import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LEAN_CAP, LEAN_SELECT } from '@/lib/tracking-list';

/**
 * THE SHIPMENT FOLLOW-UP, IN PAGES — THE DOOR.
 *
 * «متابعة الشحن — صفحات + فلاتر + بحث». The door took the two hundred oldest parcels and drew them all, and counted the
 * seven chips over those. What is held here is what it asks the database now — every parcel the question matches, lean,
 * then only the page in full — that the state and the search are each their own clause (a search typed from the default
 * view used to replace the state's `OR` and quietly looked at every state), what it refuses, and what it sends back.
 */

const { db, requireContext, requirePermission, noteCustomersHandedOut } = vi.hoisted(() => ({
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
  noteCustomersHandedOut: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a), can: () => true }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: (...a: unknown[]) => noteCustomersHandedOut(...a) }));

import { GET } from './route';

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const get = (qs = '') => GET(new Request(`http://localhost/api/ops/tracking${qs ? `?${qs}` : ''}`));

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const R1 = '33333333-3333-4333-8333-333333333333';

/** One parcel, as the DATABASE has it — the lean read takes a few fields of it, the page read all of them. */
const parcel = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  orderNumber: `ORD-${id}`,
  merchantRef: null,
  trackingNumber: `TRK-${id}`,
  confirmationStatus: 'CONFIRMED',
  updatedAt: ago(0),
  createdAt: ago(5),
  shippingStatus: 'SHIPPED',
  settlementStatus: 'NOT_APPLICABLE',
  shippedAt: ago(1),
  outForDeliveryAt: null,
  deliveryFailureReason: null,
  totalAmount: 20,
  deliveryFee: 3,
  priceIncludesDelivery: false,
  collectedAmount: null,
  items: [{ quantity: 1, freeQuantity: 0, unitPrice: 20, discountShare: 0, deliveredQty: null }],
  returnReceipt: null,
  currency: 'USD',
  regionId: R1,
  deliveryProviderId: P1,
  customer: { fullName: 'زبون', phone: '0912345678', city: 'دمشق' },
  region: { id: R1, name: 'دمشق' },
  deliveryProvider: { id: P1, name: 'أبو علي', kind: 'AGENT' },
  _count: { deliveryAttempts: 0, notes: 0 },
  ...over,
});

let world: ReturnType<typeof parcel>[];
const lean = () => db.order.findMany.mock.calls[0][0] as { where: any; orderBy: unknown; take: number; select: Record<string, unknown> };
const rich = () => db.order.findMany.mock.calls[1]?.[0] as { where: any; select: Record<string, unknown> } | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  world = [];
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'موظف تتبّع' },
    companyId: 'c1',
    storeId: 's1',
    country: { minorUnit: 2, currencyCode: 'USD', code: 'SY' },
  });
  requirePermission.mockResolvedValue({});
  // The lean read gets every parcel; the page read gets the ids it asked for — in the database's order, NOT the list's.
  db.order.findMany.mockImplementation(async (args: any) =>
    args.where.id ? world.filter((p) => args.where.id.in.includes(p.id)).reverse() : world.slice(0, args.take)
  );
  db.orderStatusLog.findMany.mockResolvedValue([]);
  db.orderChangeRequest.findMany.mockResolvedValue([]);
  db.orderActivity.findMany.mockResolvedValue([]);
  db.deliveryFee.findMany.mockResolvedValue([{ deliveryProviderId: P1, regionId: R1, lateThresholdDays: 3 }]);
  db.deliveryProvider.findMany.mockResolvedValue([{ id: P1, name: 'أبو علي' }, { id: P2, name: 'أمان' }]);
  db.region.findMany.mockResolvedValue([{ id: R1, name: 'دمشق' }]);
  noteCustomersHandedOut.mockResolvedValue(undefined);
});

