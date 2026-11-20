import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import type { db as prismaDb } from './db';
import { holdingWhere } from './reservation';
import { PENDING_EXIT } from './stock-exit-reasons';
import { VARIANT_MOVE, changeVariants, placeHolds, type PlaceMove, type VariantChange, type VariantMoveType } from './variant-stock';

type Tx = Prisma.TransactionClient | typeof prismaDb;

/**
 * COMBINATIONS IN THE STOCK DOCUMENTS — the warehouse plan, request W8b.
 *
 * A product with combinations (size/colour — `product-variants.ts`) is moved by the stock documents per combination too:
 * a transfer line and an exit line of such a product carry its combinations (`stock_transfer_line_variants`,
 * `stock_exit_line_variants`), and the opening placement may say which combinations each warehouse holds.
 *
 *   THE SUM RULE     the product line keeps its quantity; it is the SUM of its combinations' quantities — refused
 *                    otherwise. A product WITH active combinations must name them on a transfer or an exit line; a
 *                    product without any may not. The placement may name them (optional: a product placed without its
 *                    combinations leaves them «بلا مكان», as W8a does, until a keeper counts them).
 *   ONE WRITER       every piece that moves moves through `variant-stock.changeVariants` → `writePlaces`, the one writer
 *                    of `ProductVariant.onHand` and of the combination's ledger. A move between two places of the store
 *                    (warehouse → road → warehouse) leaves the total where it was; only an approved exit and an approved
 *                    transfer shortfall lower it, by exactly the pieces that left — as the product's batches do.
 *   THE ROAD         pieces of a sent transfer sit on the transfer's road (a `product_variant_stock` row with no warehouse
 *                    and `inTransitTransferId` set), as the batch twins on the road do.
 *   FREE PIECES      of a combination in a warehouse = its pieces there − the pieces of open orders sourced from that
 *                    warehouse (`Order.sourceWarehouseId`, the reservation's own «still holding» rule) − the pieces held
 *                    by pending exits from it. The product line is checked by `stock-transfers.freeStockOf` as before.
 *
 * A PRODUCT WITHOUT COMBINATIONS IS UNTOUCHED: every helper here returns at once when no line names a combination and
 * no product has one, and nothing is read or written for it (the differential tests against main pin it).
 *
 * LOCKS: the combination rows are taken LAST, after the product's stock lock and the batch rows, all at once and sorted
 * (`changeVariants`) — the order the delivery keeps (batch rows, then combination rows).
 *
 * NO MONEY: no price, no cost, no wallet, no expense, no profit. The cost stays the product's batches'.
 */

/* ───────────────────────────── refusals ───────────────────────────── */

export type VariantLineRefusalCode =
  | 'VARIANTS_REQUIRED'
  | 'VARIANTS_NOT_ALLOWED'
  | 'VARIANT_NOT_FOUND'
  | 'VARIANT_TWICE'
  | 'VARIANTS_SUM'
  | 'VARIANTS_NOT_ENOUGH_FREE'
  | 'VARIANT_NOT_ON_SHELF'
  | 'VARIANT_COUNTS_INVALID'
  | 'VARIANT_COUNT_OVER_SENT'
  | 'VARIANTS_OVER_COUNT'
  | 'VARIANT_MOVED_MEANWHILE';

export const VARIANT_LINE_STATUS: Record<VariantLineRefusalCode, number> = {
  VARIANTS_REQUIRED: 400,
  VARIANTS_NOT_ALLOWED: 400,
  VARIANT_NOT_FOUND: 400,
  VARIANT_TWICE: 400,
  VARIANTS_SUM: 400,
  VARIANTS_NOT_ENOUGH_FREE: 409,
  VARIANT_NOT_ON_SHELF: 409,
  VARIANT_COUNTS_INVALID: 400,
  VARIANT_COUNT_OVER_SENT: 400,
  VARIANTS_OVER_COUNT: 409,
  VARIANT_MOVED_MEANWHILE: 409,
};

