import { z } from 'zod';
import { Prisma } from '@prisma/client';
import type { db as prismaDb } from './db';
import { splitBatch } from './batch-split';
import { holdingWhere, lockProductsStock } from './reservation';
import { onHandTotal } from './receiving';
import { storeIsPlaced, type WarehouseRef } from './warehouse-intake';
import { NOT_BUILT_AR, readStockTransfer, stockTransferRefusal, type StockTransferKind } from './stock-transfer-kind';

type Tx = Prisma.TransactionClient | typeof prismaDb;

/**
 * A STOCK TRANSFER INSIDE ONE STORE — send, in transit, receive by count; a shortfall approved by a third person;
 * cancel before receipt (the warehouse plan, request W3a). The mirror of the wallet transfer (`transfer-kind.ts`,
 * `/api/finance/transfers`): one document with two ends, the kind read from the ends and stored, a replay guard on a
 * client-made id, and nothing ever deleted.
 *
 * UNITS NEVER LEAVE THE BATCHES. Inside one store a transfer only changes WHERE units are, never how many there are or
 * what they cost:
 *   send      the source's oldest batches are SPLIT (`batch-split.splitBatch`) into twins that are on the road — no
 *             warehouse, `inTransitTransferId` = the transfer. `quantityProduced` and `quantitySold` do not move, so
 *             «دخل» (Σ produced), «خرج» (Σ sold), the on-hand (Σ remaining) and the stock value (Σ remaining × cost) are
 *             the same numbers before and after. The draw-down never takes units on the road (`receiving.drawDownStock`).
 *   receive   the receiver types what she COUNTED per product (never more than was sent). Counted units get the
 *             destination's warehouse: a twin received whole changes address; a twin received in part is split again.
 *             Again nothing changes but the address.
 *   shortfall what was not counted stays on the road («مستلم بفرق») until a THIRD person — neither the sender nor the
 *             receiver — approves it out with a reason as LOSS or DAMAGE. Only then do units leave the store: the twins
 *             lose them as every loss does today (`quantitySold` += n, the same arithmetic as the refused-return losses
 *             through `drawDownStock`), so «خرج» rises and the stock value falls by exactly those units at their cost.
 *             Nothing is posted to a profit, a wallet or an expense (the owner's default for decision 6: a report only).
 *   cancel    before any receipt, the twins on the road are given back the source warehouse. Nothing deleted.
 *
 * THE LEDGER (`inventory_movements`, `referenceId` = the transfer): TRANSFER_OUT −n at the source when sent;
 * TRANSFER_IN +counted at the destination when received; TRANSFER_IN +n at the source when cancelled (the reversing
 * pair); LOSS or DAMAGE −missing with no warehouse (the units were on the road) when a shortfall is approved.
 * `balanceAfter` is the product's book total (`receiving.onHandTotal`), as every line writes it — unchanged by a move.
 *
 * TWO HANDS (the owner's default for decision 5): the person who sent may not receive, and neither the sender nor the
 * receiver may approve the difference. Checked by the person's id before anything else of the request is looked at —
 * a replay included: a replay is answered «already done» only to the person who did it.
 *
 * LOCKS, in one order everywhere (so no two of these doors can wait for each other in a circle):
 *   1. the transfer row FOR UPDATE (receive, cancel, difference) — two presses on one transfer go one after the other;
 *   2. the products' stock lock (`reservation.lockProductsStock`, the reserver's own key);
 *   3. the warehouse rows FOR SHARE (send) — the stop door locks the row FOR UPDATE before it counts open transfers
 *      (`warehouses.warehouseStopBlockers`), so a send and a stop cannot cross: whichever comes second sees the first.
 *
 * NO MONEY. This module reads no wallet, writes no expense and posts nothing to a profit (pinned by its test).
 */

export type StockTransferStatus = 'SENT' | 'RECEIVED' | 'RECEIVED_WITH_DIFFERENCE' | 'CANCELLED';
export type DifferenceType = 'LOSS' | 'DAMAGE';

export const STATUS_AR: Record<StockTransferStatus, string> = {
  SENT: 'بالطريق',
  RECEIVED: 'مستلم',
  RECEIVED_WITH_DIFFERENCE: 'مستلم بفرق',
  CANCELLED: 'ملغى',
};

