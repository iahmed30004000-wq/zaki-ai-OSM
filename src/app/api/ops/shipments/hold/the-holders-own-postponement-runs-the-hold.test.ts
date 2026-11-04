import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * SALMA POSTPONES HER OWN CONFIRMED ORDER BEFORE IT ENTERS A BATCH — AND IT IS THE SAME HOLD (the owner, 2/11).
 *
 * «مش هذا الأسبوع»: the postponement is a HOLD — the order stays confirmed and goes out on its day — not an un-confirmation. The
 * raising door approves her own postponement on the spot; THIS is the door that carries it out, and it used to be the desk’s or the
 * packing table’s. The seam is the permission in front of it; the hold behind it is the one every hold goes through:
 *
 *   · the date and the reason come from the APPROVED request, on the server — never from the body;
 *   · the stock follows the hold exactly as it does for anybody (`holdReservation`): the units of an order that is still on our
 *     shelf go back on sale for the length of the hold, in the SAME transaction as the date and the request marked applied;
 *   · the window is asked again here with the batch — the order may have entered one between the raising and this press — and the
 *     trolley path (`holdFromTrolley`) is never the holder’s.
 *
 * THE REAL PERMISSION ENGINE; the database and the side effects are fakes.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, releaseOrderLines, reserveOrderLines, holdFromTrolley, logAudit } = vi.hoisted(() => ({
  db: {
    order: { findFirst: vi.fn(), update: vi.fn() },
    orderChangeRequest: { findFirst: vi.fn(), updateMany: vi.fn() },
    orderActivity: { create: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  releaseOrderLines: vi.fn(async (..._a: unknown[]) => 2),
  reserveOrderLines: vi.fn(async (..._a: unknown[]) => undefined),
  holdFromTrolley: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn() }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', async (orig) => ({ ...(await orig<Record<string, unknown>>()), requirePermission: vi.fn() }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/order-cancel', () => ({ holdFromTrolley: (...a: unknown[]) => holdFromTrolley(...a) }));
vi.mock('@/lib/reservation', () => ({
  releaseOrderLines: (...a: unknown[]) => releaseOrderLines(...a),
  reserveOrderLines: (...a: unknown[]) => reserveOrderLines(...a),
}));

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { POST } from './route';

const LIVE_AGENT = [
  'ai.assist', 'ai.use', 'confirmation.issues', 'confirmation.issues_correct', 'confirmation.pull', 'confirmation.raise_issue',
  'confirmation.reassign', 'confirmation.supervise', 'confirmation.winback', 'confirmation.work', 'customers.view_basic', 'insights.view',
  'orders.change_price', 'orders.claim', 'orders.confirm', 'orders.contact_log', 'orders.edit', 'orders.note', 'orders.rating_link',
  'orders.release', 'orders.request_change', 'orders.view',
];
const WITH_KEY = [...LIVE_AGENT, 'orders.edit_confirmed'];

async function person(id: string, role: string, keys: string[]): Promise<SessionUser> {
  const base = { id, email: `${id}@x`, name: id, role, roleId: `r-${id}`, status: 'ACTIVE', companyId: 'c1' } as unknown as SessionUser;
  const grants = await computeEffectiveGrants(base as never, {
    roleRows: async () => keys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
    overrideRows: async () => [],
  });
  return attachGrants(base, grants);
}

const ORDER_ID = '88888888-8888-4888-8888-888888888888';
const REQUEST_ID = '99999999-9999-4999-8999-999999999999';
const NEXT_WEEK = new Date(Date.now() + 7 * 86_400_000);

/** A confirmed order Salma holds, in no batch, nothing printed, nothing shipped. */
const stored = (over: Record<string, unknown> = {}) => ({
  id: ORDER_ID, orderNumber: 'SY-5', confirmationStatus: 'CONFIRMED', shippingStatus: 'NOT_READY', shippingBatchId: null,
  shipHoldUntil: null, version: 4, shippedAt: null, labelPrintedAt: null, claimedById: 'salma',
  ...over,
});

/** The postponement Salma raised and decided herself, not yet carried out. */
const approved = (over: Record<string, unknown> = {}) => ({
  id: REQUEST_ID, orderId: ORDER_ID, status: 'APPROVED', appliedAt: null, intent: 'POSTPONE',
  reason: 'الزبون مسافر', postponeUntil: NEXT_WEEK, ...over,
});

async function press(user: SessionUser, body: Record<string, unknown> = {}) {
  requireContext.mockResolvedValue({ user, companyId: 'c1', storeId: 's1', country: { allowNegativeStock: false } });
  const res = await POST(
    new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: ORDER_ID, changeRequestId: REQUEST_ID, ...body }),
    })
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

function expectNothingHappened() {
  expect(db.$transaction).not.toHaveBeenCalled();
  expect(db.order.update).not.toHaveBeenCalled();
  expect(releaseOrderLines).not.toHaveBeenCalled();
  expect(holdFromTrolley).not.toHaveBeenCalled();
  expect(db.orderChangeRequest.updateMany).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  db.order.findFirst.mockResolvedValue(stored());
  db.order.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: ORDER_ID, orderNumber: 'SY-5', shipHoldUntil: data.shipHoldUntil, shipHoldReason: data.shipHoldReason,
  }));
  db.orderChangeRequest.findFirst.mockResolvedValue(approved());
  db.orderChangeRequest.updateMany.mockResolvedValue({ count: 1 });
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
});

