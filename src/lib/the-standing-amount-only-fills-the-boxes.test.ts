import { describe, expect, it } from 'vitest';
import { drawTotals, standingPrefill, type DrawLedgerRow, type StandingRow } from './partner-withdrawals-core';

/**
 * 23/11 (F7) — THE STANDING AMOUNT FILLS THE AMOUNT ONLY, AND THE DASHBOARD'S TOTALS ARE THE LEDGER'S PER CURRENCY, with no database.
 *
 * «السحوبات الأساسية بتتسجّل سحب من المحفظة بالعملة … بدون ما يجيني سعر الصرف» (the owner).
 *   · `standingPrefill` — this partner, the wallet's currency → the amount; anything else → null, the box is typed as before.
 *   · `drawTotals` — per (store, partner, wallet currency), whole minor units, a reversed draw left out; the store-currency worth is
 *     summed only over the draws that carry one, and the others are counted apart. Every expectation is worked by hand.
 */

const S = (partnerId: string, currencyCode: string, amount: number): StandingRow => ({ partnerId, currencyCode, amount });
const STANDING = [S('p1', 'USD', 250), S('p1', 'JOD', 50), S('p2', 'JOD', 40), S('p3', 'USD', 0)];

describe('standingPrefill', () => {
  it('the partner’s figure in the wallet’s currency fills the amount', () => {
    expect(standingPrefill(STANDING, 'p1', 'USD')).toBe('250');
    expect(standingPrefill(STANDING, 'p1', 'JOD')).toBe('50');
  });

  it('NEGATIVE: a standing row in ANOTHER currency is ignored — null, the box stays typed', () => {
    expect(standingPrefill(STANDING, 'p2', 'USD')).toBeNull();
    expect(standingPrefill(STANDING, 'p1', 'SYP')).toBeNull();
  });

  it('NEGATIVE: no partner, no wallet currency, an unknown partner, or a figure that is not above zero → null', () => {
    expect(standingPrefill(STANDING, '', 'USD')).toBeNull();
    expect(standingPrefill(STANDING, 'p1', '')).toBeNull();
    expect(standingPrefill(STANDING, 'nobody', 'USD')).toBeNull();
    expect(standingPrefill(STANDING, 'p3', 'USD')).toBeNull();
    expect(standingPrefill([], 'p1', 'USD')).toBeNull();
  });
});

describe('drawTotals', () => {
  const minorOf = (c: string) => ({ JOD: 3, USD: 2, SYP: 0, USDT: 2 })[c] ?? 3;
  const storeMinorOf = () => 2;
  const D = (over: Partial<DrawLedgerRow>): DrawLedgerRow => ({
    storeId: 's1', partnerId: 'p1', currencyCode: 'USD', amount: 0, valueInStoreCurrency: 0, reversed: false, ...over,
  });

  it('per store, partner and wallet currency — 0.1 + 0.2 is 0.3, a reversed draw is nothing, two currencies never meet', () => {
    const t = drawTotals(
      [
        D({ amount: 0.1, valueInStoreCurrency: 0.1 }),
        D({ amount: 0.2, valueInStoreCurrency: 0.2 }),
        D({ amount: 99, valueInStoreCurrency: 99, reversed: true }),
        D({ currencyCode: 'JOD', amount: 12.345, valueInStoreCurrency: 17.41 }),
        D({ currencyCode: 'JOD', amount: 0.005, valueInStoreCurrency: null }),
        D({ storeId: 's2', amount: 5, valueInStoreCurrency: 5 }),
        D({ currencyCode: 'USDT', amount: 1000, valueInStoreCurrency: null }),
        D({ partnerId: 'p2', currencyCode: 'SYP', amount: 1000, valueInStoreCurrency: null }),
      ],
      minorOf,
      storeMinorOf
    );
    const byKey = Object.fromEntries(
      t.map((x) => [`${x.storeId}|${x.partnerId}|${x.currencyCode}`, [x.total, x.count, x.valueTotal, x.valueCount, x.unvaluedTotal, x.unvaluedCount]])
    );
    expect(byKey).toEqual({
      's1|p1|USD': [0.3, 2, 0.3, 2, 0, 0],
      's1|p1|JOD': [12.35, 2, 17.41, 1, 0.005, 1],
      's2|p1|USD': [5, 1, 5, 1, 0, 0],
      's1|p1|USDT': [1000, 1, 0, 0, 1000, 1],
      's1|p2|SYP': [1000, 1, 0, 0, 1000, 1],
    });
  });

  it('an undefined worth is no worth: unvalued, like null — never summed as zero into the store value', () => {
    const [t] = drawTotals([D({ amount: 7, valueInStoreCurrency: undefined }), D({ amount: 3, valueInStoreCurrency: 3 })], minorOf, storeMinorOf);
    expect([t.total, t.valueTotal, t.valueCount, t.unvaluedTotal, t.unvaluedCount]).toEqual([10, 3, 1, 7, 1]);
  });

  it('NEGATIVE: only reversed draws → no line at all', () => {
    expect(drawTotals([D({ amount: 10, reversed: true }), D({ amount: 5, valueInStoreCurrency: null, reversed: true })], minorOf, storeMinorOf)).toEqual([]);
  });
});