/** The default sentence of each refusal; the helpers below name the product or the combination when they can. */
export const VARIANT_LINE_AR: Record<VariantLineRefusalCode, string> = {
  VARIANTS_REQUIRED: 'في منتج إله خيارات (مقاس/لون): اكتب كم قطعة من كل خيار.',
  VARIANTS_NOT_ALLOWED: 'في منتج ما إله خيارات، وسطره فيه خيارات. شيلها.',
  VARIANT_NOT_FOUND: 'في خيار مش من خيارات منتجه. حدّث الصفحة.',
  VARIANT_TWICE: 'نفس الخيار مكتوب مرتين بنفس السطر. اجمعه بمرة وحدة.',
  VARIANTS_SUM: 'مجموع الخيارات مش قد كمية المنتج.',
  VARIANTS_NOT_ENOUGH_FREE: 'ما في كفاية من خيار بهالمخزن.',
  VARIANT_NOT_ON_SHELF: 'المخزن ما فيه هالعدد من خيار هلق. ارفض الطلب، أو استنى لحد ما ينعدّ الخيار.',
  VARIANT_COUNTS_INVALID: 'لازم تكتب العدد لكل خيار انبعت، مرة وحدة لكل خيار.',
  VARIANT_COUNT_OVER_SENT: 'عدد خيار أكتر من اللي انبعت منه. عدّ كمان مرة.',
  VARIANTS_OVER_COUNT: 'عدد خيار بالمخازن أكتر من عدده بالمتجر. صحّح عدد الخيار أول.',
  VARIANT_MOVED_MEANWHILE: 'خيار تحرّك بنفس اللحظة من باب تاني. جرّب كمان مرة.',
};

/** Each document throws its own refusal class; the helpers here are handed the way to throw it. */
export type Fail = (code: VariantLineRefusalCode, errorAr?: string, extra?: Record<string, unknown>) => never;

/* ───────────────────────────── the bodies ───────────────────────────── */

const variantIdField = z.string({ message: 'الخيار مش محدد' }).min(1, 'اختار الخيار').max(64, 'الخيار مش صحيح');
const pieces = z.number({ message: 'العدد لازم يكون رقم' }).int('العدد لازم يكون عدد صحيح');

/** A line's combinations as a document sends them (transfer send, exit request): each more than zero. */
export const variantLinesField = z
  .array(z.object({ variantId: variantIdField, quantity: pieces.positive('عدد الخيار لازم يكون أكبر من صفر') }, { message: 'سطر الخيار مش مفهوم' }), {
    message: 'الخيارات لازم تكون قائمة',
  })
  .max(200, 'كتير خيارات بسطر واحد. قسّمه.');

/** A line's combinations as they are COUNTED (transfer receipt, placement): zero allowed. */
export const variantCountsField = z
  .array(z.object({ variantId: variantIdField, quantity: pieces.min(0, 'العدد ما بيكون أقل من صفر') }, { message: 'سطر الخيار مش مفهوم' }), {
    message: 'الخيارات لازم تكون قائمة',
  })
  .max(200, 'كتير خيارات بسطر واحد. قسّمه.');

export interface VariantQty {
  variantId: string;
  quantity: number;
}
export interface LineWithVariants {
  productId: string;
  quantity: number;
  variants?: readonly VariantQty[] | null;
}

/** A line names combinations when it carries a non-empty list. */
export const namesVariants = (l: { variants?: readonly VariantQty[] | null }) => (l.variants?.length ?? 0) > 0;

/** The same combinations with the same quantities (order does not matter) — the replay guards' question. */
export function sameVariants(a: readonly VariantQty[] | null | undefined, b: readonly VariantQty[] | null | undefined): boolean {
  const key = (xs: readonly VariantQty[] | null | undefined) =>
    [...(xs ?? [])].map((x) => `${x.variantId}:${x.quantity}`).sort().join('|');
  return key(a) === key(b);
}

/**
 * PURE: inside each line that names combinations, a combination once, and their sum = the line's quantity. Asked before
 * anything is read.
 */
export function checkLineShapes(lines: readonly LineWithVariants[], fail: Fail): void {
  for (const l of lines) {
    if (!namesVariants(l)) continue;
    const seen = new Set<string>();
    let sum = 0;
    for (const v of l.variants!) {
      if (seen.has(v.variantId)) fail('VARIANT_TWICE');
      seen.add(v.variantId);
      sum += v.quantity;
    }
    if (sum !== l.quantity) {
      fail('VARIANTS_SUM', `مجموع الخيارات (${sum}) مش قد كمية المنتج بسطره (${l.quantity}). خلّيهم متساويين.`, { productId: l.productId });
    }
  }
}

