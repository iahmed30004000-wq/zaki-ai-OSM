import { beforeEach, describe, expect, it, vi } from 'vitest';
import { courierCancelMessage } from '@/lib/courier-change';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * AN APPROVED CANCEL ON A PARCEL THE COURIER HOLDS IS NOT A DEAD END.
 *
 * The button called stand-down, which refuses once the parcel has left —
 * and the approval stayed «waiting to be applied» for ever, the courier
 * never asked to stop the parcel. Now the same door answers with the
 * message to send; once a person says it was sent, the request is marked
 * carried out, once. The ORDER is never touched: no status, no stock, no
 * version — the parcel returns through the returns door, counted.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, requirePermission, can, logAudit, releaseOrderLines, notify } = vi.hoisted(() => ({
  db: {
    order: { findFirst: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    orderChangeRequest: { findFirst: vi.fn(), updateMany: vi.fn() },
    deliveryProvider: { findFirst: vi.fn() },
    orderNote: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
    orderStatusLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  can: vi.fn(),
  logAudit: vi.fn(),
  releaseOrderLines: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: (...a: unknown[]) => requirePermission(...a),
  can: (...a: unknown[]) => can(...a),
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/reservation', () => ({ releaseOrderLines: (...a: unknown[]) => releaseOrderLines(...a) }));
vi.mock('@/lib/notify', () => ({ notify: (...a: unknown[]) => notify(...a) }));

import { POST } from '@/app/api/ops/shipments/stand-down/route';

const ORDER_ID = '88888888-8888-4888-8888-888888888888';
const REQUEST_ID = '99999999-9999-4999-8999-999999999999';

const request = (over: Record<string, unknown> = {}) => ({
  id: REQUEST_ID, orderId: ORDER_ID, status: 'APPROVED', appliedAt: null, intent: 'CANCEL',
  reason: 'الزبون سافر', requestedById: 'agent-1', postponeUntil: null, cancelReason: 'CUSTOMER_CHANGED_MIND',
  ...over,
});

const stored = (over: Record<string, unknown> = {}) => ({
  id: ORDER_ID, orderNumber: 'SY-5', version: 2, confirmationStatus: 'CONFIRMED',
  shippingStatus: 'SHIPPED', shippedAt: new Date(), labelPrintedAt: new Date(), shippingBatchId: 'b1',
  trackingNumber: 'BC-77', deliveryProviderId: 'p1',
  ...over,
});

const press = async (body: Record<string, unknown>) => {
  const res = await POST(
    new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: ORDER_ID, outcome: 'CANCEL', changeRequestId: REQUEST_ID, ...body }),
    })
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'boss', name: 'المدير', role: 'ADMIN' }, companyId: 'c1', storeId: 's1' });
  requirePermission.mockResolvedValue({});
  can.mockReturnValue(true);
  db.orderChangeRequest.findFirst.mockResolvedValue(request());
  db.order.findFirst.mockResolvedValue(stored());
  db.deliveryProvider.findFirst.mockResolvedValue({ name: 'الباشا', phone: '0999' });
  db.orderChangeRequest.updateMany.mockResolvedValue({ count: 1 });
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
});

describe('the message to the company', () => {
  it('is composed from their barcode and the reason, and addressed to the company', () => {
    const msg = courierCancelMessage({ orderNumber: 'SY-5', trackingNumber: ' BC-77 ', reason: 'الزبون غيّر رأيه' });

    expect(msg).toContain('بوليصة رقم BC-77');
    expect(msg).toContain('إلغاء هذه البوليصة');
    expect(msg).toContain('الزبون غيّر رأيه');
    expect(msg).toContain('SY-5');
  });

  it('falls back to our number when there is no barcode, and drops an empty reason', () => {
    const msg = courierCancelMessage({ orderNumber: 'SY-5', reason: '  ' });

    expect(msg).toContain('طلب رقم SY-5');
    expect(msg).not.toContain('السبب');
  });
});

describe('an approved cancel on a parcel that left', () => {
  it('first asks for the message to be sent, and writes NOTHING', async () => {
    const res = await press({});

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('COURIER_ACTION_REQUIRED');
    expect(res.body.action).toBe('CANCEL_WAYBILL');
    expect(res.body.courier).toEqual({ name: 'الباشا', phone: '0999' });
    expect(String(res.body.message)).toContain('BC-77');
    expect(db.orderChangeRequest.updateMany, 'عُلّم الطلب منفّذاً قبل إبلاغ الشركة').not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('then, once a person says the company was told, marks the request carried out — once', async () => {
    const res = await press({ courierNotified: true });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(db.orderChangeRequest.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: REQUEST_ID, appliedAt: null },
      data: { appliedById: 'boss' },
    });
    expect(db.orderActivity.create.mock.calls[0][0].data).toMatchObject({
      orderId: ORDER_ID, userId: 'boss', action: 'COURIER_TOLD_TO_CANCEL',
    });
    expect(db.orderNote.create).toHaveBeenCalledTimes(1);
    expect(logAudit.mock.calls[0][0]).toMatchObject({ action: 'SHIPMENT_CANCEL_COURIER_TOLD', userId: 'boss' });
    // And the one who asked hears it is done.
    expect(notify.mock.calls[0][0].audience).toEqual({ userIds: ['agent-1'] });
  });

  it('leaves the ORDER alone: no status, no stock, no version', async () => {
    await press({ courierNotified: true });

    expect(db.order.updateMany, 'تغيّر الطلب نفسه').not.toHaveBeenCalled();
    expect(db.order.update).not.toHaveBeenCalled();
    expect(releaseOrderLines, 'انحرّرت بضاعة طرد عند الشركة').not.toHaveBeenCalled();
    expect(db.orderStatusLog.create).not.toHaveBeenCalled();
  });

  it('a second press finds it already carried out and says so', async () => {
    db.orderChangeRequest.updateMany.mockResolvedValue({ count: 0 });

    const res = await press({ courierNotified: true });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_APPLIED');
    expect(db.orderNote.create).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('a request that is not approved gets no message at all', async () => {
    db.orderChangeRequest.findFirst.mockResolvedValue(request({ status: 'PENDING' }));

    const res = await press({ courierNotified: true });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_APPROVED');
    expect(db.orderChangeRequest.updateMany).not.toHaveBeenCalled();
  });

  it('a postponement of a parcel that left is still refused — there is nothing to hold', async () => {
    db.orderChangeRequest.findFirst.mockResolvedValue(request({ intent: 'POSTPONE', postponeUntil: new Date(Date.now() + 86_400_000) }));

    const res = await press({ outcome: 'POSTPONE', courierNotified: true });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CANCEL_AFTER_SHIPPED');
    expect(db.orderChangeRequest.updateMany).not.toHaveBeenCalled();
  });

  it('and a plain cancel with no request on a parcel that left is still refused', async () => {
    const res = await press({ changeRequestId: undefined, reason: 'CUSTOMER_CHANGED_MIND', courierNotified: true });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CANCEL_AFTER_SHIPPED');
    expect(db.orderChangeRequest.updateMany).not.toHaveBeenCalled();
  });
});

describe('an approved cancel on an order still on the shelf — the negative', () => {
  it('is carried out in place as before: stops the order and frees its goods', async () => {
    db.order.findFirst.mockResolvedValue(
      stored({ shippingStatus: 'NOT_READY', shippedAt: null, labelPrintedAt: null, shippingBatchId: null })
    );
    db.order.updateMany.mockResolvedValue({ count: 1 });

    const res = await press({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(releaseOrderLines).toHaveBeenCalledTimes(1);
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
    expect(res.body.courierTold).toBeUndefined();
  });
});
