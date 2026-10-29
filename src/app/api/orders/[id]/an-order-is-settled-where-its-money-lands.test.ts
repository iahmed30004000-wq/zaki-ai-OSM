import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «SETTLED» IS WRITTEN WHERE THE MONEY LANDS — AND NOWHERE ELSE.
 *
 * `PATCH /api/orders/[id]/finance` let a holder of `finance.update` (or `settlement.review`) move an order from
 * PENDING, PENDING_COLLECTION, COLLECTED, UNSETTLED or PARTIALLY_* to SETTLED. The door writes no wallet
 * movement, no amount and no proof, and SETTLED is what four readers take as «the cash is in»:
 *
 *   collect/route.ts        refuses a second hand collection of it
 *   settlement.ts           refuses a statement line for it
 *   agent-custody-totals    drops it from what the courier still holds
 *   commission.ts           makes its commission PAYABLE
 *
 * So one person could settle an order with not one coin received, pay out its commission, and leave the real
 * collection refused as «already settled». The only two writers of SETTLED are the ones that put the money in
 * a wallet in the same transaction: the approval of a courier statement and «استلمت منه».
 *
 * Each test asserts that NOTHING was written — the order, the ledger, the status log, the activity and the
 * audit — because a refusal that wrote half of it is the defect again.
 *
 * Also here: `Order.refundAmount` had no writer (60). The figure was validated, put in the ledger and thrown
 * away; and a «partial refund» with no figure recorded the WHOLE order total.
 */

const {
  db, requireContext, assertOrderAccess, can, logAudit, commissionCostForOrders,
} = vi.hoisted(() => ({
  db: {
    order: { findFirst: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    financialTransaction: { create: vi.fn() },
    orderStatusLog: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
  },
  requireContext: vi.fn(),
  assertOrderAccess: vi.fn(),
  can: vi.fn(),
  logAudit: vi.fn(),
  commissionCostForOrders: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/rbac', () => ({
  ORDER_ACCESS_STATUS: { NOT_FOUND: 404, FORBIDDEN: 403 },
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a),
  assertOrderReadable: vi.fn(),
}));
vi.mock('@/lib/authorization', () => ({ can: (...a: unknown[]) => can(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/commission', () => ({
  commissionCostForOrders: (...a: unknown[]) => commissionCostForOrders(...a),
}));

import { PATCH } from './finance/route';

const ORDER_ID = '11111111-2222-4333-8444-555555555555';

const ORDER = {
  id: ORDER_ID,
  companyId: 'c1',
  version: 7,
  currency: 'SYP',
  settlementStatus: 'PENDING',
  totalAmount: 60_000,
  sellingPrice: 20_000,
  quantity: 3,
  shippingCost: 0,
  discount: null,
  shippingRevenue: null,
  productCost: null,
  packagingCost: null,
  advertisingCost: null,
  otherCost: null,
  estimatedCostOfGoods: 0,
  refundAmount: null as number | null,
};

const patch = (body: unknown) =>
  PATCH(
    new Request(`http://localhost/api/orders/${ORDER_ID}/finance`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: ORDER_ID }) }
  );

function armOrder(over: Partial<typeof ORDER> = {}) {
  assertOrderAccess.mockResolvedValue({ allowed: true, order: { ...ORDER, ...over } });
}

/** Everything a write would have touched. */
function nothingWritten() {
  expect(db.order.updateMany, 'الطلب كُتب').not.toHaveBeenCalled();
  expect(db.financialTransaction.create, 'قيد في دفتر المال').not.toHaveBeenCalled();
  expect(db.orderStatusLog.create, 'سجل حالة').not.toHaveBeenCalled();
  expect(db.orderActivity.create, 'نشاط').not.toHaveBeenCalled();
  expect(logAudit, 'تدقيق').not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'هدى', role: 'FINANCE' },
    companyId: 'c1',
    storeId: 's1',
  });
  armOrder();
  can.mockReturnValue(true);
  commissionCostForOrders.mockResolvedValue(0);
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.order.findUnique.mockResolvedValue({ ...ORDER });
});