/* ───────────────────────────── whose combinations ───────────────────────────── */

export interface ProductCombos {
  /** Has at least one ACTIVE combination: its lines must name them. */
  active: boolean;
  byId: Map<string, { label: string; status: string }>;
}

/**
 * The combinations of these products (any status — an archived combination may still hold pieces), keyed by product.
 * A product with none is absent. ONE read; none at all when `ask` is false (a document that names no combination asks
 * only whether its products HAVE any, which it must).
 */
export async function combosOf(tx: Tx, companyId: string, productIds: readonly string[]): Promise<Map<string, ProductCombos>> {
  const out = new Map<string, ProductCombos>();
  if (productIds.length === 0) return out;
  const rows = await tx.productVariant.findMany({
    where: { companyId, productId: { in: [...new Set(productIds)] } },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    select: { id: true, productId: true, label: true, status: true },
  });
  for (const r of rows) {
    const p = out.get(r.productId) ?? { active: false, byId: new Map() };
    p.byId.set(r.id, { label: r.label, status: r.status });
    if (r.status === 'ACTIVE') p.active = true;
    out.set(r.productId, p);
  }
  return out;
}

/**
 * A transfer or an exit: a product with active combinations names them; a product with none names none; every named
 * combination is its product's. `nameOf` names the product in the sentence.
 */
export function checkMembership(
  lines: readonly LineWithVariants[],
  combos: ReadonlyMap<string, ProductCombos>,
  nameOf: ReadonlyMap<string, string>,
  fail: Fail,
  opts: { required: boolean }
): void {
  for (const l of lines) {
    const mine = combos.get(l.productId);
    const name = nameOf.get(l.productId) ?? '';
    if (!namesVariants(l)) {
      if (opts.required && mine?.active) {
        fail('VARIANTS_REQUIRED', `«${name}» إله خيارات (مقاس/لون): اكتب كم قطعة من كل خيار.`, { productId: l.productId });
      }
      continue;
    }
    if (!mine) fail('VARIANTS_NOT_ALLOWED', `«${name}» ما إله خيارات، وسطره فيه خيارات. شيلها.`, { productId: l.productId });
    for (const v of l.variants!) {
      if (!mine!.byId.has(v.variantId)) fail('VARIANT_NOT_FOUND', `في خيار مش من خيارات «${name}». حدّث الصفحة.`, { productId: l.productId });
    }
  }
}

/** «L · أسود» of a combination, or a blank — for the sentences. */
const labelOf = (combos: ReadonlyMap<string, ProductCombos>, productId: string, variantId: string) =>
  combos.get(productId)?.byId.get(variantId)?.label ?? '';

/* ───────────────────────────── free pieces in a warehouse ───────────────────────────── */

/**
 * FREE PIECES OF COMBINATIONS IN ONE WAREHOUSE (the product's `freeStockOf`, per combination): its pieces there (its
 * shelf row — never a road) − the pieces of open orders SOURCED from that warehouse that still hold (the reservation's
 * rule, with the store's filter, so a bench store's orders never count) − the pieces held by this store's PENDING exits
 * from it. Read without a row lock: the writes after it are guarded (`changeVariants` plans refuse a place too short).
 */
export async function freeVariantsOf(
  tx: Tx,
  p: { companyId: string; storeId: string; warehouseId: string; wanted: readonly { productId: string; variantId: string }[] }
): Promise<Map<string, number>> {
  const free = new Map<string, number>();
  const variantIds = [...new Set(p.wanted.map((w) => w.variantId))];
  if (variantIds.length === 0) return free;
  const productIds = [...new Set(p.wanted.map((w) => w.productId))];

  const shelf = await tx.productVariantStock.findMany({
    where: { variantId: { in: variantIds }, warehouseId: p.warehouseId },
    select: { variantId: true, onHand: true },
  });
  for (const id of variantIds) free.set(id, 0);
  for (const r of shelf) free.set(r.variantId, (free.get(r.variantId) ?? 0) + r.onHand);

  const held = holdingWhere({ companyId: p.companyId, productId: { in: productIds }, storeId: p.storeId });
  const sourced = await tx.orderItem.findMany({
    where: { ...held, order: { ...held.order, sourceWarehouseId: p.warehouseId } },
    select: { id: true },
  });
  if (sourced.length > 0) {
    const reserved = await tx.orderItemVariant.findMany({
      where: { orderItemId: { in: sourced.map((s) => s.id) }, variantId: { in: variantIds } },
      select: { variantId: true, quantity: true, freeQuantity: true },
    });
    for (const r of reserved) if (r.variantId) free.set(r.variantId, (free.get(r.variantId) ?? 0) - r.quantity - r.freeQuantity);
  }

  const pending = await tx.stockExit.findMany({
    where: { companyId: p.companyId, storeId: p.storeId, warehouseId: p.warehouseId, status: PENDING_EXIT },
    select: { id: true },
  });
  if (pending.length > 0) {
    const held2 = await tx.stockExitLineVariant.findMany({
      where: { exitId: { in: pending.map((e) => e.id) }, variantId: { in: variantIds } },
      select: { variantId: true, quantity: true },
    });
    for (const r of held2) free.set(r.variantId, (free.get(r.variantId) ?? 0) - r.quantity);
  }
  return free;
}

