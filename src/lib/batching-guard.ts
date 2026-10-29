import { hasEverShipped } from './order-state';

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
