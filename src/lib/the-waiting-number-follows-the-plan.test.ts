import { describe, expect, it, vi } from 'vitest';
import { zonedTimeToInstant } from './business-calendar';
import { workClock } from './no-answer-rounds';
import { returnsMode } from './no-answer-returns';
import { RETRY_SCAN_PAGE, RETURNS_MODE, pickNextCandidate, waitingByPlan, waitingCount } from './confirmation-queue';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE WAITING NUMBER FOLLOWS THE PLAN (the planner 15/11 22:30, ruling 24)
 *
 * What must work. With the plan on (`returns.cadence`), the pull's order is: held for her · NEW · the promise that arrived · the retry whose due came · the rest. `waitingByPlan` says the
 * waiting number in those four — `fresh` / `promise` / `retry` / `rest` — over the very predicates the pull picks from (`readyToPullWhere`, `duePostponedWhere`, `cadenceDueLineWhere`,
 * `promiseArrived`).
 *
 * The tests.
 *  1. THE ORACLE IS WRITTEN BY HAND, beside the facts: each order of one fixture says which part it is in (`EXPECTED`), for a supervisor and for Sara — not derived from the code under test.
 *     The database is a small SQL-shaped evaluator that reads the filters' own text over the rows (as `the-waiting-number-is-said-in-parts.test.ts` does).
 *  2. The four ADD UP to `waitingCount` — the number the header chip and the old counter give — so the total does not change.
 *  3. THE PULL AGREES: drained through the real `pickNextCandidate` over the same rows, the orders come out in the parts' order (fresh, then promise, then retry, then rest), and the
 *     number of each part is how many came out of it.
 *  4. A scan past the page: what the page did not read is in `rest`, the total is unchanged, the counter does not warn (it runs on every poll) and asks for no customer data.
 *
 * Edge cases that matter. A NEW order that also carries a date is NEW (it is pulled before any promise) · an order that is a promise AND a ready retry is a promise · a promise whose date
 * a later line answered is no promise (a retry if it carries a due, or if it is a postponed order the pull hands out right after the promises) · a «لا يرد» line from before the floor holds
 * and ranks nothing · an order the pull cannot hand out (not ready, a future date, claimed, decided, held for a colleague) is in no part.
 * Blockers: no money, no order creation, no migration — and the OFF path is `the-waiting-number-is-said-in-parts.test.ts`, untouched, plus the route's pin.
 * ═══════════════════════════════════════════════════════════════════════
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
type Tri = true | false | null;
const and = (xs: Tri[]): Tri => (xs.includes(false) ? false : xs.includes(null) ? null : true);
const or = (xs: Tri[]): Tri => (xs.includes(true) ? true : xs.includes(null) ? null : false);
function tri(row: Row, where: Row): Tri {
  return and(
    Object.entries(where).map(([key, cond]): Tri => {
      if (key === 'AND') return and((cond as Row[]).map((w) => tri(row, w)));
      if (key === 'OR') return or((cond as Row[]).map((w) => tri(row, w)));
      const value = row[key] ?? null;
      if (cond === null) return value === null;
      if (cond instanceof Date) return value === null ? null : (value as Date).getTime() === cond.getTime();
      if (typeof cond !== 'object') return value === null ? null : value === cond;
      return and(
        Object.entries(cond as Row).map(([op, arg]): Tri => {
          switch (op) {
            case 'not': return arg === null ? value !== null : value === null ? null : value !== arg;
            case 'in': return value === null ? null : (arg as unknown[]).includes(value);
            case 'gt': return value === null ? null : (value as Date).getTime() > (arg as Date).getTime();
            case 'lte': return value === null ? null : (value as Date).getTime() <= (arg as Date).getTime();
            case 'is': return arg === null ? value === null : value === null ? null : tri(value as Row, arg as Row);
            case 'none': return !(row[key] ?? []).some((c: Row) => tri(c, arg as Row) === true);
            case 'some': return (row[key] ?? []).some((c: Row) => tri(c, arg as Row) === true);
            default: throw new Error(`the evaluator does not know «${op}»`);
          }
        })
      );
    })
  );
}
const matches = (row: Row, where: Row): boolean => tri(row, where) === true;