/** Refuses, naming each short combination, when a line asks more pieces of a combination than the warehouse has free. */
export async function assertFreeVariants(
  tx: Tx,
  p: {
    companyId: string;
    storeId: string;
    warehouseId: string;
    warehouseName: string;
    lines: readonly LineWithVariants[];
    combos: ReadonlyMap<string, ProductCombos>;
    nameOf: ReadonlyMap<string, string>;
  },
  fail: Fail
): Promise<void> {
  const wanted = p.lines.filter(namesVariants).flatMap((l) => l.variants!.map((v) => ({ productId: l.productId, ...v })));
  if (wanted.length === 0) return;
  const free = await freeVariantsOf(tx, { companyId: p.companyId, storeId: p.storeId, warehouseId: p.warehouseId, wanted });
  const short = wanted
    .filter((w) => w.quantity > (free.get(w.variantId) ?? 0))
    .map((w) => ({
      productId: w.productId,
      variantId: w.variantId,
      name: p.nameOf.get(w.productId) ?? '',
      label: labelOf(p.combos, w.productId, w.variantId),
      asked: w.quantity,
      free: Math.max(0, free.get(w.variantId) ?? 0),
    }));
  if (short.length > 0) {
    fail(
      'VARIANTS_NOT_ENOUGH_FREE',
      `ما في كفاية من هالخيارات ببضاعة ${p.warehouseName} الحرّة: ${short.map((s) => `${s.name} «${s.label}» (الحر ${s.free}، طالب ${s.asked})`).join(' · ')}. إذا الخيار ما انعدّ بالمخزن لسا، عدّه من شاشة الخيارات أول.`,
      { variantsShort: short }
    );
  }
}

/* ───────────────────────────── the document's own rows ───────────────────────────── */

/** Writes a document's combination rows under its product lines. Nothing at all when no line names a combination. */
export async function writeTransferLineVariants(tx: Tx, transferId: string, lines: readonly LineWithVariants[]): Promise<void> {
  if (!lines.some(namesVariants)) return;
  const rows = await tx.stockTransferLine.findMany({ where: { transferId }, select: { id: true, productId: true } });
  const lineOf = new Map(rows.map((r) => [r.productId, r.id]));
  for (const l of lines.filter(namesVariants)) {
    for (const v of l.variants!) {
      await tx.stockTransferLineVariant.create({
        data: { lineId: lineOf.get(l.productId)!, transferId, productId: l.productId, variantId: v.variantId, quantitySent: v.quantity },
      });
    }
  }
}

export async function writeExitLineVariants(tx: Tx, exitId: string, lines: readonly LineWithVariants[]): Promise<void> {
  if (!lines.some(namesVariants)) return;
  const rows = await tx.stockExitLine.findMany({ where: { exitId }, select: { id: true, productId: true } });
  const lineOf = new Map(rows.map((r) => [r.productId, r.id]));
  for (const l of lines.filter(namesVariants)) {
    for (const v of l.variants!) {
      await tx.stockExitLineVariant.create({
        data: { lineId: lineOf.get(l.productId)!, exitId, productId: l.productId, variantId: v.variantId, quantity: v.quantity },
      });
    }
  }
}

export interface TransferVariantRow {
  variantId: string;
  quantitySent: number;
  quantityReceived: number | null;
}

