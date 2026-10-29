import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { zodMessage } from '@/lib/zod-message';
import { consumeOrderStock } from '@/lib/stock-consumption';
import { expectedBackTotal } from '@/lib/partial-delivery';
import { LOSS_RECEIPT_NOTE, SETTLEMENT_WITH_MONEY, lossReceiptCounts } from '@/lib/written-off';

/**
 * POST /api/ops/tracking/write-off — the parcel is never coming back.
 *
 * When an order is pulled away from a shipping company a replacement is
 * raised at once, and the original waits at RETURN_REQUESTED for the
 * company to send the goods back. Sometimes they never do. Without this the
 * order waits forever: it sits in the returns list, its units stay reserved
 * against a parcel that no longer exists, and the shelf keeps promising
 * stock nobody can pick.
 *
 * Writing it off says the true thing: the goods LEFT and are not coming
 * back. So the stock is CONSUMED, not restored — restoring it would put
 * units back on a shelf that does not have them, and every count from then
 * on would be wrong by exactly this order.
 *
 * It is not a deletion and not a cancellation. The order keeps its number,
 * its barcode and its history; what changes is that we stop waiting, and
 * the reason is required so the loss can be explained later.
 *
 * IT CLOSES THE WAY THE DESK CLOSES A ZERO COUNT. The order used to be left
 * RETURNED with no receipt, and everything that reads «a return nobody has
 * received» kept it: the desk's list, the daily alert, «شغلك اليوم», the
 * finance count of what is pending, and the media buyer (RETURNED with
 * returned_at empty). So it writes what the desk writes for a count of
 * nothing: a receipt of received 0, damaged 0, missing = expected, the note
 * «أُغلق كخسارة — لم يصل», returnedAt, and no settlement owed. The words
 * «مفقود بعد الشحن — خسارة = مغلق» are READ from that shape (`order-outcome`).
 * If the parcel turns up later the desk completes this same receipt (the
 * returns door), it does not open a second one.
 */

const schema = z.object({
  orderId: z.string().uuid(),
  reason: z.string().trim().min(5).max(300),
});

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    // Writing off goods is a money decision, not a tracking one.
    await requirePermission('finance.update').catch(async () => requirePermission('orders.unlock'));

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }

    const order = await db.order.findFirst({
      where: { id: parsed.data.orderId, companyId, storeId },
      select: {
        id: true,
        orderNumber: true,
        shippingStatus: true,
        trackingNumber: true,
        totalAmount: true,
        settlementStatus: true,
        returnReceipt: { select: { id: true } },
        items: { select: { id: true, quantity: true, freeQuantity: true, deliveredQty: true } },
        deliveryProvider: { select: { name: true } },
        replacedBy: { select: { orderNumber: true } },
      },
    });
    if (!order) return NextResponse.json({ error: 'الطلب غير موجود' }, { status: 404 });

    // Only a parcel we are actually waiting on can be given up on.
    if (order.shippingStatus !== 'RETURN_REQUESTED') {
      return NextResponse.json(
        {
          error: 'لا يُغلق كخسارة إلا طلب مطلوب إرجاعه ولم يصل — هذا الطلب في حالة أخرى.',
          code: 'NOT_AWAITING_RETURN',
        },
        { status: 409 }
      );
    }

    // A receipt already stands for this order: it was counted at the desk, so there is nothing left to give up on.
    if (order.returnReceipt) {
      return NextResponse.json({ error: 'تم استلام هذا المرتجع مسبقاً', code: 'ALREADY_RECEIVED' }, { status: 409 });
    }

    // What was expected back: the same sum the desk uses, so the two receipts read alike.
    const loss = lossReceiptCounts(expectedBackTotal(order.items));

    const result = await db.$transaction(async (tx) => {
      // The units left the building and will not come back. Consuming is
      // the honest entry; restoring would credit a shelf that is empty.
      await consumeOrderStock(tx as never, {
        orderId: order.id,
        companyId,
        allowNegativeStock: country.allowNegativeStock,
        userId: user.id,
      });

      // The desk's own zero count, written by the same hand: nothing received, nothing damaged, all of it missing.
      // One receipt per order (`orderId` is unique), so a second write-off in a race fails here and rolls the shelf back.
      await tx.returnReceipt.create({
        data: {
          companyId,
          orderId: order.id,
          ...loss,
          courierFeeCharged: false,
          courierFeeAmount: 0,
          inspectedById: user.id,
          note: LOSS_RECEIPT_NOTE,
          stockRestored: false,
        },
      });

      const updated = await tx.order.update({
        where: { id: order.id },
        data: {
          shippingStatus: 'RETURNED',
          returnedAt: new Date(),
          // No settlement is owed on goods that never came back — unless money is already recorded against it, which stays.
          ...((SETTLEMENT_WITH_MONEY as readonly string[]).includes(order.settlementStatus) ? {} : { settlementStatus: 'NOT_APPLICABLE' }),
          returnReason: `أُغلق كخسارة — لم تُستلم البضاعة. ${parsed.data.reason}`,
          version: { increment: 1 },
        },
        select: { id: true, orderNumber: true, shippingStatus: true, version: true },
      });

      await tx.orderActivity.create({
        data: {
          companyId,
          orderId: order.id,
          userId: user.id,
          action: 'WRITTEN_OFF_AS_LOSS',
          newStatus: 'RETURNED',
          metadata: JSON.stringify({
            reason: parsed.data.reason,
            courier: order.deliveryProvider?.name ?? null,
            barcode: order.trackingNumber,
            replacement: order.replacedBy?.orderNumber ?? null,
            amount: order.totalAmount,
            expectedQty: loss.expectedQty,
          }),
        },
      });

      return updated;
    });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'ORDER_WRITTEN_OFF',
      entity: 'Order',
      entityId: order.id,
      previousData: { shippingStatus: 'RETURN_REQUESTED' },
      newData: {
        shippingStatus: 'RETURNED',
        reason: parsed.data.reason,
        courier: order.deliveryProvider?.name ?? null,
        amount: order.totalAmount,
      },
    });

    return NextResponse.json({
      order: result,
      message: `أُغلق ${order.orderNumber} كخسارة — خرجت بضاعته من المخزون ولن تعود.`,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
