import { describe, expect, it } from 'vitest';
import { businessMinutesBetween, zonedTimeToInstant } from './business-calendar';
import {
  REPULL_RELEASE_REASON,
  ROUND_RELEASE_REASON,
  countedRounds,
  releaseCutoffs,
  roundsClose,
  roundsOn,
  roundsReleaseReason,
  workClock,
  type AttemptFact,
} from './no-answer-rounds';
import { parseRoundsSwitch } from './no-answer-rounds-switch';

/**
 * «نظام الجولات» — the rules with nothing read (no-answer-rounds.ts).
 *
 * Amman, 09:00–17:00, Friday and Saturday off. 1 November 2026 is a Sunday: Thu = 5, Fri 6 and Sat 7 are the weekend,
 * Sun = 8.
 */
const JO = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' };
const t = (day: number, h: number, m = 0) => zonedTimeToInstant(JO.timezone, 2026, 11, day, h, m);
const clock = () => workClock(JO);

const opened = (at: Date, by = 'sara'): AttemptFact => ({ createdAt: at, result: 'OPENED', employeeId: by });
const noAnswer = (at: Date, by = 'sara', result = 'NO_ANSWER'): AttemptFact => ({ createdAt: at, result, employeeId: by });
/** «اتصل» a minute before, then «لا يرد» — what the desk logs for one real call. */
const call = (at: Date, by = 'sara', result = 'NO_ANSWER'): AttemptFact[] => [
  opened(new Date(at.getTime() - 60_000), by),
  noAnswer(at, by, result),
];

describe('the working clock agrees with businessMinutesBetween', () => {
  it('on hundreds of pairs, weekends and nights included', () => {
    const c = clock();
    let seed = 7;
    const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
    const base = t(1, 0).getTime();
    for (let i = 0; i < 400; i++) {
      const a = new Date(base + Math.floor(rnd() * 20 * 86_400_000));
      const b = new Date(a.getTime() + Math.floor(rnd() * 6 * 86_400_000));
      expect(c.minutesBetween(a, b), `${a.toISOString()} → ${b.toISOString()}`).toBe(businessMinutesBetween(a, b, JO));
    }
  });

  it('and «back» is the latest instant with that many working minutes before now', () => {
    const c = clock();
    for (const now of [t(1, 10), t(1, 20), t(8, 9, 30), t(8, 11), t(6, 12), t(5, 16, 59), t(9, 9)]) {
      for (const minutes of [90, 180]) {
        const cut = c.back(now, minutes);
        expect(businessMinutesBetween(cut, now, JO), `${now.toISOString()} −${minutes}`).toBe(minutes);
        expect(businessMinutesBetween(new Date(cut.getTime() + 60_000), now, JO)).toBeLessThan(minutes);
      }
    }
  });

  it('and names the local day, not the UTC one', () => {
    // 01:30 in Amman is still the previous evening in UTC.
    expect(clock().dayKey(t(2, 1, 30))).toBe('2026-11-02');
  });
});

describe('R2 · R5 — what counts as a round', () => {
  it('presses within three working hours are ONE round', () => {
    const attempts = [...call(t(1, 10)), ...call(t(1, 11)), ...call(t(1, 12, 59))];
    expect(countedRounds(attempts, clock()).counted).toHaveLength(1);
  });

  it('and the press three working hours after the round started is the next one', () => {
    const attempts = [...call(t(1, 10)), ...call(t(1, 11)), ...call(t(1, 13))];
    expect(countedRounds(attempts, clock()).counted).toHaveLength(2);
  });

  it('BUSY and UNREACHABLE are no-answers like NO_ANSWER', () => {
    const attempts = [...call(t(1, 9)), ...call(t(1, 12), 'sara', 'BUSY'), ...call(t(1, 15), 'sara', 'UNREACHABLE')];
    expect(countedRounds(attempts, clock()).counted).toHaveLength(3);
  });

  it('a no-answer with no «اتصل» before it is not counted (R5)', () => {
    expect(countedRounds([noAnswer(t(1, 10)), noAnswer(t(1, 14))], clock()).counted).toHaveLength(0);
  });

  it('and a «اتصل» by a colleague proves nothing about her press', () => {
    expect(countedRounds([opened(t(1, 9, 59), 'huda'), noAnswer(t(1, 10), 'sara')], clock()).counted).toHaveLength(0);
  });

  it('and the «اتصل» must come after the previous counted round, not before it', () => {
    // One «اتصل», then two presses three hours apart: the first counts, the second has no dial of its own.
    const attempts = [opened(t(1, 9, 59)), noAnswer(t(1, 10)), noAnswer(t(1, 13, 30))];
    expect(countedRounds(attempts, clock()).counted).toHaveLength(1);
  });

  it('the weekend does not count toward the three hours', () => {
    // Thursday 15:00, then Sunday: 120 minutes on Thursday + 59 on Sunday = 179 — still the same round.
    expect(countedRounds([...call(t(5, 15)), ...call(t(8, 9, 59))], clock()).counted).toHaveLength(1);
    expect(countedRounds([...call(t(5, 15)), ...call(t(8, 10))], clock()).counted).toHaveLength(2);
  });

  it('nor do the hours after closing', () => {
    // 16:00, then 20:00 the same evening (one working hour between), then the next morning at 11:00 (three).
    const c = clock();
    expect(countedRounds([...call(t(1, 16)), ...call(t(1, 20))], c).counted).toHaveLength(1);
    expect(countedRounds([...call(t(1, 16)), ...call(t(1, 20)), ...call(t(2, 11))], c).counted).toHaveLength(2);
  });
});

