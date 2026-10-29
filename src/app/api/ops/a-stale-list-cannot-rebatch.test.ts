import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A LIST A MINUTE OLD MUST NOT MOVE AN ORDER THAT HAS MOVED ON.
 *
 * The shipment list is read, rows are ticked, and the batch is built later.
 * Both batching doors — `POST /api/ops/shipments` and the shipping door's
 * `assign_batch` — trusted the list: they put an order that already sat on
 * one trolley onto another, and even one already SHIPPED onto a trolley the
 * driver never loaded.
 *
 * Each refusal has its negative: an order that is still waiting is batched
 * exactly as before.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, can, authorize, assertOrderAccess, shipmentBlocks, resolveDeliveryFee, logAudit } = vi.hoisted(() => ({
  db: {
    deliveryProvider: { findFirst: vi.fn() },
    order: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
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
  resolveDeliveryFee: vi.fn(),
  logAudit: vi.fn(),
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
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/operations', () => ({ shipmentBlocks: (...a: unknown[]) => shipmentBlocks(...a) }));
vi.mock('@/lib/delivery-fees', async (orig) => ({
  ...(await orig<typeof import('@/lib/delivery-fees')>()),
  resolveDeliveryFee: (...a: unknown[]) => resolveDeliveryFee(...a),
}));
vi.mock('@/lib/notify', () => ({ notify: vi.fn() }));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: vi.fn() }));
vi.mock('@/lib/conversions/emit', () => ({ queueConversions: vi.fn() }));

import { POST as createShipment } from '@/app/api/ops/shipments/route';
import { POST as shippingDoor } from '@/app/api/orders/[id]/shipping/route';

const PROVIDER = '11111111-1111-4111-8111-111111111111';
const ORDER_ID = '22222222-2222-4222-8222-222222222222';
const BATCH_ID = '33333333-3333-4333-8333-333333333333';

const order = (over: Record<string, unknown> = {}) => ({
  id: ORDER_ID, orderNumber: 'SY-2026-0155', companyId: 'c1', storeId: 's1', customerId: 'cu1', regionId: 'r1',
  confirmationStatus: 'CONFIRMED', shippingStatus: 'NOT_READY', shippedAt: null, labelPrintedAt: null,
  shippingBatchId: null, priceIncludesDelivery: false, deliveryProviderId: null, version: 4,
  items: [{ quantity: 1, freeQuantity: 0, reservedQty: 1, unitPrice: 20, discountShare: 0 }],
  addOns: [],
  ...over,
});

const post = () =>
  createShipment(
    new Request('http://localhost/api/ops/shipments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deliveryProviderId: PROVIDER, orderIds: [ORDER_ID] }),
    })
  );

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', role: 'WAREHOUSE', name: 'م' },
    companyId: 'c1', storeId: 's1',
    country: { minorUnit: 2, allowNegativeStock: false },
  });
  can.mockReturnValue(true);
  authorize.mockReturnValue({ allowed: true });
  db.deliveryProvider.findFirst.mockResolvedValue({ id: PROVIDER });
  shipmentBlocks.mockResolvedValue([]);
  resolveDeliveryFee.mockResolvedValue({ fee: 3, lateThresholdDays: 5, returnFee: 0, source: 'TABLE' });
  db.shippingBatch.findFirst.mockResolvedValue(null);
  db.shippingBatch.count.mockResolvedValue(0);
  // (RV300, 28/10) `assign_batch` now takes the trolley's lock inside its write; by default the trolley is still being filled.
  db.shippingBatch.updateMany.mockResolvedValue({ count: 1 });
  db.shippingBatch.create.mockResolvedValue({ id: BATCH_ID, batchNumber: 'BATCH-1' });
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  db.order.update.mockResolvedValue({});
  db.orderStatusLog.create.mockResolvedValue({});
});

