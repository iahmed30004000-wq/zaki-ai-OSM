import { describe, expect, it } from 'vitest';
import { zonedTimeToInstant } from './business-calendar';
import {
  ROUND_GAP_BUSINESS_MINUTES,
  roundsClose,
  countedRounds,
  roundsReleaseReason,
  workClock,
  type AttemptFact,
  type RoundsSwitch,
} from './no-answer-rounds';
import {
  CAUGHT_UP_SENTENCE,
  NEW_TAG,
  PROMISE_TAG,
  WORK_FIRST_BUTTON,
  deskTab,
  dueContext,
  dueSentence,
  dueTag,
  dueVerdict,
  isDueNow,
  ordersCounted,
  readyAtWords,
  summariseDue,
  verdictFromCount,
  workFirstRefusal,
  type DueOrder,
} from './work-first';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — «الشغل أول»: ONE QUESTION, «DOES SHE OWE THIS ORDER A CALL RIGHT NOW?» (the owner, 8/11)
 *
 *  1. A new pull (no attempt at all) is due. With «نظام الجولات» off that is the only case there is.
 *  2. A returned «لا يرد» is due when its next round is: none counted yet (a «لا يرد» without «اتصل» before it does not count),
 *     or 180 WORKING minutes since the START of the last counted round — to the minute, across the end of the day and a weekend.
 *  3. A date that came with nothing logged since is due (a promise). A date still ahead is neither.
 *  4. An order the next release pass is about to take, and one the rounds close, are never due — the first deploy must not
 *     wall a desk that already holds a pile.
 *  5. An order whose last call reached the customer, with no date and no cycle, needs a decision: not due, tab as before.
 *  6. The tab, the count and the refusal are made from this one verdict.
 *
 * Amman, 09:00–17:00, Friday and Saturday off (as no-answer-rounds.test.ts): 1 November 2026 is a Sunday; Thursday = 5,
 * Friday 6 and Saturday 7 are the weekend, Sunday = 8, Monday = 9.
 * ═══════════════════════════════════════════════════════════════════════
 */

const JO = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' };
const t = (day: number, h: number, m = 0) => zonedTimeToInstant(JO.timezone, 2026, 11, day, h, m);
const minus = (d: Date, ms: number) => new Date(d.getTime() - ms);

const ON: RoundsSwitch = { enabled: true, enabledAt: t(1, 8) };
const OFF: RoundsSwitch = { enabled: false, enabledAt: null };
const ctxAt = (now: Date, rounds: RoundsSwitch = ON) => dueContext({ now, cal: JO, rounds });

const opened = (at: Date, by = 'sara'): AttemptFact => ({ createdAt: at, result: 'OPENED', employeeId: by });
const noAnswer = (at: Date, by = 'sara', result = 'NO_ANSWER'): AttemptFact => ({ createdAt: at, result, employeeId: by });
const logged = (at: Date, result: string, by = 'sara'): AttemptFact => ({ createdAt: at, result, employeeId: by });
/** «اتصل» a minute before, then «لا يرد» — what the desk logs for one real call. */
const call = (at: Date, by = 'sara'): AttemptFact[] => [opened(minus(at, 60_000), by), noAnswer(at, by)];

/** She took it on Sunday morning. */
const held: DueOrder = { claimedAt: t(1, 9), claimedById: 'sara' };
const verdict = (now: Date, attempts: AttemptFact[], order: DueOrder = held, rounds: RoundsSwitch = ON) =>
  dueVerdict(order, attempts, ctxAt(now, rounds));

describe('1 · a new pull is due — with the switch on or off', () => {
  it('an order with no attempt at all is due NEW', () => {
    expect(verdict(t(1, 10), [])).toMatchObject({ due: true, reason: 'NEW', waiting: false });
    expect(verdict(t(1, 10), [], held, OFF)).toMatchObject({ due: true, reason: 'NEW' });
  });

  it('whatever its dates: the old rule (UNTOUCHED_ORDER) never looked at them either', () => {
    expect(verdict(t(1, 10), [], { ...held, postponedUntil: t(3, 10) }).reason).toBe('NEW');
  });

  it('a single «اتصل» is an attempt: no longer new — but it is still due (the cycle, nothing counted)', () => {
    expect(verdict(t(1, 10), [opened(t(1, 9, 30))])).toMatchObject({ due: true, reason: 'ROUND' });
  });
});

