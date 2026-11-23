import { describe, expect, it } from 'vitest';
import {
  amountOrRefusal,
  currencyOrRefusal,
  isRefusal,
  knownCurrencies,
  standingRows,
  totalsByPartner,
  withdrawalTotals,
  type KnownCurrency,
  type WithdrawalLedgerRow,
} from './partner-withdrawals-core';

/**
 * «المسحوبات» (22/11) — the arithmetic and the refusals, with no database. Every expected total below is written by hand, never
 * computed with the function under test.
 */

const USD: KnownCurrency = { code: 'USD', ar: 'دولار أمريكي', minorUnit: 2 };
const JOD: KnownCurrency = { code: 'JOD', ar: 'دينار أردني', minorUnit: 3 };
const SYP: KnownCurrency = { code: 'SYP', ar: 'ليرة سورية', minorUnit: 2 };
const KNOWN = [JOD, SYP, USD];
const minorOf = (c: string) => KNOWN.find((k) => k.code === c)?.minorUnit ?? 3;

const codeOf = (x: unknown) => (isRefusal(x) ? x.code : 'OK');

describe('the amount', () => {
  it('NEGATIVE: missing, empty, null → AMOUNT_REQUIRED', () => {
    for (const v of [undefined, null, '']) expect(codeOf(amountOrRefusal(v, USD))).toBe('AMOUNT_REQUIRED');
  });
  it('NEGATIVE: zero and negative → AMOUNT_NOT_POSITIVE', () => {
    for (const v of [0, '0', -1, '-5', -0.01]) expect(codeOf(amountOrRefusal(v, USD))).toBe('AMOUNT_NOT_POSITIVE');
  });
  it('NEGATIVE: not a number → AMOUNT_NOT_A_NUMBER (no «0x10», no «2,5», no object)', () => {
    for (const v of ['abc', '0x10', '2,5', {}, [], true, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(codeOf(amountOrRefusal(v, USD)), String(v)).toBe('AMOUNT_NOT_A_NUMBER');
    }
  });
  it('NEGATIVE: more decimals than the currency has is refused, never rounded', () => {
    expect(codeOf(amountOrRefusal(1.234, USD))).toBe('AMOUNT_DECIMALS');
    expect(codeOf(amountOrRefusal('1.2345', JOD))).toBe('AMOUNT_DECIMALS');
    expect(amountOrRefusal(1.234, JOD)).toBe(1.234);
  });
  it('NEGATIVE: above a billion → AMOUNT_TOO_BIG', () => {
    expect(codeOf(amountOrRefusal(1_000_000_001, USD))).toBe('AMOUNT_TOO_BIG');
  });
  it('a typed string is read as the number it is', () => {
    expect(amountOrRefusal(' 250.5 ', USD)).toBe(250.5);
    expect(amountOrRefusal(100, SYP)).toBe(100);
  });
  it('every refusal is an Arabic sentence with a stable code', () => {
    for (const r of [amountOrRefusal(undefined, USD), amountOrRefusal(0, USD), amountOrRefusal('x', USD), amountOrRefusal(1.001, USD)]) {
      expect(isRefusal(r)).toBe(true);
      if (isRefusal(r)) {
        expect(r.errorAr).toMatch(/[؀-ۿ]/);
        expect(r.code).toMatch(/^[A-Z_]+$/);
      }
    }
  });
});

describe('the currency', () => {
  it('the known ones are the countries’ and the wallets’, each once, with the country’s decimals first', () => {
    const k = knownCurrencies(
      [{ currencyCode: 'JOD', minorUnit: 3 }, { currencyCode: 'USD', minorUnit: 2 }],
      [{ currencyCode: 'SYP', minorUnit: 2 }, { currencyCode: 'usd', minorUnit: 3 }]
    );
    expect(k.map((c) => c.code)).toEqual(['JOD', 'SYP', 'USD']);
    expect(k.find((c) => c.code === 'USD')!.minorUnit).toBe(2);
    expect(k.find((c) => c.code === 'SYP')!.ar).toBe('ليرة سورية');
  });
  it('NEGATIVE: a code the stores do not use → UNKNOWN_CURRENCY', () => {
    expect(codeOf(currencyOrRefusal('EUR', KNOWN))).toBe('UNKNOWN_CURRENCY');
    expect(codeOf(currencyOrRefusal('', KNOWN))).toBe('UNKNOWN_CURRENCY');
    expect(codeOf(currencyOrRefusal(undefined, KNOWN))).toBe('UNKNOWN_CURRENCY');
    expect(codeOf(currencyOrRefusal(42, KNOWN))).toBe('UNKNOWN_CURRENCY');
  });
  it('a known one, whatever its case', () => {
    expect(currencyOrRefusal(' usd ', KNOWN)).toEqual(USD);
  });
});

// 23/11 (F7): «the day» (`dayOrRefusal`) went with the retired POST of the old record — a draw carries its wallet movement's dates.

const row = (id: string, partnerId: string, currencyCode: string, amount: number, extra: Partial<WithdrawalLedgerRow> = {}): WithdrawalLedgerRow => ({
  id,
  storeId: 's1',
  partnerId,
  currencyCode,
  amount,
  reversalOfId: null,
  ...extra,
});

describe('the totals — never across currencies', () => {
  const rows = [
    row('a', 'p1', 'USD', 100),
    row('b', 'p1', 'USD', 50.25),
    row('c', 'p1', 'JOD', 70),
    row('d', 'p1', 'SYP', 1_000_000),
    row('e', 'p2', 'USD', 10),
    row('f', 'p1', 'USD', 5, { storeId: 's2' }),
  ];

  it('one line per (store, partner, currency) — a dollar and a dinar are two lines, never one', () => {
    const t = withdrawalTotals(rows, minorOf);
    const s1p1 = t.filter((x) => x.storeId === 's1' && x.partnerId === 'p1').sort((a, b) => a.currencyCode.localeCompare(b.currencyCode));
    expect(s1p1).toEqual([
      { storeId: 's1', partnerId: 'p1', currencyCode: 'JOD', total: 70, count: 1 },
      { storeId: 's1', partnerId: 'p1', currencyCode: 'SYP', total: 1_000_000, count: 1 },
      { storeId: 's1', partnerId: 'p1', currencyCode: 'USD', total: 150.25, count: 2 },
    ]);
    // No line anywhere carries two currencies, and nothing is called a grand total.
    for (const x of t) expect(Object.keys(x).sort()).toEqual(['count', 'currencyCode', 'partnerId', 'storeId', 'total']);
  });

  it('per partner, the stores are folded and the currencies are NOT', () => {
    const byPartner = totalsByPartner(withdrawalTotals(rows, minorOf), minorOf).filter((x) => x.partnerId === 'p1');
    expect(byPartner.find((x) => x.currencyCode === 'USD')).toEqual({ partnerId: 'p1', currencyCode: 'USD', total: 155.25, count: 3 });
    expect(byPartner.find((x) => x.currencyCode === 'JOD')!.total).toBe(70);
    expect(byPartner).toHaveLength(3);
  });

  it('sums in whole minor units: 0.1 + 0.2 is 0.3', () => {
    const t = withdrawalTotals([row('a', 'p1', 'USD', 0.1), row('b', 'p1', 'USD', 0.2)], minorOf);
    expect(t[0].total).toBe(0.3);
  });

  it('a cancelled withdrawal and its cancel count as nothing; a cancel is never itself a withdrawal', () => {
    const ledger = [row('a', 'p1', 'USD', 100), row('r', 'p1', 'USD', 100, { reversalOfId: 'a' }), row('b', 'p1', 'USD', 30)];
    expect(standingRows(ledger).map((r) => r.id)).toEqual(['b']);
    expect(withdrawalTotals(ledger, minorOf)).toEqual([{ storeId: 's1', partnerId: 'p1', currencyCode: 'USD', total: 30, count: 1 }]);
  });

  it('nothing at all → no lines (not a zero line)', () => {
    expect(withdrawalTotals([], minorOf)).toEqual([]);
  });
});
