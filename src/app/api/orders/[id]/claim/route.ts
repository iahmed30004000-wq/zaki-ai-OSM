import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { ORDER_ACCESS_STATUS, assertOrderAccess } from '@/lib/rbac';
import { ORDER_WORK_DOOR } from '@/lib/order-work-door';
import { atomicClaim, isLockActive, lockConfig, ownershipSnapshot } from '@/lib/order-locks';
import { logAudit } from '@/lib/audit';
import { apiError } from '@/lib/api-error';
import { can } from '@/lib/authorization';
import { deriveCoreState, getZone, type StateSource } from '@/lib/order-state';
import {
  ORDER_ALREADY_IN_QUEUE, ORDER_CLAIM_NOT_HELD, ORDER_NOT_FOUND, ORDER_PAST_CONFIRMATION, ORDER_STALE,
  ORDER_TAKEBACK_REASON, orderClaimedBy,
} from '@/lib/order-refusals';
import { claimByNumberMessage, mustHoldToWork, ownedCounts, pullRefusal, USE_THE_PULL_CODE } from '@/lib/confirmation-queue';
import { reservedForOthersWhere, reservedMessage } from '@/lib/order-reservation';
import { reserveReturningCustomers } from '@/lib/reserve-returning-customers';

/**
 * POST /api/orders/[id]/claim        → claim + digital signature (NOT for an agent of the queue: she pulls — `USE_THE_PULL`, below)
 * DELETE /api/orders/[id]/claim      → release (self) — body/query: reason
 * POST /api/orders/[id]/claim?mode=override → SUPER_ADMIN override (reason required)
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();
    const { searchParams } = new URL(req.url);
    const mode = searchParams.get('mode');
    const body = await req.json().catch(() => ({}));
    const reason: string | undefined = body?.reason;

    // ── Override mode: SUPER_ADMIN only, reason mandatory ──
    if (mode === 'override') {
      if (!can(user, 'orders.unlock')) {
        return NextResponse.json({ error: 'Forbidden: missing required permission orders.unlock', errorAr: 'فكّ القفل للمشرف وحده.' }, { status: 403 });
      }
      if (!reason || reason.trim().length < 5) {
        return NextResponse.json({ error: 'Override requires a reason (min 5 chars)' }, { status: 400 });
      }

      const access = await assertOrderAccess(id, user, { companyId, storeId }, 'orders.view');
      if (!access.allowed) return NextResponse.json({ error: 'Order not found', errorAr: ORDER_NOT_FOUND }, { status: 404 });

      const order = access.order;
      const snap = ownershipSnapshot(order);
      const now = new Date();

      // SUPER_ADMIN override is a forced, audited takeover (atomic conditional too)
      const won = await db.order.updateMany({
        where: { id, companyId, version: order.version }, // prevent racing with an in-flight save
        data: {
          claimedById: user.id,
          claimedAt: now,
          currentOwnerId: user.id,
          assignedToId: user.id,
          assignedAt: now,
          signatureStatus: 'SIGNED',
          signedById: user.id,
          signedAt: now,
          // Break any active editing lock
          lockedById: null,
          lockedAt: null,
          lockExpiresAt: null,
          // Every ownership write bumps the version
          version: { increment: 1 },
        },
      });
      if (won.count !== 1) {
        return NextResponse.json({ error: 'Order is being modified concurrently. Retry the override.', errorAr: 'يُعدَّل الطلب الآن من مكان آخر. أعد المحاولة بعد لحظة.' }, { status: 409 });
      }

      await db.orderClaimHistory.create({
        data: {
          companyId, orderId: id, userId: user.id, action: 'OVERRIDDEN', reason: reason.trim(),
          metadata: JSON.stringify({ ...snap, newOwner: user.id, performedBy: user.id }),
        },
      });
      await db.orderActivity.create({
        data: {
          companyId, orderId: id, userId: user.id, action: 'ORDER_UPDATED',
          metadata: JSON.stringify({
            override: true, reason, previousOwnerId: snap.previousOwnerId, newOwner: user.name,
          }),
        },
      });
      await logAudit({
        companyId, userId: user.id, action: 'SUPER_ADMIN_OVERRIDE', entity: 'Order', entityId: id,
        previousData: snap, newData: { newOwner: user.id, reason },
      });

      return NextResponse.json({ success: true, mode: 'override' });
    }

    // ── Normal claim ──
    if (!can(user, 'orders.claim')) {
      return NextResponse.json({ error: 'Forbidden: missing required permission orders.claim', errorAr: 'لا تملك صلاحية سحب الطلبات من الطابور.' }, { status: 403 });
    }

    /**
     * ── AN AGENT TAKES AN ORDER BY PULLING THE NEXT ONE, NEVER BY ITS NUMBER (the independent review of #154, 2/11) ──
     *
     * This door takes ANY unheld order in ANY state — a confirmed one included (`atomicClaim` has no `confirmationStatus` in its
     * WHERE) — and skips the queue's order, which is the point of a queue. The live agent role holds `orders.claim`, so one request
     * with an order number was a way to pick an order out of the pool and to take one that was already decided.
     *
     * Nothing on screen asks for it from an agent: `useOrderOwnership.claim` has no caller (OrderDetailModal uses the lock and the
     * release only), `OrderResponsibility` calls `?mode=override` and DELETE, and no Telegram, system or app door posts here. So an
     * account bound by `mustHoldToWork` is refused, with the sentence that sends her to the pull, before anything is read or written —
     * not even the best-effort hold below. The owner's «استلمه أنا» (the override above), a manager (`orders.unlock` / `orders.assign`)
     * and a moderator (`orders.claim` with no `confirmation.work`) are not bound and take an order exactly as they did.
     */
    if (mustHoldToWork((permission) => can(user, permission))) {
      const said = claimByNumberMessage((permission) => can(user, permission));
      return NextResponse.json({ error: said, errorAr: said, code: USE_THE_PULL_CODE }, { status: 403 });
    }

    // A returning customer's order is held for the agent who worked him last BEFORE anybody may take it — best-effort: a hold
    // that could not be written must never stop a claim (the order is then the shared queue's, as it was before holds). Asked
    // only of somebody who may claim: the hold write and the audience read behind it are not for any signed-in user to trigger.
    await reserveReturningCustomers({ companyId, storeId }, new Date(), { orderIds: [id] }).catch(() => 0);

    let access = await assertOrderAccess(id, user, { companyId, storeId });
    if (!access.allowed && access.reason === 'NOT_ASSIGNED') {
      // Self-scoped roles may claim orders from the CLAIMABLE QUEUE (same
      // predicate as applyQueueFilter 'available' in rbac.ts): unclaimed,
      // unsigned, still in the NEW intake stage. Without this the agent sees
      // the order in their queue but gets 403 when actually claiming it.
      const maybe = await db.order.findUnique({ where: { id } });
      const claimable =
        maybe &&
        maybe.companyId === companyId &&
        !maybe.claimedById &&
        maybe.signatureStatus === 'UNSIGNED' &&
        maybe.confirmationStatus === 'NEW';
      if (claimable) access = { allowed: true, order: maybe };
    }
    if (!access.allowed) {
      return NextResponse.json({ error: 'Order not found or not assigned to you', errorAr: ORDER_NOT_FOUND }, { status: ORDER_ACCESS_STATUS[access.reason] });
    }
    const order = access.order;

    // Already claimed by someone else → never allow stealing
    if (order.claimedById && order.claimedById !== user.id) {
      const claimer = await db.user.findUnique({ where: { id: order.claimedById }, select: { name: true } });
      return NextResponse.json(
        { error: `This order has already been claimed by ${claimer?.name ?? 'another employee'}.`, errorAr: orderClaimedBy(claimer?.name), code: 'ALREADY_CLAIMED', claimedBy: claimer?.name },
        { status: 409 }
      );
    }

    // Already claimed by me → idempotent success
    if (order.claimedById === user.id && order.signatureStatus === 'SIGNED') {
      return NextResponse.json({ success: true, alreadyClaimed: true, order });
    }

    /**
     * ── HELD FOR A COLLEAGUE WHO WORKED THIS CUSTOMER ──
     *
     * The order is in the queue and in her list with her name on it, and only she may take it (order-reservation.ts). The
     * owner and the supervisor take it over with «استلمه أنا», the override door above. Asked from the same filter the queue
     * and the write use, so the three cannot disagree.
     */
    if (order.claimedById !== user.id) {
      const held = await db.order.findFirst({
        where: { id, ...reservedForOthersWhere(user.id, new Date()) },
        select: { assignee: { select: { name: true } } },
      });
      if (held) {
        const said = reservedMessage(held.assignee?.name);
        return NextResponse.json(
          { error: said, errorAr: said, code: 'RESERVED_FOR_COLLEAGUE', heldFor: held.assignee?.name ?? null },
          { status: 409 }
        );
      }
    }

    /**
     * ── THE CAPS ARE ABOUT THE DESK, NOT ABOUT THE BUTTON ──
     *
     * «اسحب الطلب التالي» asks `pullRefusal` first: the 120 total, the 40
     * without a contact attempt, and C1's rule that an untouched order in
     * your hands comes before a new one. This door — take THIS order, by
     * id — asked none of them. No screen offers it, but the queue it
     * draws from is the same queue, and one hand-written request could
     * cherry-pick the good orders out of it all day with no limit at all.
     *
     * Only when she is TAKING it. Finishing a claim she already holds is
     * not a new order on her desk, and the caps already counted it.
     */
    if (order.claimedById !== user.id) {
      const counts = await ownedCounts(db, { companyId, storeId }, user.id);
      const refusal = pullRefusal(counts);
      if (refusal) {
        return NextResponse.json(
          {
            error: refusal.message,
            errorAr: refusal.message,
            code: refusal.code,
            // The untouched-order refusal names the order it is about, so
            // whoever gets this can open it instead of hunting for it.
            ...(refusal.code === 'UNTOUCHED_ORDER'
              ? { orderId: refusal.orderId, orderNumber: refusal.orderNumber }
              : {}),
          },
          { status: 409 }
        );
      }
    }

    const now = new Date();
    const { lockDurationMs } = lockConfig();
    const won = await atomicClaim({
      orderId: id, userId: user.id, now,
      lockExpiresAt: new Date(now.getTime() + lockDurationMs), // self-lock on claim so editing can start immediately
    });

    if (!won) {
      // The write refuses an order held for a colleague too (`atomicClaim`'s gate). A hold that landed AFTER the check above is the
      // one race where nobody claimed anything: say whom it is held for, not «already claimed».
      const heldNow = await db.order.findFirst({
        where: { id, ...reservedForOthersWhere(user.id, new Date()) },
        select: { assignee: { select: { name: true } } },
      });
      if (heldNow) {
        const said = reservedMessage(heldNow.assignee?.name);
        return NextResponse.json(
          { error: said, errorAr: said, code: 'RESERVED_FOR_COLLEAGUE', heldFor: heldNow.assignee?.name ?? null },
          { status: 409 }
        );
      }
      // Lost the race — read fresh state to tell the user who won
      const fresh = await db.order.findUnique({ where: { id }, select: { claimedById: true } });
      const claimer = fresh?.claimedById
        ? await db.user.findUnique({ where: { id: fresh.claimedById }, select: { name: true } })
        : null;
      return NextResponse.json(
        { error: `This order has already been claimed by ${claimer?.name ?? 'another employee'}.`, errorAr: orderClaimedBy(claimer?.name), code: 'ALREADY_CLAIMED', claimedBy: claimer?.name },
        { status: 409 }
      );
    }

    // History + timeline + audit (only the winner writes these)
    await db.orderClaimHistory.create({
      data: {
        companyId, orderId: id, userId: user.id, action: 'CLAIMED',
        reason: reason?.trim() || null,
        metadata: JSON.stringify(ownershipSnapshot(order)),
      },
    });
    await db.orderActivity.create({
      data: {
        companyId, orderId: id, userId: user.id, action: 'CLAIMED',
        metadata: JSON.stringify({ claimedBy: user.name, signedBy: user.name, at: now.toISOString() }),
      },
    });
    await logAudit({
      companyId, userId: user.id, action: 'ORDER_CLAIMED', entity: 'Order', entityId: id,
      previousData: ownershipSnapshot(order), newData: { claimedById: user.id, signatureStatus: 'SIGNED' },
    });

    const freshOrder = await db.order.findUnique({
      where: { id },
      include: {
        claimer: { select: { id: true, name: true } },
        owner: { select: { id: true, name: true } },
        signer: { select: { id: true, name: true } },
      },
    });
    return NextResponse.json({ success: true, order: freshOrder });
  } catch (error) {
    const { body, status } = apiError(error);
    return NextResponse.json(body, { status });
  }
}