describe('OFF — only the first case exists', () => {
  const attempts = [...call(t(1, 9, 30)), logged(t(1, 10), 'ANSWERED')];
  it('any attempt makes it not due, not waiting, with no time — rounds, dates and promises do not exist', () => {
    expect(verdict(t(3, 15), call(t(1, 9, 30)), held, OFF)).toEqual({ due: false, reason: null, waiting: false, dueAt: null });
    expect(verdict(t(3, 15), attempts, { ...held, postponedUntil: t(2, 10) }, OFF)).toEqual({ due: false, reason: null, waiting: false, dueAt: null });
  });

  it('and the tab is the old count: none → work, one or more → noAnswer', () => {
    expect(deskTab(verdictFromCount(0), 0)).toBe('work');
    expect(deskTab(verdictFromCount(2), 0)).toBe('work');
    expect(deskTab(verdictFromCount(2), 1)).toBe('noAnswer');
    expect(deskTab(verdictFromCount(2), 3)).toBe('noAnswer');
    expect(verdictFromCount(0)).toMatchObject({ due: true, reason: 'NEW' });
    expect(verdictFromCount(3).due).toBe(false);
  });
});

describe('2 · a returned «لا يرد» — the round gap, to the minute', () => {
  const attempts = call(t(1, 10)); // counted at 10:00

  it('179 working minutes after the round began: waiting, ready at 13:00', () => {
    const v = verdict(t(1, 12, 59), attempts);
    expect(v).toMatchObject({ due: false, waiting: true });
    expect(v.dueAt).toEqual(t(1, 13));
  });

  it('180 working minutes: due — and one millisecond earlier it is not', () => {
    expect(verdict(t(1, 13), attempts)).toMatchObject({ due: true, reason: 'ROUND', waiting: false, dueAt: null });
    expect(verdict(minus(t(1, 13), 1), attempts).due).toBe(false);
    expect(ROUND_GAP_BUSINESS_MINUTES).toBe(180);
  });

  it('ten minutes after the call it is waiting (the call just made is not owed again)', () => {
    expect(verdict(t(1, 10, 10), attempts)).toMatchObject({ due: false, waiting: true });
  });

  it('across the end of the working day: 16:00 + 180 working minutes is 11:00 the next morning', () => {
    const late = call(t(1, 16));
    expect(verdict(t(2, 10, 59), late)).toMatchObject({ due: false, waiting: true });
    expect(verdict(t(2, 10, 59), late).dueAt).toEqual(t(2, 11));
    expect(verdict(t(2, 11), late).due).toBe(true);
  });

  it('a call placed after closing starts counting when the day opens: 20:00 → 12:00 the next morning', () => {
    const evening = call(t(1, 20));
    expect(verdict(t(2, 11, 59), evening).dueAt).toEqual(t(2, 12));
    expect(verdict(t(2, 11, 59), evening).due).toBe(false);
    expect(verdict(t(2, 12), evening).due).toBe(true);
  });

  it('across a weekend: Thursday 15:00 + 180 working minutes is Sunday 10:00 (Friday and Saturday are frozen)', () => {
    const thursday = call(t(5, 15));
    const order = { claimedAt: t(5, 9), claimedById: 'sara' };
    expect(verdict(t(7, 15), thursday, order).due).toBe(false);
    expect(verdict(t(8, 9, 59), thursday, order)).toMatchObject({ due: false, waiting: true });
    expect(verdict(t(8, 9, 59), thursday, order).dueAt).toEqual(t(8, 10));
    expect(verdict(t(8, 10), thursday, order).due).toBe(true);
  });

  it('the gap runs from the START of the last COUNTED round — presses inside it do not move it', () => {
    // 10:00 counted; 11:00 and 12:00 are the same round (the gap is not over); the next round is due at 13:00.
    const attempts2 = [...call(t(1, 10)), ...call(t(1, 11)), ...call(t(1, 12))];
    expect(verdict(t(1, 12, 59), attempts2).dueAt).toEqual(t(1, 13));
    expect(verdict(t(1, 13), attempts2).due).toBe(true);
  });

  it('the third round on ONE day does not close; the next one waits for its gap', () => {
    const threeToday = [...call(t(1, 9)), ...call(t(1, 12)), ...call(t(1, 15))];
    const rounds = countedRounds(threeToday, workClock(JO));
    expect(rounds.counted).toHaveLength(3);
    expect(roundsClose(rounds)).toBe(false);
    // Monday 09:00: 120 working minutes since 15:00 on Sunday — 60 to go, ready at 10:00.
    expect(verdict(t(2, 9), threeToday)).toMatchObject({ due: false, waiting: true });
    expect(verdict(t(2, 9), threeToday).dueAt).toEqual(t(2, 10));
    expect(verdict(t(2, 10), threeToday).due).toBe(true);
  });
});

