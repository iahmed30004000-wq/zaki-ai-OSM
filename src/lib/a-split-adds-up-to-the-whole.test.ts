import { describe, expect, it } from 'vitest';
import { fromMinorUnits, roundMinor, splitUnitsByShares, toMinorUnits } from './money';

/** A profit as figures: the one rounding rule to whole units, the split of those units, and each part back as a figure. */
const splitByShares = (total: number, shares: readonly number[], minorUnit: number) =>
  splitUnitsByShares(toMinorUnits(total, minorUnit), shares).map((u) => fromMinorUnits(u, minorUnit));

/**
 * THE SPLIT OF A PROFIT BETWEEN PARTNERS ADDS UP TO THE PROFIT — to the last minor unit, every time (13/11).
 *
 * «الربح لازم يتم توزيعه وفق هاي النسب». Four partners with 15 / 15 / 15 / 55: each share rounded on its own can leave the four
 * parts a cent over or under the whole, and a whole that is not the sum of its parts is a ledger that never ties. The split is by
 * LARGEST REMAINDER in whole minor units — each part rounded down, the units still unspent going one each to the biggest rounded-off
 * fractions — so the parts always add up, every part is within one unit of its exact share, and the same input gives the same answer.
 *
 * A property test over thousands of random profits and share sets stands beside the worked examples: the examples say what the
 * answer is, the property says it cannot be otherwise.
 */

/** A small deterministic generator, so a failure is reproducible from its seed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Shares in hundredths that add up to 10000 exactly, `n` of them, each at least 1. */
function randomShares(next: () => number, n: number): number[] {
  const cuts = new Set<number>();
  while (cuts.size < n - 1) cuts.add(1 + Math.floor(next() * 9999));
  const sorted = [0, ...[...cuts].sort((a, b) => a - b), 10000];
  return sorted.slice(1).map((c, i) => c - sorted[i]);
}

describe('the minor units a figure is made of', () => {
  it('a figure becomes whole units by the one rounding rule, and back', () => {
    expect(toMinorUnits(277.91, 2)).toBe(27791);
    expect(toMinorUnits(0.1 + 0.2, 2)).toBe(30);
    expect(toMinorUnits(12.345, 3)).toBe(12345);
    // half away from zero, as `roundMinor` says — the same answer every other door gives
    expect(toMinorUnits(2.675, 2)).toBe(268);
    expect(toMinorUnits(-2.675, 2)).toBe(-268);
    expect(fromMinorUnits(27791, 2)).toBe(277.91);
    expect(fromMinorUnits(12345, 3)).toBe(12.345);
    expect(fromMinorUnits(toMinorUnits(100.1, 2), 2)).toBe(roundMinor(100.1, 2));
  });

  it('a currency with no minor unit is whole numbers, and one with three keeps the fils', () => {
    expect(toMinorUnits(1234.6, 0)).toBe(1235);
    expect(toMinorUnits(1.5, 3)).toBe(1500);
  });
});

