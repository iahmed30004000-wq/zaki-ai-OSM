import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { db } from '../db';
import { matchRegion } from '../regions';
import { logAudit } from '../audit';
import { cartPhoneKey } from '../abandoned-cart-rules';
import { V1_CODE, V1Fault } from './door';

/**
 * «السلات المهجورة» AT THE LANDING DOOR (contract `oms-lp.v1` §9).
 *
 * Zaki pages sends a cart when a visitor typed a valid phone and no order followed within fifteen minutes, and sends it
 * again only when the visitor changed what he typed. It retries on its own, so every call here is idempotent twice over:
 * the `Idempotency-Key` replays the first answer, and the cart itself is UPSERTED per company on `externalId` — the
 * same lead sent under a new key updates its row and never makes a second one.
 *
 * ── WHAT IT NEVER DOES ──
 *
 *   · Move a worked cart back to NEW. An update writes the data the visitor typed and nothing the team decided:
 *     the status, the attempts, the assignee, the follow-up date and the notes stay as they are.
 *   · Refuse a cart for its product. `productId` is linked when it is this company's, and otherwise left empty while
 *     `productName` keeps what the page called it.
 *   · Read a company from the request. It is the key's (`requireSystemToken`), as at every door here.
 *   · Write an order, a customer or a figure. A cart becomes an order only through the ordinary order door, by a person.
 *
 * ── TWO KINDS OF «NO» ──
 *
 * A body this door cannot take (no `externalId`, no phone, a value of the wrong type) is a refusal Zaki pages must not
 * send again: `400 { error: "<Arabic>" }`, the contract's visitor-readable shape. A fault between the two systems (a bad
 * key, a missing `Idempotency-Key`, an unknown cart) keeps the machine envelope `{ error: { code } }`.
 */

/** Arabic, because the contract's refusal shape is a sentence; Zaki pages shows it in its own log of failed sends. */
export const CART_REFUSAL_AR = {
  NOT_JSON: 'بيانات السلة غير مقروءة.',
  MISSING: 'السلة تحتاج معرّفها (externalId) ورقم الهاتف.',
  PHONE: 'رقم الهاتف في السلة غير صالح.',
  INVALID: 'بيانات السلة غير صالحة.',
  RECOVERED_INVALID: 'رقم الطلب غير صالح.',
} as const;

/** A text field the page may send empty, as null or not at all: all three are «nothing». */
const optionalText = (max: number) =>
  z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => {
      const t = typeof v === 'string' ? v.trim() : '';
      return t ? t.slice(0, max) : null;
    });

/** A moment, as ISO text; an unreadable one is a refusal, a missing one is «now». */
const optionalMoment = z
  .union([z.string().max(64), z.null()])
  .optional()
  .refine((v) => v == null || v === '' || !Number.isNaN(new Date(v).getTime()), { message: 'date' })
  .transform((v) => (v ? new Date(v) : null));

export const landingCartSchema = z.object({
  externalId: z.string().trim().min(1).max(200),
  landingPageId: optionalText(200),
  landingPageName: optionalText(200),
  landingPageUrl: optionalText(2000),
  productId: optionalText(64),
  productName: optionalText(300),
  customerName: optionalText(120),
  phone: z.string().trim().min(1).max(40),
  city: optionalText(120),
  country: optionalText(8),
  firstSeenAt: optionalMoment,
  lastSeenAt: optionalMoment,
});

export type LandingCartInput = z.infer<typeof landingCartSchema>;

export type CartRefusal = { ok: false; status: 400; body: { error: string } };
const refuse = (error: string): CartRefusal => ({ ok: false, status: 400, body: { error } });

/** The body, read and checked — or the sentence that says why not. Field values are never echoed back. */
export function readLandingCart(raw: string): { ok: true; data: LandingCartInput } | CartRefusal {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return refuse(CART_REFUSAL_AR.NOT_JSON);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return refuse(CART_REFUSAL_AR.NOT_JSON);
  const p = payload as Record<string, unknown>;
  const blank = (v: unknown) => typeof v !== 'string' || v.trim() === '';
  if (blank(p.externalId) || blank(p.phone)) return refuse(CART_REFUSAL_AR.MISSING);
  const parsed = landingCartSchema.safeParse(payload);
  if (!parsed.success) return refuse(CART_REFUSAL_AR.INVALID);
  // Seven digits at least: Zaki pages has already checked the number against the product's country, so this only stops
  // a value that is not a phone at all from becoming a row nobody can call.
  const digits = parsed.data.phone.replace(/[^\d٠-٩]/g, '');
  if (digits.length < 7 || digits.length > 15) return refuse(CART_REFUSAL_AR.PHONE);
  return { ok: true, data: parsed.data };
}

export const recoveredSchema = z.object({
  orderNumber: z.union([z.string().trim().max(64), z.null()]).optional(),
});

export function readRecovered(raw: string): { ok: true; orderNumber: string | null } | CartRefusal {
  let payload: unknown = {};
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw);
    } catch {
      return refuse(CART_REFUSAL_AR.NOT_JSON);
    }
  }
  const parsed = recoveredSchema.safeParse(payload ?? {});
  if (!parsed.success) return refuse(CART_REFUSAL_AR.RECOVERED_INVALID);
  return { ok: true, orderNumber: parsed.data.orderNumber || null };
}

/** The product, when the id is one of this company's; its store's country with it. */
async function companyProduct(companyId: string, productId: string | null) {
  if (!productId) return null;
  return db.product.findFirst({
    where: { companyId, id: productId },
    select: { id: true, name: true, store: { select: { country: { select: { code: true } } } } },
  });
}