describe('R5 — a dial comes first', () => {
  it('a «لا يرد» with no «اتصل» before it counts no round: the order stays due', () => {
    expect(verdict(t(1, 10, 5), [noAnswer(t(1, 10))])).toMatchObject({ due: true, reason: 'ROUND' });
    // …and an hour later, and three: nothing counted yet, so nothing is waiting.
    expect(verdict(t(1, 13), [noAnswer(t(1, 10)), noAnswer(t(1, 12))]).due).toBe(true);
  });

  it('with the dial it counts, and the order waits until its time', () => {
    expect(verdict(t(1, 10, 5), call(t(1, 10)))).toMatchObject({ due: false, waiting: true });
  });

  it('a colleague’s «اتصل» proves nothing about her press', () => {
    expect(verdict(t(1, 10, 5), [opened(t(1, 9, 59), 'huda'), noAnswer(t(1, 10), 'sara')]).due).toBe(true);
  });

  it('a message sent is neither a call nor an answer: it does not end the cycle', () => {
    const attempts = [...call(t(1, 10)), logged(t(1, 10, 5), 'MESSAGE_SENT')];
    expect(verdict(t(1, 11), attempts)).toMatchObject({ due: false, waiting: true });
  });

  it('BUSY and UNREACHABLE are no-answers like the others', () => {
    for (const result of ['BUSY', 'UNREACHABLE']) {
      const attempts = [opened(t(1, 9, 59)), noAnswer(t(1, 10), 'sara', result)];
      expect(verdict(t(1, 10, 30), attempts), result).toMatchObject({ waiting: true });
    }
  });
});

describe('3 · a date: ahead it is not due, arrived and unworked it is a promise', () => {
  it('a date still ahead — whatever the rounds say — is not due, and falls due the moment the date arrives', () => {
    const attempts = call(t(1, 9));
    const dated = { ...held, nextFollowUpAt: t(2, 10) };
    const v = verdict(t(1, 15), attempts, dated);
    expect(v).toMatchObject({ due: false, waiting: true });
    expect(v.dueAt).toEqual(t(2, 10));
    expect(verdict(minus(t(2, 10), 1), attempts, dated).due).toBe(false);
    expect(verdict(t(2, 10), attempts, dated)).toMatchObject({ due: true, reason: 'PROMISE' });
  });

  it('either field, and the later of the two decides', () => {
    const attempts = [logged(t(1, 10), 'ANSWERED')];
    expect(verdict(t(1, 12), attempts, { ...held, postponedUntil: t(2, 10) }).dueAt).toEqual(t(2, 10));
    expect(verdict(t(1, 12), attempts, { ...held, nextFollowUpAt: t(2, 10) }).dueAt).toEqual(t(2, 10));
    const both = { ...held, postponedUntil: t(2, 10), nextFollowUpAt: t(2, 14) };
    expect(verdict(t(1, 12), attempts, both).dueAt).toEqual(t(2, 14));
    // One date passed, the other still ahead: still ahead.
    expect(verdict(t(2, 11), attempts, both).due).toBe(false);
  });

  it('a promise: the date came, nothing was logged since — due, whoever holds it', () => {
    const attempts = [logged(t(1, 10), 'ANSWERED')];
    const order = { claimedAt: t(1, 9), claimedById: 'sara', postponedUntil: t(2, 10) };
    expect(verdict(t(2, 10, 1), attempts, order)).toMatchObject({ due: true, reason: 'PROMISE', waiting: false });
    // Pulled AFTER the date, as the pull offers a due postponed order: still hers to ring.
    expect(verdict(t(2, 11), attempts, { ...order, claimedAt: t(2, 10, 30) })).toMatchObject({ due: true, reason: 'PROMISE' });
  });

  it('an attempt logged AT the date’s own instant is "logged since" (the same boundary R1b reads)', () => {
    const order = { claimedAt: t(1, 9), claimedById: 'sara', postponedUntil: t(2, 10) };
    const at = (when: Date) => [logged(t(1, 10), 'ANSWERED'), logged(when, 'ANSWERED')];
    expect(verdict(t(2, 10, 5), at(t(2, 10)), order).due).toBe(false);
    expect(verdict(t(2, 10, 5), at(minus(t(2, 10), 1)), order)).toMatchObject({ due: true, reason: 'PROMISE' });
  });

  it('worked since the date by a call that reached: a decision is pending, not a call', () => {
    const order = { claimedAt: t(1, 9), claimedById: 'sara', postponedUntil: t(2, 10) };
    const attempts = [logged(t(1, 10), 'ANSWERED'), logged(t(2, 10, 30), 'ANSWERED')];
    expect(verdict(t(2, 11), attempts, order)).toEqual({ due: false, reason: null, waiting: false, dueAt: null });
  });

  it('worked since the date by a «اتصل» alone: she is mid-call, the order is still owed (the round)', () => {
    const order = { claimedAt: t(1, 9), claimedById: 'sara', postponedUntil: t(2, 10) };
    const attempts = [logged(t(1, 10), 'ANSWERED'), opened(t(2, 10, 30))];
    expect(verdict(t(2, 10, 35), attempts, order)).toMatchObject({ due: true, reason: 'ROUND' });
  });

  it('the grace of R1b is over three working hours after the date: nothing logged — the release takes it, so it is not due', () => {
    const order = { claimedAt: t(1, 9), claimedById: 'sara', postponedUntil: t(2, 10) };
    const attempts = [logged(t(1, 10), 'ANSWERED')];
    expect(verdict(t(2, 12, 59), attempts, order).due).toBe(true);
    expect(verdict(t(2, 13), attempts, order).due).toBe(false);
  });

  it('a date that cannot be read is no date', () => {
    const attempts = call(t(1, 10));
    expect(verdict(t(1, 13), attempts, { ...held, postponedUntil: 'tomorrow' }).due).toBe(true);
  });
});

