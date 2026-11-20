import { Prisma } from '@prisma/client';
import { FamilyCost, familyRootOf } from './batch-family';
import type { db as prismaDb } from './db';
import { intakePlace, type WarehouseRef } from './warehouse-intake';

type Tx = Prisma.TransactionClient | typeof prismaDb;

/**
 * Putting stock in and taking it out.
 *
 * On-hand is the sum of `ProductionBatch.quantityRemaining` — that is the
 * only place units actually live. An adjustment that writes an
 * InventoryMovement without touching a batch changes nothing: the ledger
 * says stock arrived and the shipment screen still reports a shortage. That
 * was the bug; every movement now moves real units.
 *
 * Cost per unit is carried by the batch, so receiving at a different cost
 * opens a new batch rather than diluting an old one. Draw-down is oldest
 * batch first, which keeps the cost of goods honest.
 */

export interface ReceiveInput {
  companyId: string;
  /**
   * Which store's shelf these units land on.
   *
   * The column existed and nothing wrote it here, so every batch and every
   * movement this function created belonged to no store. The BALANCE survived
   * that — `/api/inventory` filters the PRODUCT by store and then sums all of
   * that product's batches — but the movements ledger filters the movement
   * itself with a strict `inStore`, so a receiving simply did not appear in
   * it. Measured: 0 of 135 movements are unplaced today, because
   * `place-stock-in-stores.ts` backfilled them and nothing has been received
   * since. The next receiving would have been the first invisible one.
   */
  storeId?: string | null;
  productId: string;
  quantity: number;
  /** Cost of one unit in this delivery; opens its own batch. */
  unitCost?: number;
  batchNumber?: string | null;
  note?: string | null;
  createdById: string;
  /**
   * WHERE THE UNITS LAND (the warehouse plan, W2a). Read only for a store that is placed in warehouses, where it is
   * required and checked (`warehouse-intake.intakePlace`); for any other store it is not read and nothing changes.
   */
  warehouseId?: string | null;
  /** Does the caller reach that warehouse? The door passes `warehouses.reachesWarehouse` for its session. */
  mayUse?: (warehouse: WarehouseRef) => Promise<boolean>;
}

export async function nextBatchNumber(tx: Tx, companyId: string): Promise<string> {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const todays = await tx.productionBatch.count({
    where: { companyId, batchNumber: { startsWith: `RCV-${stamp}` } },
  });
  return `RCV-${stamp}-${String(todays + 1).padStart(3, '0')}`;
}

/** Receive units into stock. Always creates a batch — that is where units live. */
export async function receiveStock(tx: Tx, input: ReceiveInput) {
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
    throw new Error('الكمية المستلمة يجب أن تكون أكبر من صفر');
  }
  const unitCost = Math.max(0, input.unitCost ?? 0);

  // Null for a store that is not placed: the two rows below are then exactly the ones written before warehouses existed.
  const place = await intakePlace(tx, {
    companyId: input.companyId,
    storeId: input.storeId,
    productId: input.productId,
    warehouseId: input.warehouseId,
    mayUse: input.mayUse,
  });

  const batch = await tx.productionBatch.create({
    data: {
      companyId: input.companyId,
      storeId: input.storeId ?? null,
      ...(place ? { warehouseId: place } : {}),
      productId: input.productId,
      batchNumber: input.batchNumber?.trim() || (await nextBatchNumber(tx, input.companyId)),
      quantityProduced: input.quantity,
      quantityRemaining: input.quantity,
      quantitySold: 0,
      manufacturingCost: 0,
      totalProductionCost: unitCost * input.quantity,
      costPerUnit: unitCost,
      productionDate: new Date(),
      notes: input.note ?? null,
      status: 'COMPLETED',
    },
  });

  const balanceAfter = await onHandTotal(tx, input.companyId, input.productId);

  const movement = await tx.inventoryMovement.create({
    data: {
      companyId: input.companyId,
      storeId: input.storeId ?? null,
      ...(place ? { warehouseId: place } : {}),
      productId: input.productId,
      batchId: batch.id,
      type: 'PRODUCTION',
      quantity: input.quantity,
      balanceAfter,
      reason: input.note?.trim() || 'استلام بضاعة',
      createdById: input.createdById,
    },
  });

  return { batch, movement, balanceAfter };
}

export async function onHandTotal(tx: Tx, companyId: string, productId: string): Promise<number> {
  const agg = await tx.productionBatch.aggregate({
    where: { companyId, productId },
    _sum: { quantityRemaining: true },
  });
  return agg._sum.quantityRemaining ?? 0;
}

/**
 * Take units out, oldest batch first.
 *
 * Refuses to take more than is there unless the country allows negative
 * stock; even then it never writes a negative `quantityRemaining`, it
 * reports the shortfall so the caller can record it.
 */
