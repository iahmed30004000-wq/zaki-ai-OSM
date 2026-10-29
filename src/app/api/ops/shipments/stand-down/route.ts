import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission, can } from '@/lib/authorization';
import { authorises } from '@/lib/change-request-apply';
import { apiErrorResponse } from '@/lib/api-error';
import { zodMessage } from '@/lib/zod-message';
import { logAudit } from '@/lib/audit';
import { cancelVerdict } from '@/lib/shipment-cancel';
import { batchStatusOf, endOrder } from '@/lib/order-cancel';
import { REJECTION_REASONS } from '@/lib/confirmation-workflow';
import { courierCancelCarryOut } from '@/lib/courier-cancel-carryout';
import { notify } from '@/lib/notify';

/**
 * POST /api/ops/shipments/stand-down — this parcel is not going out.
 *
 * ONE DOOR, TWO OUTCOMES, because they are the same moment: somebody standing
 * at the packing table decides a confirmed order is not shipping. Either the
 * customer needs talking to again, or it is over.
 *
 * WHY IT IS NOT THE CONFIRMATION ENDPOINT. That door belongs to the
 * confirmation team and is gated on their permissions; the shipping role
 * holds `ops.ship` and `orders.change_status` and none of theirs. Reaching
 * through it would mean widening a confirmation permission to a role that
 * does not do confirmation.
 *
 * WHY IT IS NOT THE EXISTING HOLD. `/api/ops/shipments/hold` keeps the order
 * CONFIRMED with its stock still reserved and sets `shipHoldUntil` — a field
 * read by exactly two files, so a held order is invisible to everyone except
 * whoever opens the held view on this one screen, and it defaults to FOREVER.
 * That is a different thing (we cannot ship today, the customer still wants
 * it) and it stays for that. This is for when the ORDER, not the shipment,
 * has to stop.
 *
 * BOTH OUTCOMES RELEASE THE RESERVATION, IN THE SAME TRANSACTION. That is the
 * contract's own rule — «reservation is released in the same transaction on
 * CANCELLED, VOIDED, unconfirm» — and the reason for it is plain: stock held
 * by an order that is not going anywhere is stock the next customer is told
 * we do not have.
 *
 * ── UNTIL «إغلاق الشحنة — سُلّمت للشركة» (M6, 28/10) ──
 *
 * Both outcomes are possible for as long as the parcel is ours: labelled, on
 * the pickup shelf, even on a trolley that has not been pressed. They go
 * through `endOrder` — the one helper every cancel door uses — which takes
 * the order off the trolley, asks the company to cancel a barcode it already
 * holds, and counts packed goods back only on a person's word
 * (`parcelInHand`). Only after the press does a cancel become a message to
 * the company instead.
 */

