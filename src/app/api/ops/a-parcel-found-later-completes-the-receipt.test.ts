import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A PARCEL WRITTEN OFF AS LOST TURNS UP — THE DESK COMPLETES THE SAME RECEIPT.
 *
 * A write-off leaves a receipt of received 0, damaged 0, everything missing (the shape of a zero count). The desk
 * used to answer «already received» to any order that had a receipt, so a parcel that came after all could not be
 * counted in. Now it completes THAT receipt — one receipt per order — and the shelf gets the units back.
 */

const { db, requireContext, requirePermission, logAudit, reverseForOrder, restoreOrderStock } = vi.hoisted(() => ({
  reverseForOrder: vi.fn(async (..._a: unknown[]) => 1),
  restoreOrderStock: vi.fn(async (..._a: unknown[]) => ({ restored: 0, alreadyDone: false })),
  db: {
    order: { findFirst: vi.fn(), update: vi.fn() },
    returnReceipt: { create: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
    orderItem: { updateMany: vi.fn() },
    orderNote: { create: vi.fn() },
    deliveryFee: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ can: () => true, requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/commission', () => ({ reverseForOrder }));
vi.mock('@/lib/stock-consumption', () => ({ restoreOrderStock: (...a: unknown[]) => restoreOrderStock(...a) }));

import { POST } from '@/app/api/ops/returns/route';

const ORDER_ID = '77777777-7777-4777-8777-777777777777';
const post = (b: Record<string, unknown>) =>
  POST(
    new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: ORDER_ID, countedAndInspected: true, ...b }),
    })
  );

/** What a write-off leaves: four units were to come back, none did. */
const LOSS = { id: 'rr1', receivedQty: 0, damagedQty: 0, missingQty: 4, courierFeeCharged: false };

const orderWith = (returnReceipt: Record<string, unknown> | null, shippingStatus = 'RETURNED') => ({
  id: ORDER_ID,
  orderNumber: 'ORD-1',
  shippingStatus,
  settlementStatus: 'NOT_APPLICABLE',
  regionId: 'r1',
  deliveryProviderId: 'dp1',
  returnReceipt,
  items: [{ id: 'i1', productId: 'p1', productName: 'مقشر', quantity: 3, freeQuantity: 1 }],
});

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u-desk' },
    companyId: 'c1',
    storeId: 's1',
    country: { minorUnit: 3, currencyCode: 'JOD' },
  });
  requirePermission.mockResolvedValue({});
  db.$transaction.mockImplementation(async (fn: any) => fn(db));
  db.order.findFirst.mockResolvedValue(orderWith(LOSS));
  db.returnReceipt.updateMany.mockResolvedValue({ count: 1 });
  db.returnReceipt.findUniqueOrThrow.mockResolvedValue({ id: 'rr1', receivedQty: 3, damagedQty: 1, missingQty: 0 });
  db.returnReceipt.create.mockImplementation(async ({ data }: any) => ({ id: 'rr-new', ...data }));
});

