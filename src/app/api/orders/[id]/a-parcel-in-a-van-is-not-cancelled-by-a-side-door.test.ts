import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE SEPARATE STATUS FIELDS ASK THE SAME QUESTION AS THE COMBINED ONE —
 * AND THE QUESTION IS NOW «HAS THE COURIER TAKEN IT?», NOT «IS IT LABELLED?».
 *
 * `PATCH { status: 'CANCELLED' }` once asked the 28/09 guard, and the same
 * ending sent as `confirmationStatus: 'CANCELLED' | 'REJECTED'` (with the
 * override) or as `shippingStatus: 'CANCELLED'` walked past it. They all go
 * through `endOrder` now, the one helper every cancel door uses.
 *
 * M6 (28/10) moved the line: the owner ruled «الغاء و التأجيل لغاية ما اضغط
 * اغلاق الشحنة». So (old → new):
 *
 *   · a LABELLED / on-the-pickup-shelf parcel that is still on our floor was
 *     REFUSED (CANCEL_AFTER_SHIPPED) → it is now cancellable, but only on a
 *     person's word that the box was opened (ATTESTATION_REQUIRED, then ok);
 *   · a parcel with the courier, or on a trolley that was PRESSED, is still
 *     refused (CANCEL_AFTER_SHIPPED) — and the trolley's status is read, not
 *     assumed;
 *   · an ending travels ALONE (CANCEL_ALONE).
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
    // What `endOrder` writes when it ends an order.
    orderStatusLog: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
    orderNote: { create: vi.fn() },
    customer: { update: vi.fn() },
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
vi.mock('@/lib/reservation', () => ({ releaseOrderLines: vi.fn(async () => 1) }));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: vi.fn(async () => 1) }));
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
  // What `endOrder` reads besides the columns above: the trolley and the company's barcode.
  shippingBatchId: null, shippingBatch: null, trackingNumber: null, courierSendStartedAt: null, currency: 'JOD',
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
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  orderIs({});
});

const ENDINGS = [
  ['confirmationStatus', 'CANCELLED'],
  ['confirmationStatus', 'REJECTED'],
  ['shippingStatus', 'CANCELLED'],
] as const;

describe('a parcel that is labelled or on the pickup shelf — still ours until the press', () => {
  it.each(ENDINGS)('is not ended by %s: %s without a person’s word — and nothing is written', async (field, value) => {
    // Labelled and on the pickup shelf — the goods are packed under its name.
    orderIs({ shippingStatus: 'READY_FOR_PICKUP', labelPrintedAt: new Date() });

    const res = await patch({ [field]: value });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('ATTESTATION_REQUIRED');
    expect(res.body.attestation).toBe('الطرد بين يديّ — فككتُه وأعدتُ قطعه للرف وأتلفتُ بوليصته');
    expect(db.order.updateMany, 'انكتبت حالة إنهاء على طرد مغلّف بلا تصريح').not.toHaveBeenCalled();
    expect(db.$transaction, 'انفتحت معاملة لتحرير بضاعة طرد مغلّف').not.toHaveBeenCalled();
  });

  it.each(ENDINGS)('IS ended by %s: %s once a person says the box was opened', async (field, value) => {
    orderIs({ shippingStatus: 'READY_FOR_PICKUP', labelPrintedAt: new Date() });
    db.order.updateMany.mockResolvedValue({ count: 1 });

    const res = await patch({ [field]: value, parcelInHand: true });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
    expect(db.order.updateMany.mock.calls[0][0].data).toMatchObject({
      shippingStatus: 'NOT_READY', labelPrintedAt: null, shippingBatchId: null,
    });
  });

  it('and a labelled parcel is asked even when only the label says so (no pickup status, no shippedAt)', async () => {
    orderIs({ shippingStatus: 'READY_FOR_SHIPPING', labelPrintedAt: new Date() });

    const res = await patch({ shippingStatus: 'CANCELLED' });

    expect(res.body.code).toBe('ATTESTATION_REQUIRED');
  });
});

