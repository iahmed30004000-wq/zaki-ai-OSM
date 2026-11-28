import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import type { db as prismaDb } from './db';
import { lockProductsStock } from './reservation';
import { drawDownStock, onHandTotal, receiveStock } from './receiving';
import { resolveUnitCost } from './unit-cost';
import { roundMinor } from './money';
import { lockWarehouseForStop, storeIsPlaced, type WarehouseRef } from './warehouse-intake';
import { expectedInWarehouse } from './warehouse-count';
import { withCourierWhere } from './warehouse-placement';
import { OPEN_COUNT_STATUSES } from './stock-count-freeze';
import {
  VARIANT_LINE_AR,
  VARIANT_LINE_STATUS,
  checkLineShapes,
  checkMembership,
  combosOf,
  namesVariants,
  variantCountsField,
  type Fail,
  type VariantLineRefusalCode,
} from './variant-lines';
import { VARIANT_MOVE, changeVariants, placeHolds, type PlaceMove, type PlaceRow } from './variant-stock';

type Tx = Prisma.TransactionClient | typeof prismaDb;

/**
 * THE COUNT AGAINST THE KEEPER (the warehouse plan, request W5a — the owner's decision 4, his «نفّذ» of 20/11).
 *
 * The count is of what is PHYSICALLY in the warehouse: the parcels that left with the courier (a waybill exists, not
 * delivered and not received back) are not on the keeper's shelf; the confirmed orders still on the shelf without a
 * waybill are. The expected figure is the quick count's own (`warehouse-count.expectedInWarehouse` — one formula, not a
 * second one): Σ remaining of the product's rows in the warehouse − the units of the store's orders that left THAT
 * warehouse with the courier.
 *
 *   open      a sheet for ONE warehouse of a PLACED store: all the store's products, or a chosen list. From now on the
 *             warehouse stands still (`stock-count-freeze.ts`): no receipt, no transfer in or out, no exit, no return
 *             receipt; deliveries go on. ONE open sheet per warehouse (a partial unique index in the migration).
 *   answer    the keeper writes what she counted, line by line (a product with combinations: each combination, the line
 *             is their sum). She may write a line again while the sheet is OPEN. She is never told a book figure: the
 *             doors answer a holder of `inventory.count` without `inventory.count_approve` with no expected figure at all
 *             (`countShown`) — and while the sheet is OPEN no expected figure exists yet anyway.
 *   submit    every line answered; the expected figure of each line (and of each combination) is FROZEN on the line,
 *             read in ONE snapshot (the door runs this transaction REPEATABLE READ — a delivery that commits half way
 *             cannot be seen by one read and not the other).
 *   approve   by a DIFFERENT person — not the one who opened, answered a line, or submitted (two hands). Each line's
 *             difference = counted − frozen expected is applied in THAT warehouse by the recount's own arithmetic:
 *               surplus    a new batch in the warehouse at the cost of the NEWEST batch that still holds units (that
 *                          warehouse's, else the store's — the recount's own question); none, or an uncosted one: the
 *                          approval is refused whole (a surplus of something never costed is a delivery nobody wrote)
 *               shortfall  drawn oldest first in that warehouse (`drawDownStock` with `warehouseId`, never a unit on the
 *                          road, never below zero); the warehouse must hold it — refused whole otherwise
 *             ONE ledger line per product, MANUAL_ADJUSTMENT, ±difference, in that warehouse, `referenceId` = the sheet.
 *             The line keeps `applied` and `valueAtCost` (what the difference is worth at the batches' cost, signed,
 *             rounded once to the store currency's minor unit). A combination's difference moves its pieces through
 *             the one writer of a combination's count (`variant-stock.changeVariants`, type COUNT, the sheet's id).
 *             The difference, not «set the shelf to the count»: a delivery between submit and approval moved the book
 *             and the units with the courier together, so the frozen difference is still the difference.
 *   void      nothing is applied; nothing changed. The opener may void her own sheet while it is OPEN; a holder of
 *             `inventory.count_approve` may void it OPEN or SUBMITTED.
 *
 * MONEY: an approved difference moves the stock value exactly as today's recount does (a surplus at the carried cost,
 * a shortfall at the cost of the batches it empties, oldest first). Nothing here reads or writes a wallet, an expense or
 * a profit (pinned by the test, which walks every file this module imports).
 *
 * KNOWN GAPS OF THE EXPECTED FIGURE (inherited, not fixed here — the expected figure is the quick count's):
 *   · an order whose waybill was printed outside a trolley has no `sourceWarehouseId`: its units are in some warehouse's
 *     rows and are subtracted from none, so the expected figure is too HIGH by them (a shortfall that is not real). The
 *     line carries `unsourcedWithCourier` — the store's units with the courier that name no warehouse — for the approver.
 *   · an add-on whose parcel was received back BEFORE the 27/11 fix kept its reservation (the receipt released the lines
 *     only): such units still count as «with the courier», so the expected figure is too LOW by them (a surplus that is
 *     not real). Receipts since then release them; the old ones are not backfilled.
 *
 * LOCKS, in one order: the sheet row FOR UPDATE → the products' stock lock (sorted) → the warehouse row (FOR UPDATE to
 * open; FOR SHARE inside a receipt) → the batch rows → the combination rows.
 */

