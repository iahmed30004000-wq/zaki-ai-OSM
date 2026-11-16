import { describe, expect, it } from 'vitest';
import { DELIVERY_MATURITY_DAYS, SCORECARD_RULES, bucketOf, medianOf, tallyScorecard, type ScoreInputs } from './agent-scorecard';

/**
 * ═════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE AGENT SCORECARD COUNTS WHAT ITS RULES SAY (step G1)
 *
 *  1. One row per agent per day (or per week, the week starting Monday), by the STORE's clock — not the server's.
 *  2. Claims and confirmations are UNIQUE ORDERS: the same order claimed twice in a day is one; a confirmation later reversed by a rejection the same day is a rejection.
 *  3. The confirmation rate is confirmed ÷ (confirmed + rejected); every rate carries its base and a zero base is `rate: null` (shown «—»), never 0.
 *  4. The median time to the first attempt is in business minutes from the claim to her first line on that order; an order she never logged on is not in it.
 *  5. A quick release is HERS, on the same order, after her claim and under a minute: 59.999 s counts, 60 s does not, a colleague's release does not.
 *  6. Attempts logged leave out the «اتصل» press and the message; the upsell is a line she added after intake on a confirmed order.
 *  7. The delivery rate is delivered ÷ (delivered + returned) over confirmations at least seven days old; one that is still on the road is in neither part.
 *  8. Rows are by day (newest first) then by name: never by a figure. Every figure has a «قاعدة الاحتساب».
 * ═════════════════════════════════════════════════════════════════
 */

const CAL = { workHoursStart: '00:00', workHoursEnd: '23:59', weekendDays: [] as number[], timezone: 'UTC' };
const NOW = new Date('2026-11-20T12:00:00.000Z');
const at = (iso: string) => new Date(iso);
const names = new Map([['u1', 'سارة'], ['u2', 'هدى']]);

const base = (over: Partial<ScoreInputs> = {}): ScoreInputs => ({
  now: NOW, grain: 'day', calendar: CAL, names, claims: [], releases: [], decisions: [], attempts: [], upsold: new Set(), confirmations: [], ...over,
});
const one = (over: Partial<ScoreInputs>, user = 'u1') => tallyScorecard(base(over)).find((r) => r.userId === user)!;

describe('claims and decisions are unique orders', () => {
  it('the same order claimed twice the same day is one claim; on another day it is another row', () => {
    const rows = tallyScorecard(base({
      claims: [
        { userId: 'u1', orderId: 'o1', at: at('2026-11-10T08:00:00Z') },
        { userId: 'u1', orderId: 'o1', at: at('2026-11-10T09:00:00Z') },
        { userId: 'u1', orderId: 'o2', at: at('2026-11-10T09:30:00Z') },
        { userId: 'u1', orderId: 'o1', at: at('2026-11-11T08:00:00Z') },
      ],
    }));
    expect(rows.map((r) => [r.bucket, r.claims])).toEqual([['2026-11-11', 1], ['2026-11-10', 2]]);
  });

  it('a confirmation reversed by a rejection the same day is a rejection; the rate is confirmed over decided', () => {
    const r = one({
      decisions: [
        { userId: 'u1', orderId: 'a', value: 'CONFIRMED', at: at('2026-11-10T08:00:00Z') },
        { userId: 'u1', orderId: 'b', value: 'CONFIRMED', at: at('2026-11-10T08:05:00Z') },
        { userId: 'u1', orderId: 'b', value: 'REJECTED', at: at('2026-11-10T08:30:00Z') },
        { userId: 'u1', orderId: 'c', value: 'CONFIRMED', at: at('2026-11-10T09:00:00Z') },
        { userId: 'u1', orderId: 'd', value: 'REJECTED', at: at('2026-11-10T09:10:00Z') },
      ],
    });
    expect(r.confirmed).toBe(2);
    expect(r.rejected).toBe(2);
    expect(r.confirmationRate).toEqual({ of: 2, base: 4, rate: 50 });
  });

  it('no decisions: the rate is null (a dash), never 0', () => {
    const r = one({ claims: [{ userId: 'u1', orderId: 'o1', at: at('2026-11-10T08:00:00Z') }] });
    expect(r.confirmationRate).toEqual({ of: 0, base: 0, rate: null });
    expect(r.upsell.rate).toBeNull();
    expect(r.delivery.rate).toBeNull();
    expect(r.medianFirstAttemptMinutes).toBeNull();
  });
});

