import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { ORDER_ACCESS_STATUS, assertOrderAccess } from '@/lib/rbac';
import { authorize, can } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { orderSeal, type Seal } from '@/lib/order-seal';
import { codForOrder } from '@/lib/delivery-fees';
import { roundMinor } from '@/lib/money';
import { logAudit } from '@/lib/audit';

/**
 * POST /api/orders/[id]/delivery-included  { included, expectedVersion, reason?, dryRun? }
 *
 * «شامل التوصيل» FOR AN ORDER THAT ALREADY EXISTS — and has not left yet.
 *
 * The box on the order form (1/11) says it when the order is written. An order written without it — a price typed equal to an
 * offer's, a Telegram order, a sheet — is a plain price, and the courier's fee is added to what the courier collects when the
 * shipment is made. There was no door to say «this price already carries delivery» afterwards: ORD-2026-1711 was collected at 23
 * for a 20$ line the customer had been told included it. This is that door, for the orders that can still be told apart from the
 * parcel.
 *
 *   WHICH ORDERS — not ended (cancelled, rejected), not sealed (`orderSeal`: its batch handed over, shipped, or its waybill
 *   printed), no courier barcode and no send claimed (after those the courier holds the amount), and not being edited by somebody
 *   else right now (the lock the shipping door and the edit door honour). What a FILE already out of the building holds — a CSV or
 *   an Excel of the batch, a page printed but not yet stamped — this door cannot know; the screen says so before the press.
 *
 *   WHAT IT WRITES — the flag, the total, and a version, together, in one transaction with the timeline row. The new total is what
 *   `codForOrder` answers for the new flag: asked fresh, never «the stored figure plus a difference».
 *
 *   AND ONLY WHEN THE STORED TOTAL AGREES WITH THE OLD FLAG (the independent review, 1/11). The courier's fee is a column of its own
 *   that the tracking form and a typed shipping cost edit WITHOUT touching the total, so a total can stop being what the calculator
 *   says for the fee beside it. The repo's rule for that state (`order-line-edit.ts` COD_DRIFT) is to refuse until the two agree, and
 *   so does this: an order whose total no longer follows its fee is for a person to reconcile, not for a flag to guess at.
 *
 *   WHO — whoever may change the delivery fee (`orders.change_fee`), which is what the flag decides: whether it is added.
 *
 * `dryRun` answers what it would do (`totalBefore`, `totalAfter`, `inBatch`) and writes nothing, through the SAME refusals, so the
 * screen can say the figure before the press. The arithmetic stays here: no screen computes a collection.
 */
const body = z.object({
  included: z.boolean(),
  expectedVersion: z.number().int().min(0),
  reason: z.string().trim().max(200).optional(),
  dryRun: z.boolean().optional(),
});

const refuse = (error: string, code: string, status = 409) => NextResponse.json({ error, errorAr: error, code }, { status });

