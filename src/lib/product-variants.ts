import type { Prisma } from '@prisma/client';
import type { db } from './db';
import { holdingWhere } from './reservation';
import { drawPlacedVariants, restorePlacedVariant, variantsArePlaced } from './variant-stock';

/**
 * A PRODUCT WITH VARIANTS — the owner's decision of 2026-11-18 (docs/planner-questions.md, «متغيّرات المنتج»).
 *
 * A product may carry two or more option types («المقاس»: S/M/L/XL, «اللون»: أسود/رمادي/كحلي). Each sellable
 * combination is a `ProductVariant` row with its own price delta and its own count on the shelf. A product with no
 * options (every product before this) is sold, priced and stocked exactly as before: every reader here answers
 * «no variants» for it and nothing else is asked of the database.
 *
 * ── THE PRICING RULE (owner-approved; the OMS computes it, never a browser) ──
 *
 *   goods of a line = the offer's price (or the base price, with no offer)
 *                   + Σ priceDelta of EVERY piece of the line — free pieces included
 *
 * The offer's own reduction and the basket discount are unchanged and still go through the one `computeCod`. The sum
 * of deltas is added to the line's price BEFORE the reduction, so `unitPrice = (listTotal + Σdelta) / quantity`
 * (`resolvePublicLines`); `computeCod` then works exactly as it always did. A product with no variants adds 0.
 *
 * ── STOCK ──
 *
 * `ProductVariant.onHand` is the combination's own count. What it can still promise is `onHand` minus what open
 * orders HOLD of it — an `OrderItemVariant` holds while its line's `reservedQty` is set, by the same `holdingWhere`
 * the product's own availability reads. So reservation (at confirmation), release (cancel / unconfirm), draw-down
 * (delivery) and restock (a counted return) move the combination at the same moments they move the product. The
 * product's batches stay the ledger of the product's total and of its cost.
 *
 * 19/11 (W8a): in a store PLACED in warehouses the count lives per warehouse and `onHand` is their sum, written by
 * `variant-stock.ts` alone, with a ledger line per change — the draw-down and the restock below hand a placed store's
 * pieces to it. What a combination can still promise stays the store's: `onHand` (= Σ of its places) minus what open
 * orders hold, read exactly as before. A store that is not placed runs the code it always ran.
 */

type Tx = Prisma.TransactionClient | typeof db;

export interface VariantValue {
  id: string;
  label: string;
  /** A CSS hex colour for a colour value, else null. */
  swatch: string | null;
}
export interface VariantOption {
  id: string;
  name: string;
  values: VariantValue[];
}

export const MAX_OPTIONS = 3;
export const MAX_VALUES = 30;
export const MAX_COMBINATIONS = 200;
const HEX = /^#[0-9a-fA-F]{6}$/;

/** `Product.variantOptions` as options, or [] — a product with no options, or a column that does not read, has no variants. */
export function parseVariantOptions(raw: string | null | undefined): VariantOption[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: VariantOption[] = [];
    for (const o of parsed.slice(0, MAX_OPTIONS)) {
      if (!o || typeof o !== 'object') return [];
      const { id, name, values } = o as Record<string, unknown>;
      if (typeof id !== 'string' || typeof name !== 'string' || !Array.isArray(values)) return [];
      const vals: VariantValue[] = [];
      for (const v of values.slice(0, MAX_VALUES)) {
        const r = (v ?? {}) as Record<string, unknown>;
        if (typeof r.id !== 'string' || typeof r.label !== 'string') return [];
        vals.push({ id: r.id, label: r.label, swatch: typeof r.swatch === 'string' && HEX.test(r.swatch) ? r.swatch : null });
      }
      if (vals.length === 0) return [];
      out.push({ id, name, values: vals });
    }
    return out;
  } catch {
    return [];
  }
}

export const VARIANT_SELECT = {
  id: true,
  optionValues: true,
  label: true,
  sku: true,
  priceDelta: true,
  onHand: true,
  status: true,
  sortOrder: true,
} as const;

export interface VariantRow {
  id: string;
  optionValues: string;
  label: string;
  sku: string | null;
  priceDelta: number;
  onHand: number;
  status: string;
  sortOrder: number;
}