const JO = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' };
const clock = workClock(JO);
const t = (day: number, h: number, m = 0) => zonedTimeToInstant(JO.timezone, 2026, 11, day, h, m);
const scope = { companyId: 'c1', storeId: 's1' };
/** Monday noon. Sunday the 1st is a working day; Friday and Saturday are the weekend. */
const NOW = t(2, 12);
/** The floor: the moment the owner turned the plan on (Sunday 08:00). */
const SINCE = t(1, 8);
const hoursFromNow = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
const MODE = returnsMode(NOW, clock, RETURNS_MODE.idleBusinessMinutes, SINCE);
if (!MODE.cadence) throw new Error('the fixture mode must carry the cadence');
const PLAN = MODE as typeof MODE & { cadence: { since: Date } };

/** Orders are born in the order they are listed: the first is the oldest. */
let born = 0;
const order = (name: string, confirmationStatus: string, attempts: Row[] = [], over: Row = {}): Row => ({
  id: name,
  name,
  ...scope,
  createdAt: new Date(t(1, 0).getTime() + ++born * 60_000),
  claimedById: null,
  shippingStatus: 'NOT_READY',
  confirmationStatus,
  postponedUntil: null,
  nextFollowUpAt: null,
  assignedToId: null,
  assignedAt: null,
  assignee: null,
  claimHistory: [{ action: 'RELEASED' }],
  contactAttempts: attempts,
  ...over,
});
const line = (result: string, createdAt: Date, nextFollowUpAt: Date | null = null) => ({ createdAt, result, nextFollowUpAt, employeeId: 'sara' });

type Part = 'fresh' | 'promise' | 'retry' | 'rest';
const ROWS: Row[] = [];
const EXPECTED: Record<string, Part | null> = {};
const add = (part: Part | null, row: Row) => {
  ROWS.push(row);
  EXPECTED[row.name] = part;
};

// ── NEW ──
add('fresh', order('new-plain', 'NEW'));
// A NEW order that also carries a date: the pull hands it out as NEW, before any promise.
add('fresh', order('new-with-a-date', 'NEW', [], { nextFollowUpAt: hoursFromNow(-1) }));
// ── THE PROMISE THAT ARRIVED (any status) ──
add('promise', order('promise-follow-up', 'FOLLOW_UP_REQUIRED', [line('ANSWERED', hoursFromNow(-5))], { nextFollowUpAt: hoursFromNow(-2) }));
add('promise', order('promise-postponed', 'POSTPONED', [line('ANSWERED', t(1, 12))], { postponedUntil: hoursFromNow(-1), nextFollowUpAt: hoursFromNow(-1) }));
// A postponed order nobody has rung since the day it was postponed (no line at all): its date came — a promise.
add('promise', order('promise-postponed-no-line', 'POSTPONED', [], { postponedUntil: hoursFromNow(-0.5) }));
// Both a promise and a ready retry (a counted press whose due is past, rung long before the customer's date): a promise.
add('promise', order('promise-and-retry', 'IN_PROGRESS', [line('NO_ANSWER', t(1, 10), t(1, 13))], { nextFollowUpAt: hoursFromNow(-2) }));
// ── THE RETRY WHOSE TIME CAME ──
add('retry', order('retry-due', 'IN_PROGRESS', [line('NO_ANSWER', t(1, 10), t(1, 13))]));
// The customer asked for a date, and a «لا يرد» was logged AFTER it: no longer a promise — a retry, its due written on the line.
add('retry', order('retry-after-its-date', 'IN_PROGRESS', [line('NO_ANSWER', t(2, 11), t(2, 11, 30))], { nextFollowUpAt: hoursFromNow(-3) }));
// A postponed order whose date came and was worked after it: no promise; the pull hands it out right after the promises, so it is counted with the retries.
add('retry', order('postponed-worked-after', 'POSTPONED', [line('OPENED', hoursFromNow(-1))], { postponedUntil: hoursFromNow(-3), nextFollowUpAt: hoursFromNow(-3) }));
// ── THE REST ──
add('rest', order('rest-no-due', 'IN_PROGRESS', [line('OPENED', t(1, 11))]));
// A «لا يرد» from BEFORE the floor: holds nothing and ranks nothing — an ordinary rung order.
add('rest', order('rest-before-the-floor', 'NO_ANSWER', [line('NO_ANSWER', t(1, 7), t(1, 7, 30))]));
// ── IN NO PART ──
add(null, order('held-by-its-due', 'NO_ANSWER', [line('NO_ANSWER', hoursFromNow(-0.2), hoursFromNow(2))]));
add(null, order('postponed-tomorrow', 'POSTPONED', [line('ANSWERED', t(1, 12))], { postponedUntil: hoursFromNow(24), nextFollowUpAt: hoursFromNow(24) }));
add(null, order('claimed', 'NEW', [], { claimedById: 'someone' }));
add(null, order('confirmed', 'CONFIRMED', [line('ANSWERED', t(1, 12))]));
// Held for a colleague who worked the customer: a supervisor sees it (NEW), Sara does not.
const HELD = order('held-for-noor', 'NEW', [], { assignedToId: 'noor', assignedAt: hoursFromNow(-2), assignee: { status: 'ACTIVE' }, claimHistory: [] });
add('fresh', HELD);

