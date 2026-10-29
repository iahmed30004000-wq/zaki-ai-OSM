import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «أجّل الشحن» — FOR A PARCEL THAT IS ALREADY ON A TROLLEY.
 *
 * The hold door used to refuse («أخرجه من الدفعة أولاً»), and there was no
 * door that took a parcel off a trolley. M6 (28/10): until «إغلاق الشحنة —
 * سُلّمت للشركة» the parcel is still ours, so the hold takes it off the
 * trolley and keeps the box exactly as it is. And an approved «أجّل الطلب»
 * request is carried out HERE — a hold: the order stays confirmed and goes
 * out on its day — instead of the stand-down's un-confirmation, which asked
 * the customer a second time.
 *
 * This also closes the #59 review's finding (a): an approved POSTPONE for a
 * labelled parcel executed nowhere and hung the press of the whole batch.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, requirePermission, can, logAudit, holdFromTrolley, releaseOrderLines } = vi.hoisted(() => ({
  db: {
    order: { findFirst: vi.fn(), update: vi.fn() },
    orderChangeRequest: { findFirst: vi.fn(), updateMany: vi.fn() },
    orderActivity: { create: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  can: vi.fn(),
  logAudit: vi.fn(),
  holdFromTrolley: vi.fn(),
  releaseOrderLines: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: (...a: unknown[]) => requirePermission(...a),
  can: (...a: unknown[]) => can(...a),
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/order-cancel', () => ({ holdFromTrolley: (...a: unknown[]) => holdFromTrolley(...a) }));
vi.mock('@/lib/reservation', () => ({
  releaseOrderLines: (...a: unknown[]) => releaseOrderLines(...a),
  reserveOrderLines: vi.fn(),
}));

import { POST } from './route';

const ORDER_ID = '88888888-8888-4888-8888-888888888888';
const REQUEST_ID = '99999999-9999-4999-8999-999999999999';
const NEXT_WEEK = new Date(Date.now() + 7 * 86_400_000);

const stored = (over: Record<string, unknown> = {}) => ({
  id: ORDER_ID, orderNumber: 'SY-5', confirmationStatus: 'CONFIRMED', shippingStatus: 'READY_FOR_PICKUP',
  shippingBatchId: 'b1', shipHoldUntil: null, version: 4, shippedAt: null, labelPrintedAt: new Date(),
  ...over,
});

const request = (over: Record<string, unknown> = {}) => ({
  id: REQUEST_ID, orderId: ORDER_ID, status: 'APPROVED', appliedAt: null, intent: 'POSTPONE',
  reason: 'الزبون مسافر', postponeUntil: NEXT_WEEK, ...over,
});

const press = async (body: Record<string, unknown>) => {
  const res = await POST(
    new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: ORDER_ID, ...body }),
    })
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'أبو خالد', role: 'WAREHOUSE' }, companyId: 'c1', storeId: 's1',
    country: { allowNegativeStock: false },
  });
  requirePermission.mockResolvedValue({});
  can.mockReturnValue(true);
  db.order.findFirst.mockResolvedValue(stored());
  db.orderChangeRequest.findFirst.mockResolvedValue(request());
  db.orderChangeRequest.updateMany.mockResolvedValue({ count: 1 });
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  holdFromTrolley.mockResolvedValue({ ok: true, orderNumber: 'SY-5', courierCancelled: false });
});

