import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * SALMA CANCELS HER OWN CONFIRMED ORDER BEFORE IT ENTERS A BATCH — AND IT IS THE SAME CANCEL (the owner, 2/11).
 *
 * The raising door approves her own cancellation on the spot; THIS is the door that carries it out. It used to be the desk’s or the
 * packing table’s (`control.change_requests` or `ops.ship`) and refused an agent with «لا تملك صلاحية تنفيذ هذا القرار», so a
 * cancellation she had decided herself would have sat approved and un-carried-out. The seam is the permission in front of
 * the door — nothing behind it moved:
 *
 *   · the HELPER IS THE REAL ONE (`endOrder`), over a fake database that records every write: the reservation is released, the
 *     customer’s cancellation is counted, the claim is let go, the request is marked applied in the same transaction, and
 *     System 7 hears `order.cancelled` — once, after the commit, from the helper and from nowhere else;
 *   · the PERMISSION ENGINE IS THE REAL ONE, and the window is asked again here with the batch (`holdsTheWindow`), because
 *     the order may have entered a batch between the raising and this press;
 *   · and the way in is for a CANCEL only: the same key does not open this door’s other outcome.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, releaseOrderLines, emitAppEvent, logAudit, notify } = vi.hoisted(() => ({
  db: {
    order: { findFirst: vi.fn(), updateMany: vi.fn() },
    orderChangeRequest: { findFirst: vi.fn(), updateMany: vi.fn() },
    orderStatusLog: { create: vi.fn(async () => ({})) },
    orderActivity: { create: vi.fn(async () => ({})) },
    orderNote: { create: vi.fn(async () => ({})) },
    customer: { update: vi.fn(async () => ({})) },
    shippingBatch: { findFirst: vi.fn() },
    deliveryProvider: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  releaseOrderLines: vi.fn(async (..._a: unknown[]) => 2),
  emitAppEvent: vi.fn(async (..._a: unknown[]) => 1),
  logAudit: vi.fn(async (..._a: unknown[]) => undefined),
  notify: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn() }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', async (orig) => ({ ...(await orig<Record<string, unknown>>()), requirePermission: vi.fn() }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/notify', () => ({ notify: (...a: unknown[]) => notify(...a) }));
vi.mock('@/lib/reservation', () => ({ releaseOrderLines: (...a: unknown[]) => releaseOrderLines(...a) }));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: (...a: unknown[]) => emitAppEvent(...a) }));

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

/** A confirmed order Salma holds, in no batch, nothing printed, nothing shipped — the row both the door and the helper read. */
const stored = (over: Record<string, unknown> = {}) => ({
  id: ORDER_ID, orderNumber: 'SY-5', version: 4, confirmationStatus: 'CONFIRMED',
  shippingStatus: 'NOT_READY', shippedAt: null, labelPrintedAt: null, shippingBatchId: null, shippingBatch: null,
  trackingNumber: null, deliveryProviderId: null, courierSendStartedAt: null,
  regionId: 'r1', deliveryFee: 3, totalAmount: 80, currency: 'JOD', customerId: 'cu1', claimedById: 'salma',
  ...over,
});

/** The cancellation Salma raised and decided herself, not yet carried out. */
const approved = (over: Record<string, unknown> = {}) => ({
  id: REQUEST_ID, orderId: ORDER_ID, status: 'APPROVED', appliedAt: null, intent: 'CANCEL',
  reason: 'الزبون تراجع بالاتصال', requestedById: 'salma', postponeUntil: null, cancelReason: 'CUSTOMER_CHANGED_MIND',
  ...over,
});

async function press(user: SessionUser, body: Record<string, unknown> = {}) {
  requireContext.mockResolvedValue({ user, companyId: 'c1', storeId: 's1' });
  const res = await POST(
    new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: ORDER_ID, outcome: 'CANCEL', changeRequestId: REQUEST_ID, ...body }),
    })
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