export type StockTransferRefusalCode =
  | 'INVALID'
  | 'SAME_WAREHOUSE'
  | 'PRODUCT_TWICE'
  | 'TRANSFER_EXISTS'
  | 'STORE_NOT_PLACED'
  | 'WAREHOUSE_NOT_FOUND'
  | 'WAREHOUSE_OTHER_COUNTRY'
  | 'KIND_CHANGED'
  | 'KIND_NOT_BUILT'
  | 'FROM_STOPPED'
  | 'TO_STOPPED'
  | 'NOT_REACHED'
  | 'PRODUCT_NOT_FOUND'
  | 'NOT_ENOUGH_FREE'
  | 'MOVED_MEANWHILE'
  | 'NOT_FOUND'
  | 'SENDER_CANNOT_RECEIVE'
  | 'SENDER_CANNOT_APPROVE'
  | 'RECEIVER_CANNOT_APPROVE'
  | 'ALREADY_RECEIVED'
  | 'ALREADY_CANCELLED'
  | 'ALREADY_APPROVED'
  | 'NO_DIFFERENCE'
  | 'COUNTS_INVALID'
  | 'COUNT_OVER_SENT';

const STATUS_OF: Record<StockTransferRefusalCode, number> = {
  INVALID: 400,
  SAME_WAREHOUSE: 400,
  PRODUCT_TWICE: 400,
  TRANSFER_EXISTS: 409,
  STORE_NOT_PLACED: 409,
  WAREHOUSE_NOT_FOUND: 404,
  WAREHOUSE_OTHER_COUNTRY: 400,
  KIND_CHANGED: 409,
  KIND_NOT_BUILT: 400,
  FROM_STOPPED: 409,
  TO_STOPPED: 409,
  NOT_REACHED: 403,
  PRODUCT_NOT_FOUND: 404,
  NOT_ENOUGH_FREE: 409,
  MOVED_MEANWHILE: 409,
  NOT_FOUND: 404,
  SENDER_CANNOT_RECEIVE: 403,
  SENDER_CANNOT_APPROVE: 403,
  RECEIVER_CANNOT_APPROVE: 403,
  ALREADY_RECEIVED: 409,
  ALREADY_CANCELLED: 409,
  ALREADY_APPROVED: 409,
  NO_DIFFERENCE: 409,
  COUNTS_INVALID: 400,
  COUNT_OVER_SENT: 400,
};

const AR: Partial<Record<StockTransferRefusalCode, string>> = {
  SAME_WAREHOUSE: 'المخزن اللي بتنقل منه هو نفسه اللي بتنقل عليه. اختار مخزن تاني.',
  PRODUCT_TWICE: 'نفس المنتج مكتوب بسطرين. اجمعهم بسطر واحد.',
  TRANSFER_EXISTS: 'هالنقل انسجّل من قبل بشكل تاني. حدّث الصفحة وراجع قبل ما تعيد.',
  STORE_NOT_PLACED: 'هالمتجر لسا ما توزّع على المخازن. وزّع الرصيد على المخازن أول، وبعدين انقل.',
  WAREHOUSE_NOT_FOUND: 'المخزن مش موجود. حدّث الصفحة واختار من جديد.',
  WAREHOUSE_OTHER_COUNTRY: 'هالمخزن مش ببلد هالمتجر، وما بيشيل بضاعته.',
  KIND_NOT_BUILT: NOT_BUILT_AR,
  FROM_STOPPED: 'المخزن اللي بتنقل منه موقوف.',
  TO_STOPPED: 'المخزن اللي بتنقل عليه موقوف. شغّله أول، أو انقل على مخزن تاني.',
  PRODUCT_NOT_FOUND: 'في منتج مش موجود بهالمتجر. حدّث الصفحة.',
  MOVED_MEANWHILE: 'البضاعة تحرّكت بنفس اللحظة من باب تاني. جرّب كمان مرة.',
  NOT_FOUND: 'النقل مش موجود. حدّث الصفحة.',
  SENDER_CANNOT_RECEIVE: 'إنت اللي بعتّ هالنقل، فما بتستلمه. لازم حدا تاني يعدّ ويستلم.',
  SENDER_CANNOT_APPROVE: 'إنت اللي بعتّ هالنقل، فما بتعتمد فرقه. لازم شخص تالت.',
  RECEIVER_CANNOT_APPROVE: 'إنت اللي استلمت هالنقل، فما بتعتمد فرقه. لازم شخص تالت.',
  ALREADY_RECEIVED: 'هالنقل انستلم من قبل. حدّث الصفحة.',
  ALREADY_CANCELLED: 'هالنقل انلغى من قبل. حدّث الصفحة.',
  ALREADY_APPROVED: 'فرق هالنقل انعتمد من قبل. حدّث الصفحة.',
  NO_DIFFERENCE: 'ما في فرق مستني اعتماد على هالنقل.',
  COUNTS_INVALID: 'لازم تكتب العدد لكل منتج بالنقل، مرة وحدة لكل منتج.',
};

