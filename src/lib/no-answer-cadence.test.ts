import { describe, expect, it } from 'vitest';
import { zonedParts, zonedTimeToInstant } from './business-calendar';
import { NO_ANSWER_LIMIT } from './confirmation-workflow';
import {
  CADENCE_EVENING_FROM,
  CADENCE_FLOORS_MS,
  CADENCE_GAPS_MS,
  CADENCE_LIMIT,
  CADENCE_MIN_DAYS,
  CADENCE_START,
  CADENCE_WORKDAY_END,
  CADENCE_WORKDAY_START,
  CLOSED_WITHOUT_COUNT_WORDS,
  cadenceCalOf,
  cadenceCardWords,
  cadenceCloses,
  cadenceDesk,
  cadencePress,
  cadencePressWords,
  cadenceState,
  cadenceStep,
  cadenceVerdict,
  cadenceWhen,
  cadenceWorkWindow,
  closedCardWords,
  type CadenceCal,
  type CadenceState,
} from './no-answer-cadence';
import type { DueVerdict } from './work-first';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE FIVE-ATTEMPT PLAN AS ONE PURE RULE (step B of Confirmation Center v2)
 *
 *  1. #1 counts and sets #2's due at +30 min; #2 sets #3's at +2 h (both elapsed time); #3 sets #4's at the Country's workHoursStart on the first WORKING day at least 8 h (elapsed, exactly
 *     8 h counts) after it; #4 sets #5's at the first 18:00 STRICTLY after it on a working day, never less than 3 h (elapsed) after it. Working days = all but the Country's rest days
 *     (`weekendDays`; none = skip nothing).
 *  2. WORK TIME (planner, ruling 12): #2's and #3's dues fall inside [workHoursStart, workHoursEnd) on a working day — the end EXCLUSIVE, the start inclusive. A raw due (press + 30 min / + 2 h)
 *     outside it becomes the FIRST COMING workHoursStart on a working day at or after it (before the start → that day's; at/after the end or on a rest day → the next working day's); a raw
 *     due inside it is untouched, to the millisecond. #5 is NOT moved into the window (ruling 3, literal).
 *  3. `cadenceWorkWindow` is the one reader of the two hours: a missing or unreadable value falls back to 10:00 / 22:00 on its own side, and an end that is not after the start (an overnight
 *     shift, equal hours, garbage) sends BOTH ends to the constants.
 *  4. A press at the due to the millisecond counts; one millisecond before is EARLY — kept, never counted, and the state (the due) does not move.
 *  5. A line at or before the floor (`enabledAt`) never counts; a sixth press after the fifth never counts.
 *  6. Only NO_ANSWER / BUSY / UNREACHABLE are attempts; everything else neither counts nor resets. Any employee's line counts.
 *  7. The fifth counted attempt closes the order across at least two local days — and under the plan five counted attempts always span two, even on a 25-hour DST day, with or without rest
 *     days. The first-day guard (#4 is never due on #1's local day) stays as defence in depth; with #2 and #3 inside work time it can no longer fire through the steps, so it is tested on a
 *     state built by hand.
 *  8. Replaying the stored lines (`cadenceState`) equals deciding them one by one at the door (`cadencePress`), even when the clock and the attempt numbers disagree.
 *  9. The words are server-written, in Western digits, never say «جولة», and print the REAL due — «الساعة 10:00», «بكرة الساعة 10:00», «السبت الساعة 10:00» across a rest weekend; no windows.
 *
 * `no-answer-cadence-oracle.test.ts` holds the same rule a SECOND time, written the other way round.
 * ═══════════════════════════════════════════════════════════════════════
 */

const AMMAN = 'Asia/Amman';
const SINCE = new Date('2026-11-01T00:00:00.000Z');
/** Syria's row as the owner will leave it (10:00-22:00, no rest day): the hours of every calendar below unless a test says otherwise. */
const SYRIA_HOURS = { workHoursStart: '10:00', workHoursEnd: '22:00' } as const;
/** Jordan's live row: 09:00-17:00 (Friday and Saturday off). */
const JORDAN_HOURS = { workHoursStart: '09:00', workHoursEnd: '17:00' } as const;
/** A window that covers the whole local day but its last minute — for the tests that are about ELAPSED time and not about work time. */
const ALL_DAY = { workHoursStart: '00:00', workHoursEnd: '23:59' } as const;
type Hours = { workHoursStart?: string | null; workHoursEnd?: string | null };
const cal = (timeZone = AMMAN, since = SINCE, restDays?: readonly number[], hours: Hours = SYRIA_HOURS): CadenceCal => ({ since, timeZone, ...(restDays ? { restDays } : {}), ...hours });
/** Jordan's week as the live store has it: Friday and Saturday off. */
const REST_FRI_SAT = [5, 6] as const;
/** A local wall-clock instant, plus seconds and milliseconds on top (so a boundary can be hit to the millisecond). */
const local = (tz: string, y: number, mo: number, d: number, h: number, mi = 0, s = 0, ms = 0): Date =>
  new Date(zonedTimeToInstant(tz, y, mo, d, h, mi).getTime() + s * 1000 + ms);
const amman = (d: number, h: number, mi = 0, s = 0, ms = 0) => local(AMMAN, 2026, 11, d, h, mi, s, ms);
const ms = (d: Date, delta: number) => new Date(d.getTime() + delta);
const hhmm = (d: Date, tz = AMMAN) => {
  const p = zonedParts(d, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
};

/** Steps the plan through `times`, asserting each one counts. */
function chain(c: CadenceCal, times: Date[]): CadenceState {
  let s = CADENCE_START;
  for (const t of times) {
    const r = cadenceStep(s, t, c);
    expect(r.counted).toBe(true);
    s = r.next;
  }
  return s;
}
/**
 * A plan whose third attempt is pressed exactly at `t3`, reached the way an agent reaches it: the first press as late before it as the plan needs, the second exactly at its due — so that the
 * third is on time (a late press is fine, an early one is not). With #2 and #3 inside work time the dues are no longer a fixed 30 and 120 minutes apart, so the lead is searched hour by hour
 * (up to ten days, the longest a rest-day wait can take); `null` when no chain reaches `t3`.
 */
function tryUpToThird(c: CadenceCal, t3: Date): CadenceState | null {
  for (let lead = 3; lead <= 240; lead++) {
    const s1 = cadenceStep(CADENCE_START, ms(t3, -lead * 3_600_000), c);
    if (!s1.counted) continue;
    const s2 = cadenceStep(s1.next, s1.next.dueAt!, c);
    if (!s2.counted || s2.next.dueAt!.getTime() > t3.getTime()) continue;
    const s3 = cadenceStep(s2.next, t3, c);
    if (s3.counted) return s3.next;
  }
  return null;
}
function upToThird(c: CadenceCal, t3: Date): CadenceState {
  const s = tryUpToThird(c, t3);
  if (!s) throw new Error(`no on-time chain reaches a third attempt at ${t3.toISOString()}`);
  return s;
}
/** A plan whose fourth attempt is pressed exactly at `t4`, with the third as late before it as the plan needs (the smallest gap from 8 h at which the fourth is on time). */
function upToFourth(c: CadenceCal, t4: Date): CadenceState {
  for (let gap = 8; gap <= 240; gap++) {
    const s3 = tryUpToThird(c, ms(t4, -gap * 3_600_000));
    if (!s3 || s3.dueAt!.getTime() > t4.getTime()) continue;
    const s4 = cadenceStep(s3, t4, c);
    if (s4.counted) return s4.next;
  }
  throw new Error(`no on-time chain reaches a fourth attempt at ${t4.toISOString()}`);
}

describe('cadenceCalOf: the one builder of the plan’s world', () => {
  it('copies the floor, the timezone, the rest days and the work hours — and nothing else of the country', () => {
    const country = { timezone: 'Asia/Amman', weekendDays: [5, 6], workHoursStart: '09:00', workHoursEnd: '17:00', code: 'JO' };
    const built = cadenceCalOf(SINCE, country);
    expect(built).toEqual({ since: SINCE, timeZone: 'Asia/Amman', restDays: [5, 6], workHoursStart: '09:00', workHoursEnd: '17:00' });
    expect(Object.keys(built).sort()).toEqual(['restDays', 'since', 'timeZone', 'workHoursEnd', 'workHoursStart']);
  });

  it('a country without rest days or hours (null, undefined, or a mock that lacks the field) → undefined, never a made-up value; an empty list stays empty', () => {
    expect(cadenceCalOf(SINCE, { timezone: AMMAN }).restDays).toBeUndefined();
    expect(cadenceCalOf(SINCE, { timezone: AMMAN, weekendDays: null }).restDays).toBeUndefined();
    expect(cadenceCalOf(SINCE, { timezone: AMMAN, weekendDays: [] }).restDays).toEqual([]);
    expect(cadenceCalOf(SINCE, { timezone: AMMAN }).workHoursStart).toBeUndefined();
    expect(cadenceCalOf(SINCE, { timezone: AMMAN, workHoursStart: null, workHoursEnd: null }).workHoursEnd).toBeUndefined();
  });

  it('the hours it carries ARE the hours the plan uses: the same lines under 09:00 and under 10:00 give #4 an hour apart', () => {
    const lines = (c: CadenceCal) => upToThird(c, amman(3, 14)).dueAt!;
    expect(hhmm(lines(cadenceCalOf(SINCE, { timezone: AMMAN, workHoursStart: '09:00', workHoursEnd: '17:00' })))).toBe('2026-11-04 09:00');
    expect(hhmm(lines(cadenceCalOf(SINCE, { timezone: AMMAN, workHoursStart: '10:00', workHoursEnd: '22:00' })))).toBe('2026-11-04 10:00');
  });
});

describe('cadenceWorkWindow: the one reader of the Country’s two work hours', () => {
  it('a readable pair is kept (and written «HH:mm»)', () => {
    expect(cadenceWorkWindow('09:00', '17:00')).toEqual({ start: '09:00', end: '17:00' });
    expect(cadenceWorkWindow('10:00', '22:00')).toEqual({ start: '10:00', end: '22:00' });
    expect(cadenceWorkWindow('9:30', ' 18:45 ')).toEqual({ start: '09:30', end: '18:45' });
    expect(cadenceWorkWindow('00:00', '23:59')).toEqual({ start: '00:00', end: '23:59' });
  });

  it.each([
    ['both missing', undefined, undefined],
    ['both null', null, null],
    ['both empty', '', ''],
    ['both garbage', 'garbage', 'later'],
    ['not clocks (25:00 and 10:61)', '25:00', '10:61'],
    ['numbers, not text', 900, 1700],
  ])('%s → the constants 10:00 and 22:00', (_n, start, end) => {
    expect(cadenceWorkWindow(start, end)).toEqual({ start: CADENCE_WORKDAY_START, end: CADENCE_WORKDAY_END });
  });

  it('a missing or unreadable value falls back on ITS OWN side only: the other, readable one is kept when the pair is still ordered', () => {
    expect(cadenceWorkWindow(undefined, '17:00')).toEqual({ start: '10:00', end: '17:00' });
    expect(cadenceWorkWindow('garbage', '18:30')).toEqual({ start: '10:00', end: '18:30' });
    expect(cadenceWorkWindow('09:00', undefined)).toEqual({ start: '09:00', end: '22:00' });
    expect(cadenceWorkWindow('12:00', 'garbage')).toEqual({ start: '12:00', end: '22:00' });
  });

  it.each([
    ['an overnight shift 22:00 → 06:00', '22:00', '06:00'],
    ['equal hours', '10:00', '10:00'],
    ['an end before the start', '15:00', '09:30'],
    ['a readable start at or after the fallback end (23:00 and no end)', '23:00', undefined],
    ['a readable end at or before the fallback start (no start, 09:30)', undefined, '09:30'],
  ])('%s → BOTH ends fall back to 10:00 and 22:00 (a window that wraps midnight means nothing here)', (_n, start, end) => {
    expect(cadenceWorkWindow(start, end)).toEqual({ start: CADENCE_WORKDAY_START, end: CADENCE_WORKDAY_END });
  });
});

describe('the constants', () => {
  it('five attempts over two days, 30 minutes and 2 hours, the 8 h and 3 h floors, the 10:00-22:00 fallback window and #5 from 18:00 — and the switch-off limit is still 3', () => {
    expect(CADENCE_LIMIT).toBe(5);
    expect(CADENCE_MIN_DAYS).toBe(2);
    expect(CADENCE_GAPS_MS).toEqual({ afterFirst: 30 * 60_000, afterSecond: 2 * 3_600_000 });
    expect(CADENCE_FLOORS_MS).toEqual({ beforeFourth: 8 * 3_600_000, beforeFifth: 3 * 3_600_000 });
    expect(CADENCE_WORKDAY_START).toBe('10:00');
    expect(CADENCE_WORKDAY_END).toBe('22:00');
    expect(CADENCE_EVENING_FROM).toBe('18:00');
    expect(NO_ANSWER_LIMIT).toBe(3);
  });
});

describe('#1 and #2', () => {
  it('#1 always counts and sets #2’s due at exactly +30 minutes (when that is inside work time)', () => {
    const t1 = amman(3, 11, 7, 12, 345);
    const r = cadenceStep(CADENCE_START, t1, cal());
    expect(r.counted).toBe(true);
    expect(r.next.counted).toEqual([t1]);
    expect(r.next.dueAt).toEqual(ms(t1, 1_800_000));
    expect(r.next.days).toBe(1);
  });

  it('#1 counts however late after the floor', () => {
    expect(cadenceStep(CADENCE_START, amman(20, 3), cal()).counted).toBe(true);
  });

  it('+30 minutes is elapsed time, then work time: 23:50 → 00:20 is outside work, so #2 is due at the next start of work — 10:00 the next local day', () => {
    const t1 = amman(3, 23, 50);
    const due = cadenceStep(CADENCE_START, t1, cal()).next.dueAt!;
    expect(hhmm(due)).toBe('2026-11-04 10:00');
  });

  it('#2 one millisecond before its due is early: kept, not counted, the state does not move', () => {
    const t1 = amman(3, 11);
    const s1 = chain(cal(), [t1]);
    const early = cadenceStep(s1, ms(t1, 1_800_000 - 1), cal());
    expect(early.counted).toBe(false);
    expect(early.next).toBe(s1);
    expect(early.next.dueAt).toEqual(ms(t1, 1_800_000));
  });

  it('#2 exactly at its due counts (equal-to-due counts) and sets #3’s due at +2 h; one millisecond after counts too', () => {
    const t1 = amman(3, 11);
    const s1 = chain(cal(), [t1]);
    const at = cadenceStep(s1, ms(t1, 1_800_000), cal());
    expect(at.counted).toBe(true);
    expect(at.next.dueAt).toEqual(ms(t1, 1_800_000 + 7_200_000));
    expect(cadenceStep(s1, ms(t1, 1_800_001), cal()).counted).toBe(true);
  });

  it('a press at 21:50 is #1: #2 is NOT due at 22:20 (no work after 22:00) but at the next start of work, 10:00 the next day — an early press at 22:20 does not count, one at 10:00 does', () => {
    const s1 = chain(cal(), [amman(3, 21, 50)]);
    expect(s1.dueAt).toEqual(amman(4, 10));
    expect(cadenceStep(s1, amman(3, 22, 20), cal()).counted).toBe(false);
    expect(cadenceStep(s1, ms(amman(4, 10), -1), cal()).counted).toBe(false);
    expect(cadenceStep(s1, amman(4, 10), cal()).counted).toBe(true);
  });

  it('#3’s due is exactly +7 200 000 ms across a spring-forward (not 02:30 local) — on a calendar whose whole day is work time', () => {
    const NY = 'America/New_York';
    const t1 = local(NY, 2026, 3, 8, 0, 0);
    const t2 = ms(t1, 1_800_000);
    const s = chain(cal(NY, new Date('2026-01-01T00:00:00Z'), undefined, ALL_DAY), [t1, t2]);
    expect(s.dueAt).toEqual(ms(t2, 7_200_000));
  });
});

describe('#2 and #3 are due INSIDE work time (planner ruling 12): [workHoursStart, workHoursEnd) on a working day, the end exclusive', () => {
  /** A local time in Amman from a `[day, hour, minute, second, millisecond]` row of November 2026 (a function of ONE tuple: a spread of a union of rows is not a tuple to the type checker). */
  const ammanAt = (p: readonly [number, number, number, number, number]) => amman(p[0], p[1], p[2], p[3], p[4]);
  /** The due of #2 after a first press at `[d, h, mi, s, ms]`, on the calendar given (Syria’s hours 10:00-22:00 by default), Tuesday 3/11/2026 in Amman. */
  const dueOfSecond = (c: CadenceCal, p: readonly [number, number, number, number, number]) => cadenceStep(CADENCE_START, ammanAt(p), c).next.dueAt!;

  it.each([
    ['03:00 → raw 03:30 is before the start: today’s 10:00', [3, 3, 0, 0, 0], [3, 10, 0, 0, 0]],
    ['09:29:59.999 → raw 09:59:59.999 is a millisecond before the start: today’s 10:00', [3, 9, 29, 59, 999], [3, 10, 0, 0, 0]],
    ['09:30:00.000 → raw is EXACTLY the start: inside, due = the raw', [3, 9, 30, 0, 0], [3, 10, 0, 0, 0]],
    ['09:30:00.001 → raw 10:00:00.001: inside, untouched', [3, 9, 30, 0, 1], [3, 10, 0, 0, 1]],
    ['11:07:12.345 → inside, press + 30 min to the millisecond', [3, 11, 7, 12, 345], [3, 11, 37, 12, 345]],
    ['21:29:59.999 → raw 21:59:59.999: a millisecond before the end is still inside', [3, 21, 29, 59, 999], [3, 21, 59, 59, 999]],
    ['21:30:00.000 → raw is EXACTLY the end: outside (end exclusive), tomorrow’s 10:00', [3, 21, 30, 0, 0], [4, 10, 0, 0, 0]],
    ['21:30:00.001 → raw 22:00:00.001: tomorrow’s 10:00', [3, 21, 30, 0, 1], [4, 10, 0, 0, 0]],
    ['21:50 → raw 22:20: tomorrow’s 10:00', [3, 21, 50, 0, 0], [4, 10, 0, 0, 0]],
    ['23:50 → raw 00:20 the next day: that day’s 10:00', [3, 23, 50, 0, 0], [4, 10, 0, 0, 0]],
    ['00:00 → raw 00:30: today’s 10:00', [3, 0, 0, 0, 0], [3, 10, 0, 0, 0]],
  ] as const)('#2: #1 at %s', (_n, press, due) => {
    expect(dueOfSecond(cal(), press)).toEqual(ammanAt(due));
  });

  /** The due of #3 after a SECOND press pressed exactly at `[d, h, mi, s, ms]` (a late press is fine), on the same calendar. */
  const upToSecond = (c: CadenceCal, t2: Date): CadenceState => {
    for (let lead = 1; lead <= 240; lead++) {
      const s1 = cadenceStep(CADENCE_START, ms(t2, -lead * 3_600_000), c);
      if (!s1.counted || s1.next.dueAt!.getTime() > t2.getTime()) continue;
      const s2 = cadenceStep(s1.next, t2, c);
      if (s2.counted) return s2.next;
    }
    throw new Error(`no on-time chain reaches a second attempt at ${t2.toISOString()}`);
  };

  it.each([
    ['07:59:59.999 → raw 09:59:59.999: today’s 10:00', [3, 7, 59, 59, 999], [3, 10, 0, 0, 0]],
    ['08:00:00.000 → raw is EXACTLY the start: inside, due = the raw', [3, 8, 0, 0, 0], [3, 10, 0, 0, 0]],
    ['15:00 → raw 17:00: inside', [3, 15, 0, 0, 0], [3, 17, 0, 0, 0]],
    ['19:59:59.999 → raw 21:59:59.999: inside', [3, 19, 59, 59, 999], [3, 21, 59, 59, 999]],
    ['20:00:00.000 → raw is EXACTLY the end: tomorrow’s 10:00', [3, 20, 0, 0, 0], [4, 10, 0, 0, 0]],
    ['20:00:00.001 → tomorrow’s 10:00', [3, 20, 0, 0, 1], [4, 10, 0, 0, 0]],
    ['23:00 → raw 01:00 the next day: that day’s 10:00', [3, 23, 0, 0, 0], [4, 10, 0, 0, 0]],
  ] as const)('#3: #2 pressed at %s', (_n, press, due) => {
    expect(upToSecond(cal(), ammanAt(press)).dueAt).toEqual(ammanAt(due));
  });

  it('Jordan’s row (09:00-17:00): the window moves with the country — #1 at 16:29:59.999 stays inside, at 16:30 it waits for tomorrow’s 09:00', () => {
    const jordan = cal(AMMAN, SINCE, undefined, JORDAN_HOURS);
    expect(dueOfSecond(jordan, [3, 16, 29, 59, 999])).toEqual(amman(3, 16, 59, 59, 999));
    expect(dueOfSecond(jordan, [3, 16, 30, 0, 0])).toEqual(amman(4, 9));
    expect(dueOfSecond(jordan, [3, 8, 29, 59, 999])).toEqual(amman(3, 9));
    expect(dueOfSecond(jordan, [3, 8, 30, 0, 0])).toEqual(amman(3, 9));
    // 17:00 is outside Jordan’s hours, which a window of 22:00 would have called inside
    expect(dueOfSecond(jordan, [3, 17, 0, 0, 0])).toEqual(amman(4, 9));
  });

  it('a country row with no hours, or unreadable ones, is read as 10:00-22:00 — the plan does not guess a day', () => {
    for (const hours of [{}, { workHoursStart: null, workHoursEnd: null }, { workHoursStart: 'garbage', workHoursEnd: '' }, { workHoursStart: '22:00', workHoursEnd: '06:00' }] as const) {
      const c = cal(AMMAN, SINCE, undefined, hours);
      expect(dueOfSecond(c, [3, 21, 50, 0, 0])).toEqual(amman(4, 10));
      expect(dueOfSecond(c, [3, 11, 0, 0, 0])).toEqual(amman(3, 11, 30));
      expect(hhmm(upToThird(c, amman(3, 14)).dueAt!)).toBe('2026-11-04 10:00');
    }
  });

  it('the window is the country’s LOCAL clock, not UTC: the same instants read in New York and in Amman give different dues', () => {
    const NY = 'America/New_York';
    const t1 = local(NY, 2026, 11, 3, 21, 50);
    expect(cadenceStep(CADENCE_START, t1, cal(NY, new Date('2026-01-01T00:00:00Z'))).next.dueAt).toEqual(local(NY, 2026, 11, 4, 10));
  });

  it('a raw due on a spring-forward night: Berlin, #1 Saturday 28/3 21:50 → #2 is Sunday 10:00 CEST (the clock jump costs nothing)', () => {
    const BER = 'Europe/Berlin';
    expect(cadenceStep(CADENCE_START, local(BER, 2026, 3, 28, 21, 50), cal(BER, new Date('2026-01-01T00:00:00Z'))).next.dueAt).toEqual(local(BER, 2026, 3, 29, 10));
  });
});

describe('#3 → #4: the Country’s workHoursStart on the first working day at least 8 hours (elapsed) later', () => {
  it.each([
    ['08:59', [3, 8, 59, 0, 0], '2026-11-04 10:00'],
    ['09:00', [3, 9, 0, 0, 0], '2026-11-04 10:00'],
    ['14:00', [3, 14, 0, 0, 0], '2026-11-04 10:00'],
    ['23:59:59.999', [3, 23, 59, 59, 999], '2026-11-04 10:00'],
    ['00:00:00.000 (8 h to 08:00: today’s 10:00)', [3, 0, 0, 0, 0], '2026-11-03 10:00'],
    ['00:05 (today’s 10:00)', [3, 0, 5, 0, 0], '2026-11-03 10:00'],
    ['01:59:59.999 (a millisecond under 8 h to 10:00)', [3, 1, 59, 59, 999], '2026-11-03 10:00'],
    ['02:00:00.000 (EXACTLY 8 h to 10:00 counts)', [3, 2, 0, 0, 0], '2026-11-03 10:00'],
    ['02:00:00.001 (a millisecond over: tomorrow’s 10:00, 32 h)', [3, 2, 0, 0, 1], '2026-11-04 10:00'],
  ] as const)('#3 pressed at %s → %s', (_n, [d, h, mi, s, m], due) => {
    const state = upToThird(cal(), amman(d, h, mi, s, m));
    expect(hhmm(state.dueAt!)).toBe(due);
  });

  it('the 8 hours are ELAPSED time: exactly at 10:00 a press counts, one millisecond before it is early', () => {
    const s3 = upToThird(cal(), amman(3, 2, 0, 0, 0));
    expect(s3.dueAt).toEqual(amman(3, 10));
    expect(s3.dueAt!.getTime() - amman(3, 2).getTime()).toBe(CADENCE_FLOORS_MS.beforeFourth);
    expect(cadenceStep(s3, ms(s3.dueAt!, -1), cal()).counted).toBe(false);
    expect(cadenceStep(s3, s3.dueAt!, cal()).counted).toBe(true);
  });

  it.each([
    ['00:59:59.999 (a millisecond under 8 h to 09:00)', [3, 0, 59, 59, 999], '2026-11-03 09:00'],
    ['01:00:00.000 (EXACTLY 8 h to 09:00 counts)', [3, 1, 0, 0, 0], '2026-11-03 09:00'],
    ['01:00:00.001 (a millisecond over: tomorrow’s 09:00)', [3, 1, 0, 0, 1], '2026-11-04 09:00'],
    ['14:00', [3, 14, 0, 0, 0], '2026-11-04 09:00'],
  ] as const)('Jordan’s row, #3 pressed at %s → #4 at %s: the cliff moves with the start of work (8 h before it)', (_n, [d, h, mi, s, m], due) => {
    expect(hhmm(upToThird(cal(AMMAN, SINCE, undefined, JORDAN_HOURS), amman(d, h, mi, s, m)).dueAt!)).toBe(due);
  });

  it('carries month ends, year ends and leap days', () => {
    expect(hhmm(upToThird(cal(), local(AMMAN, 2026, 11, 30, 20)).dueAt!)).toBe('2026-12-01 10:00');
    expect(hhmm(upToThird(cal(), local(AMMAN, 2026, 12, 31, 20)).dueAt!)).toBe('2027-01-01 10:00');
    expect(hhmm(upToThird(cal(), local(AMMAN, 2027, 1, 31, 20)).dueAt!)).toBe('2027-02-01 10:00');
    expect(hhmm(upToThird(cal(), local(AMMAN, 2028, 2, 29, 20)).dueAt!)).toBe('2028-03-01 10:00');
  });

  it('Berlin, Saturday 22:00 on the night before the spring-forward → Sunday 10:00 CEST', () => {
    const BER = 'Europe/Berlin';
    const due = upToThird(cal(BER, new Date('2026-03-01T00:00:00Z')), local(BER, 2026, 3, 28, 22)).dueAt!;
    expect(hhmm(due, BER)).toBe('2026-03-29 10:00');
    expect(due.toISOString()).toBe('2026-03-29T08:00:00.000Z');
  });

  it('the clock is the COUNTRY’S start of work: a row that says 09:00 gives 09:00, one that says 10:00 gives 10:00, one with nothing (or garbage) gives the fallback 10:00', () => {
    const at = (hours: Hours) => hhmm(upToThird(cadenceCalOf(SINCE, { timezone: AMMAN, weekendDays: [], ...hours }), amman(3, 14)).dueAt!);
    expect(at({ workHoursStart: '09:00', workHoursEnd: '17:00' })).toBe('2026-11-04 09:00');
    expect(at({ workHoursStart: '10:00', workHoursEnd: '22:00' })).toBe('2026-11-04 10:00');
    expect(at({ workHoursStart: '08:30', workHoursEnd: '16:00' })).toBe('2026-11-04 08:30');
    expect(at({})).toBe('2026-11-04 10:00');
    expect(at({ workHoursStart: 'garbage', workHoursEnd: '17:00' })).toBe('2026-11-04 10:00');
    expect(at({ workHoursStart: '22:00', workHoursEnd: '06:00' })).toBe('2026-11-04 10:00');
  });
});

describe('#4 → #5: the first 18:00 strictly after on a working day, and never less than 3 hours (elapsed) later', () => {
  it.each([
    ['17:59:59.999 (the floor: 20:59:59.999)', [10, 17, 59, 59, 999], '2026-11-10 20:59'],
    ['18:00:00.000 (strictly after → tomorrow)', [10, 18, 0, 0, 0], '2026-11-11 18:00'],
    ['18:00:00.001', [10, 18, 0, 0, 1], '2026-11-11 18:00'],
    ['23:59', [10, 23, 59, 0, 0], '2026-11-11 18:00'],
    ['00:00', [10, 0, 0, 0, 0], '2026-11-10 18:00'],
    ['09:00', [10, 9, 0, 0, 0], '2026-11-10 18:00'],
    ['14:59:59.999 (a millisecond under 3 h to 18:00)', [10, 14, 59, 59, 999], '2026-11-10 18:00'],
    ['15:00:00.000 (EXACTLY 3 h to 18:00: the floor equals the anchor)', [10, 15, 0, 0, 0], '2026-11-10 18:00'],
    ['16:30 (the floor: 19:30)', [10, 16, 30, 0, 0], '2026-11-10 19:30'],
  ] as const)('#4 at %s → %s', (_n, [d, h, mi, s, m], due) => {
    expect(hhmm(upToFourth(cal(), amman(d, h, mi, s, m)).dueAt!)).toBe(due);
  });

  it('#4 at 15:00:00.001 → the floor binds: the due is #4 + 3 h to the millisecond (18:00:00.001)', () => {
    const t4 = amman(10, 15, 0, 0, 1);
    expect(upToFourth(cal(), t4).dueAt).toEqual(ms(t4, CADENCE_FLOORS_MS.beforeFifth));
    expect(upToFourth(cal(), t4).dueAt).toEqual(amman(10, 18, 0, 0, 1));
  });

  it('a #4 counted at 17:55 makes #5 due three hours later, 20:55 (the planner’s floor reverses the old «five minutes later»)', () => {
    const s = upToFourth(cal(), amman(10, 17, 55));
    expect(s.dueAt).toEqual(amman(10, 20, 55));
  });

  it('a late #4 (the morning after it was due) is still due at that evening’s 18:00', () => {
    const s = chain(cal(), [amman(3, 10), amman(3, 10, 30), amman(3, 12, 30), amman(5, 8)]);
    expect(hhmm(s.dueAt!)).toBe('2026-11-05 18:00');
  });

  it('Auckland, Chatham and Kathmandu read 18:00 on the intended local date', () => {
    for (const tz of ['Pacific/Auckland', 'Pacific/Chatham', 'Asia/Kathmandu', 'Australia/Lord_Howe', 'Asia/Beirut']) {
      const c = cal(tz, new Date('2026-01-01T00:00:00Z'));
      for (const [mo, d] of [[3, 29], [4, 5], [9, 27], [10, 25], [11, 1]] as const) {
        const s = upToFourth(c, local(tz, 2026, mo, d, 12));
        expect(hhmm(s.dueAt!, tz)).toBe(`2026-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')} 18:00`);
      }
    }
  });
});

describe('rest days: #4 and #5 never land on one (Jordan’s live week: Friday and Saturday off)', () => {
  const rest = cal(AMMAN, SINCE, REST_FRI_SAT);

  it.each([
    ['T3 Thursday 14:00 → Sunday 10:00 (68 h)', [19, 14, 0], '2026-11-22 10:00'],
    ['T3 Wednesday 23:50 → Thursday 10:00', [18, 23, 50], '2026-11-19 10:00'],
    ['T3 Thursday 23:50 → Sunday 10:00 (58 h)', [19, 23, 50], '2026-11-22 10:00'],
    ['T3 Friday 10:00 (pressed ON a rest day) → Sunday 10:00', [20, 10, 0], '2026-11-22 10:00'],
    ['T3 Saturday 15:00 → Sunday 10:00', [21, 15, 0], '2026-11-22 10:00'],
    ['T3 Sunday 00:30 (8 h to 08:30) → Sunday 10:00', [22, 0, 30], '2026-11-22 10:00'],
    ['T3 Sunday 14:00 → Monday 10:00 (no rest day in the way)', [22, 14, 0], '2026-11-23 10:00'],
  ] as const)('#4: %s', (_n, [d, h, mi], due) => {
    expect(hhmm(upToThird(rest, amman(d, h, mi)).dueAt!)).toBe(due);
  });

  it.each([
    ['T4 Thursday 16:30 → Thursday 19:30 (the 3 h floor, a working day)', [19, 16, 30], '2026-11-19 19:30'],
    ['T4 Thursday 19:00 → Sunday 18:00 (Friday and Saturday skipped)', [19, 19, 0], '2026-11-22 18:00'],
    ['T4 Friday 10:30 (a late press on a rest day) → Sunday 18:00', [20, 10, 30], '2026-11-22 18:00'],
    ['T4 Sunday 10:00 → Sunday 18:00', [22, 10, 0], '2026-11-22 18:00'],
  ] as const)('#5: %s', (_n, [d, h, mi], due) => {
    expect(hhmm(upToFourth(rest, amman(d, h, mi)).dueAt!)).toBe(due);
  });

  it('a press on a rest day before its (Sunday) due is early; at Sunday 10:00 to the millisecond it counts', () => {
    const s3 = upToThird(rest, amman(19, 14));
    expect(cadenceStep(s3, amman(20, 10), rest).counted).toBe(false);
    expect(cadenceStep(s3, amman(21, 12), rest).counted).toBe(false);
    expect(cadenceStep(s3, amman(22, 9, 59, 59, 999), rest).counted).toBe(false);
    expect(cadenceStep(s3, amman(22, 10), rest).counted).toBe(true);
  });

  it('a Thursday-evening chain with Friday and Saturday off, step by step: #1 Thu 20:00 → #2 Thu 20:30 → #3 waits for SUNDAY 10:00 → #4 Monday 10:00 (8 h after Sunday’s #3) → #5 Monday 18:00 — it closes over three local days', () => {
    const s1 = chain(rest, [amman(19, 20)]);
    expect(s1.dueAt).toEqual(amman(19, 20, 30)); // inside work time on a working day: exactly +30 min
    const s2 = chain(rest, [amman(19, 20), amman(19, 20, 30)]);
    expect(hhmm(s2.dueAt!)).toBe('2026-11-22 10:00'); // raw Thursday 22:30 is outside work time: Friday and Saturday are rest days, so Sunday’s start
    const s3 = chain(rest, [amman(19, 20), amman(19, 20, 30), amman(22, 10)]);
    expect(hhmm(s3.dueAt!)).toBe('2026-11-23 10:00'); // Sunday 10:00 + 8 h = 18:00: the first start of work at or after it is Monday’s
    const s4 = chain(rest, [amman(19, 20), amman(19, 20, 30), amman(22, 10), amman(23, 10)]);
    expect(hhmm(s4.dueAt!)).toBe('2026-11-23 18:00');
    const s5 = chain(rest, [amman(19, 20), amman(19, 20, 30), amman(22, 10), amman(23, 10), amman(23, 18)]);
    expect(s5.days).toBe(3);
    expect(cadenceCloses(s5)).toBe(true);
  });

  it.each([
    ['Thursday 21:55 → raw 22:25 is after the end: Sunday 10:00 (Friday and Saturday skipped)', [19, 21, 55], '2026-11-22 10:00'],
    ['Thursday 19:00 → raw 19:30: a working day, inside: exactly +30 min', [19, 19, 0], '2026-11-19 19:30'],
    ['Wednesday 21:45 → raw 22:15: Thursday is a working day, so Thursday 10:00', [18, 21, 45], '2026-11-19 10:00'],
    ['Friday 11:00 (pressed ON a rest day) → raw Friday 11:30 is a rest day: Sunday 10:00', [20, 11, 0], '2026-11-22 10:00'],
    ['Friday 03:00 → Sunday 10:00', [20, 3, 0], '2026-11-22 10:00'],
    ['Saturday 23:00 → Sunday 10:00', [21, 23, 0], '2026-11-22 10:00'],
    ['Sunday 09:00 → raw 09:30 is before the start: Sunday 10:00', [22, 9, 0], '2026-11-22 10:00'],
  ] as const)('#2 skips the rest days too: #1 %s', (_n, [d, h, mi], due) => {
    expect(hhmm(cadenceStep(CADENCE_START, amman(d, h, mi), rest).next.dueAt!)).toBe(due);
  });

  it.each([
    ['Thursday 15:00 → raw 17:00: inside, exactly +2 h', [19, 15, 0, 0, 0], '2026-11-19 17:00'],
    ['Thursday 19:59:59.999 → raw 21:59:59.999: inside', [19, 19, 59, 59, 999], '2026-11-19 21:59'],
    ['Thursday 20:00 → raw 22:00 is exactly the end: Sunday 10:00', [19, 20, 0, 0, 0], '2026-11-22 10:00'],
    ['Thursday 20:30 → raw 22:30: Sunday 10:00', [19, 20, 30, 0, 0], '2026-11-22 10:00'],
    ['Friday 08:00 (a late press on a rest day) → raw Friday 10:00 is a rest day: Sunday 10:00', [20, 8, 0, 0, 0], '2026-11-22 10:00'],
    ['Saturday 20:00 → Sunday 10:00', [21, 20, 0, 0, 0], '2026-11-22 10:00'],
    ['Wednesday 20:30 → raw 22:30: Thursday 10:00', [18, 20, 30, 0, 0], '2026-11-19 10:00'],
  ] as const)('#3 skips the rest days too: #2 pressed %s', (_n, [d, h, mi, s, m], due) => {
    // a first press early enough for the second to be late-but-counted, whatever the rest days in between
    let s2: CadenceState | null = null;
    for (let lead = 1; lead <= 240 && !s2; lead++) {
      const s1 = cadenceStep(CADENCE_START, ms(amman(d, h, mi, s, m), -lead * 3_600_000), rest);
      if (!s1.counted || s1.next.dueAt!.getTime() > amman(d, h, mi, s, m).getTime()) continue;
      const r = cadenceStep(s1.next, amman(d, h, mi, s, m), rest);
      if (r.counted) s2 = r.next;
    }
    expect(hhmm(s2!.dueAt!)).toBe(due);
  });

  it('a due inside work time on a working day is EXACTLY the elapsed gap — rest days move only what they must: Sunday 11:00 → 11:30 → 13:30', () => {
    const s = chain(rest, [amman(22, 11), amman(22, 11, 30)]);
    expect(s.dueAt).toEqual(amman(22, 13, 30));
  });

  it.each([
    ['no list at all (undefined)', undefined],
    ['an empty list', []],
    ['all seven days (nowhere to skip to)', [0, 1, 2, 3, 4, 5, 6]],
    ['only invalid entries (7, -1, 5.5, "x")', [7, -1, 5.5, 'x'] as unknown as number[]],
  ])('%s skips nothing: Thursday 14:00 → Friday 10:00', (_n, days) => {
    expect(hhmm(upToThird(cal(AMMAN, SINCE, days), amman(19, 14)).dueAt!)).toBe('2026-11-20 10:00');
    expect(hhmm(upToFourth(cal(AMMAN, SINCE, days), amman(20, 17, 55)).dueAt!)).toBe('2026-11-20 20:55');
  });

  it('invalid entries beside valid ones are dropped, the valid ones stay: [5, 6, 9, -1] reads as [5, 6]', () => {
    expect(hhmm(upToThird(cal(AMMAN, SINCE, [5, 6, 9, -1]), amman(19, 14)).dueAt!)).toBe('2026-11-22 10:00');
  });

  it('six rest days: the plan terminates on the one working day', () => {
    const sixOff = cal(AMMAN, SINCE, [0, 1, 2, 3, 4, 5]);
    expect(hhmm(upToThird(sixOff, amman(19, 14)).dueAt!)).toBe('2026-11-21 10:00');
    expect(hhmm(upToFourth(sixOff, amman(21, 10)).dueAt!)).toBe('2026-11-21 18:00');
    expect(hhmm(upToFourth(sixOff, amman(21, 19)).dueAt!)).toBe('2026-11-28 18:00');
  });

  it('six rest days: #2 and #3 wait for the one working day as well (Saturday), and a Saturday inside the window is untouched', () => {
    const sixOff = cal(AMMAN, SINCE, [0, 1, 2, 3, 4, 5]);
    expect(hhmm(cadenceStep(CADENCE_START, amman(19, 14), sixOff).next.dueAt!)).toBe('2026-11-21 10:00'); // Thursday → Saturday
    expect(cadenceStep(CADENCE_START, amman(21, 11), sixOff).next.dueAt).toEqual(amman(21, 11, 30)); // Saturday inside: +30 min
    expect(hhmm(cadenceStep(CADENCE_START, amman(21, 21, 45), sixOff).next.dueAt!)).toBe('2026-11-28 10:00'); // Saturday 22:15 is after the end: next Saturday
  });
});

describe('Jordan’s live row (09:00-17:00, Friday and Saturday off): the whole plan inside Jordan’s own hours — but #5', () => {
  const jordan = cal(AMMAN, SINCE, REST_FRI_SAT, JORDAN_HOURS);

  it('Thursday 16:40 → #2 Sunday 09:00 → #3 Sunday 11:00 → #4 Monday 09:00 → #5 Monday 18:00', () => {
    const s1 = chain(jordan, [amman(19, 16, 40)]);
    expect(hhmm(s1.dueAt!)).toBe('2026-11-22 09:00'); // raw 17:10 is after Jordan’s 17:00
    const s2 = chain(jordan, [amman(19, 16, 40), amman(22, 9)]);
    expect(s2.dueAt).toEqual(amman(22, 11)); // inside: exactly +2 h
    const s3 = chain(jordan, [amman(19, 16, 40), amman(22, 9), amman(22, 11)]);
    expect(hhmm(s3.dueAt!)).toBe('2026-11-23 09:00'); // the country’s own start of work, 8 h after Sunday 11:00 is 19:00
    const s4 = chain(jordan, [amman(19, 16, 40), amman(22, 9), amman(22, 11), amman(23, 9)]);
    // #5 is the planner’s literal rule — the first 18:00 after #4 — NOT moved into Jordan’s 09:00-17:00: it lands an hour after Jordan’s work ends (a question for the planner)
    expect(hhmm(s4.dueAt!)).toBe('2026-11-23 18:00');
  });

  it('#2 and #3 never land outside 09:00-17:00 or on a rest day, over a week of first presses (every half hour)', () => {
    const inside = (at: Date) => {
      const p = zonedParts(at, AMMAN);
      return !REST_FRI_SAT.includes(p.weekday as 5 | 6) && p.hour * 60 + p.minute >= 9 * 60 && p.hour * 60 + p.minute < 17 * 60;
    };
    for (let t = amman(15, 0).getTime(); t < amman(22, 0).getTime(); t += 30 * 60_000) {
      const s1 = cadenceStep(CADENCE_START, new Date(t), jordan);
      expect(inside(s1.next.dueAt!), `#2 after ${new Date(t).toISOString()}`).toBe(true);
      const s2 = cadenceStep(s1.next, s1.next.dueAt!, jordan);
      expect(inside(s2.next.dueAt!), `#3 after #2 at ${s1.next.dueAt!.toISOString()}`).toBe(true);
    }
  });
});

describe('five attempts over two local days, even on a 25-hour DST day (and the first-day guard)', () => {
  /** The chain of presses each exactly at the due the last one set. */
  function onTime(c: CadenceCal, t1: Date): CadenceState {
    let s = CADENCE_START;
    let at = t1;
    for (let n = 0; n < CADENCE_LIMIT; n++) {
      const r = cadenceStep(s, at, c);
      if (!r.counted) throw new Error(`press ${n + 1} at ${at.toISOString()} did not count`);
      s = r.next;
      if (s.dueAt) at = s.dueAt;
    }
    return s;
  }

  it.each([
    ['Europe/Berlin', [2026, 10, 25], '2026-10-26 10:00'],
    ['America/New_York', [2026, 11, 1], '2026-11-02 10:00'],
    ['Pacific/Auckland', [2026, 4, 5], '2026-04-06 10:00'],
  ] as const)('%s: #1 at 00:00 on the long day, #2 and #3 wait for work time (10:00, 12:00) → #4 is on the NEXT local day, five counted, two days, it closes', (tz, [y, mo, d], due4) => {
    const c = cal(tz, new Date('2026-01-01T00:00:00Z'));
    const t1 = local(tz, y, mo, d, 0, 0);
    const s = onTime(c, t1);
    expect(s.counted).toHaveLength(5);
    expect(hhmm(s.counted[1], tz)).toBe(`${String(y)}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')} 10:00`);
    expect(hhmm(s.counted[3], tz)).toBe(due4);
    expect(dayOf(s.counted[3], tz)).not.toBe(dayOf(t1, tz));
    expect(s.days).toBeGreaterThanOrEqual(CADENCE_MIN_DAYS);
    expect(cadenceCloses(s)).toBe(true);
  });

  it('the first-day guard, on a state the steps can no longer produce (defence in depth): #1 00:00, #2 00:30, #3 02:30 CEST on Berlin’s 25-hour day → #4 is pushed to the NEXT day’s 10:00, not 10:00 CET on the same day', () => {
    // With #2 and #3 inside work time, #4 (8 h or more after #3, and #3 not before the start of work) can never fall on #1's local day through `cadenceStep` itself: the guard stays
    // because the planner confirmed it, and because a state that did not come from the steps (older data, a hand-built one) must still cost the order a day. So it is exercised by hand.
    const BER = 'Europe/Berlin';
    const c = cal(BER, new Date('2026-01-01T00:00:00Z'));
    const t1 = local(BER, 2026, 10, 25, 0, 0);
    const t2 = ms(t1, 1_800_000);
    const t3 = ms(t2, 7_200_000);
    expect(hhmm(t3, BER)).toBe('2026-10-25 02:30');
    const hand: CadenceState = { counted: [t1, t2], days: 1, dueAt: null };
    const r = cadenceStep(hand, t3, c);
    expect(r.counted).toBe(true);
    // 8 h after 02:30 CEST is 09:30 CET: without the guard #4 would be due at 10:00 CET on the 25th, #1's own day
    expect(hhmm(r.next.dueAt!, BER)).toBe('2026-10-26 10:00');
    expect(r.next.dueAt!.toISOString()).toBe('2026-10-26T09:00:00.000Z');
  });

  const ZONES = ['Asia/Amman', 'Asia/Damascus', 'Europe/Berlin', 'America/New_York', 'Asia/Beirut', 'Australia/Lord_Howe', 'Pacific/Auckland', 'Pacific/Chatham', 'Asia/Kathmandu'];
  /** The zone's offset from UTC at an instant, in ms — read from `zonedParts`, to the minute. */
  const offsetOf = (at: number, tz: string): number => {
    const p = zonedParts(new Date(at), tz);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(at / 60_000) * 60_000;
  };
  const dayOf = (d: Date, tz: string) => hhmm(d, tz).slice(0, 10);

  it('9 zones × every offset transition of 2026 × T1 at every quarter-hour from 36 h before to 36 h after it × no rest day, Friday, Friday+Saturday × Syria’s and Jordan’s hours: the on-time chain spans two local days and closes', () => {
    const HOUR = 3_600_000;
    const transitionsPerZone = new Map<string, number>();
    let chains = 0;
    for (const tz of ZONES) {
      const transitions: number[] = [];
      let prev = offsetOf(Date.UTC(2026, 0, 1), tz);
      for (let at = Date.UTC(2026, 0, 1) + HOUR; at <= Date.UTC(2027, 0, 1); at += HOUR) {
        const now = offsetOf(at, tz);
        if (now !== prev) transitions.push(at);
        prev = now;
      }
      transitionsPerZone.set(tz, transitions.length);
      for (const transition of transitions) {
        for (const restDays of [undefined, [5], REST_FRI_SAT] as const) {
          for (const hours of [SYRIA_HOURS, JORDAN_HOURS]) {
            const c = cal(tz, new Date('2020-01-01T00:00:00Z'), restDays, hours);
            for (let at = transition - 36 * HOUR; at <= transition + 36 * HOUR; at += 15 * 60_000) {
              const s = onTime(c, new Date(at));
              chains++;
              if (s.days < CADENCE_MIN_DAYS || !cadenceCloses(s)) {
                throw new Error(`${tz} T1 ${new Date(at).toISOString()} rest ${JSON.stringify(restDays)} hours ${hours.workHoursStart}: days ${s.days}, closes ${cadenceCloses(s)}`);
              }
            }
          }
        }
      }
    }
    // The zones that change their clocks in 2026 did, twice each — otherwise the scan proved nothing about a 25-hour day.
    for (const tz of ['Europe/Berlin', 'America/New_York', 'Pacific/Auckland', 'Australia/Lord_Howe', 'Pacific/Chatham', 'Asia/Beirut']) expect(transitionsPerZone.get(tz)).toBe(2);
    expect(chains).toBeGreaterThan(10_000);
  }, 120_000);
});

describe('the floor, the cap and the early rule', () => {
  it('a line at the floor does not count; one millisecond after does', () => {
    expect(cadenceStep(CADENCE_START, SINCE, cal()).counted).toBe(false);
    expect(cadenceStep(CADENCE_START, ms(SINCE, 1), cal()).counted).toBe(true);
    expect(cadenceStep(CADENCE_START, ms(SINCE, -1), cal()).counted).toBe(false);
  });

  it('an invalid time never counts', () => {
    expect(cadenceStep(CADENCE_START, new Date('nope'), cal()).counted).toBe(false);
  });

  it('the sixth press after the fifth never counts, and counted stays 5', () => {
    const t = amman(3, 11);
    const s5 = chain(cal(), [t, ms(t, 1_800_000), ms(t, 1_800_000 + 7_200_000), amman(4, 10), amman(4, 18)]);
    expect(s5.counted).toHaveLength(5);
    expect(s5.dueAt).toBeNull();
    const six = cadenceStep(s5, amman(5, 12), cal());
    expect(six.counted).toBe(false);
    expect(six.next.counted).toHaveLength(5);
    expect(cadenceCloses(six.next)).toBe(true);
  });

  it('an early press does not delay, shorten or reset the due', () => {
    const t1 = amman(3, 11);
    const s1 = chain(cal(), [t1]);
    const early = cadenceStep(s1, ms(t1, 60_000), cal());
    const then = cadenceStep(early.next, ms(t1, 1_800_000), cal());
    expect(then.counted).toBe(true);
    expect(then.next.counted).toEqual([t1, ms(t1, 1_800_000)]);
  });

  it('never mutates its input', () => {
    const s = chain(cal(), [amman(3, 11)]);
    const copy = JSON.stringify(s);
    cadenceStep(s, amman(3, 12), cal());
    expect(JSON.stringify(s)).toBe(copy);
    expect(CADENCE_START.counted).toHaveLength(0);
  });

  it('days are counted by LOCAL calendar day: 23:59 and the next morning’s 10:00 are two days; with the whole day as work time, 23:59 and 00:29 are two as well; a 25 h DST day is one', () => {
    const NY = 'America/New_York';
    expect(chain(cal(), [amman(3, 23, 59), amman(4, 10)]).days).toBe(2);
    const a = cadenceStep(cadenceStep(CADENCE_START, amman(3, 23, 59), cal(AMMAN, SINCE, undefined, ALL_DAY)).next, amman(4, 0, 29), cal(AMMAN, SINCE, undefined, ALL_DAY));
    expect(a.counted).toBe(true);
    expect(a.next.days).toBe(2);
    const t1 = local(NY, 2026, 11, 1, 0, 5);
    const b = chain(cal(NY, new Date('2026-01-01T00:00:00Z'), undefined, ALL_DAY), [t1, ms(t1, 1_800_000)]);
    expect(b.days).toBe(1);
  });
});

describe('cadenceState: the lines of an order, folded', () => {
  const row = (createdAt: Date, result: string, attemptNumber: number, employeeId = 'u1') => ({ createdAt, result, attemptNumber, employeeId });

  it('BUSY and UNREACHABLE count like NO_ANSWER; every other result neither counts nor resets; lines of several employees count together', () => {
    const t = amman(3, 11);
    const rows = [
      row(t, 'NO_ANSWER', 1, 'u1'),
      row(ms(t, 100), 'OPENED', 2),
      row(ms(t, 200), 'ANSWERED', 3),
      row(ms(t, 1_800_000), 'BUSY', 4, 'u2'),
      row(ms(t, 1_800_001), 'MESSAGE_SENT', 5),
      row(ms(t, 1_800_000 + 7_200_000), 'UNREACHABLE', 6, 'supervisor'),
    ];
    const s = cadenceState(rows, cal());
    expect(s.counted).toEqual([t, ms(t, 1_800_000), ms(t, 1_800_000 + 7_200_000)]);
    for (const other of ['OPENED', 'MESSAGE_SENT', 'ANSWERED', 'CALLBACK_REQUESTED', 'WRONG_NUMBER', 'OTHER', 'CONFIRMED', 'REJECTED']) {
      expect(cadenceState([row(t, other, 1)], cal())).toBe(CADENCE_START);
    }
  });

  it('empty → the start; invalid dates are dropped', () => {
    expect(cadenceState([], cal())).toBe(CADENCE_START);
    expect(cadenceState([row(new Date('x'), 'NO_ANSWER', 1)], cal()).counted).toHaveLength(0);
  });

  it('four old lines before the floor are invisible: the first new press is #1', () => {
    const old = [1, 2, 3, 4].map((n) => row(ms(SINCE, -n * 3_600_000), 'NO_ANSWER', n));
    expect(cadenceState(old, cal()).counted).toHaveLength(0);
    const pressed = cadencePress(old, { at: amman(3, 11), result: 'NO_ANSWER' }, cal());
    expect(pressed.counted).toBe(true);
    expect(pressed.next.counted).toHaveLength(1);
  });

  it('two lines in the same millisecond are ordered by attemptNumber', () => {
    const t = amman(3, 11);
    const a = cadenceState([row(t, 'NO_ANSWER', 2), row(t, 'NO_ANSWER', 1)], cal());
    expect(a.counted).toEqual([t]);
  });

  it('under a clock skew where attemptNumber order differs from time order, the replay equals the door’s decision', () => {
    const t = amman(3, 11);
    // attempt 1 was decided at t; attempt 2 stamped 2 s EARLIER by a skewed instance: it is early (before t+30m), so it did not count.
    const rows = [row(ms(t, -2000), 'NO_ANSWER', 2), row(t, 'NO_ANSWER', 1)];
    expect(cadenceState(rows, cal()).counted).toEqual([t]);
  });
});

describe('cadenceCloses', () => {
  it('four counted: no; five over two days: yes; five on ONE day (hand-built): no', () => {
    const t = amman(3, 11);
    const s4 = chain(cal(), [t, ms(t, 1_800_000), ms(t, 1_800_000 + 7_200_000), amman(4, 10)]);
    expect(cadenceCloses(s4)).toBe(false);
    const s5 = chain(cal(), [t, ms(t, 1_800_000), ms(t, 1_800_000 + 7_200_000), amman(4, 10), amman(4, 18)]);
    expect(cadenceCloses(s5)).toBe(true);
    expect(cadenceCloses({ counted: Array.from({ length: 5 }, () => t), days: 1, dueAt: null })).toBe(false);
  });
});

describe('cadencePress: the door’s question', () => {
  const row = (createdAt: Date, result: string, attemptNumber: number) => ({ createdAt, result, attemptNumber });

  it('a result that is not a no-answer: never counted, never closes, writes no due, next = before', () => {
    const t = amman(3, 11);
    const stored = [row(t, 'NO_ANSWER', 1)];
    for (const result of ['OPENED', 'ANSWERED', 'MESSAGE_SENT', 'CALLBACK_REQUESTED', 'WRONG_NUMBER']) {
      const r = cadencePress(stored, { at: ms(t, 60_000), result }, cal());
      expect(r).toMatchObject({ counted: false, dueAt: null, closes: false });
      expect(r.next.counted).toHaveLength(1);
    }
  });

  it('an early no-answer: not counted, writes no due, does not close', () => {
    const t = amman(3, 11);
    const r = cadencePress([row(t, 'NO_ANSWER', 1)], { at: ms(t, 60_000), result: 'NO_ANSWER' }, cal());
    expect(r).toMatchObject({ counted: false, dueAt: null, closes: false });
    expect(r.next.dueAt).toEqual(ms(t, 1_800_000));
  });

  it('a counted press writes the due it set; the fifth writes none and closes', () => {
    const t = amman(3, 11);
    const first = cadencePress([], { at: t, result: 'NO_ANSWER' }, cal());
    expect(first).toMatchObject({ counted: true, closes: false });
    expect(first.dueAt).toEqual(ms(t, 1_800_000));
    const four = [t, ms(t, 1_800_000), ms(t, 1_800_000 + 7_200_000), amman(4, 10)].map((d, i) => row(d, 'NO_ANSWER', i + 1));
    const fifth = cadencePress(four, { at: amman(4, 18), result: 'UNREACHABLE' }, cal());
    expect(fifth).toMatchObject({ counted: true, dueAt: null, closes: true });
  });

  it('a sixth no-answer after a refused close asks the close again', () => {
    const t = amman(3, 11);
    const five = [t, ms(t, 1_800_000), ms(t, 1_800_000 + 7_200_000), amman(4, 10), amman(4, 18)].map((d, i) => row(d, 'NO_ANSWER', i + 1));
    const sixth = cadencePress(five, { at: amman(5, 10), result: 'NO_ANSWER' }, cal());
    expect(sixth).toMatchObject({ counted: false, closes: true });
  });

  it('five presses crammed into one day cannot close: every one after the first is early', () => {
    const t = amman(3, 11);
    const rows: ReturnType<typeof row>[] = [];
    let closes = false;
    for (let i = 0; i < 5; i++) {
      const at = ms(t, i * 60_000);
      const r = cadencePress(rows, { at, result: 'NO_ANSWER' }, cal());
      closes = closes || r.closes;
      rows.push(row(at, 'NO_ANSWER', i + 1));
    }
    expect(closes).toBe(false);
    expect(cadenceState(rows, cal()).counted).toHaveLength(1);
  });
});

// Property tests: a seeded generator (the repo's tests are deterministic).
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('properties', () => {
  const ZONES = ['Asia/Amman', 'Asia/Damascus', 'America/New_York'];
  const minutesOf = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));

  it.each([
    ['no rest days, Syria’s hours', undefined, SYRIA_HOURS],
    ['Friday and Saturday off, Syria’s hours', REST_FRI_SAT, SYRIA_HOURS],
    ['Friday and Saturday off, Jordan’s hours', REST_FRI_SAT, JORDAN_HOURS],
  ] as const)('stepping press by press equals the replay of the stored rows, for 200 random sequences per zone (5 counted always span two days; #2 and #3 are always due inside work time), %s', (_n, restDays, hours) => {
    const from = minutesOf(hours.workHoursStart);
    const to = minutesOf(hours.workHoursEnd);
    for (const tz of ZONES) {
      const c = cal(tz, new Date('2026-01-01T00:00:00Z'), restDays, hours);
      for (let seed = 1; seed <= 200; seed++) {
        const rnd = mulberry32(seed * 7919 + tz.length);
        const rows: { createdAt: Date; result: string; attemptNumber: number }[] = [];
        let at = new Date(Date.UTC(2026, 2 + Math.floor(rnd() * 9), 1 + Math.floor(rnd() * 27), Math.floor(rnd() * 24), Math.floor(rnd() * 60)));
        let counted = 0;
        for (let n = 1; n <= 14; n++) {
          const result = ['NO_ANSWER', 'NO_ANSWER', 'BUSY', 'UNREACHABLE', 'ANSWERED', 'OPENED', 'CALLBACK_REQUESTED'][Math.floor(rnd() * 7)];
          const press = cadencePress(rows, { at, result }, c);
          rows.push({ createdAt: at, result, attemptNumber: n });
          const replay = cadenceState(rows, c);
          expect(replay.counted).toEqual(press.next.counted);
          expect(replay.dueAt?.getTime() ?? null).toBe(press.next.dueAt?.getTime() ?? null);
          expect(replay.days).toBe(press.next.days);
          if (press.counted) counted++;
          if (press.next.counted.length >= CADENCE_LIMIT) expect(press.next.days).toBeGreaterThanOrEqual(CADENCE_MIN_DAYS);
          expect(press.next.counted.length).toBeLessThanOrEqual(CADENCE_LIMIT);
          // #2 and #3: the due is inside work time (a working day, [start, end)), never before the raw press + gap, and it IS the raw when the raw was already inside
          const k = press.next.counted.length;
          if (press.counted && (k === 1 || k === 2) && press.next.dueAt) {
            const raw = press.next.counted[k - 1].getTime() + (k === 1 ? CADENCE_GAPS_MS.afterFirst : CADENCE_GAPS_MS.afterSecond);
            const due = press.next.dueAt.getTime();
            const inside = (t: number) => {
              const p = zonedParts(new Date(t), tz);
              const m = p.hour * 60 + p.minute;
              return !(restDays ?? []).some((d) => d === p.weekday) && m >= from && m < to;
            };
            expect(inside(due), `${tz} seed ${seed} press ${n}: due ${press.next.dueAt.toISOString()} is outside work time`).toBe(true);
            expect(due).toBeGreaterThanOrEqual(raw);
            if (inside(raw)) expect(due).toBe(raw);
            else expect(hhmm(press.next.dueAt, tz).slice(11)).toBe(hours.workHoursStart);
          }
          // the next press lands anywhere from a minute to a day and a half later: early, on time and late are all met
          at = new Date(at.getTime() + Math.floor((1 + rnd() * 2160) * 60_000));
        }
        expect(counted).toBeLessThanOrEqual(CADENCE_LIMIT);
      }
    }
  }, 120_000);
});

