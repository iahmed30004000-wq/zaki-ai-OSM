import { describe, expect, it } from 'vitest';
import {
  activeSharesTotal,
  afterDraw,
  partnerLines,
  positionOf,
  shareHundredths,
  sharesProblem,
  type StatementPartner,
} from './partner-statement-core';
import { toMinorUnits } from './money';

/**
 * THE PARTNERS' ARITHMETIC (13/11) — the shares, the split, the balance and «مكسور عليه».
 *
 * «اذا حد تجاوز نسبة سحبة نسبة الربح بينعد مكسور عليه» (the owner). The four are 15 / 15 / 15 / 55 of the NET profit; what a partner
 * has drawn is measured against his share of it, since the beginning; what is over is «مكسور عليه», counted and shown, never refused.
 */

const FOUR: StatementPartner[] = [
  { id: 'mk', name: 'محمد كوري', sharePercent: 15, isActive: true },
  { id: 'ak', name: 'عبدالله كيوان', sharePercent: 15, isActive: true },
  { id: 'mq', name: 'محمد كيوان', sharePercent: 15, isActive: true },
  { id: 'ah', name: 'احمد كيوان', sharePercent: 55, isActive: true },
];

const lineOf = (lines: ReturnType<typeof partnerLines>, id: string) => lines.lines.find((l) => l.id === id)!;

describe('a share is judged as hundredths of a percent', () => {
  it('reads a number or a numeric string with at most two decimals, in (0, 100]', () => {
    expect(shareHundredths(15)).toBe(1500);
    expect(shareHundredths('33.33')).toBe(3333);
    expect(shareHundredths(100)).toBe(10000);
    expect(shareHundredths(0.01)).toBe(1);
  });

  it('refuses zero, negative, over 100, three decimals, text and nothing', () => {
    for (const bad of [0, -5, 100.01, 150, 33.333, 0.005, 'abc', '', ' ', null, undefined, Number.NaN, Number.POSITIVE_INFINITY, {}, []]) {
      expect(shareHundredths(bad), String(bad)).toBeNull();
    }
  });

  it('a string is judged as the characters it is: «0x10», «1e1», «2,5», «-5» and «15%» are not shares', () => {
    for (const bad of ['0x10', '1e1', '2,5', '-5', '15%', '15 20', '٣٣', 'Infinity']) {
      expect(shareHundredths(bad), bad).toBeNull();
    }
    expect(shareHundredths(' 15 ')).toBe(1500);
    expect(shareHundredths('.5')).toBe(50);
    expect(shareHundredths('15.')).toBe(1500);
  });

  it('adds only the active ones, and a row that is not a share counts nothing', () => {
    expect(
      activeSharesTotal([
        { name: 'أ', sharePercent: 15, isActive: true },
        { name: 'ب', sharePercent: 85, isActive: false },
        { name: 'ج', sharePercent: 'x', isActive: true },
        { name: 'د', sharePercent: 33.33, isActive: true },
      ])
    ).toBe(48.33);
  });
});