export class StockTransferRefused extends Error {
  readonly status: number;
  constructor(
    readonly code: StockTransferRefusalCode,
    readonly errorAr: string = AR[code] ?? 'ما زبط الطلب.',
    readonly extra: Record<string, unknown> = {}
  ) {
    super(errorAr);
    this.name = 'StockTransferRefused';
    this.status = STATUS_OF[code];
  }
}

/** The JSON a door answers with: an Arabic sentence, a stable code, and whatever the refusal carries. */
export function refusalBody(e: StockTransferRefused) {
  return { error: e.errorAr, errorAr: e.errorAr, code: e.code, ...e.extra };
}

/* ───────────────────────────── the bodies ───────────────────────────── */

const qty = z.number({ message: 'الكمية لازم تكون رقم' }).int('الكمية لازم تكون عدد صحيح');

export const sendSchema = z.object({
  /** Made by the client before the first press: the same id pressed twice is one transfer. */
  id: z.string().uuid('رقم النقل مش صحيح').optional(),
  fromWarehouseId: z.string().min(1, 'اختار المخزن اللي بتنقل منه'),
  toWarehouseId: z.string().min(1, 'اختار المخزن اللي بتنقل عليه'),
  /** Whose goods arrive. Absent = the same store (INTERNAL). Another store is a kind not built yet. */
  toStoreId: z.string().min(1).optional(),
  expectKind: z.enum(['INTERNAL', 'BETWEEN_STORES', 'BETWEEN_COUNTRIES']).optional(),
  note: z.string().trim().max(500).optional().nullable(),
  lines: z
    .array(z.object({ productId: z.string().min(1), quantity: qty.positive('الكمية لازم تكون أكبر من صفر') }))
    .min(1, 'زيد منتج واحد على الأقل')
    .max(200, 'كتير منتجات بنقل واحد. قسّمه.'),
});

export const receiveSchema = z.object({
  lines: z
    .array(z.object({ productId: z.string().min(1), quantity: qty.min(0, 'العدد ما بيكون أقل من صفر') }))
    .min(1, 'اكتب العدد لكل منتج'),
});

export const cancelSchema = z.object({ reason: z.string().trim().min(3, 'اكتب سبب الإلغاء').max(500) });

export const differenceSchema = z.object({
  type: z.enum(['LOSS', 'DAMAGE'], { message: 'اختار: ضايع أو تالف' }),
  reason: z.string().trim().min(3, 'اكتب سبب الفرق').max(500),
});

/* ───────────────────────────── shared reads ───────────────────────────── */

type WarehouseRow = { id: string; companyId: string; countryId: string; isActive: boolean; name: string };

/** The warehouse rows FOR SHARE, in id order: a stop waits for this transaction, and this one waits for a stop under way. */
async function lockWarehousesForShare(tx: Tx, ids: readonly string[]): Promise<Map<string, WarehouseRow>> {
  const out = new Map<string, WarehouseRow>();
  for (const id of [...new Set(ids)].sort()) {
    const rows = await tx.$queryRaw<WarehouseRow[]>`
      SELECT "id", "companyId", "countryId", "isActive", "name" FROM "warehouses" WHERE "id" = ${id} FOR SHARE`;
    if (rows[0]) out.set(id, rows[0]);
  }
  return out;
}

/** The transfer row FOR UPDATE: two presses on one transfer go one after the other. */
async function lockTransfer(tx: Tx, id: string): Promise<void> {
  await tx.$executeRaw`SELECT 1 FROM "stock_transfers" WHERE "id" = ${id} FOR UPDATE`;
}

const OLDEST_FIRST = [{ productionDate: 'asc' as const }, { createdAt: 'asc' as const }, { id: 'asc' as const }];

/**
 * FREE STOCK OF A WAREHOUSE, per product (the design page): Σ remaining of its batches (none on the road — a row with a
 * warehouse is never on the road) − Σ units still reserved by open orders SOURCED from it (`Order.sourceWarehouseId`,
 * stamped when an order joins a shipping batch — from W4a; until then no order is sourced and this term is 0) − units
 * held by pending exits (W6a; none exist yet). The reservation's own «still holding» rule decides which orders count
 * (`reservation.holdingWhere`), with the store's filter, so a bench store's orders never count here.
 */
