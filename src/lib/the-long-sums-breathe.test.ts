import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db } = vi.hoisted(() => ({
  db: {
    orderClaimHistory: { findMany: vi.fn() },
    orderStatusLog: { findMany: vi.fn() },
    orderContactAttempt: { groupBy: vi.fn(), findMany: vi.fn() },
    order: { groupBy: vi.fn(), findMany: vi.fn() },
    user: { findMany: vi.fn() },
    attendanceMark: { findMany: vi.fn() },
  },
}));
vi.mock('./db', () => ({ db }));

import { median, teamPerformance, type EmployeeRow, type TeamPerformance } from './team-performance';
import { attendance, type AttendanceRow, type DayRow } from './attendance';
import { businessMinutesBetween, zonedParts, type BusinessCalendar } from './business-calendar';
import { shiftCalendar, type PersonShift } from './employee-shift';
import { isReleaseSheDidNotPress } from './auto-release';

/**
 * THE LONG SUMS GIVE THE THREAD BACK — AND SAY WHAT THEY ALWAYS SAID.
 *
 * The owner, 13/11: «ابحث عن سبب التعليق بالسايت ولوحة الأداء». The team table and the attendance report each add up tens of
 * thousands of rows in one stretch with nothing awaited in it, and the site is one process with one thread: nobody else is
 * answered until the stretch ends. They now hand the thread back every couple of thousand rows (`breathe.ts`).
 *
 * What this holds:
 *   1. THE OLD FUNCTIONS, copied word for word from the commit before the change (`ref…`), as the reference.
 *   2. The same answer from the new ones on a fixture of thousands of rows — nights, weekends, a shift of their own, releases
 *      the clock wrote — compared whole, with `toEqual`.
 *   3. That the new ones really do hand the thread back, and the old ones did not (so the test can fail).
 */

// ───────────────────────── THE REFERENCE: the functions as they were ─────────────────────────

const REF_DECISIONS = ['CONFIRMED', 'REJECTED', 'CANCELLED'] as const;
const REF_OPEN_STATUSES = ['IN_PROGRESS', 'NO_ANSWER', 'FOLLOW_UP_REQUIRED', 'POSTPONED'];
const REF_ROW_CAP = 20000;

