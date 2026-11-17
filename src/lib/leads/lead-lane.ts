import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { db } from '../db';
import { activeOffersForProducts, type OfferView } from '../offers';
import { takeLandingOrder } from '../v1/landing-door';

type Client = Prisma.TransactionClient | typeof db;
type Scope = { companyId: string; storeId: string };

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE LEAD LANE (Confirmation Center v2, step E2) — the leads the pages system sent (E1), worked by the team, and the only door a lead becomes an order through.
 *
 *   · `readLeadLane`   the leads of this store still NEW, oldest first (priority 3: a lead is a person who left his number a moment ago, so the oldest waits the longest), each with the
 *     OFFERS the product can be sold by — read through the same reader every door uses (\`activeOffersForProducts\`), so a lead can be sold only at an approved price.
 *   · `convertLead`    creates a NORMAL order through the EXISTING landing door (\`takeLandingOrder\` → \`createPublicOrder\`, nothing here prices or writes an order): the lead's name, number and
 *     city, the address the agent took on the call, and an offer that must be one of the live offers of the product. The ad pair rides along — \`utm_campaign\` as the door's campaign,
 *     \`utm_content\` as the order's \`adId\` (stamped AFTER the order exists, never inside its creation). Retrying the same lead is the door's own dedupe, and the lead is marked CONVERTED only
 *     once the order exists.
 *   · `dismissLead`    «لا يحتاج»: the lead leaves the lane, nothing else happens.
 *
 * No customer is created here, nothing is sent, and no free price exists: the offer id is the only thing the agent chooses.
 * ═══════════════════════════════════════════════════════════════════════
 */

const LANE_CAP = 200;

export interface LaneLead {
  id: string;
  fullName: string;
  phone: string;
  city: string | null;
  productId: string;
  productName: string;
  receivedAt: Date;
  /** A flag from intake: the same number ordered the same product in the last 24 hours. */
  recentOrder: boolean;
  offers: OfferView[];
}

export async function readLeadLane(client: Client, scope: Scope, minorUnit: number, now: Date): Promise<LaneLead[]> {
  const rows = await client.lead.findMany({
    where: { companyId: scope.companyId, storeId: scope.storeId, status: 'NEW' },
    orderBy: { receivedAt: 'asc' },
    take: LANE_CAP,
    select: { id: true, fullName: true, phone: true, city: true, productId: true, receivedAt: true, recentOrderId: true },
  });
  if (rows.length === 0) return [];
  const productIds = [...new Set(rows.map((r) => r.productId))];
  const [offers, products] = await Promise.all([
    activeOffersForProducts(client as never, scope.companyId, productIds, minorUnit, now),
    client.product.findMany({ where: { companyId: scope.companyId, id: { in: productIds } }, select: { id: true, name: true } }),
  ]);
  const names = new Map(products.map((p) => [p.id, p.name]));
  return rows.map((r) => ({
    id: r.id,
    fullName: r.fullName,
    phone: r.phone,
    city: r.city,
    productId: r.productId,
    productName: names.get(r.productId) ?? '—',
    receivedAt: r.receivedAt,
    recentOrder: r.recentOrderId !== null,
    offers: offers.get(r.productId) ?? [],
  }));
}

export const convertSchema = z.object({
  leadId: z.string().trim().min(1).max(64),
  offerId: z.string().trim().min(1).max(64),
  address: z.string().trim().min(3).max(500),
});

export type ConvertResult =
  | { ok: true; orderNumber: string; alreadyConverted?: boolean }
  | { ok: false; status: number; code: 'LEAD_NOT_FOUND' | 'OFFER_NOT_LIVE' | 'DOOR_REFUSED'; message: string };

export async function convertLead(
  client: Client,
  scope: Scope,
  input: z.infer<typeof convertSchema>,
  minorUnit: number,
  now: Date = new Date()
): Promise<ConvertResult> {
  const lead = await client.lead.findFirst({ where: { id: input.leadId, companyId: scope.companyId, storeId: scope.storeId, status: 'NEW' } });
  if (!lead) return { ok: false, status: 404, code: 'LEAD_NOT_FOUND', message: 'الليد مش بالقايمة (يمكن انحوّل أو انشال).' };

  // the price is an offer the product is really sold by — never a typed figure
  const offers = (await activeOffersForProducts(client as never, scope.companyId, [lead.productId], minorUnit, now)).get(lead.productId) ?? [];
  if (!offers.some((o) => o.id === input.offerId)) return { ok: false, status: 409, code: 'OFFER_NOT_LIVE', message: 'هالعرض مش متاح هلأ — اختار عرض من القايمة.' };

  const result = await takeLandingOrder(scope.companyId, {
    productId: lead.productId,
    offerId: input.offerId,
    // one lead = one landing page id: the door's own duplicate guard answers a second press with the order that exists
    landingPageId: `lead-${lead.id}`,
    full_name: lead.fullName,
    phone: lead.phone,
    alt_phone: null,
    address: input.address,
    city: lead.city,
    notes: null,
    campaign: lead.utmCampaign ? lead.utmCampaign.slice(0, 40) : null,
    deviceClass: null,
  });
  if (!result.ok) {
    const said = typeof result.body?.error === 'string' ? result.body.error : 'الباب رفض الطلب.';
    return { ok: false, status: result.status === 409 || result.status === 422 || result.status === 400 ? result.status : 502, code: 'DOOR_REFUSED', message: said };
  }

  const orderNumber = String(result.body.orderNumber);
  // after the order exists, and unable to fail what is saved: the ad's id on the order, so the media buyer can match real orders to ads
  if (lead.utmContent) {
    try {
      await client.order.updateMany({ where: { companyId: scope.companyId, orderNumber, adId: null }, data: { adId: lead.utmContent.slice(0, 120) } });
    } catch (e) {
      console.error('lead lane: could not stamp the ad on the order (non-fatal):', e);
    }
  }
  await client.lead.updateMany({ where: { id: lead.id, companyId: scope.companyId, status: 'NEW' }, data: { status: 'CONVERTED' } });
  return { ok: true, orderNumber };
}

/** «لا يحتاج»: only a NEW lead of this store; false when there was nothing to dismiss. */
export async function dismissLead(client: Client, scope: Scope, leadId: string): Promise<boolean> {
  const done = await client.lead.updateMany({ where: { id: leadId, companyId: scope.companyId, storeId: scope.storeId, status: 'NEW' }, data: { status: 'DISMISSED' } });
  return done.count === 1;
}