export async function freeStockOf(
  tx: Tx,
  p: { companyId: string; storeId: string; warehouseId: string; productIds: readonly string[] }
): Promise<Map<string, number>> {
  const free = new Map<string, number>();
  const productIds = [...new Set(p.productIds)];
  for (const productId of productIds) {
    const shelf = await tx.productionBatch.aggregate({
      where: { companyId: p.companyId, storeId: p.storeId, productId, warehouseId: p.warehouseId, inTransitTransferId: null },
      _sum: { quantityRemaining: true },
    });
    const held = holdingWhere({ companyId: p.companyId, productId, storeId: p.storeId });
    const where = { ...held, order: { ...held.order, sourceWarehouseId: p.warehouseId } };
    const [lines, addOns] = await Promise.all([
      tx.orderItem.aggregate({ where, _sum: { reservedQty: true } }),
      tx.orderAddOn.aggregate({ where, _sum: { reservedQty: true } }),
    ]);
    const reserved = (lines._sum.reservedQty ?? 0) + (addOns._sum.reservedQty ?? 0);
    free.set(productId, (shelf._sum.quantityRemaining ?? 0) - reserved);
  }
  return free;
}

async function ledger(
  tx: Tx,
  row: {
    companyId: string;
    storeId: string;
    warehouseId: string | null;
    productId: string;
    type: 'TRANSFER_OUT' | 'TRANSFER_IN' | DifferenceType;
    quantity: number;
    transferId: string;
    reason: string;
    createdById: string;
  }
) {
  const balanceAfter = await onHandTotal(tx, row.companyId, row.productId);
  await tx.inventoryMovement.create({
    data: {
      companyId: row.companyId,
      storeId: row.storeId,
      warehouseId: row.warehouseId,
      productId: row.productId,
      batchId: null,
      type: row.type,
      quantity: row.quantity,
      balanceAfter,
      referenceId: row.transferId,
      reason: row.reason,
      createdById: row.createdById,
    },
  });
}

const TRANSFER_SELECT = {
  id: true,
  companyId: true,
  storeId: true,
  kind: true,
  fromWarehouseId: true,
  toWarehouseId: true,
  status: true,
  note: true,
  sentById: true,
  sentAt: true,
  receivedById: true,
  receivedAt: true,
  cancelledById: true,
  cancelledAt: true,
  cancelReason: true,
  differenceType: true,
  differenceReason: true,
  differenceApprovedById: true,
  differenceApprovedAt: true,
  lines: { select: { productId: true, quantitySent: true, quantityReceived: true }, orderBy: { productId: 'asc' as const } },
} as const;

async function readTransfer(tx: Tx, companyId: string, storeId: string, id: string) {
  const t = await tx.stockTransfer.findFirst({ where: { id, companyId, storeId }, select: TRANSFER_SELECT });
  if (!t) throw new StockTransferRefused('NOT_FOUND');
  return t;
}

export type StockTransferRow = Awaited<ReturnType<typeof readTransfer>>;

/** The rows on THIS transfer's road holding units of this product, oldest first. */
function onTheRoad(tx: Tx, companyId: string, storeId: string, transferId: string, productId: string) {
  return tx.productionBatch.findMany({
    where: { companyId, storeId, productId, inTransitTransferId: transferId, quantityRemaining: { gt: 0 } },
    orderBy: OLDEST_FIRST,
    select: { id: true, quantityRemaining: true, quantitySold: true },
  });
}

/**
 * Give `quantity` units on this transfer's road a warehouse: a row taken whole changes address (guarded by what was
 * read, so a writer in between makes it miss and the whole press stops); a row taken in part is split.
 */
async function landFromRoad(
  tx: Tx,
  p: { companyId: string; storeId: string; transferId: string; productId: string; quantity: number; warehouseId: string }
) {
  let left = p.quantity;
  for (const row of await onTheRoad(tx, p.companyId, p.storeId, p.transferId, p.productId)) {
    if (left <= 0) break;
    const take = Math.min(row.quantityRemaining, left);
    if (take === row.quantityRemaining) {
      const moved = await tx.productionBatch.updateMany({
        where: { id: row.id, companyId: p.companyId, inTransitTransferId: p.transferId, quantityRemaining: row.quantityRemaining },
        data: { warehouseId: p.warehouseId, inTransitTransferId: null },
      });
      if (moved.count !== 1) throw new StockTransferRefused('MOVED_MEANWHILE');
    } else {
      await splitBatch(tx, { companyId: p.companyId, batchId: row.id, quantity: take, to: { warehouseId: p.warehouseId } });
    }
    left -= take;
  }
  // The road holds exactly what was sent and not yet landed (the transfer row is locked): fewer is a broken state.
  if (left > 0) throw new StockTransferRefused('MOVED_MEANWHILE');
}