describe('the words', () => {
  const t = amman(3, 11);

  it('cadenceWhen prints the REAL due: a time today, «بكرة» across midnight, the weekday across a skipped weekend — no windows', () => {
    expect(cadenceWhen(ms(t, 1_800_000), t, AMMAN)).toBe('الساعة 11:30');
    expect(cadenceWhen(amman(4, 0, 20), amman(3, 23, 50), AMMAN)).toBe('بكرة الساعة 00:20');
    expect(cadenceWhen(amman(4, 10), amman(3, 12), AMMAN)).toBe('بكرة الساعة 10:00');
    expect(cadenceWhen(amman(4, 10), amman(4, 8), AMMAN)).toBe('الساعة 10:00');
    expect(cadenceWhen(amman(4, 18), amman(4, 10), AMMAN)).toBe('الساعة 18:00');
    expect(cadenceWhen(amman(5, 18), amman(4, 19), AMMAN)).toBe('بكرة الساعة 18:00');
    expect(cadenceWhen(amman(4, 20, 55), amman(4, 17, 55), AMMAN)).toBe('الساعة 20:55'); // the 3 h floor: no «6 to 10» that would lie
  });

  it('cadenceWhen across two days or more says the weekday: Thursday → «السبت»… and Sunday after a Friday-and-Saturday weekend', () => {
    expect(cadenceWhen(amman(21, 10), amman(19, 14), AMMAN)).toBe('السبت الساعة 10:00'); // Thursday 19/11 → Saturday 21/11
    expect(cadenceWhen(amman(22, 10), amman(19, 14), AMMAN)).toBe('الأحد الساعة 10:00'); // → Sunday 22/11 (3 days)
    expect(cadenceWhen(amman(23, 10), amman(19, 14), AMMAN)).toBe('الاثنين الساعة 10:00');
    expect(cadenceWhen(amman(22, 18), amman(20, 9), AMMAN)).toBe('الأحد الساعة 18:00'); // Friday morning → Sunday evening
    // every weekday name is the right one: 22/11/2026 is a Sunday, so 22…28/11 run Sunday…Saturday, all three days or more after Thursday 19/11
    const names = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
    names.forEach((name, i) => expect(cadenceWhen(amman(22 + i, 10), amman(19, 9), AMMAN)).toBe(`${name} الساعة 10:00`));
  });

  it('cadencePressWords: every sentence, exactly', () => {
    const base = { now: t, timeZone: AMMAN };
    expect(cadencePressWords({ ...base, counted: true, closed: false, released: true, attempt: 1, dueAt: ms(t, 1_800_000) })).toBe(
      'انحسبت المحاولة 1 من 5 — رجع الطلب للطابور، والمحاولة الجاية الساعة 11:30.'
    );
    expect(cadencePressWords({ ...base, counted: true, closed: false, released: false, attempt: 3, dueAt: amman(4, 10), now: amman(3, 12) })).toBe(
      'انحسبت المحاولة 3 من 5 — المحاولة الجاية بكرة الساعة 10:00.'
    );
    expect(cadencePressWords({ ...base, counted: true, closed: false, released: true, attempt: 3, dueAt: amman(22, 10), now: amman(19, 15, 30) })).toBe(
      'انحسبت المحاولة 3 من 5 — رجع الطلب للطابور، والمحاولة الجاية الأحد الساعة 10:00.'
    );
    expect(cadencePressWords({ ...base, counted: false, closed: false, released: false, attempt: 3, dueAt: amman(22, 10), now: amman(20, 10) })).toBe(
      'سجّلنا الضغطة بس ما انحسبت محاولة — لسا بدري. المحاولة 4 من 5 بتنحسب الأحد الساعة 10:00.'
    );
    expect(cadencePressWords({ ...base, counted: false, closed: false, released: false, attempt: 1, dueAt: ms(t, 1_800_000) })).toBe(
      'سجّلنا الضغطة بس ما انحسبت محاولة — لسا بدري. المحاولة 2 من 5 بتنحسب الساعة 11:30.'
    );
    expect(cadencePressWords({ ...base, counted: true, closed: true, released: false, attempt: 5, dueAt: null })).toBe(
      'انحسبت المحاولة 5 من 5 — أُغلق الطلب تلقائياً وراح على قائمة «ملغاة سابقاً».'
    );
    expect(cadencePressWords({ ...base, counted: true, closed: false, released: false, attempt: 5, dueAt: null })).toBe(
      'انحسبت المحاولة 5 من 5 — الطلب لسا مفتوح، والضغطة الجاية بتجرّب تسكّره من جديد.'
    );
    expect(cadencePressWords({ ...base, counted: false, closed: false, released: false, attempt: 5, dueAt: null })).toBe('اكتملت المحاولات الخمس — الضغطة انسجّلت بس ما انحسبت.');
    expect(cadencePressWords({ ...base, counted: false, closed: false, released: false, attempt: 0, dueAt: null })).toBe('انسجّلت الضغطة بس ما انحسبت محاولة.');
  });

  it('the sentences print the dues the plan REALLY computes now that #2 and #3 wait for work time: «بكرة الساعة 10:00» after a 21:50 press, the weekday after a Thursday-evening one', () => {
    const rest = cal(AMMAN, SINCE, REST_FRI_SAT);
    const late = amman(3, 21, 50);
    const first = cadencePress([], { at: late, result: 'NO_ANSWER' }, cal());
    expect(cadencePressWords({ counted: first.counted, closed: false, released: true, attempt: first.next.counted.length, dueAt: first.dueAt, now: late, timeZone: AMMAN })).toBe(
      'انحسبت المحاولة 1 من 5 — رجع الطلب للطابور، والمحاولة الجاية بكرة الساعة 10:00.'
    );
    const thursday = amman(19, 21, 55);
    const stored = [{ createdAt: thursday, result: 'NO_ANSWER', attemptNumber: 1 }];
    const counted = cadencePress([], { at: thursday, result: 'NO_ANSWER' }, rest);
    expect(cadencePressWords({ counted: true, closed: false, released: true, attempt: 1, dueAt: counted.dueAt, now: thursday, timeZone: AMMAN })).toBe(
      'انحسبت المحاولة 1 من 5 — رجع الطلب للطابور، والمحاولة الجاية الأحد الساعة 10:00.'
    );
    const early = cadencePress(stored, { at: amman(19, 22, 0), result: 'NO_ANSWER' }, rest);
    expect(early.counted).toBe(false);
    expect(cadencePressWords({ counted: false, closed: false, released: false, attempt: 1, dueAt: early.next.dueAt, now: amman(19, 22), timeZone: AMMAN })).toBe(
      'سجّلنا الضغطة بس ما انحسبت محاولة — لسا بدري. المحاولة 2 من 5 بتنحسب الأحد الساعة 10:00.'
    );
    // and the desk's card says the same due
    expect(cadenceCardWords(cadenceDesk(stored, rest, amman(19, 22, 30)), amman(19, 22, 30), AMMAN)).toBe('محاولة 2 من 5 — جاهز الأحد الساعة 10:00');
  });

  it('Western digits only, no Latin letters, never the word «جولة»', () => {
    const sentences = [
      cadenceWhen(ms(t, 1_800_000), t, AMMAN),
      cadenceWhen(amman(4, 10), amman(3, 12), AMMAN),
      cadenceWhen(amman(4, 18), amman(4, 10), AMMAN),
      cadenceWhen(amman(22, 10), amman(19, 14), AMMAN),
      cadencePressWords({ now: t, timeZone: AMMAN, counted: true, closed: false, released: true, attempt: 2, dueAt: ms(t, 7_200_000) }),
      cadencePressWords({ now: t, timeZone: AMMAN, counted: false, closed: false, released: false, attempt: 3, dueAt: amman(4, 10) }),
    ];
    for (const s of sentences) {
      expect(s).not.toMatch(/[٠-٩]/);
      expect(s).not.toMatch(/[A-Za-z]/);
      expect(s).not.toContain('جولة');
    }
  });
});

