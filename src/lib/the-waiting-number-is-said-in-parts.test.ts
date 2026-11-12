import { describe, expect, it } from 'vitest';
import { zonedTimeToInstant } from './business-calendar';
import { workClock } from './no-answer-rounds';
import { returnsMode } from './no-answer-returns';
import { RETURNS_MODE, duePostponedWhere, readyToPullWhere, waitingBreakdown, waitingCount } from './confirmation-queue';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE BIG NUMBER, SAID IN PARTS (the owner, 12/11: «لسا مش مفصولة» · «طلب جديد وخانة تانية طلب الراجع»)
 *
 *  1. `waitingBreakdown` cuts the pool the pull hands out into three: `fresh` (nobody has rung it), `returned` (rung before and ready
 *     again), `due` (a postponed order whose date came) — over the SAME two predicates the pick and the counter read.
 *  2. The parts ADD UP to `waitingCount`, whatever the mode (the rounds mode of «الطلب يرجع للطابور فوراً» on or off) and whoever asks
 *     (an agent for herself, a supervisor for the whole pool): the figure on the panel and the chip on the header can never disagree.
 *  3. The parts are a PARTITION: no order is counted in two of them, and an order the pull cannot hand out is in none.
 *  4. `fresh` is exactly «no contact attempt at all» and `returned` exactly «at least one» — the question the pull asks to find its
 *     first order (`pickNextCandidate`).
 *
 * Evaluated, not mocked: a small SQL-shaped evaluator (three values; a `WHERE` keeps only true) reads the filters' own text over
 * rows, the way `returns-filters-agree-with-the-rule.test.ts` does — the answer comes from the filter, not from this file.
 * Blockers: no money, no order creation, no migration.
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
const hoursFromNow = (h: number) => new Date(NOW.getTime() + h * 3_600_000);

