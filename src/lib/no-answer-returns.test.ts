import { describe, expect, it } from 'vitest';
import { zonedTimeToInstant } from './business-calendar';
import { ROUND_GAP_BUSINESS_MINUTES, workClock } from './no-answer-rounds';
import { NO_ANSWER_RESULTS } from './confirmation-workflow';
import { AUTO_RELEASE_WHY, isAutomaticRelease, isReleaseSheDidNotPress, releaseNotice } from './auto-release';
import {
  DATE_RETURNED_REASON,
  IDLE_RETURNED_REASON,
  NO_ANSWER_RETURNED_REASON,
  RETURNS_OFF,
  datesArrivedAnd,
  handLimitMessage,
  noRecentNoAnswerWhere,
  returnsMode,
  returnsReadyAnd,
  returnsSwitchOn,
} from './no-answer-returns';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «الطلب يرجع للطابور فوراً» — THE RULE ON THE STORE'S WORKING CALENDAR, WITH NOTHING READ FROM A DATABASE.
 *
 * Jordan’s week as the live store has it: Sunday to Thursday, 09:00 to 17:00, Friday and Saturday off. 1 November 2026 is a Sunday.
 * The ready-time of a «لا يرد» is three WORKING hours after the press, and the cut-off the filters compare with is the mirror of it:
 * the latest instant that is at least three working hours before now. An evening, a Friday and a Saturday add no minutes.
 *
 * The oracle here walks the clock FORWARD from a press (`clock.forward`); the production cut walks BACK from now (`clock.back`).
 * `returns-filters-agree-with-the-rule.test.ts` runs the two against each other on a grid of presses and moments.
 * ═══════════════════════════════════════════════════════════════════════
 */

const JO = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' };
const clock = workClock(JO);
const t = (day: number, h: number, m = 0) => zonedTimeToInstant(JO.timezone, 2026, 11, day, h, m);
const IDLE = 30;

describe('the ready-time of a «لا يرد»: three WORKING hours after the press', () => {
  it('the gap is the owner’s three hours, the same that makes a round', () => {
    expect(ROUND_GAP_BUSINESS_MINUTES).toBe(180);
  });

  it('Monday 10:00 looks back to Sunday 15:00: one hour that day and two on the day before', () => {
    expect(returnsMode(t(2, 10), clock, IDLE).readyCut.getTime()).toBe(t(1, 15).getTime());
  });

  it('a press on Sunday 15:00 is ready on Monday 10:00 — and not a minute earlier (forward and back agree)', () => {
    expect(clock.forward(t(1, 15), 180).getTime()).toBe(t(2, 10).getTime());
    expect(returnsMode(t(2, 9, 59), clock, IDLE).readyCut.getTime()).toBeLessThan(t(1, 15).getTime());
    expect(returnsMode(t(2, 10), clock, IDLE).readyCut.getTime()).toBe(t(1, 15).getTime());
  });

  it('a press after closing starts counting when the next day opens: Sunday 19:00 is ready on Monday 12:00', () => {
    expect(clock.forward(t(1, 19), 180).getTime()).toBe(t(2, 12).getTime());
    expect(returnsMode(t(2, 12), clock, IDLE).readyCut.getTime()).toBe(t(2, 9).getTime());
  });

  it('Thursday 16:00 → Sunday 11:00: Friday and Saturday add nothing', () => {
    expect(clock.forward(t(5, 16), 180).getTime()).toBe(t(8, 11).getTime());
    expect(returnsMode(t(8, 11), clock, IDLE).readyCut.getTime()).toBe(t(5, 16).getTime());
  });

  it('a press on a Friday counts from Sunday 09:00: ready at noon', () => {
    expect(clock.forward(t(6, 11), 180).getTime()).toBe(t(8, 12).getTime());
    // On the Saturday and the Friday itself the cut is Thursday’s: nothing pressed since Thursday’s closing is ready.
    expect(returnsMode(t(6, 12), clock, IDLE).readyCut.getTime()).toBe(t(5, 14).getTime());
  });

  it('the 17:00 → 09:00 boundary: a press at closing time is three hours old only at noon the next day', () => {
    const pressed = t(1, 17);
    expect(clock.forward(pressed, 180).getTime()).toBe(t(2, 12).getTime());
    // At Monday 09:00 no working minute has passed since the press (the cut is Sunday 14:00, before it): not ready.
    expect(returnsMode(t(2, 9), clock, IDLE).readyCut.getTime()).toBeLessThan(pressed.getTime());
    expect(returnsMode(t(2, 11, 59), clock, IDLE).readyCut.getTime()).toBeLessThan(pressed.getTime());
    expect(returnsMode(t(2, 12), clock, IDLE).readyCut.getTime()).toBeGreaterThanOrEqual(pressed.getTime());
  });

  it('a calendar with no working day: both cut-offs are the epoch, never year -271821, and nothing is ever ready', () => {
    for (const cal of [
      { ...JO, workHoursStart: '22:00', workHoursEnd: '06:00' }, // closes before it opens
      { ...JO, workHoursStart: '09:00', workHoursEnd: '09:00' }, // opens and closes together
      { ...JO, weekendDays: [0, 1, 2, 3, 4, 5, 6] }, // seven days off
    ]) {
      const dead = workClock(cal);
      // The clock itself says «never» (the end of time) — the oracle the filters are held to.
      expect(dead.forward(t(1, 12), 180).getTime()).toBe(8.64e15);
      const mode = returnsMode(t(1, 12), dead, IDLE);
      expect(mode.readyCut.getTime()).toBe(0);
      expect(mode.idleCut.getTime()).toBe(0);
    }
  });
});