describe('cadenceDesk: where a held order stands, on the server’s clock', () => {
  const row = (createdAt: Date, attemptNumber: number, result = 'NO_ANSWER') => ({ createdAt, result, attemptNumber });
  const t = amman(3, 11);
  const one = [row(t, 1)];
  const four = [t, ms(t, 1_800_000), ms(t, 1_800_000 + 7_200_000), amman(4, 10)].map((d, i) => row(d, i + 1));
  const five = [...four, row(amman(4, 18), 5)];

  it('a due exactly NOW is due; one millisecond before it is waiting (and a press then would not count)', () => {
    const due = ms(t, 1_800_000);
    expect(cadenceDesk(one, cal(), due)).toMatchObject({ counted: 1, due: true, waiting: false, closesOnNext: false });
    expect(cadenceDesk(one, cal(), ms(due, -1))).toMatchObject({ counted: 1, due: false, waiting: true, closesOnNext: false });
    expect(cadenceDesk(one, cal(), ms(due, -1)).dueAt).toEqual(due);
  });

  it('no counted attempt (none at all, or only lines from before the switch) is neither due nor waiting, and closes nothing', () => {
    expect(cadenceDesk([], cal(), t)).toMatchObject({ counted: 0, dueAt: null, due: false, waiting: false, closesOnNext: false });
    const old = [row(ms(SINCE, -3_600_000), 1), row(ms(SINCE, -1_800_000), 2)];
    expect(cadenceDesk(old, cal(), t)).toMatchObject({ counted: 0, due: false, waiting: false, closesOnNext: false });
  });

  it('closesOnNext: four counted with the due reached → true; with the due ahead → false; five counted and still open → true (a press asks again)', () => {
    const dueFour = amman(4, 18);
    expect(cadenceDesk(four, cal(), dueFour).closesOnNext).toBe(true);
    expect(cadenceDesk(four, cal(), ms(dueFour, -1)).closesOnNext).toBe(false);
    expect(cadenceDesk(four, cal(), amman(4, 12)).closesOnNext).toBe(false);
    expect(cadenceDesk(five, cal(), amman(5, 10))).toMatchObject({ counted: 5, dueAt: null, due: false, waiting: false, closesOnNext: true });
  });

  it('three counted never closes on the next press (the fifth is two attempts away)', () => {
    const three = four.slice(0, 3);
    expect(cadenceDesk(three, cal(), amman(4, 12)).closesOnNext).toBe(false);
  });
});

