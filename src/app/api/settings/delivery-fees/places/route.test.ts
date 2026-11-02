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

  it('looks the courier up inside this store only, with its code AND its platform', async () => {
    db.deliveryProvider.findFirst.mockResolvedValue({ code: 'BASHA' });
    await ask('?courier=p1');
    expect(db.deliveryProvider.findFirst.mock.calls[0][0].where).toEqual({ id: 'p1', companyId: 'c1', storeId: 's1' });
    expect(db.deliveryProvider.findFirst.mock.calls[0][0].select).toEqual({ code: true, adapterCode: true });
  });

  it('production’s Basha row — code LEG-1, platform LogesTechs — gets the list and the defaults the box shows', async () => {
    db.deliveryProvider.findFirst.mockResolvedValue({ code: 'LEG-1', adapterCode: 'LOGESTECHS' });
    const { places } = await (await ask('?courier=p1')).json();
    expect(places.regions['2903']).toEqual({ name: 'دمشق', cityId: 445053 });
    expect(places.regions['3003']).toEqual({ name: 'السويداء', cityId: 445153 });
    expect(places.regions['3736']).toEqual({ name: 'دير الزور', cityId: 949546 });
    expect(places.regions['3004']).toEqual({ name: 'القنيطرة', cityId: 566122 });
    expect(places.cities['949547']).toBeDefined();
  });

  it('NEGATIVE: the other legacy rows — LEG-3 with no platform, a manual one — get no list', async () => {
    db.deliveryProvider.findFirst.mockResolvedValue({ code: 'LEG-3', adapterCode: null });
    expect((await (await ask('?courier=p3')).json()).places).toBeNull();
    db.deliveryProvider.findFirst.mockResolvedValue({ code: 'MANUAL', adapterCode: 'MANUAL' });
    expect((await (await ask('?courier=p4')).json()).places).toBeNull();
  });

  it('NEGATIVE: a courier of another store, one we hold no list for, or none asked, gets null', async () => {
    db.deliveryProvider.findFirst.mockResolvedValue(null);
    expect((await (await ask('?courier=other')).json()).places).toBeNull();
    db.deliveryProvider.findFirst.mockResolvedValue({ code: 'NAQEL' });
    expect((await (await ask('?courier=p2')).json()).places).toBeNull();
    expect((await (await ask('')).json()).places).toBeNull();
  });
});
