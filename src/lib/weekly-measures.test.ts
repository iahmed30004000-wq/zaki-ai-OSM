import { describe, expect, it } from 'vitest';
import { FLOW_MIN_EVENTS, type ClaimLine } from './held-flow';
import {
  WEEKLY_TARGETS,
  lastWorkingDayStart,
  tallyWeekly,
  weekKeyOf,
  weeklyChecks,
  weeklyTiles,
  weeklyWindow,
  weeklyWindowWords,
  type WeeklyFigures,
  type WeeklyInput,
} from './weekly-measures';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «القياس كل أسبوع» — EACH OF THE SIX FIGURES AGAINST A HAND COUNT, EACH WITH THE CASE THAT MUST NOT COUNT.
 *
 * Jordan's calendar: Sunday to Thursday, 09:00–17:00, Friday and Saturday off, Asia/Amman (UTC+3). November 2026: the 18th is a
 * Wednesday, so «this week» is Wednesday the 11th to Tuesday the 17th, and the 13th and 14th are the rest days inside it.
 * The targets are read from `WEEKLY_TARGETS` — no measured figure of the business is written here.
 * ═══════════════════════════════════════════════════════════════════════
 */

const CAL = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' };
/** A local wall-clock moment in Amman, November 2026. */
const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 10, day, hour - 3, minute));
const NOW = at(18, 10);
const W = weeklyWindow(NOW, CAL.timezone);

const empty = (over: Partial<WeeklyInput> = {}): WeeklyInput => ({
  window: W,
  calendar: CAL,
  created: [],
  firstCalls: new Map(),
  callLines: [],
  notReachedBefore: new Set(),
  closedByRule: new Set(),
  decisions: [],
  firstNotReachedAt: new Map(),
  claims: [],
  attempts: [],
  confirmedOrders: [],
  fifth: { reached: 0, base: 0 },
  truncated: false,
  ...over,
});
const made = (id: string, createdAt: Date, o: { confirmed?: boolean; duplicateMarked?: boolean; rejectionReason?: string | null } = {}) => ({
  id,
  createdAt,
  confirmed: o.confirmed ?? false,
  duplicateMarked: o.duplicateMarked ?? false,
  rejectionReason: o.rejectionReason ?? null,
});

describe('the window — seven complete local days, yesterday back', () => {
  it('this week is the 11th to the 17th; the week before is the 4th to the 10th; the edges are local midnights', () => {
    expect([W.fromDay, W.toDay]).toEqual(['2026-11-11', '2026-11-17']);
    expect(W.start.toISOString()).toBe('2026-11-10T21:00:00.000Z');
    expect(W.end.toISOString()).toBe('2026-11-17T21:00:00.000Z');
    const last = weeklyWindow(NOW, CAL.timezone, 'last');
    expect([last.fromDay, last.toDay]).toEqual(['2026-11-04', '2026-11-10']);
    expect(last.end.getTime()).toBe(W.start.getTime());
    expect(weeklyWindowWords(W)).toBe('آخر 7 أيام: من 2026-11-11 لـ 2026-11-17');
    expect(weeklyWindowWords(last)).toBe('الأسبوع اللي قبلو: من 2026-11-04 لـ 2026-11-10');
  });

  it('NEGATIVE: half an hour after local midnight is already the next day in Amman, though UTC still says the day before', () => {
    const justAfter = new Date(Date.UTC(2026, 10, 17, 21, 30)); // 00:30 on the 18th in Amman, 21:30 on the 17th in UTC
    expect(weeklyWindow(justAfter, CAL.timezone).toDay).toBe('2026-11-17');
    const justBefore = new Date(Date.UTC(2026, 10, 17, 20, 30)); // 23:30 on the 17th in Amman
    expect(weeklyWindow(justBefore, CAL.timezone).toDay).toBe('2026-11-16');
  });

  it('only «last» asks for the week before', () => {
    expect(weekKeyOf('last')).toBe('last');
    for (const raw of [null, undefined, '', 'this', 'LAST', 'x']) expect(weekKeyOf(raw)).toBe('this');
  });

  it('the last working day: the 17th (a Tuesday); a window ending on a Saturday ends its working days on the Thursday', () => {
    expect(lastWorkingDayStart(W, CAL).getTime()).toBe(at(17, 0).getTime());
    const endsSaturday = weeklyWindow(at(15, 10), CAL.timezone); // the 8th … the 14th
    expect(endsSaturday.toDay).toBe('2026-11-14');
    expect(lastWorkingDayStart(endsSaturday, CAL).getTime()).toBe(at(12, 0).getTime());
  });
});

