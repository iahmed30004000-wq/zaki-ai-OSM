import type { Prisma } from '@prisma/client';
import type { db as prismaDb } from './db';
import { FamilyCost, familyRootOf } from './batch-family';

type Tx = Prisma.TransactionClient | typeof prismaDb;

/**
 * WHAT ONE UNIT OF THIS PRODUCT COST US.
 *
 * A product does not have "a" cost. It has a cost per batch: the run you
 * made in March at 3.20 and the delivery you received in June at 4.10 are
 * different money sitting on the same shelf. Every figure that calls itself
 * "the product's cost" is choosing how to blend them, and the choice shows
 * up directly in the profit.
 *
 * What was here read `batches[0].costPerUnit` — whichever batch the query
 * happened to return first. That is not a policy, it is an accident, and it
 * moved the reported profit of every order by the difference between two
 * arbitrary batches.
 *
 * Two honest numbers replace it:
 *
 *   The WEIGHTED AVERAGE of what is still on hand, for estimating the cost
 *   of an order that has not shipped. It answers "if I sell one now, what
 *   did it cost me", and it moves only when real stock arrives at a real
 *   price.
 *
 *   The CONSUMED cost, recorded when the goods actually leave, taken from
 *   the batches the draw-down emptied — oldest first. That is the figure
 *   that belongs in a closed order's profit, because it is the money that
 *   actually left.
 */

export interface ProductCost {
  /** Weighted average across the batches still holding units. */
  average: number;
  /** Units on hand that the average is computed over. */
  onHand: number;
  /** Total money sitting in stock for this product. */
  stockValue: number;
  /** The cost of the batch the next sale will draw from, oldest first. */
  nextOut: number;
  /** Batches still holding units. */
  batchCount: number;
}

const ZERO: ProductCost = { average: 0, onHand: 0, stockValue: 0, nextOut: 0, batchCount: 0 };

/**
 * The cumulative cost of a product, from its batches.
 *
 * Batches holding nothing are excluded: an emptied run tells you what March
 * cost, not what a unit costs today, and averaging it back in drags the
 * figure towards a price you can no longer buy at.
 */
export async function productCost(tx: Tx, companyId: string, productId: string): Promise<ProductCost> {
  const batches = await tx.productionBatch.findMany({
    where: { companyId, productId, quantityRemaining: { gt: 0 } },
    orderBy: { productionDate: 'asc' },
    select: { id: true, quantityRemaining: true, costPerUnit: true, splitFromBatchId: true },
  });
  if (batches.length === 0) return ZERO;

  const onHand = batches.reduce((sum, b) => sum + b.quantityRemaining, 0);
  // One run's units are costed once, however many places they sit in (`batch-family.ts`).
  const familyOf = await familyRootOf(tx, companyId, [productId], batches);
  const value = new FamilyCost();
  for (const b of batches) value.add(familyOf(b), b.quantityRemaining, b.costPerUnit);
  const stockValue = value.total();

  return {
    onHand,
    stockValue: round(stockValue),
    average: onHand > 0 ? round(stockValue / onHand) : 0,
    nextOut: batches[0].costPerUnit,
    batchCount: batches.length,
  };
}

/** The same figure for several products at once, without a query each. */
export async function productCosts(
  tx: Tx,
  companyId: string,
  productIds: string[]
): Promise<Map<string, ProductCost>> {
  const out = new Map<string, ProductCost>();
  if (productIds.length === 0) return out;

  const batches = await tx.productionBatch.findMany({
    where: { companyId, productId: { in: productIds }, quantityRemaining: { gt: 0 } },
    orderBy: { productionDate: 'asc' },
    select: { id: true, productId: true, quantityRemaining: true, costPerUnit: true, splitFromBatchId: true },
  });

  for (const id of productIds) out.set(id, ZERO);

  // One run's units are costed once, however many places they sit in (`batch-family.ts`).
  const familyOf = await familyRootOf(tx, companyId, productIds, batches);
  const grouped = new Map<string, { qty: number; value: FamilyCost; first: number; count: number }>();
  for (const b of batches) {
    const g = grouped.get(b.productId) ?? { qty: 0, value: new FamilyCost(), first: b.costPerUnit, count: 0 };
    g.qty += b.quantityRemaining;
    g.value.add(familyOf(b), b.quantityRemaining, b.costPerUnit);
    g.count += 1;
    grouped.set(b.productId, g);
  }

  for (const [id, g] of grouped) {
    const value = g.value.total();
    out.set(id, {
      onHand: g.qty,
      stockValue: round(value),
      average: g.qty > 0 ? round(value / g.qty) : 0,
      nextOut: g.first,
      batchCount: g.count,
    });
  }
  return out;
}

/**
 * A batch's total, from its four legacy buckets plus its free-form lines.
 *
 * The buckets are not dropped: a hundred and four live batches carry their
 * costs in them, and rewriting those would change the recorded cost of goods
 * on orders that are already closed.
 */
export function batchTotal(input: {
  manufacturingCost?: number;
  packagingCost?: number;
  rawMaterialCost?: number;
  otherCosts?: number;
  costLines?: { amount: number }[];
}): { total: number } {
  const buckets =
    (input.manufacturingCost || 0) +
    (input.packagingCost || 0) +
    (input.rawMaterialCost || 0) +
    (input.otherCosts || 0);
  const lines = (input.costLines ?? []).reduce((sum, l) => sum + (l.amount || 0), 0);
  return { total: round(buckets + lines) };
}

/** Cost per unit of a batch, to four places — fractions of a cent matter at scale. */
export function batchUnitCost(total: number, quantityProduced: number): number {
  if (!quantityProduced || quantityProduced <= 0) return 0;
  return Number((total / quantityProduced).toFixed(4));
}

function round(n: number): number {
  return Number(n.toFixed(4));
}