describe('a list of partners may be saved only when it is whole', () => {
  const four = FOUR.map((p) => ({ name: p.name, sharePercent: p.sharePercent, isActive: p.isActive }));

  it('the owner’s four, 15 + 15 + 15 + 55 = 100, are accepted', () => {
    expect(sharesProblem(four)).toBeNull();
  });

  it('the active shares must total EXACTLY 100.00: 99.99 and 100.01 are refused, with the total in the sentence', () => {
    const a = sharesProblem([{ ...four[0], sharePercent: 14.99 }, four[1], four[2], four[3]]);
    expect(a?.code).toBe('SHARES_NOT_100');
    expect(a?.error).toContain('99.99');
    expect(a?.error).toContain('100');
    const b = sharesProblem([{ ...four[0], sharePercent: 15.01 }, four[1], four[2], four[3]]);
    expect(b?.code).toBe('SHARES_NOT_100');
    expect(b?.error).toContain('100.01');
  });

  it('thirds that add to 100.00: 33.33 + 33.33 + 33.34 is accepted, 33.33 × 3 is not', () => {
    const ok = [
      { name: 'شريك أ', sharePercent: 33.33, isActive: true },
      { name: 'شريك ب', sharePercent: 33.33, isActive: true },
      { name: 'شريك ج', sharePercent: 33.34, isActive: true },
    ];
    expect(sharesProblem(ok)).toBeNull();
    expect(sharesProblem([ok[0], ok[1], { ...ok[2], sharePercent: 33.33 }])?.code).toBe('SHARES_NOT_100');
  });

  it('a partner who is switched off is not in the total — 100 among the active is what counts', () => {
    expect(sharesProblem([...four, { name: 'شريك سابق', sharePercent: 40, isActive: false }])).toBeNull();
    expect(sharesProblem([{ ...four[0], isActive: false }, four[1], four[2], four[3]])?.code).toBe('SHARES_NOT_100');
  });

  it('an empty list, a list with nobody active, too many, a short name, a long name, a repeated name, a bad share', () => {
    expect(sharesProblem([])?.code).toBe('NO_PARTNERS');
    expect(sharesProblem([{ ...four[0], isActive: false }])?.code).toBe('NO_ACTIVE');
    expect(sharesProblem(Array.from({ length: 21 }, (_, i) => ({ name: `شريك ${i + 10}`, sharePercent: 1, isActive: true })))?.code).toBe('TOO_MANY');
    expect(sharesProblem([{ ...four[0], name: 'ا' }, ...four.slice(1)])?.code).toBe('NAME_REQUIRED');
    expect(sharesProblem([{ ...four[0], name: '   ' }, ...four.slice(1)])?.code).toBe('NAME_REQUIRED');
    expect(sharesProblem([{ ...four[0], name: 'ا'.repeat(61) }, ...four.slice(1)])?.code).toBe('NAME_TOO_LONG');
    expect(sharesProblem([four[0], { ...four[1], name: '  محمد   كوري ' }, four[2], four[3]])?.code).toBe('NAME_TWICE');
    expect(sharesProblem([{ ...four[0], sharePercent: 0 }, ...four.slice(1)])?.code).toBe('SHARE_INVALID');
    expect(sharesProblem([{ ...four[0], sharePercent: 15.123 }, ...four.slice(1)])?.code).toBe('SHARE_INVALID');
    expect(sharesProblem([{ ...four[0], sharePercent: 120 }, ...four.slice(1)])?.code).toBe('SHARE_INVALID');
  });

  it('a switched-off partner’s share must still be a real share — the database holds the same range', () => {
    expect(sharesProblem([...four, { name: 'سابق', sharePercent: 0, isActive: false }])?.code).toBe('SHARE_INVALID');
  });

  it('every refusal is a sentence in Arabic with Western digits and no English word', () => {
    const sentences = [
      sharesProblem([]),
      sharesProblem([{ ...four[0], isActive: false }]),
      sharesProblem([{ ...four[0], sharePercent: 14.99 }, ...four.slice(1)]),
      sharesProblem([{ ...four[0], name: 'ا' }, ...four.slice(1)]),
      sharesProblem([four[0], { ...four[1], name: four[0].name }, four[2], four[3]]),
      sharesProblem([{ ...four[0], sharePercent: 0 }, ...four.slice(1)]),
    ].map((r) => r!.error);
    for (const s of sentences) {
      expect(s, s).toMatch(/[؀-ۿ]/);
      expect(s, s).not.toMatch(/[A-Za-z]{2,}/);
      expect(s, s).not.toMatch(/[٠-٩]/);
    }
  });
});

describe('the balance, and «مكسور عليه» at the edges', () => {
  it('a draw below the share leaves a positive balance and nothing broken', () => {
    expect(positionOf(10000, 4000)).toEqual({ balanceUnits: 6000, brokenUnits: 0 });
  });

  it('EQUAL IS NOT BROKEN: a draw exactly equal to the share is a balance of zero, not «مكسور عليه»', () => {
    const p = positionOf(10000, 10000);
    expect(p.balanceUnits).toBe(0);
    expect(p.brokenUnits).toBe(0);
    expect(Object.is(p.brokenUnits, 0)).toBe(true);
  });

  it('ONE UNIT over is broken by exactly one unit', () => {
    expect(positionOf(10000, 10001)).toEqual({ balanceUnits: -1, brokenUnits: 1 });
  });

  it('a share of nothing and any draw at all is all broken', () => {
    expect(positionOf(0, 2500)).toEqual({ balanceUnits: -2500, brokenUnits: 2500 });
    expect(positionOf(0, 0)).toEqual({ balanceUnits: 0, brokenUnits: 0 });
  });
});