/** A transfer's combination rows by product, each list in combination-id order. */
export async function transferVariantsOf(tx: Tx, transferId: string): Promise<Map<string, TransferVariantRow[]>> {
  const rows = await tx.stockTransferLineVariant.findMany({
    where: { transferId },
    orderBy: { variantId: 'asc' },
    select: { productId: true, variantId: true, quantitySent: true, quantityReceived: true },
  });
  const out = new Map<string, TransferVariantRow[]>();
  for (const r of rows) {
    const list = out.get(r.productId) ?? [];
    list.push({ variantId: r.variantId, quantitySent: r.quantitySent, quantityReceived: r.quantityReceived ?? null });
    out.set(r.productId, list);
  }
  return out;
}

/** An exit's combination rows by product, each list in combination-id order. */
export async function exitVariantsOf(tx: Tx, exitId: string): Promise<Map<string, VariantQty[]>> {
  const rows = await tx.stockExitLineVariant.findMany({
    where: { exitId },
    orderBy: { variantId: 'asc' },
    select: { productId: true, variantId: true, quantity: true },
  });
  const out = new Map<string, VariantQty[]>();
  for (const r of rows) {
    const list = out.get(r.productId) ?? [];
    list.push({ variantId: r.variantId, quantity: r.quantity });
    out.set(r.productId, list);
  }
  return out;
}

/**
 * The lines of a document with their combinations — `variants` is ADDED only to a line that has them, so a document
 * without combinations answers exactly what it answered before (no empty list appears).
 */
export function withLineVariants<L extends { productId: string }, V>(lines: readonly L[], byProduct: ReadonlyMap<string, V[]>): (L & { variants?: V[] })[] {
  return lines.map((l) => {
    const v = byProduct.get(l.productId);
    return v && v.length > 0 ? { ...l, variants: v } : { ...l };
  });
}

/* ───────────────────────────── 20/11 (W8c): the lists' combinations ───────────────────────────── */

/**
 * The combination rows of MANY transfers at once (the list door), by transfer then product — ONE read; nothing at all
 * for an empty page. The rows carry the figures as stored: the list door passes them through `stock-transfers.shownTo`,
 * which keeps the receiver blind to what was sent of each combination exactly as it does for the product line.
 */
export async function transfersVariantsOf(tx: Tx, transferIds: readonly string[]): Promise<Map<string, Map<string, TransferVariantRow[]>>> {
  const out = new Map<string, Map<string, TransferVariantRow[]>>();
  if (transferIds.length === 0) return out;
  const rows = await tx.stockTransferLineVariant.findMany({
    where: { transferId: { in: [...transferIds] } },
    orderBy: { variantId: 'asc' },
    select: { transferId: true, productId: true, variantId: true, quantitySent: true, quantityReceived: true },
  });
  for (const r of rows) {
    const mine = out.get(r.transferId) ?? new Map<string, TransferVariantRow[]>();
    const list = mine.get(r.productId) ?? [];
    list.push({ variantId: r.variantId, quantitySent: r.quantitySent, quantityReceived: r.quantityReceived ?? null });
    mine.set(r.productId, list);
    out.set(r.transferId, mine);
  }
  return out;
}

/** The combination rows of MANY exits at once (the list door), by exit then product — ONE read; none for an empty page. */
export async function exitsVariantsOf(tx: Tx, exitIds: readonly string[]): Promise<Map<string, Map<string, VariantQty[]>>> {
  const out = new Map<string, Map<string, VariantQty[]>>();
  if (exitIds.length === 0) return out;
  const rows = await tx.stockExitLineVariant.findMany({
    where: { exitId: { in: [...exitIds] } },
    orderBy: { variantId: 'asc' },
    select: { exitId: true, productId: true, variantId: true, quantity: true },
  });
  for (const r of rows) {
    const mine = out.get(r.exitId) ?? new Map<string, VariantQty[]>();
    const list = mine.get(r.productId) ?? [];
    list.push({ variantId: r.variantId, quantity: r.quantity });
    mine.set(r.productId, list);
    out.set(r.exitId, mine);
  }
  return out;
}

/** «أسود · L» of each combination named — ONE read, none when no combination is named. */
export async function variantLabelsOf(tx: Tx, companyId: string, variantIds: Iterable<string>): Promise<Map<string, string>> {
  const ids = [...new Set(variantIds)];
  if (ids.length === 0) return new Map();
  const rows = await tx.productVariant.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, label: true } });
  return new Map(rows.map((r) => [r.id, r.label]));
}