/** Release my claim (voluntary hand-back). */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();
    if (!can(user, 'orders.release')) {
      return NextResponse.json({ error: 'Forbidden: missing required permission orders.release' }, { status: 403 });
    }
    // Giving back the order she holds — the work door (order-work-door.ts).
    // The claim-by-id above keeps the old door: taking is the pull's job.
    const access = await assertOrderAccess(id, user, { companyId, storeId }, ORDER_WORK_DOOR);
    if (!access.allowed) return NextResponse.json({ error: 'Order not found', errorAr: ORDER_NOT_FOUND }, { status: 404 });

    const order = access.order;
    const mine = order.claimedById === user.id;
    /*
     * PULLING SOMEBODY ELSE'S ORDER BACK.
     *
     * The box on the order sheet draws «سحبه منه» and this door answered the
     * owner «ليس بين يديك» — a button the door refused. He pressed it three times.
     *
     * Owner and supervisor only: `orders.unlock`, the key the override door
     * (`?mode=override`) already asks, which only the owner, the company admin
     * and the manager hold. With the reason in writing, and only while the order
     * is still at the confirmation desk: past it the release below would put a
     * confirmed or shipped order back to NEW. After that the order is edited in
     * place or taken with the override.
     */
    const takingBack = !mine && can(user, 'orders.unlock');
    if (!mine && !takingBack) {
      return NextResponse.json({ error: 'لا تحمل هذا الطلب.', errorAr: ORDER_CLAIM_NOT_HELD }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const reason = searchParams.get('reason') || undefined;
    const now = new Date();
    const holderId = order.claimedById ?? order.currentOwnerId ?? null;

    if (takingBack) {
      if (!holderId) {
        return NextResponse.json({ error: ORDER_ALREADY_IN_QUEUE, errorAr: ORDER_ALREADY_IN_QUEUE, code: 'ALREADY_IN_QUEUE' }, { status: 409 });
      }
      const zone = getZone(deriveCoreState(order as StateSource));
      if (zone !== 'CONFIRMATION' && zone !== 'INTAKE') {
        return NextResponse.json({ error: ORDER_PAST_CONFIRMATION, errorAr: ORDER_PAST_CONFIRMATION, code: 'PAST_CONFIRMATION' }, { status: 409 });
      }
      if (!reason || reason.trim().length < 3) {
        return NextResponse.json({ error: ORDER_TAKEBACK_REASON, errorAr: ORDER_TAKEBACK_REASON, code: 'REASON_REQUIRED' }, { status: 400 });
      }
    }

    // Conditional release: only the CURRENT holder's claim is released (or the
    // reassigner pulling it back), guarded by the version the caller loaded
    // (lost-update protection).
    const released = await db.order.updateMany({
      where: {
        id,
        companyId,
        claimedById: takingBack ? order.claimedById : user.id,
        version: order.version,
      },
      data: {
        claimedById: null, claimedAt: null,
        currentOwnerId: null,
        // A release lets go of the hold as well: an order she gave back is the shared queue's, not held for her a second time
        // (`assignedAt` is what a hold is measured from — order-reservation.ts).
        assignedAt: null,
        // Pulled back: the order is nobody's, not «assigned» to the one it was taken from
        ...(takingBack ? { assignedToId: null } : {}),
        // A released order goes back to the claimable queue (legacy 'NEW')
        confirmationStatus: 'NEW',
        status: 'NEW',
        signatureStatus: 'UNSIGNED', signedById: null, signedAt: null, signatureNote: null,
        // releasing also drops any editing lock I hold — and, pulled back, the holder's
        ...(order.lockedById === user.id || (takingBack && order.lockedById) ? { lockedById: null, lockedAt: null, lockExpiresAt: null } : {}),
        version: { increment: 1 },
      },
    });
    if (released.count !== 1) {
      return NextResponse.json(
        { error: 'This order was updated by another user. Please refresh before saving.', errorAr: ORDER_STALE, code: 'VERSION_CONFLICT' },
        { status: 409 }
      );
    }

    await db.orderClaimHistory.create({
      data: {
        companyId, orderId: id, userId: user.id, action: 'RELEASED', reason,
        metadata: JSON.stringify({ previousOwner: takingBack ? holderId : user.id, ...(takingBack ? { pulledBackBy: user.id } : {}) }),
      },
    });
    await db.orderActivity.create({
      data: {
        companyId, orderId: id, userId: user.id, action: 'RELEASED',
        metadata: JSON.stringify({ releasedBy: user.name, ...(takingBack ? { pulledBack: true, from: holderId, reason } : {}) }),
      },
    });
    await logAudit({
      companyId, userId: user.id, action: 'ORDER_RELEASED', entity: 'Order', entityId: id,
      previousData: { claimedById: takingBack ? order.claimedById : user.id }, newData: { claimedById: null, reason, ...(takingBack ? { pulledBackBy: user.id } : {}) },
    });

    const freshOrder = await db.order.findUnique({ where: { id } });
    return NextResponse.json({ success: true, order: freshOrder });
  } catch (error) {
    const { body, status } = apiError(error);
    return NextResponse.json(body, { status });
  }
}
