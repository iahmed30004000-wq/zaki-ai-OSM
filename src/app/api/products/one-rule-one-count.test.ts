import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';
import { productScopeWhere, productScopeWhereWithin } from '@/lib/product-scope';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE PRODUCTS DOORS SAY «WHICH PRODUCTS» ONCE (RV86) AND «HOW MANY WERE SOLD» ONCE (RV87).
 *
 *   RV86 — the rule (a CATEGORY grant reaches «categoryId in», a SPECIFIC grant reaches «id in») was written by hand in
 *          three doors (the list, «/stats», «/grades»): three copies of one rule, drifting the day a scope kind is added.
 *          It is «product-scope.ts» now, and these tests hold that the doors agree to the letter and that no door writes
 *          the rule again.
 *
 *   RV87 — «analytics.totalSold» was the sum of the batch counter, which reads 0 for a delivery that never drew from a
 *          batch. The list door and the product page now say the number the stats door says: the delivered lines.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, getPermissionScope, maySeeCost, productCosts, authorize } = vi.hoisted(() => ({
  db: {
    product: { findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn() },
    // no product has a fixed cost in these tests: the costs are the batches', as they were
    productFixedCost: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
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

import { GET as STATS } from './stats/route';
import { GET as LIST } from './route';
import { GET as ONE } from './[id]/route';

const CTX = { user: { id: 'u1', role: 'MODERATOR' }, companyId: 'c1', storeId: 's1', country: { currencyCode: 'JOD' } };
const BATCH_TRAP = 99; // what the old counter said
const batch = (over: Record<string, unknown> = {}) => ({
  id: 'b1', batchNumber: 'B-1', quantityProduced: 100, quantitySold: BATCH_TRAP, quantityRemaining: 1,
  totalProductionCost: 200, costPerUnit: 2, manufacturingCost: 100, packagingCost: 50, rawMaterialCost: 40, otherCosts: 10,
  productionDate: new Date('2026-09-01'), ...over,
});
const product = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: id, nameEn: id, sku: id, status: 'ACTIVE', categoryId: 'cat', companyId: 'c1', storeId: 's1',
  category: { id: 'cat', name: 'عناية' }, images: [], offers: [], batches: [batch()], ...over,
});

let settled: unknown[];
let unsettled: unknown[];

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue(CTX);
  getPermissionScope.mockReturnValue({ scope: 'ALL_COMPANY' });
  maySeeCost.mockReturnValue(true);
  authorize.mockReturnValue({ allowed: true });
  settled = [{ productId: 'p1', _sum: { deliveredQty: 20 } }];
  unsettled = [{ productId: 'p1', _sum: { quantity: 30, freeQuantity: 10 } }];
  db.product.findMany.mockResolvedValue([product('p1'), product('p2')]);
  db.product.findFirst.mockResolvedValue(product('p1'));
  db.product.count.mockResolvedValue(0);
  productCosts.mockResolvedValue(new Map([['p1', { average: 2, onHand: 1, stockValue: 2 }], ['p2', { average: 0, onHand: 0, stockValue: 0 }]]));
  db.orderItem.groupBy.mockImplementation(async (a: { where: { deliveredQty: unknown } }) => (a.where.deliveredQty === null ? unsettled : settled));
});

const json = async (res: Response) => (await res.json()) as any;
const listReq = () => new Request('http://localhost/api/products');
const oneCtx = (id: string) => ({ params: Promise.resolve({ id }) });

describe('RV87 — three doors, one «sold»', () => {
  it('— the list says what the customers took (60), not what the batch counter says (99)', async () => {
    const b = await json(await LIST(listReq()));
    const p1 = b.products.find((p: any) => p.id === 'p1');
    expect(p1.analytics.totalSold).toBe(60);
    expect(p1.analytics.totalSold).not.toBe(BATCH_TRAP);
  });

  it('— a product with no delivered line says 0, whatever its batch counter holds', async () => {
    const b = await json(await LIST(listReq()));
    expect(b.products.find((p: any) => p.id === 'p2').analytics.totalSold).toBe(0);
  });

  it('— the product page says the same 60', async () => {
    const b = await json(await ONE(new Request('http://localhost/api/products/p1'), oneCtx('p1')));
    expect(b.analytics.totalSold).toBe(60);
  });

  it('— and the stats door says the same 60: the three can never disagree', async () => {
    const list = await json(await LIST(listReq()));
    const one = await json(await ONE(new Request('http://localhost/api/products/p1'), oneCtx('p1')));
    const stats = await json(await STATS());
    const fromList = list.products.find((p: any) => p.id === 'p1').analytics.totalSold;
    expect(fromList).toBe(one.analytics.totalSold);
    expect(fromList).toBe(stats.unitsSold.p1);
  });

  it('— the money beside it is exactly what it was: costs from the batches, the average from the one cost function', async () => {
    const b = await json(await LIST(listReq()));
    const a = b.products.find((p: any) => p.id === 'p1').analytics;
    expect(a).toMatchObject({ totalProduced: 100, totalRemaining: 1, totalMfgCost: 100, totalPackCost: 50, totalRawCost: 40, totalOtherCost: 10, totalProdCost: 200, avgCostPerUnit: 2 });
    expect(productCosts).toHaveBeenCalledTimes(1);
  });

  it('— a caller who may not see cost still gets the units, and no cost key', async () => {
    maySeeCost.mockReturnValue(false);
    const b = await json(await LIST(listReq()));
    const a = b.products.find((p: any) => p.id === 'p1').analytics;
    expect(a.totalSold).toBe(60);
    expect(Object.keys(a)).not.toContain('avgCostPerUnit');
    expect(Object.keys(a)).not.toContain('totalProdCost');
    expect(productCosts).not.toHaveBeenCalled();
  });

  it('— NEGATIVE: an empty catalogue asks the database nothing about orders', async () => {
    db.product.findMany.mockResolvedValue([]);
    const b = await json(await LIST(listReq()));
    expect(b.products).toEqual([]);
    expect(db.orderItem.groupBy).not.toHaveBeenCalled();
  });

  it('— the count is about THIS store’s orders', async () => {
    await LIST(listReq());
    for (const [args] of db.orderItem.groupBy.mock.calls) expect(args.where.order.storeId).toBe('s1');
  });

  it('— and the page of a product that is not the caller’s stays a 404 before anything is counted', async () => {
    db.product.findFirst.mockResolvedValue(null);
    const res = await ONE(new Request('http://localhost/api/products/zz'), oneCtx('zz'));
    expect(res.status).toBe(404);
    expect(db.orderItem.groupBy).not.toHaveBeenCalled();
  });
});

