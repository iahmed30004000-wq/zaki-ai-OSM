import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { notify } from '@/lib/notify';
import { zodMessage } from '@/lib/zod-message';
import { authorises, expandApproved } from '@/lib/change-request-apply';
import { changeFieldLabel } from '@/lib/change-request-fields';
import { courierActionFor } from '@/lib/couriers/change';
import { orderSeal, sealedFieldsIn, handedToCourier } from '@/lib/order-seal';
import { mayDecide } from '@/lib/change-request-routing';
import { createReplacement, type ReplacementSource } from '@/lib/replacement-order';
import { ACTIVITY_ROLE } from '@/lib/superseded';

/**
 * POST /api/orders/:id/reorder — the waybill is cancelled; here is the new order.
 *
 * THE HALF THAT WAS MISSING. A change to the goods on a parcel the courier
 * is already holding cannot be an edit — no dispatcher opens a carton — so
 * `courierActionFor` answers CANCEL_AND_REORDER and the screen sends them a
 * message saying, in as many words, «نرجو إلغاء هذه البوليصة… وسنرسل لكم
 * بوليصة جديدة بالطلب المعدّل».
 *
 * And then the button under that message wrote the change onto the SAME
 * order. The courier had been told the waybill was cancelled; our record
 * kept the parcel in shipping, under their barcode, with a quantity that
 * was never in the carton. The promised new order was never sent, because
 * nothing anywhere made one.
 *
 * So this makes it. The original ends as RETURN_REQUESTED — the parcel is
 * physically coming back and its goods return through the returns door,
 * counted, which is the same ending the transfer path gives a parcel taken
 * back from a company. The replacement is built by the one builder both
 * paths share, carrying the approved change, and it re-enters at
 * preparation with no courier and no batch: it is a parcel to be packed
 * again, and who takes it is the next decision, not this one.
 *
 * WHAT IT DOES NOT DO is decide that any of this is allowed. The seal is
 * re-read here, the request is re-read here, and both must still say what
 * they said when the screen asked.
 */

const schema = z.object({
  changeRequestId: z.string().uuid(),
  /** Somebody is saying the courier has been told. Nothing moves without it. */
  courierNotified: z.literal(true),
});

