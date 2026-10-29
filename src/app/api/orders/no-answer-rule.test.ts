import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The 1/2/3 no-answer rule: the third no-answer closes the order under its
 * own distinct reason — it is never recorded as a customer rejection.
 */

const { db, requireContext, assertOrderAccess, logAudit, endOrder } = vi.hoisted(() => ({
  db: {
    orderContactAttempt: { findFirst: vi.fn(), create: vi.fn(), count: vi.fn() },
    order: { update: vi.fn() },
    orderStatusLog: { create: vi.fn() },
    orderNote: { create: vi.fn() },
    // An order with no add-ons — plain functions, so a mock reset leaves them answering.
    orderAddOn: { aggregate: async () => ({ _sum: { reservedQty: 0 } }), findMany: async () => [], update: async () => ({}), updateMany: async () => ({ count: 0 }) },
    orderItem: { updateMany: vi.fn() },
    user: { findUnique: vi.fn() },
    $transaction: vi.fn(async (fn: any) => fn(db)),
  },
  requireContext: vi.fn(),
  assertOrderAccess: vi.fn(),
  logAudit: vi.fn(),
  endOrder: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('./db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/rbac', () => ({ assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
// The close is `endOrder`'s — the one helper every cancel door goes through; its own tests cover its writes.
vi.mock('@/lib/order-cancel', () => ({ endOrder: (...a: unknown[]) => endOrder(...a) }));
vi.mock('@/lib/authorization', () => ({ can: () => true, authorize: () => ({ allowed: true }) }));

import { POST } from '@/app/api/orders/[id]/contact-attempts/route';

const params = { params: Promise.resolve({ id: 'o1' }) };
const attempt = (result: string) =>
  new Request('http://localhost/x', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contactMethod: 'PHONE', result }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'Agent', role: 'CONFIRMATION_AGENT', status: 'ACTIVE' },
    companyId: 'c1', storeId: 's1',
  });
  assertOrderAccess.mockResolvedValue({
    allowed: true,
    // A real order row always says where its shipping stands; one that does not is never closed by a counter.
    order: { id: 'o1', confirmationStatus: 'IN_PROGRESS', nextFollowUpAt: null, followUpStatus: null, shippingStatus: 'NOT_READY' },
  });
  db.orderContactAttempt.findFirst.mockResolvedValue({ attemptNumber: 1 });
  db.orderContactAttempt.create.mockResolvedValue({ id: 'a1', attemptNumber: 2 });
  db.orderItem.updateMany.mockResolvedValue({ count: 0 });
  endOrder.mockResolvedValue({ ok: true, orderNumber: 'ORD-1', attested: false, tookOff: false, courierCancelled: false });
});

describe('no-answer counter', () => {
  it('leaves the order open on the second no-answer', async () => {
    db.orderContactAttempt.count.mockResolvedValue(2);
    const res = await POST(attempt('NO_ANSWER'), params);
    const data = await res.json();
    expect(data.autoClosed).toBe(false);
    expect(data.noAnswerCount).toBe(2);
    expect(db.order.update).not.toHaveBeenCalled();
  });

  it('closes the order on the third, with its own reason and no commission', async () => {
    db.orderContactAttempt.count.mockResolvedValue(3);
    const res = await POST(attempt('NO_ANSWER'), params);
    const data = await res.json();
    expect(data.autoClosed).toBe(true);

    // Through the one helper, in THIS transaction (the attempt that closed it),
    // under its own door and its own reason — never as a customer's rejection.
    expect(endOrder).toHaveBeenCalledTimes(1);
    const call = endOrder.mock.calls[0][0];
    expect(call).toMatchObject({
      orderId: 'o1', companyId: 'c1', door: 'CONTACT_AUTO_CLOSE',
      kind: 'CANCEL', endAs: 'CANCELLED', reason: 'NO_ANSWER_3_ATTEMPTS',
    });
    expect(call.tx, 'الإغلاق خرج من معاملة المحاولة').toBe(db);
    // No commission to take off: the ledger accrues on DELIVERY, and this
    // order never reached a door. The retired per-order column is not
    // written either — it is not the commission source any more.
    expect(call.data).not.toHaveProperty('moderatorCommission');
    // The order itself is not written by this door any more.
    expect(db.order.update).not.toHaveBeenCalled();
  });

  it('says it did NOT close when the helper refused (the order moved on in the same instant)', async () => {
    db.orderContactAttempt.count.mockResolvedValue(3);
    endOrder.mockResolvedValue({ ok: false, status: 409, code: 'ORDER_MOVED_ON', error: 'x' });

    const data = await (await POST(attempt('NO_ANSWER'), params)).json();

    expect(data.autoClosed).toBe(false);
    expect(data.success).toBe(true); // the attempt itself stays recorded
  });

  it.each([
    ['on a trolley', { shippingBatchId: 'b1' }],
    ['with a barcode', { trackingNumber: 'BC-1' }],
    ['with a printed waybill', { labelPrintedAt: new Date() }],
    ['past NOT_READY', { shippingStatus: 'READY_FOR_PICKUP' }],
  ])('never auto-closes a parcel that entered the shipment: %s', async (_name, over) => {
    assertOrderAccess.mockResolvedValue({
      allowed: true,
      order: { id: 'o1', confirmationStatus: 'IN_PROGRESS', nextFollowUpAt: null, followUpStatus: null, shippingStatus: 'NOT_READY', ...over },
    });
    db.orderContactAttempt.count.mockResolvedValue(3);

    const data = await (await POST(attempt('NO_ANSWER'), params)).json();

    // A counter does not get to take a parcel off a trolley: that is a person's decision.
    expect(data.autoClosed).toBe(false);
    expect(endOrder, 'العدّاد ألغى طرداً دخل الشحن').not.toHaveBeenCalled();
  });

  it('does not close on an answered call, whatever the count', async () => {
    db.orderContactAttempt.count.mockResolvedValue(5);
    const res = await POST(attempt('ANSWERED'), params);
    expect((await res.json()).autoClosed).toBe(false);
    expect(db.order.update).not.toHaveBeenCalled();
  });

  it('never re-closes an order that already reached a terminal status', async () => {
    assertOrderAccess.mockResolvedValue({
      allowed: true,
      order: { id: 'o1', confirmationStatus: 'CONFIRMED', nextFollowUpAt: null, followUpStatus: null },
    });
    db.orderContactAttempt.count.mockResolvedValue(4);
    const res = await POST(attempt('NO_ANSWER'), params);
    expect((await res.json()).autoClosed).toBe(false);
    expect(db.order.update).not.toHaveBeenCalled();
  });
});