describe('1 · «سرعة أول اتصال» — the median in WORKING minutes', () => {
  it('across midnight, over a weekend, and with no call yet', () => {
    const f = tallyWeekly(
      empty({
        created: [made('a', at(16, 16, 50)), made('b', at(12, 16, 55)), made('c', at(17, 9)), made('d', at(17, 10))],
        firstCalls: new Map([
          ['a', at(17, 9, 10)], // Monday 16:50 → Tuesday 09:10: 10 + 10 = 20 working minutes, not 16 hours
          ['b', at(15, 9, 5)], // Thursday 16:55 → Sunday 09:05: 5 + 5 = 10, the Friday and the Saturday not counted
          ['c', at(17, 9, 30)], // 30
        ]),
      })
    );
    expect(f.firstCall).toEqual({ medianMinutes: 20, base: 3, noCallYet: 1 });
  });

  it('NEGATIVE: an order with no call is counted apart, never as a zero in the median', () => {
    const f = tallyWeekly(empty({ created: [made('a', at(16, 9)), made('b', at(16, 9))], firstCalls: new Map([['a', at(16, 10)]]) }));
    expect(f.firstCall).toEqual({ medianMinutes: 60, base: 1, noCallYet: 1 });
  });
});

describe('2 · «التأكيد من الطلبات الفريدة»', () => {
  it('confirmed ÷ created, without the duplicate-marked and the rejected-as-duplicate', () => {
    const f = tallyWeekly(
      empty({
        created: [
          made('a', at(16, 9), { confirmed: true }),
          made('b', at(16, 9), { confirmed: false }),
          made('c', at(16, 9), { confirmed: true, duplicateMarked: true }), // NEGATIVE: marked at intake — out of both sides
          made('d', at(16, 9), { rejectionReason: 'DUPLICATE_ORDER' }), // NEGATIVE: rejected as a duplicate — out of the base
          made('e', at(16, 9), { rejectionReason: 'WRONG_NUMBER' }), // a refusal of another kind stays in the base
        ],
      })
    );
    expect(f.uniqueConfirmed).toEqual({ confirmed: 1, base: 3, duplicates: 2, rate: 33 });
  });
});

describe('3 · «لا يرد اللي انعاد عليه»', () => {
  it('called again later, or closed by the five-attempt rule; the last working day is outside the base', () => {
    const f = tallyWeekly(
      empty({
        callLines: [
          { orderId: 'a', at: at(15, 10), reached: false },
          { orderId: 'a', at: at(16, 11), reached: true }, // a: called again → retried
          { orderId: 'b', at: at(15, 10), reached: false }, // b: never called again → not
          { orderId: 'c', at: at(16, 12), reached: false }, // c: closed by the rule → retried
          { orderId: 'd', at: at(17, 9), reached: false }, // d: NEGATIVE — on the window's last working day: outside the base
          { orderId: 'e', at: at(12, 10), reached: false },
          { orderId: 'e', at: at(17, 10), reached: false }, // e: its base line (Thursday) was called again on the last day → retried
        ],
        closedByRule: new Set(['c']),
      })
    );
    expect(f.retried).toEqual({ retried: 3, base: 4, rate: 75 });
  });

  it('NEGATIVE: a later call AFTER the window does not count — the window is the question', () => {
    const f = tallyWeekly(
      empty({ callLines: [{ orderId: 'a', at: at(15, 10), reached: false }, { orderId: 'a', at: at(18, 9), reached: true }] })
    );
    expect(f.retried).toEqual({ retried: 0, base: 1, rate: 0 });
  });
});

