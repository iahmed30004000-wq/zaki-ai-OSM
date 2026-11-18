import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A BENCH ORDER NEVER REACHES A COURIER — EVERY DOOR, WITH ITS NEGATIVE (B2, 18/11).
 *
 * «منصة تجريب»: a bench store's order is confirmed like a real one and then
 * stops. Each door that moves an order toward a courier is asked here twice:
 * once for a bench store (refused, in the owner's sentence, nothing written)
 * and once for a real store (the door goes on exactly as before). The rule and
 * its words live in `test-store.ts`; the store question in `bench-store.ts`.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, can, authorize, assertOrderAccess, shipmentBlocks, preparationGroups, resolveDeliveryFee } = vi.hoisted(() => ({
  db: {
    store: { findFirst: vi.fn() },
    deliveryProvider: { findFirst: vi.fn() },
    deliveryFee: { findMany: vi.fn() },
    order: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
    orderItem: { findMany: vi.fn() },
    orderAddOn: { findMany: vi.fn() },
    orderChangeRequest: { findFirst: vi.fn() },
    shippingBatch: { findFirst: vi.fn(), count: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    orderStatusLog: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
    user: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  can: vi.fn(),
  authorize: vi.fn(),
  assertOrderAccess: vi.fn(),
  shipmentBlocks: vi.fn(),
  preparationGroups: vi.fn(),
  resolveDeliveryFee: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: vi.fn(),
  can: (...a: unknown[]) => can(...a),
  authorize: (...a: unknown[]) => authorize(...a),
}));
vi.mock('@/lib/rbac', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a),
}));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: vi.fn() }));
vi.mock('@/lib/operations', async (orig) => ({
  ...(await orig<typeof import('@/lib/operations')>()),
  shipmentBlocks: (...a: unknown[]) => shipmentBlocks(...a),
  shipmentBlocksBulk: vi.fn(async () => new Map()),
  preparationGroups: (...a: unknown[]) => preparationGroups(...a),
}));
vi.mock('@/lib/delivery-fees', async (orig) => ({
  ...(await orig<typeof import('@/lib/delivery-fees')>()),
  resolveDeliveryFee: (...a: unknown[]) => resolveDeliveryFee(...a),
  resolveDeliveryFeesFor: vi.fn(async () => new Map()),
}));
vi.mock('@/lib/notify', () => ({ notify: vi.fn() }));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: vi.fn() }));
vi.mock('@/lib/conversions/emit', () => ({ queueConversions: vi.fn() }));

import { GET as shipmentList, POST as createShipment } from '@/app/api/ops/shipments/route';
import { GET as readyFile } from '@/app/api/ops/shipments/export/route';
import { GET as prepList } from '@/app/api/ops/preparation/route';
import { POST as shippingDoor } from '@/app/api/orders/[id]/shipping/route';
import { BENCH_LIST_EMPTY_AR, BENCH_STOPS_AR, BENCH_STOPS_CODE } from '@/lib/test-store';

const PROVIDER = '11111111-1111-4111-8111-111111111111';
const ORDER_ID = '22222222-2222-4222-8222-222222222222';
const BATCH_ID = '33333333-3333-4333-8333-333333333333';

/** The store of the session is a bench: the one question `isBenchStore` asks finds it marked. */
const bench = () => db.store.findFirst.mockResolvedValue({ id: 's1' });
/** A real store: the question finds nothing marked. */
const real = () => db.store.findFirst.mockResolvedValue(null);

const anOrder = (over: Record<string, unknown> = {}) => ({
  id: ORDER_ID, orderNumber: 'SY-2026-0001', companyId: 'c1', storeId: 's1', customerId: 'cu1', regionId: 'r1',
  confirmationStatus: 'CONFIRMED', shippingStatus: 'NOT_READY', shippedAt: null, labelPrintedAt: null,
  shippingBatchId: null, priceIncludesDelivery: false, deliveryProviderId: null, version: 4,
  lockedById: null, lockExpiresAt: null, trackingNumber: null,
  items: [{ quantity: 1, freeQuantity: 0, reservedQty: 1, unitPrice: 20, discountShare: 0 }],
  addOns: [],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', role: 'WAREHOUSE', name: 'م' },
    companyId: 'c1', storeId: 's1',
    country: { minorUnit: 2, allowNegativeStock: false, currencyCode: 'JOD' },
  });
  can.mockReturnValue(true);
  authorize.mockReturnValue({ allowed: true });
  real();
  db.deliveryProvider.findFirst.mockResolvedValue({ id: PROVIDER, code: 'X', adapterCode: null });
  db.deliveryFee.findMany.mockResolvedValue([]);
  shipmentBlocks.mockResolvedValue([]);
  preparationGroups.mockResolvedValue([]);
  resolveDeliveryFee.mockResolvedValue({ fee: 3, lateThresholdDays: 5, returnFee: 0, source: 'TABLE' });
  db.order.findMany.mockResolvedValue([]);
  db.order.count.mockResolvedValue(0);
  db.order.update.mockResolvedValue({});
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.order.findUnique.mockResolvedValue({ id: ORDER_ID });
  db.orderItem.findMany.mockResolvedValue([]);
  db.orderAddOn.findMany.mockResolvedValue([]);
  db.orderChangeRequest.findFirst.mockResolvedValue(null);
  db.shippingBatch.findFirst.mockResolvedValue(null);
  db.shippingBatch.count.mockResolvedValue(0);
  db.shippingBatch.updateMany.mockResolvedValue({ count: 1 });
  db.shippingBatch.create.mockResolvedValue({ id: BATCH_ID, batchNumber: 'BATCH-1' });
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
});

