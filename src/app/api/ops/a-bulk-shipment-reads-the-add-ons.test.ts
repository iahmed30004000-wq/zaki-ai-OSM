import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ط43 — THE BULK SHIPMENT READS THE ADD-ONS, AS THE MANUAL DOOR ALWAYS DID.
 *
 * An order of 20 with a 15 add-on nobody reserved was refused at the single-order door («إضافة غير محجوزة») and
 * shipped by the bulk door, which asked about the lines alone: the courier collected 35 plus the fee for goods that
 * were not on the shelf. The bulk door now asks the same question of the lines AND the add-ons, and the stock check
 * (`shipmentBlocks`) covers the add-ons too, in the words «إضافة».
 *
 * «اي قرار بعد الان اتخذو دون الرجوع الي» — decided: the add-on is NOT refused when the order is taken (the owner's
 * rule is that an order stops at the shipment); re-reserving add-ons of orders confirmed before the reservation
 * existed is a production write and is left out.
 */

const { db, requireContext, shipmentBlocks, resolveDeliveryFee } = vi.hoisted(() => ({
  db: {
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
vi.mock('@/lib/delivery-fees', async (orig) => ({
  ...(await orig<typeof import('@/lib/delivery-fees')>()),
  resolveDeliveryFee: (...a: unknown[]) => resolveDeliveryFee(...a),
}));
// The REAL assertReadyToShip — it is the thing under test.

import { POST } from '@/app/api/ops/shipments/route';
import { assertReadyToShip } from '@/lib/order-state';
import { guardLines } from '@/lib/reservation';

const PROVIDER = '11111111-1111-4111-8111-111111111111';
const ORDER_ID = '22222222-2222-4222-8222-222222222222';

const order = (addOnReserved: number, over: Record<string, unknown> = {}) => ({
  id: ORDER_ID, orderNumber: 'SY-2026-0155', companyId: 'c1', storeId: 's1', customerId: 'cu1', regionId: 'r1',
  confirmationStatus: 'CONFIRMED', shippingStatus: 'NOT_READY', shippedAt: null, priceIncludesDelivery: false,
  deliveryProviderId: null, version: 1, shippingBatchId: null, labelPrintedAt: null, shipHoldUntil: null,
  items: [{ quantity: 1, freeQuantity: 0, reservedQty: 1, unitPrice: 20, discountShare: 0, lineTotal: 20 }],
  addOns: [{ quantity: 1, price: 15, reservedQty: addOnReserved }],
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

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', role: 'WAREHOUSE' }, companyId: 'c1', storeId: 's1',
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

describe('the bulk door', () => {
  it('refuses an order whose add-on nobody reserved, and names it an add-on', async () => {
    db.order.findMany.mockResolvedValue([order(0)]);
    const res = await post();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('ALL_BLOCKED');
    expect(body.exceptions[0].reasons.join(' ')).toContain('إضافة غير محجوزة');
    expect(db.order.update).not.toHaveBeenCalled();
  });

  it('NEGATIVE: an add-on that IS reserved passes, and the shipment is made with its money', async () => {
    db.order.findMany.mockResolvedValue([order(1)]);
    const res = await post();
    expect(res.status).toBe(201);
    expect(db.order.update.mock.calls[0][0].data.totalAmount).toBe(38);
  });

  it('NEGATIVE: an order with no add-ons is judged by its lines alone, as before', async () => {
    db.order.findMany.mockResolvedValue([order(0, { addOns: [] })]);
    expect((await post()).status).toBe(201);
  });

  it('reads the add-ons\' reservation from the database at all', async () => {
    db.order.findMany.mockResolvedValue([order(1)]);
    await post();
    expect(db.order.findMany.mock.calls[0][0].select.addOns.select).toMatchObject({ reservedQty: true });
  });
});

describe('the sentence', () => {
  it('says «سطر» for a line and «إضافة» for an add-on, and both when both are short', () => {
    const line = (reservedQty: number) => ({ quantity: 1, freeQuantity: 0, reservedQty });
    const add = (reservedQty: number) => ({ quantity: 1, reservedQty });
    expect(assertReadyToShip({ confirmationStatus: 'CONFIRMED' } as never, guardLines([line(0)], [add(1)])).message).toBe(
      'لا يمكن التجهيز: 1 سطر غير محجوز بالكامل'
    );
    expect(assertReadyToShip({ confirmationStatus: 'CONFIRMED' } as never, guardLines([line(1)], [add(0)])).message).toBe(
      'لا يمكن التجهيز: 1 إضافة غير محجوزة بالكامل'
    );
    expect(assertReadyToShip({ confirmationStatus: 'CONFIRMED' } as never, guardLines([line(0)], [add(0)])).message).toBe(
      'لا يمكن التجهيز: 1 سطر غير محجوز بالكامل، و1 إضافة غير محجوزة بالكامل'
    );
  });

  it('NEGATIVE: everything reserved is allowed', () => {
    const r = assertReadyToShip(
      { confirmationStatus: 'CONFIRMED' } as never,
      guardLines([{ quantity: 2, freeQuantity: 1, reservedQty: 3 }], [{ quantity: 1, reservedQty: 1 }])
    );
    expect(r.allowed).toBe(true);
  });
});