/* ───────────────────────────── send ───────────────────────────── */

export interface SendInput {
  companyId: string;
  storeId: string;
  sentById: string;
  body: z.infer<typeof sendSchema>;
  /** Does the sender reach this warehouse? The door passes `warehouses.reachesWarehouse` for the session. */
  mayUse: (w: WarehouseRef) => Promise<boolean>;
}

const sameLines = (a: readonly { productId: string; quantity: number }[], b: readonly { productId: string; quantitySent: number }[]) =>
  a.length === b.length &&
  [...a].sort((x, y) => x.productId.localeCompare(y.productId)).every((l, i) => {
    const s = [...b].sort((x, y) => x.productId.localeCompare(y.productId))[i];
    return s.productId === l.productId && s.quantitySent === l.quantity;
  });

/**
 * A REPLAY: the same id, the same deal (ends, lines) and the same sender → that transfer, nothing written. The same id
 * carrying anything else — another deal, another person, another company's row — is a conflict that says nothing about
 * the row. Asked first, before the warehouses are judged: the first press may have succeeded and a warehouse been
 * stopped since, and a retry of a transfer that happened is a success to repeat.
 */
export async function replayOf(tx: Tx, input: Omit<SendInput, 'mayUse'>) {
  const id = input.body.id;
  if (!id) return null;
  const row = await tx.stockTransfer.findUnique({ where: { id }, select: TRANSFER_SELECT });
  if (!row) return null;
  const same =
    row.companyId === input.companyId &&
    row.storeId === input.storeId &&
    row.sentById === input.sentById &&
    row.fromWarehouseId === input.body.fromWarehouseId &&
    row.toWarehouseId === input.body.toWarehouseId &&
    (input.body.toStoreId ?? input.storeId) === row.storeId &&
    sameLines(input.body.lines, row.lines);
  if (!same) throw new StockTransferRefused('TRANSFER_EXISTS');
  return row;
}

