import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — «شامل التوصيل» FOR AN ORDER THAT ALREADY EXISTS (the owner, 1/11)
 *
 * ORD-2026-1711 was collected at 23 for a 20$ line the customer had been told includes delivery, and 43 orders since 1/10 were in
 * the same case (a price equal to a delivery-included offer's, never bound to it). The box on the form stops it from now; this is
 * the door that corrects the ones already written — while nothing about the amount has reached the courier or the paper.
 *
 *  1. It flips `priceIncludesDelivery` and moves the stored total by EXACTLY what the flag moves it by (`codForOrder` asked with the
 *     flag as it is and as it will be, the difference added): 23 → 20 for 1711 and back; no fee priced yet → the total does not move.
 *  2. It refuses what the courier or the paper already holds, each with its own sentence, and writes NOTHING: a cancelled or
 *     rejected order; a batch handed over / a shipped parcel / a printed waybill (`orderSeal`); a barcode or a send in flight.
 *  3. It asks the order's own version, twice (read and write): a parcel put on a trolley or printed meanwhile makes it refuse.
 *  4. `orders.change_fee` and the order's own door: nobody else flips it.
 *  5. `dryRun` says the two figures and writes nothing, so the screen can state them before the press.
 *  6. Every change leaves a timeline row and an audit row, with the before and the after.
 *
 * Blockers: this WRITES an order's total (money) — so the figure is `codForOrder`'s, never typed; no migration; no customer data.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, assertOrderAccess, authorize, logAudit } = vi.hoisted(() => ({
  db: {
    order: { findFirst: vi.fn(), updateMany: vi.fn() },
    orderActivity: { create: vi.fn() },
  },
  requireContext: vi.fn(),
  assertOrderAccess: vi.fn(),
  authorize: vi.fn(),
  logAudit: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/rbac', () => ({
  ORDER_ACCESS_STATUS: { NOT_FOUND: 404, WRONG_COMPANY: 404, NOT_ASSIGNED: 404 },
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a),
}));
vi.mock('@/lib/authorization', () => ({ authorize: (...a: unknown[]) => authorize(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/api-error', () => ({
  apiErrorResponse: (e: unknown) => Response.json({ error: `UNEXPECTED: ${(e as Error)?.message}` }, { status: 500 }),
}));

import { POST } from './route';

const line = (over: Record<string, unknown> = {}) => ({ quantity: 1, freeQuantity: 0, unitPrice: 20, discountShare: 0, lineTotal: 20, ...over });

/** ORD-2026-1711: a 20$ line, in an open trolley, the courier's fee 3 snapshotted, collected at 23. */
const ORDER = {
  id: 'o1', orderNumber: 'ORD-2026-1711', version: 3, confirmationStatus: 'CONFIRMED', shippingStatus: 'READY_FOR_PICKUP',
  shippedAt: null, labelPrintedAt: null, trackingNumber: null, courierSendStartedAt: null, priceIncludesDelivery: false,
  totalAmount: 23, deliveryFee: 3, shippingCost: 0, currency: 'USD',
  shippingBatch: { status: 'READY', batchNumber: 'BATCH-2026-0005' },
  items: [line()], addOns: [] as { quantity: number; price: number }[],
};

const send = (b: Record<string, unknown>) =>
  POST(new Request('http://localhost/api/orders/o1/delivery-included', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }), {
    params: Promise.resolve({ id: 'o1' }),
  });
const flip = (included = true, over: Record<string, unknown> = {}) => send({ included, expectedVersion: 3, ...over });

const given = (over: Record<string, unknown> = {}) => db.order.findFirst.mockResolvedValue({ ...ORDER, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1', role: 'MANAGER' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 2 } });
  assertOrderAccess.mockResolvedValue({ allowed: true, order: { id: 'o1', companyId: 'c1' } });
  authorize.mockReturnValue({ allowed: true });
  given();
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.orderActivity.create.mockResolvedValue({});
  logAudit.mockResolvedValue(undefined);
});