describe('building a batch from a list', () => {
  it('refuses an order that is already on another trolley', async () => {
    db.order.findMany.mockResolvedValue([order({ shippingBatchId: 'batch-old', shippingStatus: 'READY_FOR_PICKUP' })]);

    const res = await post();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe('ALL_BLOCKED');
    expect(body.exceptions[0].reasons.join(' ')).toContain('داخل دفعة أصلاً');
    expect(db.order.update, 'انتقل طلب من دفعة لدفعة').not.toHaveBeenCalled();
    expect(db.shippingBatch.create).not.toHaveBeenCalled();
  });

  it('refuses an order that has already shipped', async () => {
    db.order.findMany.mockResolvedValue([order({ shippingStatus: 'SHIPPED', shippedAt: new Date() })]);

    const res = await post();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.exceptions[0].reasons.join(' ')).toContain('سُلّم لشركة الشحن');
    expect(db.order.update).not.toHaveBeenCalled();
  });

  it('refuses an order whose status moved on even with no trolley and no stamp', async () => {
    db.order.findMany.mockResolvedValue([order({ shippingStatus: 'READY_FOR_PICKUP' })]);

    const res = await post();

    expect(res.status).toBe(409);
    expect((await res.json()).exceptions[0].reasons.join(' ')).toContain('تغيّرت حالة الطلب');
  });

  it('batches the good ones and names the stale one, in the same press', async () => {
    const stale = order({ id: '44444444-4444-4444-8444-444444444444', orderNumber: 'SY-2', shippingBatchId: 'batch-old' });
    db.order.findMany.mockResolvedValue([order(), stale]);

    const res = await createShipment(
      new Request('http://localhost/x', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deliveryProviderId: PROVIDER, orderIds: [ORDER_ID, stale.id] }),
      })
    );
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.shipped).toBe(1);
    expect(body.exceptions.map((e: { orderNumber: string }) => e.orderNumber)).toEqual(['SY-2']);
    expect(db.order.update).toHaveBeenCalledTimes(1);
  });

  it('writes the move only if the order is STILL waiting, at the version it read', async () => {
    db.order.findMany.mockResolvedValue([order()]);

    const res = await post();

    expect(res.status).toBe(201);
    expect(db.order.update.mock.calls[0][0].where).toMatchObject({
      id: ORDER_ID,
      version: 4,
      shippingBatchId: null,
      shippingStatus: { in: ['NOT_READY', 'PACKING', 'READY_FOR_SHIPPING'] },
    });
  });

  it('stops the whole press when another press got there between the read and the write', async () => {
    db.order.findMany.mockResolvedValue([order()]);
    // What Prisma throws when the conditional update finds no such row.
    db.order.update.mockRejectedValue(Object.assign(new Error('record not found'), { code: 'P2025' }));

    const res = await post();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe('ORDER_MOVED_ON');
    expect(body.error).toContain('SY-2026-0155');
    expect(logAudit, 'سُجّلت دفعة لم تُنشأ').not.toHaveBeenCalled();
    expect(db.orderStatusLog.create).not.toHaveBeenCalled();
  });

  it('a plain order is batched exactly as before', async () => {
    db.order.findMany.mockResolvedValue([order({ shippingStatus: 'READY_FOR_SHIPPING' })]);

    const res = await post();

    expect(res.status).toBe(201);
    expect((await res.json()).shipped).toBe(1);
    expect(db.order.update.mock.calls[0][0].data).toMatchObject({
      shippingBatchId: BATCH_ID,
      shippingStatus: 'READY_FOR_PICKUP',
    });
  });
});

