import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE DOOR THAT SETS A PRODUCT'S FIXED COST (the owner, 1/11)
 *
 * «سعر تكلفة المنتج يكون ثابت ولا يتغير ابدا… ثابت لكل الطلبات… اللي بيقدر يغيرو الادمنة فقط من قائمة المنتجات.»
 *
 *  1. `PUT /api/products/[id]/fixed-cost { amount }` sets or replaces the one figure of a product (one row, upsert); `null` clears
 *     it; zero is a figure; four decimals; never negative; bounded.
 *  2. ONLY WHO MAY: `products.change_cost` evaluated against the product, AND the cost key (a person who may not see what things
 *     cost may not set it). Neither → refused with its own sentence, before anything is read or written.
 *  3. A product of another store or company is not found (the same store filter every product door uses).
 *  4. Every change leaves an audit row with the figure before and after (+ the reason); the same figure again writes nothing.
 *  5. It changes no order, no batch, no stock: the only writes are to `product_fixed_costs`.
 *
 * Blockers: no money formula changes here; no migration beyond the additive table (its own test); no customer data.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, authorize, maySeeCost, logAudit } = vi.hoisted(() => ({
  db: {
    product: { findFirst: vi.fn() },
    productFixedCost: { upsert: vi.fn(), deleteMany: vi.fn() },
  },
  requireContext: vi.fn(),
  authorize: vi.fn(),
  maySeeCost: vi.fn(),
  logAudit: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ authorize: (...a: unknown[]) => authorize(...a) }));
vi.mock('@/lib/cost-visibility', () => ({ maySeeCost: (...a: unknown[]) => maySeeCost(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/api-error', () => ({
  apiErrorResponse: (e: unknown) => Response.json({ error: `UNEXPECTED: ${(e as Error)?.message}` }, { status: 500 }),
}));

import { PUT } from './route';

const USER = { id: 'u1', role: 'COMPANY_ADMIN' };
const PRODUCT = { id: 'p1', companyId: 'c1', storeId: 's1', categoryId: 'cat1', name: 'كريم حرير', fixedCost: null as { amount: number } | null };

const put = (b: unknown) =>
  PUT(new Request('http://localhost/api/products/p1/fixed-cost', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }), {
    params: Promise.resolve({ id: 'p1' }),
  });
const given = (fixed: number | null) => db.product.findFirst.mockResolvedValue({ ...PRODUCT, fixedCost: fixed === null ? null : { amount: fixed } });

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: USER, companyId: 'c1', storeId: 's1' });
  maySeeCost.mockReturnValue(true);
  authorize.mockReturnValue({ allowed: true });
  given(null);
  db.productFixedCost.upsert.mockResolvedValue({});
  db.productFixedCost.deleteMany.mockResolvedValue({ count: 1 });
  logAudit.mockResolvedValue(undefined);
});

function expectNothingWritten() {
  expect(db.productFixedCost.upsert).not.toHaveBeenCalled();
  expect(db.productFixedCost.deleteMany).not.toHaveBeenCalled();
  expect(logAudit).not.toHaveBeenCalled();
}

