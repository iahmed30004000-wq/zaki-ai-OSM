import { db } from './db';
import { businessMinutesBetween, type BusinessCalendar } from './business-calendar';
import { breatheEvery } from './breathe';

/**
 * WHO DID THE WORK, AND HOW FAST.
 *
 * A manager asking "how is the confirmation desk doing" was given lifetime
 * totals with no date on them: an agent who worked hard last quarter and
 * nothing this week outranked one who carried the whole week. Every number
 * here is bounded by a window, and counted at the moment the action
 * happened — claimed THIS week, confirmed THIS week — so a row reads the
 * way a manager says it out loud.
 *
 * Two deliberate choices, because they are the ones that decide whether the
 * report is trusted:
 *
 *   BUSINESS MINUTES, never wall-clock. An order claimed at 16:55 and
 *   confirmed at 09:05 the next morning took ten minutes of work, not
 *   sixteen hours. The same calendar that freezes every SLA in the system
 *   freezes this, so nobody is punished for going home.
 *
 *   MEDIAN, never average. One order left open over a weekend moves an
 *   average by hours and says nothing about the other forty. The median is
 *   the typical call, which is what "كم ساعة بتاخد" actually asks.
 *
 * Rows are read from the append-only records — claim history and the
 * confirmation status log — not from the order's current columns. Those
 * columns hold the LAST thing that happened; a report of who did what needs
 * every thing that happened.
 */

/** Decisions that end the confirmation stage. */
const DECISIONS = ['CONFIRMED', 'REJECTED', 'CANCELLED'] as const;
/** Still being worked: neither a success nor a failure yet. */
const OPEN_STATUSES = ['IN_PROGRESS', 'NO_ANSWER', 'FOLLOW_UP_REQUIRED', 'POSTPONED'];
/** Hard ceiling on rows pulled per window; the window itself is clamped to 90 days upstream. */
const ROW_CAP = 20000;

export interface EmployeeRow {
  id: string;
  name: string;
  role: string | null;
  /** Orders this person pulled from the pool inside the window. */
  claimed: number;
  confirmed: number;
  /** Rejected or cancelled — both mean the sale did not happen. */
  rejected: number;
  noAnswer: number;
  /** confirmed + rejected: the ones that reached a decision in the window. */
  decided: number;
  /** Still open right now, whenever it was claimed. Workload, not history. */
  openNow: number;
  /** confirmed / decided, as a percentage. Null when nothing was decided. */
  confirmationRate: number | null;
  /** Typical business minutes from pulling an order to confirming it. */
  medianConfirmMinutes: number | null;
  /** Typical business minutes between one claim and the next — the cadence. */
  medianGapMinutes: number | null;
  /**
   * Typical business minutes from pulling an order to the first thing done
   * about it. The number the customer actually feels.
   */
  medianFirstActionMinutes: number | null;
  /** Calls, WhatsApps and the rest, and how many it typically takes. */
  attempts: number;
  attemptsPerDecision: number | null;
}

export interface TeamPerformance {
  employees: EmployeeRow[];
  totals: {
    claimed: number;
    confirmed: number;
    rejected: number;
    decided: number;
    confirmationRate: number | null;
    medianConfirmMinutes: number | null;
  };
}

