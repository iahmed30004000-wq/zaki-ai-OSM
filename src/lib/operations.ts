import type { Prisma } from '@prisma/client';
import { db } from './db';
import { availableStock, freeFromPools, stockPoolsFor, type StockPools } from './reservation';
import { realStoresOnly } from './test-store';
/*
 * W4a: the warehouse's shelf is LOADED ONLY when a warehouse is asked about (`await import` below). A store that is not
 * placed never asks, so these functions run on exactly the modules they ran on before the warehouses existed.
 */
import type { ShipmentWarehouse, WarehouseShelf } from './shipment-warehouse';
const warehouseShelfModule = () => import('./shipment-warehouse');

type Tx = Prisma.TransactionClient | typeof db;

/**
 * OPERATIONS — preparation grouping and the blocking checks a shipment must
 * pass. Every number here is computed on the server; the screens render it.
 */

export interface PreparationLine {
  orderId: string;
  orderNumber: string;
  customerName: string;
  regionName: string | null;
  /** A change request still waiting on this order, if there is one. */
  pendingChangeRequestId: string | null;
  quantity: number;
  freeQuantity: number;
  reservedQty: number;
  /** The size and colour of every piece of this line (product variants), or null. */
  variantSummary?: string | null;
  confirmationStatus: string;
  shippingStatus: string;
}

export interface PreparationGroup {
  productId: string;
  productName: string;
  /** Orders waiting for this product. */
  orders: number;
  /** Units required across those orders, gift units included. */
  required: number;
  /** Units still available after everything already reserved elsewhere. */
  available: number;
  /** required - available, floored at zero. */
  shortage: number;
  lines: PreparationLine[];
}

/**
 * Preparation is grouped BY PRODUCT: the warehouse picks a product once, not
 * an order at a time. Shortage is the gap between what the confirmed orders
 * need and what is actually on the shelf.
 */
