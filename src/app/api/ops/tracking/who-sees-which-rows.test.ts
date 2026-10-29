import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MONEY_FIELDS } from '@/lib/tracking-sight';

/**
 * WHO SEES WHICH ROWS ON THE FOLLOW-UP SCREEN — THE DOOR, KEY BY KEY.
 *
 * The screen showed every parcel, the courier's money and the collect bar to anybody holding «متابعة الشحن». It has
 * two levels now (`lib/tracking-sight.ts`) and this holds them where they are enforced:
 *
 *   • the delivered parcels (the collection rows), the chip and the courier's figures need «عرض التسويات» OR «إدارة
 *     الصناديق النقدية» — without either the rows are not even read, the figures are not in the answer, and a state or a
 *     chip that is only those rows is a 403;
 *   • the return rows need «عرض المرتجعات»; «المرتجعات» (the key that RECEIVES the stock) is not it;
 *   • acting on the money is «إدارة الصناديق النقدية» alone — the `access` the screen draws from says so.
 *
 * Every key has its NEGATIVE here: the person without it gets a 403, or the same list with those rows and figures gone.
 */

const { db, requireContext, requirePermission, held } = vi.hoisted(() => ({
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
  held: new Set<string>(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: (...a: unknown[]) => requirePermission(...a),
  can: (_user: unknown, key: string) => held.has(key),
}));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: vi.fn().mockResolvedValue(undefined) }));

import { GET } from './route';

const get = (qs = '') => GET(new Request(`http://localhost/api/ops/tracking${qs ? `?${qs}` : ''}`));
const asking = () => db.order.findMany.mock.calls[0]?.[0] as { where: { AND: unknown[] } } | undefined;

const P1 = '11111111-1111-4111-8111-111111111111';
const R1 = '33333333-3333-4333-8333-333333333333';

const parcel = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  orderNumber: `ORD-${id}`,
  merchantRef: null,
  trackingNumber: `TRK-${id}`,
  confirmationStatus: 'CONFIRMED',
  updatedAt: new Date(),
  createdAt: new Date(),
  shippingStatus: 'DELIVERED',
  settlementStatus: 'PENDING_COLLECTION',
  shippedAt: new Date(Date.now() - 5 * 86_400_000),
  deliveredAt: new Date(Date.now() - 86_400_000),
  returnedAt: null,
  outForDeliveryAt: null,
  deliveryFailureReason: null,
  totalAmount: 20,
  deliveryFee: 3,
  priceIncludesDelivery: false,
  collectedAmount: 17,
  items: [{ quantity: 1, freeQuantity: 0, unitPrice: 20, discountShare: 0, lineTotal: 20, deliveredQty: 1 }],
  addOns: [],
  returnReceipt: null,
  currency: 'USD',
  regionId: R1,
  deliveryProviderId: P1,
  customer: { fullName: 'زبون', phone: '0912345678', city: 'دمشق' },
  region: { id: R1, name: 'دمشق' },
  deliveryProvider: { id: P1, name: 'أبو علي', kind: 'COMPANY', apiEnabled: false, adapterCode: null },
  _count: { deliveryAttempts: 0, notes: 0 },
  ...over,
});

let world: ReturnType<typeof parcel>[];

beforeEach(() => {
  vi.clearAllMocks();
  held.clear();
  held.add('ops.track');
  world = [parcel('a')];
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'موظف' },
    companyId: 'c1',
    storeId: 's1',
    country: { minorUnit: 2, currencyCode: 'USD', code: 'SY' },
  });
  requirePermission.mockResolvedValue({});
  db.order.findMany.mockImplementation(async (args: any) =>
    args.where.id ? world.filter((p) => args.where.id.in.includes(p.id)) : world.slice(0, args.take)
  );
  db.orderStatusLog.findMany.mockResolvedValue([]);
  db.orderChangeRequest.findMany.mockResolvedValue([]);
  db.orderActivity.findMany.mockResolvedValue([]);
  db.deliveryFee.findMany.mockResolvedValue([{ deliveryProviderId: P1, regionId: R1, lateThresholdDays: 3 }]);
  db.deliveryProvider.findMany.mockResolvedValue([{ id: P1, name: 'أبو علي' }]);
  db.region.findMany.mockResolvedValue([{ id: R1, name: 'دمشق' }]);
});

const NOT_THE_OTHER_LEVELS = { shippingStatus: { notIn: ['DELIVERED', 'PARTIALLY_DELIVERED', 'RETURN_REQUESTED', 'RETURNED'] } };

