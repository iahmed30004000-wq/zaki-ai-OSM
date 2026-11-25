import { NextResponse } from 'next/server';
import { z } from 'zod';
import { count, money as moneyInput } from '@/lib/numeric-input';
import { apiErrorResponse } from '@/lib/api-error';
import { db } from '@/lib/db';
import { inStore } from '@/lib/store-filter';
import { requireContext } from '@/lib/geo-context';
import { batchTotal, batchUnitCost } from '@/lib/product-cost';
import { foldSplitRows } from '@/lib/batch-grade';
import { onHandTotal } from '@/lib/receiving';
import { logAudit } from '@/lib/audit';
import { requirePermission } from '@/lib/authorization';
import { zodMessage } from '@/lib/zod-message';
import { intakePlace, IntakePlaceRefused, intakeRefusalBody } from '@/lib/warehouse-intake';
import { reachesWarehouse } from '@/lib/warehouses';
import { placedWarehouseChoices } from '@/lib/placed-warehouse-choices';

export async function GET(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('production.view');

    const batches = await db.productionBatch.findMany({
      where: inStore(companyId, storeId),
      include: {
        product: {
          // `sourceType` and `basePrice` are what the screen grades a batch
          // with: a PURCHASED product's batch is a delivery of ready goods
          // and not a run at all — the owner's «ليش المنتجات الجاهزة موجودة
          // بتشغيلات الإنتاج» — and a unit cost is only worth judging against
          // the price the unit is sold at. Neither is inferred in the browser
          // and neither is a new query: they ride the include that was
          // already here.
          select: { id: true, name: true, sku: true, sourceType: true, basePrice: true },
        },
        // The named costs of this run, beside the four fixed buckets.
        costLines: { orderBy: { sortOrder: 'asc' }, select: { label: true, amount: true } },
      },
      orderBy: { productionDate: 'desc' },
    });

    /*
     * A ROW SPLIT OFF A RUN IS NOT A RUN (the warehouse plan, W2c). When goods change place a twin row holds them
     * (`batch-split.ts`, quantity produced 0): it is listed under its run, not beside it — the run shows what it and every
     * row split from it still hold and what was sold out of them (`batch-grade.foldSplitRows`). A store that was never
     * placed has no twin, and the list is the very list it was.
     */
    const runs = foldSplitRows(batches);

    // The country's own currency. The screen printed "$" beside every
    // production cost in a system that runs pounds and dinars side by side,
    // so a batch costing 12,000 Syrian pounds read as twelve thousand
    // dollars.
    /*
     * 22/11 (F1): A PLACED STORE'S RUN NAMES ITS WAREHOUSE, so the screen is told which ones it may offer — the very list
     * the POST below accepts (`placed-warehouse-choices.ts`). A store that is not placed: the answer is the one it was.
     */
    const choices = await placedWarehouseChoices(user, companyId, storeId);
    return NextResponse.json({ batches: runs, currency: country.currencyCode, ...(choices ? { placed: true, ...choices } : {}) });
  } catch (error: any) {
    return apiErrorResponse(error);
  }
}

/**
 * THE CREATE DOOR READS ITS NUMBERS THE WAY THE EDIT DOOR DOES.
 *
 * `PATCH /api/production/[id]` — the door that CORRECTS the same four
 * buckets and the same cost lines — has validated them with
 * `numeric-input` since it was written, and `numeric-input.test.ts` names
 * it among «the doors that move money or stock». This door, the one that
 * creates the batch in the first place, validated nothing. The same
 * failure as every other sibling-door miss in this audit: the rule landed
 * on one of a pair.
 *
 * WHAT THE OLD DOOR DID, MEASURED:
 *
 *   · `!quantityProduced || quantityProduced <= 0` is not a number guard.
 *     On the STRING `'abc'`, `'abc' <= 0` is `false` and `!'abc'` is
 *     `false`, so it passed — and `parseInt('abc', 10)` is `NaN`. Prisma
 *     refuses `NaN` for an `Int` column (`PrismaClientValidationError`),
 *     so nothing was stored; what the operator got was a 500 «حدث خطأ
 *     داخلي» where a 400 naming the field was waiting.
 *   · The silent ones are worse, because they DID store. `'5abc'` → 5.
 *     `'3,5'` from an Arabic keyboard → 3. `'1e3'` typed for a thousand →
 *     **1**. And `'0x10'` → 0, so a run with real costs was recorded with
 *     zero units and `costPerUnit` 0 — past a guard whose whole text says
 *     the quantity must be above zero.
 *   · `parseFloat(manufacturingCost) || 0` stored **0** for anything that
 *     is not a number, and that zero is not visible anywhere: it flows
 *     through `batchTotal` into `totalProductionCost` and `costPerUnit`,
 *     and out into every COGS and production-cost report. Same defect as
 *     `82ecac3`'s free product, on the cost side.
 *   · A free-form cost line was `Math.max(0, Number(l?.amount) || 0)`: a
 *     non-numeric amount became 0, and a NEGATIVE amount was silently
 *     CLAMPED to 0. It is refused now, not clamped. A clamp keeps the
 *     batch's own total wrong — understated by exactly what was typed —
 *     and says nothing, so the operator reads a unit cost that is not the
 *     one their input implies. And the four buckets beside it are refused
 *     for a negative, so a clamp here would be one screen with two rules
 *     for the same kind of number, which is what `a-column-has-one-rule`
 *     exists to stop.
 *
 * A ZERO IS STILL STORABLE, everywhere a zero is a real answer: a run with
 * no packaging cost, and a named line whose amount is genuinely nothing.
 * Every column's own default is `0.0`, and that default is declared here
 * once — not re-applied at the write site, which is where `82ecac3` found
 * the eighth vacuous guard.
 *
 * WHAT IS REFUSED THAT USED TO BE ACCEPTED SILENTLY: a blank cost-line
 * label (it was dropped, taking its amount with it), a 31st cost line (it
 * was truncated), and a label past 80 characters (it was cut). The edit
 * door refuses all three. The screen filters blank labels before it sends,
 * so no live caller changes behaviour.
 */
