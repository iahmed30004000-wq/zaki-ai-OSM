import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE ADD-ON IS COLLECTED.
 *
 * The thank-you page offers a second product; accepting it records an
 * OrderAddOn and raises the order's total. Creating the shipment then
 * snapshotted the COD by rebuilding it from the order's LINES alone — and
 * wrote that back over the total. The courier collected the order without
 * the add-on: on the dev data, 12 of 32 on every upsold order, 37%.
 *
 * Nothing tested shipment creation at all, which is how it survived.
 */

const { db, requireContext, shipmentBlocks, resolveDeliveryFee } = vi.hoisted(() => ({
  db: {
    // B2 (18/11): the shipping doors now ask whether the store is a test bench (`bench-store.ts`); unset, this answers «no».
    store: { findFirst: vi.fn() },
    deliveryProvider: { findFirst: vi.fn() },
    order: { findMany: vi.fn(), update: vi.fn() },
    shippingBatch: { findFirst: vi.fn(), count: vi.fn(), create: vi.fn() },
    orderStatusLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  shipmentBlocks: vi.fn(),
  resolveDeliveryFee: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: vi.fn() }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/operations', () => ({ shipmentBlocks: (...a: unknown[]) => shipmentBlocks(...a) }));
// The REAL codForOrder — only the fee lookup is replaced, so the money maths
// under test is the production function.
vi.mock('@/lib/delivery-fees', async (orig) => ({
  ...(await orig<typeof import('@/lib/delivery-fees')>()),
  resolveDeliveryFee: (...a: unknown[]) => resolveDeliveryFee(...a),
}));
vi.mock('@/lib/order-state', async (orig) => ({
  ...(await orig<typeof import('@/lib/order-state')>()),
  assertReadyToShip: () => ({ allowed: true }),
}));

import { POST } from '@/app/api/ops/shipments/route';

const PROVIDER = '11111111-1111-4111-8111-111111111111';
const ORDER_ID = '22222222-2222-4222-8222-222222222222';

const order = (over: Record<string, unknown> = {}) => ({
  id: ORDER_ID, orderNumber: 'SY-2026-0155', companyId: 'c1', storeId: 's1', customerId: 'cu1', regionId: 'r1',
  confirmationStatus: 'CONFIRMED', shippingStatus: 'NOT_READY', shippedAt: null, priceIncludesDelivery: false,
  deliveryProviderId: null, version: 1,
  items: [{ quantity: 1, freeQuantity: 0, reservedQty: 1, unitPrice: 20, discountShare: 0 }],
  addOns: [{ quantity: 1, price: 12 }],
  ...over,
});

const post = () =>
  POST(
    new Request('http://localhost/api/ops/shipments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deliveryProviderId: PROVIDER, orderIds: [ORDER_ID] }),
    })
  );

const writtenTotal = () => db.order.update.mock.calls[0][0].data.totalAmount;

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', role: 'WAREHOUSE' },
    companyId: 'c1', storeId: 's1',
    country: { minorUnit: 2, allowNegativeStock: false },
  });
  db.deliveryProvider.findFirst.mockResolvedValue({ id: PROVIDER });
  shipmentBlocks.mockResolvedValue([]);
  resolveDeliveryFee.mockResolvedValue({ fee: 3, lateThresholdDays: 5, returnFee: 0, source: 'TABLE' });
  db.shippingBatch.findFirst.mockResolvedValue(null);
  db.shippingBatch.count.mockResolvedValue(0);
  db.shippingBatch.create.mockResolvedValue({ id: 'b1', batchNumber: 'BATCH-1' });
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  db.order.update.mockResolvedValue({});
  db.orderStatusLog.create.mockResolvedValue({});
});

describe('the COD snapshot taken at shipment', () => {
  it('includes the add-on: 20 + 12 + fee 3 = 35', async () => {
    db.order.findMany.mockResolvedValue([order()]);
    const res = await post();
    expect(res.status).toBe(201);
    expect(writtenTotal()).toBe(35);
  });

  it('never collects less than the lines plus the add-ons — the regression', async () => {
    // What the old code wrote: the lines and the fee, the add-on gone.
    db.order.findMany.mockResolvedValue([order()]);
    await post();
    expect(writtenTotal()).not.toBe(23);
  });

  it('asks the database for the add-ons at all', async () => {
    db.order.findMany.mockResolvedValue([order()]);
    await post();
    expect(db.order.findMany.mock.calls[0][0].select.addOns).toBeTruthy();
  });

  it('counts every add-on at its quantity', async () => {
    db.order.findMany.mockResolvedValue([order({ addOns: [{ quantity: 2, price: 12 }, { quantity: 1, price: 5.5 }] })]);
    await post();
    expect(writtenTotal()).toBe(20 + 24 + 5.5 + 3);
  });

  it('takes a Decimal price as Prisma returns it', async () => {
    db.order.findMany.mockResolvedValue([order({ addOns: [{ quantity: 1, price: { toString: () => '12.00' } }] })]);
    await post();
    expect(writtenTotal()).toBe(35);
  });

  it('leaves an order with no add-ons exactly as before', async () => {
    db.order.findMany.mockResolvedValue([order({ addOns: [] })]);
    await post();
    expect(writtenTotal()).toBe(23);
  });

  it('keeps the fee out of the COD on a store whose prices include delivery', async () => {
    db.order.findMany.mockResolvedValue([order({ priceIncludesDelivery: true })]);
    await post();
    expect(writtenTotal()).toBe(32);
  });
});