describe('4 · the first deploy must not wall a desk — an order that is leaving is not due', () => {
  const attempts = call(t(1, 9, 30)); // the run starts at 09:30 on Sunday

  it('before twelve working hours it is owed; at twelve (Monday 13:30) the release takes it and it is not', () => {
    expect(verdict(t(2, 13, 29), attempts).due).toBe(true);
    const going = verdict(t(2, 13, 30), attempts);
    expect(going).toEqual({ due: false, reason: null, waiting: true, dueAt: null });
    // …and it is the release pass's own verdict that says so: one definition of "about to leave", asked in two places.
    expect(roundsReleaseReason({ claimedAt: t(1, 9), claimedById: 'sara' }, attempts, { enabledAt: t(1, 8) }, ctxAt(t(2, 13, 30)).cut)).not.toBeNull();
  });

  it('the pile from before the switch: counted from the switch, not from the old press', () => {
    // Pressed on Thursday; the switch went on Sunday at noon. Twelve working hours after the SWITCH is Monday 16:00… not before.
    const old = call(t(5, 10));
    const sw: RoundsSwitch = { enabled: true, enabledAt: t(8, 12) };
    const order = { claimedAt: t(5, 9), claimedById: 'sara' };
    expect(verdict(t(9, 15, 59), old, order, sw).due).toBe(true);
    expect(verdict(t(9, 16), old, order, sw).due).toBe(false);
  });

  it('she is on the call: a «اتصل» of hers in the last 15 working minutes keeps it in her hands, and it is owed', () => {
    const calling = [...attempts, opened(t(2, 13, 25))];
    expect(verdict(t(2, 13, 35), calling)).toMatchObject({ due: true, reason: 'ROUND' });
    // The control: without her press the same order is leaving.
    expect(verdict(t(2, 13, 35), attempts).due).toBe(false);
  });

  it('re-pulled and untouched: ninety working minutes after she took it the release takes it', () => {
    const repulled = { claimedAt: t(2, 10), claimedById: 'huda' };
    expect(verdict(t(2, 11, 29), call(t(1, 9, 30), 'sara'), repulled).due).toBe(true);
    expect(verdict(t(2, 11, 30), call(t(1, 9, 30), 'sara'), repulled).due).toBe(false);
  });

  it('a returned «لا يرد» she has just pulled is due: the rounds were counted before, the last one long ago', () => {
    const repulled = { claimedAt: t(2, 10), claimedById: 'huda' };
    const v = verdict(t(2, 10, 5), call(t(1, 9, 30), 'sara'), repulled);
    expect(v).toMatchObject({ due: true, reason: 'ROUND', waiting: false });
    // …and it lands in «اتصلي هلّق», not in «بانتظار», whatever its count says.
    expect(deskTab(v, 1)).toBe('work');
  });

  it('an order with no claim time on the row is read as claimed long ago (an old run is leaving)', () => {
    expect(verdict(t(9, 10), call(t(1, 9)), {}).due).toBe(false);
    expect(verdict(t(1, 10, 5), [opened(t(1, 10))], {}).due).toBe(true);
  });

  it('three counted rounds on two days: the order is closed (the door closes it) — not owed', () => {
    const closing = [...call(t(1, 9)), ...call(t(1, 12)), ...call(t(2, 10))];
    expect(roundsClose(countedRounds(closing, workClock(JO)))).toBe(true);
    expect(verdict(t(2, 10, 5), closing)).toEqual({ due: false, reason: null, waiting: true, dueAt: null });
  });
});

