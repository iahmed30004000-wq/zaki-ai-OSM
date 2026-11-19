import { randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { db as prismaDb } from './db';
import { lockProductsStock } from './reservation';

type Tx = Prisma.TransactionClient | typeof prismaDb;

/**
 * SPLITTING A BATCH — THE ONE WAY UNITS CHANGE PLACE INSIDE ONE STORE (the warehouse plan).
 *
 * Units live only in batches, and a batch says WHOSE goods (`storeId`) and, now, WHERE (`warehouseId`). When some of a
 * batch's units go somewhere else, the batch is split: the parent gives `quantity` units away and a TWIN row receives them.
 *
 *   parent: quantityMovedOut += n, quantityRemaining −= n
 *   twin:   quantityProduced 0, quantityMovedIn n, quantityRemaining n, quantitySold 0, quantityMovedOut 0
 *           the parent's costPerUnit, productionDate, createdAt, storeId, status and notes; splitFromBatchId = parent
 *           every cost bucket and totalProductionCost 0; no cost lines; no opening count; batch number «<parent>~<6 hex>»
 *
 * WHY EACH OF THOSE, because each one keeps a figure still:
 *   - `quantityProduced` and `quantitySold` never move: Σ produced is «دخل», Σ sold is «خرج», and the production cost fix
 *     divides a run's total by ITS produced quantity (`batchUnitCost`) — a move that touched it would re-price the run.
 *   - the twin's totals are 0 and it has no cost lines: a report that adds what runs cost adds nothing twice.
 *   - the unit cost is the parent's: Σ (remaining × cost) — the stock value — is the same number before and after.
 *   - the production date AND the creation time are the parent's: the draw-down takes the oldest first by exactly those two
 *     (`receiving.drawDownStock`), so the twin sits where its units sat and no other batch can slip in between them.
 *   - the notes travel: a batch entered at cost zero says why in its notes, and its units keep the sentence.
 *   - no opening count: the count's batches ARE its lines, and a twin is not a line anybody counted.
 * A row's arithmetic after any number of splits:
 *   quantityRemaining = quantityProduced + quantityMovedIn − quantitySold − quantityMovedOut
 *
 * WHERE THE TWIN GOES — `to`: a warehouse (the units are there) or a transfer in transit (they are on the road, with no
 * warehouse). Nothing else: an unplaced twin would be a row nobody can find.
 *
 * NO LEDGER LINE. A split is not stock in or out; what is on hand does not change. The door that splits writes its own
 * document (a placement, a transfer) and that document carries the story.
 *
 * NO MONEY. This module reads no wallet, writes no expense and posts nothing to a profit (pinned by its test).
 */

export type SplitTarget = { warehouseId: string } | { inTransitTransferId: string };

export class SplitRefused extends Error {
  constructor(
    readonly code: 'NOT_IN_TRANSACTION' | 'QUANTITY_INVALID' | 'BATCH_NOT_FOUND' | 'NOT_ENOUGH_UNITS' | 'TARGET_INVALID',
    readonly errorAr: string
  ) {
    super(errorAr);
    this.name = 'SplitRefused';
  }
}

/** What a split reads of the parent. Exported so the placement plans with the very same columns. */
export const SPLIT_PARENT_SELECT = {
  id: true,
  companyId: true,
  storeId: true,
  productId: true,
  batchNumber: true,
  quantityRemaining: true,
  costPerUnit: true,
  productionDate: true,
  createdAt: true,
  status: true,
  notes: true,
  warehouseId: true,
  inTransitTransferId: true,
} as const;

/** «<parent>~<6 hex>» — the parent's number stays readable in the twin's. */
export function twinBatchNumber(parent: string, hex: string = randomBytes(3).toString('hex')): string {
  return `${parent}~${hex}`;
}

function targetOf(to: SplitTarget): { warehouseId: string | null; inTransitTransferId: string | null } {
  if ('warehouseId' in to && typeof to.warehouseId === 'string' && to.warehouseId.length > 0) {
    return { warehouseId: to.warehouseId, inTransitTransferId: null };
  }
  if ('inTransitTransferId' in to && typeof to.inTransitTransferId === 'string' && to.inTransitTransferId.length > 0) {
    return { warehouseId: null, inTransitTransferId: to.inTransitTransferId };
  }
  throw new SplitRefused('TARGET_INVALID', 'لوين رايحة القطع؟ لازم مخزن أو نقل بالطريق.');
}

/**
 * Split `quantity` units of one batch into a twin at `to`. Runs inside the caller's transaction and takes the product's
 * stock lock first (the reserver's — `reservation.lockProductsStock`), then reads the parent, so the units it moves are the
 * units the batch holds at that moment.
 */
export async function splitBatch(
  tx: Tx,
  input: { companyId: string; batchId: string; quantity: number; to: SplitTarget; hex?: string }
) {
  if ('$transaction' in tx) {
    throw new SplitRefused('NOT_IN_TRANSACTION', 'تقسيم الدفعة لازم يصير جوّا عملية وحدة.');
  }
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw new SplitRefused('QUANTITY_INVALID', 'الكمية اللي بتنقسم لازم تكون عدد صحيح أكبر من صفر.');
  }
  const target = targetOf(input.to);

  const head = await tx.productionBatch.findFirst({
    where: { id: input.batchId, companyId: input.companyId },
    select: { productId: true },
  });
  if (!head) throw new SplitRefused('BATCH_NOT_FOUND', 'الدفعة مش موجودة.');
  await lockProductsStock(tx, input.companyId, [head.productId]);

  // Read again under the lock: the quantity it decides on is the one nobody else is changing through a locked door.
  const parent = await tx.productionBatch.findFirst({
    where: { id: input.batchId, companyId: input.companyId },
    select: SPLIT_PARENT_SELECT,
  });
  if (!parent) throw new SplitRefused('BATCH_NOT_FOUND', 'الدفعة مش موجودة.');
  if (parent.quantityRemaining < input.quantity) {
    throw new SplitRefused(
      'NOT_ENOUGH_UNITS',
      `الدفعة ${parent.batchNumber} فيها ${parent.quantityRemaining} وبدّك تنقل ${input.quantity}.`
    );
  }

  /*
   * The parent's side, guarded by what was just read: a writer that changed the row in between (a draw-down takes no
   * lock) makes this match nothing, and the split stops instead of moving units the batch no longer has.
   */
  const took = await tx.productionBatch.updateMany({
    where: { id: parent.id, companyId: input.companyId, quantityRemaining: parent.quantityRemaining },
    data: { quantityRemaining: { decrement: input.quantity }, quantityMovedOut: { increment: input.quantity } },
  });
  if (took.count !== 1) {
    throw new SplitRefused('NOT_ENOUGH_UNITS', `الدفعة ${parent.batchNumber} تغيّرت هلّق. جرّب كمان مرة.`);
  }

  const twin = await tx.productionBatch.create({
    data: {
      companyId: parent.companyId,
      storeId: parent.storeId,
      productId: parent.productId,
      batchNumber: twinBatchNumber(parent.batchNumber, input.hex),
      quantityProduced: 0,
      quantitySold: 0,
      quantityRemaining: input.quantity,
      quantityMovedIn: input.quantity,
      quantityMovedOut: 0,
      manufacturingCost: 0,
      packagingCost: 0,
      rawMaterialCost: 0,
      otherCosts: 0,
      totalProductionCost: 0,
      costPerUnit: parent.costPerUnit,
      productionDate: parent.productionDate,
      createdAt: parent.createdAt,
      status: parent.status,
      notes: parent.notes,
      splitFromBatchId: parent.id,
      warehouseId: target.warehouseId,
      inTransitTransferId: target.inTransitTransferId,
    },
    select: { id: true, batchNumber: true, quantityRemaining: true, warehouseId: true, inTransitTransferId: true },
  });

  return { parentId: parent.id, twin };
}

/**
 * Every row split from these batches, at any depth (a split of a split) — what a cost fix on a parent must reach.
 * One read per generation; a chain is as deep as the number of times its units moved.
 */
export async function descendantsOf(tx: Tx, companyId: string, batchIds: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  const seen = new Set(batchIds);
  let frontier = [...seen];
  while (frontier.length > 0) {
    const children = await tx.productionBatch.findMany({
      where: { companyId, splitFromBatchId: { in: frontier } },
      select: { id: true },
    });
    frontier = children.map((c) => c.id).filter((id) => !seen.has(id));
    for (const id of frontier) {
      seen.add(id);
      found.push(id);
    }
  }
  return found;
}
