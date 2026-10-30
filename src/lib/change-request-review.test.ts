import { describe, expect, it } from 'vitest';
import { readRaisedSnapshot, reviewDrift, reviewTotals, shutReason, type ReviewTotals } from './change-request-review';
import type { PublicStockEffect, Totals } from './order-line-edit';

/**
 * WHAT MOVED SINCE A REQUEST WAS RAISED — the comparison the decider's screen prints, as a table of cases.
 * Three-place JOD: half a minor unit is 0.0005, so 48.5 and 48.5004 are one figure and 48.5 and 48.6 are not.
 */

const NOW: ReviewTotals = { subtotal: 46, discount: 0, deliveryFee: 2.5, addOns: 0, cod: 48.5, giftUnits: 0 };
const AFTER: ReviewTotals = { subtotal: 70, discount: 0, deliveryFee: 2.5, addOns: 0, cod: 72.5, giftUnits: 0 };

const stockOf = (over: Partial<PublicStockEffect> = {}): PublicStockEffect => ({
  productId: 'p-cream',
  productName: 'كريم',
  before: 3,
  after: 5,
  held: 3,
  freed: 0,
  enough: true,
  status: 'ENOUGH',
  ...over,
});

const SNAPSHOT = {
  orderVersion: 7,
  minorUnit: 3,
  before: { cod: 48.5, subtotal: 46, discount: 0, deliveryFee: 2.5, giftUnits: 0 },
  after: { cod: 72.5, subtotal: 70, discount: 0, deliveryFee: 2.5, giftUnits: 0 },
  lineOrder: ['a', 'b'],
  stock: [{ productId: 'p-cream', productName: 'كريم', enough: true }],
  door: 'REQUEST',
};

const drift = (over: Partial<Parameters<typeof reviewDrift>[0]> = {}) =>
  reviewDrift({
    snapshot: SNAPSHOT,
    nowBefore: NOW,
    nowAfter: AFTER,
    lineCount: 2,
    stale: false,
    stock: [stockOf()],
    door: 'REQUEST',
    minorUnit: 3,
    ...over,
  });

describe('Ⅰ · nothing moved', () => {
  it('is known, not moved, and says nothing', () => {
    expect(drift()).toEqual({ known: true, moved: false, items: [] });
  });

  it('a difference below half a minor unit is the same figure', () => {
    expect(drift({ nowBefore: { ...NOW, cod: 48.5004 } }).moved).toBe(false);
    expect(drift({ nowBefore: { ...NOW, cod: 48.6 } }).moved).toBe(true);
  });
});

