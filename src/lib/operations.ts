import type { Prisma } from '@prisma/client';
import { db } from './db';
import { availableStock } from './reservation';

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
export async function preparationGroups(tx: Tx, scope: { companyId: string; storeId: string }) {
  const items = await tx.orderItem.findMany({
    where: {
      companyId: scope.companyId,
      order: {
        storeId: scope.storeId,
        confirmationStatus: 'CONFIRMED',
        shippingStatus: { in: ['NOT_READY', 'PACKING'] },
      },
    },
    select: {
      productId: true,
      productName: true,
      quantity: true,
      freeQuantity: true,
      reservedQty: true,
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
      confirmationStatus: item.order.confirmationStatus,
      shippingStatus: item.order.shippingStatus,
    });
    byProduct.set(item.productId, group);
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
  | 'NO_FEE_ROW';

export interface OrderBlock {
  code: BlockCode;
  message: string;
  /** false = the operator may acknowledge and continue; true = hard stop. */
  hard: boolean;
}

const RECENT_RETURN_DAYS = 30;
const IN_TRANSIT = ['SHIPPED', 'OUT_FOR_DELIVERY'];

/**
 * Blocking warnings for one order before it joins a shipment. The operator
 * may acknowledge the soft ones; a hard block (stock shortage with negative
 * stock disallowed) creates no shipment row at all.
 */
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
  opts: { allowNegativeStock: boolean; batchOrderIds?: string[] }
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
    blocks.push({ code: 'NO_REGION', message: 'لم تُحدَّد المحافظة — لا يمكن حساب أجرة التوصيل', hard: true });
  } else if (order.deliveryProviderId) {
    const fee = await tx.deliveryFee.findFirst({
      where: { deliveryProviderId: order.deliveryProviderId, regionId: order.regionId, isActive: true },
      select: { id: true },
    });
    if (!fee) {
      blocks.push({ code: 'NO_FEE_ROW', message: 'لا توجد أجرة توصيل لهذه المحافظة عند هذه الشركة', hard: true });
    }
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