export type CountStatus = 'OPEN' | 'SUBMITTED' | 'APPROVED' | 'VOIDED';

export const COUNT_STATUS_AR: Record<CountStatus, string> = {
  OPEN: 'عم ينعدّ',
  SUBMITTED: 'مستني اعتماد',
  APPROVED: 'معتمد',
  VOIDED: 'ملغى',
};

export type StockCountRefusalCode =
  | 'INVALID'
  | 'PRODUCT_TWICE'
  | 'STORE_NOT_PLACED'
  | 'WAREHOUSE_NOT_FOUND'
  | 'WAREHOUSE_OTHER_COUNTRY'
  | 'WAREHOUSE_STOPPED'
  | 'NOT_REACHED'
  | 'PRODUCT_NOT_FOUND'
  | 'NO_PRODUCTS'
  | 'COUNT_ALREADY_OPEN'
  | 'NOT_FOUND'
  | 'NOT_ON_SHEET'
  | 'NOT_OPEN'
  | 'INCOMPLETE'
  | 'NOT_SUBMITTED'
  | 'COUNTER_CANNOT_APPROVE'
  | 'ALREADY_APPROVED'
  | 'ALREADY_VOIDED'
  | 'VOID_NOT_YOURS'
  | 'UNCOSTED_SURPLUS'
  | 'NOT_ON_SHELF'
  | 'MOVED_MEANWHILE'
  | VariantLineRefusalCode;

const STATUS_OF: Record<StockCountRefusalCode, number> = {
  ...VARIANT_LINE_STATUS,
  INVALID: 400,
  PRODUCT_TWICE: 400,
  STORE_NOT_PLACED: 409,
  WAREHOUSE_NOT_FOUND: 404,
  WAREHOUSE_OTHER_COUNTRY: 400,
  WAREHOUSE_STOPPED: 409,
  NOT_REACHED: 403,
  PRODUCT_NOT_FOUND: 404,
  NO_PRODUCTS: 400,
  COUNT_ALREADY_OPEN: 409,
  NOT_FOUND: 404,
  NOT_ON_SHEET: 400,
  NOT_OPEN: 409,
  INCOMPLETE: 409,
  NOT_SUBMITTED: 409,
  COUNTER_CANNOT_APPROVE: 403,
  ALREADY_APPROVED: 409,
  ALREADY_VOIDED: 409,
  VOID_NOT_YOURS: 403,
  UNCOSTED_SURPLUS: 409,
  NOT_ON_SHELF: 409,
  MOVED_MEANWHILE: 409,
};

const AR: Record<StockCountRefusalCode, string> = {
  ...VARIANT_LINE_AR,
  INVALID: 'البيانات ناقصة.',
  PRODUCT_TWICE: 'نفس المنتج مكتوب بسطرين. اجمعهم بسطر واحد.',
  STORE_NOT_PLACED: 'هالمتجر لسا ما توزّع على المخازن. الجرد على الأمين بيصير بعد توزيع الرصيد على المخازن.',
  WAREHOUSE_NOT_FOUND: 'المخزن مش موجود. حدّث الصفحة واختار من جديد.',
  WAREHOUSE_OTHER_COUNTRY: 'هالمخزن مش ببلد هالمتجر، وما بيشيل بضاعته.',
  WAREHOUSE_STOPPED: 'هالمخزن موقوف. ما بينفتح عليه جرد.',
  NOT_REACHED: 'ما إلك وصول على هالمخزن.',
  PRODUCT_NOT_FOUND: 'في منتج مش موجود بهالمتجر. حدّث الصفحة.',
  NO_PRODUCTS: 'ما في منتجات بهالمتجر تنعدّ.',
  COUNT_ALREADY_OPEN: 'في ورقة جرد مفتوحة على هالمخزن من قبل. كمّلها أو خلّيها تنعتمد أو تنلغى أول.',
  NOT_FOUND: 'ورقة الجرد مش موجودة. حدّث الصفحة.',
  NOT_ON_SHEET: 'في منتج مش على ورقة الجرد هاي.',
  NOT_OPEN: 'ورقة الجرد انسلّمت أو انسكّرت، وما بينكتب عليها عدّ.',
  INCOMPLETE: 'لسا في منتجات ما انعدّت. اكتب العدد لكل سطر (ولو صفر) وبعدين سلّم.',
  NOT_SUBMITTED: 'ورقة الجرد لسا ما انسلّمت. لازم تنسلّم قبل الاعتماد.',
  COUNTER_CANNOT_APPROVE: 'إنت فتحت أو عدّيت أو سلّمت هالجرد، فما بتعتمده. لازم حدا تاني.',
  ALREADY_APPROVED: 'هالجرد انعتمد من قبل. حدّث الصفحة.',
  ALREADY_VOIDED: 'هالجرد انلغى من قبل. حدّث الصفحة.',
  VOID_NOT_YOURS: 'بتلغي ورقة جرد إنت فتحتها وهي لسا عم تنعدّ بس. غير هيك بدّها اللي بيعتمد الجرد.',
  UNCOSTED_SURPLUS: 'في منتج زاد بالجرد وما إله كلفة سابقة تنبنى عليها. استلم الزيادة من «استلام بضاعة جاهزة» بكلفتها، وبعدين اعمل جرد جديد.',
  NOT_ON_SHELF: 'المخزن ما فيه هالكمية هلق لينخصم منها النقص. ألغي الجرد واعمل جرد جديد.',
  MOVED_MEANWHILE: 'البضاعة تحرّكت بنفس اللحظة من باب تاني. جرّب كمان مرة.',
};

