import type { Prisma } from '@prisma/client';
import type { db as prismaDb } from './db';
import { productCosts, type ProductCost } from './product-cost';
import { roundMinor } from './money';

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
 * This file is the one place that says which of the two answers is taken. The screens ask `withFixedCost`; the ORDERS ask
 * `unitCostsOf` (every door that raises an order, the lines edit) and `fixedCostsOf` (the delivery, which prices the goods that
 * really left, and the doors that copy an order). An order already written keeps what it was written with: a figure applies to the
 * orders costed after it was set — one raised, a line moved, a delivery recorded — and rewrites no row.
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

/**
 * WHAT ONE UNIT OF EACH OF THESE PRODUCTS COSTS AN ORDER — the one answer every door that raises an order asks (the owner, 1/11).
 *
 *   1. the product's FIXED figure, when an admin set one — and ZERO is a figure (`??`, never `||`): an item that costs nothing is
 *      a real answer, and an order of it costs nothing;
 *   2. otherwise what the batches on hand say — the weighted average, exactly as every door read it before (`productCosts`);
 *   3. otherwise 0: a product with no figure and no costed stock on hand, or one that is not there at all.
 *
 * ONE ANSWER PER PRODUCT ASKED. The map holds an entry for every distinct id handed in, so a caller reads `.get(id) ?? 0` and never
 * has to ask itself whether «absent» meant «free» or «unknown». AT MOST TWO QUERIES, however many products: the figures, then —
 * only for the products that have none — the batches. A product with a figure never reads a batch.
 *
 * The company is part of both questions: a figure or a batch of another company's product with the same id answers nothing here.
 * Rounding is the caller's, by the currency, as it always was: this returns the unit cost, not a total.
 */
export async function unitCostsOf(tx: Tx, companyId: string, productIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = [...new Set(productIds)];
  if (ids.length === 0) return out;
  const fixed = await fixedCostsOf(tx, companyId, ids);
  const unfixed = ids.filter((id) => !fixed.has(id));
  const batches = unfixed.length > 0 ? await productCosts(tx, companyId, unfixed) : new Map<string, ProductCost>();
  for (const id of ids) out.set(id, fixed.get(id) ?? batches.get(id)?.average ?? 0);
  return out;
}

/**
 * THE COST OF AN ORDER THAT IS A COPY OF ANOTHER — the figures put on what the copy already carries (the owner, 1/11).
 *
 * A replacement, or a box handed to another customer, is not costed from the shelf: it takes a share of the cost of the order it
 * stands for (`base`, scaled by the door exactly as it always was). A cost is stored PER ORDER, not per line, so there is no line to
 * read the old figure from. What this adds is the owner's rule: a line whose product has a fixed figure costs the figure × its units
 * (the gift included — a free unit is free to the customer, never to the shop), whatever the order it copies was struck at.
 *
 * The lines with no figure keep their share of `base`, by the units they hold: the order's own average per unit, which is also how a
 * lines edit estimates the part nobody touched. NO LINE WITH A FIGURE, NOTHING CHANGES: `base` comes back as it was handed in, not
 * a rounded copy of it. When every line has a figure the answer is simply Σ figure × units. Rounded by the currency, like the money
 * beside it.
 */
export function costOfACopy(
  base: number,
  lines: ReadonlyArray<{ productId: string; units: number }>,
  fixed: ReadonlyMap<string, number>,
  minorUnit: number
): number {
  const withFigure = lines.filter((l) => fixed.has(l.productId));
  const units = lines.reduce((n, l) => n + l.units, 0);
  if (withFigure.length === 0 || !(units > 0)) return base;
  const figureUnits = withFigure.reduce((n, l) => n + l.units, 0);
  const figureCost = withFigure.reduce((sum, l) => sum + (fixed.get(l.productId) as number) * l.units, 0);
  // A `base` that is not a number (undefined, NaN) has no share to give: it is NOT allowed to turn the lines that DO have a figure into 0
  // (`undefined * 0` is NaN, and `roundMinor(NaN)` is 0) — the independent review, 2/11. Both callers hand a real number today.
  const rest = Number.isFinite(base) ? (base * (units - figureUnits)) / units : 0;
  return roundMinor(figureCost + rest, minorUnit);
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
