import { beforeEach, describe, expect, it, vi } from 'vitest';
import { costOfACopy, fixedCostsOf, unitCostsOf, withFixedCost } from './product-fixed-cost';
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

/**
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT ONE UNIT COSTS AN ORDER — `unitCostsOf`, the one answer every door that raises an order asks (the owner, 1/11)
 *
 * «سعر تكلفة المنتج يكون ثابت ولا يتغير ابدا… ثابت لكل الطلبات وما يتغير تحت اي ظرف».
 *
 *  · the product's FIXED figure wins — whatever the batches say, and without reading a batch for it;
 *  · ZERO is a figure (`??`, never `||`): an item that costs nothing is a real answer;
 *  · no figure, the weighted average of the batches on hand — exactly what every door read before;
 *  · no figure and no costed stock, or no such product: 0 — an answer, present in the map, never «absent»;
 *  · both questions are the company's, and there are at most two queries however many products are asked.
 *
 * The batches are the REAL `productCosts` over a fake table: the average below is computed, not handed in.
 * ═══════════════════════════════════════════════════════════════════════
 */
describe('unitCostsOf', () => {
  type Figure = { productId: string; amount: number };
  type Batch = { productId: string; quantityRemaining: number; costPerUnit: number };
  const tx = {
    productFixedCost: { findMany: vi.fn(async (): Promise<Figure[]> => []) },
    productionBatch: { findMany: vi.fn(async (): Promise<Batch[]> => []) },
  };
  /** p2 has two batches on hand: 10 at 3 and 10 at 4 — a weighted average of 3.5. */
  const SHELF: Batch[] = [
    { productId: 'p1', quantityRemaining: 50, costPerUnit: 9 },
    { productId: 'p2', quantityRemaining: 10, costPerUnit: 3 },
    { productId: 'p2', quantityRemaining: 10, costPerUnit: 4 },
  ];
  const figures = (...rows: Figure[]) => tx.productFixedCost.findMany.mockImplementation(async () => rows);
  const shelf = (...rows: Batch[]) =>
    tx.productionBatch.findMany.mockImplementation(async (args?: unknown) => {
      const ids = (args as { where: { productId: { in: string[] } } }).where.productId.in;
      return rows.filter((r) => ids.includes(r.productId));
    });

  beforeEach(() => {
    vi.clearAllMocks();
    figures();
    shelf(...SHELF);
  });

  it('THE FIGURE WINS over what the batches say: p1’s 9 on the shelf is not used, its figure of 5 is', async () => {
    figures({ productId: 'p1', amount: 5 });
    const map = await unitCostsOf(tx as never, 'c1', ['p1']);
    expect(map.get('p1')).toBe(5);
  });

  it('…and a product with a figure never reads a batch: nothing on the shelf can move it', async () => {
    figures({ productId: 'p1', amount: 5 });
    await unitCostsOf(tx as never, 'c1', ['p1']);
    expect(tx.productionBatch.findMany).not.toHaveBeenCalled();
  });

  it('ZERO WINS: an item that costs nothing is 0, not the 9 of the shelf — `??`, never `||`', async () => {
    figures({ productId: 'p1', amount: 0 });
    const map = await unitCostsOf(tx as never, 'c1', ['p1']);
    expect(map.get('p1')).toBe(0);
    expect(map.get('p1')).not.toBe(9);
  });

  it('NO FIGURE: the weighted average of the batches on hand — 10 at 3 and 10 at 4 is 3.5', async () => {
    const map = await unitCostsOf(tx as never, 'c1', ['p2']);
    expect(map.get('p2')).toBe(3.5);
  });

  it('NO FIGURE AND NO BATCH: 0 — and the entry is THERE, so a caller never has to guess what «absent» meant', async () => {
    shelf();
    const map = await unitCostsOf(tx as never, 'c1', ['p3']);
    expect(map.has('p3')).toBe(true);
    expect(map.get('p3')).toBe(0);
  });

  it('A PRODUCT THAT IS NOT THERE AT ALL: 0, the same answer', async () => {
    const map = await unitCostsOf(tx as never, 'c1', ['no-such-product']);
    expect(map.get('no-such-product')).toBe(0);
  });

  it('SEVERAL AT ONCE, each its own way: p1 at its figure, p2 at its average, p3 at 0', async () => {
    figures({ productId: 'p1', amount: 5 });
    const map = await unitCostsOf(tx as never, 'c1', ['p1', 'p2', 'p3']);
    expect([...map.entries()]).toEqual([['p1', 5], ['p2', 3.5], ['p3', 0]]);
  });

  it('A FIGURE OF ANOTHER PRODUCT changes nothing for this one', async () => {
    figures({ productId: 'p1', amount: 5 });
    const map = await unitCostsOf(tx as never, 'c1', ['p2']);
    expect(map.get('p2')).toBe(3.5);
  });

  it('ONE QUESTION EACH, however many products: the figures once, the batches once — for the ones with no figure only', async () => {
    figures({ productId: 'p1', amount: 5 });
    await unitCostsOf(tx as never, 'c1', ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
    expect(tx.productFixedCost.findMany).toHaveBeenCalledTimes(1);
    expect(tx.productionBatch.findMany).toHaveBeenCalledTimes(1);
    expect(tx.productFixedCost.findMany).toHaveBeenCalledWith({
      where: { companyId: 'c1', productId: { in: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'] } },
      select: { productId: true, amount: true },
    });
    const batchWhere = (tx.productionBatch.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(batchWhere).toEqual({ companyId: 'c1', productId: { in: ['p2', 'p3', 'p4', 'p5', 'p6'] }, quantityRemaining: { gt: 0 } });
  });

  it('BOTH QUESTIONS ARE THE COMPANY’S: another company’s figure or batch for the same product id answers nothing here', async () => {
    await unitCostsOf(tx as never, 'company-7', ['p1', 'p2']);
    const figureWhere = (tx.productFixedCost.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    const batchWhere = (tx.productionBatch.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(figureWhere.companyId).toBe('company-7');
    expect(batchWhere.companyId).toBe('company-7');
  });

  it('THE SAME PRODUCT TWICE is one question and one entry', async () => {
    figures({ productId: 'p1', amount: 5 });
    const map = await unitCostsOf(tx as never, 'c1', ['p1', 'p1', 'p1']);
    expect(map.size).toBe(1);
    expect(tx.productFixedCost.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { companyId: 'c1', productId: { in: ['p1'] } } }));
  });

  it('NO PRODUCTS: an empty map and no question asked', async () => {
    const map = await unitCostsOf(tx as never, 'c1', []);
    expect(map.size).toBe(0);
    expect(tx.productFixedCost.findMany).not.toHaveBeenCalled();
    expect(tx.productionBatch.findMany).not.toHaveBeenCalled();
  });

  it('IT IS A UNIT COST, NOT A TOTAL: nothing is rounded here — the door rounds the total by its currency', async () => {
    figures({ productId: 'p1', amount: 1.11117 });
    const map = await unitCostsOf(tx as never, 'c1', ['p1']);
    expect(map.get('p1')).toBe(1.11117);
  });
});

/**
 * A COPY'S COST — `costOfACopy`: the figures put on what a replacement or a handed-over box already carries (the owner, 1/11).
 * A cost is stored per ORDER, so a line with no figure keeps its share of it by units; a line with one costs figure × units.
 */
describe('costOfACopy', () => {
  const two = [{ productId: 'p1', units: 2 }, { productId: 'p2', units: 3 }];

  it('NO LINE WITH A FIGURE: the cost comes back exactly as it was handed in — not rounded, not recomputed', () => {
    expect(costOfACopy(80.123456, two, new Map(), 2)).toBe(80.123456);
    expect(costOfACopy(80.123456, two, new Map([['p9', 4]]), 2)).toBe(80.123456);
  });

  it('EVERY LINE WITH A FIGURE: the sum of figure × units, whatever the base was — 2 × 50 + 3 × 10 = 130', () => {
    expect(costOfACopy(80, two, new Map([['p1', 50], ['p2', 10]]), 2)).toBe(130);
  });

  it('SOME LINES: the figures for theirs, and the others keep their share of the base by units — 2 × 50 + 80 × 3/5 = 148', () => {
    expect(costOfACopy(80, two, new Map([['p1', 50]]), 2)).toBe(148);
  });

  it('ZERO IS A FIGURE: its line costs nothing and the others keep their share — 0 + 80 × 3/5 = 48', () => {
    expect(costOfACopy(80, two, new Map([['p1', 0]]), 2)).toBe(48);
  });

  it('A BASE OF NOTHING is nothing for the lines with no figure: the figure alone is the cost', () => {
    expect(costOfACopy(0, two, new Map([['p1', 50]]), 2)).toBe(100);
  });

  it('NO UNITS, NO ARITHMETIC: an empty copy keeps its base', () => {
    expect(costOfACopy(80, [], new Map([['p1', 50]]), 2)).toBe(80);
    expect(costOfACopy(80, [{ productId: 'p1', units: 0 }], new Map([['p1', 50]]), 2)).toBe(80);
  });

  it('ROUNDED BY THE CURRENCY: 3 × 1.1117 = 3.3351 is 3.34 at two places and 3.335 at three', () => {
    const one = [{ productId: 'p1', units: 3 }];
    expect(costOfACopy(0, one, new Map([['p1', 1.1117]]), 2)).toBe(3.34);
    expect(costOfACopy(0, one, new Map([['p1', 1.1117]]), 3)).toBe(3.335);
  });

  it('THE SAME PRODUCT ON TWO LINES is costed on both', () => {
    const lines = [{ productId: 'p1', units: 2 }, { productId: 'p1', units: 1 }, { productId: 'p2', units: 1 }];
    expect(costOfACopy(40, lines, new Map([['p1', 6]]), 2)).toBe(28); // 3 × 6 + 40 × 1/4
  });

  /*
   * A BASE THAT IS NOT A NUMBER MUST NOT ERASE THE FIGURES (the independent review, 2/11). `undefined * 0` is NaN, and `roundMinor(NaN)`
   * is 0 — so a copy whose every line has a figure, handed a missing base, came out as 0 instead of Σ figure × units. Both callers hand a
   * real number today; this holds the day one does not.
   */
  it('A MISSING BASE: every line with a figure still costs figure × units — never 0', () => {
    const all = new Map([['p1', 50], ['p2', 10]]);
    for (const base of [undefined, Number.NaN, Number.POSITIVE_INFINITY] as unknown as number[]) {
      expect(costOfACopy(base, two, all, 2), String(base)).toBe(130);
    }
  });

  it('A MISSING BASE gives nothing to the lines with no figure — their share of nothing is nothing, and the figured line is untouched', () => {
    expect(costOfACopy(Number.NaN, two, new Map([['p1', 50]]), 2)).toBe(100);
  });
});
