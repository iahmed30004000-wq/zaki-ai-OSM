import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { mayDecide } from '@/lib/change-request-routing';
import { touchesMoney } from '@/lib/change-request-fields';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { zodMessage } from '@/lib/zod-message';
import { createNotification } from '@/lib/notification';
import { handedToCourier } from '@/lib/order-seal';
import { afterResponse } from '@/lib/notify';

/**
 * PATCH /api/control/change-requests/:id — decide one request.
 *
 * Approving unblocks the order and records the decision; it does NOT rewrite
 * the order by itself, because an approved change may touch quantity, offer
 * or discount, and those must run through the order's own money path rather
 * than a blind field copy. The response lists the fields to apply.
 *
 * There is no auto-approval anywhere: an expired SLA escalates, silence is
 * never consent.
 */
const decideSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  note: z.string().trim().max(500).optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();

    const parsed = decideSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }
    if (parsed.data.decision === 'REJECTED' && !parsed.data.note) {
      return NextResponse.json({ error: 'الرفض يتطلب سبباً' }, { status: 400 });
    }

    const request = await db.orderChangeRequest.findFirst({
      where: { id, companyId, order: { storeId } },
      // Who may decide depends on how far the order has travelled, so the
      // stage travels with the request.
      include: {
        order: {
          // What `handedToCourier` reads: the warehouse may decide until
          // the courier takes the parcel, and not after — a printed label
          // is not the line. See change-request-routing.
          select: {
            id: true, orderNumber: true, confirmationStatus: true, claimedById: true,
            shippingStatus: true, shippedAt: true,
            shippingBatch: { select: { status: true } },
          },
        },
      },
    });
    if (!request) return NextResponse.json({ error: 'طلب التعديل غير موجود' }, { status: 404 });
    if (request.status !== 'PENDING') {
      return NextResponse.json({ error: 'تم البت في هذا الطلب مسبقاً', code: 'ALREADY_DECIDED' }, { status: 409 });
    }
    if (request.requestedById === user.id) {
      return NextResponse.json(
        { error: 'لا يمكنك اعتماد طلب تعديل قدّمته بنفسك', code: 'SELF_APPROVAL' },
        { status: 403 }
      );
    }

    // The only person who can answer "can this still be changed?" is the one
    // holding the order. Before confirmation that is the agent on the phone
    // with the customer; after it the order is in a batch or on a van and the
    // question becomes whether the courier can still be reached — which was
    // never the agent's authority. A supervisor may decide either way, so an
    // escalation path never depends on one person being at their desk.
    const routing = mayDecide(user, {
      ...request.order,
      handedToCourier: handedToCourier({
        shippingStatus: request.order.shippingStatus,
        shippedAt: request.order.shippedAt,
        batchStatus: request.order.shippingBatch?.status ?? null,
      }),
    }, {
      // APPROVING a request that moves a price, a discount, a quantity or a product needs `orders.change_price` too (PR-7).
      // Rejecting never does: refusing a figure changes none.
      money: parsed.data.decision === 'APPROVED' && touchesMoney(request.changes),
    });
    if (!routing.allowed) {
      return NextResponse.json(
        {
          error: routing.reason,
          errorAr: routing.reason,
          code: routing.code ?? 'NOT_THE_DECIDER',
          decider: routing.decider,
        },
        { status: 403 }
      );
    }

    const decided = await db.$transaction(async (tx) => {
      const updated = await tx.orderChangeRequest.update({
        where: { id },
        data: {
          status: parsed.data.decision,
          decidedById: user.id,
          decidedAt: new Date(),
          decisionNote: parsed.data.note ?? null,
        },
      });
      await tx.orderNote.create({
        data: {
          companyId,
          orderId: request.orderId,
          authorId: user.id,
          kind: 'internal',
          body:
            parsed.data.decision === 'APPROVED'
              ? `تم اعتماد طلب التعديل${parsed.data.note ? `: ${parsed.data.note}` : ''}`
              : `تم رفض طلب التعديل: ${parsed.data.note}`,
        },
      });
      return updated;
    });

    await logAudit({
      companyId,
      userId: user.id,
      action: parsed.data.decision === 'APPROVED' ? 'CHANGE_REQUEST_APPROVED' : 'CHANGE_REQUEST_REJECTED',
      entity: 'OrderChangeRequest',
      entityId: id,
      previousData: { status: 'PENDING' },
      newData: { status: parsed.data.decision, note: parsed.data.note ?? null },
    });

    /**
     * AND THE ANSWER GOES BACK TO WHOEVER ASKED.
     *
     * This was the hole. Raising a request notified the decider, and an
     * overdue one notified the supervisors, and the DECISION notified
     * nobody at all — there was not one call in this file. The agent
     * presses «طلب تعديل» with the customer on the phone, and whether the
     * answer came an hour ago or never is the same screen to her. So she
     * rings a supervisor to ask, which is what the request existed to stop.
     *
     * Approved is not finished: the change is written onto the order in a
     * second step, so the message says which of the two happened. The
     * rejection carries its reason, because «لا» without one sends her
     * straight back to ask why.
     *
     * Never to the decider — being told your own decision is noise, the
     * same rule the raise already follows.
     */
    if (request.requestedById !== user.id) {
      const approved = parsed.data.decision === 'APPROVED';
      afterResponse(async () => {
        await createNotification({
          companyId,
          storeId,
          actorId: user.id,
          audience: { userIds: [request.requestedById] },
          type: 'SYSTEM_ALERT',
          title: approved
            ? `اعتُمد تعديلك على ${request.order.orderNumber}`
            : `رُفض تعديلك على ${request.order.orderNumber}`,
          message: approved
            ? `${user.name ?? 'المشرف'} اعتمده — ويُطبَّق على الطلب في خطوة التطبيق.${parsed.data.note ? ` ${parsed.data.note}` : ''}`
            : `${user.name ?? 'المشرف'}: ${parsed.data.note}`,
          link: ['/orders', '/confirmation/mine', '/control/change-requests'],
        });
      });
    }

    return NextResponse.json({
      request: decided,
      // The approved fields still have to be applied through the order APIs.
      fieldsToApply: parsed.data.decision === 'APPROVED' ? decided.changes : null,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}


/**
 * DELETE /api/control/change-requests/:id — take back a request you raised.
 *
 * `CANCELLED` was in the status list from the beginning and nothing ever
 * wrote it, so a request raised by mistake could not be undone by anyone —
 * and a PENDING request is not inert. A blocking one refuses every forward
 * shipping transition on that order, and ANY pending one refuses a second
 * request on it. So one wrong press froze the order until a supervisor
 * happened to open the queue and reject it, and until then nobody could
 * even raise the corrected request.
 *
 * ONLY THE REQUESTER, and only while it is still pending. A supervisor who
 * wants it gone rejects it with a reason — that is a decision, it is
 * already here, and it is what the requester needs to hear. Letting a
 * supervisor withdraw instead would be the same act under a name that
 * records nothing.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();

    const request = await db.orderChangeRequest.findFirst({
      where: { id, companyId, order: { storeId } },
      select: { id: true, orderId: true, status: true, requestedById: true, reason: true },
    });
    if (!request) return NextResponse.json({ error: 'طلب التعديل غير موجود' }, { status: 404 });
    if (request.requestedById !== user.id) {
      return NextResponse.json(
        { error: 'يسحب الطلبَ من رفعه — والمشرف يرفضه بسببٍ مكتوب', code: 'NOT_THE_REQUESTER' },
        { status: 403 }
      );
    }
    if (request.status !== 'PENDING') {
      return NextResponse.json(
        { error: 'تم البت في هذا الطلب مسبقاً', code: 'ALREADY_DECIDED' },
        { status: 409 }
      );
    }

    await db.$transaction(async (tx) => {
      // Pending, here too: the supervisor may be deciding it this second,
      // and a decision that lands first wins rather than being overwritten.
      const res = await tx.orderChangeRequest.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: 'CANCELLED', decidedById: user.id, decidedAt: new Date() },
      });
      if (res.count !== 1) throw new Error('ALREADY_DECIDED');
      await tx.orderNote.create({
        data: {
          companyId,
          orderId: request.orderId,
          authorId: user.id,
          kind: 'internal',
          body: `سحب طلب التعديل: ${request.reason}`,
        },
      });
    });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'CHANGE_REQUEST_WITHDRAWN',
      entity: 'OrderChangeRequest',
      entityId: id,
      previousData: { status: 'PENDING' },
      newData: { status: 'CANCELLED' },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === 'ALREADY_DECIDED') {
      return NextResponse.json(
        { error: 'تم البت في هذا الطلب مسبقاً', code: 'ALREADY_DECIDED' },
        { status: 409 }
      );
    }
    return apiErrorResponse(error);
  }
}
