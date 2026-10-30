import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE PACKING TABLE'S PEN, AT THE DOOR (30/10, `ops.edit_in_batch`).
 *
 * The owner: «بدي تعديل حصري لموظفة التجهيز تقدر تعدل قبل ما تغلق الباتش … وبعد ما تغلق ما تقدر تعدل شي».
 *
 * A CONFIRMED order is edited by a request (CHANGE_REQUEST_REQUIRED). The holder of this key may, instead, write a
 * name, a phone, a governorate, an address or a quantity straight onto the order — while the order sits in a batch that
 * is still OPEN. Every claim below has its negative beside it: no key, a closed trolley, a price, a swapped product, an
 * order of another store, a quantity of nothing.
 *
 * These run the real door and read the answer. The database is a set of stubs: what is asserted is what the door
 * WRITES, in which order, and what it refuses before it writes anything.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, can, authorize, assertOrderAccess, logAudit, reserveOrderLines, availableStock, releaseCourierParcel, calls } = vi.hoisted(() => ({
  db: {
    order: { findUnique: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
    orderChangeRequest: { findFirst: vi.fn() },
    shippingBatch: { findFirst: vi.fn() },
    orderItem: { findMany: vi.fn(), findFirst: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
    orderAddOn: { findMany: vi.fn() },
    product: { findMany: vi.fn(), findFirst: vi.fn() },
    region: { findFirst: vi.fn() },
    deliveryFee: { findFirst: vi.fn() },
    customer: { findFirst: vi.fn(), update: vi.fn() },
    orderActivity: { create: vi.fn() },
    orderStatusLog: { create: vi.fn() },
    user: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  can: vi.fn(),
  authorize: vi.fn(),
  assertOrderAccess: vi.fn(),
  logAudit: vi.fn(),
  reserveOrderLines: vi.fn(),
  availableStock: vi.fn(),
  releaseCourierParcel: vi.fn(),
  calls: [] as string[],
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  can: (...a: unknown[]) => can(...a),
  authorize: (...a: unknown[]) => authorize(...a),
  getPermissionScope: () => null,
  requirePermission: vi.fn(),
}));
vi.mock('@/lib/rbac', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a),
  assertOrderReadable: vi.fn(),
}));
vi.mock('@/lib/reservation', () => ({
  reserveOrderLines: (...a: unknown[]) => reserveOrderLines(...a),
  availableStock: (...a: unknown[]) => availableStock(...a),
}));
vi.mock('@/lib/order-cancel', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  releaseCourierParcel: (...a: unknown[]) => releaseCourierParcel(...a),
}));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: vi.fn() }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/notify', () => ({ notify: vi.fn() }));

import { PATCH } from './route';

const ORDER_ID = '11111111-2222-4333-8444-555555555555';
const P1 = 'prod-aaaa-1';
const P2 = 'prod-bbbb-2';
const REGION = '22222222-2222-4222-8222-222222222222';

/**
 * Confirmed, on a trolley still being filled: three pieces at 12 each, delivery 3.
 *
 * The fee is where a BATCHED order keeps it: `deliveryFee` (the courier's table, snapshotted when the order went on the
 * trolley) with `shippingCost` left at 0 — which is what `ops/shipments` writes (it never touches `shippingCost`).
 */
const baseOrder = () => ({
  id: ORDER_ID, companyId: 'c1', storeId: 's1', countryId: 'co1', customerId: 'cu1', version: 3, orderNumber: 'SY-1',
  status: 'CONFIRMED', confirmationStatus: 'CONFIRMED', shippingStatus: 'READY_FOR_PICKUP', shippedAt: null,
  labelPrintedAt: null, shippingBatchId: 'b1', deliveryProviderId: 'dp1', trackingNumber: null, courierSendStartedAt: null,
  claimedById: null, lockedById: null, lockExpiresAt: null, regionId: 'r-old', moderatorId: 'u9',
  quantity: 3, sellingPrice: 36, discountAmount: 0, shippingCost: 0, deliveryFee: 3, totalAmount: 39, productId: P1, productNameSnapshot: 'كريم',
  priceIncludesDelivery: false,
});
let ORDER: ReturnType<typeof baseOrder>;

/** Which keys the caller holds. */
const holds = (...keys: string[]) => {
  can.mockImplementation((_u: unknown, k: string) => keys.includes(k));
  authorize.mockImplementation((_u: unknown, k: string, resource?: { companyId?: string }) =>
    keys.includes(k) && (!resource || resource.companyId === 'c1') ? { allowed: true } : { allowed: false, reason: 'NO_PERMISSION' }
  );
};