describe('RV86 — the same catalogue from every door, whatever the grant', () => {
  const CASES: Array<[string, unknown, string | null]> = [
    ['all of the company', { scope: 'ALL_COMPANY' }, 's1'],
    ['no store selected', { scope: 'ALL_COMPANY' }, null],
    ['a CATEGORY grant', { scope: 'CATEGORY', scopeIds: ['cat-1', 'cat-2'] }, 's1'],
    ['a CATEGORY grant with broken ids', { scope: 'CATEGORY', scopeIds: null }, 's1'],
    ['a SPECIFIC grant', { scope: 'SPECIFIC', scopeIds: ['p1', 'p2'] }, 's1'],
    ['a SPECIFIC grant with broken ids', { scope: 'SPECIFIC', scopeIds: 'p1' }, 's1'],
    ['an OWN grant, which products treat as company-wide', { scope: 'OWN' }, 's1'],
  ];

  it.each(CASES)('— list and stats read one "where": %s', async (_n, scope, storeId) => {
    requireContext.mockResolvedValue({ ...CTX, storeId });
    getPermissionScope.mockReturnValue(scope);
    await LIST(listReq());
    const listWhere = db.product.findMany.mock.calls[0][0].where;
    db.product.findMany.mockClear();
    await STATS();
    expect(db.product.findMany.mock.calls[0][0].where).toEqual(listWhere);
    expect(listWhere).toEqual(productScopeWhere(scope as never, 'c1', storeId));
  });

  it.each(CASES)('— grades narrows that same rule to the ids asked for, never widening it: %s', (_n, scope, storeId) => {
    const base = productScopeWhere(scope as never, 'c1', storeId);
    const within = productScopeWhereWithin(scope as never, 'c1', storeId, ['p1', 'zz']);
    const { id: baseId, ...baseRest } = base as any;
    const { id: withinId, ...withinRest } = within as any;
    expect(withinRest).toEqual(baseRest);
    if ((scope as any).scope === 'SPECIFIC') {
      const granted: string[] = Array.isArray((scope as any).scopeIds) ? (scope as any).scopeIds : [];
      // an id the grant does not name is dropped — an id in a query string is a request, not a permission
      expect(withinId).toEqual({ in: ['p1', 'zz'].filter((i) => granted.includes(i)) });
      expect(baseId).toEqual({ in: granted });
    } else {
      expect(withinId).toEqual({ in: ['p1', 'zz'] });
      expect(baseId).toBeUndefined();
    }
  });

  it('— NEGATIVE: a SPECIFIC grant never reaches an id it was not given', () => {
    const within = productScopeWhereWithin({ scope: 'SPECIFIC', scopeIds: ['p1'] }, 'c1', 's1', ['p9']);
    expect((within as any).id).toEqual({ in: [] });
  });
});

describe('RV86 — no door writes the rule again', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(full);
    }
    return out;
  }
  const files = walk(join(process.cwd(), 'src/app/api/products'));

  it('— found the doors', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('— none names a scope kind: that is "lib/product-scope.ts"’s alone', () => {
    const offenders = files.filter((f) => /['"](CATEGORY|SPECIFIC)['"]/.test(stripComments(readFileSync(f, 'utf8'))));
    expect(offenders, "هذي الأبواب كتبت قاعدة النطاق بإيدها: ${offenders.join('، ')}").toEqual([]);
  });

  it('— and the three doors that list products read it from there', () => {
    for (const rel of ['route.ts', 'stats/route.ts']) {
      expect(stripComments(readFileSync(join(process.cwd(), 'src/app/api/products', rel), 'utf8')), rel).toContain("from '@/lib/product-scope'");
    }
    expect(stripComments(readFileSync(join(process.cwd(), 'src/app/api/products/grades/route.ts'), 'utf8'))).toContain('productScopeWhereWithin');
  });

  it('— and no door sums the batch counter into «sold» any more', () => {
    for (const rel of ['route.ts', '[id]/route.ts']) {
      const src = stripComments(readFileSync(join(process.cwd(), 'src/app/api/products', rel), 'utf8'));
      expect(src, rel).not.toMatch(/reduce\([^)]*quantitySold/);
      expect(src, rel).toContain('deliveredUnitsByProduct');
    }
  });
});