export class StockCountRefused extends Error {
  readonly status: number;
  constructor(
    readonly code: StockCountRefusalCode,
    readonly errorAr: string = AR[code],
    readonly extra: Record<string, unknown> = {}
  ) {
    super(errorAr);
    this.name = 'StockCountRefused';
    this.status = STATUS_OF[code];
  }
}

/** The JSON a door answers with: an Arabic sentence, a stable code, and whatever the refusal carries. */
export function countRefusalBody(e: StockCountRefused) {
  return { error: e.errorAr, errorAr: e.errorAr, code: e.code, ...e.extra };
}

/** How `variant-lines.ts` refuses inside a count: as the count refuses. */
const fail: Fail = (code, errorAr, extra) => {
  throw new StockCountRefused(code, errorAr ?? AR[code], extra ?? {});
};

/* ───────────────────────────── the bodies (every message Arabic) ───────────────────────────── */

const idField = (ar: string) => z.string({ message: ar }).min(1, ar).max(64, ar);

export const openSchema = z.object(
  {
    warehouseId: idField('اختار المخزن'),
    /** Absent: every product of the store. Given: only these. */
    productIds: z.array(idField('اختار المنتج'), { message: 'المنتجات لازم تكون قائمة' }).min(1, 'اختار منتج واحد على الأقل').max(2000, 'كتير منتجات بورقة وحدة. قسّمها.').optional(),
    note: z.string({ message: 'الملاحظة لازم تكون نص' }).trim().max(500, 'الملاحظة طويلة كتير').optional().nullable(),
  },
  { message: 'البيانات ناقصة' }
);

export const answersSchema = z.object(
  {
    lines: z
      .array(
        z.object(
          {
            productId: idField('اختار المنتج'),
            counted: z.number({ message: 'العدد لازم يكون رقم' }).int('العدد لازم يكون عدد صحيح').min(0, 'العدد ما بيكون أقل من صفر').max(1_000_000, 'العدد كبير كتير'),
            /** A product with combinations: each combination's count; their sum is `counted`. */
            variants: variantCountsField.optional(),
          },
          { message: 'سطر العدّ مش مفهوم' }
        ),
        { message: 'اكتب عدد منتج واحد على الأقل' }
      )
      .min(1, 'اكتب عدد منتج واحد على الأقل')
      .max(2000, 'كتير سطور بمرة وحدة. قسّمها.'),
  },
  { message: 'البيانات ناقصة' }
);

/** Submitting and approving ask nothing more than the press. */
export const pressSchema = z.object({}, { message: 'البيانات مش مفهومة' }).nullable();

export const voidSchema = z.object(
  { reason: z.string({ message: 'اكتب سبب الإلغاء' }).trim().min(3, 'اكتب سبب الإلغاء').max(500, 'سبب الإلغاء طويل كتير') },
  { message: 'اكتب سبب الإلغاء' }
);

/* ───────────────────────────── reads ───────────────────────────── */

const COUNT_SELECT = {
  id: true,
  companyId: true,
  storeId: true,
  warehouseId: true,
  status: true,
  scope: true,
  note: true,
  openedById: true,
  openedAt: true,
  submittedById: true,
  submittedAt: true,
  decidedById: true,
  decidedAt: true,
  voidReason: true,
  writerIds: true,
  lines: {
    select: {
      productId: true,
      counted: true,
      countedById: true,
      countedAt: true,
      book: true,
      withCourier: true,
      expected: true,
      unsourcedWithCourier: true,
      applied: true,
      valueAtCost: true,
    },
    orderBy: { productId: 'asc' as const },
  },
} as const;

export interface CountVariantRow {
  variantId: string;
  counted: number;
  expected: number | null;
}