describe('assign_batch on the shipping door', () => {
  const assign = async (over: Record<string, unknown>) => {
    const o = {
      id: ORDER_ID, companyId: 'c1', storeId: 's1', version: 4, orderNumber: 'SY-1',
      confirmationStatus: 'CONFIRMED', shippingStatus: 'READY_FOR_PICKUP', shippedAt: null, labelPrintedAt: null,
      shippingBatchId: null, lockedById: null, lockExpiresAt: null, deliveryProviderId: null,
      ...over,
    };
    assertOrderAccess.mockResolvedValue({ allowed: true, order: o });
    db.shippingBatch.findFirst.mockResolvedValue({ id: BATCH_ID, batchNumber: 'BATCH-1', status: 'READY' });
    db.order.updateMany.mockResolvedValue({ count: 1 });
    db.order.findUnique.mockResolvedValue({ id: ORDER_ID, orderNumber: 'SY-1' });
    const res = await shippingDoor(
      new Request('http://localhost/x', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'assign_batch', shippingBatchId: BATCH_ID, expectedVersion: 4 }),
      }),
      { params: Promise.resolve({ id: ORDER_ID }) }
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it('refuses an order that already belongs to another batch', async () => {
    const res = await assign({ shippingBatchId: 'batch-old' });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('ORDER_NOT_MOVABLE');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('refuses an order that has already shipped', async () => {
    const res = await assign({ shippingStatus: 'SHIPPED', shippedAt: new Date() });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ORDER_NOT_MOVABLE');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('refuses one the courier already reports, even with no stamp on it', async () => {
    const res = await assign({ shippingStatus: 'OUT_FOR_DELIVERY' });

    expect(res.body.code).toBe('ORDER_NOT_MOVABLE');
  });

  it('puts an unbatched, waiting order on the batch — with its version as the condition', async () => {
    const res = await assign({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(db.order.updateMany.mock.calls[0][0].where).toMatchObject({ id: ORDER_ID, version: 4 });
    expect(db.order.updateMany.mock.calls[0][0].data.shippingBatchId).toBe(BATCH_ID);
  });

  it('takes the trolley’s lock IN the write, only while it is still READY — before it touches the order', async () => {
    const res = await assign({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const lock = db.shippingBatch.updateMany.mock.calls[0][0];
    expect(lock.where).toMatchObject({ id: BATCH_ID, companyId: 'c1', status: 'READY' });
    expect(db.shippingBatch.updateMany.mock.invocationCallOrder[0]).toBeLessThan(db.order.updateMany.mock.invocationCallOrder[0]);
  });

  it('RV300: the press landed between the look and the write — the order is NOT added to a trolley that left', async () => {
    db.shippingBatch.updateMany.mockResolvedValue({ count: 0 });

    const res = await assign({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BATCH_CLOSED_FOR_INTAKE');
    expect(db.order.updateMany, 'انكتب الطلب على دفعة سُلّمت').not.toHaveBeenCalled();
  });

  it('NEGATIVE: the other actions never touch a trolley’s lock', async () => {
    assertOrderAccess.mockResolvedValue({
      allowed: true,
      order: { id: ORDER_ID, companyId: 'c1', storeId: 's1', version: 4, orderNumber: 'SY-1', confirmationStatus: 'CONFIRMED', shippingStatus: 'READY_FOR_PICKUP', shippedAt: null, lockedById: null, lockExpiresAt: null, deliveryProviderId: null },
    });
    db.deliveryProvider.findFirst.mockResolvedValue({ id: PROVIDER, name: 'أ' });
    db.order.updateMany.mockResolvedValue({ count: 1 });
    db.order.findUnique.mockResolvedValue({ id: ORDER_ID });

    const res = await shippingDoor(
      new Request('http://localhost/x', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'assign_provider', deliveryProviderId: PROVIDER, expectedVersion: 4 }),
      }),
      { params: Promise.resolve({ id: ORDER_ID }) }
    );

    expect(res.status).toBe(200);
    expect(db.shippingBatch.updateMany).not.toHaveBeenCalled();
  });

  it('and pressing it again on the same batch is not a refusal', async () => {
    const res = await assign({ shippingBatchId: BATCH_ID });

    expect(res.status).toBe(200);
  });

  it('and a stale version still stops it — that guard is untouched', async () => {
    assertOrderAccess.mockResolvedValue({
      allowed: true,
      order: { id: ORDER_ID, version: 9, shippingStatus: 'READY_FOR_PICKUP', confirmationStatus: 'CONFIRMED', lockedById: null, lockExpiresAt: null },
    });
    const res = await shippingDoor(
      new Request('http://localhost/x', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'assign_batch', shippingBatchId: BATCH_ID, expectedVersion: 4 }),
      }),
      { params: Promise.resolve({ id: ORDER_ID }) }
    );

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('VERSION_CONFLICT');
  });
});
