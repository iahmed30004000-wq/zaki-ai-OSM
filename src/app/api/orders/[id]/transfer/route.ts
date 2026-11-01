import { STATE_LABEL_AR, deriveCoreState, getZone, type StateSource } from '@/lib/order-state';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { ORDER_ACCESS_STATUS, assertOrderAccess, assertOrderReadable } from '@/lib/rbac';
import { ownershipSnapshot } from '@/lib/order-locks';
import { logAudit } from '@/lib/audit';
import { apiError } from '@/lib/api-error';
import { can, authorize } from '@/lib/authorization';
import { ORDER_NOT_FOUND, ORDER_STALE } from '@/lib/order-refusals';
import { resolveAudience } from '@/lib/notification-audience';
import { mayBeHandedAnOrder } from '@/lib/confirmation-queue';

/**
 * POST /api/orders/[id]/transfer
 * Controlled order transfer — never allow order stealing.
 *
 * Authorization (server-side):
 *  - orders.assign permission with scope evaluation (admins/managers), OR
 *  - the current claimer releasing to a specific colleague (voluntary transfer)
 *
 * Body: { targetUserId, reason? }  — targetUserId is verified in DB,
 * never trusted from ownership fields.
 */

interface RankedUser { id: string; name: string; role: string; roleId: string | null }

/** Two people do the same job when they share a role — the DB role when both
 *  carry one, the legacy role string otherwise. */
function sameRank(a: RankedUser, b: RankedUser): boolean {
  if (a.roleId && b.roleId) return a.roleId === b.roleId;
  return a.role === b.role;
}

/**
 * WHO MAY BE HANDED AN ORDER BY SOMEBODY WHO ASSIGNS (the owner, 1/11: «سحبت الطلب اجيت اعطيه لموظفة التأكيد مش ملاقيها»).
 *
 * The same-role rule below was written for an agent handing a confirmation order to the warehouse. It also stopped the owner and the
 * supervisor — whose role is not an agent's — from handing an order DOWN to a confirmation agent: the list offered only people of the
 * HOLDER'S role, and the holder was the owner who had just taken the order. What the rule protects is that the order lands in hands
 * that can work it, so for a person with `orders.assign` that is what is asked: the target can WORK the order — `mayBeHandedAnOrder`:
 * `confirmation.work` («العمل على طلباتي»), `confirmation.pull` and `orders.confirm`. A warehouse employee has no such key and is
 * still refused.
 *
 * ⚠️ `confirmation.work` ALONE was the first version of this question, and the supervisor template holds it (it works a queue to
 * watch it): she was offered, and received, an order she could neither confirm nor ring — no pull, no `orders.confirm`, no
 * `orders.contact_log` (the independent review of #154). The audience resolver is still asked for `confirmation.work` — it already
 * returns every holder with the grants the engine computed for him — and the other two keys are asked of those same sessions, in
 * memory: no query of its own, and the list and the acceptance below read this one function, so they cannot disagree.
 */
async function whoMayWorkTheOrder(companyId: string, storeId: string | null): Promise<Array<{ id: string; name: string; email?: string | null }>> {
  const audience = await resolveAudience({ companyId, storeId, audience: { permission: 'confirmation.work' } });
  return audience
    .filter((u) => mayBeHandedAnOrder((permission) => can(u, permission)))
    .map((u) => ({ id: u.id, name: u.name, email: u.email }));
}

/** Whose hands the order is in right now: the claimer, else the owner, else
 *  the person doing the transferring. */
