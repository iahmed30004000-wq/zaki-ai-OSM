import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE SEPARATE STATUS FIELDS ASK THE SAME QUESTION AS THE COMBINED ONE.
 *
 * `PATCH { status: 'CANCELLED' }` asked `assertCancellable` — a parcel that
 * is labelled, on the pickup shelf or with the courier cannot be cancelled,
 * because its goods are not on the shelf. The same ending sent as
 * `confirmationStatus: 'CANCELLED' | 'REJECTED'` (with the override) or as
 * `shippingStatus: 'CANCELLED'` walked past it, and the order read as dead
 * while its parcel rode in a van.
 *
 * These claims run the door and read the answer. Every refusal has its
 * negative: an order still on the shelf is NOT refused by this guard.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, can, authorize, getPermissionScope, assertOrderAccess, logAudit, notify } = vi.hoisted(() => ({
  db: {
    order: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    orderChangeRequest: { findFirst: vi.fn() },
    shippingBatch: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  can: vi.fn(),
  authorize: vi.fn(),
  getPermissionScope: vi.fn(),
  assertOrderAccess: vi.fn(),
  logAudit: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  can: (...a: unknown[]) => can(...a),
  authorize: (...a: unknown[]) => authorize(...a),
  getPermissionScope: (...a: unknown[]) => getPermissionScope(...a),
  requirePermission: vi.fn(),
}));
vi.mock('@/lib/rbac', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a),
  assertOrderReadable: vi.fn(),
}));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: vi.fn() }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/notify', () => ({ notify: (...a: unknown[]) => notify(...a) }));
vi.mock('@/lib/api-error', () => ({
  apiError: (e: unknown) => ({ body: { error: `UNEXPECTED: ${(e as Error)?.message}` }, status: 500 }),
}));

import { PATCH } from './route';

const ORDER = {
  id: 'o1', companyId: 'c1', storeId: 's1', version: 7, orderNumber: 'ORD-1',
  status: 'CONFIRMED', confirmationStatus: 'CONFIRMED', shippingStatus: 'NOT_READY',
  shippedAt: null, labelPrintedAt: null, handedToCourierAt: null, claimedById: null,
  lockedById: null, lockExpiresAt: null, deliveryProviderId: null,
  confirmedAt: new Date('2026-10-15T05:00:00.000Z'),
  quantity: 1, sellingPrice: 10, discountAmount: 0, shippingCost: 0, totalAmount: 10,
  customerId: 'cu1', noAnswerCount: 0, postponeCount: 0,
};

const REASON = 'قرار المالك بعد اتصال بالزبون';

const patch = async (body: Record<string, unknown>) => {
  const res = await PATCH(
    new Request('http://localhost/api/orders/o1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 7, reason: REASON, ...body }),
    }),
    { params: Promise.resolve({ id: 'o1' }) }
  );
  if (!res) throw new Error('PATCH answered nothing');
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

function orderIs(over: Record<string, unknown>) {
  const o = { ...ORDER, ...over };
  assertOrderAccess.mockResolvedValue({ allowed: true, order: o });
  db.order.findUnique.mockResolvedValue(o);
  db.order.findFirst.mockResolvedValue(o);
}

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', role: 'SUPER_ADMIN', companyId: 'c1' },
    companyId: 'c1', storeId: 's1', countryId: 'co1',
    country: { code: 'JO', currencyCode: 'JOD', minorUnit: 3 },
  });
  // The owner: holds every key, including the override (orders.unlock).
  can.mockReturnValue(true);
  authorize.mockReturnValue({ allowed: true });
  getPermissionScope.mockReturnValue({ scope: 'ALL_COMPANY' });
  db.shippingBatch.findFirst.mockResolvedValue(null);
  db.orderChangeRequest.findFirst.mockResolvedValue(null);
  orderIs({});
});

describe('a parcel that has left the shelf', () => {
  it.each([
    ['confirmationStatus', 'CANCELLED'],
    ['confirmationStatus', 'REJECTED'],
    ['shippingStatus', 'CANCELLED'],
  ])('is not ended by %s: %s', async (field, value) => {
    // Labelled and on the pickup shelf — the goods are packed under its name.
    orderIs({ shippingStatus: 'READY_FOR_PICKUP', labelPrintedAt: new Date() });

    const res = await patch({ [field]: value });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('CANCEL_AFTER_SHIPPED');
    expect(db.order.update, 'انكتبت حالة إنهاء على طرد خرج').not.toHaveBeenCalled();
    expect(db.$transaction, 'انفتحت معاملة لتحرير بضاعة طرد خرج').not.toHaveBeenCalled();
  });

  it('and one already with the courier is refused the same way', async () => {
    orderIs({ shippingStatus: 'SHIPPED', shippedAt: new Date() });

    const res = await patch({ confirmationStatus: 'CANCELLED' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CANCEL_AFTER_SHIPPED');
  });

  it('and a labelled parcel is refused even when only the label says so', async () => {
    // No pickup status, no shippedAt: a printed waybill alone commits the goods.
    orderIs({ shippingStatus: 'READY_FOR_SHIPPING', labelPrintedAt: new Date() });

    const res = await patch({ shippingStatus: 'CANCELLED' });

    expect(res.body.code).toBe('CANCEL_AFTER_SHIPPED');
  });
});

describe('an order still on the shelf', () => {
  it.each([
    ['confirmationStatus', 'CANCELLED'],
    ['shippingStatus', 'CANCELLED'],
  ])('is not stopped by this guard for %s: %s', async (field, value) => {
    const res = await patch({ [field]: value });

    // Whatever the rest of the route answers, it is not THIS refusal.
    expect(res.body.code).not.toBe('CANCEL_AFTER_SHIPPED');
  });

  it('and a change that ends nothing is not asked the question at all', async () => {
    // A labelled parcel moving to another waiting status is not a cancel.
    orderIs({ shippingStatus: 'READY_FOR_PICKUP', labelPrintedAt: new Date() });

    const res = await patch({ shippingStatus: 'SHIPPED' });

    expect(res.body.code).not.toBe('CANCEL_AFTER_SHIPPED');
  });

  it('and writing the state it already has is not an ending', async () => {
    // Re-sending CANCELLED to an order that is already cancelled changes nothing.
    orderIs({ confirmationStatus: 'CANCELLED', shippingStatus: 'READY_FOR_PICKUP', labelPrintedAt: new Date() });

    const res = await patch({ confirmationStatus: 'CANCELLED', notes: undefined });

    expect(res.body.code).not.toBe('CANCEL_AFTER_SHIPPED');
  });
});
