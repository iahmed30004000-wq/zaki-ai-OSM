import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «REJECT», WITH THE OVERRIDE, IS THE SAME ENDING AS «CANCEL» — AND BOTH
 * ASK THE ONE HELPER WHETHER THE PARCEL IS STILL OURS.
 *
 * `cancel` asked a guard; `reject` did not. With `orders.unlock` and a
 * reason, a CONFIRMED order is allowed the CONFIRMED → REJECTED override —
 * and rejecting drops the reservation in the same transaction. For an order
 * whose parcel is packed that once put its units back on the shelf while they
 * sat in a box.
 *
 * M6 (28/10) moved the line, so (old → new):
 *
 *   · a LABELLED / pickup-shelf parcel on our floor was refused
 *     (CANCEL_AFTER_SHIPPED) → it is now rejectable ON A PERSON'S WORD that the
 *     box was opened (ATTESTATION_REQUIRED, then ok), and frees its units then;
 *   · a parcel the courier has taken (shipped, or on a PRESSED trolley) is still
 *     refused (CANCEL_AFTER_SHIPPED) and frees nothing.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, can, authorize, assertOrderAccess, logAudit, releaseOrderLines } = vi.hoisted(() => ({
  db: {
    order: { updateMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
    // What `endOrder` writes when it ends an order.
    customer: { findUnique: vi.fn(async () => null), update: vi.fn() },
    orderNote: { create: vi.fn() },
    orderContactAttempt: { count: vi.fn(async () => 1) },
    orderStatusLog: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
    user: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  can: vi.fn(),
  authorize: vi.fn(),
  assertOrderAccess: vi.fn(),
  logAudit: vi.fn(),
  releaseOrderLines: vi.fn(async () => undefined),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  can: (...a: unknown[]) => can(...a),
  authorize: (...a: unknown[]) => authorize(...a),
  requirePermission: vi.fn(),
}));
vi.mock('@/lib/rbac', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a),
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/notify', () => ({ notify: vi.fn() }));
vi.mock('@/lib/reservation', () => ({
  releaseOrderLines: (...a: unknown[]) => releaseOrderLines(...(a as [])),
  reserveOrderLines: vi.fn(),
}));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: vi.fn() }));
vi.mock('@/lib/conversions/emit', () => ({ queueConversions: vi.fn() }));
vi.mock('@/lib/blacklist', () => ({ AlreadyBlocked: class extends Error {}, blockPhone: vi.fn() }));

import { POST } from './route';

const ORDER = {
  id: 'o1', companyId: 'c1', storeId: 's1', version: 3, orderNumber: 'ORD-1',
  confirmationStatus: 'CONFIRMED', shippingStatus: 'NOT_READY', shippedAt: null, labelPrintedAt: null,
  claimedById: null, lockedById: null, lockExpiresAt: null, confirmedAt: new Date(), customerId: 'cu1',
  nextFollowUpAt: null, followUpStatus: null, moderatorId: null,
  // What `endOrder` reads besides the columns above: the trolley, the barcode, the money.
  shippingBatchId: null, shippingBatch: null, deliveryProviderId: null, trackingNumber: null,
  courierSendStartedAt: null, totalAmount: 10, currency: 'JOD',
};

const reject = async (extra: Record<string, unknown> = {}) => {
  const res = await POST(
    new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'reject',
        rejectionReason: 'CUSTOMER_CHANGED_MIND',
        note: 'الزبون رجع عن الطلب بالاتصال',
        expectedVersion: 3,
        ...extra,
      }),
    }),
    { params: Promise.resolve({ id: 'o1' }) }
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

function orderIs(over: Record<string, unknown>) {
  const o = { ...ORDER, ...over };
  assertOrderAccess.mockResolvedValue({ allowed: true, order: o });
  // `endOrder` reads the order afresh, with its trolley.
  db.order.findFirst.mockResolvedValue(o);
}

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'المالك', role: 'SUPER_ADMIN' },
    companyId: 'c1', storeId: 's1', country: { allowNegativeStock: false },
  });
  can.mockReturnValue(true);
  authorize.mockReturnValue({ allowed: true });
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.order.findUnique.mockResolvedValue({ ...ORDER });
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  orderIs({});
});

describe('rejecting a confirmed order that is packed but still on our floor', () => {
  it.each([
    ['labelled', { labelPrintedAt: new Date() }],
    ['on the pickup shelf', { shippingStatus: 'READY_FOR_PICKUP' }],
    ['on a trolley still being filled', { shippingStatus: 'READY_FOR_PICKUP', labelPrintedAt: new Date(), shippingBatchId: 'b1', shippingBatch: { status: 'READY', batchNumber: 'B-1' } }],
  ])('is refused when the parcel is %s — until a person says the box was opened — and frees nothing', async (_name, over) => {
    orderIs(over);

    const res = await reject();

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('ATTESTATION_REQUIRED');
    expect(releaseOrderLines, 'حُرّرت بضاعة طرد مغلّف بلا كلمة أحد').not.toHaveBeenCalled();
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('and with that word it is rejected, off the trolley, and the units go back — once', async () => {
    orderIs({ shippingStatus: 'READY_FOR_PICKUP', labelPrintedAt: new Date(), shippingBatchId: 'b1', shippingBatch: { status: 'READY', batchNumber: 'B-1' } });

    const res = await reject({ parcelInHand: true });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(releaseOrderLines).toHaveBeenCalledTimes(1);
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
    // The rejection keeps its word and its reason, and the parcel leaves the shipment.
    expect(db.order.updateMany.mock.calls[0][0].data).toMatchObject({
      confirmationStatus: 'REJECTED', rejectionReason: 'CUSTOMER_CHANGED_MIND',
      shippingBatchId: null, labelPrintedAt: null, shippingStatus: 'NOT_READY',
    });
  });
});

describe('rejecting a confirmed order whose parcel the courier has taken', () => {
  it.each([
    ['with the courier', { shippingStatus: 'SHIPPED', shippedAt: new Date() }],
    ['on a trolley that was pressed', { shippingStatus: 'READY_FOR_PICKUP', labelPrintedAt: new Date(), shippingBatchId: 'b1', shippingBatch: { status: 'SHIPPED', batchNumber: 'B-1' } }],
  ])('is refused when the parcel is %s, whatever anybody says, and frees nothing', async (_name, over) => {
    orderIs(over);

    const res = await reject({ parcelInHand: true });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('CANCEL_AFTER_SHIPPED');
    expect(releaseOrderLines, 'حُرّرت بضاعة طرد خرج').not.toHaveBeenCalled();
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });
});

describe('the negatives — the ordinary reject is not asked for anything', () => {
  it('still works while the goods are on the shelf — the override is not closed', async () => {
    const res = await reject();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(releaseOrderLines).toHaveBeenCalledTimes(1);
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
  });

  it('and an ordinary new order is rejected as before', async () => {
    orderIs({ confirmationStatus: 'IN_PROGRESS', claimedById: 'u1' });

    const res = await reject();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(releaseOrderLines).toHaveBeenCalledTimes(1);
  });

  it('and it counts the customer’s refusal now — the confirmation door never did', async () => {
    const res = await reject();

    expect(res.status).toBe(200);
    expect(db.customer.update).toHaveBeenCalledWith({ where: { id: 'cu1' }, data: { cancelledOrders: { increment: 1 } } });
  });
});