describe('the worked examples — the owner’s four partners, 15 / 15 / 15 / 55', () => {
  const shares = [15, 15, 15, 55];

  it('a round profit splits exactly: 1000 → 150 · 150 · 150 · 550', () => {
    expect(splitByShares(1000, shares, 2)).toEqual([150, 150, 150, 550]);
  });

  it('ONE CENT OVER a clean split: 100.01 → the odd cent goes to the biggest fraction, and the parts add to 100.01', () => {
    // exact: 15.0015 · 15.0015 · 15.0015 · 55.0055 — in cents 1500.15 · 1500.15 · 1500.15 · 5500.55
    // down: 1500 · 1500 · 1500 · 5500 = 10000, one cent unspent; the fractions .15 .15 .15 .55 → the 55% partner gets it
    expect(splitUnitsByShares(10001, shares)).toEqual([1500, 1500, 1500, 5501]);
    expect(splitByShares(100.01, shares, 2)).toEqual([15, 15, 15, 55.01]);
  });

  it('two cents over: the two biggest fractions get one each, equal fractions in the order given', () => {
    // 10002 cents: exact 1500.3 · 1500.3 · 1500.3 · 5501.1 → down 1500 · 1500 · 1500 · 5501 = 10001, one unspent;
    // fractions .3 .3 .3 .1 → the FIRST of the three equal ones
    expect(splitUnitsByShares(10002, shares)).toEqual([1501, 1500, 1500, 5501]);
  });

  it('a three-decimal currency (JOD): 100.010 → in fils, and the parts add to the whole', () => {
    // 100010 fils: exact 15001.5 · 15001.5 · 15001.5 · 55005.5 — down 15001 ×3 + 55005 = 100008, two unspent, and ALL FOUR
    // fractions are .5: a tie, so the first two in the order given get the fils (it is the order, not the size, that breaks a tie).
    const parts = splitByShares(100.01, shares, 3);
    expect(parts).toEqual([15.002, 15.002, 15.001, 55.005]);
    expect(parts.reduce((s, p) => s + toMinorUnits(p, 3), 0)).toBe(toMinorUnits(100.01, 3));
  });

  it('a currency with no minor unit: 1001 → whole numbers that add to 1001', () => {
    const parts = splitByShares(1001, shares, 0);
    expect(parts.reduce((s, p) => s + p, 0)).toBe(1001);
    expect(parts.every((p) => Number.isInteger(p))).toBe(true);
  });

  it('the profit on the pinned worked example of the profit screen: 277.91', () => {
    const parts = splitByShares(277.91, shares, 2);
    // exact: 41.6865 · 41.6865 · 41.6865 · 152.8505 → cents 4168.65 ×3 and 15285.05; down 4168 ×3 + 15285 = 27789, two unspent;
    // fractions .65 .65 .65 .05 → the first two of the three equal ones
    expect(parts).toEqual([41.69, 41.69, 41.68, 152.85]);
    expect(parts.reduce((s, p) => s + toMinorUnits(p, 2), 0)).toBe(27791);
  });

  it('nothing to share: zero, a loss and a non-number all give zeros, and so do shares that add to nothing', () => {
    expect(splitByShares(0, shares, 2)).toEqual([0, 0, 0, 0]);
    expect(splitByShares(-500, shares, 2)).toEqual([0, 0, 0, 0]);
    expect(splitByShares(Number.NaN, shares, 2)).toEqual([0, 0, 0, 0]);
    expect(splitByShares(100, [0, 0], 2)).toEqual([0, 0]);
    expect(splitByShares(100, [], 2)).toEqual([]);
  });

  it('one partner with the whole: he gets all of it, to the last unit', () => {
    expect(splitByShares(123.45, [100], 2)).toEqual([123.45]);
  });

  it('a share that cannot be read is a bug and throws — never rounded behind the caller’s back', () => {
    expect(() => splitUnitsByShares(1000, [15, -1])).toThrow(RangeError);
    expect(() => splitUnitsByShares(1000, [15, Number.NaN])).toThrow(RangeError);
    expect(() => splitUnitsByShares(1000, [15.005, 84.995])).toThrow(RangeError);
    expect(() => splitUnitsByShares(1000, ['15' as unknown as number])).toThrow(RangeError);
  });
});

