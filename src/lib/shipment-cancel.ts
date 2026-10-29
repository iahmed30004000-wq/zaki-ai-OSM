import { handedToCourier } from './order-seal';

/**
 * UNTIL «إغلاق الشحنة — سُلّمت للشركة», A PARCEL IS STILL OURS TO CANCEL OR HOLD.
 *
 * THE OWNER'S RULING (28/10, M6): «الغاء و التأجيل لغاية ما اضغط اغلاق الشحنة».
 * The line for cancelling and for postponing is the press of the batch
 * button, not the printer. Before it the box is on our floor: it can be
 * opened, the goods taken out, the waybill torn up. After it the parcel is
 * with the company, and a cancel is a REQUEST that tells them.
 *
 * It overturns the 28/09 ruling «لحظةَ طباعة البوليصة» for those two acts
 * ONLY. That ruling's reason still stands for STOCK and is kept here as a
 * question of its own: a printed waybill, or a parcel on the pickup shelf,
 * means the units are packed under this order's name. They go back on the
 * shelf only when a person says, by name, that they did the putting back —
 * see `ATTESTATION_AR`.
 *
 * Pure and client-safe: the screens read it to decide what to offer, and the
 * server reads the same function to decide what to allow.
 */

/**
 * What a person says before the units of a packed parcel are counted back.
 *
 * Not a permission: a statement, recorded on the order with the name of the
 * one who made it (the same pattern as the reorder door's `courierNotified`).
 * The server will not release the reservation of a labelled or pickup-shelf
 * parcel without it, because releasing it INVENTS stock if the box is still
 * sealed on the shelf.
 */
export const ATTESTATION_AR = 'الطرد بين يديّ — فككتُه وأعدتُ قطعه للرف وأتلفتُ بوليصته';

/** What the order needs to answer «may it still be cancelled?». Every field is required: a caller that cannot say is refused. */
export interface CancelFacts {
  confirmationStatus: string;
  shippingStatus: string;
  shippedAt: Date | string | null;
  labelPrintedAt: Date | string | null;
  /** The trolley it sits on, or null. */
  shippingBatchId: string | null;
  /**
   * The status of THAT trolley. Required, not optional: the question is
   * unanswerable without it, and a caller that forgot it used to be read as
   * «not handed over» — the unsafe way round.
   */
  batchStatus: string | null;
}

export const IN_FLIGHT_AR = 'الطرد قيد الترحيل الآن — استنّى دقيقتين أو تحقّق مع الشركة قبل ما تلغيه.';
export const HANDED_OVER_AR =
  'الطرد سُلّم لشركة الشحن — صار الإلغاء طلباً يُبلَّغ للشركة، وتعود بضاعته للمخزون عند استلام المرتجع وعدّه.';
export const UNKNOWN_BATCH_AR = 'تعذّر معرفة حالة دفعة هذا الطرد — حدّث الصفحة وجرّب من جديد.';
export const ATTESTATION_NEEDED_AR =
  'الطرد مطبوعة بوليصته أو جاهز للاستلام — علّم «الطرد بين يديّ» ليرجع للرف قبل ما تلغيه.';

export type CancelVerdict =
  | { allowed: true; needsAttestation: boolean }
  | { allowed: false; code: 'CANCEL_AFTER_SHIPPED' | 'UNKNOWN_BATCH'; message: string };

/**
 * A packed parcel: its goods are not on any shelf anybody else can be sold from.
 *
 * The 28/09 stock ruling, kept as it was: the printed waybill or the pickup
 * shelf. Asked of the row, not of the batch.
 */
export function isPacked(order: Pick<CancelFacts, 'labelPrintedAt' | 'shippingStatus'>): boolean {
  return !!order.labelPrintedAt || order.shippingStatus === 'READY_FOR_PICKUP';
}

/**
 * MAY THIS ORDER STILL BE CANCELLED (OR HELD), AND WHAT DOES IT COST?
 *
 * `allowed` until the courier has the parcel. `needsAttestation` when the
 * goods are packed: cancelling is possible, but only with a person's word
 * that the box was opened.
 */
export function cancelVerdict(order: CancelFacts): CancelVerdict {
  // A trolley we cannot read is not a trolley we may assume is open.
  if (order.shippingBatchId && !order.batchStatus) {
    return { allowed: false, code: 'UNKNOWN_BATCH', message: UNKNOWN_BATCH_AR };
  }
  if (
    handedToCourier({
      shippingStatus: order.shippingStatus,
      shippedAt: order.shippedAt,
      batchStatus: order.batchStatus,
    })
  ) {
    return { allowed: false, code: 'CANCEL_AFTER_SHIPPED', message: HANDED_OVER_AR };
  }
  return { allowed: true, needsAttestation: isPacked(order) };
}

/**
 * The columns an order loses when it leaves the shipping pipeline for good
 * (cancel, or handed back to the confirmation desk).
 *
 * ONE LIST, so the doors cannot leave different orders behind: shipping idle,
 * settlement not applicable, off the trolley, no waybill, no barcode, no hold.
 * The OLD values are not lost — the caller writes them to the activity
 * «أُخرج من الدفعة» first.
 *
 * The courier assignment goes only when it came WITH the trolley: an order
 * that was given a company before it was ever batched keeps that choice.
 */
export function leavesTheShipment(opts: { fromTrolley: boolean }): Record<string, unknown> {
  return {
    shippingStatus: 'NOT_READY',
    settlementStatus: 'NOT_APPLICABLE',
    shippingBatchId: null,
    labelPrintedAt: null,
    trackingNumber: null,
    courierSendStartedAt: null,
    shipHoldUntil: null,
    shipHoldReason: null,
    ...(opts.fromTrolley
      ? { deliveryProviderId: null, deliveryAssignedAt: null, deliveryAssignedById: null }
      : {}),
  };
}

/**
 * The columns a HELD parcel loses: only the trolley and its settlement — the label, the company and the goods stay.
 *
 * AND ITS SHIPPING STATUS STAYS WHERE IT IS. A parcel on a trolley is READY_FOR_PICKUP — the box is packed — and that
 * status IS the fact `isPacked` reads. Sending it back to READY_FOR_SHIPPING (as this once did) erased that fact when
 * the parcel had no printed waybill yet: a later cancel, a second hold or a void then saw an unpacked order and counted
 * the units back on the shelf with nobody's word. The held parcel is found again by the shipment list, which reads
 * «READY_FOR_PICKUP, no trolley, a hold date» as a packed parcel waiting for a new trolley.
 */
export function leavesTheTrolley(): Record<string, unknown> {
  return {
    settlementStatus: 'NOT_APPLICABLE',
    shippingBatchId: null,
    deliveryAssignedAt: null,
    deliveryAssignedById: null,
  };
}

/** What was on the order when it left, as the activity «أُخرج من الدفعة» keeps it. */
export interface TakenOff {
  batch: string | null;
  courier: string | null;
  barcode: string | null;
  labelPrintedAt: string | null;
  shippingStatus: string;
}

export function takenOffFrom(order: {
  shippingStatus: string;
  labelPrintedAt: Date | string | null;
  trackingNumber: string | null;
  deliveryProviderId: string | null;
  batchNumber?: string | null;
  courierName?: string | null;
}): TakenOff {
  return {
    batch: order.batchNumber ?? null,
    courier: order.courierName ?? order.deliveryProviderId ?? null,
    barcode: order.trackingNumber ?? null,
    labelPrintedAt: order.labelPrintedAt ? new Date(order.labelPrintedAt).toISOString() : null,
    shippingStatus: order.shippingStatus,
  };
}
