import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import {
  CLAIM_CAPS,
  OPEN_CONFIRMATION,
  ownedCounts,
  pullPermission,
  waitingCount,
  reservedForColleaguesCount,
  postponedNotDueCount,
  POSTPONE_LEAD_DAYS,
} from '@/lib/confirmation-queue';
import { heldFor } from '@/lib/order-reservation';

/**
 * GET /api/confirmation/queue
 *
 * Agents get NO list — a waiting counter and whether they may pull. Only
 * supervisors (confirmation.supervise) receive the rows, and they are the
 * same data, never a different query.
 */
export async function GET() {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('confirmation.pull').catch(async () => requirePermission('confirmation.supervise'));

    const scope = { companyId, storeId };
    /*
     * A READ, AND ONLY A READ — the owner's ruling 4/11. Every agent's screen polls this every 30 seconds, and it used to
     * write on each poll: the ninety-minute release (`releaseStaleClaims`) and the returning-customer hold
     * (`reserveReturningCustomers`). A poll that writes holds a pool connection and row locks, and the agent's next
     * navigation waited behind them. Both writes keep their clocks — the `release-stale-claims` job every 300 s and
     * `reserve-returning-customers` every 120 s — and the pull makes both before it takes anything, so the rules are
     * unchanged; only who runs them on a poll is. A stale claim may now go back up to five minutes later than it did.
     * (`the-queue-read-writes-nothing.test.ts`.)
     */

    const mayPull = can(user, 'confirmation.pull');
    const now = new Date();
    const [waiting, counts, waitingOnADate, heldForColleagues] = await Promise.all([
      // For an agent: what SHE may take (hers first, never a colleague's). For a supervisor: the whole pool, as before.
      waitingCount(db, scope, now, mayPull ? user.id : undefined),
      // In her hands AND held for her (RV706): the cap counts both, and the screen shows both.
      ownedCounts(db, scope, user.id, now),
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
          where: { ...scope, claimedById: null, confirmationStatus: { in: OPEN_CONFIRMATION }, shippingStatus: 'NOT_READY' },
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
            _count: { select: { claimHistory: true } },
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
      // Kept for the screen's shape: this read releases nothing now, the job and the pull do (4/11).
      autoReleased: 0,
      // Agents never see the list; supervisors see the same rows as data.
      orders: rows
        ? rows.map(({ assignee, claimedById, assignedToId, assignedAt, _count, ...row }) => ({
            ...row,
            reservedFor: heldFor(
              { claimedById, confirmationStatus: row.confirmationStatus, assignedToId, assignedAt, assignee, everClaimed: _count.claimHistory > 0 },
              now
            ),
          }))
        : null,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
