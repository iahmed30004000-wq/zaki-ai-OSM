import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE PATCH FREEZES AN ORDER ON AN OPEN TROLLEY — the owner's ruling 4/11.
 *
 * «مجرد ما الطلبات تترحل ع الباتش ما حد يقدر يلغي أي شي، ولا يترحل طلب الغاء او طلب تأجيل او تعديل، عشان اقدر اغلق الشحنة».
 *
 * On a trolley that has not been handed over, `PATCH /api/orders/:id` ends nothing (any of the four fields that name an
 * ending — through `endOrder`, which refuses on its own read), overrides no status (`orders.unlock`), sets no postponement
 * date and carries out no approved request — each refused ON_OPEN_TROLLEY before anything is written. The packing table's
 * own pen (`ops.edit_in_batch`) is the warehouse's tool and is held, unchanged, in prep-edit-in-batch.test.ts. After the
 * handover nothing here changes.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, can, authorize, getPermissionScope, assertOrderAccess, logAudit, notify } = vi.hoisted(() => ({
  db: {
    order: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    orderChangeRequest: { findFirst: vi.fn(), updateMany: vi.fn() },
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
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

function orderIs(over: Record<string, unknown>) {
  const o = { ...ORDER, ...over };
  assertOrderAccess.mockResolvedValue({ allowed: true, order: o });
  db.order.findUnique.mockResolvedValue(o);
  db.order.findFirst.mockResolvedValue(o);
}

/** A confirmed, packed parcel on trolley b1, in the given state — the order's relation and the trolley row agree. */
function onTrolley(status: string | null, over: Record<string, unknown> = {}) {
  orderIs({
    shippingStatus: 'READY_FOR_PICKUP', labelPrintedAt: new Date(), shippingBatchId: 'b1',
    shippingBatch: status ? { status, batchNumber: 'B-1' } : null, ...over,
  });
  db.shippingBatch.findFirst.mockResolvedValue(status ? { status, batchNumber: 'B-1' } : null);
}

const REQUEST_ID = 'aaaaaaaa-1111-4222-8333-444444444444';

const nothingWritten = () => {
  expect(db.order.update, 'انكتب على طلب على دفعة مفتوحة').not.toHaveBeenCalled();
  expect(db.order.updateMany, 'انكتب على طلب على دفعة مفتوحة').not.toHaveBeenCalled();
  expect(db.$transaction).not.toHaveBeenCalled();
  expect(db.orderChangeRequest.updateMany).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', role: 'SUPER_ADMIN', companyId: 'c1' },
    companyId: 'c1', storeId: 's1', countryId: 'co1',
    country: { code: 'JO', currencyCode: 'JOD', minorUnit: 3 },
  });
  // The owner: every key, the override (orders.unlock) and the cancel key included — but NOT the packing table's pen, which
  // is the warehouse's own tool and is held in prep-edit-in-batch.test.ts.
  can.mockImplementation((_u: unknown, key: string) => key !== 'ops.edit_in_batch');
  authorize.mockReturnValue({ allowed: true });
  getPermissionScope.mockReturnValue({ scope: 'ALL_COMPANY' });
  db.shippingBatch.findFirst.mockResolvedValue(null);
  db.orderChangeRequest.findFirst.mockResolvedValue(null);
  db.orderChangeRequest.updateMany.mockResolvedValue({ count: 1 });
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.order.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...ORDER, ...data }));
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  orderIs({});
});

const ENDINGS = [
  ['status', 'CANCELLED'],
  ['confirmationStatus', 'CANCELLED'],
  ['confirmationStatus', 'REJECTED'],
  ['shippingStatus', 'CANCELLED'],
] as const;

describe('on a trolley still being filled, the PATCH changes nothing the ruling covers', () => {
  it.each(ENDINGS)('an ending by %s: %s is refused ON_OPEN_TROLLEY — even with the word that the box was opened', async (field, value) => {
    onTrolley('READY');

    const res = await patch({ [field]: value, parcelInHand: true });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('ON_OPEN_TROLLEY');
    nothingWritten();
  });

  it.each([
    ['status', 'NEW'],
    ['confirmationStatus', 'IN_PROGRESS'],
    ['status', 'SHIPPED'],
  ])('the override of the statuses (`orders.unlock`) — %s: %s — is refused ON_OPEN_TROLLEY', async (field, value) => {
    onTrolley('READY');

    const res = await patch({ [field]: value });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('ON_OPEN_TROLLEY');
    nothingWritten();
  });

  it('a postponement date is refused ON_OPEN_TROLLEY', async () => {
    onTrolley('READY');

    const res = await patch({ postponedUntil: new Date(Date.now() + 3 * 86_400_000).toISOString() });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('ON_OPEN_TROLLEY');
    nothingWritten();
  });

  it('an approved request carried out through `changeRequestId` is refused ON_OPEN_TROLLEY, and is NOT stamped applied', async () => {
    onTrolley('READY');
    db.orderChangeRequest.findFirst.mockResolvedValue({
      id: REQUEST_ID, orderId: 'o1', status: 'APPROVED', appliedAt: null, requestedById: 'agent',
      reason: 'الزبون انتقل', decisionNote: 'موافق', changes: { customerAddress: { from: 'قديم', to: 'جديد' } },
    });

    const res = await patch({ changeRequestId: REQUEST_ID, reason: undefined });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('ON_OPEN_TROLLEY');
    nothingWritten();
  });

  it('FAILS CLOSED: a trolley the order names but nobody can read is an open one', async () => {
    onTrolley(null);

    const res = await patch({ postponedUntil: new Date(Date.now() + 3 * 86_400_000).toISOString() });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ON_OPEN_TROLLEY');
    nothingWritten();
  });
});

describe('the negatives — what the ruling does not touch', () => {
  it('a note of ours is still written on an order on an open trolley — it changes nothing the press waits for', async () => {
    onTrolley('READY');

    const res = await patch({ internalNotes: 'الزبون بيرد بعد العصر', reason: undefined });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('off any trolley, a postponement date is written as before', async () => {
    orderIs({});

    const res = await patch({ postponedUntil: new Date(Date.now() + 3 * 86_400_000).toISOString() });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('after the handover the trolley is not what answers: an ending is the courier’s refusal, as before', async () => {
    onTrolley('SHIPPED');

    const res = await patch({ confirmationStatus: 'CANCELLED', parcelInHand: true });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CANCEL_AFTER_SHIPPED');
  });
});
