import type { Prisma } from '@prisma/client';
import { hasEverShipped } from './order-state';
import { orderSearchOr } from './order-filters';

/**
 * WHO MAY BE PUT ON A TROLLEY — AND WHO MAY NOT, WHATEVER THE LIST SAID.
 *
 * The shipment list is read, a person ticks rows, and the batch is built a
 * minute later. In that minute somebody else may have put the same order on
 * a trolley, or the courier may have taken it away. Both batching doors
 * (`POST /api/ops/shipments` and `assign_batch`) trusted the list: they moved
 * an order that already sat on one trolley onto another, and even one that
 * was already SHIPPED — so a parcel in a van appeared on a manifest the
 * driver never signed.
 *
 * The question is asked of the row as it is NOW, at the write, and the write
 * itself repeats it as a condition (`version`, no batch, a status that is
 * still waiting). This file only owns the words and the one list.
 */

/** Statuses an order may still be in when it is first put on a trolley. */
export const BATCHABLE_SHIPPING = ['NOT_READY', 'PACKING', 'READY_FOR_SHIPPING'] as const;

/** The statuses the shipment list offers: orders not yet packed. */
export const WAITING_FOR_A_TROLLEY = BATCHABLE_SHIPPING;

/**
 * A PACKED PARCEL WAITING FOR A NEW TROLLEY (`where`).
 *
 * «أجّل الشحن» on a parcel that is already on a trolley takes it off and keeps the box as it is — status
 * READY_FOR_PICKUP, label, goods. Without a hold date such a parcel is one an agent handed back to us and the shipment
 * list has never offered it; with one, it is a postponed parcel that must come back to the list on its day.
 */
export const HELD_PACKED_PARCEL = {
  shippingStatus: 'READY_FOR_PICKUP',
  shippingBatchId: null,
  shipHoldUntil: { not: null },
} as const;

/**
 * «جاهزة للشحن» AND «مؤجَّلة الشحن» — THE TWO TABS OF «إنشاء شحنة», WRITTEN ONCE (3/11).
 *
 * The list's own `where`, lifted out of `GET /api/ops/shipments` so the file of the ready orders
 * (`GET /api/ops/shipments/export`) asks the very same question instead of a copy of it: what the tab shows is what the
 * file holds, and a postponed order is in neither. `held: false` is «جاهزة للشحن» (no hold, or a hold whose day has come);
 * `held: true` is «مؤجَّلة الشحن». The search is the orders list's (`orderSearchOr`), with the city.
 */
export function shipmentListWhere(input: {
  companyId: string;
  storeId: string;
  held: boolean;
  regionId?: string | null;
  productId?: string | null;
  search?: string | null;
  from?: Date | null;
  to?: Date | null;
  now?: Date;
}): Prisma.OrderWhereInput {
  const { companyId, storeId, held, regionId, productId, search, from, to } = input;
  const now = input.now ?? new Date();
  return {
    companyId,
    storeId,
    confirmationStatus: 'CONFIRMED',
    // Held back by hand: the customer asked for it not to go out yet.
    // A hold with no date is open-ended and only ends when released.
    //
    // TWO KINDS OF PARCEL WAIT FOR A TROLLEY, as two branches: one not yet packed, and one PACKED (still
    // READY_FOR_PICKUP) that «أجّل الشحن» took off a trolley. The second keeps its status, because that status
    // is the fact «the box is packed»; its hold date is what tells it from one an agent handed back.
    // «المؤجَّلة»: every branch below is held, and the column says so at the top too.
    ...(held ? { shipHoldUntil: { not: null } } : {}),
    OR: [
      {
        shippingStatus: { in: [...WAITING_FOR_A_TROLLEY] },
        ...(held ? { shipHoldUntil: { not: null } } : { OR: [{ shipHoldUntil: null }, { shipHoldUntil: { lte: now } }] }),
      },
      held ? HELD_PACKED_PARCEL : { ...HELD_PACKED_PARCEL, shipHoldUntil: { lte: now } },
    ],
    ...(regionId ? { regionId } : {}),
    ...(productId ? { items: { some: { productId } } } : {}),
    // ANDed as its own clause, not spread: the where above already has
    // an `OR` for the hold window, and a second one at the same level
    // would silently replace it — the held filter would stop working
    // the moment somebody typed in the search box.
    ...(search ? { AND: [{ OR: orderSearchOr(search, { withCity: true }) as Prisma.OrderWhereInput[] }] } : {}),
    ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
  };
}

export interface BatchingFacts {
  shippingBatchId?: string | null;
  /** Set when the parcel was postponed: the only way a READY_FOR_PICKUP parcel is batchable again. */
  shipHoldUntil?: Date | string | null;
  shippingStatus: string;
  shippedAt?: Date | string | null;
  labelPrintedAt?: Date | string | null;
}

export const ALREADY_BATCHED_AR = 'الطلب داخل دفعة أصلاً — حدّث القائمة قبل ما تكمّل';
export const MOVED_ON_AR = 'تغيّرت حالة الطلب — حدّث القائمة قبل ما تكمّل';
export const ALREADY_LEFT_AR ='الطلب سُلّم لشركة الشحن أصلاً — حدّث القائمة قبل ما تكمّل';

/** Has it already shipped — `hasEverShipped` reads only these two facts of the row. */
function left(order: BatchingFacts): boolean {
  return hasEverShipped({
    confirmationStatus: '',
    shippingStatus: order.shippingStatus,
    shippedAt: order.shippedAt,
  });
}

/**
 * The refusal for creating a batch from a list: the order must still be
 * waiting for a trolley — unbatched, not shipped, in a waiting status.
 */
export function whyNotBatchable(order: BatchingFacts): string | null {
  if (order.shippingBatchId) return ALREADY_BATCHED_AR;
  if (left(order)) return ALREADY_LEFT_AR;
  const heldPacked = order.shippingStatus === 'READY_FOR_PICKUP' && !!order.shipHoldUntil;
  if (!heldPacked && !(BATCHABLE_SHIPPING as readonly string[]).includes(order.shippingStatus)) return MOVED_ON_AR;
  return null;
}

/**
 * The refusal for moving one order onto a named batch. Looser on status (an
 * order handed back by an agent is READY_FOR_PICKUP with no trolley), but
 * never one that is on another trolley or already gone.
 */
export function whyNotMovable(order: BatchingFacts, toBatchId: string): string | null {
  if (left(order)) return ALREADY_LEFT_AR;
  if (order.shippingBatchId && order.shippingBatchId !== toBatchId) return ALREADY_BATCHED_AR;
  return null;
}