const RANK: Record<Part, number> = { fresh: 0, promise: 1, retry: 2, rest: 3 };
const tally = (skip: string[] = []) => {
  const out: Record<Part, number> = { fresh: 0, promise: 0, retry: 0, rest: 0 };
  for (const [name, part] of Object.entries(EXPECTED)) if (part && !skip.includes(name)) out[part]++;
  return out;
};

/** A database that answers `count` and `findMany` (and `findFirst`) from the filters' text over a copy of the rows, and remembers what it was asked. */
function dbOver(rows: Row[], seen: { counts: Row[]; scans: Row[] } = { counts: [], scans: [] }) {
  const sorted = (xs: Row[], orderBy: Row | Row[] | undefined) => {
    const keys = ([] as Row[]).concat(orderBy ?? []);
    return [...xs].sort((a, b) => {
      for (const k of keys) {
        const [field, dir] = Object.entries(k)[0] as [string, 'asc' | 'desc'];
        const x = a[field] ?? null;
        const y = b[field] ?? null;
        if (x === y) continue;
        if (x === null) return 1;
        if (y === null) return -1;
        const d = x instanceof Date ? x.getTime() - y.getTime() : x < y ? -1 : 1;
        if (d !== 0) return dir === 'desc' ? -d : d;
      }
      return 0;
    });
  };
  const project = (row: Row, select: Row): Row => {
    const out: Row = {};
    for (const [key, spec] of Object.entries(select)) {
      if (key === '_count') {
        out._count = Object.fromEntries(
          Object.entries(spec.select as Row).map(([rel, s]) => [rel, (row[rel] ?? []).filter((c: Row) => matches(c, (s as Row).where ?? {})).length])
        );
      } else if (spec === true) out[key] = row[key];
      else {
        const kids = sorted((row[key] ?? []).filter((c: Row) => matches(c, spec.where ?? {})), spec.orderBy);
        out[key] = (spec.take ? kids.slice(0, spec.take) : kids).map((c: Row) => project(c, spec.select ?? Object.fromEntries(Object.keys(c).map((k) => [k, true]))));
      }
    }
    return out;
  };
  return {
    order: {
      count: async ({ where }: { where: Row }) => (seen.counts.push(where), rows.filter((r) => matches(r, where)).length),
      findMany: async (args: { where: Row; orderBy?: Row[]; take?: number; select: Row }) => {
        seen.scans.push(args as Row);
        const hits = sorted(rows.filter((r) => matches(r, args.where)), args.orderBy);
        return (args.take ? hits.slice(0, args.take) : hits).map((r) => project(r, args.select));
      },
      findFirst: async (args: { where: Row; orderBy?: Row | Row[]; select: Row }) => {
        const hit = sorted(rows.filter((r) => matches(r, args.where)), args.orderBy)[0];
        return hit ? project(hit, args.select) : null;
      },
    },
  } as never;
}

describe('the four parts are what the filters and the promise fact say — a hand-written oracle', () => {
  it('a supervisor reads the whole pool', async () => {
    expect(await waitingByPlan(dbOver(ROWS), scope, NOW, undefined, PLAN)).toEqual(tally());
  });

  it('Sara: what a colleague holds is not hers', async () => {
    expect(await waitingByPlan(dbOver(ROWS), scope, NOW, 'sara', PLAN)).toEqual(tally(['held-for-noor']));
  });

  it('and the fixture is not vacuous: every part has an order, two askers give two answers, and the oracle says what it says', () => {
    expect(tally(['held-for-noor'])).toEqual({ fresh: 2, promise: 4, retry: 3, rest: 2 });
    expect(tally()).toEqual({ fresh: 3, promise: 4, retry: 3, rest: 2 });
    expect(Object.values(EXPECTED).filter((p) => p === null)).toHaveLength(4);
  });
});

