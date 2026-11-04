import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE CONFIRMATION DOOR ENDS NOTHING ON AN OPEN TROLLEY — the owner's ruling 4/11.
 *
 * «مجرد ما الطلبات تترحل ع الباتش ما حد يقدر يلغي أي شي». The confirmation door's «cancel» and «reject» (the override on
 * a confirmed order) both land in `endOrder`, which — unless the caller is the warehouse's own batch-screen tool — refuses
 * an order on a trolley still being filled with ON_OPEN_TROLLEY, before the company is asked anything and before anything
 * is written. The real helper runs here; only the database is a fake. After the handover the old refusal stands; off any
 * trolley the door works as before.
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
  db.order.findFirst.mockResolvedValue(o);
}

const onTrolley = (status: string | null) =>
  orderIs({
    shippingStatus: 'READY_FOR_PICKUP', labelPrintedAt: new Date(), shippingBatchId: 'b1',
    shippingBatch: status ? { status, batchNumber: 'B-1' } : null,
  });

const cancel = (extra: Record<string, unknown> = {}) =>
  reject({ action: 'cancel', rejectionReason: undefined, note: 'الزبون اتصل وألغى الطلب', ...extra });

const nothingWritten = () => {
  expect(db.order.updateMany, 'انكتب إنهاء على طلب على دفعة مفتوحة').not.toHaveBeenCalled();
  expect(db.$transaction).not.toHaveBeenCalled();
  expect(releaseOrderLines).not.toHaveBeenCalled();
  expect(db.customer.update).not.toHaveBeenCalled();
};

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

describe('on a trolley still being filled', () => {
  it.each([[{}], [{ parcelInHand: true }]])('«cancel» is refused ON_OPEN_TROLLEY (%o) — and nothing is written', async (said) => {
    onTrolley('READY');

    const res = await cancel(said);

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('ON_OPEN_TROLLEY');
    nothingWritten();
  });

  it('«reject» (the override on a confirmed order) is refused the same way', async () => {
    onTrolley('READY');

    const res = await reject({ parcelInHand: true });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('ON_OPEN_TROLLEY');
    nothingWritten();
  });
});

describe('the negatives', () => {
  it('a trolley the order names but nobody can read is still refused (UNKNOWN_BATCH comes first) — nothing written', async () => {
    onTrolley(null);

    const res = await cancel({ parcelInHand: true });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('UNKNOWN_BATCH');
    nothingWritten();
  });

  it('after the handover the old refusal stands: CANCEL_AFTER_SHIPPED', async () => {
    onTrolley('SHIPPED');

    const res = await cancel({ parcelInHand: true });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CANCEL_AFTER_SHIPPED');
    nothingWritten();
  });

  it('an order on no trolley is cancelled as before', async () => {
    const res = await cancel();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
    expect(db.order.updateMany.mock.calls[0][0].data).toMatchObject({ confirmationStatus: 'CANCELLED' });
  });
});
