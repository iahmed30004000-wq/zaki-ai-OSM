import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «REJECT», WITH THE OVERRIDE, IS THE SAME ENDING AS «CANCEL».
 *
 * `cancel` asked `assertCancellable`; `reject` did not. With `orders.unlock`
 * and a reason, a CONFIRMED order is allowed the CONFIRMED → REJECTED
 * override — and rejecting drops the reservation in the same transaction.
 * For an order whose parcel is labelled or on the pickup shelf that put its
 * units back on the shelf while they sat in a box.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, can, authorize, assertOrderAccess, logAudit, releaseOrderLines } = vi.hoisted(() => ({
  db: {
    order: { updateMany: vi.fn(), findUnique: vi.fn() },
    orderContactAttempt: { count: vi.fn(async () => 1) },
    orderStatusLog: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
    user: { findUnique: vi.fn() },
    customer: { findUnique: vi.fn(async () => null) },
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
};

const reject = async () => {
  const res = await POST(
    new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'reject',
        rejectionReason: 'CUSTOMER_CHANGED_MIND',
        note: 'الزبون رجع عن الطلب بالاتصال',
        expectedVersion: 3,
      }),
    }),
    { params: Promise.resolve({ id: 'o1' }) }
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

function orderIs(over: Record<string, unknown>) {
  assertOrderAccess.mockResolvedValue({ allowed: true, order: { ...ORDER, ...over } });
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

describe('rejecting a confirmed order', () => {
  it.each([
    ['labelled', { labelPrintedAt: new Date() }],
    ['on the pickup shelf', { shippingStatus: 'READY_FOR_PICKUP' }],
    ['with the courier', { shippingStatus: 'SHIPPED', shippedAt: new Date() }],
  ])('is refused when the parcel is %s, and frees nothing', async (_name, over) => {
    orderIs(over);

    const res = await reject();

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('CANCEL_AFTER_SHIPPED');
    expect(releaseOrderLines, 'حُرّرت بضاعة طرد خرج').not.toHaveBeenCalled();
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

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
});