/** A combination's value ids, one per option in option order. */
export function valuesOf(row: Pick<VariantRow, 'optionValues'>): string[] {
  try {
    const v: unknown = JSON.parse(row.optionValues);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** «L · أسود» — the value labels in option order. */
export function labelFor(options: VariantOption[], valueIds: string[]): string {
  return options
    .map((o, i) => o.values.find((v) => v.id === valueIds[i])?.label ?? '')
    .filter(Boolean)
    .join(' · ');
}

/** The combinations a customer may be offered: active ones, in the seller's order. */
export async function activeVariants(client: Tx, companyId: string, productId: string): Promise<VariantRow[]> {
  return client.productVariant.findMany({
    where: { companyId, productId, status: 'ACTIVE' },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    select: VARIANT_SELECT,
  });
}

/** What open orders hold of each combination — the pieces of every line still holding stock (`holdingWhere`). */
export async function heldOfVariants(
  client: Tx,
  p: { companyId: string; productId: string; variantIds: string[]; exceptOrderId?: string; storeId?: string | null }
): Promise<Map<string, number>> {
  const held = new Map<string, number>();
  if (p.variantIds.length === 0) return held;
  const rows = await client.orderItemVariant.groupBy({
    by: ['variantId'],
    where: {
      companyId: p.companyId,
      variantId: { in: [...new Set(p.variantIds)] },
      orderItem: holdingWhere({
        companyId: p.companyId,
        productId: p.productId,
        ...(p.exceptOrderId ? { orderId: { not: p.exceptOrderId } } : {}),
        storeId: p.storeId,
      }),
    },
    _sum: { quantity: true, freeQuantity: true },
  });
  for (const r of rows) {
    if (r.variantId) held.set(r.variantId, (r._sum?.quantity ?? 0) + (r._sum?.freeQuantity ?? 0));
  }
  return held;
}

/** What each combination can still promise: its own count minus what open orders hold of it. */
export async function freeOfVariants(
  client: Tx,
  p: { companyId: string; productId: string; rows: VariantRow[]; exceptOrderId?: string; storeId?: string | null }
): Promise<Map<string, number>> {
  const held = await heldOfVariants(client, { ...p, variantIds: p.rows.map((r) => r.id) });
  return new Map(p.rows.map((r) => [r.id, r.onHand - (held.get(r.id) ?? 0)]));
}

/** What a page may print of a combination's stock: «بقي N» only for 1..20, as for the product (`landing-door.ts`). */
const SHOWN_AT_OR_BELOW = 20;

export interface VariantsView {
  options: VariantOption[];
  combinations: {
    id: string;
    values: string[];
    label: string;
    priceDelta: number;
    available: boolean;
    availableStock: number | null;
  }[];
}

/** The block the landing contract names (`oms-lp.v1` §10): the options and every active combination. Null with no options. */
export function variantsView(
  options: VariantOption[],
  rows: VariantRow[],
  free: Map<string, number>,
  showCount: boolean
): VariantsView | null {
  if (options.length === 0) return null;
  return {
    options,
    combinations: rows.map((r) => {
      const left = free.get(r.id) ?? 0;
      return {
        id: r.id,
        values: valuesOf(r),
        label: r.label,
        priceDelta: r.priceDelta,
        available: left > 0,
        availableStock: showCount && left >= 1 && left <= SHOWN_AT_OR_BELOW ? left : null,
      };
    }),
  };
}

/** Reads a product's variants block — no query at all for a product without options. */
export async function readVariantsView(
  client: Tx,
  companyId: string,
  product: { id: string; variantOptions?: string | null; storeId?: string | null },
  showCount: boolean
): Promise<VariantsView | null> {
  const options = parseVariantOptions(product.variantOptions);
  if (options.length === 0) return null;
  const rows = await activeVariants(client, companyId, product.id);
  const free = await freeOfVariants(client, { companyId, productId: product.id, rows, storeId: product.storeId });
  return variantsView(options, rows, free, showCount);
}

// ─── The customer's choice, per piece ───

/** «يرجى اختيار المقاس واللون لكل قطعة.» — the option names, joined the way Arabic joins them. */
export function unitsSentence(options: VariantOption[]): string {
  return `يرجى اختيار ${options.map((o) => o.name).join(' و')} لكل قطعة.`;
}
export const UNKNOWN_UNIT = 'أحد الخيارات المختارة لم يعد متاحًا. أعد تحميل الصفحة.';
export const soldOutSentence = (label: string) => `نفد «${label}». اختر خيارًا آخر.`;
export const shortSentence = (label: string) => `لا تكفي الكمية المتوفرة من «${label}». اختر خيارًا آخر.`;

/** The pieces of one line, grouped by combination; paid pieces in `quantity`, gift pieces in `freeQuantity`. */
export interface UnitGroup {
  variantId: string;
  label: string;
  quantity: number;
  freeQuantity: number;
  /** Per piece, a snapshot of the combination's delta. */
  priceDelta: number;
}

export type UnitsCheck =
  | { ok: true; groups: UnitGroup[]; delta: number }
  | { ok: false; fieldErrors: Record<string, string> };

/**
 * ONE CHOICE PER PIECE, CHECKED — pure. `units` lists a combination id per piece, the paid pieces first and the gift
 * pieces after (`paid` + `gift` of them). Refuses a wrong count, a combination that is not this product's active one,
 * and more pieces of a combination than it can still promise (`free`). `units.<i>` names the first offending piece.
 */
export function checkUnits(p: {
  options: VariantOption[];
  rows: VariantRow[];
  free: Map<string, number>;
  units: string[];
  paid: number;
  gift: number;
}): UnitsCheck {
  if (p.units.length !== p.paid + p.gift) return { ok: false, fieldErrors: { units: unitsSentence(p.options) } };
  const byId = new Map(p.rows.filter((r) => r.status === 'ACTIVE').map((r) => [r.id, r]));
  const asked = new Map<string, number>();
  for (let i = 0; i < p.units.length; i++) {
    const row = byId.get(p.units[i]);
    if (!row) return { ok: false, fieldErrors: { units: UNKNOWN_UNIT, [`units.${i}`]: UNKNOWN_UNIT } };
    const n = (asked.get(row.id) ?? 0) + 1;
    asked.set(row.id, n);
    const left = p.free.get(row.id) ?? 0;
    if (n > left) {
      const msg = left <= 0 ? soldOutSentence(row.label) : shortSentence(row.label);
      return { ok: false, fieldErrors: { units: msg, [`units.${i}`]: msg } };
    }
  }
  const groups: UnitGroup[] = [];
  let delta = 0;
  p.units.forEach((id, i) => {
    const row = byId.get(id)!;
    delta += row.priceDelta;
    let g = groups.find((x) => x.variantId === id);
    if (!g) {
      g = { variantId: id, label: row.label, quantity: 0, freeQuantity: 0, priceDelta: row.priceDelta };
      groups.push(g);
    }
    if (i < p.paid) g.quantity++;
    else g.freeQuantity++;
  });
  return { ok: true, groups, delta };
}

/** Reads what `checkUnits` needs and asks it. No query for a product without options; `null` then. */
export async function resolveUnits(
  client: Tx,
  p: {
    companyId: string;
    product: { id: string; variantOptions?: string | null };
    units: string[];
    paid: number;
    gift: number;
    exceptOrderId?: string;
    storeId?: string | null;
  }
): Promise<UnitsCheck | null> {
  const options = parseVariantOptions(p.product.variantOptions);
  if (options.length === 0) return null;
  const rows = await activeVariants(client, p.companyId, p.product.id);
  const free = await freeOfVariants(client, {
    companyId: p.companyId,
    productId: p.product.id,
    rows,
    exceptOrderId: p.exceptOrderId,
    storeId: p.storeId,
  });
  return checkUnits({ options, rows, free, units: p.units, paid: p.paid, gift: p.gift });
}

/** «L · أسود ×2، M · كحلي (مجانًا)» — what a packer reads. */
export function variantSummary(groups: ReadonlyArray<Pick<UnitGroup, 'label' | 'quantity' | 'freeQuantity'>>): string | null {
  const parts: string[] = [];
  for (const g of groups) {
    if (g.quantity > 0) parts.push(g.quantity > 1 ? `${g.label} ×${g.quantity}` : g.label);
    if (g.freeQuantity > 0) parts.push(`${g.label}${g.freeQuantity > 1 ? ` ×${g.freeQuantity}` : ''} (مجانًا)`);
  }
  return parts.length ? parts.join('، ') : null;
}

/** The pieces of a line as a list of ids, paid first — the shape `units` is sent in. */
export function unitsOfGroups(groups: ReadonlyArray<{ variantId: string | null; label: string; quantity: number; freeQuantity: number }>) {
  const out: { variantId: string | null; label: string; free: boolean }[] = [];
  for (const g of groups) for (let i = 0; i < g.quantity; i++) out.push({ variantId: g.variantId, label: g.label, free: false });
  for (const g of groups) for (let i = 0; i < g.freeQuantity; i++) out.push({ variantId: g.variantId, label: g.label, free: true });
  return out;
}

/** Writes (or rewrites) a line's pieces and its summary, inside the caller's transaction. */
export async function writeLineVariants(
  tx: Tx,
  p: { companyId: string; orderId: string; orderItemId: string; productId: string; groups: UnitGroup[] }
) {
  await tx.orderItemVariant.deleteMany({ where: { orderItemId: p.orderItemId } });
  if (p.groups.length > 0) {
    await tx.orderItemVariant.createMany({
      data: p.groups.map((g) => ({
        companyId: p.companyId,
        orderId: p.orderId,
        orderItemId: p.orderItemId,
        productId: p.productId,
        variantId: g.variantId,
        label: g.label,
        quantity: g.quantity,
        freeQuantity: g.freeQuantity,
        priceDelta: g.priceDelta,
      })),
    });
  }
  await tx.orderItem.update({ where: { id: p.orderItemId }, data: { variantSummary: variantSummary(p.groups) } });
}

/**
 * THE PIECES A LINE IS SHORT OF, combination by combination — read by `reserveOrderLines` under the product's lock.
 * A line whose pieces were never chosen asks nothing here (0).
 */
export async function lineVariantShortage(
  tx: Tx,
  p: { companyId: string; productId: string; orderItemId: string; orderId: string; storeId?: string | null }
): Promise<number> {
  const pieces = await tx.orderItemVariant.findMany({
    where: { orderItemId: p.orderItemId, variantId: { not: null } },
    select: { variantId: true, quantity: true, freeQuantity: true },
  });
  if (pieces.length === 0) return 0;
  const need = new Map<string, number>();
  for (const x of pieces) need.set(x.variantId!, (need.get(x.variantId!) ?? 0) + x.quantity + x.freeQuantity);
  const rows = await tx.productVariant.findMany({ where: { id: { in: [...need.keys()] } }, select: VARIANT_SELECT });
  const free = await freeOfVariants(tx, { companyId: p.companyId, productId: p.productId, rows, exceptOrderId: p.orderId, storeId: p.storeId });
  let missing = 0;
  for (const [id, n] of need) missing += Math.max(0, n - (free.get(id) ?? 0));
  return missing;
}

/** The pieces of every line of an order that has them, with the line's units — read before a lines edit replaces the rows. */
export async function piecesOfOrder(tx: Tx, orderId: string) {
  const lines = await tx.orderItem.findMany({
    where: { orderId, variantSummary: { not: null } },
    orderBy: { createdAt: 'asc' },
    select: {
      productId: true,
      quantity: true,
      freeQuantity: true,
      variants: { orderBy: { createdAt: 'asc' }, select: { variantId: true, label: true, quantity: true, freeQuantity: true, priceDelta: true } },
    },
  });
  return lines.map((l) => ({
    productId: l.productId,
    quantity: l.quantity,
    freeQuantity: l.freeQuantity,
    groups: l.variants
      .filter((v) => v.variantId)
      .map((v) => ({ variantId: v.variantId!, label: v.label, quantity: v.quantity, freeQuantity: v.freeQuantity, priceDelta: v.priceDelta })),
  }));
}

/**
 * A LINES EDIT REWROTE THE ROWS: the pieces go back onto a new line of the same product with the same units. A line
 * whose units changed cannot keep a piece-by-piece choice made for other units — it loses it, and the order's history
 * says so (the call asks again). Money is not touched here: the lines edit priced the lines itself.
 */
export async function carryPieces(
  tx: Tx,
  p: { companyId: string; orderId: string; before: Awaited<ReturnType<typeof piecesOfOrder>> }
): Promise<number> {
  const after = await tx.orderItem.findMany({
    where: { orderId: p.orderId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, productId: true, quantity: true, freeQuantity: true },
  });
  const used = new Set<string>();
  let dropped = 0;
  for (const b of p.before) {
    const row = after.find((a) => !used.has(a.id) && a.productId === b.productId && a.quantity === b.quantity && a.freeQuantity === b.freeQuantity);
    if (!row || b.groups.length === 0) {
      dropped++;
      continue;
    }
    used.add(row.id);
    await writeLineVariants(tx, { companyId: p.companyId, orderId: p.orderId, orderItemId: row.id, productId: row.productId, groups: b.groups });
  }
  if (dropped > 0) {
    await tx.orderActivity.create({
      data: { companyId: p.companyId, orderId: p.orderId, userId: null, action: 'VARIANTS_NOT_CHOSEN', metadata: JSON.stringify({ reason: 'LINES_EDITED' }) },
    });
  }
  return dropped;
}

/**
 * At delivery: every chosen piece leaves its combination's count (never below zero — a delivery is a fact).
 * 19/11 (W8a): a placed store's pieces leave their places (`variant-stock.drawPlacedVariants`: the order's warehouse,
 * then «بلا مكان», then the fullest); any other store's, the store-level count, as before.
 */
export async function drawDownVariants(tx: Tx, orderId: string) {
  const pieces = await tx.orderItemVariant.findMany({
    where: { orderId, variantId: { not: null } },
    select: { variantId: true, quantity: true, freeQuantity: true },
  });
  if (pieces.length > 0) {
    const order = await tx.order.findFirst({ where: { id: orderId }, select: { companyId: true, storeId: true, sourceWarehouseId: true } });
    if (order && (await variantsArePlaced(tx, order.storeId))) {
      await drawPlacedVariants(
        tx,
        { companyId: order.companyId, storeId: order.storeId, orderId, sourceWarehouseId: order.sourceWarehouseId ?? null },
        pieces.map((x) => ({ variantId: x.variantId!, quantity: x.quantity + x.freeQuantity }))
      );
      return;
    }
  }
  for (const x of pieces) {
    const row = await tx.productVariant.findFirst({ where: { id: x.variantId! }, select: { onHand: true } });
    if (!row) continue;
    await tx.productVariant.update({ where: { id: x.variantId! }, data: { onHand: Math.max(0, row.onHand - x.quantity - x.freeQuantity) } });
  }
}

/**
 * A COUNTED RETURN puts `take` pieces of a line's product back — onto the combinations they left, in the line's own
 * order (paid pieces, then gifts). The returns desk counts per line, not per combination, so on a partial return the
 * first pieces of the line are the ones restored; a wrong guess is put right from the product's variants screen.
 *
 * 19/11 (W8a): in a placed store the pieces go back onto `warehouseId` — the warehouse the returns desk names, passed
 * by W2b when it is built — and with none named onto «بلا مكان», where the product's own return batch lands today.
 */
export async function restoreVariants(tx: Tx, p: { orderId: string; productId: string; take: number; warehouseId?: string | null }) {
  let left = p.take;
  if (left <= 0) return;
  const pieces = await tx.orderItemVariant.findMany({
    where: { orderId: p.orderId, productId: p.productId, variantId: { not: null } },
    orderBy: { createdAt: 'asc' },
    select: { variantId: true, quantity: true, freeQuantity: true },
  });
  if (pieces.length > 0) {
    const order = await tx.order.findFirst({ where: { id: p.orderId }, select: { companyId: true, storeId: true } });
    if (order && (await variantsArePlaced(tx, order.storeId))) {
      for (const x of pieces) {
        if (left <= 0) break;
        const back = Math.min(left, x.quantity + x.freeQuantity);
        left -= back;
        await restorePlacedVariant(
          tx,
          { companyId: order.companyId, storeId: order.storeId, orderId: p.orderId, warehouseId: p.warehouseId ?? null },
          { variantId: x.variantId!, quantity: back }
        );
      }
      return;
    }
  }
  for (const x of pieces) {
    if (left <= 0) break;
    const back = Math.min(left, x.quantity + x.freeQuantity);
    left -= back;
    await tx.productVariant.update({ where: { id: x.variantId! }, data: { onHand: { increment: back } } });
  }
}
