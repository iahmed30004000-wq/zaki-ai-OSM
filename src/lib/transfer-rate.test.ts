import { describe, expect, it } from 'vitest';
import { roundMinor } from './money';
import { CURRENCIES } from './currencies';
import {
  MAX_AMOUNT,
  UNITS_PER_USD,
  amountInFromQuote,
  boxTextFor,
  currencyWord,
  dealOf,
  displayRate,
  fitsMinorUnit,
  formatRate,
  orientation,
  parseTyped,
  quoteOf,
  rateForBox,
  resolveTransferAmounts,
  storedRate,
  type DealInput,
  type Face,
} from './transfer-rate';

/**
 * ONE DEAL, THREE FACES — every figure below is worked by hand in the comment beside it.
 *
 * The owner holds a different face of the same deal each time: the board says «13,000 ليرة لكل دولار», the slip says
 * «استلمت 1,290,000». This file holds that the screen and the door turn any of them into the same two amounts, and that
 * the rate the books keep (six decimals) is never the thing money is worked from.
 */

const SYP_USD = { from: 'SYP', to: 'USD' } as const;
const USD_SYP = { from: 'USD', to: 'SYP' } as const;

describe('which of two currencies is «the strong one»', () => {
  it('the dollar is stronger than the lira, and the answer does not depend on which way round it is asked', () => {
    expect(orientation('USD', 'SYP')).toEqual({ strong: 'USD', weak: 'SYP' });
    expect(orientation('SYP', 'USD')).toEqual({ strong: 'USD', weak: 'SYP' });
  });

  it('the dinar is stronger than the dollar (0.71 per dollar) and than the lira', () => {
    expect(orientation('JOD', 'USD').strong).toBe('JOD');
    expect(orientation('SYP', 'JOD')).toEqual({ strong: 'JOD', weak: 'SYP' });
  });

  it('two with the same figure are told apart by their code, the same way from both sides', () => {
    // BHD and OMR both hold 0.38 in the table.
    expect(orientation('BHD', 'OMR')).toEqual(orientation('OMR', 'BHD'));
  });

  it('a code in lower case or with spaces is the code it spells', () => {
    expect(orientation(' syp ', 'usd').strong).toBe('usd');
  });

  it('every currency the product offers has a place in the table', () => {
    for (const c of CURRENCIES) expect(UNITS_PER_USD[c.code], `${c.code} غير موجودة بجدول القوة`).toBeGreaterThan(0);
  });

  it('a code nobody listed is read as weaker than the dollar', () => {
    expect(orientation('GBP', 'USD')).toEqual({ strong: 'USD', weak: 'GBP' });
    expect(orientation('USD', 'GBP')).toEqual({ strong: 'USD', weak: 'GBP' });
  });

  it('…unless the history says otherwise: a previous transfer between that very pair decides, newest first', () => {
    // 1 GBP bought 1.27 USD: the destination counts in more units, so the SOURCE is the stronger.
    expect(orientation('GBP', 'USD', [{ from: 'GBP', to: 'USD', rate: 1.27 }]).strong).toBe('GBP');
    // 1 USD bought 0.79 GBP, the other way round: the destination is the stronger.
    expect(orientation('GBP', 'USD', [{ from: 'USD', to: 'GBP', rate: 0.79 }]).strong).toBe('GBP');
    // the first matching row is the one that counts
    expect(
      orientation('GBP', 'USD', [
        { from: 'USD', to: 'GBP', rate: 0.79 },
        { from: 'USD', to: 'GBP', rate: 1.4 },
      ]).strong
    ).toBe('GBP');
  });

  it('a row of another pair, a rate of 1 or a rate that is nothing says nothing', () => {
    const base = orientation('GBP', 'USD');
    for (const row of [
      { from: 'EUR', to: 'USD', rate: 1.2 },
      { from: 'GBP', to: 'USD', rate: 1 },
      { from: 'GBP', to: 'USD', rate: 0 },
      { from: 'GBP', to: 'USD', rate: Number.NaN },
    ]) {
      expect(orientation('GBP', 'USD', [row])).toEqual(base);
    }
  });

  it('and the history never overrules two currencies the table does know', () => {
    // A wrongly typed past rate must not turn the lira into the strong one.
    expect(orientation('SYP', 'USD', [{ from: 'SYP', to: 'USD', rate: 5 }]).strong).toBe('USD');
  });
});

