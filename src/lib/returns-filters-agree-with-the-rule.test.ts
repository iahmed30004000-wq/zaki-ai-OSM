import { describe, expect, it } from 'vitest';
import { NO_ANSWER_RESULTS } from './confirmation-workflow';
import { zonedTimeToInstant } from './business-calendar';
import { ROUND_GAP_BUSINESS_MINUTES, workClock } from './no-answer-rounds';
import { returnsMode } from './no-answer-returns';
import { RETURNS_MODE, duePostponedWhere, postponedNotDueCount, readyToPullWhere } from './confirmation-queue';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE FILTERS ARE THE RULE — AND THE RULE IS WRITTEN HERE A SECOND TIME, THE OTHER WAY ROUND.
 *
 * «ready» reaches the database as two clauses (`returnsReadyAnd`): no «لا يرد» newer than a cut that walks BACK three working hours
 * from now, and no date still ahead. The oracle below never walks back: it asks, of each press, WHEN it becomes three working hours
 * old (`clock.forward`) and compares that with now. Two ways of counting the same hours must agree on every press, every result, every
 * date and every moment — Friday, the evening and the 17:00 → 09:00 boundary included — or one of them is wrong.
 *
 * And the pool is PARTITIONED: an unclaimed order at the desk is exactly one of — the pull can hand it out (a promise whose date
 * arrived, or a ready order), a date holds it («مؤجَّلة حتى موعدها»), or a «لا يرد» not yet three working hours old holds it. Nothing
 * is counted twice and nothing falls between them: the number the queue shows is what the pull can give.
 *
 * Evaluated by a small SQL-shaped evaluator (three values: true · false · unknown; a `WHERE` keeps only true), as the in-memory
 * databases of the pull’s own tests do — the answer comes from the filter’s text.
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

/** Moments that matter: mid-day, the opening bell, the closing bell, a Friday, a Saturday, a Sunday morning after the weekend. */
const MOMENTS = [t(2, 12), t(2, 9), t(2, 17), t(3, 10, 30), t(5, 16, 59), t(6, 12), t(8, 9, 30)];
/**
 * Presses every half hour from Thursday morning to Monday afternoon (two evenings, a night and a weekend inside), and — for each
 * moment — the exact cut and the millisecond either side of it: the boundary is where two ways of counting would part.
 */
const PRESSES: Date[] = [];
for (let at = t(5, 8).getTime(); at <= t(9, 14).getTime(); at += 30 * 60_000) PRESSES.push(new Date(at));
for (const now of MOMENTS) {
  const cut = returnsMode(now, clock, 30).readyCut.getTime();
  PRESSES.push(new Date(cut - 1), new Date(cut), new Date(cut + 1));
}
const RESULTS = ['NO_ANSWER', 'BUSY', 'UNREACHABLE', 'OPENED', 'MESSAGE_SENT', 'ANSWERED', 'WRONG_NUMBER'];
const STATUSES = ['NEW', 'FOLLOW_UP_REQUIRED', 'POSTPONED'];

/** An unclaimed order of the pool, with the facts the rule reads. */
const poolOrder = (confirmationStatus: string, attempts: Row[], postponedUntil: Date | null, nextFollowUpAt: Date | null): Row => ({
  ...scope, claimedById: null, shippingStatus: 'NOT_READY', confirmationStatus,
  postponedUntil, nextFollowUpAt, assignedToId: null, assignedAt: null, assignee: null, claimHistory: [{ action: 'RELEASED' }],
  contactAttempts: attempts,
});

