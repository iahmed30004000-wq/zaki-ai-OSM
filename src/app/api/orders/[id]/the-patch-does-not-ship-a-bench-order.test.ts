import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE PATCH DOES NOT SHIP A BENCH ORDER EITHER (B2, 18/11 — `test-store.ts`).
 *
 * `PATCH /api/orders/:id` writes `shippingStatus` by the field itself and by the combined `status: 'SHIPPED'`. A bench
 * store's order stops at confirmation, so a step toward a courier is refused here with the shipping door's own code and
 * sentence — asked of the ORDER's store — and nothing is written. A real store's order moves as before; a bench order
 * already gone keeps its road; a cancel is not a step toward a courier.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, can, authorize, getPermissionScope, assertOrderAccess, logAudit, notify } = vi.hoisted(() => ({
  db: {
    // The bench question (bench-store.ts).
    store: { findFirst: vi.fn() },
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
import { BENCH_STOPS_AR, BENCH_STOPS_CODE } from '@/lib/test-store';

const ORDER = {
  id: 'o1', companyId: 'c1', storeId: 's9', version: 7, orderNumber: 'ORD-1',
  status: 'CONFIRMED', confirmationStatus: 'CONFIRMED', shippingStatus: 'NOT_READY',
  shippedAt: null, labelPrintedAt: null, handedToCourierAt: null, claimedById: null,
  lockedById: null, lockExpiresAt: null, deliveryProviderId: null,
  confirmedAt: new Date('2026-10-15T05:00:00.000Z'),
  quantity: 1, sellingPrice: 10, discountAmount: 0, shippingCost: 0, totalAmount: 10,
  customerId: 'cu1', noAnswerCount: 0, postponeCount: 0,
  shippingBatchId: null, shippingBatch: null, trackingNumber: null, courierSendStartedAt: null, currency: 'JOD',
};

const patch = async (body: Record<string, unknown>) => {
  const res = await PATCH(
    new Request('http://localhost/api/orders/o1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 7, reason: 'قرار المالك بعد اتصال بالزبون', ...body }),
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

const bench = () => db.store.findFirst.mockResolvedValue({ id: 's9' });

const nothingWritten = () => {
  expect(db.order.update, 'انكتب على طلب منصّة').not.toHaveBeenCalled();
  expect(db.order.updateMany, 'انكتب على طلب منصّة').not.toHaveBeenCalled();
  expect(db.$transaction).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  // The session stands in store s1; the order belongs to s9 — the question is asked of the ORDER's store.
  requireContext.mockResolvedValue({
    user: { id: 'u1', role: 'SUPER_ADMIN', companyId: 'c1' },
    companyId: 'c1', storeId: 's1', countryId: 'co1',
    country: { code: 'JO', currencyCode: 'JOD', minorUnit: 3 },
  });
  can.mockImplementation((_u: unknown, key: string) => key !== 'ops.edit_in_batch');
  authorize.mockReturnValue({ allowed: true });
  getPermissionScope.mockReturnValue({ scope: 'ALL_COMPANY' });
  db.store.findFirst.mockResolvedValue(null);
  db.shippingBatch.findFirst.mockResolvedValue(null);
  db.orderChangeRequest.findFirst.mockResolvedValue(null);
  db.orderChangeRequest.updateMany.mockResolvedValue({ count: 1 });
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.order.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...ORDER, ...data }));
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  orderIs({});
});

describe('a bench order, by the PATCH', () => {
  it.each(['PACKING', 'READY_FOR_SHIPPING', 'READY_FOR_PICKUP', 'SHIPPED'])(
    'shippingStatus: %s is refused in the owner’s sentence, and nothing is written',
    async (to) => {
      bench();
      const res = await patch({ shippingStatus: to });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.code).toBe(BENCH_STOPS_CODE);
      expect(res.body.error).toBe(BENCH_STOPS_AR);
      nothingWritten();
    }
  );

  it('the combined status: SHIPPED (the owner’s override with a reason) is refused too', async () => {
    bench();
    const res = await patch({ status: 'SHIPPED' });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe(BENCH_STOPS_CODE);
    nothingWritten();
  });

  it('the store asked is the ORDER’s (s9), not the session’s (s1), inside this company', async () => {
    bench();
    await patch({ shippingStatus: 'PACKING' });
    expect(db.store.findFirst.mock.calls[0][0].where).toEqual({ id: 's9', companyId: 'c1', isTest: true });
  });

  it('HISTORY: a bench parcel already gone keeps its road — the store is not even asked', async () => {
    bench();
    orderIs({ shippingStatus: 'SHIPPED', shippedAt: new Date('2026-10-16T05:00:00.000Z') });
    const res = await patch({ shippingStatus: 'OUT_FOR_DELIVERY' });
    expect(res.body.code).not.toBe(BENCH_STOPS_CODE);
    expect(db.store.findFirst).not.toHaveBeenCalled();
  });

  it('a note on a bench order is written — it is not a step toward a courier', async () => {
    bench();
    const res = await patch({ internalNotes: 'الزبون بيرد بعد العصر', reason: undefined });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(db.store.findFirst).not.toHaveBeenCalled();
  });
});

describe('NEGATIVE: a real store’s order, as before', () => {
  it('shippingStatus: PACKING is written', async () => {
    const res = await patch({ shippingStatus: 'PACKING' });
    expect(res.body.code).not.toBe(BENCH_STOPS_CODE);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('the combined status: SHIPPED is not refused by the bench stop', async () => {
    const res = await patch({ status: 'SHIPPED' });
    expect(res.body.code).not.toBe(BENCH_STOPS_CODE);
  });
});