describe('5 · a call that REACHED the customer, with no date: a decision, not a call', () => {
  const reached = [...call(t(1, 9, 30)), logged(t(1, 10), 'ANSWERED')];

  it('is not due and not waiting — at any hour, any day', () => {
    for (const now of [t(1, 11), t(2, 15), t(8, 10)]) {
      expect(verdict(now, reached), now.toISOString()).toEqual({ due: false, reason: null, waiting: false, dueAt: null });
    }
  });

  it('its tab is exactly what it was: none → work, one or more → noAnswer', () => {
    const v = verdict(t(1, 11), reached);
    expect(deskTab(v, 0)).toBe('work');
    expect(deskTab(v, 1)).toBe('noAnswer');
  });

  it('a wrong number, a callback request: they reached somebody too', () => {
    for (const result of ['WRONG_NUMBER', 'CALLBACK_REQUESTED', 'OTHER']) {
      expect(verdict(t(2, 15), [logged(t(1, 10), result)]).due, result).toBe(false);
    }
  });

  it('a no-answer AFTER the call that reached starts a new cycle — counted from the last round that began', () => {
    const again = [...reached, ...call(t(1, 11))];
    // 11:00 is only 90 working minutes after the round that began at 09:30: the same round. Ready at 12:30.
    expect(verdict(t(1, 12, 29), again)).toMatchObject({ due: false, waiting: true });
    expect(verdict(t(1, 12, 29), again).dueAt).toEqual(t(1, 12, 30));
    expect(verdict(t(1, 12, 30), again).due).toBe(true);
  });
});

describe('the verdict agrees with itself: where it says "ready at", it is ready then and not before', () => {
  it('on a few hundred random histories, across nights, weekends and the end of the switch window', () => {
    const clock = workClock(JO);
    let seed = 13;
    const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
    const base = t(1, 0).getTime();
    let checked = 0;
    for (let i = 0; i < 400; i++) {
      const calls = 1 + Math.floor(rnd() * 3);
      const attempts: AttemptFact[] = [];
      let last = base + Math.floor(rnd() * 3 * 86_400_000);
      for (let c = 0; c < calls; c++) {
        attempts.push(...call(new Date(last)));
        last += Math.floor(rnd() * 5 * 3_600_000);
      }
      const now = new Date(last + Math.floor(rnd() * 3_600_000));
      const order: DueOrder = { claimedAt: new Date(base - 3_600_000), claimedById: 'sara' };
      const v = dueVerdict(order, attempts, dueContext({ now, cal: JO, rounds: { enabled: true, enabledAt: new Date(base - 86_400_000) } }));
      if (!v.waiting || !v.dueAt) continue;
      const ctxAtDue = (at: Date) => dueContext({ now: at, cal: JO, rounds: { enabled: true, enabledAt: new Date(base - 86_400_000) } });
      expect(dueVerdict(order, attempts, ctxAtDue(new Date(v.dueAt.getTime() - 1))).due, `${now.toISOString()} one ms before`).toBe(false);
      const at = ctxAtDue(v.dueAt);
      const readyOrGone =
        isDueNow(order, attempts, at) ||
        roundsReleaseReason({ ...order, claimedAt: order.claimedAt as Date }, attempts, { enabledAt: new Date(base - 86_400_000) }, at.cut) !== null ||
        roundsClose(countedRounds(attempts, clock));
      expect(readyOrGone, `${now.toISOString()} at ${v.dueAt.toISOString()}`).toBe(true);
      checked += 1;
    }
    expect(checked, 'the generator must reach the waiting case').toBeGreaterThan(50);
  });
});

