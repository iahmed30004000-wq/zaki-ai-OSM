import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import {
  CLAIM_CAPS,
  OPEN_CONFIRMATION,
  RETURNS_MODE,
  ownedCounts,
  pullPermission,
  readReturnsMode,
  waitingBreakdown,
  reservedForColleaguesCount,
  postponedNotDueCount,
  openIssuesCount,
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
    const { user, companyId, storeId, country } = await requireContext();
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
    /*
     * «الطلب يرجع للطابور فوراً»: where it is on, every number below is the mode's — a returned order counts from its ready-time, a dated one
     * from its date, and the limit is five — the very predicates the pull picks from, so a number shown is what the pull can hand out.
     * Off (the default, and on any failure to read the switches) none of this runs and the answer is what it always was.
     */
    const returns = await readReturnsMode(db, companyId, {
      now,
      calendar: () => ({
        workHoursStart: country.workHoursStart,
        workHoursEnd: country.workHoursEnd,
        weekendDays: country.weekendDays,
        timezone: country.timezone,
      }),
    });
    const hand = returns ? RETURNS_MODE.handLimit : undefined;
    const [pool, counts, waitingOnADate, heldForColleagues, openIssues] = await Promise.all([
      // For an agent: what SHE may take (hers first, never a colleague's). For a supervisor: the whole pool, as before.
      // Said in PARTS (the owner, 12/11: «طلب جديد وخانة تانية طلب الراجع») — the big number is their sum, so it cannot disagree with
      // them; and they are asked over the very predicates the pull picks from (`waitingBreakdown`), so neither can it with the button.
      waitingBreakdown(db, scope, now, mayPull ? user.id : undefined, returns),
      // In her hands AND held for her (RV706): the cap counts both, and the screen shows both.
      ownedCounts(db, scope, user.id, now),
      // Real work, none of it takeable today. Said out loud rather than
      // folded into a number that promises a pull.
      returns ? postponedNotDueCount(db, scope, now, returns) : postponedNotDueCount(db, scope),
      // In the queue, seen and not takeable: said apart, so «بانتظارك» never promises a pull that answers «لا توجد طلبات».
      mayPull ? reservedForColleaguesCount(db, scope, user.id, now) : Promise.resolve(0),
      // «الطلبات اللي عليها مشاكل» (the owner, 13/11): the open entry issues, said under the pool and not in it — and only to whoever may open
      // that list (`confirmation.issues`), the number being the list's own. A person without the key gets no field, so the card draws no box.
      can(user, 'confirmation.issues') ? openIssuesCount(db, scope) : Promise.resolve(undefined),
    ]);
    /**
     * The authority first, then the caps. A supervisor holds
     * `confirmation.supervise` and not `confirmation.pull`, so she reaches
     * this screen and `POST /api/confirmation/pull` refuses her — the screen
     * must know that from here rather than discover it on the press.
     */
    // The mode hands its own hand limit to the same rule; off, the call is exactly what it always was.
    const refusal = hand === undefined ? pullPermission(can(user, 'confirmation.pull'), counts) : pullPermission(can(user, 'confirmation.pull'), counts, hand);

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
      // What the pull can hand out: never rung + rung before and back + a promise whose date came. The three follow, so the screen
      // can say them apart under the one figure — still ONE button, and the order it gives is unchanged.
      waiting: pool.fresh + pool.returned + pool.due,
      waitingNew: pool.fresh,
      waitingReturned: pool.returned,
      waitingDue: pool.due,
      waitingOnADate,
      ...(openIssues === undefined ? {} : { openIssues }),
      reservedForColleagues: heldForColleagues,
      owned: counts,
      // The mode's hand limit stands in for the cap of 500 on the panel («بيدك 3 / 5»); off, the caps are what they were.
      caps: hand === undefined ? CLAIM_CAPS : { ...CLAIM_CAPS, total: hand },
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
