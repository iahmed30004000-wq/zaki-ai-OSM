import { describe, expect, it } from 'vitest';
import { priceFieldsChanged, storedLinesOf, type PriceEditContext } from './order-price-gate';

/**
 * «DOES THIS EDIT MOVE A PRICE?» — the question orders.change_price is asked about (perm-plan PR-6).
 *
 * The lines card posts every price box back on every save, so the question cannot be "does the request carry a price".
 * Each case is a request, the order as it stands, and whether the price moved. The negatives matter more than the
 * positives: a check that says "no change" for a real discount is the door left open.
 */

const ORDER: PriceEditContext = {
  // 2 pieces of A at 10 and 1 piece of B at 12, no discount: 32 for 3 pieces
  stored: { sellingPrice: 32, quantity: 3, discountAmount: 0 },
  lines: [
    { productId: 'A', quantity: 2, beforeDiscount: 20 },
    { productId: 'B', quantity: 1, beforeDiscount: 12 },
  ],
  catalogPrice: (id) => ({ A: 10, B: 12, C: 7.5, FREE: null } as Record<string, number | null>)[id] ?? null,
  minorUnit: 2,
};

describe('the discount', () => {
  it('is a price change when it differs from the stored one — and not otherwise', () => {
    expect(priceFieldsChanged({ discountAmount: 5 }, ORDER)).toEqual(['discountAmount']);
    expect(priceFieldsChanged({ discountAmount: 0 }, ORDER)).toEqual([]);
    expect(priceFieldsChanged({ discountAmount: 0.004 }, ORDER)).toEqual([]); // inside one minor unit
    expect(priceFieldsChanged({ discountAmount: 0.02 }, ORDER)).toEqual(['discountAmount']);
    // a stored discount posted back unchanged
    expect(priceFieldsChanged({ discountAmount: 4 }, { ...ORDER, stored: { ...ORDER.stored, discountAmount: 4 } })).toEqual([]);
  });
});

describe('the single-line price (the total for the quantity named)', () => {
  it('the same total is no change; a different total is', () => {
    expect(priceFieldsChanged({ sellingPrice: 32 }, ORDER)).toEqual([]);
    expect(priceFieldsChanged({ sellingPrice: 31 }, ORDER)).toEqual(['sellingPrice']);
    expect(priceFieldsChanged({ sellingPrice: 0 }, ORDER)).toEqual(['sellingPrice']);
  });

  it('a raised quantity at the same piece price is no change; at a different piece price it is', () => {
    // 32 for 3 → 4 pieces at the same piece price is 42.667
    expect(priceFieldsChanged({ sellingPrice: 42.67, quantity: 4 }, ORDER)).toEqual([]);
    expect(priceFieldsChanged({ sellingPrice: 32, quantity: 4 }, ORDER)).toEqual(['sellingPrice']); // the total held: the piece got cheaper
    expect(priceFieldsChanged({ sellingPrice: 60, quantity: 4 }, ORDER)).toEqual(['sellingPrice']);
  });
});

