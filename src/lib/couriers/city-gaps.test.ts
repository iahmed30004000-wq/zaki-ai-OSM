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
vi.mock('../db', () => ({ db }));

process.env.APP_ENCRYPTION_KEY = 'c'.repeat(64);

import { courierCityGaps } from './city-gaps';
import { courierCityGapLine } from './city-gap-line';
import { encryptJson } from '../secrets';

const account = encryptJson({
  email: 'shop@example.com', password: 'a-real-password', companyId: 744, originCityId: 445053,
  senderName: 'متجر', senderPhone: '0999000000',
});
const BASHA = { id: 'p1', name: 'الباشا', code: 'BASHA', adapterCode: 'LOGESTECHS', apiEnabled: true, apiConfig: {}, apiCredentials: account };
/*
 * A SECOND COMPANY ON THE SAME PLATFORM — its own account.
 *
 * These tests are about «a governorate with no id → a warning». Every LogesTechs courier now reads Basha's list
 * (`places.courierListKey`), which gives each of our governorates its city without anybody typing it (2/11) — so the
 * governorate with no id here is one the list does not name («بغداد»), and the list itself is tried on Basha in
 * `the-press-and-the-warning-agree.test.ts` and below («production's Basha row»).
 */
const HALA = { ...BASHA, name: 'هلا', code: 'HALA' };
const MANUAL = { id: 'p2', name: 'ناقل', code: 'NAQEL', adapterCode: null, apiEnabled: false, apiConfig: null, apiCredentials: null };

const ask = (batches: { id: string; status: string; deliveryProviderId: string | null }[]) =>
  courierCityGaps({ companyId: 'c1', storeId: 's1', batches });
const OPEN = { id: 'b1', status: 'READY', deliveryProviderId: 'p1' };

beforeEach(() => {
  vi.clearAllMocks();
  db.deliveryProvider.findMany.mockResolvedValue([HALA]);
  // The rows the query asks for: the ones that carry an id, with the id.
  db.deliveryFee.findMany.mockResolvedValue([{ deliveryProviderId: 'p1', regionId: 'damascus', courierCityId: 445053 }]);
  db.region.findMany.mockResolvedValue([{ id: 'damascus', name: 'دمشق' }, { id: 'baghdad', name: 'بغداد' }]);
  db.order.groupBy.mockResolvedValue([
    { shippingBatchId: 'b1', regionId: 'damascus', _count: { _all: 4 } },
    { shippingBatchId: 'b1', regionId: 'baghdad', _count: { _all: 2 } },
  ]);
});

describe('the parcels the courier has no city id for', () => {
  it('names the count and the governorate of the ones without — the others are not in it', async () => {
    const gaps = await ask([OPEN]);
    expect(gaps.get('b1')).toEqual({ count: 2, regions: ['بغداد'] });
  });

  it('NEGATIVE: every governorate has its id — no warning', async () => {
    db.deliveryFee.findMany.mockResolvedValue([
      { deliveryProviderId: 'p1', regionId: 'damascus', courierCityId: 445053 },
      { deliveryProviderId: 'p1', regionId: 'baghdad', courierCityId: 999001 },
    ]);
    expect((await ask([OPEN])).size).toBe(0);
  });

  it('NEGATIVE: another courier’s id for that governorate does not count for this trolley', async () => {
    db.deliveryFee.findMany.mockResolvedValue([
      { deliveryProviderId: 'p1', regionId: 'damascus', courierCityId: 445053 },
      { deliveryProviderId: 'other', regionId: 'baghdad', courierCityId: 999001 },
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

/*
 * PRODUCTION'S BASHA ROW (measured 2/11): the settings screen shows «LEG-1 · LogesTechs» — the legacy import named the
 * code, the platform is LogesTechs. Run through the REAL adapter question, as at the press.
 */
describe('production’s Basha row: code LEG-1, platform LogesTechs', () => {
  const LEG1 = { ...BASHA, code: 'LEG-1' };
  const LEG3 = { ...BASHA, name: 'الو دليفيري', code: 'LEG-3', adapterCode: null };
  const SYRIA = [
    { id: 'damascus', name: 'دمشق' }, { id: 'sweida', name: 'السويداء' }, { id: 'deir', name: 'دير الزور' }, { id: 'quneitra', name: 'القنيطرة' },
  ];

  beforeEach(() => {
    db.region.findMany.mockResolvedValue(SYRIA);
    db.order.groupBy.mockResolvedValue(SYRIA.map((r) => ({ shippingBatchId: 'b1', regionId: r.id, _count: { _all: 1 } })));
    db.deliveryFee.findMany.mockResolvedValue([]);
  });

  it('nothing typed for any governorate: the list answers every one — no warning', async () => {
    db.deliveryProvider.findMany.mockResolvedValue([LEG1]);
    expect((await ask([OPEN])).size).toBe(0);
  });

  it('a typed Region Id (2903 on دمشق) is not counted as an id — but the list still answers دمشق, so no warning', async () => {
    db.deliveryProvider.findMany.mockResolvedValue([LEG1]);
    db.deliveryFee.findMany.mockResolvedValue([{ deliveryProviderId: 'p1', regionId: 'damascus', courierCityId: 2903 }]);
    expect((await ask([OPEN])).size).toBe(0);
  });

  it('a governorate the list does not name is still warned about, on LEG-1 too', async () => {
    db.deliveryProvider.findMany.mockResolvedValue([LEG1]);
    db.region.findMany.mockResolvedValue([...SYRIA, { id: 'baghdad', name: 'بغداد' }]);
    db.order.groupBy.mockResolvedValue([{ shippingBatchId: 'b1', regionId: 'baghdad', _count: { _all: 3 } }, { shippingBatchId: 'b1', regionId: 'sweida', _count: { _all: 1 } }]);
    expect((await ask([OPEN])).get('b1')).toEqual({ count: 3, regions: ['بغداد'] });
  });

  it('NEGATIVE: LEG-3 («الو دليفيري», no platform) is manual under the real adapter — never asked, never warned', async () => {
    db.deliveryProvider.findMany.mockResolvedValue([LEG3]);
    expect((await ask([OPEN])).size).toBe(0);
    expect(db.order.groupBy).not.toHaveBeenCalled();
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
    db.deliveryProvider.findMany.mockResolvedValue([{ ...HALA, apiEnabled: false }]);
    expect((await ask([OPEN])).size).toBe(0);
    db.deliveryProvider.findMany.mockResolvedValue([{ ...HALA, apiCredentials: null }]);
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
