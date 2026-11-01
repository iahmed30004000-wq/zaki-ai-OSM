import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — «شامل التوصيل» FOR AN ORDER THAT ALREADY EXISTS (the owner, 1/11)
 *
 * ORD-2026-1711 was collected at 23 for a 20$ line the customer had been told includes delivery, and 43 orders since 1/10 were in
 * the same case (a price equal to a delivery-included offer's, never bound to it). The box on the form stops it from now; this is
 * the door that corrects the ones already written — while nothing about the amount has reached the courier or the paper.
 *
 *  1. It flips `priceIncludesDelivery` and writes the total `codForOrder` answers for the new flag — asked fresh, never «the stored
 *     figure plus a difference»: 23 → 20 for 1711 and back; no fee priced yet → the total does not move.
 *  2. It writes only when the stored total AGREES with the flag the order has now (the independent review, 1/11): the courier's fee
 *     is a column the tracking form edits without the total, and an order whose total stopped following its fee is refused
 *     (`COD_DRIFT`) for a person to reconcile — the repo's own rule for that state (`order-line-edit.ts`).
 *  3. It refuses what the courier or the paper already holds, each with its own sentence, and writes NOTHING: a cancelled or
 *     rejected order; a batch handed over / a shipped parcel / a printed waybill (`orderSeal`); a barcode or a send in flight;
 *     an order somebody else is editing right now (the lock the shipping door honours).
 *  4. It asks the order's own version, twice (read and write): a parcel put on a trolley or printed meanwhile makes it refuse.
 *  5. `orders.change_fee` evaluated against the order, and the order's own door: nobody else flips it.
 *  6. `dryRun` says the two figures (and whether the order is on a trolley, so the screen can say «reprint») and writes nothing,
 *     through the SAME refusals.
 *  7. The flag, the total and the timeline row are written together, in one transaction; the audit row follows.
 *
 * Blockers: this WRITES an order's total (money) — so the figure is `codForOrder`'s, never typed; no migration; no customer data.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, tx, requireContext, assertOrderAccess, authorize, can, logAudit } = vi.hoisted(() => ({
  db: {
    order: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
  // What the transaction hands the callback: the ONLY client the write and the timeline row may use.
  tx: {
    order: { updateMany: vi.fn() },
    orderActivity: { create: vi.fn() },
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
  ORDER_ACCESS_STATUS: { NOT_FOUND: 404, WRONG_COMPANY: 404, NOT_ASSIGNED: 404 },
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a),
}));
vi.mock('@/lib/authorization', () => ({
  authorize: (...a: unknown[]) => authorize(...a),
  can: (...a: unknown[]) => can(...a),
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/api-error', () => ({
  apiErrorResponse: (e: unknown) => Response.json({ error: `UNEXPECTED: ${(e as Error)?.message}` }, { status: 500 }),
}));

import { POST } from './route';

const line = (over: Record<string, unknown> = {}) => ({ quantity: 1, freeQuantity: 0, unitPrice: 20, discountShare: 0, lineTotal: 20, ...over });

const USER = { id: 'u1', role: 'MANAGER' };
const ACCESS_ORDER = { id: 'o1', companyId: 'c1' };

/** ORD-2026-1711: a 20$ line, in an open trolley, the courier's fee 3 snapshotted, collected at 23. */
const ORDER = {
  id: 'o1', orderNumber: 'ORD-2026-1711', version: 3, confirmationStatus: 'CONFIRMED', shippingStatus: 'READY_FOR_PICKUP',
  shippedAt: null, labelPrintedAt: null, trackingNumber: null, courierSendStartedAt: null, priceIncludesDelivery: false,
  totalAmount: 23, deliveryFee: 3, shippingCost: 0, currency: 'USD', lockedById: null, lockExpiresAt: null,
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
  requireContext.mockResolvedValue({ user: USER, companyId: 'c1', storeId: 's1', country: { minorUnit: 2 } });
  assertOrderAccess.mockResolvedValue({ allowed: true, order: ACCESS_ORDER });
  authorize.mockReturnValue({ allowed: true });
  can.mockReturnValue(false);
  given();
  db.$transaction.mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx));
  tx.order.updateMany.mockResolvedValue({ count: 1 });
  tx.orderActivity.create.mockResolvedValue({});
  logAudit.mockResolvedValue(undefined);
});

/** Nothing was written, not even a transaction opened, and nobody was told. */
function expectNothingWritten(why?: string) {
  expect(db.$transaction, why).not.toHaveBeenCalled();
  expect(tx.order.updateMany, why).not.toHaveBeenCalled();
  expect(tx.orderActivity.create, why).not.toHaveBeenCalled();
  expect(logAudit, why).not.toHaveBeenCalled();
}

