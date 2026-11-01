import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/api-error';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { ORDER_ACCESS_STATUS, assertOrderAccess, assertOrderReadable } from '@/lib/rbac';
import { ORDER_WORK_DOOR } from '@/lib/order-work-door';
import { CONTACT_METHODS, CONTACT_RESULTS, NO_ANSWER_RESULTS } from '@/lib/confirmation-workflow';
import { logAudit } from '@/lib/audit';
import { NO_ANSWER_LIMIT } from '@/lib/confirmation-workflow';
import { endOrder } from '@/lib/order-cancel';
import { can, authorize } from '@/lib/authorization';
import { ORDER_NOT_FOUND } from '@/lib/order-refusals';
import { mustHoldToWork, NOT_HELD_MESSAGE } from '@/lib/confirmation-queue';

/**
 * GET  /api/orders/[id]/contact-attempts — chronological attempt history
 * POST /api/orders/[id]/contact-attempts — record one attempt (append-only)
 *
 * Server derives: employeeId, employeeRole, attemptNumber, createdAt.
 * Client can NEVER forge: companyId, employeeId, employeeRole, attemptNumber.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();
    const access = await assertOrderReadable(id, user, { companyId, storeId }, ORDER_WORK_DOOR);
    if (!access.allowed) {
      return NextResponse.json({ error: 'Order not found', errorAr: ORDER_NOT_FOUND }, { status: ORDER_ACCESS_STATUS[access.reason] });
    }

    const attempts = await db.orderContactAttempt.findMany({
      where: { orderId: id, companyId },
      orderBy: { attemptNumber: 'asc' },
      include: { employee: { select: { id: true, name: true } } },
    });

    const last = attempts.length ? attempts[attempts.length - 1] : null;
    return NextResponse.json({
      attempts,
      summary: {
        total: attempts.length,
        lastAttempt: last,
        lastEmployee: last?.employee?.name ?? null,
        lastResult: last?.result ?? null,
        nextFollowUpAt: last?.nextFollowUpAt ?? null,
      },
    });
  } catch (error: any) {
    return apiErrorResponse(error);
  }
}

function parseFollowUpDate(
  v: unknown
): { ok: true; date: Date | null } | { ok: false; error: string; errorAr: string } {
  if (v === undefined || v === null || v === '') return { ok: true, date: null };
  const d = new Date(v as string);
  if (isNaN(d.getTime())) return { ok: false, error: 'Invalid nextFollowUpAt date', errorAr: 'موعد المتابعة غير صالح.' };
  // Server-time check: follow-up must be in the future (1 min tolerance)
  if (d.getTime() < Date.now() - 60_000) return { ok: false, error: 'nextFollowUpAt must be in the future', errorAr: 'موعد المتابعة يجب أن يكون في المستقبل.' };
  return { ok: true, date: d };
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();

    /**
     * ── THE TELEPHONE HAS ITS OWN PERMISSION NOW ──
     *
     * This door used to open for `orders.edit` OR `orders.claim`, and the
     * `contact_result` action next door rode on `orders.confirm`. Three
     * permissions, none of them about recording what happened on a call —
     * so the owner could not grant or withhold it from «الصلاحيات» at all.
     *
     * `orders.contact_log` is granted on deploy to every role that held
     * any of those three, so nobody loses a door; from then on he unticks
     * per role.
     */
    if (!can(user, 'orders.contact_log')) {
      return NextResponse.json(
        {
          error: 'Forbidden: cannot record contact attempts',
          errorAr: 'لا تملك صلاحية تسجيل نتيجة الاتصال.',
          code: 'CONTACT_LOG_NOT_ALLOWED',
        },
        { status: 403 }
      );
    }

    if (!can(user, 'orders.edit') && !can(user, 'orders.claim')) {
      return NextResponse.json({ error: 'Forbidden: cannot record contact attempts' }, { status: 403 });
    }

    // The call she makes on the order she holds — the work door (order-work-door.ts).
    const access = await assertOrderAccess(id, user, { companyId, storeId }, ORDER_WORK_DOOR);
    if (!access.allowed) {
      return NextResponse.json({ error: 'Order not found or not assigned to you', errorAr: ORDER_NOT_FOUND }, { status: ORDER_ACCESS_STATUS[access.reason] });
    }
    const order = access.order;

    // Edit authority is scope-evaluated (ASSIGNED covers own-assignment);
    // claim holders may record attempts on the claimable queue.
    if (!authorize(user, 'orders.edit', order).allowed && !can(user, 'orders.claim')) {
      return NextResponse.json({ error: 'Forbidden: cannot record contact attempts', errorAr: 'لا تملك صلاحية تسجيل محاولات التواصل.' }, { status: 403 });
    }

    // AN AGENT WORKS ONLY THE ORDER SHE HOLDS (the owner, 1/11): the call she logs is on the order in her hands, as the confirmation
    // door next door asks. A supervisor and the owner log a call on any order, as before.
    if (mustHoldToWork((permission) => can(user, permission)) && order.claimedById !== user.id) {
      return NextResponse.json({ error: NOT_HELD_MESSAGE, errorAr: NOT_HELD_MESSAGE, code: 'NOT_HELD' }, { status: 403 });
    }

    const body = await req.json();
    const { contactMethod, result, note, nextFollowUpAt } = body as {
      contactMethod?: string; result?: string; note?: string; nextFollowUpAt?: string;
    };

    // ── Server-side validation (never trust frontend) ──
    if (!contactMethod || !(CONTACT_METHODS as readonly string[]).includes(contactMethod)) {
      return NextResponse.json({ error: 'Invalid contactMethod', errorAr: 'طريقة التواصل غير معروفة. اختر واحدة من القائمة.' }, { status: 400 });
    }
    if (!result || !(CONTACT_RESULTS as readonly string[]).includes(result)) {
      return NextResponse.json({ error: 'Invalid contact result', errorAr: 'نتيجة التواصل غير معروفة. اختر واحدة من القائمة.' }, { status: 400 });
    }
    if (note && note.length > 2000) {
      return NextResponse.json({ error: 'Note too long (max 2000)', errorAr: 'الملاحظة أطول من 2000 حرف. اختصرها.' }, { status: 400 });
    }
    const fu = parseFollowUpDate(nextFollowUpAt);
    if (!fu.ok) return NextResponse.json({ error: fu.error, errorAr: fu.errorAr }, { status: 400 });

    // Attempt number computed server-side; unique(orderId, attemptNumber) backstops races
    const lastAttempt = await db.orderContactAttempt.findFirst({
      where: { orderId: id },
      orderBy: { attemptNumber: 'desc' },
      select: { attemptNumber: true },
    });
    const attemptNumber = (lastAttempt?.attemptNumber ?? 0) + 1;

    // ── The 1/2/3 no-answer rule ──
    // The third no-answer closes the order under its OWN reason, in the same
    // transaction as the attempt, and releases the reservation. It is not a
    // customer rejection and must never be reported as one.
    const { attempt, autoClosed, noAnswerCount, announce } = await db.$transaction(async (tx) => {
      const created = await tx.orderContactAttempt.create({
        data: {
          companyId,            // from session — never client
          orderId: id,
          employeeId: user.id,  // server-derived — forged employeeId impossible
          employeeRole: user.role,
          attemptNumber,
          contactMethod: contactMethod!,
          result: result!,
          note: note?.trim() || null,
          nextFollowUpAt: fu.date,
        },
        include: { employee: { select: { id: true, name: true } } },
      });

      const noAnswers = await tx.orderContactAttempt.count({
        where: { orderId: id, result: { in: [...NO_ANSWER_RESULTS] } },
      });

      const terminal = ['CONFIRMED', 'REJECTED', 'CANCELLED'].includes(order.confirmationStatus);
      /*
       * AND THE PARCEL MUST STILL BE OURS TO CANCEL — ASKED OF THE ONE HELPER.
       *
       * This is the one door that cancels an order without a person pressing
       * cancel, so it must not even try to touch a parcel that has entered
       * the shipment: an order with a trolley, a barcode, a printed waybill
       * or a place on the pickup shelf is a person's decision (it needs
       * their word that the box was opened), never a counter's. It could not
       * reach one by coincidence once — shipping needs CONFIRMED and
       * CONFIRMED is in the `terminal` list — and a rule's shadow is not a
       * rule. `endOrder` is the helper every cancel door goes through; this
       * door asks it, in this transaction, only for an order that never left
       * the confirmation desk.
       */
      const neverShipped =
        !order.shippingBatchId &&
        !order.trackingNumber &&
        !order.labelPrintedAt &&
        order.shippingStatus === 'NOT_READY';
      /*
       * ANY of the three, not `NO_ANSWER` alone.
       *
       * The counter above has always counted BUSY too, and the close fired
       * only on `NO_ANSWER` — so an order whose third attempt was busy
       * reached «3/3» and then closed nothing, and sat there with no door
       * out of it. Three calls that never reached anybody is the same
       * evidence whichever way the line failed.
       */
      if (
        (NO_ANSWER_RESULTS as readonly string[]).includes(result!) &&
        noAnswers >= NO_ANSWER_LIMIT &&
        !terminal &&
        neverShipped
      ) {
        const closed = await endOrder({
          orderId: id,
          companyId,
          storeId,
          by: { id: user.id, name: user.name, role: user.role },
          door: 'CONTACT_AUTO_CLOSE',
          kind: 'CANCEL',
          endAs: 'CANCELLED',
          reason: 'NO_ANSWER_3_ATTEMPTS',
          rejectionNote: `إغلاق تلقائي بعد ${noAnswers} محاولات بلا رد`,
          data: { followUpStatus: order.nextFollowUpAt ? 'CANCELLED' : order.followUpStatus },
          logNote: 'AUTO_CLOSE_NO_ANSWER_3_ATTEMPTS',
          noteBody: `أُغلق الطلب تلقائياً بعد ${noAnswers} محاولات اتصال بلا رد.`,
          tx,
        });
        // A refusal (the order moved on in the same instant) leaves the attempt
        // recorded and the order alone; the next attempt asks again.
        //
        // The announcement for System 7 is NOT sent from in here: this transaction
        // has not committed, and a cancellation told to an installed app that is
        // then rolled back is a customer written to about an order that is still open.
        return {
          attempt: created,
          autoClosed: closed.ok,
          noAnswerCount: noAnswers,
          announce: closed.ok ? closed.afterCommit : undefined,
        };
      }
      return { attempt: created, autoClosed: false, noAnswerCount: noAnswers, announce: undefined };
    });
    // The transaction has committed: only now does anybody hear the order closed.
    await announce?.();

    await logAudit({
      companyId, userId: user.id, action: 'CONTACT_ATTEMPT_RECORDED',
      entity: 'Order', entityId: id,
      newData: { attemptNumber, contactMethod, result, nextFollowUpAt: fu.date },
    });

    return NextResponse.json({
      success: true,
      attempt,
      noAnswerCount,
      noAnswerLimit: NO_ANSWER_LIMIT,
      autoClosed,
    });
  } catch (error: any) {
    return apiErrorResponse(error);
  }
}
