import { NextResponse } from 'next/server';
import { notify } from '@/lib/notify';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { ORDER_ACCESS_STATUS, assertOrderAccess } from '@/lib/rbac';
import { ORDER_WORK_DOOR } from '@/lib/order-work-door';
import { AlreadyBlocked, blockPhone } from '@/lib/blacklist';
import { CONFIRMATION_STATUSES, CONFIRMATION_STATUS_AR, FOLLOW_UP_REASONS, REJECTION_REASONS, isValidTransition, type ConfirmationStatus } from '@/lib/confirmation-workflow';
import { logAudit } from '@/lib/audit';
import { apiError } from '@/lib/api-error';
import { can, authorize } from '@/lib/authorization';
import { endOrder } from '@/lib/order-cancel';
import { reserveOrderLines } from '@/lib/reservation';
import { emitAppEvent } from '@/lib/apps/events';
import { queueConversions } from '@/lib/conversions/emit';
import {
  needsContactFirst, CONTACT_FIRST_MESSAGE, needsRegionFirst, REGION_REQUIRED_MESSAGE, mustHoldToWork, NOT_HELD_MESSAGE,
} from '@/lib/confirmation-queue';

/**
 * POST /api/orders/[id]/confirmation — controlled confirmation workflow action.
 *
 * Body: {
 *   action: 'start' | 'contact_result' | 'confirm' | 'reject' | 'cancel' | 'schedule_follow_up' | 'resolve_follow_up'
 *   result?:        contact result (for contact_result)
 *   contactMethod?: for contact_result
 *   note?:          optional/required note
 *   nextFollowUpAt?: required for follow-up/postpone scheduling
 *   followUpReason?: structured follow-up reason
 *   rejectionReason?: structured reason (required for reject)
 *   expectedVersion: optimistic concurrency (mandatory — the version the client loaded)
 * }
 *
 * All transitions validated server-side; SUPER_ADMIN override requires reason + audit.
 */
/**
 * The confirmation states, in the words the screens already use. A refusal
 * that prints `FOLLOW_UP_REQUIRED` at somebody is a refusal in a second
 * language on top of the first.
 */
/*
 * THE ONE VOCABULARY, NOT A FIFTH COPY OF IT.
 *
 * The name stays `CONFIRMATION_AR` because the sentences below read it.
 * What changed is where the words come from: this copy said «قيد
 * المعالجة», «بحاجة متابعة», «مؤجَّل» and «مؤكَّد» where the rest of the
 * product says «قيد التأكيد», «يحتاج متابعة», «مؤجل» and «مؤكد».
 */