describe('cadenceVerdict: the shape deskTab already reads', () => {
  const t = amman(3, 11);
  const base = { counted: 1, due: false, waiting: false, dueAt: null as Date | null };

  it('no counted attempt → by the order’s own attempt count: a NEW order is due NEW; anything rung but invisible is not due', () => {
    expect(cadenceVerdict({ ...base, counted: 0 }, 0)).toEqual({ due: true, reason: 'NEW', waiting: false, dueAt: null });
    expect(cadenceVerdict({ ...base, counted: 0 }, 2)).toEqual({ due: false, reason: null, waiting: false, dueAt: null });
  });

  it('the due arrived → ROUND, due; the due ahead → waiting with its dueAt; five counted and open → not due, not waiting', () => {
    expect(cadenceVerdict({ ...base, due: true, dueAt: t }, 1)).toEqual({ due: true, reason: 'ROUND', waiting: false, dueAt: null });
    expect(cadenceVerdict({ ...base, waiting: true, dueAt: ms(t, 60_000) }, 1)).toEqual({ due: false, reason: null, waiting: true, dueAt: ms(t, 60_000) });
    expect(cadenceVerdict({ counted: 5, due: false, waiting: false, dueAt: null }, 5)).toEqual({ due: false, reason: null, waiting: false, dueAt: null });
  });
});