export async function sendTransfer(tx: Tx, input: SendInput): Promise<{ transfer: StockTransferRow; replay: boolean; kind: StockTransferKind }> {
  const { companyId, storeId, body } = input;

  const seen = new Set<string>();
  for (const l of body.lines) {
    if (seen.has(l.productId)) throw new StockTransferRefused('PRODUCT_TWICE');
    seen.add(l.productId);
  }
  if (body.fromWarehouseId === body.toWarehouseId) throw new StockTransferRefused('SAME_WAREHOUSE');

  const replay = await replayOf(tx, input);
  if (replay) return { transfer: replay, replay: true, kind: replay.kind as StockTransferKind };

  const productIds = [...seen];
  // 2. the products' stock lock, then 3. the two warehouses FOR SHARE (the order every door of this module keeps).
  await lockProductsStock(tx, companyId, productIds);
  const wh = await lockWarehousesForShare(tx, [body.fromWarehouseId, body.toWarehouseId]);
  const from = wh.get(body.fromWarehouseId);
  const to = wh.get(body.toWarehouseId);
  if (!from || from.companyId !== companyId || !to || to.companyId !== companyId) throw new StockTransferRefused('WAREHOUSE_NOT_FOUND');

  const store = await tx.store.findFirst({ where: { id: storeId, companyId }, select: { countryId: true, name: true } });
  if (!store) throw new StockTransferRefused('NOT_FOUND');
  // The source holds THIS store's goods only if it is of the store's country (a warehouse holds the goods of its country's stores).
  if (from.countryId !== store.countryId) throw new StockTransferRefused('WAREHOUSE_OTHER_COUNTRY');

  const ends = {
    from: { warehouseId: from.id, warehouseName: from.name, storeId, storeName: store.name, countryId: from.countryId },
    to: { warehouseId: to.id, warehouseName: to.name, storeId: body.toStoreId ?? storeId, countryId: to.countryId },
  };
  const pairRefusal = stockTransferRefusal(ends.from, ends.to);
  if (pairRefusal) throw new StockTransferRefused('SAME_WAREHOUSE', pairRefusal);
  const reading = readStockTransfer(ends.from, ends.to);
  if (body.expectKind && body.expectKind !== reading.kind) {
    throw new StockTransferRefused('KIND_CHANGED', `تغيّر نوع النقل — هاد ${reading.label}. راجعه وأعد المحاولة.`, { kind: reading.kind });
  }
  if (!reading.built) throw new StockTransferRefused('KIND_NOT_BUILT', NOT_BUILT_AR, { kind: reading.kind });

  if (!(await storeIsPlaced(storeId, tx))) throw new StockTransferRefused('STORE_NOT_PLACED');
  if (!from.isActive) throw new StockTransferRefused('FROM_STOPPED');
  if (!to.isActive) throw new StockTransferRefused('TO_STOPPED');
  if (!(await input.mayUse({ id: from.id, companyId: from.companyId, countryId: from.countryId }))) {
    throw new StockTransferRefused('NOT_REACHED', 'ما إلك وصول على المخزن اللي بتنقل منه.');
  }

  const products = await tx.product.findMany({ where: { id: { in: productIds }, companyId, storeId }, select: { id: true, name: true } });
  if (products.length !== productIds.length) throw new StockTransferRefused('PRODUCT_NOT_FOUND');
  const nameOf = new Map(products.map((p) => [p.id, p.name]));

  const free = await freeStockOf(tx, { companyId, storeId, warehouseId: from.id, productIds });
  const short = body.lines
    .filter((l) => l.quantity > (free.get(l.productId) ?? 0))
    .map((l) => ({ productId: l.productId, name: nameOf.get(l.productId) ?? '', asked: l.quantity, free: Math.max(0, free.get(l.productId) ?? 0) }));
  if (short.length > 0) {
    throw new StockTransferRefused(
      'NOT_ENOUGH_FREE',
      `ما في كفاية ببضاعة ${from.name} الحرّة: ${short.map((s) => `${s.name} (الحر ${s.free}، طالب ${s.asked})`).join(' · ')}.`,
      { short }
    );
  }

  const created = await tx.stockTransfer.create({
    data: {
      ...(body.id ? { id: body.id } : {}),
      companyId,
      storeId,
      kind: reading.kind,
      fromWarehouseId: from.id,
      toWarehouseId: to.id,
      status: 'SENT',
      note: body.note?.trim() || null,
      sentById: input.sentById,
      lines: { create: body.lines.map((l) => ({ productId: l.productId, quantitySent: l.quantity })) },
    },
    select: { id: true },
  });

  for (const line of body.lines) {
    let left = line.quantity;
    const shelf = await tx.productionBatch.findMany({
      where: { companyId, storeId, productId: line.productId, warehouseId: from.id, inTransitTransferId: null, quantityRemaining: { gt: 0 } },
      orderBy: OLDEST_FIRST,
      select: { id: true, quantityRemaining: true },
    });
    for (const b of shelf) {
      if (left <= 0) break;
      const take = Math.min(b.quantityRemaining, left);
      await splitBatch(tx, { companyId, batchId: b.id, quantity: take, to: { inTransitTransferId: created.id } });
      left -= take;
    }
    // Free stock was checked under the lock; the shelf holds at least that much. Fewer means a writer slipped in.
    if (left > 0) throw new StockTransferRefused('MOVED_MEANWHILE');
    await ledger(tx, {
      companyId,
      storeId,
      warehouseId: from.id,
      productId: line.productId,
      type: 'TRANSFER_OUT',
      quantity: -line.quantity,
      transferId: created.id,
      reason: `نقل إلى ${to.name}`,
      createdById: input.sentById,
    });
  }

  return { transfer: await readTransfer(tx, companyId, storeId, created.id), replay: false, kind: reading.kind };
}

/* ───────────────────────────── receive ───────────────────────────── */

const countsMatch = (t: StockTransferRow, counts: readonly { productId: string; quantity: number }[]) =>
  t.lines.length === counts.length && t.lines.every((l) => counts.find((c) => c.productId === l.productId)?.quantity === l.quantityReceived);

