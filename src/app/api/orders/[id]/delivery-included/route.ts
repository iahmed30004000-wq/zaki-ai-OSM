import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { ORDER_ACCESS_STATUS, assertOrderAccess } from '@/lib/rbac';
import { authorize } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { orderSeal, sealMessage } from '@/lib/order-seal';
import { codForOrder } from '@/lib/delivery-fees';
import { roundMinor } from '@/lib/money';
import { logAudit } from '@/lib/audit';

/**
 * POST /api/orders/[id]/delivery-included  { included, expectedVersion, reason?, dryRun? }
 *
 * «السعر شامل التوصيل» FOR AN ORDER THAT ALREADY EXISTS — and has not left yet.
 *
 * The box on the order form (1/11) says it when the order is written. An order written without it — a price typed equal to an
 * offer's, a Telegram order, a sheet — is a plain price, and the courier's fee is added to what the courier collects when the
 * shipment is made. There was no door to say «this price already carries delivery» afterwards: ORD-2026-1711 was collected at 23
 * for a 20$ line the customer had been told included it. This is that door, for the orders that can still be told apart from the
 * parcel: nothing about the amount has reached the courier or the paper.
 *
 *   WHICH ORDERS — not ended (cancelled, rejected), not sealed (`orderSeal`: its batch handed over, shipped, or its waybill
 *   printed), and with no barcode of the courier's and no send claimed: after those the courier holds the amount, and a different
 *   one here would only make our record disagree with the parcel.
 *
 *   WHAT IT WRITES — the flag, the total, and a version. The total moves by exactly what the flag moves it by:
 *   `codForOrder` asked twice, with the flag as it is and as it will be, and the DIFFERENCE added to the stored total — so
 *   whatever else made the stored figure what it is (a rounding, an add-on, an old discount spread) is left alone, and an order
 *   with no fee priced yet moves by nothing. The fee column itself is not touched: the courier's fee is still the courier's.
 *
 *   WHO — whoever may change the delivery fee (`orders.change_fee`), which is what the flag decides: whether it is added.
 *
 * `dryRun` answers what it would do (`totalBefore`, `totalAfter`) and writes nothing, so the screen can say the figure before the
 * press. The arithmetic stays here: no screen computes a collection.
 */
const body = z.object({
  included: z.boolean(),
  expectedVersion: z.number().int().min(0),
  reason: z.string().trim().max(200).optional(),
  dryRun: z.boolean().optional(),
});