describe('marking an order SETTLED through the finance door', () => {
  it.each(['PENDING', 'PARTIALLY_SETTLED', 'PARTIALLY_REFUNDED', 'PENDING_COLLECTION', 'COLLECTED', 'UNSETTLED'])(
    'is refused from %s, says where the money is recorded, and writes nothing',
    async (from) => {
      armOrder({ settlementStatus: from });
      const res = await patch({ expectedVersion: 7, settlementStatus: 'SETTLED' });
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body.code).toBe('SETTLE_THROUGH_COLLECTION');
      // The sentence names both real doors, so the person knows where to go.
      expect(body.errorAr).toContain('استلمت منه');
      expect(body.errorAr).toContain('التحصيل والكشوف');
      nothingWritten();
    }
  );

  it('and nothing else in the same request is half-applied: a cost sent with it is not saved either', async () => {
    const res = await patch({ expectedVersion: 7, settlementStatus: 'SETTLED', productCost: 500 });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('SETTLE_THROUGH_COLLECTION');
    nothingWritten();
  });

  it('even for the holder of every key — the refusal is about the door, not the person', async () => {
    can.mockReturnValue(true);
    const res = await patch({ expectedVersion: 7, settlementStatus: 'SETTLED' });
    expect(res.status).toBe(409);
    nothingWritten();
  });

  it('SETTLED → SETTLED is still the old refusal (not a valid move at all)', async () => {
    armOrder({ settlementStatus: 'SETTLED' });
    const res = await patch({ expectedVersion: 7, settlementStatus: 'SETTLED' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('INVALID_TRANSITION');
    nothingWritten();
  });

  it('a person with no financial authority at all still gets the 403, not the sentence about collection', async () => {
    can.mockReturnValue(false);
    const res = await patch({ expectedVersion: 7, settlementStatus: 'SETTLED' });
    expect(res.status).toBe(403);
    nothingWritten();
  });

  it('the other moves this door allows are untouched: a partial settlement, a refund, a cancel, a cost-only edit', async () => {
    const partial = await patch({ expectedVersion: 7, settlementStatus: 'PARTIALLY_SETTLED', amount: 2500 });
    expect(partial.status).toBe(200);

    vi.clearAllMocks();
    armOrder();
    can.mockReturnValue(true);
    commissionCostForOrders.mockResolvedValue(0);
    db.order.updateMany.mockResolvedValue({ count: 1 });
    db.order.findUnique.mockResolvedValue({ ...ORDER });
    const cancel = await patch({ expectedVersion: 7, settlementStatus: 'CANCELLED' });
    expect(cancel.status).toBe(200);

    vi.clearAllMocks();
    armOrder();
    can.mockReturnValue(true);
    commissionCostForOrders.mockResolvedValue(0);
    db.order.updateMany.mockResolvedValue({ count: 1 });
    db.order.findUnique.mockResolvedValue({ ...ORDER });
    const cost = await patch({ expectedVersion: 7, otherCost: 100 });
    expect(cost.status).toBe(200);
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe('the refund is written where it is decided (60)', () => {
  const saved = (): Record<string, any> | undefined => db.order.updateMany.mock.calls[0]?.[0]?.data;

  it('a partial refund with no figure is refused — it used to record the whole order total as «partial»', async () => {
    const res = await patch({ expectedVersion: 7, settlementStatus: 'PARTIALLY_REFUNDED' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('REFUND_AMOUNT_REQUIRED');
    nothingWritten();
  });

  it('a partial refund of zero is refused too', async () => {
    const res = await patch({ expectedVersion: 7, settlementStatus: 'PARTIALLY_REFUNDED', refundAmount: 0 });
    expect(res.status).toBe(400);
    nothingWritten();
  });

  it('a typed refund is saved on the order AND in the ledger, as the same figure', async () => {
    const res = await patch({ expectedVersion: 7, settlementStatus: 'PARTIALLY_REFUNDED', refundAmount: '1500.25' });
    expect(res.status).toBe(200);
    expect(String(saved()?.refundAmount)).toBe('1500.25');
    expect(String(db.financialTransaction.create.mock.calls[0][0].data.amount)).toBe('1500.25');
  });

  it('a full refund with no figure is the order total', async () => {
    const res = await patch({ expectedVersion: 7, settlementStatus: 'REFUNDED' });
    expect(res.status).toBe(200);
    expect(String(saved()?.refundAmount)).toBe('60000');
  });

  it('a second refund is ADDED to the first, and may not pass the order total together', async () => {
    armOrder({ settlementStatus: 'PARTIALLY_REFUNDED', refundAmount: 50_000 });
    const over = await patch({ expectedVersion: 7, settlementStatus: 'REFUNDED', refundAmount: 20_000 });
    expect(over.status).toBe(400);
    expect((await over.json()).code).toBe('REFUND_EXCEEDS_TOTAL');
    nothingWritten();

    vi.clearAllMocks();
    armOrder({ settlementStatus: 'PARTIALLY_REFUNDED', refundAmount: 50_000 });
    can.mockReturnValue(true);
    commissionCostForOrders.mockResolvedValue(0);
    db.order.updateMany.mockResolvedValue({ count: 1 });
    db.order.findUnique.mockResolvedValue({ ...ORDER });
    const ok = await patch({ expectedVersion: 7, settlementStatus: 'REFUNDED', refundAmount: 10_000 });
    expect(ok.status).toBe(200);
    expect(String(saved()?.refundAmount)).toBe('60000');
  });

  it('the running total is what a later partial settlement is measured against', async () => {
    armOrder({ settlementStatus: 'PENDING', refundAmount: 58_000 });
    const res = await patch({ expectedVersion: 7, settlementStatus: 'PARTIALLY_SETTLED', amount: 3_000 });
    expect(res.status).toBe(400);
    nothingWritten();
  });
});
