import { describe, expect, it } from 'vitest';
import { MEASURE_RULE, MEASURE_THRESHOLDS_SECONDS, tallyMeasure, type MeasureLine } from './no-answer-measure';

/**
 * ═════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE NO-ANSWER MEASUREMENT REPORT PAIRS EACH LINE WITH HER PRESS (step G1)
 *
 *  1. A «لا يرد» line (no answer, busy, unreachable) is paired with HER «اتصل» press on the SAME order directly before it (no other result of hers between); the gap is the ring.
 *  2. Under 30 s / 1 min / 2 min is a strict «less than»: exactly 30 s is not under 30 s.
 *  3. A line with no press is counted apart and is NOT in the base of the three shares; a press that ended in another result is spent and does not pair with a later line.
 *  4. Shares carry their counts; a zero base is `rate: null` (a dash).
 *  5. By the store's clock, one row per agent per day, newest day first then by name; a colleague's lines never mix.
 * ═════════════════════════════════════════════════════════════════
 */

const names = new Map([['u1', 'سارة'], ['u2', 'هدى']]);
const t = (hms: string, day = '2026-11-10') => new Date(`${day}T${hms}Z`);
const line = (userId: string, orderId: string, result: string, hms: string, day?: string): MeasureLine => ({ userId, orderId, result, at: t(hms, day) });
const rowOf = (lines: MeasureLine[], user = 'u1', tz = 'UTC') => tallyMeasure(lines, names, tz).find((r) => r.userId === user)!;
const under = (r: ReturnType<typeof rowOf>, seconds: number) => r.under.find((u) => u.seconds === seconds)!;

describe('pairing', () => {
  it('a press and the «لا يرد» after it: the gap in seconds is the ring', () => {
    const r = rowOf([line('u1', 'o1', 'OPENED', '08:00:00'), line('u1', 'o1', 'NO_ANSWER', '08:00:20')]);
    expect(r).toMatchObject({ opened: 1, noAnswer: 1, withPress: 1, withoutPress: 0 });
    expect(under(r, 30)).toEqual({ seconds: 30, count: 1, rate: 100 });
  });

  it('the thresholds are strict: exactly 30 s is not under 30 s, 59.999 s is under a minute, 120 s is not under 2 minutes', () => {
    const a = rowOf([line('u1', 'o1', 'OPENED', '08:00:00'), line('u1', 'o1', 'NO_ANSWER', '08:00:30')]);
    expect(under(a, 30).count).toBe(0);
    expect(under(a, 60).count).toBe(1);
    const b = rowOf([line('u1', 'o2', 'OPENED', '08:00:00'), { userId: 'u1', orderId: 'o2', result: 'BUSY', at: new Date(t('08:00:00').getTime() + 59_999) }]);
    expect(under(b, 60).count).toBe(1);
    const c = rowOf([line('u1', 'o3', 'OPENED', '08:00:00'), line('u1', 'o3', 'UNREACHABLE', '08:02:00')]);
    expect(under(c, 120).count).toBe(0);
  });

  it('busy and unreachable are «لا يرد» too', () => {
    const r = rowOf([line('u1', 'o1', 'OPENED', '08:00:00'), line('u1', 'o1', 'BUSY', '08:00:10'), line('u1', 'o2', 'OPENED', '08:05:00'), line('u1', 'o2', 'UNREACHABLE', '08:05:15')]);
    expect(r.noAnswer).toBe(2);
    expect(r.withPress).toBe(2);
  });

  it('a line with no press before it is counted apart and is not in the shares\' base', () => {
    const r = rowOf([line('u1', 'o1', 'NO_ANSWER', '08:00:10'), line('u1', 'o2', 'OPENED', '08:01:00'), line('u1', 'o2', 'NO_ANSWER', '08:01:10')]);
    expect(r).toMatchObject({ noAnswer: 2, withPress: 1, withoutPress: 1 });
    expect(under(r, 30)).toEqual({ seconds: 30, count: 1, rate: 100 });
  });

  it('a press spent by another result does not pair with a later line; a second press pairs with its own line', () => {
    const r = rowOf([
      line('u1', 'o1', 'OPENED', '08:00:00'),
      line('u1', 'o1', 'ANSWERED', '08:00:40'), // the press ended in an answer
      line('u1', 'o1', 'NO_ANSWER', '08:05:00'), // a later line with no press of its own
      line('u1', 'o1', 'OPENED', '08:10:00'),
      line('u1', 'o1', 'NO_ANSWER', '08:10:25'),
    ]);
    expect(r).toMatchObject({ opened: 2, noAnswer: 2, withPress: 1, withoutPress: 1 });
    expect(under(r, 30).count).toBe(1);
  });

  it('a message between the press and the line does not spend the press', () => {
    const r = rowOf([line('u1', 'o1', 'OPENED', '08:00:00'), line('u1', 'o1', 'MESSAGE_SENT', '08:00:05'), line('u1', 'o1', 'NO_ANSWER', '08:00:20')]);
    expect(r.withPress).toBe(1);
  });

  it('a colleague\'s press on the same order is not mine to pair with', () => {
    const r = rowOf([line('u2', 'o1', 'OPENED', '08:00:00'), line('u1', 'o1', 'NO_ANSWER', '08:00:10')]);
    expect(r).toMatchObject({ opened: 0, noAnswer: 1, withPress: 0, withoutPress: 1 });
  });
});

