import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { CONFIRMATION_REFUSED } from '../order-state';
import { INTAKE_WINDOW_MS } from '../intake-flags';
import { intakePhoneKeys } from '../intake-filter';
import { sameProductWhere } from '../confirmed-twin';
import { canonicalPhone } from '../phone-rules';
import type { db } from '../db';

type Client = Prisma.TransactionClient | typeof db;

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A LEAD FROM THE PAGES SYSTEM (Confirmation Center v2, step E1) — what the signed webhook accepts, and what it does with it.
 *
 *   · `leadSchema`   the payload: the pages system's own id, name, phone, city, the product (an id of THIS catalogue), the page and the ad's utm pair. Strict: a field it does not know is refused.
 *   · `takeLead`     resolves the product (which gives the company and the store — the secret identifies the sender, the catalogue identifies whose lead it is), keeps the lead ONCE (idempotent on the
 *     external id), and FLAGS — never refuses — a lead whose number already ordered the same product in the last 24 hours (`recentOrderId`), by the intake filter's own definition of «the same».
 *
 * It creates no order and no customer and prices nothing: a lead becomes an order only through the existing landing door with an approved offer (a later step). No customer value is echoed in any
 * answer, and nothing here reaches a model.
 * ═══════════════════════════════════════════════════════════════════════
 */

const text = (max: number) => z.string().trim().min(1).max(max);
const optional = (max: number) => z.string().trim().max(max).optional().transform((v) => (v ? v : null));

export const leadSchema = z
  .object({
    id: text(120),
    full_name: text(200),
    phone: text(40),
    city: optional(120),
    product_id: text(120),
    page: optional(500),
    utm_campaign: optional(200),
    utm_content: optional(200),
  })
  .strict();
export type LeadInput = z.infer<typeof leadSchema>;

export type TakeLeadResult =
  | { ok: true; created: boolean; recentOrder: boolean }
  | { ok: false; code: 'UNKNOWN_PRODUCT' | 'INVALID_PHONE'; status: 422 };

/** The OLDEST order of the same person for the same product in the last 24 hours that was not refused — or null. A flag source only. */
export async function recentOrderOfTheSame(
  client: Client,
  scope: { companyId: string; storeId: string; countryCode: string },
  phone: string,
  productId: string,
  now: Date
): Promise<{ id: string } | null> {
  const product = sameProductWhere([productId]);
  if (!product) return null;
  const customers = await client.customer.findMany({
    where: { companyId: scope.companyId, storeId: scope.storeId, phone: { in: intakePhoneKeys(phone, scope.countryCode) } },
    select: { id: true },
    take: 50,
  });
  if (customers.length === 0) return null;
  return client.order.findFirst({
    where: {
      companyId: scope.companyId,
      customerId: { in: customers.map((c) => c.id) },
      createdAt: { gte: new Date(now.getTime() - INTAKE_WINDOW_MS), lte: now },
      confirmationStatus: { notIn: [...CONFIRMATION_REFUSED] },
      replacesOrderId: null,
      ...product,
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
}

/** Keeps a lead once. The product gives the company and the store; a product that is not in the catalogue is refused (422), and so is a number with no digits. */
export async function takeLead(client: Client, lead: LeadInput, now: Date = new Date()): Promise<TakeLeadResult> {
  const product = await client.product.findUnique({
    where: { id: lead.product_id },
    select: { id: true, companyId: true, storeId: true, store: { select: { country: { select: { code: true } } } } },
  });
  if (!product || !product.storeId) return { ok: false, code: 'UNKNOWN_PRODUCT', status: 422 };
  const countryCode = product.store?.country?.code ?? '';
  const phoneKey = canonicalPhone(lead.phone, countryCode);
  if (!phoneKey) return { ok: false, code: 'INVALID_PHONE', status: 422 };

  const scope = { companyId: product.companyId, storeId: product.storeId, countryCode };
  const already = await client.lead.findUnique({ where: { companyId_externalId: { companyId: scope.companyId, externalId: lead.id } }, select: { recentOrderId: true } });
  if (already) return { ok: true, created: false, recentOrder: !!already.recentOrderId };

  const recent = await recentOrderOfTheSame(client, scope, lead.phone, product.id, now);
  await client.lead.create({
    data: {
      companyId: scope.companyId,
      storeId: scope.storeId,
      externalId: lead.id,
      fullName: lead.full_name,
      phone: lead.phone,
      phoneKey,
      city: lead.city,
      productId: product.id,
      pageUrl: lead.page,
      utmCampaign: lead.utm_campaign,
      utmContent: lead.utm_content,
      recentOrderId: recent?.id ?? null,
    },
  });
  return { ok: true, created: true, recentOrder: !!recent };
}
