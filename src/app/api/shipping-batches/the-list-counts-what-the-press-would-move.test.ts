import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — the batch list says how many parcels «خرج للتوصيل لكل الدفعة» would move.
 *
 * The button on a batch's card shows its count on its face and is drawn only when there is one, so the list carries it:
 *
 *  1. Each batch comes back with `shippedCount` — the parcels of THAT batch (this company, this store) still at «مشحون».
 *  2. One grouped count for the whole page, never one query per batch, and none at all for an empty page.
 *  3. A batch with no such parcel says 0 (not absent): the screen reads «no button» from it.
 *  4. Whoever may not see batches gets the same refusal as before, and the count is never asked.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, can, courierCityGaps } = vi.hoisted(() => ({
  db: { shippingBatch: { count: vi.fn(), findMany: vi.fn() }, order: { groupBy: vi.fn() } },
  requireContext: vi.fn(),
  can: vi.fn(),
  courierCityGaps: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ can: (...a: unknown[]) => can(...a), requirePermission: vi.fn() }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/couriers/city-gaps', () => ({ courierCityGaps: (...a: unknown[]) => courierCityGaps(...a) }));

import { GET } from './route';

const batch = (id: string, status = 'SHIPPED') => ({ id, status, deliveryProviderId: 'p1', batchNumber: id, provider: { id: 'p1' }, _count: { orders: 160 } });
const list = async () => (await (await GET(new Request('http://localhost/api/shipping-batches?limit=100'))).json()) as { batches: { id: string; shippedCount: number; courierCityGap: unknown }[] };

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1' });
  can.mockReturnValue(true);
  db.shippingBatch.count.mockResolvedValue(3);
  db.shippingBatch.findMany.mockResolvedValue([batch('b1'), batch('b2'), batch('b3', 'READY')]);
  db.order.groupBy.mockResolvedValue([{ shippingBatchId: 'b1', _count: { _all: 158 } }, { shippingBatchId: 'b2', _count: { _all: 1 } }]);
  courierCityGaps.mockResolvedValue(new Map());
});

describe('GET /api/shipping-batches — `shippedCount`', () => {
  it('puts the count of «مشحون» parcels on the batch it belongs to, and 0 on a batch that has none', async () => {
    const { batches } = await list();
    expect(batches.map((b) => [b.id, b.shippedCount])).toEqual([['b1', 158], ['b2', 1], ['b3', 0]]);
  });

  it('counts only parcels at «مشحون», of these batches, inside this company and this store — in ONE grouped query', async () => {
    await list();
    expect(db.order.groupBy).toHaveBeenCalledTimes(1);
    expect(db.order.groupBy.mock.calls[0][0]).toEqual({
      by: ['shippingBatchId'],
      where: { companyId: 'c1', storeId: 's1', shippingBatchId: { in: ['b1', 'b2', 'b3'] }, shippingStatus: 'SHIPPED' },
      _count: { _all: true },
    });
  });

  it('an empty page asks nothing', async () => {
    db.shippingBatch.findMany.mockResolvedValue([]);
    db.shippingBatch.count.mockResolvedValue(0);
    const { batches } = await list();
    expect(batches).toEqual([]);
    expect(db.order.groupBy).not.toHaveBeenCalled();
  });

  it('the other fields of the batch are what they were', async () => {
    courierCityGaps.mockResolvedValue(new Map([['b3', { count: 2, regions: ['السويداء'] }]]));
    const { batches } = await list();
    expect(batches.find((b) => b.id === 'b3')!.courierCityGap).toEqual({ count: 2, regions: ['السويداء'] });
    expect(batches.find((b) => b.id === 'b1')).toMatchObject({ batchNumber: 'b1', _count: { orders: 160 } });
  });

  it('NEGATIVE: someone who may not see batches is refused as before, and nothing is counted', async () => {
    can.mockReturnValue(false);
    const res = await GET(new Request('http://localhost/api/shipping-batches'));
    expect(res.status).toBe(403);
    expect(db.order.groupBy).not.toHaveBeenCalled();
  });
});
