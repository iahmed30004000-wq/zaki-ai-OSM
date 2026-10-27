import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { ORDER_ACCESS_STATUS, assertOrderAccess } from '@/lib/rbac';
import { ORDER_WORK_DOOR } from '@/lib/order-work-door';
import { atomicClaim, isLockActive, lockConfig, ownershipSnapshot } from '@/lib/order-locks';
import { logAudit } from '@/lib/audit';
import { apiError } from '@/lib/api-error';
import { can } from '@/lib/authorization';
import { ORDER_CLAIM_NOT_HELD, ORDER_NOT_FOUND, ORDER_STALE, orderClaimedBy } from '@/lib/order-refusals';
import { ownedCounts, pullRefusal } from '@/lib/confirmation-queue';

/**
 * POST /api/orders/[id]/claim        → claim + digital signature
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
    if (order.claimedById !== user.id) {
      return NextResponse.json({ error: 'You do not hold the claim on this order.', errorAr: ORDER_CLAIM_NOT_HELD }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const reason = searchParams.get('reason') || undefined;
    const now = new Date();

    // Conditional release: only the CURRENT claim holder may release, guarded
    // by the version the caller loaded (lost-update protection).
    const released = await db.order.updateMany({
      where: {
        id,
        companyId,
        claimedById: user.id,
        version: order.version,
      },
      data: {
        claimedById: null, claimedAt: null,
        currentOwnerId: null,
        // A released order goes back to the claimable queue (legacy 'NEW')
        confirmationStatus: 'NEW',
        status: 'NEW',
        signatureStatus: 'UNSIGNED', signedById: null, signedAt: null, signatureNote: null,
        // releasing also drops any editing lock I hold
        ...(order.lockedById === user.id ? { lockedById: null, lockedAt: null, lockExpiresAt: null } : {}),
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
        metadata: JSON.stringify({ previousOwner: user.id }),
      },
    });
    await db.orderActivity.create({
      data: { companyId, orderId: id, userId: user.id, action: 'RELEASED', metadata: JSON.stringify({ releasedBy: user.name }) },
    });
    await logAudit({
      companyId, userId: user.id, action: 'ORDER_RELEASED', entity: 'Order', entityId: id,
      previousData: { claimedById: user.id }, newData: { claimedById: null, reason },
    });

    const freshOrder = await db.order.findUnique({ where: { id } });
    return NextResponse.json({ success: true, order: freshOrder });
  } catch (error) {
    const { body, status } = apiError(error);
    return NextResponse.json(body, { status });
  }
}
