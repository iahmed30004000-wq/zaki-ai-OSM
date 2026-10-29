import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A WARNING BEFORE THE PRESS (RV166).
 *
 * «رحّل إلى الشركة» refuses a governorate the courier has no city id for — but only once pressed. These read the same
 * facts earlier. They run the REAL `adapterFor` (a stored, encrypted account) so «a courier that needs the id» means
 * what dispatch means by it.
 */

const { db } = vi.hoisted(() => ({
  db: {
    deliveryProvider: { findMany: vi.fn() },
    order: { groupBy: vi.fn() },
    deliveryFee: { findMany: vi.fn() },
    region: { findMany: vi.fn() },
  },
}));
vi.mock('./db', () => ({ db }));

process.env.APP_ENCRYPTION_KEY = 'c'.repeat(64);

import { courierCityGaps } from './courier-city-gaps';
import { courierCityGapLine } from './courier-city-gap-line';
import { encryptJson } from './secrets';

const account = encryptJson({
  email: 'shop@example.com', password: 'a-real-password', companyId: 744, originCityId: 445053,
  senderName: 'متجر', senderPhone: '0999000000',
});
const BASHA = { id: 'p1', name: 'الباشا', code: 'BASHA', adapterCode: 'LOGESTECHS', apiEnabled: true, apiConfig: {}, apiCredentials: account };
const MANUAL = { id: 'p2', name: 'ناقل', code: 'NAQEL', adapterCode: null, apiEnabled: false, apiConfig: null, apiCredentials: null };

const ask = (batches: { id: string; status: string; deliveryProviderId: string | null }[]) =>
  courierCityGaps({ companyId: 'c1', storeId: 's1', batches });
const OPEN = { id: 'b1', status: 'READY', deliveryProviderId: 'p1' };

beforeEach(() => {
  vi.clearAllMocks();
  db.deliveryProvider.findMany.mockResolvedValue([BASHA]);
  db.deliveryFee.findMany.mockResolvedValue([{ deliveryProviderId: 'p1', regionId: 'damascus' }]);
  db.region.findMany.mockResolvedValue([{ id: 'sweida', name: 'السويداء' }]);
  db.order.groupBy.mockResolvedValue([
    { shippingBatchId: 'b1', regionId: 'damascus', _count: { _all: 4 } },
    { shippingBatchId: 'b1', regionId: 'sweida', _count: { _all: 2 } },
  ]);
});

describe('the parcels the courier has no city id for', () => {
  it('names the count and the governorate of the ones without — the others are not in it', async () => {
    const gaps = await ask([OPEN]);
    expect(gaps.get('b1')).toEqual({ count: 2, regions: ['السويداء'] });
  });

  it('NEGATIVE: every governorate has its id — no warning', async () => {
    db.deliveryFee.findMany.mockResolvedValue([
      { deliveryProviderId: 'p1', regionId: 'damascus' }, { deliveryProviderId: 'p1', regionId: 'sweida' },
    ]);
    expect((await ask([OPEN])).size).toBe(0);
  });

  it('NEGATIVE: another courier’s id for that governorate does not count for this trolley', async () => {
    db.deliveryFee.findMany.mockResolvedValue([
      { deliveryProviderId: 'p1', regionId: 'damascus' }, { deliveryProviderId: 'other', regionId: 'sweida' },
    ]);
    expect((await ask([OPEN])).get('b1')?.count).toBe(2);
  });

  it('a parcel with no governorate at all is named as such, as dispatch refuses it too', async () => {
    db.order.groupBy.mockResolvedValue([{ shippingBatchId: 'b1', regionId: null, _count: { _all: 1 } }]);
    db.region.findMany.mockResolvedValue([]);
    expect((await ask([OPEN])).get('b1')).toEqual({ count: 1, regions: ['بلا محافظة'] });
  });

  it('counts only what the press would still claim: no barcode, waiting for pickup, confirmed, in these trolleys', async () => {
    await ask([OPEN]);
    expect(db.order.groupBy.mock.calls[0][0].where).toMatchObject({
      companyId: 'c1', storeId: 's1', shippingBatchId: { in: ['b1'] },
      trackingNumber: null, shippingStatus: 'READY_FOR_PICKUP', confirmationStatus: 'CONFIRMED',
    });
  });

  it('reads only fee rows that carry an id', async () => {
    await ask([OPEN]);
    expect(db.deliveryFee.findMany.mock.calls[0][0].where).toMatchObject({ courierCityId: { not: null } });
  });
});

describe('where it says nothing', () => {
  it('NEGATIVE: a manual courier needs no id — and no parcel is even counted', async () => {
    db.deliveryProvider.findMany.mockResolvedValue([MANUAL]);
    const gaps = await ask([{ id: 'b2', status: 'READY', deliveryProviderId: 'p2' }]);
    expect(gaps.size).toBe(0);
    expect(db.order.groupBy).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a switched-off or account-less courier is manual too', async () => {
    db.deliveryProvider.findMany.mockResolvedValue([{ ...BASHA, apiEnabled: false }]);
    expect((await ask([OPEN])).size).toBe(0);
    db.deliveryProvider.findMany.mockResolvedValue([{ ...BASHA, apiCredentials: null }]);
    expect((await ask([OPEN])).size).toBe(0);
  });

  it('NEGATIVE: a trolley already handed over is not warned about — the press is gone', async () => {
    expect((await ask([{ ...OPEN, status: 'SHIPPED' }])).size).toBe(0);
    expect(db.deliveryProvider.findMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a trolley with no courier is not asked about', async () => {
    expect((await ask([{ ...OPEN, deliveryProviderId: null }])).size).toBe(0);
    expect(db.deliveryProvider.findMany).not.toHaveBeenCalled();
  });
});

describe('the sentence', () => {
  it('says how many, which governorate, where to enter the id — and that the rest still go', () => {
    const line = courierCityGapLine({ count: 2, regions: ['السويداء', 'القنيطرة'] });
    expect(line).toContain('2 طلب (السويداء، القنيطرة)');
    expect(line).toContain('«رمزها عند الشركة»');
    expect(line).toContain('باقي الطلبات بتنرسل عادي');
  });

  it('is Arabic only', () => {
    expect(courierCityGapLine({ count: 1, regions: ['حلب'] })).not.toMatch(/[A-Za-z]/);
  });
});