describe('what it asks the database', () => {
  it('— once for EVERY parcel the question matches, lean and bounded; then only the page, in full, scoped again', async () => {
    world = [parcel('a'), parcel('b')];
    const res = await get();
    expect(res.status).toBe(200);
    expect(db.order.findMany).toHaveBeenCalledTimes(2);
    expect(lean()).toMatchObject({ take: LEAN_CAP + 1, select: LEAN_SELECT });
    expect(lean().where).toMatchObject({ companyId: 'c1', storeId: 's1' });
    expect(rich()!.where).toEqual({ id: { in: ['a', 'b'] }, companyId: 'c1', storeId: 's1' });
    expect(Object.keys(rich()!.select)).toEqual(expect.arrayContaining(['items', 'customer', 'deliveryProvider', 'region']));
  });

  it('and the default state is what is moving PLUS what arrived and is still owed — as its own clause', async () => {
    await get();
    expect(lean().where.AND).toEqual([
      {
        OR: [
          { shippingStatus: { in: ['SHIPPED', 'OUT_FOR_DELIVERY', 'READY_FOR_PICKUP', 'FAILED_DELIVERY', 'RETURN_REQUESTED'] } },
          { shippingStatus: { in: ['DELIVERED', 'PARTIALLY_DELIVERED'] }, settlementStatus: { not: 'SETTLED' } },
        ],
      },
    ]);
  });

  it('and THE SEARCH IS ANDed ONTO THE STATE, never in its place — typed from the default view, it no longer looks at every state', async () => {
    await get('q=0791234567');
    const and = lean().where.AND as any[];
    expect(and).toHaveLength(2);
    // The state's clause is still there…
    expect(JSON.stringify(and[0])).toContain('SETTLED');
    expect(JSON.stringify(and[0])).toContain('FAILED_DELIVERY');
    // …and the search is its own.
    expect(and[1].OR.map((c: any) => Object.keys(c)[0])).toEqual(['orderNumber', 'merchantRef', 'trackingNumber', 'customer', 'customer', 'customer']);
    // Nothing is spread over the scope: no `OR` at the top of the question to be overwritten by another `OR`.
    expect(lean().where.OR).toBeUndefined();
  });

  it('and «every state» — `every`, or the old `all` — asks for no state, a state asks for that state', async () => {
    for (const q of ['status=every', 'status=all']) {
      db.order.findMany.mockClear();
      await get(q);
      expect(lean().where.AND, q).toEqual([]);
    }
    db.order.findMany.mockClear();
    await get('status=RETURNED&q=ab');
    expect(lean().where.AND).toEqual([{ shippingStatus: 'RETURNED' }, expect.objectContaining({ OR: expect.any(Array) })]);
  });

  it('and a PRODUCT is its own clause — the orders for that product, in THIS store, ANDed with the state and the search', async () => {
    await get(`product=${P1}&status=DELIVERED&q=ab`);
    const and = lean().where.AND as any[];
    expect(and).toHaveLength(3);
    expect(and[0]).toEqual({ shippingStatus: 'DELIVERED' });
    expect(and[1]).toEqual({ productId: P1 });
    expect(and[2].OR).toBeDefined();
    // The store is still in the WHERE: another store's product id finds nothing here.
    expect(lean().where).toMatchObject({ companyId: 'c1', storeId: 's1' });
  });

  it('NEGATIVE: no product asked for means no product clause; «all» is no choice; a word that is no id is refused and reads nothing', async () => {
    await get();
    expect(JSON.stringify(lean().where.AND)).not.toContain('productId');
    db.order.findMany.mockClear();
    await get('product=all');
    expect(JSON.stringify(lean().where.AND)).not.toContain('productId');
    db.order.findMany.mockClear();
    const res = await get('product=كريم');
    expect(res.status).toBe(400);
    expect(db.order.findMany).not.toHaveBeenCalled();
  });

  it('and only whoever may follow shipments reads it — the permission is asked by name, and a refusal reads nothing', async () => {
    requirePermission.mockRejectedValue(new Error('Forbidden: missing required permission ops.track'));
    expect((await get()).status).toBe(403);
    expect(requirePermission).toHaveBeenCalledWith('ops.track');
    expect(db.order.findMany).not.toHaveBeenCalled();
  });

  it('and a filter that names another company cannot reach it — the scope is the person’s, and the dropdowns narrow what was read', async () => {
    world = [parcel('a'), parcel('b', { deliveryProviderId: P2 })];
    await get(`courier=${P2}`);
    expect(lean().where).toMatchObject({ companyId: 'c1', storeId: 's1' });
    expect(rich()!.where.id.in).toEqual(['b']);
  });
});

describe('what it refuses', () => {
  it.each([
    ['status=SHIPPING', 'الحالة غير معروف: SHIPPING'],
    ['task=late', 'المهمة غير معروف: late'],
    ['courier=dhl', 'شركة الشحن غير معروف: dhl'],
    ['region=amman', 'المحافظة غير معروف: amman'],
    ['age=ancient', 'مدّة الشحن غير معروف: ancient'],
  ])('— %s: 400, in Arabic, and nothing was read', async (query, arabic) => {
    const res = await get(query);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errorAr).toBe(arabic);
    expect(body.error).toMatch(/^Unknown /);
    expect(db.order.findMany).not.toHaveBeenCalled();
  });
});