describe('cadenceVerdict: the rounds’ PROMISE comes first when it is handed over (RV2392)', () => {
  const t = amman(3, 11);
  const base = { counted: 1, due: false, waiting: false, dueAt: null as Date | null };
  const PROMISE: DueVerdict = { due: true, reason: 'PROMISE', waiting: false, dueAt: null };

  it('counted 0 (a line that reached her, or lines from before the switch) with a promise → the PROMISE verdict, not the count’s', () => {
    expect(cadenceVerdict({ ...base, counted: 0 }, 2, PROMISE)).toEqual(PROMISE);
    expect(cadenceVerdict({ ...base, counted: 0 }, 0, PROMISE)).toEqual(PROMISE);
  });

  it('counted 2 with the plan’s due arrived → PROMISE, not ROUND (the tag beats the plan’s words)', () => {
    expect(cadenceVerdict({ ...base, counted: 2, due: true, dueAt: t }, 2, PROMISE)).toEqual(PROMISE);
  });

  it('counted 1 with the plan still waiting → a due PROMISE and not waiting (the customer asked; the plan’s wait does not apply)', () => {
    expect(cadenceVerdict({ ...base, waiting: true, dueAt: ms(t, 60_000) }, 1, PROMISE)).toEqual(PROMISE);
  });

  it('five counted and still open → PROMISE', () => {
    expect(cadenceVerdict({ counted: 5, due: false, waiting: false, dueAt: null }, 5, PROMISE)).toEqual(PROMISE);
  });

  it('only the word PROMISE is read: a ROUND given by the rounds is ignored and the result equals the two-argument one (no «جولة» leaks into the plan)', () => {
    const ROUND: DueVerdict = { due: true, reason: 'ROUND', waiting: false, dueAt: null };
    for (const [desk, count] of [
      [{ ...base, counted: 0 }, 2],
      [{ ...base, due: true, dueAt: t }, 1],
      [{ ...base, waiting: true, dueAt: ms(t, 60_000) }, 1],
    ] as const) {
      expect(cadenceVerdict(desk, count, ROUND)).toEqual(cadenceVerdict(desk, count));
    }
  });

  it('a NEW, a waiting and a not-due verdict from the rounds are ignored too', () => {
    const NEW: DueVerdict = { due: true, reason: 'NEW', waiting: false, dueAt: null };
    const WAITING: DueVerdict = { due: false, reason: null, waiting: true, dueAt: ms(t, 9 * 60_000) };
    const NOT_DUE: DueVerdict = { due: false, reason: null, waiting: false, dueAt: null };
    const desk = { ...base, due: true, dueAt: t };
    for (const given of [NEW, WAITING, NOT_DUE]) {
      expect(cadenceVerdict(desk, 1, given)).toEqual({ due: true, reason: 'ROUND', waiting: false, dueAt: null });
      expect(cadenceVerdict({ ...base, counted: 0 }, 2, given)).toEqual({ due: false, reason: null, waiting: false, dueAt: null });
    }
  });

  it('`null` and an omitted third argument are what the function always was', () => {
    expect(cadenceVerdict({ ...base, counted: 0 }, 0, null)).toEqual(cadenceVerdict({ ...base, counted: 0 }, 0));
    expect(cadenceVerdict({ ...base, due: true, dueAt: t }, 1, null)).toEqual({ due: true, reason: 'ROUND', waiting: false, dueAt: null });
  });
});