async function currentHolder(
  database: typeof db,
  order: { claimedById?: string | null; currentOwnerId?: string | null },
  actor: { id: string; role: string; name?: string | null }
): Promise<RankedUser | null> {
  const holderId = order.claimedById ?? order.currentOwnerId ?? actor.id;
  return database.user.findUnique({
    where: { id: holderId },
    select: { id: true, name: true, role: true, roleId: true },
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();
    const body = await req.json();
    const { targetUserId, reason } = body as { targetUserId?: string; reason?: string };

    if (!targetUserId) {
      return NextResponse.json({ error: 'targetUserId is required', errorAr: 'اختر الموظّف الذي يُحوَّل إليه الطلب.' }, { status: 400 });
    }
    if (!reason || reason.trim().length < 3) {
      return NextResponse.json({ error: 'A reason is required for transferring an order.' }, { status: 400 });
    }

    const access = await assertOrderAccess(id, user, { companyId, storeId }, 'orders.view');
    if (!access.allowed) {
      return NextResponse.json({ error: 'Order not found or not assigned to you', errorAr: ORDER_NOT_FOUND }, { status: ORDER_ACCESS_STATUS[access.reason] });
    }
    const order = access.order;
    const isReassigner = authorize(user, 'orders.assign', order).allowed;

    // Terminal orders are finalized — they can no longer be transferred.
    // Read from the DERIVED state, not the legacy merged column: that column
    // is never written by the courier feed or by the door-side recorder, so
    // a delivered order was still being handed from one employee to another.
    const state = deriveCoreState(order as StateSource);
    if (getZone(state) === 'CLOSED') {
      return NextResponse.json(
        { error: `Cannot transfer an order in terminal status ${state}`, errorAr: `لا يُحوَّل طلبٌ في حالة «${STATE_LABEL_AR[state] ?? state}» — انتهى العمل عليه.`, code: 'TERMINAL_STATUS' },
        { status: 409 }
      );
    }

    // A non-reassigner may only transfer an order THEY currently own/claimed
    if (!isReassigner) {
      if (!can(user, 'orders.release')) {
        return NextResponse.json({ error: 'Forbidden: missing required permission orders.assign', errorAr: 'لا تملك صلاحية تحويل الطلبات لموظّف آخر.' }, { status: 403 });
      }
      if (order.currentOwnerId !== user.id && order.claimedById !== user.id) {
        return NextResponse.json({ error: 'You can only transfer an order you own.', errorAr: 'لا تحوّل إلا طلباً بين يديك.' }, { status: 403 });
      }
    }

    // Target must be an ACTIVE user in the SAME company
    const target = await db.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, name: true, companyId: true, status: true, role: true, roleId: true },
    });
    if (!target || target.companyId !== companyId || target.status !== 'ACTIVE') {
      return NextResponse.json({ error: 'Target user not found in your company or not active', errorAr: 'الموظّف غير موجود في شركتك أو حسابه غير نشِط.' }, { status: 400 });
    }

    // An order moves sideways, never across jobs. Whoever is holding a
    // confirmation order hands it to another confirmation agent — handing it
    // to the warehouse would put it in a pair of hands that cannot do the
    // next thing it needs, and the queue it belongs to would not show it.
    const holder = await currentHolder(db, order, user);
    if (isReassigner) {
      // Somebody who assigns hands the order to anybody who can WORK it, whatever her role — not only to the holder's role.
      const mayWork = (await whoMayWorkTheOrder(companyId, storeId ?? null)).some((u) => u.id === target.id);
      if (!mayWork) {
        return NextResponse.json(
          {
            error: `${target.name} ما بيشتغل على الطلبات — ما بيتحوّل الطلب لإلو`,
            errorAr: `${target.name} ما بيقدر يشتغل على الطلب (لازم يكون عنده «العمل على طلباتي والمؤجلة» و«سحب الطلب التالي» و«تغيير حالة التأكيد») — حوّل الطلب لموظف تأكيد.`,
            code: 'CANNOT_WORK_IT',
          },
          { status: 409 }
        );
      }
    } else if (holder && !sameRank(holder, target)) {
      return NextResponse.json(
        {
          error: `لا يمكن تحويل الطلب إلى رتبة مختلفة — ${target.name} ليس بنفس دور ${holder.name}`,
          code: 'DIFFERENT_RANK',
        },
        { status: 409 }
      );
    }
    if (target.id === order.currentOwnerId) {
      return NextResponse.json({ error: 'This order is already owned by that user', errorAr: 'الطلب بين يدي هذا الموظّف أصلاً.' }, { status: 400 });
    }

    const previousOwnerId = order.currentOwnerId;
    const previousClaimedById = order.claimedById;
    const now = new Date();

    // Conditional versioned write — never overwrite a concurrent save
    const won = await db.order.updateMany({
      where: { id, companyId, version: order.version },
      data: {
        assignedToId: target.id,
        assignedAt: now,
        currentOwnerId: target.id,
        claimedById: target.id,
        claimedAt: now,
        // The target must sign for the order themselves — never forged here
        signatureStatus: 'UNSIGNED',
        signedById: null,
        signedAt: null,
        // transfer breaks the previous owner's editing lock
        lockedById: null, lockedAt: null, lockExpiresAt: null,
        version: { increment: 1 },
      },
    });
    if (won.count !== 1) {
      return NextResponse.json(
        { error: 'This order was updated by another user. Please refresh before saving.', errorAr: ORDER_STALE, code: 'VERSION_CONFLICT' },
        { status: 409 }
      );
    }

    await db.orderClaimHistory.create({
      data: {
        companyId, orderId: id, userId: user.id, action: 'TRANSFERRED', reason: reason.trim(),
        metadata: JSON.stringify({ previousOwnerId, previousClaimedById, newOwner: target.id, performedBy: user.id }),
      },
    });
    await db.orderActivity.create({
      data: {
        companyId, orderId: id, userId: user.id, action: 'TRANSFERRED',
        metadata: JSON.stringify({ from: previousOwnerId, to: target.name, by: user.name, reason }),
      },
    });
    await logAudit({
      companyId, userId: user.id, action: 'ORDER_TRANSFERRED', entity: 'Order', entityId: id,
      previousData: { previousOwnerId, previousClaimedById },
      newData: { newOwner: target.id, by: user.id, reason },
    });

    const freshOrder = await db.order.findUnique({ where: { id } });
    return NextResponse.json({ success: true, transferredTo: target.name, order: freshOrder });
  } catch (error) {
    const { body, status } = apiError(error);
    return NextResponse.json(body, { status });
  }
}