describe('R3 — the close', () => {
  it('three rounds on ONE day close nothing', () => {
    const rounds = countedRounds([...call(t(1, 9)), ...call(t(1, 12)), ...call(t(1, 15))], clock());
    expect(rounds.counted).toHaveLength(3);
    expect(rounds.days).toBe(1);
    expect(roundsClose(rounds)).toBe(false);
  });

  it('three rounds over two days close it', () => {
    const rounds = countedRounds([...call(t(1, 9)), ...call(t(1, 12)), ...call(t(2, 10))], clock());
    expect(rounds.counted).toHaveLength(3);
    expect(rounds.days).toBe(2);
    expect(roundsClose(rounds)).toBe(true);
  });

  it('and a fourth round on the next day closes the order that waited', () => {
    const rounds = countedRounds([...call(t(1, 9)), ...call(t(1, 12)), ...call(t(1, 15)), ...call(t(2, 10))], clock());
    expect(roundsClose(rounds)).toBe(true);
  });

  it('two rounds never close, whatever the days', () => {
    expect(roundsClose(countedRounds([...call(t(1, 9)), ...call(t(2, 12))], clock()))).toBe(false);
  });

  it('never more rounds than no-answers: ON can only close later than OFF', () => {
    let seed = 11;
    const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
    const results = ['NO_ANSWER', 'BUSY', 'OPENED', 'ANSWERED', 'UNREACHABLE', 'MESSAGE_SENT'];
    for (let i = 0; i < 200; i++) {
      const attempts: AttemptFact[] = Array.from({ length: 1 + Math.floor(rnd() * 12) }, () => ({
        createdAt: new Date(t(1, 9).getTime() + Math.floor(rnd() * 5 * 86_400_000)),
        result: results[Math.floor(rnd() * results.length)],
        employeeId: rnd() < 0.8 ? 'sara' : 'huda',
      }));
      const offCount = attempts.filter((a) => ['NO_ANSWER', 'BUSY', 'UNREACHABLE'].includes(a.result)).length;
      expect(countedRounds(attempts, clock()).counted.length).toBeLessThanOrEqual(offCount);
    }
  });
});

