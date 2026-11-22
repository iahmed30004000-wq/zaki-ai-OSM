import { describe, expect, it } from 'vitest';
import {
  OCCURRED_AT_REFUSAL_AR,
  OCCURRED_AT_SKEW_MS,
  OccurredAtRefused,
  assertOccurredAt,
  byRealDateDesc,
  dayIn,
  readOccurredAt,
  realDateOf,
  registeredOnAnotherDay,
} from './real-date';

/**
 * THE REAL DATE (22/11) — «مرات بيصير حركة بيوم 19 وبسجلها بيوم 20».
 *
 * The rule every door asks: the past is allowed, the future is refused (beyond a five-minute clock skew), and anything that is
 * not an ISO moment is refused — each with an Arabic sentence and a stable code. And the reading a list asks: the real date or
 * the registration, «another day» decided in the STORE's timezone, and the order of the list.
 */

const NOW = new Date('2026-11-20T09:00:00.000Z');

describe('what a door accepts as the real date', () => {
  it("nothing typed = none: the row's real date is its registration", () => {
    for (const raw of [undefined, null, '']) expect(readOccurredAt(raw, NOW)).toEqual({ ok: true, value: null });
  });

  it('the day before, typed late, is accepted as it is', () => {
    const r = readOccurredAt('2026-11-19T14:30:00.000Z', NOW);
    expect(r).toEqual({ ok: true, value: new Date('2026-11-19T14:30:00.000Z') });
  });

  it('a device clock a little ahead of the server is let through (the skew), and one minute past it is not', () => {
    expect(readOccurredAt(new Date(NOW.getTime() + OCCURRED_AT_SKEW_MS).toISOString(), NOW).ok).toBe(true);
    const late = readOccurredAt(new Date(NOW.getTime() + OCCURRED_AT_SKEW_MS + 60_000).toISOString(), NOW);
    expect(late).toEqual({ ok: false, code: 'OCCURRED_AT_FUTURE', errorAr: OCCURRED_AT_REFUSAL_AR.OCCURRED_AT_FUTURE });
  });

  it('the skew is the stated five minutes: a phone two minutes ahead passes, ten minutes ahead does not', () => {
    expect(OCCURRED_AT_SKEW_MS).toBe(5 * 60 * 1000);
    expect(readOccurredAt(new Date(NOW.getTime() + 2 * 60_000).toISOString(), NOW).ok).toBe(true);
    expect(readOccurredAt(new Date(NOW.getTime() + 10 * 60_000).toISOString(), NOW).ok).toBe(false);
  });

  it('NEGATIVE: tomorrow is refused, in Arabic, with its code', () => {
    const r = readOccurredAt('2026-11-21T09:00:00.000Z', NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('OCCURRED_AT_FUTURE');
      expect(r.errorAr).toMatch(/[؀-ۿ]/);
    }
  });

  it.each(['yesterday', '19/11/2026', '2026-11-19', '2026-13-40T99:99', 1763550000000, {}, true])(
    'NEGATIVE: %s is not an ISO moment — malformed',
    (raw) => {
      expect(readOccurredAt(raw, NOW)).toMatchObject({ ok: false, code: 'OCCURRED_AT_MALFORMED' });
    }
  );

  it('NEGATIVE: a year typed wrong (0202) is refused as too old, not stored as a real date', () => {
    expect(readOccurredAt('0202-11-19T10:00', NOW)).toMatchObject({ ok: false, code: 'OCCURRED_AT_TOO_OLD' });
  });

  it('the same rule where a writer hands a Date: it throws the refusal with its code', () => {
    expect(assertOccurredAt(undefined, NOW)).toBeNull();
    expect(() => assertOccurredAt(new Date('2026-11-22T00:00:00Z'), NOW)).toThrow(OccurredAtRefused);
    try {
      assertOccurredAt(new Date('2026-11-22T00:00:00Z'), NOW);
    } catch (e) {
      expect((e as OccurredAtRefused).code).toBe('OCCURRED_AT_FUTURE');
      expect((e as Error).message).toBe(OCCURRED_AT_REFUSAL_AR.OCCURRED_AT_FUTURE);
    }
  });
});

describe('what a list reads', () => {
  const created = '2026-11-20T08:00:00.000Z';

  it('a row with no real date shows its registration', () => {
    expect(realDateOf({ occurredAt: null, createdAt: created }).toISOString()).toBe(created);
    expect(registeredOnAnotherDay({ occurredAt: null, createdAt: created }, 'Asia/Damascus')).toBe(false);
  });

  it('the 19th registered on the 20th is «another day»', () => {
    expect(registeredOnAnotherDay({ occurredAt: '2026-11-19T14:00:00.000Z', createdAt: created }, 'Asia/Damascus')).toBe(true);
  });

  it('a few minutes earlier the same day is ONE date, not two', () => {
    expect(registeredOnAnotherDay({ occurredAt: '2026-11-20T07:40:00.000Z', createdAt: created }, 'Asia/Damascus')).toBe(false);
  });

  it("the day is the STORE's: 22:30 UTC on the 19th is already the 20th in Damascus (UTC+3)", () => {
    const row = { occurredAt: '2026-11-19T22:30:00.000Z', createdAt: created };
    expect(dayIn(new Date(row.occurredAt), 'Asia/Damascus')).toBe('2026-11-20');
    expect(registeredOnAnotherDay(row, 'Asia/Damascus')).toBe(false);
    // Read in UTC it would have been two days — which is exactly the mistake the store's clock prevents.
    expect(registeredOnAnotherDay(row, 'UTC')).toBe(true);
  });

  it('the list is ordered by the real date, then by the registration, newest first', () => {
    const rows = [
      { id: 'a', occurredAt: '2026-11-19T14:00:00.000Z', createdAt: '2026-11-20T08:00:00.000Z' },
      { id: 'b', occurredAt: null, createdAt: '2026-11-20T07:00:00.000Z' },
      { id: 'c', occurredAt: null, createdAt: '2026-11-19T20:00:00.000Z' },
      { id: 'd', occurredAt: '2026-11-19T14:00:00.000Z', createdAt: '2026-11-20T09:00:00.000Z' },
    ];
    expect([...rows].sort(byRealDateDesc).map((r) => r.id)).toEqual(['b', 'c', 'd', 'a']);
  });
});