/**
 * A shown line with its combinations' labels added — a word, never a figure, so a blind line stays blind. A line with no
 * combinations comes back as it went in (no empty list, no new field).
 */
export function labelLineVariants<L extends object>(line: L, labels: ReadonlyMap<string, string>): L {
  const variants = (line as { variants?: readonly { variantId: string }[] }).variants;
  if (!variants || variants.length === 0) return line;
  return { ...line, variants: variants.map((v) => ({ ...v, label: labels.get(v.variantId) ?? null })) };
}

/* ───────────────────────────── the receipt's counts ───────────────────────────── */

/**
 * The receiver's counts against what was sent, per combination: a line sent with combinations is counted with exactly
 * those (each once, each never above what was sent, summing to the product's count); a line sent without combinations
 * is counted without any.
 */
export function checkReceiptCounts(
  counts: readonly LineWithVariants[],
  sent: ReadonlyMap<string, TransferVariantRow[]>,
  fail: Fail
): void {
  for (const c of counts) {
    const mine = sent.get(c.productId) ?? [];
    if (mine.length === 0) {
      if (namesVariants(c)) fail('VARIANT_COUNTS_INVALID', 'هالمنتج انبعت بلا خيارات. اكتب عدده بس.', { productId: c.productId });
      continue;
    }
    const got = c.variants ?? [];
    const ids = new Set(got.map((g) => g.variantId));
    if (ids.size !== got.length || got.length !== mine.length || mine.some((m) => !ids.has(m.variantId))) {
      fail('VARIANT_COUNTS_INVALID', undefined, { productId: c.productId });
    }
    for (const g of got) {
      if (g.quantity > (mine.find((m) => m.variantId === g.variantId)?.quantitySent ?? 0)) {
        fail('VARIANT_COUNT_OVER_SENT', 'عدد خيار أكتر من اللي انبعت منه. عدّ كمان مرة، والزيادة بتنكتب من الجرد مش من هون.', { productId: c.productId });
      }
    }
    const sum = got.reduce((s, g) => s + g.quantity, 0);
    if (sum !== c.quantity) {
      fail('VARIANTS_SUM', `مجموع الخيارات (${sum}) مش قد العدد اللي كتبته للمنتج (${c.quantity}). خلّيهم متساويين.`, { productId: c.productId });
    }
  }
}

/** The replay of a receipt: the same combinations counted the same. */
export function sameReceiptCounts(
  counts: readonly LineWithVariants[],
  sent: ReadonlyMap<string, TransferVariantRow[]>
): boolean {
  return counts.every((c) =>
    sameVariants(
      c.variants ?? [],
      (sent.get(c.productId) ?? []).map((r) => ({ variantId: r.variantId, quantity: r.quantityReceived ?? -1 }))
    )
  );
}

/* ───────────────────────────── the moves ───────────────────────────── */

interface MoveWho {
  companyId: string;
  storeId: string;
  userId: string;
  referenceId: string;
}

/** A plan step that refuses when a place holds fewer pieces than it must give. */
function take(places: Parameters<VariantChange['plan']>[0], from: { warehouseId: string | null; road?: string | null }, n: number, fail: Fail, code: VariantLineRefusalCode, extra: Record<string, unknown>): PlaceMove {
  if (placeHolds(places, from) < n) fail(code, undefined, extra);
  return { ...from, delta: -n };
}

const change = (variantId: string, type: VariantMoveType, reason: string, plan: VariantChange['plan']): VariantChange => ({ variantId, type, reason, plan });

/** SEND: each combination's pieces leave the source warehouse for the transfer's road. */
export async function sendVariants(
  tx: Tx,
  who: MoveWho,
  p: { fromWarehouseId: string; lines: readonly LineWithVariants[]; reason: string },
  fail: Fail
): Promise<void> {
  const changes = p.lines.filter(namesVariants).flatMap((l) =>
    l.variants!.map((v) =>
      change(v.variantId, VARIANT_MOVE.TRANSFER_OUT, p.reason, (places) => [
        take(places, { warehouseId: p.fromWarehouseId }, v.quantity, fail, 'VARIANT_MOVED_MEANWHILE', { variantId: v.variantId }),
        { warehouseId: null, road: who.referenceId, delta: v.quantity },
      ])
    )
  );
  await changeVariants(tx, who, changes);
}

