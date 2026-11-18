import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Confirmation centre guards: moderators never pull, store-sourced orders
 * cannot raise an entry issue, an issue is not a cancellation, VOID is owner
 * only, and a pending change request blocks forward shipping.
 */

const { db, requireContext, requirePermission, can, assertOrderAccess, logAudit } = vi.hoisted(() => ({
  db: {
    // B2 (18/11): the shipping doors now ask whether the store is a test bench (`bench-store.ts`); unset, this answers «no».
    store: { findFirst: vi.fn() },
    order: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    orderIssue: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    orderChangeRequest: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    orderNote: { create: vi.fn() },
    orderItem: { findMany: vi.fn(), updateMany: vi.fn() },
    user: { findMany: vi.fn(), findUnique: vi.fn() },
    $transaction: vi.fn(async (fn: any) => (typeof fn === 'function' ? fn(db) : fn)),
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  can: vi.fn(),
  assertOrderAccess: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: (...a: unknown[]) => requirePermission(...a),
  can: (...a: unknown[]) => can(...a),
  authorize: () => ({ allowed: true }),
}));
vi.mock('@/lib/rbac', () => ({ assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));

import * as pullRoute from '@/app/api/confirmation/pull/route';
import * as issuesRoute from '@/app/api/confirmation/issues/route';
import * as issueDecisionRoute from '@/app/api/confirmation/issues/[id]/route';
import * as crDecisionRoute from '@/app/api/control/change-requests/[id]/route';
import * as shippingRoute from '@/app/api/orders/[id]/shipping/route';

const ORDER_ID = '55555555-5555-4555-8555-555555555555';
const user = { id: 'u1', name: 'Agent', role: 'CONFIRMATION_AGENT', status: 'ACTIVE' };
const ctx = {
  user, companyId: 'c1', storeId: 's1', countryId: 'co1',
  country: {
    id: 'co1', code: 'JO', name: 'الأردن', currencyCode: 'JOD', minorUnit: 3, timezone: 'Asia/Amman',
    orderPrefix: 'ORD', allowNegativeStock: false, workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6],
  },
};
const body = (b: unknown, method = 'POST') =>
  new Request('http://localhost/x', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue(ctx);
  requirePermission.mockResolvedValue(user);
  can.mockReturnValue(false);
  db.orderNote.create.mockResolvedValue({});
  db.order.update.mockResolvedValue({});
});

describe('pulling the next order', () => {
  it('is refused without confirmation.pull (a moderator gets 403)', async () => {
    requirePermission.mockRejectedValue(new Error('Forbidden: missing required permission confirmation.pull'));
    const res = await pullRoute.POST();
    expect(res.status).toBe(403);
  });
});

