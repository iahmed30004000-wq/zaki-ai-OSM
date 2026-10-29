import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deliveryFeeChange, readFeeReason, FEE_REASON_MAX } from '@/lib/delivery-fee-change';

/**
 * A DELIVERY FEE CHANGED, AND NOBODY COULD SAY FROM WHAT, TO WHAT, OR WHY.
 *
 * `POST /api/orders/[id]/shipping` (`update_tracking`) wrote the new fee and its audit row said the shipping
 * status and the tracking number. The fee is read by the courier's statement (it is deducted from what he owes),
 * by commission (subtracted before it is computed) and by the agent's custody figure — so a fee quietly moved
 * from 2,500 to 0 moved money in three places and left nothing to find it by.
 *
 * `Order.deliveryFeeOverrideReason` was documented as «always carries a reason (written to the audit log)» and
 * was written by nothing at all.
 */

const {
  db, requireContext, assertOrderAccess, authorize, can, logAudit,
} = vi.hoisted(() => ({
  db: {
    order: { findFirst: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    user: { findUnique: vi.fn() },
    orderStatusLog: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  assertOrderAccess: vi.fn(),
  authorize: vi.fn(),
  can: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/rbac', () => ({
  ORDER_ACCESS_STATUS: { NOT_FOUND: 404, FORBIDDEN: 403 },
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a),
}));
vi.mock('@/lib/authorization', () => ({
  authorize: (...a: unknown[]) => authorize(...a),
  can: (...a: unknown[]) => can(...a),
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/notify', () => ({ notify: vi.fn() }));
vi.mock('@/lib/stock-consumption', () => ({ consumeOrderStock: vi.fn() }));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: vi.fn() }));
vi.mock('@/lib/conversions/emit', () => ({ queueConversions: vi.fn() }));
vi.mock('@/lib/delivery-attempts', () => ({ appendDeliveryAttempt: vi.fn() }));

import { POST } from './[id]/shipping/route';

const ORDER = {
  id: 'o1',
  orderNumber: 'SY-2026-0001',
  shippingStatus: 'PENDING',
  version: 4,
  trackingNumber: null,
  deliveryProviderId: null,
  storeId: 's1',
  lockedById: null,
  lockExpiresAt: null,
  totalAmount: 25_000,
  currency: 'SYP',
  priceIncludesDelivery: false,
  deliveryFee: 2500 as number | null,
};

const post = (body: Record<string, unknown>) =>
  POST(
    new Request('http://localhost/api/orders/o1/shipping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update_tracking', expectedVersion: 4, ...body }),
    }),
    { params: Promise.resolve({ id: 'o1' }) }
  );

const saved = () => db.order.updateMany.mock.calls[0][0].data;
const feeAudit = () => logAudit.mock.calls.map((c) => c[0]).filter((a) => a.action === 'DELIVERY_FEE_CHANGED');
const feeActivity = () => db.orderActivity.create.mock.calls.map((c) => c[0].data).filter((d) => d.action === 'DELIVERY_FEE_CHANGED');

function arm(order: Partial<typeof ORDER> = {}) {
  requireContext.mockResolvedValue({
    user: { id: 'u1', role: 'OPS', name: 'سامر' },
    companyId: 'c1',
    storeId: 's1',
    country: { allowNegativeStock: false, minorUnit: 2 },
  });
  assertOrderAccess.mockResolvedValue({ allowed: true, order: { ...ORDER, ...order } });
  authorize.mockReturnValue({ allowed: true });
  can.mockReturnValue(true);
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.order.findUnique.mockResolvedValue({ ...ORDER });
  db.$transaction.mockImplementation(async (fn: any) => fn({ order: db.order }));
}

beforeEach(() => {
  vi.clearAllMocks();
  arm();
});

