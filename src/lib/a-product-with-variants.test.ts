import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A PRODUCT WITH VARIANTS — the owner's decision of 2026-11-18 (docs/planner-questions.md, «متغيّرات المنتج»).
 *
 * What is pinned here: the shape of the options, one choice per piece checked (count, a combination of this product,
 * stock per combination), THE PRICING RULE (offer price + Σ delta of every piece, gifts included, through the one
 * `computeCod`), and that a product WITHOUT variants is priced by the very expression it always was and asks the
 * database nothing new.
 */

const h = vi.hoisted(() => ({
  db: {
    productVariant: { findMany: vi.fn() },
    orderItemVariant: { groupBy: vi.fn() },
  },
  activeOffersFor: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db: h.db }));
vi.mock('./db', () => ({ db: h.db }));
vi.mock('./offers', async () => {
  const real = await vi.importActual<typeof import('./offers')>('./offers');
  return { ...real, activeOffersFor: (...a: unknown[]) => h.activeOffersFor(...a) };
});

import {
  checkUnits,
  parseVariantOptions,
  unitsOfGroups,
  unitsSentence,
  variantSummary,
  variantsView,
  type VariantOption,
  type VariantRow,
} from './product-variants';
import { basketDiscount, resolvePublicLines } from './public-order';
import { computeCod } from './money';

const OPTIONS: VariantOption[] = [
  { id: 'o1', name: 'المقاس', values: [{ id: 'l', label: 'L', swatch: null }, { id: 'xl', label: 'XL', swatch: null }] },
  { id: 'o2', name: 'اللون', values: [{ id: 'blk', label: 'أسود', swatch: '#111111' }, { id: 'nvy', label: 'كحلي', swatch: '#1f2a44' }] },
];
const row = (id: string, values: string[], label: string, priceDelta: number, onHand: number): VariantRow => ({
  id, optionValues: JSON.stringify(values), label, sku: null, priceDelta, onHand, status: 'ACTIVE', sortOrder: 0,
});
const ROWS = [
  row('v-l-blk', ['l', 'blk'], 'L · أسود', 0, 5),
  row('v-l-nvy', ['l', 'nvy'], 'L · كحلي', 0, 0),
  row('v-xl-blk', ['xl', 'blk'], 'XL · أسود', 2, 1),
];
const FREE = new Map([['v-l-blk', 5], ['v-l-nvy', 0], ['v-xl-blk', 1]]);

describe('the options are read, or there are none', () => {
  it('a product with no options — every product before this — has no variants', () => {
    expect(parseVariantOptions(null)).toEqual([]);
    expect(parseVariantOptions('')).toEqual([]);
    expect(parseVariantOptions('not json')).toEqual([]);
    expect(variantsView([], ROWS, FREE, true)).toBeNull();
  });
  it('reads the options, and a swatch only when it is a colour', () => {
    const raw = JSON.stringify([{ id: 'o2', name: 'اللون', values: [{ id: 'a', label: 'أحمر', swatch: '#ff0000' }, { id: 'b', label: 'X', swatch: 'red;}' }] }]);
    expect(parseVariantOptions(raw)).toEqual([{ id: 'o2', name: 'اللون', values: [{ id: 'a', label: 'أحمر', swatch: '#ff0000' }, { id: 'b', label: 'X', swatch: null }] }]);
  });
  it('the landing view: available per combination, a count only from 1 to 20 and only when asked for', () => {
    const v = variantsView(OPTIONS, ROWS, FREE, true)!;
    expect(v.combinations.map((c) => [c.id, c.values, c.available, c.availableStock])).toEqual([
      ['v-l-blk', ['l', 'blk'], true, 5],
      ['v-l-nvy', ['l', 'nvy'], false, null],
      ['v-xl-blk', ['xl', 'blk'], true, 1],
    ]);
    expect(variantsView(OPTIONS, ROWS, new Map([['v-l-blk', 50]]), true)!.combinations[0].availableStock).toBeNull();
    expect(variantsView(OPTIONS, ROWS, FREE, false)!.combinations.every((c) => c.availableStock === null)).toBe(true);
  });
});

describe('one choice per piece, checked', () => {
  const ask = (units: string[], paid = 2, gift = 0) => checkUnits({ options: OPTIONS, rows: ROWS, free: FREE, units, paid, gift });

  it('the count must be the offer\'s pieces, gifts included', () => {
    expect(ask(['v-l-blk'])).toEqual({ ok: false, fieldErrors: { units: 'يرجى اختيار المقاس واللون لكل قطعة.' } });
    expect(unitsSentence([OPTIONS[0]])).toBe('يرجى اختيار المقاس لكل قطعة.');
  });
  it('a combination of another product, or an archived one, is refused on its piece', () => {
    const r = ask(['v-l-blk', 'nope']);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.fieldErrors['units.1']).toBe('أحد الخيارات المختارة لم يعد متاحًا. أعد تحميل الصفحة.');
  });
  it('a sold-out combination, and one with fewer left than asked, are refused with their name', () => {
    const out = ask(['v-l-blk', 'v-l-nvy']);
    expect(!out.ok && out.fieldErrors['units.1']).toBe('نفد «L · كحلي». اختر خيارًا آخر.');
    const short = ask(['v-xl-blk', 'v-xl-blk']);
    expect(!short.ok && short.fieldErrors['units.1']).toBe('لا تكفي الكمية المتوفرة من «XL · أسود». اختر خيارًا آخر.');
  });
  it('groups the pieces, paid first and gifts after, and sums every piece\'s delta — the gift\'s too', () => {
    const r = ask(['v-l-blk', 'v-xl-blk', 'v-l-blk'], 2, 1);
    expect(r).toEqual({
      ok: true,
      delta: 2,
      groups: [
        { variantId: 'v-l-blk', label: 'L · أسود', quantity: 1, freeQuantity: 1, priceDelta: 0 },
        { variantId: 'v-xl-blk', label: 'XL · أسود', quantity: 1, freeQuantity: 0, priceDelta: 2 },
      ],
    });
    if (r.ok) {
      expect(variantSummary(r.groups)).toBe('L · أسود، L · أسود (مجانًا)، XL · أسود');
      expect(unitsOfGroups(r.groups).map((u) => [u.variantId, u.free])).toEqual([
        ['v-l-blk', false],
        ['v-xl-blk', false],
        ['v-l-blk', true],
      ]);
    }
  });
});