describe('the holder, with the key, on her own confirmed order in no batch — her postponement is carried out', () => {
  it('holds the order to the APPROVED day, for the APPROVED reason — read from the request, never from the body', async () => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', WITH_KEY);

    const res = await press(salma, { until: new Date(Date.now() + 25 * 86_400_000).toISOString(), reason: 'سبب آخر' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(db.order.update).toHaveBeenCalledTimes(1);
    const write = db.order.update.mock.calls[0][0] as { where: Record<string, unknown>; data: Record<string, unknown> };
    expect(write.where).toEqual({ id: ORDER_ID, version: 4 });
    expect(write.data.shipHoldUntil).toEqual(NEXT_WEEK);
    expect(write.data.shipHoldReason).toBe('الزبون مسافر');
    // The order stays CONFIRMED: this is a hold, not an un-confirmation.
    expect(write.data).not.toHaveProperty('confirmationStatus');
    expect(write.data).not.toHaveProperty('claimedById');
  });

  it('PUTS THE UNITS BACK ON SALE for the length of the hold — the same stock rule every hold has, in the same transaction', async () => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', WITH_KEY);

    await press(salma);

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(releaseOrderLines).toHaveBeenCalledTimes(1);
    expect(releaseOrderLines.mock.calls[0][0]).toBe(db);
    expect(releaseOrderLines.mock.calls[0][1]).toBe(ORDER_ID);
    const activity = db.orderActivity.create.mock.calls[0][0].data;
    expect(activity).toMatchObject({ action: 'SHIP_HOLD_SET', userId: 'salma' });
    expect(JSON.parse(activity.metadata)).toMatchObject({ stock: 'RELEASED' });
  });

  it('and a parcel already packed under this order’s name does NOT free its units — the hold’s own rule, not a second opinion', async () => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', WITH_KEY);
    // Off its trolley but packed (a waybill is printed): no batch, so the window is open; the units are not on a shelf.
    db.order.findFirst.mockResolvedValue(stored({ shippingStatus: 'READY_FOR_PICKUP', labelPrintedAt: new Date('2026-11-01T08:00:00Z') }));

    const res = await press(salma);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(releaseOrderLines).not.toHaveBeenCalled();
    expect(JSON.parse(db.orderActivity.create.mock.calls[0][0].data.metadata)).toMatchObject({ stock: 'KEPT' });
  });

  it('marks the request applied BY HER, once, in the same transaction as the date', async () => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', WITH_KEY);

    await press(salma);

    expect(db.orderChangeRequest.updateMany).toHaveBeenCalledWith({
      where: { id: REQUEST_ID, status: 'APPROVED', appliedAt: null },
      data: { appliedAt: expect.any(Date), appliedById: 'salma' },
    });
    expect(logAudit.mock.calls[0][0]).toMatchObject({ action: 'SHIP_HOLD_SET', entityId: ORDER_ID, userId: 'salma' });
  });

  it('never takes the trolley path — she is not on one', async () => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', WITH_KEY);

    await press(salma);

    expect(holdFromTrolley).not.toHaveBeenCalled();
  });
});

