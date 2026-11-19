import { NextResponse } from 'next/server';
import { z } from 'zod';
import { money as moneyInput } from '@/lib/numeric-input';
import { apiErrorResponse } from '@/lib/api-error';
import { db } from '@/lib/db';
import { inStore } from '@/lib/store-filter';
import { requireContext } from '@/lib/geo-context';
import { batchTotal, batchUnitCost } from '@/lib/product-cost';
import { logAudit } from '@/lib/audit';
import { requirePermission } from '@/lib/authorization';
import { zodMessage } from '@/lib/zod-message';
import { descendantsOf } from '@/lib/batch-split';

/**
 * PATCH /api/production/[id] — correct what a run cost.
 *
 * Batches could be created and never corrected, and most of this company's
 * stock was entered at a cost of zero. Every profit figure in the system is
 * therefore gross wearing the word "صافي": the arithmetic is right and the
 * input is missing.
 *
 * Correcting it is legitimate and is not the same as editing a financial
 * record: there is no posting to reverse, only a number that was never
 * entered. A reversing entry would be the wrong instrument.
 *
 * WHAT THIS DOES AND DOES NOT REACH. An order's COGS is SNAPSHOTTED when it
 * is created (orders/route.ts takes the weighted average cost at that
 * moment), and that is the right design — last quarter's profit must not
 * change every time a new batch is entered. So correcting a batch fixes:
 *
 *   the remaining stock's value, and every order created FROM NOW ON.
 *
 * It does NOT reach orders already written. An order sold while the batch
 * read zero carries zero for good unless somebody deliberately backfills
 * it, which is a separate decision about historical figures and not
 * something a cost correction should do behind anyone's back.
 *
 * What it does not touch either: the quantity. Produced, sold and remaining
 * are the stock ledger's, and a quantity changed here would silently break
 * the identity that every movement must add up to. Cost only.
 */

interface Ctx {
  params: Promise<{ id: string }>;
}

const money = moneyInput(100_000_000);

const schema = z.object({
  manufacturingCost: money.optional(),
  packagingCost: money.optional(),
  rawMaterialCost: money.optional(),
  otherCosts: money.optional(),
  /** Replaces the named lines as a set: what is sent IS the list now. */
  costLines: z
    .array(z.object({ label: z.string().trim().min(1).max(80), amount: money }))
    .max(30)
    .optional(),
  /** Why it changed. A cost correction with no reason is a mystery later. */
  reason: z.string().trim().max(200).optional().nullable(),
});

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('production.manage');
    const { id } = await ctx.params;

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: zodMessage(parsed.error) },
        { status: 400 }
      );
    }

    const batch = await db.productionBatch.findFirst({
      where: { id, ...inStore(companyId, storeId) },
      include: { costLines: { orderBy: { sortOrder: 'asc' }, select: { label: true, amount: true } } },
    });
    if (!batch) {
      return NextResponse.json({ error: 'الدفعة غير موجودة' }, { status: 404 });
    }

    /*
     * A ROW SPLIT FROM A RUN IS NOT A RUN (the warehouse plan, `batch-split.ts`).
     *
     * When units of a batch change place, a twin row holds them with `quantityProduced` 0 and the run's own unit cost. Its
     * cost is not its own to correct: it is the run's, and «total ÷ produced» on a row that produced nothing is no price at
     * all. The correction is made on the run, and reaches the twin from there (below).
     */
    if (batch.splitFromBatchId) {
      const ar = 'هاي الدفعة مقسومة من دفعة أصلية (انتقلت قطعها لمخزن). صحّح الكلفة على الدفعة الأصلية، وبتوصل لهون لحالها.';
      return NextResponse.json({ error: ar, errorAr: ar, code: 'SPLIT_ROW' }, { status: 409 });
    }

    const body = parsed.data;
    const mfg = body.manufacturingCost ?? batch.manufacturingCost;
    const pack = body.packagingCost ?? batch.packagingCost;
    const raw = body.rawMaterialCost ?? batch.rawMaterialCost;
    const other = body.otherCosts ?? batch.otherCosts;
    const costLines = body.costLines ?? batch.costLines.map((l) => ({ label: l.label, amount: l.amount }));

    // The SAME arithmetic the create path uses. A second formula here is how
    // a batch ends up with one cost when it is entered and another when it
    // is corrected.
    const { total: totalProductionCost } = batchTotal({
      manufacturingCost: mfg,
      packagingCost: pack,
      rawMaterialCost: raw,
      otherCosts: other,
      costLines,
    });
    const costPerUnit = batchUnitCost(totalProductionCost, batch.quantityProduced);

    const updated = await db.$transaction(async (tx) => {
      if (body.costLines) {
        // Replaced as a set, so removing a line is simply leaving it out.
        await tx.productionBatchCost.deleteMany({ where: { batchId: batch.id } });
        if (costLines.length) {
          await tx.productionBatchCost.createMany({
            data: costLines.map((l, i) => ({
              companyId,
              batchId: batch.id,
              label: l.label,
              amount: l.amount,
              sortOrder: i,
            })),
          });
        }
      }
      /*
       * THE RUN'S UNITS THAT MOVED CARRY THE RUN'S COST. Every row split from this one, at any depth, takes the corrected
       * unit cost — exactly what the units would have taken had they never moved, so the stock value after a correction
       * is the same number whether or not the store was placed. A batch never split has no such row: nothing more is written.
       */
      const moved = await descendantsOf(tx, companyId, [batch.id]);
      if (moved.length > 0) {
        await tx.productionBatch.updateMany({ where: { companyId, id: { in: moved } }, data: { costPerUnit } });
      }
      return tx.productionBatch.update({
        where: { id: batch.id },
        data: {
          manufacturingCost: mfg,
          packagingCost: pack,
          rawMaterialCost: raw,
          otherCosts: other,
          totalProductionCost,
          costPerUnit,
        },
        include: { costLines: { orderBy: { sortOrder: 'asc' }, select: { label: true, amount: true } } },
      });
    });

    // What a cost was before and after is exactly the thing somebody will
    // need to explain a month from now.
    await logAudit({
      companyId,
      userId: user.id,
      action: 'PRODUCTION_BATCH_COST_CORRECTED',
      entity: 'ProductionBatch',
      entityId: batch.id,
      previousData: {
        batchNumber: batch.batchNumber,
        totalProductionCost: batch.totalProductionCost,
        costPerUnit: batch.costPerUnit,
        costLines: batch.costLines,
      },
      newData: {
        batchNumber: batch.batchNumber,
        totalProductionCost,
        costPerUnit,
        costLines,
        reason: body.reason ?? null,
      },
    });

    return NextResponse.json({ success: true, batch: updated });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
