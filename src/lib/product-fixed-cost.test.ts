import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixedCostsOf, withFixedCost } from './product-fixed-cost';
import type { ProductCost } from './product-cost';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE COST OF A PRODUCT THAT DOES NOT MOVE — the helper every screen goes through (the owner, 1/11)
 *
 * «سعر تكلفة المنتج يكون ثابت ولا يتغير ابدا… اللي بيقدر يغيرو الادمنة فقط من قائمة المنتجات.»
 *
 *  · a product with a fixed figure costs IT: the unit cost, the cost of the next unit out and the value of the stock (on hand × the
 *    figure) — whatever the batches say, and whatever arrives or leaves afterwards;
 *  · a product with none costs exactly what its batches say, untouched — "no figure, no change";
 *  · ZERO is a figure: an item that costs nothing is a real answer, and `0` must not be read as "none";
 *  · the shelf is never the figure's: the units on hand and the batch count come from the batches either way.
 * ═══════════════════════════════════════════════════════════════════════
 */

const batches = (over: Partial<ProductCost> = {}): ProductCost => ({
  onHand: 100, average: 3.5, nextOut: 3, stockValue: 350, batchCount: 2, ...over,
});

describe('withFixedCost', () => {
  it('no figure → the very same answer, untouched (not a copy that could drift)', () => {
    const c = batches();
    expect(withFixedCost(c, undefined)).toBe(c);
  });

  it('a figure → the unit cost and the next unit out are IT, and the stock is worth on hand × it', () => {
    const out = withFixedCost(batches(), 5);
    expect(out).toEqual({ onHand: 100, average: 5, nextOut: 5, stockValue: 500, batchCount: 2 });
  });

  it('the figure does not move with the batches: new stock at another price changes the shelf, not the cost', () => {
    const before = withFixedCost(batches(), 5);
    const after = withFixedCost(batches({ onHand: 130, average: 9, nextOut: 9, stockValue: 1170, batchCount: 3 }), 5);
    expect(after.average).toBe(before.average);
    expect(after.nextOut).toBe(before.nextOut);
    expect(after.stockValue).toBe(650); // 130 × 5: the shelf grew, the unit cost did not
    expect(after.onHand).toBe(130);
    expect(after.batchCount).toBe(3);
  });

  it('ZERO is a figure: an item that costs nothing is not read as "no figure"', () => {
    const out = withFixedCost(batches(), 0);
    expect(out).toMatchObject({ average: 0, nextOut: 0, stockValue: 0, onHand: 100 });
  });

  it('an empty shelf is worth nothing at any figure, and still costs the figure per unit', () => {
    const out = withFixedCost(batches({ onHand: 0, stockValue: 0, batchCount: 0 }), 7.25);
    expect(out).toMatchObject({ average: 7.25, nextOut: 7.25, stockValue: 0, onHand: 0, batchCount: 0 });
  });

  it('the value is rounded to four decimals, like the batches’ own', () => {
    const out = withFixedCost(batches({ onHand: 3 }), 1.23456);
    expect(out.stockValue).toBe(3.7037); // 3 × 1.23456 = 3.70368
    expect(out.average).toBe(1.23456); // the figure itself is not rounded here: the door stores what it was given, to four decimals
  });
});

describe('fixedCostsOf', () => {
  const tx = { productFixedCost: { findMany: vi.fn() } };

  beforeEach(() => vi.clearAllMocks());

  it('maps the rows by product; a product with none is simply absent', async () => {
    tx.productFixedCost.findMany.mockResolvedValue([{ productId: 'p1', amount: 4.5 }, { productId: 'p3', amount: 0 }]);
    const map = await fixedCostsOf(tx as never, 'c1', ['p1', 'p2', 'p3']);
    expect(map.get('p1')).toBe(4.5);
    expect(map.has('p2')).toBe(false);
    expect(map.get('p3')).toBe(0); // a zero figure is present, not absent
  });

  it('is scoped to the company and to the ids asked, and reads only the two columns it needs', async () => {
    tx.productFixedCost.findMany.mockResolvedValue([]);
    await fixedCostsOf(tx as never, 'c1', ['p1', 'p2']);
    expect(tx.productFixedCost.findMany).toHaveBeenCalledWith({
      where: { companyId: 'c1', productId: { in: ['p1', 'p2'] } },
      select: { productId: true, amount: true },
    });
  });

  it('asks nothing at all for no products', async () => {
    const map = await fixedCostsOf(tx as never, 'c1', []);
    expect(map.size).toBe(0);
    expect(tx.productFixedCost.findMany).not.toHaveBeenCalled();
  });
});