/** THE ORACLE: a press is three working hours old from `forward(press)`; a date is ahead while it is after now. */
function oracle(row: Row, now: Date) {
  const dateAhead = [row.postponedUntil, row.nextFollowUpAt].some((d: Date | null) => d !== null && d.getTime() > now.getTime());
  const hoursAhead = row.contactAttempts.some(
    (a: Row) => (NO_ANSWER_RESULTS as readonly string[]).includes(a.result) && clock.forward(a.createdAt, ROUND_GAP_BUSINESS_MINUTES).getTime() > now.getTime()
  );
  const hasDate = row.postponedUntil !== null || row.nextFollowUpAt !== null;
  const postponed = row.confirmationStatus === 'POSTPONED';
  return {
    // Handed out by the pull: a postponed order that has a date (arrived) · any other open order — and no hours left to wait.
    pullable: !dateAhead && !hoursAhead && (postponed ? hasDate : true),
    // Held by a date: any date ahead, or a postponed order that has none (it is not takeable, and is said, not lost).
    dateWait: dateAhead || (postponed && !hasDate),
    // Held by a «لا يرد» only: every date has arrived and the order is takeable but for its three hours.
    hoursWait: !dateAhead && hoursAhead && (postponed ? hasDate : true),
  };
}

/** The where the «waiting on a date» counter asks the database — captured, not run. */
async function dateWaitWhere(now: Date, mode: ReturnType<typeof returnsMode>): Promise<Row> {
  let seen: Row = {};
  await postponedNotDueCount({ order: { count: async ({ where }: { where: Row }) => ((seen = where), 0) } } as never, scope, now, mode);
  return seen;
}

describe('the filters and the oracle agree on every press, result, date and moment', () => {
  it('ready (an open status but postponed), due (a postponed promise), and «waiting on a date» — one verdict each, the same as the oracle’s', async () => {
    const failures: string[] = [];
    let compared = 0;
    for (const now of MOMENTS) {
      const mode = returnsMode(now, clock, RETURNS_MODE.idleBusinessMinutes);
      const ready = readyToPullWhere(scope, 'sara', now, mode);
      const due = duePostponedWhere(scope, now, mode);
      const waitsOnADate = await dateWaitWhere(now, mode);
      // A date long past, a date still ahead, none. (A date exactly AT now has its own test below.)
      const dates = [null, new Date(now.getTime() - 3_600_000), new Date(now.getTime() + 3_600_000)];
      for (const status of STATUSES) {
        for (const result of RESULTS) {
          for (const press of PRESSES) {
            for (const postponedUntil of dates) {
              for (const nextFollowUpAt of dates) {
                const row = poolOrder(status, [{ createdAt: press, result, employeeId: 'sara' }], postponedUntil, nextFollowUpAt);
                const verdict = oracle(row, now);
                const handedOut = status === 'POSTPONED' ? matches(row, due) : matches(row, ready);
                const dateWait = matches(row, waitsOnADate);
                const overlap = status === 'POSTPONED' ? matches(row, ready) : matches(row, due);
                const parts = [verdict.pullable, verdict.dateWait, verdict.hoursWait].filter(Boolean).length;
                if (handedOut !== verdict.pullable || dateWait !== verdict.dateWait || overlap || parts !== 1) {
                  failures.push(JSON.stringify({ now, status, result, press, postponedUntil, nextFollowUpAt, handedOut, dateWait, overlap, verdict }));
                }
                compared++;
              }
            }
          }
        }
      }
    }
    expect(failures.slice(0, 3)).toEqual([]);
    // Seven moments × three statuses × seven results × some two hundred presses × nine date pairs: the grid is real, not a handful.
    expect(compared).toBeGreaterThan(200_000);
  }, 120_000);

  it('a date exactly AT now has arrived: the order is takeable (and a postponed one is due), to the millisecond', () => {
    const now = t(2, 12);
    const mode = returnsMode(now, clock, RETURNS_MODE.idleBusinessMinutes);
    const at = (ms: number) => new Date(now.getTime() + ms);
    expect(matches(poolOrder('NEW', [], now, null), readyToPullWhere(scope, 'sara', now, mode))).toBe(true);
    expect(matches(poolOrder('NEW', [], null, now), readyToPullWhere(scope, 'sara', now, mode))).toBe(true);
    expect(matches(poolOrder('NEW', [], at(1), null), readyToPullWhere(scope, 'sara', now, mode))).toBe(false);
    expect(matches(poolOrder('POSTPONED', [], now, now), duePostponedWhere(scope, now, mode))).toBe(true);
    expect(matches(poolOrder('POSTPONED', [], at(1), at(1)), duePostponedWhere(scope, now, mode))).toBe(false);
  });

  it('an order with no attempt at all is ready at every moment (a new order), and its dates still hold it', () => {
    for (const now of MOMENTS) {
      const mode = returnsMode(now, clock, RETURNS_MODE.idleBusinessMinutes);
      const ready = readyToPullWhere(scope, 'sara', now, mode);
      expect(matches(poolOrder('NEW', [], null, null), ready)).toBe(true);
      expect(matches(poolOrder('NEW', [], new Date(now.getTime() + 1), null), ready)).toBe(false);
    }
  });

  it('several attempts: one fresh «لا يرد» among old ones holds the order; a fresh «اتصل» among old «لا يرد» does not', () => {
    const now = t(2, 12);
    const mode = returnsMode(now, clock, RETURNS_MODE.idleBusinessMinutes);
    const ready = readyToPullWhere(scope, 'sara', now, mode);
    const old = { createdAt: t(1, 10), result: 'NO_ANSWER', employeeId: 'sara' };
    const fresh = (result: string) => ({ createdAt: t(2, 11, 40), result, employeeId: 'sara' });
    expect(matches(poolOrder('IN_PROGRESS', [old, fresh('NO_ANSWER')], null, null), ready)).toBe(false);
    expect(matches(poolOrder('IN_PROGRESS', [old, fresh('OPENED')], null, null), ready)).toBe(true);
    expect(matches(poolOrder('IN_PROGRESS', [fresh('MESSAGE_SENT'), old], null, null), ready)).toBe(true);
  });
});

