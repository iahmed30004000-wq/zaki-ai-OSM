import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db, requireContext, can, assertOrderAccess, logAudit } = vi.hoisted(() => ({
  db: {
    order: { updateMany: vi.fn(), findUnique: vi.fn() },
    shippingBatch: { findFirst: vi.fn(), updateMany: vi.fn() },
    orderStatusLog: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
    orderChangeRequest: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  can: vi.fn(),
  assertOrderAccess: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: vi.fn(),
  can: (...a: unknown[]) => can(...a),
  authorize: vi.fn(() => ({ allowed: true })),
}));
vi.mock('@/lib/rbac', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a),
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/notify', () => ({ notify: vi.fn() }));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: vi.fn() }));
vi.mock('@/lib/conversions/emit', () => ({ queueConversions: vi.fn() }));

import { POST as shippingDoor } from '@/app/api/orders/[id]/shipping/route';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A PARCEL ON OUR OWN FLOOR HAS NOTHING TO RETURN (28/10, «قبل التسليم»).
 *
 * `READY_FOR_PICKUP → RETURN_REQUESTED` is a transition REMOVED, and marked
 * (shipping-workflow.ts, order-state.ts). It made a fake return — on the
 * returns desk, in the tracking alerts, in the customer's return rate — for a
 * box that never left the building. The shipping door answers anybody still
 * asking with the three doors that fit (cancel · hold · move to another
 * company as the same order), BEFORE the transition table, so the override
 * with a note (`orders.unlock`) cannot bring it back.
 *
 * Every refusal has its negative: a parcel the company really holds still
 * comes back the way it always did.
 * ═══════════════════════════════════════════════════════════════════════
 */

const ORDER_ID = '22222222-2222-4222-8222-222222222222';

const stored = (over: Record<string, unknown> = {}) => ({
  id: ORDER_ID, companyId: 'c1', storeId: 's1', version: 4, orderNumber: 'SY-1',
  confirmationStatus: 'CONFIRMED', shippingStatus: 'READY_FOR_PICKUP', shippedAt: null, labelPrintedAt: new Date(),
  shippingBatchId: 'b1', deliveryProviderId: 'co1', trackingNumber: null,
  lockedById: null, lockExpiresAt: null, totalAmount: 20, currency: 'JOD',
  ...over,
});

const move = async (to: string, extra: Record<string, unknown> = {}) => {
  const res = await shippingDoor(
    new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'transition', to, expectedVersion: 4, ...extra }),
    }),
    { params: Promise.resolve({ id: ORDER_ID }) }
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', role: 'DELIVERY_MANAGER', name: 'م' },
    companyId: 'c1', storeId: 's1',
    country: { minorUnit: 2, allowNegativeStock: false },
  });
  can.mockReturnValue(true);
  db.shippingBatch.findFirst.mockResolvedValue({ status: 'READY' });
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.order.findUnique.mockResolvedValue({ id: ORDER_ID });
  db.orderStatusLog.create.mockResolvedValue({});
  db.orderActivity.create.mockResolvedValue({});
  db.orderChangeRequest.findFirst.mockResolvedValue(null);
});

describe('READY_FOR_PICKUP → RETURN_REQUESTED, before the company took the parcel', () => {
  it('is refused with the three doors that fit — and writes nothing', async () => {
    assertOrderAccess.mockResolvedValue({ allowed: true, order: stored() });

    const res = await move('RETURN_REQUESTED', { returnReason: 'CUSTOMER_REQUEST' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_RETURN_BEFORE_HANDOVER');
    expect(res.body.error).toContain('ألغِ الطلب');
    expect(res.body.error).toContain('أجّل شحنه');
    expect(res.body.error).toContain('حوّله لشركة تانية');
    expect(db.order.updateMany, 'انكتب مرتجع وهمي').not.toHaveBeenCalled();
    expect(db.orderStatusLog.create).not.toHaveBeenCalled();
  });

  it('is refused for the override too: `orders.unlock` with a long note does not bring the fake return back', async () => {
    assertOrderAccess.mockResolvedValue({ allowed: true, order: stored() });
    can.mockReturnValue(true); // everything, including orders.unlock

    const res = await move('RETURN_REQUESTED', { returnReason: 'CUSTOMER_REQUEST', shippingNote: 'سبب طويل وكافي للتجاوز' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_RETURN_BEFORE_HANDOVER');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('is refused for a parcel on no trolley at all', async () => {
    assertOrderAccess.mockResolvedValue({ allowed: true, order: stored({ shippingBatchId: null }) });

    const res = await move('RETURN_REQUESTED', { returnReason: 'CUSTOMER_REQUEST' });

    expect(res.body.code).toBe('NO_RETURN_BEFORE_HANDOVER');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: an old row whose trolley WAS pressed (status never moved) gets the table’s own refusal, not ours', async () => {
    assertOrderAccess.mockResolvedValue({ allowed: true, order: stored() });
    db.shippingBatch.findFirst.mockResolvedValue({ status: 'SHIPPED' });
    can.mockImplementation((_u: unknown, key: string) => key !== 'orders.unlock');

    const res = await move('RETURN_REQUESTED', { returnReason: 'CUSTOMER_REQUEST' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVALID_TRANSITION');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a parcel the company holds and could not deliver still comes back', async () => {
    assertOrderAccess.mockResolvedValue({
      allowed: true,
      order: stored({ shippingStatus: 'FAILED_DELIVERY', shippedAt: new Date(), shippingBatch: { status: 'SHIPPED' } }),
    });
    db.shippingBatch.findFirst.mockResolvedValue({ status: 'SHIPPED' });

    const res = await move('RETURN_REQUESTED', { returnReason: 'CUSTOMER_REQUEST' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
    expect(db.order.updateMany.mock.calls[0][0].data.shippingStatus).toBe('RETURN_REQUESTED');
  });
});