describe('4 · «المتأخر: اللي خلص ناقص اللي دخل»', () => {
  it('entered: the first miss falls in the window; finished: a decision after a miss, an order decided twice counted once', () => {
    const f = tallyWeekly(
      empty({
        callLines: [
          { orderId: 'a', at: at(15, 10), reached: false }, // entered
          { orderId: 'b', at: at(15, 10), reached: false }, // NEGATIVE: missed before the window too — not entered
          { orderId: 'c', at: at(15, 10), reached: true }, // NEGATIVE: reached, not a miss
          { orderId: 'd', at: at(16, 10), reached: false }, // entered
        ],
        notReachedBefore: new Set(['b']),
        decisions: [
          { orderId: 'x', to: 'CONFIRMED', at: at(15, 12) },
          { orderId: 'x', to: 'CONFIRMED', at: at(16, 12) }, // NEGATIVE: confirmed twice — one decision
          { orderId: 'y', to: 'REJECTED', at: at(16, 12) },
          { orderId: 'z', to: 'CONFIRMED', at: at(16, 12) }, // NEGATIVE: never missed — not finished
          { orderId: 'w', to: 'CONFIRMED', at: at(16, 12) }, // NEGATIVE: its first miss came after the decision
        ],
        firstNotReachedAt: new Map([
          ['x', at(10, 10)],
          ['y', at(15, 10)],
          ['w', at(16, 13)],
        ]),
      })
    );
    expect(f.backlog).toEqual({ entered: 2, finished: 2, net: 0 });
  });
});

describe('5 · «سحبات رجعت بلا اتصال»', () => {
  const claim = (orderId: string, userId: string, action: string, reason: string | null, when: Date): ClaimLine => ({ orderId, userId, action, reason, at: when });

  it('released with no attempt by the puller between the claim and the release', () => {
    const f = tallyWeekly(
      empty({
        claims: [
          claim('a', 'u1', 'CLAIMED', 'PULL_NEXT', at(15, 10)),
          claim('a', 'u1', 'RELEASED', 'AUTO_RELEASE_IDLE', at(15, 11)), // a: no attempt → silent
          claim('b', 'u1', 'CLAIMED', 'PULL_NEXT', at(15, 10)),
          claim('b', 'u1', 'RELEASED', 'NO_ANSWER_RETURNED', at(15, 11)), // b: NEGATIVE — her own attempt came first → not silent
          claim('c', 'u2', 'CLAIMED', 'PULL_NEXT', at(15, 10)),
          claim('c', 'u2', 'RELEASED', null, at(15, 11)), // c: only SOMEBODY ELSE tried → silent
          claim('d', 'u1', 'CLAIMED', 'PULL_NEXT', at(15, 10)), // d: still held — in the base, not released
          claim('e', 'u1', 'CLAIMED', 'CUSTOMER_CALLED_BACK', at(15, 10)), // NEGATIVE: not a pull — outside the base
          claim('e', 'u1', 'RELEASED', null, at(15, 11)),
        ],
        attempts: [
          { orderId: 'b', userId: 'u1', at: at(15, 10, 5) },
          { orderId: 'c', userId: 'u9', at: at(15, 10, 5) },
          { orderId: 'a', userId: 'u1', at: at(15, 12) }, // after the release: not between
        ],
      })
    );
    expect(f.silentPulls).toEqual({ silent: 2, base: 4, rate: 50 });
  });
});