describe('with the mode off the predicates are today’s, byte for byte', () => {
  const now = t(2, 12);

  it('ready: the open list without postponed — and, for an agent, only what is not held for a colleague', () => {
    expect(readyToPullWhere(scope)).toEqual({
      ...scope, claimedById: null, confirmationStatus: { in: ['NEW', 'IN_PROGRESS', 'NO_ANSWER', 'FOLLOW_UP_REQUIRED'] }, shippingStatus: 'NOT_READY',
    });
    expect(Object.keys(readyToPullWhere(scope, 'sara', now))).toContain('AND');
    expect((readyToPullWhere(scope, 'sara', now) as { AND: unknown[] }).AND).toHaveLength(1);
    expect(readyToPullWhere(scope, 'sara', now, null)).toEqual(readyToPullWhere(scope, 'sara', now));
    expect(readyToPullWhere(scope, 'sara', now, undefined)).toEqual(readyToPullWhere(scope, 'sara', now));
  });

  it('due: the two-day lead, the postponement date first — and no clause of the mode', () => {
    const where = duePostponedWhere(scope, now) as Row;
    const lead = new Date(now.getTime() + 2 * 24 * 3_600_000);
    expect(where.OR).toEqual([{ postponedUntil: { lte: lead } }, { postponedUntil: null, nextFollowUpAt: { lte: lead } }]);
    expect(where.AND).toBeUndefined();
    expect(duePostponedWhere(scope, now, null)).toEqual(where);
  });

  it('and with the mode on, a date counts AT its day: the lead is none', () => {
    const mode = returnsMode(now, clock, RETURNS_MODE.idleBusinessMinutes);
    const where = duePostponedWhere(scope, now, mode) as Row;
    expect(where.OR).toEqual([{ postponedUntil: { lte: now } }, { postponedUntil: null, nextFollowUpAt: { lte: now } }]);
    expect(where.AND).toHaveLength(2);
  });
});