describe('idle: nothing logged for thirty WORKING minutes', () => {
  it('the cut is thirty working minutes back, and evenings and weekends add none', () => {
    expect(returnsMode(t(1, 12), clock, IDLE).idleCut.getTime()).toBe(t(1, 11, 30).getTime());
    expect(returnsMode(t(2, 9, 10), clock, IDLE).idleCut.getTime()).toBe(t(1, 16, 40).getTime());
    expect(returnsMode(t(8, 9, 10), clock, IDLE).idleCut.getTime()).toBe(t(5, 16, 40).getTime());
    // At the opening bell nothing is thirty minutes old yet that did not wait through yesterday evening: it is Sunday 17:00 − 30 min.
    expect(returnsMode(t(2, 9), clock, IDLE).idleCut.getTime()).toBe(t(1, 16, 30).getTime());
  });

  it('the moment the mode is placed is the moment it was asked about', () => {
    expect(returnsMode(t(3, 13, 7), clock, IDLE).now.getTime()).toBe(t(3, 13, 7).getTime());
  });
});

describe('the filters, as database clauses', () => {
  const mode = returnsMode(t(2, 12), clock, IDLE);

  it('no «لا يرد» newer than the cut — all three results, strictly newer', () => {
    expect(noRecentNoAnswerWhere(mode)).toEqual({
      contactAttempts: { none: { result: { in: ['NO_ANSWER', 'BUSY', 'UNREACHABLE'] }, createdAt: { gt: mode.readyCut } } },
    });
    expect([...NO_ANSWER_RESULTS]).toEqual(['NO_ANSWER', 'BUSY', 'UNREACHABLE']);
  });

  it('every date NULL-safe, and a date AT now has arrived', () => {
    expect(datesArrivedAnd(mode)).toEqual([
      { OR: [{ postponedUntil: null }, { postponedUntil: { lte: mode.now } }] },
      { OR: [{ nextFollowUpAt: null }, { nextFollowUpAt: { lte: mode.now } }] },
    ]);
  });

  it('«ready» is exactly those three clauses and nothing else', () => {
    expect(returnsReadyAnd(mode)).toEqual([...datesArrivedAnd(mode), noRecentNoAnswerWhere(mode)]);
  });
});

describe('the words, the reasons and the switch', () => {
  it('the hand limit’s sentence is the owner’s, with the number in it', () => {
    expect(handLimitMessage(5)).toBe('وصلت للحد (5) — خلّصي واحد أو اضغطي «أعِدْه إلى الطابور»');
  });

  it('the three reasons are told apart, and each line is the system’s (nobody pressed «release»)', () => {
    expect(new Set([NO_ANSWER_RETURNED_REASON, DATE_RETURNED_REASON, IDLE_RETURNED_REASON]).size).toBe(3);
    expect(NO_ANSWER_RETURNED_REASON).toBe('NO_ANSWER_RETURNED');
    expect(IDLE_RETURNED_REASON.startsWith('AUTO_RELEASE')).toBe(true);
    for (const reason of [NO_ANSWER_RETURNED_REASON, DATE_RETURNED_REASON, IDLE_RETURNED_REASON]) {
      const line = { action: 'RELEASED', reason, metadata: JSON.stringify({ automatic: true, holder: 'sara' }) };
      expect(isAutomaticRelease(line), reason).toBe(true);
      // …and attendance does not read it as work of hers.
      expect(isReleaseSheDidNotPress(line), reason).toBe(true);
    }
  });

  it('only the idle release tells her (the other two are her own press): its notice names the thirty working minutes', () => {
    expect(AUTO_RELEASE_WHY[IDLE_RETURNED_REASON]).toContain('30 دقيقة عمل');
    const notice = releaseNotice({ companyId: 'c1', storeId: 's1', holderId: 'sara', orderNumber: 'ORD-9', reason: IDLE_RETURNED_REASON });
    expect(notice.message).toBe('رجع ORD-9 للطابور: ما انسجّلت عليه أي محاولة خلال 30 دقيقة عمل');
    expect(AUTO_RELEASE_WHY[NO_ANSWER_RETURNED_REASON]).toBeUndefined();
    expect(AUTO_RELEASE_WHY[DATE_RETURNED_REASON]).toBeUndefined();
  });

  it('only a real true with a real date is on', () => {
    expect(returnsSwitchOn(RETURNS_OFF)).toBe(false);
    expect(returnsSwitchOn(null)).toBe(false);
    expect(returnsSwitchOn(undefined)).toBe(false);
    expect(returnsSwitchOn({ enabled: true, enabledAt: null })).toBe(false);
    expect(returnsSwitchOn({ enabled: true, enabledAt: new Date('nope') })).toBe(false);
    expect(returnsSwitchOn({ enabled: false, enabledAt: new Date() })).toBe(false);
    expect(returnsSwitchOn({ enabled: true, enabledAt: new Date() })).toBe(true);
  });
});