describe('the shares', () => {
  it('print their counts and a zero base is a dash, never 0', () => {
    const none = rowOf([line('u1', 'o1', 'OPENED', '08:00:00')]);
    expect(none.under.every((u) => u.rate === null && u.count === 0)).toBe(true);
    const mixed = rowOf([
      line('u1', 'a', 'OPENED', '08:00:00'), line('u1', 'a', 'NO_ANSWER', '08:00:10'),
      line('u1', 'b', 'OPENED', '08:01:00'), line('u1', 'b', 'NO_ANSWER', '08:02:45'),
      line('u1', 'c', 'OPENED', '08:02:00'), line('u1', 'c', 'NO_ANSWER', '08:05:00'),
      line('u1', 'd', 'OPENED', '08:06:00'), line('u1', 'd', 'NO_ANSWER', '08:06:50'),
    ]);
    expect(MEASURE_THRESHOLDS_SECONDS).toEqual([30, 60, 120]);
    expect(mixed.under.map((u) => [u.seconds, u.count, u.rate])).toEqual([[30, 1, 25], [60, 2, 50], [120, 3, 75]]);
    expect(mixed.withPress).toBe(4);
  });
});

describe('rows', () => {
  it('are one per agent per local day, newest first then by name, by the store\'s clock', () => {
    const lines = [
      line('u1', 'o1', 'OPENED', '23:30:00', '2026-11-10'), line('u1', 'o1', 'NO_ANSWER', '23:30:10', '2026-11-10'),
      line('u2', 'o2', 'OPENED', '08:00:00', '2026-11-11'), line('u2', 'o2', 'NO_ANSWER', '08:00:10', '2026-11-11'),
      line('u1', 'o3', 'OPENED', '08:00:00', '2026-11-11'), line('u1', 'o3', 'NO_ANSWER', '08:00:10', '2026-11-11'),
    ];
    expect(tallyMeasure(lines, names, 'UTC').map((r) => `${r.day}|${r.name}`)).toEqual(['2026-11-11|سارة', '2026-11-11|هدى', '2026-11-10|سارة']);
    // in Damascus (UTC+3) the 23:30 UTC line is already the next day
    expect(tallyMeasure(lines, names, 'Asia/Damascus').map((r) => `${r.day}|${r.name}`)).toEqual(['2026-11-11|سارة', '2026-11-11|هدى']);
  });

  it('the rule is in Arabic with Western digits and says what is outside the base', () => {
    expect(MEASURE_RULE).toContain('ما بيدخل بقاعدة النسب');
    expect(MEASURE_RULE).not.toMatch(/[٠-٩]/);
  });
});
