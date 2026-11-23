import { describe, expect, it } from 'vitest';
import { drawTotals, standingPrefill, type DrawLedgerRow, type StandingRow } from './partner-withdrawals-core';

/**
 * 23/11 (F7) — THE STANDING AMOUNT IS A SHORTCUT, AND THE DASHBOARD'S TOTALS ARE THE LEDGER'S, with no database.
 *
 * «ليش ما تتثبت كم المسحوبات تبعتي بالدولار والدينار وكل عملة بدل ما كل مرة اسجل كم المبلغ؟» (the owner).
 *   · `standingPrefill` — the one rule the wallet dialog and the one press share: this partner, the wallet's currency, and the
 *     equivalent only when it was typed for this store's currency; anything else → null, the boxes are typed as before.
 *   · `drawTotals` — per (store, partner, wallet currency), whole minor units, a reversed draw left out, the store-currency worth
 *     summed beside it in the store's decimals. Every expectation below is worked by hand, never by the function.
 */

const S = (partnerId: string, currencyCode: string, amount: number, storeValue: number | null = null, storeCurrencyCode: string | null = null): StandingRow => ({
  partnerId, currencyCode, amount, storeValue, storeCurrencyCode,
});
const STANDING = [S('p1', 'USD', 250), S('p1', 'JOD', 50, 70.5, 'USD'), S('p2', 'JOD', 40, 56, 'SYP'), S('p3', 'USD', 0)];

describe('standingPrefill', () => {
  it('the store’s own currency: the amount, and no equivalent is asked', () => {
    expect(standingPrefill(STANDING, 'p1', 'USD', 'USD')).toEqual({ amount: '250', storeValue: null });
  });

  it('a foreign wallet: the amount AND the equivalent typed for this store’s currency', () => {
    expect(standingPrefill(STANDING, 'p1', 'JOD', 'USD')).toEqual({ amount: '50', storeValue: '70.5' });
  });

  it('NEGATIVE: an equivalent typed for another store currency is not this store’s — the amount only', () => {
    expect(standingPrefill(STANDING, 'p2', 'JOD', 'USD')).toEqual({ amount: '40', storeValue: null });
  });

  it('NEGATIVE: a standing row in ANOTHER currency is ignored — null, the boxes stay typed', () => {
    expect(standingPrefill(STANDING, 'p2', 'USD', 'USD')).toBeNull();
    expect(standingPrefill(STANDING, 'p1', 'SYP', 'USD')).toBeNull();
  });

  it('NEGATIVE: no partner, no wallet currency, an unknown partner, or a figure that is not above zero → null', () => {
    expect(standingPrefill(STANDING, '', 'USD', 'USD')).toBeNull();
    expect(standingPrefill(STANDING, 'p1', '', 'USD')).toBeNull();
    expect(standingPrefill(STANDING, 'nobody', 'USD', 'USD')).toBeNull();
    expect(standingPrefill(STANDING, 'p3', 'USD', 'USD')).toBeNull();
    expect(standingPrefill([], 'p1', 'USD', 'USD')).toBeNull();
  });

  it('the store currency unknown: the amount fills, the equivalent is never guessed', () => {
    expect(standingPrefill(STANDING, 'p1', 'JOD', null)).toEqual({ amount: '50', storeValue: null });
  });
});

describe('drawTotals', () => {
  const minorOf = (c: string) => ({ JOD: 3, USD: 2, SYP: 0 })[c] ?? 3;
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
        D({ currencyCode: 'JOD', amount: 0.005, valueInStoreCurrency: 0.01 }),
        D({ storeId: 's2', amount: 5, valueInStoreCurrency: 5 }),
        D({ partnerId: 'p2', currencyCode: 'SYP', amount: 150000, valueInStoreCurrency: 11.5 }),
      ],
      minorOf,
      storeMinorOf
    );
    const byKey = Object.fromEntries(t.map((x) => [`${x.storeId}|${x.partnerId}|${x.currencyCode}`, [x.total, x.valueTotal, x.count]]));
    expect(byKey).toEqual({
      's1|p1|USD': [0.3, 0.3, 2],
      's1|p1|JOD': [12.35, 17.42, 2],
      's2|p1|USD': [5, 5, 1],
      's1|p2|SYP': [150000, 11.5, 1],
    });
  });

  it('NEGATIVE: only reversed draws → no line at all', () => {
    expect(drawTotals([D({ amount: 10, reversed: true })], minorOf, storeMinorOf)).toEqual([]);
  });
});
