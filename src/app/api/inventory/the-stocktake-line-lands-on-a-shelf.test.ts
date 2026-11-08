import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A STOCKTAKE THAT MOVES THIS STORE'S BATCHES AND IS RECORDED IN NO STORE.
 *
 * `POST /api/inventory` with `action: 'recount'` does two things in one
 * transaction: it moves units — `receiveStock` for a surplus, `drawDownStock`
 * for a shortfall, both handed `storeId`, the latter under a comment saying
 * why — and then writes ONE `InventoryMovement` summarising the correction.
 * That summary row carried no `storeId`.
 *
 * `/api/inventory/movements` and the ledger block in `/api/inventory` filter
 * the movement itself with `inStore(companyId, storeId)`, which is an EXACT
 * match (`src/lib/store-filter.ts`). So the correction was applied to the
 * store's shelf and then reported in no store's ledger: the counted number
 * and the system number were reconciled, and the record of the reconciliation
 * could not be read back by anybody. The reason string this door insists on —
 * «Why the shelf and the system disagree. Never optional.» — went into a row
 * no screen returns.
 *
 * WHERE THE STORE COMES FROM, AND WHY THERE IS ONLY ONE CANDIDATE:
 * `requireContext()` throws `STORE_REQUIRED` rather than returning a null
 * store, and the product was fetched one query earlier with this same
 * `inStore(companyId, storeId)` — an exact match on `Product.storeId`. So any
 * product this door accepts has exactly this store, and «the store the
 * counter is standing in» and «the product's own store» are one proven value.
 *
 * ASSERTED BY VALUE, and against the real read filter. A test that looked for
 * the word `storeId` in this file is the kind that let the defect ship.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, requirePermission, logAudit, receiveStock, drawDownStock, onHandTotal, reservedElsewhere } =
  vi.hoisted(() => ({
    db: {
      product: { findFirst: vi.fn() },
      productionBatch: { findFirst: vi.fn() },
      inventoryMovement: { create: vi.fn() },
      $transaction: vi.fn(),
    },
    requireContext: vi.fn(),
    requirePermission: vi.fn(),
    logAudit: vi.fn(),
    receiveStock: vi.fn(),
    drawDownStock: vi.fn(),
    onHandTotal: vi.fn(),
    reservedElsewhere: vi.fn(),
  }));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/reservation', () => ({ reservedElsewhere: (...a: unknown[]) => reservedElsewhere(...a) }));
vi.mock('@/lib/receiving', () => ({
  receiveStock: (...a: unknown[]) => receiveStock(...a),
  drawDownStock: (...a: unknown[]) => drawDownStock(...a),
  onHandTotal: (...a: unknown[]) => onHandTotal(...a),
}));

import { POST } from './route';
/** The real filter the ledger screens use — not a restatement of it. */
import { inStore } from '@/lib/store-filter';

const PRODUCT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const MUBARAK = 's-mubarak';
const SIHHA = 's-sihha';

const recount = (body: Record<string, unknown>) =>
  POST(
    new Request('http://localhost/api/inventory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'recount', productId: PRODUCT, reason: 'جرد ربع سنوي', ...body }),
    })
  );

/** The summary row exactly as it reached Prisma. */
const summary = () => db.inventoryMovement.create.mock.calls[0][0].data as Record<string, unknown>;

/** `inStore`'s own shapes, applied for real rather than described. */
function matchesWhere(row: Record<string, unknown>, where: Record<string, any>): boolean {
  for (const [key, want] of Object.entries(where)) {
    if (want && typeof want === 'object' && Array.isArray(want.in)) {
      if (!want.in.includes(row[key])) return false;
    } else if (row[key] !== want) {
      return false;
    }
  }
  return true;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: MUBARAK });
  requirePermission.mockResolvedValue({});
  db.$transaction.mockImplementation(async (fn: any) => fn(db));
  db.product.findFirst.mockResolvedValue({ id: PRODUCT, name: 'كريم', sourceType: 'PURCHASED' });
  db.productionBatch.findFirst.mockResolvedValue({ costPerUnit: 6 });
  db.inventoryMovement.create.mockImplementation(async ({ data }: any) => ({ id: 'm1', ...data }));
  receiveStock.mockResolvedValue({ batch: { batchNumber: 'ADJ-1' }, movement: {}, balanceAfter: 12 });
  drawDownStock.mockResolvedValue({ taken: 3, short: 0, cost: 18 });
  onHandTotal.mockResolvedValue(10);
  reservedElsewhere.mockResolvedValue(0);
});