export async function readCount(tx: Tx, companyId: string, storeId: string, id: string) {
  const c = await tx.stockCount.findFirst({ where: { id, companyId, storeId }, select: COUNT_SELECT });
  if (!c) throw new StockCountRefused('NOT_FOUND');
  const rows = await tx.stockCountLineVariant.findMany({
    where: { countId: id },
    orderBy: { variantId: 'asc' },
    select: { productId: true, variantId: true, counted: true, expected: true },
  });
  const byProduct = new Map<string, CountVariantRow[]>();
  for (const r of rows) {
    const list = byProduct.get(r.productId) ?? [];
    list.push({ variantId: r.variantId, counted: r.counted, expected: r.expected });
    byProduct.set(r.productId, list);
  }
  // `variants` is ADDED only to a line that has them.
  const lines = c.lines.map((l) => (byProduct.has(l.productId) ? { ...l, variants: byProduct.get(l.productId)! } : l));
  return { ...c, lines };
}

export type StockCountRow = Awaited<ReturnType<typeof readCount>>;
type CountLine = StockCountRow['lines'][number] & { variants?: CountVariantRow[] };

/** The sheet row FOR UPDATE: two presses on one sheet go one after the other. */
async function lockCount(tx: Tx, id: string): Promise<void> {
  await tx.$executeRaw`SELECT 1 FROM "stock_counts" WHERE "id" = ${id} FOR UPDATE`;
}

/**
 * Everybody who had a hand in the count: the opener, the one who submitted, and EVERY person who ever wrote a line —
 * `writerIds`, kept on the sheet and never shortened, because a later answer overwrites a line's `countedById` and a
 * person whose count was written over still counted (review of #445: without it she could approve).
 */
export function countersOf(c: Pick<StockCountRow, 'openedById' | 'submittedById' | 'lines'> & { writerIds?: string[] | null }): Set<string> {
  const out = new Set<string>([c.openedById, ...(c.writerIds ?? [])]);
  if (c.submittedById) out.add(c.submittedById);
  for (const l of c.lines) if (l.countedById) out.add(l.countedById);
  return out;
}

async function reach(tx: Tx, companyId: string, warehouseId: string, mayUse: (w: WarehouseRef) => Promise<boolean>) {
  const wh = await tx.warehouse.findFirst({ where: { id: warehouseId, companyId }, select: { id: true, companyId: true, countryId: true, name: true } });
  if (!wh) throw new StockCountRefused('WAREHOUSE_NOT_FOUND');
  if (!(await mayUse({ id: wh.id, companyId: wh.companyId, countryId: wh.countryId }))) throw new StockCountRefused('NOT_REACHED');
  return wh;
}

/* ───────────────────────────── open ───────────────────────────── */

export interface OpenInput {
  companyId: string;
  storeId: string;
  openedById: string;
  body: z.infer<typeof openSchema>;
  mayUse: (w: WarehouseRef) => Promise<boolean>;
}

export async function openCount(tx: Tx, input: OpenInput): Promise<StockCountRow> {
  const { companyId, storeId, body } = input;
  if (body.productIds && new Set(body.productIds).size !== body.productIds.length) throw new StockCountRefused('PRODUCT_TWICE');

  // The warehouse row FOR UPDATE: every receipt, transfer and exit reads it FOR SHARE before it asks «under count?», so a
  // press already under way finishes before the sheet exists, and one that comes after sees it.
  await lockWarehouseForStop(tx, body.warehouseId);
  const wh = await tx.warehouse.findFirst({
    where: { id: body.warehouseId, companyId },
    select: { id: true, companyId: true, countryId: true, isActive: true, name: true },
  });
  if (!wh) throw new StockCountRefused('WAREHOUSE_NOT_FOUND');
  const store = await tx.store.findFirst({ where: { id: storeId, companyId }, select: { countryId: true } });
  if (!store) throw new StockCountRefused('NOT_FOUND');
  if (wh.countryId !== store.countryId) throw new StockCountRefused('WAREHOUSE_OTHER_COUNTRY');
  if (!(await storeIsPlaced(storeId, tx))) throw new StockCountRefused('STORE_NOT_PLACED');
  if (!wh.isActive) throw new StockCountRefused('WAREHOUSE_STOPPED');
  if (!(await input.mayUse({ id: wh.id, companyId: wh.companyId, countryId: wh.countryId }))) throw new StockCountRefused('NOT_REACHED');

  const already = await tx.stockCount.findFirst({
    where: { warehouseId: wh.id, status: { in: [...OPEN_COUNT_STATUSES] } },
    select: { id: true },
  });
  if (already) throw new StockCountRefused('COUNT_ALREADY_OPEN', undefined, { countId: already.id });

  const products = await tx.product.findMany({
    where: { companyId, storeId, ...(body.productIds ? { id: { in: body.productIds } } : {}) },
    orderBy: { id: 'asc' },
    select: { id: true },
  });
  if (body.productIds && products.length !== body.productIds.length) throw new StockCountRefused('PRODUCT_NOT_FOUND');
  if (products.length === 0) throw new StockCountRefused('NO_PRODUCTS');

  const created = await tx.stockCount.create({
    data: {
      companyId,
      storeId,
      warehouseId: wh.id,
      status: 'OPEN',
      scope: body.productIds ? 'CHOSEN' : 'ALL',
      note: body.note?.trim() || null,
      openedById: input.openedById,
      lines: { create: products.map((p) => ({ productId: p.id })) },
    },
    select: { id: true },
  });
  return readCount(tx, companyId, storeId, created.id);
}