describe('setting the figure', () => {
  it('a product with none gets one row, with who set it, and an audit row with the before (none) and the after', async () => {
    const res = await put({ amount: 4.5, reason: 'سعر المورّد الجديد' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fixedCost: 4.5, previous: null });
    expect(db.productFixedCost.upsert).toHaveBeenCalledWith({
      where: { productId: 'p1' },
      create: { companyId: 'c1', productId: 'p1', amount: 4.5, setById: 'u1' },
      update: { amount: 4.5, setById: 'u1' },
    });
    expect(logAudit.mock.calls[0][0]).toMatchObject({
      companyId: 'c1', userId: 'u1', action: 'PRODUCT_FIXED_COST_SET', entity: 'Product', entityId: 'p1',
      previousData: { fixedCost: null }, newData: { fixedCost: 4.5, reason: 'سعر المورّد الجديد' },
    });
  });

  it('replacing one figure by another keeps the old one in the audit row', async () => {
    given(4.5);
    const out = await (await put({ amount: 6 })).json();
    expect(out).toEqual({ fixedCost: 6, previous: 4.5 });
    expect(logAudit.mock.calls[0][0]).toMatchObject({ previousData: { fixedCost: 4.5 }, newData: { fixedCost: 6 } });
    expect(logAudit.mock.calls[0][0].newData).not.toHaveProperty('reason');
  });

  it('ZERO is a figure: stored as zero, not read as "none"', async () => {
    const out = await (await put({ amount: 0 })).json();
    expect(out.fixedCost).toBe(0);
    expect(db.productFixedCost.upsert.mock.calls[0][0].create.amount).toBe(0);
    expect(db.productFixedCost.deleteMany).not.toHaveBeenCalled();
  });

  it('four decimals, and a figure written as text by a form is read as the number it spells', async () => {
    await put({ amount: 1.23456 });
    expect(db.productFixedCost.upsert.mock.calls[0][0].create.amount).toBe(1.2346);
    vi.clearAllMocks();
    requireContext.mockResolvedValue({ user: USER, companyId: 'c1', storeId: 's1' });
    maySeeCost.mockReturnValue(true);
    authorize.mockReturnValue({ allowed: true });
    given(null);
    await put({ amount: '7.5' });
    expect(db.productFixedCost.upsert.mock.calls[0][0].create.amount).toBe(7.5);
  });

  it('the same figure again is "unchanged": nothing written, no audit row', async () => {
    given(4.5);
    const out = await (await put({ amount: 4.5 })).json();
    expect(out).toEqual({ fixedCost: 4.5, unchanged: true });
    expectNothingWritten();
    // …and so is clearing a product that has none
    given(null);
    expect(await (await put({ amount: null })).json()).toEqual({ fixedCost: null, unchanged: true });
    expectNothingWritten();
  });
});

describe('clearing the figure', () => {
  it('null removes the row — the product costs what its batches say again — and the audit row keeps the figure it had', async () => {
    given(4.5);
    const out = await (await put({ amount: null })).json();
    expect(out).toEqual({ fixedCost: null, previous: 4.5 });
    expect(db.productFixedCost.deleteMany).toHaveBeenCalledWith({ where: { productId: 'p1', companyId: 'c1' } });
    expect(db.productFixedCost.upsert).not.toHaveBeenCalled();
    expect(logAudit.mock.calls[0][0]).toMatchObject({ previousData: { fixedCost: 4.5 }, newData: { fixedCost: null } });
  });
});

describe('who', () => {
  it('NEGATIVE: somebody who may not see what things cost is refused before the product is read', async () => {
    maySeeCost.mockReturnValue(false);
    const res = await put({ amount: 4 });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('COST_FORBIDDEN');
    expect(db.product.findFirst).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it('NEGATIVE: somebody who may see cost but does not hold the key is refused, with her own sentence, and nothing is written', async () => {
    authorize.mockReturnValue({ allowed: false });
    const res = await put({ amount: 4 });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('COST_CHANGE_FORBIDDEN');
    expect(authorize.mock.calls[0][1]).toBe('products.change_cost');
    expectNothingWritten();
  });

  it('the key is evaluated against THE PRODUCT (a scoped grant reads its category/store), not only as a bare key', async () => {
    await put({ amount: 4 });
    expect(authorize.mock.calls[0][0]).toBe(USER);
    expect(authorize.mock.calls[0][2]).toMatchObject({ id: 'p1', categoryId: 'cat1', storeId: 's1' });
  });

  it('NEGATIVE: a product of another store, or another company, is not found', async () => {
    db.product.findFirst.mockResolvedValue(null);
    const res = await put({ amount: 4 });
    expect(res.status).toBe(404);
    expect(db.product.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'p1', companyId: 'c1' });
    expectNothingWritten();

    db.product.findFirst.mockResolvedValue({ ...PRODUCT, companyId: 'c-other' });
    expect((await put({ amount: 4 })).status).toBe(404);
    expectNothingWritten();
  });
});

describe('what is refused as a figure', () => {
  const refused = async (b: unknown) => {
    vi.clearAllMocks();
    requireContext.mockResolvedValue({ user: USER, companyId: 'c1', storeId: 's1' });
    maySeeCost.mockReturnValue(true);
    authorize.mockReturnValue({ allowed: true });
    given(null);
    const res = await put(b);
    expect(res.status, JSON.stringify(b)).toBe(400);
    expectNothingWritten();
  };

  it('NEGATIVE: negative, text, empty, missing, not a number, or absurd — a 400, and nothing written', async () => {
    await refused({ amount: -1 });
    await refused({ amount: 'abc' });
    await refused({ amount: '' });
    await refused({});
    await refused({ amount: true });
    await refused({ amount: {} });
    await refused({ amount: 1e12 });
    await refused({ amount: 4, reason: 'x'.repeat(201) });
    await refused(null);
  });
});