describe('the stocktake records its correction on the shelf it corrected', () => {
  it('a SHORTFALL: the summary row carries the store the draw-down took units from', async () => {
    const res = await recount({ countedQuantity: 7 });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);

    const row = summary();
    // THE VALUE. `undefined` is what this door wrote for as long as the
    // defect existed, and a revert prints exactly that here.
    expect(row.storeId).toBe(MUBARAK);
    expect(row.companyId).toBe('c1');
    expect(row.type).toBe('MANUAL_ADJUSTMENT');
    expect(row.quantity).toBe(-3);
    expect(typeof row.storeId).toBe('string');
    expect(row.storeId).not.toBe('');

    // And the SAME store the units actually left, not a second source.
    expect(drawDownStock.mock.calls[0][1]).toMatchObject({ storeId: MUBARAK });
    expect(row.storeId).toBe(drawDownStock.mock.calls[0][1].storeId);
  });

  it('a SURPLUS: the summary row carries the store the units were received into', async () => {
    const res = await recount({ countedQuantity: 14 });
    expect(res.status).toBe(200);

    const row = summary();
    expect(row.storeId).toBe(MUBARAK);
    expect(row.quantity).toBe(4);
    expect(receiveStock.mock.calls[0][1]).toMatchObject({ storeId: MUBARAK });
    expect(row.storeId).toBe(receiveStock.mock.calls[0][1].storeId);
  });

  it('and that store is the one the product was already validated against', async () => {
    await recount({ countedQuantity: 7 });
    // The product lookup uses the shared helper, so «context store» and
    // «the product's store» are one value and cannot disagree.
    expect(db.product.findFirst.mock.calls[0][0].where).toEqual({ id: PRODUCT, ...inStore('c1', MUBARAK) });
    expect(summary().storeId).toBe(inStore('c1', MUBARAK).storeId);
  });

  it('and the row the door writes is a row the ledger screen returns — before, it was not', async () => {
    await recount({ countedQuantity: 7 });
    const row = summary();

    const mine = inStore('c1', MUBARAK);
    expect(matchesWhere(row, mine)).toBe(true);
    // The row as this door used to write it: the same correction, no shelf.
    expect(matchesWhere({ ...row, storeId: undefined }, mine)).toBe(false);
    expect(matchesWhere({ ...row, storeId: null }, mine)).toBe(false);
    // And it is not handed to another store, which is the same rule working.
    expect(matchesWhere(row, inStore('c1', SIHHA))).toBe(false);
    // Nor to a session with no store, answered with the whole company.
    expect(matchesWhere(row, inStore('c1', null))).toBe(false);
  });

  it('and it follows the store the request is actually in, not a constant', async () => {
    requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: SIHHA });
    await recount({ countedQuantity: 7 });
    expect(summary().storeId).toBe(SIHHA);
    expect(drawDownStock.mock.calls[0][1]).toMatchObject({ storeId: SIHHA });
  });

  it('and a count that matches writes no ledger line at all', async () => {
    // Nothing moved, so nothing is recorded — the store question does not
    // arise, and a row here would be a correction of zero in the ledger.
    const res = await recount({ countedQuantity: 10 });
    expect(res.status).toBe(200);
    expect((await res.json()).difference).toBe(0);
    expect(db.inventoryMovement.create).not.toHaveBeenCalled();
    expect(drawDownStock).not.toHaveBeenCalled();
    expect(receiveStock).not.toHaveBeenCalled();
  });
});
