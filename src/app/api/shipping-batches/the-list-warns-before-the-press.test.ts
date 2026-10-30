import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE BATCH LIST CARRIES THE WARNING (RV166).
 *
 * Each batch of the list comes back with `courierCityGap`: null when the courier has an id for every waiting parcel's
 * governorate, and {count, regions} when it has not. The query behind it is tested in `couriers/city-gaps.test.ts`;
 * here, that the route asks it for THIS company and store, and hands the answer back beside the right batch.
 */

const { db, requireContext, can, courierCityGaps } = vi.hoisted(() => ({
  db: { shippingBatch: { count: vi.fn(), findMany: vi.fn() } },
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

const batch = (id: string, status = 'READY') => ({ id, status, deliveryProviderId: 'p1', batchNumber: id, provider: { id: 'p1' }, _count: { orders: 3 } });

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1' });
  can.mockReturnValue(true);
  db.shippingBatch.count.mockResolvedValue(2);
  db.shippingBatch.findMany.mockResolvedValue([batch('b1'), batch('b2')]);
  courierCityGaps.mockResolvedValue(new Map([['b1', { count: 2, regions: ['السويداء'] }]]));
});

describe('GET /api/shipping-batches', () => {
  it('puts the gap on the batch it belongs to and null on the others', async () => {
    const body = await (await GET(new Request('http://localhost/api/shipping-batches?limit=100'))).json();
    expect(body.batches.find((b: { id: string }) => b.id === 'b1').courierCityGap).toEqual({ count: 2, regions: ['السويداء'] });
    expect(body.batches.find((b: { id: string }) => b.id === 'b2').courierCityGap).toBeNull();
  });

  it('asks for this company and store, and only the fields the question needs from each batch', async () => {
    await GET(new Request('http://localhost/api/shipping-batches'));
    expect(courierCityGaps).toHaveBeenCalledWith({
      companyId: 'c1', storeId: 's1',
      batches: [
        { id: 'b1', status: 'READY', deliveryProviderId: 'p1' },
        { id: 'b2', status: 'READY', deliveryProviderId: 'p1' },
      ],
    });
  });

  it('NEGATIVE: the answer is refused, as before, to someone who may not see batches — the question is never asked', async () => {
    can.mockReturnValue(false);
    const res = await GET(new Request('http://localhost/api/shipping-batches'));
    expect(res.status).toBe(403);
    expect(courierCityGaps).not.toHaveBeenCalled();
  });
});