describe('the figure moves by exactly what the flag moves it by', () => {
  it('ORD-2026-1711: delivery included → 23 becomes 20, with the flag, a version, a timeline row and an audit row', async () => {
    const res = await flip(true, { reason: 'العرض شامل التوصيل' });
    const out = await res.json();
    expect(res.status).toBe(200);
    expect(out).toMatchObject({ changed: true, included: true, totalBefore: 23, totalAfter: 20, delta: -3, version: 4 });

    const w = db.order.updateMany.mock.calls[0][0];
    expect(w.data).toEqual({ priceIncludesDelivery: true, totalAmount: 20, version: { increment: 1 } });
    expect(JSON.parse(db.orderActivity.create.mock.calls[0][0].data.metadata)).toEqual({
      from: false, to: true, totalBefore: 23, totalAfter: 20, reason: 'العرض شامل التوصيل',
    });
    expect(db.orderActivity.create.mock.calls[0][0].data).toMatchObject({ orderId: 'o1', userId: 'u1', action: 'DELIVERY_INCLUDED_CHANGED' });
    expect(logAudit.mock.calls[0][0]).toMatchObject({
      action: 'ORDER_DELIVERY_INCLUDED_CHANGED', entityId: 'o1',
      previousData: { priceIncludesDelivery: false, totalAmount: 23 }, newData: { priceIncludesDelivery: true, totalAmount: 20 },
    });
  });

  it('and back: included → the fee is added again, 20 becomes 23', async () => {
    given({ priceIncludesDelivery: true, totalAmount: 20 });
    const out = await (await flip(false)).json();
    expect(out).toMatchObject({ changed: true, included: false, totalBefore: 20, totalAfter: 23, delta: 3 });
    expect(db.order.updateMany.mock.calls[0][0].data.totalAmount).toBe(23);
  });

  it('an order with no fee priced yet (not on a trolley): the flag is told, the total does not move', async () => {
    given({ shippingBatch: null, shippingStatus: 'NOT_READY', deliveryFee: null, shippingCost: 0, totalAmount: 20 });
    const out = await (await flip(true)).json();
    expect(out).toMatchObject({ changed: true, totalBefore: 20, totalAfter: 20, delta: 0 });
    expect(db.order.updateMany.mock.calls[0][0].data).toEqual({ priceIncludesDelivery: true, totalAmount: 20, version: { increment: 1 } });
  });

  it('a fee typed on the order (no courier fee yet) comes off when delivery is included — the creation door’s own formula', async () => {
    given({ shippingBatch: null, shippingStatus: 'NOT_READY', deliveryFee: null, shippingCost: 4, totalAmount: 24 });
    const out = await (await flip(true)).json();
    expect(out).toMatchObject({ totalBefore: 24, totalAfter: 20, delta: -4 });
  });

  it('whatever else made the stored total what it is stays: a discount, an add-on, an odd figure — only the fee moves', async () => {
    // goods 20 − discount 5 + add-on 12 = 27, plus the fee 3 = 30; stored as 30.
    given({
      items: [line({ discountShare: 5, lineTotal: 15 })], addOns: [{ quantity: 1, price: 12 }], totalAmount: 30,
    });
    const out = await (await flip(true)).json();
    expect(out).toMatchObject({ totalBefore: 30, totalAfter: 27, delta: -3 });

    // an old figure that is NOT what a fresh calculation gives (a stored 31): it moves by the fee and keeps its own oddness
    vi.clearAllMocks();
    requireContext.mockResolvedValue({ user: { id: 'u1', role: 'MANAGER' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 2 } });
    assertOrderAccess.mockResolvedValue({ allowed: true, order: { id: 'o1' } });
    authorize.mockReturnValue({ allowed: true });
    db.order.updateMany.mockResolvedValue({ count: 1 });
    given({ items: [line({ discountShare: 5, lineTotal: 15 })], addOns: [{ quantity: 1, price: 12 }], totalAmount: 31 });
    expect((await (await flip(true)).json()).totalAfter).toBe(28);
  });

  it('JOD has three decimals: the difference is rounded by the currency, not by two places', async () => {
    requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 3 } });
    given({ items: [line({ unitPrice: 17.5, lineTotal: 17.5 })], deliveryFee: 3.25, totalAmount: 20.75 });
    const out = await (await flip(true)).json();
    expect(out).toMatchObject({ totalBefore: 20.75, totalAfter: 17.5, delta: -3.25 });
  });
});

