import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE APPLY STEP AGREES WITH THE SELF-DECISION — AT THE LAST PRESS (the owner, 2/11).
 *
 * The raising door approves the holder's own request on the spot (`the-holder-changes-her-own-order-until-it-enters-a-batch`), and
 * the browser then presses ONE more button: `PATCH /api/orders/[id]` with the request's id. That door asks `mayApply`, which asks
 * the SAME `mayDecide` — now with the order’s batch. If the two ever disagreed, a request she had decided herself would be
 * refused at the last press and sit in «بانتظار التطبيق» for somebody else to carry out.
 *
 * THE REAL PERMISSION ENGINE, as in the other tables: each person is built the way a session is, and `can` answers. The database
 * and the side effects are fakes. The order is a confirmed one with an approved request to change the street.
 *
 * AND THE DOOR ITSELF IS UNMOVED: a DIRECT edit of a confirmed order is still refused (`CHANGE_REQUEST_REQUIRED`), for her too —
 * what changed is who may DECIDE a request, not which door writes it.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, assertOrderAccess, logAudit } = vi.hoisted(() => ({
  db: {
    order: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    orderChannel: { findFirst: vi.fn() },
    shippingBatch: { findFirst: vi.fn() },
    customer: { update: vi.fn() },
    orderNote: { create: vi.fn(async () => ({})) },
    orderStatusLog: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
    orderContactAttempt: { count: vi.fn(async () => 1) },
    orderChangeRequest: { findFirst: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  assertOrderAccess: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn() }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/notify', () => ({ notify: vi.fn(), afterResponse: (fn: () => Promise<void>) => void fn() }));
vi.mock('@/lib/rbac', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a),
  assertOrderReadable: vi.fn(),
  orderVisibilityWhere: () => ({}),
}));

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { PATCH } from './route';

const LIVE_AGENT = [
  'ai.assist', 'ai.use', 'confirmation.issues', 'confirmation.issues_correct', 'confirmation.pull', 'confirmation.raise_issue',
  'confirmation.reassign', 'confirmation.supervise', 'confirmation.winback', 'confirmation.work', 'customers.view_basic', 'insights.view',
  'orders.change_price', 'orders.claim', 'orders.confirm', 'orders.contact_log', 'orders.edit', 'orders.note', 'orders.rating_link',
  'orders.release', 'orders.request_change', 'orders.view',
];
const WITH_KEY = [...LIVE_AGENT, 'orders.edit_confirmed'];
const SUPERVISOR = ['orders.view', 'orders.edit', 'orders.request_change', 'control.change_requests', 'control.change_requests_view', 'orders.change_price'];

async function person(id: string, role: string, keys: string[]): Promise<SessionUser> {
  const base = { id, email: `${id}@x`, name: id, role, roleId: `r-${id}`, status: 'ACTIVE', companyId: 'c1' } as unknown as SessionUser;
  const grants = await computeEffectiveGrants(base as never, {
    roleRows: async () => keys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
    overrideRows: async () => [],
  });
  return attachGrants(base, grants);
}

const ORDER_ID = '11111111-2222-4333-8444-555555555555';
const REQUEST_ID = 'aaaaaaaa-1111-4222-8333-444444444444';

/** A confirmed order Salma holds, in no batch, nothing printed, nothing shipped. */
const confirmed = (over: Record<string, unknown> = {}) => ({
  id: ORDER_ID, companyId: 'c1', storeId: 's1', customerId: 'cu1', version: 3, orderNumber: 'SY-5',
  confirmationStatus: 'CONFIRMED', shippingStatus: 'NOT_READY', shippedAt: null, labelPrintedAt: null,
  claimedById: 'salma', shippingBatchId: null, lockedById: null, lockExpiresAt: null, shippingCost: 3,
  ...over,
});

/** The request Salma raised and decided herself: the street. */
const approved = (over: Record<string, unknown> = {}) => ({
  id: REQUEST_ID, orderId: ORDER_ID, status: 'APPROVED', appliedAt: null, requestedById: 'salma',
  reason: 'الزبون غيّر العنوان بالتلفون', decisionNote: 'طُبِّق مباشرةً',
  changes: { customerAddress: { from: 'شارع قديم', to: 'شارع جديد' } },
  ...over,
});

async function patch(user: SessionUser, order: Record<string, unknown>, body: Record<string, unknown>) {
  requireContext.mockResolvedValue({
    user, companyId: 'c1', storeId: 's1',
    country: { code: 'JO', minorUnit: 3, currencyCode: 'JOD', allowNegativeStock: false },
  });
  assertOrderAccess.mockResolvedValue({ allowed: true, order });
  db.order.findUnique.mockResolvedValue(order);
  const res = await PATCH(
    new Request(`http://localhost/api/orders/${ORDER_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 3, ...body }),
    }),
    { params: Promise.resolve({ id: ORDER_ID }) }
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation(async (fn: never) => (typeof fn === 'function' ? (fn as (tx: unknown) => unknown)(db) : fn));
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.order.update.mockResolvedValue({});
  db.customer.update.mockResolvedValue({});
  db.shippingBatch.findFirst.mockResolvedValue(null);
  db.orderChangeRequest.findFirst.mockResolvedValue(approved());
  db.orderChangeRequest.updateMany.mockResolvedValue({ count: 1 });
});

describe('the holder, with the key, on her own confirmed order in no batch — the last press carries it out', () => {
  it('writes the APPROVED street, marks the request applied by HER, and audits who decided and why', async () => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', WITH_KEY);

    const res = await patch(salma, confirmed(), { changeRequestId: REQUEST_ID });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(JSON.stringify(db.customer.update.mock.calls)).toContain('شارع جديد');
    expect(db.orderChangeRequest.updateMany).toHaveBeenCalledWith({
      where: { id: REQUEST_ID, appliedAt: null },
      data: { appliedAt: expect.any(Date), appliedById: 'salma' },
    });
    const entry = logAudit.mock.calls.map((c) => c[0]).find((e) => e.entity === 'Order');
    expect(entry.action).toBe('ORDER_UPDATED_BY_CHANGE_REQUEST');
    expect(entry.userId).toBe('salma');
    expect(entry.newData.changeRequest).toEqual({ id: REQUEST_ID, reason: 'الزبون غيّر العنوان بالتلفون', decision: 'طُبِّق مباشرةً' });
  });
});

describe('every neighbour is refused at the last press — by the same predicate the raising door asked', () => {
  it('on a trolley that is still being filled ⇒ 403 NOT_THE_DECIDER, nothing written — the window ended at batch entry', async () => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', WITH_KEY);

    const res = await patch(salma, confirmed({ shippingStatus: 'READY_FOR_PICKUP', shippingBatchId: 'b1' }), { changeRequestId: REQUEST_ID });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_THE_DECIDER');
    expect(res.body.error).toContain('المستودع');
    expect(db.customer.update).not.toHaveBeenCalled();
    expect(db.orderChangeRequest.updateMany).not.toHaveBeenCalled();
  });

  it('on a colleague’s order ⇒ 403 NOT_THE_DECIDER, nothing written', async () => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', WITH_KEY);

    const res = await patch(salma, confirmed({ claimedById: 'someone-else' }), { changeRequestId: REQUEST_ID });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_THE_DECIDER');
    expect(db.customer.update).not.toHaveBeenCalled();
  });

  it('without the key ⇒ 403 NOT_THE_DECIDER, as the live role was refused on 1/11', async () => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', LIVE_AGENT);

    const res = await patch(salma, confirmed(), { changeRequestId: REQUEST_ID });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_THE_DECIDER');
    expect(db.customer.update).not.toHaveBeenCalled();
  });

  it('with the courier (shipped by hand, no trolley) ⇒ refused, never applied under her window', async () => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', WITH_KEY);

    const res = await patch(salma, confirmed({ shippingStatus: 'SHIPPED', shippedAt: new Date() }), { changeRequestId: REQUEST_ID });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_THE_DECIDER');
    expect(db.customer.update).not.toHaveBeenCalled();
  });

  it('a request still PENDING is not applied by anybody — the window decides who may decide, not that nobody did', async () => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', WITH_KEY);
    db.orderChangeRequest.findFirst.mockResolvedValue(approved({ status: 'PENDING' }));

    const res = await patch(salma, confirmed(), { changeRequestId: REQUEST_ID });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_APPROVED');
    expect(db.customer.update).not.toHaveBeenCalled();
  });

  it('another field riding along with the request is still refused — the window widens nothing here', async () => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', WITH_KEY);

    const res = await patch(salma, confirmed(), { changeRequestId: REQUEST_ID, customerPhone: '0799999999' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('STRAY_FIELDS');
    expect(db.customer.update).not.toHaveBeenCalled();
  });
});

describe('everybody else is untouched', () => {
  // ruling 4/11 overturns M6 here: on a trolley still being filled not even a supervisor carries a request out.
  it('a supervisor does NOT carry out the same request on a trolley that is still being filled — ON_OPEN_TROLLEY, nothing stamped', async () => {
    const sup = await person('sup', 'CONFIRMATION_SUPERVISOR', SUPERVISOR);
    db.shippingBatch.findFirst.mockResolvedValue({ status: 'READY', batchNumber: 'B-1' });

    const res = await patch(sup, confirmed({ shippingStatus: 'READY_FOR_PICKUP', shippingBatchId: 'b1' }), { changeRequestId: REQUEST_ID });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('ON_OPEN_TROLLEY');
    expect(db.orderChangeRequest.updateMany).not.toHaveBeenCalled();
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.order.update).not.toHaveBeenCalled();
  });
});

describe('the door is unmoved: a DIRECT edit of a confirmed order is still a request, for her too', () => {
  it('the holder with the key, no request id ⇒ 409 CHANGE_REQUEST_REQUIRED, nothing written', async () => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', WITH_KEY);

    const res = await patch(salma, confirmed(), { customerAddress: 'شارع آخر' });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('CHANGE_REQUEST_REQUIRED');
    expect(db.customer.update).not.toHaveBeenCalled();
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });
});