/** Nothing of the order changed: no write, no stock back, no count, no event. */
function expectNothingHappened() {
  expect(db.$transaction, 'انفتحت معاملة').not.toHaveBeenCalled();
  expect(db.order.updateMany).not.toHaveBeenCalled();
  expect(releaseOrderLines).not.toHaveBeenCalled();
  expect(db.customer.update).not.toHaveBeenCalled();
  expect(emitAppEvent).not.toHaveBeenCalled();
  expect(db.orderChangeRequest.updateMany).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  db.order.findFirst.mockResolvedValue(stored());
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.orderChangeRequest.findFirst.mockResolvedValue(approved());
  db.orderChangeRequest.updateMany.mockResolvedValue({ count: 1 });
  db.shippingBatch.findFirst.mockResolvedValue(null);
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
});

describe('the holder, with the key, on her own confirmed order in no batch — her cancellation is carried out', () => {
  it('goes through the ONE helper: written once, conditionally, the claim let go, the order CANCELLED', async () => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', WITH_KEY);

    const res = await press(salma);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
    const write = db.order.updateMany.mock.calls[0][0] as { where: Record<string, unknown>; data: Record<string, unknown> };
    // The conditional write: the version she read, no trolley, not shipped — a press or a dispatch that lands first makes it find nothing.
    expect(write.where).toMatchObject({ id: ORDER_ID, companyId: 'c1', version: 4, shippingBatchId: null, shippedAt: null });
    expect(write.data).toMatchObject({
      confirmationStatus: 'CANCELLED', status: 'CANCELLED', rejectionReason: 'CUSTOMER_CHANGED_MIND',
      claimedById: null, currentOwnerId: null, shippingStatus: 'NOT_READY',
    });
  });

  it('RELEASES THE RESERVATION in the same transaction — the units go back on the shelf', async () => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', WITH_KEY);

    await press(salma);

    expect(releaseOrderLines).toHaveBeenCalledTimes(1);
    expect(releaseOrderLines.mock.calls[0][0]).toBe(db);
    expect(releaseOrderLines.mock.calls[0][1]).toBe(ORDER_ID);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it('COUNTS THE CUSTOMER’S CANCELLATION, once', async () => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', WITH_KEY);

    await press(salma);

    expect(db.customer.update).toHaveBeenCalledTimes(1);
    expect(db.customer.update).toHaveBeenCalledWith({ where: { id: 'cu1' }, data: { cancelledOrders: { increment: 1 } } });
  });

  it('TELLS SYSTEM 7 `order.cancelled`, once, after the commit — from the helper', async () => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', WITH_KEY);

    await press(salma);

    expect(emitAppEvent).toHaveBeenCalledTimes(1);
    expect(emitAppEvent.mock.calls[0][0]).toBe('c1');
    expect(emitAppEvent.mock.calls[0][1]).toBe('order.cancelled');
    expect(emitAppEvent.mock.calls[0][2]).toMatchObject({
      orderId: ORDER_ID, orderNumber: 'SY-5', confirmationStatus: 'CANCELLED', previousStatus: 'CONFIRMED', total: 80, currency: 'JOD',
    });
  });

  it('marks the request applied BY HER, once, in the same transaction; the audit and the log name the door and the person', async () => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', WITH_KEY);

    await press(salma);

    expect(db.orderChangeRequest.updateMany).toHaveBeenCalledWith({
      where: { id: REQUEST_ID, appliedAt: null },
      data: { appliedAt: expect.any(Date), appliedById: 'salma' },
    });
    const activity = db.orderActivity.create.mock.calls.map((c: any[]) => c[0].data).find((d: any) => d.action === 'STATUS_CHANGED');
    expect(activity).toMatchObject({ userId: 'salma', previousStatus: 'CONFIRMED', newStatus: 'CANCELLED' });
    expect(JSON.parse(activity.metadata)).toMatchObject({ door: 'STAND_DOWN', workflow: 'CONFIRMATION' });
    expect(logAudit.mock.calls.map((c) => (c[0] as { action: string }).action)).toContain('SHIPMENT_STOOD_DOWN_CANCELLED');
    // …and the note on the order carries HER sentence, the only record of what the customer said.
    const note = (db.orderNote.create.mock.calls as unknown as Array<[{ data: { body: string } }]>)[0][0];
    expect(note.data.body).toContain('الزبون تراجع بالاتصال');
  });

  it('NEGATIVE: the request’s reason is the one stored, never one riding in the body', async () => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', WITH_KEY);

    await press(salma, { reason: 'PRICE_TOO_HIGH' });

    expect((db.order.updateMany.mock.calls[0][0] as { data: Record<string, unknown> }).data.rejectionReason).toBe('CUSTOMER_CHANGED_MIND');
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

  it('once the order has entered a batch between the raising and this press — the window ended at batch entry', async () => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', WITH_KEY);
    db.order.findFirst.mockResolvedValue(stored({ shippingStatus: 'READY_FOR_PICKUP', shippingBatchId: 'b1', shippingBatch: { status: 'READY', batchNumber: 'B-1' } }));
    db.shippingBatch.findFirst.mockResolvedValue({ status: 'READY' });

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

  it('without the key (the live role as it was on 1/11)', async () => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', LIVE_AGENT);

    const res = await press(salma);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('لا تملك صلاحية تنفيذ هذا القرار');
    // …before the order was even read.
    expect(db.order.findFirst).not.toHaveBeenCalled();
    expectNothingHappened();
  });

  it('THE WAY IN IS FOR A CANCEL ONLY: the same key does not open this door’s other outcome (the un-confirmation)', async () => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', WITH_KEY);
    db.orderChangeRequest.findFirst.mockResolvedValue(approved({ intent: 'POSTPONE', postponeUntil: new Date(Date.now() + 5 * 86_400_000), cancelReason: null }));

    const res = await press(salma, { outcome: 'POSTPONE' });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('لا تملك صلاحية تنفيذ هذا القرار');
    expectNothingHappened();
  });

  it('a request that is not an approved cancellation of THIS order is refused by the guards it always had', async () => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', WITH_KEY);

    db.orderChangeRequest.findFirst.mockResolvedValue(approved({ status: 'PENDING' }));
    expect((await press(salma)).body.code).toBe('NOT_APPROVED');

    db.orderChangeRequest.findFirst.mockResolvedValue(approved({ orderId: 'another-order' }));
    expect((await press(salma)).body.code).toBe('WRONG_ORDER');

    db.orderChangeRequest.findFirst.mockResolvedValue(approved({ appliedAt: new Date() }));
    expect((await press(salma)).body.code).toBe('ALREADY_APPLIED');

    expectNothingHappened();
  });

  it('no request id at all ⇒ the door asks `ops.ship` as ever, and the key alone is not it', async () => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', WITH_KEY);
    const { requirePermission } = await import('@/lib/authorization');
    (requirePermission as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Forbidden: missing required permission ops.ship'));

    requireContext.mockResolvedValue({ user: salma, companyId: 'c1', storeId: 's1' });
    const res = await POST(
      new Request('http://localhost/x', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: ORDER_ID, outcome: 'CANCEL', reason: 'CUSTOMER_CHANGED_MIND' }),
      })
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    expectNothingHappened();
  });
});

describe('everybody else is untouched', () => {
  it('the desk (control.change_requests) carries the same request out on an order nobody on the desk holds, as ever', async () => {
    const sup = await person('sup', 'CONFIRMATION_SUPERVISOR', ['orders.view', 'control.change_requests', 'control.change_requests_view']);
    db.order.findFirst.mockResolvedValue(stored({ claimedById: 'salma' }));

    const res = await press(sup);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(releaseOrderLines).toHaveBeenCalledTimes(1);
    expect(emitAppEvent).toHaveBeenCalledTimes(1);
  });

  it('the packing table (ops.ship) carries it out on an order on its trolley, as ever — the window is not what lets it', async () => {
    const hand = await person('hand', 'WAREHOUSE', ['orders.view', 'ops.ship']);
    db.order.findFirst.mockResolvedValue(stored({ shippingStatus: 'READY_FOR_PICKUP', shippingBatchId: 'b1', shippingBatch: { status: 'READY', batchNumber: 'B-1' } }));
    db.shippingBatch.findFirst.mockResolvedValue({ status: 'READY' });

    const res = await press(hand, { parcelInHand: true });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(emitAppEvent).toHaveBeenCalledTimes(1);
  });
});