describe('the short word for a currency, from the names the product already has', () => {
  it('says دولار, ليرة and دينار', () => {
    expect(currencyWord('USD')).toBe('دولار');
    expect(currencyWord('SYP')).toBe('ليرة');
    expect(currencyWord('JOD')).toBe('دينار');
  });

  it('two currencies that start with the same word are told apart by the whole name', () => {
    expect(currencyWord('SYP', 'LBP')).toBe('ليرة سورية');
    expect(currencyWord('LBP', 'SYP')).toBe('ليرة لبنانية');
    expect(currencyWord('JOD', 'KWD')).toBe('دينار أردني');
    expect(currencyWord('SYP', 'USD')).toBe('ليرة');
  });

  it('a code that is not on the list is its own name', () => {
    expect(currencyWord('GBP')).toBe('GBP');
    expect(currencyWord('GBP', 'USD')).toBe('GBP');
  });
});

describe('a figure typed in a box', () => {
  it.each([
    ['1290000', 1290000],
    ['1,290,000', 1290000],
    ['١٬٢٩٠٬٠٠٠', 1290000],
    ['١٢٩٠٠٠٠', 1290000],
    ['3.5', 3.5],
    ['٣٫٥', 3.5],
    ['۱۳۰۰۰', 13000],
    ['.5', 0.5],
    ['12.', 12],
    ['0.00008', 0.00008],
    [' 13 000 ', 13000],
    ['1,290,000.55', 1290000.55],
  ])('reads %s as %s', (text, expected) => {
    expect(parseTyped(text)).toBe(expected);
  });

  it('reads a figure with a non-breaking space in it, as a slip pasted from a page has', () => {
    expect(parseTyped(`13${String.fromCharCode(0xa0)}000`)).toBe(13000);
    expect(parseTyped(`${String.fromCharCode(0xa0)}1,290,000${String.fromCharCode(0xa0)}`)).toBe(1290000);
  });

  it.each(['', '   ', 'abc', '3,5', '1,23', '12,34,56', '1.2.3', '-5', '+5', '1e5', '0x10', '١٢٣abc', '1,290,000,'])(
    'does not read %j — a comma with no thousands behind it could be a decimal or a typo, and a rate is no place to guess',
    (text) => {
      expect(parseTyped(text)).toBeNull();
    }
  );
});

describe('the acceptance examples, with their exact numbers', () => {
  it('1 — 100 USD at «13,000 ليرة لكل دولار» is 1,300,000 SYP', () => {
    // 100 × 13,000 = 1,300,000.
    expect(amountInFromQuote(USD_SYP, 100, { per: 'USD', value: 13000 }, 2)).toBe(1_300_000);
  });

  it('2 — 1,300,000 SYP with the SAME quote, no hand inversion, is 100 USD', () => {
    // The quote is about the dollar, so the lira are DIVIDED by it: 1,300,000 ÷ 13,000 = 100.
    expect(amountInFromQuote(SYP_USD, 1_300_000, { per: 'USD', value: 13000 }, 2)).toBe(100);
  });

  it('3 — 1,250,000 SYP at «دولار لكل ليرة» 0.00008 is 100 USD, and the card says 12,500 ليرة لكل دولار', () => {
    // 1,250,000 × 0.00008 = 100.
    const o = orientation('SYP', 'USD');
    const arrives = amountInFromQuote(SYP_USD, 1_250_000, quoteOf('B', 0.00008, o), 2);
    expect(arrives).toBe(100);
    // 1,250,000 ÷ 100 = 12,500 lira for one dollar, and the inverse 0.00008 dollars for one lira.
    const rate = displayRate(SYP_USD, 1_250_000, arrives!, o)!;
    expect(rate.weakPerStrong).toBe(12_500);
    expect(formatRate(rate.weakPerStrong)).toBe('12,500');
    expect(rate.strongPerWeak).toBeCloseTo(0.00008, 12);
  });

  it('4 — 100 USD out and 1,290,000 SYP received: the card says 12,900 and the amount stored is exactly what was typed', () => {
    const deal = dealOf(input({ ...USD_SYP, amountOutText: '100', face: 'C', text: '1,290,000' }));
    expect(deal.amountIn).toBe(1_290_000);
    expect(deal.rate!.weakPerStrong).toBe(12_900);
    expect(formatRate(deal.rate!.weakPerStrong)).toBe('12,900');
    expect(deal.verdict).toMatchObject({ ok: true, amountOut: 100, amountIn: 1_290_000, rate: 12_900, entered: 'AMOUNT_IN' });
  });

  it('5 — 100 JOD at «18,000 ليرة لكل دينار» is 1,800,000 SYP', () => {
    // 100 × 18,000 = 1,800,000, in the lira's two decimals.
    expect(amountInFromQuote({ from: 'JOD', to: 'SYP' }, 100, { per: 'JOD', value: 18000 }, 2)).toBe(1_800_000);
    // and the legacy payload — the rate as the door has always taken it — gives the same.
    expect(
      resolveTransferAmounts({
        fromCode: 'JOD', toCode: 'SYP', fromName: 'الصندوق', toName: 'الليرة',
        amountOut: 100, exchangeRate: 18000, fromMinor: 3, toMinor: 2,
      })
    ).toMatchObject({ ok: true, amountOut: 100, amountIn: 1_800_000, rate: 18000, entered: 'RATE' });
  });
});

