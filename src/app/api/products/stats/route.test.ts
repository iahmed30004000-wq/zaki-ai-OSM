import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';
import { DELIVERED_SHIPPING } from '@/lib/order-state';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * GET /api/products/stats — THE FIGURES ABOVE THE PRODUCTS LIST AND THE UNITS IN ITS «المبيعات» COLUMN.
 *
 * The owner, 21/10: «بطاقات ذكية في المنتجات زي احصائيات» and «المبيعات في جدول المنتجات فش ارقام؟». What is held here is what
 * the door READS and to WHOM it answers:
 *
 *   · the same catalogue as the list, to the letter — so «١١٤ منتجاً» above the table and the rows under it are one catalogue;
 *   · the units a customer took, counted in the database from the lines of orders that reached the door as delivered — the
 *     settled part of a part-delivery, and `quantity + freeQuantity` where the door did not settle the line;
 *   · the value of the stock only for a caller who may see what goods cost — absent, not zero, for everybody else;
 *   · and a refusal in Arabic that reads nothing on the way.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, getPermissionScope, maySeeCost, productCosts, mayReadInsights } = vi.hoisted(() => ({
  db: {
    product: { findMany: vi.fn(), count: vi.fn() },
    // no product has a fixed cost here: the stock is worth what its batches say, as it was
    productFixedCost: { findMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []) },
    orderItem: { groupBy: vi.fn() },
  },
  requireContext: vi.fn(),
  getPermissionScope: vi.fn(),
  maySeeCost: vi.fn(),
  productCosts: vi.fn(),
  mayReadInsights: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  getPermissionScope: (...a: unknown[]) => getPermissionScope(...a),
  requirePermission: vi.fn(),
}));
vi.mock('@/lib/cost-visibility', () => ({ maySeeCost: (...a: unknown[]) => maySeeCost(...a), withoutCost: (b: unknown) => b }));
vi.mock('@/lib/insights-key', () => ({ mayReadInsights: (...a: unknown[]) => mayReadInsights(...a) }));
vi.mock('@/lib/product-cost', () => ({ productCosts: (...a: unknown[]) => productCosts(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/auth', () => ({ requireCompanyTenant: vi.fn() }));

import { GET as STATS } from './route';
import { GET as LIST } from '../route';

const STORE = 's1';
const CTX = { user: { id: 'u1', role: 'MODERATOR' }, companyId: 'c1', storeId: STORE };
const cost = (onHand: number, stockValue: number) => ({ onHand, stockValue, average: onHand ? stockValue / onHand : 0, nextOut: 0, batchCount: onHand ? 1 : 0 });
const listReq = () => new Request('http://localhost/api/products');

let settledRows: unknown[];
let unsettledRows: unknown[];

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue(CTX);
  getPermissionScope.mockReturnValue({ scope: 'ALL_COMPANY' });
  maySeeCost.mockReturnValue(false);
  // The cards (`totals`, `top`) travel to `insights.view` (PR-10); the tests below hold it unless they say otherwise.
  mayReadInsights.mockReturnValue(true);
  settledRows = [];
  unsettledRows = [];
  db.product.findMany.mockResolvedValue([]);
  db.product.count.mockResolvedValue(0);
  productCosts.mockResolvedValue(new Map());
  db.orderItem.groupBy.mockImplementation(async (args: { where: { deliveredQty: unknown } }) =>
    args.where.deliveredQty === null ? unsettledRows : settledRows
  );
});

const body = async (res: Response) => (await res.json()) as any;

describe('who may ask', () => {
  it('— without `products.view` it is a 403 in Arabic, in BOTH fields, and nothing is read', async () => {
    getPermissionScope.mockReturnValue(null);
    const res = await STATS();
    expect(res.status).toBe(403);
    const b = await body(res);
    expect(b.error).toBe('لا تملك صلاحية عرض المنتجات.');
    expect(b.errorAr).toBe('لا تملك صلاحية عرض المنتجات.');
    expect(db.product.findMany).not.toHaveBeenCalled();
    expect(db.orderItem.groupBy).not.toHaveBeenCalled();
    expect(productCosts).not.toHaveBeenCalled();
  });

  it('and the gate is the list’s own: `products.view`', async () => {
    await STATS();
    expect(getPermissionScope).toHaveBeenCalledWith(CTX.user, 'products.view');
  });
});

describe('the same catalogue as the list, to the letter', () => {
  const CASES: Array<[string, unknown, string | null]> = [
    ['a store is selected', { scope: 'ALL_COMPANY' }, STORE],
    ['no store is selected — the company, as the list reads it', { scope: 'ALL_COMPANY' }, null],
    ['the grant is by CATEGORY', { scope: 'CATEGORY', scopeIds: ['cat-1', 'cat-2'] }, STORE],
    ['the grant is by CATEGORY and its ids are broken', { scope: 'CATEGORY', scopeIds: null }, STORE],
    ['the grant is by SPECIFIC product', { scope: 'SPECIFIC', scopeIds: ['p1', 'p2'] }, STORE],
    ['the grant is by SPECIFIC product and its ids are broken', { scope: 'SPECIFIC', scopeIds: 'p1' }, STORE],
    ['the grant is OWN, which products treat as company-wide', { scope: 'OWN' }, STORE],
  ];

  it.each(CASES)('— %s', async (_name, scope, storeId) => {
    requireContext.mockResolvedValue({ ...CTX, storeId });
    getPermissionScope.mockReturnValue(scope);

    await LIST(listReq());
    const listWhere = db.product.findMany.mock.calls[0][0].where;
    db.product.findMany.mockClear();

    await STATS();
    const statsWhere = db.product.findMany.mock.calls[0][0].where;

    expect(statsWhere).toEqual(listWhere);
  });
});

describe('the units a customer took', () => {
  const PRODUCTS = [
    { id: 'p1', status: 'ACTIVE', categoryId: 'cat' },
    { id: 'p2', status: 'ACTIVE', categoryId: null },
    { id: 'p3', status: 'INACTIVE', categoryId: 'cat' },
  ];
  beforeEach(() => {
    db.product.findMany.mockResolvedValue(PRODUCTS);
    productCosts.mockResolvedValue(new Map([['p1', cost(10, 35)], ['p2', cost(0, 0)], ['p3', cost(4, 8)]]));
  });

  it('— two counts in the database, one row per product: the lines the door SETTLED, and the lines it did not', async () => {
    await STATS();
    expect(db.orderItem.groupBy).toHaveBeenCalledTimes(2);
    const calls = db.orderItem.groupBy.mock.calls.map((c) => c[0]);
    const settled = calls.find((a) => JSON.stringify(a.where.deliveredQty) === JSON.stringify({ not: null }));
    const unsettled = calls.find((a) => a.where.deliveredQty === null);
    expect(settled?.by).toEqual(['productId']);
    expect(settled?._sum).toEqual({ deliveredQty: true });
    expect(unsettled?.by).toEqual(['productId']);
    expect(unsettled?._sum).toEqual({ quantity: true, freeQuantity: true });
  });

  it('and both are about THESE products, in THIS company and store, on orders that reached the door as delivered', async () => {
    await STATS();
    for (const [args] of db.orderItem.groupBy.mock.calls) {
      expect(args.where.companyId).toBe('c1');
      expect(args.where.productId).toEqual({ in: ['p1', 'p2', 'p3'] });
      expect(args.where.order).toEqual({ companyId: 'c1', storeId: STORE, shippingStatus: { in: [...DELIVERED_SHIPPING] } });
    }
  });

  it('and with no store selected the orders are the company’s — as the list is', async () => {
    requireContext.mockResolvedValue({ ...CTX, storeId: null });
    await STATS();
    for (const [args] of db.orderItem.groupBy.mock.calls) {
      expect(args.where.order).toEqual({ companyId: 'c1', shippingStatus: { in: [...DELIVERED_SHIPPING] } });
    }
  });

  it('and the units are what the door settled plus quantity and gift on the lines it did not', async () => {
    settledRows = [{ productId: 'p1', _sum: { deliveredQty: 20 } }];
    unsettledRows = [
      { productId: 'p1', _sum: { quantity: 30, freeQuantity: 10 } },
      { productId: 'p2', _sum: { quantity: 7, freeQuantity: 0 } },
    ];
    const b = await body(await STATS());
    expect(b.unitsSold).toEqual({ p1: 60, p2: 7 });
    expect(b.totals.unitsSold).toBe(67);
  });

  it('and a null sum is nothing, not NaN — a product with only settled lines, or only a gift', async () => {
    settledRows = [{ productId: 'p1', _sum: { deliveredQty: null } }];
    unsettledRows = [{ productId: 'p2', _sum: { quantity: null, freeQuantity: 2 } }];
    const b = await body(await STATS());
    expect(b.unitsSold).toEqual({ p2: 2 });
  });

  it('and a sum the database did not return at all is nothing, not NaN', async () => {
    // The SAME product has a settled row with no figure and an unsettled row with some: one missing figure must not eat the other.
    settledRows = [{ productId: 'p1', _sum: {} }];
    unsettledRows = [{ productId: 'p1', _sum: { quantity: 3 } }];
    const b = await body(await STATS());
    expect(b.unitsSold).toEqual({ p1: 3 });
    expect(b.totals.unitsSold).toBe(3);
  });

  it('and the top product is the one with the most units', async () => {
    settledRows = [{ productId: 'p1', _sum: { deliveredQty: 5 } }];
    unsettledRows = [{ productId: 'p3', _sum: { quantity: 40, freeQuantity: 0 } }];
    const b = await body(await STATS());
    expect(b.top).toEqual({ id: 'p3', units: 40 });
  });

  it('and nothing about a customer is read — only counts per product', async () => {
    await STATS();
    for (const [args] of db.orderItem.groupBy.mock.calls) {
      expect(Object.keys(args).sort()).toEqual(['_sum', 'by', 'where']);
    }
  });
});

describe('the stock and what it is worth', () => {
  beforeEach(() => {
    db.product.findMany.mockResolvedValue([
      { id: 'p1', status: 'ACTIVE', categoryId: 'cat' },
      { id: 'p2', status: 'ACTIVE', categoryId: null },
    ]);
    productCosts.mockResolvedValue(new Map([['p1', cost(10, 35)], ['p2', cost(0, 0)]]));
  });

  it('— units on hand and the products with none are sent to everyone who may see the catalogue', async () => {
    maySeeCost.mockReturnValue(false);
    const b = await body(await STATS());
    expect(b.totals.unitsOnHand).toBe(10);
    expect(b.totals.outOfStock).toBe(1);
    expect(b.totals.products).toBe(2);
    expect(b.totals.unfiled).toBe(1);
  });

  it('and the VALUE of the stock is absent — not zero — for a caller who may not see what goods cost', async () => {
    maySeeCost.mockReturnValue(false);
    const b = await body(await STATS());
    expect('stockValue' in b.totals).toBe(false);
    expect(JSON.stringify(b)).not.toContain('35');
  });

  it('and is the sum of what each product’s stock is worth for a caller who may', async () => {
    maySeeCost.mockReturnValue(true);
    const b = await body(await STATS());
    expect(b.totals.stockValue).toBe(35);
  });

  it('and cost is judged for THIS caller', async () => {
    await STATS();
    expect(maySeeCost).toHaveBeenCalledWith(CTX.user);
  });

  it('and the costs are read once for the whole page, for exactly the products in scope', async () => {
    await STATS();
    expect(productCosts).toHaveBeenCalledTimes(1);
    expect(productCosts).toHaveBeenCalledWith(db, 'c1', ['p1', 'p2']);
  });

  describe('a product with a fixed cost (the owner, 1/11: «سعر تكلفة المنتج يكون ثابت»)', () => {
    it('— its stock is worth on hand × the figure an admin set; the other product is still worth what its batches say', async () => {
      maySeeCost.mockReturnValue(true);
      // p1: 10 on hand, the batches say 35 (3.5 each) — the admin fixed it at 5. p2: 4 on hand worth 12 by its batches, no figure.
      productCosts.mockResolvedValue(new Map([['p1', cost(10, 35)], ['p2', cost(4, 12)]]));
      db.productFixedCost.findMany.mockResolvedValueOnce([{ productId: 'p1', amount: 5 }]);
      const b = await body(await STATS());
      expect(b.totals.stockValue).toBe(62); // 10 × 5 + 12 — not 47 (the batches), and not 70 (p1's figure applied to p2 as well)
    });

    it('— a product with no figure is unchanged: 35, as before', async () => {
      maySeeCost.mockReturnValue(true);
      const b = await body(await STATS());
      expect(b.totals.stockValue).toBe(35);
    });

    it('— the figures are read once, for this company and exactly the products in scope', async () => {
      maySeeCost.mockReturnValue(true);
      await STATS();
      expect(db.productFixedCost.findMany).toHaveBeenCalledTimes(1);
      const args = db.productFixedCost.findMany.mock.calls[0][0] as { where: { companyId: string; productId: { in: string[] } } };
      expect(args.where).toEqual({ companyId: 'c1', productId: { in: ['p1', 'p2'] } });
    });

    it('— somebody who may not see what goods cost has the figures neither read nor sent', async () => {
      maySeeCost.mockReturnValue(false);
      db.productFixedCost.findMany.mockResolvedValue([{ productId: 'p1', amount: 5 }]);
      const b = await body(await STATS());
      expect(db.productFixedCost.findMany).not.toHaveBeenCalled();
      expect('stockValue' in b.totals).toBe(false);
      expect(JSON.stringify(b)).not.toContain('50');
    });
  });
});

describe('an empty catalogue', () => {
  it('— answers zeros without a single query over orders or batches', async () => {
    db.product.findMany.mockResolvedValue([]);
    const b = await body(await STATS());
    expect(b.totals).toEqual({ products: 0, active: 0, unfiled: 0, outOfStock: 0, unitsOnHand: 0, unitsSold: 0 });
    expect(b.top).toBeNull();
    expect(db.orderItem.groupBy).not.toHaveBeenCalled();
    expect(productCosts).not.toHaveBeenCalled();
  });
});

describe('how it is built', () => {
  const src = () => stripComments(readFileSync(join(process.cwd(), 'src/app/api/products/stats/route.ts'), 'utf8'));
  // RV87: the counting moved out of this door into the one function the list and the product page also read.
  const counting = () => stripComments(readFileSync(join(process.cwd(), 'src/lib/product-sold.ts'), 'utf8'));

  it('— the units are COUNTED in the database, never loaded line by line into JavaScript', () => {
    expect(src()).toContain('deliveredUnitsByProduct');
    expect(counting()).toContain('groupBy');
    expect(counting()).not.toMatch(/orderItem\.findMany/);
    expect(src()).not.toMatch(/orderItem\./);
  });

  it('and «delivered» is the one definition of it, imported — never a list of states written here', () => {
    expect(counting()).toContain("import { DELIVERED_SHIPPING } from './order-state'");
    expect(counting()).not.toMatch(/'DELIVERED'|"DELIVERED"/);
    expect(src()).not.toMatch(/'DELIVERED'|"DELIVERED"/);
  });

  it('and the door sends no English refusal', () => {
    expect(src()).not.toMatch(/error: '[A-Za-z]/);
  });
});

/**
 * THE CARDS ARE THE SMART-CARD KEY'S; THE COLUMN IS THE CATALOGUE'S (perm-plan PR-10).
 *
 * `totals` and `top` are the four cards above the list. Without `insights.view` they are ABSENT — not zero, not null — and the
 * units per product, which feed each row's «المبيعات» cell, stay for everybody who may see the catalogue.
 */
describe('without insights.view: the column stays, the cards go', () => {
  beforeEach(() => {
    mayReadInsights.mockReturnValue(false);
    db.product.findMany.mockResolvedValue([{ id: 'p1', status: 'ACTIVE', categoryId: 'c' }]);
    productCosts.mockResolvedValue(new Map([['p1', cost(10, 35)]]));
    settledRows = [{ productId: 'p1', _sum: { deliveredQty: 12 } }];
  });

  it('answers the units per product and nothing else', async () => {
    const b = await body(await STATS());
    expect(b).toEqual({ unitsSold: { p1: 12 } });
    expect('totals' in b).toBe(false);
    expect('top' in b).toBe(false);
  });

  it('and not one of the stock figures leaks through the units (no on-hand, no value)', async () => {
    maySeeCost.mockReturnValue(true);
    const text = JSON.stringify(await body(await STATS()));
    expect(text).not.toContain('stockValue');
    expect(text).not.toContain('unitsOnHand');
    expect(text).not.toContain('35');
  });

  it('NEGATIVE (the test of the test): the same caller WITH the key gets the cards', async () => {
    mayReadInsights.mockReturnValue(true);
    const b = await body(await STATS());
    expect(b.totals.unitsSold).toBe(12);
    expect(b.top).toEqual({ id: 'p1', units: 12 });
  });

  it('asks the key of THIS caller, not a stale one', async () => {
    await STATS();
    expect(mayReadInsights).toHaveBeenCalledWith(CTX.user);
  });
});
