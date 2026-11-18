import { db } from './db';
import { localDay } from './eod-report';
import { whereDelivered } from './order-state';
import { profitWindow, type ProfitWindow } from './profit-to-date';
import { notSuperseded } from './superseded';

/**
 * ONE ROW PER DAY — THE DOOR THE DASHBOARD'S ONE CHART READS (plan 17/11, R9).
 *
 * Nothing in the system answered «كم طلب كل يوم»: the dashboard's answer is one number per window, and a chart cannot be drawn from
 * a number. The screen was not allowed to build the series itself — it would be counting in the browser, and two screens would then
 * disagree about when a day begins. So the days are cut HERE, in the STORE's own clock (the same `localDay` the daily closing uses),
 * and the screen only draws what it is given.
 *
 * WHAT IS COUNTED — three events, each on the day it HAPPENED, not on the day the order was made:
 *   created    the order arrived (`createdAt`)
 *   confirmed  the order was confirmed (`confirmedAt`)
 *   delivered  the courier's delivery (`deliveredAt`, on the shared «delivered» definition — a partial delivery is one too)
 * An order replaced by another is not a second sale, so none of the three counts it (`notSuperseded`, the rule every count follows).
 * Counts only. No amount is added up or shown here: the money figures keep their own doors, and a chart of orders must not become a
 * second way to read the profit.
 *
 * NEVER CLAMPED SILENTLY. A span longer than {@link MAX_SERIES_DAYS} is REFUSED, not shortened: a chart that quietly drew 90 days
 * under a «this year» label would be the defect the profit span was built to avoid. A day with no event is a row of zeros, so a quiet
 * day is drawn as quiet and not skipped.
 */
export const MAX_SERIES_DAYS = 92;

/** A ceiling on the rows read per event; reaching it is said in the answer, never hidden. */
const ROW_CAP = 60_000;

export interface SeriesDay {
  /** The store's own day, `YYYY-MM-DD`. */
  day: string;
  created: number;
  confirmed: number;
  delivered: number;
}

export interface DailySeries {
  days: SeriesDay[];
  totals: { created: number; confirmed: number; delivered: number };
  /** True when one of the three reads hit its row ceiling: the counts are then a floor, and the screen must say so. */
  truncated: boolean;
}

export type SeriesSpan =
  | { ok: true; window: ProfitWindow; days: string[] }
  | { ok: false; reason: 'invalid' | 'too-long' };

/** Every day from `from` to `to`, inclusive, as `YYYY-MM-DD`. Both are real days (checked by `profitWindow`). */
function eachDay(from: string, to: string): string[] {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const out: string[] = [];
  const last = Date.UTC(ty, tm - 1, td);
  for (let t = Date.UTC(fy, fm - 1, fd); t <= last; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** «from» and «to» as days of the store → the instants they cover and the days between. Refuses a span that is not two real days in order, or is too long. */
export function seriesSpan(from: string | null | undefined, to: string | null | undefined, timeZone: string): SeriesSpan {
  const window = profitWindow(from, to, timeZone);
  if (!window || !from || !to) return { ok: false, reason: 'invalid' };
  const days = eachDay(from, to);
  if (days.length > MAX_SERIES_DAYS) return { ok: false, reason: 'too-long' };
  return { ok: true, window, days };
}

export async function dailySeries(
  scope: { companyId: string; storeId: string },
  span: { window: ProfitWindow; days: string[] },
  timeZone: string,
): Promise<DailySeries> {
  const { companyId, storeId } = scope;
  const inWindow = { gte: span.window.start, lt: span.window.end };
  const base = { companyId, storeId, ...notSuperseded };

  const [created, confirmed, delivered] = await Promise.all([
    db.order.findMany({ where: { ...base, createdAt: inWindow }, select: { createdAt: true }, take: ROW_CAP }),
    db.order.findMany({ where: { ...base, confirmedAt: inWindow }, select: { confirmedAt: true }, take: ROW_CAP }),
    db.order.findMany({ where: { ...base, ...whereDelivered(), deliveredAt: inWindow }, select: { deliveredAt: true }, take: ROW_CAP }),
  ]);

  const rows = new Map<string, SeriesDay>(span.days.map((day) => [day, { day, created: 0, confirmed: 0, delivered: 0 }]));
  const bump = (at: Date | null, field: 'created' | 'confirmed' | 'delivered') => {
    if (!at) return;
    const row = rows.get(localDay(at, timeZone));
    if (row) row[field] += 1;
  };
  for (const o of created) bump(o.createdAt, 'created');
  for (const o of confirmed) bump(o.confirmedAt, 'confirmed');
  for (const o of delivered) bump(o.deliveredAt, 'delivered');

  const days = span.days.map((day) => rows.get(day)!);
  return {
    days,
    totals: {
      created: days.reduce((s, d) => s + d.created, 0),
      confirmed: days.reduce((s, d) => s + d.confirmed, 0),
      delivered: days.reduce((s, d) => s + d.delivered, 0),
    },
    truncated: created.length >= ROW_CAP || confirmed.length >= ROW_CAP || delivered.length >= ROW_CAP,
  };
}