describe('the level that sees the collection rows and the courier’s figures', () => {
  it('NEGATIVE: with neither «عرض التسويات» nor «إدارة الصناديق النقدية», the delivered parcels are never read, and the figures are not in the answer', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    // The question to the database leaves the delivered AND the returned parcels out — so no chip or dropdown counts them either.
    expect(asking()!.where.AND).toContainEqual(NOT_THE_OTHER_LEVELS);
    const body = await res.json();
    expect(body.access).toEqual({ money: false, returns: false, collect: false });
    expect(body.orders).toHaveLength(1);
    for (const field of MONEY_FIELDS) expect(body.orders[0], field).not.toHaveProperty(field);
    // The sum the customer is asked to pay is not the courier's money: the contact message still carries it.
    expect(body.orders[0]).toMatchObject({ totalAmount: 20, currency: 'USD' });
  });

  it('«عرض التسويات» alone sees the rows and the figures, and still cannot act', async () => {
    held.add('settlement.view');
    const body = await (await get()).json();
    expect(body.access).toEqual({ money: true, returns: false, collect: false });
    expect(asking()!.where.AND).toContainEqual({ shippingStatus: { notIn: ['RETURN_REQUESTED', 'RETURNED'] } });
    for (const field of ['collectionStatus', 'settlementStatus', 'collectedAmount', 'expectedCollection', 'deliveryFee']) {
      expect(body.orders[0], field).toHaveProperty(field);
    }
    expect(typeof body.orders[0].expectedCollection).toBe('number');
  });

  it('«إدارة الصناديق النقدية» alone sees them too, and is the only key that acts', async () => {
    held.add('finance.cashbox');
    const body = await (await get()).json();
    expect(body.access).toEqual({ money: true, returns: false, collect: true });
    expect(body.orders[0]).toHaveProperty('expectedCollection');
  });

  it('NEGATIVE: asking for the delivered state, or the «بانتظار التحصيل» chip, without the level is a 403 naming «عرض التسويات» — and the database is never asked', async () => {
    for (const q of ['status=DELIVERED', 'status=PARTIALLY_DELIVERED', 'task=COLLECT']) {
      db.order.findMany.mockClear();
      const res = await get(q);
      expect(res.status, q).toBe(403);
      expect((await res.json()).errorAr, q).toContain('عرض التسويات');
      expect(db.order.findMany, q).not.toHaveBeenCalled();
    }
  });

  it('and with the level the same requests are answered', async () => {
    held.add('settlement.view');
    for (const q of ['status=DELIVERED', 'task=COLLECT']) expect((await get(q)).status, q).toBe(200);
  });

  it('the rows of the other chips stay: «غير متأخرة» and the default are not refused', async () => {
    for (const q of ['task=NOT_LATE', 'status=every', 'status=SHIPPED']) expect((await get(q)).status, q).toBe(200);
  });
});

describe('the level that sees the return rows', () => {
  it('NEGATIVE: «المرتجعات» — the key that receives the stock — is not the key that sees the rows', async () => {
    held.add('ops.returns');
    held.add('settlement.view');
    const body = await (await get()).json();
    expect(body.access.returns).toBe(false);
    expect(asking()!.where.AND).toContainEqual({ shippingStatus: { notIn: ['RETURN_REQUESTED', 'RETURNED'] } });
  });

  it('NEGATIVE: asking for a return state, or the «بانتظار الإرجاع» chip, without the key is a 403 naming «عرض المرتجعات»', async () => {
    held.add('settlement.view');
    for (const q of ['status=RETURN_REQUESTED', 'status=RETURNED', 'task=RETURNING']) {
      db.order.findMany.mockClear();
      const res = await get(q);
      expect(res.status, q).toBe(403);
      expect((await res.json()).errorAr, q).toContain('عرض المرتجعات');
      expect(db.order.findMany, q).not.toHaveBeenCalled();
    }
  });

  it('with the key, the return rows are read — and a person who holds both levels is asked no extra clause at all', async () => {
    held.add('ops.returns_view');
    held.add('settlement.view');
    for (const q of ['status=RETURN_REQUESTED', 'task=RETURNING']) expect((await get(q)).status, q).toBe(200);
    db.order.findMany.mockClear();
    const body = await (await get()).json();
    expect(body.access).toEqual({ money: true, returns: true, collect: false });
    expect(JSON.stringify(asking()!.where.AND)).not.toContain('notIn');
  });
});

describe('the door itself', () => {
  it('still asks «متابعة الشحن» first — nobody reaches either level without it', async () => {
    await get();
    expect(requirePermission).toHaveBeenCalledWith('ops.track');
  });

  it('a delivered row that slips into the lean read cannot bring its figures out: they are taken off every row, not only the delivered ones', async () => {
    world = [parcel('a', { shippingStatus: 'SHIPPED', settlementStatus: 'NOT_APPLICABLE', collectedAmount: null })];
    const body = await (await get()).json();
    for (const field of MONEY_FIELDS) expect(body.orders[0], field).not.toHaveProperty(field);
  });
});
