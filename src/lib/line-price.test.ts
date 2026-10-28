import { describe, expect, it } from 'vitest';
import { atBasePrice } from './line-price';
import { computeCod } from './money';
import { repoFile, stripComments } from './guard-source';

/**
 * THE FIGURE THE ORDER FORM SUGGESTS IS THE FIGURE THE ONE COD FUNCTION GIVES.
 *
 * The manual order form's price box holds the total for the line's paid
 * quantity. While nobody has written in it, it follows the quantity at the
 * product's base price — and that figure is `atBasePrice`, never a product
 * typed out in a screen. These hold it to `computeCod`'s own line value,
 * read the currency's minor unit rather than assume one, and say nothing at
 * all when there is nothing honest to say.
 *
 * Every rule has its NEGATIVE beside it, so a check that cannot fail is seen
 * to be able to.
 */

describe('the base price for the paid quantity, rounded by the currency', () => {
  it('the worked example: 25 for one piece, 50 for two, 75 for three', () => {
    expect(atBasePrice(25, 1, 2)).toBe(25);
    expect(atBasePrice(25, 2, 2)).toBe(50);
    expect(atBasePrice(25, 3, 2)).toBe(75);
    // NEGATIVE: the figure moves with the quantity — two pieces are not 25.
    expect(atBasePrice(25, 2, 2)).not.toBe(25);
  });

  it('two decimals: 0.1 × 3 is 0.3, not float noise', () => {
    expect(atBasePrice(0.1, 3, 2)).toBe(0.3);
    expect(String(atBasePrice(0.1, 3, 2))).toBe('0.3');
    // NEGATIVE: the bare product is NOT 0.3, so the rounding is what made it so.
    expect(0.1 * 3).not.toBe(0.3);
    expect(String(0.1 * 3)).toBe('0.30000000000000004');
  });

  it('three decimals keep the third: 0.125 × 3 is 0.375', () => {
    expect(atBasePrice(0.125, 3, 3)).toBe(0.375);
    // NEGATIVE: at two decimals the same pieces give 0.38 — the unit is read, not fixed at two.
    expect(atBasePrice(0.125, 3, 2)).toBe(0.38);
  });

  it('a whole-unit currency rounds half away from zero: 12.5 × 3 is 38', () => {
    expect(atBasePrice(12.5, 3, 0)).toBe(38);
    // NEGATIVE: not 37.5 — nothing below the unit survives.
    expect(atBasePrice(12.5, 3, 0)).not.toBe(37.5);
    // And 0 IS a unit. A check that read it as «no unit» would answer nothing here.
    expect(atBasePrice(14, 2, 0)).toBe(28);
  });
});

describe('and it is computeCod’s own figure for that line', () => {
  it('over every quantity from 1 to 12, three units and five base prices', () => {
    let compared = 0;
    for (const unit of [0, 2, 3]) {
      for (const base of [0.1, 1.2345, 12.5, 14, 25]) {
        for (let q = 1; q <= 12; q++) {
          const cod = computeCod({ lines: [{ quantity: q, unitPrice: base }], minorUnit: unit });
          expect(atBasePrice(base, q, unit), `${base} × ${q} @ ${unit}`).toBe(cod.subtotal);
          expect(atBasePrice(base, q, unit), `${base} × ${q} @ ${unit}`).toBe(cod.lineTotals[0]);
          compared++;
        }
      }
    }
    expect(compared).toBe(180);
  });

  it('NEGATIVE: the unrounded product disagrees with it, so the comparison above can fail', () => {
    const cod = computeCod({ lines: [{ quantity: 3, unitPrice: 0.1 }], minorUnit: 2 });
    expect(0.1 * 3).not.toBe(cod.subtotal);
    expect(atBasePrice(0.1, 3, 2)).toBe(cod.subtotal);
  });
});

describe('no figure where there is nothing honest to say', () => {
  it('a base price that is 0, negative, not a number, or missing gives an empty box', () => {
    expect(atBasePrice(0, 1, 2)).toBeUndefined();
    expect(atBasePrice(0, 3, 2)).toBeUndefined();
    expect(atBasePrice(-5, 1, 2)).toBeUndefined();
    expect(atBasePrice(Number.NaN, 1, 2)).toBeUndefined();
    expect(atBasePrice(Number.POSITIVE_INFINITY, 1, 2)).toBeUndefined();
    expect(atBasePrice(undefined, 1, 2)).toBeUndefined();
    expect(atBasePrice(null, 1, 2)).toBeUndefined();
    // NEGATIVE: small is not nothing.
    expect(atBasePrice(0.01, 1, 2)).toBe(0.01);
  });

  it('a paid quantity that is not a whole number from 1 gives an empty box', () => {
    expect(atBasePrice(25, 0, 2)).toBeUndefined();
    expect(atBasePrice(25, -1, 2)).toBeUndefined();
    expect(atBasePrice(25, 2.5, 2)).toBeUndefined();
    expect(atBasePrice(25, Number.NaN, 2)).toBeUndefined();
    // NEGATIVE: one piece is the base price itself.
    expect(atBasePrice(25, 1, 2)).toBe(25);
  });

  it('a minor unit nobody stated gives an empty box — never an assumed two', () => {
    expect(atBasePrice(25, 2, undefined)).toBeUndefined();
    expect(atBasePrice(25, 2, null)).toBeUndefined();
    expect(atBasePrice(25, 2, Number.NaN)).toBeUndefined();
    expect(atBasePrice(25, 2, -1)).toBeUndefined();
    expect(atBasePrice(25, 2, 7)).toBeUndefined();
    expect(atBasePrice(25, 2, 2.5)).toBeUndefined();
    // NEGATIVE: every real unit answers.
    expect(atBasePrice(25, 2, 0)).toBe(50);
    expect(atBasePrice(25, 2, 2)).toBe(50);
    expect(atBasePrice(25, 2, 3)).toBe(50);
  });
});

describe('and the file stays the one pure rule', () => {
  it('imports the one rounding and nothing else', () => {
    const imports = stripComments(repoFile('src/lib/line-price.ts')).match(/^import .*$/gm) ?? [];
    expect(imports).toEqual(["import { roundMinor } from './money';"]);
  });

  it('and takes no gift: the caller passes the PAID quantity, three parameters and no fourth', () => {
    expect(atBasePrice.length).toBe(3);
    // NEGATIVE: a gift counted as a paid piece would be 100 for «3 + 1» at 25, not 75.
    expect(atBasePrice(25, 3, 2)).toBe(75);
    expect(atBasePrice(25, 3, 2)).not.toBe(100);
  });
});