describe('the total is what the calculator says for the new flag — asked fresh', () => {
  it('ORD-2026-1711: delivery included → 23 becomes 20, with the flag, a version, a timeline row and an audit row', async () => {
    const res = await flip(true, { reason: 'العرض شامل التوصيل' });
    const out = await res.json();
    expect(res.status).toBe(200);
    expect(out).toMatchObject({ changed: true, included: true, totalBefore: 23, totalAfter: 20, delta: -3, inBatch: true, version: 4 });

    const w = tx.order.updateMany.mock.calls[0][0];
    expect(w.data).toEqual({ priceIncludesDelivery: true, totalAmount: 20, version: { increment: 1 } });
    expect(JSON.parse(tx.orderActivity.create.mock.calls[0][0].data.metadata)).toEqual({
      from: false, to: true, totalBefore: 23, totalAfter: 20, reason: 'العرض شامل التوصيل',
    });
    expect(tx.orderActivity.create.mock.calls[0][0].data).toMatchObject({ orderId: 'o1', userId: 'u1', action: 'DELIVERY_INCLUDED_CHANGED' });
    expect(logAudit.mock.calls[0][0]).toMatchObject({
      action: 'ORDER_DELIVERY_INCLUDED_CHANGED', entityId: 'o1',
      previousData: { priceIncludesDelivery: false, totalAmount: 23 }, newData: { priceIncludesDelivery: true, totalAmount: 20 },
    });
  });

  it('and back: included → the fee is added again, 20 becomes 23', async () => {
    given({ priceIncludesDelivery: true, totalAmount: 20 });
    const out = await (await flip(false)).json();
    expect(out).toMatchObject({ changed: true, included: false, totalBefore: 20, totalAfter: 23, delta: 3 });
    expect(tx.order.updateMany.mock.calls[0][0].data.totalAmount).toBe(23);
  });

  it('an order with no fee priced yet (not on a trolley): the flag is told, the total does not move', async () => {
    given({ shippingBatch: null, shippingStatus: 'NOT_READY', deliveryFee: null, shippingCost: 0, totalAmount: 20 });
    const out = await (await flip(true)).json();
    expect(out).toMatchObject({ changed: true, totalBefore: 20, totalAfter: 20, delta: 0, inBatch: false });
    expect(tx.order.updateMany.mock.calls[0][0].data).toEqual({ priceIncludesDelivery: true, totalAmount: 20, version: { increment: 1 } });
  });

  it('a fee typed on the order (no courier fee yet) comes off when delivery is included — the creation door’s own formula', async () => {
    given({ shippingBatch: null, shippingStatus: 'NOT_READY', deliveryFee: null, shippingCost: 4, totalAmount: 24 });
    const out = await (await flip(true)).json();
    expect(out).toMatchObject({ totalBefore: 24, totalAfter: 20, delta: -4 });
  });

  it('a discount and an add-on stay in the figure: only the fee moves', async () => {
    // goods 20 − discount 5 + add-on 12 = 27, plus the fee 3 = 30; stored as 30.
    given({ items: [line({ discountShare: 5, lineTotal: 15 })], addOns: [{ quantity: 1, price: 12 }], totalAmount: 30 });
    const out = await (await flip(true)).json();
    expect(out).toMatchObject({ totalBefore: 30, totalAfter: 27, delta: -3 });
  });

  it('JOD has three decimals: the figure is rounded by the currency, not by two places', async () => {
    requireContext.mockResolvedValue({ user: USER, companyId: 'c1', storeId: 's1', country: { minorUnit: 3 } });
    given({ items: [line({ unitPrice: 17.5, lineTotal: 17.5 })], deliveryFee: 3.25, totalAmount: 20.75 });
    const out = await (await flip(true)).json();
    expect(out).toMatchObject({ totalBefore: 20.75, totalAfter: 17.5, delta: -3.25 });
  });

  it('a stored figure half a minor unit off the calculator is rounding noise: it is REPLACED by the calculator’s, not nudged', async () => {
    given({ totalAmount: 23.004 });
    const out = await (await flip(true)).json();
    expect(out).toMatchObject({ changed: true, totalAfter: 20 });
    expect(tx.order.updateMany.mock.calls[0][0].data.totalAmount).toBe(20);
  });

  it('a discount larger than the goods cannot push the collection below zero: the calculator caps it, so included is 0 and not −3', async () => {
    // goods 2, a discount of 5 capped at 2 → net 0; plus the fee 4 = 4 (stored as 4); included → 0.
    given({ items: [line({ unitPrice: 2, lineTotal: 2, discountShare: 5 })], deliveryFee: 4, totalAmount: 4 });
    const out = await (await flip(true)).json();
    expect(out).toMatchObject({ changed: true, totalBefore: 4, totalAfter: 0, delta: -4 });
    expect(tx.order.updateMany.mock.calls[0][0].data.totalAmount).toBe(0);
  });
});