describe('R1 — when a held order goes back to the queue', () => {
  const on = { enabledAt: t(1, 8) };
  const cutAt = (now: Date) => releaseCutoffs(now, clock());
  const held = { claimedAt: t(1, 9) };

  it('three working hours after the first no-answer of the run, not a minute before', () => {
    const attempts = call(t(1, 9, 30));
    expect(roundsReleaseReason(held, attempts, on, cutAt(t(1, 12, 29)), t(1, 12, 29))).toBeNull();
    expect(roundsReleaseReason(held, attempts, on, cutAt(t(1, 12, 30)), t(1, 12, 30))).toBe(ROUND_RELEASE_REASON);
  });

  it('presses inside the three hours do not restart them', () => {
    const attempts = [...call(t(1, 9, 30)), ...call(t(1, 11)), ...call(t(1, 12))];
    expect(roundsReleaseReason(held, attempts, on, cutAt(t(1, 12, 30)), t(1, 12, 30))).toBe(ROUND_RELEASE_REASON);
  });

  it('a no-answer with no «اتصل» still starts the three hours', () => {
    expect(roundsReleaseReason(held, [noAnswer(t(1, 9, 30))], on, cutAt(t(1, 12, 30)), t(1, 12, 30))).toBe(ROUND_RELEASE_REASON);
  });

  it('a call that reached somebody ends the run, and a no-answer after it starts a new one', () => {
    const reached = [...call(t(1, 9, 30)), { createdAt: t(1, 10), result: 'ANSWERED', employeeId: 'sara' }];
    expect(roundsReleaseReason(held, reached, on, cutAt(t(1, 16)), t(1, 16))).toBeNull();
    const again = [...reached, ...call(t(1, 11))];
    expect(roundsReleaseReason(held, again, on, cutAt(t(1, 13, 59)), t(1, 13, 59))).toBeNull();
    expect(roundsReleaseReason(held, again, on, cutAt(t(1, 14)), t(1, 14))).toBe(ROUND_RELEASE_REASON);
  });

  it('«اتصل» and a sent message are neither: they do not end the run', () => {
    const attempts = [...call(t(1, 9, 30)), { createdAt: t(1, 10), result: 'MESSAGE_SENT', employeeId: 'sara' }];
    expect(roundsReleaseReason(held, attempts, on, cutAt(t(1, 12, 30)), t(1, 12, 30))).toBe(ROUND_RELEASE_REASON);
  });

  it('the weekend is frozen', () => {
    const thursday = { claimedAt: t(5, 15) };
    const attempts = call(t(5, 16));
    expect(roundsReleaseReason(thursday, attempts, on, cutAt(t(8, 10, 59)), t(8, 10, 59))).toBeNull();
    expect(roundsReleaseReason(thursday, attempts, on, cutAt(t(8, 11)), t(8, 11))).toBe(ROUND_RELEASE_REASON);
    // Nothing moves on Saturday afternoon either.
    expect(roundsReleaseReason(thursday, attempts, on, cutAt(t(7, 15)), t(7, 15))).toBeNull();
  });

  it('a date ahead keeps it with her', () => {
    const attempts = call(t(1, 9, 30));
    const now = t(1, 16);
    expect(roundsReleaseReason({ ...held, postponedUntil: t(3, 10) }, attempts, on, cutAt(now), now)).toBeNull();
    expect(roundsReleaseReason({ ...held, nextFollowUpAt: t(1, 17) }, attempts, on, cutAt(now), now)).toBeNull();
    // A date that has passed does not.
    expect(roundsReleaseReason({ ...held, nextFollowUpAt: t(1, 9) }, attempts, on, cutAt(now), now)).toBe(ROUND_RELEASE_REASON);
  });

  it('SWITCH-ON TIME: what was logged before it never moves an order', () => {
    // Held since Thursday with two no-answers on Thursday; switched on Sunday at noon.
    const old = { claimedAt: t(5, 9) };
    const attempts = [...call(t(5, 10)), ...call(t(5, 14))];
    const sw = { enabledAt: t(8, 12) };
    expect(roundsReleaseReason(old, attempts, sw, cutAt(t(8, 12)), t(8, 12))).toBeNull();
    expect(roundsReleaseReason(old, attempts, sw, cutAt(t(9, 16)), t(9, 16)), 'old attempts started a run').toBeNull();
    // A no-answer after the switch starts the clock.
    const after = [...attempts, ...call(t(8, 13))];
    expect(roundsReleaseReason(old, after, sw, cutAt(t(8, 15, 59)), t(8, 15, 59))).toBeNull();
    expect(roundsReleaseReason(old, after, sw, cutAt(t(8, 16)), t(8, 16))).toBe(ROUND_RELEASE_REASON);
  });

  it('a no-answer from before she took it is not hers', () => {
    const repulled = { claimedAt: t(1, 14) };
    const attempts = [...call(t(1, 10)), ...call(t(1, 14, 30))];
    expect(roundsReleaseReason(repulled, attempts, on, cutAt(t(1, 16)), t(1, 16))).toBeNull();
    expect(roundsReleaseReason(repulled, attempts, on, cutAt(t(2, 10, 30)), t(2, 10, 30))).toBe(ROUND_RELEASE_REASON);
  });

  it('re-pulled and untouched: ninety working minutes after she took it', () => {
    const repulled = { claimedAt: t(1, 14) };
    const attempts = call(t(1, 10));
    expect(roundsReleaseReason(repulled, attempts, on, cutAt(t(1, 15, 29)), t(1, 15, 29))).toBeNull();
    expect(roundsReleaseReason(repulled, attempts, on, cutAt(t(1, 15, 30)), t(1, 15, 30))).toBe(REPULL_RELEASE_REASON);
  });

  it('and after the switch went on, when that is later', () => {
    const repulled = { claimedAt: t(1, 9) };
    const attempts = call(t(1, 8, 30));
    const sw = { enabledAt: t(1, 14) };
    expect(roundsReleaseReason(repulled, attempts, sw, cutAt(t(1, 15, 29)), t(1, 15, 29))).toBeNull();
    expect(roundsReleaseReason(repulled, attempts, sw, cutAt(t(1, 15, 30)), t(1, 15, 30))).toBe(REPULL_RELEASE_REASON);
  });

  it('no attempt at all is the ninety-minute rule of today, not this one', () => {
    expect(roundsReleaseReason(held, [], on, cutAt(t(2, 16)), t(2, 16))).toBeNull();
  });
});

describe('the switch reads OFF unless it is plainly ON', () => {
  it.each([undefined, null, {}, { enabled: 'yes', enabledAt: '2026-11-01T00:00:00Z' }, { enabled: true }, { enabled: true, enabledAt: 'soon' }, { enabled: false, enabledAt: '2026-11-01T00:00:00Z' }])(
    '%j → off',
    (raw) => {
      expect(roundsOn(parseRoundsSwitch(raw))).toBe(false);
    }
  );

  it('on, with its moment', () => {
    const sw = parseRoundsSwitch({ enabled: true, enabledAt: '2026-11-01T06:00:00.000Z' });
    expect(roundsOn(sw)).toBe(true);
    expect(sw.enabledAt?.toISOString()).toBe('2026-11-01T06:00:00.000Z');
  });
});