describe('6 · «تسليم المؤكَّد»', () => {
  it('delivered of those that ended; the ones still on the road are counted apart, outside the base', () => {
    const f = tallyWeekly(
      empty({
        confirmedOrders: [
          { id: 'a', shippingStatus: 'DELIVERED', confirmationStatus: 'CONFIRMED' },
          { id: 'b', shippingStatus: 'PARTIALLY_DELIVERED', confirmationStatus: 'CONFIRMED' },
          { id: 'c', shippingStatus: 'RETURNED', confirmationStatus: 'CONFIRMED' },
          { id: 'd', shippingStatus: 'NOT_READY', confirmationStatus: 'CANCELLED' }, // refused after the yes: ended, not delivered
          { id: 'e', shippingStatus: 'SHIPPED', confirmationStatus: 'CONFIRMED' }, // NEGATIVE: on the road — not a «not delivered»
          { id: 'f', shippingStatus: 'OUT_FOR_DELIVERY', confirmationStatus: 'CONFIRMED' },
        ],
      })
    );
    expect(f.delivered).toEqual({ delivered: 2, base: 4, onTheRoad: 2, rate: 50 });
  });
});

const figuresOf = (over: Partial<WeeklyFigures> = {}): WeeklyFigures => ({ ...tallyWeekly(empty()), ...over });

describe('the tiles — what the screen prints', () => {
  it('a zero base is «—» with no tone, never «0%» and never «ماشي»', () => {
    const tiles = weeklyTiles(figuresOf());
    expect(tiles.map((t) => t.key)).toEqual(['firstCall', 'uniqueConfirmed', 'retried', 'backlog', 'silentPulls', 'delivered']);
    for (const t of tiles.filter((x) => x.key !== 'backlog')) {
      expect(t.value, t.key).toBe('—');
      expect(t.tone, t.key).toBeNull();
      expect(t.toneWords, t.key).toBeNull();
    }
    expect(tiles.find((t) => t.key === 'backlog')!.value).toBe('0');
  });

  it('every tile says its target, from WEEKLY_TARGETS, and how it was counted', () => {
    const tiles = weeklyTiles(figuresOf());
    const T = WEEKLY_TARGETS;
    expect(tiles.map((t) => t.target)).toEqual([
      `الهدف: ${T.firstCallMinutes} دقيقة عمل أو أقل`,
      `الهدف: ${T.uniqueConfirmedPercent}% أو أكتر`,
      `الهدف: ${T.retriedPercent}% أو أكتر`,
      'الهدف: صفر أو أكتر',
      `الهدف: أقل من ${T.silentPullsPercent}%`,
      `الهدف: ${T.deliveredPercent}% أو أكتر`,
    ]);
    for (const t of tiles) expect(t.definition.length, t.key).toBeGreaterThan(30);
  });

  it('the tone is read from the target only, at the exact boundary', () => {
    const tone = (over: Partial<WeeklyFigures>, key: string) => weeklyTiles(figuresOf(over)).find((t) => t.key === key)!;
    const U = WEEKLY_TARGETS.uniqueConfirmedPercent;
    expect(tone({ uniqueConfirmed: { confirmed: U, base: 100, duplicates: 0, rate: U } }, 'uniqueConfirmed').toneWords).toBe('ماشي');
    expect(tone({ uniqueConfirmed: { confirmed: U - 1, base: 100, duplicates: 0, rate: U - 1 } }, 'uniqueConfirmed').toneWords).toBe('انتباه');
    const S = WEEKLY_TARGETS.silentPullsPercent;
    expect(tone({ silentPulls: { silent: S - 1, base: 100, rate: S - 1 } }, 'silentPulls').tone).toBe('OK');
    expect(tone({ silentPulls: { silent: S, base: 100, rate: S } }, 'silentPulls').tone).toBe('WATCH');
    const M = WEEKLY_TARGETS.firstCallMinutes;
    expect(tone({ firstCall: { medianMinutes: M, base: 1, noCallYet: 0 } }, 'firstCall').tone).toBe('OK');
    expect(tone({ firstCall: { medianMinutes: M + 1, base: 1, noCallYet: 0 } }, 'firstCall').tone).toBe('WATCH');
    expect(tone({ backlog: { entered: 3, finished: 2, net: -1 } }, 'backlog')).toMatchObject({ value: '-1', tone: 'WATCH' });
    expect(tone({ backlog: { entered: 2, finished: 3, net: 1 } }, 'backlog')).toMatchObject({ value: '+1', tone: 'OK' });
  });

  it('every percentage beside «X من Y», and what is counted apart is said', () => {
    const tiles = weeklyTiles(
      figuresOf({
        delivered: { delivered: 9, base: 10, onTheRoad: 4, rate: 90 },
        firstCall: { medianMinutes: 7, base: 12, noCallYet: 3 },
      })
    );
    const d = tiles.find((t) => t.key === 'delivered')!;
    expect([d.value, d.counts, d.apart]).toEqual(['90%', '9 من 10', 'لسا بالطريق: 4']);
    expect(tiles.find((t) => t.key === 'firstCall')!.apart).toBe('لسا بلا اتصال: 3');
  });
});