describe('dryRun says it, and writes nothing', () => {
  it('the two figures and the difference, with nothing written, no timeline row, no audit row', async () => {
    const out = await (await flip(true, { dryRun: true })).json();
    expect(out).toMatchObject({ dryRun: true, included: true, totalBefore: 23, totalAfter: 20, delta: -3, currency: 'USD' });
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.orderActivity.create).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('the same flag as the order has: nothing to do, said as such, and nothing written', async () => {
    const out = await (await flip(false)).json();
    expect(out).toMatchObject({ unchanged: true, included: false, totalBefore: 23, totalAfter: 23 });
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });
});

describe('it refuses what the courier or the paper already holds — and writes nothing', () => {
  const refused = async (over: Record<string, unknown>, code: string, status = 409) => {
    given(over);
    const res = await flip(true);
    expect(res.status, JSON.stringify(over)).toBe(status);
    expect((await res.json()).code, JSON.stringify(over)).toBe(code);
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.orderActivity.create).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  };

  it('a cancelled or a rejected order', async () => {
    await refused({ confirmationStatus: 'CANCELLED' }, 'ORDER_ENDED');
    await refused({ confirmationStatus: 'REJECTED' }, 'ORDER_ENDED');
  });

  it('a batch already handed over or closed, a parcel that shipped, a waybill that is printed — the seal, in its own words', async () => {
    await refused({ shippingBatch: { status: 'SHIPPED', batchNumber: 'BATCH-2026-0004' } }, 'ORDER_SEALED');
    await refused({ shippingBatch: { status: 'CLOSED', batchNumber: 'BATCH-2026-0003' } }, 'ORDER_SEALED');
    await refused({ shippedAt: new Date('2026-10-31') }, 'ORDER_SEALED');
    await refused({ shippingStatus: 'OUT_FOR_DELIVERY' }, 'ORDER_SEALED');
    await refused({ labelPrintedAt: new Date('2026-11-01') }, 'ORDER_SEALED');
  });

  it('says WHICH of the three closed it, so a person can act', async () => {
    given({ labelPrintedAt: new Date('2026-11-01') });
    expect((await (await flip(true)).json()).error).toContain('بوليصة الطلب طُبعت');
    given({ shippingBatch: { status: 'SHIPPED', batchNumber: 'BATCH-2026-0004' } });
    expect((await (await flip(true)).json()).error).toContain('BATCH-2026-0004');
  });

  it('a barcode of the courier’s, or a send in flight: the courier holds the amount', async () => {
    await refused({ trackingNumber: 'KSA100422577363' }, 'ALREADY_WITH_COURIER');
    await refused({ courierSendStartedAt: new Date('2026-11-01T10:00:00Z') }, 'ALREADY_WITH_COURIER');
  });

  it('an order somebody else changed since the screen read it', async () => {
    await refused({ version: 4 }, 'STALE_ORDER');
  });

  it('a write that finds the order moved on between the read and the write (a trolley, a print, a send): nothing is recorded', async () => {
    db.order.updateMany.mockResolvedValue({ count: 0 });
    const res = await flip(true);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ORDER_MOVED_ON');
    expect(db.orderActivity.create).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('and the write itself carries every one of those conditions, not only the read', async () => {
    await flip(true);
    const where = db.order.updateMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      id: 'o1', companyId: 'c1', storeId: 's1', version: 3,
      labelPrintedAt: null, shippedAt: null, trackingNumber: null, courierSendStartedAt: null,
      confirmationStatus: { notIn: ['CANCELLED', 'REJECTED'] },
    });
  });
});

describe('who', () => {
  it('NEGATIVE: somebody who may not change the fee is refused before anything is read', async () => {
    authorize.mockReturnValue({ allowed: false });
    const res = await flip(true);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('FEE_FORBIDDEN');
    expect(authorize.mock.calls[0][1]).toBe('orders.change_fee');
    expect(db.order.findFirst).not.toHaveBeenCalled();
  });

  it('NEGATIVE: an order she cannot see is not found, whatever the key', async () => {
    assertOrderAccess.mockResolvedValue({ allowed: false, reason: 'NOT_ASSIGNED' });
    const res = await flip(true);
    expect(res.status).toBe(404);
    expect(authorize).not.toHaveBeenCalled();
    expect(db.order.findFirst).not.toHaveBeenCalled();
  });

  it('NEGATIVE: an order of another store reads as nothing', async () => {
    db.order.findFirst.mockResolvedValue(null);
    const res = await flip(true);
    expect(res.status).toBe(404);
    expect(db.order.findFirst.mock.calls[0][0].where).toEqual({ id: 'o1', companyId: 'c1', storeId: 's1' });
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: anything but a boolean and a version is a 400, before the order is read', async () => {
    for (const b of [{ included: 'true', expectedVersion: 3 }, { included: 1, expectedVersion: 3 }, { expectedVersion: 3 }, { included: true }, { included: true, expectedVersion: '3' }]) {
      vi.clearAllMocks();
      requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 2 } });
      assertOrderAccess.mockResolvedValue({ allowed: true, order: { id: 'o1' } });
      authorize.mockReturnValue({ allowed: true });
      const res = await send(b);
      expect(res.status, JSON.stringify(b)).toBe(400);
      expect(db.order.findFirst).not.toHaveBeenCalled();
    }
  });
});
