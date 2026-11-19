import type { Prisma } from '@prisma/client';
import type { db as prismaDb } from './db';

type Tx = Prisma.TransactionClient | typeof prismaDb;

/**
 * A RUN AND THE ROWS SPLIT FROM IT ARE ONE LAYER OF COST — for the money arithmetic (the warehouse plan, W1a).
 *
 * When units of a batch change place, a twin row holds them at the run's unit cost (`batch-split.ts`). The units are the
 * same units; only their address changed. But floating-point arithmetic is not indifferent to the split: 15 units at
 * 17.4047 is `15 × 17.4047`, and 10 + 5 of them is `10 × 17.4047 + 5 × 17.4047` — a different double, and on an exact
 * half the currency's rounding goes the other way. So every reader that multiplies units by a unit cost (the draw-down's
 * consumed cost, the stock value and its average) first adds up the units of ONE FAMILY — a run and every row split from
 * it, at any depth — and multiplies once, exactly as it did before the split.
 *
 * A store that was never placed has no twin: every row is its own family, the sums are taken in the same order, and the
 * arithmetic is the main branch's to the bit (proven by a differential against frozen output).
 */

/** Resolves each row to its family's root. Reads nothing when none of the rows was split from another. */
export async function familyRootOf(
  tx: Tx,
  companyId: string,
  productIds: readonly string[],
  rows: readonly { id: string; splitFromBatchId?: string | null }[]
): Promise<(row: { id: string; splitFromBatchId?: string | null }) => string> {
  if (!rows.some((r) => r.splitFromBatchId)) return (row) => row.id;
  // Every twin of these products (a parent emptied by draws is not among `rows`, and a chain can be several deep).
  const twins = await tx.productionBatch.findMany({
    where: { companyId, productId: { in: [...new Set(productIds)] }, splitFromBatchId: { not: null } },
    select: { id: true, splitFromBatchId: true },
  });
  const parent = new Map<string, string>();
  for (const t of twins) if (t.splitFromBatchId) parent.set(t.id, t.splitFromBatchId);
  for (const r of rows) if (r.splitFromBatchId) parent.set(r.id, r.splitFromBatchId);
  return (row) => {
    let id = row.id;
    const seen = new Set<string>();
    while (parent.has(id) && !seen.has(id)) {
      seen.add(id);
      id = parent.get(id)!;
    }
    return id;
  };
}

/**
 * Units grouped by family (and unit cost — a family has one), in the order each family first appears; then
 * Σ (units × cost) over the families in that order. With no twins this is `Σ units × cost` row by row, in row order.
 */
export class FamilyCost {
  private readonly groups = new Map<string, { units: number; cost: number }>();

  add(family: string, units: number, unitCost: number) {
    const key = `${family}|${unitCost}`;
    const g = this.groups.get(key);
    if (g) g.units += units;
    else this.groups.set(key, { units, cost: unitCost });
  }

  total(): number {
    let sum = 0;
    for (const g of this.groups.values()) sum += g.units * g.cost;
    return sum;
  }
}
