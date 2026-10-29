import { db } from './db';
import { logAudit } from './audit';
import { notify } from './notify';
import { REJECTION_REASON_AR } from './confirmation-workflow';
import { COURIER_CANCEL_AR, courierCancelMessage } from './courier-change';

/**
 * CARRYING OUT AN APPROVED CANCEL ON A PARCEL THE COURIER ALREADY HOLDS.
 *
 * The stand-down door refuses to cancel an order whose parcel has left, and
 * rightly: the goods are in a van, not on a shelf. But the approval that
 * reached it was left standing — «waiting to be applied», for ever, with the
 * courier never asked to stop the parcel (see `courierCancelMessage`).
 *
 * This is the missing step, in two calls of the same door:
 *
 *   1. without `courierNotified` — the message to send, and who to send it
 *      to. Nothing is written.
 *   2. with it — a person says the company has been told. The request is
 *      marked carried out (once: the same `appliedAt: null` condition the
 *      in-place carry-out uses), and the order gets a note and a timeline
 *      entry with that person's name.
 *
 * What it does NOT do is touch the order: no status, no stock, no version.
 * The parcel is the courier's until it comes back through the returns door,
 * where it is counted. Its own file, not the route's body, so the route's
 * one transaction stays the one that stops an order.
 */

export interface CarryOutResult {
  status: number;
  body: Record<string, unknown>;
}

export async function courierCancelCarryOut(input: {
  companyId: string;
  storeId: string;
  user: { id: string; name: string };
  courierNotified: boolean;
  order: { id: string; orderNumber: string; trackingNumber: string | null; deliveryProviderId: string | null };
  request: { id: string; requestedById: string; reason: string; cancelReason: string | null };
}): Promise<CarryOutResult> {
  const { companyId, storeId, user, order, request, courierNotified } = input;

  const provider = order.deliveryProviderId
    ? await db.deliveryProvider.findFirst({
        where: { id: order.deliveryProviderId, companyId },
        select: { name: true, phone: true },
      })
    : null;

  if (!courierNotified) {
    return {
      status: 409,
      body: {
        error: COURIER_CANCEL_AR,
        errorAr: COURIER_CANCEL_AR,
        code: 'COURIER_ACTION_REQUIRED',
        action: 'CANCEL_WAYBILL',
        courier: provider ? { name: provider.name, phone: provider.phone } : null,
        message: courierCancelMessage({
          orderNumber: order.orderNumber,
          trackingNumber: order.trackingNumber,
          reason: REJECTION_REASON_AR[request.cancelReason ?? ''] ?? request.reason,
        }),
      },
    };
  }

  const marked = await db.$transaction(async (tx) => {
    const res = await tx.orderChangeRequest.updateMany({
      where: { id: request.id, appliedAt: null },
      data: { appliedAt: new Date(), appliedById: user.id },
    });
    if (res.count !== 1) return false;
    await tx.orderNote.create({
      data: {
        companyId, orderId: order.id, authorId: user.id, kind: 'internal',
        body:
          `أُبلغت ${provider?.name ?? 'شركة الشحن'} بإلغاء الطرد وطُلب منها إيقافه — بناءً على طلب: ${request.reason}. ` +
          'يرجع عبر باب المرتجعات ويتعدّ.',
      },
    });
    await tx.orderActivity.create({
      data: {
        companyId, orderId: order.id, userId: user.id,
        action: 'COURIER_TOLD_TO_CANCEL',
        metadata: JSON.stringify({ request: request.id, courier: provider?.name ?? null, barcode: order.trackingNumber ?? null }),
      },
    });
    return true;
  });
  if (!marked) {
    return {
      status: 409,
      body: { error: 'هالطلب اتنفّذ قبل ما تضغط — حدّث الصفحة', errorAr: 'هالطلب اتنفّذ قبل ما تضغط — حدّث الصفحة', code: 'ALREADY_APPLIED' },
    };
  }

  await logAudit({
    companyId, userId: user.id, action: 'SHIPMENT_CANCEL_COURIER_TOLD',
    entity: 'Order', entityId: order.id,
    newData: { request: request.id, courier: provider?.name ?? null, by: user.name },
  });

  // The person who asked hears it is done — «اعتُمد» and «نُفِّذ» are two days.
  if (request.requestedById !== user.id) {
    notify({
      companyId,
      storeId,
      audience: { userIds: [request.requestedById] },
      actorId: user.id,
      title: `أُبلغت الشركة بإلغاء ${order.orderNumber}`,
      message: `الطرد عند الشركة — طُلب منها إيقافه ويرجع عبر المرتجعات: ${request.reason}`,
      type: 'SYSTEM_ALERT',
      link: `/orders?highlight=${order.id}`,
    });
  }

  return { status: 200, body: { success: true, orderNumber: order.orderNumber, courierTold: true } };
}
