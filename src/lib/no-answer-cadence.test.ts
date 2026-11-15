import { describe, expect, it } from 'vitest';
import { zonedParts, zonedTimeToInstant } from './business-calendar';
import { NO_ANSWER_LIMIT } from './confirmation-workflow';
import {
  CADENCE_EVENING,
  CADENCE_GAPS_MS,
  CADENCE_LIMIT,
  CADENCE_MIN_DAYS,
  CADENCE_MORNING,
  CADENCE_START,
  cadenceCardWords,
  cadenceCloses,
  cadenceDesk,
  cadencePress,
  cadencePressWords,
  cadenceState,
  cadenceStep,
  cadenceVerdict,
  cadenceWhen,
  type CadenceCal,
  type CadenceState,
} from './no-answer-cadence';
import type { DueVerdict } from './work-first';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE FIVE-ATTEMPT PLAN AS ONE PURE RULE (step B of Confirmation Center v2)
 *
 *  1. #1 counts and sets #2's due at +30 min; #2 sets #3's at +2 h (elapsed time); #3 sets #4's at 09:00 of the NEXT local day; #4 sets #5's at the first 18:00 STRICTLY after it.
 *  2. A press at the due to the millisecond counts; one millisecond before is EARLY — kept, never counted, and the state (the due) does not move.
 *  3. A line at or before the floor (`enabledAt`) never counts; a sixth press after the fifth never counts.
 *  4. Only NO_ANSWER / BUSY / UNREACHABLE are attempts; everything else neither counts nor resets. Any employee's line counts.
 *  5. The fifth counted attempt closes the order across at least two local days — and under the plan five counted attempts always span two.
 *  6. Replaying the stored lines (`cadenceState`) equals deciding them one by one at the door (`cadencePress`), even when the clock and the attempt numbers disagree.
 *  7. The words are server-written, in Western digits, never say «جولة», and take their numbers from the constants.
 *
 * `no-answer-cadence-oracle.test.ts` holds the same rule a SECOND time, written the other way round.
 * ═══════════════════════════════════════════════════════════════════════
 */

const AMMAN = 'Asia/Amman';
const SINCE = new Date('2026-11-01T00:00:00.000Z');
const cal = (timeZone = AMMAN, since = SINCE): CadenceCal => ({ since, timeZone });
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
/** A plan whose fourth attempt is exactly at `t4`, with the third two days before (so the 09:00 due has long passed). */
function upToFourth(c: CadenceCal, t4: Date) {
  const t3 = ms(t4, -48 * 3_600_000);
  return chain(c, [ms(t3, -150 * 60_000), ms(t3, -120 * 60_000), t3, t4]);
}