describe('PROPERTY: over thousands of random profits and share sets', () => {
  const next = rng(20261113);

  it('the parts add up to the whole — exactly, in whole units', () => {
    for (let i = 0; i < 4000; i++) {
      const n = 1 + Math.floor(next() * 8);
      const shares = randomShares(next, n).map((h) => h / 100);
      const total = Math.floor(next() * 5_000_000);
      const parts = splitUnitsByShares(total, shares);
      expect(parts.reduce((a, b) => a + b, 0), `total ${total} shares ${shares}`).toBe(total);
    }
  });

  it('every part is within one unit of its exact share, and never negative', () => {
    for (let i = 0; i < 4000; i++) {
      const n = 1 + Math.floor(next() * 8);
      const hundredths = randomShares(next, n);
      const total = Math.floor(next() * 5_000_000);
      const parts = splitUnitsByShares(total, hundredths.map((h) => h / 100));
      parts.forEach((p, k) => {
        const exact = (total * hundredths[k]) / 10000;
        expect(p, `part ${k}`).toBeGreaterThanOrEqual(0);
        expect(Math.abs(p - exact), `part ${k} of ${total}`).toBeLessThan(1);
      });
    }
  });

  it('a larger share never gets less than a smaller one', () => {
    for (let i = 0; i < 4000; i++) {
      const n = 2 + Math.floor(next() * 7);
      const hundredths = randomShares(next, n);
      const total = Math.floor(next() * 5_000_000);
      const parts = splitUnitsByShares(total, hundredths.map((h) => h / 100));
      for (let a = 0; a < n; a++) {
        for (let b = 0; b < n; b++) {
          if (hundredths[a] > hundredths[b]) expect(parts[a], `${hundredths[a]} vs ${hundredths[b]} of ${total}`).toBeGreaterThanOrEqual(parts[b]);
        }
      }
    }
  });

  it('the same input always gives the same answer, and the figures version agrees with the units version', () => {
    for (let i = 0; i < 500; i++) {
      const n = 1 + Math.floor(next() * 6);
      const shares = randomShares(next, n).map((h) => h / 100);
      const total = Math.floor(next() * 5_000_000);
      const minor = Math.floor(next() * 4);
      expect(splitUnitsByShares(total, shares)).toEqual(splitUnitsByShares(total, shares));
      const figures = splitByShares(fromMinorUnits(total, minor), shares, minor);
      expect(figures.map((f) => toMinorUnits(f, minor))).toEqual(splitUnitsByShares(total, shares));
    }
  });

  it('a profit with cents and a currency with fils: the sum of the figures is the profit, whatever the decimals', () => {
    for (let i = 0; i < 2000; i++) {
      const minor = Math.floor(next() * 4);
      const total = fromMinorUnits(Math.floor(next() * 9_000_000), minor);
      const shares = randomShares(next, 4).map((h) => h / 100);
      const parts = splitByShares(total, shares, minor);
      expect(parts.reduce((s, p) => s + toMinorUnits(p, minor), 0)).toBe(toMinorUnits(total, minor));
    }
  });

  it('big profits do not overflow a float on the way: a billion at three decimals', () => {
    const total = 1_000_000_000_000; // 1e9 with three decimals, in fils
    const parts = splitUnitsByShares(total, [15, 15, 15, 55]);
    expect(parts).toEqual([150_000_000_000, 150_000_000_000, 150_000_000_000, 550_000_000_000]);
    const odd = splitUnitsByShares(total + 1, [15, 15, 15, 55]);
    expect(odd.reduce((a, b) => a + b, 0)).toBe(total + 1);
  });
});

/**
 * A HUGE TOTAL — where a float is already wrong and the parts still add up.
 *
 * A billion at three decimals (above) fits a float: 1e12 × 5500 is under 2^53. This does not: a total of 7.35 quadrillion units times a
 * weight of 1500 is 1.1e19, far past the 9.007e15 a float holds exactly, so a split done in floats misjudges which fraction is the
 * biggest — and ends up ONE UNIT on the wrong partner while the parts still add up to the total, which is why a sum-check never
 * sees it. The spare unit has to go to the biggest fraction, to the last digit. These are measured behaviours (found by running the
 * float split against the exact one over random totals), not a look at how the function is written.
 */