describe('a quote that cannot be used', () => {
  const q = { per: 'USD', value: 13000 };
  it.each([
    ['no amount', 0, q],
    ['a negative amount', -1, q],
    ['an amount that is not a number', Number.NaN, q],
    ['no rate', 100, { per: 'USD', value: 0 }],
    ['a negative rate', 100, { per: 'USD', value: -13000 }],
    ['a rate that is not a number', 100, { per: 'USD', value: Number.NaN }],
    ['a rate of infinity', 100, { per: 'USD', value: Number.POSITIVE_INFINITY }],
    ['a quote about a currency that is in neither wallet', 100, { per: 'EUR', value: 13000 }],
  ])('is nothing: %s', (_why, amountOut, quote) => {
    expect(amountInFromQuote(USD_SYP, amountOut, quote, 2)).toBeNull();
  });

  it('a rate so small the arriving amount rounds to nothing is a real zero, not a blank — the caller names it', () => {
    // 100 × 0.000001 = 0.0001, which a 3-decimal currency cannot hold.
    expect(amountInFromQuote({ from: 'USD', to: 'JOD' }, 100, { per: 'USD', value: 0.000001 }, 3)).toBe(0);
  });
});

/** A screen's deal between two wallets, with the defaults the examples use. */
function input(over: Partial<DealInput> & { from: string; to: string }): DealInput {
  return {
    fromName: 'الصندوق',
    toName: 'الحساب',
    fromMinor: 2,
    toMinor: 2,
    amountOutText: '',
    face: 'A',
    text: '',
    orientation: orientation(over.from, over.to),
    ...over,
  };
}

