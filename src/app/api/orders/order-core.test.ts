import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Stage 3 route guards: notes are append-only, a shipped order cannot be
 * cancelled, and an order with an unreserved line cannot become READY.
 */

const { db, requireContext, assertOrderAccess, logAudit, createNotification } = vi.hoisted(() => ({
  db: {
    // B2 (18/11): the shipping doors now ask whether the store is a test bench (`bench-store.ts`); unset, this answers «no».
    store: { findFirst: vi.fn() },
    orderNote: { findMany: vi.fn(), create: vi.fn() },
    // An order with no add-ons — plain functions, so a mock reset leaves them answering.
    orderAddOn: { aggregate: async () => ({ _sum: { reservedQty: 0 } }), findMany: async () => [], update: async () => ({}), updateMany: async () => ({ count: 0 }) },
    orderItem: { findMany: vi.fn() },
    orderChangeRequest: { findFirst: vi.fn() },
    user: { findMany: vi.fn(), findUnique: vi.fn() },
    order: { update: vi.fn(), updateMany: vi.fn() },
    deliveryProvider: { findFirst: vi.fn() },
    shippingBatch: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  assertOrderAccess: vi.fn(),
  logAudit: vi.fn(),
  createNotification: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/rbac', () => ({
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a),
  // Reads go through the list's envelope; the same verdict feeds both
  // here, because these tests are about what follows a verdict.
  assertOrderReadable: (...a: unknown[]) => assertOrderAccess(...a),
  ORDER_ACCESS_STATUS: { NOT_FOUND: 404, WRONG_COMPANY: 404, NOT_ASSIGNED: 404 },
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/notification', () => ({ createNotification: (...a: unknown[]) => createNotification(...a) }));
vi.mock('@/lib/authorization', () => ({
  can: () => true,
  authorize: () => ({ allowed: true }),
  requirePermission: vi.fn(),
}));

import * as notesRoute from '@/app/api/orders/[id]/notes/route';
import * as shippingRoute from '@/app/api/orders/[id]/shipping/route';

const user = { id: 'u1', name: 'Admin', role: 'COMPANY_ADMIN', status: 'ACTIVE' };
const ctx = {
  user, companyId: 'c1', storeId: 's1', countryId: 'co1',
  country: { id: 'co1', code: 'JO', name: 'الأردن', currencyCode: 'JOD', minorUnit: 3, timezone: 'Asia/Amman', orderPrefix: 'ORD', allowNegativeStock: false },
};
const params = { params: Promise.resolve({ id: 'o1' }) };
const req = (body: unknown) =>
  new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const order = (over: Record<string, unknown> = {}) => ({
  id: 'o1', companyId: 'c1', storeId: 's1', version: 1,
  confirmationStatus: 'CONFIRMED', shippingStatus: 'NOT_READY',
  lockedById: null, lockExpiresAt: null, shippedAt: null, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue(ctx);
  assertOrderAccess.mockResolvedValue({ allowed: true, order: order() });
  // No blocking change request unless a test says so.
  db.orderChangeRequest.findFirst.mockResolvedValue(null);
});

describe('order notes are immutable', () => {
  it('exposes no PATCH and no DELETE', () => {
    expect((notesRoute as Record<string, unknown>).PATCH).toBeUndefined();
    expect((notesRoute as Record<string, unknown>).DELETE).toBeUndefined();
    expect((notesRoute as Record<string, unknown>).PUT).toBeUndefined();
  });

  it('appends a note with the author and kind', async () => {
    db.orderNote.create.mockImplementation(async ({ data }: any) => ({ id: 'n1', ...data }));
    const res = await notesRoute.POST(req({ body: 'العميل طلب التأجيل ليوم الأحد', kind: 'follow_up' }), params);
    expect(res.status).toBe(201);
    expect(db.orderNote.create.mock.calls[0][0].data).toMatchObject({
      companyId: 'c1', orderId: 'o1', authorId: 'u1', kind: 'follow_up',
    });
  });

  it('rejects an unknown kind and an empty body', async () => {
    expect((await notesRoute.POST(req({ body: 'نص صالح', kind: 'invented' }), params)).status).toBe(400);
    expect((await notesRoute.POST(req({ body: ' ' }), params)).status).toBe(400);
  });

  it('returns the thread in chronological order', async () => {
    db.orderNote.findMany.mockResolvedValue([{ id: 'n1', authorId: 'u1', body: 'x', kind: 'internal', createdAt: new Date() }]);
    db.user.findMany.mockResolvedValue([{ id: 'u1', name: 'Admin' }]);
    const res = await notesRoute.GET(new Request('http://localhost/x'), params);
    const data = await res.json();
    expect(data.count).toBe(1);
    expect(db.orderNote.findMany.mock.calls[0][0].orderBy).toEqual({ createdAt: 'asc' });
  });
});

describe('shipping guards', () => {
  it('refuses READY_FOR_SHIPPING while a line is unreserved (409)', async () => {
    db.orderItem.findMany.mockResolvedValue([
      { quantity: 2, freeQuantity: 0, reservedQty: 2 },
      { quantity: 1, freeQuantity: 0, reservedQty: 0 },
    ]);
    const res = await shippingRoute.POST(
      req({ action: 'transition', to: 'READY_FOR_SHIPPING', expectedVersion: 1 }),
      params
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('UNRESERVED_LINES');
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('refuses cancelling an order that already shipped (409)', async () => {
    assertOrderAccess.mockResolvedValue({
      allowed: true,
      order: order({ shippingStatus: 'SHIPPED', shippedAt: new Date() }),
    });
    const res = await shippingRoute.POST(req({ action: 'transition', to: 'CANCELLED', expectedVersion: 1 }), params);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CANCEL_AFTER_SHIPPED');
  });
});
