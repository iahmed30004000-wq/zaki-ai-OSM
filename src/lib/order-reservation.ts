/**
 * A RETURNING CUSTOMER'S ORDER IS HELD FOR THE AGENT WHO WORKED HIM LAST.
 *
 * The owner, 31/10: «بس تجي موظفة التأكيد تسحب الطلب للزبون وهو عندو سجل طلبات.. مايروح الطلب لنفس الموظفة لازم يروح لنفس
 * الموظفة عشان تتابع معه». A customer ordered, an agent rang him and agreed a discount, and he ordered again a day later: the
 * new order went to whoever pulled next, and the customer was asked everything again by a stranger.
 *
 * ── WHAT «HELD» MEANS ──
 *
 *   · The order stays where it is — unclaimed, counted, listed — and carries the name of the agent: `assignedToId`, the
 *     column an order's «مُسنَد إلى» has always been. It shows in the agent's «الطلبات» and in her colleagues', with her name.
 *   · Only she may take it. «اسحب التالي» gives it to her first and skips it for everyone else; taking it by id says whose it is.
 *   · It lets go by itself, so nobody has to remember to free it: after twenty-four hours from the day it was held, or the moment
 *     her account is not ACTIVE (disabled, suspended). Then it is the shared queue's, as every order is.
 *   · Once anybody holds it (`claimedById`) it is no longer «held» — it is theirs. A release clears `assignedAt` (see
 *     `releaseStaleClaims` and the release door), so an order she gave back is not held for her a second time.
 *
 * No new column: `assignedToId` and `assignedAt` exist, every creation door writes them as null, and the transfer and the claim
 * write them with a claim beside them — which this predicate excludes by `claimedById: null`.
 *
 * THIS FILE IS PURE — no database, no clock of its own. It is the one definition of «held», read by the queue, the claim door,
 * the orders list, the screens' marks and the job that makes the assignment, so that they cannot disagree about which orders
 * are held. The writer that decides WHO is in `reserve-returning-customers.ts`.
 */

/** How long an order waits for its agent before it is everybody's. The owner, 31/10: «24 ساعة فقط وبعدها يكون عام». */
export const RESERVATION_HOURS = 24;
const HOUR_MS = 3_600_000;

/** The oldest assignment that still holds. */
export function reservationCutoff(now: Date): Date {
  return new Date(now.getTime() - RESERVATION_HOURS * HOUR_MS);
}

/** When an assignment made at `assignedAt` lets go. */
export function reservationEnds(assignedAt: Date | string): Date {
  return new Date(new Date(assignedAt).getTime() + RESERVATION_HOURS * HOUR_MS);
}

/** Hours left before it lets go, rounded up and never below one — said by the server, so no screen reads a clock to say it. */
export function reservationHoursLeft(assignedAt: Date | string, now: Date): number {
  return Math.max(1, Math.ceil((reservationEnds(assignedAt).getTime() - now.getTime()) / HOUR_MS));
}

/**
 * THE ORDERS HELD FOR SOMEBODY RIGHT NOW — as a database filter.
 *
 * `confirmationStatus: 'NEW'` because only an order that has just arrived is held; one that came back to the queue after a
 * release is not (it has been worked once and the agent had her chance). The assignee must be ACTIVE: a disabled or suspended
 * account holds nothing.
 */
export function reservedWhere(now: Date) {
  return {
    claimedById: null,
    confirmationStatus: 'NEW',
    assignedToId: { not: null },
    assignedAt: { gt: reservationCutoff(now) },
    assignee: { is: { status: 'ACTIVE' } },
  };
}

/** Held for THIS person. */
export function reservedForWhere(userId: string, now: Date) {
  return { ...reservedWhere(now), assignedToId: userId };
}

/** Held for somebody ELSE — the orders this person may see and may not take. */
export function reservedForOthersWhere(userId: string, now: Date) {
  return { AND: [reservedWhere(now), { assignedToId: { not: userId } }] };
}

