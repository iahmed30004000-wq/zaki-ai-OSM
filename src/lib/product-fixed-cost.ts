import type { Prisma } from '@prisma/client';
import type { db as prismaDb } from './db';
import type { ProductCost } from './product-cost';

type Tx = Prisma.TransactionClient | typeof prismaDb;

/**
 * THE COST OF A PRODUCT THAT DOES NOT MOVE (the owner, 1/11).
 *
 * «سعر تكلفة المنتج يكون ثابت ولا يتغير ابدا… ثابت لكل الطلبات وما يتغير تحت اي ظرف، اللي بيقدر يغيرو الادمنة فقط من قائمة
 * المنتجات.» `product-cost.ts` answers «what did one unit cost on the day I asked» from the batches on hand — a weighted average that
 * moves whenever stock arrives or leaves, so the profit of one order moved with the shelf around it. This is the other answer: ONE
 * figure per product, typed by an admin (`ProductFixedCost`), that nothing recomputes.
 *
 * NO FIGURE, NO CHANGE. A product with no row here costs exactly what it did: the weighted average of its batches. Nothing is
 * written for the products that exist; an admin sets each one by hand, from the products list.
 *
 * This file is the one place that says which of the two answers a screen takes (`withFixedCost`). What an ORDER is priced from is a
 * separate step, taken door by door after this one — nothing here changes an order.
 */

/** The fixed cost of each of these products that has one. A product with none is simply absent from the map. */
export async function fixedCostsOf(tx: Tx, companyId: string, productIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (productIds.length === 0) return out;
  const rows = await tx.productFixedCost.findMany({
    where: { companyId, productId: { in: productIds } },
    select: { productId: true, amount: true },
  });
  for (const r of rows) out.set(r.productId, r.amount);
  return out;
}

const round4 = (n: number) => Number(n.toFixed(4));

/**
 * A product's cost AS THE SCREENS SHOW IT. With a fixed figure, the unit cost and the cost of the next unit out ARE that figure, and
 * the stock is worth what is on hand times it; without one, the cost is what the batches say, untouched. `batchCount` and `onHand`
 * are the shelf's, never the figure's.
 */
export function withFixedCost(cost: ProductCost, fixed: number | undefined): ProductCost {
  if (fixed === undefined) return cost;
  return { ...cost, average: fixed, nextOut: fixed, stockValue: round4(cost.onHand * fixed) };
}
