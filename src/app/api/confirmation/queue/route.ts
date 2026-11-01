import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import {
  CLAIM_CAPS,
  ownedCounts,
  pullPermission,
  releaseStaleClaims,
  waitingCount,
  reservedForColleaguesCount,
  postponedNotDueCount,
  POSTPONE_LEAD_DAYS,
} from '@/lib/confirmation-queue';
import { heldFor } from '@/lib/order-reservation';
import { reserveReturningCustomers } from '@/lib/reserve-returning-customers';

/**
 * GET /api/confirmation/queue
 *
 * Agents get NO list — a waiting counter and whether they may pull. Only
 * supervisors (confirmation.supervise) receive the rows, and they are the
 * same data, never a different query.
 */
export async function GET() {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('confirmation.pull').catch(async () => requirePermission('confirmation.supervise'));

    const scope = { companyId, storeId };
    const cal = {
      workHoursStart: country.workHoursStart,
      workHoursEnd: country.workHoursEnd,
      weekendDays: country.weekendDays,
      timezone: country.timezone,
    };
    const released = await releaseStaleClaims(db, scope, cal);
    // Held for the agent who worked the customer last — made before anything is counted, best-effort (order-reservation.ts).
    await reserveReturningCustomers(scope).catch(() => 0);

    const mayPull = can(user, 'confirmation.pull');
    const now = new Date();
    const [waiting, counts, waitingOnADate, heldForColleagues] = await Promise.all([
      // For an agent: what SHE may take (hers first, never a colleague's). For a supervisor: the whole pool, as before.
      waitingCount(db, scope, now, mayPull ? user.id : undefined),
      ownedCounts(db, scope, user.id),
      // Real work, none of it takeable today. Said out loud rather than
      // folded into a number that promises a pull.
      postponedNotDueCount(db, scope),
      // In the queue, seen and not takeable: said apart, so «بانتظارك» never promises a pull that answers «لا توجد طلبات».
      mayPull ? reservedForColleaguesCount(db, scope, user.id, now) : Promise.resolve(0),
    ]);
    /**
     * The authority first, then the caps. A supervisor holds
     * `confirmation.supervise` and not `confirmation.pull`, so she reaches
     * this screen and `POST /api/confirmation/pull` refuses her — the screen
     * must know that from here rather than discover it on the press.
     */
    const refusal = pullPermission(can(user, 'confirmation.pull'), counts);

    const isSupervisor = can(user, 'confirmation.supervise');
    const rows = isSupervisor
      ? await db.order.findMany({
          where: { ...scope, claimedById: null, confirmationStatus: { in: ['NEW', 'IN_PROGRESS', 'NO_ANSWER', 'FOLLOW_UP_REQUIRED', 'POSTPONED'] }, shippingStatus: 'NOT_READY' },
          orderBy: [{ postponedUntil: 'asc' }, { createdAt: 'asc' }],
          take: 200,
          select: {
            id: true, orderNumber: true, merchantRef: true, createdAt: true,
            confirmationStatus: true, postponedUntil: true, postponeCount: true, totalAmount: true,
            customer: { select: { fullName: true, city: true } },
            product: { select: { name: true } },
            // Whom it is held for, when it is — the supervisor sees the pool WITH the names.
            claimedById: true, assignedToId: true, assignedAt: true,
            assignee: { select: { id: true, name: true, status: true } },
          },
        })
      : null;

    return NextResponse.json({
      waiting,
      waitingOnADate,
      reservedForColleagues: heldForColleagues,
      owned: counts,
      caps: CLAIM_CAPS,
      leadDays: POSTPONE_LEAD_DAYS,
      canPull: !refusal,
      refusal,
      autoReleased: released,
      // Agents never see the list; supervisors see the same rows as data.
      orders: rows
        ? rows.map(({ assignee, claimedById, assignedToId, assignedAt, ...row }) => ({
            ...row,
            reservedFor: heldFor({ claimedById, confirmationStatus: row.confirmationStatus, assignedToId, assignedAt, assignee }, now),
          }))
        : null,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
