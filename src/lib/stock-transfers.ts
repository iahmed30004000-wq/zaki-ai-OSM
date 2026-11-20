import { z } from 'zod';
import { Prisma } from '@prisma/client';
import type { db as prismaDb } from './db';
import { splitBatch } from './batch-split';
import { holdingWhere, lockProductsStock } from './reservation';
import { WAREHOUSE_COUNTING_AR, holdWarehousesStill, warehousesUnderCount } from './stock-count-freeze';
import { drawDownStock, onHandTotal, receiveStock } from './receiving';
import { storeIsPlaced, type WarehouseRef } from './warehouse-intake';
import { isAcross, needsOwnerApproval, readStockTransfer, stockTransferRefusal, type StockTransferKind } from './stock-transfer-kind';
import { PENDING_EXIT } from './stock-exit-reasons';
import { twinsIn } from './product-twins';
import { arrivalCost, landedCostsField, missingValue, normalizeLanded, type LandedCost } from './stock-transfer-cost';
import {
  VARIANT_LINE_AR,
  VARIANT_LINE_STATUS,
  assertFreeVariants,
  cancelVariants,
  checkLineShapes,
  checkMembership,
  checkReceiptCounts,
  combosOf,
  differenceVariants,
  namesVariants,
  receiveVariants,
  sameReceiptCounts,
  sameVariants,
  sendVariants,
  transferVariantsOf,
  variantCountsField,
  variantLinesField,
  withLineVariants,
  writeTransferLineVariants,
  type Fail,
  type TransferVariantRow,
  type VariantLineRefusalCode,
} from './variant-lines';

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
 *
 * 20/11 (W8b): COMBINATIONS. A line of a product with combinations (size/colour) names them (`lines[].variants`), and
 * the line's quantity is their sum; the receipt counts them one by one. Their pieces move with the units — source →
 * the transfer's road → destination (or back to the source on a cancel, or out of the store on an approved shortfall)
 * — through `variant-lines.ts`, after the batch rows, by the one writer of a combination's count. A product without
 * combinations moves exactly as before.
 *
 * 20/11 (W7b): ACROSS STORES — another store of one country (BETWEEN_STORES) or of another country (BETWEEN_COUNTRIES),
 * by the owner's explicit word of 20/11. Two products, two books, so a batch is NOT split:
 *   send      every product needs its twin in the other store (`product-twins.twinsIn`, kept on the line). The units are
 *             DRAWN out of the source product in the source warehouse (`receiving.drawDownStock` — oldest first, never a
 *             unit on the road, the guarded write, a run and its twins costed once), the line keeps what they cost
 *             (`costOut`, not rounded), and the ledger says TRANSFER_OUT. Between send and receipt the goods exist on
 *             the document only. A transfer to another country needs `inventory.transfer_abroad`, and is first written
 *             AWAITING_APPROVAL: nothing moves (its units are held out of the free stock) until THE OWNER presses
 *             «اعتمد وابعت» (`approveAbroad`), which does the send.
 *   receive   counted units are RECEIVED into the twin in the destination warehouse (`receiving.receiveStock` — a new
 *             batch, its ledger line TRANSFER_IN) at the cost they left with plus the typed landed costs
 *             (`stock-transfer-cost.arrivalCost`: rounded to the destination's minor unit, the remainder pinned there).
 *   shortfall the missing units already left the source at the send: the approval by a third person is a REPORT ONLY —
 *             no unit, no ledger line, no money moves (the owner's decision 6). Nobody is charged.
 *   cancel    before receipt only: the units go back into the source product as a NEW batch in the source warehouse at
 *             the captured cost (cost per unit = costOut ÷ sent), ledger TRANSFER_IN. After receipt the only way back is
 *             a new transfer. A transfer still awaiting the owner is cancelled with nothing to give back.
 *   Products with combinations are refused across stores: no pair of combinations exists, so a piece could not be told
 *   where to land (`VARIANTS_ACROSS`).
 */

export type StockTransferStatus = 'AWAITING_APPROVAL' | 'SENT' | 'RECEIVED' | 'RECEIVED_WITH_DIFFERENCE' | 'CANCELLED';
export type DifferenceType = 'LOSS' | 'DAMAGE';

export const STATUS_AR: Record<StockTransferStatus, string> = {
  AWAITING_APPROVAL: 'مستني اعتماد المالك',
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
  // 20/11 (W7b): the transfer across stores and countries.
  | 'TO_OTHER_COUNTRY'
  | 'TO_STORE_NOT_FOUND'
  | 'TO_STORE_NOT_PLACED'
  | 'TO_STORE_NOT_REACHED'
  | 'ABROAD_KEY_MISSING'
  | 'NO_PAIR'
  | 'TWIN_GONE'
  | 'VARIANTS_ACROSS'
  | 'NOT_APPROVED_YET'
  | 'NOT_AWAITING'
  | 'OWNER_ONLY'
  | 'COSTS_NOT_HERE'
  | 'COSTS_WITHOUT_UNITS'
  | 'ZERO_COST_UNEXPLAINED'
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
  | 'COUNT_OVER_SENT'
  // 21/11 (W5a): a count sheet of one of the two warehouses is open.
  | 'WAREHOUSE_COUNTING'
  | VariantLineRefusalCode;

const STATUS_OF: Record<StockTransferRefusalCode, number> = {
  ...VARIANT_LINE_STATUS,
  INVALID: 400,
  SAME_WAREHOUSE: 400,
  PRODUCT_TWICE: 400,
  TRANSFER_EXISTS: 409,
  STORE_NOT_PLACED: 409,
  WAREHOUSE_NOT_FOUND: 404,
  WAREHOUSE_OTHER_COUNTRY: 400,
  KIND_CHANGED: 409,
  TO_OTHER_COUNTRY: 400,
  TO_STORE_NOT_FOUND: 404,
  TO_STORE_NOT_PLACED: 409,
  TO_STORE_NOT_REACHED: 403,
  ABROAD_KEY_MISSING: 403,
  NO_PAIR: 409,
  TWIN_GONE: 409,
  VARIANTS_ACROSS: 409,
  NOT_APPROVED_YET: 409,
  NOT_AWAITING: 409,
  OWNER_ONLY: 403,
  COSTS_NOT_HERE: 400,
  COSTS_WITHOUT_UNITS: 400,
  ZERO_COST_UNEXPLAINED: 400,
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
  WAREHOUSE_COUNTING: 409,
};

const AR: Partial<Record<StockTransferRefusalCode, string>> = {
  ...VARIANT_LINE_AR,
  SAME_WAREHOUSE: 'المخزن اللي بتنقل منه هو نفسه اللي بتنقل عليه. اختار مخزن تاني.',
  PRODUCT_TWICE: 'نفس المنتج مكتوب بسطرين. اجمعهم بسطر واحد.',
  TRANSFER_EXISTS: 'هالنقل انسجّل من قبل بشكل تاني. حدّث الصفحة وراجع قبل ما تعيد.',
  STORE_NOT_PLACED: 'هالمتجر لسا ما توزّع على المخازن. وزّع الرصيد على المخازن أول، وبعدين انقل.',
  WAREHOUSE_NOT_FOUND: 'المخزن مش موجود. حدّث الصفحة واختار من جديد.',
  WAREHOUSE_OTHER_COUNTRY: 'هالمخزن مش ببلد هالمتجر، وما بيشيل بضاعته.',
  TO_OTHER_COUNTRY: 'المخزن اللي بتنقل عليه مش ببلد المتجر اللي واصلة عليه البضاعة. لنقل لبلد تاني اختار المتجر اللي هناك ومخزن من مخازن بلده.',
  TO_STORE_NOT_FOUND: 'المتجر اللي بتنقل عليه مش موجود. حدّث الصفحة واختار من جديد.',
  TO_STORE_NOT_PLACED: 'المتجر اللي بتنقل عليه لسا ما توزّع على المخازن. لازم يتوزّع رصيده على المخازن أول.',
  TO_STORE_NOT_REACHED: 'ما إلك وصول على المتجر اللي واصلة عليه البضاعة.',
  ABROAD_KEY_MISSING: 'النقل لبلد تاني بدّو صلاحية «نقل بضاعة لبلد تاني». اطلبها من المالك.',
  NO_PAIR: 'في منتج ما إله توأم بالمتجر اللي بتنقل عليه. اربطه بتوأمه أول.',
  TWIN_GONE: 'المنتج التوأم بالمتجر التاني انحذف. اربط المنتج من جديد واعمل نقل جديد.',
  VARIANTS_ACROSS: 'المنتج اللي إله خيارات (مقاس/لون) ما بينقل لمتجر تاني لسا: ما في ربط بين خيارات المتجرين.',
  NOT_APPROVED_YET: 'هالنقل لسا مستني اعتماد المالك، والبضاعة ما طلعت.',
  NOT_AWAITING: 'هالنقل مش مستني اعتماد. حدّث الصفحة.',
  OWNER_ONLY: 'اعتماد النقل لبلد تاني إلو للمالك بس.',
  COSTS_NOT_HERE: 'المصاريف بتنكتب بس على نقل لمتجر تاني. النقل جوّا المتجر ما بيغيّر الكلفة.',
  COSTS_WITHOUT_UNITS: 'ما وصل ولا قطعة من هالمنتج، فما في وين تنحط مصاريفه. شيلها أو صحّح العدد.',
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
  WAREHOUSE_COUNTING: WAREHOUSE_COUNTING_AR,
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

/** How `variant-lines.ts` refuses inside a transfer: as the transfer refuses. */
const fail: Fail = (code, errorAr, extra) => {
  throw new StockTransferRefused(code, errorAr ?? VARIANT_LINE_AR[code], extra ?? {});
};

/* ───────────────────────────── the bodies ───────────────────────────── */

const qty = z.number({ message: 'الكمية لازم تكون رقم' }).int('الكمية لازم تكون عدد صحيح');
/*
 * 20/11 (W3b): every message of these bodies is an Arabic sentence — the screen «نقل البضاعة» prints the door's refusal
 * as it is. Before, a missing product id, an empty store id, a note or a reason past 500 letters, an unknown kind, or a
 * body that was not an object at all came back in zod's English («Too small: expected string…», «Invalid input:
 * expected object…»). The doors also turn any message with no Arabic letter into one Arabic sentence
 * (`stock-transfer-door.arabicIssue`), so a rule added later without its sentence still answers in Arabic.
 */
const BODY_AR = { message: 'البيانات ناقصة أو مش صحيحة. حدّث الصفحة وجرّب كمان مرة.' };
const productIdField = z.string({ message: 'المنتج مش محدد' }).min(1, 'اختار المنتج');
const words = (what: string, min: number, minAr: string) =>
  z.string({ message: minAr }).trim().min(min, minAr).max(500, `${what} أطول من 500 حرف. اختصره.`);

export const sendSchema = z.object(
  {
    /** Made by the client before the first press: the same id pressed twice is one transfer. */
    id: z.string({ message: 'رقم النقل مش صحيح' }).uuid('رقم النقل مش صحيح').optional(),
    fromWarehouseId: z.string({ message: 'اختار المخزن اللي بتنقل منه' }).min(1, 'اختار المخزن اللي بتنقل منه'),
    toWarehouseId: z.string({ message: 'اختار المخزن اللي بتنقل عليه' }).min(1, 'اختار المخزن اللي بتنقل عليه'),
    /** Whose goods arrive. Absent = the same store (INTERNAL). Another store is a kind not built yet. */
    toStoreId: z.string({ message: 'المتجر اللي بتنقل عليه مش صحيح' }).min(1, 'المتجر اللي بتنقل عليه مش صحيح').optional(),
    expectKind: z.enum(['INTERNAL', 'BETWEEN_STORES', 'BETWEEN_COUNTRIES'], { message: 'نوع النقل مش معروف. حدّث الصفحة.' }).optional(),
    note: z.string({ message: 'الملاحظة لازم تكون كلام' }).trim().max(500, 'الملاحظة أطول من 500 حرف. اختصرها.').optional().nullable(),
    lines: z
      .array(
        z.object(
          {
            productId: productIdField,
            quantity: qty.positive('الكمية لازم تكون أكبر من صفر'),
            /** 20/11 (W8b): a product with combinations names them; their sum is `quantity`. */
            variants: variantLinesField.optional(),
          },
          BODY_AR
        ),
        {
        message: 'زيد منتج واحد على الأقل',
      })
      .min(1, 'زيد منتج واحد على الأقل')
      .max(200, 'كتير منتجات بنقل واحد. قسّمه.'),
  },
  BODY_AR
);

export const receiveSchema = z.object(
  {
    lines: z
      .array(
        z.object(
          {
            productId: productIdField,
            quantity: qty.min(0, 'العدد ما بيكون أقل من صفر'),
            /** 20/11 (W8b): a line sent with combinations is counted per combination; their sum is `quantity`. */
            variants: variantCountsField.optional(),
            /**
             * 20/11 (W7b): ACROSS STORES ONLY — the landed cost lines of this product (transport, customs, other), in the
             * destination store's currency. Their total goes into the unit cost (`stock-transfer-cost.arrivalCost`).
             */
            costs: landedCostsField.optional(),
            /** 20/11 (W7b): why a unit cost of zero is real (`unit-cost.resolveUnitCost`). */
            zeroCostReason: z.string({ message: 'سبب الكلفة صفر لازم يكون كلام' }).trim().max(300, 'سبب الكلفة صفر أطول من 300 حرف. اختصره.').optional().nullable(),
          },
          BODY_AR
        ),
        { message: 'اكتب العدد لكل منتج' }
      )
      .min(1, 'اكتب العدد لكل منتج'),
  },
  BODY_AR
);

export const cancelSchema = z.object({ reason: words('سبب الإلغاء', 3, 'اكتب سبب الإلغاء') }, BODY_AR);

/** 20/11 (W7b): the owner's press on a transfer to another country carries nothing but itself. */
export const approveSchema = z.object({}, BODY_AR);

export const differenceSchema = z.object(
  {
    type: z.enum(['LOSS', 'DAMAGE'], { message: 'اختار: ضايع أو تالف' }),
    reason: words('سبب الفرق', 3, 'اكتب سبب الفرق'),
  },
  BODY_AR
);

/* ───────────────────────────── shared reads ───────────────────────────── */

export type WarehouseRow = { id: string; companyId: string; countryId: string; isActive: boolean; name: string };

/** The warehouse rows FOR SHARE, in id order: a stop waits for this transaction, and this one waits for a stop under way. */
export async function lockWarehousesForShare(tx: Tx, ids: readonly string[]): Promise<Map<string, WarehouseRow>> {
  const out = new Map<string, WarehouseRow>();
  for (const id of [...new Set(ids)].sort()) {
    const rows = await tx.$queryRaw<WarehouseRow[]>`
      SELECT "id", "companyId", "countryId", "isActive", "name" FROM "warehouses" WHERE "id" = ${id} FOR SHARE`;
    if (rows[0]) out.set(id, rows[0]);
  }
  return out;
}

/**
 * 21/11 (W5a): A WAREHOUSE UNDER COUNT STANDS STILL (`stock-count-freeze.ts`). Asked after its row is read FOR SHARE (a
 * sheet is opened under the row FOR UPDATE), so a sheet opened first is seen and one opened later waits for this press.
 */
async function refuseIfCounting(tx: Tx, warehouseIds: readonly string[], locked = false): Promise<void> {
  if (!locked) await holdWarehousesStill(tx, warehouseIds);
  const busy = await warehousesUnderCount(tx, warehouseIds);
  if (busy.size > 0) throw new StockTransferRefused('WAREHOUSE_COUNTING', undefined, { warehouseIds: [...busy].sort() });
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
 *
 * 20/11 (W6a): the third term is real — Σ quantity of the lines of this store's exits from this warehouse that are still
 * PENDING (`stock-exit-reasons.PENDING_EXIT`). A rejected exit releases its units (it is no longer pending); an approved one has
 * already taken them off the shelf (the first term), so it is not counted twice. ONE formula: the exit request and the
 * transfer send both ask this function.
 *
 * 20/11 (W7b): a fourth term — Σ sent of the lines of this store's transfers from this warehouse still AWAITING the
 * owner's approval (to another country: nothing has moved yet, so the shelf still holds them). `exceptTransferId` leaves
 * out the transfer being approved, which asks for its own units. No such transfer exists before W7b, so the term is 0.
 */
export async function freeStockOf(
  tx: Tx,
  p: { companyId: string; storeId: string; warehouseId: string; productIds: readonly string[]; exceptTransferId?: string }
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
    const [lines, addOns, exits, awaiting] = await Promise.all([
      tx.orderItem.aggregate({ where, _sum: { reservedQty: true } }),
      tx.orderAddOn.aggregate({ where, _sum: { reservedQty: true } }),
      tx.stockExitLine.aggregate({
        where: { productId, exit: { companyId: p.companyId, storeId: p.storeId, warehouseId: p.warehouseId, status: PENDING_EXIT } },
        _sum: { quantity: true },
      }),
      tx.stockTransferLine.aggregate({
        where: {
          productId,
          transfer: {
            companyId: p.companyId,
            storeId: p.storeId,
            fromWarehouseId: p.warehouseId,
            status: 'AWAITING_APPROVAL',
            ...(p.exceptTransferId ? { id: { not: p.exceptTransferId } } : {}),
          },
        },
        _sum: { quantitySent: true },
      }),
    ]);
    const reserved = (lines._sum.reservedQty ?? 0) + (addOns._sum.reservedQty ?? 0);
    const pendingExits = exits._sum.quantity ?? 0;
    const awaitingOwner = awaiting._sum.quantitySent ?? 0;
    free.set(productId, (shelf._sum.quantityRemaining ?? 0) - reserved - pendingExits - awaitingOwner);
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
  // 20/11 (W7b): the destination store and the owner's press (null for INTERNAL).
  toStoreId: true,
  approvedById: true,
  approvedAt: true,
  lines: {
    select: {
      productId: true,
      quantitySent: true,
      quantityReceived: true,
      // 20/11 (W7b): the twin and the cost the units carry (null for INTERNAL).
      toProductId: true,
      costOut: true,
      landedCosts: true,
      unitCostIn: true,
      costRemainder: true,
    },
    orderBy: { productId: 'asc' as const },
  },
} as const;

/** 20/11 (W8b): a transfer with its lines' combinations — added only to a line that has them. */
async function withVariants<
  L extends { productId: string; quantitySent: number; quantityReceived: number | null },
  T extends { id: string; lines: L[] },
>(tx: Tx, t: T & { lines: L[] }) {
  const lines = withLineVariants<L, TransferVariantRow>(t.lines, await transferVariantsOf(tx, t.id));
  return { ...(t as Omit<T, 'lines'>), lines };
}

/**
 * The transfer as the store `storeId` may see it: its own (the source store), or — 20/11 (W7b) — one whose goods arrive
 * in it (`toStoreId`). An INTERNAL transfer has no `toStoreId`, so for it this is the question it always was.
 */
async function readTransfer(tx: Tx, companyId: string, storeId: string, id: string) {
  const t = await tx.stockTransfer.findFirst({ where: { id, companyId, OR: [{ storeId }, { toStoreId: storeId }] }, select: TRANSFER_SELECT });
  if (!t) throw new StockTransferRefused('NOT_FOUND');
  return withVariants(tx, t);
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

/**
 * 20/11 (W7b): THE SEND OF A TRANSFER ACROSS STORES — the units leave the source product in the source warehouse, and
 * the line keeps what they cost. `drawDownStock` is the one draw of this system: oldest first, never a unit on the road,
 * only that warehouse's rows, a write guarded by what was read, a run and its twins costed once. Its cost is kept as it
 * is — NOT rounded — so the source's stock value fell by exactly `costOut`. The caller holds the products' stock lock and
 * has checked the free stock under it.
 */
async function dispatchAcross(
  tx: Tx,
  p: {
    companyId: string;
    storeId: string;
    transferId: string;
    fromWarehouseId: string;
    toWords: string;
    lines: readonly { productId: string; quantity: number }[];
    byId: string;
  }
) {
  for (const line of p.lines) {
    let drawn: { taken: number; short: number; cost: number };
    try {
      drawn = await drawDownStock(tx, {
        companyId: p.companyId,
        storeId: p.storeId,
        warehouseId: p.fromWarehouseId,
        productId: line.productId,
        quantity: line.quantity,
        allowNegative: false,
      });
    } catch (e) {
      // The draw refuses in its own words when the shelf moved between the free-stock check and its write.
      if (e instanceof Error && !('code' in e)) throw new StockTransferRefused('MOVED_MEANWHILE');
      throw e;
    }
    if (drawn.taken !== line.quantity || drawn.short !== 0) throw new StockTransferRefused('MOVED_MEANWHILE');
    await tx.stockTransferLine.updateMany({ where: { transferId: p.transferId, productId: line.productId }, data: { costOut: drawn.cost } });
    await ledger(tx, {
      companyId: p.companyId,
      storeId: p.storeId,
      warehouseId: p.fromWarehouseId,
      productId: line.productId,
      type: 'TRANSFER_OUT',
      quantity: -line.quantity,
      transferId: p.transferId,
      reason: `نقل إلى ${p.toWords}`,
      createdById: p.byId,
    });
  }
}

/* ───────────────────────────── send ───────────────────────────── */

export interface SendInput {
  companyId: string;
  storeId: string;
  sentById: string;
  body: z.infer<typeof sendSchema>;
  /** Does the sender reach this warehouse? The door passes `warehouses.reachesWarehouse` for the session. */
  mayUse: (w: WarehouseRef) => Promise<boolean>;
  /**
   * 20/11 (W7b): does the sender reach this OTHER store (the system's one store-entry rule, `geo-context.reachesStore`)?
   * Asked only for a transfer across stores. Absent = no.
   */
  mayReachStore?: (storeId: string) => Promise<boolean>;
  /** 20/11 (W7b): does the sender hold `inventory.transfer_abroad`? Asked only for another country. Absent = no. */
  mayAbroad?: boolean;
}

/** 20/11 (W7b): the store the goods arrive in, when it is not the source store (null = INTERNAL). */
const destinationOf = (storeId: string, toStoreId: string | null | undefined) => (toStoreId && toStoreId !== storeId ? toStoreId : null);

const sameLines = (
  a: readonly { productId: string; quantity: number; variants?: readonly { variantId: string; quantity: number }[] }[],
  b: readonly { productId: string; quantitySent: number; variants?: readonly { variantId: string; quantitySent: number }[] }[]
) =>
  a.length === b.length &&
  [...a].sort((x, y) => x.productId.localeCompare(y.productId)).every((l, i) => {
    const s = [...b].sort((x, y) => x.productId.localeCompare(y.productId))[i];
    return (
      s.productId === l.productId &&
      s.quantitySent === l.quantity &&
      // 20/11 (W8b): the same combinations too (none on both sides for a product without them).
      sameVariants(l.variants, s.variants?.map((v) => ({ variantId: v.variantId, quantity: v.quantitySent })))
    );
  });

/**
 * A REPLAY: the same id, the same deal (ends, lines) and the same sender → that transfer, nothing written. The same id
 * carrying anything else — another deal, another person, another company's row — is a conflict that says nothing about
 * the row. Asked first, before the warehouses are judged: the first press may have succeeded and a warehouse been
 * stopped since, and a retry of a transfer that happened is a success to repeat.
 */
export async function replayOf(tx: Tx, input: Omit<SendInput, 'mayUse' | 'mayReachStore' | 'mayAbroad'>) {
  const id = input.body.id;
  if (!id) return null;
  const found = await tx.stockTransfer.findUnique({ where: { id }, select: TRANSFER_SELECT });
  if (!found) return null;
  const row = await withVariants(tx, found);
  const same =
    row.companyId === input.companyId &&
    row.storeId === input.storeId &&
    row.sentById === input.sentById &&
    row.fromWarehouseId === input.body.fromWarehouseId &&
    row.toWarehouseId === input.body.toWarehouseId &&
    // 20/11 (W7b): the same destination store (null on both sides = INTERNAL, as before).
    destinationOf(input.storeId, input.body.toStoreId) === (row.toStoreId ?? null) &&
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
  checkLineShapes(body.lines, fail);

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

  /*
   * 20/11 (W7b): THE DESTINATION STORE. Absent (or this store) = INTERNAL, and the destination warehouse must then be of
   * this store's country — a warehouse of another country holds none of this store's goods. Before W7b such a pair was
   * read as BETWEEN_COUNTRIES and refused «لسا مش مبني»; it is refused now with the sentence that says what to choose.
   */
  const destStoreId = destinationOf(storeId, body.toStoreId);
  const destStore = destStoreId
    ? await tx.store.findFirst({ where: { id: destStoreId, companyId }, select: { countryId: true, name: true } })
    : store;
  if (!destStore) throw new StockTransferRefused('TO_STORE_NOT_FOUND');
  if (to.countryId !== destStore.countryId) throw new StockTransferRefused('TO_OTHER_COUNTRY');

  const ends = {
    from: { warehouseId: from.id, warehouseName: from.name, storeId, storeName: store.name, countryId: from.countryId },
    to: { warehouseId: to.id, warehouseName: to.name, storeId: destStoreId ?? storeId, storeName: destStore.name, countryId: to.countryId },
  };
  const pairRefusal = stockTransferRefusal(ends.from, ends.to);
  if (pairRefusal) throw new StockTransferRefused('SAME_WAREHOUSE', pairRefusal);
  const reading = readStockTransfer(ends.from, ends.to);
  if (body.expectKind && body.expectKind !== reading.kind) {
    throw new StockTransferRefused('KIND_CHANGED', `تغيّر نوع النقل — هاد ${reading.label}. راجعه وأعد المحاولة.`, { kind: reading.kind });
  }
  const across = isAcross(reading.kind);
  // The abroad key, before anything else of the destination is looked at.
  if (needsOwnerApproval(reading.kind) && input.mayAbroad !== true) throw new StockTransferRefused('ABROAD_KEY_MISSING');

  if (!(await storeIsPlaced(storeId, tx))) throw new StockTransferRefused('STORE_NOT_PLACED');
  if (destStoreId && !(await storeIsPlaced(destStoreId, tx))) throw new StockTransferRefused('TO_STORE_NOT_PLACED');
  if (!from.isActive) throw new StockTransferRefused('FROM_STOPPED');
  if (!to.isActive) throw new StockTransferRefused('TO_STOPPED');
  await refuseIfCounting(tx, [from.id, to.id], true);
  if (!(await input.mayUse({ id: from.id, companyId: from.companyId, countryId: from.countryId }))) {
    throw new StockTransferRefused('NOT_REACHED', 'ما إلك وصول على المخزن اللي بتنقل منه.');
  }
  if (destStoreId && !(input.mayReachStore && (await input.mayReachStore(destStoreId)))) throw new StockTransferRefused('TO_STORE_NOT_REACHED');

  const products = await tx.product.findMany({ where: { id: { in: productIds }, companyId, storeId }, select: { id: true, name: true } });
  if (products.length !== productIds.length) throw new StockTransferRefused('PRODUCT_NOT_FOUND');
  const nameOf = new Map(products.map((p) => [p.id, p.name]));
  // 20/11 (W8b): a product with active combinations names them; a product without any names none.
  const combos = await combosOf(tx, companyId, productIds);
  /*
   * 20/11 (W7b): ACROSS STORES, the twin of every product — and no combinations at either end. There is no pair of
   * combinations (W7a pairs products only), so a piece of «أسود · L» could not be told which combination of the other
   * store it lands in. The smallest safe rule: refused, by name, until combination pairs exist.
   */
  const twinOf = new Map<string, string>();
  if (across) {
    const withCombos = productIds.filter((id) => combos.has(id));
    if (withCombos.length > 0 || body.lines.some(namesVariants)) {
      throw new StockTransferRefused('VARIANTS_ACROSS', undefined, { productIds: withCombos.length ? withCombos : body.lines.filter(namesVariants).map((l) => l.productId) });
    }
    const twins = await twinsIn(tx, companyId, storeId, productIds, destStoreId!);
    const unpaired = productIds.filter((id) => !twins.has(id));
    if (unpaired.length > 0) {
      throw new StockTransferRefused(
        'NO_PAIR',
        `هالمنتجات ما إلها توأم بـ${destStore.name}: ${unpaired.map((id) => nameOf.get(id) ?? '').join(' · ')}. اربطها بتوأمها أول.`,
        { productIds: unpaired }
      );
    }
    const twinIds = [...twins.values()];
    const twinRows = await tx.product.findMany({ where: { id: { in: twinIds }, companyId, storeId: destStoreId! }, select: { id: true } });
    if (twinRows.length !== new Set(twinIds).size) throw new StockTransferRefused('TWIN_GONE');
    const twinCombos = await combosOf(tx, companyId, twinIds);
    if (twinCombos.size > 0) throw new StockTransferRefused('VARIANTS_ACROSS', undefined, { productIds: [...twinCombos.keys()] });
    for (const [a, b] of twins) twinOf.set(a, b);
  } else {
    checkMembership(body.lines, combos, nameOf, fail, { required: true });
  }

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
  if (!across) {
    await assertFreeVariants(tx, { companyId, storeId, warehouseId: from.id, warehouseName: from.name, lines: body.lines, combos, nameOf }, fail);
  }

  const awaitsOwner = needsOwnerApproval(reading.kind);
  const created = await tx.stockTransfer.create({
    data: {
      ...(body.id ? { id: body.id } : {}),
      companyId,
      storeId,
      kind: reading.kind,
      fromWarehouseId: from.id,
      toWarehouseId: to.id,
      status: awaitsOwner ? 'AWAITING_APPROVAL' : 'SENT',
      note: body.note?.trim() || null,
      sentById: input.sentById,
      // 20/11 (W7b): written only for a transfer across stores, so an INTERNAL row is the row it always was.
      ...(destStoreId ? { toStoreId: destStoreId } : {}),
      lines: {
        create: body.lines.map((l) => ({
          productId: l.productId,
          quantitySent: l.quantity,
          ...(across ? { toProductId: twinOf.get(l.productId)! } : {}),
        })),
      },
    },
    select: { id: true },
  });

  if (across) {
    // Another country waits for the owner's press: nothing moves now. Another store of this country leaves at once.
    if (!awaitsOwner) {
      await dispatchAcross(tx, {
        companyId,
        storeId,
        transferId: created.id,
        fromWarehouseId: from.id,
        toWords: `${destStore.name} — ${to.name}`,
        lines: body.lines,
        byId: input.sentById,
      });
    }
    return { transfer: await readTransfer(tx, companyId, storeId, created.id), replay: false, kind: reading.kind };
  }

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
  /*
   * The combinations: their document rows, then their pieces on the road — AFTER the batch rows. Inserting a combination
   * row takes a key-share lock on its `product_variants` row (the foreign key) until commit; a delivery writes batch rows
   * and then locks the same combination rows. Written before the batches, the two could wait for each other in a circle.
   */
  await writeTransferLineVariants(tx, created.id, body.lines);
  await sendVariants(
    tx,
    { companyId, storeId, userId: input.sentById, referenceId: created.id },
    { fromWarehouseId: from.id, lines: body.lines, reason: `نقل إلى ${to.name}` },
    fail
  );

  return { transfer: await readTransfer(tx, companyId, storeId, created.id), replay: false, kind: reading.kind };
}

/* ───────────────────────────── receive ───────────────────────────── */

const countsMatch = (t: StockTransferRow, counts: readonly { productId: string; quantity: number; variants?: { variantId: string; quantity: number }[] }[]) =>
  t.lines.length === counts.length &&
  t.lines.every((l) => counts.find((c) => c.productId === l.productId)?.quantity === l.quantityReceived) &&
  // 20/11 (W8b): and each combination counted the same.
  sameReceiptCounts(counts, new Map(t.lines.map((l) => [l.productId, l.variants ?? []])));

export async function receiveTransfer(
  tx: Tx,
  input: {
    companyId: string;
    storeId: string;
    transferId: string;
    receivedById: string;
    body: z.infer<typeof receiveSchema>;
    mayUse: (w: WarehouseRef) => Promise<boolean>;
    /** 20/11 (W7b): does the receiver reach the destination store of a transfer across stores? Absent = no. */
    mayReachStore?: (storeId: string) => Promise<boolean>;
  }
): Promise<{ transfer: StockTransferRow; replay: boolean }> {
  const { companyId, storeId, transferId } = input;
  await lockTransfer(tx, transferId);
  const t = await readTransfer(tx, companyId, storeId, transferId);

  // Two hands, before anything else — a replay included.
  if (t.sentById === input.receivedById) throw new StockTransferRefused('SENDER_CANNOT_RECEIVE');
  if (t.status === 'CANCELLED') throw new StockTransferRefused('ALREADY_CANCELLED');
  if (t.status === 'AWAITING_APPROVAL') throw new StockTransferRefused('NOT_APPROVED_YET');
  if (t.status !== 'SENT') {
    if (t.receivedById === input.receivedById && countsMatch(t, input.body.lines) && (await sameCosts(tx, t, input.body.lines))) {
      return { transfer: t, replay: true };
    }
    throw new StockTransferRefused('ALREADY_RECEIVED');
  }
  if (isAcross(t.kind)) return receiveAcross(tx, t, input);
  // 20/11 (W7b): inside one store the cost does not move, so there is nothing to type.
  if (input.body.lines.some((c) => (c.costs?.length ?? 0) > 0 || !!c.zeroCostReason?.trim())) throw new StockTransferRefused('COSTS_NOT_HERE');

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
  // 20/11 (W8b): a line sent with combinations is counted per combination.
  const sentVariants = new Map(t.lines.map((l) => [l.productId, l.variants ?? []]));
  checkReceiptCounts(counts, sentVariants, fail);

  await lockProductsStock(tx, companyId, [...sentOf.keys()]);
  await refuseIfCounting(tx, [to.id]);
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
    if (namesVariants(c)) {
      for (const v of c.variants!) {
        await tx.stockTransferLineVariant.updateMany({ where: { transferId, productId: c.productId, variantId: v.variantId }, data: { quantityReceived: v.quantity } });
      }
    }
  }
  await receiveVariants(
    tx,
    { companyId, storeId, userId: input.receivedById, referenceId: transferId },
    { toWarehouseId: to.id, counts, reason: `استلام نقل على ${to.name}` },
    fail
  );
  await tx.stockTransfer.update({
    where: { id: transferId },
    data: { status: short ? 'RECEIVED_WITH_DIFFERENCE' : 'RECEIVED', receivedById: input.receivedById, receivedAt: new Date() },
  });
  return { transfer: await readTransfer(tx, companyId, storeId, transferId), replay: false };
}

/** The destination store's currency decimals (its country's minor unit; 2 when unknown, as every money door says). */
async function minorUnitOf(tx: Tx, companyId: string, storeId: string): Promise<number> {
  const s = await tx.store.findFirst({ where: { id: storeId, companyId }, select: { country: { select: { minorUnit: true } } } });
  return s?.country?.minorUnit ?? 2;
}

/** The typed cost lines as stored (an INTERNAL line has none). */
const storedLanded = (v: unknown): LandedCost[] => (Array.isArray(v) ? (v as LandedCost[]) : []);

/**
 * 20/11 (W7b): a replayed receipt across stores is the same receipt only with the same cost lines too (normalized as
 * they were stored). Inside one store there are none, and the answer is what it always was.
 */
async function sameCosts(
  tx: Tx,
  t: StockTransferRow,
  counts: readonly { productId: string; costs?: LandedCost[] | null }[]
): Promise<boolean> {
  if (!isAcross(t.kind) || !t.toStoreId) return true;
  const minor = await minorUnitOf(tx, t.companyId, t.toStoreId);
  return t.lines.every((l) => {
    const typed = normalizeLanded(counts.find((c) => c.productId === l.productId)?.costs, minor);
    return JSON.stringify(typed) === JSON.stringify(storedLanded(l.landedCosts));
  });
}

/**
 * 20/11 (W7b): THE RECEIPT OF A TRANSFER ACROSS STORES. Counted units of each line are received into the twin
 * (`toProductId`) in the destination warehouse as a NEW batch (`receiving.receiveStock` — it asks the destination
 * store's placement and the warehouse's country, state and reach), at the unit cost `stock-transfer-cost.arrivalCost`
 * computes: the cost that left for the units that arrived, plus the typed landed lines, rounded to the destination's
 * minor unit, the remainder written on the line and booked nowhere. Its ledger line is TRANSFER_IN with the transfer's id.
 * A line counted 0 opens no batch (and may carry no cost line). What was not counted is a shortfall — a report only.
 */
async function receiveAcross(
  tx: Tx,
  t: StockTransferRow,
  input: {
    companyId: string;
    transferId: string;
    receivedById: string;
    body: z.infer<typeof receiveSchema>;
    mayUse: (w: WarehouseRef) => Promise<boolean>;
    mayReachStore?: (storeId: string) => Promise<boolean>;
  }
): Promise<{ transfer: StockTransferRow; replay: boolean }> {
  const { companyId, transferId } = input;
  const destStoreId = t.toStoreId!;
  const to = await tx.warehouse.findFirst({ where: { id: t.toWarehouseId, companyId }, select: { id: true, companyId: true, countryId: true, name: true } });
  if (!to) throw new StockTransferRefused('WAREHOUSE_NOT_FOUND');
  if (!(await input.mayUse({ id: to.id, companyId: to.companyId, countryId: to.countryId }))) {
    throw new StockTransferRefused('NOT_REACHED', 'ما إلك وصول على المخزن اللي واصل عليه النقل.');
  }
  if (!(input.mayReachStore && (await input.mayReachStore(destStoreId)))) throw new StockTransferRefused('TO_STORE_NOT_REACHED');

  const counts = input.body.lines;
  const sentOf = new Map(t.lines.map((l) => [l.productId, l.quantitySent]));
  const named = new Set(counts.map((c) => c.productId));
  if (named.size !== counts.length || counts.length !== t.lines.length || counts.some((c) => !sentOf.has(c.productId))) {
    throw new StockTransferRefused('COUNTS_INVALID');
  }
  const over = counts.find((c) => c.quantity > (sentOf.get(c.productId) ?? 0));
  if (over) throw new StockTransferRefused('COUNT_OVER_SENT', 'العدد أكتر من اللي انبعت. عدّ كمان مرة، والزيادة بتنكتب من الجرد مش من هون.');
  if (counts.some(namesVariants)) throw new StockTransferRefused('VARIANTS_ACROSS');

  const minor = await minorUnitOf(tx, companyId, destStoreId);
  const from = await tx.warehouse.findFirst({ where: { id: t.fromWarehouseId, companyId }, select: { name: true } });
  const fromStore = await tx.store.findFirst({ where: { id: t.storeId, companyId }, select: { name: true } });
  const fromWords = `${fromStore?.name ?? 'متجر تاني'} — ${from?.name ?? 'مخزن'}`;

  const twins = t.lines.map((l) => l.toProductId).filter((x): x is string => !!x);
  if (twins.length !== t.lines.length) throw new StockTransferRefused('TWIN_GONE');
  await lockProductsStock(tx, companyId, twins);

  let short = false;
  for (const c of counts) {
    const line = t.lines.find((l) => l.productId === c.productId)!;
    const landed = normalizeLanded(c.costs, minor);
    if (c.quantity < line.quantitySent) short = true;
    if (c.quantity === 0) {
      if (landed.length > 0) throw new StockTransferRefused('COSTS_WITHOUT_UNITS', undefined, { productId: c.productId });
      await tx.stockTransferLine.updateMany({ where: { transferId, productId: c.productId }, data: { quantityReceived: 0 } });
      continue;
    }
    if (line.costOut === null || line.costOut === undefined) throw new StockTransferRefused('MOVED_MEANWHILE');
    const cost = arrivalCost({
      costOut: line.costOut,
      sent: line.quantitySent,
      received: c.quantity,
      landed,
      minorUnit: minor,
      zeroCostReason: c.zeroCostReason,
    });
    if (!cost.ok) throw new StockTransferRefused('ZERO_COST_UNEXPLAINED', cost.message, { productId: c.productId, costCode: cost.code });
    await receiveStock(tx, {
      companyId,
      storeId: destStoreId,
      productId: line.toProductId!,
      quantity: c.quantity,
      unitCost: cost.unitCost,
      warehouseId: to.id,
      mayUse: input.mayUse,
      note: `نقل من ${fromWords}`,
      createdById: input.receivedById,
      movement: { type: 'TRANSFER_IN', referenceId: transferId, reason: `استلام نقل من ${fromWords} على ${to.name}` },
    });
    await tx.stockTransferLine.updateMany({
      where: { transferId, productId: c.productId },
      data: {
        quantityReceived: c.quantity,
        unitCostIn: cost.unitCost,
        landedCosts: landed as unknown as Prisma.InputJsonValue,
        costRemainder: cost.remainder,
        zeroCostReason: cost.unitCost === 0 ? c.zeroCostReason?.trim() || null : null,
      },
    });
  }
  await tx.stockTransfer.update({
    where: { id: transferId },
    data: { status: short ? 'RECEIVED_WITH_DIFFERENCE' : 'RECEIVED', receivedById: input.receivedById, receivedAt: new Date() },
  });
  return { transfer: await readTransfer(tx, companyId, t.storeId, transferId), replay: false };
}

/* ───────────────────────────── the owner's press (another country) ───────────────────────────── */

/**
 * 20/11 (W7b): THE OWNER'S PRESS on a transfer to another country — «اعتمد وابعت». Only the owner (`isOwner`: the
 * engine's own full-access flag, `authorization.hasFullAccess`) may press it; a person who holds every inventory key,
 * the abroad key included, may not. It does the send that the request did not: the free stock is asked again (the
 * transfer's own held units left out), and the units are drawn out of the source (`dispatchAcross`). The owner may press
 * it on a request he wrote himself — it is his approval that the rule asks for, not a second person.
 */
export async function approveAbroad(
  tx: Tx,
  input: {
    companyId: string;
    storeId: string;
    transferId: string;
    approvedById: string;
    isOwner: boolean;
    mayUse: (w: WarehouseRef) => Promise<boolean>;
  }
): Promise<{ transfer: StockTransferRow; replay: boolean }> {
  const { companyId, storeId, transferId } = input;
  await lockTransfer(tx, transferId);
  const t = await readTransfer(tx, companyId, storeId, transferId);
  if (!input.isOwner) throw new StockTransferRefused('OWNER_ONLY');
  if (t.status === 'CANCELLED') throw new StockTransferRefused('ALREADY_CANCELLED');
  if (t.status !== 'AWAITING_APPROVAL') {
    if (t.approvedById === input.approvedById && t.approvedAt) return { transfer: t, replay: true };
    throw new StockTransferRefused('NOT_AWAITING');
  }

  const productIds = t.lines.map((l) => l.productId);
  await lockProductsStock(tx, companyId, productIds);
  const wh = await lockWarehousesForShare(tx, [t.fromWarehouseId, t.toWarehouseId]);
  const from = wh.get(t.fromWarehouseId);
  const to = wh.get(t.toWarehouseId);
  if (!from || !to) throw new StockTransferRefused('WAREHOUSE_NOT_FOUND');
  if (!from.isActive) throw new StockTransferRefused('FROM_STOPPED');
  if (!to.isActive) throw new StockTransferRefused('TO_STOPPED');
  await refuseIfCounting(tx, [from.id], true);
  if (!(await input.mayUse({ id: from.id, companyId: from.companyId, countryId: from.countryId }))) {
    throw new StockTransferRefused('NOT_REACHED', 'ما إلك وصول على المخزن اللي بتنقل منه.');
  }
  if (t.lines.some((l) => !l.toProductId)) throw new StockTransferRefused('TWIN_GONE');

  const free = await freeStockOf(tx, { companyId, storeId: t.storeId, warehouseId: from.id, productIds, exceptTransferId: t.id });
  const shortLines = t.lines.filter((l) => l.quantitySent > (free.get(l.productId) ?? 0));
  if (shortLines.length > 0) {
    throw new StockTransferRefused('NOT_ENOUGH_FREE', `ما في كفاية ببضاعة ${from.name} الحرّة هلّق. اطلب نقل أصغر أو ألغي هالطلب.`, {
      short: shortLines.map((l) => ({ productId: l.productId, asked: l.quantitySent, free: Math.max(0, free.get(l.productId) ?? 0) })),
    });
  }
  const destStore = await tx.store.findFirst({ where: { id: t.toStoreId!, companyId }, select: { name: true } });
  await dispatchAcross(tx, {
    companyId,
    storeId: t.storeId,
    transferId,
    fromWarehouseId: from.id,
    toWords: `${destStore?.name ?? 'متجر تاني'} — ${to.name}`,
    lines: t.lines.map((l) => ({ productId: l.productId, quantity: l.quantitySent })),
    // The units move at the owner's press: the ledger line is his.
    byId: input.approvedById,
  });
  const now = new Date();
  await tx.stockTransfer.update({
    where: { id: transferId },
    data: { status: 'SENT', approvedById: input.approvedById, approvedAt: now, sentAt: now },
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
  if (t.status !== 'SENT' && t.status !== 'AWAITING_APPROVAL') {
    throw new StockTransferRefused('ALREADY_RECEIVED', 'هالنقل انستلم، فما بينلغى. لترجّع البضاعة اعمل نقل معاكس.');
  }

  const from = await tx.warehouse.findFirst({ where: { id: t.fromWarehouseId, companyId }, select: { id: true, companyId: true, countryId: true, name: true } });
  if (!from) throw new StockTransferRefused('WAREHOUSE_NOT_FOUND');
  if (!(await input.mayUse({ id: from.id, companyId: from.companyId, countryId: from.countryId }))) {
    throw new StockTransferRefused('NOT_REACHED', 'ما إلك وصول على المخزن اللي طلع منه النقل.');
  }

  const cancelled = () =>
    tx.stockTransfer.update({
      where: { id: transferId },
      data: { status: 'CANCELLED', cancelledById: input.cancelledById, cancelledAt: new Date(), cancelReason: input.body.reason },
    });
  // 20/11 (W7b): a transfer to another country still waiting for the owner moved nothing — there is nothing to give back.
  if (t.status === 'AWAITING_APPROVAL') {
    await cancelled();
    return { transfer: await readTransfer(tx, companyId, storeId, transferId), replay: false };
  }
  /*
   * 20/11 (W7b): ACROSS STORES, the units left the source product as a draw-down: they come back into it as a NEW batch
   * in the source warehouse at the captured cost — cost per unit = costOut ÷ sent, so the batch is worth sent × that, the
   * value that left — with a TRANSFER_IN line carrying the transfer's id. Not a split: there is no twin on any road.
   */
  if (isAcross(t.kind)) {
    await lockProductsStock(tx, companyId, t.lines.map((l) => l.productId));
    for (const l of t.lines) {
      if (l.costOut === null || l.costOut === undefined) throw new StockTransferRefused('MOVED_MEANWHILE');
      await receiveStock(tx, {
        companyId,
        storeId: t.storeId,
        productId: l.productId,
        quantity: l.quantitySent,
        unitCost: l.costOut / l.quantitySent,
        warehouseId: from.id,
        mayUse: input.mayUse,
        note: 'رجوع نقل ملغى',
        createdById: input.cancelledById,
        movement: { type: 'TRANSFER_IN', referenceId: transferId, reason: `إلغاء نقل — رجعت على ${from.name}` },
      });
    }
    await cancelled();
    return { transfer: await readTransfer(tx, companyId, storeId, transferId), replay: false };
  }

  await lockProductsStock(tx, companyId, t.lines.map((l) => l.productId));
  await refuseIfCounting(tx, [from.id]);
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
  await cancelVariants(
    tx,
    { companyId, storeId, userId: input.cancelledById, referenceId: transferId },
    { fromWarehouseId: from.id, sent: new Map(t.lines.map((l) => [l.productId, l.variants ?? []])), reason: `إلغاء نقل — رجعت على ${from.name}` },
    fail
  );
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

  const approved = () =>
    tx.stockTransfer.update({
      where: { id: transferId },
      data: {
        differenceType: input.body.type,
        differenceReason: input.body.reason,
        differenceApprovedById: input.approvedById,
        differenceApprovedAt: new Date(),
      },
    });
  /*
   * 20/11 (W7b): ACROSS STORES the missing units left the source at the send (TRANSFER_OUT) and arrived nowhere: the
   * approval is a REPORT ONLY (the owner's decision 6) — no unit, no ledger line, no money moves, and nobody is charged.
   * Their value at the cost that left is `stock-transfer-cost.missingValue` of the line, for the report.
   */
  if (isAcross(t.kind)) {
    await approved();
    return { transfer: await readTransfer(tx, companyId, storeId, transferId), replay: false };
  }

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
  await differenceVariants(
    tx,
    { companyId, storeId, userId: input.approvedById, referenceId: transferId },
    { type: input.body.type, sent: new Map(t.lines.map((l) => [l.productId, l.variants ?? []])), reason: `فرق نقل (${words}): ${input.body.reason}` },
    fail
  );
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

/**
 * 20/11 (W7b): the lines as the audit log keeps them — quantities, combinations and the twin, never a cost figure (the
 * audit screen is read by people who may not see what things cost). An INTERNAL line keeps exactly what it kept.
 */
export function auditLines<L extends { productId: string; quantitySent: number; quantityReceived: number | null; toProductId?: string | null; variants?: unknown }>(
  lines: readonly L[]
) {
  return lines.map((l) => ({
    productId: l.productId,
    quantitySent: l.quantitySent,
    quantityReceived: l.quantityReceived,
    ...(l.variants !== undefined ? { variants: l.variants } : {}),
    ...(l.toProductId ? { toProductId: l.toProductId } : {}),
  }));
}

/* ───────────────────────────── the ledger while on the road ───────────────────────────── */

/** What the ledger says in place of a sent figure the reader may not see yet. */
export const HIDDEN_ON_ROAD_AR = 'العدد مخفي لحد ما ينستلم النقل';

/**
 * 20/11 (W3b review): THE LEDGER IS BLIND TOO. The send writes a `TRANSFER_OUT −n` line at once, and the movements door
 * answers every holder of `inventory.view` — the receiver included — so her count was blind on this tab and not on the
 * next. Of the given ledger lines, the transfers whose `TRANSFER_OUT` line this viewer may not read yet: still on the road
 * (`SENT`) and not sent by her. Received or cancelled, the line says its figure to everyone.
 *
 * No `TRANSFER_OUT` line in the page = no read at all (a store that never transferred answers as it did).
 */
export async function transfersBlindTo(
  tx: Tx,
  companyId: string,
  viewerId: string,
  lines: readonly { type: string; referenceId: string | null }[]
): Promise<Set<string>> {
  const ids = [...new Set(lines.filter((l) => l.type === 'TRANSFER_OUT' && l.referenceId).map((l) => l.referenceId as string))];
  if (ids.length === 0) return new Set();
  const open = await tx.stockTransfer.findMany({
    where: { id: { in: ids }, companyId, status: 'SENT', sentById: { not: viewerId } },
    select: { id: true },
  });
  return new Set(open.map((t) => t.id));
}

/* ───────────────────────────── what the list shows ───────────────────────────── */

/**
 * A transfer as the list answers it. WHILE IT IS ON THE ROAD the sent quantities are told only to the person who sent
 * it: the receiver types what she counted without being told what to expect (the count is blind, like the keeper's
 * count of W5). Once received, every line says sent, counted and the difference.
 */
export function shownTo<
  T extends {
    status: string;
    sentById: string;
    lines: {
      productId: string;
      quantitySent: number;
      quantityReceived: number | null;
      variants?: { variantId: string; quantitySent: number; quantityReceived: number | null }[];
      toProductId?: string | null;
      costOut?: number | null;
      landedCosts?: unknown;
      unitCostIn?: number | null;
      costRemainder?: number | null;
    }[];
  },
>(
  t: T,
  viewerId: string,
  /**
   * 20/11 (W7b): `seesCost` — the viewer may see what things cost (`cost-visibility.maySeeCost`); `owner` — the viewer
   * is the owner (`authorization.hasFullAccess`), who must read a request to another country to approve it.
   */
  opts: { seesCost?: boolean; owner?: boolean } = {}
) {
  /*
   * 20/11 (W7b): a request to another country still AWAITING the owner is blind too — to everyone but its sender and the
   * owner who approves it: the receiver must not learn the figure before the goods leave.
   */
  const blind =
    (t.status === 'SENT' && t.sentById !== viewerId) || (t.status === 'AWAITING_APPROVAL' && t.sentById !== viewerId && opts.owner !== true);
  const shown = <L extends { quantitySent: number; quantityReceived: number | null }>(l: L) => ({
    quantitySent: blind ? null : l.quantitySent,
    quantityReceived: l.quantityReceived,
    difference: l.quantityReceived === null ? null : l.quantitySent - l.quantityReceived,
  });
  /*
   * 20/11 (W7b): a line across stores names its twin, and — to a viewer who may see cost, and never while the count is
   * blind (the cost that left ÷ a known unit cost would tell the sent figure) — the cost it carries. Omitted otherwise,
   * not zeroed. An INTERNAL line answers exactly what it answered.
   */
  const across = (l: T['lines'][number]) =>
    l.toProductId
      ? {
          toProductId: l.toProductId,
          ...(opts.seesCost && !blind
            ? {
                costOut: l.costOut ?? null,
                landedCosts: storedLanded(l.landedCosts),
                unitCostIn: l.unitCostIn ?? null,
                costRemainder: l.costRemainder ?? null,
                // The shortfall's value at the cost that left — a report figure, posted nowhere (decision 6).
                ...(l.quantityReceived !== null && l.costOut != null && l.quantityReceived < l.quantitySent
                  ? { missingValue: missingValue(l.costOut, l.quantitySent, l.quantityReceived) }
                  : {}),
              }
            : {}),
        }
      : {};
  return {
    ...t,
    statusAr: STATUS_AR[t.status as StockTransferStatus] ?? t.status,
    blind,
    lines: t.lines.map((l) => ({
      productId: l.productId,
      ...shown(l),
      ...across(l),
      // 20/11 (W8b): the combinations, blind exactly as their line — WHICH were sent, never how many, until received.
      ...(l.variants && l.variants.length > 0 ? { variants: l.variants.map((v) => ({ variantId: v.variantId, ...shown(v) })) } : {}),
    })),
  };
}