describe('THE PRICING RULE — offer price + Σ delta of every piece, through the one computeCod', () => {
  const offer = { id: 'of2', name: 'قطعتين', quantity: 2, freeQuantity: 1, price: 22, listPrice: 25, compareAtPrice: null, isDefault: true, deliveryIncluded: false, endsAt: null };
  const PLAIN = { id: 'p0', name: 'عسل', image: null, basePrice: 15 };
  const SHIRT = { id: 'p1', name: 'قميص', image: null, basePrice: 12, variantOptions: JSON.stringify(OPTIONS) };

  beforeEach(() => {
    vi.clearAllMocks();
    h.activeOffersFor.mockResolvedValue([offer]);
    h.db.productVariant.findMany.mockResolvedValue(ROWS);
    h.db.orderItemVariant.groupBy.mockResolvedValue([]);
  });

  it('a product WITHOUT variants: the same unit price as ever, and nothing asked of the variants', async () => {
    const r = await resolvePublicLines('c1', [PLAIN], [{ productId: 'p0', offerId: 'of2', count: 1, units: ['x'] }], 3);
    expect(r.ok && r.lines[0]).toMatchObject({ quantity: 2, freeQuantity: 1, unitPrice: 12.5, offerDiscount: 3 });
    expect(r.ok && r.lines[0].units).toBeUndefined();
    expect(h.db.productVariant.findMany).not.toHaveBeenCalled();
  });

  it('with pieces: unit price carries the deltas, the reduction is untouched, the goods are offer + Σ delta', async () => {
    // XL · أسود (+2) as a paid piece, and again (+2) as the gift: 22 + 4 = 26.
    h.db.productVariant.findMany.mockResolvedValue([row('v-l-blk', ['l', 'blk'], 'L · أسود', 0, 5), row('v-xl-blk', ['xl', 'blk'], 'XL · أسود', 2, 9)]);
    const r = await resolvePublicLines('c1', [SHIRT], [{ productId: 'p1', offerId: 'of2', count: 1, units: ['v-l-blk', 'v-xl-blk', 'v-xl-blk'] }], 3);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [line] = r.lines;
    expect(line.variantDelta).toBe(4);
    expect(line.unitPrice).toBeCloseTo(14.5);
    const money = computeCod({ lines: [{ quantity: line.quantity, unitPrice: line.unitPrice, freeQuantity: line.freeQuantity }], discount: basketDiscount(r.lines), minorUnit: 3 });
    expect(money.cod).toBe(26);
  });

  it('a sold-out piece is refused before anything is priced', async () => {
    h.db.orderItemVariant.groupBy.mockResolvedValue([{ variantId: 'v-xl-blk', _sum: { quantity: 1, freeQuantity: 0 } }]);
    const r = await resolvePublicLines('c1', [SHIRT], [{ productId: 'p1', offerId: 'of2', count: 1, units: ['v-l-blk', 'v-xl-blk', 'v-l-blk'] }], 3);
    expect(r).toEqual({ ok: false, fieldErrors: { units: 'نفد «XL · أسود». اختر خيارًا آخر.', 'units.1': 'نفد «XL · أسود». اختر خيارًا آخر.' } });
  });

  it('with no pieces sent (an older page): taken at the offer\'s price, flagged for the call', async () => {
    const r = await resolvePublicLines('c1', [SHIRT], [{ productId: 'p1', offerId: 'of2', count: 1 }], 3);
    expect(r.ok && r.lines[0]).toMatchObject({ unitPrice: 12.5, unitsMissing: true });
    expect(h.db.productVariant.findMany).not.toHaveBeenCalled();
  });

  it('holds count only lines still holding stock — the same `holdingWhere` the product reads', async () => {
    await resolvePublicLines('c1', [SHIRT], [{ productId: 'p1', offerId: 'of2', count: 1, units: ['v-l-blk', 'v-l-blk', 'v-xl-blk'] }], 3);
    const where = h.db.orderItemVariant.groupBy.mock.calls[0][0].where;
    expect(where.orderItem.reservedQty).toEqual({ gt: 0 });
    expect(where.orderItem.order.confirmationStatus).toEqual({ notIn: ['REJECTED', 'CANCELLED'] });
  });
});
