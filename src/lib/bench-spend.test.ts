import { describe, expect, it } from 'vitest';
import { addSpend, BenchRefused, correctSpend, liveSpend, MAX_ENTRIES_PER_PRODUCT, storedSpend, voidSpend, type BenchSpendEntry } from './bench-spend';

/**
 * THE BENCH'S HAND-WRITTEN SPEND (18/11): one live entry per day, never
 * deleted — voided, the same rule as an expense — and a correction is a void
 * and a new entry together.
 */

const base = { today: '2026-11-18', byId: 'u1', at: '2026-11-18T10:00:00.000Z', minorUnit: 2 };
const add = (list: BenchSpendEntry[], id: string, day: unknown, amount: unknown) => addSpend(list, { ...base, id, day, amount });

describe('adding', () => {
  it('writes the day and the amount, rounded to the currency', () => {
    const list = add([], 'a', '2026-11-17', '20.456');
    expect(list).toEqual([{ id: 'a', day: '2026-11-17', amount: 20.46, at: base.at, byId: 'u1' }]);
  });

  it('a zero day is allowed (the ads were off)', () => {
    expect(add([], 'a', '2026-11-17', 0)[0].amount).toBe(0);
  });

  const refused: [string, unknown, unknown][] = [
    ['a negative amount', '2026-11-17', -1],
    ['text', '2026-11-17', 'abc'],
    ['an empty amount', '2026-11-17', ''],
    ['an absurd amount', '2026-11-17', 2_000_000],
    ['a day that is not a day', '2026-02-30', 10],
    ['a day in the future', '2026-11-19', 10],
    ['no day', undefined, 10],
  ];
  it.each(refused)('refuses %s', (_n, day, amount) => {
    expect(() => add([], 'a', day, amount)).toThrow(BenchRefused);
  });

  it('refuses a second live entry for the same day — correct it instead', () => {
    const list = add([], 'a', '2026-11-17', 20);
    expect(() => add(list, 'b', '2026-11-17', 5)).toThrow(/صحّحه/);
  });

  it('but a voided day can be written again', () => {
    const list = voidSpend(add([], 'a', '2026-11-17', 20), { entryId: 'a', reason: 'غلط', byId: 'u1', at: base.at });
    expect(add(list, 'b', '2026-11-17', 15)).toHaveLength(2);
  });

  it('has a ceiling per product', () => {
    const many: BenchSpendEntry[] = Array.from({ length: MAX_ENTRIES_PER_PRODUCT }, (_, i) => ({
      id: `x${i}`, day: '2026-01-01', amount: 1, at: base.at, byId: 'u1', voidedAt: base.at,
    }));
    expect(() => add(many, 'a', '2026-11-17', 1)).toThrow(BenchRefused);
  });
});

describe('voiding — never deleting', () => {
  const list = add([], 'a', '2026-11-17', 20);

  it('keeps the line, marked, with who and why', () => {
    const next = voidSpend(list, { entryId: 'a', reason: 'مكتوب غلط', byId: 'u2', at: 'T' });
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ id: 'a', amount: 20, voidedAt: 'T', voidedById: 'u2', voidReason: 'مكتوب غلط' });
    expect(liveSpend(next)).toEqual([]);
  });

  it('refuses without a reason', () => {
    expect(() => voidSpend(list, { entryId: 'a', reason: ' ', byId: 'u2', at: 'T' })).toThrow(/سبب/);
  });

  it('refuses twice', () => {
    const once = voidSpend(list, { entryId: 'a', reason: 'غلط', byId: 'u2', at: 'T' });
    expect(() => voidSpend(once, { entryId: 'a', reason: 'غلط', byId: 'u2', at: 'T' })).toThrow(/ملغى/);
  });

  it('refuses an unknown line', () => {
    expect(() => voidSpend(list, { entryId: 'zz', reason: 'غلط', byId: 'u2', at: 'T' })).toThrow(BenchRefused);
  });
});

describe('correcting = void + new, the same day', () => {
  const list = add([], 'a', '2026-11-16', 20);

  it('voids the old line and writes the new one for its day', () => {
    const next = correctSpend(list, { ...base, entryId: 'a', newId: 'b', amount: 25, reason: undefined });
    expect(next).toHaveLength(2);
    expect(next[0]).toMatchObject({ id: 'a', amount: 20, voidReason: 'تصحيح المبلغ' });
    expect(next[1]).toMatchObject({ id: 'b', day: '2026-11-16', amount: 25, replaces: 'a' });
    expect(liveSpend(next)).toEqual([{ day: '2026-11-16', amount: 25 }]);
  });

  it('refuses the same amount', () => {
    expect(() => correctSpend(list, { ...base, entryId: 'a', newId: 'b', amount: 20, reason: '' })).toThrow(BenchRefused);
  });

  it('refuses a voided line', () => {
    const voided = voidSpend(list, { entryId: 'a', reason: 'غلط', byId: 'u1', at: 'T' });
    expect(() => correctSpend(voided, { ...base, entryId: 'a', newId: 'b', amount: 5, reason: '' })).toThrow(/ملغى/);
  });

  it('does not change the list it was given', () => {
    const copy = JSON.parse(JSON.stringify(list));
    correctSpend(list, { ...base, entryId: 'a', newId: 'b', amount: 25, reason: '' });
    expect(list).toEqual(copy);
  });
});

describe('a stored list', () => {
  it('drops malformed rows instead of throwing', () => {
    expect(storedSpend('x')).toEqual([]);
    expect(storedSpend([{ id: 'a', day: 'nope', amount: 1 }, { id: 'b', day: '2026-11-01', amount: 'x' }, null])).toEqual([]);
    expect(storedSpend([{ id: 'a', day: '2026-11-01', amount: 3, at: 'T', byId: 'u' }])).toHaveLength(1);
  });

  it('every refusal is Arabic', () => {
    try {
      add([], 'a', '2026-11-19', 1);
    } catch (e) {
      expect((e as Error).message).toMatch(/[؀-ۿ]/);
      expect((e as Error).message).not.toMatch(/[A-Za-z]{2,}/);
    }
  });
});
