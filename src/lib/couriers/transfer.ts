import type { ShippingStatus } from '../shipping-workflow';

/**
 * Moving a parcel to a different courier.
 *
 * The courier is chosen once, when the shipment is created. After that it is
 * not a field you edit, because the parcel is physically somewhere: with a
 * company it sits in their pipeline under their barcode, and a statement
 * will eventually claim it. Overwriting the provider would silently detach
 * an order from the shipment that still holds it.
 *
 * So there are exactly three moves:
 *
 *   DIRECT   — only away from a مندوب (AGENT). He is immediate and local:
 *              the moment you hand the parcel on you have it back from him,
 *              so his leg is closed as received and the order re-dispatches
 *              with no replacement and no new number.
 *
 *   REBATCH  — away from a COMPANY that has NOT YET TAKEN the parcel (its
 *              trolley was never pressed with «إغلاق الشحنة — سُلّمت
 *              للشركة»). The box is on our floor: the company has nothing of
 *              ours to take back and nothing to put in a statement. So it is
 *              the SAME order, with the same number, taken off the old
 *              trolley and put on the new company's — no replacement, no
 *              cancel-and-reorder. A printed waybill carries the old
 *              company's name, so it goes only on a person's word that it was
 *              destroyed. (The owner, 28/10: «قبل التسليم: نفس الطلب».)
 *
 *   REPLACE  — away from a COMPANY that HAS the parcel, to anyone. The
 *              company's leg is closed as taken back, and a REPLACEMENT order
 *              is raised that starts in preparation and is assigned from
 *              scratch. The original keeps its history, its barcode and its
 *              place in whatever statement the company sends.
 */

export type ProviderKind = 'COMPANY' | 'AGENT';

export interface TransferParty {
  id: string;
  name: string;
  kind: ProviderKind;
}

export type TransferMode = 'DIRECT' | 'REBATCH' | 'REPLACE';

export interface TransferPlan {
  mode: TransferMode;
  /** What happens to the leg the parcel is leaving. */
  closeAs: 'RECEIVED_FROM_AGENT' | 'OFF_OUR_TROLLEY' | 'TAKEN_BACK_FROM_COMPANY';
  /** Status the ORIGINAL order ends at. */
  originalStatus: ShippingStatus;
  /** Status the order being dispatched starts from. */
  nextStatus: ShippingStatus;
  reason: string;
}

/**
 * A company takes parcels by the trolley, not one at a time.
 *
 * Handing an order to a company with no batch open means it sits assigned
 * to somebody who has not agreed to carry anything today — invisible on
 * every batch screen, and nobody's job. So the transfer waits until there
 * is a trolley to put it on.
 *
 * An AGENT is different and deliberately exempt: he takes a parcel by hand,
 * now, and making him wait for a batch to be opened would be paperwork
 * standing in front of a man at the counter.
 */
export function requiresOpenBatch(to: TransferParty): boolean {
  return to.kind === 'COMPANY';
}

export class TransferRefused extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

/** Statuses from which a transfer makes any sense at all. */
const TRANSFERABLE: ShippingStatus[] = [
  'READY_FOR_PICKUP',
  'SHIPPED',
  'OUT_FOR_DELIVERY',
  'FAILED_DELIVERY',
];

/**
 * Decides the move, or refuses it. Pure: the caller performs it.
 */
export function planTransfer(input: {
  from: TransferParty | null;
  to: TransferParty;
  shippingStatus: string;
  /**
   * Has the company TAKEN the parcel — `handedToCourier`, computed by the
   * caller. REQUIRED, with no default: `READY_FOR_PICKUP` is the status of an
   * agent's parcel all day and of a company's parcel that is still on OUR
   * trolley, so the status alone cannot tell a replacement from a re-batch.
   * Guessing «taken» here raised a second live order for the same goods and
   * reserved them twice (the measured bug, #59); guessing «not taken» would
   * tell a company it holds nothing while it does. Neither guess is offered.
   */
  handedOver: boolean;
}): TransferPlan {
  const { from, to } = input;
  const status = input.shippingStatus as ShippingStatus;

  if (!from) {
    throw new TransferRefused(
      'NO_CURRENT_COURIER',
      'الطلب غير مُسنَد لأي جهة — أسنِده من شاشة إنشاء الشحنة'
    );
  }

  if (from.id === to.id) {
    throw new TransferRefused('SAME_COURIER', 'الطلب مُسنَد لهذه الجهة أصلاً');
  }

  // Delivered, returned or cancelled: the parcel's journey is over. Whatever
  // is owed is owed; moving it now would rewrite a settled fact.
  if (!TRANSFERABLE.includes(status)) {
    throw new TransferRefused(
      'NOT_TRANSFERABLE',
      'لا يمكن تحويل طلب في هذه الحالة — التحويل يكون قبل انتهاء رحلة الطرد'
    );
  }

  if (from.kind === 'AGENT') {
    // He is immediate; handing the parcel on IS receiving it back from him.
    return {
      mode: 'DIRECT',
      closeAs: 'RECEIVED_FROM_AGENT',
      originalStatus: 'READY_FOR_PICKUP',
      nextStatus: 'READY_FOR_PICKUP',
      reason: `استلام من المندوب ${from.name} وتحويل إلى ${to.name}`,
    };
  }

  // Leaving a company that never took it: the box is still here. The same
  // order moves trolleys — nothing is closed, nothing is raised.
  if (!input.handedOver) {
    return {
      mode: 'REBATCH',
      closeAs: 'OFF_OUR_TROLLEY',
      originalStatus: 'READY_FOR_PICKUP',
      nextStatus: 'READY_FOR_PICKUP',
      reason: `نقل من ${from.name} إلى ${to.name} قبل التسليم — نفس الطلب`,
    };
  }

  // Leaving a company that HAS it — to another company or to an agent, it
  // makes no difference: the parcel has to physically come back first.
  return {
    mode: 'REPLACE',
    closeAs: 'TAKEN_BACK_FROM_COMPANY',
    originalStatus: 'RETURN_REQUESTED',
    nextStatus: 'READY_FOR_SHIPPING',
    reason: `سحب من ${from.name} وإصدار طلب بديل لـ ${to.name}`,
  };
}