/** RECEIVE: the counted pieces of each combination leave the road for the destination; the rest stays on the road. */
export async function receiveVariants(
  tx: Tx,
  who: MoveWho,
  p: { toWarehouseId: string; counts: readonly LineWithVariants[]; reason: string },
  fail: Fail
): Promise<void> {
  const changes = p.counts
    .filter(namesVariants)
    .flatMap((c) => c.variants!.filter((v) => v.quantity > 0))
    .map((v) =>
      change(v.variantId, VARIANT_MOVE.TRANSFER_IN, p.reason, (places) => [
        take(places, { warehouseId: null, road: who.referenceId }, v.quantity, fail, 'VARIANT_MOVED_MEANWHILE', { variantId: v.variantId }),
        { warehouseId: p.toWarehouseId, delta: v.quantity },
      ])
    );
  await changeVariants(tx, who, changes);
}

/** CANCEL before receipt: everything on the road goes back to the source warehouse. */
export async function cancelVariants(
  tx: Tx,
  who: MoveWho,
  p: { fromWarehouseId: string; sent: ReadonlyMap<string, TransferVariantRow[]>; reason: string },
  fail: Fail
): Promise<void> {
  const changes = [...p.sent.values()].flat().map((r) =>
    change(r.variantId, VARIANT_MOVE.TRANSFER_BACK, p.reason, (places) => [
      take(places, { warehouseId: null, road: who.referenceId }, r.quantitySent, fail, 'VARIANT_MOVED_MEANWHILE', { variantId: r.variantId }),
      { warehouseId: p.fromWarehouseId, delta: r.quantitySent },
    ])
  );
  await changeVariants(tx, who, changes);
}

/** THE APPROVED SHORTFALL: what was sent and not counted leaves the road — and the store. */
export async function differenceVariants(
  tx: Tx,
  who: MoveWho,
  p: { type: 'LOSS' | 'DAMAGE'; sent: ReadonlyMap<string, TransferVariantRow[]>; reason: string },
  fail: Fail
): Promise<void> {
  const changes = [...p.sent.values()]
    .flat()
    .map((r) => ({ r, missing: r.quantitySent - (r.quantityReceived ?? 0) }))
    .filter(({ missing }) => missing > 0)
    .map(({ r, missing }) =>
      change(r.variantId, p.type === 'DAMAGE' ? VARIANT_MOVE.DAMAGE : VARIANT_MOVE.LOSS, p.reason, (places) => [
        take(places, { warehouseId: null, road: who.referenceId }, missing, fail, 'VARIANT_MOVED_MEANWHILE', { variantId: r.variantId }),
      ])
    );
  await changeVariants(tx, who, changes);
}

/**
 * Before an exit is approved: does the warehouse hold each combination's pieces NOW? (A delivery draws its pieces where
 * it can and may have emptied this warehouse's.) Read without a lock to refuse cleanly; the write below is guarded too.
 */
export async function assertVariantsOnShelf(
  tx: Tx,
  p: { warehouseId: string; byProduct: ReadonlyMap<string, VariantQty[]> },
  fail: Fail
): Promise<void> {
  const wanted = [...p.byProduct.values()].flat();
  if (wanted.length === 0) return;
  const rows = await tx.productVariantStock.findMany({
    where: { variantId: { in: wanted.map((w) => w.variantId) }, warehouseId: p.warehouseId },
    select: { variantId: true, onHand: true },
  });
  for (const w of wanted) {
    const there = rows.filter((r) => r.variantId === w.variantId).reduce((s, r) => s + r.onHand, 0);
    if (there < w.quantity) fail('VARIANT_NOT_ON_SHELF', undefined, { variantId: w.variantId, onShelf: there, asked: w.quantity });
  }
}

/** AN APPROVED EXIT: each combination's pieces leave that warehouse — and the store. */
export async function exitVariants(
  tx: Tx,
  who: MoveWho,
  p: { warehouseId: string; byProduct: ReadonlyMap<string, VariantQty[]>; reason: string },
  fail: Fail
): Promise<void> {
  const changes = [...p.byProduct.values()].flat().map((v) =>
    change(v.variantId, VARIANT_MOVE.EXIT, p.reason, (places) => [
      take(places, { warehouseId: p.warehouseId }, v.quantity, fail, 'VARIANT_NOT_ON_SHELF', { variantId: v.variantId }),
    ])
  );
  await changeVariants(tx, who, changes);
}