describe('the same deal from any face is the same two amounts', () => {
  // Pairs of rates that are exact inverses in decimal: «weak per one strong» and «strong per one weak».
  const INVERSES: Array<[number, string, string]> = [
    [12_500, '12500', '0.00008'],
    [8, '8', '0.125'],
    [4, '4', '0.25'],
    [10, '10', '0.1'],
    [2, '2', '0.5'],
    [1000, '1000', '0.001'],
    [20, '20', '0.05'],
    [125, '125', '0.008'],
    [25, '25', '0.04'],
    [16, '16', '0.0625'],
  ];
  // Dollars out for the first direction, lira out for the second — amounts a person would actually move.
  const OUTS_BY_DIRECTION = new Map<string, string[]>([
    ['USD→SYP', ['1', '7', '10', '100', '100.5', '250.25', '1000', '99.99', '12345.67']],
    ['SYP→USD', ['100000', '125000', '1250000', '1300000.5', '99999.99', '2500000', '31250.25', '1234567.89', '50000000']],
  ]);

  it('rate in A, its inverse in B, and the amount that results in C: one amountIn, both ways round', () => {
    let checked = 0;
    let expected = 0;
    for (const dir of [USD_SYP, SYP_USD]) {
      const OUTS = OUTS_BY_DIRECTION.get(`${dir.from}→${dir.to}`)!;
      for (const [, a, b] of INVERSES) {
        for (const out of OUTS) {
          expected += 1;
          const viaA = dealOf(input({ ...dir, amountOutText: out, face: 'A', text: a }));
          const viaB = dealOf(input({ ...dir, amountOutText: out, face: 'B', text: b }));
          expect(viaA.amountIn, `A=${a} ${dir.from}→${dir.to} ${out}`).toBeGreaterThan(0);
          expect(viaB.amountIn, `A=${a} vs B=${b}, ${dir.from}→${dir.to} ${out}`).toBe(viaA.amountIn);
          // typing the amount that arrived is the same deal again, with the same rate on the card
          const viaC = dealOf(input({ ...dir, amountOutText: out, face: 'C', text: String(viaA.amountIn) }));
          expect(viaC.amountIn).toBe(viaA.amountIn);
          expect(viaC.rate!.weakPerStrong).toBe(viaA.rate!.weakPerStrong);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(expected);
    expect(checked).toBeGreaterThan(150);
  });

  it('the card says the same rate however the deal was given, and it is always «weak per one strong»', () => {
    // 100 dollars out, or the 1,250,000 lira that are the same hundred dollars: the same board number, the same card.
    for (const [dir, out] of [[USD_SYP, '100'], [SYP_USD, '1250000']] as const) {
      const viaA = dealOf(input({ ...dir, amountOutText: out, face: 'A', text: '12500' }));
      const viaB = dealOf(input({ ...dir, amountOutText: out, face: 'B', text: '0.00008' }));
      expect(viaA.rate!.weakPerStrong, `${dir.from}→${dir.to}`).toBe(12_500);
      expect(viaB.rate!.weakPerStrong, `${dir.from}→${dir.to}`).toBeCloseTo(12_500, 6);
    }
  });

  it('what the card shows is what the door would write: the two amounts of the verdict ARE the card', () => {
    const cases: Array<[string, string, Face, string, number, number]> = [
      ['USD', 'SYP', 'A', '12900', 2, 2],
      ['SYP', 'USD', 'A', '12900', 2, 2],
      ['JOD', 'SYP', 'A', '18000', 3, 2],
      ['SYP', 'JOD', 'B', '0.000055', 2, 3],
      ['USD', 'JOD', 'B', '1.4085', 2, 3],
      ['JOD', 'USD', 'A', '1.41', 3, 2],
      ['SYP', 'USD', 'C', '76.92', 2, 2],
    ];
    for (const [from, to, face, text, fromMinor, toMinor] of cases) {
      for (const out of ['1', '33.3', '1000', '123456.78', '0.01']) {
        const deal = dealOf(input({ from, to, fromMinor, toMinor, amountOutText: out, face, text }));
        if (!deal.verdict) continue;
        if (!deal.verdict.ok) continue; // a deal the door would refuse has no amounts to compare
        // the two movements, as the route would write them from what the screen sends
        const sent = resolveTransferAmounts({
          fromCode: from, toCode: to, fromName: 'أ', toName: 'ب', amountOut: deal.amountOut!, amountIn: deal.amountIn!,
          fromMinor, toMinor,
        });
        expect(sent).toMatchObject({ ok: true, amountOut: deal.amountOut, amountIn: deal.amountIn });
        // and the amount is a figure the destination holds, so nothing is rounded a second time on the way
        expect(roundMinor(deal.amountIn!, toMinor)).toBe(deal.amountIn);
      }
    }
  });
});

describe('the amounts, in the decimals of each currency', () => {
  it('JOD has three decimals: 100 JOD at 1.4085 is 140.850 USD-cents-exact, rounded once to the dollar’s two', () => {
    // 100 × 1.4085 = 140.85 exactly.
    expect(amountInFromQuote({ from: 'JOD', to: 'USD' }, 100, { per: 'JOD', value: 1.4085 }, 2)).toBe(140.85);
    // 33.333 JOD × 1.4085 = 46.9487... → 46.95 (the dollar's two decimals).
    expect(amountInFromQuote({ from: 'JOD', to: 'USD' }, 33.333, { per: 'JOD', value: 1.4085 }, 2)).toBe(46.95);
    // and a dollar amount into dinars keeps the fils: 100 ÷ 1.4085 = 70.9975... → 70.998.
    expect(amountInFromQuote({ from: 'USD', to: 'JOD' }, 100, { per: 'JOD', value: 1.4085 }, 3)).toBe(70.998);
  });

  it('half a unit rounds away from zero, as everywhere else in the product', () => {
    // 0.005 → 0.01 at two decimals; 2.675 → 2.68 (the float that is 2.67499999… must not win).
    expect(amountInFromQuote({ from: 'USD', to: 'EUR' }, 1, { per: 'USD', value: 0.005 }, 2)).toBe(0.01);
    expect(amountInFromQuote({ from: 'USD', to: 'EUR' }, 1, { per: 'USD', value: 2.675 }, 2)).toBe(2.68);
  });

  it('whole numbers for a currency counted without decimals', () => {
    // 3 × 12.5 = 37.5 → 38 at zero decimals.
    expect(amountInFromQuote({ from: 'USD', to: 'IQD' }, 3, { per: 'USD', value: 12.5 }, 0)).toBe(38);
  });

  it('a tiny amount and a huge one both come out as the right figure, not an artefact', () => {
    expect(amountInFromQuote(USD_SYP, 0.01, { per: 'USD', value: 13000 }, 2)).toBe(130);
    expect(amountInFromQuote(USD_SYP, 1_000_000, { per: 'USD', value: 13000 }, 2)).toBe(13_000_000_000);
  });
});

describe('what a figure may carry', () => {
  it('has no more decimals than the currency counts in', () => {
    expect(fitsMinorUnit(10.12, 2)).toBe(true);
    expect(fitsMinorUnit(10.123, 3)).toBe(true);
    expect(fitsMinorUnit(10.123, 2)).toBe(false);
    expect(fitsMinorUnit(10.5, 0)).toBe(false);
    expect(fitsMinorUnit(10, 0)).toBe(true);
    expect(fitsMinorUnit(0.07, 2)).toBe(true);
    expect(fitsMinorUnit(1.005, 2)).toBe(false);
    expect(fitsMinorUnit(Number.NaN, 2)).toBe(false);
  });

  it('every figure of the form k / 10^m fits m decimals, up to the largest the column holds', () => {
    for (const m of [0, 2, 3]) {
      for (const k of [1, 7, 99, 12345, 9_999_999, 99_999_999_999_999].filter((x) => x / 10 ** m <= MAX_AMOUNT)) {
        expect(fitsMinorUnit(k / 10 ** m, m), `${k}/10^${m}`).toBe(true);
      }
    }
  });
});

describe('THE PRECISION TRAP — the stored rate is about the deal, never an input to it', () => {
  it('SYP→USD at 13,000 stores 0.000077, and multiplying that back would be wrong by a tenth of a percent', () => {
    // 100 USD for 1,300,000 SYP, the other way round: 1,300,000 lira out, 100 dollars in.
    const stored = storedRate(1_300_000, 100)!;
    expect(stored).toBe(0.000077);
    // 1,300,000 × 0.000077 = 100.1 dollars — the column's six decimals cannot say 1/13000.
    expect(roundMinor(1_300_000 * stored, 2)).toBe(100.1);
    expect(roundMinor(1_300_000 * stored, 2)).not.toBe(100);
  });

  it('so the door keeps the typed amount, and the stored rate is only the reading of the two', () => {
    const r = resolveTransferAmounts({
      fromCode: 'SYP', toCode: 'USD', fromName: 'الليرة', toName: 'الدولار',
      amountOut: 1_300_000, amountIn: 100, fromMinor: 2, toMinor: 2,
    });
    expect(r).toMatchObject({ ok: true, amountOut: 1_300_000, amountIn: 100, rate: 0.000077, entered: 'AMOUNT_IN' });
  });

  it('a stored rate is derived from the two amounts, six decimals, in the direction the column has always had', () => {
    expect(storedRate(100, 1_300_000)).toBe(13_000);
    expect(storedRate(100, 141)).toBe(1.41);
    expect(storedRate(3, 1)).toBe(0.333333);
    expect(storedRate(7, 22)).toBe(3.142857);
  });

  it('a pair of amounts the column cannot hold has no stored rate', () => {
    // 1 lira for 0.01 dollars is 0.01 — fine; 10,000,000 lira for 0.01 dollars is 1e-9, below the six decimals.
    expect(storedRate(1, 0.01)).toBe(0.01);
    expect(storedRate(10_000_000, 0.01)).toBeNull();
    // 0.01 dollars for 1,000,000 lira is 100,000,000 — nine digits before the point; the column has eight.
    expect(storedRate(0.01, 1_000_000)).toBeNull();
    expect(storedRate(0, 5)).toBeNull();
    expect(storedRate(5, 0)).toBeNull();
  });
});

describe('what the door makes of a request', () => {
  const base = { fromCode: 'USD', toCode: 'SYP', fromName: 'الدولار', toName: 'الليرة', fromMinor: 2, toMinor: 2 };

  it('one currency: the same amount arrives, the rate is 1, and nothing else may come', () => {
    expect(resolveTransferAmounts({ ...base, toCode: 'USD', amountOut: 250 })).toEqual({
      ok: true, amountOut: 250, amountIn: 250, rate: 1, entered: 'NONE',
    });
    for (const extra of [{ exchangeRate: 1 }, { amountIn: 250 }, { exchangeRate: 2, amountIn: 500 }]) {
      expect(resolveTransferAmounts({ ...base, toCode: 'USD', amountOut: 250, ...extra })).toMatchObject({
        ok: false, code: 'RATE_NOT_ALLOWED',
      });
    }
  });

  it('two currencies need exactly one of them — both, or neither, is a refusal in Arabic', () => {
    const both = resolveTransferAmounts({ ...base, amountOut: 100, exchangeRate: 13000, amountIn: 1_300_000 });
    expect(both).toMatchObject({ ok: false, code: 'RATE_AND_AMOUNT_BOTH' });
    const neither = resolveTransferAmounts({ ...base, amountOut: 100 });
    expect(neither).toMatchObject({ ok: false, code: 'EXCHANGE_RATE_REQUIRED' });
    for (const said of [both, neither]) expect((said as { error: string }).error).toMatch(/[؀-ۿ]/);
    expect((neither as { error: string }).error).toContain('سعر صرف');
    expect((neither as { error: string }).error).toContain('المبلغ المستلم');
  });

  it('a rate: the arriving amount is the old arithmetic, rounded once to the destination, and the rate is kept as typed', () => {
    expect(resolveTransferAmounts({ ...base, amountOut: 100, exchangeRate: 13000.123456 })).toMatchObject({
      ok: true, amountOut: 100, amountIn: 1_300_012.35, rate: 13000.123456, entered: 'RATE',
    });
  });

  it('an arriving amount: stored as given, with the rate derived from the two', () => {
    expect(resolveTransferAmounts({ ...base, amountOut: 100, amountIn: 1_290_000 })).toMatchObject({
      ok: true, amountOut: 100, amountIn: 1_290_000, rate: 12_900, entered: 'AMOUNT_IN',
    });
  });

  it.each([
    ['zero', 0],
    ['a negative figure', -5],
    ['infinity', Number.POSITIVE_INFINITY],
    ['not a number', Number.NaN],
  ])('an arriving amount of %s is refused by name', (_why, amountIn) => {
    expect(resolveTransferAmounts({ ...base, amountOut: 100, amountIn })).toMatchObject({
      ok: false, code: 'AMOUNT_IN_INVALID',
    });
  });

  it('an arriving amount with more decimals than the destination counts in is refused, never rounded', () => {
    const said = resolveTransferAmounts({ ...base, amountOut: 100, amountIn: 1_290_000.005 });
    expect(said).toMatchObject({ ok: false, code: 'AMOUNT_IN_DECIMALS' });
    expect((said as { error: string }).error).toContain('خانتين عشريتين');
    expect((said as { error: string }).error).toContain('SYP');
  });

  it('what leaves, with more decimals than the source counts in, is refused too — on every path', () => {
    for (const extra of [{ exchangeRate: 13000 }, { amountIn: 1_300_000 }]) {
      const said = resolveTransferAmounts({ ...base, amountOut: 100.005, ...extra });
      expect(said, JSON.stringify(extra)).toMatchObject({ ok: false, code: 'AMOUNT_OUT_DECIMALS' });
      expect((said as { error: string }).error).toContain('USD');
    }
    expect(resolveTransferAmounts({ ...base, toCode: 'USD', amountOut: 100.005 })).toMatchObject({
      ok: false, code: 'AMOUNT_OUT_DECIMALS',
    });
  });

  it('JOD counts three decimals and a whole-number currency none', () => {
    expect(resolveTransferAmounts({ ...base, fromCode: 'JOD', fromMinor: 3, amountOut: 10.123, exchangeRate: 18000 }).ok).toBe(true);
    expect(resolveTransferAmounts({ ...base, fromCode: 'JOD', fromMinor: 3, amountOut: 10.1234, exchangeRate: 18000 })).toMatchObject({
      ok: false, code: 'AMOUNT_OUT_DECIMALS',
    });
    const none = resolveTransferAmounts({ ...base, fromMinor: 0, amountOut: 10.5, exchangeRate: 13000 });
    expect(none).toMatchObject({ ok: false, code: 'AMOUNT_OUT_DECIMALS' });
    expect((none as { error: string }).error).toContain('بلا كسور');
  });

  it('a rate that leaves nothing at the other end keeps the sentence it has always had', () => {
    const said = resolveTransferAmounts({ ...base, toMinor: 3, amountOut: 100, exchangeRate: 0.000001 });
    expect(said).toMatchObject({ ok: false, code: 'EXCHANGE_RATE_TOO_SMALL' });
    expect((said as { error: string }).error).toContain('صفراً');
  });

  it('an amount the books cannot hold, or a pair of amounts with no storable rate, is a refusal and not a crash', () => {
    // 100,000,000,000 — one more figure than `Decimal(14,3)` holds in front of the point
    expect(resolveTransferAmounts({ ...base, amountOut: 100, amountIn: 100_000_000_000 })).toMatchObject({
      ok: false, code: 'AMOUNT_IN_TOO_BIG',
    });
    expect(resolveTransferAmounts({ ...base, amountOut: 1_000_000_000, exchangeRate: 1_000_000 })).toMatchObject({
      ok: false, code: 'AMOUNT_IN_TOO_BIG',
    });
    expect(resolveTransferAmounts({ ...base, amountOut: 0.01, amountIn: 1_000_000 })).toMatchObject({
      ok: false, code: 'RATE_OUT_OF_RANGE',
    });
  });

  /*
   * THE OLD ARITHMETIC, KEPT BYTE FOR BYTE — A DIFFERENTIAL OVER A WIDE GRID.
   *
   * `legacy` is the route's own three lines, copied verbatim from before this change:
   *
   *     const rate = sameCurrency ? 1 : input.exchangeRate;
   *     const amountIn = roundMinor(input.amountOut * rate, to.country.minorUnit);
   *     const amountOut = roundMinor(input.amountOut, from.country.minorUnit);
   *
   * Every request the old door answered well — an amount the source can hold, a rate, two currencies; or one
   * currency and no rate — must get the SAME numbers from the new one, to the last digit.
   */
  describe('differential: the rate path against the old arithmetic', () => {
    const legacy = (typed: number, rate: number, same: boolean, fromMinor: number, toMinor: number) => {
      const r = same ? 1 : rate;
      return { amountIn: roundMinor(typed * r, toMinor), amountOut: roundMinor(typed, fromMinor), rate: r };
    };

    const MINORS: Array<[number, number]> = [[2, 2], [3, 3], [2, 3], [3, 2], [0, 2], [2, 0], [0, 0], [3, 0]];
    const RATES = [
      0.000001, 0.000005, 0.00001, 0.000077, 0.0000769231, 0.00008, 0.0001, 0.001, 0.01, 0.0825, 0.1, 0.27, 0.2667, 0.333333,
      0.5, 0.71, 0.7092, 0.99, 1, 1.01, 1.41, 1.4085, 2, 2.675, 3.75, 3.6725, 7.5, 10, 12.5, 33.3, 48.12, 100, 1310, 5000,
      12900, 13000, 13000.123456, 18000, 89500, 123456.789012, 999999.999999, 1_000_000,
    ];

    it('the same amountIn, amountOut and rate for every payload the old door took', () => {
      let compared = 0;
      for (const [fromMinor, toMinor] of MINORS) {
        const amounts = [1, 2, 3, 7, 10, 12, 99, 100, 250, 1000, 12345, 1_000_000, 999_999_999].concat(
          fromMinor >= 2 ? [0.01, 0.07, 0.5, 1.25, 99.99, 100.5, 250.25, 1234.56, 33.33] : [],
          fromMinor >= 3 ? [0.001, 0.123, 1.005, 33.333, 100.125, 12345.678] : []
        );
        for (const typed of amounts) {
          for (const rate of RATES) {
            const old = legacy(typed, rate, false, fromMinor, toMinor);
            const now = resolveTransferAmounts({
              fromCode: 'AAA', toCode: 'BBB', fromName: 'أ', toName: 'ب',
              amountOut: typed, exchangeRate: rate, fromMinor, toMinor,
            });
            if (old.amountIn <= 0 || old.amountIn > MAX_AMOUNT) {
              // The old door answered a 400 «صفراً», or a 500 from the column: the new one is a 400 either way.
              expect(now.ok, `${typed}×${rate} (${fromMinor},${toMinor})`).toBe(false);
              compared += 1;
              continue;
            }
            expect(now, `${typed}×${rate} (${fromMinor},${toMinor})`).toEqual({
              ok: true, amountOut: old.amountOut, amountIn: old.amountIn, rate: old.rate, entered: 'RATE',
            });
            // byte-identical, not merely close
            expect(Object.is((now as { amountIn: number }).amountIn, old.amountIn)).toBe(true);
            compared += 1;
          }
        }
      }
      expect(compared).toBeGreaterThan(3000);
    });

    it('and one currency with no rate: the same amount, rounded as the old door rounded it', () => {
      for (const [fromMinor, toMinor] of MINORS) {
        for (const typed of [1, 10, 250, 1000.5, 33.333].filter((x) => fitsMinorUnit(x, fromMinor))) {
          const old = legacy(typed, 1, true, fromMinor, toMinor);
          const now = resolveTransferAmounts({
            fromCode: 'USD', toCode: 'USD', fromName: 'أ', toName: 'ب', amountOut: typed, fromMinor, toMinor,
          });
          expect(now).toEqual({ ok: true, amountOut: old.amountOut, amountIn: old.amountIn, rate: 1, entered: 'NONE' });
        }
      }
    });
  });
});

describe('formatting a rate for a person, and for a box', () => {
  it.each([
    [13000, '13,000'],
    [12900.5, '12,900.5'],
    [12900.456, '12,900.46'],
    [1.4085, '1.4085'],
    [1.41, '1.41'],
    [3.75, '3.75'],
    [0.7092, '0.7092'],
    [0.00007692307, '0.00007692'],
    [0.000077, '0.000077'],
    [0.00008, '0.00008'],
    [1000000, '1,000,000'],
    [0.5, '0.5'],
  ])('writes %s as %s', (x, text) => {
    expect(formatRate(x)).toBe(text);
  });

  it('writes a dash for what is not a rate', () => {
    for (const x of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(formatRate(x)).toBe('—');
  });

  it('never an exponent and never an Arabic digit', () => {
    for (const x of [1e-9, 1e-7, 123456789.123, 5e-7]) {
      expect(formatRate(x)).not.toMatch(/e|[٠-٩]/i);
      expect(rateForBox(x)).not.toMatch(/e|[٠-٩]/i);
    }
  });

  it('a box holds enough digits that retyping it is the same deal', () => {
    expect(rateForBox(13000)).toBe('13000');
    expect(rateForBox(0.00008)).toBe('0.00008');
    expect(rateForBox(1 / 13000)).toBe('0.000076923077');
    expect(Number(rateForBox(1 / 13000))).toBeCloseTo(1 / 13000, 11);
    expect(rateForBox(0)).toBe('');
    expect(rateForBox(Number.NaN)).toBe('');
  });
});

describe('the A/B switch is a view: flipping it back and forth never moves the deal', () => {
  it('13,000 typed in A, shown in B as its inverse, and back in A as 13,000 — not 12,999.99', () => {
    const i = input({ ...USD_SYP, amountOutText: '100', face: 'A', text: '13000' });
    const deal = dealOf(i);
    expect(boxTextFor('A', i, deal)).toBe('13000');
    const inB = boxTextFor('B', i, deal);
    expect(inB).toBe('0.000076923077');
    // the deal is still worked from what was TYPED, so the card did not change
    expect(deal.amountIn).toBe(1_300_000);
    // and typing in B makes B the truth: the same board number in the other unit is the same deal, to the unit
    const retyped = dealOf(input({ ...USD_SYP, amountOutText: '100', face: 'B', text: inB }));
    expect(Math.abs(retyped.amountIn! - 1_300_000)).toBeLessThanOrEqual(0.01);
  });

  it('C shows the amount that results, and from C the rates are read off the two amounts', () => {
    const typedA = input({ ...USD_SYP, amountOutText: '100', face: 'A', text: '12900' });
    expect(boxTextFor('C', typedA, dealOf(typedA))).toBe('1290000');
    const typedC = input({ ...USD_SYP, amountOutText: '100', face: 'C', text: '1290000' });
    const deal = dealOf(typedC);
    expect(boxTextFor('A', typedC, deal)).toBe('12900');
    expect(boxTextFor('B', typedC, deal)).toBe(rateForBox(100 / 1_290_000));
    expect(boxTextFor('C', typedC, deal)).toBe('1290000');
  });

  it('nothing typed, nothing to show in another face', () => {
    const i = input({ ...USD_SYP, amountOutText: '', face: 'A', text: '' });
    for (const view of ['A', 'B', 'C'] as const) expect(boxTextFor(view, i, dealOf(i))).toBe('');
  });
});

describe('the deal while it is incomplete or wrong', () => {
  it('no amount, or an amount that is not a figure, is nothing yet', () => {
    for (const amountOutText of ['', 'abc', '0', '-3']) {
      expect(dealOf(input({ ...USD_SYP, amountOutText, face: 'A', text: '13000' }))).toEqual({
        amountOut: null, amountIn: null, verdict: null, rate: null,
      });
    }
  });

  it('an amount and no rate yet: the amount is known, nothing arrives', () => {
    const d = dealOf(input({ ...USD_SYP, amountOutText: '100', face: 'A', text: '' }));
    expect(d).toMatchObject({ amountOut: 100, amountIn: null, verdict: null, rate: null });
  });

  it('a rate that leaves nothing arriving is the door’s own refusal, before anyone presses', () => {
    // «دولار لكل دينار» is a rate about the dinar, which the dollars are not: face B is the rate per one DOLLAR.
    const d = dealOf(input({ from: 'USD', to: 'JOD', fromMinor: 2, toMinor: 3, amountOutText: '100', face: 'B', text: '0.000001' }));
    expect(d.verdict).toMatchObject({ ok: false, code: 'EXCHANGE_RATE_TOO_SMALL' });
    expect(d.amountIn).toBe(0);
  });

  it('an arriving amount with too many decimals is the door’s refusal too', () => {
    const d = dealOf(input({ ...USD_SYP, amountOutText: '100', face: 'C', text: '1290000.123' }));
    expect(d.verdict).toMatchObject({ ok: false, code: 'AMOUNT_IN_DECIMALS' });
  });

  it('one currency needs nothing typed: the same amount arrives, no rate on the card', () => {
    const d = dealOf(input({ from: 'USD', to: 'USD', amountOutText: '250' }));
    expect(d).toMatchObject({ amountOut: 250, amountIn: 250, rate: null });
    expect(d.verdict).toMatchObject({ ok: true, rate: 1, entered: 'NONE' });
  });

  it('digits typed on an Arabic keyboard are read', () => {
    const d = dealOf(input({ ...USD_SYP, amountOutText: '١٠٠', face: 'A', text: '١٣٬٠٠٠' }));
    expect(d.amountIn).toBe(1_300_000);
  });
});
