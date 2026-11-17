import { db } from '../db';
import { V1_CODE, V1Fault } from './door';
import { isoWithOffset } from './shape';

/**
 * WHAT EACH AD SPENT EACH DAY — for the media buyer.
 *
 * `GET /api/v1/ad-spend` is the read that sets a cost per order. It answers from `AdSpendDay`, the table the 06:00 spend pull fills
 * (`ads/daily.ts`), and it NEVER calls Meta: the media buyer's own Meta token is for writes, and an endpoint rated at thirty a minute
 * must not be able to spend the ad account's rate limit. `as_of` says when the pull last ran, so a stale answer is shown as stale.
 *
 * ── NOT ONE BYTE ABOUT THE CUSTOMER — and not one about an order ──
 *
 * Ids, a day, money and two counts. Nothing here joins an order, a customer or an address; the reader selects `AdSpendDay` columns
 * and nothing else.
 *
 * ── BOUNDED ──
 *
 * `date_from` and `date_to` required, at most 31 days apart; a page is at most 500 rows; the company is the token's.
 *
 * ── THE THREE LEVELS ──
 *
 * `ad` (the default) is one row per day per ad. `adset` and `campaign` add the ads up. The row's own identity is `ad_id` in every
 * level — at `adset` it is the ad set's id, at `campaign` the campaign's — because the contract's item has one required id and the
 * media buyer groups by it; `adset_id` and `campaign_id` are filled wherever they are known.
 */

export const AD_SPEND_PAGE_DEFAULT = 500;
export const AD_SPEND_PAGE_MAX = 500;
export const AD_SPEND_WINDOW_DAYS = 31;

export type AdSpendLevel = 'ad' | 'adset' | 'campaign';

/** The contract's day is «Asia/Amman»: the as_of moment carries that zone's offset. */
const AS_OF_ZONE = 'Asia/Amman';

const DAY_MS = 86_400_000;

const fault = (message: string, field: string) =>
  new V1Fault(400, V1_CODE.VALIDATION_FAILED, message, { field });

/** `YYYY-MM-DD` that is a real calendar day, as a UTC-midnight date. */
function readDay(raw: string | null, field: string): Date {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw fault(`${field} must be a date written YYYY-MM-DD`, field);
  const at = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== raw) throw fault(`${field} is not a real day`, field);
  return at;
}

export function readWindow(fromRaw: string | null, toRaw: string | null): { from: Date; to: Date } {
  const from = readDay(fromRaw, 'date_from');
  const to = readDay(toRaw, 'date_to');
  if (to.getTime() < from.getTime()) throw fault('date_to is before date_from', 'date_to');
  if ((to.getTime() - from.getTime()) / DAY_MS > AD_SPEND_WINDOW_DAYS) {
    throw new V1Fault(400, V1_CODE.VALIDATION_FAILED, `date_to may be at most ${AD_SPEND_WINDOW_DAYS} days after date_from`, {
      field: 'date_to',
      max_days: AD_SPEND_WINDOW_DAYS,
    });
  }
  return { from, to };
}

export function readLevel(raw: string | null): AdSpendLevel {
  if (raw === null || raw === '') return 'ad';
  if (raw === 'ad' || raw === 'adset' || raw === 'campaign') return raw;
  throw fault('level must be ad, adset or campaign', 'level');
}

/** Where the last page stopped, as (day, key). Opaque to the caller and base64url so it travels in a query string as-is. */
export function encodeSpendCursor(day: string, key: string): string {
  return Buffer.from(JSON.stringify({ d: day, k: key }), 'utf8').toString('base64url');
}

export function decodeSpendCursor(raw: string): { day: Date; key: string } {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (parsed && typeof parsed === 'object') {
      const { d, k } = parsed as { d?: unknown; k?: unknown };
      if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && typeof k === 'string' && k.length > 0 && k.length <= 64) {
        const day = new Date(`${d}T00:00:00.000Z`);
        if (!Number.isNaN(day.getTime())) return { day, key: k };
      }
    }
  } catch {
    // fall through to the one refusal below
  }
  throw fault('cursor is not one this endpoint issued', 'cursor');
}

const dayOf = (d: Date) => d.toISOString().slice(0, 10);
/** Money as the contract writes it: a decimal string with two places. */
const money = (v: unknown) => Number(v).toFixed(2);