describe('the total does not change: the four add up to the number the header chip and the old counter give', () => {
  it.each([
    ['a supervisor', undefined],
    ['Sara', 'sara'],
  ] as const)('%s: fresh + promise + retry + rest = waitingCount', async (_who, forUserId) => {
    const parts = await waitingByPlan(dbOver(ROWS), scope, NOW, forUserId, PLAN);
    const whole = await waitingCount(dbOver(ROWS), scope, NOW, forUserId, PLAN);
    expect(parts.fresh + parts.promise + parts.retry + parts.rest).toBe(whole);
    expect(whole).toBeGreaterThan(0);
  });
});

describe('the pull agrees: drained through the real pick, the orders come out in the parts’ order and in the parts’ numbers', () => {
  it.each([
    ['a supervisor', undefined, []],
    ['Sara', 'sara', ['held-for-noor']],
  ] as const)('%s', async (_who, forUserId, skip) => {
    const rows = ROWS.map((r) => ({ ...r }));
    const db = dbOver(rows);
    const out: Part[] = [];
    for (let i = 0; i < 40; i++) {
      const id = await pickNextCandidate(db, scope, NOW, forUserId, { heldForHerAsked: true, returns: MODE });
      if (!id) break;
      out.push(EXPECTED[id]!);
      rows.find((r) => r.id === id)!.claimedById = 'taken';
    }
    expect(out.every(Boolean), 'the pull never hands out an order that is in no part').toBe(true);
    const ranks = out.map((p) => RANK[p]);
    expect(ranks, `the pull's order is the parts' order: ${out.join(' · ')}`).toEqual([...ranks].sort((a, b) => a - b));
    const counted = { fresh: 0, promise: 0, retry: 0, rest: 0 };
    for (const p of out) counted[p]++;
    expect(counted).toEqual(await waitingByPlan(dbOver(ROWS), scope, NOW, forUserId, PLAN));
    expect(counted).toEqual(tally([...skip]));
  });
});

describe('the questions it asks', () => {
  it('four counts and ONE scan: the dated orders of the pool that are not NEW, oldest-created first, bounded, with only the newest line and a filtered count of the due lines — and nothing of a customer', async () => {
    const seen = { counts: [] as Row[], scans: [] as Row[] };
    await waitingByPlan(dbOver(ROWS, seen), scope, NOW, 'sara', PLAN);
    expect(seen.counts).toHaveLength(4);
    expect(seen.scans).toHaveLength(1);
    const scan = seen.scans[0];
    expect(scan.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
    expect(scan.take).toBe(RETRY_SCAN_PAGE);
    expect(Object.keys(scan.select).sort()).toEqual(['_count', 'confirmationStatus', 'contactAttempts', 'nextFollowUpAt', 'postponedUntil']);
    expect(scan.select.contactAttempts).toMatchObject({ orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } });
  });

  it('a pool past the page: what the page did not read falls into «الباقي», the total is the pool, and the counter says nothing to the log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const promised = { confirmationStatus: 'FOLLOW_UP_REQUIRED', postponedUntil: null, nextFollowUpAt: hoursFromNow(-2), contactAttempts: [], _count: { contactAttempts: 0 } };
      const counts = [0, 2500, 100, 0]; // due, ready, fresh, undated retry — in the order the function asks
      const db = {
        order: {
          count: vi.fn(async () => counts.shift()!),
          findMany: vi.fn(async () => Array.from({ length: RETRY_SCAN_PAGE }, () => promised)),
        },
      } as never;
      const parts = await waitingByPlan(db, scope, NOW, 'sara', PLAN);
      expect(parts).toEqual({ fresh: 100, promise: RETRY_SCAN_PAGE, retry: 0, rest: 2500 - 100 - RETRY_SCAN_PAGE });
      expect(parts.fresh + parts.promise + parts.retry + parts.rest).toBe(2500);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