describe('the parcel that was written off arrives', () => {
  it('completes the SAME receipt — updated in place, a second one is never opened', async () => {
    const res = await post({ receivedQty: 3, damagedQty: 1 });
    expect(res.status).toBe(201);
    expect(db.returnReceipt.create).not.toHaveBeenCalled();
    expect(db.returnReceipt.updateMany).toHaveBeenCalledTimes(1);
    const { where, data } = db.returnReceipt.updateMany.mock.calls[0][0];
    // the guard is in the question: only a receipt that STILL says nothing came back can be completed
    expect(where).toEqual({ orderId: ORDER_ID, receivedQty: 0, damagedQty: 0, missingQty: { gt: 0 } });
    expect(data).toMatchObject({ expectedQty: 4, receivedQty: 3, damagedQty: 1, missingQty: 0, inspectedById: 'u-desk', stockRestored: true });
    expect(data.inspectedAt).toBeInstanceOf(Date);
  });

  it('gives the units back to the shelf, once', async () => {
    await post({ receivedQty: 3, damagedQty: 1 });
    expect(restoreOrderStock).toHaveBeenCalledTimes(1);
    expect(restoreOrderStock.mock.calls[0][1]).toMatchObject({ orderId: ORDER_ID, receivedQty: 3, damagedQty: 1 });
  });

  it('leaves the order as the write-off closed it — no new status, no new moment, no settlement rewritten', async () => {
    await post({ receivedQty: 2, damagedQty: 0 });
    const { data } = db.order.update.mock.calls[0][0];
    expect(Object.keys(data)).toEqual(['version']);
  });

  it('what is still missing is worked out, never typed: 4 expected, 2 here, 2 short', async () => {
    await post({ receivedQty: 2, damagedQty: 0 });
    expect(db.returnReceipt.updateMany.mock.calls[0][0].data).toMatchObject({ receivedQty: 2, missingQty: 2 });
  });

  it('says in the note that it came after the loss was closed, and in the audit trail', async () => {
    await post({ receivedQty: 3, damagedQty: 1 });
    expect(db.orderNote.create.mock.calls[0][0].data.body).toMatch(/^وصل الطرد بعد إغلاقه بلا استلام — استلام مرتجع: وصل 3، تالف 1، ناقص 0/);
    expect(logAudit.mock.calls[0][0].newData).toMatchObject({ completesLossReceipt: true, received: 3, damaged: 1 });
  });

  it('a courier fee the first receipt already carried is not taken twice or changed', async () => {
    db.order.findFirst.mockResolvedValue(orderWith({ ...LOSS, courierFeeCharged: true }));
    await post({ receivedQty: 3, damagedQty: 1, chargeCourierFee: false });
    const { data } = db.returnReceipt.updateMany.mock.calls[0][0];
    expect(data).not.toHaveProperty('courierFeeCharged');
    expect(data).not.toHaveProperty('courierFeeAmount');
  });

  it('NEGATIVE: two clerks at once — the second finds no such receipt, is refused, and restores nothing', async () => {
    db.returnReceipt.updateMany.mockResolvedValue({ count: 0 });
    const res = await post({ receivedQty: 3, damagedQty: 1 });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ALREADY_RECEIVED');
    expect(restoreOrderStock).not.toHaveBeenCalled();
    expect(db.order.update).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe('and what is still refused', () => {
  it('NEGATIVE: a second zero count over a closed loss changes nothing', async () => {
    const res = await post({ receivedQty: 0, damagedQty: 0 });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ALREADY_RECEIVED');
    expect(db.returnReceipt.updateMany).not.toHaveBeenCalled();
    expect(restoreOrderStock).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a receipt that already holds units is final — completing it would count the parcel twice', async () => {
    db.order.findFirst.mockResolvedValue(orderWith({ id: 'rr1', receivedQty: 2, damagedQty: 0, missingQty: 2, courierFeeCharged: false }));
    const res = await post({ receivedQty: 2, damagedQty: 0 });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ALREADY_RECEIVED');
    expect(db.returnReceipt.updateMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: more than was expected is still refused', async () => {
    const res = await post({ receivedQty: 4, damagedQty: 1 });
    expect(res.status).toBe(400);
    expect(db.returnReceipt.updateMany).not.toHaveBeenCalled();
  });
});

describe('and the ordinary first count is exactly what it was', () => {
  it('creates the receipt, and closes the order as RETURNED', async () => {
    db.order.findFirst.mockResolvedValue(orderWith(null, 'RETURN_REQUESTED'));
    const res = await post({ receivedQty: 3, damagedQty: 0 });
    expect(res.status).toBe(201);
    expect(db.returnReceipt.updateMany).not.toHaveBeenCalled();
    expect(db.returnReceipt.create.mock.calls[0][0].data).toMatchObject({
      orderId: ORDER_ID, expectedQty: 4, receivedQty: 3, damagedQty: 0, missingQty: 1, stockRestored: true,
    });
    expect(db.order.update.mock.calls[0][0].data).toMatchObject({ shippingStatus: 'RETURNED', settlementStatus: 'NOT_APPLICABLE' });
    expect(db.orderNote.create.mock.calls[0][0].data.body).toMatch(/^استلام مرتجع/);
  });
});