/* ───────────────────────────── answer ───────────────────────────── */

export interface AnswerInput {
  companyId: string;
  storeId: string;
  countId: string;
  countedById: string;
  body: z.infer<typeof answersSchema>;
  mayUse: (w: WarehouseRef) => Promise<boolean>;
}

export async function recordAnswers(tx: Tx, input: AnswerInput): Promise<StockCountRow> {
  const { companyId, storeId, countId, body } = input;
  const seen = new Set<string>();
  for (const l of body.lines) {
    if (seen.has(l.productId)) throw new StockCountRefused('PRODUCT_TWICE');
    seen.add(l.productId);
  }
  const asLines = body.lines.map((l) => ({ productId: l.productId, quantity: l.counted, variants: l.variants }));
  checkLineShapes(asLines, fail);

  await lockCount(tx, countId);
  const c = await readCount(tx, companyId, storeId, countId);
  if (c.status !== 'OPEN') throw new StockCountRefused('NOT_OPEN');
  await reach(tx, companyId, c.warehouseId, input.mayUse);
  const onSheet = new Set(c.lines.map((l) => l.productId));
  const off = body.lines.find((l) => !onSheet.has(l.productId));
  if (off) throw new StockCountRefused('NOT_ON_SHEET', undefined, { productId: off.productId });

  // A product with active combinations is counted per combination; one without any is counted as a whole.
  const productIds = [...seen];
  const combos = await combosOf(tx, companyId, productIds);
  const products = await tx.product.findMany({ where: { id: { in: productIds }, companyId }, select: { id: true, name: true } });
  checkMembership(asLines, combos, new Map(products.map((p) => [p.id, p.name])), fail, { required: true });

  const now = new Date();
  // Every writer stays on the sheet for good (the two-hands rule reads it), even when her answer is written over later.
  if (!(c.writerIds ?? []).includes(input.countedById)) {
    await tx.stockCount.update({ where: { id: countId }, data: { writerIds: [...(c.writerIds ?? []), input.countedById] } });
  }
  for (const l of body.lines) {
    await tx.stockCountLine.updateMany({
      where: { countId, productId: l.productId },
      data: { counted: l.counted, countedById: input.countedById, countedAt: now },
    });
    // The line's combinations are written again whole: an answer replaces the one before it.
    const line = await tx.stockCountLine.findFirst({ where: { countId, productId: l.productId }, select: { id: true } });
    if (!line) throw new StockCountRefused('NOT_ON_SHEET', undefined, { productId: l.productId });
    await tx.stockCountLineVariant.deleteMany({ where: { lineId: line.id } });
    if (namesVariants(l)) {
      for (const v of l.variants!) {
        await tx.stockCountLineVariant.create({
          data: { lineId: line.id, countId, productId: l.productId, variantId: v.variantId, counted: v.quantity },
        });
      }
    }
  }
  return readCount(tx, companyId, storeId, countId);
}

/* ───────────────────────────── submit (the freeze) ───────────────────────────── */

export interface PressInput {
  companyId: string;
  storeId: string;
  countId: string;
  userId: string;
  mayUse: (w: WarehouseRef) => Promise<boolean>;
}

/**
 * Units of this store's orders with the courier that name NO warehouse — a waybill printed outside a trolley. Their units
 * are in some warehouse's rows and the expected figure subtracts them from none (shown to the approver; never applied).
 */
async function unsourcedWithCourier(tx: Tx, p: { companyId: string; storeId: string; productId: string }): Promise<number> {
  const left = withCourierWhere({ companyId: p.companyId, storeId: p.storeId, productIds: [p.productId] });
  const where = { ...left, order: { ...left.order, sourceWarehouseId: null } };
  const [lines, addOns] = await Promise.all([
    tx.orderItem.aggregate({ where, _sum: { reservedQty: true } }),
    tx.orderAddOn.aggregate({ where, _sum: { reservedQty: true } }),
  ]);
  return (lines._sum?.reservedQty ?? 0) + (addOns._sum?.reservedQty ?? 0);
}

