// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  LEASE_KEY,
  LEASE_MS,
  OUTBOX_KEY,
  PENDING_KEY,
  dropLease,
  outgoingState,
  takeLease,
  undoable,
  alreadyLogged,
  attemptBody,
  awayClock,
  callbackChips,
  followUpBody,
  isNetworkFailure,
  outcomeOrder,
  readOutbox,
  readPending,
  writeOutbox,
  type Outgoing,
} from './call-outcome';
import { whatsappAppLink, whatsappLink } from './message-templates';

/**
 * «شو صار؟» — the part of the call sheet that is not drawn: the order of the answers, the two bodies, what a reload keeps.
 */

beforeEach(() => window.localStorage.clear());

describe('the answers move under the thumb by the time away — and none is ever hidden', () => {
  it.each([
    [null, 'ANSWERED'],
    [0, 'NOT_CALLED'],
    [5_999, 'NOT_CALLED'],
    [6_000, 'NO_ANSWER'],
    [45_000, 'NO_ANSWER'],
    [45_001, 'ANSWERED'],
  ])('%s ms away → %s first', (away, first) => {
    const order = outcomeOrder(away as number | null);
    expect(order[0]).toBe(first);
    expect([...order].sort()).toEqual(['ANSWERED', 'BUSY', 'CALLBACK', 'NOT_CALLED', 'NO_ANSWER', 'UNREACHABLE', 'WRONG_NUMBER']);
  });

  it('6 to 45 seconds puts the three unanswered results first, in the card’s words order', () => {
    expect(outcomeOrder(20_000).slice(0, 3)).toEqual(['NO_ANSWER', 'BUSY', 'UNREACHABLE']);
  });

  it('the clock is small and plain', () => {
    expect(awayClock(42_000)).toBe('0:42');
    expect(awayClock(725_000)).toBe('12:05');
    expect(awayClock(3_729_000)).toBe('1:02:09');
  });
});

describe('the bodies are the ones the desk already sent', () => {
  it('a line in the contact log: exactly the card’s «لا يرد» body, byte for byte', () => {
    // What `logAttempt` wrote before this file existed: JSON.stringify({ contactMethod: method, result }).
    expect(attemptBody('PHONE', 'NO_ANSWER')).toBe('{"contactMethod":"PHONE","result":"NO_ANSWER"}');
    expect(attemptBody('PHONE', 'UNREACHABLE')).toBe('{"contactMethod":"PHONE","result":"UNREACHABLE"}');
  });

  it('a postponement: exactly the «تأجيل» dialog’s body, byte for byte', () => {
    const at = new Date('2026-11-05T10:00:00.000Z');
    const old = (note: string) =>
      JSON.stringify({
        action: 'schedule_follow_up',
        nextFollowUpAt: at.toISOString(),
        followUpReason: 'POSTPONED',
        preferredTime: 'صباحاً (9-12)',
        note: note || undefined,
        expectedVersion: 7,
      });
    for (const note of ['', 'بعد الراتب']) {
      expect(followUpBody({ at, reason: 'POSTPONED', preferredTime: 'صباحاً (9-12)', note, expectedVersion: 7 })).toBe(old(note));
    }
  });
});

describe('«اتصل لاحقاً» — four moments on the phone’s clock', () => {
  it('in the morning: +1, +3, six this evening, ten tomorrow', () => {
    const now = new Date(2026, 10, 4, 9, 30);
    const chips = callbackChips(now);
    expect(chips.map((c) => c.label)).toEqual(['+1 س', '+3 س', 'اليوم 6 م', 'بكرة 10 ص']);
    expect(chips[2].at.getHours()).toBe(18);
    expect(chips[3].at.getDate()).toBe(5);
    expect(chips[3].at.getHours()).toBe(10);
    for (const c of chips) expect(c.at.getTime()).toBeGreaterThan(now.getTime());
  });

  it('after six, «اليوم 6 م» is not offered — the door refuses a time in the past', () => {
    expect(callbackChips(new Date(2026, 10, 4, 17, 58)).map((c) => c.label)).toEqual(['+1 س', '+3 س', 'بكرة 10 ص']);
  });
});