describe('6 · the tab, the count and the refusal come from one verdict', () => {
  const waiting = { due: false, reason: null, waiting: true, dueAt: null } as const;
  const due = { due: true, reason: 'ROUND', waiting: false, dueAt: null } as const;
  const decision = { due: false, reason: null, waiting: false, dueAt: null } as const;

  it('due → «اتصلي هلّق» whatever the count; waiting → «بانتظار» whatever the count', () => {
    expect(deskTab(due, 0)).toBe('work');
    expect(deskTab(due, 2)).toBe('work');
    expect(deskTab(waiting, 0)).toBe('noAnswer');
    expect(deskTab(waiting, 2)).toBe('noAnswer');
  });

  it('the rest follows the old count: none → work; one, two, or an open order past the limit → noAnswer', () => {
    expect(deskTab(decision, 0)).toBe('work');
    expect(deskTab(decision, 1)).toBe('noAnswer');
    expect(deskTab(decision, 2)).toBe('noAnswer');
    expect(deskTab(decision, 4)).toBe('noAnswer');
  });

  it('the summary: how many, and the OLDEST claimed first (null claim time last, then the number)', () => {
    const rows = [
      { id: 'a', orderNumber: 'ORD-3', claimedAt: t(2, 10), due: true },
      { id: 'b', orderNumber: 'ORD-1', claimedAt: t(1, 9), due: true },
      { id: 'c', orderNumber: 'ORD-0', claimedAt: t(1, 8), due: false },
      { id: 'd', orderNumber: 'ORD-2', claimedAt: null, due: true },
    ];
    expect(summariseDue(rows)).toEqual({ count: 3, first: { id: 'b', orderNumber: 'ORD-1' } });
    expect(summariseDue([])).toEqual({ count: 0, first: null });
    expect(summariseDue(rows.map((r) => ({ ...r, due: false })))).toEqual({ count: 0, first: null });
    // The same instant: the smaller number first, so two readers never open different orders.
    expect(
      summariseDue([
        { id: 'x', orderNumber: 'ORD-9', claimedAt: t(1, 9), due: true },
        { id: 'y', orderNumber: 'ORD-8', claimedAt: t(1, 9), due: true },
      ]).first
    ).toEqual({ id: 'y', orderNumber: 'ORD-8' });
  });

  it('the refusal: code, the sentence naming how many, the oldest order — and none when nothing is owed', () => {
    const r = workFirstRefusal({ count: 5, first: { id: 'o-7', orderNumber: 'ORD-7' } });
    expect(r).toEqual({
      code: 'WORK_FIRST',
      message: 'عندك 5 طلبات لازم ترني عليهم هلّق قبل سحب طلب جديد — أولها الطلب ORD-7.',
      orderId: 'o-7',
      orderNumber: 'ORD-7',
      count: 5,
    });
    expect(workFirstRefusal({ count: 0, first: null })).toBeNull();
  });
});