const money = moneyInput(100_000_000);

const createSchema = z.object({
  productId: z.string().min(10).max(64),
  batchNumber: z.string().trim().min(1).max(60),
  /** Whole, and at least one: a run of nothing is not a run. */
  quantityProduced: count(1_000_000, 1),
  manufacturingCost: money.default(0),
  packagingCost: money.default(0),
  rawMaterialCost: money.default(0),
  otherCosts: money.default(0),
  /**
   * Free-form cost lines — "قالب", "أجرة عامل", "شحن المواد". Four fixed
   * buckets never matched a real run; they matched whatever fitted into
   * four words. The buckets stay for the batches that use them, and the
   * total is the buckets plus the lines.
   *
   * The same shape the edit door declares, so the two cannot disagree about
   * what a cost line is.
   */
  costLines: z
    .array(z.object({ label: z.string().trim().min(1).max(80), amount: money }))
    .max(30)
    .default([]),
  /**
   * `new Date('abc')` is an Invalid Date, and Prisma refuses it — another
   * 500 where a sentence belongs. Refused here instead.
   */
  productionDate: z
    .string()
    .trim()
    .min(1)
    .refine((s) => Number.isFinite(new Date(s).getTime()), 'تاريخ الإنتاج غير صالح')
    .optional()
    .nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
  /**
   * The warehouse the run's units landed in (the warehouse plan, W2a). Read only when the store is placed in warehouses,
   * where it is required. `.catch` because the old schema stripped any such field: a body the old door accepted is never
   * refused for it.
   */
  warehouseId: z.string().max(64).optional().nullable().catch(undefined),
});

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('production.manage');

    const parsed = createSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }
    const { productId, batchNumber, productionDate, notes } = parsed.data;

    // Check duplicate batch number
    const existing = await db.productionBatch.findUnique({
      where: {
        companyId_batchNumber: {
          companyId,
          batchNumber: batchNumber.trim().toUpperCase(),
        },
      },
    });

    if (existing) {
      return NextResponse.json(
        { error: 'A production batch with this batch number already exists', errorAr: 'رقم التشغيلة مستعملٌ. اختر رقماً أخر أو ابحذ عن التشغيلة القائمة.' },
        { status: 400 }
      );
    }

    // Already numbers, already bounded, already non-negative — the schema
    // did that. No fallback here: a fallback at the write site is a second
    // rule for the column, and the default that belongs to an absent cost
    // is declared once, in the schema, where it can be read.
    const { quantityProduced: qty, manufacturingCost: mfg, packagingCost: pack,
      rawMaterialCost: raw, otherCosts: other, costLines } = parsed.data;

    const { total: totalProductionCost } = batchTotal({
      manufacturingCost: mfg,
      packagingCost: pack,
      rawMaterialCost: raw,
      otherCosts: other,
      costLines,
    });
    const costPerUnit = batchUnitCost(totalProductionCost, qty);

    // Phase S: tenant-validate the referenced product
    const prodCheck = await db.product.findFirst({ where: { id: productId, ...inStore(companyId, storeId) } });
    if (!prodCheck) {
      return NextResponse.json({ error: 'المنتج غير موجود في شركتك' }, { status: 404 });
    }

    // A bought product entered as a production run puts invented
    // manufacturing costs into the production reports — a run that never
    // happened, with a cost breakdown nobody can trace to any work.
    if (prodCheck.sourceType === 'PURCHASED') {
      return NextResponse.json(
        {
          error: `«${prodCheck.name}» منتج جاهز — تُضاف كميته من «استلام بضاعة جاهزة» بسعر الشراء.`,
          code: 'WRONG_DOOR',
        },
        { status: 409 }
      );
    }

    /*
     * THE RUN AND ITS LEDGER LINE ARE ONE TRANSACTION (the warehouse plan, W2a).
     *
     * They were two separate writes: a failure between them left a batch whose units nobody could trace in the
     * movements ledger. Now both land or neither does. And for a store placed in warehouses the run names the
     * warehouse its units landed in — required, of the store's country, running, and one this person reaches
     * (`warehouse-intake.intakePlace`, asked inside this same transaction). For a store that is not placed `place` is
     * null and the two rows are exactly the ones this door always wrote.
     */
    const batch = await db.$transaction(async (tx) => {
      const place = await intakePlace(tx, {
        companyId,
        storeId,
        productId,
        warehouseId: parsed.data.warehouseId,
        mayUse: (w) => reachesWarehouse(user, companyId, w),
      });
      const batch = await tx.productionBatch.create({
        data: {
          costLines: costLines.length
            ? { create: costLines.map((l, i) => ({ companyId, label: l.label, amount: l.amount, sortOrder: i })) }
            : undefined,
          companyId,
          // WHICH SHELF THESE UNITS LAND ON.
          //
          // The column was here and this door never wrote it, so a batch
          // created through it belonged to no store — and the GET above
          // filters `inStore(companyId, storeId)`, which per
          // `store-filter.ts` is an EXACT `storeId: storeId` match that a
          // NULL can never satisfy. The run was stored, held
          // `quantityRemaining` units, fed `costPerUnit` into cost of
          // goods — and was invisible on the one screen that owns it. The
          // PATCH in `[id]/route.ts` looks a batch up the same way, so its
          // costs could not be corrected either, and nobody knew to look.
          //
          // The store is the request context's, and that is not a choice
          // between candidates: `requireContext()` refuses a request with
          // no store (`STORE_REQUIRED`) so `storeId` is always a string
          // here, and the product was just tenant-validated with the same
          // `inStore(companyId, storeId)` — so `prodCheck.storeId` IS this
          // `storeId`, exactly. The two paths that get this right agree:
          // `receiveStock` takes the store from the receiving context and
          // the return restock puts units «back onto the shelf it left».
          storeId,
          ...(place ? { warehouseId: place } : {}),
          productId,
          batchNumber: batchNumber.trim().toUpperCase(),
          quantityProduced: qty,
          quantitySold: 0,
          quantityRemaining: qty,
          manufacturingCost: mfg,
          packagingCost: pack,
          rawMaterialCost: raw,
          otherCosts: other,
          totalProductionCost,
          costPerUnit,
          productionDate: productionDate ? new Date(productionDate) : new Date(),
          notes: notes?.trim() || null,
          status: 'COMPLETED',
        },
      });

      // Create corresponding Inventory Movement
      await tx.inventoryMovement.create({
        data: {
          companyId,
          // The same shelf as the batch. One of the pair getting a store
          // while the other does not is the defect half-fixed: the stock
          // ledger (`/api/inventory/movements`) filters the movement
          // itself with `inStore`, so an unplaced movement is a run that
          // happened and left no trace of how the balance got that way.
          storeId,
          ...(place ? { warehouseId: place } : {}),
          productId,
          batchId: batch.id,
          type: 'PRODUCTION',
          quantity: qty,
          /*
           * THE SHELF'S BALANCE, NOT THIS RUN'S SIZE.
           *
           * This was `qty` — the new batch's own quantity. For the FIRST run
           * of a product the two agree, which is why it read as correct; for
           * every run after it the column says something that is not the
           * balance. Measured on the shape: a product holding 50 that takes a
           * second run of 20 wrote `balanceAfter: 20` beside `quantity: 20`,
           * so the ledger read 20 where the shelf held 70, and the next line
           * under it — a sale of 1 written by `consumeOrderStock` from
           * `onHandTotal` — read 69. The series jumps 20 → 69 and the column
           * whose whole purpose is that somebody can read the shelf's history
           * and have it add up stops adding up at exactly that row.
           *
           * `onHandTotal` is what the other five writers use —
           * `receiving.ts:77,87`, `stock-consumption.ts:139,398`,
           * `inventory/route.ts:476` — and this door was the only exception.
           * It is read AFTER `productionBatch.create` above, so the run just
           * written is already in the sum.
           *
           * AND IT IS COMPANY-WIDE PER PRODUCT ON PURPOSE, not an oversight
           * left behind by the `storeId` work above. `Product.storeId` is a
           * single column, so one `productId` belongs to one store and this
           * sum can never mix two shelves; and the shelf screen itself —
           * `GET /api/inventory` — filters the PRODUCT by store and then sums
           * ALL of that product's batches, which is this exact figure. A
           * store filter here would make `balanceAfter` disagree with the
           * number the operator reads as on hand, which is the opposite of
           * what the column is for.
           */
          balanceAfter: await onHandTotal(tx, companyId, productId),
          referenceId: batch.id,
          reason: `Production Batch ${batch.batchNumber} completed`,
          createdById: user.id,
        },
      });
      return batch;
    });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'PRODUCTION_BATCH_CREATED',
      entity: 'ProductionBatch',
      entityId: batch.id,
      newData: batch,
    });

    return NextResponse.json({ success: true, batch });
  } catch (error: any) {
    if (error instanceof IntakePlaceRefused) return NextResponse.json(intakeRefusalBody(error), { status: error.status });
    return apiErrorResponse(error);
  }
}
