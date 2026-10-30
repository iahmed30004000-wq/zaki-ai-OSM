import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE GRADE ON THE PRODUCTS LIST — AND THE TWO THINGS IT MUST NOT SAY.
 *
 * It must not say a product never sold to somebody who merely may not see
 * sales, and it must not put the company's margin in front of a confirmation
 * agent. `cost-visibility.ts` exists because this very endpoint once returned
 * the cost of every batch to everyone who could open the products screen, so
 * every gate below is tested by its REFUSAL and not by its success.
 */

const { db, requireContext, can, getPermissionScope, maySeeCost, getDateRange } = vi.hoisted(() => ({
  db: { product: { findMany: vi.fn() }, orderItem: { findMany: vi.fn() } },
  requireContext: vi.fn(),
  can: vi.fn(),
  getPermissionScope: vi.fn(),
  maySeeCost: vi.fn(),
  getDateRange: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  can: (...a: unknown[]) => can(...a),
  getPermissionScope: (...a: unknown[]) => getPermissionScope(...a),
}));
vi.mock('@/lib/cost-visibility', () => ({ maySeeCost: (...a: unknown[]) => maySeeCost(...a) }));
vi.mock('@/lib/analytics', () => ({ getDateRange: (...a: unknown[]) => getDateRange(...a) }));

import { GET } from './route';

/** The measured catalogue, trimmed to the rows each test needs. */
const TOP = { id: 'top', status: 'ACTIVE', basePrice: 0, categoryId: null, _count: { images: 0 } };
const READY = { id: 'ready', status: 'ACTIVE', basePrice: 20, categoryId: 'cat', _count: { images: 2 } };

const order = (over: Record<string, unknown> = {}) => ({
  confirmationStatus: 'CONFIRMED',
  shippingStatus: 'DELIVERED',
  totalAmount: 20,
  collectedAmount: null,
  estimatedCostOfGoods: 0,
  ...over,
});

/** `n` delivered lines of one product, each worth `each`. */
const deliveredLines = (productId: string, n: number, each = 20, over: Record<string, unknown> = {}) =>
  Array.from({ length: n }, (_, i) => ({
    productId,
    lineTotal: each,
    orderId: `${productId}-o${i}`,
    order: order({ totalAmount: each, ...over }),
  }));

const req = (ids: string) => new Request(`http://x/api/products/grades?ids=${ids}`);

beforeEach(() => {
  vi.resetAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'owner', role: 'COMPANY_ADMIN', companyId: 'c1' },
    companyId: 'c1',
    storeId: 's1',
  });
  getPermissionScope.mockReturnValue({ scope: 'ALL_COMPANY', scopeIds: null });
  can.mockReturnValue(true);
  maySeeCost.mockReturnValue(true);
  getDateRange.mockReturnValue({ start: new Date('2026-07-01T00:00:00Z'), end: new Date('2026-09-29T00:00:00Z') });
  db.product.findMany.mockResolvedValue([TOP]);
  db.orderItem.findMany.mockResolvedValue(deliveredLines('top', 12));
});

describe('who may ask', () => {
  it('refuses without products.view, and reads nothing on the way to the refusal', async () => {
    getPermissionScope.mockReturnValue(null);
    const res = await GET(req('top'));
    expect(res.status).toBe(403);
    expect(db.product.findMany).not.toHaveBeenCalled();
    expect(db.orderItem.findMany).not.toHaveBeenCalled();
  });

  it('asks the scope for products.view, the same key the list is gated on', async () => {
    await GET(req('top'));
    expect(getPermissionScope.mock.calls[0][1]).toBe('products.view');
  });

  it('answers an empty id list without touching the database', async () => {
    const res = await GET(req(''));
    expect(res.status).toBe(200);
    expect((await res.json()).grades).toEqual([]);
    expect(db.product.findMany).not.toHaveBeenCalled();
  });
});

describe('the grade is a smart card — insights.view (PR-10)', () => {
  it('refuses a caller who may see the catalogue and the reports but not the cards, in Arabic in BOTH fields, reading nothing', async () => {
    can.mockImplementation((_u: unknown, key: string) => key !== 'insights.view');
    const res = await GET(req('top'));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/[\u0600-\u06FF]/);
    expect(body.errorAr).toBe(body.error);
    expect(body.code).toBe('INSIGHTS_REQUIRED');
    expect(db.product.findMany).not.toHaveBeenCalled();
    expect(db.orderItem.findMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: the cards alone, without the catalogue key, is still the catalogue’s refusal', async () => {
    getPermissionScope.mockReturnValue(null);
    can.mockImplementation((_u: unknown, key: string) => key === 'insights.view');
    expect((await GET(req('top'))).status).toBe(403);
    expect(db.product.findMany).not.toHaveBeenCalled();
  });

  it('asks the cards’ key of THIS caller', async () => {
    await GET(req('top'));
    expect(can.mock.calls.some((c) => c[1] === 'insights.view' && c[0]?.id === 'owner')).toBe(true);
  });
});

