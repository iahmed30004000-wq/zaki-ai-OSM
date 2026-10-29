import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE SHIPPING SCREEN'S «CANCELLED» IS THE ONE HELPER'S — NOT A COLUMN.
 *
 * This door used to write ONE column, `shippingStatus: 'CANCELLED'`, and
 * nothing else: the confirmation stayed CONFIRMED, the units stayed reserved,
 * the parcel stayed on its trolley with its waybill, and the customer's
 * cancellation was never counted. It is the same ending the stand-down, the
 * confirmation's «cancel» and the PATCH perform, so it goes through the same
 * helper (`endOrder`). The helper announces `order.cancelled` — once — so this
 * route must not announce it as well.
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
  emitAppEvent: vi.fn(async () => 1),
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

describe('«CANCELLED» from the shipping screen', () => {
  it('goes to the helper, as this door, ending as CANCELLED, at the version the screen loaded', async () => {
    const res = await press(CANCEL);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(endOrder).toHaveBeenCalledTimes(1);
    expect(endOrder.mock.calls[0][0]).toMatchObject({
      orderId: 'o1', companyId: 'c1', door: 'SHIPPING_STATUS', kind: 'CANCEL', endAs: 'CANCELLED',
      expectedVersion: 1, logNote: 'قرار المالك بعد اتصال بالزبون', parcelInHand: false,
    });
  });

  it('writes NO column itself — not the one it used to write, and not a second event on top of the helper’s', async () => {
    await press(CANCEL);

    expect(db.order.updateMany, 'كتب هذا الباب حالة الإلغاء بنفسه').not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(emitAppEvent, 'أُعلن order.cancelled مرتين').not.toHaveBeenCalled();
  });

  it('carries the person’s word to the helper', async () => {
    await press({ ...CANCEL, parcelInHand: true });

    expect(endOrder.mock.calls[0][0].parcelInHand).toBe(true);
  });

  it('forwards a refusal with the sentence the person must stand behind', async () => {
    endOrder.mockResolvedValue({
      ok: false, status: 409, code: 'ATTESTATION_REQUIRED', error: 'علّم «الطرد بين يديّ»', attestation: 'الطرد بين يديّ — …',
    });

    const res = await press(CANCEL);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'ATTESTATION_REQUIRED', attestation: 'الطرد بين يديّ — …' });
  });

  it('a parcel with the courier is refused at the gate, before the transition table and before the helper', async () => {
    assertOrderAccess.mockResolvedValue({ allowed: true, order: { ...ORDER, shippingStatus: 'SHIPPED', shippedAt: new Date() } });

    const res = await press(CANCEL);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CANCEL_AFTER_SHIPPED');
    expect(endOrder).not.toHaveBeenCalled();
  });

  it('and so is one on a trolley that was pressed', async () => {
    assertOrderAccess.mockResolvedValue({
      allowed: true, order: { ...ORDER, shippingStatus: 'READY_FOR_PICKUP', shippingBatchId: 'b1' },
    });
    db.shippingBatch.findFirst.mockResolvedValue({ status: 'SHIPPED' });

    const res = await press(CANCEL);

    expect(res.body.code).toBe('CANCEL_AFTER_SHIPPED');
    expect(endOrder).not.toHaveBeenCalled();
  });

  it('NEGATIVE: the transition table still guards it — without the override reason it is an invalid transition', async () => {
    can.mockReturnValue(false);
    assertOrderAccess.mockResolvedValue({ allowed: true, order: { ...ORDER, shippingStatus: 'READY_FOR_SHIPPING' } });

    const res = await press({ action: 'transition', to: 'CANCELLED', expectedVersion: 1 });

    expect(res.body.code).toBe('INVALID_TRANSITION');
    expect(endOrder).not.toHaveBeenCalled();
  });

  it('NEGATIVE: any OTHER transition is not touched by the helper at all', async () => {
    assertOrderAccess.mockResolvedValue({ allowed: true, order: { ...ORDER, shippingStatus: 'SHIPPED', shippedAt: new Date() } });
    db.order.updateMany.mockResolvedValue({ count: 1 });
    db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));

    await press({ action: 'transition', to: 'OUT_FOR_DELIVERY', expectedVersion: 1 });

    expect(endOrder).not.toHaveBeenCalled();
  });
});