describe('the quick release is hers, after her claim, and under a minute', () => {
  const claim = { userId: 'u1', orderId: 'o1', at: at('2026-11-10T08:00:00.000Z') };
  const release = (ms: number, user = 'u1') => ({ userId: user, orderId: 'o1', at: new Date(claim.at.getTime() + ms) });

  it('59.999 s counts, 60 s does not', () => {
    expect(one({ claims: [claim], releases: [release(59_999)] }).quickNoAnswer).toEqual({ of: 1, base: 1, rate: 100 });
    expect(one({ claims: [claim], releases: [release(60_000)] }).quickNoAnswer).toEqual({ of: 0, base: 1, rate: 0 });
  });

  it('a colleague\'s release, or a release before the claim, does not count', () => {
    expect(one({ claims: [claim], releases: [release(10_000, 'u2')] }).quickNoAnswer.of).toBe(0);
    expect(one({ claims: [claim], releases: [release(-5_000)] }).quickNoAnswer.of).toBe(0);
  });

  it('the share is of her claims: one quick of four is 25%', () => {
    const claims = ['o1', 'o2', 'o3', 'o4'].map((orderId) => ({ userId: 'u1', orderId, at: at('2026-11-10T08:00:00Z') }));
    expect(one({ claims, releases: [{ userId: 'u1', orderId: 'o2', at: at('2026-11-10T08:00:30Z') }] }).quickNoAnswer).toEqual({ of: 1, base: 4, rate: 25 });
  });
});

describe('attempts, the first attempt, and the upsell', () => {
  it('the press and the message are not attempts; a call and a result are', () => {
    const lines = ['OPENED', 'NO_ANSWER', 'MESSAGE_SENT', 'ANSWERED', 'BUSY'].map((result, i) => ({ userId: 'u1', orderId: 'o1', result, at: at(`2026-11-10T08:0${i}:00Z`) }));
    expect(one({ attempts: lines }).attempts).toBe(3);
  });

  it('the median first attempt is in minutes from each claim to her first line on it; an order with no line is out', () => {
    const claims = [
      { userId: 'u1', orderId: 'o1', at: at('2026-11-10T08:00:00Z') },
      { userId: 'u1', orderId: 'o2', at: at('2026-11-10T08:00:00Z') },
      { userId: 'u1', orderId: 'o3', at: at('2026-11-10T08:00:00Z') },
      { userId: 'u1', orderId: 'o4', at: at('2026-11-10T08:00:00Z') },
    ];
    const attempts = [
      { userId: 'u1', orderId: 'o1', result: 'OPENED', at: at('2026-11-10T08:02:00Z') },
      { userId: 'u1', orderId: 'o1', result: 'NO_ANSWER', at: at('2026-11-10T08:03:00Z') },
      { userId: 'u1', orderId: 'o2', result: 'OPENED', at: at('2026-11-10T08:10:00Z') },
      { userId: 'u1', orderId: 'o3', result: 'ANSWERED', at: at('2026-11-10T08:04:00Z') },
      { userId: 'u2', orderId: 'o4', result: 'ANSWERED', at: at('2026-11-10T08:01:00Z') }, // a colleague's line is not hers
    ];
    const r = one({ claims, attempts });
    expect(r.firstAttempts).toBe(3);
    expect(r.medianFirstAttemptMinutes).toBe(4);
  });

  it('the upsell is confirmed orders where SHE added a line after intake, over her confirmed orders', () => {
    const decisions = ['a', 'b', 'c', 'd'].map((orderId) => ({ userId: 'u1', orderId, value: 'CONFIRMED' as const, at: at('2026-11-10T09:00:00Z') }));
    expect(one({ decisions, upsold: new Set(['u1|a', 'u2|b', 'u1|zzz']) }).upsell).toEqual({ of: 1, base: 4, rate: 25 });
  });
});