describe('the bulk trolley door — POST /api/ops/shipments', () => {
  const post = () =>
    createShipment(
      new Request('http://localhost/api/ops/shipments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deliveryProviderId: PROVIDER, orderIds: [ORDER_ID] }),
      })
    );

  it('a bench: refused in the owner’s sentence, before any order is read — no trolley, no write', async () => {
    bench();
    db.order.findMany.mockResolvedValue([anOrder()]);
    const res = await post();
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body).toEqual({ error: BENCH_STOPS_AR, code: BENCH_STOPS_CODE });
    expect(db.order.findMany).not.toHaveBeenCalled();
    expect(db.shippingBatch.create).not.toHaveBeenCalled();
    expect(db.order.update).not.toHaveBeenCalled();
  });

  it('asks about THIS company and THIS store', async () => {
    bench();
    await post();
    expect(db.store.findFirst.mock.calls[0][0].where).toEqual({ id: 's1', companyId: 'c1', isTest: true });
  });

  it('NEGATIVE: a real store’s order goes on the trolley exactly as before', async () => {
    db.order.findMany.mockResolvedValue([anOrder()]);
    const res = await post();
    expect(res.status).toBe(201);
    expect(db.order.update.mock.calls[0][0].data).toMatchObject({ shippingBatchId: BATCH_ID, shippingStatus: 'READY_FOR_PICKUP' });
  });
});

describe('the «إنشاء شحنة» list — GET /api/ops/shipments', () => {
  const get = () => shipmentList(new Request('http://localhost/api/ops/shipments'));

  it('a bench offers nothing and says why — the orders are never read', async () => {
    bench();
    const res = await get();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.orders).toEqual([]);
    expect(body.count).toBe(0);
    expect(body.benchNote).toBe(BENCH_LIST_EMPTY_AR);
    expect(db.order.findMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a real store’s list is read as before, with no bench sentence', async () => {
    const res = await get();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(db.order.findMany).toHaveBeenCalledTimes(1);
    expect(body.benchNote).toBeUndefined();
  });
});

describe('the file of the ready orders — GET /api/ops/shipments/export', () => {
  const get = () => readyFile(new Request(`http://localhost/api/ops/shipments/export?courier=${PROVIDER}`));

  it('a bench: no courier’s sheet is made of its orders', async () => {
    bench();
    const res = await get();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe(BENCH_STOPS_CODE);
    expect(db.order.findMany).not.toHaveBeenCalled();
  });

  it('asks about THIS company and THIS store', async () => {
    bench();
    await get();
    expect(db.store.findFirst.mock.calls[0][0].where).toEqual({ id: 's1', companyId: 'c1', isTest: true });
  });

  it('NEGATIVE: a real store’s file reads its orders', async () => {
    await get();
    expect(db.order.findMany).toHaveBeenCalled();
  });
});

describe('the packing list — GET /api/ops/preparation', () => {
  it('a bench: nothing to pack, and the screen is told why', async () => {
    bench();
    const body = await (await prepList()).json();
    expect(body.groups).toEqual([]);
    expect(body.totals).toEqual({ products: 0, orders: 0, shortages: 0 });
    expect(body.benchNote).toBe(BENCH_LIST_EMPTY_AR);
    expect(preparationGroups).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a real store’s packing list is the one function’s answer', async () => {
    preparationGroups.mockResolvedValue([{ productId: 'p1', productName: 'م', orders: 1, required: 1, available: 1, shortage: 0, lines: [{ orderId: 'o1' }] }]);
    const body = await (await prepList()).json();
    expect(preparationGroups).toHaveBeenCalledTimes(1);
    expect(body.groups).toHaveLength(1);
    expect(body.benchNote).toBeUndefined();
  });
});

