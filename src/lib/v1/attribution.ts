import type { Prisma } from '@prisma/client';
import { db } from '../db';
import { minorUnitFor } from '../currencies';
import { deriveCoreState, type CoreState } from '../order-state';
import { publicAddress } from '../public-address';
import { realStoresOnly } from '../test-store';
import { V1_CODE, V1Fault } from './door';
import { amountString, isoWithOffset } from './shape';

/**
 * WHICH AD EACH ORDER CAME FROM, AND WHAT BECAME OF IT — for the media buyer.
 *
 * `GET /api/v1/orders/attribution` is the read the media buyer syncs every
 * hour (its spec, §9.2). It decides where ad money goes on THIS system's
 * truth — confirmed, delivered, returned — not on Meta's «Purchase», which
 * counts a click on «اطلب» as a sale.
 *
 * ── NOT ONE BYTE ABOUT THE CUSTOMER ──
 *
 * No name, no phone, no address, no note, and not the sealed click id
 * either. The SELECT below is the proof: a field that is never read cannot
 * be spread into an answer later. `capi_ref` is null — see its comment.
 *
 * ── EVERY FIGURE IS ONE THIS SYSTEM ALREADY HOLDS ──
 *
 * The status is `deriveCoreState`, the one function every screen uses. The
 * value is the stored `totalAmount` (never re-totalled from lines — see
 * `the-systems-door.test.ts`). «Collected» is `collectedAmount ?? total` on
 * a delivered order, the reading `conversions/emit.ts`, `agent-custody` and
 * `analytics` already share. The moments are the order's own columns, and
 * its status log where a column was never written.
 */

/** The six words the media buyer's contract knows. */
export type AttributionStatus = 'new' | 'confirmed' | 'shipped' | 'delivered' | 'returned' | 'canceled';

/**
 * FOURTEEN CORE STATES ONTO SIX — the mapping the PR states for the owner.
 *
 * Anything still being worked by the call centre is `new`: claimed, no
 * answer and postponed are all «not yet a yes», and the media buyer's
 * confirm rate must not count them. A partial delivery is `delivered` —
 * money came in at the door — and its `collected` says how much. A parcel
 * on its way back (`WAITING_RETURN`) is still `shipped` until it is
 * received: calling it returned before the courier hands it over is a
 * guess.
 */
export const STATUS_OF: Record<CoreState, AttributionStatus> = {
  NEW: 'new',
  CLAIMED: 'new',
  NO_ANSWER: 'new',
  POSTPONED: 'new',
  CONFIRMED: 'confirmed',
  PREPARING: 'confirmed',
  READY_TO_SHIP: 'confirmed',
  SHIPPED: 'shipped',
  WAITING_RETURN: 'shipped',
  DELIVERED: 'delivered',
  PARTIALLY_DELIVERED: 'delivered',
  RETURNED: 'returned',
  CANCELLED: 'canceled',
  VOIDED: 'canceled',
};

/**
 * THE CAPS — so a sync can never be the thing that hangs production.
 *
 * The owner's rule (2026-10-26): «بدنا حل جذري… ما بدنا نخرب ع حالنا». One
 * call reads at most 200 orders over at most 31 days, through the
 * `(companyId, updatedAt)` index, and a key is held to its own per-minute
 * allowance (30 for the media buyer — `V1_SYSTEMS`). A full re-read of
 * history is not a thing this door does.
 */
export const PAGE_DEFAULT = 200;
export const PAGE_MAX = 200;
export const MAX_WINDOW_DAYS = 31;

/**
 * THE CURSOR — where the last page stopped, as (updatedAt, id).
 *
 * Opaque to the caller and base64url so it travels in a query string as-is.
 * The id breaks ties: two orders touched in the same millisecond would
 * otherwise straddle a page boundary and one of them be skipped for ever.
 */