describe('a parcel on a trolley', () => {
  it('is held by taking it off the trolley — no more «أخرجه من الدفعة أولاً»', async () => {
    const until = NEXT_WEEK.toISOString();

    const res = await press({ until, reason: 'الزبون مسافر' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.code).not.toBe('ALREADY_BATCHED');
    expect(holdFromTrolley).toHaveBeenCalledTimes(1);
    expect(holdFromTrolley.mock.calls[0][0]).toMatchObject({
      orderId: ORDER_ID, companyId: 'c1', until: new Date(until), reason: 'الزبون مسافر',
    });
    // The box is not opened: nothing is released, and the unbatched path is not run on top of it.
    expect(releaseOrderLines).not.toHaveBeenCalled();
    expect(db.order.update).not.toHaveBeenCalled();
    expect(db.orderActivity.create.mock.calls[0][0].data).toMatchObject({ action: 'SHIP_HOLD_SET' });
    expect(JSON.parse(db.orderActivity.create.mock.calls[0][0].data.metadata)).toMatchObject({ stock: 'KEPT', fromTrolley: true });
    expect(logAudit.mock.calls[0][0]).toMatchObject({ action: 'SHIP_HOLD_SET', entityId: ORDER_ID });
  });

  it('says so in words when the company’s waybill was cancelled there for it (an API parcel)', async () => {
    holdFromTrolley.mockResolvedValue({ ok: true, orderNumber: 'SY-5', courierCancelled: true });

    const res = await press({ until: NEXT_WEEK.toISOString() });

    expect(res.body.message).toContain('ألغينا الطرد عند الشركة');
  });

  it('forwards the helper’s refusal — a pressed trolley, a company that said no, an answer nobody heard', async () => {
    for (const [status, code] of [[409, 'CANCEL_AFTER_SHIPPED'], [409, 'COURIER_REFUSED'], [409, 'COURIER_UNSURE']] as const) {
      holdFromTrolley.mockResolvedValue({ ok: false, status, code, error: `رفض ${code}` });

      const res = await press({ until: NEXT_WEEK.toISOString() });

      expect(res.status).toBe(status);
      expect(res.body.code).toBe(code);
      expect(res.body.error).toBe(`رفض ${code}`);
    }
    expect(db.orderActivity.create, 'سُجّل تأجيل ما تمّ').not.toHaveBeenCalled();
  });

  it('NEGATIVE: an order with no trolley is held the way it always was — and the helper is not involved', async () => {
    db.order.findFirst.mockResolvedValue(stored({ shippingBatchId: null, shippingStatus: 'NOT_READY', labelPrintedAt: null }));
    db.order.update.mockResolvedValue({ id: ORDER_ID, orderNumber: 'SY-5', shipHoldUntil: NEXT_WEEK, shipHoldReason: null });

    const res = await press({ until: NEXT_WEEK.toISOString() });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(holdFromTrolley).not.toHaveBeenCalled();
    expect(db.order.update).toHaveBeenCalledTimes(1);
  });
});

describe('an approved «أجّل الطلب» request is carried out HERE, as a hold', () => {
  it('takes the date and the reason from the approved request — never from the body', async () => {
    const res = await press({ changeRequestId: REQUEST_ID });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(holdFromTrolley.mock.calls[0][0]).toMatchObject({
      until: NEXT_WEEK, reason: 'الزبون مسافر', viaRequest: { id: REQUEST_ID },
    });
  });

  it('on an unbatched order marks the request carried out inside the same transaction, once', async () => {
    db.order.findFirst.mockResolvedValue(stored({ shippingBatchId: null, shippingStatus: 'NOT_READY', labelPrintedAt: null }));
    db.order.update.mockResolvedValue({ id: ORDER_ID, orderNumber: 'SY-5', shipHoldUntil: NEXT_WEEK, shipHoldReason: 'الزبون مسافر' });

    await press({ changeRequestId: REQUEST_ID });

    expect(db.orderChangeRequest.updateMany).toHaveBeenCalledTimes(1);
    expect(db.orderChangeRequest.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: REQUEST_ID, appliedAt: null }, data: { appliedById: 'u1' },
    });
  });

  it.each([
    ['not approved', { status: 'PENDING' }, 'NOT_APPROVED'],
    ['already carried out', { appliedAt: new Date() }, 'ALREADY_APPLIED'],
    ['a cancellation, not a postponement', { intent: 'CANCEL' }, 'WRONG_INTENT'],
    ['of another order', { orderId: '77777777-7777-4777-8777-777777777777' }, 'WRONG_ORDER'],
  ])('refuses a request that is %s', async (_name, over, code) => {
    db.orderChangeRequest.findFirst.mockResolvedValue(request(over));

    const res = await press({ changeRequestId: REQUEST_ID });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.code).toBe(code);
    expect(holdFromTrolley).not.toHaveBeenCalled();
    expect(db.order.update).not.toHaveBeenCalled();
  });

  it('refuses a postponement with no date rather than inventing one', async () => {
    db.orderChangeRequest.findFirst.mockResolvedValue(request({ postponeUntil: null }));

    const res = await press({ changeRequestId: REQUEST_ID });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_DATE');
  });

  it('the decision stands beside ops.ship, it does not widen it: neither key, no carry-out', async () => {
    can.mockReturnValue(false);

    const res = await press({ changeRequestId: REQUEST_ID });

    expect(res.status).toBe(403);
    expect(holdFromTrolley).not.toHaveBeenCalled();
  });

  it('NEGATIVE: with no request the door still asks for ops.ship', async () => {
    await press({ until: NEXT_WEEK.toISOString() });

    expect(requirePermission).toHaveBeenCalledWith('ops.ship');
  });
});
