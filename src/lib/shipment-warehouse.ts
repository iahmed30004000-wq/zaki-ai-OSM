import type { Prisma } from '@prisma/client';
import { db } from './db';
import { holdingWhere } from './reservation';
import type { WarehouseRef } from './warehouse-intake';
import { freeStockOf } from './stock-transfers';

type Tx = Prisma.TransactionClient | typeof db;

/**
 * A SHIPMENT IS MADE IN ONE WAREHOUSE (the warehouse plan, request W4a).
 *
 * For a store whose stock is PLACED in warehouses (`warehouse_placements` has its row), the person who creates a
 * shipment names the warehouse it leaves from (the owner's decision 3, default: the person creating the shipment
 * chooses). Then:
 *   - the trolley carries that warehouse (`ShippingBatch.warehouseId`) and never mixes warehouses: the «one open trolley
 *     per courier» rule becomes «one open trolley per courier AND warehouse»;
 *   - every order that joins is stamped `Order.sourceWarehouseId`; an order taken off the trolley while it is still in
 *     the building loses the stamp (`shipment-cancel.leavesTheTrolley` / `leavesTheShipment`);
 *   - the stock blocks ask the FREE stock of that warehouse (`stock-transfers.freeStockOf` — the one formula, shared with
 *     the transfer door) with today's hard / soft rule (`allowNegativeStock`), and a shortage names the other warehouses
 *     of the store that do hold the units.
 *
 * A store that is NOT placed asks none of this: `shipmentPlace` answers `null` whatever the body carried, and every door
 * writes and answers exactly as it did before the warehouses existed (pinned by `shipment-blocks.main-golden.json`).
 *
 * NOTHING HERE CHANGES A RESERVATION. The reservation stays the store's promise (`OrderItem.reservedQty`); this file only
 * reads it, through the reservation's own «still holding» rule (`reservation.holdingWhere`, with the store's filter, so a
 * bench store's orders never count). The delivery still draws from the store as today — taking the units from the
 * order's warehouse is request W4b, not this one.
 *
 * NO MONEY. Nothing here reads or writes a wallet, an expense, a profit or a cost.
 */

export type ShipmentPlaceRefusalCode =
  | 'WAREHOUSE_REQUIRED'
  | 'WAREHOUSE_NOT_FOUND'
  | 'WAREHOUSE_OTHER_COUNTRY'
  | 'WAREHOUSE_STOPPED'
  | 'WAREHOUSE_NOT_REACHED';

const REFUSALS: Record<ShipmentPlaceRefusalCode, { status: number; ar: string }> = {
  WAREHOUSE_REQUIRED: { status: 400, ar: 'هالمتجر موزّع على مخازن. اختار المخزن اللي طالعة منه الشحنة.' },
  WAREHOUSE_NOT_FOUND: { status: 400, ar: 'المخزن مش موجود. حدّث الصفحة واختار من جديد.' },
  WAREHOUSE_OTHER_COUNTRY: { status: 400, ar: 'هالمخزن مش ببلد هالمتجر، وما بيشيل بضاعته.' },
  WAREHOUSE_STOPPED: { status: 409, ar: 'هالمخزن موقوف. اعمل الشحنة من مخزن تاني.' },
  WAREHOUSE_NOT_REACHED: { status: 403, ar: 'ما إلك وصول على هالمخزن. اعمل الشحنة من مخزن من مخازنك.' },
};

export class ShipmentPlaceRefused extends Error {
  readonly status: number;
  readonly errorAr: string;
  constructor(readonly code: ShipmentPlaceRefusalCode) {
    super(REFUSALS[code].ar);
    this.name = 'ShipmentPlaceRefused';
    this.status = REFUSALS[code].status;
    this.errorAr = REFUSALS[code].ar;
  }
}

/** The JSON a door answers with: an Arabic sentence and a stable code. */
export function shipmentPlaceBody(e: ShipmentPlaceRefused) {
  return { error: e.errorAr, errorAr: e.errorAr, code: e.code };
}

/** The warehouse a shipment leaves from: its id and its name (the name goes into the refusal sentences). */
export interface ShipmentWarehouse {
  id: string;
  name: string;
}

/**
 * Where this shipment leaves from: `null` for a store that is not placed (the body's warehouse is then not read, not
 * checked, not stored), otherwise the checked warehouse — of the store's company and country, running, and one the caller
 * reaches (`mayUse`: the door passes `warehouses.reachesWarehouse` for the session). Throws `ShipmentPlaceRefused`.
 */
