import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A CANCELLATION STORED WITHOUT ITS REASON IS NOT STUCK FOR EVER.
 *
 * Requests raised before the reason was saved sit approved and un-carried-out
 * with `cancelReason = null`, and the door refused every press with «سبب
 * الإلغاء مطلوب». Nothing may guess a reason for them. The person carrying
 * the decision out picks one from the structured list; it is written onto the
 * request with their name in the audit — and ONLY for a request that has
 * none. A request that has one keeps it, whatever the body says.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, requirePermission, can, logAudit, endOrder, courierCancelCarryOut } = vi.hoisted(() => ({
  db: {
    order: { findFirst: vi.fn() },
    orderChangeRequest: {
      findFirst: vi.fn<(...a: unknown[]) => Promise<Record<string, unknown> | null>>(),
      updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 1 })),
    },
    shippingBatch: { findFirst: vi.fn() },
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  can: vi.fn(),
  logAudit: vi.fn(),
  endOrder: vi.fn(),
  courierCancelCarryOut: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: (...a: unknown[]) => requirePermission(...a),
  can: (...a: unknown[]) => can(...a),
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/notify', () => ({ notify: vi.fn() }));
vi.mock('@/lib/couriers/cancel-carryout', () => ({ courierCancelCarryOut: (...a: unknown[]) => courierCancelCarryOut(...a) }));
vi.mock('@/lib/order-cancel', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  endOrder: (...a: unknown[]) => endOrder(...a),
}));

import { POST } from './route';

const ORDER_ID = '88888888-8888-4888-8888-888888888888';
const REQUEST_ID = '99999999-9999-4999-8999-999999999999';
const SAID = 'الزبون تراجع بالاتصال';

const stored = (over: Record<string, unknown> = {}) => ({
  id: ORDER_ID, orderNumber: 'SY-5', version: 4, confirmationStatus: 'CONFIRMED',
  shippingStatus: 'READY_FOR_PICKUP', shippedAt: null, labelPrintedAt: new Date(),
  shippingBatchId: 'b1', trackingNumber: null, deliveryProviderId: null,
  ...over,
});

/** An approved cancellation, not yet carried out. `cancelReason: null` is the old kind. */
const approved = (over: Record<string, unknown> = {}) => ({
  id: REQUEST_ID, orderId: ORDER_ID, status: 'APPROVED', appliedAt: null, intent: 'CANCEL',
  reason: SAID, requestedById: 'agent', postponeUntil: null, cancelReason: null,
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
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'boss', name: 'المدير', role: 'SUPER_ADMIN' }, companyId: 'c1', storeId: 's1' });
  requirePermission.mockResolvedValue({});
  can.mockReturnValue(true);
  db.order.findFirst.mockResolvedValue(stored());
  db.shippingBatch.findFirst.mockResolvedValue({ status: 'READY' });
  db.orderChangeRequest.findFirst.mockResolvedValue(approved());
  endOrder.mockResolvedValue({ ok: true, orderNumber: 'SY-5', attested: false, tookOff: false, courierCancelled: false });
  courierCancelCarryOut.mockResolvedValue({ status: 200, body: { success: true } });
});