interface GroupedRow {
  date: Date;
  key: string | null;
  spend: unknown;
  impressions: number | null;
  linkClicks: number | null;
  currency: string | null;
  campaignId: string | null;
}

export interface AdSpendItem {
  date: string;
  ad_id: string;
  adset_id: string | null;
  campaign_id: string | null;
  spend: string;
  currency: string;
  impressions: number | null;
  link_clicks: number | null;
}

/** One page, ordered by day then id so a page never repeats a row. */
export async function readAdSpendPage(params: {
  companyId: string;
  from: Date;
  to: Date;
  level: AdSpendLevel;
  cursor: { day: Date; key: string } | null;
  limit: number;
}) {
  const { companyId, from, to, level, cursor, limit } = params;
  // From the token, never from the request — see `system-token.ts`.
  const base = { companyId, date: { gte: from, lte: to } };
  const keyField = level === 'ad' ? 'adId' : level === 'adset' ? 'adsetId' : 'campaignId';
  const after = cursor
    ? { OR: [{ date: { gt: cursor.day } }, { date: cursor.day, [keyField]: { gt: cursor.key } }] }
    : {};

  let items: AdSpendItem[];
  let more: boolean;
  let last: { day: string; key: string } | null = null;

  if (level === 'ad') {
    const rows = await db.adSpendDay.findMany({
      where: { ...base, ...after },
      orderBy: [{ date: 'asc' }, { adId: 'asc' }],
      take: limit + 1,
      select: { date: true, adId: true, adsetId: true, campaignId: true, spend: true, currency: true, impressions: true, linkClicks: true },
    });
    more = rows.length > limit;
    const page = rows.slice(0, limit);
    items = page.map((r) => ({
      date: dayOf(r.date),
      ad_id: r.adId,
      adset_id: r.adsetId,
      campaign_id: r.campaignId,
      spend: money(r.spend),
      currency: r.currency,
      impressions: r.impressions,
      link_clicks: r.linkClicks,
    }));
    const tail = page[page.length - 1];
    last = tail ? { day: dayOf(tail.date), key: tail.adId } : null;
  } else {
    const where = { ...base, [keyField]: { not: null }, ...after };
    const sums = { spend: true, impressions: true, linkClicks: true } as const;
    const mins = { currency: true, campaignId: true } as const;
    // Two literal calls, not one with a computed field: Prisma types a groupBy by its literal `by`.
    const grouped: GroupedRow[] =
      level === 'adset'
        ? (await db.adSpendDay.groupBy({ by: ['date', 'adsetId'], where, orderBy: [{ date: 'asc' }, { adsetId: 'asc' }], take: limit + 1, _sum: sums, _min: mins })).map((r) => ({
            date: r.date, key: r.adsetId, spend: r._sum.spend, impressions: r._sum.impressions, linkClicks: r._sum.linkClicks, currency: r._min.currency, campaignId: r._min.campaignId,
          }))
        : (await db.adSpendDay.groupBy({ by: ['date', 'campaignId'], where, orderBy: [{ date: 'asc' }, { campaignId: 'asc' }], take: limit + 1, _sum: sums, _min: mins })).map((r) => ({
            date: r.date, key: r.campaignId, spend: r._sum.spend, impressions: r._sum.impressions, linkClicks: r._sum.linkClicks, currency: r._min.currency, campaignId: r.campaignId,
          }));
    more = grouped.length > limit;
    const page = grouped.slice(0, limit);
    items = page.map((r) => {
      const key = String(r.key);
      return {
        date: dayOf(r.date),
        ad_id: key,
        adset_id: level === 'adset' ? key : null,
        campaign_id: level === 'campaign' ? key : (r.campaignId ?? null),
        spend: money(r.spend ?? 0),
        currency: r.currency ?? '',
        impressions: r.impressions ?? null,
        link_clicks: r.linkClicks ?? null,
      };
    });
    const tail = items[items.length - 1];
    last = tail ? { day: tail.date, key: tail.ad_id } : null;
  }

  const pulled = await db.adSpendDay.aggregate({ where: { companyId }, _max: { pulledAt: true } });
  return {
    items,
    next_cursor: more && last ? encodeSpendCursor(last.day, last.key) : null,
    // Never pulled: the epoch, which any reader shows as «قديم» — a required field cannot honestly say «now» for a table that is empty.
    as_of: isoWithOffset(pulled._max.pulledAt ?? new Date(0), AS_OF_ZONE),
  };
}