/** An unclaimed order of the pool, with the facts the filters read. */
const order = (
  name: string,
  confirmationStatus: string,
  attempts: Row[] = [],
  over: Row = {}
): Row => ({
  name,
  ...scope,
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
const attempt = (result: string, createdAt: Date) => ({ createdAt, result, employeeId: 'sara' });

/**
 * One pool with every kind of order the three parts and the exclusions are about. Each row says, in `EXPECTED`, which part it is in
 * for the mode OFF and for the mode ON — written by hand, beside the facts, not derived from the filters.
 */
const ROWS: Row[] = [
  order('new-1', 'NEW'),
  order('new-2', 'IN_PROGRESS'),
  // Rung on Sunday morning: its three working hours were over by Sunday afternoon. Back in the pool in both modes.
  order('returned-old-no-answer', 'NO_ANSWER', [attempt('NO_ANSWER', t(1, 10))]),
  // Rung twenty minutes ago: the mode holds it for three working hours; with the mode off nothing does.
  order('returned-just-now', 'NO_ANSWER', [attempt('NO_ANSWER', t(2, 11, 40))]),
  // A follow-up whose customer was reached: rung before, ready again in both modes.
  order('returned-follow-up', 'FOLLOW_UP_REQUIRED', [attempt('ANSWERED', t(1, 14))]),
  // A promise whose date came an hour ago.
  order('due-an-hour-ago', 'POSTPONED', [attempt('ANSWERED', t(1, 12))], { postponedUntil: hoursFromNow(-1), nextFollowUpAt: hoursFromNow(-1) }),
  // A promise for tomorrow: inside the old two-day lead (due with the mode off), not yet due with the mode on (no lead).
  order('due-tomorrow', 'POSTPONED', [attempt('ANSWERED', t(1, 12))], { postponedUntil: hoursFromNow(24), nextFollowUpAt: hoursFromNow(24) }),
  // A promise for next week: in neither part, in either mode.
  order('later', 'POSTPONED', [attempt('ANSWERED', t(1, 12))], { postponedUntil: hoursFromNow(5 * 24), nextFollowUpAt: hoursFromNow(5 * 24) }),
  // Not in the pool at all.
  order('claimed', 'NEW', [], { claimedById: 'someone' }),
  order('shipped', 'NEW', [], { shippingStatus: 'READY_FOR_PICKUP' }),
  order('confirmed', 'CONFIRMED', [attempt('ANSWERED', t(1, 12))]),
  // Held for a colleague who worked the customer (two hours ago): hers, not Sara's. A hold is only ever on a NEW order that nobody
  // has ever claimed (`notHeldForOthersWhere`: any claim in its history lets it go), so this one has no history.
  order('held-for-noor', 'NEW', [], { assignedToId: 'noor', assignedAt: hoursFromNow(-2), assignee: { status: 'ACTIVE' }, claimHistory: [] }),
];

type Part = 'fresh' | 'returned' | 'due' | null;
/** name → [mode OFF, mode ON], for SOMEBODY WHO SEES THE WHOLE POOL (a supervisor). */
const EXPECTED: Record<string, [Part, Part]> = {
  'new-1': ['fresh', 'fresh'],
  'new-2': ['fresh', 'fresh'],
  'returned-old-no-answer': ['returned', 'returned'],
  'returned-just-now': ['returned', null],
  'returned-follow-up': ['returned', 'returned'],
  'due-an-hour-ago': ['due', 'due'],
  'due-tomorrow': ['due', null],
  later: [null, null],
  claimed: [null, null],
  shipped: [null, null],
  confirmed: [null, null],
  'held-for-noor': ['fresh', 'fresh'],
};
const tally = (mode: 0 | 1, skip: string[] = []) => {
  const out = { fresh: 0, returned: 0, due: 0 };
  for (const [name, parts] of Object.entries(EXPECTED)) {
    const part = parts[mode];
    if (part && !skip.includes(name)) out[part]++;
  }
  return out;
};

/** A database that answers `count` from the filter's text over `ROWS`, and remembers every filter it was asked. */
const dbOver = (rows: Row[], seen: Row[] = []) =>
  ({ order: { count: async ({ where }: { where: Row }) => (seen.push(where), rows.filter((r) => matches(r, where)).length) } }) as never;

const MODE_ON = returnsMode(NOW, clock, RETURNS_MODE.idleBusinessMinutes);

describe('the parts are what the filters say, mode by mode and asker by asker', () => {
  it.each([
    ['the mode OFF, a supervisor (the whole pool)', undefined, null, tally(0)],
    ['the mode OFF, Sara (what the colleague holds is not hers)', 'sara', null, tally(0, ['held-for-noor'])],
    ['the mode ON, a supervisor', undefined, MODE_ON, tally(1)],
    ['the mode ON, Sara', 'sara', MODE_ON, tally(1, ['held-for-noor'])],
  ] as const)('%s', async (_name, forUserId, mode, expected) => {
    expect(await waitingBreakdown(dbOver(ROWS), scope, NOW, forUserId, mode)).toEqual(expected);
  });

  it('and the fixture is not vacuous: the two modes and the two askers really do give different pools', () => {
    expect(tally(0)).toEqual({ fresh: 3, returned: 3, due: 2 });
    expect(tally(1)).toEqual({ fresh: 3, returned: 2, due: 1 });
    expect(tally(0, ['held-for-noor'])).toEqual({ fresh: 2, returned: 3, due: 2 });
  });
});

describe('the parts add up to the number the header chip and the old counter give', () => {
  it.each([
    ['the mode OFF, a supervisor', undefined, null],
    ['the mode OFF, Sara', 'sara', null],
    ['the mode ON, a supervisor', undefined, MODE_ON],
    ['the mode ON, Sara', 'sara', MODE_ON],
  ] as const)('%s: fresh + returned + due = waitingCount', async (_name, forUserId, mode) => {
    const parts = await waitingBreakdown(dbOver(ROWS), scope, NOW, forUserId, mode);
    const whole = await waitingCount(dbOver(ROWS), scope, NOW, forUserId, mode);
    expect(parts.fresh + parts.returned + parts.due).toBe(whole);
    expect(whole).toBeGreaterThan(0);
  });
});

describe('the parts are a partition of what the pull can hand out', () => {
  it.each([
    ['the mode OFF', null],
    ['the mode ON', MODE_ON],
  ] as const)('%s: no order is in two parts, and an order the pull cannot hand out is in none', async (_name, mode) => {
    const seen: Row[] = [];
    await waitingBreakdown(dbOver(ROWS, seen), scope, NOW, 'sara', mode);
    expect(seen, 'three questions: due, fresh, returned').toHaveLength(3);
    const handedOut = (row: Row) => matches(row, readyToPullWhere(scope, 'sara', NOW, mode)) || matches(row, duePostponedWhere(scope, NOW, mode));
    for (const row of ROWS) {
      const inParts = seen.filter((where) => matches(row, where)).length;
      expect(inParts, `${row.name} is counted ${inParts} times`).toBeLessThanOrEqual(1);
      expect(inParts === 1, `${row.name}: in a part ⇔ the pull can hand it out`).toBe(handedOut(row));
    }
  });

  it('«fresh» is exactly an order with no attempt at all, and «returned» an order with at least one', async () => {
    const seen: Row[] = [];
    await waitingBreakdown(dbOver(ROWS, seen), scope, NOW, undefined, null);
    const [due, fresh, returned] = seen;
    for (const row of ROWS) {
      if (matches(row, fresh)) expect(row.contactAttempts, `${row.name} is «fresh» and has attempts`).toHaveLength(0);
      if (matches(row, returned)) expect(row.contactAttempts.length, `${row.name} is «returned» and has none`).toBeGreaterThan(0);
      if (matches(row, due)) expect(row.confirmationStatus).toBe('POSTPONED');
    }
  });
});

describe('the figure of the owner’s screenshot (422) can be read in parts without losing an order', () => {
  it('a pool of 5 new and 417 returned is said as «5 جديد · 417 راجع», and the sum is 422', async () => {
    const pool = [
      ...Array.from({ length: 5 }, (_, i) => order(`n${i}`, 'NEW')),
      ...Array.from({ length: 417 }, (_, i) => order(`r${i}`, 'NO_ANSWER', [attempt('NO_ANSWER', t(1, 10))])),
    ];
    const parts = await waitingBreakdown(dbOver(pool), scope, NOW, 'sara', MODE_ON);
    expect(parts).toEqual({ fresh: 5, returned: 417, due: 0 });
    expect(parts.fresh + parts.returned + parts.due).toBe(422);
  });
});
