import { realDateOf } from './real-date';

/**
 * A PARTNER'S DRAW FROM BEFORE THE PROFIT STARTED (25/11, F13) — the owner's choice «ب» on the open question of A1: the draws count
 * from the SAME start as the profit they are cut against, the store's profit epoch (`profitEpoch`, the day of its first courier
 * statement).
 *
 *   · WHICH DATE: the draw's REAL date — the moment typed for it (`occurredAt`), else its registration (`createdAt`); the date the
 *     ledger shows (`realDateOf`), with the same fallback the wallet and the «المسحوبات» dashboard use. A draw typed for a day before
 *     the epoch and registered after it is before the epoch.
 *   · THE BOUNDARY: the epoch is the first instant of the store's own day; a draw at that instant is counted, one instant earlier is not.
 *   · A REVERSAL FOLLOWS ITS ORIGINAL: only the original OUT row is ever asked; its reversing entry goes with it whatever its own date.
 *   · NO EPOCH (a store with no statement): nothing is before it — every draw counts, exactly as before.
 *
 * Nothing is deleted or hidden: such a draw is LISTED, marked with `BEFORE_PROFIT_AR`, and kept out of the figures the balance is cut
 * from. No wallet balance and no movement changes — this is a reading rule. Pure: no database, no clock.
 */
export const BEFORE_PROFIT_AR = 'قبل بداية الأرباح — ما بتنحسب';

export function drawBeforeProfit(
  draw: { occurredAt?: Date | string | null; createdAt: Date | string },
  epochAt: Date | null | undefined
): boolean {
  if (!epochAt) return false;
  return realDateOf(draw).getTime() < epochAt.getTime();
}