describe('closedCardWords: the closed-today card prints a number only when it reached the limit (RV2391)', () => {
  it('below the limit → the number-free sentence; at the limit or past it → null (print the numbers as always)', () => {
    expect(closedCardWords(0, CADENCE_LIMIT)).toBe(CLOSED_WITHOUT_COUNT_WORDS);
    expect(closedCardWords(4, CADENCE_LIMIT)).toBe(CLOSED_WITHOUT_COUNT_WORDS);
    expect(closedCardWords(5, CADENCE_LIMIT)).toBeNull();
    expect(closedCardWords(6, CADENCE_LIMIT)).toBeNull();
    // The same rule under the legacy limit: the limit is the caller's, never a literal 5.
    expect(closedCardWords(0, NO_ANSWER_LIMIT)).toBe(CLOSED_WITHOUT_COUNT_WORDS);
    expect(closedCardWords(NO_ANSWER_LIMIT, NO_ANSWER_LIMIT)).toBeNull();
  });

  it('the sentence says no number, no «جولة», no Eastern or Latin digit, and reads «بعد …» so both places it is printed in stay true', () => {
    expect(CLOSED_WITHOUT_COUNT_WORDS).not.toMatch(/[0-9٠-٩]/);
    expect(CLOSED_WITHOUT_COUNT_WORDS).not.toContain('ثلاث');
    expect(CLOSED_WITHOUT_COUNT_WORDS).not.toContain('جولة');
    expect(CLOSED_WITHOUT_COUNT_WORDS.startsWith('بعد ')).toBe(true);
  });
});