describe('the statement over the owner’s four', () => {
  it('splits the net profit 15 / 15 / 15 / 55, and the entitlements add up to the profit exactly', () => {
    const s = partnerLines({ netProfit: 277.91, partners: FOUR, drawsUnits: {}, minorUnit: 2 });
    expect(s.state).toBe('OK');
    expect(s.sharesTotal).toBe(100);
    expect(s.lines.map((l) => l.entitlement)).toEqual([41.69, 41.69, 41.68, 152.85]);
    expect(s.totals.entitlement).toBe(277.91);
    expect(s.lines.every((l) => l.draws === 0 && l.broken === 0)).toBe(true);
  });

  it('the draws are measured against each share, and the balance is the share less the draws', () => {
    const s = partnerLines({ netProfit: 1000, partners: FOUR, drawsUnits: { mk: 10000, ah: 30000 }, minorUnit: 2 });
    expect(lineOf(s, 'mk')).toMatchObject({ entitlement: 150, draws: 100, balance: 50, broken: 0 });
    expect(lineOf(s, 'ah')).toMatchObject({ entitlement: 550, draws: 300, balance: 250, broken: 0 });
    expect(s.totals).toEqual({ entitlement: 1000, draws: 400, broken: 0 });
  });

  it('a partner who draws past his share is «مكسور عليه» by the excess — and only he is', () => {
    const s = partnerLines({ netProfit: 1000, partners: FOUR, drawsUnits: { mk: 20000, ah: 55000 }, minorUnit: 2 });
    expect(lineOf(s, 'mk')).toMatchObject({ entitlement: 150, draws: 200, balance: -50, broken: 50 });
    // 550 drawn of an entitlement of 550 — equal, not broken
    expect(lineOf(s, 'ah')).toMatchObject({ entitlement: 550, draws: 550, balance: 0, broken: 0 });
    expect(lineOf(s, 'ak').broken).toBe(0);
    expect(s.totals.broken).toBe(50);
  });

  it('A LOSS gives every partner an entitlement of zero — and every draw is then «مكسور عليه»', () => {
    const s = partnerLines({ netProfit: -722.1, partners: FOUR, drawsUnits: { ah: 10000 }, minorUnit: 2 });
    expect(s.lines.map((l) => l.entitlement)).toEqual([0, 0, 0, 0]);
    expect(lineOf(s, 'ah')).toMatchObject({ entitlement: 0, draws: 100, balance: -100, broken: 100 });
    expect(s.totals.entitlement).toBe(0);
  });

  it('a profit of zero is the same as a loss for the shares', () => {
    const s = partnerLines({ netProfit: 0, partners: FOUR, drawsUnits: {}, minorUnit: 2 });
    expect(s.lines.map((l) => l.entitlement)).toEqual([0, 0, 0, 0]);
  });

  it('it carries forward by construction: the same draws against a bigger profit are no longer broken', () => {
    const draws = { mk: 20000 };
    expect(lineOf(partnerLines({ netProfit: 1000, partners: FOUR, drawsUnits: draws, minorUnit: 2 }), 'mk').broken).toBe(50);
    expect(lineOf(partnerLines({ netProfit: 2000, partners: FOUR, drawsUnits: draws, minorUnit: 2 }), 'mk').broken).toBe(0);
  });

  it('a three-decimal currency keeps the fils: 100.01 JOD splits into fils that add to 100.010', () => {
    const s = partnerLines({ netProfit: 100.01, partners: FOUR, drawsUnits: {}, minorUnit: 3 });
    expect(s.lines.map((l) => toMinorUnits(l.entitlement as number, 3)).reduce((a, b) => a + b, 0)).toBe(100010);
    expect(s.lines.map((l) => l.entitlement)).toEqual([15.002, 15.002, 15.001, 55.005]);
  });

  it('the cent that does not split goes by the biggest fraction, so it does not always fall on the same man', () => {
    const at = (net: number) => partnerLines({ netProfit: net, partners: FOUR, drawsUnits: {}, minorUnit: 2 }).lines.map((l) => l.entitlement);
    expect(at(100.01)).toEqual([15, 15, 15, 55.01]);
    expect(at(277.91)).toEqual([41.69, 41.69, 41.68, 152.85]);
  });

  it('a partner switched off is out of the split, and is listed only while he has draws that stand', () => {
    const partners = [...FOUR.map((p) => (p.id === 'mq' ? { ...p, isActive: false } : p)), { id: 'x', name: 'شريك جديد', sharePercent: 15, isActive: true }];
    const without = partnerLines({ netProfit: 1000, partners, drawsUnits: {}, minorUnit: 2 });
    expect(without.lines.map((l) => l.id)).toEqual(['mk', 'ak', 'ah', 'x']);
    expect(without.state).toBe('OK');
    const withDraws = partnerLines({ netProfit: 1000, partners, drawsUnits: { mq: 5000 }, minorUnit: 2 });
    expect(withDraws.lines.map((l) => l.id)).toEqual(['mk', 'ak', 'mq', 'ah', 'x']);
    // he is out of the split: his entitlement is 0, so what he took stands as broken — today's shares for all history
    expect(lineOf(withDraws, 'mq')).toMatchObject({ isActive: false, entitlement: 0, draws: 50, broken: 50 });
  });

  it('SHARES NOT TOTALLING 100: nothing is split, and no one is called «مكسور عليه» on a guess', () => {
    const partners = FOUR.map((p) => (p.id === 'ah' ? { ...p, sharePercent: 50 } : p));
    const s = partnerLines({ netProfit: 1000, partners, drawsUnits: { mk: 99999 }, minorUnit: 2 });
    expect(s.state).toBe('SHARES_NOT_100');
    expect(s.sharesTotal).toBe(95);
    expect(s.lines.every((l) => l.entitlement === null && l.balance === null && l.broken === null)).toBe(true);
    // what he took is still shown — the money does not vanish because the shares are wrong
    expect(lineOf(s, 'mk').draws).toBe(999.99);
    expect(s.totals).toEqual({ entitlement: null, draws: 999.99, broken: null });
  });

  it('no active partner: the state says so, and the draws of the switched-off ones are still shown', () => {
    const none = FOUR.map((p) => ({ ...p, isActive: false }));
    const s = partnerLines({ netProfit: 1000, partners: none, drawsUnits: { mk: 1000 }, minorUnit: 2 });
    expect(s.state).toBe('NO_PARTNERS');
    expect(s.lines.map((l) => l.id)).toEqual(['mk']);
    expect(s.lines[0].broken).toBeNull();
    expect(partnerLines({ netProfit: 1000, partners: [], drawsUnits: {}, minorUnit: 2 }).lines).toEqual([]);
  });

  it('the order the partners come in is the order of the lines, and it breaks the tie of the last cent', () => {
    const reversed = [...FOUR].reverse();
    const s = partnerLines({ netProfit: 277.91, partners: reversed, drawsUnits: {}, minorUnit: 2 });
    expect(s.lines.map((l) => l.id)).toEqual(['ah', 'mq', 'ak', 'mk']);
    expect(s.lines.map((l) => l.entitlement)).toEqual([152.85, 41.69, 41.69, 41.68]);
  });
});