/**
 * GET /api/orders/[id]/transfer — the colleagues this order may go to.
 *
 * The screen offers exactly what the POST above accepts, so a name can never
 * appear in the list and then be refused on save.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();

    const access = await assertOrderReadable(id, user, { companyId, storeId }, 'orders.view');
    if (!access.allowed) {
      return NextResponse.json({ error: 'Order not found', errorAr: ORDER_NOT_FOUND }, { status: 404 });
    }
    const order = access.order;

    const mayTransfer =
      authorize(user, 'orders.assign', order).allowed ||
      (can(user, 'orders.release') && (order.currentOwnerId === user.id || order.claimedById === user.id));
    if (!mayTransfer) return NextResponse.json({ candidates: [], mayTransfer: false });

    const holder = await currentHolder(db, order, user);
    if (!holder) return NextResponse.json({ candidates: [], mayTransfer: true });

    // Whoever assigns may hand it to any employee who can work it (the owner, 1/11); an agent giving it up keeps to her own role.
    if (authorize(user, 'orders.assign', order).allowed) {
      const workers = (await whoMayWorkTheOrder(companyId, storeId ?? null))
        .filter((u) => u.id !== holder.id)
        .sort((a, b) => a.name.localeCompare(b.name, 'ar'))
        .slice(0, 50);
      return NextResponse.json({
        mayTransfer: true,
        scope: 'ANY_AGENT',
        holder: { id: holder.id, name: holder.name },
        candidates: workers.map((u) => ({ id: u.id, name: u.name, email: u.email ?? undefined })),
      });
    }

    const candidates = await db.user.findMany({
      where: {
        companyId,
        status: 'ACTIVE',
        id: { not: holder.id },
        ...(holder.roleId ? { roleId: holder.roleId } : { role: holder.role }),
      },
      select: { id: true, name: true, email: true },
      orderBy: { name: 'asc' },
      take: 50,
    });

    return NextResponse.json({
      mayTransfer: true,
      scope: 'SAME_RANK',
      holder: { id: holder.id, name: holder.name },
      candidates,
    });
  } catch (error) {
    const { body, status } = apiError(error);
    return NextResponse.json(body, { status });
  }
}