describe('cadenceCardWords: the line a held card prints', () => {
  const t = amman(3, 11);

  it('due: «لا يرد راجع — محاولة n من 5»; waiting: «محاولة n من 5 — جاهز …» with the real due (today, tomorrow, the weekday after a rest weekend)', () => {
    expect(cadenceCardWords({ counted: 2, due: true, waiting: false, dueAt: t }, t, AMMAN)).toBe('لا يرد راجع — محاولة 3 من 5');
    expect(cadenceCardWords({ counted: 1, due: false, waiting: true, dueAt: amman(3, 17, 30) }, t, AMMAN)).toBe('محاولة 2 من 5 — جاهز الساعة 17:30');
    expect(cadenceCardWords({ counted: 1, due: false, waiting: true, dueAt: amman(4, 0, 20) }, amman(3, 23, 50), AMMAN)).toBe('محاولة 2 من 5 — جاهز بكرة الساعة 00:20');
    expect(cadenceCardWords({ counted: 3, due: false, waiting: true, dueAt: amman(4, 10) }, amman(3, 12), AMMAN)).toBe('محاولة 4 من 5 — جاهز بكرة الساعة 10:00');
    expect(cadenceCardWords({ counted: 3, due: false, waiting: true, dueAt: amman(22, 10) }, amman(19, 17), AMMAN)).toBe('محاولة 4 من 5 — جاهز الأحد الساعة 10:00');
    expect(cadenceCardWords({ counted: 4, due: false, waiting: true, dueAt: amman(3, 18) }, t, AMMAN)).toBe('محاولة 5 من 5 — جاهز الساعة 18:00');
  });

  it('null for no counted attempt (a NEW order keeps its own words) and for a complete plan', () => {
    expect(cadenceCardWords({ counted: 0, due: false, waiting: false, dueAt: null }, t, AMMAN)).toBeNull();
    expect(cadenceCardWords({ counted: 5, due: false, waiting: false, dueAt: null }, t, AMMAN)).toBeNull();
  });

  it('Western digits, never «جولة», and the due it prints is the constants’ own clock: 10:00 for #4, 18:00 for #5', () => {
    const s = cadenceCardWords({ counted: 3, due: false, waiting: true, dueAt: amman(4, 10) }, amman(3, 12), AMMAN)!;
    expect(s).not.toMatch(/[٠-٩A-Za-z]/);
    expect(s).not.toContain('جولة');
    expect(s).toContain(CADENCE_WORKDAY_START);
    expect(cadenceCardWords({ counted: 4, due: false, waiting: true, dueAt: amman(3, 18) }, t, AMMAN)).toContain(CADENCE_EVENING_FROM);
  });
});