const patch = async (body: Record<string, unknown>) => {
  const res = await PATCH(
    new Request(`http://localhost/api/orders/${ORDER_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 3, ...body }),
    }),
    { params: Promise.resolve({ id: ORDER_ID }) }
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

const wrote = () => db.order.updateMany.mock.calls[0][0] as { where: Record<string, any>; data: Record<string, any> };
const activities = () => db.orderActivity.create.mock.calls.map((c: any[]) => c[0].data);
const lineRows = () => db.orderItem.createMany.mock.calls[0][0].data as Array<Record<string, any>>;

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  ORDER = baseOrder();
  requireContext.mockResolvedValue({
    user: { id: 'prep1', name: 'سارة', role: 'WAREHOUSE', companyId: 'c1' },
    companyId: 'c1', storeId: 's1',
    country: { code: 'JO', currencyCode: 'JOD', minorUnit: 2, allowNegativeStock: false },
  });
  holds('ops.batches', 'ops.edit_in_batch');
  // The ordinary door: she holds no order key, so the order is not hers to open that way.
  assertOrderAccess.mockResolvedValue({ allowed: false, reason: 'NOT_ASSIGNED' });
  db.order.findUnique.mockImplementation(async () => ({ ...ORDER }));
  db.shippingBatch.findFirst.mockResolvedValue({ status: 'READY', batchNumber: 'BATCH-7' });
  db.orderChangeRequest.findFirst.mockResolvedValue(null);
  db.orderItem.findMany.mockResolvedValue([{ productId: P1, productName: 'كريم', quantity: 3, lineTotal: 36, discountShare: 0, freeQuantity: 0 }]);
  db.deliveryFee.findFirst.mockResolvedValue({ fee: 3, lateThresholdDays: 0, returnFee: 0 });
  availableStock.mockResolvedValue(100);
  releaseCourierParcel.mockResolvedValue({
    ok: true, courierCancelled: true, cleared: { trackingNumber: null, courierSendStartedAt: null },
    remote: { kind: 'CANCELLED', courier: 'الباشا', barcode: 'BC1' },
  });
  db.orderItem.findFirst.mockResolvedValue(null);
  db.orderItem.deleteMany.mockImplementation(async () => { calls.push('delete lines'); return { count: 1 }; });
  db.orderItem.createMany.mockImplementation(async () => { calls.push('write lines'); return { count: 1 }; });
  db.orderAddOn.findMany.mockResolvedValue([]);
  db.product.findMany.mockImplementation(async (a: any) => a.where.id.in.map((id: string) => ({ id, name: id === P1 ? 'كريم' : 'عطر', basePrice: 12 })));
  db.region.findFirst.mockResolvedValue({ id: REGION, name: 'السويداء' });
  db.customer.findFirst.mockResolvedValue(null);
  db.customer.update.mockResolvedValue({});
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.orderActivity.create.mockResolvedValue({});
  db.orderStatusLog.create.mockResolvedValue({});
  db.$transaction.mockImplementation(async (fn: never) => (typeof fn === 'function' ? (fn as (tx: unknown) => unknown)(db) : fn));
  reserveOrderLines.mockImplementation(async () => { calls.push('reserve'); return { reserved: 1, shortages: [] }; });
});

describe('(أ) the holder of the key, on a confirmed order in an open batch', () => {
  it('corrects the name, the phone and the address in place — written on the SAME order, at the version she read', async () => {
    const res = await patch({ customerName: 'سارة أحمد', customerPhone: '0791234567', customerAddress: 'شارع الجلاء' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
    expect(wrote().where).toMatchObject({ id: ORDER_ID, version: 3 });
    const customer = db.customer.update.mock.calls[0][0];
    expect(customer.where).toEqual({ id: 'cu1' });
    expect(customer.data).toMatchObject({ fullName: 'سارة أحمد', address: 'شارع الجلاء', rawPhone: '0791234567' });
  });

  it('moves the governorate, and the written city follows it', async () => {
    const res = await patch({ regionId: REGION });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(wrote().data.regionId).toBe(REGION);
    expect(db.customer.update.mock.calls[0][0].data.city).toBe('السويداء');
  });

  it('raises a quantity at the SAME piece price: 3 at 12 becomes 5 at 12, through the one calculator', async () => {
    const res = await patch({ items: [{ productId: P1, quantity: 5, unitPrice: 60 }] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(lineRows()).toHaveLength(1);
    expect(lineRows()[0]).toMatchObject({ productId: P1, quantity: 5, lineTotal: 60, unitPrice: 12 });
    expect(wrote().data).toMatchObject({ quantity: 5, sellingPrice: 60, totalAmount: 63, discountAmount: 0 });
    // The fee is the courier's snapshot: this door neither reads it from `shippingCost` (0 here) nor writes it.
    expect(wrote().data).not.toHaveProperty('shippingCost');
  });

  it('CLAIM: the price the browser sends for a line is ignored — the door rebuilds it from the stored line', async () => {
    for (const sent of [1, 0, 9999]) {
      db.order.updateMany.mockClear();
      db.orderItem.createMany.mockClear();
      const res = await patch({ items: [{ productId: P1, quantity: 5, unitPrice: sent }] });
      expect(res.status, `sent ${sent}: ${JSON.stringify(res.body)}`).toBe(200);
      expect(lineRows()[0], `sent ${sent}`).toMatchObject({ quantity: 5, lineTotal: 60, unitPrice: 12 });
      expect(wrote().data.totalAmount, `sent ${sent}`).toBe(63);
    }
  });

  it('lowers a quantity the same way: 3 at 12 becomes 2 at 12', async () => {
    const res = await patch({ items: [{ productId: P1, quantity: 2, unitPrice: 36 }] });

    expect(res.status).toBe(200);
    expect(lineRows()[0]).toMatchObject({ quantity: 2, lineTotal: 24 });
    expect(wrote().data).toMatchObject({ quantity: 2, sellingPrice: 24, totalAmount: 27 });
  });

  // (old → new, 30/10, review of #116) This claim used to read «a quantity change keeps the accepted add-ons in the total» (68).
  // The reviewers showed the add-on is reserved apart from the lines and the total was only ever as right as that sum; the
  // decision is that an order with an add-on takes its quantity by REQUEST. What stays true: an add-on order still takes the
  // fields that carry no money, and the total it was collected with is not recomputed.
  it('an order with an accepted add-on takes a name and keeps its total untouched', async () => {
    db.orderAddOn.findMany.mockResolvedValue([{ quantity: 1, price: 5 }]);

    const res = await patch({ customerName: 'سارة أحمد' });

    expect(res.status).toBe(200);
    expect(wrote().data).not.toHaveProperty('totalAmount');
  });

  it('the shelf follows the quantity through the one reserver — after the new rows are written, never before', async () => {
    await patch({ items: [{ productId: P1, quantity: 5, unitPrice: 60 }] });

    expect(calls).toEqual(['delete lines', 'write lines', 'reserve']);
    expect(reserveOrderLines).toHaveBeenCalledTimes(1);
    expect(reserveOrderLines.mock.calls[0][1]).toBe(ORDER_ID);
    expect(reserveOrderLines.mock.calls[0][2]).toEqual({ allowNegativeStock: false });
  });

  it('a name alone touches no lines and reserves nothing', async () => {
    await patch({ customerName: 'سارة أحمد' });

    expect(db.orderItem.deleteMany).not.toHaveBeenCalled();
    expect(reserveOrderLines).not.toHaveBeenCalled();
  });

  it('a shelf that cannot cover the new quantity refuses by name and the write is thrown away', async () => {
    reserveOrderLines.mockImplementation(async () => ({ reserved: 0, shortages: [{ orderItemId: 'i1', productId: P1, productName: 'كريم', missing: 2 }] }));

    const res = await patch({ items: [{ productId: P1, quantity: 5, unitPrice: 60 }] });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PREP_SHORTAGE');
    expect(res.body.errorAr).toContain('كريم');
    // The audit line is written only after the transaction commits: a refused write leaves none.
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('where the country lets stock go negative, the shortage is recorded and the edit stands', async () => {
    requireContext.mockResolvedValue({
      user: { id: 'prep1', name: 'سارة', role: 'WAREHOUSE', companyId: 'c1' }, companyId: 'c1', storeId: 's1',
      country: { code: 'JO', currencyCode: 'JOD', minorUnit: 2, allowNegativeStock: true },
    });
    reserveOrderLines.mockResolvedValue({ reserved: 1, shortages: [{ orderItemId: 'i1', productId: P1, productName: 'كريم', missing: 2 }] });

    const res = await patch({ items: [{ productId: P1, quantity: 5, unitPrice: 60 }] });

    expect(res.status).toBe(200);
    expect(reserveOrderLines.mock.calls[0][2]).toEqual({ allowNegativeStock: true });
  });

  it('an order with no governorate still takes a name, and takes one when she picks it', async () => {
    ORDER.regionId = null as never;

    expect((await patch({ customerName: 'سارة أحمد' })).status).toBe(200);
    db.order.updateMany.mockClear();
    expect((await patch({ regionId: REGION })).status).toBe(200);
    expect(wrote().data.regionId).toBe(REGION);
  });

  it('a printed waybill is cleared in the same write and said on the order — it is printed again', async () => {
    ORDER.labelPrintedAt = new Date('2026-10-29T08:00:00Z') as never;

    const res = await patch({ customerAddress: 'شارع الجلاء' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(wrote().data.labelPrintedAt).toBeNull();
    expect(activities().some((a: any) => a.action === 'LABEL_STALE_REPRINT')).toBe(true);
  });
});

describe('(أ) and her name is on it', () => {
  it('writes a timeline line by her, the fields and the quantities before and after — and no customer data', async () => {
    await patch({ customerName: 'سارة أحمد', customerPhone: '0791234567', items: [{ productId: P1, quantity: 5, unitPrice: 60 }] });

    const line = activities().find((a: any) => a.action === 'PREP_EDITED_BEFORE_CLOSE');
    expect(line).toBeTruthy();
    expect(line).toMatchObject({ orderId: ORDER_ID, userId: 'prep1', companyId: 'c1' });
    const meta = JSON.parse(line.metadata);
    expect(meta).toMatchObject({ updatedBy: 'سارة', batch: 'BATCH-7', fields: ['customerName', 'customerPhone', 'items'] });
    expect(meta.quantities).toEqual([{ productId: P1, before: 3, after: 5 }]);
    expect(line.metadata).not.toContain('0791234567');
    expect(line.metadata).not.toContain('سارة أحمد');
  });

  it('writes an audit entry of its own, with what changed and no more than the existing edit carries', async () => {
    await patch({ customerName: 'سارة أحمد', items: [{ productId: P1, quantity: 5, unitPrice: 60 }] });

    expect(logAudit).toHaveBeenCalledTimes(1);
    const entry = logAudit.mock.calls[0][0];
    expect(entry).toMatchObject({ action: 'ORDER_UPDATED_IN_BATCH', userId: 'prep1', entity: 'Order', entityId: ORDER_ID });
    expect(entry.newData.prepEdit).toEqual({
      by: 'سارة', fields: ['customerName', 'items'], batch: 'BATCH-7',
      quantities: [{ productId: P1, before: 3, after: 5 }],
    });
    expect(JSON.stringify(entry.newData.prepEdit)).not.toContain('سارة أحمد');
  });
});

describe('(ب) without the key, a confirmed order is a request, exactly as today', () => {
  beforeEach(() => {
    // The same person, the ordinary keys, no packing-table key.
    holds('orders.view', 'orders.edit', 'ops.batches');
    assertOrderAccess.mockResolvedValue({ allowed: true, order: { ...ORDER } });
  });

  it('answers CHANGE_REQUEST_REQUIRED and writes nothing', async () => {
    const res = await patch({ customerName: 'سارة أحمد' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CHANGE_REQUEST_REQUIRED');
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.customer.update).not.toHaveBeenCalled();
  });

  it('and a quantity is refused the same way', async () => {
    const res = await patch({ items: [{ productId: P1, quantity: 5, unitPrice: 60 }] });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CHANGE_REQUEST_REQUIRED');
    expect(db.orderItem.deleteMany).not.toHaveBeenCalled();
  });

  it('a person with no order key at all is told the order is not found, not the way round', async () => {
    holds('ops.batches');
    assertOrderAccess.mockResolvedValue({ allowed: false, reason: 'NOT_ASSIGNED' });

    const res = await patch({ customerName: 'سارة أحمد' });

    expect(res.status).toBe(404);
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });
});

describe('(ج) once the shipment is closed, nothing is edited', () => {
  it('a batch handed to the company seals it — the seal’s own words, nothing written', async () => {
    db.shippingBatch.findFirst.mockResolvedValue({ status: 'SHIPPED', batchNumber: 'BATCH-7' });

    const res = await patch({ customerName: 'سارة أحمد' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ORDER_SEALED');
    expect(res.body.errorAr).toContain('BATCH-7');
    expect(res.body.errorAr).toContain('طلب تعديل');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('a settled batch seals it too', async () => {
    db.shippingBatch.findFirst.mockResolvedValue({ status: 'CLOSED', batchNumber: 'BATCH-7' });

    const res = await patch({ items: [{ productId: P1, quantity: 5, unitPrice: 60 }] });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ORDER_SEALED');
    expect(db.orderItem.deleteMany).not.toHaveBeenCalled();
  });

  it('THE RACE: the form was read while the trolley was open and saved after it was closed', async () => {
    expect((await patch({ customerName: 'سارة أحمد' })).status).toBe(200);
    db.order.updateMany.mockClear();
    // Between the two, somebody pressed «إغلاق الشحنة — سُلّمت للشركة».
    db.shippingBatch.findFirst.mockResolvedValue({ status: 'SHIPPED', batchNumber: 'BATCH-7' });
    ORDER.shippingStatus = 'SHIPPED';
    ORDER.shippedAt = new Date() as never;

    const res = await patch({ customerName: 'اسم آخر' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ORDER_SEALED');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('a parcel that left on its own is sealed although its batch is still open', async () => {
    ORDER.shippedAt = new Date() as never;

    const res = await patch({ customerAddress: 'شارع آخر' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ORDER_SEALED');
  });

  it('even a person who ALSO holds the order keys is sealed — the key lifts nothing once it has shut', async () => {
    holds('orders.view', 'orders.edit', 'ops.batches', 'ops.edit_in_batch');
    assertOrderAccess.mockResolvedValue({ allowed: true, order: { ...ORDER } });
    db.shippingBatch.findFirst.mockResolvedValue({ status: 'SHIPPED', batchNumber: 'BATCH-7' });

    const res = await patch({ customerName: 'سارة أحمد' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ORDER_SEALED');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });
});

describe('(د) a price, a discount, a fee or another product never passes through this key', () => {
  beforeEach(() => {
    // She also holds the order keys here, so the only thing between the request and the write is the price gate itself.
    holds('orders.view', 'orders.edit', 'ops.batches', 'ops.edit_in_batch');
    assertOrderAccess.mockResolvedValue({ allowed: true, order: { ...ORDER } });
  });

  it('a new line price is refused as a price change', async () => {
    const res = await patch({ sellingPrice: 10 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PRICE_FORBIDDEN');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('a discount is refused', async () => {
    const res = await patch({ discountAmount: 5 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PRICE_FORBIDDEN');
  });

  it('a delivery fee is refused', async () => {
    const res = await patch({ shippingCost: 0 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SHIPPING_FORBIDDEN');
  });

  it('a name together with a price is not the key’s request: the name does not carry the price in', async () => {
    const res = await patch({ customerName: 'سارة أحمد', sellingPrice: 10 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PRICE_FORBIDDEN');
    expect(db.customer.update).not.toHaveBeenCalled();
  });

  it('another product on a line is refused by name, and nothing is written', async () => {
    const res = await patch({ items: [{ productId: P2, quantity: 3, unitPrice: 36 }] });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PREP_GOODS_ONLY');
    expect(db.orderItem.deleteMany).not.toHaveBeenCalled();
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('a product ADDED to the order, or one DROPPED, is refused the same way', async () => {
    const added = await patch({ items: [{ productId: P1, quantity: 3, unitPrice: 36 }, { productId: P2, quantity: 1, unitPrice: 5 }] });
    expect(added.body.code).toBe('PREP_GOODS_ONLY');

    db.orderItem.findMany.mockResolvedValue([
      { productId: P1, quantity: 3, lineTotal: 36, discountShare: 0 },
      { productId: P2, quantity: 1, lineTotal: 5, discountShare: 0 },
    ]);
    const dropped = await patch({ items: [{ productId: P1, quantity: 3, unitPrice: 36 }] });
    expect(dropped.body.code).toBe('PREP_GOODS_ONLY');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('the single-line shorthand for a quantity is not the key’s either', async () => {
    const res = await patch({ quantity: 5 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CHANGE_REQUEST_REQUIRED');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });
});

describe('(هـ) an order outside her reach answers as it does today', () => {
  it('an order of ANOTHER STORE is not found', async () => {
    ORDER.storeId = 's2';

    const res = await patch({ customerName: 'سارة أحمد' });

    expect(res.status).toBe(404);
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('an order of ANOTHER COMPANY is not found', async () => {
    ORDER.companyId = 'c2';

    const res = await patch({ customerName: 'سارة أحمد' });

    expect(res.status).toBe(404);
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('an order that is not confirmed is not the packing table’s: she is told it is not found', async () => {
    ORDER.confirmationStatus = 'NEW';

    const res = await patch({ customerName: 'سارة أحمد' });

    expect(res.status).toBe(404);
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('a confirmed order with no batch at all is not hers either', async () => {
    ORDER.shippingBatchId = null as never;

    const res = await patch({ customerName: 'سارة أحمد' });

    expect(res.status).toBe(404);
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('a key held with a scope that is not «كل الشركة» opens nothing', async () => {
    authorize.mockReturnValue({ allowed: false, reason: 'OUT_OF_SCOPE' });

    const res = await patch({ customerName: 'سارة أحمد' });

    expect(res.status).toBe(404);
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });
});

describe('the edge cases of a quantity', () => {
  it('zero is refused before anything is read', async () => {
    const res = await patch({ items: [{ productId: P1, quantity: 0, unitPrice: 0 }] });

    expect(res.status).toBe(400);
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.orderItem.deleteMany).not.toHaveBeenCalled();
  });

  it('a negative one is refused the same way', async () => {
    const res = await patch({ items: [{ productId: P1, quantity: -2, unitPrice: 0 }] });

    expect(res.status).toBe(400);
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('a line already delivered or returned is a record: its quantity is not rewritten', async () => {
    db.orderItem.findFirst.mockResolvedValue({ id: 'i1' });

    const res = await patch({ items: [{ productId: P1, quantity: 5, unitPrice: 60 }] });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LINES_COMMITTED');
    expect(db.orderItem.deleteMany).not.toHaveBeenCalled();
  });

  it('a version she did not read is a conflict, not an overwrite', async () => {
    db.order.updateMany.mockResolvedValue({ count: 0 });

    const res = await patch({ customerName: 'سارة أحمد' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VERSION_CONFLICT');
  });

  it('a phone that is not a phone for the country is refused', async () => {
    const res = await patch({ customerPhone: '1111111' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PHONE');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * THE REVIEWS OF #116 (30/10) — each claim runs the door, and each has the case that hid the defect.
 * ═══════════════════════════════════════════════════════════════════════ */

describe('(مال) the delivery fee is not lost from the total', () => {
  it('a BATCHED order keeps its fee in deliveryFee and shippingCost 0: 3 at 12 + 3 becomes 5 at 12 + 3 = 63, not 60', async () => {
    expect(ORDER.shippingCost).toBe(0);
    expect(ORDER.deliveryFee).toBe(3);

    const res = await patch({ items: [{ productId: P1, quantity: 5, unitPrice: 60 }] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(wrote().data.totalAmount).toBe(63);
  });

  it('deliveryFee wins over a stale shippingCost, as it does where the total was written', async () => {
    ORDER.shippingCost = 7 as never;

    await patch({ items: [{ productId: P1, quantity: 5, unitPrice: 60 }] });

    expect(wrote().data.totalAmount).toBe(63);
  });

  it('an order with no deliveryFee falls back to its own shippingCost', async () => {
    ORDER.deliveryFee = null as never;
    ORDER.shippingCost = 3 as never;

    await patch({ items: [{ productId: P1, quantity: 5, unitPrice: 60 }] });

    expect(wrote().data.totalAmount).toBe(63);
  });

  it('a store order (shippingCost 0 and no fee yet) is 5 at 12 = 60 — nothing is invented', async () => {
    ORDER.deliveryFee = null as never;
    ORDER.shippingCost = 0 as never;

    await patch({ items: [{ productId: P1, quantity: 5, unitPrice: 60 }] });

    expect(wrote().data.totalAmount).toBe(60);
  });

  it('a price that already INCLUDES delivery does not add the fee again: 5 at 12 = 60', async () => {
    (ORDER as Record<string, unknown>).priceIncludesDelivery = true;

    await patch({ items: [{ productId: P1, quantity: 5, unitPrice: 60 }] });

    expect(wrote().data.totalAmount).toBe(60);
    expect(wrote().data.sellingPrice).toBe(60);
  });

  it('there and back again: 3 to 5 to 3 lands on the original total, because the total is rebuilt from the stored line, not added to', async () => {
    await patch({ items: [{ productId: P1, quantity: 5, unitPrice: 0 }] });
    expect(wrote().data.totalAmount).toBe(63);
    // The line as the first write left it.
    db.orderItem.findMany.mockResolvedValue([{ productId: P1, productName: 'كريم', quantity: 5, lineTotal: 60, discountShare: 0, freeQuantity: 0 }]);
    db.order.updateMany.mockClear();

    await patch({ items: [{ productId: P1, quantity: 3, unitPrice: 0 }] });

    expect(wrote().data.totalAmount).toBe(39);
  });
});

describe('(مال) a new governorate must not change what the courier charges', () => {
  it('the same fee goes through', async () => {
    db.deliveryFee.findFirst.mockResolvedValue({ fee: 3, lateThresholdDays: 0, returnFee: 0 });

    const res = await patch({ regionId: REGION });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(wrote().data.regionId).toBe(REGION);
  });

  it('a different fee is refused in words, and nothing is written', async () => {
    db.deliveryFee.findFirst.mockResolvedValue({ fee: 5, lateThresholdDays: 0, returnFee: 0 });

    const res = await patch({ customerName: 'سارة أحمد', regionId: REGION });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PREP_REGION_FEE');
    expect(res.body.errorAr).toContain('أجرة التوصيل');
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.customer.update).not.toHaveBeenCalled();
  });

  it('a governorate the courier has no row for is a fee of nothing: refused while the order carries a fee', async () => {
    db.deliveryFee.findFirst.mockResolvedValue(null);

    const res = await patch({ regionId: REGION });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PREP_REGION_FEE');
  });

  it('an order with no courier on it cannot be checked, so it is refused', async () => {
    ORDER.deliveryProviderId = null as never;

    const res = await patch({ regionId: REGION });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PREP_REGION_FEE');
    expect(db.deliveryFee.findFirst).not.toHaveBeenCalled();
  });

  it('the governorate it already has is not looked up again', async () => {
    ORDER.regionId = REGION as never;

    const res = await patch({ regionId: REGION });

    expect(res.status).toBe(200);
    expect(db.deliveryFee.findFirst).not.toHaveBeenCalled();
  });

  it('a governorate can be chosen, never cleared', async () => {
    const res = await patch({ regionId: null });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PREP_REGION_CLEAR');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });
});

describe('(مال) only an ordinary order’s quantity is changed in place', () => {
  const refused = async () => {
    const res = await patch({ items: [{ productId: P1, quantity: 5, unitPrice: 60 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('PREP_COMPLEX_ORDER');
    expect(res.body.errorAr).toContain('خصم');
    expect(db.orderItem.deleteMany).not.toHaveBeenCalled();
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(reserveOrderLines).not.toHaveBeenCalled();
  };

  it('an order with a discount', async () => {
    ORDER.discountAmount = 4 as never;
    db.orderItem.findMany.mockResolvedValue([{ productId: P1, productName: 'كريم', quantity: 3, lineTotal: 32, discountShare: 4, freeQuantity: 0 }]);
    await refused();
  });

  it('an order with a gift unit on a line', async () => {
    db.orderItem.findMany.mockResolvedValue([{ productId: P1, productName: 'كريم', quantity: 3, lineTotal: 36, discountShare: 0, freeQuantity: 1 }]);
    await refused();
  });

  it('a line that carries a share of a discount', async () => {
    db.orderItem.findMany.mockResolvedValue([{ productId: P1, productName: 'كريم', quantity: 3, lineTotal: 35, discountShare: 1, freeQuantity: 0 }]);
    await refused();
  });

  it('an order with an add-on the customer accepted', async () => {
    db.orderAddOn.findMany.mockResolvedValue([{ quantity: 1, price: 5 }]);
    await refused();
  });

  it('a product on two lines', async () => {
    db.orderItem.findMany.mockResolvedValue([
      { productId: P1, productName: 'كريم', quantity: 2, lineTotal: 24, discountShare: 0, freeQuantity: 0 },
      { productId: P1, productName: 'كريم', quantity: 1, lineTotal: 12, discountShare: 0, freeQuantity: 0 },
    ]);
    const res = await patch({ items: [{ productId: P1, quantity: 3, unitPrice: 0 }, { productId: P1, quantity: 1, unitPrice: 0 }] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PREP_COMPLEX_ORDER');
    expect(db.orderItem.deleteMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: the same orders still take a name, a phone and an address — the fields that carry no money', async () => {
    ORDER.discountAmount = 4 as never;
    db.orderAddOn.findMany.mockResolvedValue([{ quantity: 1, price: 5 }]);

    const res = await patch({ customerName: 'سارة أحمد', customerPhone: '0791234567', customerAddress: 'شارع الجلاء' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(db.orderItem.deleteMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: quantities sent back as they are rewrite nothing on such an order', async () => {
    ORDER.discountAmount = 4 as never;
    db.orderItem.findMany.mockResolvedValue([{ productId: P1, productName: 'كريم', quantity: 3, lineTotal: 32, discountShare: 4, freeQuantity: 0 }]);

    const res = await patch({ customerName: 'سارة أحمد', items: [{ productId: P1, quantity: 3, unitPrice: 36 }] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(db.orderItem.deleteMany).not.toHaveBeenCalled();
    expect(reserveOrderLines).not.toHaveBeenCalled();
  });
});

describe('(مخزون) the shelf is asked BEFORE the company is', () => {
  const PARCEL = () => {
    ORDER.trackingNumber = 'BC1' as never;
    ORDER.labelPrintedAt = new Date('2026-10-29T08:00:00Z') as never;
  };

  it('a quantity the shelf cannot cover is refused with the company never told to cancel the parcel', async () => {
    PARCEL();
    availableStock.mockResolvedValue(4);

    const res = await patch({ items: [{ productId: P1, quantity: 5, unitPrice: 60 }] });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PREP_SHORTAGE');
    expect(res.body.errorAr).toContain('كريم');
    expect(res.body.errorAr).toContain('لم يُحفظ شيء');
    expect(releaseCourierParcel).not.toHaveBeenCalled();
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('asks about this order’s own product, leaving out what this very order already holds', async () => {
    await patch({ items: [{ productId: P1, quantity: 5, unitPrice: 60 }] });

    expect(availableStock).toHaveBeenCalledWith(db, 'c1', P1, ORDER_ID);
  });

  it('enough on the shelf: the company is told, the write follows', async () => {
    PARCEL();

    const res = await patch({ items: [{ productId: P1, quantity: 5, unitPrice: 60 }] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(releaseCourierParcel).toHaveBeenCalledTimes(1);
    expect(wrote().data).toMatchObject({ trackingNumber: null, labelPrintedAt: null });
  });

  it('THE RACE: the shelf empties after the company said yes — the order says so, and the person is told the truth', async () => {
    PARCEL();
    reserveOrderLines.mockImplementation(async () => ({ reserved: 0, shortages: [{ orderItemId: 'i1', productId: P1, productName: 'كريم', missing: 2 }] }));

    const res = await patch({ items: [{ productId: P1, quantity: 5, unitPrice: 60 }] });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PREP_SHORTAGE');
    expect(res.body.errorAr).toContain('أُلغي الطرد عند شركة الشحن');
    expect(res.body.errorAr).not.toContain('لم يُحفظ شيء');
    const note = activities().find((a: any) => a.action === 'COURIER_CANCELLED_EDIT_NOT_SAVED');
    expect(note).toBeTruthy();
    expect(JSON.parse(note.metadata)).toMatchObject({ barcode: 'BC1', door: 'PREP_EDIT' });
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('NEGATIVE: with no parcel at the company, a race-lost shortage says only that nothing was saved', async () => {
    reserveOrderLines.mockImplementation(async () => ({ reserved: 0, shortages: [{ orderItemId: 'i1', productId: P1, productName: 'كريم', missing: 2 }] }));

    const res = await patch({ items: [{ productId: P1, quantity: 5, unitPrice: 60 }] });

    expect(res.body.errorAr).toContain('لم يُحفظ شيء');
    expect(activities().some((a: any) => a.action === 'COURIER_CANCELLED_EDIT_NOT_SAVED')).toBe(false);
  });
});

describe('(صلاحيات) what the packing table’s pen is answered with, and who may use it', () => {
  it('the answer carries a few fields — never the cost, the profit or the commission of the order row', async () => {
    db.order.findUnique.mockImplementation(async () => ({
      ...ORDER, grossProfit: 11, netProfit: 9, productCost: 5, advertisingCost: 2, moderatorCommission: 1, internalNotes: 'سرّ',
    }));

    const res = await patch({ customerName: 'سارة أحمد' });

    expect(res.status).toBe(200);
    const sent = JSON.stringify(res.body);
    for (const leaked of ['grossProfit', 'netProfit', 'productCost', 'advertisingCost', 'moderatorCommission', 'internalNotes']) {
      expect(sent, leaked).not.toContain(leaked);
    }
    expect(res.body.order).toMatchObject({ id: ORDER_ID, orderNumber: 'SY-1' });
  });

  it('the key without the batches screen opens nothing — a «requires» is a hint on the permissions screen, not a rule', async () => {
    holds('ops.edit_in_batch');

    const res = await patch({ customerName: 'سارة أحمد' });

    expect(res.status).toBe(404);
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('a phone that belongs to another customer is refused WITHOUT that customer’s name for the key alone', async () => {
    db.customer.findFirst.mockResolvedValue({ id: 'cu2', fullName: 'زبون آخر اسمه سرّي' });

    const res = await patch({ customerPhone: '0791234567' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_PHONE');
    expect(JSON.stringify(res.body)).not.toContain('سرّي');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('and WITH the customers key the name is said, as it always was', async () => {
    holds('ops.batches', 'ops.edit_in_batch', 'customers.view');
    db.customer.findFirst.mockResolvedValue({ id: 'cu2', fullName: 'زبون آخر اسمه سرّي' });

    const res = await patch({ customerPhone: '0791234567' });

    expect(res.body.error).toContain('زبون آخر اسمه سرّي');
  });

  it('the closed-shipment message is given only for an order of her own store’s batch — another store’s is not found, not sealed', async () => {
    db.shippingBatch.findFirst.mockResolvedValue({ status: 'SHIPPED', batchNumber: 'BATCH-7' });
    ORDER.storeId = 's2';

    const res = await patch({ customerName: 'سارة أحمد' });

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('BATCH-7');
  });

  it('and it is not given at all to someone without the batches screen', async () => {
    holds('ops.edit_in_batch');
    db.shippingBatch.findFirst.mockResolvedValue({ status: 'SHIPPED', batchNumber: 'BATCH-7' });

    const res = await patch({ customerName: 'سارة أحمد' });

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('BATCH-7');
  });
});