describe('the constants', () => {
  it('five attempts over two days, 30 minutes and 2 hours, 9–12 and 18–22 — and the switch-off limit is still 3', () => {
    expect(CADENCE_LIMIT).toBe(5);
    expect(CADENCE_MIN_DAYS).toBe(2);
    expect(CADENCE_GAPS_MS).toEqual({ afterFirst: 30 * 60_000, afterSecond: 2 * 3_600_000 });
    expect(CADENCE_MORNING).toEqual({ from: 9, to: 12 });
    expect(CADENCE_EVENING).toEqual({ from: 18, to: 22 });
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

describe('#3 → #4: 09:00 of the next local day', () => {
  it.each([
    ['08:59', [3, 8, 59, 0, 0], '2026-11-04 09:00'],
    ['09:00', [3, 9, 0, 0, 0], '2026-11-04 09:00'],
    ['23:59:59.999', [3, 23, 59, 59, 999], '2026-11-04 09:00'],
    ['00:00:00.000 (~33 h)', [3, 0, 0, 0, 0], '2026-11-04 09:00'],
    ['00:05 (~33 h)', [3, 0, 5, 0, 0], '2026-11-04 09:00'],
  ] as const)('#3 at %s → %s', (_n, [d, h, mi, s, m], due) => {
    const state = upToThird(cal(), amman(d, h, mi, s, m));
    expect(hhmm(state.dueAt!)).toBe(due);
  });

  it('carries month ends, year ends and leap days', () => {
    expect(hhmm(upToThird(cal(), local(AMMAN, 2026, 11, 30, 20)).dueAt!)).toBe('2026-12-01 09:00');
    expect(hhmm(upToThird(cal(), local(AMMAN, 2026, 12, 31, 20)).dueAt!)).toBe('2027-01-01 09:00');
    expect(hhmm(upToThird(cal(), local(AMMAN, 2027, 1, 31, 20)).dueAt!)).toBe('2027-02-01 09:00');
    expect(hhmm(upToThird(cal(), local(AMMAN, 2028, 2, 29, 20)).dueAt!)).toBe('2028-03-01 09:00');
  });

  it('Berlin, Saturday 22:00 on the night before the spring-forward → Sunday 09:00 CEST', () => {
    const BER = 'Europe/Berlin';
    const due = upToThird(cal(BER, new Date('2026-03-01T00:00:00Z')), local(BER, 2026, 3, 28, 22)).dueAt!;
    expect(hhmm(due, BER)).toBe('2026-03-29 09:00');
    expect(due.toISOString()).toBe('2026-03-29T07:00:00.000Z');
  });
});

describe('#4 → #5: the first 18:00 strictly after', () => {
  it.each([
    ['17:59:59.999', [10, 17, 59, 59, 999], '2026-11-10 18:00'],
    ['18:00:00.000 (strictly after → tomorrow)', [10, 18, 0, 0, 0], '2026-11-11 18:00'],
    ['18:00:00.001', [10, 18, 0, 0, 1], '2026-11-11 18:00'],
    ['23:59', [10, 23, 59, 0, 0], '2026-11-11 18:00'],
    ['00:00', [10, 0, 0, 0, 0], '2026-11-10 18:00'],
    ['09:00', [10, 9, 0, 0, 0], '2026-11-10 18:00'],
  ] as const)('#4 at %s → %s', (_n, [d, h, mi, s, m], due) => {
    expect(hhmm(upToFourth(cal(), amman(d, h, mi, s, m)).dueAt!)).toBe(due);
  });

  it('a #4 counted at 17:55 makes #5 due five minutes later (the literal plan, planner question Q3)', () => {
    const s = upToFourth(cal(), amman(10, 17, 55));
    expect(s.dueAt).toEqual(amman(10, 18, 0));
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
    const s5 = chain(cal(), [t, ms(t, 1_800_000), ms(t, 1_800_000 + 7_200_000), amman(4, 9), amman(4, 18)]);
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
    const s4 = chain(cal(), [t, ms(t, 1_800_000), ms(t, 1_800_000 + 7_200_000), amman(4, 9)]);
    expect(cadenceCloses(s4)).toBe(false);
    const s5 = chain(cal(), [t, ms(t, 1_800_000), ms(t, 1_800_000 + 7_200_000), amman(4, 9), amman(4, 18)]);
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
    const four = [t, ms(t, 1_800_000), ms(t, 1_800_000 + 7_200_000), amman(4, 9)].map((d, i) => row(d, 'NO_ANSWER', i + 1));
    const fifth = cadencePress(four, { at: amman(4, 18), result: 'UNREACHABLE' }, cal());
    expect(fifth).toMatchObject({ counted: true, dueAt: null, closes: true });
  });

  it('a sixth no-answer after a refused close asks the close again', () => {
    const t = amman(3, 11);
    const five = [t, ms(t, 1_800_000), ms(t, 1_800_000 + 7_200_000), amman(4, 9), amman(4, 18)].map((d, i) => row(d, 'NO_ANSWER', i + 1));
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

  it('stepping press by press equals the replay of the stored rows, for 200 random sequences per zone (and 5 counted always span two days)', () => {
    for (const tz of ZONES) {
      const c = cal(tz, new Date('2026-01-01T00:00:00Z'));
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
  });
});

describe('the words', () => {
  const t = amman(3, 11);

  it('cadenceWhen: a time today, «بكرة» across midnight, and the two windows from the constants', () => {
    expect(cadenceWhen(2, ms(t, 1_800_000), t, AMMAN)).toBe('الساعة 11:30');
    expect(cadenceWhen(2, amman(4, 0, 20), amman(3, 23, 50), AMMAN)).toBe('بكرة الساعة 00:20');
    expect(cadenceWhen(4, amman(4, 9), amman(3, 12), AMMAN)).toBe('بكرة بين 9 و12');
    expect(cadenceWhen(4, amman(4, 9), amman(4, 8), AMMAN)).toBe('بين 9 و12');
    expect(cadenceWhen(5, amman(4, 18), amman(4, 10), AMMAN)).toBe('بين 6 و10 مساءً');
    expect(cadenceWhen(5, amman(5, 18), amman(4, 19), AMMAN)).toBe('بكرة بين 6 و10 مساءً');
  });

  it('cadencePressWords: every sentence, exactly', () => {
    const base = { now: t, timeZone: AMMAN };
    expect(cadencePressWords({ ...base, counted: true, closed: false, released: true, attempt: 1, dueAt: ms(t, 1_800_000) })).toBe(
      'انحسبت المحاولة 1 من 5 — رجع الطلب للطابور، والمحاولة الجاية الساعة 11:30.'
    );
    expect(cadencePressWords({ ...base, counted: true, closed: false, released: false, attempt: 3, dueAt: amman(4, 9), now: amman(3, 12) })).toBe(
      'انحسبت المحاولة 3 من 5 — المحاولة الجاية بكرة بين 9 و12.'
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
      cadenceWhen(2, ms(t, 1_800_000), t, AMMAN),
      cadenceWhen(4, amman(4, 9), amman(3, 12), AMMAN),
      cadenceWhen(5, amman(4, 18), amman(4, 10), AMMAN),
      cadencePressWords({ now: t, timeZone: AMMAN, counted: true, closed: false, released: true, attempt: 2, dueAt: ms(t, 7_200_000) }),
      cadencePressWords({ now: t, timeZone: AMMAN, counted: false, closed: false, released: false, attempt: 3, dueAt: amman(4, 9) }),
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
  const four = [t, ms(t, 1_800_000), ms(t, 1_800_000 + 7_200_000), amman(4, 9)].map((d, i) => row(d, i + 1));
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

describe('cadenceCardWords: the line a held card prints', () => {
  const t = amman(3, 11);

  it('due: «لا يرد راجع — محاولة n من 5»; waiting: «محاولة n من 5 — جاهز …» (today, tomorrow, the two windows)', () => {
    expect(cadenceCardWords({ counted: 2, due: true, waiting: false, dueAt: t }, t, AMMAN)).toBe('لا يرد راجع — محاولة 3 من 5');
    expect(cadenceCardWords({ counted: 1, due: false, waiting: true, dueAt: amman(3, 17, 30) }, t, AMMAN)).toBe('محاولة 2 من 5 — جاهز الساعة 17:30');
    expect(cadenceCardWords({ counted: 1, due: false, waiting: true, dueAt: amman(4, 0, 20) }, amman(3, 23, 50), AMMAN)).toBe('محاولة 2 من 5 — جاهز بكرة الساعة 00:20');
    expect(cadenceCardWords({ counted: 3, due: false, waiting: true, dueAt: amman(4, 9) }, amman(3, 12), AMMAN)).toBe('محاولة 4 من 5 — جاهز بكرة بين 9 و12');
    expect(cadenceCardWords({ counted: 4, due: false, waiting: true, dueAt: amman(3, 18) }, t, AMMAN)).toBe('محاولة 5 من 5 — جاهز بين 6 و10 مساءً');
  });

  it('null for no counted attempt (a NEW order keeps its own words) and for a complete plan', () => {
    expect(cadenceCardWords({ counted: 0, due: false, waiting: false, dueAt: null }, t, AMMAN)).toBeNull();
    expect(cadenceCardWords({ counted: 5, due: false, waiting: false, dueAt: null }, t, AMMAN)).toBeNull();
  });

  it('Western digits, never «جولة», and a window changes with its constant’s numbers', () => {
    const s = cadenceCardWords({ counted: 3, due: false, waiting: true, dueAt: amman(4, 9) }, amman(3, 12), AMMAN)!;
    expect(s).not.toMatch(/[٠-٩A-Za-z]/);
    expect(s).not.toContain('جولة');
    expect(s).toContain(`${CADENCE_MORNING.from} و${CADENCE_MORNING.to}`);
    expect(cadenceCardWords({ counted: 4, due: false, waiting: true, dueAt: amman(3, 18) }, t, AMMAN)).toContain(`${CADENCE_EVENING.from - 12} و${CADENCE_EVENING.to - 12}`);
  });
});
