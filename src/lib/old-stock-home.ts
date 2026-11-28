import { Prisma } from '@prisma/client';
import type { db as prismaDb } from './db';
import { splitBatch } from './batch-split';
import { addOnUnitsBack, lineUnitsBack } from './returning-units';
import { lockProductsStock } from './reservation';
import { leftWarehouseWhere } from './order-state';
import { placesOf } from './stock-places';
import { holdWarehousesStill, warehousesUnderCount } from './stock-count-freeze';
import { figureOf, unsourcedHolds, warehouseHolds, type WarehouseFigure, type WarehouseHold } from './warehouse-figures';

type Tx = Prisma.TransactionClient | typeof prismaDb;

/**
 * «كل إشي قديم من قدسيا» — THE OLD STOCK IS GIVEN ITS WAREHOUSE (the owner, 27/11).
 *
 * The opening placement left the units that were out with the courier with no warehouse, and their orders naming none. A
 * delivery of such an order drew from the oldest rows of the whole store — warehouse rows included — so a parcel that had
 * left one warehouse took units off another one's shelf. The owner's ruling: all of it left one warehouse. This press
 * writes exactly that, once per store:
 *
 *   1. every OLD order — gone from the building before the placement (or riding a trolley of that time), not finished,
 *      naming no warehouse — is named as that warehouse's, and so is every shipment of that time;
 *   2. every batch row with no warehouse (not on a road) joins it;
 *   3. units the old draw took from ANOTHER warehouse go back to it, from the home warehouse's free units — the person
 *      pressing confirms each figure. The suggestion is what that warehouse's own ledger says went in, minus what it holds,
 *      never more than the units the sales naming no warehouse took since the placement;
 *   4. from then on an order that names no warehouse draws from the home warehouse first (`stock-consumption.ts`).
 *
 * It moves units between places inside one store. The store's «على الرف», «محجوز» and «متاح» do not move; no movement is
 * written (a split writes none, as the placement writes none) and no money is touched. The audit line carries the story.
 */

export type OldStockCode =
  | 'NOT_PLACED'
  | 'ALREADY_DONE'
  | 'WAREHOUSE_NOT_FOUND'
  | 'WAREHOUSE_STOPPED'
  | 'WAREHOUSE_OTHER_COUNTRY'
  | 'WAREHOUSE_COUNTING'
  | 'RESTORE_INVALID'
  | 'RESTORE_SHORT'
  | 'COMBINATIONS';

const REFUSALS: Record<OldStockCode, { status: number; ar: string }> = {
  NOT_PLACED: { status: 409, ar: 'هالمتجر لسا مش موزّع على المخازن. التوزيع أول.' },
  ALREADY_DONE: { status: 409, ar: 'البضاعة القديمة انضمّت لمخزنها من قبل. حدّث الصفحة.' },
  WAREHOUSE_NOT_FOUND: { status: 404, ar: 'المخزن مش موجود. حدّث الصفحة.' },
  WAREHOUSE_STOPPED: { status: 409, ar: 'هالمخزن موقوف. اختار مخزن شغّال.' },
  WAREHOUSE_OTHER_COUNTRY: { status: 400, ar: 'هالمخزن مش ببلد هالمتجر.' },
  WAREHOUSE_COUNTING: { status: 409, ar: 'في جرد مفتوح على مخزن من المخازن. خلّصه أو الغيه أول.' },
  RESTORE_INVALID: { status: 400, ar: 'في سطر إرجاع مش مفهوم: منتج من هالمتجر، ومخزن غير مخزن القديم، وعدد صحيح أكبر من صفر، وكل واحد مرة.' },
  RESTORE_SHORT: { status: 409, ar: 'متاح مخزن القديم ما بيكفي لهالعدد. صغّر «بيرجعلو».' },
  COMBINATIONS: { status: 409, ar: 'في منتج بخيارات (مقاس/لون) إلو بضاعة قديمة، وهاد الباب ما بينقل الخيارات. راجع المبرمج.' },
};