describe('the page', () => {
  it('— page and size come from the address, the size capped at a hundred; words are the default', async () => {
    world = Array.from({ length: 160 }, (_, i) => parcel(`p${String(i).padStart(3, '0')}`));
    await get('page=3&limit=10');
    expect(rich()!.where.id.in).toHaveLength(10);
    db.order.findMany.mockClear();
    await get('page=1&limit=1000');
    expect(rich()!.where.id.in).toHaveLength(100);
    db.order.findMany.mockClear();
    await get('page=abc&limit=xyz');
    expect(rich()!.where.id.in).toHaveLength(25);
  });

  it('and a page past the end is answered with the last, and the body says which — `count` is what is ON the page, `total` how many there are', async () => {
    world = Array.from({ length: 60 }, (_, i) => parcel(`p${String(i).padStart(3, '0')}`));
    const body = await (await get('page=99999')).json();
    expect(body.pagination).toEqual({ total: 60, page: 3, limit: 25, totalPages: 3 });
    expect(body.count).toBe(10);
    expect(body.orders).toHaveLength(10);
  });

  it('and the page is in the LIST’s order — worst first — not the order the database answered in', async () => {
    world = [
      parcel('quiet', { shippedAt: ago(1) }),
      parcel('failed', { shippingStatus: 'FAILED_DELIVERY', shippedAt: ago(2) }),
      parcel('late', { shippedAt: ago(10) }),
    ];
    const body = await (await get()).json();
    // The rich read answers in reverse (the mock); the rows come back as the list ranked them.
    expect(body.orders.map((o: { id: string }) => o.id)).toEqual(['failed', 'late', 'quiet']);
  });

  it('and a parcel that vanished between the two reads is skipped, not a crash', async () => {
    world = [parcel('a'), parcel('b')];
    db.order.findMany.mockImplementation(async (args: any) =>
      args.where.id ? world.filter((p) => p.id === 'a') : world
    );
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).orders.map((o: { id: string }) => o.id)).toEqual(['a']);
  });

  it('and an empty page reads nothing in full', async () => {
    world = [];
    const body = await (await get()).json();
    expect(db.order.findMany).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({ count: 0, orders: [], pagination: { total: 0, page: 1, totalPages: 1 }, capped: false });
  });

  it('and a chip is a question for the server — pressing «متأخرة» reads only the late parcels in full', async () => {
    world = [parcel('quiet'), parcel('late', { shippedAt: ago(10) })];
    const body = await (await get('task=LATE')).json();
    expect(rich()!.where.id.in).toEqual(['late']);
    expect(body.pagination.total).toBe(1);
    expect(body.applied.task).toBe('LATE');
  });
});

describe('the numbers it sends with the page', () => {
  it('— the chips, the badge, «الكل» and the dropdowns’ numbers, counted over the whole list — not over the page', async () => {
    world = [
      ...Array.from({ length: 30 }, (_, i) => parcel(`l${i}`, { shippedAt: ago(10) })),
      parcel('q', { shippedAt: ago(1) }),
    ];
    const body = await (await get('limit=5')).json();
    expect(body.count).toBe(5);
    expect(body.lateCount).toBe(30);
    expect(body.facts.total).toBe(31);
    expect(body.facts.tasks.LATE).toBe(30);
    expect(body.facts.lateCount).toBe(30);
    expect(body.facts.couriers).toEqual([{ id: P1, name: 'أبو علي', count: 31 }]);
    expect(body.facts.regions).toEqual([{ id: R1, name: 'دمشق', count: 31 }]);
    expect(body.facts.ages).toEqual({ fresh: 1, few: 0, week: 0, old: 30 });
    expect(Object.keys(body.facts)).toEqual(['total', 'tasks', 'lateCount', 'notLate', 'couriers', 'regions', 'ages']);
  });

  it('and a row’s own «late» is the list’s: the parcel the chip counts is the parcel that says late', async () => {
    world = [parcel('late', { shippedAt: ago(10) }), parcel('quiet', { shippedAt: ago(1) })];
    const body = await (await get('task=LATE')).json();
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0]).toMatchObject({ id: 'late', late: true, daysInTransit: 10, lateThresholdDays: 3 });
  });

  it('and it says what was applied, and whether the bound was reached — a list is never silently shorter than it looks', async () => {
    world = [parcel('a')];
    const body = await (await get(`status=RETURNED&courier=${P1}&age=fresh&q=ab`)).json();
    expect(body.applied).toEqual({ status: 'RETURNED', task: null, courier: P1, region: null, age: 'fresh', product: null, q: 'ab' });
    expect(body.capped).toBe(false);
  });

  it('and the country’s calling code and the tally of contact details handed out still travel with it', async () => {
    world = [parcel('a'), parcel('b')];
    const body = await (await get()).json();
    expect(body.dialCode).toBe('963');
    expect(noteCustomersHandedOut).toHaveBeenCalledTimes(1);
    expect(noteCustomersHandedOut.mock.calls[0][0].rows.map((r: { id: string }) => r.id).sort()).toEqual(['a', 'b']);
    expect(noteCustomersHandedOut.mock.calls[0][0]).toMatchObject({ companyId: 'c1', storeId: 's1', where: 'شاشة التتبّع' });
  });
});