describe('«بعد هالسحب» — the very subtraction the statement makes', () => {
  const line = { entitlement: 150, draws: 100 };

  it('a draw inside what is left says nothing is broken', () => {
    expect(afterDraw(line, 30, 2)).toEqual({ draws: 130, balance: 20, broken: 0 });
  });

  it('a draw to the cent of what is left is not broken', () => {
    expect(afterDraw(line, 50, 2)).toEqual({ draws: 150, balance: 0, broken: 0 });
  });

  it('a draw past it says by how much — and it is still only a message: the draw is allowed', () => {
    expect(afterDraw(line, 50.01, 2)).toEqual({ draws: 150.01, balance: -0.01, broken: 0.01 });
    expect(afterDraw(line, 300, 2)).toEqual({ draws: 400, balance: -250, broken: 250 });
  });

  it('it agrees with the statement: the line after the draw is the line of the statement with the draw in its draws', () => {
    const before = partnerLines({ netProfit: 1000, partners: FOUR, drawsUnits: { mk: 10000 }, minorUnit: 2 });
    const hint = afterDraw(lineOf(before, 'mk') as { entitlement: number; draws: number }, 75.5, 2);
    const after = partnerLines({ netProfit: 1000, partners: FOUR, drawsUnits: { mk: 10000 + 7550 }, minorUnit: 2 });
    expect(hint).toEqual({ draws: lineOf(after, 'mk').draws, balance: lineOf(after, 'mk').balance, broken: lineOf(after, 'mk').broken });
  });

  it('floats do not creep in: 0.1 + 0.2 against 0.3 is equal, not a cent broken', () => {
    expect(afterDraw({ entitlement: 0.3, draws: 0.1 }, 0.2, 2)).toEqual({ draws: 0.3, balance: 0, broken: 0 });
  });

  it('with no entitlement to measure against (shares not cut) the answer is null, not a guess', () => {
    expect(afterDraw({ entitlement: null, draws: 10 }, 5, 2)).toEqual({ draws: 15, balance: null, broken: null });
  });
});
