import { db } from './db';
import { SHIPPING_GONE } from './order-state';

/**
 * A SEND THAT NEVER ANSWERED — AND THE ONE PERSON WHO CAN CLOSE IT.
 *
 * Sending an order to a courier writes a claim on the row first
 * (`courier_send_started_at`) so that two presses cannot create two parcels.
 * A refusal gives the claim back. A SILENCE — a timeout — keeps it, on
 * purpose: the parcel may exist, and releasing the claim would hand the next
 * click a second waybill. Nothing ever cleared it, so the order sat «send
 * in flight» for ever, un-sendable and un-printable.
 *
 * The only thing that can settle it is a person ringing the company and
 * hearing «we have no parcel under that number». This is that person's
 * door: it clears the claim and the barcode, in one conditional write, and
 * it is audited by the caller.
 *
 * It refuses, in this order:
 *   - an order with no claim (nothing to clear);
 *   - a claim younger than the courier's own patience (the call may still
 *     be answering);
 *   - an order that has already left, whose parcel is by definition real;
 *   - an order that carries a barcode, unless the caller repeats it back —
 *     a sent order keeps its claim beside its barcode, and the barcode is
 *     what tells a real parcel from a stuck one.
 */

/** Longer than any courier call is allowed to take (30 s) — several times over. */
export const STUCK_AFTER_MS = 2 * 60_000;

export type ClearSendResult =
  | { ok: true; clearedBarcode: string | null; orderNumber: string; version: number }
  | {
      ok: false;
      code: 'NOT_FOUND' | 'NO_CLAIM' | 'TOO_SOON' | 'ALREADY_LEFT' | 'BARCODE_CONFIRM_REQUIRED' | 'MOVED_ON';
      message: string;
      /** With BARCODE_CONFIRM_REQUIRED: the barcode the screen must show. */
      barcode?: string;
    };

export async function clearStuckSend(input: {
  orderId: string;
  companyId: string;
  storeId: string;
  /** The barcode, repeated back by the person, when the order carries one. */
  confirmBarcode?: string | null;
  now?: Date;
}): Promise<ClearSendResult> {
  const now = input.now ?? new Date();
  const order = await db.order.findFirst({
    where: { id: input.orderId, companyId: input.companyId, storeId: input.storeId },
    select: {
      id: true, orderNumber: true, version: true, trackingNumber: true,
      courierSendStartedAt: true, shippingStatus: true, shippedAt: true,
    },
  });
  if (!order) return { ok: false, code: 'NOT_FOUND', message: 'الطلب غير موجود' };

  if (!order.courierSendStartedAt) {
    return { ok: false, code: 'NO_CLAIM', message: 'ما في إرسال معلّق على هالطلب' };
  }
  if (now.getTime() - new Date(order.courierSendStartedAt).getTime() < STUCK_AFTER_MS) {
    return {
      ok: false,
      code: 'TOO_SOON',
      message: 'الإرسال بدأ من أقل من دقيقتين — يمكن لسّا الشركة عم تردّ. استنّى شوي وجرّب.',
    };
  }
  if (order.shippedAt || (SHIPPING_GONE as readonly string[]).includes(order.shippingStatus)) {
    return {
      ok: false,
      code: 'ALREADY_LEFT',
      message: 'الطرد سُلّم للشركة أصلاً — يعني موجود عندهم. ما بيصير نفرّغ رقمه.',
    };
  }
  if (order.trackingNumber && input.confirmBarcode?.trim() !== order.trackingNumber) {
    return {
      ok: false,
      code: 'BARCODE_CONFIRM_REQUIRED',
      message: 'على الطلب باركود مسجّل. اكتبه بنفسك لتأكيد إنو الشركة ما عندها طرد بهالرقم.',
      barcode: order.trackingNumber,
    };
  }

  /*
   * ONE CONDITIONAL WRITE. The claim must still be there and unchanged, the
   * barcode must still be what was read, and the version must not have
   * moved: if the late answer arrived a second ago and wrote a barcode, this
   * finds nothing to clear and says so instead of erasing a real parcel.
   */
  const cleared = await db.order.updateMany({
    where: {
      id: order.id,
      companyId: input.companyId,
      version: order.version,
      courierSendStartedAt: order.courierSendStartedAt,
      trackingNumber: order.trackingNumber,
      shippedAt: null,
      shippingStatus: { notIn: [...SHIPPING_GONE] },
    },
    data: { courierSendStartedAt: null, trackingNumber: null, version: { increment: 1 } },
  });
  if (cleared.count !== 1) {
    return { ok: false, code: 'MOVED_ON', message: 'الطلب تغيّر قبل ما ينفكّ — حدّث الصفحة وجرّب من جديد.' };
  }
  return { ok: true, clearedBarcode: order.trackingNumber ?? null, orderNumber: order.orderNumber, version: order.version + 1 };
}
