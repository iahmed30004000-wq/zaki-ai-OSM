import { describe, expect, it } from 'vitest';
import { HAND_WINDOW_DAYS, findPossibleDoubles, handWindowStart, type HandMovement } from './possible-double';

/**
 * «THE SAME MONEY, ENTERED BY HAND AND THEN BY THE STATEMENT» — the comparison on its own.
 * The route test drives the whole approval; these pin the arithmetic of "alike" at the currency's own
 * decimals and at the edge of the window.
 */

const NOW = new Date('2026-10-28T12:25:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const move = (over: Partial<HandMovement> = {}): HandMovement => ({
  id: 'h1', walletId: 'w1', amount: 1543.9, minorUnit: 2, party: 'الباشا', note: 'Qabas',
  createdAt: new Date(NOW.getTime() - DAY), createdById: 'u1', ...over,
});

describe('the same amount, at the currency’s own decimals', () => {
  it('USD (2): 1543.9 against 1543.90 is the same — his numbers', () => {
    expect(findPossibleDoubles([{ walletId: 'w1', amount: 1543.9 }], [move({ amount: 1543.9 })], NOW)).toHaveLength(1);
  });

  it('JOD (3): 10.125 against 10.125 is the same', () => {
    expect(findPossibleDoubles([{ walletId: 'w1', amount: 10.125 }], [move({ amount: 10.125, minorUnit: 3 })], NOW)).toHaveLength(1);
  });

  it('JOD (3): 10.125 against 10.12 is NOT', () => {
    expect(findPossibleDoubles([{ walletId: 'w1', amount: 10.125 }], [move({ amount: 10.12, minorUnit: 3 })], NOW)).toEqual([]);
  });

  it('SYP (0): 15000.4 against 15000 is the same, 15001 is not', () => {
    const syp = { minorUnit: 0 };
    expect(findPossibleDoubles([{ walletId: 'w1', amount: 15000.4 }], [move({ amount: 15000, ...syp })], NOW)).toHaveLength(1);
    expect(findPossibleDoubles([{ walletId: 'w1', amount: 15000.4 }], [move({ amount: 15001, ...syp })], NOW)).toEqual([]);
  });

  it('floating point does not split a pair (0.1 + 0.2 against 0.3)', () => {
    expect(findPossibleDoubles([{ walletId: 'w1', amount: 0.1 + 0.2 }], [move({ amount: 0.3, minorUnit: 3 })], NOW)).toHaveLength(1);
  });
});

describe('the wallet and the window', () => {
  it('another wallet is another money', () => {
    expect(findPossibleDoubles([{ walletId: 'w2', amount: 1543.9 }], [move()], NOW)).toEqual([]);
  });

  it(`${HAND_WINDOW_DAYS} days back counts; one day more does not`, () => {
    expect(handWindowStart(NOW).getTime()).toBe(NOW.getTime() - HAND_WINDOW_DAYS * DAY);
    const at = (days: number) => move({ createdAt: new Date(NOW.getTime() - days * DAY) });
    expect(findPossibleDoubles([{ walletId: 'w1', amount: 1543.9 }], [at(14)], NOW)).toHaveLength(1);
    expect(findPossibleDoubles([{ walletId: 'w1', amount: 1543.9 }], [at(15)], NOW)).toEqual([]);
  });

  it('a row is listed once however many receipts it resembles', () => {
    const receipts = [{ walletId: 'w1', amount: 1543.9 }, { walletId: 'w1', amount: 1543.9 }];
    expect(findPossibleDoubles(receipts, [move()], NOW)).toHaveLength(1);
  });
});
