/**
 * ═══════════════════════════════════════════════════════════════════════
 * QUEUE PRIORITY v2 — THE PURE RULES (Confirmation Center v2, step D1). Nothing here reads a database or a clock.
 *
 * The study of 7–14/11 (1,751 unique orders) says the backlog starved: new orders always went first, so a «لا يرد» order waited days behind a stream that never stopped.
 * The ruling is a ratio that follows the data, not a number written in code:
 *
 *   · the BASE ORDER stays: a customer's promise (he asked to be called) · a NEW order · a «لا يرد» retry whose due arrived · a postponed order due.
 *     (Leads are priority 3 and winback 6 when those steps exist — E and F; this file does not know them yet.)
 *   · a FRESH order (under 15 minutes) always goes before the backlog: the customer has just ordered, the call is warm.
 *   · AGING: a retry that has waited MORE than 2 hours past its due outranks the NEW orders older than 15 minutes.
 *   · THE SHARE: of an agent's pulls, about `share` go to the backlog and the rest to new orders — a ratio the system computes from the last 7 days, clamped to 25%–50%.
 *     If no backlog item is due, the pull falls back to new (and the other way round).
 *   · TIME-OF-DAY MODES: 09:00–11:00 (the night's orders first, then the backlog) and 21:00–24:00 (the arrival peak: new first) — in both the share and the aging are
 *     SUSPENDED and the order is the plain base order: new first, oldest first.
 *
 * Every rule is tied to the SHIFT and the ROLE, never to a person: whoever fills the shift is dealt the same hand.
 * ═══════════════════════════════════════════════════════════════════════
 */

export const QUEUE_PRIORITY = {
  /** A new order younger than this is «fresh»: it goes before any backlog. */
  freshMinutes: 15,
  /** A retry due this long ago (or more) outranks the new orders that are not fresh. */
  agingHours: 2,
  /** The share is never below this… */
  shareMin: 0.25,
  /** …nor above this. */
  shareMax: 0.5,
  /** Used when the last 7 days have nothing to count (a new store): the steady-state figure of the study. */
  shareDefault: 0.37,
  /** The window the share is computed over. */
  windowDays: 7,
  /** Backlog older than this many hours is «stock»… */
  staleStockHours: 48,
  /** …and while the stock is above this many orders, a fifth of it is added to the backlog side of the ratio. */
  staleStockThreshold: 50,
  staleStockDivisor: 5,
  /** How many of an agent's latest pulls the ratio is balanced over. */
  recentPulls: 12,
} as const;

export type PullLane = 'NEW' | 'BACKLOG';

/** The time-of-day modes, as local minutes since midnight, `to` exclusive (24:00 = 1440). Settings can override them in a later step; the defaults are the study's. */
export const QUEUE_MODES = {
  nightFirst: { from: 9 * 60, to: 11 * 60 },
  peakNewFirst: { from: 21 * 60, to: 24 * 60 },
} as const;

export type QueueMode = 'NIGHT_FIRST' | 'PEAK_NEW_FIRST' | 'NORMAL';

/** The mode at a local time of day (minutes since 00:00). Both named modes are «new first, oldest first»: they suspend the share and the aging. */
export function queueModeAt(localMinutes: number): QueueMode {
  if (localMinutes >= QUEUE_MODES.nightFirst.from && localMinutes < QUEUE_MODES.nightFirst.to) return 'NIGHT_FIRST';
  if (localMinutes >= QUEUE_MODES.peakNewFirst.from && localMinutes < QUEUE_MODES.peakNewFirst.to) return 'PEAK_NEW_FIRST';
  return 'NORMAL';
}

/** An order created AFTER this instant is «fresh» (younger than `freshMinutes`). */
export function freshSince(now: Date): Date {
  return new Date(now.getTime() - QUEUE_PRIORITY.freshMinutes * 60_000);
}

/** A retry whose due is more than `agingHours` behind `now`. */
export function isAged(dueAt: Date | string | number, now: Date): boolean {
  return now.getTime() - new Date(dueAt).getTime() > QUEUE_PRIORITY.agingHours * 3_600_000;
}