const schema = z.object({
  orderId: z.string().uuid(),
  outcome: z.enum(['POSTPONE', 'CANCEL']),
  /** For POSTPONE: when to try again. The follow-up screen works by date. */
  until: z.string().datetime({ offset: true }).or(z.string().datetime()).optional(),
  /** For CANCEL: one of the structured reasons, never free text. */
  reason: z.string().optional(),
  note: z.string().trim().max(500).optional(),
  /**
   * AN APPROVED CANCEL OR POSTPONE REQUEST, CARRIED OUT.
   *
   * The agent on the phone cannot stand a shipment down — `ops.ship` is the
   * packing table's permission, not hers. What she can do is ask, through
   * the change-request door, and somebody who may decide decides. This is
   * that decision being carried out, and it is the same two outcomes this
   * route already performs, with the same guards.
   */
  changeRequestId: z.string().uuid().optional(),
  /**
   * For an approved CANCEL on a parcel the courier already holds: a person
   * says the company has been told. Not a permission — a statement, recorded
   * with the name of whoever made it, same as the edit path's.
   */
  courierNotified: z.literal(true).optional(),
  /**
   * «الطرد بين يديّ — فككتُه وأعدتُ قطعه للرف وأتلفتُ بوليصته». Required when
   * the parcel is labelled or on the pickup shelf: its goods are packed under
   * this order's name, and counting them back without anyone having opened
   * the box invents stock. A statement, recorded with the name of whoever
   * made it — not a permission.
   */
  parcelInHand: z.literal(true).optional(),
});

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }
    const { orderId, outcome, note, changeRequestId, courierNotified, parcelInHand } = parsed.data;
    let { until, reason } = parsed.data;

    /**
     * WHO MAY: the packing table, or a decision that says so.
     *
     * `requirePermission` moved down here from the top of the handler so
     * the second door exists at all. It is still the ONLY way in without a
     * request — the approved request does not widen `ops.ship`, it stands
     * beside it, and it is read from the database rather than believed.
     */
    let viaRequest: {
      id: string; requestedById: string; reason: string;
      postponeUntil: Date | null; cancelReason: string | null;
    } | null = null;
    if (changeRequestId) {
      const request = await db.orderChangeRequest.findFirst({
        where: { id: changeRequestId, companyId },
        select: {
          id: true, orderId: true, status: true, appliedAt: true, intent: true,
          reason: true, requestedById: true, postponeUntil: true, cancelReason: true,
        },
      });
      if (!request) return NextResponse.json({ error: 'طلب التعديل غير موجود' }, { status: 404 });
      const verdict = authorises(request, outcome === 'CANCEL' ? 'CANCEL' : 'POSTPONE', orderId);
      if (!verdict.ok) {
        return NextResponse.json({ error: verdict.error, code: verdict.code }, { status: verdict.status });
      }
      // Whoever may decide one may carry out the one they decided.
      if (!can(user, 'control.change_requests') && !can(user, 'ops.ship')) {
        return NextResponse.json({ error: 'لا تملك صلاحية تنفيذ هذا القرار' }, { status: 403 });
      }
      viaRequest = {
        id: request.id,
        requestedById: request.requestedById,
        reason: request.reason,
        postponeUntil: request.postponeUntil,
        cancelReason: request.cancelReason,
      };
    } else {
      await requirePermission('ops.ship');
    }

    /**
     * AND THE VALUES COME FROM WHAT WAS APPROVED.
     *
     * The same rule the edit path states: «the browser sends the request's
     * id and nothing else; the VALUES come from the approved request, on
     * the server». A date or a reason riding along in the body would make
     * «an approved postponement to Thursday» a way to hold an order until
     * next year.
     */
    if (viaRequest) {
      until = viaRequest.postponeUntil ? viaRequest.postponeUntil.toISOString() : undefined;
      reason = viaRequest.cancelReason ?? undefined;
    }

    const order = await db.order.findFirst({
      where: { id: orderId, companyId, storeId },
      select: {
        id: true, orderNumber: true, version: true, confirmationStatus: true,
        shippingStatus: true, shippedAt: true, labelPrintedAt: true, shippingBatchId: true,
        // For the message to the company when the parcel is already theirs.
        trackingNumber: true, deliveryProviderId: true,
      },
    });
    if (!order) return NextResponse.json({ error: 'الطلب غير موجود' }, { status: 404 });

    /**
     * NOT AFTER THE COURIER HAS TAKEN IT.
     *
     * The line is the press of «إغلاق الشحنة — سُلّمت للشركة», not the
     * printer: until then the box is on our floor. Once the company has the
     * parcel this is no longer a decision about a shipment — it is a message
     * to them and a return, counted and inspected when it comes back.
     */
    const gate = cancelVerdict({
      confirmationStatus: order.confirmationStatus,
      shippingStatus: order.shippingStatus,
      shippedAt: order.shippedAt,
      labelPrintedAt: order.labelPrintedAt,
      shippingBatchId: order.shippingBatchId,
      batchStatus: await batchStatusOf(db, order.shippingBatchId),
    });
    if (!gate.allowed) {
      /*
       * AN APPROVED CANCEL IS NOT A DEAD END.
       *
       * Refusing here was right for the order — it must not be cancelled
       * under a parcel in a van — and wrong for the approval: the request
       * stayed «waiting to be applied» for ever and the courier was never
       * asked to stop the parcel. So an approved CANCEL gets the message to
       * the company; once a person says it was sent, the request is marked
       * carried out. The order itself is untouched and the goods come back
       * through the returns door, counted. Anything else keeps the refusal.
       *
       * ONLY WHEN THE COMPANY HAS THE PARCEL. A trolley that has not been
       * pressed is still ours: that case never reaches here, because the
       * gate allows it. The old version let «أبلغتُهم» mark a request carried
       * out while the parcel still stood on our trolley — which hid the
       * request from the press and sent a cancelled parcel.
       */
      if (viaRequest && outcome === 'CANCEL' && gate.code === 'CANCEL_AFTER_SHIPPED') {
        const out = await courierCancelCarryOut({
          companyId, storeId, user, courierNotified: courierNotified === true,
          order: {
            id: order.id, orderNumber: order.orderNumber,
            trackingNumber: order.trackingNumber, deliveryProviderId: order.deliveryProviderId,
          },
          request: viaRequest,
        });
        return NextResponse.json(out.body, { status: out.status });
      }
      return NextResponse.json({ error: gate.message, errorAr: gate.message, code: gate.code }, { status: 409 });
    }

    if (order.confirmationStatus !== 'CONFIRMED') {
      return NextResponse.json(
        { error: 'هذا الطلب ليس مؤكَّداً — لا شيء يُوقَف', code: 'NOT_CONFIRMED' },
        { status: 409 }
      );
    }

    let data: Record<string, unknown>;
    let auditAction: string;
    let noteBody: string;

    if (outcome === 'POSTPONE') {
      if (!until) {
        return NextResponse.json({ error: 'موعد المحاولة القادمة مطلوب' }, { status: 400 });
      }
      const due = new Date(until);
      if (isNaN(due.getTime()) || due.getTime() < Date.now() - 60_000) {
        return NextResponse.json({ error: 'الموعد يجب أن يكون في المستقبل' }, { status: 400 });
      }
      data = {
        // The confirmation is undone: the customer has to be spoken to again,
        // so the order goes back to being one somebody has to work.
        confirmationStatus: 'POSTPONED',
        status: 'POSTPONED',
        postponedUntil: due,
        nextFollowUpAt: due,
        postponeCount: { increment: 1 },
        followUpStatus: 'SCHEDULED',
        followUpReason: 'POSTPONED',
        confirmedAt: null,
        confirmedById: null,
        // Nobody holds it: it belongs to whoever is free when its date comes.
        claimedById: null,
        claimedAt: null,
        currentOwnerId: null,
        lockedById: null,
        lockedAt: null,
        signatureStatus: 'UNSIGNED',
      };
      auditAction = 'SHIPMENT_STOOD_DOWN_POSTPONED';
      noteBody = `أُوقف شحنه وأُعيد إلى المتابعة حتى ${due.toISOString().slice(0, 10)}${note ? ` — ${note}` : ''}`;
    } else {
      if (!reason || !(REJECTION_REASONS as readonly string[]).includes(reason)) {
        return NextResponse.json({ error: 'سبب الإلغاء مطلوب' }, { status: 400 });
      }
      if (reason === 'OTHER' && (!note || note.trim().length < 5)) {
        return NextResponse.json({ error: 'سبب «أخرى» يحتاج ملاحظة تشرحه' }, { status: 400 });
      }
      data = {
        claimedById: null,
        claimedAt: null,
        currentOwnerId: null,
        lockedById: null,
        lockedAt: null,
      };
      auditAction = 'SHIPMENT_STOOD_DOWN_CANCELLED';
      noteBody = `أُلغي قبل الشحن (${reason})${note ? ` — ${note}` : ''}`;
    }

    /**
     * ONE HELPER, ONE END STATE, ONE TRANSACTION.
     *
     * The conditional write (version, trolley, barcode, claim), the release
     * of the reservation, the status logs, the customer's count, the
     * activity «أُخرج من الدفعة» and the event for System 7 all live in
     * `endOrder` — the same place the confirmation's cancel, the shipping
     * screen's CANCELLED, the PATCH and the automatic close go through, so
     * they cannot end an order five different ways.
     */
    const ended = await endOrder({
      orderId: order.id,
      companyId,
      storeId,
      by: { id: user.id, name: user.name, role: user.role },
      door: 'STAND_DOWN',
      kind: outcome === 'POSTPONE' ? 'FOLLOW_UP' : 'CANCEL',
      endAs: 'CANCELLED',
      reason: outcome === 'CANCEL' ? reason : undefined,
      rejectionNote: outcome === 'CANCEL' ? note?.trim() || null : undefined,
      data,
      logNote: noteBody,
      // Whose ask this was. A cancellation that appears on an order with only
      // the deciding manager's name on it loses the agent's sentence — and
      // her sentence is the only record of what the customer actually said.
      noteBody: viaRequest ? `${noteBody} — بناءً على طلب: ${viaRequest.reason}` : noteBody,
      expectedVersion: order.version,
      parcelInHand: parcelInHand === true,
      viaRequest,
    });
    if (!ended.ok) {
      return NextResponse.json(
        { error: ended.error, errorAr: ended.error, code: ended.code, ...(ended.attestation ? { attestation: ended.attestation } : {}) },
        { status: ended.status }
      );
    }

    /**
     * AND THE PERSON WHO ASKED HEARS THAT IT IS DONE.
     *
     * «اعتُمد» and «نُفِّذ» are two different days for her: an approval sits
     * in «بانتظار التطبيق» until somebody carries it out, and until then
     * the order still says what it said. She told the customer it was
     * cancelled; she needs to know when it actually was.
     */
    if (viaRequest && viaRequest.requestedById !== user.id) {
      notify({
        companyId,
        storeId,
        audience: { userIds: [viaRequest.requestedById] },
        actorId: user.id,
        title: `نُفِّذ طلبك على ${order.orderNumber}`,
        message: outcome === 'CANCEL' ? `أُلغي الطلب: ${viaRequest.reason}` : `أُجِّل الطلب: ${viaRequest.reason}`,
        type: 'SYSTEM_ALERT',
        link: `/orders?highlight=${order.id}`,
      });
    }

    await logAudit({
      companyId, userId: user.id, action: auditAction,
      entity: 'Order', entityId: order.id,
      previousData: { confirmationStatus: 'CONFIRMED' },
      newData: { outcome, until: until ?? null, reason: reason ?? null, by: user.name },
    });

    return NextResponse.json({ success: true, orderNumber: order.orderNumber });
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
