import { describe, expect, it } from 'vitest';
import { offerAboveBase, offerCeiling, paidPieces } from './offer-ceiling';
import { OFFER_ABOVE_BASE, offerAboveBaseRefusal, offerEditAboveBaseRefusal } from './offers';

/**
 * «العرض ما بصير يكون اكثر من السعر الاساسي» — THE OWNER, 28/10.
 *
 * An offer's `sellingPrice` is the price of the WHOLE bundle; `basePrice` is the price of ONE piece. So the line is
 * the base price × the PAID pieces, both sides rounded by the store's currency, and equality passes. These are the
 * figures the screen's hint and both doors are built on — one function, so they cannot be a fils apart.
 */

describe('the line: the base price × the paid pieces', () => {
  it('is one piece’s price for one piece', () => {
    expect(offerCeiling(25, 1, 2)).toBe(25);
  });

  it('grows with the PAID pieces — «3 بـ60» at a base of 25 has a line of 75', () => {
    expect(offerCeiling(25, 3, 2)).toBe(75);
  });

  it('is rounded by the currency, so 0.1 × 3 is 0.3 and not 0.30000000000000004', () => {
    expect(0.1 * 3).not.toBe(0.3);
    expect(offerCeiling(0.1, 3, 3)).toBe(0.3);
  });

  it('reads a bundle of nonsense size as ONE piece — zero, negative and NaN alike', () => {
    expect(offerCeiling(25, 0, 2)).toBe(25);
    expect(offerCeiling(25, -2, 2)).toBe(25);
    expect(offerCeiling(25, Number.NaN, 2)).toBe(25);
    expect(paidPieces(0)).toBe(1);
    expect(paidPieces(Number.NaN)).toBe(1);
    expect(paidPieces(4)).toBe(4);
  });

  it('draws no line at all without a base price — 0 is «not priced yet»', () => {
    expect(offerCeiling(0, 3, 2)).toBeNull();
    expect(offerCeiling(-5, 3, 2)).toBeNull();
    expect(offerCeiling(Number.NaN, 3, 2)).toBeNull();
  });

  it('NEGATIVE: and a base too large to multiply is no line, never a line at ZERO that refuses everything', () => {
    // `roundMinor` answers 0 for what it cannot read; trusted, this would cap every offer of the product at 0.
    expect(() => offerCeiling(1e308, 2, 2)).not.toThrow();
    expect(offerCeiling(1e308, 2, 2)).toBeNull(); // the product overflows
    expect(offerCeiling(1e308, 1, 2)).toBeNull(); // the product survives, the rounding overflows
    expect(offerAboveBase({ sellingPrice: 1_000_000, quantity: 2 }, 1e308, 2)).toBeNull();
  });
});

describe('an offer above its line', () => {
  it('equality passes — 25 for one piece at a base of 25', () => {
    expect(offerAboveBase({ sellingPrice: 25, quantity: 1 }, 25, 2)).toBeNull();
  });

  it('NEGATIVE: one minor unit over is refused, and the answer is the line — 25.01 at two places', () => {
    expect(offerAboveBase({ sellingPrice: 25.01, quantity: 1 }, 25, 2)).toBe(25);
  });

  it('and the price is rounded the same way as the line — 25.004 IS 25 in a two-place currency', () => {
    expect(offerAboveBase({ sellingPrice: 25.004, quantity: 1 }, 25, 2)).toBeNull();
  });

  it('a Jordanian dinar has three places: 12.345 × 2 is 24.690 — 24.690 passes and 24.691 is refused', () => {
    expect(offerAboveBase({ sellingPrice: 24.69, quantity: 2 }, 12.345, 3)).toBeNull();
    expect(offerAboveBase({ sellingPrice: 24.691, quantity: 2 }, 12.345, 3)).toBe(24.69);
  });

  it('the float edge: 0.3 for three pieces at a base of 0.1 passes', () => {
    expect(offerAboveBase({ sellingPrice: 0.3, quantity: 3 }, 0.1, 3)).toBeNull();
  });

  it('three pieces at a base of 25: 60 and 75 pass, 76 is refused', () => {
    expect(offerAboveBase({ sellingPrice: 60, quantity: 3 }, 25, 2)).toBeNull();
    expect(offerAboveBase({ sellingPrice: 75, quantity: 3 }, 25, 2)).toBeNull();
    expect(offerAboveBase({ sellingPrice: 76, quantity: 3 }, 25, 2)).toBe(75);
  });

  it('a gift is not counted: «3 + 1 هدية» at 75 passes, and at 80 it is refused — the line is 75, not 100', () => {
    // A stored row, gift and all. Only the paid pieces reach the line.
    const atSeventyFive = { quantity: 3, freeQuantity: 1, sellingPrice: 75 };
    const atEighty = { quantity: 3, freeQuantity: 1, sellingPrice: 80 };
    expect(offerAboveBase(atSeventyFive, 25, 2)).toBeNull();
    expect(offerAboveBase(atEighty, 25, 2)).toBe(75);
  });

  it('a free bundle is a pricing decision and always passes', () => {
    expect(offerAboveBase({ sellingPrice: 0, quantity: 3 }, 25, 2)).toBeNull();
  });

  it('without a base price nothing is above anything', () => {
    expect(offerAboveBase({ sellingPrice: 999, quantity: 1 }, 0, 2)).toBeNull();
  });
});