describe('an old request, stored without its reason', () => {
  it('is carried out under the reason the decider picks, and it is written onto the request', async () => {
    const res = await press({ reason: 'CUSTOMER_CHANGED_MIND' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(endOrder.mock.calls[0][0]).toMatchObject({ reason: 'CUSTOMER_CHANGED_MIND', kind: 'CANCEL' });
    // …for the record, and only where it is still empty (two presses cannot overwrite each other).
    expect(db.orderChangeRequest.updateMany).toHaveBeenCalledWith({
      where: { id: REQUEST_ID, companyId: 'c1', cancelReason: null },
      data: { cancelReason: 'CUSTOMER_CHANGED_MIND' },
    });
    // The helper is handed the request WITH the reason, so the row it closes agrees.
    expect(endOrder.mock.calls[0][0].viaRequest).toMatchObject({ id: REQUEST_ID, cancelReason: 'CUSTOMER_CHANGED_MIND' });
  });

  it('and the choice carries the decider’s name in the audit', async () => {
    await press({ reason: 'PRICE_TOO_HIGH' });

    const chosen = logAudit.mock.calls.map((c) => c[0]).find((a) => a.action === 'CHANGE_REQUEST_CANCEL_REASON_CHOSEN');
    expect(chosen).toMatchObject({ userId: 'boss', entityId: ORDER_ID, newData: { requestId: REQUEST_ID, cancelReason: 'PRICE_TOO_HIGH', by: 'المدير' } });
  });

  it('with no reason at all it is refused with the code and says what to do', async () => {
    const res = await press({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CANCEL_REASON_REQUIRED');
    expect(res.body.errorAr).toContain('سبب الإلغاء مطلوب');
    expect(res.body.errorAr).toContain('اختر السبب من القائمة');
    expect(endOrder).not.toHaveBeenCalled();
    expect(db.orderChangeRequest.updateMany).not.toHaveBeenCalled();
  });

  it.each(['NO_ANSWER_3_ATTEMPTS', 'MODERATOR_DATA_ERROR', 'NOT_A_REASON'])(
    'NEGATIVE: %j is not a choice a person may make, and nothing is written',
    async (bad) => {
      const res = await press({ reason: bad });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('CANCEL_REASON_REQUIRED');
      expect(endOrder).not.toHaveBeenCalled();
      expect(db.orderChangeRequest.updateMany).not.toHaveBeenCalled();
    }
  );

  it('«أخرى» is explained by the customer’s sentence the request was raised with', async () => {
    const res = await press({ reason: 'OTHER' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(endOrder.mock.calls[0][0]).toMatchObject({ reason: 'OTHER', rejectionNote: SAID });
  });

  it('but «أخرى» with nothing to explain it (a request sentence too short) is refused', async () => {
    db.orderChangeRequest.findFirst.mockResolvedValue(approved({ reason: 'لا' }));

    const res = await press({ reason: 'OTHER' });

    expect(res.status).toBe(400);
    expect(endOrder).not.toHaveBeenCalled();
    expect(db.orderChangeRequest.updateMany).not.toHaveBeenCalled();
  });

  it('a note typed by the decider wins over the request’s sentence', async () => {
    await press({ reason: 'OTHER', note: 'اتصلنا بالزبون وأكد' });

    expect(endOrder.mock.calls[0][0].rejectionNote).toBe('اتصلنا بالزبون وأكد');
  });
});

describe('a request that HAS its reason keeps it', () => {
  beforeEach(() => {
    db.orderChangeRequest.findFirst.mockResolvedValue(approved({ cancelReason: 'FAKE_ORDER' }));
  });

  it('the body’s reason is ignored, exactly as the date is', async () => {
    const res = await press({ reason: 'PRICE_TOO_HIGH' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(endOrder.mock.calls[0][0].reason).toBe('FAKE_ORDER');
    expect(db.orderChangeRequest.updateMany).not.toHaveBeenCalled();
    expect(logAudit.mock.calls.map((c) => c[0].action)).not.toContain('CHANGE_REQUEST_CANCEL_REASON_CHOSEN');
  });

  it('and presses with no reason at all, as the screen always did', async () => {
    const res = await press({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(endOrder.mock.calls[0][0].reason).toBe('FAKE_ORDER');
  });
});

describe('the edges of the old request', () => {
  it('a packed parcel: the first press is asked for the word, the repeat carries the same reason and succeeds', async () => {
    endOrder.mockResolvedValueOnce({
      ok: false, status: 409, code: 'ATTESTATION_REQUIRED', error: 'علّم «الطرد بين يديّ»', attestation: 'الطرد بين يديّ',
    });

    const first = await press({ reason: 'CUSTOMER_CHANGED_MIND' });
    expect(first.status).toBe(409);
    expect(first.body.code).toBe('ATTESTATION_REQUIRED');

    // The screen repeats the press with the word; the reason is still the one picked.
    const second = await press({ reason: 'CUSTOMER_CHANGED_MIND', parcelInHand: true });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(endOrder.mock.calls[1][0]).toMatchObject({ reason: 'CUSTOMER_CHANGED_MIND', parcelInHand: true });
  });

  it('and once the first press has saved it, a repeat that sends no reason still succeeds', async () => {
    db.orderChangeRequest.findFirst.mockResolvedValue(approved({ cancelReason: 'CUSTOMER_CHANGED_MIND' }));

    const res = await press({ parcelInHand: true });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(endOrder.mock.calls[0][0].reason).toBe('CUSTOMER_CHANGED_MIND');
  });

  it('a parcel the courier holds needs no reason from the decider: the message carries the customer’s sentence', async () => {
    db.shippingBatch.findFirst.mockResolvedValue({ status: 'SHIPPED' });

    const res = await press({});

    expect(res.status).toBe(200);
    expect(endOrder).not.toHaveBeenCalled();
    expect(courierCancelCarryOut).toHaveBeenCalledTimes(1);
    expect(courierCancelCarryOut.mock.calls[0][0].request).toMatchObject({ id: REQUEST_ID, cancelReason: null, reason: SAID });
  });
});

describe('the direct door is untouched', () => {
  it('with no request, the body’s reason is what it always was — and nothing is written to any request', async () => {
    db.orderChangeRequest.findFirst.mockResolvedValue(null);
    db.shippingBatch.findFirst.mockResolvedValue({ status: 'READY' });

    const res = await press({ changeRequestId: undefined, reason: 'CUSTOMER_CHANGED_MIND' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(requirePermission).toHaveBeenCalledWith('ops.ship');
    expect(db.orderChangeRequest.updateMany).not.toHaveBeenCalled();
  });

  it('and without a reason it is refused as before', async () => {
    const res = await press({ changeRequestId: undefined });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CANCEL_REASON_REQUIRED');
    expect(endOrder).not.toHaveBeenCalled();
  });
});