/* ───────────────────────────── the opening placement ───────────────────────────── */

export interface PlacementVariantCount {
  warehouseId: string;
  lines: readonly LineWithVariants[];
}

/** Per combination: the pieces each warehouse was counted to hold (zeros dropped), in the warehouses' order. */
export function placementVariantPlan(counts: readonly PlacementVariantCount[]): Map<string, { productId: string; perWarehouse: { warehouseId: string; quantity: number }[] }> {
  const out = new Map<string, { productId: string; perWarehouse: { warehouseId: string; quantity: number }[] }>();
  for (const c of counts) {
    for (const l of c.lines) {
      for (const v of l.variants ?? []) {
        if (v.quantity <= 0) continue;
        const e = out.get(v.variantId) ?? { productId: l.productId, perWarehouse: [] };
        e.perWarehouse.push({ warehouseId: c.warehouseId, quantity: v.quantity });
        out.set(v.variantId, e);
      }
    }
  }
  return out;
}

/**
 * THE PLACEMENT'S COMBINATIONS, checked against the database (the preview and the press ask the same): each named
 * combination is its product's, and no combination is counted, over all the warehouses, above its store-level count
 * (`onHand` — what the placement divides; the rest stays «بلا مكان»: the pieces with the courier, or not counted yet).
 * Nothing at all is read when no line names a combination.
 */
export async function checkPlacementVariants(
  tx: Tx,
  p: { companyId: string; counts: readonly PlacementVariantCount[]; nameOf: ReadonlyMap<string, string> },
  fail: Fail
): Promise<void> {
  const lines = p.counts.flatMap((c) => c.lines);
  if (!lines.some(namesVariants)) return;
  const productIds = [...new Set(lines.filter(namesVariants).map((l) => l.productId))];
  const combos = await combosOf(tx, p.companyId, productIds);
  checkMembership(lines, combos, p.nameOf, fail, { required: false });
  const plan = placementVariantPlan(p.counts);
  const rows = await tx.productVariant.findMany({
    where: { companyId: p.companyId, id: { in: [...plan.keys()] } },
    select: { id: true, onHand: true },
  });
  const onHandOf = new Map(rows.map((r) => [r.id, r.onHand]));
  const over = [...plan]
    .map(([variantId, e]) => ({ variantId, productId: e.productId, counted: e.perWarehouse.reduce((s, w) => s + w.quantity, 0), onHand: onHandOf.get(variantId) ?? 0 }))
    .filter((x) => x.counted > x.onHand);
  if (over.length > 0) {
    const shown = over
      .slice(0, 5)
      .map((x) => `${p.nameOf.get(x.productId) ?? ''} «${labelOf(combos, x.productId, x.variantId)}» (بالمتجر ${x.onHand}، انعدّ ${x.counted})`);
    fail(
      'VARIANTS_OVER_COUNT',
      `عدّ الخيارات بالمخازن أكتر من عددها بالمتجر: ${shown.join('، ')}${over.length > 5 ? ` و${over.length - 5} غيرهم` : ''}. صحّح عدد الخيار من شاشة الخيارات أول، وبعدين وزّع.`,
      { variantsOver: over }
    );
  }
}

/** THE PRESS: each combination's counted pieces leave «بلا مكان» for their warehouses (the total does not move). */
export async function placeVariants(
  tx: Tx,
  who: MoveWho,
  p: { counts: readonly PlacementVariantCount[]; reason: string },
  fail: Fail
): Promise<void> {
  const plan = placementVariantPlan(p.counts);
  const changes = [...plan].map(([variantId, e]) => {
    const total = e.perWarehouse.reduce((s, w) => s + w.quantity, 0);
    return change(variantId, VARIANT_MOVE.PLACEMENT, p.reason, (places) => [
      ...e.perWarehouse.map((w) => ({ warehouseId: w.warehouseId, delta: w.quantity })),
      take(places, { warehouseId: null }, total, fail, 'VARIANTS_OVER_COUNT', { variantId }),
    ]);
  });
  await changeVariants(tx, who, changes);
}