const refuse = (error: string, code: string, status = 409) => NextResponse.json({ error, errorAr: error, code }, { status });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId, country } = await requireContext();

    // Order access first, then the authority evaluated against the order — as every door that moves a parcel's money does.
    const access = await assertOrderAccess(id, user, { companyId, storeId }, 'orders.view');
    if (!access.allowed) {
      return NextResponse.json({ error: 'الطلب غير موجود أو ليس بين يديك' }, { status: ORDER_ACCESS_STATUS[access.reason] });
    }
    const allowed = authorize(user, 'orders.change_fee', access.order);
    if (!allowed.allowed) {
      return NextResponse.json({ error: 'ما عندك صلاحية تغيير أجرة التوصيل.', errorAr: 'ما عندك صلاحية تغيير أجرة التوصيل.', code: 'FEE_FORBIDDEN' }, { status: 403 });
    }

    const parsed = body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'بيانات غير صالحة' }, { status: 400 });
    const { included, expectedVersion, reason, dryRun } = parsed.data;

    const order = await db.order.findFirst({
      where: { id, companyId, storeId },
      select: {
        id: true, orderNumber: true, version: true, confirmationStatus: true, shippingStatus: true, shippedAt: true,
        labelPrintedAt: true, trackingNumber: true, courierSendStartedAt: true, priceIncludesDelivery: true,
        totalAmount: true, deliveryFee: true, shippingCost: true, currency: true,
        shippingBatch: { select: { status: true, batchNumber: true } },
        items: { select: { quantity: true, freeQuantity: true, unitPrice: true, discountShare: true, lineTotal: true } },
        addOns: { select: { quantity: true, price: true } },
      },
    });
    if (!order) return NextResponse.json({ error: 'الطلب غير موجود' }, { status: 404 });

    if (order.confirmationStatus === 'CANCELLED' || order.confirmationStatus === 'REJECTED') {
      return refuse('الطلب ملغى أو مرفوض — ما في شي يتغيّر عليه.', 'ORDER_ENDED');
    }
    const seal = orderSeal({
      shippingBatch: order.shippingBatch,
      shippingStatus: order.shippingStatus,
      shippedAt: order.shippedAt,
      labelPrintedAt: order.labelPrintedAt,
    });
    if (seal.sealed) {
      return refuse(sealMessage(seal.batchNumber, ['shippingCost'], seal.reason), 'ORDER_SEALED');
    }
    if (order.trackingNumber || order.courierSendStartedAt) {
      return refuse('الطلب انرحّل للشركة بمبلغه — ما بيتغيّر من هون.', 'ALREADY_WITH_COURIER');
    }
    if (order.version !== expectedVersion) {
      return refuse('الطلب تغيّر من حدا تاني. حدّث الصفحة وجرّب من جديد.', 'STALE_ORDER');
    }

    const was = order.priceIncludesDelivery === true;
    const stored = Number(order.totalAmount ?? 0);
    if (was === included) {
      return NextResponse.json({ unchanged: true, included, totalBefore: stored, totalAfter: stored, version: order.version });
    }

    // The figure moves by exactly what the flag moves it by: the same calculator, asked with the flag as it is and as it will be.
    const minorUnit = country.minorUnit;
    const fee = Number(order.deliveryFee ?? order.shippingCost ?? 0);
    const ask = (priceIncludesDelivery: boolean) =>
      codForOrder({ lines: order.items, addOns: order.addOns, deliveryFee: fee, priceIncludesDelivery, minorUnit }).cod;
    const delta = roundMinor(ask(included) - ask(was), minorUnit);
    const next = roundMinor(stored + delta, minorUnit);
    if (next < 0) return refuse('المبلغ ما بيصير بالسالب — راجع الطلب.', 'NEGATIVE_TOTAL');

    if (dryRun) {
      return NextResponse.json({ dryRun: true, included, totalBefore: stored, totalAfter: next, delta, currency: order.currency });
    }

    // The write repeats the question: the version is what moved if somebody put it on a trolley, printed it or sent it meanwhile.
    const written = await db.order.updateMany({
      where: {
        id, companyId, storeId, version: order.version,
        labelPrintedAt: null, shippedAt: null, trackingNumber: null, courierSendStartedAt: null,
        confirmationStatus: { notIn: ['CANCELLED', 'REJECTED'] },
      },
      data: { priceIncludesDelivery: included, totalAmount: next, version: { increment: 1 } },
    });
    if (written.count !== 1) {
      return refuse('الطلب تغيّر قبل ما ينحفظ التعديل — ما انحفظ شي. حدّث الصفحة وجرّب من جديد.', 'ORDER_MOVED_ON');
    }

    await db.orderActivity.create({
      data: {
        companyId, orderId: id, userId: user.id, action: 'DELIVERY_INCLUDED_CHANGED',
        metadata: JSON.stringify({ from: was, to: included, totalBefore: stored, totalAfter: next, ...(reason ? { reason } : {}) }),
      },
    });
    await logAudit({
      companyId, userId: user.id, action: 'ORDER_DELIVERY_INCLUDED_CHANGED', entity: 'Order', entityId: id,
      previousData: { priceIncludesDelivery: was, totalAmount: stored },
      newData: { priceIncludesDelivery: included, totalAmount: next, ...(reason ? { reason } : {}) },
    });

    return NextResponse.json({ changed: true, included, totalBefore: stored, totalAfter: next, delta, currency: order.currency, version: order.version + 1 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