describe('what the phone keeps', () => {
  it('the open call — hers, and not one forgotten for hours', () => {
    const now = 1_800_000_000_000;
    window.localStorage.setItem(PENDING_KEY, JSON.stringify({ orderId: 'o1', startedAt: now - 1_000, userId: 'u1' }));
    expect(readPending('u1', now)).toEqual({ orderId: 'o1', startedAt: now - 1_000, userId: 'u1' });
    expect(readPending('u2', now)).toBeNull();
    expect(readPending('u1', now + 3 * 60 * 60 * 1000)).toBeNull();
    window.localStorage.setItem(PENDING_KEY, '{not json');
    expect(readPending('u1', now)).toBeNull();
  });

  it('the outbox — another person’s waiting lines on the same phone are kept, never read as hers', () => {
    const item = (userId: string, key: string): Outgoing => ({
      key, userId, orderId: 'o1', orderNumber: 'SY-1', door: 'attempt', body: '{}', result: 'NO_ANSWER', label: 'ما رد', startedAt: Date.now(), sendAt: Date.now(),
    });
    writeOutbox('u2', [item('u2', 'a')]);
    writeOutbox('u1', [item('u1', 'b')]);
    expect(readOutbox('u1').map((o) => o.key)).toEqual(['b']);
    expect(readOutbox('u2').map((o) => o.key)).toEqual(['a']);
    writeOutbox('u1', []);
    expect(readOutbox('u2').map((o) => o.key)).toEqual(['a']);
    writeOutbox('u2', []);
    expect(window.localStorage.getItem(OUTBOX_KEY)).toBeNull();
  });
});

describe('what can still be taken back, and what is too old to send', () => {
  const base: Outgoing = {
    key: 'k', userId: 'u1', orderId: 'o1', orderNumber: 'SY-1', door: 'attempt', body: '{}', result: 'NO_ANSWER', label: 'ما رد', startedAt: 1_000, sendAt: 6_000,
  };
  it('only inside its five seconds, and only while nothing has left', () => {
    expect(undoable(base, 5_999)).toBe(true);
    expect(undoable(base, 6_000)).toBe(false);
    expect(undoable({ ...base, inFlight: true }, 2_000)).toBe(false);
    expect(undoable({ ...base, uncertain: true }, 2_000)).toBe(false);
    expect(outgoingState(base, false, 2_000)).toBe('countdown');
    expect(outgoingState({ ...base, inFlight: true }, false, 2_000)).toBe('sending');
    expect(outgoingState({ ...base, uncertain: true }, false, 9_000)).toBe('line');
    expect(outgoingState(base, true, 9_000)).toBe('line');
  });

  it('an answer waiting more than a day is dropped, never sent that late', () => {
    const now = 1_800_000_000_000;
    writeOutbox('u1', [{ ...base, startedAt: now - 25 * 60 * 60 * 1000 }, { ...base, key: 'fresh', startedAt: now - 60_000 }]);
    expect(readOutbox('u1', now).map((o) => o.key)).toEqual(['fresh']);
  });

  it('the lease: one owner at a time, until it is dropped or runs out', () => {
    const now = 1_800_000_000_000;
    expect(takeLease('tab-a', now)).toBe(true);
    expect(takeLease('tab-b', now + 1_000)).toBe(false);
    expect(takeLease('tab-a', now + 1_000)).toBe(true);
    expect(takeLease('tab-b', now + 1_000 + LEASE_MS + 1)).toBe(true);
    dropLease('tab-a');
    expect(window.localStorage.getItem(LEASE_KEY)).not.toBeNull();
    dropLease('tab-b');
    expect(window.localStorage.getItem(LEASE_KEY)).toBeNull();
  });
});

describe('a dropped line, and the resend that asks first', () => {
  it('a refusal has a status; a dropped line has none', () => {
    expect(isNetworkFailure(new TypeError('Failed to fetch'))).toBe(true);
    expect(isNetworkFailure(Object.assign(new Error('x'), { status: 403 }))).toBe(false);
  });

  it('her own line of the same result, since the call started, is the one already written', () => {
    const item = { result: 'NO_ANSWER', userId: 'u1', startedAt: 1_000_000 };
    const at = (ms: number) => new Date(ms).toISOString();
    expect(alreadyLogged([{ result: 'NO_ANSWER', employeeId: 'u1', createdAt: at(1_001_000) }], item, 0)).toBe(true);
    expect(alreadyLogged([{ result: 'BUSY', employeeId: 'u1', createdAt: at(1_001_000) }], item, 0)).toBe(false);
    expect(alreadyLogged([{ result: 'NO_ANSWER', employeeId: 'u2', createdAt: at(1_001_000) }], item, 0)).toBe(false);
    // the line from the call before this one is not this one
    expect(alreadyLogged([{ result: 'NO_ANSWER', employeeId: 'u1', createdAt: at(1_000_000 - 120_000) }], item, 0)).toBe(false);
    // the server's clock runs a minute ahead: the same line, read on the server's clock
    expect(alreadyLogged([{ result: 'NO_ANSWER', employeeId: 'u1', createdAt: at(1_061_000) }], item, 60_000)).toBe(true);
  });
});

describe('the WhatsApp app’s own address — the same number, the same text', () => {
  it('normalised by the one normaliser the browser link uses', () => {
    expect(whatsappAppLink('0952554562', '963', 'طلبك')).toBe(`whatsapp://send?phone=963952554562&text=${encodeURIComponent('طلبك')}`);
    expect(whatsappLink('0952554562', '963', 'طلبك')).toBe(`https://wa.me/963952554562?text=${encodeURIComponent('طلبك')}`);
    expect(whatsappAppLink('0952554562', null)).toBe('');
  });
});