describe('the words', () => {
  it('count orders the way the desk speaks: one, two, three to ten, eleven and more', () => {
    expect(ordersCounted(1)).toBe('طلب واحد');
    expect(ordersCounted(2)).toBe('طلبين');
    expect(ordersCounted(3)).toBe('3 طلبات');
    expect(ordersCounted(10)).toBe('10 طلبات');
    expect(ordersCounted(11)).toBe('11 طلب');
    expect(ordersCounted(100)).toBe('100 طلب');
    expect(ordersCounted(103)).toBe('103 طلبات');
    expect(ordersCounted(479)).toBe('479 طلب');
  });

  it('the banner says how many, and "him" for one', () => {
    expect(dueSentence(1)).toBe('عندك طلب واحد لازم ترني عليه هلّق');
    expect(dueSentence(2)).toBe('عندك طلبين لازم ترني عليهم هلّق');
    expect(dueSentence(5)).toBe('عندك 5 طلبات لازم ترني عليهم هلّق');
    expect(dueSentence(12)).toBe('عندك 12 طلب لازم ترني عليهم هلّق');
  });

  it('the fixed sentences are the ones the owner approved', () => {
    expect(CAUGHT_UP_SENTENCE).toBe('خلّصتي. اسحبي التالي');
    expect(WORK_FIRST_BUTTON).toBe('اسحب طلب جديد — خلّصي اللي فوق أول');
    expect(NEW_TAG).toBe('جديد — سحبتيه هلّق');
    expect(PROMISE_TAG).toBe('الزبون طلب نكلمو هلّق');
  });

  it('the tag of a due card says what it is: new, a returning no-answer with its round, or a promise', () => {
    expect(dueTag('NEW', 0, 3)).toBe('جديد — سحبتيه هلّق');
    expect(dueTag('ROUND', 1, 3)).toBe('لا يرد راجع — جولة 1 من 3');
    expect(dueTag('ROUND', 2, 3)).toBe('لا يرد راجع — جولة 2 من 3');
    expect(dueTag('ROUND', 0, 3)).toBe('لا يرد راجع');
    expect(dueTag('PROMISE', 1, 3)).toBe('الزبون طلب نكلمو هلّق');
  });

  it('no sentence carries an Arabic-Indic digit', () => {
    const all = [dueSentence(5), CAUGHT_UP_SENTENCE, WORK_FIRST_BUTTON, NEW_TAG, PROMISE_TAG, dueTag('ROUND', 2, 3), readyAtWords(t(1, 13), t(1, 10), JO.timezone)];
    for (const s of all) expect(s, s).not.toMatch(/[\u0660-\u0669\u06F0-\u06F9]/);
  });
});

describe('«جاهز الساعة» — on the store’s clock', () => {
  it('the same day: the time alone, 24-hour, Latin digits', () => {
    expect(readyAtWords(t(1, 13), t(1, 10), JO.timezone)).toBe('جاهز الساعة 13:00');
    expect(readyAtWords(t(1, 9, 5), t(1, 8), JO.timezone)).toBe('جاهز الساعة 09:05');
  });

  it('tomorrow: a day word, because "ready at 11:00" read at 16:00 is a sentence to work out', () => {
    expect(readyAtWords(t(2, 11), t(1, 16), JO.timezone)).toBe('جاهز بكرة الساعة 11:00');
  });

  it('inside the week: the weekday', () => {
    expect(readyAtWords(t(8, 10), t(5, 15), JO.timezone)).toContain('الأحد');
    expect(readyAtWords(t(8, 10), t(5, 15), JO.timezone)).toContain('الساعة 10:00');
  });

  it('a week or more away: the date', () => {
    expect(readyAtWords(t(9, 10), t(1, 15), JO.timezone)).toMatch(/9 نوفمبر|9 تشرين الثاني/);
  });

  it('the store’s day, not the machine’s: 00:30 in Amman is still yesterday in UTC — and it is tomorrow for a reader at 10:00', () => {
    const lateNight = new Date('2026-11-01T21:30:00Z');
    expect(readyAtWords(lateNight, new Date('2026-11-01T07:00:00Z'), 'Asia/Amman')).toBe('جاهز بكرة الساعة 00:30');
  });

  it('the store’s clock whatever the machine’s: three stores read one instant three ways', () => {
    // 13:05 UTC on 2 November 2026, read at 01:00 UTC. New York is back on standard time since the 1st (UTC−5); Auckland is UTC+13.
    const at = new Date('2026-11-02T13:05:00Z');
    const now = new Date('2026-11-02T01:00:00Z');
    expect(readyAtWords(at, now, 'Asia/Amman')).toBe('جاهز الساعة 16:05');
    expect(readyAtWords(at, now, 'America/New_York')).toBe('جاهز بكرة الساعة 08:05');
    expect(readyAtWords(at, now, 'Pacific/Auckland')).toBe('جاهز بكرة الساعة 02:05');
  });

  it('a timezone that is not one does not throw: the machine’s clock is used', () => {
    expect(readyAtWords(t(1, 13), t(1, 10), 'Not/AZone')).toMatch(/^جاهز (بكرة )?الساعة \d\d:\d\d$/);
    expect(readyAtWords('not a date', t(1, 10), JO.timezone)).toBe('');
  });
});