async function refTeamPerformance(input: {
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
    db.orderClaimHistory.findMany({
      where: { companyId, action: 'CLAIMED', ...inStore, ...(when ? { createdAt: when } : {}) },
      select: { userId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: REF_ROW_CAP,
    }),
    db.orderStatusLog.findMany({
      where: {
        companyId,
        statusType: 'CONFIRMATION',
        newValue: { in: [...REF_DECISIONS, 'NO_ANSWER'] },
        ...inStore,
        ...(when ? { createdAt: when } : {}),
      },
      select: {
        changedById: true,
        newValue: true,
        createdAt: true,
        order: { select: { claimedAt: true } },
      },
      take: REF_ROW_CAP,
    }),
    db.orderContactAttempt.groupBy({
      by: ['employeeId', 'orderId'],
      where: { companyId, ...inStore, ...(when ? { createdAt: when } : {}) },
      _count: { _all: true },
      _min: { createdAt: true },
    }),
    db.order.groupBy({
      by: ['claimedById'],
      where: { companyId, storeId, claimedById: { not: null }, confirmationStatus: { in: REF_OPEN_STATUSES } },
      _count: { _all: true },
    }),
  ]);

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

  const people = await db.user.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, name: true, role: true },
  });
  const personOf = new Map(people.map((p: { id: string; name: string; role: string }) => [p.id, p]));

  const attemptOrderIds = [...new Set(attempts.map((a: { orderId: string }) => a.orderId))].slice(0, REF_ROW_CAP);
  const claimedAtOf = attemptOrderIds.length
    ? new Map(
        (
          await db.order.findMany({
            where: { id: { in: attemptOrderIds }, companyId, storeId },
            select: { id: true, claimedAt: true, claimedById: true },
          })
        ).map((o: { id: string }) => [o.id, o])
      )
    : new Map();

  const firstActionSpans = new Map<string, number[]>();
  for (const a of attempts) {
    const order = claimedAtOf.get(a.orderId) as { claimedAt: Date | null; claimedById: string | null } | undefined;
    const startedAt = order?.claimedAt;
    const firstAt = a._min.createdAt;
    if (!startedAt || !firstAt || order.claimedById !== a.employeeId || firstAt < startedAt) continue;
    const span = businessMinutesBetween(startedAt, firstAt, calendar);
    const list = firstActionSpans.get(a.employeeId);
    if (list) list.push(span);
    else firstActionSpans.set(a.employeeId, [span]);
  }

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
    const who = d.changedById;
    if (!who) continue;
    if (d.newValue === 'CONFIRMED') {
      bump(confirmed, who);
      const claimedAt = d.order?.claimedAt;
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
  const openOf = new Map(openNow.map((o: { claimedById: string; _count: { _all: number } }) => [o.claimedById as string, o._count._all]));

  const employees: EmployeeRow[] = [...ids].map((id) => {
    const person = personOf.get(id) as { name: string; role: string } | undefined;
    const ok = confirmed.get(id) ?? 0;
    const no = rejected.get(id) ?? 0;
    const decided = ok + no;
    const times = claimTimes.get(id) ?? [];

    const gaps: number[] = [];
    for (let i = 1; i < times.length; i++) {
      gaps.push(businessMinutesBetween(times[i - 1], times[i], calendar));
    }

    const tries = attemptsOf.get(id) ?? 0;
    return {
      id,
      name: person?.name ?? '—',
      role: person?.role ?? null,
      claimed: times.length,
      confirmed: ok,
      rejected: no,
      noAnswer: noAnswer.get(id) ?? 0,
      decided,
      openNow: (openOf.get(id) as number | undefined) ?? 0,
      confirmationRate: decided > 0 ? Math.round((ok / decided) * 100) : null,
      medianConfirmMinutes: median(confirmSpans.get(id) ?? []),
      medianGapMinutes: median(gaps),
      medianFirstActionMinutes: median(firstActionSpans.get(id) ?? []),
      attempts: tries,
      attemptsPerDecision: decided > 0 && tries > 0 ? Number((tries / decided).toFixed(1)) : null,
    };
  });

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

const REF_MINUTE = 60 * 1000;

function refHhmm(value: string, fallback: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value ?? '');
  if (!m) return fallback;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return minutes >= 0 && minutes <= 24 * 60 ? minutes : fallback;
}
function refLocalDay(at: Date, timezone: string): string {
  const p = zonedParts(at, timezone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
function refLocalMinutes(at: Date, timezone: string): number {
  const p = zonedParts(at, timezone);
  return p.hour * 60 + p.minute;
}
const refEarliest = (a: Date | null, b: Date | null) => (!a ? b : !b ? a : a < b ? a : b);
const refLatest = (a: Date | null, b: Date | null) => (!a ? b : !b ? a : a > b ? a : b);

async function refAttendance(input: {
  companyId: string;
  storeId: string;
  userIds: string[];
  calendar: BusinessCalendar;
  shifts?: Map<string, PersonShift>;
  start: Date;
  end: Date;
}): Promise<Map<string, AttendanceRow>> {
  const { companyId, storeId, userIds, calendar, shifts, start, end } = input;
  const result = new Map<string, AttendanceRow>();
  if (userIds.length === 0) return result;

  const when = { gte: start, lte: end };
  const [marks, claims, decisions, attempts] = await Promise.all([
    db.attendanceMark.findMany({
      where: { userId: { in: userIds }, at: when },
      select: { userId: true, kind: true, at: true },
      orderBy: { at: 'asc' },
    }),
    db.orderClaimHistory.findMany({
      where: { companyId, userId: { in: userIds }, order: { storeId }, createdAt: when },
      select: { userId: true, createdAt: true, action: true, reason: true, metadata: true },
    }),
    db.orderStatusLog.findMany({
      where: { companyId, changedById: { in: userIds }, order: { storeId }, createdAt: when },
      select: { changedById: true, createdAt: true },
    }),
    db.orderContactAttempt.findMany({
      where: { companyId, employeeId: { in: userIds }, order: { storeId }, createdAt: when },
      select: { employeeId: true, createdAt: true },
    }),
  ]);

  const shiftOf = (userId: string) => {
    const cal = shiftCalendar(shifts?.get(userId), calendar);
    return {
      start: refHhmm(cal.workHoursStart, 9 * 60),
      end: refHhmm(cal.workHoursEnd, 17 * 60),
      weekend: new Set(cal.weekendDays ?? []),
    };
  };

  const byUser = new Map<string, Map<string, DayRow>>();
  const dayOf = (userId: string, at: Date): DayRow => {
    let days = byUser.get(userId);
    if (!days) byUser.set(userId, (days = new Map()));
    const date = refLocalDay(at, calendar.timezone);
    let day = days.get(date);
    if (!day) {
      days.set(
        date,
        (day = {
          date,
          arrivedAt: null,
          leftAt: null,
          presentMinutes: null,
          workStartedAt: null,
          workEndedAt: null,
          workedMinutes: null,
          lateMinutes: null,
          leftEarly: false,
          checkedOut: false,
          arrivalFromWork: false,
        })
      );
    }
    return day;
  };

  for (const m of marks) {
    const day = dayOf(m.userId, m.at);
    if (m.kind === 'CHECK_OUT') {
      day.leftAt = refLatest(day.leftAt, m.at);
      day.checkedOut = true;
    } else {
      day.arrivedAt = refEarliest(day.arrivedAt, m.at);
      day.leftAt = refLatest(day.leftAt, m.at);
    }
  }

  const sawWork = (userId: string, at: Date) => {
    const day = dayOf(userId, at);
    day.workStartedAt = refEarliest(day.workStartedAt, at);
    day.workEndedAt = refLatest(day.workEndedAt, at);
  };
  for (const c of claims) if (!isReleaseSheDidNotPress(c)) sawWork(c.userId, c.createdAt);
  for (const d of decisions) if (d.changedById) sawWork(d.changedById, d.createdAt);
  for (const a of attempts) sawWork(a.employeeId, a.createdAt);

  for (const userId of userIds) {
    const days = [...(byUser.get(userId)?.values() ?? [])].sort((a, b) => a.date.localeCompare(b.date));
    const shift = shiftOf(userId);

    let daysLate = 0;
    let totalLate = 0;
    let totalPresent = 0;
    let daysPresent = 0;
    let daysWithoutWork = 0;
    let daysLateEstimated = 0;

    for (const day of days) {
      if (!day.arrivedAt && day.workStartedAt) day.arrivalFromWork = true;
      day.arrivedAt = refEarliest(day.arrivedAt, day.workStartedAt);
      if (!day.checkedOut) day.leftAt = refLatest(day.leftAt, day.workEndedAt);

      if (day.arrivedAt && day.leftAt && day.leftAt > day.arrivedAt) {
        day.presentMinutes = Math.round((+day.leftAt - +day.arrivedAt) / REF_MINUTE);
      } else if (day.arrivedAt) {
        day.presentMinutes = 0;
      }

      if (day.workStartedAt && day.workEndedAt) {
        day.workedMinutes = Math.round((+day.workEndedAt - +day.workStartedAt) / REF_MINUTE);
      }

      if (day.arrivedAt) {
        daysPresent++;
        totalPresent += day.presentMinutes ?? 0;
        if (!day.workStartedAt) daysWithoutWork++;

        const p = zonedParts(day.arrivedAt, calendar.timezone);
        if (!shift.weekend.has(p.weekday)) {
          const late = refLocalMinutes(day.arrivedAt, calendar.timezone) - shift.start;
          day.lateMinutes = Math.max(0, late);
          if (day.lateMinutes > 0) {
            daysLate++;
            totalLate += day.lateMinutes;
            if (day.arrivalFromWork) daysLateEstimated++;
          }
          if (day.leftAt && refLocalMinutes(day.leftAt, calendar.timezone) < shift.end) {
            day.leftEarly = true;
          }
        }
      }
    }

    result.set(userId, {
      userId,
      days,
      daysPresent,
      daysLate,
      totalLateMinutes: totalLate,
      totalPresentMinutes: totalPresent,
      avgPresentMinutes: daysPresent > 0 ? Math.round(totalPresent / daysPresent) : null,
      daysWithoutWork,
      daysLateEstimated,
    });
  }

  return result;
}

// ───────────────────────── the fixture: a month of a desk, seeded ─────────────────────────

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const CAL: BusinessCalendar = { workHoursStart: '09:00', workHoursEnd: '21:00', weekendDays: [5], timezone: 'Asia/Damascus' };
const START = new Date('2026-10-01T00:00:00Z');
const END = new Date('2026-10-31T00:00:00Z');
const USERS = Array.from({ length: 12 }, (_, i) => `u${i}`);
const SHIFTS = new Map<string, PersonShift>([
  ['u1', { shiftStart: '12:00', shiftEnd: '20:00', restDays: '4' }],
  ['u2', { shiftStart: 'bad', shiftEnd: null, restDays: null }],
  ['u3', { shiftStart: '06:00', shiftEnd: '05:00', restDays: '' }],
]);

interface Fixture {
  claims: { userId: string | null; createdAt: Date; action: string; reason: string | null; metadata: string | null }[];
  decisions: { changedById: string | null; newValue: string; createdAt: Date; order: { claimedAt: Date | null } }[];
  attemptGroups: { employeeId: string; orderId: string; _count: { _all: number }; _min: { createdAt: Date | null } }[];
  attemptRows: { employeeId: string; createdAt: Date }[];
  orders: { id: string; claimedAt: Date | null; claimedById: string | null }[];
  marks: { userId: string; kind: string; at: Date }[];
}

function build(seed: number, size: { claims: number; decisions: number; attempts: number; marks: number }): Fixture {
  const next = rng(seed);
  const span = END.getTime() - START.getTime();
  const when = () => new Date(START.getTime() + Math.floor(next() * span));
  const user = () => USERS[Math.floor(next() * USERS.length)];

  const claims = Array.from({ length: size.claims }, when)
    .sort((a, b) => a.getTime() - b.getTime())
    .map((createdAt) => {
      const k = next();
      return k < 0.78
        ? { userId: user(), createdAt, action: 'CLAIMED', reason: null, metadata: null }
        : k < 0.88
          ? { userId: user(), createdAt, action: 'RELEASED', reason: 'AUTO_RELEASE_90_BUSINESS_MINUTES', metadata: null }
          : k < 0.97
            ? { userId: user(), createdAt, action: 'RELEASED', reason: null, metadata: JSON.stringify({ takenBy: 'a-colleague' }) }
            : { userId: null, createdAt, action: 'CLAIMED', reason: null, metadata: null };
    });

  const decisions = Array.from({ length: size.decisions }, () => {
    const pulledAt = when();
    // Some decided within minutes, some overnight, a few over the weekend, a few with no pull at all (an import).
    const k = next();
    const took = k < 0.6 ? Math.floor(next() * 40) * 60_000 : k < 0.85 ? Math.floor(next() * 16 * 60) * 60_000 : Math.floor(next() * 3 * 24 * 60) * 60_000;
    const r = next();
    return {
      changedById: next() < 0.02 ? null : user(),
      newValue: r < 0.62 ? 'CONFIRMED' : r < 0.8 ? 'REJECTED' : r < 0.9 ? 'CANCELLED' : 'NO_ANSWER',
      createdAt: new Date(pulledAt.getTime() + took),
      order: { claimedAt: next() < 0.07 ? null : pulledAt },
    };
  });

  const orders: Fixture['orders'] = [];
  const attemptGroups: Fixture['attemptGroups'] = [];
  const attemptRows: Fixture['attemptRows'] = [];
  for (let i = 0; i < size.attempts; i++) {
    const claimedAt = when();
    const employeeId = user();
    // Most orders are still shown as claimed by the person who rang; some were moved to a colleague.
    orders.push({ id: `o${i}`, claimedAt: next() < 0.05 ? null : claimedAt, claimedById: next() < 0.9 ? employeeId : user() });
    const firstAt = new Date(claimedAt.getTime() + (next() < 0.05 ? -60_000 : Math.floor(next() * 300) * 60_000));
    attemptGroups.push({ employeeId, orderId: `o${i}`, _count: { _all: 1 + Math.floor(next() * 4) }, _min: { createdAt: next() < 0.02 ? null : firstAt } });
    attemptRows.push({ employeeId, createdAt: firstAt });
  }

  const marks = Array.from({ length: size.marks }, () => {
    const k = next();
    return { userId: user(), kind: k < 0.5 ? 'LOGIN' : k < 0.75 ? 'CHECK_IN' : 'CHECK_OUT', at: when() };
  });

  return { claims, decisions, attemptGroups, attemptRows, orders, marks };
}

/** Wire the mocked database to answer both functions from one fixture, the way the real one would. */
function wire(f: Fixture) {
  db.orderClaimHistory.findMany.mockImplementation(async (args: { where: { action?: string } }) =>
    args.where.action === 'CLAIMED' ? f.claims.filter((c) => c.action === 'CLAIMED' && c.userId) : f.claims
  );
  db.orderStatusLog.findMany.mockImplementation(async () => f.decisions);
  db.orderContactAttempt.groupBy.mockImplementation(async () => f.attemptGroups);
  db.orderContactAttempt.findMany.mockImplementation(async () => f.attemptRows);
  db.order.groupBy.mockImplementation(async () => USERS.slice(0, 6).map((id, i) => ({ claimedById: id, _count: { _all: i + 1 } })));
  db.order.findMany.mockImplementation(async () => f.orders);
  db.user.findMany.mockImplementation(async () => USERS.map((id, i) => ({ id, name: `موظف ${i}`, role: i % 4 === 0 ? 'CONFIRMATION_SUPERVISOR' : 'CONFIRMATION_AGENT' })));
  db.attendanceMark.findMany.mockImplementation(async () => f.marks);
}

/** How many times other work got a turn while `run` was being worked out. */
async function turnsDuring(run: () => Promise<unknown>): Promise<number> {
  let turns = 0;
  let going = true;
  const spin = () => {
    if (!going) return;
    turns++;
    setImmediate(spin);
  };
  setImmediate(spin);
  try {
    await run();
  } finally {
    going = false;
  }
  return turns;
}

const TEAM = { companyId: 'c1', storeId: 's1', calendar: CAL, start: START, end: END };
const ATTENDANCE = { companyId: 'c1', storeId: 's1', userIds: USERS, calendar: CAL, shifts: SHIFTS, start: START, end: END };
const BIG = { claims: 6000, decisions: 6000, attempts: 3000, marks: 2500 };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the team table', () => {
  it('is the same table as before, on thousands of rows', async () => {
    wire(build(20261113, BIG));
    const before = await refTeamPerformance(TEAM);
    const after = await teamPerformance(TEAM);
    expect(after).toEqual(before);
    // and the fixture is a real table, not two empty ones that happen to agree
    expect(after.employees).toHaveLength(12);
    expect(after.totals.claimed).toBeGreaterThan(4000);
    expect(after.totals.confirmed).toBeGreaterThan(2500);
    expect(after.employees.some((e) => e.medianConfirmMinutes !== null && e.medianGapMinutes !== null && e.medianFirstActionMinutes !== null)).toBe(true);
  }, 240_000);

  // One loop at a time, so that taking the pause out of ANY one of them is seen: each fixture is big in one kind of row only.
  it.each([
    ['the first-action times (one per order that was rung)', { claims: 0, decisions: 0, attempts: 5000, marks: 0 }],
    ['the pull-to-confirm times (one per decision)', { claims: 0, decisions: 5000, attempts: 0, marks: 0 }],
    // (about a fifth of the claim lines in the fixture are releases, which the table does not count as pulls)
    ['the gaps between pulls (one per pull)', { claims: 9000, decisions: 0, attempts: 0, marks: 0 }],
  ])('hands the thread back while it works out %s, and the old one did not', async (_what, size) => {
    wire(build(7, size));
    const old = await turnsDuring(() => refTeamPerformance(TEAM));
    const now = await turnsDuring(() => teamPerformance(TEAM));
    expect(old).toBeLessThanOrEqual(1);
    expect(now).toBeGreaterThanOrEqual(2);
  }, 240_000);

  it('is the same on an empty month and on a month with one person', async () => {
    wire(build(1, { claims: 0, decisions: 0, attempts: 0, marks: 0 }));
    db.order.groupBy.mockImplementation(async () => []);
    expect(await teamPerformance(TEAM)).toEqual(await refTeamPerformance(TEAM));
    wire(build(2, { claims: 40, decisions: 25, attempts: 10, marks: 5 }));
    expect(await teamPerformance(TEAM)).toEqual(await refTeamPerformance(TEAM));
  });
});

