import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * RV880 — AN ORDER THAT ENTERS A BATCH IS NO LONGER POSTPONED (the owner: «برجع للجاهز»).
 *
 * «مؤجَّلة الشحن» lets a postponed packed parcel be ticked, and «إنشاء شحنة» (`POST /api/ops/shipments`) put it on a trolley with
 * its `shipHoldUntil` still in the future. Now the same write that puts it on the trolley clears the date and the reason, and the
 * order's timeline and the audit say the hold was lifted — the action «أرجِعه» writes (`SHIP_HOLD_RELEASED`).
 *
 * Unchanged, and held here: who may enter a batch, the stock (an order whose hold gave its units back is still refused by the
 * readiness check, so nothing ships unreserved), and an order with no hold writes nothing extra.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, shipmentBlocks, resolveDeliveryFee, logAudit } = vi.hoisted(() => ({
  db: {
    deliveryProvider: { findFirst: vi.fn() },
    order: { findMany: vi.fn(), update: vi.fn() },
    shippingBatch: { findFirst: vi.fn(), count: vi.fn(), create: vi.fn() },
    orderStatusLog: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  shipmentBlocks: vi.fn(),
  resolveDeliveryFee: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: vi.fn(), can: () => true }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/operations', () => ({ shipmentBlocks: (...a: unknown[]) => shipmentBlocks(...a) }));
vi.mock('@/lib/delivery-fees', async (orig) => ({
  ...(await orig<typeof import('@/lib/delivery-fees')>()),
  resolveDeliveryFee: (...a: unknown[]) => resolveDeliveryFee(...a),
}));

import { POST as createShipment } from '@/app/api/ops/shipments/route';
import { SHIP_HOLD_RELEASED, holdEndsInBatch } from '@/lib/shipment-hold';

const PROVIDER = '11111111-1111-4111-8111-111111111111';
const ORDER_ID = '22222222-2222-4222-8222-222222222222';
const BATCH_ID = '33333333-3333-4333-8333-333333333333';
const DAY = 86_400_000;

const order = (over: Record<string, unknown> = {}) => ({
  id: ORDER_ID, orderNumber: 'SY-2026-0880', companyId: 'c1', storeId: 's1', customerId: 'cu1', regionId: 'r1',
  confirmationStatus: 'CONFIRMED', shippingStatus: 'NOT_READY', shippedAt: null, labelPrintedAt: null,
  shippingBatchId: null, priceIncludesDelivery: false, deliveryProviderId: null, version: 4,
  shipHoldUntil: null, shipHoldReason: null,
  items: [{ quantity: 1, freeQuantity: 0, reservedQty: 1, unitPrice: 20, discountShare: 0, lineTotal: 20 }],
  addOns: [],
  ...over,
});

/** «أجّل الشحن» took it off a trolley: packed, label kept, units kept, postponed to next week. */
const heldPackedParcel = (over: Record<string, unknown> = {}) =>
  order({
    shippingStatus: 'READY_FOR_PICKUP', labelPrintedAt: new Date(Date.now() - DAY),
    shipHoldUntil: new Date(Date.now() + 7 * DAY), shipHoldReason: 'الزبون مسافر', ...over,
  });

const post = () =>
  createShipment(
    new Request('http://localhost/api/ops/shipments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deliveryProviderId: PROVIDER, orderIds: [ORDER_ID] }),
    })
  );

const written = () => db.order.update.mock.calls[0][0] as { where: Record<string, unknown>; data: Record<string, unknown> };
const auditActions = () => (logAudit.mock.calls as unknown as [{ action: string }][]).map(([a]) => a.action);

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', role: 'WAREHOUSE', name: 'م' },
    companyId: 'c1', storeId: 's1',
    country: { minorUnit: 2, allowNegativeStock: false },
  });
  db.deliveryProvider.findFirst.mockResolvedValue({ id: PROVIDER, apiEnabled: false });
  shipmentBlocks.mockResolvedValue([]);
  resolveDeliveryFee.mockResolvedValue({ fee: 3, lateThresholdDays: 5, returnFee: 0, source: 'TABLE' });
  db.shippingBatch.findFirst.mockResolvedValue(null);
  db.shippingBatch.count.mockResolvedValue(0);
  db.shippingBatch.create.mockResolvedValue({ id: BATCH_ID, batchNumber: 'BATCH-1' });
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  db.order.update.mockResolvedValue({});
  db.orderStatusLog.create.mockResolvedValue({});
  db.orderActivity.create.mockResolvedValue({});
  logAudit.mockResolvedValue(undefined);
});

describe('the rule, alone', () => {
  const NOW = new Date('2026-11-03T10:00:00Z');
  it('a date ahead is cleared and recorded; a passed date is cleared only; no date is nothing', () => {
    expect(holdEndsInBatch({ shipHoldUntil: new Date('2026-11-10T00:00:00Z') }, NOW)).toEqual({ clears: true, lifted: true });
    expect(holdEndsInBatch({ shipHoldUntil: '2026-11-03T09:00:00Z' }, NOW)).toEqual({ clears: true, lifted: false });
    expect(holdEndsInBatch({ shipHoldUntil: null }, NOW)).toEqual({ clears: false, lifted: false });
    expect(holdEndsInBatch({}, NOW)).toEqual({ clears: false, lifted: false });
  });
});