export async function shipmentPlace(
  tx: Tx,
  input: {
    companyId: string;
    storeId: string | null | undefined;
    warehouseId?: unknown;
    mayUse: (warehouse: WarehouseRef) => Promise<boolean>;
  }
): Promise<ShipmentWarehouse | null> {
  if (!input.storeId) return null;
  /*
   * «Is this store placed?» is the question `warehouse-intake.storeIsPlaced` asks — its `warehouse_placements` row exists —
   * read here through the store's own relation, in the one read that also gives the store's country. (One statement for
   * an unplaced store, as the intake rule spends; nothing more is read for it.)
   */
  const store = await tx.store.findFirst({
    where: { id: input.storeId, companyId: input.companyId },
    select: { countryId: true, warehousePlacement: { select: { id: true } } },
  });
  if (!store?.warehousePlacement) return null;

  const warehouseId = typeof input.warehouseId === 'string' ? input.warehouseId.trim() : '';
  if (!warehouseId) throw new ShipmentPlaceRefused('WAREHOUSE_REQUIRED');

  const warehouse = await tx.warehouse.findFirst({
    where: { id: warehouseId, companyId: input.companyId },
    select: { id: true, companyId: true, countryId: true, isActive: true, name: true },
  });
  if (!warehouse) throw new ShipmentPlaceRefused('WAREHOUSE_NOT_FOUND');
  if (store.countryId !== warehouse.countryId) throw new ShipmentPlaceRefused('WAREHOUSE_OTHER_COUNTRY');
  if (!warehouse.isActive) throw new ShipmentPlaceRefused('WAREHOUSE_STOPPED');
  if (!(await input.mayUse({ id: warehouse.id, companyId: warehouse.companyId, countryId: warehouse.countryId }))) {
    throw new ShipmentPlaceRefused('WAREHOUSE_NOT_REACHED');
  }
  return { id: warehouse.id, name: warehouse.name };
}

/**
 * THE WAREHOUSES A PERSON MAY PICK ON THE SHIPPING SCREENS (W4c) — «التجهيز», «إنشاء شحنة» and «دفعات الشحن».
 *
 * `null` for a store that is not placed: the lists then answer without a `warehouses` field at all, and the screens draw
 * no picker — today's screens, today's requests. For a PLACED store: the running warehouses of the store's country, in
 * name order, that this person reaches (`reached` — the door passes `warehouses.warehousesReachedBy` for the session, the
 * same rule `shipmentPlace` asks with `reachesWarehouse`), so a warehouse offered here is never one the door refuses.
 * An empty list = placed, and she reaches none of them: the screen says so instead of offering nothing.
 * One read for a store that is not placed (the same read `shipmentPlace` makes); two more for a placed one.
 */
export async function shipmentWarehouseChoices(
  tx: Tx,
  input: {
    companyId: string;
    storeId: string | null | undefined;
    reached: (warehouses: WarehouseRef[]) => Promise<WarehouseRef[]>;
  }
): Promise<ShipmentWarehouse[] | null> {
  if (!input.storeId) return null;
  const store = await tx.store.findFirst({
    where: { id: input.storeId, companyId: input.companyId },
    select: { countryId: true, warehousePlacement: { select: { id: true } } },
  });
  if (!store?.warehousePlacement) return null;
  const running = await tx.warehouse.findMany({
    where: { companyId: input.companyId, countryId: store.countryId, isActive: true },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, companyId: true, countryId: true },
  });
  const ok = new Set((await input.reached(running.map(({ id, companyId, countryId }) => ({ id, companyId, countryId })))).map((w) => w.id));
  return running.filter((w) => ok.has(w.id)).map((w) => ({ id: w.id, name: w.name }));
}

/* ───────────────────────────── the warehouse's shelf ───────────────────────────── */

/**
 * What the stock blocks need to know of ONE warehouse for a set of products and orders:
 *   base         `freeStockOf` per product — Σ remaining of its rows (none on the road) − what orders already sourced from
 *                it still hold;
 *   own          what each listed order still holds itself, per product (the reservation's own «still holding» rule);
 *   stampedHere  the listed orders already sourced from this warehouse (their holds are inside `base`).
 */
export interface WarehouseShelf {
  warehouse: ShipmentWarehouse;
  base: Map<string, number>;
  own: Map<string, number>;
  stampedHere: Set<string>;
}

const ownKey = (orderId: string, productId: string) => `${orderId}|${productId}`;