describe('an order whose total no longer follows its fee is for a person to reconcile (COD_DRIFT)', () => {
  it('the odd figure: a stored 31 where the calculator says 30 is refused, and nothing is written', async () => {
    given({ items: [line({ discountShare: 5, lineTotal: 15 })], addOns: [{ quantity: 1, price: 12 }], totalAmount: 31 });
    const res = await flip(true);
    expect(res.status).toBe(409);
    const out = await res.json();
    expect(out.code).toBe('COD_DRIFT');
    expect(out.error).toContain('31');
    expect(out.error).toContain('30');
    expectNothingWritten();
  });

  it('the fee was changed on the tracking form without the total (fee 5, total still 23): refused', async () => {
    given({ deliveryFee: 5 });
    const res = await flip(true);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('COD_DRIFT');
    expectNothingWritten();
  });

  it('the same in the other direction: included, but the stored total still carries a fee', async () => {
    given({ priceIncludesDelivery: true, totalAmount: 23 });
    const res = await flip(false);
    expect((await res.json()).code).toBe('COD_DRIFT');
    expectNothingWritten();
  });

  it('the dry run is refused the same way, so the screen never states a figure the press would refuse', async () => {
    given({ deliveryFee: 5 });
    const res = await flip(true, { dryRun: true });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('COD_DRIFT');
  });

  it('the limit is half a minor unit: 0.004 off passes at two decimals, 0.006 off does not', async () => {
    given({ totalAmount: 23.006 });
    expect((await (await flip(true)).json()).code).toBe('COD_DRIFT');
    given({ totalAmount: 23.004 });
    expect((await (await flip(true)).json()).changed).toBe(true);
  });
});

describe('dryRun says it, and writes nothing', () => {
  it('the two figures, the difference and the trolley, with nothing written, no timeline row, no audit row', async () => {
    const out = await (await flip(true, { dryRun: true })).json();
    expect(out).toMatchObject({ dryRun: true, included: true, totalBefore: 23, totalAfter: 20, delta: -3, inBatch: true, currency: 'USD' });
    expectNothingWritten();
  });

  it('an order not on a trolley says so: nothing to reprint', async () => {
    given({ shippingBatch: null });
    const out = await (await flip(true, { dryRun: true })).json();
    expect(out.inBatch).toBe(false);
  });

  it('the same flag as the order has: nothing to do, said as such, and nothing written', async () => {
    const out = await (await flip(false)).json();
    expect(out).toMatchObject({ unchanged: true, included: false, totalBefore: 23, totalAfter: 23, inBatch: true });
    expectNothingWritten();
  });

  it('goes through the SAME refusals as the press: a sealed order, a locked one', async () => {
    given({ labelPrintedAt: new Date('2026-11-01') });
    expect((await (await flip(true, { dryRun: true })).json()).code).toBe('ORDER_SEALED');
    given({ lockedById: 'u2', lockExpiresAt: new Date(Date.now() + 60_000) });
    expect((await (await flip(true, { dryRun: true })).json()).code).toBe('ORDER_LOCKED');
  });
});

