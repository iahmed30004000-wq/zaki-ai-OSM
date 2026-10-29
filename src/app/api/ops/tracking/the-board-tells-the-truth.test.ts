import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE FOLLOW-UP BOARD MUST NOT SAY WHAT IS NOT TRUE.
 *
 * Measured on the live shop: delivered parcels read «متأخرة» (the clock ran to today for ever), parcels of companies that
 * never hand out a barcode read «بلا باركود», a cancelled order whose parcel had long arrived still raised an alert, and
 * the bar that offers the owed money counted the page it held — where money waits last, so it was usually empty.
 *
 * What this holds: the clock stops at the delivery or the return; late, unbarcoded and the alerts are about parcels on
 * the road only; a barcode is owed only by a company that creates its waybill through its API; the chips still count a
 * row under every condition it meets, and the new «غير متأخرة» is one more; the owed total is the whole list's; and the
 * owed rows come out in the order they became owed.
 */

const { db, requireContext, requirePermission } = vi.hoisted(() => ({
  db: {
    order: { findMany: vi.fn() },
    orderStatusLog: { findMany: vi.fn() },
    orderChangeRequest: { findMany: vi.fn() },
    orderActivity: { findMany: vi.fn() },
    deliveryFee: { findMany: vi.fn() },
    deliveryProvider: { findMany: vi.fn() },
    region: { findMany: vi.fn() },
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a), can: () => true }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: vi.fn().mockResolvedValue(undefined) }));

import { GET } from './route';

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const get = (qs = '') => new Request(`http://localhost/api/ops/tracking${qs}`);

const API = { id: 'api', name: 'شركة بالربط', kind: 'COMPANY', apiEnabled: true, adapterCode: 'logestechs' };
const MANUAL = { id: 'manual', name: 'شركة يدوية', kind: 'COMPANY', apiEnabled: false, adapterCode: null };

let n = 0;
const parcel = (over: Record<string, unknown> = {}) => ({
  id: `o${++n}`, orderNumber: `SY-${n}`, merchantRef: null,
  trackingNumber: `BC-${n}`, confirmationStatus: 'CONFIRMED', updatedAt: ago(0),
  shippingStatus: 'SHIPPED', settlementStatus: 'NOT_APPLICABLE',
  shippedAt: ago(1), deliveredAt: null, returnedAt: null, outForDeliveryAt: null, deliveryFailureReason: null,
  totalAmount: 20, deliveryFee: 3, priceIncludesDelivery: false, collectedAmount: null,
  items: [{ quantity: 1, freeQuantity: 0, unitPrice: 20, discountShare: 0, deliveredQty: null }],
  returnReceipt: null, addOns: [],
  currency: 'USD', regionId: 'r1', deliveryProviderId: 'api',
  customer: { fullName: 'زبون', phone: '0912345678', city: 'دمشق' },
  region: { id: 'r1', name: 'دمشق' },
  deliveryProvider: API as typeof API | null,
  _count: { deliveryAttempts: 0, notes: 0 },
  ...over,
});

const FEES = [
  { deliveryProviderId: 'api', regionId: 'r1', lateThresholdDays: 3 },
  { deliveryProviderId: 'manual', regionId: 'r1', lateThresholdDays: 3 },
  { deliveryProviderId: 'half', regionId: 'r1', lateThresholdDays: 3 },
];

const ask = async (rows: ReturnType<typeof parcel>[], qs = '') => {
  db.order.findMany.mockResolvedValue(rows);
  db.deliveryProvider.findMany.mockResolvedValue(
    [...new Map(rows.flatMap((r) => (r.deliveryProvider ? [[r.deliveryProvider.id, r.deliveryProvider] as const] : []))).values()]
  );
  const res = await GET(get(qs));
  return { res, body: await res.json() };
};
const byId = (body: { orders: { id: string }[] }, id: string) => body.orders.find((o) => o.id === id) as Record<string, any>;

beforeEach(() => {
  vi.clearAllMocks();
  n = 0;
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'موظف تتبّع' },
    companyId: 'c1', storeId: 's1',
    country: { minorUnit: 2, currencyCode: 'USD', code: 'SY' },
  });
  requirePermission.mockResolvedValue({});
  db.orderStatusLog.findMany.mockResolvedValue([]);
  db.orderChangeRequest.findMany.mockResolvedValue([]);
  db.orderActivity.findMany.mockResolvedValue([]);
  db.deliveryFee.findMany.mockResolvedValue(FEES);
  db.region.findMany.mockResolvedValue([{ id: 'r1', name: 'دمشق' }]);
});