describe('a changed fee is recorded: before, after and the reason', () => {
  it('writes the reason to the order column and a row to the audit log and to the order timeline', async () => {
    const res = await post({ deliveryFee: 0, deliveryFeeReason: '  اتفاق مع الشركة على توصيل مجاني  ' });
    expect(res.status).toBe(200);

    expect(saved().deliveryFee).toBe(0);
    expect(saved().deliveryFeeOverrideReason).toBe('اتفاق مع الشركة على توصيل مجاني');

    expect(feeAudit()).toHaveLength(1);
    expect(feeAudit()[0]).toMatchObject({
      companyId: 'c1', userId: 'u1', entity: 'Order', entityId: 'o1',
      previousData: { deliveryFee: 2500 },
      newData: { deliveryFee: 0, reason: 'اتفاق مع الشركة على توصيل مجاني', by: 'سامر' },
    });

    expect(feeActivity()).toHaveLength(1);
    expect(JSON.parse(feeActivity()[0].metadata)).toMatchObject({
      feeBefore: 2500, feeAfter: 0, feeReason: 'اتفاق مع الشركة على توصيل مجاني',
    });
  });

  it('a change with no reason is still recorded — the reason is null, and a stale one is cleared', async () => {
    arm({ deliveryFee: 2500 });
    const res = await post({ deliveryFee: 3000 });
    expect(res.status).toBe(200);
    expect(saved().deliveryFeeOverrideReason).toBeNull();
    expect(feeAudit()[0].newData).toMatchObject({ deliveryFee: 3000, reason: null });
    expect(JSON.parse(feeActivity()[0].metadata)).not.toHaveProperty('feeReason');
  });

  it('«not recorded» (null) and a typed zero are different states: both directions are changes', async () => {
    arm({ deliveryFee: null });
    expect((await post({ deliveryFee: 0 })).status).toBe(200);
    expect(feeAudit()[0].previousData).toEqual({ deliveryFee: null });
    expect(feeAudit()[0].newData).toMatchObject({ deliveryFee: 0 });
    expect(JSON.parse(feeActivity()[0].metadata).feeBefore).toBe('غير مسجّلة');

    vi.clearAllMocks();
    arm({ deliveryFee: 0 });
    expect((await post({ deliveryFee: null })).status).toBe(200);
    expect(feeAudit()[0].previousData).toEqual({ deliveryFee: 0 });
    expect(feeAudit()[0].newData).toMatchObject({ deliveryFee: null });
  });
});

describe('and nothing is recorded when the fee did not change', () => {
  it('the same fee sent again (the screen sends it with a tracking edit) leaves no fee row and keeps the stored reason', async () => {
    arm({ deliveryFee: 2500 });
    const res = await post({ deliveryFee: '2500', trackingNumber: 'TRK-9', deliveryFeeReason: 'x' });
    expect(res.status).toBe(200);
    expect(feeAudit()).toHaveLength(0);
    expect(feeActivity()).toHaveLength(0);
    expect(saved()).not.toHaveProperty('deliveryFeeOverrideReason');
  });

  it('a request with no fee at all touches neither the fee nor its reason', async () => {
    const res = await post({ trackingNumber: 'TRK-9' });
    expect(res.status).toBe(200);
    expect(saved()).not.toHaveProperty('deliveryFee');
    expect(saved()).not.toHaveProperty('deliveryFeeOverrideReason');
    expect(feeAudit()).toHaveLength(0);
  });

  it('a refused fee writes no fee row either', async () => {
    const res = await post({ deliveryFee: 'abc' });
    expect(res.status).toBe(400);
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(feeAudit()).toHaveLength(0);
  });
});

describe('the reason is read strictly', () => {
  it.each([42, { a: 1 }, ['x'], true])('a reason that is not text (%j) is a 400 and nothing is written', async (reason) => {
    const res = await post({ deliveryFee: 0, deliveryFeeReason: reason });
    expect(res.status).toBe(400);
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('and one past the column length is refused', async () => {
    const res = await post({ deliveryFee: 0, deliveryFeeReason: 'ا'.repeat(FEE_REASON_MAX + 1) });
    expect(res.status).toBe(400);
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });
});

describe('the pure reader', () => {
  it('deliveryFeeChange: equal is null; null vs 0 is a change; strings from the database read as numbers', () => {
    expect(deliveryFeeChange(2500, 2500, null)).toBeNull();
    expect(deliveryFeeChange(null, null, 'x')).toBeNull();
    expect(deliveryFeeChange('2500', 2500, null)).toBeNull();
    expect(deliveryFeeChange(null, 0, null)).toEqual({ before: null, after: 0, reason: null });
    expect(deliveryFeeChange(0, null, 'r')).toEqual({ before: 0, after: null, reason: 'r' });
    expect(deliveryFeeChange(2500, 3000, 'r')).toEqual({ before: 2500, after: 3000, reason: 'r' });
  });

  it('readFeeReason: absent/null/blank are «none»; text is trimmed; anything else is refused', () => {
    expect(readFeeReason(undefined)).toEqual({ ok: true, reason: null });
    expect(readFeeReason(null)).toEqual({ ok: true, reason: null });
    expect(readFeeReason('   ')).toEqual({ ok: true, reason: null });
    expect(readFeeReason(' سبب ')).toEqual({ ok: true, reason: 'سبب' });
    expect(readFeeReason(7)).toEqual({ ok: false });
    expect(readFeeReason('a'.repeat(FEE_REASON_MAX + 1))).toEqual({ ok: false });
  });
});