describe('the single order door — POST /api/orders/[id]/shipping', () => {
  const door = async (order: Record<string, unknown>, body: Record<string, unknown>) => {
    assertOrderAccess.mockResolvedValue({ allowed: true, order });
    const res = await shippingDoor(
      new Request('http://localhost/x', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedVersion: 4, ...body }),
      }),
      { params: Promise.resolve({ id: ORDER_ID }) }
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  for (const to of ['READY_FOR_SHIPPING', 'PACKING', 'READY_FOR_PICKUP', 'SHIPPED'] as const) {
    it(`a bench order is not moved to ${to}`, async () => {
      bench();
      // The table's own road (shipping-workflow.ts): NOT_READY → READY_FOR_SHIPPING → PACKING → READY_FOR_PICKUP → SHIPPED.
      const from = { READY_FOR_SHIPPING: 'NOT_READY', PACKING: 'READY_FOR_SHIPPING', READY_FOR_PICKUP: 'PACKING', SHIPPED: 'READY_FOR_PICKUP' }[to];
      const res = await door(anOrder({ shippingStatus: from }), { action: 'transition', to });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.code).toBe(BENCH_STOPS_CODE);
      expect(res.body.error).toBe(BENCH_STOPS_AR);
      expect(db.order.updateMany).not.toHaveBeenCalled();
      expect(db.order.update).not.toHaveBeenCalled();
    });
  }

  it('asks the ORDER’s store, not the session’s, inside this company', async () => {
    bench();
    await door(anOrder({ storeId: 's9' }), { action: 'transition', to: 'READY_FOR_SHIPPING' });
    expect(db.store.findFirst.mock.calls[0][0].where).toEqual({ id: 's9', companyId: 'c1', isTest: true });
  });

  it('and the owner’s override with a note does not pass it either', async () => {
    bench();
    const res = await door(anOrder({ shippingStatus: 'NOT_READY' }), {
      action: 'transition', to: 'SHIPPED', shippingNote: 'تجاوز بسبب مكتوب',
    });
    expect(res.body.code).toBe(BENCH_STOPS_CODE);
  });

  it('NEGATIVE: a real store’s order passes the bench question and meets the next one', async () => {
    const res = await door(anOrder({ shippingStatus: 'NOT_READY' }), { action: 'transition', to: 'READY_FOR_SHIPPING' });
    expect(res.body.code).not.toBe(BENCH_STOPS_CODE);
    expect(db.orderChangeRequest.findFirst, 'لم يصل لسؤال طلب التعديل').toHaveBeenCalled();
  });

  it('HISTORY: a bench order already on a trolley before the mark goes on — the store is not even asked', async () => {
    bench();
    const res = await door(anOrder({ shippingStatus: 'READY_FOR_PICKUP', shippingBatchId: BATCH_ID }), { action: 'transition', to: 'SHIPPED' });
    expect(res.body.code).not.toBe(BENCH_STOPS_CODE);
    expect(db.store.findFirst).not.toHaveBeenCalled();
    expect(db.orderChangeRequest.findFirst).toHaveBeenCalled();
  });

  it('HISTORY: a bench parcel already out is still delivered', async () => {
    bench();
    const res = await door(anOrder({ shippingStatus: 'SHIPPED', shippedAt: new Date() }), { action: 'transition', to: 'OUT_FOR_DELIVERY' });
    expect(res.body.code).not.toBe(BENCH_STOPS_CODE);
  });

  it('a cancel of a bench order is not refused by the stop — it is not a step toward a courier', async () => {
    bench();
    const res = await door(anOrder(), { action: 'transition', to: 'CANCELLED' });
    expect(res.body.code).not.toBe(BENCH_STOPS_CODE);
  });

  describe('«ضمّ لدفعة» — assign_batch', () => {
    beforeEach(() => {
      db.shippingBatch.findFirst.mockResolvedValue({ id: BATCH_ID, batchNumber: 'BATCH-1', status: 'READY' });
    });

    it('a bench order is never put on a trolley', async () => {
      bench();
      const res = await door(anOrder({ shippingStatus: 'READY_FOR_PICKUP' }), { action: 'assign_batch', shippingBatchId: BATCH_ID });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe(BENCH_STOPS_CODE);
      expect(db.order.updateMany).not.toHaveBeenCalled();
      expect(db.shippingBatch.updateMany).not.toHaveBeenCalled();
    });

    it('NEGATIVE: a real store’s order is put on it as before', async () => {
      const res = await door(anOrder({ shippingStatus: 'READY_FOR_PICKUP' }), { action: 'assign_batch', shippingBatchId: BATCH_ID });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(db.order.updateMany.mock.calls[0][0].data.shippingBatchId).toBe(BATCH_ID);
    });
  });
});