/** What a reorder can carry: the goods, and what is charged for them. */
const REORDERABLE = ['quantity', 'discountAmount'] as const;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId, country } = await requireContext();

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }

    const request = await db.orderChangeRequest.findFirst({
      where: { id: parsed.data.changeRequestId, companyId },
      select: {
        id: true, orderId: true, status: true, appliedAt: true, intent: true,
        changes: true, reason: true, decisionNote: true, requestedById: true,
      },
    });
    if (!request) return NextResponse.json({ error: 'طلب التعديل غير موجود' }, { status: 404 });

    const verdict = authorises(request, 'EDIT', id);
    if (!verdict.ok) {
      return NextResponse.json({ error: verdict.error, code: verdict.code }, { status: verdict.status });
    }
    /**
     * Whoever may decide one may carry out the one they decided — the same
     * rule the stand-down door uses, and for the same measured reason: the
     * people the queue is addressed to are not the people who hold
     * `orders.unlock`.
     */
    if (!can(user, 'control.change_requests') && !can(user, 'orders.edit')) {
      return NextResponse.json({ error: 'لا تملك صلاحية تنفيذ هذا القرار' }, { status: 403 });
    }

    const expanded = expandApproved(request);
    if (!expanded.ok) {
      return NextResponse.json({ error: expanded.error, code: expanded.code }, { status: expanded.status });
    }

    const order = await db.order.findFirst({
      where: { id, companyId, storeId },
      include: { replacedBy: { select: { orderNumber: true } } },
    });
    if (!order) return NextResponse.json({ error: 'الطلب غير موجود' }, { status: 404 });
    /*
     * AND WHO DECIDES THIS ORDER, AS THE APPLY DOOR ASKS.
     *
     * The check above is any grant at all: `orders.edit` limited to the
     * agent's own orders passed it, for any order in the store, and this
     * door cancels the parcel and creates a replacement with stock held.
     * The ordinary apply path asks who decides THIS order (mayApply →
     * mayDecide); so does this one now.
     */
    const routing = mayDecide(user, {
      confirmationStatus: order.confirmationStatus,
      claimedById: order.claimedById ?? null,
      handedToCourier: handedToCourier({ shippingStatus: order.shippingStatus, shippedAt: order.shippedAt ?? null }),
    });
    if (!routing.allowed) {
      return NextResponse.json(
        { error: routing.reason ?? 'لا تملك صلاحية تنفيذ هذا القرار', code: 'NOT_THE_DECIDER' },
        { status: 403 }
      );
    }
    if (order.replacedBy) {
      return NextResponse.json(
        { error: `صدر لهذا الطلب بديل مسبقاً (${order.replacedBy.orderNumber})`, code: 'ALREADY_REPLACED' },
        { status: 409 }
      );
    }

    /**
     * THE SEAL IS RE-READ, AND IT MUST STILL SAY REORDER.
     *
     * A parcel that came back while the message was being written is no
     * longer sealed, and the ordinary apply path — money, audit, one
     * route — is the right door for it. An address change is CONTACT_CHANGE
     * and belongs there too: cancelling a waybill a dispatcher could have
     * fixed in thirty seconds costs a delivery and a return for nothing.
     */
    const batch = await db.shippingBatch.findFirst({
      where: { orders: { some: { id } }, companyId },
      select: { status: true, batchNumber: true },
    });
    const seal = orderSeal({
      shippingBatch: batch,
      shippingStatus: order.shippingStatus,
      shippedAt: order.shippedAt,
      labelPrintedAt: order.labelPrintedAt,
    });
    const sealedAsked = sealedFieldsIn(expanded.fields);
    /*
     * BEFORE THE COMPANY TOOK THE PARCEL THERE IS NOTHING TO CANCEL AND REORDER (28/10).
     *
     * A printed waybill seals an order (`orderSeal`), and a goods change on a sealed order
     * used to land here — which closed the parcel as RETURN_REQUESTED, a return for a box
     * that never left our floor, and raised a second order for the same goods. The owner's
     * ruling: until «إغلاق الشحنة — سُلّمت للشركة» an approved goods edit is made on the
     * SAME order and its waybill is printed again. That is the apply door's work, so this
     * door answers it by name instead of making a replacement.
     */
    const handed = handedToCourier({
      shippingStatus: order.shippingStatus,
      shippedAt: order.shippedAt,
      batchStatus: batch?.status ?? null,
    });
    if (!handed) {
      return NextResponse.json(
        {
          error: 'الطرد ما انسلّم للشركة بعد — التعديل بيتطبّق على نفس الطلب وبتنعاد طباعة بوليصته، بلا طلب بديل. طبّقه من زرّ التطبيق.',
          code: 'NOT_A_REORDER',
        },
        { status: 409 }
      );
    }
    if (!seal.sealed || courierActionFor(sealedAsked) !== 'CANCEL_AND_REORDER') {
      return NextResponse.json(
        {
          error: 'هذا التعديل لا يحتاج طلباً بديلاً — طبّقه من زرّ التطبيق.',
          code: 'NOT_A_REORDER',
        },
        { status: 409 }
      );
    }

    // Only the goods travel to a new order. A request mixing a contact
    // field in would have its address silently dropped here, so it is
    // named and refused instead — the dialog raises one field at a time.
    const stray = Object.keys(expanded.fields).filter(
      (f) => !(REORDERABLE as readonly string[]).includes(f)
    );
    if (stray.length > 0) {
      return NextResponse.json(
        {
          error: `«${stray.map(changeFieldLabel).join('، ')}» لا تُحمل على طلبٍ بديل — افصلها في طلبٍ خاص.`,
          code: 'NOT_REORDERABLE',
        },
        { status: 422 }
      );
    }

    const overrides = {
      quantity: typeof expanded.fields.quantity === 'number' ? expanded.fields.quantity : undefined,
      discountAmount:
        typeof expanded.fields.discountAmount === 'number' ? expanded.fields.discountAmount : undefined,
    };

    const run = (attempt: number) =>
      db.$transaction(async (tx) => {
        // The original's leg is closed: the parcel is coming back, and its
        // goods return to stock when the return is received and counted —
        // never here, on our say-so, while a box is still in a van.
        const closed = await tx.order.updateMany({
          where: { id: order.id, companyId, version: order.version },
          data: {
            shippingStatus: 'RETURN_REQUESTED',
            returnReason: 'CUSTOMER_REQUEST',
            version: { increment: 1 },
          },
        });
        if (closed.count !== 1) throw new Error('VERSION_CONFLICT');

        const replacement = await createReplacement(tx, {
          companyId,
          createdById: user.id,
          order: order as unknown as ReplacementSource,
          orderPrefix: country.orderPrefix,
          attempt,
          minorUnit: country.minorUnit,
          allowNegativeStock: country.allowNegativeStock,
          // Packed again from scratch; who carries it is the next decision.
          shippingStatus: 'READY_FOR_SHIPPING',
          deliveryProviderId: null,
          shippingBatchId: null,
          internalNotes: `بديل عن ${order.orderNumber} بعد إلغاء البوليصة: ${request.reason}`,
          overrides,
        });

        // Both ends of the story, on both orders, so neither can be read
        // without the other.
        for (const [orderId, body, role] of [
          [order.id, `أُلغيت بوليصتُه لدى شركة الشحن وصدر البديل ${replacement.orderNumber} — ${request.reason}`, ACTIVITY_ROLE.original],
          [replacement.id, `بديل عن ${order.orderNumber} بعد تعديلٍ معتمَد — ${request.reason}`, ACTIVITY_ROLE.replacement],
        ] as const) {
          await tx.orderNote.create({
            data: { companyId, orderId, authorId: user.id, kind: 'internal', body },
          });
          await tx.orderActivity.create({
            data: {
              companyId, orderId, userId: user.id,
              action: 'CHANGE_REQUEST_REORDERED',
              // The role says which side of the pair this copy is on —
              // see src/lib/superseded.ts.
              metadata: JSON.stringify({
                role,
                requestId: request.id,
                original: order.orderNumber,
                replacement: replacement.orderNumber,
              }),
            },
          });
        }

        // Once. A second, concurrent press raises no second order.
        await tx.orderChangeRequest.updateMany({
          where: { id: request.id, appliedAt: null },
          data: { appliedAt: new Date(), appliedById: user.id },
        });

        return replacement;
      });

    // A duplicate order number means somebody took it between reading the
    // highest and inserting; step the number on and run the whole thing
    // again. On Postgres a failed statement aborts the transaction, so the
    // retry cannot live inside it.
    let replacement: Awaited<ReturnType<typeof run>> | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        replacement = await run(attempt);
        break;
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === 'P2002' && attempt < 4) continue;
        throw e;
      }
    }
    if (!replacement) {
      return NextResponse.json({ error: 'تعذّر إصدار رقم للطلب البديل — أعد المحاولة' }, { status: 409 });
    }

    await logAudit({
      companyId,
      userId: user.id,
      action: 'CHANGE_REQUEST_REORDERED',
      entity: 'Order',
      entityId: order.id,
      previousData: { shippingStatus: order.shippingStatus },
      newData: {
        requestId: request.id,
        replacementId: replacement.id,
        replacementNumber: replacement.orderNumber,
        overrides,
      },
    });

    if (request.requestedById !== user.id) {
      notify({
        companyId,
        storeId: order.storeId ?? storeId,
        audience: { userIds: [request.requestedById] },
        actorId: user.id,
        title: `صدر بديلٌ عن ${order.orderNumber}`,
        message: `أُلغيت البوليصة وصدر ${replacement.orderNumber} بالتعديل: ${request.reason}`,
        type: 'SYSTEM_ALERT',
        link: `/orders?highlight=${replacement.id}`,
      });
    }

    return NextResponse.json({ replacement });
  } catch (error) {
    if (error instanceof Error && error.message === 'VERSION_CONFLICT') {
      return NextResponse.json(
        { error: 'تغيّر الطلب أثناء العمل عليه — حدّث الصفحة', code: 'VERSION_CONFLICT' },
        { status: 409 }
      );
    }
    return apiErrorResponse(error);
  }
}
