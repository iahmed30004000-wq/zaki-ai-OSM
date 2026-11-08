import { describe, expect, it } from 'vitest';
import { addBusinessMinutes, businessMinutesBetween, zonedTimeToInstant } from './business-calendar';
import {
  DUE_RELEASE_BUSINESS_MINUTES,
  DUE_RELEASE_REASON,
  HOLDER_ACTIVE_BUSINESS_MINUTES,
  REPULL_RELEASE_BUSINESS_MINUTES,
  REPULL_RELEASE_REASON,
  ROUND_CLOSE_MIN_DAYS,
  ROUND_GAP_BUSINESS_MINUTES,
  ROUND_RELEASE_BUSINESS_MINUTES,
  ROUND_RELEASE_REASON,
  countedRounds,
  releaseCutoffs,
  roundsClose,
  roundsOn,
  roundsReleaseReason,
  sinceLastReached,
  workClock,
  type AttemptFact,
  type HeldFacts,
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
const logged = (at: Date, outcome: string, by = 'sara'): AttemptFact => ({ createdAt: at, result: outcome, employeeId: by });
/** «اتصل» a minute before, then «لا يرد» — what the desk logs for one real call. */
const call = (at: Date, by = 'sara', outcome = 'NO_ANSWER'): AttemptFact[] => [
  opened(new Date(at.getTime() - 60_000), by),
  noAnswer(at, by, outcome),
];

describe('the numbers of the rules — the owner, 8/11: twelve hours to let a run go (it was six), a hundred and eighty minutes for a round', () => {
  it('are written once, and the ones that did not change did not change', () => {
    expect(ROUND_RELEASE_BUSINESS_MINUTES, 'يبقى 12 ساعة عمل').toBe(720);
    expect(ROUND_GAP_BUSINESS_MINUTES, 'ما يعدّ جولة وحدة بقي 3 ساعات').toBe(180);
    expect(REPULL_RELEASE_BUSINESS_MINUTES).toBe(90);
    expect(HOLDER_ACTIVE_BUSINESS_MINUTES).toBe(15);
    expect(ROUND_CLOSE_MIN_DAYS).toBe(2);
    expect(DUE_RELEASE_BUSINESS_MINUTES, 'بعد موعد الطلب بـ3 ساعات عمل').toBe(180);
  });

  it('and the cut-offs of one pass are each that many working minutes back from now', () => {
    const now = t(2, 17);
    const cut = releaseCutoffs(now, clock());
    // Twelve working hours back from Monday 17:00: the 8 of Monday and 4 of Sunday.
    expect(cut.round).toEqual(t(1, 13));
    expect(cut.promise).toEqual(t(2, 14));
    expect(cut.repull).toEqual(t(2, 15, 30));
    expect(cut.recent).toEqual(t(2, 16, 45));
  });
});

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
      for (const minutes of [90, 180, 360]) {
        const cut = c.back(now, minutes);
        expect(businessMinutesBetween(cut, now, JO), `${now.toISOString()} −${minutes}`).toBe(minutes);
        expect(businessMinutesBetween(new Date(cut.getTime() + 60_000), now, JO)).toBeLessThan(minutes);
      }
    }
  });

  it('and «forward» is the earliest instant with that many working minutes after the start — the mirror of «back»', () => {
    const c = clock();
    for (const from of [t(1, 10), t(1, 20), t(8, 9, 30), t(8, 11), t(6, 12), t(5, 16, 59), t(9, 9), t(1, 17)]) {
      for (const minutes of [90, 180, 360, 720]) {
        const ready = c.forward(from, minutes);
        const label = `${from.toISOString()} +${minutes}`;
        expect(businessMinutesBetween(from, ready, JO), label).toBe(minutes);
        expect(businessMinutesBetween(from, new Date(ready.getTime() - 60_000), JO), label).toBeLessThan(minutes);
      }
    }
  });

  it('and, on random instants with seconds on them, it is exact to the millisecond against the clock’s own minutes', () => {
    const c = clock();
    let seed = 29;
    const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
    const base = t(1, 0).getTime();
    for (let i = 0; i < 80; i++) {
      const from = new Date(base + Math.floor(rnd() * 20 * 86_400_000));
      for (const minutes of [1, 90, 180, 360, 720]) {
        const ready = c.forward(from, minutes);
        const label = `${from.toISOString()} +${minutes}`;
        // Never fewer working minutes than asked — and one millisecond earlier there were fewer.
        expect(c.minutesBetween(from, ready), label).toBeGreaterThanOrEqual(minutes);
        expect(c.minutesBetween(from, new Date(ready.getTime() - 1)), label).toBeLessThan(minutes);
        // The calendar's own "add business minutes" says the same instant (to the float rounding of its minutes).
        expect(Math.abs(ready.getTime() - addBusinessMinutes(from, minutes, JO).getTime()), label).toBeLessThanOrEqual(1);
      }
    }
  });

  it('«forward» across the end of the day, a night and a weekend', () => {
    const c = clock();
    expect(c.forward(t(1, 10), 180)).toEqual(t(1, 13));
    // 16:00 Sunday: one hour left that day, two on Monday.
    expect(c.forward(t(1, 16), 180)).toEqual(t(2, 11));
    // After closing, counting starts when the day opens.
    expect(c.forward(t(1, 20), 180)).toEqual(t(2, 12));
    expect(c.forward(t(1, 3), 60)).toEqual(t(1, 10));
    // Thursday 15:00: two hours that day, Friday and Saturday frozen, one on Sunday.
    expect(c.forward(t(5, 15), 180)).toEqual(t(8, 10));
    // A moment on the closing minute counts nothing that day.
    expect(c.forward(t(1, 17), 1)).toEqual(t(2, 9, 1));
  });

  it('«forward» with no working day at all answers the end of time, as «back» answers the beginning of it', () => {
    const never = workClock({ ...JO, weekendDays: [0, 1, 2, 3, 4, 5, 6] });
    expect(never.forward(t(1, 10), 180).getTime()).toBe(8.64e15);
    expect(never.back(t(1, 10), 180).getTime()).toBe(-8.64e15);
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

  it('SIX hours to let a run go did not move the three hours of a round: two presses 3h apart are two rounds, 2h59 apart one', () => {
    // The release moved to six (R1); what counts as ONE round did not (R2). Both numbers live side by side in the same file.
    expect(countedRounds([...call(t(1, 9)), ...call(t(1, 11, 59))], clock()).counted).toHaveLength(1);
    expect(countedRounds([...call(t(1, 9)), ...call(t(1, 12))], clock()).counted).toHaveLength(2);
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

describe('the cycle — what has happened since the last call that reached somebody', () => {
  it('is every attempt when nobody was reached, oldest first, whatever order they come in', () => {
    const attempts = [noAnswer(t(1, 12)), opened(t(1, 9, 59)), noAnswer(t(1, 10))];
    expect(sinceLastReached(attempts).map((a) => a.createdAt)).toEqual([t(1, 9, 59), t(1, 10), t(1, 12)]);
  });

  it('starts after the last call that reached somebody — and is empty when that was the last thing that happened', () => {
    const reached = [...call(t(1, 9, 30)), logged(t(1, 10), 'ANSWERED')];
    expect(sinceLastReached(reached)).toEqual([]);
    expect(sinceLastReached([...reached, ...call(t(1, 11))])).toHaveLength(2);
    expect(sinceLastReached([])).toEqual([]);
  });

  it('a sent message and a «اتصل» do not end it; a wrong number and a callback request do', () => {
    expect(sinceLastReached([...call(t(1, 9, 30)), logged(t(1, 10), 'MESSAGE_SENT')])).toHaveLength(3);
    for (const result of ['WRONG_NUMBER', 'CALLBACK_REQUESTED', 'ANSWERED', 'OTHER']) {
      expect(sinceLastReached([...call(t(1, 9, 30)), logged(t(1, 10), result)]), result).toEqual([]);
    }
  });
});

/** The verdict at `now`, with the cut-offs that pass would have placed. */
const verdict = (order: HeldFacts, attempts: readonly AttemptFact[], sw: { enabledAt: Date }, now: Date) =>
  roundsReleaseReason(order, attempts, sw, releaseCutoffs(now, clock()));

describe('R1 — when a held order goes back to the queue', () => {
  const on = { enabledAt: t(1, 8) };
  const held = { claimedAt: t(1, 9) };

  it('TWELVE working hours after the first no-answer of the run: 11h59 stays, 12h00 goes (the owner, 8/11)', () => {
    const attempts = call(t(1, 9, 30));
    // Sunday 09:30 to 17:00 is 7h30; the other 4h30 end on Monday at 13:30.
    expect(verdict(held, attempts, on, t(2, 13, 29))).toBeNull();
    expect(verdict(held, attempts, on, t(2, 13, 30))).toBe(ROUND_RELEASE_REASON);
    // Six hours — what it was — is no longer enough; nor is the rest of the working day.
    expect(verdict(held, attempts, on, t(1, 15, 30))).toBeNull();
    expect(verdict(held, attempts, on, t(1, 17))).toBeNull();
    expect(verdict(held, attempts, on, t(2, 9))).toBeNull();
  });

  it('presses inside the twelve hours do not restart them', () => {
    const attempts = [...call(t(1, 9, 30)), ...call(t(1, 11)), ...call(t(1, 12)), ...call(t(1, 14)), ...call(t(2, 10))];
    expect(verdict(held, attempts, on, t(2, 13, 30))).toBe(ROUND_RELEASE_REASON);
  });

  it('a no-answer with no «اتصل» still starts the twelve hours', () => {
    expect(verdict(held, [noAnswer(t(1, 9, 30))], on, t(2, 13, 29))).toBeNull();
    expect(verdict(held, [noAnswer(t(1, 9, 30))], on, t(2, 13, 30))).toBe(ROUND_RELEASE_REASON);
  });

  it('a call that reached somebody ends the run, and a no-answer after it starts a new one', () => {
    const reached = [...call(t(1, 9, 30)), logged(t(1, 10), 'ANSWERED')];
    expect(verdict(held, reached, on, t(2, 16))).toBeNull();
    // The new run began at 11:00; twelve working hours later is Monday 15:00 (6h on Sunday, 6h on Monday).
    const again = [...reached, ...call(t(1, 11))];
    expect(verdict(held, again, on, t(2, 14, 59))).toBeNull();
    expect(verdict(held, again, on, t(2, 15))).toBe(ROUND_RELEASE_REASON);
  });

  it('«اتصل» and a sent message are neither: they do not end the run', () => {
    const attempts = [...call(t(1, 9, 30)), logged(t(1, 10), 'MESSAGE_SENT')];
    expect(verdict(held, attempts, on, t(2, 13, 30))).toBe(ROUND_RELEASE_REASON);
  });

  it('the weekend is frozen: 1h on Thursday + 8h on Sunday + 3h on Monday', () => {
    const thursday = { claimedAt: t(5, 15) };
    const attempts = call(t(5, 16));
    expect(verdict(thursday, attempts, on, t(9, 11, 59))).toBeNull();
    expect(verdict(thursday, attempts, on, t(9, 12))).toBe(ROUND_RELEASE_REASON);
    // Nothing moves on Saturday afternoon, nor all of Sunday.
    expect(verdict(thursday, attempts, on, t(7, 15))).toBeNull();
    expect(verdict(thursday, attempts, on, t(8, 17))).toBeNull();
  });

  it('SHE IS ON THE CALL: a «اتصل» of hers in the last 15 working minutes keeps it (the 12:58 case)', () => {
    // The run started on Sunday at 9:00, so Monday 13:00 is twelve working hours. She pressed «اتصل» at 12:58 and is talking.
    const hers = { claimedAt: t(1, 8, 30), claimedById: 'sara' };
    const attempts = [...call(t(1, 9)), opened(t(2, 12, 58))];
    expect(verdict(hers, [...call(t(1, 9))], on, t(2, 13)), 'the control: without her press it goes').toBe(ROUND_RELEASE_REASON);
    expect(verdict(hers, attempts, on, t(2, 13))).toBeNull();
    expect(verdict(hers, attempts, on, t(2, 13, 12))).toBeNull();
    // Fifteen working minutes after her press, with nothing logged since: it goes.
    expect(verdict(hers, attempts, on, t(2, 13, 13))).toBe(ROUND_RELEASE_REASON);
  });

  it('and the fifteen minutes are working minutes: a press at 16:58 does not keep it the next morning', () => {
    const hers = { claimedAt: t(1, 8, 30), claimedById: 'sara' };
    const attempts = [...call(t(1, 9)), opened(t(2, 16, 58))];
    expect(verdict(hers, attempts, on, t(3, 9, 12))).toBeNull();
    expect(verdict(hers, attempts, on, t(3, 9, 13))).toBe(ROUND_RELEASE_REASON);
  });

  it('a colleague’s press does not keep it in her hands', () => {
    const hers = { claimedAt: t(1, 8, 30), claimedById: 'sara' };
    const attempts = [...call(t(1, 9)), opened(t(2, 12, 58), 'huda')];
    expect(verdict(hers, attempts, on, t(2, 13))).toBe(ROUND_RELEASE_REASON);
  });

  it('SWITCH-ON TIME (6/11): the pile from before it goes back too — twelve working hours after the switch, not at once', () => {
    // Held since Thursday with two no-answers on Thursday; switched on Sunday at noon. Salwa's 237 were this order.
    const old = { claimedAt: t(5, 9) };
    const attempts = [...call(t(5, 10)), ...call(t(5, 14))];
    const sw = { enabledAt: t(8, 12) };
    expect(verdict(old, attempts, sw, t(8, 12)), 'nothing leaves the moment it is pressed').toBeNull();
    // Five working hours of Sunday after the switch, and seven on Monday: 16:00.
    expect(verdict(old, attempts, sw, t(9, 15, 59))).toBeNull();
    expect(verdict(old, attempts, sw, t(9, 16)), 'the old run, counted from the switch').toBe(ROUND_RELEASE_REASON);
    // A no-answer after the switch does not push it later: the run began on Thursday.
    const after = [...attempts, ...call(t(8, 13))];
    expect(verdict(old, after, sw, t(9, 16))).toBe(ROUND_RELEASE_REASON);
  });

  it('SWITCH-ON TIME: a call that reached somebody before the switch still ends the old run', () => {
    const old = { claimedAt: t(5, 9) };
    const reached = [...call(t(5, 10)), logged(t(5, 11), 'ANSWERED')];
    const sw = { enabledAt: t(8, 12) };
    // Nothing after the answered call: no run, and the re-pull rule does not apply (she worked it after taking it).
    expect(verdict(old, reached, sw, t(10, 16))).toBeNull();
    // A no-answer after the answered call, still before the switch: a run, counted from the switch.
    const again = [...reached, ...call(t(5, 14))];
    expect(verdict(old, again, sw, t(9, 15, 59))).toBeNull();
    expect(verdict(old, again, sw, t(9, 16))).toBe(ROUND_RELEASE_REASON);
  });

  it('SWITCH-ON TIME: an old run still waits for a date ahead and for her being on the call', () => {
    const old = { claimedAt: t(5, 9), claimedById: 'sara' };
    const attempts = call(t(5, 10));
    const sw = { enabledAt: t(8, 12) };
    // The control: with nothing in the way, Monday 16:00 is when it goes.
    expect(verdict(old, attempts, sw, t(9, 16))).toBe(ROUND_RELEASE_REASON);
    expect(verdict({ ...old, nextFollowUpAt: t(10, 12) }, attempts, sw, t(9, 16))).toBeNull();
    expect(verdict(old, [...attempts, opened(t(9, 15, 50))], sw, t(9, 16))).toBeNull();
  });

  it('a no-answer from before she took it is not hers', () => {
    const repulled = { claimedAt: t(1, 14) };
    const attempts = [...call(t(1, 10)), ...call(t(1, 14, 30))];
    expect(verdict(repulled, attempts, on, t(1, 16))).toBeNull();
    // 2h30 on Sunday after 14:30, the 8h of Monday, and 1h30 on Tuesday: 10:30.
    expect(verdict(repulled, attempts, on, t(3, 10, 29))).toBeNull();
    expect(verdict(repulled, attempts, on, t(3, 10, 30))).toBe(ROUND_RELEASE_REASON);
  });

  it('re-pulled and untouched: ninety working minutes after she took it', () => {
    const repulled = { claimedAt: t(1, 14) };
    const attempts = call(t(1, 10));
    expect(verdict(repulled, attempts, on, t(1, 15, 29))).toBeNull();
    expect(verdict(repulled, attempts, on, t(1, 15, 30))).toBe(REPULL_RELEASE_REASON);
  });

  it('and after the switch went on, when that is later', () => {
    const repulled = { claimedAt: t(1, 9) };
    const attempts = call(t(1, 8, 30));
    const sw = { enabledAt: t(1, 14) };
    expect(verdict(repulled, attempts, sw, t(1, 15, 29))).toBeNull();
    expect(verdict(repulled, attempts, sw, t(1, 15, 30))).toBe(REPULL_RELEASE_REASON);
  });

  it('no attempt at all is the ninety-minute rule of today, not this one', () => {
    expect(verdict(held, [], on, t(2, 16))).toBeNull();
  });
});

/**
 * R1b — A DATED ORDER NOBODY OPENED (the owner, 7/11: «حلّ الثغرتين»).
 *
 * Sara took the order on Sunday 09:00, rang, and the customer asked for Monday 10:00 (a postponement) — or asked to be
 * called back on a day (a callback). The claim stays with her. Before this rule the order was released by nothing when the last call had REACHED the
 * customer, and a postponed order whose holder never came back sat on her desk for ever.
 */
describe('R1b — a dated order that nobody opened after its date', () => {
  const on = { enabledAt: t(1, 8) };
  const D = t(2, 10); // Monday 10:00
  const order = (over: Partial<HeldFacts> = {}): HeldFacts => ({ claimedAt: t(1, 9), claimedById: 'sara', postponedUntil: D, ...over });
  /** What she logged on Sunday: her «اتصل», and the customer asking for Monday. */
  const beforeTheDate: AttemptFact[] = [opened(t(1, 9, 29)), logged(t(1, 9, 30), 'POSTPONED')];

  it('three working hours after the date: 2h59 it is still hers, 3h00 it goes back — with its own reason', () => {
    expect(verdict(order(), beforeTheDate, on, t(2, 12, 59))).toBeNull();
    expect(verdict(order(), beforeTheDate, on, t(2, 13))).toBe(DUE_RELEASE_REASON);
    expect(DUE_RELEASE_REASON).toBe('AUTO_RELEASE_DATE_PASSED');
  });

  it('a date still ahead keeps it, whatever else (as it always did)', () => {
    expect(verdict(order(), beforeTheDate, on, t(1, 16))).toBeNull();
    expect(verdict(order({ postponedUntil: null, nextFollowUpAt: t(2, 17) }), beforeTheDate, on, t(2, 11))).toBeNull();
  });

  it('on the WORKING clock: a date at 16:00 is three working hours old at 11:00 the next day, and the weekend is frozen', () => {
    // Monday 16:00 → 1h Monday + 2h Tuesday.
    const monday = order({ postponedUntil: t(2, 16) });
    expect(verdict(monday, beforeTheDate, on, t(3, 10, 59))).toBeNull();
    expect(verdict(monday, beforeTheDate, on, t(3, 11))).toBe(DUE_RELEASE_REASON);
    // Thursday 15:00 → 2h Thursday + 1h Sunday; nothing moves in between.
    const thursday = order({ claimedAt: t(2, 9), postponedUntil: t(5, 15) });
    const before: AttemptFact[] = [opened(t(2, 9, 29)), logged(t(2, 9, 30), 'POSTPONED')];
    expect(verdict(thursday, before, on, t(5, 17))).toBeNull();
    expect(verdict(thursday, before, on, t(7, 15)), 'Saturday afternoon').toBeNull();
    expect(verdict(thursday, before, on, t(8, 9, 59))).toBeNull();
    expect(verdict(thursday, before, on, t(8, 10))).toBe(DUE_RELEASE_REASON);
  });

  it.each([
    ['«لا يرد»', noAnswer(t(2, 10, 30))],
    ['«اتصل» (OPENED)', opened(t(2, 10, 30))],
    ['«رد» (ANSWERED)', logged(t(2, 10, 30), 'ANSWERED')],
    ['رسالة (MESSAGE_SENT)', logged(t(2, 10, 30), 'MESSAGE_SENT')],
    ['«اتصل» لزميلتها', opened(t(2, 10, 30), 'huda')],
    ['«رد» لزميلتها', logged(t(2, 10, 30), 'ANSWERED', 'huda')],
  ])('an attempt of any kind after the date keeps it from THIS release — %s', (_what, later) => {
    // The control: the same order without it goes back at 13:00.
    expect(verdict(order(), beforeTheDate, on, t(2, 13))).toBe(DUE_RELEASE_REASON);
    expect(verdict(order(), [...beforeTheDate, later], on, t(2, 13))).not.toBe(DUE_RELEASE_REASON);
    expect(verdict(order(), [...beforeTheDate, later], on, t(2, 13))).toBeNull();
  });

  it('the boundary is the date’s own instant: an attempt logged AT it counts as started, one a millisecond earlier does not', () => {
    // Review of PR #217: `>` instead of `>=` passed every test. An «اتصل» pressed in the very millisecond of the date is the agent
    // answering the promise; the same press a millisecond before it is not.
    const atTheDate = new Date(D.getTime());
    const justBefore = new Date(D.getTime() - 1);
    const justAfter = new Date(D.getTime() + 1);
    expect(verdict(order(), [...beforeTheDate, opened(atTheDate)], on, t(2, 13)), 'at the date').toBeNull();
    expect(verdict(order(), [...beforeTheDate, opened(justAfter)], on, t(2, 13)), 'a millisecond after').toBeNull();
    expect(verdict(order(), [...beforeTheDate, opened(justBefore)], on, t(2, 13)), 'a millisecond before').toBe(DUE_RELEASE_REASON);
  });

  it('a call that REACHED the customer before the date does not keep it — the case nothing released', () => {
    const reached: AttemptFact[] = [opened(t(1, 9, 29)), logged(t(1, 9, 30), 'ANSWERED'), logged(t(1, 9, 31), 'CALLBACK_REQUESTED')];
    expect(verdict(order({ postponedUntil: null, nextFollowUpAt: D }), reached, on, t(2, 13))).toBe(DUE_RELEASE_REASON);
    // The same order with the dates removed is exactly the one that sat for ever: no run, no re-pull, null.
    expect(verdict(order({ postponedUntil: null }), reached, on, t(2, 13))).toBeNull();
  });

  it('both dates: the LATER one decides — in either field', () => {
    const early = t(2, 10);
    const late = t(2, 14);
    const a = order({ postponedUntil: early, nextFollowUpAt: late });
    const b = order({ postponedUntil: late, nextFollowUpAt: early });
    for (const o of [a, b]) {
      expect(verdict(o, beforeTheDate, on, t(2, 13)), 'the earlier date is three hours old, the later is not').toBeNull();
      expect(verdict(o, beforeTheDate, on, t(2, 16, 59))).toBeNull();
      expect(verdict(o, beforeTheDate, on, t(2, 17))).toBe(DUE_RELEASE_REASON);
    }
  });

  it('a date given as text is read like a date', () => {
    const o = order({ postponedUntil: D.toISOString(), claimedAt: t(1, 9).toISOString() });
    expect(verdict(o, beforeTheDate, on, t(2, 12, 59))).toBeNull();
    expect(verdict(o, beforeTheDate, on, t(2, 13))).toBe(DUE_RELEASE_REASON);
  });

  it('only an order she held THROUGH the date is this one’s: taken after it, she gets the ninety minutes of a re-pull', () => {
    // Postponed to Monday 10:00, let go, and pulled again at 14:00 the same day. The date is old; nothing is logged since she took it.
    const repulled = order({ claimedAt: t(2, 14) });
    expect(verdict(repulled, beforeTheDate, on, t(2, 14, 1)), 'a minute after the pull').toBeNull();
    expect(verdict(repulled, beforeTheDate, on, t(2, 15, 29))).toBeNull();
    expect(verdict(repulled, beforeTheDate, on, t(2, 15, 30))).toBe(REPULL_RELEASE_REASON);
  });

  it('THE GRACE IS FOR THE RUN-BASED RELEASE TOO: the minute the date passes, a twelve-hour run no longer takes it', () => {
    // Sunday's no-answer matures at twelve working hours on Monday 13:30; the date is Monday 15:00, and a colleague's press after
    // the date stops this being R1b's. Its three working hours of grace end on Tuesday at 10:00 (2h on Monday, 1h on Tuesday).
    const date = t(2, 15);
    const run = [...call(t(1, 9, 30)), noAnswer(t(2, 15, 1), 'huda')];
    const dated = order({ postponedUntil: null, nextFollowUpAt: date });
    expect(verdict(order({ postponedUntil: null }), run, on, t(2, 15, 30)), 'without the date it goes').toBe(ROUND_RELEASE_REASON);
    expect(verdict(dated, run, on, t(2, 15, 30)), 'with it, the grace').toBeNull();
    expect(verdict(dated, run, on, t(3, 9, 59))).toBeNull();
    expect(verdict(dated, run, on, t(3, 10)), 'and after the grace, the run').toBe(ROUND_RELEASE_REASON);
  });

  it('and for the re-pull: a dated order taken early and untouched waits for its date plus the grace', () => {
    // Pulled on Sunday 10:00 from the due list (the lead days), rung once before: the date is Monday 10:00.
    const early = order({ claimedAt: t(1, 10) });
    const rung = [opened(t(1, 9, 20), 'huda'), logged(t(1, 9, 21), 'POSTPONED', 'huda')];
    expect(verdict({ ...early, postponedUntil: null }, rung, on, t(1, 12)), 'the control: undated, the re-pull goes').toBe(REPULL_RELEASE_REASON);
    expect(verdict(early, rung, on, t(1, 12)), 'ninety minutes is not enough while the date is ahead').toBeNull();
    expect(verdict(early, rung, on, t(2, 12, 59))).toBeNull();
    expect(verdict(early, rung, on, t(2, 13))).toBe(DUE_RELEASE_REASON);
  });

  it('SWITCH-ON TIME: a date older than the switch gets the same three working hours of notice from the switch', () => {
    const sw = { enabledAt: t(3, 9) };
    const stale = order({ postponedUntil: t(2, 10) });
    expect(verdict(stale, beforeTheDate, sw, t(3, 9)), 'nothing leaves the moment it is pressed').toBeNull();
    expect(verdict(stale, beforeTheDate, sw, t(3, 11, 59))).toBeNull();
    expect(verdict(stale, beforeTheDate, sw, t(3, 12))).toBe(DUE_RELEASE_REASON);
  });

  it('no attempt at all is still the ninety-minute rule’s — dated or not', () => {
    expect(verdict(order(), [], on, t(2, 13))).toBeNull();
  });

  it('a date that cannot be read is no date', () => {
    expect(verdict(order({ postponedUntil: 'soon' }), beforeTheDate, on, t(2, 13))).toBeNull();
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