export async function receiveTransfer(
  tx: Tx,
  input: {
    companyId: string;
    storeId: string;
    transferId: string;
    receivedById: string;
    body: z.infer<typeof receiveSchema>;
    mayUse: (w: WarehouseRef) => Promise<boolean>;
  }
): Promise<{ transfer: StockTransferRow; replay: boolean }> {
  const { companyId, storeId, transferId } = input;
  await lockTransfer(tx, transferId);
  const t = await readTransfer(tx, companyId, storeId, transferId);

  // Two hands, before anything else — a replay included.
  if (t.sentById === input.receivedById) throw new StockTransferRefused('SENDER_CANNOT_RECEIVE');
  if (t.status === 'CANCELLED') throw new StockTransferRefused('ALREADY_CANCELLED');
  if (t.status !== 'SENT') {
    if (t.receivedById === input.receivedById && countsMatch(t, input.body.lines)) return { transfer: t, replay: true };
    throw new StockTransferRefused('ALREADY_RECEIVED');
  }

  const to = await tx.warehouse.findFirst({ where: { id: t.toWarehouseId, companyId }, select: { id: true, companyId: true, countryId: true, name: true } });
  if (!to) throw new StockTransferRefused('WAREHOUSE_NOT_FOUND');
  // A STOPPED destination still receives: the goods are already on their way there, and refusing would strand them on
  // the road. (The stop door refuses while a transfer is open — this is for a stop that came some other way.)
  if (!(await input.mayUse({ id: to.id, companyId: to.companyId, countryId: to.countryId }))) {
    throw new StockTransferRefused('NOT_REACHED', 'ما إلك وصول على المخزن اللي واصل عليه النقل.');
  }

  const counts = input.body.lines;
  const sentOf = new Map(t.lines.map((l) => [l.productId, l.quantitySent]));
  const named = new Set(counts.map((c) => c.productId));
  if (named.size !== counts.length || counts.length !== t.lines.length || counts.some((c) => !sentOf.has(c.productId))) {
    throw new StockTransferRefused('COUNTS_INVALID');
  }
  const over = counts.find((c) => c.quantity > (sentOf.get(c.productId) ?? 0));
  if (over) throw new StockTransferRefused('COUNT_OVER_SENT', 'العدد أكتر من اللي انبعت. عدّ كمان مرة، والزيادة بتنكتب من الجرد مش من هون.');

  await lockProductsStock(tx, companyId, [...sentOf.keys()]);
  let short = false;
  for (const c of counts) {
    if (c.quantity < (sentOf.get(c.productId) ?? 0)) short = true;
    if (c.quantity > 0) {
      await landFromRoad(tx, { companyId, storeId, transferId, productId: c.productId, quantity: c.quantity, warehouseId: to.id });
      await ledger(tx, {
        companyId,
        storeId,
        warehouseId: to.id,
        productId: c.productId,
        type: 'TRANSFER_IN',
        quantity: c.quantity,
        transferId,
        reason: `استلام نقل على ${to.name}`,
        createdById: input.receivedById,
      });
    }
    await tx.stockTransferLine.updateMany({ where: { transferId, productId: c.productId }, data: { quantityReceived: c.quantity } });
  }
  await tx.stockTransfer.update({
    where: { id: transferId },
    data: { status: short ? 'RECEIVED_WITH_DIFFERENCE' : 'RECEIVED', receivedById: input.receivedById, receivedAt: new Date() },
  });
  return { transfer: await readTransfer(tx, companyId, storeId, transferId), replay: false };
}

/* ───────────────────────────── cancel ───────────────────────────── */

export async function cancelTransfer(
  tx: Tx,
  input: {
    companyId: string;
    storeId: string;
    transferId: string;
    cancelledById: string;
    body: z.infer<typeof cancelSchema>;
    mayUse: (w: WarehouseRef) => Promise<boolean>;
  }
): Promise<{ transfer: StockTransferRow; replay: boolean }> {
  const { companyId, storeId, transferId } = input;
  await lockTransfer(tx, transferId);
  const t = await readTransfer(tx, companyId, storeId, transferId);
  if (t.status === 'CANCELLED') {
    if (t.cancelledById === input.cancelledById) return { transfer: t, replay: true };
    throw new StockTransferRefused('ALREADY_CANCELLED');
  }
  if (t.status !== 'SENT') {
    throw new StockTransferRefused('ALREADY_RECEIVED', 'هالنقل انستلم، فما بينلغى. لترجّع البضاعة اعمل نقل معاكس.');
  }

  const from = await tx.warehouse.findFirst({ where: { id: t.fromWarehouseId, companyId }, select: { id: true, companyId: true, countryId: true, name: true } });
  if (!from) throw new StockTransferRefused('WAREHOUSE_NOT_FOUND');
  if (!(await input.mayUse({ id: from.id, companyId: from.companyId, countryId: from.countryId }))) {
    throw new StockTransferRefused('NOT_REACHED', 'ما إلك وصول على المخزن اللي طلع منه النقل.');
  }

  await lockProductsStock(tx, companyId, t.lines.map((l) => l.productId));
  for (const l of t.lines) {
    await landFromRoad(tx, { companyId, storeId, transferId, productId: l.productId, quantity: l.quantitySent, warehouseId: from.id });
    await ledger(tx, {
      companyId,
      storeId,
      warehouseId: from.id,
      productId: l.productId,
      type: 'TRANSFER_IN',
      quantity: l.quantitySent,
      transferId,
      reason: `إلغاء نقل — رجعت على ${from.name}`,
      createdById: input.cancelledById,
    });
  }
  await tx.stockTransfer.update({
    where: { id: transferId },
    data: { status: 'CANCELLED', cancelledById: input.cancelledById, cancelledAt: new Date(), cancelReason: input.body.reason },
  });
  return { transfer: await readTransfer(tx, companyId, storeId, transferId), replay: false };
}