export function encodeCursor(updatedAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ u: updatedAt.toISOString(), i: id }), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): { updatedAt: Date; id: string } {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (parsed && typeof parsed === 'object') {
      const { u, i } = parsed as { u?: unknown; i?: unknown };
      const at = typeof u === 'string' ? new Date(u) : null;
      if (at && !Number.isNaN(at.getTime()) && typeof i === 'string' && i.length > 0 && i.length <= 64) {
        return { updatedAt: at, id: i };
      }
    }
  } catch {
    // fall through to the one refusal below
  }
  throw new V1Fault(422, V1_CODE.VALIDATION_FAILED, 'cursor is not one this endpoint issued', {
    field: 'cursor',
  });
}

/**
 * `updated_since`, required and at most `MAX_WINDOW_DAYS` back: a sync with
 * no starting point, or one starting a year ago, would read the whole
 * history in one breath.
 */
export function readSince(raw: string | null, now: Date = new Date()): Date {
  const at = raw ? new Date(raw) : null;
  if (!at || Number.isNaN(at.getTime())) {
    throw new V1Fault(422, V1_CODE.VALIDATION_FAILED, 'updated_since must be an ISO 8601 date-time', {
      field: 'updated_since',
    });
  }
  if (now.getTime() - at.getTime() > MAX_WINDOW_DAYS * 86_400_000) {
    throw new V1Fault(422, V1_CODE.VALIDATION_FAILED, `updated_since may be at most ${MAX_WINDOW_DAYS} days back`, {
      field: 'updated_since',
      max_days: MAX_WINDOW_DAYS,
    });
  }
  return at;
}

/** Status-log values that mark each moment, for an order whose column was never written. */
const LOG_MARKS: Record<'confirmed' | 'shipped' | 'delivered' | 'returned' | 'canceled', string[]> = {
  confirmed: ['CONFIRMED'],
  shipped: ['SHIPPED'],
  delivered: ['DELIVERED', 'PARTIALLY_DELIVERED'],
  returned: ['RETURNED'],
  canceled: ['CANCELLED', 'REJECTED'],
};

/**
 * WHAT IS READ — and, by omission, what is not.
 *
 * `customerId` is not here, nor `customer`, `deliveryAddress`, the notes,
 * `ctwaClidEnc` or `psidEnc`. `the-media-buyers-door.test.ts` holds this
 * object to that.
 */
export const ATTRIBUTION_SELECT = {
  id: true,
  orderNumber: true,
  confirmationStatus: true,
  shippingStatus: true,
  claimedById: true,
  shippedAt: true,
  labelPrintedAt: true,
  confirmedAt: true,
  deliveredAt: true,
  returnedAt: true,
  createdAt: true,
  updatedAt: true,
  totalAmount: true,
  collectedAmount: true,
  currency: true,
  rejectionReason: true,
  source: true,
  externalChannel: true,
  adId: true,
  landingPageId: true,
  product: { select: { sku: true } },
  channel: { select: { kind: true } },
  campaign: { select: { externalId: true } },
  landingPage: { select: { slug: true, domain: true, domainVerifiedAt: true } },
  store: { select: { country: { select: { code: true, timezone: true, minorUnit: true } } } },
  statusLogs: {
    where: { statusType: { in: ['CONFIRMATION', 'SHIPPING'] } },
    orderBy: { createdAt: 'asc' },
    select: { newValue: true, createdAt: true },
  },
  contactAttempts: { orderBy: { createdAt: 'asc' }, take: 1, select: { createdAt: true } },
} satisfies Prisma.OrderSelect;

type Row = Prisma.OrderGetPayload<{ select: typeof ATTRIBUTION_SELECT }>;