/** Why the seal refuses THIS door, in words that fit it (the edit door's sentence sends a person to a request that cannot carry this). */
function sealedSentence(seal: Seal): string {
  if (seal.reason === 'LABELLED') return 'بوليصة الطلب طُبعت ولُصقت على الطرد — مبلغها ما بيتغيّر من هون.';
  if (seal.reason === 'SHIPPED') return 'الطلب شُحن وخرج من المستودع — مبلغه ما بيتغيّر من هون.';
  return `الطلب سُلِّم لشركة الشحن ضمن دفعة مقفلة${seal.batchNumber ? ` (${seal.batchNumber})` : ''} — مبلغه ما بيتغيّر من هون.`;
}

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
        totalAmount: true, deliveryFee: true, shippingCost: true, currency: true, lockedById: true, lockExpiresAt: true,
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
    if (seal.sealed) return refuse(sealedSentence(seal), 'ORDER_SEALED');
    if (order.trackingNumber || order.courierSendStartedAt) {
      return refuse('الطلب انرحّل للشركة بمبلغه — ما بيتغيّر من هون.', 'ALREADY_WITH_COURIER');
    }
    // Somebody is editing it right now (the same lock the shipping door and the edit door honour): her unsaved form would be lost.
    const locked = !!order.lockedById && !!order.lockExpiresAt && new Date(order.lockExpiresAt).getTime() > Date.now();
    if (locked && order.lockedById !== user.id && !can(user, 'orders.unlock')) {
      return refuse('حدا عم يعدّل هالطلب هلّق — انتظر لحد ما يخلص.', 'ORDER_LOCKED', 423);
    }
    if (order.version !== expectedVersion) {
      return refuse('الطلب تغيّر من حدا تاني. حدّث الصفحة وجرّب من جديد.', 'STALE_ORDER');
    }

    const was = order.priceIncludesDelivery === true;
    const stored = Number(order.totalAmount ?? 0);
    const inBatch = !!order.shippingBatch;
    if (was === included) {
      return NextResponse.json({ unchanged: true, included, totalBefore: stored, totalAfter: stored, inBatch, version: order.version });
    }

    // What the calculator says for this order's lines, add-ons and fee — with the flag as it is, and as it will be.
    const minorUnit = country.minorUnit;
    const fee = Number(order.deliveryFee ?? order.shippingCost ?? 0);
    const ask = (priceIncludesDelivery: boolean) =>
      codForOrder({ lines: order.items, addOns: order.addOns, deliveryFee: fee, priceIncludesDelivery, minorUnit }).cod;
    const asNow = ask(was);
    // The stored total must be what the calculator says for the flag the order has NOW. The fee is a column of its own that other
    // doors edit without touching the total; a total that stopped following it is for a person to reconcile (COD_DRIFT).
    if (Math.abs(stored - asNow) > 0.5 / 10 ** minorUnit + 1e-9) {
      return refuse(
        `مبلغ الطلب المحفوظ (${stored}) ما بيطابق حسابه (${asNow}) — الأجرة أو السعر اتعدّلوا لحالهم. راجع الطلب أول وبعدين غيّر «شامل التوصيل».`,
        'COD_DRIFT'
      );
    }
    // (No floor to add here: `computeCod` caps a discount at the goods and a fee at zero, so a collection is never below zero.)
    const next = ask(included);
    const delta = roundMinor(next - stored, minorUnit);

    if (dryRun) {
      return NextResponse.json({ dryRun: true, included, totalBefore: stored, totalAfter: next, delta, inBatch, currency: order.currency });
    }

    // The write repeats the question and goes in ONE transaction with the timeline row: the version is what moved if somebody put the
    // order on a trolley, printed it or sent it meanwhile, and a flip without its row is not a thing that can happen.
    const done = await db.$transaction(async (tx) => {
      const written = await tx.order.updateMany({
        where: {
          id, companyId, storeId, version: order.version,
          labelPrintedAt: null, shippedAt: null, trackingNumber: null, courierSendStartedAt: null,
          confirmationStatus: { notIn: ['CANCELLED', 'REJECTED'] },
        },
        data: { priceIncludesDelivery: included, totalAmount: next, version: { increment: 1 } },
      });
      if (written.count !== 1) return false;
      await tx.orderActivity.create({
        data: {
          companyId, orderId: id, userId: user.id, action: 'DELIVERY_INCLUDED_CHANGED',
          metadata: JSON.stringify({ from: was, to: included, totalBefore: stored, totalAfter: next, ...(reason ? { reason } : {}) }),
        },
      });
      return true;
    });
    if (!done) {
      return refuse('الطلب تغيّر قبل ما ينحفظ التعديل — ما انحفظ شي. حدّث الصفحة وجرّب من جديد.', 'ORDER_MOVED_ON');
    }

    await logAudit({
      companyId, userId: user.id, action: 'ORDER_DELIVERY_INCLUDED_CHANGED', entity: 'Order', entityId: id,
      previousData: { priceIncludesDelivery: was, totalAmount: stored },
      newData: { priceIncludesDelivery: included, totalAmount: next, ...(reason ? { reason } : {}) },
    });

    return NextResponse.json({ changed: true, included, totalBefore: stored, totalAfter: next, delta, inBatch, currency: order.currency, version: order.version + 1 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
