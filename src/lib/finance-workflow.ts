/**
 * SALESFLOW — Phase D3: Settlement & Finance Workflow Engine
 *
 * Money is ALWAYS Decimal (never floats) — DB Decimal(12,2) + Prisma Decimal.
 * Settlement transitions are controlled server-side; server sets timestamps.
 */

import { Prisma } from '@prisma/client';

export const SETTLEMENT_STATUSES = [  'NOT_APPLICABLE', 'PENDING', 'PARTIALLY_SETTLED', 'SETTLED',
  'REFUNDED', 'PARTIALLY_REFUNDED', 'CANCELLED', 'PENDING_COLLECTION', 'COLLECTED', 'UNSETTLED',
] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

/**
 * Controlled settlement transitions.
 * PENDING_COLLECTION/COLLECTED are legacy bridge states mapped onto the new model.
 */
export const SETTLEMENT_TRANSITIONS: Record<SettlementStatus, SettlementStatus[]> = {
  NOT_APPLICABLE: ['PENDING'],
  PENDING: ['PARTIALLY_SETTLED', 'SETTLED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'CANCELLED'],
  PARTIALLY_SETTLED: ['SETTLED', 'REFUNDED', 'PARTIALLY_REFUNDED'],
  // Every row below that LISTS 'SETTLED' lists what the map allows, not what PATCH /api/orders/:id/finance
  // accepts: that door refuses SETTLED outright (SETTLE_THROUGH_COLLECTION), because it moves no money into a
  // wallet. The only writers of SETTLED are the approval of a courier statement and «استلمت منه».
  SETTLED: ['REFUNDED', 'PARTIALLY_REFUNDED'], // post-settlement refund possible
  REFUNDED: [],                                 // terminal
  PARTIALLY_REFUNDED: ['SETTLED', 'REFUNDED'],
  CANCELLED: [],                                // terminal
  // legacy bridge states (kept compatible with D2 writes)
  PENDING_COLLECTION: ['SETTLED', 'REFUNDED', 'PARTIALLY_REFUNDED'],
  COLLECTED: ['SETTLED', 'REFUNDED', 'PARTIALLY_REFUNDED'],
  UNSETTLED: ['SETTLED', 'REFUNDED', 'PARTIALLY_REFUNDED'],
};

export function isValidSettlementTransition(from: string, to: string): boolean {
  const list = SETTLEMENT_TRANSITIONS[from as SettlementStatus];
  if (!list) return false;
  return list.includes(to as SettlementStatus);
}

/** Transaction types for the append-only ledger */
export const TRANSACTION_TYPES = [
  'REVENUE', 'REFUND', 'EXPENSE', 'COMMISSION', 'SETTLEMENT', 'ADJUSTMENT',
] as const;

/**
 * Compute financial snapshot with Decimal-safe arithmetic (prisma Decimal).
 * All inputs/outputs are Decimal — floats never touch money math.
 *
 * ── IT MULTIPLIED BY QUANTITY TWICE OVER, AND BOTH VALUES WERE ALREADY
 *    WHOLE-ORDER TOTALS ──
 *
 * This read `sellingPrice * quantity` and `productCost * quantity`.
 * MEASURED on the live rows — a three-unit order:
 *
 *     ORD-2026-0030   quantity 3
 *       sellingPrice            36      SUM(quantity × unitPrice) = 36
 *       estimatedCostOfGoods    15
 *
 * So `Order.sellingPrice` IS the subtotal, proved against the lines rather
 * than assumed — `winback-lines.test.ts` says so in writing and the data
 * agrees on every multi-unit row. And every writer of
 * `estimatedCostOfGoods` multiplies by quantity itself
 * (`unitCost * qty` in three doors, `average * l.quantity` in the fourth),
 * so that is the order's total too.
 *
 * What this function therefore produced for that order:
 *
 *     subtotal     36 × 3 = 108     should be 36
 *     productCost  15 × 3 =  45     should be 15
 *     grossProfit  108 − 45 = 63    should be 21
 *
 * Three times the revenue, three times the cost, three times the profit —
 * and it is the ONLY writer of `subtotal`, `totalRevenue`, `grossProfit`
 * and `netProfit`, which the profit screens read. MEASURED: all four
 * columns are null on all 56 orders, because the one route that calls this
 * has no screen. So nothing stored is wrong today, and this is the good
 * moment to fix it — before the first use rather than after.
 *
 * ── THE PARAMETERS ARE NAMED FOR THEIR SCALE NOW ──
 *
 * `subtotal` and `goodsCost`, not `sellingPrice` and `productCost`. The
 * old names invited the multiplication: «price» and «cost» read as
 * per-unit, and a reader has to go and check four writers to find out they
 * are not. A name that carries the scale makes the mistake unwriteable.
 */

/**
 * WHAT THE GOODS ON ONE ORDER COST US — ONE ANSWER, FOR THE WHOLE ORDER.
 *
 * Two columns hold it and they are not the same thing, which is how the
 * figure came to be multiplied twice:
 *
 *   · `estimatedCostOfGoods` — written at creation by every order door, and
 *     every one of them multiplies by quantity. The ORDER's total.
 *   · `productCost` — one of the per-order finance columns, written only by
 *     `PATCH /api/orders/:id/finance`. Null on all 56 live rows, so its
 *     scale was never settled by data — only by this function, which used
 *     to multiply it. It is the TOTAL now, like its neighbour, because the
 *     finance route already fell back from one to the other in a single
 *     `??` chain and a chain whose two links have different scales is a
 *     figure that changes meaning depending on which link answered.
 *
 * Settled rather than documented: zero rows to migrate, and a comment
 * explaining that two interchangeable columns mean different things is a
 * comment that will be read after the mistake.
 */
export function orderGoodsCost(order: {
  productCost?: unknown;
  estimatedCostOfGoods?: unknown;
}): Prisma.Decimal {
  // `??` and not `||`: a typed 0 is a real cost — a free sample — and
  // falling through it to the estimate would charge for a gift.
  const typed = order.productCost ?? null;
  if (typed !== null && typed !== undefined) return new Prisma.Decimal(typed as never);
  return new Prisma.Decimal((order.estimatedCostOfGoods ?? 0) as never);
}

export function computeFinancials(input: {
  /** The order's subtotal — ALREADY the whole order. Never multiplied here. */
  subtotal: any;
  discount?: any; shippingRevenue?: any;
  /** What the goods cost for the WHOLE order. Never multiplied here either. */
  goodsCost?: any;
  packagingCost?: any; shippingCost?: any;
  advertisingCost?: any; otherCost?: any; commission?: any;
}): {
  subtotal: any; totalRevenue: any; totalCost: any;
  grossProfit: any; netProfit: any;
} {
  const D = (v: any) => {
    return new Prisma.Decimal(v ?? 0);
  };
  const add = (a: any, b: any) => D(a).add(D(b));
  const sub = (a: any, b: any) => D(a).sub(D(b));

  const subtotal = D(input.subtotal);
  const totalRevenue = add(subtotal, D(input.discount ?? 0).neg()).add(D(input.shippingRevenue ?? 0));
  const productCost = D(input.goodsCost ?? 0);
  const totalCost = add(productCost, D(input.packagingCost ?? 0))
    .add(D(input.shippingCost ?? 0))
    .add(D(input.advertisingCost ?? 0))
    .add(D(input.otherCost ?? 0))
    .add(D(input.commission ?? 0));
  const grossProfit = sub(totalRevenue, productCost);
  const netProfit = sub(totalRevenue, totalCost);

  return { subtotal, totalRevenue, totalCost, grossProfit, netProfit };
}
