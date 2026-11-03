import { FILTERABLE_STATES, deriveCoreState, type CoreState } from '@/lib/order-state';
import { roundMinor } from '@/lib/money';

/**
 * THE FIGURES ABOVE THE ORDERS LIST — folded from what the database answered, and nothing else.
 *
 * Pure: the route asks one `groupBy` and one `aggregate` and hands both here. No price is worked out: every sum is a sum the
 * database made of a column the list already carries (`totalAmount`, `netProfit`), rounded to the
 * currency's own minor unit only because a float sum of a thousand prices ends in …0000001.
 */

/** One group of the state query: the three columns `deriveCoreState` reads, and how many orders share them. */
export interface StateGroup {
  confirmationStatus: string;
  shippingStatus: string;
  claimedById: string | null;
  _count: { _all: number };
}

/**
 * Each filterable state with how many orders are in it — in the dropdown's order, zero included, so a screen that draws only
 * the non-zero ones decides that itself. A group whose state is not filterable (nothing can be filtered to it) is counted
 * in the total and in no chip.
 */
export function stateCounts(groups: readonly StateGroup[]): { states: { state: CoreState; count: number }[]; total: number } {
  const by = new Map<CoreState, number>();
  let total = 0;
  for (const g of groups) {
    const n = g._count?._all ?? 0;
    total += n;
    const state = deriveCoreState({ confirmationStatus: g.confirmationStatus, shippingStatus: g.shippingStatus, claimedById: g.claimedById });
    by.set(state, (by.get(state) ?? 0) + n);
  }
  return { states: FILTERABLE_STATES.map((state) => ({ state, count: by.get(state) ?? 0 })), total };
}

/** What `db.order.aggregate` hands back; Decimal columns arrive as objects with `toString`, Float ones as numbers. */
export interface OrderTotals {
  _count: { _all: number; netProfit?: number };
  _sum: { totalAmount?: unknown; netProfit?: unknown };
}

export interface OrderCards {
  orders: number;
  value: number;
  /** `null` when there is nothing to average. */
  average: number | null;
  /** Present only for whoever the list hands an order's profit to: the net profit of the orders finance has finalised, and how many. */
  profit?: { value: number; orders: number };
}

const num = (v: unknown): number => {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'number' ? v : Number(String(v));
  return Number.isFinite(n) ? n : 0;
};

export function orderSummary(totals: OrderTotals, opts: { withProfit: boolean; minorUnit: number }): OrderCards {
  const orders = totals._count?._all ?? 0;
  const value = roundMinor(num(totals._sum?.totalAmount), opts.minorUnit);
  const cards: OrderCards = {
    orders,
    value,
    average: orders > 0 ? roundMinor(value / orders, opts.minorUnit) : null,
  };
  if (opts.withProfit) {
    cards.profit = { value: roundMinor(num(totals._sum?.netProfit), opts.minorUnit), orders: totals._count?.netProfit ?? 0 };
  }
  return cards;
}
