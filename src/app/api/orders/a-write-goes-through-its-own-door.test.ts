import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SIDE DOORS THAT WROTE WITHOUT THE RULES OF THE FRONT DOOR.
 *
 * Found by the permissions audit and checked against the code. Each was a
 * second way to make a change that already had a proper door — with the
 * proper door's key, its order rules or its stock rules left behind:
 *
 *   · the tracking number through order editing (`orders.edit` alone);
 *   · a confirmed order's lines replaced directly, not by a change request;
 *   · the call log confirming and rejecting, with no stock reserved;
 *   · the re-order door, open to any `orders.edit` for any order;
 *   · two old queues with no caller, deciding by role name;
 *   · «أظهِرها في المتجر», which asked for no permission at all.
 *
 * Every refusal is paired with the case that must still go through, so a
 * fix that simply shut the door would fail here too.
 */

type Who = { id: string; name: string; role: string; status: 'ACTIVE'; keys: string[] };

const { db, requireContext, current, requirePermission } = vi.hoisted(() => ({
  db: {
    order: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
    orderChangeRequest: { findFirst: vi.fn() },
    orderChannel: { findFirst: vi.fn() },
    shippingBatch: { findFirst: vi.fn() },
    customer: { update: vi.fn() },
    orderStatusLog: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
    orderContactAttempt: { count: vi.fn() },
    landingPage: { findFirst: vi.fn(), update: vi.fn() },
    store: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  current: { order: {} as Record<string, unknown>, user: {} as Who },
  requirePermission: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/notify', () => ({ notify: vi.fn() }));
vi.mock('@/lib/landing-cache', () => ({ refreshLandingPages: vi.fn() }));
vi.mock('@/lib/authorization', () => ({
  can: (u: Who, k: string) => u.keys.includes(k),
  authorize: (u: Who, k: string) => (u.keys.includes(k) ? { allowed: true } : { allowed: false, reason: 'NO_SCOPE' }),
  getPermissionScope: (u: Who, k: string) => (u.keys.includes(k) ? { scope: 'ASSIGNED' } : null),
  requirePermission: (...a: unknown[]) => requirePermission(...a),
}));
vi.mock('@/lib/rbac', () => ({
  assertOrderAccess: async () => ({ allowed: true, order: current.order }),
  orderVisibilityWhere: () => ({}),
  ORDER_ACCESS_STATUS: { NOT_FOUND: 404, WRONG_COMPANY: 404, NOT_ASSIGNED: 404 },
}));
// The change request itself is approved and says «re-order»; what is under
// test is who may carry it out.
vi.mock('@/lib/change-request-apply', async (orig) => ({
  ...(await orig<typeof import('@/lib/change-request-apply')>()),
  authorises: () => ({ ok: true }),
  expandApproved: () => ({ ok: true, fields: { customerAddress: 'حي جديد' } }),
}));

import { PATCH as editOrder } from './[id]/route';
import { POST as reorder } from './[id]/reorder/route';
import { GET as followUps } from './follow-ups/route';
import { GET as shippingQueues } from './shipping/route';
import { PATCH as editLanding } from '../landing-pages/[id]/route';

const ORDER_ID = '11111111-2222-4333-8444-555555555555';
const person = (keys: string[], role = 'CUSTOM'): Who => ({ id: 'u1', name: 'سارة', role, status: 'ACTIVE', keys });

function as(user: Who) {
  current.user = user;
  requireContext.mockResolvedValue({ user, companyId: 'c1', storeId: 's1', country: { minorUnit: 2, currencyCode: 'USD' } });
  requirePermission.mockImplementation(async (k: string) => {
    if (!user.keys.includes(k)) throw new Error(`Forbidden: missing required permission ${k}`);
    return user;
  });
}

const order = (over: Record<string, unknown> = {}) => ({
  id: ORDER_ID, companyId: 'c1', storeId: 's1', customerId: 'cu1', version: 3,
  confirmationStatus: 'CONTACTING', shippingStatus: 'NOT_READY', shippingCost: 5,
  claimedById: null, lockedById: null, lockExpiresAt: null, ...over,
});

const patch = (body: unknown) =>
  editOrder(
    new Request(`http://x/api/orders/${ORDER_ID}`, { method: 'PATCH', body: JSON.stringify({ expectedVersion: 3, ...(body as object) }) }),
    { params: Promise.resolve({ id: ORDER_ID }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation(async (fn: unknown) => (typeof fn === 'function' ? (fn as (tx: unknown) => unknown)(db) : fn));
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.order.findUnique.mockImplementation(async () => current.order);
  db.orderContactAttempt.count.mockResolvedValue(1);
  current.order = order();
});

describe('the tracking number', () => {
  it('is refused through order editing — even for someone who may edit and ship', async () => {
    as(person(['orders.view', 'orders.edit', 'orders.change_status']));
    const res = await patch({ trackingCode: 'TRK-1' });
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(body.code).toBe('TRACKING_VIA_SHIPPING');
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.order.update).not.toHaveBeenCalled();
  });
});

describe('a confirmed order’s lines', () => {
  const LINES = { items: [{ productId: 'product-0001', quantity: 2, unitPrice: 10 }] };

  it('are a change request once the order is confirmed', async () => {
    // OLD → NEW (PR-6): + orders.change_price, the key the migration gives every orders.edit holder (the lines carry a price).
    as(person(['orders.view', 'orders.edit', 'orders.change_price']));
    current.order = order({ confirmationStatus: 'CONFIRMED' });
    const res = await patch(LINES);
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body.code).toBe('CHANGE_REQUEST_REQUIRED');
    expect(body.fields).toEqual(['items']);
    expect(body.fieldsAr).toEqual(['أسطر الطلب']);
  });

  it('and are not stopped by this lock before confirmation', async () => {
    as(person(['orders.view', 'orders.edit', 'orders.change_price']));
    const res = await patch(LINES);
    const body = await res.json().catch(() => ({}));
    expect(body.code).not.toBe('CHANGE_REQUEST_REQUIRED');
  });
});

describe('the re-order door', () => {
  const run = () =>
    reorder(
      new Request(`http://x/api/orders/${ORDER_ID}/reorder`, {
        method: 'POST',
        body: JSON.stringify({ changeRequestId: '99999999-8888-4777-8666-555555555555', courierNotified: true }),
      }),
      { params: Promise.resolve({ id: ORDER_ID }) },
    );

  beforeEach(() => {
    db.orderChangeRequest.findFirst.mockResolvedValue({ id: 'cr1', orderId: ORDER_ID, status: 'APPROVED', changes: {} });
    // With the courier: only the change-requests desk decides it.
    db.order.findFirst.mockResolvedValue(
      order({ confirmationStatus: 'CONFIRMED', shippingStatus: 'SHIPPED', shippedAt: new Date(), replacedBy: null }),
    );
    db.shippingBatch.findFirst.mockResolvedValue({ status: 'SHIPPED', batchNumber: 'SB-1' });
  });

  it('refuses someone whose only reason is orders.edit, on an order they do not decide', async () => {
    as(person(['orders.view', 'orders.edit']));
    const res = await run();
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(403);
    expect(body.code).toBe('NOT_THE_DECIDER');
  });

  it('lets the change-requests desk past the deciding check', async () => {
    as(person(['orders.view', 'control.change_requests']));
    const res = await run();
    const body = await res.json().catch(() => ({}));
    expect(body.code).not.toBe('NOT_THE_DECIDER');
  });
});

describe('the two old queues', () => {
  it('answer 410 with where to go — for everyone, the owner included', async () => {
    as(person(['orders.view', 'orders.change_status', 'confirmation.supervise'], 'SUPER_ADMIN'));
    for (const res of [await followUps(), await shippingQueues()]) {
      const body = await res.json();
      expect(res.status).toBe(410);
      expect(body.code).toBe('GONE');
      expect(body.errorAr).toMatch(/شاشة|بشاشات/);
    }
  });
});

describe('«أظهِرها في المتجر»', () => {
  const toggle = () =>
    editLanding(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ showInStore: true }) }), {
      params: Promise.resolve({ id: 'lp1' }),
    });

  beforeEach(() => {
    db.landingPage.findFirst.mockResolvedValue({ id: 'lp1', slug: 'p', storeId: 's1', productId: 'p1', isPublished: true });
    db.store.findFirst.mockResolvedValue(null);
    db.landingPage.update.mockResolvedValue({ id: 'lp1', showInStore: true });
  });

  it('is refused without landing_pages.edit — it asked for nothing before', async () => {
    as(person(['landing_pages.view']));
    const res = await toggle();
    expect(res.status).toBe(403);
    expect(db.landingPage.update).not.toHaveBeenCalled();
  });

  it('goes through with it', async () => {
    as(person(['landing_pages.view', 'landing_pages.edit']));
    const res = await toggle();
    expect(res.status).not.toBe(403);
    expect(requirePermission).toHaveBeenCalledWith('landing_pages.edit');
  });
});