export async function preparationGroups(
  tx: Tx,
  scope: { companyId: string; storeId: string },
  /**
   * W4a: «available» of ONE warehouse of a placed store, asked by the preparation door with `?warehouse=`. Absent = the
   * store's shelf, exactly as before. The orders on this list are not on a trolley yet, so none of them is sourced from
   * the warehouse: what they hold is not inside the warehouse's free stock and is not added back.
   */
  place?: { warehouse: ShipmentWarehouse }
) {
  const items = await tx.orderItem.findMany({
    where: {
      companyId: scope.companyId,
      order: {
        storeId: scope.storeId,
        confirmationStatus: 'CONFIRMED',
        shippingStatus: { in: ['NOT_READY', 'PACKING'] },
        // A bench's orders stop at confirmation (`test-store.ts`, B2): never on the packing list — nor, through this one
        // function, in the picking assistant's.
        ...realStoresOnly(),
      },
    },
    select: {
      productId: true,
      productName: true,
      quantity: true,
      freeQuantity: true,
      reservedQty: true,
      variantSummary: true,
      order: {
        select: {
          id: true, orderNumber: true, confirmationStatus: true, shippingStatus: true,
          customer: { select: { fullName: true } },
          region: { select: { name: true } },
          // A change request waiting on this order is the one thing the
          // packer must see BEFORE the box is taped: packing to an address
          // somebody is asking to change is work done twice.
          changeRequests: { where: { status: 'PENDING' }, select: { id: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  const byProduct = new Map<string, PreparationGroup>();
  for (const item of items) {
    const group = byProduct.get(item.productId) ?? {
      productId: item.productId,
      productName: item.productName,
      orders: 0,
      required: 0,
      available: 0,
      shortage: 0,
      lines: [],
    };
    group.orders++;
    group.required += item.quantity + item.freeQuantity;
    group.lines.push({
      orderId: item.order.id,
      orderNumber: item.order.orderNumber,
      customerName: item.order.customer.fullName,
      regionName: item.order.region?.name ?? null,
      pendingChangeRequestId: item.order.changeRequests?.[0]?.id ?? null,
      quantity: item.quantity,
      freeQuantity: item.freeQuantity,
      reservedQty: item.reservedQty,
      variantSummary: item.variantSummary ?? null,
      confirmationStatus: item.order.confirmationStatus,
      shippingStatus: item.order.shippingStatus,
    });
    byProduct.set(item.productId, group);
  }

  if (place) {
    const { warehouseShelfFor } = await warehouseShelfModule();
    const shelf = await warehouseShelfFor(tx, {
      companyId: scope.companyId,
      storeId: scope.storeId,
      warehouse: place.warehouse,
      productIds: [...byProduct.keys()],
      orderIds: [...new Set(items.map((i) => i.order.id))],
    });
    for (const group of byProduct.values()) {
      // An order of this list already sourced from the warehouse (none, in practice: it would be on a trolley) is inside
      // the free stock; its own hold is added back, as the store's version adds back the holds of these very orders.
      const sourcedHere = group.lines.filter((l) => shelf.stampedHere.has(l.orderId)).reduce((s, l) => s + l.reservedQty, 0);
      group.available = (shelf.base.get(group.productId) ?? 0) + sourcedHere;
      group.shortage = Math.max(0, group.required - group.available);
    }
    return [...byProduct.values()].sort((a, b) => b.shortage - a.shortage || b.orders - a.orders);
  }

  for (const group of byProduct.values()) {
    // Reservations of these very orders are part of "available": they are
    // already earmarked for them, not competing with them.
    const reservedHere = group.lines.reduce((s, l) => s + l.reservedQty, 0);
    const free = await availableStock(tx, scope.companyId, group.productId, undefined, scope.storeId);
    group.available = free + reservedHere;
    group.shortage = Math.max(0, group.required - group.available);
  }

  return [...byProduct.values()].sort((a, b) => b.shortage - a.shortage || b.orders - a.orders);
}

export type BlockCode =
  | 'DUPLICATE_IN_BATCH'
  | 'PREVIOUS_SHIPMENT_IN_TRANSIT'
  | 'RECENT_RETURN'
  | 'STOCK_SHORTAGE'
  | 'NO_REGION'
  | 'NO_FEE_ROW'
  | 'UNRESERVED_LINES';

export interface OrderBlock {
  code: BlockCode;
  message: string;
  /** false = the operator may acknowledge and continue; true = hard stop. */
  hard: boolean;
  /** What to do about it, when there is something to do — a second sentence, never part of the door's own words. */
  hint?: string;
}

const RECENT_RETURN_DAYS = 30;
const IN_TRANSIT = ['SHIPPED', 'OUT_FOR_DELIVERY'];

/**
 * Blocking warnings for one order before it joins a shipment. The operator
 * may acknowledge the soft ones; a hard block (stock shortage with negative
 * stock disallowed) creates no shipment row at all.
 */
/**
 * THE TWO HARD BLOCKS ABOUT THE DELIVERY FEE, WRITTEN ONCE (3/11).
 *
 * An order with no governorate cannot be priced, and a governorate with no active fee row at the courier is priced at
 * zero — the courier would collect the goods without the delivery. `shipmentBlocks` asks it of one order; the file of the
 * ready orders (`GET /api/ops/shipments/export`) asks it of the whole list with one read of the fee rows
 * (`activeFeeRowWhere` with `{ in: [...] }`). Same row, same rule, same words.
 */
export function activeFeeRowWhere(deliveryProviderId: string, regionId: string | { in: string[] }) {
  return { deliveryProviderId, regionId, isActive: true };
}

/** `hasFeeRow` is whether an active fee row exists for the order's governorate at the courier (not asked without one). */
export function deliveryFeeBlock(regionId: string | null, hasFeeRow: boolean): OrderBlock | null {
  if (!regionId) return { code: 'NO_REGION', message: 'لم تُحدَّد المحافظة — لا يمكن حساب أجرة التوصيل', hard: true };
  if (!hasFeeRow) return { code: 'NO_FEE_ROW', message: 'لا توجد أجرة توصيل لهذه المحافظة عند هذه الشركة', hard: true };
  return null;
}

export async function shipmentBlocks(
  tx: Tx,
  order: {
    id: string;
    companyId: string;
    /** Whose stock this order may draw on. */
    storeId: string | null;
    customerId: string;
    regionId: string | null;
    deliveryProviderId: string | null;
  },
  opts: {
    allowNegativeStock: boolean;
    batchOrderIds?: string[];
    /**
     * W4a: the warehouse a PLACED store's shipment leaves from (`shipment-warehouse.shipmentPlace`). The stock question is
     * then asked of that warehouse's free stock. Absent = the store's shelf, exactly as before.
     */
    warehouse?: ShipmentWarehouse;
  }
): Promise<OrderBlock[]> {
  const blocks: OrderBlock[] = [];

  if (opts.batchOrderIds && opts.batchOrderIds.filter((id) => id === order.id).length > 1) {
    blocks.push({ code: 'DUPLICATE_IN_BATCH', message: 'الطلب مكرر داخل نفس الدفعة', hard: false });
  }

  const inTransit = await tx.order.count({
    where: {
      companyId: order.companyId,
      customerId: order.customerId,
      id: { not: order.id },
      shippingStatus: { in: IN_TRANSIT },
    },
  });
  if (inTransit > 0) {
    blocks.push({
      code: 'PREVIOUS_SHIPMENT_IN_TRANSIT',
      message: `للعميل ${inTransit} شحنة قيد التوصيل`,
      hard: false,
    });
  }

  const since = new Date(Date.now() - RECENT_RETURN_DAYS * 24 * 60 * 60 * 1000);
  const recentReturn = await tx.order.count({
    where: {
      companyId: order.companyId,
      customerId: order.customerId,
      id: { not: order.id },
      shippingStatus: { in: ['RETURNED', 'RETURN_REQUESTED'] },
      OR: [{ returnedAt: { gte: since } }, { updatedAt: { gte: since } }],
    },
  });
  if (recentReturn > 0) {
    blocks.push({ code: 'RECENT_RETURN', message: `للعميل ${recentReturn} مرتجع خلال ${RECENT_RETURN_DAYS} يوماً`, hard: false });
  }

  if (!order.regionId) {
    blocks.push(deliveryFeeBlock(null, false)!);
  } else if (order.deliveryProviderId) {
    const fee = await tx.deliveryFee.findFirst({
      where: activeFeeRowWhere(order.deliveryProviderId, order.regionId),
      select: { id: true },
    });
    const block = deliveryFeeBlock(order.regionId, !!fee);
    if (block) blocks.push(block);
  }

  const lines = await tx.orderItem.findMany({
    where: { orderId: order.id },
    select: { productId: true, productName: true, quantity: true, freeQuantity: true, reservedQty: true },
  });
  /*
   * THE CUSTOMER'S ADDITIONS AFTER THE ORDER ARE GOODS IN THE BOX TOO.
   *
   * Only the lines were asked about, so an add-on the shelf could not cover was shipped (and collected for) without a
   * word, while the single-order door refused the same parcel. They are read here and asked the same question; the
   * sentence says «إضافة» so the packer knows it is not a line of the order itself.
   */
  const addOns = await tx.orderAddOn.findMany({
    where: { orderId: order.id },
    select: { productId: true, productName: true, quantity: true },
  });
  const wanted = [
    ...lines.map((l) => ({ ...l, addOn: false })),
    ...addOns.map((a) => ({ productId: a.productId, productName: a.productName, quantity: a.quantity, freeQuantity: 0, addOn: true })),
  ];

  if (opts.warehouse && order.storeId) {
    // THE WAREHOUSE'S SHELF (W4a) — the same question, asked of the one warehouse the shipment leaves from.
    const needs = wanted.map((l) => ({ ...l, need: l.quantity + l.freeQuantity })).filter((l) => l.need > 0);
    const joining = opts.batchOrderIds ?? [order.id];
    const { freeInWarehouse, otherWarehousesFree, warehouseShelfFor, warehouseShortageAr } = await warehouseShelfModule();
    const shelf = await warehouseShelfFor(tx, {
      companyId: order.companyId,
      storeId: order.storeId,
      warehouse: opts.warehouse,
      productIds: needs.map((l) => l.productId),
      orderIds: [order.id, ...joining],
    });
    const short = needs
      .map((l) => ({ ...l, free: freeInWarehouse(shelf, order.id, l.productId, joining) }))
      .filter((l) => l.free < l.need);
    const others = short.length
      ? await otherWarehousesFree(tx, {
          companyId: order.companyId,
          storeId: order.storeId,
          exceptWarehouseId: opts.warehouse.id,
          productIds: short.map((l) => l.productId),
        })
      : [];
    for (const l of short) blocks.push(warehouseShortageBlock(shelf, l, others, opts.allowNegativeStock, warehouseShortageAr));
    return blocks;
  }

  for (const line of wanted) {
    /*
     * ── WHAT THIS LINE NEEDS, NOT WHAT IS LEFT UNRESERVED ──
     *
     * The owner, 20/10: an order may be taken with no stock, from either
     * door, «بس يوقف عند انشاء الشحنة».
     *
     * This read `quantity + freeQuantity - reservedQty`, and that made the
     * whole check skippable by the very thing it was guarding against.
     * With `allowNegativeStock` ON, confirming RESERVES the line against
     * stock that does not exist — so `need` came out zero, the line was
     * skipped, and the shipment was built for goods that are not in the
     * building. No block, no acknowledgement, nothing on the screen.
     *
     * Worse than «it did not stop»: the flag was written to SOFTEN this
     * block (`hard: !allowNegativeStock`), and that soft branch could
     * never run. `STOCK_SHORTAGE` only ever fired for a line nothing had
     * reserved — which only happens when the flag is OFF, where `hard` is
     * `true`. The flag did not soften the stop; it deleted it.
     *
     * So the question is the honest one: is the stock THERE. A
     * reservation made against nothing is not an answer to it.
     */
    const need = line.quantity + line.freeQuantity;
    if (need <= 0) continue;
    /*
     * This store's shelf only. Two stores drawing on one pile can each
     * promise a customer what the other has already taken.
     *
     * ⚠️ `order.id` is passed so this order's OWN reservation is excluded:
     * a line holding two of the ten on the shelf must read as «my two are
     * covered», not as a shortage of its own making. Without that, every
     * correctly reserved shipment in the company would be blocked.
     */
    const free = await availableStock(tx, order.companyId, line.productId, order.id, order.storeId);
    if (free < need) {
      blocks.push({
        code: 'STOCK_SHORTAGE',
        message: `نقص مخزون: ${line.productName} (${line.addOn ? 'إضافة، ' : ''}ينقص ${need - Math.max(0, free)})`,
        /*
         * Refused outright where negative stock is forbidden; where it is
         * allowed, a SOFT block — which the shipments door still refuses
         * unless this order was acknowledged by name. Soft is «somebody
         * decided», never «nobody was told».
         */
        hard: !opts.allowNegativeStock,
      });
    }
  }

  return blocks;
}

/**
 * A shortage in the warehouse a shipment leaves from (W4a): the same code and today's hard / soft rule — refused outright
 * where negative stock is forbidden, a soft block that needs the order's acknowledgement where it is allowed — and a
 * sentence that names the warehouse and, when another warehouse of the store holds the units, that one.
 */
function warehouseShortageBlock(
  shelf: WarehouseShelf,
  line: { productId: string; productName: string; addOn: boolean; need: number; free: number },
  others: readonly { name: string; free: Map<string, number> }[],
  allowNegativeStock: boolean,
  sentence: (typeof import('./shipment-warehouse'))['warehouseShortageAr']
): OrderBlock {
  return {
    code: 'STOCK_SHORTAGE',
    message: sentence({
      warehouseName: shelf.warehouse.name,
      productName: line.productName,
      addOn: line.addOn,
      missing: line.need - Math.max(0, line.free),
      need: line.need,
      productId: line.productId,
      others,
    }),
    hard: !allowNegativeStock,
  };
}

/** One order of a list and the lines it carries — everything `shipmentBlocksBulk` needs to answer for it. */
export interface BlockedOrder {
  id: string;
  companyId: string;
  storeId: string | null;
  customerId: string;
  regionId: string | null;
  deliveryProviderId: string | null;
  items: ReadonlyArray<{ productId: string; productName: string; quantity: number; freeQuantity: number }>;
  addOns: ReadonlyArray<{ productId: string; productName: string; quantity: number }>;
}

/**
 * `shipmentBlocks` FOR A WHOLE LIST — the same blocks, in the same order, in the same words, from a handful of reads.
 *
 * The list of orders ready to ship asked `shipmentBlocks` of each of up to 300 orders, one after the other: two counts,
 * a fee row, the lines, the add-ons and three aggregates for every line — about 2,700 statements to draw one screen, again
 * after every pause in typing and every return to the tab. The questions are the same for everyone; only the answers
 * differ. So they are asked once, grouped, and each order takes its own answer out:
 *
 *   • the customer's other orders on the road, and returned lately — one read each for all the customers, and each order
 *     leaves ITSELF out of its own count (`id: { not }` in the single version);
 *   • whether an active fee row exists for each (courier, governorate) — one read;
 *   • the shelf — `stockPoolsFor`, per store, which builds its `where` from the same builders `availableStock` does.
 *
 * It READS ONLY and is for the list. The door that creates a shipment keeps asking `shipmentBlocks` of each order inside
 * its own transaction, so a list that says «متوفّر» and a door that refuses (or the reverse) can only differ by what
 * changed between the two clicks — never by the rule. The test next to this file holds the two to the same answer,
 * order by order, over a fixture with shared products, add-ons, a customer with a parcel on the road and one who
 * returned one.
 */
export async function shipmentBlocksBulk(
  tx: Tx,
  orders: ReadonlyArray<BlockedOrder>,
  opts: {
    allowNegativeStock: boolean;
    batchOrderIds?: string[];
    /** W4a: as in `shipmentBlocks` — the warehouse of a PLACED store the list is asked for. Absent = as before. */
    warehouse?: ShipmentWarehouse;
  }
): Promise<Map<string, OrderBlock[]>> {
  const out = new Map<string, OrderBlock[]>();
  if (orders.length === 0) return out;

  const companyIds = [...new Set(orders.map((o) => o.companyId))];
  const since = new Date(Date.now() - RECENT_RETURN_DAYS * 24 * 60 * 60 * 1000);

  // The customer's OTHER orders on the road / returned lately: ids per customer, so an order can leave itself out.
  // Keyed by company first: the single version asks `companyId: order.companyId`, and a list is one company's in practice.
  const remember = (into: Map<string, string[]>, rows: { id: string; customerId: string }[]) => {
    for (const r of rows) into.set(r.customerId, [...(into.get(r.customerId) ?? []), r.id]);
  };
  const road = new Map<string, Map<string, string[]>>();
  const returned = new Map<string, Map<string, string[]>>();

  // Active fee rows, one entry per (courier, governorate) that exists.
  const priced = new Set<string>();
  const wantedFees = new Map<string, Set<string>>();
  for (const o of orders) {
    if (!o.regionId || !o.deliveryProviderId) continue;
    const regions = wantedFees.get(o.deliveryProviderId) ?? new Set<string>();
    regions.add(o.regionId);
    wantedFees.set(o.deliveryProviderId, regions);
  }

  const reads: Promise<unknown>[] = [];
  for (const companyId of companyIds) {
    const customerIds = [...new Set(orders.filter((o) => o.companyId === companyId).map((o) => o.customerId))];
    reads.push(
      tx.order
        .findMany({
          where: { companyId, customerId: { in: customerIds }, shippingStatus: { in: IN_TRANSIT } },
          select: { id: true, customerId: true },
        })
        .then((rows) => {
          const into = new Map<string, string[]>();
          remember(into, rows);
          road.set(companyId, into);
        }),
      tx.order
        .findMany({
          where: {
            companyId,
            customerId: { in: customerIds },
            shippingStatus: { in: ['RETURNED', 'RETURN_REQUESTED'] },
            OR: [{ returnedAt: { gte: since } }, { updatedAt: { gte: since } }],
          },
          select: { id: true, customerId: true },
        })
        .then((rows) => {
          const into = new Map<string, string[]>();
          remember(into, rows);
          returned.set(companyId, into);
        })
    );
  }
  if (wantedFees.size > 0) {
    reads.push(
      tx.deliveryFee
        .findMany({
          where: { OR: [...wantedFees].map(([courier, regions]) => activeFeeRowWhere(courier, { in: [...regions] })) },
          select: { deliveryProviderId: true, regionId: true },
        })
        .then((rows) => {
          for (const r of rows) priced.add(`${r.deliveryProviderId}|${r.regionId}`);
        })
    );
  }

  // The shelf, per (company, store): the pool an order draws on is its store's, and a list may hold several stores' orders.
  const shelves = new Map<string, StockPools>();
  const shelfKey = (o: { companyId: string; storeId: string | null }) => `${o.companyId}|${o.storeId ?? '*'}`;
  const needsOf = (o: BlockedOrder) => [
    ...o.items.map((l) => ({ ...l, addOn: false, need: l.quantity + l.freeQuantity })),
    ...o.addOns.map((a) => ({ productId: a.productId, productName: a.productName, quantity: a.quantity, freeQuantity: 0, addOn: true, need: a.quantity })),
  ];
  const poolOrders = new Map<string, BlockedOrder[]>();
  for (const o of orders) poolOrders.set(shelfKey(o), [...(poolOrders.get(shelfKey(o)) ?? []), o]);
  // W4a: the warehouse's shelf instead, per (company, store) — and, for the lines it cannot cover, the store's other
  // warehouses, read once for the whole list.
  const warehouseShelves = new Map<string, { shelf: WarehouseShelf; others: { name: string; free: Map<string, number> }[] }>();
  const warehouse = opts.warehouse;
  const joining = opts.batchOrderIds ?? [];
  const shelfLib = warehouse ? await warehouseShelfModule() : null;
  for (const [key, group] of poolOrders) {
    const storeId = group[0].storeId;
    if (!warehouse || !storeId) continue;
    const productIds = group.flatMap((o) => needsOf(o).filter((l) => l.need > 0).map((l) => l.productId));
    reads.push(
      (async () => {
        const { otherWarehousesFree, warehouseShelfFor } = shelfLib!;
        const shelf = await warehouseShelfFor(tx, {
          companyId: group[0].companyId,
          storeId,
          warehouse,
          productIds,
          orderIds: [...group.map((o) => o.id), ...joining],
        });
        // The other warehouses only for the products some order of the list is short of.
        const short = group.flatMap((o) =>
          needsOf(o)
            .filter((l) => l.need > 0 && shelfLib!.freeInWarehouse(shelf, o.id, l.productId, joining.length ? joining : [o.id]) < l.need)
            .map((l) => l.productId)
        );
        const others = short.length
          ? await otherWarehousesFree(tx, { companyId: group[0].companyId, storeId, exceptWarehouseId: warehouse.id, productIds: short })
          : [];
        warehouseShelves.set(key, { shelf, others });
      })()
    );
  }
  for (const [key, group] of poolOrders) {
    if (warehouse && group[0].storeId) continue;
    // Only a line that needs something is asked about — as in the single version.
    const productIds = group.flatMap((o) => needsOf(o).filter((l) => l.need > 0).map((l) => l.productId));
    reads.push(
      stockPoolsFor(tx, {
        companyId: group[0].companyId,
        storeId: group[0].storeId,
        productIds,
        orderIds: group.map((o) => o.id),
      }).then((pools) => {
        shelves.set(key, pools);
      })
    );
  }
  await Promise.all(reads);

  for (const order of orders) {
    const blocks: OrderBlock[] = [];

    if (opts.batchOrderIds && opts.batchOrderIds.filter((id) => id === order.id).length > 1) {
      blocks.push({ code: 'DUPLICATE_IN_BATCH', message: 'الطلب مكرر داخل نفس الدفعة', hard: false });
    }

    const inTransit = (road.get(order.companyId)?.get(order.customerId) ?? []).filter((id) => id !== order.id).length;
    if (inTransit > 0) {
      blocks.push({ code: 'PREVIOUS_SHIPMENT_IN_TRANSIT', message: `للعميل ${inTransit} شحنة قيد التوصيل`, hard: false });
    }

    const recentReturn = (returned.get(order.companyId)?.get(order.customerId) ?? []).filter((id) => id !== order.id).length;
    if (recentReturn > 0) {
      blocks.push({ code: 'RECENT_RETURN', message: `للعميل ${recentReturn} مرتجع خلال ${RECENT_RETURN_DAYS} يوماً`, hard: false });
    }

    if (!order.regionId) {
      blocks.push(deliveryFeeBlock(null, false)!);
    } else if (order.deliveryProviderId) {
      const block = deliveryFeeBlock(order.regionId, priced.has(`${order.deliveryProviderId}|${order.regionId}`));
      if (block) blocks.push(block);
    }

    const inWarehouse = warehouseShelves.get(shelfKey(order));
    if (inWarehouse && shelfLib) {
      for (const line of needsOf(order)) {
        if (line.need <= 0) continue;
        const free = shelfLib.freeInWarehouse(inWarehouse.shelf, order.id, line.productId, joining.length ? joining : [order.id]);
        if (free < line.need) {
          blocks.push(warehouseShortageBlock(inWarehouse.shelf, { ...line, free }, inWarehouse.others, opts.allowNegativeStock, shelfLib.warehouseShortageAr));
        }
      }
      out.set(order.id, blocks);
      continue;
    }

    const pools = shelves.get(shelfKey(order));
    for (const line of needsOf(order)) {
      if (line.need <= 0) continue;
      const free = pools ? freeFromPools(pools, order.id, line.productId) : 0;
      if (free < line.need) {
        blocks.push({
          code: 'STOCK_SHORTAGE',
          message: `نقص مخزون: ${line.productName} (${line.addOn ? 'إضافة، ' : ''}ينقص ${line.need - Math.max(0, free)})`,
          hard: !opts.allowNegativeStock,
        });
      }
    }

    out.set(order.id, blocks);
  }
  return out;
}

/**
 * A warehouse payload carries no phone and no address (contract PART 3).
 * The printed label is the one exception — a sticker without an address is
 * useless — and it is rendered server-side, never returned as data.
 */
export function redactCustomerForWarehouse<T extends { phone?: string | null; rawPhone?: string | null; address?: string | null }>(
  customer: T,
  maySeeContact: boolean
): T {
  if (maySeeContact) return customer;
  return { ...customer, phone: undefined, rawPhone: undefined, address: undefined } as T;
}
