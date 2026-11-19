import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db, requireContext, requirePermission, logAudit } = vi.hoisted(() => ({
  db: {
    // 19/11 (W1a): `findMany` added — the correction now asks which rows were split from the run (to give them its cost);
    // answering «none», as for every run never split, keeps each test below exactly what it was.
    productionBatch: { findFirst: vi.fn(), update: vi.fn(), findMany: vi.fn(async () => []), updateMany: vi.fn() },
    productionBatchCost: { deleteMany: vi.fn(), createMany: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));

import { PATCH } from './[id]/route';

/**
 * Correcting what a run cost.
 *
 * Most of this company's stock was entered at a cost of zero, so every
 * profit figure was gross wearing the word "صافي". The correction path
 * below is the only way to fix that, which makes it worth being careful
 * about: it moves historical margin.
 */

const BATCH = {
  id: 'b1',
  companyId: 'c1',
  batchNumber: 'SEED-1',
  quantityProduced: 500,
  quantitySold: 104,
  manufacturingCost: 0,
  packagingCost: 0,
  rawMaterialCost: 0,
  otherCosts: 0,
  totalProductionCost: 0,
  costPerUnit: 0,
  costLines: [],
};

const patch = (body: unknown) =>
  PATCH(
    new Request('http://localhost/api/production/b1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'b1' }) }
  );

beforeEach(() => {
  vi.clearAllMocks();
  // A caller always stands in a store: requireContext refuses to return
  // without one, which is what lets the route rely on it.
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1' });
  requirePermission.mockResolvedValue({ companyId: 'c1' });
  db.productionBatch.findFirst.mockResolvedValue({ ...BATCH });
  db.productionBatch.update.mockImplementation(async (args: never) => (args as { data: unknown }).data);
  db.$transaction.mockImplementation(async (fn: never) => (fn as (tx: unknown) => unknown)(db));
});

describe('correcting a batch cost', () => {
  it('spreads the total over what was produced, not what was sold', async () => {
    // 3500 over 500 units is 7 each. Dividing by the 104 already sold would
    // price the remaining stock at nearly five times its cost.
    const res = await patch({ rawMaterialCost: 3500 });
    expect(res.status).toBe(200);
    const data = db.productionBatch.update.mock.calls[0][0].data;
    expect(data.totalProductionCost).toBe(3500);
    expect(data.costPerUnit).toBe(7);
  });

  it('adds the named lines to the four buckets', async () => {
    await patch({
      manufacturingCost: 1000,
      costLines: [
        { label: 'قالب', amount: 400 },
        { label: 'أجرة عامل', amount: 600 },
      ],
    });
    expect(db.productionBatch.update.mock.calls[0][0].data.totalProductionCost).toBe(2000);
  });

  it('replaces the named lines as a set, so removing one is leaving it out', async () => {
    db.productionBatch.findFirst.mockResolvedValue({
      ...BATCH,
      costLines: [{ label: 'قديم', amount: 999 }],
    });
    await patch({ costLines: [{ label: 'قالب', amount: 100 }] });
    expect(db.productionBatchCost.deleteMany).toHaveBeenCalledWith({ where: { batchId: 'b1' } });
    expect(db.productionBatchCost.createMany.mock.calls[0][0].data).toHaveLength(1);
    expect(db.productionBatch.update.mock.calls[0][0].data.totalProductionCost).toBe(100);
  });

  it('keeps the lines it was not asked about', async () => {
    db.productionBatch.findFirst.mockResolvedValue({
      ...BATCH,
      costLines: [{ label: 'قالب', amount: 250 }],
    });
    await patch({ manufacturingCost: 750 });
    expect(db.productionBatchCost.deleteMany).not.toHaveBeenCalled();
    expect(db.productionBatch.update.mock.calls[0][0].data.totalProductionCost).toBe(1000);
  });

  it('never touches the quantity', async () => {
    // Produced, sold and remaining belong to the stock ledger. A quantity
    // changed here would silently break the identity every movement adds up
    // to.
    await patch({ rawMaterialCost: 500, quantityProduced: 9999, quantitySold: 0 });
    const data = db.productionBatch.update.mock.calls[0][0].data;
    expect(data.quantityProduced).toBeUndefined();
    expect(data.quantitySold).toBeUndefined();
    expect(data.quantityRemaining).toBeUndefined();
  });

  it('records what the cost was before and after', async () => {
    // The thing somebody needs to explain a month from now.
    await patch({ rawMaterialCost: 3500, reason: 'كلفة المواد لم تُدخل عند الإنشاء' });
    const call = logAudit.mock.calls[0][0];
    expect(call.action).toBe('PRODUCTION_BATCH_COST_CORRECTED');
    expect(call.previousData.costPerUnit).toBe(0);
    expect(call.newData.costPerUnit).toBe(7);
    expect(call.newData.reason).toContain('لم تُدخل');
  });
});

describe('what it refuses', () => {
  it('refuses anyone without production.manage', async () => {
    requirePermission.mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }));
    const res = await patch({ rawMaterialCost: 100 });
    expect(res.status).toBe(403);
    expect(db.productionBatch.update).not.toHaveBeenCalled();
  });

  it('refuses a batch belonging to another company', async () => {
    db.productionBatch.findFirst.mockResolvedValue(null);
    const res = await patch({ rawMaterialCost: 100 });
    expect(res.status).toBe(404);
    expect(db.productionBatch.findFirst.mock.calls[0][0].where.companyId).toBe('c1');
  });

  it('refuses a negative cost', async () => {
    const res = await patch({ rawMaterialCost: -50 });
    expect(res.status).toBe(400);
    expect(db.productionBatch.update).not.toHaveBeenCalled();
  });

  it('refuses a nameless cost line', async () => {
    const res = await patch({ costLines: [{ label: '  ', amount: 100 }] });
    expect(res.status).toBe(400);
  });
});

/**
 * AND THE STORE, WHICH THE COMPANY CHECK NEVER COVERED.
 *
 * The company boundary held everywhere; the store boundary had holes, and a
 * production batch was one. `{ companyId }` returns MORE rows when the
 * store is forgotten, so it throws nothing and renders fine — which is the
 * whole reason these assert the refusal rather than the success.
 */
describe('a batch belongs to a store', () => {
  it('names the caller’s store when looking one up', async () => {
    db.productionBatch.findFirst.mockResolvedValue(null);
    await patch({ rawMaterialCost: 100 });
    const where = db.productionBatch.findFirst.mock.calls.at(-1)![0].where;
    expect(where).toMatchObject({ companyId: 'c1', storeId: 's1' });
  });

  it('cannot reach a batch of another store', async () => {
    // It exists; it is simply not one this caller can name. So the lookup
    // finds nothing and the route answers "not found" rather than
    // rewriting another store's costs.
    db.productionBatch.findFirst.mockResolvedValue(null);
    const res = await patch({ rawMaterialCost: 100 });
    expect(res.status).toBe(404);
    expect(db.productionBatch.update).not.toHaveBeenCalled();
  });

  it('matches nothing when no store is selected', async () => {
    requireContext.mockResolvedValueOnce({ user: { id: 'u1' }, companyId: 'c1', storeId: null });
    db.productionBatch.findFirst.mockResolvedValue(null);
    await patch({ rawMaterialCost: 100 });
    const where = db.productionBatch.findFirst.mock.calls.at(-1)![0].where;
    // An impossible clause, never a company-wide one.
    expect(where.id).toEqual({ in: [] });
    expect(where.storeId).toBeUndefined();
  });
});
