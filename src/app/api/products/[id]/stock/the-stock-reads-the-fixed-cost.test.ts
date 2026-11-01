import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * GET /api/products/[id]/stock — WHAT THE PRODUCT COSTS WHEN AN ADMIN FIXED IT (the owner, 1/11)
 *
 * «سعر تكلفة المنتج يكون ثابت ولا يتغير ابدا… اللي بيقدر يغيرو الادمنة فقط من قائمة المنتجات.»
 *
 *  · no figure → exactly what the batches say, as it always answered (and `fixedCost: null`, so the screen can say which it is);
 *  · a figure → the unit cost, the cost of the next unit out and the value of the stock (on hand × the figure) ARE it; the batches'
 *    average rides beside it so an admin sets one from the other;
 *  · the shelf is never the figure's: on hand, reserved, available and the batch count are the same with and without;
 *  · ZERO is a figure, not "none";
 *  · a caller who may not see what goods cost gets no cost field of any kind — and the figures are not even read for them.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, requirePermission, maySeeCost, productCost, reservedElsewhere } = vi.hoisted(() => ({
  db: {
    product: { findFirst: vi.fn() },
    productFixedCost: { findMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []) },
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  maySeeCost: vi.fn(),
  productCost: vi.fn(),
  reservedElsewhere: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/cost-visibility', () => ({ maySeeCost: (...a: unknown[]) => maySeeCost(...a) }));
vi.mock('@/lib/product-cost', () => ({ productCost: (...a: unknown[]) => productCost(...a) }));
vi.mock('@/lib/reservation', () => ({ reservedElsewhere: (...a: unknown[]) => reservedElsewhere(...a) }));

import { GET } from './route';

const CTX = { user: { id: 'u1', role: 'COMPANY_ADMIN' }, companyId: 'c1', storeId: 's1', country: { currencyCode: 'JOD' } };
/** 10 on hand across two batches, 3.5 on average, the next unit out costs 3. */
const BATCHES = { onHand: 10, average: 3.5, nextOut: 3, stockValue: 35, batchCount: 2 };

const ask = async (id = 'p1') => {
  const res = await GET(new Request('http://localhost/api/products/p1/stock'), { params: Promise.resolve({ id }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue(CTX);
  requirePermission.mockResolvedValue(undefined);
  maySeeCost.mockReturnValue(true);
  db.product.findFirst.mockResolvedValue({ id: 'p1', sourceType: 'PURCHASED' });
  db.productFixedCost.findMany.mockResolvedValue([]);
  productCost.mockResolvedValue(BATCHES);
  reservedElsewhere.mockResolvedValue(4);
});

describe('a product with no fixed figure', () => {
  it('answers exactly what the batches say — and says there is no fixed figure, with the batches’ average beside it', async () => {
    const { status, body } = await ask();
    expect(status).toBe(200);
    expect(body).toMatchObject({
      averageCost: 3.5, nextOutCost: 3, stockValue: 35,
      fixedCost: null, batchAverageCost: 3.5,
    });
  });
});

describe('a product with a fixed figure', () => {
  beforeEach(() => db.productFixedCost.findMany.mockResolvedValue([{ productId: 'p1', amount: 5 }]));

  it('the unit cost, the cost of the next unit out and the value of the stock ARE the figure (10 × 5)', async () => {
    const { body } = await ask();
    expect(body).toMatchObject({ averageCost: 5, nextOutCost: 5, stockValue: 50, fixedCost: 5 });
  });

  it('the batches’ own average rides beside it, so an admin can set one from the other', async () => {
    const { body } = await ask();
    expect(body.batchAverageCost).toBe(3.5);
  });

  it('the shelf is never the figure’s: on hand, reserved, available, batch count and the rest are what they were', async () => {
    const withFigure = (await ask()).body;
    db.productFixedCost.findMany.mockResolvedValue([]);
    const without = (await ask()).body;
    for (const key of ['onHand', 'reserved', 'available', 'batchCount', 'currencyCode', 'sourceType']) {
      expect(withFigure[key], key).toEqual(without[key]);
    }
    expect(withFigure).toMatchObject({ onHand: 10, reserved: 4, available: 6, batchCount: 2, currencyCode: 'JOD', sourceType: 'PURCHASED' });
  });

  it('new stock at another price moves the shelf and not the cost', async () => {
    productCost.mockResolvedValue({ onHand: 30, average: 9, nextOut: 9, stockValue: 270, batchCount: 3 });
    const { body } = await ask();
    expect(body).toMatchObject({ averageCost: 5, nextOutCost: 5, stockValue: 150, onHand: 30, batchAverageCost: 9 });
  });

  it('ZERO is a figure — a free sample costs nothing, and that is not "no figure"', async () => {
    db.productFixedCost.findMany.mockResolvedValue([{ productId: 'p1', amount: 0 }]);
    const { body } = await ask();
    expect(body).toMatchObject({ averageCost: 0, nextOutCost: 0, stockValue: 0, fixedCost: 0 });
  });

  it('is read for THIS company and THIS product, once', async () => {
    await ask();
    expect(db.productFixedCost.findMany).toHaveBeenCalledTimes(1);
    const args = db.productFixedCost.findMany.mock.calls[0][0] as { where: unknown };
    expect(args.where).toEqual({ companyId: 'c1', productId: { in: ['p1'] } });
  });
});

describe('somebody who may not see what goods cost', () => {
  beforeEach(() => {
    maySeeCost.mockReturnValue(false);
    db.productFixedCost.findMany.mockResolvedValue([{ productId: 'p1', amount: 5 }]);
  });

  it('gets the quantities and not one cost field — omitted, not zeroed', async () => {
    const { status, body } = await ask();
    expect(status).toBe(200);
    expect(body).toMatchObject({ onHand: 10, reserved: 4, available: 6, batchCount: 2 });
    for (const key of ['averageCost', 'nextOutCost', 'stockValue', 'fixedCost', 'batchAverageCost']) {
      expect(key in body, key).toBe(false);
    }
    expect(JSON.stringify(body)).not.toContain('50');
  });

  it('and the figures are not even read for them', async () => {
    await ask();
    expect(db.productFixedCost.findMany).not.toHaveBeenCalled();
  });

  it('and cost is judged for THIS caller', async () => {
    await ask();
    expect(maySeeCost).toHaveBeenCalledWith(CTX.user);
  });
});

describe('the door itself', () => {
  it('asks the stock key first', async () => {
    await ask();
    expect(requirePermission).toHaveBeenCalledWith('inventory.view');
  });

  it('an unknown product is a 404 and nothing about cost is read', async () => {
    db.product.findFirst.mockResolvedValue(null);
    const { status } = await ask('nope');
    expect(status).toBe(404);
    expect(productCost).not.toHaveBeenCalled();
    expect(db.productFixedCost.findMany).not.toHaveBeenCalled();
  });
});