/* ───────────────────────────── the difference ───────────────────────────── */

export async function approveDifference(
  tx: Tx,
  input: {
    companyId: string;
    storeId: string;
    transferId: string;
    approvedById: string;
    body: z.infer<typeof differenceSchema>;
    mayUse: (w: WarehouseRef) => Promise<boolean>;
  }
): Promise<{ transfer: StockTransferRow; replay: boolean }> {
  const { companyId, storeId, transferId } = input;
  await lockTransfer(tx, transferId);
  const t = await readTransfer(tx, companyId, storeId, transferId);

  // Two hands (three, here), before anything else — a replay included.
  if (t.sentById === input.approvedById) throw new StockTransferRefused('SENDER_CANNOT_APPROVE');
  if (t.receivedById === input.approvedById) throw new StockTransferRefused('RECEIVER_CANNOT_APPROVE');
  if (t.status !== 'RECEIVED_WITH_DIFFERENCE') throw new StockTransferRefused('NO_DIFFERENCE');
  if (t.differenceApprovedAt) {
    if (t.differenceApprovedById === input.approvedById && t.differenceType === input.body.type) return { transfer: t, replay: true };
    throw new StockTransferRefused('ALREADY_APPROVED');
  }

  const to = await tx.warehouse.findFirst({ where: { id: t.toWarehouseId, companyId }, select: { id: true, companyId: true, countryId: true } });
  if (!to) throw new StockTransferRefused('WAREHOUSE_NOT_FOUND');
  if (!(await input.mayUse(to))) throw new StockTransferRefused('NOT_REACHED', 'ما إلك وصول على المخزن اللي واصل عليه النقل.');

  await lockProductsStock(tx, companyId, t.lines.map((l) => l.productId));
  const words = input.body.type === 'DAMAGE' ? 'تالف' : 'ضايع';
  for (const l of t.lines) {
    const missing = l.quantitySent - (l.quantityReceived ?? 0);
    if (missing <= 0) continue;
    let left = missing;
    for (const row of await onTheRoad(tx, companyId, storeId, transferId, l.productId)) {
      if (left <= 0) break;
      const take = Math.min(row.quantityRemaining, left);
      // Units leave the store the way every loss does today (`drawDownStock`): remaining −, sold +. Guarded by what was read.
      const took = await tx.productionBatch.updateMany({
        where: { id: row.id, companyId, inTransitTransferId: transferId, quantityRemaining: row.quantityRemaining },
        data: { quantityRemaining: { decrement: take }, quantitySold: { increment: take } },
      });
      if (took.count !== 1) throw new StockTransferRefused('MOVED_MEANWHILE');
      left -= take;
    }
    if (left > 0) throw new StockTransferRefused('MOVED_MEANWHILE');
    await ledger(tx, {
      companyId,
      storeId,
      warehouseId: null,
      productId: l.productId,
      type: input.body.type,
      quantity: -missing,
      transferId,
      reason: `فرق نقل (${words}): ${input.body.reason}`,
      createdById: input.approvedById,
    });
  }
  await tx.stockTransfer.update({
    where: { id: transferId },
    data: {
      differenceType: input.body.type,
      differenceReason: input.body.reason,
      differenceApprovedById: input.approvedById,
      differenceApprovedAt: new Date(),
    },
  });
  return { transfer: await readTransfer(tx, companyId, storeId, transferId), replay: false };
}

/* ───────────────────────────── what the list shows ───────────────────────────── */

/**
 * A transfer as the list answers it. WHILE IT IS ON THE ROAD the sent quantities are told only to the person who sent
 * it: the receiver types what she counted without being told what to expect (the count is blind, like the keeper's
 * count of W5). Once received, every line says sent, counted and the difference.
 */
export function shownTo<T extends { status: string; sentById: string; lines: { productId: string; quantitySent: number; quantityReceived: number | null }[] }>(
  t: T,
  viewerId: string
) {
  const blind = t.status === 'SENT' && t.sentById !== viewerId;
  return {
    ...t,
    statusAr: STATUS_AR[t.status as StockTransferStatus] ?? t.status,
    blind,
    lines: t.lines.map((l) => ({
      productId: l.productId,
      quantitySent: blind ? null : l.quantitySent,
      quantityReceived: l.quantityReceived,
      difference: l.quantityReceived === null ? null : l.quantitySent - l.quantityReceived,
    })),
  };
}