export class OldStockRefused extends Error {
  readonly status: number;
  readonly errorAr: string;
  constructor(
    readonly code: OldStockCode,
    errorAr?: string
  ) {
    super(errorAr ?? REFUSALS[code].ar);
    this.name = 'OldStockRefused';
    this.status = REFUSALS[code].status;
    this.errorAr = errorAr ?? REFUSALS[code].ar;
  }
}

export interface Restore {
  productId: string;
  warehouseId: string;
  quantity: number;
}

/**
 * Gone from the building, and OLD: it shipped or had its waybill printed before the placement, or it rides a trolley of that
 * time (a trolley with no warehouse), or it was written before the placement and is on no trolley and no hold. A parcel of
 * AFTER the placement that «أجّل الشحن» took off a warehouse's trolley (its warehouse is cleared, its waybill stays) is not
 * old: naming it would hold units against a warehouse that never had them.
 */
export function oldAndGone(placedAt: Date): Prisma.OrderWhereInput {
  return {
    AND: [
      leftWarehouseWhere(),
      {
        OR: [
          { shippedAt: { lt: placedAt } },
          { labelPrintedAt: { lt: placedAt } },
          { shippingBatch: { is: { warehouseId: null } } },
          { createdAt: { lt: placedAt }, shippingBatchId: null, shipHoldUntil: null },
        ],
      },
    ],
  };
}

/** The orders the press names: this store's, old and gone, not finished, naming no warehouse. */
export function oldOrdersWhere(companyId: string, storeId: string, placedAt: Date): Prisma.OrderWhereInput {
  return {
    companyId,
    storeId,
    sourceWarehouseId: null,
    confirmationStatus: { notIn: ['REJECTED', 'CANCELLED'] },
    shippingStatus: { notIn: ['DELIVERED', 'CANCELLED'] },
    ...oldAndGone(placedAt),
  };
}

export interface OldStockFacts {
  warehouses: { id: string; name: string }[];
  products: { id: string; name: string; sku: string | null }[];
  rows: { productId: string; quantityRemaining: number; warehouseId: string | null; inTransitTransferId: string | null }[];
  holds: Map<string, Map<string, WarehouseHold>>;
  /** Units held by old orders, per product. */
  oldHeld: Map<string, number>;
  /** Σ of the ledger lines that name a warehouse, per `warehouseId|productId`. */
  ledger: Map<string, number>;
  /** Units the sales naming NO warehouse took since the placement, per product — the most that can have been taken wrongly. */
  looseSales: Map<string, number>;
  /** Products with active combinations (size/colour). */
  combined: Set<string>;
  orders: number;
}

export interface OldStockRow {
  productId: string;
  name: string;
  sku: string | null;
  /** Units with no warehouse that will join the home warehouse. */
  unplaced: number;
  /** Units old orders still hold — they become the home warehouse's «محجوز». */
  oldHeld: number;
  warehouses: {
    id: string;
    before: WarehouseFigure;
    after: WarehouseFigure;
    /** Units this warehouse gets back (0 for the home one). */
    restore: number;
    /** What its own ledger says is missing — the box's first figure. */
    suggested: number;
  }[];
}