/** The middle value, rounded. Empty gives null rather than a lying zero. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? Math.round(sorted[mid])
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export async function teamPerformance(input: {
  companyId: string;
  storeId: string;
  calendar: BusinessCalendar;
  start?: Date;
  end?: Date;
}): Promise<TeamPerformance> {
  const { companyId, storeId, calendar, start, end } = input;
  const when = start || end ? { ...(start ? { gte: start } : {}), ...(end ? { lte: end } : {}) } : undefined;
  const inStore = { order: { storeId } };

  const [claims, decisions, attempts, openNow] = await Promise.all([
    // Pulling an order from the pool. The append-only history, not the
    // order's claimedAt: an order released and re-claimed was two pulls of
    // work, and claimedAt remembers only the second.
    db.orderClaimHistory.findMany({
      where: { companyId, action: 'CLAIMED', ...inStore, ...(when ? { createdAt: when } : {}) },
      select: { userId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: ROW_CAP,
    }),
    // Every confirmation decision recorded in the window, with the moment
    // the order was pulled, so the duration is the person's own time.
    db.orderStatusLog.findMany({
      where: {
        companyId,
        statusType: 'CONFIRMATION',
        newValue: { in: [...DECISIONS, 'NO_ANSWER'] },
        ...inStore,
        ...(when ? { createdAt: when } : {}),
      },
      select: {
        changedById: true,
        newValue: true,
        createdAt: true,
        order: { select: { claimedAt: true } },
      },
      take: ROW_CAP,
    }),
    // Grouped by order as well as person, so the same pass gives both how
    // many times they tried and when they first did — no second query for
    // the response clock.
    db.orderContactAttempt.groupBy({
      by: ['employeeId', 'orderId'],
      where: { companyId, ...inStore, ...(when ? { createdAt: when } : {}) },
      _count: { _all: true },
      _min: { createdAt: true },
    }),
    // Workload is a "right now" question, so it carries no window: an agent
    // holding twelve open orders is holding them today regardless of when
    // she picked them up.
    db.order.groupBy({
      by: ['claimedById'],
      where: { companyId, storeId, claimedById: { not: null }, confirmationStatus: { in: OPEN_STATUSES } },
      _count: { _all: true },
    }),
  ]);

  // Everyone who appears in any of the four, so a person who only closed
  // work she pulled last week is still a row.
  const ids = new Set<string>();
  for (const c of claims) if (c.userId) ids.add(c.userId);
  for (const d of decisions) if (d.changedById) ids.add(d.changedById);
  for (const a of attempts) if (a.employeeId) ids.add(a.employeeId);
  for (const o of openNow) if (o.claimedById) ids.add(o.claimedById);
  if (ids.size === 0) {
    return {
      employees: [],
      totals: { claimed: 0, confirmed: 0, rejected: 0, decided: 0, confirmationRate: null, medianConfirmMinutes: null },
    };
  }

  // Looked up by id alone: the ids came from records already scoped to this
  // company and store, so whoever produced them was working here. Demanding
  // user.companyId as well would drop a platform-level owner — whose own
  // row carries no company — from the list of people who did the work.
  const people = await db.user.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, name: true, role: true },
  });
  const personOf = new Map(people.map((p) => [p.id, p]));

  // THE RESPONSE CLOCK, averaged. How long from pulling an order to the
  // first thing done about it — the wait the customer actually feels.
  // Only orders still shown as claimed by the same person are measured: an
  // order transferred to somebody else would otherwise charge the first
  // agent for the second one's delay.
  const attemptOrderIds = [...new Set(attempts.map((a) => a.orderId))].slice(0, ROW_CAP);
  const claimedAtOf = attemptOrderIds.length
    ? new Map(
        (
          await db.order.findMany({
            where: { id: { in: attemptOrderIds }, companyId, storeId },
            select: { id: true, claimedAt: true, claimedById: true },
          })
        ).map((o) => [o.id, o])
      )
    : new Map();

  // Every loop below can run over tens of thousands of rows and none of them waits for anything: each hands the thread back
  // now and then (`breathe.ts`), so the rest of the site is answered while this is worked out.
  const pause = breatheEvery();

  const firstActionSpans = new Map<string, number[]>();
  for (const a of attempts) {
    const turn = pause();
    if (turn) await turn;
    const order = claimedAtOf.get(a.orderId);
    const startedAt = order?.claimedAt;
    const firstAt = a._min.createdAt;
    if (!startedAt || !firstAt || order.claimedById !== a.employeeId || firstAt < startedAt) continue;
    const span = businessMinutesBetween(startedAt, firstAt, calendar);
    const list = firstActionSpans.get(a.employeeId);
    if (list) list.push(span);
    else firstActionSpans.set(a.employeeId, [span]);
  }

  // One pass per record type, bucketed by person.
  const claimTimes = new Map<string, Date[]>();
  for (const c of claims) {
    if (!c.userId) continue;
    const list = claimTimes.get(c.userId);
    if (list) list.push(c.createdAt);
    else claimTimes.set(c.userId, [c.createdAt]);
  }

  const confirmed = new Map<string, number>();
  const rejected = new Map<string, number>();
  const noAnswer = new Map<string, number>();
  const confirmSpans = new Map<string, number[]>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

  for (const d of decisions) {
    const turn = pause();
    if (turn) await turn;
    const who = d.changedById;
    if (!who) continue;
    if (d.newValue === 'CONFIRMED') {
      bump(confirmed, who);
      const claimedAt = d.order?.claimedAt;
      // No claimedAt means the order never went through the pool — an
      // import or a direct entry. It is a real confirmation, but it is not
      // evidence of how fast anyone works, so it is counted and not timed.
      if (claimedAt && claimedAt <= d.createdAt) {
        const span = businessMinutesBetween(claimedAt, d.createdAt, calendar);
        const list = confirmSpans.get(who);
        if (list) list.push(span);
        else confirmSpans.set(who, [span]);
      }
    } else if (d.newValue === 'NO_ANSWER') bump(noAnswer, who);
    else bump(rejected, who);
  }

  const attemptsOf = new Map<string, number>();
  for (const a of attempts) attemptsOf.set(a.employeeId, (attemptsOf.get(a.employeeId) ?? 0) + a._count._all);
  const openOf = new Map(openNow.map((o) => [o.claimedById as string, o._count._all]));

  // A loop and not a `.map`, so that it may wait its turn (the order of `ids` is the order `.map` had).
  const employees: EmployeeRow[] = [];
  for (const id of ids) {
    const person = personOf.get(id);
    const ok = confirmed.get(id) ?? 0;
    const no = rejected.get(id) ?? 0;
    const decided = ok + no;
    const times = claimTimes.get(id) ?? [];

    // The gap between one pull and the next, in business minutes, so a
    // night and a weekend do not count as idleness.
    const gaps: number[] = [];
    for (let i = 1; i < times.length; i++) {
      const turn = pause();
      if (turn) await turn;
      gaps.push(businessMinutesBetween(times[i - 1], times[i], calendar));
    }

    const tries = attemptsOf.get(id) ?? 0;
    employees.push({
      id,
      name: person?.name ?? '—',
      role: person?.role ?? null,
      claimed: times.length,
      confirmed: ok,
      rejected: no,
      noAnswer: noAnswer.get(id) ?? 0,
      decided,
      openNow: openOf.get(id) ?? 0,
      confirmationRate: decided > 0 ? Math.round((ok / decided) * 100) : null,
      medianConfirmMinutes: median(confirmSpans.get(id) ?? []),
      medianGapMinutes: median(gaps),
      medianFirstActionMinutes: median(firstActionSpans.get(id) ?? []),
      attempts: tries,
      // No logged attempts is an absence of records, not a rate of zero —
      // plenty of confirming happens on a phone the system never sees, and
      // a column of zeros would read as an employee who called nobody.
      attemptsPerDecision: decided > 0 && tries > 0 ? Number((tries / decided).toFixed(1)) : null,
    });
  }

  // Busiest first; a tie goes to whoever decided more.
  employees.sort((a, b) => b.claimed - a.claimed || b.decided - a.decided);

  const allSpans = [...confirmSpans.values()].flat();
  const totalConfirmed = employees.reduce((s, e) => s + e.confirmed, 0);
  const totalRejected = employees.reduce((s, e) => s + e.rejected, 0);
  const totalDecided = totalConfirmed + totalRejected;

  return {
    employees,
    totals: {
      claimed: employees.reduce((s, e) => s + e.claimed, 0),
      confirmed: totalConfirmed,
      rejected: totalRejected,
      decided: totalDecided,
      confirmationRate: totalDecided > 0 ? Math.round((totalConfirmed / totalDecided) * 100) : null,
      medianConfirmMinutes: median(allSpans),
    },
  };
}