describe('a parcel the courier has taken', () => {
  it.each(ENDINGS)('is not ended by %s: %s — whatever anybody says', async (field, value) => {
    orderIs({ shippingStatus: 'SHIPPED', shippedAt: new Date() });

    const res = await patch({ [field]: value, parcelInHand: true });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('CANCEL_AFTER_SHIPPED');
    expect(db.order.updateMany, 'انكتبت حالة إنهاء على طرد خرج').not.toHaveBeenCalled();
    expect(db.$transaction, 'انفتحت معاملة لتحرير بضاعة طرد خرج').not.toHaveBeenCalled();
  });

  it('and so is one on a trolley that was PRESSED, even if its own status still reads «waiting for pickup»', async () => {
    orderIs({
      shippingStatus: 'READY_FOR_PICKUP', labelPrintedAt: new Date(),
      shippingBatchId: 'b1', shippingBatch: { status: 'SHIPPED', batchNumber: 'B-1' },
    });

    const res = await patch({ confirmationStatus: 'CANCELLED', parcelInHand: true });

    expect(res.body.code).toBe('CANCEL_AFTER_SHIPPED');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('while the SAME parcel on a trolley still being filled is ours to cancel', async () => {
    orderIs({
      shippingStatus: 'READY_FOR_PICKUP', labelPrintedAt: new Date(),
      shippingBatchId: 'b1', shippingBatch: { status: 'READY', batchNumber: 'B-1' },
    });
    db.order.updateMany.mockResolvedValue({ count: 1 });

    const res = await patch({ confirmationStatus: 'CANCELLED', parcelInHand: true });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(db.order.updateMany.mock.calls[0][0].data.shippingBatchId).toBeNull();
  });
});

describe('an order still on the shelf', () => {
  it.each([
    ['confirmationStatus', 'CANCELLED'],
    ['shippingStatus', 'CANCELLED'],
  ])('is not stopped by this guard for %s: %s', async (field, value) => {
    db.order.updateMany.mockResolvedValue({ count: 1 });

    const res = await patch({ [field]: value });

    // Whatever the rest of the route answers, it is not a refusal of the guard.
    expect(res.body.code).not.toBe('CANCEL_AFTER_SHIPPED');
    expect(res.body.code).not.toBe('ATTESTATION_REQUIRED');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('and a change that ends nothing is not asked the question at all', async () => {
    // A labelled parcel moving to another waiting status is not a cancel.
    orderIs({ shippingStatus: 'READY_FOR_PICKUP', labelPrintedAt: new Date() });

    const res = await patch({ shippingStatus: 'SHIPPED' });

    expect(res.body.code).not.toBe('CANCEL_AFTER_SHIPPED');
    expect(res.body.code).not.toBe('ATTESTATION_REQUIRED');
  });

  it('and writing the state it already has is not an ending', async () => {
    // Re-sending CANCELLED to an order that is already cancelled changes nothing.
    orderIs({ confirmationStatus: 'CANCELLED', shippingStatus: 'READY_FOR_PICKUP', labelPrintedAt: new Date() });

    const res = await patch({ confirmationStatus: 'CANCELLED', notes: undefined });

    expect(res.body.code).not.toBe('CANCEL_AFTER_SHIPPED');
    expect(res.body.code).not.toBe('ATTESTATION_REQUIRED');
  });
});

describe('an ending travels alone', () => {
  it('is refused when it comes with another edit — it has no single meaning', async () => {
    const res = await patch({ confirmationStatus: 'CANCELLED', sellingPrice: 99 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CANCEL_ALONE');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });
});

/**
 * AN ENDING ASKS THE SAME OF WHOEVER PRESSES IT, WHICHEVER FIELD NAMES IT.
 *
 * `shippingStatus: 'CANCELLED'` alone needs only `orders.edit` and
 * `orders.change_status` at the PATCH's own checks, and it used to write one
 * column. It now ends the order — CANCELLED, the reservation released, the
 * customer counted, System 7 told — which at the confirmation door takes
 * `orders.unlock` and a written reason. A weaker pair at this door was a
 * cancellation by a role that could not cancel anywhere else.
 */
describe('an ending needs the unlock key and a written reason', () => {
  it.each(ENDINGS)('%s: %s without orders.unlock is refused — and nothing is written', async (field, value) => {
    can.mockImplementation((_u: unknown, key: string) => key !== 'orders.unlock');

    const res = await patch({ [field]: value });

    expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(403 - 0);
    expect([403, 409]).toContain(res.status);
    expect(db.order.updateMany, 'كُتب إلغاء بلا مفتاح').not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.customer.update).not.toHaveBeenCalled();
  });

  it('the shipping field alone — the one the older checks let through — is a plain 403', async () => {
    can.mockImplementation((_u: unknown, key: string) => key !== 'orders.unlock');

    const res = await patch({ shippingStatus: 'CANCELLED' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('UNLOCK_REQUIRED');
  });

  it.each(ENDINGS)('%s: %s with the key but no reason (or a few letters) is refused', async (field, value) => {
    const none = await patch({ [field]: value, reason: '' });
    const short = await patch({ [field]: value, reason: 'لا' });

    expect(none.status).toBe(400);
    expect(short.status).toBe(400);
    expect(short.body.code).toBe('REASON_REQUIRED');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: with the key and a reason it goes through', async () => {
    db.order.updateMany.mockResolvedValue({ count: 1 });

    const res = await patch({ shippingStatus: 'CANCELLED' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('NEGATIVE: a change that ends nothing does not ask for the key', async () => {
    can.mockImplementation((_u: unknown, key: string) => key !== 'orders.unlock');

    const res = await patch({ shippingStatus: 'SHIPPED' });

    expect(res.body.code).not.toBe('UNLOCK_REQUIRED');
  });
});