describe('entry issues', () => {
  it('refuses an order that no moderator entered (store-sourced)', async () => {
    assertOrderAccess.mockResolvedValue({ allowed: true, order: { id: ORDER_ID, moderatorId: null } });
    const res = await issuesRoute.POST(body({ orderId: ORDER_ID, reason: 'WRONG_PHONE' }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('NOT_MODERATOR_ENTERED');
    expect(db.orderIssue.create).not.toHaveBeenCalled();
  });

  it('returns a moderator-entered order to the queue without cancelling it', async () => {
    assertOrderAccess.mockResolvedValue({ allowed: true, order: { id: ORDER_ID, moderatorId: 'mod1' } });
    db.orderIssue.findFirst.mockResolvedValue(null);
    db.orderIssue.create.mockImplementation(async ({ data }: any) => ({ id: 'iss1', ...data }));

    const res = await issuesRoute.POST(body({ orderId: ORDER_ID, reason: 'WRONG_ADDRESS', note: 'العنوان ناقص' }));
    expect(res.status).toBe(201);

    const orderUpdate = db.order.update.mock.calls[0][0].data;
    expect(orderUpdate).toMatchObject({ confirmationStatus: 'NEW', claimedById: null });
    // Not a cancellation, and created_at is never touched.
    expect(orderUpdate.status).toBe('NEW');
    expect(orderUpdate).not.toHaveProperty('createdAt');
    expect(orderUpdate).not.toHaveProperty('rejectionReason');
  });

  it('refuses VOID for anyone but the owner, and for a shipped order', async () => {
    db.orderIssue.findFirst.mockResolvedValue({
      id: 'iss1', status: 'OPEN', orderId: ORDER_ID, note: null,
      order: { id: ORDER_ID, confirmationStatus: 'CONFIRMED', shippingStatus: 'NOT_READY', shippedAt: null },
    });
    const denied = await issueDecisionRoute.PATCH(body({ action: 'void' }, 'PATCH'), params('iss1'));
    expect(denied.status).toBe(403);

    can.mockReturnValue(true); // now the owner
    db.orderIssue.findFirst.mockResolvedValue({
      id: 'iss1', status: 'OPEN', orderId: ORDER_ID, note: null,
      order: { id: ORDER_ID, confirmationStatus: 'CONFIRMED', shippingStatus: 'SHIPPED', shippedAt: new Date() },
    });
    const shipped = await issueDecisionRoute.PATCH(body({ action: 'void' }, 'PATCH'), params('iss1'));
    expect(shipped.status).toBe(409);
    expect((await shipped.json()).code).toBe('ALREADY_SHIPPED');
  });
});

describe('change requests', () => {
  it('refuses a decision by the same person who raised it', async () => {
    db.orderChangeRequest.findFirst.mockResolvedValue({
      id: 'cr1', status: 'PENDING', requestedById: user.id, orderId: ORDER_ID, order: { id: ORDER_ID, orderNumber: 'ORD-1' },
    });
    const res = await crDecisionRoute.PATCH(body({ decision: 'APPROVED' }, 'PATCH'), params('cr1'));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('SELF_APPROVAL');
  });

  it('requires a reason to reject', async () => {
    db.orderChangeRequest.findFirst.mockResolvedValue({
      id: 'cr1', status: 'PENDING', requestedById: 'other', orderId: ORDER_ID, order: { id: ORDER_ID, orderNumber: 'ORD-1' },
    });
    const res = await crDecisionRoute.PATCH(body({ decision: 'REJECTED' }, 'PATCH'), params('cr1'));
    expect(res.status).toBe(400);
  });

  it('never auto-approves: an already decided request is a conflict', async () => {
    db.orderChangeRequest.findFirst.mockResolvedValue({
      id: 'cr1', status: 'APPROVED', requestedById: 'other', orderId: ORDER_ID, order: { id: ORDER_ID, orderNumber: 'ORD-1' },
    });
    const res = await crDecisionRoute.PATCH(body({ decision: 'APPROVED' }, 'PATCH'), params('cr1'));
    expect(res.status).toBe(409);
  });

  it('blocks our forward shipping transition while one is pending', async () => {
    assertOrderAccess.mockResolvedValue({
      allowed: true,
      order: {
        id: ORDER_ID, companyId: 'c1', storeId: 's1', version: 1,
        confirmationStatus: 'CONFIRMED', shippingStatus: 'NOT_READY', lockedById: null, lockExpiresAt: null, shippedAt: null,
      },
    });
    can.mockReturnValue(true);
    db.orderChangeRequest.findFirst.mockResolvedValue({ id: 'cr1', reason: 'تغيير العنوان' });

    const res = await shippingRoute.POST(
      body({ action: 'transition', to: 'READY_FOR_SHIPPING', expectedVersion: 1 }),
      params(ORDER_ID)
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CHANGE_REQUEST_PENDING');
  });
});

describe('raising a change request', () => {
  it('needs only the field being changed, not all ten', async () => {
    // z.record keyed by an enum is EXHAUSTIVE in Zod 4. The schema quietly
    // demanded every changeable field, so the only answer anybody could get
    // was "اسم العميل مطلوب" — and no change request could be raised from
    // any screen at all.
    const { z } = await import('zod');
    const FIELDS = ['customerName', 'customerAddress', 'quantity'] as const;
    const value = z.object({ to: z.union([z.string(), z.number()]).nullable() });

    const exhaustive = z.record(z.enum(FIELDS), value);
    expect(exhaustive.safeParse({ customerAddress: { to: 'شارع' } }).success).toBe(false);

    const partial = z.partialRecord(z.enum(FIELDS), value);
    expect(partial.safeParse({ customerAddress: { to: 'شارع' } }).success).toBe(true);
  });
});