describe('what a door answers', () => {
  it('the owner’s own sentence (28/10), word for word — in a currency with no decimals it is exactly his', () => {
    expect(offerAboveBaseRefusal({ sellingPrice: 80, quantity: 3 }, 25, 0)).toEqual({
      error: 'لا يمكنك إنشاء العرض: السعر 80 أعلى من السعر الأساسي لـ3 قطع (75)',
      code: OFFER_ABOVE_BASE,
      maxPrice: 75,
    });
    const stored = { sellingPrice: 60, quantity: 3, status: 'ACTIVE' };
    expect(offerEditAboveBaseRefusal(stored, { sellingPrice: 80 }, 25, 0)?.error).toBe(
      'لا يمكنك تعديل العرض: السعر 80 أعلى من السعر الأساسي لـ3 قطع (75)'
    );
  });

  it('and its figures are written for the store’s currency — three places in dinars, grouped past a thousand', () => {
    expect(offerAboveBaseRefusal({ sellingPrice: 80, quantity: 3 }, 25, 3)?.error).toBe(
      'لا يمكنك إنشاء العرض: السعر 80.000 أعلى من السعر الأساسي لـ3 قطع (75.000)'
    );
    expect(offerAboveBaseRefusal({ sellingPrice: 2500, quantity: 2 }, 1200, 2)?.error).toBe(
      'لا يمكنك إنشاء العرض: السعر 2,500.00 أعلى من السعر الأساسي لقطعتين (2,400.00)'
    );
  });

  it('«3 + 1 هدية بـ80» names the line of the 3 PAID pieces — the gift does not raise it to 100', () => {
    // A stored row, gift and all, as the door hands it over.
    const giftOnTop = { quantity: 3, freeQuantity: 1, sellingPrice: 80 };
    expect(offerAboveBaseRefusal(giftOnTop, 25, 0)?.error).toBe(
      'لا يمكنك إنشاء العرض: السعر 80 أعلى من السعر الأساسي لـ3 قطع (75)'
    );
  });

  it('and counts the pieces the way Arabic counts them — one, two, three to ten, eleven and up', () => {
    const said = (quantity: number) => offerAboveBaseRefusal({ sellingPrice: 1_000_000, quantity }, 1, 0)?.error;
    expect(said(1)).toContain('السعر الأساسي لقطعة واحدة (1)');
    expect(said(2)).toContain('السعر الأساسي لقطعتين (2)');
    expect(said(3)).toContain('السعر الأساسي لـ3 قطع (3)');
    expect(said(10)).toContain('السعر الأساسي لـ10 قطع (10)');
    expect(said(11)).toContain('السعر الأساسي لـ11 قطعة (11)');
    expect(said(100)).toContain('السعر الأساسي لـ100 قطعة (100)');
    expect(said(103)).toContain('السعر الأساسي لـ103 قطع (103)');
  });

  it('and answers nothing for an offer on or under its line', () => {
    expect(offerAboveBaseRefusal({ sellingPrice: 75, quantity: 3 }, 25, 2)).toBeNull();
  });

  it('NEGATIVE: an offer’s own discount does not relax the line — the «السعر» box is what is measured', () => {
    // 30 for one piece, reduced by 6 to a charge of 24, at a base of 25: the box says 30, and 30 is above 25.
    const reduced = { quantity: 1, sellingPrice: 30, discount: 6 };
    expect(offerAboveBaseRefusal(reduced, 25, 2)?.maxPrice).toBe(25);
  });
});

describe('what an edit is measured for', () => {
  const ABOVE = { sellingPrice: 80, quantity: 3, status: 'ACTIVE' };

  it('an edit that changes neither the price nor the quantity is never refused, even on an offer above its line', () => {
    expect(offerEditAboveBaseRefusal(ABOVE, { sellingPrice: 80, quantity: 3, status: 'ACTIVE' }, 25, 2)).toBeNull();
    expect(offerEditAboveBaseRefusal(ABOVE, {}, 25, 2)).toBeNull();
  });

  it('a price that moves is measured on the row it leaves', () => {
    expect(offerEditAboveBaseRefusal(ABOVE, { sellingPrice: 78 }, 25, 2)?.maxPrice).toBe(75);
    expect(offerEditAboveBaseRefusal(ABOVE, { sellingPrice: 75 }, 25, 2)).toBeNull();
  });

  it('a quantity sent alone is measured against the STORED price', () => {
    const under = { sellingPrice: 60, quantity: 3, status: 'ACTIVE' };
    expect(offerEditAboveBaseRefusal(under, { quantity: 1 }, 25, 2)?.maxPrice).toBe(25);
  });

  it('switching a stopped one back on is measured, and refused with the edit door’s sentence', () => {
    const stopped = { ...ABOVE, status: 'INACTIVE' };
    const refusal = offerEditAboveBaseRefusal(stopped, { status: 'ACTIVE' }, 25, 2);
    expect(refusal?.error).toBe('لا يمكنك تعديل العرض: السعر 80.00 أعلى من السعر الأساسي لـ3 قطع (75.00)');
    expect(offerEditAboveBaseRefusal(stopped, { status: 'INACTIVE' }, 25, 2)).toBeNull();
  });
});