export async function warehouseShelfFor(
  tx: Tx,
  p: { companyId: string; storeId: string; warehouse: ShipmentWarehouse; productIds: readonly string[]; orderIds: readonly string[] }
): Promise<WarehouseShelf> {
  const productIds = [...new Set(p.productIds)];
  const orderIds = [...new Set(p.orderIds)];
  const shelf: WarehouseShelf = { warehouse: p.warehouse, base: new Map(), own: new Map(), stampedHere: new Set() };
  if (productIds.length === 0) return shelf;

  shelf.base = await freeStockOf(tx, { companyId: p.companyId, storeId: p.storeId, warehouseId: p.warehouse.id, productIds });
  if (orderIds.length === 0) return shelf;

  const where = holdingWhere({ companyId: p.companyId, productId: { in: productIds }, orderId: { in: orderIds }, storeId: p.storeId });
  const [lines, addOns, stamped] = await Promise.all([
    tx.orderItem.findMany({ where, select: { orderId: true, productId: true, reservedQty: true } }),
    tx.orderAddOn.findMany({ where, select: { orderId: true, productId: true, reservedQty: true } }),
    tx.order.findMany({
      where: { companyId: p.companyId, storeId: p.storeId, id: { in: orderIds }, sourceWarehouseId: p.warehouse.id },
      select: { id: true },
    }),
  ]);
  for (const r of [...lines, ...addOns]) {
    const key = ownKey(r.orderId, r.productId);
    shelf.own.set(key, (shelf.own.get(key) ?? 0) + (r.reservedQty ?? 0));
  }
  for (const o of stamped) shelf.stampedHere.add(o.id);
  return shelf;
}

/**
 * The units of this product the warehouse can give THIS order — the warehouse's version of
 * `availableStock(…, exceptOrderId)`: the order's own hold never competes with itself, and every OTHER order of the same
 * press (`joining`) competes as if it were already sourced from here, because the press is about to make it so. Two orders
 * of five units each cannot both be promised the eight units of one warehouse.
 */
export function freeInWarehouse(shelf: WarehouseShelf, orderId: string, productId: string, joining: readonly string[]): number {
  let free = shelf.base.get(productId) ?? 0;
  if (shelf.stampedHere.has(orderId)) free += shelf.own.get(ownKey(orderId, productId)) ?? 0;
  for (const other of new Set(joining)) {
    if (other === orderId || shelf.stampedHere.has(other)) continue;
    free -= shelf.own.get(ownKey(other, productId)) ?? 0;
  }
  return free;
}

/**
 * The store's OTHER running warehouses and their free stock of these products — read only when a line is short, so the
 * sentence can say where the units are. Same formula (`freeStockOf`), same store filter.
 */
export async function otherWarehousesFree(
  tx: Tx,
  p: { companyId: string; storeId: string; exceptWarehouseId: string; productIds: readonly string[] }
): Promise<{ name: string; free: Map<string, number> }[]> {
  const productIds = [...new Set(p.productIds)];
  if (productIds.length === 0) return [];
  const store = await tx.store.findFirst({ where: { id: p.storeId, companyId: p.companyId }, select: { countryId: true } });
  if (!store) return [];
  const others = await tx.warehouse.findMany({
    where: { companyId: p.companyId, countryId: store.countryId, isActive: true, id: { not: p.exceptWarehouseId } },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });
  const out: { name: string; free: Map<string, number> }[] = [];
  for (const w of others) {
    out.push({ name: w.name, free: await freeStockOf(tx, { companyId: p.companyId, storeId: p.storeId, warehouseId: w.id, productIds }) });
  }
  return out;
}

/**
 * The sentence of a shortage in a warehouse. It names the warehouse that is short and, when another warehouse of the
 * store can cover the line, that one: «انقلها من هناك، أو اعمل الشحنة من هناك». A warehouse that holds some but not enough
 * is named only when none holds enough.
 */
export function warehouseShortageAr(p: {
  warehouseName: string;
  productName: string;
  addOn: boolean;
  missing: number;
  need: number;
  productId: string;
  others: readonly { name: string; free: Map<string, number> }[];
}): string {
  const head = `نقص مخزون بمخزن «${p.warehouseName}»: ${p.productName} (${p.addOn ? 'إضافة، ' : ''}ينقص ${p.missing})`;
  const enough = p.others.filter((w) => (w.free.get(p.productId) ?? 0) >= p.need).map((w) => w.name);
  const some = p.others.filter((w) => (w.free.get(p.productId) ?? 0) > 0).map((w) => w.name);
  const names = enough.length > 0 ? enough : some;
  if (names.length === 0) return head;
  const list = names.map((n) => `«${n}»`).join(' و');
  return `${head} — في منه بمخزن ${list}: انقله من هناك، أو اعمل الشحنة من هناك.`;
}
