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
  closedCardWords,
  type CadenceCal,
  type CadenceState,
} from './no-answer-cadence';
import type { DueVerdict } from './work-first';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE FIVE-ATTEMPT PLAN AS ONE PURE RULE (step B of Confirmation Center v2)
 *
 *  1. #1 counts and sets #2's due at +30 min; #2 sets #3's at +2 h (elapsed time); #3 sets #4's at 10:00 on the first WORKING day at least 8 h (elapsed, exactly 8 h counts) after it; #4 sets
 *     #5's at the first 18:00 STRICTLY after it on a working day, never less than 3 h (elapsed) after it. Working days = all but the Country's rest days (`weekendDays`; none = skip nothing),
 *     and they move #4 and #5 only, never the 30-minute and 2-hour gaps. #4's clock is the constant 10:00, never the Country's `workHoursStart`.
 *  2. A press at the due to the millisecond counts; one millisecond before is EARLY — kept, never counted, and the state (the due) does not move.
 *  3. A line at or before the floor (`enabledAt`) never counts; a sixth press after the fifth never counts.
 *  4. Only NO_ANSWER / BUSY / UNREACHABLE are attempts; everything else neither counts nor resets. Any employee's line counts.
 *  5. The fifth counted attempt closes the order across at least two local days — and under the plan five counted attempts always span two, even on a 25-hour DST day (the first-day
 *     guard: #4 is never due on #1's local day), with or without rest days.
 *  6. Replaying the stored lines (`cadenceState`) equals deciding them one by one at the door (`cadencePress`), even when the clock and the attempt numbers disagree.
 *  7. The words are server-written, in Western digits, never say «جولة», and print the REAL due — «الساعة 10:00», «بكرة الساعة 18:00», «السبت الساعة 10:00» across a rest weekend; no windows.
 *
 * `no-answer-cadence-oracle.test.ts` holds the same rule a SECOND time, written the other way round.
 * ═══════════════════════════════════════════════════════════════════════
 */

const AMMAN = 'Asia/Amman';
const SINCE = new Date('2026-11-01T00:00:00.000Z');
const cal = (timeZone = AMMAN, since = SINCE, restDays?: readonly number[]): CadenceCal => ({ since, timeZone, ...(restDays ? { restDays } : {}) });
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
/** A plan whose third attempt is exactly at `t3` (the second exactly at its due, the first exactly 30 minutes before that). */
const upToThird = (c: CadenceCal, t3: Date) => chain(c, [ms(t3, -150 * 60_000), ms(t3, -120 * 60_000), t3]);
/**
 * A plan whose fourth attempt is exactly at `t4`, with the third `gapHours` before (default two days, so the 10:00 due has long passed). A rest-day wait is longer than two days
 * (Thursday 14:00 → Sunday 10:00 is 68 h), so a test with rest days gives the gap it needs — `chain` asserts that every press counts.
 */
function upToFourth(c: CadenceCal, t4: Date, gapHours = 48) {
  const t3 = ms(t4, -gapHours * 3_600_000);
  return chain(c, [ms(t3, -150 * 60_000), ms(t3, -120 * 60_000), t3, t4]);
}

describe('cadenceCalOf: the one builder of the plan’s world', () => {
  it('copies the floor, the timezone and the rest days — and nothing else of the country (never its work hours: #4’s clock is the planner’s fixed 10:00)', () => {
    const country = { timezone: 'Asia/Amman', weekendDays: [5, 6], workHoursStart: '09:00', workHoursEnd: '17:00', code: 'JO' };
    const built = cadenceCalOf(SINCE, country);
    expect(built).toEqual({ since: SINCE, timeZone: 'Asia/Amman', restDays: [5, 6] });
    expect(Object.keys(built).sort()).toEqual(['restDays', 'since', 'timeZone']);
  });

  it('a country without rest days (null, undefined, or a mock that lacks the field) → no rest days key value; an empty list stays empty', () => {
    expect(cadenceCalOf(SINCE, { timezone: AMMAN }).restDays).toBeUndefined();
    expect(cadenceCalOf(SINCE, { timezone: AMMAN, weekendDays: null }).restDays).toBeUndefined();
    expect(cadenceCalOf(SINCE, { timezone: AMMAN, weekendDays: [] }).restDays).toEqual([]);
  });
});

describe('the constants', () => {
  it('five attempts over two days, 30 minutes and 2 hours, the 8 h and 3 h floors, #4 at 10:00 and #5 from 18:00 — and the switch-off limit is still 3', () => {
    expect(CADENCE_LIMIT).toBe(5);
    expect(CADENCE_MIN_DAYS).toBe(2);
    expect(CADENCE_GAPS_MS).toEqual({ afterFirst: 30 * 60_000, afterSecond: 2 * 3_600_000 });
    expect(CADENCE_FLOORS_MS).toEqual({ beforeFourth: 8 * 3_600_000, beforeFifth: 3 * 3_600_000 });
    expect(CADENCE_WORKDAY_START).toBe('10:00');
    expect(CADENCE_EVENING_FROM).toBe('18:00');
    expect(NO_ANSWER_LIMIT).toBe(3);
  });
});

describe('#1 and #2', () => {
  it('#1 always counts and sets #2’s due at exactly +30 minutes', () => {
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

  it('+30 minutes is elapsed time: 23:50 → 00:20 the next local day', () => {
    const t1 = amman(3, 23, 50);
    const due = cadenceStep(CADENCE_START, t1, cal()).next.dueAt!;
    expect(hhmm(due)).toBe('2026-11-04 00:20');
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

  it('#3’s due is exactly +7 200 000 ms across a spring-forward (not 02:30 local)', () => {
    const NY = 'America/New_York';
    const t1 = local(NY, 2026, 3, 8, 0, 0);
    const t2 = ms(t1, 1_800_000);
    const s = chain(cal(NY, new Date('2026-01-01T00:00:00Z')), [t1, t2]);
    expect(s.dueAt).toEqual(ms(t2, 7_200_000));
  });
});

describe('#3 → #4: 10:00 on the first working day at least 8 hours (elapsed) later', () => {
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
  ] as const)('#3 at %s → %s', (_n, [d, h, mi, s, m], due) => {
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

  it('the clock is the planner’s 10:00 whatever the country’s work hours say: the calendar is not told them', () => {
    // `cadenceCalOf` copies no work hours, so a country row that still reads 09:00 cannot bring the nine back.
    const c = cadenceCalOf(SINCE, { timezone: AMMAN, weekendDays: [], workHoursStart: '09:00' } as { timezone: string; weekendDays: number[] });
    expect(hhmm(upToThird(c, amman(3, 14)).dueAt!)).toBe('2026-11-04 10:00');
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
    const t3 = amman(3, 12);
    const s = chain(cal(), [ms(t3, -150 * 60_000), ms(t3, -120 * 60_000), t3, amman(5, 8)]);
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

  it('the Jordanian week end to end: Thursday 20:00 → 20:30 → 22:30 → Sunday 10:00 → Sunday 18:00 closes the order over two local days (about 3.9 days)', () => {
    const s = chain(rest, [amman(19, 20), amman(19, 20, 30), amman(19, 22, 30), amman(22, 10), amman(22, 18)]);
    expect(s.days).toBe(2);
    expect(cadenceCloses(s)).toBe(true);
  });

  it('the 30-minute and 2-hour gaps are elapsed time and never move for a rest day: Thursday 21:55 → #3 is due Friday 00:25', () => {
    const t1 = amman(19, 21, 55);
    const s1 = chain(rest, [t1]);
    expect(s1.dueAt).toEqual(amman(19, 22, 25));
    const s2 = chain(rest, [t1, s1.dueAt!]);
    expect(hhmm(s2.dueAt!)).toBe('2026-11-20 00:25');
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
    expect(hhmm(upToFourth(sixOff, amman(21, 10), 24 * 7).dueAt!)).toBe('2026-11-21 18:00');
    expect(hhmm(upToFourth(sixOff, amman(21, 19), 24 * 7).dueAt!)).toBe('2026-11-28 18:00');
  });
});

describe('five attempts over two local days, even on a 25-hour DST day: the first-day guard', () => {
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
  ] as const)('%s: #1 at 00:00, #2 +30 min, #3 +2 h (02:30 on the wall) → #4 is on the NEXT local day, five counted, two days, it closes', (tz, [y, mo, d], due4) => {
    const c = cal(tz, new Date('2026-01-01T00:00:00Z'));
    const t1 = local(tz, y, mo, d, 0, 0);
    const s = onTime(c, t1);
    expect(s.counted).toHaveLength(5);
    expect(hhmm(s.counted[3], tz)).toBe(due4);
    expect(dayOf(s.counted[3], tz)).not.toBe(dayOf(t1, tz));
    expect(s.days).toBeGreaterThanOrEqual(CADENCE_MIN_DAYS);
    expect(cadenceCloses(s)).toBe(true);
  });

  const ZONES = ['Asia/Amman', 'Asia/Damascus', 'Europe/Berlin', 'America/New_York', 'Asia/Beirut', 'Australia/Lord_Howe', 'Pacific/Auckland', 'Pacific/Chatham', 'Asia/Kathmandu'];
  /** The zone's offset from UTC at an instant, in ms — read from `zonedParts`, to the minute. */
  const offsetOf = (at: number, tz: string): number => {
    const p = zonedParts(new Date(at), tz);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(at / 60_000) * 60_000;
  };
  const dayOf = (d: Date, tz: string) => hhmm(d, tz).slice(0, 10);

  it('9 zones × every offset transition of 2026 × T1 at every quarter-hour from 36 h before to 36 h after it × no rest day, Friday, Friday+Saturday: the on-time chain spans two local days and closes', () => {
    const HOUR = 3_600_000;
    const transitionsPerZone = new Map<string, number>();
    let chains = 0;
    for (const tz of ZONES) {
      const c0 = cal(tz, new Date('2020-01-01T00:00:00Z'));
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
          const c: CadenceCal = restDays ? { ...c0, restDays } : c0;
          for (let at = transition - 36 * HOUR; at <= transition + 36 * HOUR; at += 15 * 60_000) {
            const s = onTime(c, new Date(at));
            chains++;
            if (s.days < CADENCE_MIN_DAYS || !cadenceCloses(s)) {
              throw new Error(`${tz} T1 ${new Date(at).toISOString()} rest ${JSON.stringify(restDays)}: days ${s.days}, closes ${cadenceCloses(s)}`);
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

  it('days are counted by LOCAL calendar day: 23:59 and 00:01 are two days; a 25 h DST day is one', () => {
    const NY = 'America/New_York';
    const a = cadenceStep(cadenceStep(CADENCE_START, amman(3, 23, 59), cal()).next, amman(4, 0, 29), cal());
    expect(a.next.days).toBe(2);
    const t1 = local(NY, 2026, 11, 1, 0, 5);
    const b = chain(cal(NY, new Date('2026-01-01T00:00:00Z')), [t1, ms(t1, 1_800_000)]);
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

  it.each([
    ['no rest days', undefined],
    ['Friday and Saturday off', REST_FRI_SAT],
  ] as const)('stepping press by press equals the replay of the stored rows, for 200 random sequences per zone (and 5 counted always span two days — the guard), %s', (_n, restDays) => {
    for (const tz of ZONES) {
      const c = cal(tz, new Date('2026-01-01T00:00:00Z'), restDays);
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
