import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE SHIPPING SCREEN'S «CANCELLED» ENDS NOTHING ON AN OPEN TROLLEY — the owner's ruling 4/11.
 *
 * The transition to CANCELLED is asked, before the transition table and before the helper, whether the parcel sits on a
 * trolley still being filled; if so it is refused ON_OPEN_TROLLEY and the helper is never called. Only the batch screen's
 * own «ألغِ» takes a parcel off an open trolley. After the handover the courier's refusal stands; off any trolley the door
 * goes to the helper as before.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, assertOrderAccess, endOrder, emitAppEvent, can } = vi.hoisted(() => ({
  db: {
    order: { findUnique: vi.fn(), updateMany: vi.fn() },
    orderChangeRequest: { findFirst: vi.fn() },
    shippingBatch: { findFirst: vi.fn() },
    orderStatusLog: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
    user: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  assertOrderAccess: vi.fn(),
  endOrder: vi.fn(),
  emitAppEvent: vi.fn(async (..._a: unknown[]) => 1),
  can: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/rbac', () => ({
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a),
  ORDER_ACCESS_STATUS: { NOT_FOUND: 404, WRONG_COMPANY: 404, NOT_ASSIGNED: 404 },
}));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/notify', () => ({ notify: vi.fn() }));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: (...a: unknown[]) => emitAppEvent(...a) }));
vi.mock('@/lib/conversions/emit', () => ({ queueConversions: vi.fn() }));
vi.mock('@/lib/authorization', () => ({
  can: (...a: unknown[]) => can(...a),
  authorize: () => ({ allowed: true }),
}));
vi.mock('@/lib/order-cancel', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  endOrder: (...a: unknown[]) => endOrder(...a),
}));

import { POST } from './route';

const ORDER = {
  id: 'o1', companyId: 'c1', storeId: 's1', version: 1, orderNumber: 'ORD-1',
  confirmationStatus: 'CONFIRMED', shippingStatus: 'PACKING', shippedAt: null, labelPrintedAt: null,
  shippingBatchId: null, trackingNumber: null, lockedById: null, lockExpiresAt: null,
  totalAmount: 10, currency: 'JOD', deliveryProviderId: null,
};

const press = async (body: Record<string, unknown>) => {
  const res = await POST(
    new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: 'o1' }) }
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

const CANCEL = { action: 'transition', to: 'CANCELLED', expectedVersion: 1, shippingNote: 'قرار المالك بعد اتصال بالزبون' };

const onTrolley = (status: string | null) => {
  const o = { ...ORDER, shippingStatus: 'READY_FOR_PICKUP', labelPrintedAt: new Date(), shippingBatchId: 'b1' };
  assertOrderAccess.mockResolvedValue({ allowed: true, order: o });
  db.order.findUnique.mockResolvedValue(o);
  db.shippingBatch.findFirst.mockResolvedValue(status ? { status } : null);
};

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'المالك', role: 'SUPER_ADMIN' }, companyId: 'c1', storeId: 's1',
    country: { allowNegativeStock: false },
  });
  assertOrderAccess.mockResolvedValue({ allowed: true, order: ORDER });
  can.mockReturnValue(true);
  db.orderChangeRequest.findFirst.mockResolvedValue(null);
  db.shippingBatch.findFirst.mockResolvedValue(null);
  db.order.findUnique.mockResolvedValue(ORDER);
  endOrder.mockResolvedValue({ ok: true, orderNumber: 'ORD-1', attested: false, tookOff: false, courierCancelled: false });
});

describe('«CANCELLED» on a trolley still being filled', () => {
  it.each([[{}], [{ parcelInHand: true }]])('is refused ON_OPEN_TROLLEY (%o) — the helper is never called, nothing is written', async (said) => {
    onTrolley('READY');

    const res = await press({ ...CANCEL, ...said });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('ON_OPEN_TROLLEY');
    expect(endOrder).not.toHaveBeenCalled();
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe('the negatives', () => {
  it('a trolley the order names but nobody can read is refused as before (UNKNOWN_BATCH)', async () => {
    onTrolley(null);

    const res = await press(CANCEL);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('UNKNOWN_BATCH');
    expect(endOrder).not.toHaveBeenCalled();
  });

  it('after the handover the courier’s refusal stands (CANCEL_AFTER_SHIPPED)', async () => {
    onTrolley('SHIPPED');

    const res = await press(CANCEL);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CANCEL_AFTER_SHIPPED');
    expect(endOrder).not.toHaveBeenCalled();
  });

  it('off any trolley the door goes to the helper as before', async () => {
    const res = await press(CANCEL);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(endOrder).toHaveBeenCalledTimes(1);
  });
});