const arrived = (id: string, shippedDaysAgo: number, deliveredDaysAgo: number | null, over: Record<string, unknown> = {}) =>
  parcel({
    id, shippingStatus: 'DELIVERED', settlementStatus: 'PENDING_COLLECTION',
    shippedAt: ago(shippedDaysAgo), deliveredAt: deliveredDaysAgo === null ? null : ago(deliveredDaysAgo), ...over,
  });

describe('a parcel that arrived is not late, and its clock stopped', () => {
  it('— delivered 10 days after it shipped, on a 3-day lane: 10 days, not late, even though today is far later', async () => {
    const { body } = await ask([arrived('d', 40, 30)]);
    expect(byId(body, 'd').daysInTransit).toBe(10);
    expect(byId(body, 'd').late).toBe(false);
    expect(body.lateCount).toBe(0);
    expect(body.facts.tasks.LATE).toBe(0);
  });

  it('— delivered inside the lane’s time is not late either (the easy case)', async () => {
    const { body } = await ask([arrived('d', 20, 18)]);
    expect(byId(body, 'd')).toMatchObject({ daysInTransit: 2, late: false });
  });

  it('— a delivery dated BEFORE the shipping date is zero days, never a negative number', async () => {
    const { body } = await ask([arrived('d', 5, 9)]);
    expect(byId(body, 'd')).toMatchObject({ daysInTransit: 0, late: false });
  });

  it('— a returned parcel stops at the return date and is not late', async () => {
    const { body } = await ask(
      [parcel({ id: 'r', shippingStatus: 'RETURNED', shippedAt: ago(60), returnedAt: ago(50) })],
      '?status=RETURNED'
    );
    expect(byId(body, 'r')).toMatchObject({ daysInTransit: 10, late: false });
    expect(body.lateCount).toBe(0);
  });

  it('— a delivered row the sheet import left with no date has no days at all (counting to today would invent a journey)', async () => {
    const { body } = await ask([arrived('i', 90, null)]);
    expect(byId(body, 'i')).toMatchObject({ daysInTransit: null, late: false });
  });

  it('— the same parcel still on the road IS late: the clock runs to today', async () => {
    const { body } = await ask([parcel({ id: 'road', shippedAt: ago(10) })]);
    expect(byId(body, 'road')).toMatchObject({ daysInTransit: 10, late: true });
    expect(body.lateCount).toBe(1);
  });
});

describe('«بلا باركود» is owed only by a company that creates its waybill through its API', () => {
  it('— an API company’s parcel on the road with no barcode is flagged', async () => {
    const { body } = await ask([parcel({ id: 'a', trackingNumber: null })]);
    expect(byId(body, 'a').barcodeExpected).toBe(true);
    expect(body.facts.tasks.NO_BARCODE).toBe(1);
  });

  it('— a manual company’s parcel with no barcode is NOT flagged: it is matched on the order number', async () => {
    const { body } = await ask([parcel({ id: 'm', trackingNumber: null, deliveryProviderId: 'manual', deliveryProvider: MANUAL })]);
    expect(byId(body, 'm').barcodeExpected).toBe(false);
    expect(body.facts.tasks.NO_BARCODE).toBe(0);
  });

  it('— a company with the API switched on but no adapter has nothing to create a waybill with: not flagged', async () => {
    const half = { ...MANUAL, id: 'half', apiEnabled: true, adapterCode: null };
    const { body } = await ask([parcel({ id: 'h', trackingNumber: null, deliveryProviderId: 'half', deliveryProvider: half })]);
    expect(body.facts.tasks.NO_BARCODE).toBe(0);
  });

  it('— a parcel with no company at all owes no barcode either', async () => {
    const { body } = await ask([parcel({ id: 'x', trackingNumber: null, deliveryProviderId: null, deliveryProvider: null })]);
    expect(body.facts.tasks.NO_BARCODE).toBe(0);
  });

  it('— a delivered parcel of an API company with no barcode is past it', async () => {
    const { body } = await ask([arrived('d', 3, 1, { trackingNumber: null })]);
    expect(body.facts.tasks.NO_BARCODE).toBe(0);
  });

  it('— the two fields that decide it do not leave the building', async () => {
    const { body } = await ask([parcel({ id: 'a' })]);
    expect(Object.keys(byId(body, 'a').deliveryProvider).sort()).toEqual(['id', 'kind', 'name']);
  });
});