/** The city as one of the country's regions — only when the match is unambiguous (`matchRegion`), else nothing. */
async function regionOf(companyId: string, countryCode: string | null, city: string | null): Promise<string | null> {
  if (!countryCode || !city) return null;
  const country = await db.country.findFirst({ where: { companyId, code: countryCode }, select: { id: true } });
  if (!country) return null;
  const regions = await db.region.findMany({ where: { countryId: country.id, isActive: true }, select: { id: true, name: true } });
  return matchRegion(regions, city)?.id ?? null;
}

const CART_ANSWER = { id: true, status: true } as const;

/**
 * CREATE OR UPDATE ONE CART. `201` when it is new, `200` when it was already here — and the answer is the cart's REAL
 * status, which stays CONTACTED (or whatever the team set) through any number of updates.
 */
export async function upsertLandingCart(
  companyId: string,
  input: LandingCartInput
): Promise<{ status: 200 | 201; body: { id: string; status: string } }> {
  const product = await companyProduct(companyId, input.productId);
  const country = (input.country?.toUpperCase() || product?.store?.country.code || null) ?? null;
  const now = new Date();
  const lastSeenAt = input.lastSeenAt ?? now;
  const firstSeenAt = input.firstSeenAt ?? lastSeenAt;

  // Everything the visitor typed or the page knows — and nothing the team decided.
  const data = {
    landingPageId: input.landingPageId,
    landingPageName: input.landingPageName,
    landingPageUrl: input.landingPageUrl,
    productId: product?.id ?? null,
    productName: input.productName ?? product?.name ?? null,
    customerName: input.customerName,
    phone: input.phone,
    phoneNormalized: cartPhoneKey(input.phone, country),
    city: input.city,
    regionId: await regionOf(companyId, country, input.city),
    country,
    firstSeenAt,
    lastSeenAt,
  };

  const update = async () => {
    const row = await db.abandonedCart.update({
      where: { companyId_externalId: { companyId, externalId: input.externalId } },
      data: { ...data, activities: { create: { companyId, action: 'UPDATED' } } },
      select: CART_ANSWER,
    });
    return { status: 200 as const, body: { id: row.id, status: row.status } };
  };

  const known = await db.abandonedCart.findUnique({
    where: { companyId_externalId: { companyId, externalId: input.externalId } },
    select: { id: true },
  });
  if (known) return update();

  try {
    const row = await db.abandonedCart.create({
      data: {
        companyId,
        externalId: input.externalId,
        source: 'LANDING_PAGE',
        status: 'NEW',
        ...data,
        activities: { create: { companyId, action: 'RECEIVED', toStatus: 'NEW' } },
      },
      select: CART_ANSWER,
    });
    return { status: 201, body: { id: row.id, status: row.status } };
  } catch (e) {
    // Two sends of one lead under two keys, in the same second: the unique index let one create, and the other updates.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return update();
    throw e;
  }
}

/**
 * THE CART BECAME AN ORDER — THE CUSTOMER ORDERED BY HIMSELF.
 *
 * RECOVERED, linked to the order when its number is this company's (the number may be null: the order was still in Zaki
 * pages' queue). A repeat answers 200 and changes nothing — except that a link missing the first time is written when the
 * number arrives. An unknown cart is 404, the machine envelope.
 *
 * ONE DEPARTURE, NAMED: a cart the TEAM already turned into an order (CONVERTED) keeps that status, because the team's
 * order is the one this cart produced; the page's order is written into the cart's history so whoever opens it sees that
 * the customer ordered twice. The answer is 200 with the status it kept.
 */
export async function recoverLandingCart(
  companyId: string,
  externalId: string,
  orderNumber: string | null
): Promise<{ id: string; status: string }> {
  const cart = await db.abandonedCart.findUnique({
    where: { companyId_externalId: { companyId, externalId } },
    select: { id: true, status: true, orderId: true },
  });
  if (!cart) throw new V1Fault(404, V1_CODE.NOT_FOUND, 'No such abandoned cart');

  const order = orderNumber
    ? await db.order.findFirst({ where: { companyId, orderNumber }, select: { id: true } })
    : null;

  if (cart.status === 'RECOVERED') {
    if (!cart.orderId && order) {
      await db.abandonedCart.update({ where: { id: cart.id }, data: { orderId: order.id } });
    }
    return { id: cart.id, status: 'RECOVERED' };
  }

  if (cart.status === 'CONVERTED') {
    await db.abandonedCartActivity.create({
      data: {
        companyId,
        cartId: cart.id,
        action: 'RECOVERED',
        fromStatus: 'CONVERTED',
        toStatus: 'CONVERTED',
        metadata: JSON.stringify({ orderNumber, kept: 'CONVERTED' }),
      },
    });
    return { id: cart.id, status: 'CONVERTED' };
  }

  await db.abandonedCart.update({
    where: { id: cart.id },
    data: {
      status: 'RECOVERED',
      orderId: order?.id ?? cart.orderId,
      activities: {
        create: {
          companyId,
          action: 'RECOVERED',
          fromStatus: cart.status,
          toStatus: 'RECOVERED',
          metadata: JSON.stringify({ orderNumber }),
        },
      },
    },
  });
  await logAudit({
    companyId,
    userId: null,
    action: 'ABANDONED_CART_RECOVERED',
    entity: 'AbandonedCart',
    entityId: cart.id,
    previousData: { status: cart.status },
    newData: { status: 'RECOVERED', orderNumber, via: 'landing' },
  });
  return { id: cart.id, status: 'RECOVERED' };
}
