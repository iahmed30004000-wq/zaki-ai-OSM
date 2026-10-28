import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/api-error';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { ORDER_ACCESS_STATUS, assertOrderAccess, assertOrderReadable } from '@/lib/rbac';
import { ORDER_WORK_DOOR } from '@/lib/order-work-door';
import { CONTACT_METHODS, CONTACT_RESULTS, NO_ANSWER_RESULTS } from '@/lib/confirmation-workflow';
import { logAudit } from '@/lib/audit';
import { NO_ANSWER_LIMIT } from '@/lib/confirmation-workflow';
import { assertCancellable, type StateSource } from '@/lib/order-state';
import { releaseOrderLines } from '@/lib/reservation';
import { can, authorize } from '@/lib/authorization';
import { ORDER_NOT_FOUND } from '@/lib/order-refusals';

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
    const { attempt, autoClosed, noAnswerCount } = await db.$transaction(async (tx) => {
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
       * AND THE PARCEL MUST STILL BE OURS TO CANCEL.
       *
       * This is the one door that cancels an order without a person pressing
       * cancel, and it did not ask. Today it cannot reach a shipped parcel —
       * but only by coincidence: shipping requires `confirmationStatus ===
       * 'CONFIRMED'` (assertReadyToShip) and CONFIRMED happens to be in the
       * `terminal` list above, so the auto-close is skipped. Two unrelated
       * lists overlapping is not a rule; it is a rule's shadow, and it
       * disappears the day anybody ships an order by another path or edits
       * either list.
       *
       * The rule itself is `assertCancellable`, and it is the same function
       * the shipments door and the stand-down door call: once the parcel has
       * left, cancelling is a change REQUEST and the stock returns through
       * the returns door, counted — not by a status written here.
       */
      const stillOurs = assertCancellable(order as unknown as StateSource).allowed;
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
        stillOurs
      ) {
        await tx.order.update({
          where: { id },
          data: {
            confirmationStatus: 'CANCELLED',
            status: 'CANCELLED',
            rejectionReason: 'NO_ANSWER_3_ATTEMPTS',
            rejectionNote: `إغلاق تلقائي بعد ${noAnswers} محاولات بلا رد`,
            followUpStatus: order.nextFollowUpAt ? 'CANCELLED' : order.followUpStatus,
            version: { increment: 1 },
          },
        });
        await releaseOrderLines(tx, id);
        await tx.orderStatusLog.create({
          data: {
            companyId, orderId: id, statusType: 'CONFIRMATION',
            previousValue: order.confirmationStatus, newValue: 'CANCELLED',
            changedById: user.id, changedByRole: user.role,
            note: 'AUTO_CLOSE_NO_ANSWER_3_ATTEMPTS',
          },
        });
        await tx.orderNote.create({
          data: {
            companyId, orderId: id, authorId: user.id, kind: 'follow_up',
            body: `أُغلق الطلب تلقائياً بعد ${noAnswers} محاولات اتصال بلا رد.`,
          },
        });
        return { attempt: created, autoClosed: true, noAnswerCount: noAnswers };
      }
      return { attempt: created, autoClosed: false, noAnswerCount: noAnswers };
    });

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