describe('the two checks — sentences, never a decision', () => {
  it('a base under FLOW_MIN_EVENTS says «العيّنة صغيرة» instead of a verdict', () => {
    const f = figuresOf({ checks: { fifth: { reached: 5, base: FLOW_MIN_EVENTS - 1, rate: 17 }, onTheLine: { part: 9, base: FLOW_MIN_EVENTS - 1, rate: 31 } } });
    const [fifth, line] = weeklyChecks(f);
    expect(fifth.verdict).toBe('SMALL');
    expect(line.verdict).toBe('SMALL');
    expect(fifth.sentence).toBe(`نسبة الرد بالمحاولة الخامسة 17% (من ${FLOW_MIN_EVENTS - 1}) — العيّنة صغيرة — لسا بكّير نحكم.`);
    expect(line.sentence).toContain(`دخول من «الزبون على الخط»: 9 من ${FLOW_MIN_EVENTS - 1} (31%)`);
  });

  it('against the rule values, at the boundary', () => {
    const F = WEEKLY_TARGETS.fifthAnswerPercent;
    const L = WEEKLY_TARGETS.onTheLinePercent;
    const verdicts = (fifthReached: number, linePart: number) =>
      weeklyChecks(figuresOf({ checks: { fifth: { reached: fifthReached, base: 100, rate: fifthReached }, onTheLine: { part: linePart, base: 100, rate: linePart } } })).map((c) => c.verdict);
    expect(verdicts(F, L)).toEqual(['ABOVE', 'BELOW']);
    expect(verdicts(F - 1, L + 1)).toEqual(['BELOW', 'ABOVE']);
  });

  it('a zero base is «—»', () => {
    expect(weeklyChecks(figuresOf())[0].sentence).toContain('الخامسة — (من 0)');
    expect(weeklyChecks(figuresOf())[1].sentence).toContain('0 من 0 (—)');
  });
});

describe('the second check reads what ENTERED the hands — the `held-flow.ts` sum', () => {
  it('a take from a colleague is a hand-over, not an entry', () => {
    const c = (action: string, reason: string | null): ClaimLine => ({ orderId: 'o', userId: 'u', action, reason, at: at(15, 10) });
    const f = tallyWeekly(
      empty({
        claims: [
          c('CLAIMED', 'PULL_NEXT'),
          c('CLAIMED', 'PULL_NEXT'),
          c('CLAIMED', 'MANUAL_ENTRY'),
          c('CLAIMED', 'CUSTOMER_CALLED_BACK'), // from the pool: entered
          c('CLAIMED', 'CUSTOMER_CALLED_BACK'), // from a colleague …
          c('RELEASED', 'TAKEN_ON_THE_LINE'), // … whose side is this line: NEGATIVE — no entry
        ],
      })
    );
    expect(f.checks.onTheLine).toEqual({ part: 1, base: 4, rate: 25 });
  });
});

describe('the sources keep their promises', () => {
  it('no database, no clock, no framework in the arithmetic', async () => {
    const { readFileSync } = await import('node:fs');
    const { stripComments } = await import('./guard-source');
    const src = stripComments(readFileSync('src/lib/weekly-measures.ts', 'utf8'));
    expect(src).not.toMatch(/from '\.\/db'|from '@\/lib\/db'|new Date\(\)|Date\.now\(\)|from 'next|from 'react/);
  });
});
