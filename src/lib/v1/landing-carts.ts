import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { db } from '../db';
import { matchRegion } from '../regions';
import { logAudit } from '../audit';
import { phoneKeys } from '../phone-rules';
import { CART_MERGE_HOURS, MERGE_INTO_STATUSES, cartPhoneKey } from '../abandoned-cart-rules';
import { autoOrderForCart } from '../abandoned-cart-orders';
import { closeCartIfOrdered } from '../cart-has-order';
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
 *   · Write an order, a customer or a figure ITSELF. A cart becomes an order through an order door only: the ordinary
 *     one, by a person («حوّل لطلب»), or — when it carries a name and a phone and the company's switch is on — the
 *     landing orders' own engine, by itself, on this very send (the owner, 17/11; `abandoned-cart-orders.ts`). The
 *     answer then says CONVERTED. Whatever happens there, this door still answers `{ id, status }`.
 *
 * ── TWO RULES OF 21/11 (the owner) ──
 *
 *   · A NEW cart whose customer already has an order for the same product («له طلب») closes itself as RECOVERED, pointing
 *     at that order (`cart-has-order.ts`), before any automatic order and whatever the company's switch says. The answer
 *     then says RECOVERED — still `{ id, status }`, the cart's real status, as the contract has it.
 *   · ONE CART PER CUSTOMER PER PRODUCT, NOT ONE PER VISIT. Zaki pages gives each visit its own `externalId`. A new one
 *     whose phone and product match a cart still open (`MERGE_INTO_STATUSES`) and seen within `CART_MERGE_HOURS` updates
 *     that cart — its `firstSeenAt` kept — and is remembered as its alias (`AbandonedCartAlias`), so a re-send or a
 *     `/recovered` under it reaches the same cart. The answer's `id` is that cart's. Never across products or companies,
 *     never into a closed cart, never for a product unknown here.
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

/** The cart Zaki pages calls by this `externalId`: its own, or the one it was folded into (`alias: true`). */
async function cartOf(
  companyId: string,
  externalId: string
): Promise<{ id: string; lastSeenAt: Date; alias: boolean } | null> {
  const own = await db.abandonedCart.findUnique({
    where: { companyId_externalId: { companyId, externalId } },
    select: { id: true, lastSeenAt: true },
  });
  if (own) return { ...own, alias: false };
  const alias = await db.abandonedCartAlias.findUnique({
    where: { companyId_externalId: { companyId, externalId } },
    select: { cart: { select: { id: true, lastSeenAt: true } } },
  });
  return alias ? { ...alias.cart, alias: true } : null;
}

/**
 * CREATE OR UPDATE ONE CART. `201` when it is new, `200` when it was already here — and the answer is the cart's REAL
 * status, which stays CONTACTED (or whatever the team set) through any number of updates. CONVERTED when this send made
 * it an order by itself (a name and a phone, the company's switch on — `abandoned-cart-orders.ts`), or when it already was.
 * RECOVERED when the customer already had an order for this product and the cart closed itself (`cart-has-order.ts`).
 * A new `externalId` folded into the customer's open cart for the same product answers `200` with THAT cart's id.
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

  const update = async (id: string) => {
    const row = await db.abandonedCart.update({
      where: { id },
      data: { ...data, activities: { create: { companyId, action: 'UPDATED' } } },
      select: CART_ANSWER,
    });
    return { status: 200 as const, body: { id: row.id, status: row.status } };
  };

  /**
   * A SECOND VISIT OF THE SAME CUSTOMER FOR THE SAME PRODUCT: the cart still open, seen within the window. Only for a
   * product of this company — two unknown products are not known to be the same one.
   */
  const twinOf = async () => {
    if (!data.productId || !data.phoneNormalized) return null;
    return db.abandonedCart.findFirst({
      where: {
        companyId,
        productId: data.productId,
        phoneNormalized: { in: phoneKeys(data.phoneNormalized) },
        status: { in: MERGE_INTO_STATUSES },
        lastSeenAt: { gte: new Date(lastSeenAt.getTime() - CART_MERGE_HOURS * 60 * 60 * 1000) },
      },
      orderBy: { lastSeenAt: 'desc' },
      select: { id: true, lastSeenAt: true },
    });
  };

  /**
   * FOLD THIS VISIT INTO THE CART: what it brings, over what the cart holds — an empty field never wipes a filled one, the
   * first visit's moment stays, the last one moves only forward. Then the `externalId` is remembered as the cart's alias
   * (once: a re-send under an alias it already is comes through here too, and finds it remembered).
   */
  const fold = async (twin: { id: string; lastSeenAt: Date }, remember: boolean) => {
    const brought = Object.fromEntries(
      Object.entries(data).filter(([k, v]) => v != null && k !== 'firstSeenAt' && k !== 'lastSeenAt')
    );
    const row = await db.abandonedCart.update({
      where: { id: twin.id },
      data: {
        ...brought,
        lastSeenAt: lastSeenAt > twin.lastSeenAt ? lastSeenAt : twin.lastSeenAt,
        activities: { create: { companyId, action: 'UPDATED', metadata: JSON.stringify({ alias: input.externalId }) } },
      },
      select: CART_ANSWER,
    });
    if (remember) {
      try {
        await db.abandonedCartAlias.create({ data: { companyId, externalId: input.externalId, cartId: twin.id } });
      } catch (e) {
        // The same visit sent twice in the same second: the other send already remembered it.
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      }
    }
    return { status: 200 as const, body: { id: row.id, status: row.status } };
  };

  const existing = async () => {
    const known = await cartOf(companyId, input.externalId);
    if (!known) return null;
    return known.alias ? fold(known, false) : update(known.id);
  };

  const upsert = async (): Promise<{ status: 200 | 201; body: { id: string; status: string } }> => {
    const known = await existing();
    if (known) return known;

    const twin = await twinOf();
    if (twin) return fold(twin, true);

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
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const raced = await existing();
        if (raced) return raced;
      }
      throw e;
    }
  };

  const answer = await upsert();
  // The customer already has an order for this product: the cart closes itself as «طلب لحاله», pointing at it
  // (`cart-has-order.ts`) — whatever the switch says, because it makes no order. Never fails this door.
  const had = await closeCartIfOrdered(companyId, answer.body.id, now);
  if (had) return { status: answer.status, body: { id: answer.body.id, status: 'RECOVERED' } };
  // A name and a phone: the cart becomes an order by itself (`abandoned-cart-orders.ts`) — or stays a cart, with the
  // reason on its history. Never fails this door, and a cart already tried is never tried twice.
  const made = await autoOrderForCart(companyId, answer.body.id, { now });
  return made.kind === 'CONVERTED' ? { status: answer.status, body: { id: answer.body.id, status: 'CONVERTED' } } : answer;
}

/**
 * THE CART BECAME AN ORDER — THE CUSTOMER ORDERED BY HIMSELF.
 *
 * RECOVERED, linked to the order when its number is this company's (the number may be null: the order was still in Zaki
 * pages' queue). The `externalId` is the cart's own or one of its aliases (21/11). A repeat answers 200 and changes nothing — except that a link missing the first time is written when the
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
  // Its own `externalId`, or one folded into it as an alias (a second visit of the same customer for the same product).
  const known = await cartOf(companyId, externalId);
  const cart = known
    ? await db.abandonedCart.findUnique({ where: { id: known.id }, select: { id: true, status: true, orderId: true } })
    : null;
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