/** One order as the media buyer reads it. Pure: no database, no clock. */
export function attributionItem(o: Row, origin: string | null | undefined) {
  const zone = o.store?.country?.timezone ?? 'UTC';
  const at = (d: Date | null | undefined) => (d ? isoWithOffset(d, zone) : null);
  const firstLog = (mark: keyof typeof LOG_MARKS) =>
    o.statusLogs.find((l) => l.newValue !== null && LOG_MARKS[mark].includes(l.newValue))?.createdAt ?? null;

  const core = deriveCoreState(o);
  const status = STATUS_OF[core];
  const minorUnit = minorUnitFor(o.currency) ?? o.store?.country?.minorUnit ?? 2;

  return {
    order_id: o.id,
    product_code: o.product?.sku ?? '',
    country: o.store?.country?.code ?? 'ZZ',
    // The caller's own word first («whatsapp»), then the company's channel
    // kind, then the free-text source the order was raised with.
    channel: (o.externalChannel ?? o.channel?.kind ?? o.source).trim().toLowerCase(),
    ad_id: o.adId,
    /*
     * Not stored on an order today. The ad set and the ad's name arrive only
     * once landing pages capture them from the link — the media buyer's
     * P0.1, which changes order creation and waits for the owner's OK.
     */
    adset_id: null,
    campaign_id: o.campaign?.externalId ?? null,
    ad_name: null,
    landing_page: o.landingPage
      ? publicAddress(origin, {
          kind: 'lp',
          slug: o.landingPage.slug,
          domain: o.landingPage.domain,
          domainVerifiedAt: o.landingPage.domainVerifiedAt,
        }).url
      : null,
    status,
    created_at: at(o.createdAt),
    confirmed_at: at(o.confirmedAt ?? firstLog('confirmed')),
    shipped_at: at(o.shippedAt ?? firstLog('shipped')),
    delivered_at: at(o.deliveredAt ?? firstLog('delivered')),
    returned_at: at(o.returnedAt ?? firstLog('returned')),
    // Only an order that IS cancelled carries the moment: one cancelled and
    // later revived is not cancelled.
    canceled_at: status === 'canceled' ? at(firstLog('canceled')) : null,
    order_value: amountString(o.totalAmount, minorUnit),
    collected:
      status === 'delivered'
        ? amountString(Number(o.collectedAmount ?? o.totalAmount), minorUnit)
        : null,
    currency: o.currency,
    is_fake: o.rejectionReason === 'FAKE_ORDER',
    first_contact_at: at(o.contactAttempts[0]?.createdAt),
    /*
     * NULL ON PURPOSE. The spec has this as «an encrypted reference to the
     * phone and fbc/fbp/ctwa_clid that only CAPI code opens». This system
     * already sends its own conversions to Meta (`conversions/meta-capi.ts`),
     * and handing another system a sealed phone needs a key both hold —
     * which is the owner's decision, not this endpoint's. Until he rules,
     * the key stays and says «nothing».
     */
    capi_ref: null,
  };
}

/*
 * NOT FILTERED BY `notSuperseded`, ON PURPOSE.
 *
 * This feed is a published contract: the same fields and six status
 * words for every caller. Dropping a replaced order from it would leave the
 * media buyer holding that order «shipped» for ever (it was served before it
 * was replaced), and there is no seventh word to say «replaced». Adding one
 * is a decision on the contract, not on this reader. What changed for the
 * media buyer is that the replacement now carries the ad, the campaign and
 * the page, so the sale that finally delivers is visible to it at last.
 */
/** One page of orders touched at or after `since`, oldest change first. */
export async function readAttributionPage(params: {
  companyId: string;
  since: Date;
  cursor: { updatedAt: Date; id: string } | null;
  limit: number;
  origin: string | null | undefined;
}) {
  const { companyId, since, cursor, limit, origin } = params;
  const rows = await db.order.findMany({
    where: {
      // From the token, never from the request — see `system-token.ts`.
      companyId,
      // A test bench's orders are not the business («أرقامٌ لا تدخل أيَّ حسبة»).
      ...realStoresOnly(),
      updatedAt: { gte: since },
      ...(cursor
        ? {
            OR: [
              { updatedAt: { gt: cursor.updatedAt } },
              { updatedAt: cursor.updatedAt, id: { gt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    // One more than asked: its presence is how the last page knows it is.
    take: limit + 1,
    select: ATTRIBUTION_SELECT,
  });

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((o) => attributionItem(o, origin)),
    next_cursor: rows.length > limit && last ? encodeCursor(last.updatedAt, last.id) : null,
  };
}