/**
 * A COMBINATION'S EXPECTED PIECES in the warehouse — the product's formula, per combination: its pieces in that
 * warehouse's place (never a road) − the pieces of order lines that left THAT warehouse with the courier (the same
 * «still held and has left» rule, `withCourierWhere`, with the order's `sourceWarehouseId`).
 */
async function expectedPieces(
  tx: Tx,
  p: { companyId: string; storeId: string; productId: string; warehouseId: string; variantIds: readonly string[] }
): Promise<Map<string, number>> {
  const out = new Map<string, number>(p.variantIds.map((id) => [id, 0]));
  if (p.variantIds.length === 0) return out;
  const shelf = await tx.productVariantStock.findMany({
    where: { variantId: { in: [...p.variantIds] }, warehouseId: p.warehouseId },
    select: { variantId: true, onHand: true },
  });
  for (const r of shelf) out.set(r.variantId, (out.get(r.variantId) ?? 0) + r.onHand);
  const left = withCourierWhere({ companyId: p.companyId, storeId: p.storeId, productIds: [p.productId] });
  const items = await tx.orderItem.findMany({
    where: { ...left, order: { ...left.order, sourceWarehouseId: p.warehouseId } },
    select: { id: true },
  });
  if (items.length > 0) {
    const pieces = await tx.orderItemVariant.findMany({
      where: { orderItemId: { in: items.map((i) => i.id) }, variantId: { in: [...p.variantIds] } },
      select: { variantId: true, quantity: true, freeQuantity: true },
    });
    for (const r of pieces) if (r.variantId) out.set(r.variantId, (out.get(r.variantId) ?? 0) - r.quantity - r.freeQuantity);
  }
  return out;
}

export async function submitCount(tx: Tx, input: PressInput): Promise<{ count: StockCountRow; replay: boolean }> {
  const { companyId, storeId, countId } = input;
  await lockCount(tx, countId);
  const c = await readCount(tx, companyId, storeId, countId);
  if (c.status === 'SUBMITTED' && c.submittedById === input.userId) return { count: c, replay: true };
  if (c.status !== 'OPEN') throw new StockCountRefused('NOT_OPEN');
  await reach(tx, companyId, c.warehouseId, input.mayUse);
  const missing = c.lines.filter((l) => l.counted === null || l.counted === undefined);
  if (missing.length > 0) throw new StockCountRefused('INCOMPLETE', undefined, { missing: missing.length });

  await lockProductsStock(tx, companyId, c.lines.map((l) => l.productId));
  for (const l of c.lines as CountLine[]) {
    // THE ONE FORMULA (the quick count's): the warehouse's rows − the units that left it with the courier.
    const facts = await expectedInWarehouse(tx, { companyId, storeId, productId: l.productId, warehouseId: c.warehouseId });
    const unsourced = await unsourcedWithCourier(tx, { companyId, storeId, productId: l.productId });
    await tx.stockCountLine.updateMany({
      where: { countId, productId: l.productId },
      data: { book: facts.book, withCourier: facts.withCourier, expected: facts.expected, unsourcedWithCourier: unsourced },
    });
    if (l.variants && l.variants.length > 0) {
      const exp = await expectedPieces(tx, { companyId, storeId, productId: l.productId, warehouseId: c.warehouseId, variantIds: l.variants.map((v) => v.variantId) });
      for (const v of l.variants) {
        await tx.stockCountLineVariant.updateMany({ where: { countId, productId: l.productId, variantId: v.variantId }, data: { expected: exp.get(v.variantId) ?? 0 } });
      }
    }
  }
  await tx.stockCount.update({ where: { id: countId }, data: { status: 'SUBMITTED', submittedById: input.userId, submittedAt: new Date() } });
  return { count: await readCount(tx, companyId, storeId, countId), replay: false };
}

/* ───────────────────────────── approve ───────────────────────────── */

/**
 * THE COST A SURPLUS ENTERS AT — the recount's own question (`POST /api/inventory`, action «recount»): the newest batch
 * that still holds units, asked first in the counted warehouse (never a row on the road), then in the whole store.
 * `null` when there is none or it was never costed: the caller refuses.
 */
async function surplusCost(tx: Tx, p: { companyId: string; storeId: string; productId: string; warehouseId: string }): Promise<number | null> {
  const base = { companyId: p.companyId, storeId: p.storeId, productId: p.productId, quantityRemaining: { gt: 0 } };
  const here = await tx.productionBatch.findFirst({
    where: { ...base, warehouseId: p.warehouseId, inTransitTransferId: null },
    orderBy: { productionDate: 'desc' },
    select: { costPerUnit: true },
  });
  const row = here ?? (await tx.productionBatch.findFirst({ where: base, orderBy: { productionDate: 'desc' }, select: { costPerUnit: true } }));
  const carried = resolveUnitCost({ given: undefined, previous: row?.costPerUnit ?? null });
  return carried.ok ? carried.unitCost : null;
}

