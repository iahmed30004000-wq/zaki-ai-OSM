import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE COST FIX AND THE ROWS SPLIT FROM A RUN (the warehouse plan, request W1a).
 *
 * When some of a run's units change place, a twin row holds them at the run's unit cost (`batch-split.ts`). So:
 *   - correcting the RUN gives every row split from it — at any depth — the corrected unit cost: the stock value after a
 *     correction is the same number whether the store was placed or not;
 *   - correcting a TWIN is refused: it produced nothing, and «total ÷ produced» on it is no price at all.
 * And a run that was never split — every run of a store that is not placed — is corrected EXACTLY as on `osm/main`: the
 * frozen golden file beside this test holds what the main branch's door answered and wrote for 300 random corrections,
 * and this door must answer and write the same.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- recorded call arguments, compared whole
type Row = Record<string, any>;

const { db, requireContext, requirePermission, logAudit } = vi.hoisted(() => ({
  db: {
    productionBatch: { findFirst: vi.fn(), update: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
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

let rows: Row[] = [];

const patch = (id: string, body: unknown) =>
  PATCH(new Request(`http://localhost/api/production/${id}`, { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1' });
  requirePermission.mockResolvedValue({ companyId: 'c1' });
  db.productionBatch.findFirst.mockImplementation(async ({ where }: Row) => {
    const r = rows.find((x) => x.id === where.id && x.companyId === where.companyId && x.storeId === where.storeId);
    return r ? { ...r, costLines: [] } : null;
  });
  db.productionBatch.findMany.mockImplementation(async ({ where }: Row) =>
    rows.filter((x) => x.companyId === where.companyId && where.splitFromBatchId.in.includes(x.splitFromBatchId)).map((x) => ({ id: x.id }))
  );
  db.productionBatch.updateMany.mockImplementation(async ({ where, data }: Row) => {
    const hit = rows.filter((x) => x.companyId === where.companyId && where.id.in.includes(x.id));
    for (const r of hit) Object.assign(r, data);
    return { count: hit.length };
  });
  db.productionBatch.update.mockImplementation(async ({ where, data }: Row) => {
    const r = rows.find((x) => x.id === where.id)!;
    Object.assign(r, data);
    return { ...r };
  });
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
});

const run = (id: string, over: Row = {}): Row => ({
  id,
  companyId: 'c1',
  storeId: 's1',
  batchNumber: `RUN-${id}`,
  quantityProduced: 100,
  quantitySold: 40,
  quantityRemaining: 60,
  manufacturingCost: 0,
  packagingCost: 0,
  rawMaterialCost: 0,
  otherCosts: 0,
  totalProductionCost: 0,
  costPerUnit: 0,
  splitFromBatchId: null,
  ...over,
});

describe('a split row and its run', () => {
  it('correcting the run reaches every row split from it, at any depth — and the stock value is what it would be unsplit', async () => {
    rows = [
      run('b1', { quantityRemaining: 30, quantityMovedOut: 30 }),
      run('t1', { quantityProduced: 0, quantitySold: 0, quantityRemaining: 20, splitFromBatchId: 'b1' }),
      run('t2', { quantityProduced: 0, quantitySold: 0, quantityRemaining: 10, splitFromBatchId: 't1' }),
      run('other', { costPerUnit: 9 }),
    ];
    const res = await patch('b1', { rawMaterialCost: 350 });
    expect(res.status).toBe(200);
    expect(rows.map((r) => [r.id, r.costPerUnit])).toEqual([['b1', 3.5], ['t1', 3.5], ['t2', 3.5], ['other', 9]]);
    const value = rows.filter((r) => r.id !== 'other').reduce((s, r) => s + r.quantityRemaining * r.costPerUnit, 0);
    expect(value).toBe(60 * 3.5);
    // The twins' own totals stay zero: a report that adds what runs cost does not add this run three times.
    expect(rows.filter((r) => r.splitFromBatchId).map((r) => r.totalProductionCost)).toEqual([0, 0]);
  });

  it('NEGATIVE: correcting a twin is refused in Arabic, and nothing is written', async () => {
    rows = [run('b1'), run('t1', { quantityProduced: 0, splitFromBatchId: 'b1' })];
    const res = await patch('t1', { rawMaterialCost: 350 });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('SPLIT_ROW');
    expect(body.errorAr).toMatch(/الدفعة الأصلية/);
    expect(db.productionBatch.update).not.toHaveBeenCalled();
    expect(db.productionBatch.updateMany).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a run never split writes nothing to any other row', async () => {
    rows = [run('b1'), run('b2', { costPerUnit: 4 })];
    await patch('b1', { manufacturingCost: 100 });
    expect(db.productionBatch.updateMany).not.toHaveBeenCalled();
    expect(rows[1].costPerUnit).toBe(4);
  });
});

/* ───────────── the differential against osm/main ───────────── */

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 300 random corrections of runs never split — the batch, the body, and whether the batch is found at all. */
function scenarios() {
  const r = rng(20261119);
  const money = () => (r() < 0.2 ? 0 : Math.round(r() * 1_000_000) / 100);
  const out: { batch: Row | null; body: Row }[] = [];
  for (let i = 0; i < 300; i++) {
    const produced = r() < 0.1 ? 0 : Math.floor(r() * 2000);
    const batch = r() < 0.05 ? null : {
      id: 'b1',
      companyId: 'c1',
      storeId: 's1',
      batchNumber: `RUN-${i}`,
      quantityProduced: produced,
      quantitySold: Math.floor(r() * (produced + 1)),
      manufacturingCost: money(),
      packagingCost: money(),
      rawMaterialCost: money(),
      otherCosts: money(),
      totalProductionCost: money(),
      costPerUnit: money(),
      splitFromBatchId: null,
      costLines: r() < 0.5 ? [] : [{ label: 'قالب', amount: money() }],
    };
    const body: Row = {};
    for (const k of ['manufacturingCost', 'packagingCost', 'rawMaterialCost', 'otherCosts']) if (r() < 0.4) body[k] = r() < 0.05 ? -1 : money();
    if (r() < 0.3) body.costLines = Array.from({ length: Math.floor(r() * 3) }, (_, j) => ({ label: `بند ${j}`, amount: money() }));
    if (r() < 0.3) body.reason = 'تصحيح';
    out.push({ batch, body });
  }
  return out;
}

/** What the door answered and every write it asked for — the facts the golden file freezes. */
async function record(patchFn: typeof PATCH) {
  const results: Row[] = [];
  for (const s of scenarios()) {
    vi.clearAllMocks();
    db.productionBatch.findFirst.mockResolvedValue(s.batch ? structuredClone(s.batch) : null);
    db.productionBatch.findMany.mockResolvedValue([]);
    db.productionBatch.update.mockImplementation(async (args: Row) => args.data);
    const res = await patchFn(new Request('http://localhost/api/production/b1', { method: 'PATCH', body: JSON.stringify(s.body) }), { params: Promise.resolve({ id: 'b1' }) });
    results.push({
      status: res.status,
      body: await res.json(),
      update: db.productionBatch.update.mock.calls,
      updateMany: db.productionBatch.updateMany.mock.calls,
      deleteMany: db.productionBatchCost.deleteMany.mock.calls,
      createMany: db.productionBatchCost.createMany.mock.calls,
      audit: logAudit.mock.calls,
    });
  }
  return JSON.parse(JSON.stringify(results));
}

describe('a run never split is corrected exactly as on osm/main (differential, frozen golden)', () => {
  it('300 random corrections: the same answers and the same writes', async () => {
    const golden = JSON.parse(readFileSync(join(__dirname, 'cost-fix.main-golden.json'), 'utf8'));
    const now = await record(PATCH);
    expect(golden).toHaveLength(300);
    expect(golden.filter((g: Row) => g.status === 200).length).toBeGreaterThan(150);
    expect(now).toEqual(golden);
  });
});