/** What the share is computed from — three counts over the store, read by `queue-priority-share.ts`. */
export interface ShareInputs {
  /** Distinct customers who ordered in the last 7 days (a repeat by the same person is one). */
  newUnique: number;
  /** Distinct orders that became backlog in the last 7 days: an order whose first «لا يرد» line is that recent. */
  backlogEntered: number;
  /** Open backlog orders older than 48 hours. */
  staleStock: number;
}

export interface ShareResult {
  share: number;
  /** The ratio before the clamp; null when there was nothing to count. */
  raw: number | null;
  clamp: 'MIN' | 'MAX' | 'DEFAULT' | null;
  numerator: number;
  denominator: number;
  staleAdded: number;
}

/** share = (backlog that entered in 7 days [+ stock over 48 h ÷ 5, while the stock is over 50]) ÷ (new unique + backlog that entered), clamped to 25%–50%. */
export function backlogShare(i: ShareInputs): ShareResult {
  const q = QUEUE_PRIORITY;
  const staleAdded = i.staleStock > q.staleStockThreshold ? i.staleStock / q.staleStockDivisor : 0;
  const numerator = i.backlogEntered + staleAdded;
  const denominator = i.newUnique + i.backlogEntered;
  if (denominator <= 0) return { share: q.shareDefault, raw: null, clamp: 'DEFAULT', numerator, denominator, staleAdded };
  const raw = numerator / denominator;
  if (raw < q.shareMin) return { share: q.shareMin, raw, clamp: 'MIN', numerator, denominator, staleAdded };
  if (raw > q.shareMax) return { share: q.shareMax, raw, clamp: 'MAX', numerator, denominator, staleAdded };
  return { share: raw, raw, clamp: null, numerator, denominator, staleAdded };
}

/**
 * Is it the backlog's turn? Over her latest pulls (newest first, at most `recentPulls`): the next pull goes to the backlog when it would not push the backlog's part of her
 * pulls above the share. 37% gives new, new, BACKLOG, new, new, BACKLOG… — about one pull in three, which is the study's steady state.
 */
export function wantsBacklog(share: number, recent: readonly PullLane[]): boolean {
  const window = recent.slice(0, QUEUE_PRIORITY.recentPulls);
  const backlog = window.filter((l) => l === 'BACKLOG').length;
  return (backlog + 1) / (window.length + 1) <= share + 1e-9;
}

/** The lane the claim history keeps in its `metadata` — anything else (an old line, a broken JSON) is «not counted». */
export function laneOfMetadata(metadata: string | null | undefined): PullLane | null {
  if (!metadata) return null;
  try {
    const lane = (JSON.parse(metadata) as { lane?: unknown }).lane;
    return lane === 'NEW' || lane === 'BACKLOG' ? lane : null;
  } catch {
    return null;
  }
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** «قاعدة الاحتساب»: the share and how it was reached, in plain Arabic with Western digits — the sentence the settings card shows. */
export function shareNote(r: ShareResult, i: ShareInputs): string {
  const q = QUEUE_PRIORITY;
  if (r.clamp === 'DEFAULT') {
    return `نسبة المتأخر ${pct(r.share)} (القيمة الافتراضية: ما في طلبات بآخر ${q.windowDays} أيام تنحسب منها).`;
  }
  const stale = r.staleAdded > 0 ? ` + (${i.staleStock} طلب أقدم من ${q.staleStockHours} ساعة ÷ ${q.staleStockDivisor})` : '';
  const clamp = r.clamp === 'MIN' ? ` — النتيجة ${pct(r.raw ?? 0)} فرُفعت للحد الأدنى ${pct(q.shareMin)}` : r.clamp === 'MAX' ? ` — النتيجة ${pct(r.raw ?? 0)} فنزلت للحد الأعلى ${pct(q.shareMax)}` : '';
  return `نسبة المتأخر ${pct(r.share)}. قاعدة الاحتساب: (${i.backlogEntered} طلب صار متأخر بآخر ${q.windowDays} أيام${stale}) ÷ (${i.newUnique} زبون جديد + ${i.backlogEntered})، محصورة بين ${pct(q.shareMin)} و${pct(q.shareMax)}${clamp}.`;
}
