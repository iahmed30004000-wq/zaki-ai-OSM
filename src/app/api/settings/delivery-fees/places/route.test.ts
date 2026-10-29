import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db, requireContext, requirePermission } = vi.hoisted(() => ({
  db: { deliveryProvider: { findFirst: vi.fn() } },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));

import { GET } from './route';

/** The names in a courier's own list, for the «رمزها عند الشركة» box. Reference data, scoped to the store's own couriers. */
beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ companyId: 'c1', storeId: 's1' });
});

const ask = (q: string) => GET(new Request(`http://localhost/api/settings/delivery-fees/places${q}`));

describe('GET /api/settings/delivery-fees/places', () => {
  it('answers the cities and regions of Basha’s list, to somebody who may view settings', async () => {
    db.deliveryProvider.findFirst.mockResolvedValue({ code: 'BASHA' });
    const body = await (await ask('?courier=p1')).json();
    expect(requirePermission).toHaveBeenCalledWith('settings.view');
    expect(body.places.cities['445153']).toBe('السويداء — السويداء');
    expect(body.places.regions['3003']).toEqual({ name: 'السويداء', cityId: 445153 });
  });

  it('looks the courier up inside this store only', async () => {
    db.deliveryProvider.findFirst.mockResolvedValue({ code: 'BASHA' });
    await ask('?courier=p1');
    expect(db.deliveryProvider.findFirst.mock.calls[0][0].where).toEqual({ id: 'p1', companyId: 'c1', storeId: 's1' });
  });

  it('NEGATIVE: a courier of another store, one we hold no list for, or none asked, gets null', async () => {
    db.deliveryProvider.findFirst.mockResolvedValue(null);
    expect((await (await ask('?courier=other')).json()).places).toBeNull();
    db.deliveryProvider.findFirst.mockResolvedValue({ code: 'NAQEL' });
    expect((await (await ask('?courier=p2')).json()).places).toBeNull();
    expect((await (await ask('')).json()).places).toBeNull();
  });
});