describe('an alert is about a parcel on the road', () => {
  it('— a cancelled order whose parcel is still out raises it', async () => {
    const { body } = await ask([parcel({ id: 'out', confirmationStatus: 'CANCELLED' })]);
    expect(byId(body, 'out').alert).toMatchObject({ kind: 'CANCELLED', acknowledged: false });
    expect(body.facts.tasks.CANCELLED).toBe(1);
  });

  it('— the same order once the parcel has arrived (or come back) raises nothing', async () => {
    const { body } = await ask(
      [
        arrived('arrived', 5, 1, { confirmationStatus: 'CANCELLED' }),
        parcel({ id: 'back', confirmationStatus: 'CANCELLED', shippingStatus: 'RETURNED', shippedAt: ago(5), returnedAt: ago(1) }),
      ],
      '?status=every'
    );
    expect(byId(body, 'arrived').alert).toBeNull();
    expect(byId(body, 'back').alert).toBeNull();
    expect(body.facts.tasks.CANCELLED).toBe(0);
  });
});

describe('the chips — every condition a row meets, and one more', () => {
  const world = () => [
    parcel({ id: 'late-nobarcode', shippedAt: ago(10), trackingNumber: null }),
    parcel({ id: 'ontime', shippedAt: ago(1) }),
    parcel({ id: 'ontime-manual', shippedAt: ago(2), trackingNumber: null, deliveryProviderId: 'manual', deliveryProvider: MANUAL }),
    arrived('arrived', 30, 20),
  ];

  it('— a late parcel with no barcode is counted under both, as before', async () => {
    const { body } = await ask(world());
    expect(body.facts.tasks).toMatchObject({ LATE: 1, NO_BARCODE: 1, COLLECT: 1 });
  });

  it('— «غير متأخرة» counts what is on the road and inside its time, and not what arrived', async () => {
    const { body } = await ask(world());
    expect(body.facts.notLate).toBe(2);
  });

  it('— asking for it brings exactly those parcels', async () => {
    const { body } = await ask(world(), '?task=NOT_LATE');
    expect(body.orders.map((o: { id: string }) => o.id).sort()).toEqual(['ontime', 'ontime-manual']);
    expect(body.pagination.total).toBe(2);
  });

  it('— and a chip that does not exist is still refused, in Arabic', async () => {
    const res = await GET(get('?task=NOT_EARLY'));
    expect(res.status).toBe(400);
    expect((await res.json()).errorAr).toContain('المهمة');
  });
});

describe('the owed money — a total that does not move with the page, in the order it became owed', () => {
  const world = () => [
    // Late parcels come first in the ranking: the owed ones come LAST.
    parcel({ id: 'late1', shippedAt: ago(30) }),
    parcel({ id: 'late2', shippedAt: ago(29) }),
    arrived('new', 60, 2),
    arrived('old', 60, 20),
    arrived('import', 60, null),
    arrived('mid', 60, 9),
  ];

  it('— the total is the whole list’s, whichever page is asked for', async () => {
    const p1 = (await ask(world(), '?limit=2&page=1')).body;
    const p3 = (await ask(world(), '?limit=2&page=3')).body;
    expect(p1.facts.tasks.COLLECT).toBe(4);
    expect(p3.facts.tasks.COLLECT).toBe(4);
    // Page one holds none of them (late first) — which is exactly why the bar cannot count the page.
    expect(p1.orders.some((o: { shippingStatus: string }) => o.shippingStatus === 'DELIVERED')).toBe(false);
  });

  it('— the owed rows are the longest-delivered first, and the one with no delivery date last', async () => {
    const { body } = await ask(world(), '?task=COLLECT');
    expect(body.orders.map((o: { id: string }) => o.id)).toEqual(['old', 'mid', 'new', 'import']);
  });
});
