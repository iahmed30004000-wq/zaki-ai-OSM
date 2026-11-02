import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { ORDER_ACCESS_STATUS, assertOrderAccess } from '@/lib/rbac';
import { CONTACT_RESULTS, REJECTION_REASONS } from '@/lib/confirmation-workflow';
import { apiError } from '@/lib/api-error';
import { can, authorize } from '@/lib/authorization';
import { ORDER_NOT_FOUND } from '@/lib/order-refusals';
import { mustHoldToWork, NOT_HELD_MESSAGE } from '@/lib/confirmation-queue';

/**
 * POST /api/orders/[id]/call-logs — record a call. A result that would move
 * the order is refused (USE_CONFIRMATION_DOOR): status is the confirmation door's.
 *
 * SECURITY (Phase S):
 *  - Permission required: orders.edit with scope evaluation
 *    (ASSIGNED scope enforces own-assignment).
 *  - Order access via assertOrderAccess (company isolation + role assignment scope).
 *  - moderatorId on the log is ALWAYS the authenticated user (server-derived).
 *  - An agent of the queue logs a call only on the order she HOLDS (`mustHoldToWork`, below).
 *
 * Nothing on screen calls this door (OrderDetailModal says so); it is kept for the API, and it stays on `'orders.view'` and off the
 * work door (`the-order-she-holds.test.ts` holds that) — the holder check is an extra refusal, not a wider entrance.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();

    // Order access first, then editing authority evaluated against the order
    const access = await assertOrderAccess(id, user, { companyId, storeId }, 'orders.view');
    if (!access.allowed) {
      return NextResponse.json({ error: 'Order not found or not assigned to you', errorAr: ORDER_NOT_FOUND }, { status: ORDER_ACCESS_STATUS[access.reason] });
    }
    const order = access.order;

    /**
     * ── THE THIRD DOOR THAT RECORDS A CALL ──
     *
     * The independent review found this one: `orders.contact_log` was put
     * on the contact-attempts route and on the `contact_result` action,
     * and this route writes a `CallLog` with the same `CONTACT_RESULTS`
     * values and moves `confirmationStatus` from them. So a role the owner
     * had just untickedled «تسجيل نتيجة الاتصال» for could still record call
     * outcomes here by hand — and the permission he had been told to
     * untick would be a promise the system does not keep.
     *
     * It is outside the two doors the task names, and it is gated anyway:
     * a guard with a sibling door around it is not a guard. Nobody loses
     * anything on deploy — the migration grants `orders.contact_log` to
     * every role holding `orders.edit`, which is exactly who could reach
     * this route before.
     */
    if (!can(user, 'orders.contact_log')) {
      return NextResponse.json(
        { error: 'لا تملك صلاحية تسجيل نتيجة الاتصال.', code: 'CONTACT_LOG_NOT_ALLOWED' },
        { status: 403 }
      );
    }

    // Permission: callers must have order-edit authority (scope-evaluated)
    const editAuth = authorize(user, 'orders.edit', order);
    if (!editAuth.allowed) {
      // Secure policy: out-of-scope/other-tenant orders are reported as missing
      if (editAuth.reason === 'NO_TENANT') {
        return NextResponse.json({ error: 'Order not found', errorAr: ORDER_NOT_FOUND }, { status: 404 });
      }
      return NextResponse.json({ error: 'Forbidden: cannot record calls', errorAr: 'لا تملك صلاحية تسجيل الاتصالات.' }, { status: 403 });
    }

    // AN AGENT WORKS ONLY THE ORDER SHE HOLDS (the owner, 1/11; the independent review of #154 found this door beside the two it fixed):
    // a call logged here writes a `CallLog` and a CALL_MADE row on whatever order she can open, held or not — the half of «اتصلت ثم
    // أكّدت» the confirmation door next door refuses. Whoever can take or hand out any order (`orders.unlock`, `orders.assign`) is not
    // bound, as at the other doors; `confirmation.supervise` excuses nobody. Asked before the body is read and before any row.
    if (mustHoldToWork((permission) => can(user, permission)) && order.claimedById !== user.id) {
      return NextResponse.json({ error: NOT_HELD_MESSAGE, errorAr: NOT_HELD_MESSAGE, code: 'NOT_HELD' }, { status: 403 });
    }

    const body = await req.json();
    const { result, notes, nextFollowUpDate, callDate, rejectionReason } = body;

    // Whitelisted result values only (CONTACT_RESULTS + POSTPONED used by the UI)
    const ALLOWED_CALL_RESULTS = [...CONTACT_RESULTS, 'POSTPONED'] as string[];
    if (!result || !ALLOWED_CALL_RESULTS.includes(result)) {
      return NextResponse.json({ error: 'Call Result is required', errorAr: 'اختر نتيجة الاتصال.' }, { status: 400 });
    }

    /**
     * CLOSING AN ORDER HERE OBEYS THE SAME RULE AS CLOSING IT ANYWHERE.
     *
     * The confirmation screen refuses to reject an order without a structured
     * reason, and demands a sentence when the reason is «other». This door
     * closed orders too — and wrote `OTHER` for every one of them, with no
     * sentence. Two doors to the same shelf, one of them locked.
     */
    if (result === 'REJECTED') {
      if (!rejectionReason || !(REJECTION_REASONS as readonly string[]).includes(rejectionReason)) {
        return NextResponse.json({ error: 'سبب الإلغاء مطلوب' }, { status: 400 });
      }
      if (rejectionReason === 'OTHER' && (!notes || String(notes).trim().length < 5)) {
        return NextResponse.json({ error: 'سبب «أخرى» يحتاج ملاحظة تشرحه' }, { status: 400 });
      }
    }

    // Optional structured fields — validated before use
    let nextFollowUp: Date | null = null;
    if (nextFollowUpDate !== undefined && nextFollowUpDate !== null && nextFollowUpDate !== '') {
      nextFollowUp = new Date(nextFollowUpDate);
      if (isNaN(nextFollowUp.getTime())) {
        return NextResponse.json({ error: 'Invalid nextFollowUpDate', errorAr: 'تاريخ المتابعة غير صالح.' }, { status: 400 });
      }
    }
    let callAt = new Date();
    if (callDate !== undefined && callDate !== null && callDate !== '') {
      callAt = new Date(callDate);
      if (isNaN(callAt.getTime())) {
        return NextResponse.json({ error: 'Invalid callDate', errorAr: 'تاريخ الاتصال غير صالح.' }, { status: 400 });
      }
    }

    // ── Workflow status mapping — now VALIDATED like the confirmation workflow ──
    let mappedStatus: string | null = null;
    if (result === 'CONFIRMED') mappedStatus = 'CONFIRMED';
    else if (result === 'REJECTED') mappedStatus = 'REJECTED';
    else if (result === 'POSTPONED') mappedStatus = 'POSTPONED';
    // A WRONG NUMBER IS NOT A NO-ANSWER.
    //
    // It used to be, so a mistyped number burned three call attempts and then
    // auto-closed as NO_ANSWER_3_ATTEMPTS — three calls nobody could ever have
    // answered, and a statistic that says «we cannot reach people» when the
    // truth is «our numbers are wrong». It closes now, under the reason that
    // is already in the list for it.
    else if (result === 'WRONG_NUMBER') mappedStatus = 'REJECTED';
    else if (result === 'NO_ANSWER' || result === 'BUSY') mappedStatus = 'NO_ANSWER';
    else if (result === 'CALLBACK_REQUESTED') mappedStatus = 'CONTACTING';

    const statusWillChange = !!(mappedStatus && mappedStatus !== order.status);
    /*
     * A CALL IS RECORDED HERE; AN ORDER IS CONFIRMED AT THE CONFIRMATION DOOR.
     *
     * This door used to confirm and reject too — with `orders.confirm`, but
     * without that door's rules: no stock reserved on «مؤكد», none released
     * on «مرفوض», no editing lock, no contact-first. Its form went from the
     * order window long ago (OrderDetailModal says so) and nothing calls it
     * for a status. So a result that would move the order is refused, in
     * words that say where to go, and nothing is written — not even the call,
     * because a call logged as «confirmed» on an order that is not would be a
     * second record that disagrees with the first.
     */
    if (statusWillChange) {
      return NextResponse.json(
        {
          error: 'تغيير حالة الطلب من شاشة التأكيد — هون بينسجّل الاتصال بس.',
          errorAr: 'تغيير حالة الطلب من شاشة التأكيد — هون بينسجّل الاتصال بس.',
          code: 'USE_CONFIRMATION_DOOR',
        },
        { status: 409 }
      );
    }

    const callLog = await db.$transaction(async (tx) => {
      const log = await tx.callLog.create({
        data: {
          companyId,           // session-derived
          orderId: id,
          moderatorId: user.id, // server-derived — never trusted from client
          callDate: callAt,
          result,
          notes: notes?.trim() || null,
          nextFollowUpDate: nextFollowUp,
        },
      });
      await tx.orderActivity.create({
        data: {
          companyId,
          orderId: id,
          userId: user.id,
          action: 'CALL_MADE',
          metadata: JSON.stringify({ callResult: result, notes: notes || '', caller: user.name }),
        },
      });
      return log;
    });

    return NextResponse.json({ success: true, callLog });
  } catch (error: any) {
    if (error?.message?.startsWith('VERSION_CONFLICT')) {
      return NextResponse.json(
        {
          error: 'This order was updated by another user. Please refresh before saving.',
          errorAr: 'تم تعديل هذا الطلب بواسطة مستخدم آخر. يرجى تحديث الصفحة قبل الحفظ.',
          code: 'VERSION_CONFLICT',
        },
        { status: 409 }
      );
    }
    const { body, status } = apiError(error);
    return NextResponse.json(body, { status });
  }
}