/** A combination's difference as moves of its places: up takes «بلا مكان» first (as a combination's count does); down must be there. */
function differencePlan(places: readonly PlaceRow[], warehouseId: string, d: number, variantId: string): PlaceMove[] {
  if (d === 0) return [];
  if (d < 0) {
    if (placeHolds(places, { warehouseId }) < -d) fail('VARIANT_NOT_ON_SHELF', undefined, { variantId });
    return [{ warehouseId, delta: d }];
  }
  const unplaced = Math.max(0, placeHolds(places, { warehouseId: null }));
  const fromUnplaced = Math.min(d, unplaced);
  return fromUnplaced > 0 ? [{ warehouseId, delta: d }, { warehouseId: null, delta: -fromUnplaced }] : [{ warehouseId, delta: d }];
}

export async function approveCount(tx: Tx, input: PressInput): Promise<{ count: StockCountRow; replay: boolean }> {
  const { companyId, storeId, countId } = input;
  await lockCount(tx, countId);
  const c = await readCount(tx, companyId, storeId, countId);
  // Two hands, before anything else — a replay included.
  if (countersOf(c).has(input.userId)) throw new StockCountRefused('COUNTER_CANNOT_APPROVE');
  if (c.status === 'APPROVED') {
    if (c.decidedById === input.userId) return { count: c, replay: true };
    throw new StockCountRefused('ALREADY_APPROVED');
  }
  if (c.status === 'VOIDED') throw new StockCountRefused('ALREADY_VOIDED');
  if (c.status !== 'SUBMITTED') throw new StockCountRefused('NOT_SUBMITTED');
  const wh = await reach(tx, companyId, c.warehouseId, input.mayUse);

  /*
   * The sheet is closed FIRST, in this same transaction: the warehouse is then no longer «under count» for the receipt
   * below (`receiveStock` asks the intake, which refuses a warehouse under count). Every other transaction still sees the
   * sheet SUBMITTED until this one commits — and if anything below refuses, the whole approval rolls back.
   */
  await tx.stockCount.update({ where: { id: countId }, data: { status: 'APPROVED', decidedById: input.userId, decidedAt: new Date() } });

  await lockProductsStock(tx, companyId, c.lines.map((l) => l.productId));
  const store = await tx.store.findFirst({ where: { id: storeId, companyId }, select: { country: { select: { minorUnit: true } } } });
  const minorUnit = store?.country?.minorUnit ?? 2;
  const names = new Map(
    (await tx.product.findMany({ where: { id: { in: c.lines.map((l) => l.productId) }, companyId }, select: { id: true, name: true } })).map((p) => [p.id, p.name])
  );

  for (const l of c.lines as CountLine[]) {
    if (l.counted === null || l.expected === null) throw new StockCountRefused('NOT_SUBMITTED');
    const d = l.counted - l.expected;
    const reason = `جرد ${wh.name}: انعدّ ${l.counted} والمفروض ${l.expected}`;
    let value = 0;
    if (d > 0) {
      const unitCost = await surplusCost(tx, { companyId, storeId, productId: l.productId, warehouseId: wh.id });
      if (unitCost === null) {
        throw new StockCountRefused('UNCOSTED_SURPLUS', `«${names.get(l.productId) ?? ''}» زاد ${d} بالجرد وما إله كلفة سابقة تنبنى عليها. ${AR.UNCOSTED_SURPLUS}`, { productId: l.productId });
      }
      await receiveStock(tx, {
        companyId,
        storeId,
        productId: l.productId,
        quantity: d,
        unitCost,
        batchNumber: `ADJ-${Date.now().toString(36).toUpperCase()}-${l.productId.slice(-4)}`,
        note: reason,
        createdById: input.userId,
        warehouseId: wh.id,
        mayUse: input.mayUse,
        movement: { type: 'MANUAL_ADJUSTMENT', referenceId: countId, reason },
      });
      value = roundMinor(d * unitCost, minorUnit);
    } else if (d < 0) {
      const there = await tx.productionBatch.aggregate({
        where: { companyId, storeId, productId: l.productId, warehouseId: wh.id, inTransitTransferId: null, quantityRemaining: { gt: 0 } },
        _sum: { quantityRemaining: true },
      });
      if ((there._sum?.quantityRemaining ?? 0) < -d) {
        throw new StockCountRefused('NOT_ON_SHELF', undefined, { productId: l.productId, onShelf: there._sum?.quantityRemaining ?? 0, short: -d });
      }
      let drawn: { taken: number; cost: number };
      try {
        drawn = await drawDownStock(tx, { companyId, storeId, warehouseId: wh.id, productId: l.productId, quantity: -d, allowNegative: false });
      } catch (err) {
        if (err instanceof Error && !('code' in err)) throw new StockCountRefused('MOVED_MEANWHILE');
        throw err;
      }
      if (drawn.taken !== -d) throw new StockCountRefused('MOVED_MEANWHILE');
      await tx.inventoryMovement.create({
        data: {
          companyId,
          storeId,
          warehouseId: wh.id,
          productId: l.productId,
          batchId: null,
          type: 'MANUAL_ADJUSTMENT',
          quantity: d,
          balanceAfter: await onHandTotal(tx, companyId, l.productId),
          referenceId: countId,
          reason,
          createdById: input.userId,
        },
      });
      value = -roundMinor(drawn.cost, minorUnit);
    }
    await tx.stockCountLine.updateMany({ where: { countId, productId: l.productId }, data: { applied: d, valueAtCost: value } });

    // The combinations: each its own difference, through the one writer of a combination's count.
    const changes = (l.variants ?? [])
      .filter((v) => v.expected !== null && v.counted - (v.expected ?? 0) !== 0)
      .map((v) => {
        const dv = v.counted - (v.expected ?? 0);
        return {
          variantId: v.variantId,
          type: VARIANT_MOVE.COUNT,
          reason: `جرد ${wh.name}: انعدّ ${v.counted} والمفروض ${v.expected}`,
          plan: (places: readonly PlaceRow[]) => differencePlan(places, wh.id, dv, v.variantId),
        };
      });
    await changeVariants(tx, { companyId, storeId, userId: input.userId, referenceId: countId }, changes);
  }
  return { count: await readCount(tx, companyId, storeId, countId), replay: false };
}

