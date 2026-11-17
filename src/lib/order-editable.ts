/**
 * «CAN THIS ORDER STILL BE EDITED BY A MACHINE?» — ONE ANSWER, FOR EVERY DOOR THAT ASKS.
 *
 * Two doors ask it of an order that has not been confirmed yet: the landing confirmation chat
 * (`v1/landing-chat.ts`, a customer's own page) and the replies system's `/api/v1/orders/{id}/amend|cancel`
 * (a customer's WhatsApp chat). They are the same question — «has the order's life begun?» — and a second copy of
 * the answer is how one door lets an edit through that the other refuses. So the answer lives here and nowhere else.
 */

/** Ended: nothing is left to edit, and ending it again is a no-op. */
export const ENDED: readonly string[] = ['REJECTED', 'CANCELLED'];

/** Decided: confirmed (a person's call from here on) or ended. */
const DECIDED: readonly string[] = ['CONFIRMED', ...ENDED];

/** On a trolley, labelled, barcoded or past «not ready»: the parcel's life has begun, and no machine edits it any more. */
export function onShipment(o: {
  shippingStatus: string;
  shippingBatchId: string | null;
  trackingNumber: string | null;
  labelPrintedAt: Date | null;
}): boolean {
  return !!o.shippingBatchId || !!o.trackingNumber || !!o.labelPrintedAt || o.shippingStatus !== 'NOT_READY';
}

/**
 * THE SAME QUESTION, AS A WHERE — for a write that must still hold when it is made.
 *
 * `orderEditable` is asked of a row that was READ; between the read and the write somebody may have confirmed the order or put
 * it on a trolley. A write that carries this condition (with the row's `version`) is refused by the database itself then, not by
 * a second reading of the answer. It says exactly what `orderEditable` says, beside it, so the two cannot drift apart.
 */
export const EDITABLE_NOW = {
  confirmationStatus: { notIn: [...DECIDED] },
  shippingStatus: 'NOT_READY',
  shippingBatchId: null,
  trackingNumber: null,
  labelPrintedAt: null,
};

/** «editable»: not confirmed, not rejected, not cancelled, and not on a shipment. */
export function orderEditable(o: {
  confirmationStatus: string;
  shippingStatus: string;
  shippingBatchId: string | null;
  trackingNumber: string | null;
  labelPrintedAt: Date | null;
}): boolean {
  return !DECIDED.includes(o.confirmationStatus) && !onShipment(o);
}
