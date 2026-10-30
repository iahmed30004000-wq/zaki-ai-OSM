import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * WHO HEARS ABOUT AN ORDER'S OUTCOME, AT THE ROUTE.
 *
 * The review found no test that drove the order edit or the order creation
 * route and looked at the audience they send — so dropping the actor, or
 * telling the wrong moderator, would have passed every test. These do.
 */

const { db, requireContext, createNotification } = vi.hoisted(() => ({
  db: {
    order: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    user: { findFirst: vi.fn(), findUnique: vi.fn() },
    orderChannel: { findFirst: vi.fn() },
    shippingBatch: { findFirst: vi.fn() },
    customer: { update: vi.fn() },
    orderStatusLog: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
    orderChangeRequest: { findFirst: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  createNotification: vi.fn(),
}));

const ORDER_ID = '11111111-2222-4333-8444-555555555555';
let ORDER: Record<string, unknown>;

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/notification', () => ({ createNotification: (...a: unknown[]) => createNotification(...a) }));
vi.mock('@/lib/authorization', () => ({
  authorize: () => ({ allowed: true }),
  can: () => true,
  getPermissionScope: () => ({ scope: 'ALL_COMPANY' }),
}));
vi.mock('@/lib/rbac', () => ({
  assertOrderAccess: async () => ({ allowed: true, order: ORDER }),
  orderVisibilityWhere: () => ({}),
}));

import { PATCH } from './[id]/route';

// Company-wide edit scope owes a reason on a substantive edit
// (src/lib/order-edit-reason.ts); who gets told is what these tests measure.
const patch = (body: Record<string, unknown>) =>
  PATCH(
    new Request(`http://localhost/api/orders/${ORDER_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'قرار المالك بعد مراجعة الطلب', ...body }),
    }),
    { params: Promise.resolve({ id: ORDER_ID }) }
  );

beforeEach(() => {
  vi.clearAllMocks();
  ORDER = {
    id: ORDER_ID, companyId: 'c1', storeId: 's1', customerId: 'cu1', version: 3, orderNumber: 'SY-1',
    status: 'CONTACTING', confirmationStatus: 'IN_PROGRESS', shippingStatus: 'NOT_READY',
    moderatorId: 'mod-A', lockedById: null, lockExpiresAt: null, shippingCost: 0,
    // CHANGED 30/10 (no confirmation without a governorate) — was: no `regionId` on the fixture. The outcome is only reachable on an order that has one.
    regionId: 'r1',
  };
  requireContext.mockResolvedValue({
    user: { id: 'agent-1', name: 'سارة', role: 'CONFIRMATION_AGENT' },
    companyId: 'c1', storeId: 's1',
    country: { minorUnit: 2, currencyCode: 'USD' },
  });
  db.order.findUnique.mockImplementation(async () => ORDER);
  db.user.findFirst.mockResolvedValue({ id: 'mod-B' });
  db.$transaction.mockImplementation(async (fn: never) =>
    typeof fn === 'function' ? (fn as (tx: unknown) => unknown)(db) : fn
  );
  // Writes land, so the read-back after commit shows what was stored.
  db.order.updateMany.mockImplementation(async ({ data }: any) => {
    ORDER = { ...ORDER, ...data };
    return { count: 1 };
  });
  db.order.update.mockImplementation(async ({ data }: any) => {
    ORDER = { ...ORDER, ...data };
    return ORDER;
  });
  createNotification.mockResolvedValue(1);
});

const outcome = () => createNotification.mock.calls.find((c) => ['تأكيد طلب', 'رفض طلب', 'إلغاء طلب'].includes(c[0].title))?.[0];

describe('an outcome set through the order edit', () => {
  it('tells the store\'s confirmation supervisors and the order\'s moderator, never the actor', async () => {
    const res = await patch({ expectedVersion: 3, status: 'CONFIRMED' });
    expect(res.status).toBe(200);
    const n = outcome();
    expect(n).toMatchObject({
      companyId: 'c1',
      storeId: 's1',
      actorId: 'agent-1',
      type: 'SYSTEM_ALERT',
      audience: { permission: 'confirmation.supervise' },
    });
    expect(n.audience.userIds).toContain('mod-A');
  });

  it('tells BOTH moderators when the same edit moves the order to another one', async () => {
    // The commission follows the new owner; the old one saw it a moment ago.
    await patch({ expectedVersion: 3, status: 'CONFIRMED', moderatorId: 'mod-B' });
    expect(outcome().audience.userIds).toEqual(expect.arrayContaining(['mod-A', 'mod-B']));
  });

  it('tells nobody when the status did not change', async () => {
    ORDER = { ...ORDER, status: 'CONFIRMED' };
    await patch({ expectedVersion: 3, status: 'CONFIRMED' });
    expect(outcome()).toBeUndefined();
  });
});
