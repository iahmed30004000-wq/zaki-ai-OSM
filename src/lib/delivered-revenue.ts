/**
 * THE REVENUE OF ONE DELIVERED ORDER — ONE RULE, READ BY THE DASHBOARD AND BY THE PROFIT SCREEN (25/11, A1).
 *
 * What the courier PAID for it on a statement (`collectedAmount`) when that is known, else the order's own price (`totalAmount`)
 * until its statement arrives. A partial delivery is exactly the case where the two differ, and it is the money taken that is revenue.
 *
 * The dashboard (`analytics.ts`) adds it up inside PostgreSQL, where Prisma has no COALESCE aggregate, so it sums the two halves
 * apart with the two clauses below; the profit screen (`profit-to-date.ts`) adds it up row by row with `revenueOf`. Both are this
 * file: the halves are exactly the rows `revenueOf` reads `collectedAmount` for, and the rows it falls back to `totalAmount` for.
 * `api/finance/the-profit-and-the-dashboard-agree-on-revenue.test.ts` holds them to the same number on the same orders.
 */

/** The orders whose revenue is what was collected: the courier's figure is known. */
export const whereRevenueIsCollected = () => ({ collectedAmount: { not: null } });

/** The orders whose revenue is still their price: no figure collected yet. */
export const whereRevenueIsPrice = () => ({ collectedAmount: null });

/** One order: `collectedAmount ?? totalAmount`. `collectedAmount` is a Decimal column, so it is read as a number here. */
export function revenueOf(order: { collectedAmount?: unknown; totalAmount: number }): number {
  return order.collectedAmount !== null && order.collectedAmount !== undefined ? Number(order.collectedAmount) : order.totalAmount;
}