/**
 * NAMED FOR AN AGENT, AND NOBODY HOLDS IT — the name lets her SEE and TAKE the order, never WORK it.
 *
 * `assignedToId` has always meant «this is mine to work» (the lists, the edit lock, the contact log, the confirmation door all read
 * it that way). An order that has just arrived and is named for her is not hers to work yet: working it before she pulls it would
 * bypass what pulling checks — the caps, and the rule that she rings the customer before she decides anything. So the write doors
 * (`authorize` and the work door) do not count this name as ownership until she holds the order; the read envelope and the claim
 * door do, which is how she finds it and takes it.
 *
 * No time in it, on purpose: after the day the order is everybody's to pull, and the name on it must not become a way to edit
 * an order nobody holds. (An order a person released also lands here — NEW, unclaimed, still carrying her name — and could be
 * edited by her without holding it; that was a hole before holds existed, and this closes it too.)
 */
export function isHeldRow(order: { claimedById?: string | null; confirmationStatus?: string | null; assignedToId?: string | null }): boolean {
  return !order.claimedById && order.confirmationStatus === 'NEW' && !!order.assignedToId;
}

/** What a row needs to answer «is it held for somebody right now?» — the same four facts the filter reads. */
export interface ReservableRow {
  claimedById?: string | null;
  confirmationStatus?: string | null;
  assignedToId?: string | null;
  assignedAt?: Date | string | null;
  /** The assignee's account status, when the read carried it. Absent means «not known to be ACTIVE». */
  assigneeStatus?: string | null;
}

/** The filter above, asked of one row already in hand. They must agree, and `a-held-order-agrees-with-its-filter.test.ts` holds them to it. */
export function isReservedNow(row: ReservableRow, now: Date): boolean {
  if (row.claimedById) return false;
  if (row.confirmationStatus !== 'NEW') return false;
  if (!row.assignedToId || !row.assignedAt) return false;
  if (new Date(row.assignedAt).getTime() <= reservationCutoff(now).getTime()) return false;
  return row.assigneeStatus === 'ACTIVE';
}

/**
 * WHO IT IS HELD FOR, as a row in hand says it — `null` when it is not held (a day gone, her account off, anybody holds it).
 * The one place the three screens' `reservedFor` is made, so the list, the order sheet and the supervisor's rows cannot disagree.
 */
export function heldFor(
  row: Omit<ReservableRow, 'assigneeStatus'> & { assignee?: { id: string; name: string; status?: string | null } | null },
  now: Date
): { id: string; name: string } | null {
  const agent = row.assignee;
  if (!agent || !isReservedNow({ ...row, assigneeStatus: agent.status }, now)) return null;
  return { id: agent.id, name: agent.name };
}

/** The sentence the claim door and the screens say to anyone but the agent. */
export function reservedMessage(agentName?: string | null): string {
  return (
    `هذا الطلب تابع لـ${agentName || 'زميلتك'} — هي اللي تعاملت مع هالزبون قبل. ` +
    `ما بتقدر تسحبه، وبيصير عاماً بعد ${RESERVATION_HOURS} ساعة من وصوله أو إذا ما كانت متاحة.`
  );
}

/** One prior order of the customer, as the choice reads it. Newest first when passed in a list. */
export interface PriorOrder {
  claimedById?: string | null;
  currentOwnerId?: string | null;
  confirmedById?: string | null;
}

/** Who worked a prior order: who holds it, else who held it last, else who confirmed it. Null when nobody did. */
export function handlerOf(prior: PriorOrder): string | null {
  return prior.claimedById ?? prior.currentOwnerId ?? prior.confirmedById ?? null;
}

/**
 * THE AGENT A RETURNING CUSTOMER GOES BACK TO.
 *
 * The most recent prior order that anybody worked names the agent — and ONLY that one. If she is not available (not in
 * `eligible`: ACTIVE, may pull) the answer is nobody, and the order is the shared queue's. It does not fall back to the
 * agent before her: the owner's rule is «the one who dealt with him; if she is out, it is open», and a second choice would be
 * a colleague who never spoke to him.
 *
 * `priors` MUST be newest first.
 */
export function agentForReturningCustomer(priors: readonly PriorOrder[], eligible: ReadonlySet<string>): string | null {
  for (const prior of priors) {
    const handler = handlerOf(prior);
    if (handler) return eligible.has(handler) ? handler : null;
  }
  return null;
}