describe('Ⅱ · each thing that can move says so, once, in Arabic', () => {
  const cases: Array<{ name: string; over: Partial<Parameters<typeof reviewDrift>[0]>; kind: string; mentions: string[] }> = [
    { name: 'the total', over: { nowBefore: { ...NOW, cod: 50 } }, kind: 'TOTAL', mentions: ['48.500', '50.000'] },
    { name: 'the delivery fee', over: { nowBefore: { ...NOW, deliveryFee: 3 } }, kind: 'FEE', mentions: ['2.500', '3.000'] },
    { name: 'the order’s discount', over: { nowBefore: { ...NOW, discount: 2 } }, kind: 'DISCOUNT', mentions: ['0.000', '2.000'] },
    { name: 'the result after the request', over: { nowAfter: { ...AFTER, cod: 67.5 } }, kind: 'RESULT', mentions: ['67.500', '72.500'] },
    { name: 'the number of lines', over: { lineCount: 3 }, kind: 'LINES', mentions: ['2', '3'] },
    { name: 'the shelf, running out', over: { stock: [stockOf({ enough: false, status: 'SHORT_BLOCKED' })] }, kind: 'SHELF', mentions: ['كريم', 'ما عاد يكفي'] },
    { name: 'the door', over: { door: 'COURIER_ACTION' }, kind: 'DOOR', mentions: ['الطرد عند شركة الشحن'] },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const d = drift(c.over);
      expect(d.moved).toBe(true);
      const item = d.items.find((i) => i.kind === c.kind);
      expect(item, JSON.stringify(d.items)).toBeDefined();
      for (const word of c.mentions) expect(item?.messageAr).toContain(word);
      // Latin digits, and no English word.
      expect(item?.messageAr).not.toMatch(/[٠-٩]/);
      expect(item?.messageAr).not.toMatch(/[A-Za-z]{3,}/);
      // Exactly the kinds that moved: nothing else is reported.
      expect(d.items.map((i) => i.kind)).toEqual([c.kind]);
    });
  }

  it('the shelf getting better is said too, in the other direction', () => {
    const was = { ...SNAPSHOT, stock: [{ productId: 'p-cream', productName: 'كريم', enough: false }] };
    const d = drift({ snapshot: was });
    expect(d.items.find((i) => i.kind === 'SHELF')?.messageAr).toContain('صار يكفي');
  });

  it('lines that cannot be found any more say so and draw no result', () => {
    const d = drift({ stale: true, nowAfter: null });
    expect(d.items.map((i) => i.kind)).toContain('LINES');
    expect(d.items.map((i) => i.kind)).not.toContain('RESULT');
  });

  it('a product the snapshot never mentioned is not a drift', () => {
    const d = drift({ stock: [stockOf(), stockOf({ productId: 'p-new', enough: false, status: 'SHORT_BLOCKED' })] });
    expect(d.moved).toBe(false);
  });
});

describe('Ⅲ · a request with no record of the moment it was raised', () => {
  for (const snapshot of [undefined, null, 'x', 5, [], {}, { before: 'bad' }]) {
    it(`${JSON.stringify(snapshot)} → unknown, never «nothing changed»`, () => {
      expect(drift({ snapshot })).toEqual({ known: false, moved: false, items: [] });
    });
  }

  it('a snapshot with garbage in a field is read defensively', () => {
    const read = readRaisedSnapshot({ ...SNAPSHOT, lineOrder: [1, 2], stock: [{ productId: 7 }, null, { productId: 'p', enough: true }], before: { cod: 'x', subtotal: 5 } });
    expect(read?.lineOrder).toBeNull();
    expect(read?.stock).toEqual([{ productId: 'p', productName: '', enough: true }]);
    expect(read?.before).toEqual({ subtotal: 5 });
  });
});

describe('Ⅳ · what leaves the engine for a decision screen', () => {
  it('drops the per-line shares and the revenue, keeps what is collected', () => {
    const engine: Totals = { subtotal: 46, discount: 0, discountShares: [0, 0], deliveryFee: 2.5, addOns: 0, cod: 48.5, revenue: 46, giftUnits: 1 };
    const kept = reviewTotals(engine);
    expect(Object.keys(kept).sort()).toEqual(['addOns', 'cod', 'deliveryFee', 'discount', 'giftUnits', 'subtotal']);
    expect(kept.cod).toBe(48.5);
  });
});

describe('Ⅴ · the sentence under a shut button', () => {
  it('is the blocking reasons, each once, in order — and nothing for a warning', () => {
    const problems = [
      { code: 'A', blocking: true, messageAr: 'المخزون ما بيكفي لـكريم.' },
      { code: 'B', blocking: false, messageAr: 'تنبيه فقط.' },
      { code: 'C', blocking: true, messageAr: 'المخزون ما بيكفي لـكريم.' },
      { code: 'D', blocking: true, messageAr: 'الطرد عند شركة الشحن.' },
    ];
    expect(shutReason(problems)).toBe('المخزون ما بيكفي لـكريم. — الطرد عند شركة الشحن.');
  });

  it('is null when nothing blocks', () => {
    expect(shutReason([{ code: 'B', blocking: false, messageAr: 'تنبيه فقط.' }])).toBeNull();
    expect(shutReason([])).toBeNull();
  });
});
