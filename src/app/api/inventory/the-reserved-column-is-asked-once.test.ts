import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE SHELF SCREEN ASKS «HOW MANY ARE HELD» ONCE FOR ALL ITS PRODUCTS, NOT ONCE PER PRODUCT.
 *
 * `GET /api/inventory` called `reservedElsewhere` for each product, at once: two aggregates each, 228 statements for 114
 * products on the main pool, every time the screen opened. The held units now come from `reservedForProducts` — two grouped
 * reads built from the same `holdingWhere` the per-product read uses (`reservation.ts`), so the rule of what holds stock still
 * has one home. The two are held to the same answer by `the-shipment-list-asks-in-bulk.test.ts`; this holds the DOOR:
 * one call for the whole list of products, none per product, and a row that carries what the map says (zero where it is silent).
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, reservedForProducts, reservedElsewhere } = vi.hoisted(() => ({
  db: { product: { findMany: vi.fn() }, inventoryMovement: { findMany: vi.fn() } },
  requireContext: vi.fn(),
  reservedForProducts: vi.fn(),
  reservedElsewhere: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: vi.fn() }));
vi.mock('@/lib/cost-visibility', () => ({ maySeeCost: () => false }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/receiving', () => ({ drawDownStock: vi.fn(), onHandTotal: vi.fn(), receiveStock: vi.fn() }));
vi.mock('@/lib/unit-cost', () => ({ resolveUnitCost: vi.fn() }));
vi.mock('@/lib/stock-ledger', async (orig) => ({
  ...(await orig<typeof import('@/lib/stock-ledger')>()),
  ledgerDepthDays: vi.fn(async () => 30),
  deliveredPerProduct: vi.fn(async () => new Map()),
}));
vi.mock('@/lib/reservation', () => ({
  reservedElsewhere: (...a: unknown[]) => reservedElsewhere(...a),
  reservedForProducts: (...a: unknown[]) => reservedForProducts(...a),
}));

import { GET } from './route';

const product = (n: number) => ({
  id: `p${n}`, name: `منتج ${n}`, sku: `SKU-${n}`, status: 'ACTIVE', sourceType: 'PURCHASED',
  batches: [{ id: `b${n}`, batchNumber: `B-${n}`, quantityProduced: 20, quantitySold: 0, quantityRemaining: 20, costPerUnit: 5, productionDate: new Date('2026-09-01') }],
});

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1', role: 'WAREHOUSE' }, companyId: 'c1', storeId: 's1' });
  db.product.findMany.mockResolvedValue(Array.from({ length: 114 }, (_, i) => product(i + 1)));
  db.inventoryMovement.findMany.mockResolvedValue([]);
  reservedForProducts.mockResolvedValue(new Map([['p1', 7], ['p2', 3]]));
});

describe('GET /api/inventory', () => {
  it('asks how many are held ONCE for all 114 products, in the store the person works in, and never per product', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(reservedForProducts).toHaveBeenCalledTimes(1);
    expect(reservedForProducts).toHaveBeenCalledWith(db, {
      companyId: 'c1',
      storeId: 's1',
      productIds: Array.from({ length: 114 }, (_, i) => `p${i + 1}`),
    });
    expect(reservedElsewhere).not.toHaveBeenCalled();
  });

  it('each row carries what the map says — zero where it is silent — and the figure agrees with the verdict’s own', async () => {
    const body = (await (await GET()).json()) as {
      stockSummary: { id: string; reserved: number; remaining: number; health: { available: number } }[];
    };
    const byId = new Map(body.stockSummary.map((r) => [r.id, r]));
    expect(byId.get('p1')!.reserved).toBe(7);
    expect(byId.get('p2')!.reserved).toBe(3);
    expect(byId.get('p3')!.reserved).toBe(0);
    // 20 on the shelf, 7 held: the verdict's available is 13 — the column and the verdict read the same number.
    expect(byId.get('p1')!.health.available).toBe(13);
    expect(byId.get('p3')!.health.available).toBe(20);
  });
});