describe('the sales gate — reports.view alone', () => {
  it('omits the whole performance half when the caller has neither', async () => {
    // The cards' key is held (PR-10); the reports' key is not.
    can.mockImplementation((_u: unknown, key: string) => key === 'insights.view');
    const res = await GET(req('top'));
    const body = await res.json();
    expect(body.salesVisible).toBe(false);
    expect(body.grades[0].state).toBe('SALES_HIDDEN');
    expect(body.grades[0].score).toBeNull();
    expect(body.grades[0].sales).toBeNull();
    // Not merely hidden in the row: never read at all.
    expect(db.orderItem.findMany).not.toHaveBeenCalled();
  });

  it('leaks no count, no revenue and no order of any kind in that answer', async () => {
    can.mockImplementation((_u: unknown, key: string) => key === 'insights.view');
    const text = JSON.stringify(await (await GET(req('top'))).json());
    expect(text).not.toContain('deliveredRevenue');
    expect(text).not.toContain('"confirmed"');
  });

  it('still answers the readiness question, which is catalogue data the list already shows', async () => {
    can.mockImplementation((_u: unknown, key: string) => key === 'insights.view');
    const body = await (await GET(req('top'))).json();
    expect(body.grades[0].readiness.gaps.map((g: { key: string }) => g.key)).toEqual([
      'price',
      'image',
      'category',
    ]);
    expect(body.readiness.notSellable).toBe(1);
  });

  it('opens on reports.view alone — and NEGATIVE: the retired analytics.view opens nothing (29/10)', async () => {
    can.mockImplementation((_u: unknown, key: string) => key === 'reports.view' || key === 'insights.view');
    expect((await (await GET(req('top'))).json()).salesVisible).toBe(true);
    can.mockImplementation((_u: unknown, key: string) => key === 'analytics.view' || key === 'insights.view');
    expect((await (await GET(req('top'))).json()).salesVisible).toBe(false);
  });
});

describe('the cost gate — maySeeCost', () => {
  const withCost = () => db.orderItem.findMany.mockResolvedValue(deliveredLines('top', 12, 20, { estimatedCostOfGoods: 5 }));

  it('scores the margin band for a caller who may see cost', async () => {
    withCost();
    const body = await (await GET(req('top'))).json();
    const band = body.grades[0].score.bands.find((b: { key: string }) => b.key === 'goods_margin');
    // 12 delivered at 20 = 240 revenue, 60 cost → 75% margin
    expect(band.value).toBe(75);
    expect(body.grades[0].score.possible).toBe(100);
    expect(body.costVisible).toBe(true);
  });

  it('drops the band entirely for a caller who may not — absent, never zero', async () => {
    withCost();
    maySeeCost.mockReturnValue(false);
    const body = await (await GET(req('top'))).json();
    const band = body.grades[0].score.bands.find((b: { key: string }) => b.key === 'goods_margin');
    expect(band.points).toBeNull();
    expect(band.value).toBeNull();
    expect(body.grades[0].sales.deliveredCogs).toBeNull();
    expect(body.costVisible).toBe(false);
  });

  it('and then the score says it is out of less, rather than looking like a worse product', async () => {
    withCost();
    maySeeCost.mockReturnValue(false);
    const body = await (await GET(req('top'))).json();
    expect(body.grades[0].score.possible).toBe(70);
    expect(body.grades[0].why).toContain('من 70');
  });

  it('writes no cost figure anywhere in that answer', async () => {
    db.orderItem.findMany.mockResolvedValue(deliveredLines('top', 12, 20, { estimatedCostOfGoods: 7.25 }));
    maySeeCost.mockReturnValue(false);
    const text = JSON.stringify(await (await GET(req('top'))).json());
    expect(text).not.toContain('7.25');
    expect(text).not.toContain('87'); // 12 × 7.25 — the total it would sum to
  });
});

describe('the tenancy and the scope', () => {
  it('asks only for this company and this store', async () => {
    await GET(req('top'));
    const where = db.product.findMany.mock.calls[0][0].where;
    expect(where.companyId).toBe('c1');
    expect(where.storeId).toBe('s1');
    expect(where.id).toEqual({ in: ['top'] });
  });

  it('narrows a SPECIFIC grant to the intersection, never to what was asked', async () => {
    getPermissionScope.mockReturnValue({ scope: 'SPECIFIC', scopeIds: ['ready'] });
    await GET(req('top,ready'));
    expect(db.product.findMany.mock.calls[0][0].where.id).toEqual({ in: ['ready'] });
  });

  it('applies a CATEGORY grant as the list does', async () => {
    getPermissionScope.mockReturnValue({ scope: 'CATEGORY', scopeIds: ['cat'] });
    await GET(req('top'));
    expect(db.product.findMany.mock.calls[0][0].where.categoryId).toEqual({ in: ['cat'] });
  });

  it('scopes the order lines to the same store and bounds them by the window', async () => {
    await GET(req('top'));
    const where = db.orderItem.findMany.mock.calls[0][0].where;
    expect(where.order.companyId).toBe('c1');
    expect(where.order.storeId).toBe('s1');
    expect(where.order.createdAt.gte).toBeInstanceOf(Date);
    expect(where.order.createdAt.lte).toBeInstanceOf(Date);
  });

  it('caps the id list rather than accepting a query string of any length', async () => {
    await GET(req(Array.from({ length: 400 }, (_, i) => `p${i}`).join(',')));
    expect(db.product.findMany.mock.calls[0][0].where.id.in).toHaveLength(200);
  });
});