describe('the attendance report', () => {
  it('is the same report as before, on thousands of rows', async () => {
    wire(build(99, { ...BIG, marks: 2500 }));
    const before = await refAttendance(ATTENDANCE);
    const after = await attendance(ATTENDANCE);
    expect(after).toEqual(before);
    // a report with days in it, some of them late, some of them guessed from work
    const days = [...after.values()].flatMap((r) => r.days);
    expect(days.length).toBeGreaterThan(200);
    expect([...after.values()].some((r) => r.daysLate > 0)).toBe(true);
    expect([...after.values()].some((r) => r.daysLateEstimated > 0)).toBe(true);
  }, 240_000);

  it.each([
    ['the marks', { claims: 0, decisions: 0, attempts: 0, marks: 5000 }],
    ['the claim history', { claims: 5000, decisions: 0, attempts: 0, marks: 0 }],
    ['the status log', { claims: 0, decisions: 5000, attempts: 0, marks: 0 }],
    ['the contact attempts', { claims: 0, decisions: 0, attempts: 5000, marks: 0 }],
  ])('hands the thread back while it reads %s, and the old one did not', async (_what, size) => {
    wire(build(5, size));
    const old = await turnsDuring(() => refAttendance(ATTENDANCE));
    const now = await turnsDuring(() => attendance(ATTENDANCE));
    expect(old).toBeLessThanOrEqual(1);
    expect(now).toBeGreaterThanOrEqual(2);
  }, 240_000);

  it('is the same with nobody asked for, and with a few rows', async () => {
    wire(build(3, { claims: 30, decisions: 10, attempts: 5, marks: 6 }));
    expect(await attendance({ ...ATTENDANCE, userIds: [] })).toEqual(await refAttendance({ ...ATTENDANCE, userIds: [] }));
    expect(await attendance(ATTENDANCE)).toEqual(await refAttendance(ATTENDANCE));
  });
});
