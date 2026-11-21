import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { answersSchema, countersOf, readCount, recordAnswers } from '@/lib/stock-counts';
import { combosOf, labelLineVariants, variantLabelsOf } from '@/lib/variant-lines';
import { countAction, countRefusalOf, shownFor } from '@/lib/stock-count-door';

/**
 * GET   /api/inventory/counts/:id (inventory.view) — one sheet with its lines (each with its product's name), through
 *       the blind rule: a person without `inventory.count_approve` is told only what was counted.
 *       21/11 (W5b): each line also names its product's ACTIVE combinations (`combinations`: id and label — a word, never
 *       a figure, so the keeper's screen knows which boxes to draw without asking a door that answers the shelf); the
 *       combinations already answered carry their label; `youCounted` says whether the caller had a hand in the count
 *       (`countersOf`, the approval's own two-hands rule) so the screen hides «اعتمد» from her — the approval door decides.
 * PATCH /api/inventory/counts/:id (inventory.count) — the keeper's answers: `{ lines: [{ productId, counted, variants? }] }`;
 *       a line may be answered again while the sheet is open
 *
 * The warehouse plan, request W5a. Every rule is in `src/lib/stock-counts.ts`.
 */

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('inventory.view');
    try {
      const count = await readCount(db, companyId, storeId, id);
      const productIds = count.lines.map((l) => l.productId);
      const [products, warehouse, combos, labels] = await Promise.all([
        db.product.findMany({ where: { id: { in: productIds }, companyId }, select: { id: true, name: true, sku: true } }),
        db.warehouse.findFirst({ where: { id: count.warehouseId, companyId }, select: { name: true } }),
        combosOf(db, companyId, productIds),
        variantLabelsOf(db, companyId, count.lines.flatMap((l) => ('variants' in l && l.variants ? l.variants.map((v) => v.variantId) : []))),
      ]);
      const names = new Map(products.map((p) => [p.id, p]));
      const shown = shownFor(user, count);
      const activeOf = (productId: string) =>
        [...(combos.get(productId)?.byId ?? new Map<string, { label: string; status: string }>())]
          .filter(([, c]) => c.status === 'ACTIVE')
          .map(([variantId, c]) => ({ variantId, label: c.label }));
      return NextResponse.json({
        count: {
          ...shown,
          warehouseName: warehouse?.name ?? null,
          youCounted: countersOf(count).has(user.id),
          lines: shown.lines.map((l) => ({
            ...labelLineVariants(l, labels),
            productName: names.get(l.productId as string)?.name ?? null,
            sku: names.get(l.productId as string)?.sku ?? null,
            combinations: activeOf(l.productId as string),
          })),
        },
      });
    } catch (e) {
      const refused = countRefusalOf(e);
      if (refused) return refused;
      throw e;
    }
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return countAction(req, params, {
    gate: () => requirePermission('inventory.count'),
    schema: answersSchema,
    audit: 'STOCK_COUNT_ANSWERED',
    run: async (tx, p) => ({
      count: await recordAnswers(tx, { companyId: p.companyId, storeId: p.storeId, countId: p.countId, countedById: p.userId, body: p.body, mayUse: p.mayUse }),
      replay: false,
    }),
  });
}