describe('the figures', () => {
  it('counts delivered out of confirmed, and returns and refusals as facts beside it', async () => {
    db.product.findMany.mockResolvedValue([TOP]);
    db.orderItem.findMany.mockResolvedValue([
      ...deliveredLines('top', 10),
      { productId: 'top', lineTotal: 20, orderId: 'r1', order: order({ shippingStatus: 'RETURNED' }) },
      { productId: 'top', lineTotal: 20, orderId: 'x1', order: order({ confirmationStatus: 'REJECTED', shippingStatus: 'NOT_READY' }) },
    ]);
    const body = await (await GET(req('top'))).json();
    const sales = body.grades[0].sales;
    expect(sales.confirmed).toBe(11);
    expect(sales.delivered).toBe(10);
    expect(sales.returned).toBe(1);
    expect(sales.refused).toBe(1);
    const band = body.grades[0].score.bands.find((b: { key: string }) => b.key === 'delivery_rate');
    expect(band.value).toBe(91); // 10 of 11
  });

  it('takes the collected amount over the order total where the door recorded one', async () => {
    db.orderItem.findMany.mockResolvedValue(deliveredLines('top', 10, 20, { collectedAmount: 15 }));
    const body = await (await GET(req('top'))).json();
    expect(body.grades[0].sales.deliveredRevenue).toBe(150);
  });

  it('splits a multi-line order by each line’s share, not whole to one product', async () => {
    db.product.findMany.mockResolvedValue([TOP]);
    const shared = Array.from({ length: 10 }, (_, i) => [
      { productId: 'top', lineTotal: 30, orderId: `s${i}`, order: order({ totalAmount: 100 }) },
      { productId: 'other', lineTotal: 70, orderId: `s${i}`, order: order({ totalAmount: 100 }) },
    ]).flat();
    db.orderItem.findMany.mockResolvedValue(shared);
    const body = await (await GET(req('top'))).json();
    // 30 of every 100, ten times — not 1000.
    expect(body.grades[0].sales.deliveredRevenue).toBe(300);
  });

  it('reads the value band against the best product in the SHOP, not the best on the page', async () => {
    db.product.findMany.mockResolvedValue([TOP]);
    db.orderItem.findMany.mockResolvedValue([
      ...deliveredLines('top', 10, 20),
      // A product nobody asked about, worth twice as much per delivered order.
      ...deliveredLines('unasked', 10, 40),
    ]);
    const body = await (await GET(req('top'))).json();
    const band = body.grades[0].score.bands.find((b: { key: string }) => b.key === 'delivered_value');
    expect(band.reference).toBe(40);
    expect(band.points).toBe(10); // 20 of 40 → half of the twenty-point band
  });

  it('does not let a two-order fluke set the ceiling of the money band', async () => {
    db.product.findMany.mockResolvedValue([TOP]);
    db.orderItem.findMany.mockResolvedValue([
      ...deliveredLines('top', 10, 20),
      // The measured case: the shop's highest delivered order, 50.01, sits on
      // a product with two of them.
      ...deliveredLines('fluke', 2, 50),
    ]);
    const body = await (await GET(req('top'))).json();
    const band = body.grades[0].score.bands.find((b: { key: string }) => b.key === 'delivered_value');
    // The ceiling is the best product that itself clears the floor — here
    // the asked one — and not the fluke's 50.
    expect(band.reference).toBe(20);
    expect(band.points).toBe(20);
  });

  it('grades nothing when the sample is under the floor, and says which floor', async () => {
    db.orderItem.findMany.mockResolvedValue(deliveredLines('top', 9));
    const body = await (await GET(req('top'))).json();
    expect(body.grades[0].state).toBe('THIN_SAMPLE');
    expect(body.grades[0].score).toBeNull();
    expect(body.minSample).toBe(10);
  });

  it('says «never ordered» for a product with no line at all', async () => {
    db.product.findMany.mockResolvedValue([READY]);
    db.orderItem.findMany.mockResolvedValue(deliveredLines('top', 12));
    const body = await (await GET(req('ready'))).json();
    expect(body.grades[0].state).toBe('NEVER_ORDERED');
    expect(body.readiness.neverOrdered).toBe(1);
  });

  it('puts the graded rows first and counts the whole page in one sentence', async () => {
    db.product.findMany.mockResolvedValue([READY, TOP]);
    db.orderItem.findMany.mockResolvedValue(deliveredLines('top', 12));
    const body = await (await GET(req('ready,top'))).json();
    expect(body.grades.map((g: { productId: string }) => g.productId)).toEqual(['top', 'ready']);
    expect(body.readiness.total).toBe(2);
    expect(body.readiness.graded).toBe(1);
    expect(body.readiness.why).toContain('1 له درجة');
  });
});