export async function drawDownStock(
  tx: Tx,
  input: {
    companyId: string;
    productId: string;
    quantity: number;
    allowNegative: boolean;
    /**
     * WHICH SHELF. Stock is the store's — the batch carries `storeId` and
     * `onHand` filters by it — and this draw-down did not, so an order
     * reserved against its own store's shelf was served FIFO from EVERY
     * store's batches and could empty a shelf another store had already
     * promised. That is the exact case the batch's own doc comment was
     * written against.
     *
     * Null or absent keeps the old company-wide behaviour, the same
     * convention `onHand` uses, so an order with no store still draws.
     */
    storeId?: string | null;
    /**
     * WHICH WAREHOUSE (the warehouse plan, W6a — an exit draws from the one warehouse it names). Absent or null: every
     * warehouse of the store, exactly as before — no caller before W6a passes it, so their reads are the very ones they
     * were. Given: only that warehouse's rows. Units on the road stay excluded either way (a row with a warehouse is
     * never on the road). Everything else — oldest first, the guarded write, the family cost — is the same code.
     */
    warehouseId?: string | null;
  }
): Promise<{ taken: number; short: number; cost: number }> {
  if (input.quantity <= 0) return { taken: 0, short: 0, cost: 0 };

  const read = () =>
    tx.productionBatch.findMany({
      where: {
        companyId: input.companyId,
        productId: input.productId,
        quantityRemaining: { gt: 0 },
        ...(input.storeId ? { storeId: input.storeId } : {}),
        ...(input.warehouseId ? { warehouseId: input.warehouseId } : {}),
        /*
         * NEVER UNITS ON THE ROAD (the warehouse plan, W2a). A row with `inTransitTransferId` holds units travelling
         * between two warehouses (`batch-split.ts`): they are on no shelf, nobody can hand them to a courier, and the
         * transfer's receipt or cancel is the only door that may give them back a place. Every draw — the six delivery
         * doors, the refused-return losses, the lost-parcel write-off, the recount's shortfall — comes through here.
         * A store that was never placed has no such row, so for it this condition removes nothing.
         */
        inTransitTransferId: null,
      },
      orderBy: [{ productionDate: 'asc' }, { createdAt: 'asc' }],
      // `costPerUnit` because the money that LEFT is only knowable here.
      // `product-cost.ts` describes this figure — «the CONSUMED cost… taken
      // from the batches the draw-down emptied — oldest first… the figure
      // that belongs in a closed order's profit» — and it was never
      // returned, so every margin in the product rested on the estimate
      // taken when the order was written instead.
      // `splitFromBatchId`: rows split from one run are costed as that run (`batch-family.ts`).
      select: { id: true, quantityRemaining: true, quantitySold: true, costPerUnit: true, splitFromBatchId: true },
    });

  let batches = await read();
  const available = batches.reduce((sum, b) => sum + b.quantityRemaining, 0);
  if (available < input.quantity && !input.allowNegative) {
    throw new Error(`المخزون غير كافٍ: المتاح ${available} والمطلوب ${input.quantity}`);
  }

  let left = input.quantity;
  /*
   * Each batch at ITS price. An order served from the March run at 3.20
   * and the June delivery at 4.10 cost both, not an average of them.
   * The units of one run (and of the rows split from it when its goods
   * changed place) are added up first and costed once — the same double a
   * run that never moved gives (`batch-family.ts`).
   */
  const costs = new FamilyCost();
  for (let attempt = 0; ; attempt++) {
    const familyOf = await familyRootOf(tx, input.companyId, [input.productId], batches);
    let changed = false;
    for (const batch of batches) {
      if (left <= 0) break;
      const take = Math.min(batch.quantityRemaining, left);
      /*
       * WRITTEN ONLY IF THE ROW STILL HOLDS WHAT WAS READ (the warehouse plan, W1a).
       *
       * The new figures are computed from the read above, and nothing locks the
       * rows between that read and this write. A split that moved some of this
       * row's units elsewhere and committed in between (a placement, a
       * transfer) would otherwise be overwritten — the units it moved counted
       * twice. The condition makes the write miss instead, and the draw reads
       * again and goes on from where it is. Without anyone writing in between,
       * the row matches and the write is the very one it always was.
       */
      try {
        await tx.productionBatch.update({
          where: { id: batch.id, quantityRemaining: batch.quantityRemaining },
          data: { quantityRemaining: batch.quantityRemaining - take, quantitySold: batch.quantitySold + take },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
          changed = true;
          break;
        }
        throw e;
      }
      costs.add(familyOf(batch), take, batch.costPerUnit ?? 0);
      left -= take;
    }
    if (!changed || left <= 0) break;
    if (attempt >= 4) throw new Error('المخزون عم يتغيّر بنفس اللحظة من باب تاني. جرّب كمان مرة.');
    batches = await read();
    const nowThere = batches.reduce((sum, b) => sum + b.quantityRemaining, 0);
    if (nowThere < left && !input.allowNegative) {
      throw new Error(`المخزون غير كافٍ: المتاح ${nowThere} والمطلوب ${left}`);
    }
  }

  /*
   * WHAT IS SHORT COSTS NOTHING, because it never left a batch. Pricing
   * the shortfall at the last batch's rate would invent money for goods
   * the shelf did not have.
   */
  /*
   * AND THE COST IS NOT ROUNDED HERE.
   *
   * It was `Math.round(cost * 100) / 100` — two decimals, in a function that
   * has no idea which currency it is counting. JOD has three, so a batch at
   * 3.333 taken three times is 9.999 and was handed back as 10.00; the
   * caller's own `roundMinor(cost, minorUnit)` then rounded a figure that
   * had already lost the digit. Same defect as the six fixed on 2026-10-02,
   * and the same ruling applies: a DERIVED figure is rounded once, by
   * whoever knows the currency — never on the way there.
   */
  const cost = costs.total();
  return { taken: input.quantity - left, short: left, cost };
}
