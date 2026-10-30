import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE CATALOGUE SAYS WHAT MAY BE SOLD TODAY — BESIDE WHAT IT ALWAYS SAID.
 *
 * `GET /api/products` returns every offer row a product has (`offers`): stopped, finished, the one shown only after an
 * order. A good many screens read that list as it is, so it does not move. The lines editor needs the other question —
 * «which bundles may I put on this line» — and gets it as `liveOffers`, from the one reader every door uses.
 *
 * This holds three things: the old field is word for word what it was, the new one carries the live bundles with the
 * reduction said out loud, and an extra field never stops the catalogue from loading.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, getPermissionScope, maySeeCost, productCosts } = vi.hoisted(() => ({
  db: {
    product: { findMany: vi.fn(), count: vi.fn() },
    orderItem: { groupBy: vi.fn() },
    offer: { findMany: vi.fn() },
    order: { groupBy: vi.fn() },
  },
  requireContext: vi.fn(),
  getPermissionScope: vi.fn(),
  maySeeCost: vi.fn(),
  productCosts: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  getPermissionScope: (...a: unknown[]) => getPermissionScope(...a),
  requirePermission: vi.fn(),
  can: vi.fn(() => true),
}));
vi.mock('@/lib/cost-visibility', () => ({ maySeeCost: (...a: unknown[]) => maySeeCost(...a), withoutCost: (b: unknown) => b }));
vi.mock('@/lib/product-cost', () => ({ productCosts: (...a: unknown[]) => productCosts(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/auth', () => ({ requireCompanyTenant: vi.fn() }));

import { GET } from './route';

const CTX = {
  user: { id: 'u1', role: 'MODERATOR' },
  companyId: 'c1',
  storeId: 's1',
  country: { currencyCode: 'JOD', minorUnit: 3 },
};

/** Every offer row the product has — including the three that must NOT be offered on a line. */
const ALL_OFFERS = [
  { id: 'live', name: '٣ + ١', quantity: 3, freeQuantity: 1, sellingPrice: 75, status: 'ACTIVE' },
  { id: 'stopped', name: 'موقوف', quantity: 2, freeQuantity: 0, sellingPrice: 40, status: 'PAUSED' },
  { id: 'finished', name: 'منتهي', quantity: 4, freeQuantity: 0, sellingPrice: 90, status: 'ACTIVE' },
  { id: 'after', name: 'بعد الطلب', quantity: 1, freeQuantity: 0, sellingPrice: 15, status: 'ACTIVE' },
];

const product = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: id, nameEn: id, sku: id, status: 'ACTIVE', categoryId: 'cat', companyId: 'c1', storeId: 's1',
  category: { id: 'cat', name: 'عناية' }, images: [], offers: [], batches: [], ...over,
});

/** What the live reader's query returns for the live bundle of p1, as a row. */
const LIVE_ROW = {
  id: 'live', productId: 'p1', name: '٣ + ١', quantity: 3, freeQuantity: 1, sellingPrice: 75, discount: 3,
  compareAtPrice: null, isDefault: false, deliveryIncluded: true, endsAt: null,
};

const json = async (res: Response) => (await res.json()) as any;
const list = () => GET(new Request('http://localhost/api/products'));

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue(CTX);
  getPermissionScope.mockReturnValue({ scope: 'ALL_COMPANY' });
  maySeeCost.mockReturnValue(false);
  productCosts.mockResolvedValue(new Map());
  db.product.count.mockResolvedValue(0);
  db.product.findMany.mockResolvedValue([product('p1', { offers: ALL_OFFERS }), product('p2')]);
  db.orderItem.groupBy.mockResolvedValue([]);
  db.order.groupBy.mockResolvedValue([]);
  db.offer.findMany.mockResolvedValue([LIVE_ROW]);
});

describe('`offers` is what it always was', () => {
  it('every row the product has, stopped and finished and after-the-order included, untouched', async () => {
    const body = await json(await list());
    const p1 = body.products.find((p: any) => p.id === 'p1');
    expect(p1.offers).toEqual(ALL_OFFERS);
    // NEGATIVE: the live list is a different, shorter answer — the old field was not replaced by it.
    expect(p1.liveOffers).toHaveLength(1);
    expect(p1.offers.length).toBeGreaterThan(p1.liveOffers.length);
  });

  it('the select that feeds it still carries the gift and the status the order dialog reads', async () => {
    await list();
    const include = db.product.findMany.mock.calls[0]?.[0]?.include;
    expect(include.offers.select).toMatchObject({ id: true, name: true, quantity: true, freeQuantity: true, sellingPrice: true, status: true });
  });
});

describe('`liveOffers` is what may be sold today', () => {
  it('carries the bundle, what is charged, the price before its reduction, and the reduction', async () => {
    const body = await json(await list());
    const p1 = body.products.find((p: any) => p.id === 'p1');
    expect(p1.liveOffers).toEqual([
      expect.objectContaining({ id: 'live', quantity: 3, freeQuantity: 1, price: 72, listPrice: 75, discount: 3, deliveryIncluded: true, endsAt: null }),
    ]);
  });

  it('a product with nothing on sale has an empty list, not a missing one', async () => {
    const body = await json(await list());
    expect(body.products.find((p: any) => p.id === 'p2').liveOffers).toEqual([]);
  });

  it('is read in ONE query for the whole page, under the live predicate and the company', async () => {
    await list();
    expect(db.offer.findMany).toHaveBeenCalledTimes(1);
    const where = db.offer.findMany.mock.calls[0]?.[0]?.where;
    expect(where).toMatchObject({ companyId: 'c1', productId: { in: ['p1', 'p2'] }, status: 'ACTIVE', postOrderOffer: false });
    expect(where.OR).toHaveLength(2);
  });

  it('does not scan delivered orders for a struck-through price it never shows', async () => {
    await list();
    expect(db.order.groupBy).not.toHaveBeenCalled();
  });

  it('is rounded by the store’s currency (three places), and a reduction below the unit takes nothing', async () => {
    db.offer.findMany.mockResolvedValue([{ ...LIVE_ROW, sellingPrice: 0.1234, discount: 0.0004 }]);
    const body = await json(await list());
    const [offer] = body.products.find((p: any) => p.id === 'p1').liveOffers;
    expect(offer).toMatchObject({ price: 0.123, listPrice: null, discount: 0 });
  });
});

describe('an extra field never stops the catalogue', () => {
  it('when the live read fails the list still loads, `offers` intact and `liveOffers` absent', async () => {
    db.offer.findMany.mockRejectedValue(new Error('boom'));
    const res = await list();
    expect(res.status).toBe(200);
    const body = await json(res);
    const p1 = body.products.find((p: any) => p.id === 'p1');
    expect(p1.offers).toEqual(ALL_OFFERS);
    expect(Object.keys(p1)).not.toContain('liveOffers');
  });

  it('an empty catalogue asks the offers table nothing', async () => {
    db.product.findMany.mockResolvedValue([]);
    const body = await json(await list());
    expect(body.products).toEqual([]);
    expect(db.offer.findMany).not.toHaveBeenCalled();
  });
});