/* ───────────────────────────── void ───────────────────────────── */

export async function voidCount(
  tx: Tx,
  input: PressInput & { body: z.infer<typeof voidSchema>; mayDecide: boolean }
): Promise<{ count: StockCountRow; replay: boolean }> {
  const { companyId, storeId, countId } = input;
  await lockCount(tx, countId);
  const c = await readCount(tx, companyId, storeId, countId);
  if (c.status === 'VOIDED') {
    if (c.decidedById === input.userId) return { count: c, replay: true };
    throw new StockCountRefused('ALREADY_VOIDED');
  }
  if (c.status === 'APPROVED') throw new StockCountRefused('ALREADY_APPROVED');
  // The approver's key voids an open or a submitted sheet; without it, only the opener, and only while it is counted.
  if (!input.mayDecide && !(c.openedById === input.userId && c.status === 'OPEN')) throw new StockCountRefused('VOID_NOT_YOURS');
  await reach(tx, companyId, c.warehouseId, input.mayUse);
  await tx.stockCount.update({
    where: { id: countId },
    data: { status: 'VOIDED', decidedById: input.userId, decidedAt: new Date(), voidReason: input.body.reason },
  });
  return { count: await readCount(tx, companyId, storeId, countId), replay: false };
}

/* ───────────────────────────── what a door shows ───────────────────────────── */

/** The fields of a line that say, or let one work out, what the book holds. */
const BOOK_FIELDS = ['book', 'withCourier', 'expected', 'unsourcedWithCourier', 'applied', 'valueAtCost', 'difference'] as const;

/**
 * 21/11 (W5b): THE DIFFERENCE of a line, said by the server so the approval screen computes nothing: counted − the frozen
 * expected, once both exist (a submitted or an approved sheet); `null` before. Only ever added for a person who sees the
 * expected figure — the difference gives the expected back.
 */
const differenceOf = (counted: unknown, expected: unknown): number | null =>
  typeof counted === 'number' && typeof expected === 'number' ? counted - expected : null;

/**
 * A SHEET AS A DOOR ANSWERS IT.
 *
 *   seesExpected  false for a holder of `inventory.count` without `inventory.count_approve`: every figure that says what
 *                 the book holds is LEFT OUT — not zeroed, not nulled — on every line and every combination: the expected
 *                 figure, the book, the units with the courier, the applied difference (counted − expected gives the
 *                 expected back) and its value. Only what she counted, and the words for the status, reach her.
 *   seesCost      the value at cost only for a holder of the cost key (`cost-visibility.maySeeCost`).
 */
export function countShown<T extends { status: string; lines: (Record<string, unknown> & { variants?: CountVariantRow[] })[] }>(
  c: T,
  opts: { seesExpected: boolean; seesCost: boolean }
) {
  const lines = c.lines.map((l) => {
    const out: Record<string, unknown> = { ...l };
    if (!opts.seesExpected) for (const k of BOOK_FIELDS) delete out[k];
    else {
      out.difference = differenceOf(l.counted, l.expected);
      if (!opts.seesCost) delete out.valueAtCost;
    }
    if (l.variants) {
      out.variants = l.variants.map((v) =>
        opts.seesExpected ? { ...v, difference: differenceOf(v.counted, v.expected) } : { variantId: v.variantId, counted: v.counted }
      );
    }
    return out;
  });
  return { ...c, statusAr: COUNT_STATUS_AR[c.status as CountStatus] ?? c.status, lines };
}