describe('it refuses what the courier or the paper already holds — and writes nothing', () => {
  const refused = async (over: Record<string, unknown>, code: string, status = 409) => {
    given(over);
    const res = await flip(true);
    expect(res.status, JSON.stringify(over)).toBe(status);
    expect((await res.json()).code, JSON.stringify(over)).toBe(code);
    expectNothingWritten(JSON.stringify(over));
  };

  it('a cancelled or a rejected order', async () => {
    await refused({ confirmationStatus: 'CANCELLED' }, 'ORDER_ENDED');
    await refused({ confirmationStatus: 'REJECTED' }, 'ORDER_ENDED');
  });

  it('a batch already handed over or closed, a parcel that shipped, a waybill that is printed — the seal', async () => {
    await refused({ shippingBatch: { status: 'SHIPPED', batchNumber: 'BATCH-2026-0004' } }, 'ORDER_SEALED');
    await refused({ shippingBatch: { status: 'CLOSED', batchNumber: 'BATCH-2026-0003' } }, 'ORDER_SEALED');
    await refused({ shippedAt: new Date('2026-10-31') }, 'ORDER_SEALED');
    await refused({ shippingStatus: 'OUT_FOR_DELIVERY' }, 'ORDER_SEALED');
    await refused({ labelPrintedAt: new Date('2026-11-01') }, 'ORDER_SEALED');
  });

  it('says WHICH of the three closed it, in this door’s own words (not the edit door’s «send a request»)', async () => {
    given({ labelPrintedAt: new Date('2026-11-01') });
    expect((await (await flip(true)).json()).error).toContain('بوليصة الطلب طُبعت');
    given({ shippedAt: new Date('2026-10-31') });
    expect((await (await flip(true)).json()).error).toContain('الطلب شُحن');
    given({ shippingBatch: { status: 'SHIPPED', batchNumber: 'BATCH-2026-0004' } });
    const batch = (await (await flip(true)).json()).error as string;
    expect(batch).toContain('BATCH-2026-0004');
    // Not the sentence of the edit door, which sends a person to a change request this flag cannot ride on.
    expect(batch).not.toContain('طلب تغيير');
  });

  it('a barcode of the courier’s, or a send in flight: the courier holds the amount', async () => {
    await refused({ trackingNumber: 'KSA100422577363' }, 'ALREADY_WITH_COURIER');
    await refused({ courierSendStartedAt: new Date('2026-11-01T10:00:00Z') }, 'ALREADY_WITH_COURIER');
  });

  it('an order somebody else changed since the screen read it', async () => {
    await refused({ version: 4 }, 'STALE_ORDER');
  });

  it('a write that finds the order moved on between the read and the write (a trolley, a print, a send): nothing is recorded', async () => {
    tx.order.updateMany.mockResolvedValue({ count: 0 });
    const res = await flip(true);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ORDER_MOVED_ON');
    expect(tx.orderActivity.create).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('and the write itself carries every one of those conditions, not only the read', async () => {
    await flip(true);
    const where = tx.order.updateMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      id: 'o1', companyId: 'c1', storeId: 's1', version: 3,
      labelPrintedAt: null, shippedAt: null, trackingNumber: null, courierSendStartedAt: null,
      confirmationStatus: { notIn: ['CANCELLED', 'REJECTED'] },
    });
  });
});

describe('an order somebody else is editing right now is left to her (the shipping door’s lock)', () => {
  const later = () => new Date(Date.now() + 5 * 60_000);

  it('a lock held by another person, still running: 423, and nothing is written', async () => {
    given({ lockedById: 'u2', lockExpiresAt: later() });
    const res = await flip(true);
    expect(res.status).toBe(423);
    expect((await res.json()).code).toBe('ORDER_LOCKED');
    expectNothingWritten();
  });

  it('NEGATIVE: her own lock, an expired lock, and a lock that is nobody’s are no obstacle', async () => {
    given({ lockedById: 'u1', lockExpiresAt: later() });
    expect((await (await flip(true)).json()).changed).toBe(true);
    given({ lockedById: 'u2', lockExpiresAt: new Date(Date.now() - 1000) });
    expect((await (await flip(true)).json()).changed).toBe(true);
    given({ lockedById: 'u2', lockExpiresAt: null });
    expect((await (await flip(true)).json()).changed).toBe(true);
  });

  it('whoever may unlock orders goes through another person’s lock, as at the shipping door', async () => {
    can.mockImplementation((_u: unknown, key: string) => key === 'orders.unlock');
    given({ lockedById: 'u2', lockExpiresAt: later() });
    expect((await (await flip(true)).json()).changed).toBe(true);
    expect(can.mock.calls.some((c) => c[1] === 'orders.unlock')).toBe(true);
  });
});

describe('the flag, the total and the timeline row are written together', () => {
  it('through the transaction’s client — the one the write and the row share', async () => {
    await flip(true);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.order.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.orderActivity.create).toHaveBeenCalledTimes(1);
    // The audit row is a separate best-effort write that follows the commit.
    expect(db.$transaction.mock.invocationCallOrder[0]).toBeLessThan(logAudit.mock.invocationCallOrder[0]);
  });

  it('a timeline row that cannot be written fails the press, and no audit row claims a change', async () => {
    tx.orderActivity.create.mockRejectedValue(new Error('disk full'));
    const res = await flip(true);
    expect(res.status).toBe(500);
    expect(logAudit).not.toHaveBeenCalled();
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

  it('the authority is evaluated against THE ORDER (a scoped grant reads it), not only the key', async () => {
    await flip(true);
    expect(authorize.mock.calls[0]).toEqual([USER, 'orders.change_fee', ACCESS_ORDER]);
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
    expectNothingWritten();
  });

  it('NEGATIVE: anything but a boolean and a version is a 400, before the order is read', async () => {
    const bodies = [
      { included: 'true', expectedVersion: 3 }, { included: 1, expectedVersion: 3 }, { expectedVersion: 3 },
      { included: true }, { included: true, expectedVersion: '3' }, { included: true, expectedVersion: 3, reason: 'x'.repeat(201) },
    ];
    for (const b of bodies) {
      db.order.findFirst.mockClear();
      const res = await send(b);
      expect(res.status, JSON.stringify(b)).toBe(400);
      expect(db.order.findFirst).not.toHaveBeenCalled();
    }
  });
});