const CONFIRMATION_AR: Record<string, string> = CONFIRMATION_STATUS_AR;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId, country } = await requireContext();

    // Confirmation status authority (scope evaluated against the loaded order).
    // The work door: the order she holds is decided without «عرض الطلبات».
    const access = await assertOrderAccess(id, user, { companyId, storeId }, ORDER_WORK_DOOR);
    if (!access.allowed) {
      return NextResponse.json({ error: 'الطلب غير موجود أو ليس بين يديك' }, { status: ORDER_ACCESS_STATUS[access.reason] });
    }
    const order = access.order;

    const confirmAuth = authorize(user, 'orders.confirm', order);
    if (!confirmAuth.allowed) {
      return NextResponse.json({ error: 'لا تملك صلاحية تغيير حالة التأكيد' }, { status: 403 });
    }

    /*
     * AN AGENT WORKS ONLY THE ORDER SHE HOLDS (the owner, 1/11) — see `mustHoldToWork`. Asked before anything is read from the body,
     * for EVERY action: an agent who could `confirm` an order nobody held, from the orders list, also left it with no holder, no
     * stage and no contact rule (`needsContactFirst` binds only a holder). Whoever can take or hand out any order (`orders.unlock`,
     * `orders.assign`) is not bound — and `confirmation.supervise` does NOT excuse anybody: the live agent role holds it.
     */
    if (mustHoldToWork((permission) => can(user, permission)) && order.claimedById !== user.id) {
      return NextResponse.json({ error: NOT_HELD_MESSAGE, errorAr: NOT_HELD_MESSAGE, code: 'NOT_HELD' }, { status: 403 });
    }

    // ── Editing-lock enforcement: an ACTIVE foreign lock blocks edits ──
    // (users with orders.unlock may bypass, same as the generic PATCH)
    const lockActive =
      order.lockedById &&
      order.lockExpiresAt &&
      new Date(order.lockExpiresAt).getTime() > Date.now();
    if (lockActive && order.lockedById !== user.id && !can(user, 'orders.unlock')) {
      const holder = await db.user.findUnique({ where: { id: order.lockedById! }, select: { name: true } });
      return NextResponse.json(
        {
          error: `${holder?.name ?? 'موظف آخر'} يعمل على هذا الطلب الآن — انتظر حتى يتركه`,
          errorAr: `هذا الطلب يتم تعديله حالياً بواسطة ${holder?.name ?? 'مستخدم آخر'}.`,
          code: 'ORDER_LOCKED',
          locked: true,
          lockedBy: holder?.name ?? null,
        },
        { status: 423 }
      );
    }

    const body = await req.json();
    const {
      action, result, note, nextFollowUpAt, followUpReason, preferredTime,
      rejectionReason, rejectionNote, expectedVersion, parcelInHand,
    } = body as {
      action?: string; result?: string; contactMethod?: string; note?: string;
      nextFollowUpAt?: string; followUpReason?: string; preferredTime?: string;
      rejectionReason?: string; rejectionNote?: string; expectedVersion?: number;
      /** «الطرد بين يديّ…» — a person's word that a packed parcel's box was opened. */
      parcelInHand?: boolean;
    };

    if (!action) return NextResponse.json({ error: 'لم يُحدَّد الإجراء' }, { status: 400 });

    /*
     * ── THE CONTACT COMES FIRST ──
     *
     * Checked HERE, before the action switch, because the rule is about
     * every disposal of a held order and not about any one of them: an
     * agent who can reach `confirm` without it can reach «تأجيل» without
     * it too, and «تأجيل» is the one that cost an hour and a half of work
     * (see `needsContactFirst`).
     *
     * The count and not the rows: the route never needs the attempts
     * themselves, and «does any exist» is one index read.
     */
    if (
      needsContactFirst({
        action,
        // A result that carries a date is also a postponement (RV5) — see `needsContactFirst`.
        schedulesFollowUp: !!nextFollowUpAt,
        // A reject for a reason that needs no word with the customer is not bound (the owner, 30/10).
        rejectionReason,
        isHolder: order.claimedById === user.id,
        hasAttempt:
          (await db.orderContactAttempt.count({ where: { orderId: order.id }, take: 1 })) > 0,
      })
    ) {
      return NextResponse.json(
        {
          error: CONTACT_FIRST_MESSAGE,
          errorAr: CONTACT_FIRST_MESSAGE,
          code: 'CONTACT_FIRST',
        },
        { status: 409 }
      );
    }

    const from = order.confirmationStatus as ConfirmationStatus;
    const now = new Date();

    // ── Action → target status + validation ──
    let target: ConfirmationStatus | null = null;
    const updateData: Record<string, unknown> = {};

    switch (action) {
      case 'start': {
        // Claimed owner may mark processing
        if (from !== 'NEW') {
          return NextResponse.json({ error: `لا يمكن البدء من حالة «${CONFIRMATION_AR[from] ?? from}»` }, { status: 400 });
        }
        if (order.claimedById !== user.id && !authorize(user, 'orders.edit', order).allowed) {
          return NextResponse.json({ error: 'اسحب الطلب أولاً — لا يمكن العمل على طلب ليس بين يديك' }, { status: 403 });
        }
        target = 'IN_PROGRESS';
        break;
      }
      case 'contact_result': {
        /*
         * The same permission the contact-attempts door now asks for, and
         * for the same reason: this action records what happened on a
         * call. It rode on `orders.confirm` — «may change the confirmation
         * status» — which is a different act with a different risk, and
         * the owner could not separate them from «الصلاحيات».
         */
        if (!can(user, 'orders.contact_log')) {
          return NextResponse.json(
            { error: 'لا تملك صلاحية تسجيل نتيجة الاتصال.', code: 'CONTACT_LOG_NOT_ALLOWED' },
            { status: 403 }
          );
        }
        // Records result on the attempt just logged; updates workflow state
        if (!result || !['ANSWERED', 'NO_ANSWER', 'BUSY', 'WRONG_NUMBER', 'CALLBACK_REQUESTED', 'OTHER'].includes(result)) {
          return NextResponse.json({ error: 'نتيجة الاتصال غير صالحة' }, { status: 400 });
        }
        if (result === 'ANSWERED') target = 'IN_PROGRESS';
        else if (result === 'NO_ANSWER') target = 'NO_ANSWER';
        else if (result === 'BUSY') target = 'NO_ANSWER';
        else if (result === 'WRONG_NUMBER') target = 'NO_ANSWER';
        else if (result === 'CALLBACK_REQUESTED') target = 'FOLLOW_UP_REQUIRED';
        else target = 'FOLLOW_UP_REQUIRED';
        break;
      }
      case 'confirm': {
        /*
         * NO GOVERNORATE, NO YES (the owner, 30/10) — see `needsRegionFirst`. Asked of the order's own `regionId`, before
         * anything is decided, reserved or written, and of EVERYONE: the override (`orders.unlock`) does not reach it,
         * because the fee cannot be priced whoever pressed the button.
         */
        if (needsRegionFirst(order)) {
          return NextResponse.json(
            { error: REGION_REQUIRED_MESSAGE, errorAr: REGION_REQUIRED_MESSAGE, code: 'REGION_REQUIRED' },
            { status: 409 }
          );
        }
        target = 'CONFIRMED';
        break;
      }
      case 'reject': {
        target = 'REJECTED';
        // The same question «cancel» asks below, answered by the same helper
        // (`endOrder`, further down): a reject writes the same dead end and
        // drops the same reservation, so with the override (orders.unlock) it
        // could free the units of a parcel already labelled or on a trolley.
        if (!rejectionReason || !(REJECTION_REASONS as readonly string[]).includes(rejectionReason)) {
          return NextResponse.json({ error: 'اختر سبب الرفض من القائمة' }, { status: 400 });
        }
        if (rejectionReason === 'OTHER' && (!note || note.trim().length < 5)) {
          return NextResponse.json({ error: 'سبب الرفض «أخرى» يحتاج ملاحظة — خمسة أحرف على الأقل' }, { status: 400 });
        }
        updateData.rejectionReason = rejectionReason;
        updateData.rejectionNote = rejectionNote?.trim() || null;
        break;
      }
      case 'schedule_follow_up': {
        target = nextFollowUpTarget(from);
        if (!target) {
          return NextResponse.json({ error: `لا يمكن جدولة متابعة من حالة «${CONFIRMATION_AR[from] ?? from}»` }, { status: 400 });
        }
        break;
      }
      case 'resolve_follow_up': {
        // Any active employee on the order resolves the pending follow-up
        if (!order.nextFollowUpAt || order.followUpStatus === 'COMPLETED' || order.followUpStatus === 'CANCELLED') {
          return NextResponse.json({ error: 'لا متابعة قائمة على هذا الطلب لتُغلَق' }, { status: 400 });
        }
        break;
      }
      case 'cancel': {
        // Cancelling has a key of its own (PR-6): `orders.cancel`, given by the migration to everybody who held
        // `orders.unlock` — the key it used to ride on — so nobody lost it and nobody gained it.
        if (!can(user, 'orders.cancel')) {
          return NextResponse.json({ error: 'الإلغاء للمدير وحده' }, { status: 403 });
        }
        // The gate is `endOrder`'s, below: until the press of «إغلاق الشحنة —
        // سُلّمت للشركة» the order is still ours; after it a cancel is a request
        // that tells the company (contract invariant 4, as moved by M6).
        if (!note || note.trim().length < 5) {
          return NextResponse.json({ error: 'الإلغاء يحتاج سبباً — خمسة أحرف على الأقل' }, { status: 400 });
        }
        target = 'CANCELLED';
        break;
      }
      default:
        return NextResponse.json({ error: 'إجراء غير معروف' }, { status: 400 });
    }

    // Follow-up scheduling validation (POSTPONED / FOLLOW_UP_REQUIRED / future contact)
    const followUpDate: Date | null = null;
    if (action === 'schedule_follow_up' || (action === 'contact_result' && nextFollowUpAt)) {
      if (nextFollowUpAt) {
        const d = new Date(nextFollowUpAt);
        if (isNaN(d.getTime())) return NextResponse.json({ error: 'تاريخ المتابعة غير صالح' }, { status: 400 });
        if (d.getTime() < now.getTime() - 60_000) {
          return NextResponse.json({ error: 'موعد المتابعة يجب أن يكون في المستقبل' }, { status: 400 });
        }
        updateData.nextFollowUpAt = d;
        // Postpone details the confirmation screen shows back to the agent:
        // when the customer asked for, and how often they have asked.
        if (target === 'POSTPONED') {
          updateData.postponedUntil = d;
          updateData.postponeCount = { increment: 1 };
          if (typeof preferredTime === 'string' && preferredTime.trim()) {
            updateData.postponePreferredTime = preferredTime.trim().slice(0, 40);
          }
        }
        updateData.followUpStatus = 'SCHEDULED';
        updateData.followUpReason =
          followUpReason && (FOLLOW_UP_REASONS as readonly string[]).includes(followUpReason)
            ? followUpReason
            : 'OTHER';
      } else if (target === 'POSTPONED' || target === 'FOLLOW_UP_REQUIRED') {
        return NextResponse.json(
          { error: 'التأجيل والمتابعة يحتاجان موعداً — بلا موعد يختفي الطلب ولا يُعيده شيء' }, { status: 400 }
        );
      }
    }

    // ── Transition validation (backend-enforced; frontend is UX only) ──
    // Self-transitions (from === to) are allowed for re-scheduling semantics —
    // e.g. re-postponing an already POSTPONED order must not 409.
    if (target && !isValidTransition(from, target) && from !== target) {
      // SUPER_ADMIN override path requires reason; recorded as workflow override
      const isOverride = can(user, 'orders.unlock') && note && note.trim().length >= 5;
      if (!isOverride) {
        return NextResponse.json(
          {
            error: `لا يمكن الانتقال من «${CONFIRMATION_AR[from] ?? from}» إلى «${CONFIRMATION_AR[target] ?? target}»`,
            // In Arabic, the two states in the screen's own words — the English codes were all the agent was shown.
            errorAr: `لا يمكن الانتقال من «${CONFIRMATION_AR[from] ?? from}» إلى «${CONFIRMATION_AR[target] ?? target}» — هذا الإجراء غير مسموح على حالة الطلب الآن.`,
            code: 'INVALID_TRANSITION',
          },
          { status: 409 }
        );
      }
    }

    // ── Optimistic concurrency: expectedVersion is MANDATORY (same as PATCH) ──
    // Omitting it would silently disable lost-update protection on this write.
    if (typeof expectedVersion !== 'number') {
      return NextResponse.json(
        {
          error: 'تعذّر الحفظ — أعد فتح الطلب وحاول ثانية',
          errorAr: 'يلزم تمرير رقم النسخة (expectedVersion) لتحديث حالة التأكيد.',
          code: 'VERSION_REQUIRED',
        },
        { status: 400 }
      );
    }
    const versionGuard = { version: expectedVersion };

    // ── Compose the update ──
    if (target) updateData.confirmationStatus = target;
    // Keep legacy combined status synchronized for list compatibility
    if (target === 'CONFIRMED') {
      updateData.status = 'CONFIRMED';
      updateData.confirmedAt = order.confirmedAt ?? now;
      updateData.confirmedById = user.id;
    } else if (target === 'REJECTED') {
      updateData.status = 'REJECTED';
    } else if (target === 'CANCELLED') {
      updateData.status = 'CANCELLED';
    }

    // Terminal decisions resolve any pending follow-up — folded into the same
    // update/transaction instead of a second unguarded write.
    if ((action === 'confirm' || action === 'reject') &&
        order.nextFollowUpAt && (!order.followUpStatus || order.followUpStatus === 'SCHEDULED')) {
      updateData.followUpStatus = 'COMPLETED';
      updateData.followUpResolvedAt = now;
      updateData.followUpResolvedById = user.id;
    }

    updateData.version = { increment: 1 };

    /**
     * AN ORDER THAT ENDS GOES THROUGH THE ONE HELPER.
     *
     * Reject and cancel are the same ending (and the same reservation
     * release), so they ask the same gate, take the parcel off a trolley,
     * count the customer's cancellation and — for a cancel — tell System 7,
     * exactly as the stand-down, the shipping screen and the PATCH do.
     */
    if (target === 'REJECTED' || target === 'CANCELLED') {
      const { version: _next, ...columns } = updateData;
      void _next;
      const ended = await endOrder({
        orderId: id,
        companyId,
        storeId: null,
        by: { id: user.id, name: user.name, role: user.role },
        door: 'CONFIRMATION',
        kind: 'CANCEL',
        endAs: target,
        data: columns,
        logNote: note?.trim() || rejectionReason || null,
        noteBody: null,
        expectedVersion,
        parcelInHand: parcelInHand === true,
      });
      if (!ended.ok) {
        return NextResponse.json(
          {
            error: ended.error,
            errorAr: ended.error,
            code: ended.code,
            ...(ended.attestation ? { attestation: ended.attestation } : {}),
          },
          { status: ended.status }
        );
      }
    } else {
      await db.$transaction(async (tx) => {
        const res = await tx.order.updateMany({
          where: { id, companyId, ...versionGuard },
          data: updateData,
        });
        if (res.count !== 1) {
          throw new Error('VERSION_CONFLICT: This order was updated by another user. Please refresh before saving.');
        }

        // ── Reservation follows the decision, inside THIS transaction ──
        // Confirming reserves every line. Rejecting or cancelling releases
        // them — in `endOrder`, in its own transaction, so stock is never
        // held by a dead order.
        if (target === 'CONFIRMED') {
          await reserveOrderLines(tx, id, { allowNegativeStock: country.allowNegativeStock });
        }

        // ── Logs: StatusLog (always on transition) + Activity ──
        if (target && target !== from) {
          await tx.orderStatusLog.create({
            data: {
              companyId, orderId: id, statusType: 'CONFIRMATION',
              previousValue: from, newValue: target,
              changedById: user.id, changedByRole: user.role,
              note: note?.trim() || rejectionReason || null,
            },
          });
          await tx.orderActivity.create({
            data: {
              companyId, orderId: id, userId: user.id,
              action: 'STATUS_CHANGED', previousStatus: from, newStatus: target,
              metadata: JSON.stringify({ by: user.name, role: user.role, workflow: 'CONFIRMATION' }),
            },
          });
        }
        return res;
      });
    }
    await logAudit({
      companyId, userId: user.id,
      action: target === 'CONFIRMED' ? 'ORDER_CONFIRMED' : target === 'REJECTED' ? 'ORDER_REJECTED' : 'CONFIRMATION_WORKFLOW_ACTION',
      entity: 'Order', entityId: id,
      previousData: { confirmationStatus: from, nextFollowUpAt: order.nextFollowUpAt },
      newData: { confirmationStatus: target, rejectionReason, followUpReason, action },
    });

    /**
     * A FAKE ORDER IS A PHONE, NOT JUST A ROW.
     *
     * The blacklist was complete — the model, the release-only history, and
     * enforcement on all four intake doors: the direct order, the AI intake,
     * the storefront and Telegram. Nothing ever put anybody ON it except a
     * person opening `/control/blacklist` and typing a number.
     *
     * So the moment somebody actually identifies a fake — «طلب وهميّ», the
     * one rejection reason that accuses nobody of changing their mind — the
     * work of stopping the next one was a separate errand, on another
     * screen, that nobody remembers after the twentieth call of the day.
     * The list stayed empty and the same number ordered again on Tuesday.
     *
     * ONLY `FAKE_ORDER`. A wrong number is our typing, an entry error is our
     * own mistake, and «لا يريد المنتج» is a customer exercising a choice —
     * none of the three is a reason to stop somebody buying. This is the
     * code whose whole meaning is «there is no real order here».
     *
     * Blocking never fails the rejection. The order was rejected; that is
     * recorded and committed. If the phone is already blocked, or is not a
     * phone we can canonicalise, the rejection still stands — and the block
     * is releasable in one click on the screen that always owned it.
     */
    if (target === 'REJECTED' && rejectionReason === 'FAKE_ORDER') {
      /**
       * Read here, not off `order`. `assertOrderAccess` loads the order's
       * own columns and no relations, so `order.customer` is undefined —
       * reaching for it would have made this whole branch a silent no-op
       * that typechecks perfectly.
       */
      const customer = await db.customer.findUnique({
        where: { id: order.customerId },
        select: { phone: true, fullName: true },
      });
      if (customer?.phone) {
        try {
          await blockPhone(db, {
            companyId,
            phone: customer.phone,
            name: customer.fullName ?? null,
            reason: `طلب وهميّ — ${order.orderNumber}${rejectionNote?.trim() ? `: ${rejectionNote.trim()}` : ''}`,
            blockedById: user.id,
          });
          await logAudit({
            companyId, userId: user.id, action: 'CUSTOMER_BLOCKED_ON_FAKE_ORDER',
            entity: 'Order', entityId: id,
            newData: { phone: customer.phone, orderNumber: order.orderNumber },
          });
        } catch (e) {
          // Already blocked is the ordinary case on a second fake from the
          // same number, and is not a failure of anything.
          if (!(e instanceof AlreadyBlocked)) {
            console.warn('blocking on fake order failed:', e);
          }
        }
      }
    }

    const fresh = await db.order.findUnique({ where: { id } });

    // Tell the installed apps, after the commit. Confirming is when a lead
    // becomes an order somebody will act on, which is the moment most
    // integrations actually care about.
    if (target === 'CONFIRMED') {
      // A cancellation is announced by `endOrder`, from the one place every
      // cancel door goes through — never twice, and never from here.
      await emitAppEvent(companyId, 'order.confirmed', {
        orderId: id,
        orderNumber: fresh?.orderNumber ?? null,
        confirmationStatus: target,
        previousStatus: from,
        total: Number(fresh?.totalAmount ?? 0),
        currency: fresh?.currency ?? null,
      });
    }

    // A confirmed order is the seller's second choice of conversion moment:
    // truer than a form submission, and still not money in hand.
    if (target === 'CONFIRMED') {
      await queueConversions(companyId, 'order.confirmed', id);
    }

    // A confirmation outcome goes to this store's confirmation supervisors
    // and to the moderator who entered the order (their commission rides on
    // it), never to the agent who just decided it. After commit; never
    // throws.
    if (target && (target === 'CONFIRMED' || target === 'REJECTED' || target === 'CANCELLED')) {
      notify({
        companyId,
        storeId: order.storeId ?? storeId,
        audience: { permission: 'confirmation.supervise', userIds: [order.moderatorId] },
        actorId: user.id,
        title: target === 'CONFIRMED' ? 'تأكيد طلب' : target === 'REJECTED' ? 'رفض طلب' : 'إلغاء طلب',
        message: `الطلب #${order.orderNumber} أصبح بالحالة ${target} بواسطة ${user.name}.`,
        type: 'SYSTEM_ALERT',
        link: `/orders?highlight=${order.id}`,
      });
    }

    return NextResponse.json({ success: true, order: fresh });
  } catch (error: any) {
    if (error?.message?.startsWith('VERSION_CONFLICT')) {
      return NextResponse.json(
        {
          error: 'عدّل هذا الطلبَ شخصٌ آخر قبلك — أعد تحميل الصفحة ثم احفظ',
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

/**
 * Where an order lands when a callback is scheduled on it.
 *
 * An order already waiting on a follow-up used to land NOWHERE: the map
 * returned null for FOLLOW_UP_REQUIRED and the agent got "Cannot schedule
 * follow-up from status FOLLOW_UP_REQUIRED". But moving the date is the
 * most ordinary thing on this desk — she calls, the customer says "tomorrow
 * instead", and the system refused to write the new date.
 *
 * So both waiting states re-schedule onto themselves. POSTPONED already
 * did; FOLLOW_UP_REQUIRED now does too, and the route allows a
 * self-transition precisely for this.
 */
function nextFollowUpTarget(from: ConfirmationStatus): ConfirmationStatus | null {
  if (from === 'NEW' || from === 'IN_PROGRESS') return 'POSTPONED';
  if (from === 'NO_ANSWER') return 'FOLLOW_UP_REQUIRED';
  if (from === 'POSTPONED') return 'POSTPONED';                     // re-schedule
  if (from === 'FOLLOW_UP_REQUIRED') return 'FOLLOW_UP_REQUIRED';   // re-schedule
  return null;
}
