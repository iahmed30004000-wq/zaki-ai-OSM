/**
 * WHAT A CHANGE OF AN ORDER'S DELIVERY FEE LEAVES BEHIND.
 *
 * The fee is not a display. The courier's statement deducts it from what he owes, commission subtracts it
 * before it is computed, and the agent's custody figure carries it — so changing it moves money in three
 * places. The shipping door wrote the new fee and its audit row said only the shipping status and the tracking
 * number: nobody could tell afterwards that a fee had been 2,500 and became 0, or who did it, or why.
 *
 * `Order.deliveryFeeOverrideReason` was documented as «a manual fee override always carries a reason (written to
 * the audit log)» and was written by nothing. This is the one place that decides WHAT a change is, so the order's
 * column, the timeline entry and the audit row cannot disagree about it.
 *
 * Pure: no database, no clock. The route reads the stored fee and the new one and asks.
 */

/** The longest reason the column and the screen accept. */
export const FEE_REASON_MAX = 300;

export interface DeliveryFeeChange {
  /** The stored fee before — null is «not recorded», which is not the same as 0. */
  before: number | null;
  /** The fee after — null clears it. */
  after: number | null;
  /** Why, as the person wrote it; null when nothing was written. */
  reason: string | null;
}

export type DeliveryFeeReasonRead = { ok: true; reason: string | null } | { ok: false };

/**
 * The reason, read from a request body: absent, null and blank are «no reason given»; text is trimmed and
 * bounded; anything else (a number, an object) is refused rather than guessed into a string.
 */
export function readFeeReason(raw: unknown): DeliveryFeeReasonRead {
  if (raw === undefined || raw === null) return { ok: true, reason: null };
  if (typeof raw !== 'string') return { ok: false };
  const t = raw.trim();
  if (t.length > FEE_REASON_MAX) return { ok: false };
  return { ok: true, reason: t || null };
}

const asNumber = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * The change from `before` to `after`, or null when the fee is the same. «Not recorded» (null) and a typed 0 are
 * different states and a move between them IS a change: 30 of 56 live orders hold null, and a 0 is a policy.
 */
export function deliveryFeeChange(before: unknown, after: unknown, reason: string | null): DeliveryFeeChange | null {
  const b = asNumber(before);
  const a = asNumber(after);
  if (b === a) return null;
  return { before: b, after: a, reason };
}