describe('the lines', () => {
  it('every box posted back untouched is no change — in any order', () => {
    expect(priceFieldsChanged({ items: [{ productId: 'A', quantity: 2, unitPrice: 20 }, { productId: 'B', quantity: 1, unitPrice: 12 }] }, ORDER)).toEqual([]);
    expect(priceFieldsChanged({ items: [{ productId: 'B', quantity: 1, unitPrice: 12 }, { productId: 'A', quantity: 2, unitPrice: 20 }] }, ORDER)).toEqual([]);
  });

  it('a line total that moved is a change, whichever line it is', () => {
    expect(priceFieldsChanged({ items: [{ productId: 'A', quantity: 2, unitPrice: 19 }, { productId: 'B', quantity: 1, unitPrice: 12 }] }, ORDER)).toEqual(['items']);
    expect(priceFieldsChanged({ items: [{ productId: 'A', quantity: 2, unitPrice: 20 }, { productId: 'B', quantity: 1, unitPrice: 0 }] }, ORDER)).toEqual(['items']);
  });

  it('a raised quantity at the same piece price is no change; with the total held, it is', () => {
    expect(priceFieldsChanged({ items: [{ productId: 'A', quantity: 3, unitPrice: 30 }, { productId: 'B', quantity: 1, unitPrice: 12 }] }, ORDER)).toEqual([]);
    expect(priceFieldsChanged({ items: [{ productId: 'A', quantity: 3, unitPrice: 20 }, { productId: 'B', quantity: 1, unitPrice: 12 }] }, ORDER)).toEqual(['items']);
  });

  it('a line taken off is no price change (the rest are as they were)', () => {
    expect(priceFieldsChanged({ items: [{ productId: 'A', quantity: 2, unitPrice: 20 }] }, ORDER)).toEqual([]);
  });

  it('a product the order did not have must come at its catalogue price for the quantity — anything else is a price', () => {
    const base = { productId: 'A', quantity: 2, unitPrice: 20 };
    expect(priceFieldsChanged({ items: [base, { productId: 'C', quantity: 2, unitPrice: 15 }] }, ORDER)).toEqual([]); // 2 × 7.5
    expect(priceFieldsChanged({ items: [base, { productId: 'C', quantity: 2, unitPrice: 1 }] }, ORDER)).toEqual(['items']);
    expect(priceFieldsChanged({ items: [base, { productId: 'C', quantity: 2, unitPrice: 0 }] }, ORDER)).toEqual(['items']); // a free line
    // a product with NO catalogue price has no price to compare with: whatever is typed is a new price
    expect(priceFieldsChanged({ items: [base, { productId: 'FREE', quantity: 1, unitPrice: 0 }] }, ORDER)).toEqual(['items']);
    expect(priceFieldsChanged({ items: [base, { productId: 'NOPE', quantity: 1, unitPrice: 3 }] }, ORDER)).toEqual(['items']);
  });

  it('one product on two lines is matched line by line, not twice against the same stored line', () => {
    const two: PriceEditContext = { ...ORDER, lines: [{ productId: 'A', quantity: 1, beforeDiscount: 10 }, { productId: 'A', quantity: 1, beforeDiscount: 10 }] };
    expect(priceFieldsChanged({ items: [{ productId: 'A', quantity: 1, unitPrice: 10 }, { productId: 'A', quantity: 1, unitPrice: 10 }] }, two)).toEqual([]);
    // a THIRD line of A has no stored line left: it is compared with the catalogue (10 for 1) — fine at 10, a price at 1
    expect(priceFieldsChanged({ items: [{ productId: 'A', quantity: 1, unitPrice: 10 }, { productId: 'A', quantity: 1, unitPrice: 10 }, { productId: 'A', quantity: 1, unitPrice: 1 }] }, two)).toEqual(['items']);
  });

  it('the tolerance is a minor unit per piece — a division and a rounding on the way back is not a new price', () => {
    // 3 pieces for 50.00, posted as 50.01 (the stored unit price 16.67 × 3): inside 3 minor units
    const rounded: PriceEditContext = { ...ORDER, lines: [{ productId: 'A', quantity: 3, beforeDiscount: 50 }] };
    expect(priceFieldsChanged({ items: [{ productId: 'A', quantity: 3, unitPrice: 50.01 }] }, rounded)).toEqual([]);
    expect(priceFieldsChanged({ items: [{ productId: 'A', quantity: 3, unitPrice: 50.5 }] }, rounded)).toEqual(['items']);
  });
});

describe('everything together, and the empty request', () => {
  it('reports each moved field once; a request that carries no price field reports nothing', () => {
    expect(
      priceFieldsChanged({ discountAmount: 9, sellingPrice: 1, items: [{ productId: 'A', quantity: 1, unitPrice: 1 }] }, ORDER).sort()
    ).toEqual(['discountAmount', 'items', 'sellingPrice']);
    expect(priceFieldsChanged({}, ORDER)).toEqual([]);
    expect(priceFieldsChanged({ quantity: 5 }, ORDER)).toEqual([]);
  });

  it('a currency with no minor unit: whole numbers, and a one-unit move still counts as a move beyond the tolerance of one', () => {
    const syp: PriceEditContext = { ...ORDER, minorUnit: 0, stored: { sellingPrice: 40_000, quantity: 2, discountAmount: 0 }, lines: [{ productId: 'A', quantity: 2, beforeDiscount: 40_000 }] };
    expect(priceFieldsChanged({ items: [{ productId: 'A', quantity: 2, unitPrice: 40_000 }] }, syp)).toEqual([]);
    expect(priceFieldsChanged({ items: [{ productId: 'A', quantity: 2, unitPrice: 35_000 }] }, syp)).toEqual(['items']);
  });
});

describe('the stored lines are read the way the order window reads them', () => {
  it('lineTotal + the discount share, when the shares are the order’s own discount', () => {
    const lines = storedLinesOf(
      [
        { productId: 'A', quantity: 2, lineTotal: '17.5', discountShare: '2.5' },
        { productId: 'B', quantity: 1, lineTotal: '10', discountShare: '2.5' },
      ],
      5,
      2
    );
    expect(lines).toEqual([
      { productId: 'A', quantity: 2, beforeDiscount: 20 },
      { productId: 'B', quantity: 1, beforeDiscount: 12.5 },
    ]);
    // …so a save with nothing touched (the card posts 20 and 12.5 with the same discount) moves no price
    expect(priceFieldsChanged({ discountAmount: 5, items: [{ productId: 'A', quantity: 2, unitPrice: 20 }, { productId: 'B', quantity: 1, unitPrice: 12.5 }] }, { ...ORDER, lines, stored: { sellingPrice: 32.5, quantity: 3, discountAmount: 5 } })).toEqual([]);
  });
});
