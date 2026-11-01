import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE PRODUCTS LIST AND THE PRODUCT PAGE SAY THE COST THAT DOES NOT MOVE (the owner, 1/11)
 *
 * «سعر تكلفة المنتج يكون ثابت ولا يتغير ابدا… اللي بيقدر يغيرو الادمنة فقط من قائمة المنتجات.»
 *
 *  · `analytics.avgCostPerUnit` is the fixed figure where an admin set one, and the weighted average of the batches where none was
 *    — "no figure, no change";
 *  · `analytics.fixedCost` says which of the two it is: the figure, or `null`. ZERO is a figure, not "none";
 *  · the batches' own money (what was spent making them) is untouched: only the cost OF A UNIT moves;
 *  · somebody who may not see what goods cost gets neither key, and the figures are not even read for them;
 *  · the figures are asked once for the whole page of the list, for this company and exactly the products on it.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, getPermissionScope, maySeeCost, productCosts, authorize } = vi.hoisted(() => ({
  db: {
    product: { findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn() },
    productFixedCost: { findMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []) },
    orderItem: { groupBy: vi.fn() },
  },
  requireContext: vi.fn(),
  getPermissionScope: vi.fn(),
  maySeeCost: vi.fn(),
  productCosts: vi.fn(),
  authorize: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  getPermissionScope: (...a: unknown[]) => getPermissionScope(...a),
  requirePermission: vi.fn(),
  can: vi.fn(() => true),
  authorize: (...a: unknown[]) => authorize(...a),
}));
vi.mock('@/lib/cost-visibility', () => ({ maySeeCost: (...a: unknown[]) => maySeeCost(...a), withoutCost: (b: unknown) => b }));
vi.mock('@/lib/product-cost', () => ({ productCosts: (...a: unknown[]) => productCosts(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/auth', () => ({ requireCompanyTenant: vi.fn() }));
vi.mock('@/lib/landing-cache', () => ({ refreshLandingPages: vi.fn() }));
vi.mock('@/lib/selling-currency', () => ({ sellingCurrency: vi.fn(async () => 'JOD') }));
vi.mock('@/lib/storage', () => ({ deleteStoredFile: vi.fn() }));
vi.mock('@/lib/offers', () => ({ baseBelowActiveOffersRefusal: vi.fn() }));

import { GET as LIST } from './route';
import { GET as ONE } from './[id]/route';

const CTX = { user: { id: 'u1', role: 'COMPANY_ADMIN' }, companyId: 'c1', storeId: 's1', country: { currencyCode: 'JOD' } };
const batch = () => ({
  id: 'b1', batchNumber: 'B-1', quantityProduced: 100, quantitySold: 0, quantityRemaining: 10,
  totalProductionCost: 200, costPerUnit: 2, manufacturingCost: 100, packagingCost: 50, rawMaterialCost: 40, otherCosts: 10,
  productionDate: new Date('2026-09-01'),
});
const product = (id: string) => ({
  id, name: id, nameEn: id, sku: id, status: 'ACTIVE', categoryId: 'cat', companyId: 'c1', storeId: 's1',
  category: { id: 'cat', name: 'عناية' }, images: [], offers: [], batches: [batch()],
});

const json = async (res: Response) => (await res.json()) as any;
const list = async () => json(await LIST(new Request('http://localhost/api/products')));
const one = async (id = 'p1') => json(await ONE(new Request(`http://localhost/api/products/${id}`), { params: Promise.resolve({ id }) }));
const analyticsOf = (b: any, id: string) => b.products.find((p: any) => p.id === id).analytics;

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue(CTX);
  getPermissionScope.mockReturnValue({ scope: 'ALL_COMPANY' });
  maySeeCost.mockReturnValue(true);
  authorize.mockReturnValue({ allowed: true });
  db.product.findMany.mockResolvedValue([product('p1'), product('p2')]);
  db.product.findFirst.mockResolvedValue(product('p1'));
  db.product.count.mockResolvedValue(0);
  db.orderItem.groupBy.mockResolvedValue([]);
  db.productFixedCost.findMany.mockResolvedValue([]);
  // The batches say p1 costs 2 a unit; p2 has nothing on hand.
  productCosts.mockResolvedValue(new Map([['p1', { average: 2, onHand: 10, stockValue: 20 }], ['p2', { average: 0, onHand: 0, stockValue: 0 }]]));
});

describe('the list', () => {
  it('no figure → the unit cost is what the batches say, and `fixedCost` is null: nothing moved', async () => {
    const a = analyticsOf(await list(), 'p1');
    expect(a.avgCostPerUnit).toBe(2);
    expect(a.fixedCost).toBeNull();
  });

  it('a figure → the unit cost IS the figure and `fixedCost` says so; a product with none beside it keeps the batches’ answer', async () => {
    db.productFixedCost.findMany.mockResolvedValue([{ productId: 'p1', amount: 5 }]);
    const b = await list();
    expect(analyticsOf(b, 'p1')).toMatchObject({ avgCostPerUnit: 5, fixedCost: 5 });
    expect(analyticsOf(b, 'p2')).toMatchObject({ avgCostPerUnit: 0, fixedCost: null });
  });

  it('the batches’ own money is untouched — what was spent making them is a fact, only the cost of a unit is the figure', async () => {
    db.productFixedCost.findMany.mockResolvedValue([{ productId: 'p1', amount: 5 }]);
    expect(analyticsOf(await list(), 'p1')).toMatchObject({
      totalMfgCost: 100, totalPackCost: 50, totalRawCost: 40, totalOtherCost: 10, totalProdCost: 200, totalProduced: 100, totalRemaining: 10,
    });
  });

  it('ZERO is a figure — a free sample costs nothing, and that is not "no figure"', async () => {
    db.productFixedCost.findMany.mockResolvedValue([{ productId: 'p1', amount: 0 }]);
    expect(analyticsOf(await list(), 'p1')).toMatchObject({ avgCostPerUnit: 0, fixedCost: 0 });
  });

  it('the unit cost is shown to two decimals, as it always was; the figure itself is sent as typed', async () => {
    db.productFixedCost.findMany.mockResolvedValue([{ productId: 'p1', amount: 5.1234 }]);
    expect(analyticsOf(await list(), 'p1')).toMatchObject({ avgCostPerUnit: 5.12, fixedCost: 5.1234 });
  });

  it('is asked ONCE for the whole page — this company and exactly the products on it', async () => {
    await list();
    expect(db.productFixedCost.findMany).toHaveBeenCalledTimes(1);
    const args = db.productFixedCost.findMany.mock.calls[0][0] as { where: unknown };
    expect(args.where).toEqual({ companyId: 'c1', productId: { in: ['p1', 'p2'] } });
  });

  it('somebody who may not see what goods cost gets neither key — and the figures are not even read', async () => {
    maySeeCost.mockReturnValue(false);
    db.productFixedCost.findMany.mockResolvedValue([{ productId: 'p1', amount: 5 }]);
    const a = analyticsOf(await list(), 'p1');
    expect('avgCostPerUnit' in a).toBe(false);
    expect('fixedCost' in a).toBe(false);
    expect(db.productFixedCost.findMany).not.toHaveBeenCalled();
  });
});

describe('the product page', () => {
  it('no figure → the unit cost is the batches’, `fixedCost` null', async () => {
    const b = await one();
    expect(b.analytics.avgCostPerUnit).toBe(2);
    expect(b.analytics.fixedCost).toBeNull();
  });

  it('a figure → the unit cost IS the figure — the page says what the list says', async () => {
    db.productFixedCost.findMany.mockResolvedValue([{ productId: 'p1', amount: 5 }]);
    const [page, many] = [await one(), await list()];
    expect(page.analytics).toMatchObject({ avgCostPerUnit: 5, fixedCost: 5 });
    expect(page.analytics.avgCostPerUnit).toBe(analyticsOf(many, 'p1').avgCostPerUnit);
    expect(page.analytics.fixedCost).toBe(analyticsOf(many, 'p1').fixedCost);
  });

  it('ZERO is a figure here too', async () => {
    db.productFixedCost.findMany.mockResolvedValue([{ productId: 'p1', amount: 0 }]);
    expect((await one()).analytics).toMatchObject({ avgCostPerUnit: 0, fixedCost: 0 });
  });

  it('is asked for THIS company and THIS product', async () => {
    await one();
    const args = db.productFixedCost.findMany.mock.calls[0][0] as { where: unknown };
    expect(args.where).toEqual({ companyId: 'c1', productId: { in: ['p1'] } });
  });

  it('somebody who may not see what goods cost gets neither key — and the figure is not even read', async () => {
    maySeeCost.mockReturnValue(false);
    db.productFixedCost.findMany.mockResolvedValue([{ productId: 'p1', amount: 5 }]);
    const b = await one();
    expect('avgCostPerUnit' in b.analytics).toBe(false);
    expect('fixedCost' in b.analytics).toBe(false);
    expect(db.productFixedCost.findMany).not.toHaveBeenCalled();
  });
});