describe('every neighbour is refused 403 before anything moves — the window is asked AGAIN here, with the batch', () => {
  it('on a colleague’s order', async () => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', WITH_KEY);
    db.order.findFirst.mockResolvedValue(stored({ claimedById: 'someone-else' }));

    const res = await press(salma);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('لا تملك صلاحية تنفيذ هذا القرار');
    expectNothingHappened();
  });

  it('once the order has entered a batch between the raising and this press — and the trolley hold is not hers', async () => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', WITH_KEY);
    db.order.findFirst.mockResolvedValue(stored({ shippingStatus: 'READY_FOR_PICKUP', shippingBatchId: 'b1' }));

    const res = await press(salma);

    expect(res.status).toBe(403);
    expectNothingHappened();
  });

  it('with the courier — shipped by hand, in no batch', async () => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', WITH_KEY);
    db.order.findFirst.mockResolvedValue(stored({ shippingStatus: 'SHIPPED', shippedAt: new Date() }));

    const res = await press(salma);

    expect(res.status).toBe(403);
    expectNothingHappened();
  });

  it('without the key (the live role as it was on 1/11) — before the order is even read', async () => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', LIVE_AGENT);

    const res = await press(salma);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('لا تملك صلاحية تنفيذ هذا القرار');
    expect(db.order.findFirst).not.toHaveBeenCalled();
    expectNothingHappened();
  });

  it('a request that is not an approved postponement of THIS order is refused by the guards it always had', async () => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', WITH_KEY);

    db.orderChangeRequest.findFirst.mockResolvedValue(approved({ status: 'PENDING' }));
    expect((await press(salma)).body.code).toBe('NOT_APPROVED');
    db.orderChangeRequest.findFirst.mockResolvedValue(approved({ intent: 'CANCEL' }));
    expect((await press(salma)).body.code).toBe('WRONG_INTENT');
    db.orderChangeRequest.findFirst.mockResolvedValue(approved({ appliedAt: new Date() }));
    expect((await press(salma)).body.code).toBe('ALREADY_APPLIED');
    db.orderChangeRequest.findFirst.mockResolvedValue(approved({ postponeUntil: null }));
    expect((await press(salma)).body.code).toBe('NO_DATE');

    expectNothingHappened();
  });

  it('the hold cap is the hold’s own: a day more than 30 away is refused with its sentence, nothing written', async () => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', WITH_KEY);
    db.orderChangeRequest.findFirst.mockResolvedValue(approved({ postponeUntil: new Date(Date.now() + 45 * 86_400_000) }));

    const res = await press(salma);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('HOLD_TOO_LONG');
    expectNothingHappened();
  });
});

describe('everybody else is untouched', () => {
  // ruling 4/11 overturns M6 here: an approved postponement is not carried off an open trolley — the packing table holds it
  // with the batch screen's own «أجّل الشحن» (no request — a-parcel-on-a-trolley-can-be-held.test.ts).
  it('the packing table (ops.ship) does NOT carry a request out on a parcel on its open trolley — ON_OPEN_TROLLEY, nothing held', async () => {
    const hand = await person('hand', 'WAREHOUSE', ['orders.view', 'ops.ship']);
    db.order.findFirst.mockResolvedValue(stored({ shippingStatus: 'READY_FOR_PICKUP', shippingBatchId: 'b1', shippingBatch: { status: 'READY' } }));
    holdFromTrolley.mockResolvedValue({ ok: true, orderNumber: 'SY-5', courierCancelled: false });

    const res = await press(hand);

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('ON_OPEN_TROLLEY');
    expect(holdFromTrolley).not.toHaveBeenCalled();
  });

  it('…and a trolley it names but nobody can read is an open one (fail closed)', async () => {
    const hand = await person('hand', 'WAREHOUSE', ['orders.view', 'ops.ship']);
    db.order.findFirst.mockResolvedValue(stored({ shippingStatus: 'READY_FOR_PICKUP', shippingBatchId: 'b1', shippingBatch: null }));

    const res = await press(hand);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ON_OPEN_TROLLEY');
    expect(holdFromTrolley).not.toHaveBeenCalled();
  });

  it('the desk (control.change_requests) carries the same request out on a colleague’s order, as ever', async () => {
    const sup = await person('sup', 'CONFIRMATION_SUPERVISOR', ['orders.view', 'control.change_requests', 'control.change_requests_view']);

    const res = await press(sup);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(db.order.update).toHaveBeenCalledTimes(1);
  });
});