describe('a postponed packed parcel ticked in «مؤجَّلة الشحن» and put on a trolley', () => {
  it('worked example: it is batched, and the same write clears the hold date and its reason', async () => {
    db.order.findMany.mockResolvedValue([heldPackedParcel()]);

    const res = await post();

    expect(res.status, await res.clone().text()).toBe(201);
    expect(db.order.update).toHaveBeenCalledTimes(1);
    expect(written().data).toMatchObject({
      shippingBatchId: BATCH_ID,
      shippingStatus: 'READY_FOR_PICKUP',
      shipHoldUntil: null,
      shipHoldReason: null,
    });
    // Who may enter is unchanged: READY_FOR_PICKUP is let in only because it carried a hold date.
    expect(written().where).toMatchObject({ id: ORDER_ID, version: 4, shippingBatchId: null });
    expect((written().where.shippingStatus as { in: string[] }).in).toContain('READY_FOR_PICKUP');
  });

  it('and records it as «أرجِعه» does: a SHIP_HOLD_RELEASED line in the timeline (in the transaction) and in the audit', async () => {
    const parcel = heldPackedParcel();
    db.order.findMany.mockResolvedValue([parcel]);

    await post();

    expect(SHIP_HOLD_RELEASED).toBe('SHIP_HOLD_RELEASED');
    expect(db.orderActivity.create).toHaveBeenCalledTimes(1);
    const activity = db.orderActivity.create.mock.calls[0][0].data;
    expect(activity).toMatchObject({ companyId: 'c1', orderId: ORDER_ID, userId: 'u1', action: 'SHIP_HOLD_RELEASED' });
    expect(JSON.parse(activity.metadata)).toEqual({
      until: null,
      reason: null,
      stock: 'KEPT',
      intoBatch: 'BATCH-1',
      heldUntil: (parcel.shipHoldUntil as unknown as Date).toISOString(),
      heldReason: 'الزبون مسافر',
    });

    expect(auditActions()).toEqual(['SHIPMENT_BATCH_CREATED', 'SHIP_HOLD_RELEASED']);
    const audit = logAudit.mock.calls[1][0];
    expect(audit).toMatchObject({
      companyId: 'c1', userId: 'u1', entity: 'Order', entityId: ORDER_ID,
      previousData: { shipHoldUntil: parcel.shipHoldUntil, reason: 'الزبون مسافر' },
      newData: { shipHoldUntil: null, reason: null, intoBatch: 'BATCH-1' },
    });
  });

  it('money is the same as for any order: the fee and the COD snapshot are untouched by the hold', async () => {
    db.order.findMany.mockResolvedValue([heldPackedParcel()]);
    await post();
    const held = written().data;

    vi.clearAllMocks();
    db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
    db.shippingBatch.create.mockResolvedValue({ id: BATCH_ID, batchNumber: 'BATCH-1' });
    db.deliveryProvider.findFirst.mockResolvedValue({ id: PROVIDER, apiEnabled: false });
    shipmentBlocks.mockResolvedValue([]);
    resolveDeliveryFee.mockResolvedValue({ fee: 3, lateThresholdDays: 5, returnFee: 0, source: 'TABLE' });
    db.order.findMany.mockResolvedValue([order()]);
    await post();
    const plain = written().data;

    expect(held.deliveryFee).toBe(plain.deliveryFee);
    expect(held.totalAmount).toBe(plain.totalAmount);
  });
});

describe('NEGATIVE', () => {
  it('an order with no hold is batched exactly as before: no hold keys in the write, no timeline line, no extra audit', async () => {
    db.order.findMany.mockResolvedValue([order({ shippingStatus: 'READY_FOR_SHIPPING' })]);

    const res = await post();

    expect(res.status).toBe(201);
    expect(written().data).not.toHaveProperty('shipHoldUntil');
    expect(written().data).not.toHaveProperty('shipHoldReason');
    expect(db.orderActivity.create).not.toHaveBeenCalled();
    expect(auditActions()).toEqual(['SHIPMENT_BATCH_CREATED']);
  });

  it('a packed parcel whose hold date already passed («أرجِعه» moved it to now): cleared, but not recorded a second time', async () => {
    db.order.findMany.mockResolvedValue([heldPackedParcel({ shipHoldUntil: new Date(Date.now() - 60_000), shipHoldReason: null })]);

    const res = await post();

    expect(res.status).toBe(201);
    expect(written().data).toMatchObject({ shipHoldUntil: null, shipHoldReason: null });
    expect(db.orderActivity.create).not.toHaveBeenCalled();
    expect(auditActions()).toEqual(['SHIPMENT_BATCH_CREATED']);
  });

  it('a held order whose hold gave its units back is still refused — nothing ships unreserved, nothing is written', async () => {
    db.order.findMany.mockResolvedValue([
      order({
        shipHoldUntil: new Date(Date.now() + 3 * DAY), shipHoldReason: 'بعد الراتب',
        items: [{ quantity: 2, freeQuantity: 0, reservedQty: 0, unitPrice: 20, discountShare: 0, lineTotal: 40 }],
      }),
    ]);

    const res = await post();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe('ALL_BLOCKED');
    expect(body.exceptions[0].reasons.join(' ')).toContain('غير محجوز');
    expect(db.order.update).not.toHaveBeenCalled();
    expect(db.orderActivity.create).not.toHaveBeenCalled();
  });
});