describe('a HUGE total is split to the last unit', () => {
  /** The same answer worked a different way: each share as an exact fraction, the spare units to the biggest fractions, ties in order. */
  function exactSplit(total: number, hundredths: number[]): number[] {
    const whole = hundredths.reduce((a, b) => a + b, 0);
    const t = BigInt(total);
    const cut = hundredths.map((h) => ({ floor: (t * BigInt(h)) / BigInt(whole), rest: (t * BigInt(h)) % BigInt(whole) }));
    let spare = Number(t - cut.reduce((a, c) => a + c.floor, BigInt(0)));
    const byFraction = cut.map((c, i) => ({ i, rest: c.rest })).sort((a, b) => (a.rest === b.rest ? a.i - b.i : a.rest > b.rest ? -1 : 1));
    const parts = cut.map((c) => c.floor);
    for (const { i } of byFraction) {
      if (spare-- <= 0) break;
      parts[i] += BigInt(1);
    }
    return parts.map(Number);
  }

  it('7 352 052 004 175 182 units: the 15% shares are …277.30 and the 55% is …350.10, so the one spare unit goes to the FIRST of the .30s', () => {
    // 7352052004175182 × 15 / 100 = 1102807800626277.30 (three of them) · × 55 / 100 = 4043628602296350.10 · floors add to the total less one
    expect(splitUnitsByShares(7352052004175182, [15, 15, 15, 55])).toEqual([1102807800626278, 1102807800626277, 1102807800626277, 4043628602296350]);
  });

  it('three more totals on which the float split puts the spare unit on the 55%, where the exact one does not', () => {
    expect(splitUnitsByShares(7563622093274662, [15, 15, 15, 55])).toEqual([1134543313991200, 1134543313991199, 1134543313991199, 4159992151301064]);
    expect(splitUnitsByShares(5281362370463422, [15, 15, 15, 55])).toEqual([792204355569514, 792204355569513, 792204355569513, 2904749303754882]);
    expect(splitUnitsByShares(7115108993109582, [15, 15, 15, 55])).toEqual([1067266348966438, 1067266348966437, 1067266348966437, 3913309946210270]);
  });

  it('the biggest whole number a float holds exactly — 9 007 199 254 740 991 — splits and adds up, four shares or three thirds', () => {
    const top = Number.MAX_SAFE_INTEGER;
    // …× 15% = …148.65 (three) and × 55% = …545.05: floors fall two units short, and the two go to the first two .65s
    expect(splitUnitsByShares(top, [15, 15, 15, 55])).toEqual([1351079888211149, 1351079888211149, 1351079888211148, 4953959590107545]);
    // × 33.33% = …172.3003 (twice) and × 33.34% = …646.3994: floors fall one short, and the one goes to the biggest fraction — the last
    expect(splitUnitsByShares(top, [33.33, 33.33, 33.34])).toEqual([3002099511605172, 3002099511605172, 3003000231530647]);
    for (const shares of [[15, 15, 15, 55], [33.33, 33.33, 33.34]]) {
      expect(splitUnitsByShares(top, shares).reduce((a, b) => a + b, 0)).toBe(top);
    }
  });

  it('across a few hundred totals from 2^52 up to the top of the safe range, the split is the exact one and adds up to the total', () => {
    const next = rng(13112026);
    const sets = [[15, 15, 15, 55], [33.33, 33.33, 33.34], [1, 99], [20, 20, 20, 20, 20], [0.01, 99.99]];
    for (let i = 0; i < 400; i++) {
      const total = 2 ** 52 + Math.floor(next() * (2 ** 52 - 1));
      const shares = sets[i % sets.length];
      const parts = splitUnitsByShares(total, shares);
      expect(parts, `total ${total} shares ${shares}`).toEqual(exactSplit(total, shares.map((s) => Math.round(s * 100))));
      expect(parts.reduce((a, b) => a + b, 0), `total ${total}`).toBe(total);
    }
  });

  it('a total past the largest safe whole number is not split on a guess: it comes back as nothing to share', () => {
    expect(splitUnitsByShares(2 ** 53, [15, 15, 15, 55])).toEqual([0, 0, 0, 0]);
    expect(splitUnitsByShares(Number.MAX_SAFE_INTEGER + 2, [100])).toEqual([0]);
  });
});