export async function readOldStockFacts(tx: Tx, companyId: string, storeId: string, placedAt: Date): Promise<OldStockFacts> {
  const store = await tx.store.findFirst({ where: { id: storeId, companyId }, select: { countryId: true } });
  if (!store) throw new OldStockRefused('NOT_PLACED');
  const [warehouses, products] = await Promise.all([
    tx.warehouse.findMany({
      where: { companyId, countryId: store.countryId, isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    tx.product.findMany({ where: { companyId, storeId }, orderBy: { name: 'asc' }, select: { id: true, name: true, sku: true } }),
  ]);
  const productIds = products.map((p) => p.id);
  const warehouseIds = warehouses.map((w) => w.id);
  const [rows, holds, oldHeld, lines, orders, sales, variants] = await Promise.all([
    tx.productionBatch.findMany({
      where: { companyId, storeId, productId: { in: productIds } },
      select: { productId: true, quantityRemaining: true, warehouseId: true, inTransitTransferId: true },
    }),
    warehouseHolds(tx, { companyId, storeId, warehouseIds, productIds }),
    unsourcedHolds(tx, { companyId, storeId, productIds, left: oldAndGone(placedAt) as Record<string, unknown> }),
    tx.inventoryMovement.groupBy({
      by: ['warehouseId', 'productId'],
      where: { companyId, storeId, warehouseId: { in: warehouseIds } },
      _sum: { quantity: true },
    }),
    tx.order.count({ where: oldOrdersWhere(companyId, storeId, placedAt) }),
    tx.inventoryMovement.groupBy({
      by: ['productId'],
      // A READ of the sale lines (`stock-consumption` alone writes one).
      where: { companyId, storeId, type: { in: ['SALE'] }, warehouseId: null, createdAt: { gte: placedAt } },
      _sum: { quantity: true },
    }),
    tx.productVariant.findMany({ where: { companyId, status: 'ACTIVE', productId: { in: productIds } }, select: { productId: true } }),
  ]);
  const written = new Map<string, number>(lines.map((l) => [`${l.warehouseId}|${l.productId}`, l._sum?.quantity ?? 0]));
  const refused = await refusedSince(tx, companyId, storeId, placedAt);
  const ledger = correctedLedger(written, refused.receipts, refused.damagedBack);
  const looseSales = new Map<string, number>(sales.map((s) => [s.productId, Math.max(0, -(s._sum?.quantity ?? 0))]));
  return { warehouses, products, rows, holds, oldHeld, ledger, looseSales, combined: new Set(variants.map((v) => v.productId)), orders };
}

/** One refused parcel received since the placement, as the books moved its sound units with no ledger line. */
export interface RefusedReceipt {
  /** The warehouse that received it. */
  into: string;
  /** The warehouse the order named; null = none (an old order). */
  from: string | null;
  /** The units split into the receiver («movedToWarehouse» of the receipt's audit line). */
  moved: number;
  /** The order's lines then its add-ons, in the receipt's order: what each still owed back. */
  lines: { productId: string; units: number }[];
}

/**
 * THE LEDGER PUT RIGHT — pure. A refused parcel's sound units reach the receiving warehouse by a SPLIT (no ledger line),
 * and a line with broken units comes back there as a `DMG-` batch (its only line writes the BROKEN units, at the warehouse
 * they were drawn from). Either way, when the receiver is not that warehouse, the receiver's «what its ledger says went in»
 * is too low by the sound units and the other's too high by them. Received where they came from, nothing is missing.
 * The split units are laid over the order's lines in their order, as the receipt moved them.
 */
export function correctedLedger(
  ledger: ReadonlyMap<string, number>,
  receipts: readonly RefusedReceipt[],
  damagedBack: readonly { warehouseId: string; from: string | null; productId: string; quantity: number }[]
): Map<string, number> {
  const out = new Map(ledger);
  const add = (warehouseId: string, productId: string, n: number) => {
    const key = `${warehouseId}|${productId}`;
    out.set(key, (out.get(key) ?? 0) + n);
  };
  for (const r of receipts) {
    if (r.from === r.into) continue;
    let left = r.moved;
    for (const line of r.lines) {
      if (left <= 0) break;
      const n = Math.min(left, Math.max(0, line.units));
      if (n === 0) continue;
      add(r.into, line.productId, n);
      if (r.from) add(r.from, line.productId, -n);
      left -= n;
    }
  }
  for (const d of damagedBack) {
    if (d.from === d.warehouseId) continue;
    add(d.warehouseId, d.productId, d.quantity);
    if (d.from) add(d.from, d.productId, -d.quantity);
  }
  return out;
}

/** «DMG-<order number>-<6 of the product>» → the order number. */
const orderOf = (batchNumber: string) => batchNumber.slice('DMG-'.length, batchNumber.lastIndexOf('-'));

/** The two ledgerless ways a refused parcel's units reached a warehouse since the placement, read back. */
async function refusedSince(tx: Tx, companyId: string, storeId: string, placedAt: Date) {
  const [audits, damaged] = await Promise.all([
    tx.auditLog.findMany({
      where: { companyId, action: 'RETURN_RECEIVED', createdAt: { gte: placedAt } },
      orderBy: { createdAt: 'asc' },
      select: { entityId: true, newData: true },
    }),
    tx.productionBatch.findMany({
      where: { companyId, storeId, batchNumber: { startsWith: 'DMG-' }, createdAt: { gte: placedAt }, warehouseId: { not: null } },
      select: { id: true, batchNumber: true, warehouseId: true, productId: true, quantityProduced: true },
    }),
  ]);
  // Where each `DMG-` batch's units were drawn from: the warehouse its own DAMAGE line names (none = an old order's).
  const brokenLines = damaged.length
    ? await tx.inventoryMovement.findMany({
        where: { companyId, storeId, type: { in: ['DAMAGE'] }, batchId: { in: damaged.map((d) => d.id) } },
        select: { batchId: true, warehouseId: true },
      })
    : [];
  const drawnFrom = new Map(brokenLines.map((l) => [l.batchId as string, l.warehouseId ?? null]));
  // No line (the shelf came up short): the warehouse the order names.
  const lineless = damaged.filter((d) => !drawnFrom.has(d.id));
  const named = lineless.length
    ? await tx.order.findMany({
        where: { companyId, storeId, orderNumber: { in: lineless.map((d) => orderOf(d.batchNumber)) } },
        select: { orderNumber: true, sourceWarehouseId: true },
      })
    : [];
  for (const d of lineless) drawnFrom.set(d.id, named.find((o) => o.orderNumber === orderOf(d.batchNumber))?.sourceWarehouseId ?? null);
  const said = audits.flatMap((a) => {
    try {
      const d = JSON.parse(a.newData ?? '{}') as { warehouseId?: unknown; movedToWarehouse?: unknown };
      return typeof d.warehouseId === 'string' && typeof d.movedToWarehouse === 'number' && d.movedToWarehouse > 0
        ? [{ orderId: a.entityId, into: d.warehouseId, moved: d.movedToWarehouse }]
        : [];
    } catch {
      return [];
    }
  });
  const orders = said.length
    ? await tx.order.findMany({
        where: { companyId, storeId, id: { in: said.map((s) => s.orderId) } },
        select: {
          id: true,
          sourceWarehouseId: true,
          items: { select: { productId: true, quantity: true, freeQuantity: true, deliveredQty: true } },
          addOns: { select: { productId: true, quantity: true } },
        },
      })
    : [];
  const byId = new Map(orders.map((o) => [o.id, o]));
  const receipts: RefusedReceipt[] = said.flatMap((s) => {
    const o = byId.get(s.orderId);
    if (!o) return [];
    const lines = [
      ...o.items.map((i) => ({ productId: i.productId, units: lineUnitsBack(i) })),
      ...(o.addOns ?? []).map((a) => ({ productId: a.productId, units: addOnUnitsBack(o.items, a) })),
    ];
    return [{ into: s.into, from: o.sourceWarehouseId ?? null, moved: s.moved, lines }];
  });
  return {
    receipts,
    damagedBack: damaged.map((d) => ({
      warehouseId: d.warehouseId!,
      from: drawnFrom.get(d.id) ?? null,
      productId: d.productId,
      quantity: d.quantityProduced,
    })),
  };
}

/**
 * THE TABLE — pure: what each warehouse holds now, and after the press with this home and these restores. `restores`
 * left out = the suggestions. A product with nothing to move is not listed.
 */
export function planOldStock(facts: OldStockFacts, homeWarehouseId: string, restores?: readonly Restore[]): OldStockRow[] {
  const out: OldStockRow[] = [];
  for (const product of facts.products) {
    const places = placesOf(facts.rows.filter((r) => r.productId === product.id));
    const unplaced = places.unplaced;
    const oldHeld = facts.oldHeld.get(product.id) ?? 0;
    const onHandOf = new Map(places.warehouses.map((w) => [w.id, w.onHand]));
    // What the home warehouse will have FREE after taking the old stock: only that can go back to another one.
    const homeHold = facts.holds.get(homeWarehouseId)?.get(product.id);
    const homeFree = figureOf((onHandOf.get(homeWarehouseId) ?? 0) + unplaced, homeHold).free - oldHeld;
    let left = facts.combined.has(product.id) ? 0 : Math.max(0, Math.min(homeFree, facts.looseSales.get(product.id) ?? 0));
    const cells = facts.warehouses.map((w) => {
      const onHand = onHandOf.get(w.id) ?? 0;
      const ledger = facts.ledger.get(`${w.id}|${product.id}`);
      let suggested = 0;
      if (w.id !== homeWarehouseId && ledger !== undefined) {
        suggested = Math.min(left, Math.max(0, ledger - onHand));
        left -= suggested;
      }
      const asked = restores?.find((r) => r.productId === product.id && r.warehouseId === w.id)?.quantity;
      const restore = w.id === homeWarehouseId ? 0 : restores ? (asked ?? 0) : suggested;
      return { id: w.id, onHand, restore, suggested };
    });
    const given = cells.reduce((s, c) => s + c.restore, 0);
    if (unplaced === 0 && oldHeld === 0 && given === 0 && cells.every((c) => c.suggested === 0)) continue;
    out.push({
      productId: product.id,
      name: product.name,
      sku: product.sku,
      unplaced,
      oldHeld,
      warehouses: cells.map((c) => {
        const hold = facts.holds.get(c.id)?.get(product.id);
        const home = c.id === homeWarehouseId;
        return {
          id: c.id,
          before: figureOf(c.onHand, hold),
          after: figureOf(
            home ? c.onHand + unplaced - given : c.onHand + c.restore,
            home ? { reserved: (hold?.reserved ?? 0) + oldHeld, pending: hold?.pending ?? 0 } : hold
          ),
          restore: c.restore,
          suggested: c.suggested,
        };
      }),
    });
  }
  return out;
}

/** THE PRESS — inside ONE transaction, once per store. */
export async function moveOldStockHome(
  tx: Tx,
  input: { companyId: string; storeId: string; homeWarehouseId: string; restores: readonly Restore[]; userId: string; now?: Date }
) {
  const { companyId, storeId, homeWarehouseId, restores } = input;
  const placement = await tx.warehousePlacement.findUnique({ where: { storeId }, select: { id: true, oldStockWarehouseId: true, createdAt: true } });
  if (!placement) throw new OldStockRefused('NOT_PLACED');
  if (placement.oldStockWarehouseId) throw new OldStockRefused('ALREADY_DONE');

  const store = await tx.store.findFirst({ where: { id: storeId, companyId }, select: { countryId: true } });
  const named = [...new Set([homeWarehouseId, ...restores.map((r) => r.warehouseId)])];
  const found = await tx.warehouse.findMany({ where: { companyId, id: { in: named } }, select: { id: true, countryId: true, isActive: true } });
  for (const id of named) {
    const w = found.find((x) => x.id === id);
    if (!w) throw new OldStockRefused('WAREHOUSE_NOT_FOUND');
    if (w.countryId !== store?.countryId) throw new OldStockRefused('WAREHOUSE_OTHER_COUNTRY');
    if (!w.isActive) throw new OldStockRefused('WAREHOUSE_STOPPED');
  }
  await holdWarehousesStill(tx, named);
  if ((await warehousesUnderCount(tx, named)).size > 0) throw new OldStockRefused('WAREHOUSE_COUNTING');

  const productIds = (await tx.product.findMany({ where: { companyId, storeId }, select: { id: true } })).map((p) => p.id);
  const known = new Set(productIds);
  const seen = new Set<string>();
  for (const r of restores) {
    const key = `${r.warehouseId}|${r.productId}`;
    if (!known.has(r.productId) || r.warehouseId === homeWarehouseId || !Number.isInteger(r.quantity) || r.quantity <= 0 || seen.has(key)) {
      throw new OldStockRefused('RESTORE_INVALID');
    }
    seen.add(key);
  }
  // Every product's lock before anything is read: the book these places divide is the book nobody else is changing.
  await lockProductsStock(tx, companyId, productIds);

  // The claim and the answer in one write: of two presses at once, the second matches nothing.
  const claimed = await tx.warehousePlacement.updateMany({
    where: { id: placement.id, oldStockWarehouseId: null },
    data: { oldStockWarehouseId: homeWarehouseId, oldStockMovedAt: input.now ?? new Date() },
  });
  if (claimed.count !== 1) throw new OldStockRefused('ALREADY_DONE');

  const facts = await readOldStockFacts(tx, companyId, storeId, placement.createdAt);
  const before = planOldStock(facts, homeWarehouseId, restores);
  // A product with combinations that has old stock, or is asked back: refused whole — its pieces live in places of their own.
  if (before.some((r) => facts.combined.has(r.productId))) throw new OldStockRefused('COMBINATIONS');
  // Nothing goes back out of units the home warehouse's own orders hold.
  const short = before.some(
    (r) => r.warehouses.some((w) => w.restore > 0) && (r.warehouses.find((w) => w.id === homeWarehouseId)?.after.free ?? 0) < 0
  );
  if (short) throw new OldStockRefused('RESTORE_SHORT');

  // Named by a statement that leaves `updatedAt` alone: a stamp is not work on the order, and the screens that age returns,
  // warn about a recent one or count «closed today» read that column.
  const old = await tx.order.findMany({ where: oldOrdersWhere(companyId, storeId, placement.createdAt), select: { id: true } });
  let stamped = 0;
  for (let i = 0; i < old.length; i += 1000) {
    const ids = old.slice(i, i + 1000).map((o) => o.id);
    stamped += await tx.$executeRaw`UPDATE "orders" SET "sourceWarehouseId" = ${homeWarehouseId} WHERE "companyId" = ${companyId} AND "storeId" = ${storeId} AND "sourceWarehouseId" IS NULL AND "id" IN (${Prisma.join(ids)})`;
  }
  // The shipments of that time that have left: named, so a second «assign» never clears an order's stamp. A trolley still
  // being packed is left as it is — named, it would take new parcels beside old ones.
  await tx.shippingBatch.updateMany({
    where: { companyId, storeId, warehouseId: null, createdAt: { lt: placement.createdAt }, status: { not: 'READY' } },
    data: { warehouseId: homeWarehouseId },
  });
  const rows = await tx.productionBatch.updateMany({
    where: { companyId, storeId, warehouseId: null, inTransitTransferId: null, quantityRemaining: { not: 0 } },
    data: { warehouseId: homeWarehouseId },
  });

  for (const r of restores) {
    let left = r.quantity;
    const shelf = await tx.productionBatch.findMany({
      where: { companyId, storeId, productId: r.productId, warehouseId: homeWarehouseId, inTransitTransferId: null, quantityRemaining: { gt: 0 } },
      orderBy: [{ productionDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, quantityRemaining: true },
    });
    for (const b of shelf) {
      if (left <= 0) break;
      const take = Math.min(b.quantityRemaining, left);
      await splitBatch(tx, { companyId, batchId: b.id, quantity: take, to: { warehouseId: r.warehouseId } });
      left -= take;
    }
    if (left > 0) throw new OldStockRefused('RESTORE_SHORT');
  }

  return { rows: before, orders: stamped, batchRows: rows.count };
}