describe('delivery counts only mature confirmations', () => {
  const day = (offset: number) => new Date(NOW.getTime() - offset * 86_400_000);
  const c = (offsetDays: number, shippingStatus: string, orderId = `o${offsetDays}${shippingStatus}`) => ({ userId: 'u1', orderId, at: day(offsetDays), shippingStatus });

  it('delivered ÷ (delivered + returned) at seven days or older; younger ones and in-flight ones are in neither part', () => {
    const rows = tallyScorecard(base({
      confirmations: [
        c(8, 'DELIVERED', 'a'), c(8, 'DELIVERED', 'b'), c(8, 'DELIVERED', 'c'), c(8, 'RETURNED', 'd'),
        c(8, 'OUT_FOR_DELIVERY', 'e'), // still on the road: in neither
        c(3, 'RETURNED', 'f'), // too young: in neither
      ],
    }));
    const total = rows.reduce((s, r) => ({ delivered: s.delivered + r.delivery.delivered, returned: s.returned + r.delivery.returned }), { delivered: 0, returned: 0 });
    expect(total).toEqual({ delivered: 3, returned: 1 });
    expect(rows.find((r) => r.delivery.base === 4)?.delivery.rate).toBe(75);
  });

  it('the maturity is exactly seven days: a confirmation seven days old counts, one a minute younger does not', () => {
    const exact = new Date(NOW.getTime() - DELIVERY_MATURITY_DAYS * 86_400_000);
    const younger = new Date(exact.getTime() + 60_000);
    const rows = tallyScorecard(base({ confirmations: [{ userId: 'u1', orderId: 'x', at: exact, shippingStatus: 'DELIVERED' }, { userId: 'u1', orderId: 'y', at: younger, shippingStatus: 'DELIVERED' }] }));
    expect(rows.reduce((s, r) => s + r.delivery.delivered, 0)).toBe(1);
  });

  it('partial delivery counts as delivered and a return request as returned (the same sets the delivery rate of commission reads)', () => {
    const r = tallyScorecard(base({ confirmations: [c(9, 'PARTIALLY_DELIVERED', 'p'), c(9, 'RETURN_REQUESTED', 'q')] }))[0];
    expect(r.delivery).toMatchObject({ delivered: 1, returned: 1, rate: 50 });
  });
});

describe('the buckets follow the store\'s clock', () => {
  it('a line at 23:30 UTC is the next day in Damascus (UTC+3)', () => {
    expect(bucketOf(at('2026-11-10T23:30:00Z'), 'day', 'UTC')).toBe('2026-11-10');
    expect(bucketOf(at('2026-11-10T23:30:00Z'), 'day', 'Asia/Damascus')).toBe('2026-11-11');
  });

  it('the week starts on Monday', () => {
    expect(bucketOf(at('2026-11-16T10:00:00Z'), 'week', 'UTC')).toBe('2026-11-16'); // a Monday
    expect(bucketOf(at('2026-11-22T10:00:00Z'), 'week', 'UTC')).toBe('2026-11-16'); // the Sunday after
    expect(bucketOf(at('2026-11-23T00:30:00Z'), 'week', 'UTC')).toBe('2026-11-23');
  });

  it('the week grain sums a week into one row per agent', () => {
    const claims = [
      { userId: 'u1', orderId: 'o1', at: at('2026-11-16T08:00:00Z') },
      { userId: 'u1', orderId: 'o2', at: at('2026-11-18T08:00:00Z') },
      { userId: 'u1', orderId: 'o3', at: at('2026-11-23T08:00:00Z') },
    ];
    expect(tallyScorecard(base({ grain: 'week', claims })).map((r) => [r.bucket, r.claims])).toEqual([['2026-11-23', 1], ['2026-11-16', 2]]);
  });
});

describe('order of the rows, and the words', () => {
  it('rows are by day (newest first) then by name — whatever the figures', () => {
    const decisions = [
      { userId: 'u2', orderId: 'a', value: 'CONFIRMED' as const, at: at('2026-11-10T08:00:00Z') },
      { userId: 'u1', orderId: 'b', value: 'REJECTED' as const, at: at('2026-11-10T08:00:00Z') },
      { userId: 'u1', orderId: 'c', value: 'CONFIRMED' as const, at: at('2026-11-09T08:00:00Z') },
    ];
    expect(tallyScorecard(base({ decisions })).map((r) => `${r.bucket}|${r.name}`)).toEqual(['2026-11-10|سارة', '2026-11-10|هدى', '2026-11-09|سارة']);
  });

  it('the median works on odd and even lists', () => {
    expect(medianOf([])).toBeNull();
    expect(medianOf([5])).toBe(5);
    expect(medianOf([9, 1, 5])).toBe(5);
    expect(medianOf([4, 1, 3, 2])).toBe(2.5);
  });

  it('every figure has its rule, in Arabic with Western digits', () => {
    for (const key of ['claims', 'confirmed', 'confirmationRate', 'medianFirstAttempt', 'quickNoAnswer', 'attempts', 'upsell', 'delivery', 'winback']) {
      expect(SCORECARD_RULES[key], key).toBeTruthy();
      expect(SCORECARD_RULES[key]).not.toMatch(/[٠-٩]/);
    }
    expect(SCORECARD_RULES.delivery).toContain(String(DELIVERY_MATURITY_DAYS));
  });

  it('the winback is not measured yet and says which step brings it', () => {
    expect(one({ claims: [{ userId: 'u1', orderId: 'o1', at: at('2026-11-10T08:00:00Z') }] }).winback).toBeNull();
    expect(SCORECARD_RULES.winback).toContain('الخطوة F');
  });
});
