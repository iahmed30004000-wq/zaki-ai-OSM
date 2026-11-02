import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE CALL LOG ASKS WHO HOLDS THE ORDER
 * (the independent review of #154, 2/11 — BACKLOG RV566, the call-logs half)
 *
 * `POST /api/orders/[id]/call-logs` writes a `CallLog` and a CALL_MADE activity on whatever order the caller can open — held or not. It
 * changes no status (a result that would is sent to the confirmation door), but it is half of «اتصلت ثم أكّدت»: the half the confirmation
 * door and the contact-attempts door refuse an agent on an order she does not hold.
 *
 *  1. an account bound by `mustHoldToWork` is refused 403 `NOT_HELD` — in the one sentence, nobody holding the order or a colleague —
 *     and no row is written;
 *  2. on the order she HOLDS it logs the call as before;
 *  3. the owner, a manager and an account that is no agent of the queue are not asked — as before;
 *  4. nothing legitimate calls this door (OrderDetailModal says its form was removed; `nothing-unused-ships` lists the route with no
 *     visible caller; no telephony or integration posts here), so no flow is broken by asking.
 *
 * Persons are built the way a session is (`computeEffectiveGrants` + `attachGrants`) and the REAL `can` / `authorize` answer.
 *
 * Blockers: no money, no order creation.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, assertOrderAccess } = vi.hoisted(() => ({
  db: {
    callLog: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  assertOrderAccess: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/rbac', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a),
}));

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { NOT_HELD_MESSAGE } from '@/lib/confirmation-queue';
import { POST } from './route';

/** CONFIRMATION_AGENT, live, 1/11 (`GET /api/roles`): all 22 keys at the whole company. `confirmation.supervise` excuses nobody. */
const LIVE_AGENT = [
  'ai.assist', 'ai.use', 'confirmation.issues', 'confirmation.issues_correct', 'confirmation.pull', 'confirmation.raise_issue',
  'confirmation.reassign', 'confirmation.supervise', 'confirmation.winback', 'confirmation.work', 'customers.view_basic', 'insights.view',
  'orders.change_price', 'orders.claim', 'orders.confirm', 'orders.contact_log', 'orders.edit', 'orders.note', 'orders.rating_link',
  'orders.release', 'orders.request_change', 'orders.view',
];
/** The shipped template without `confirmation.supervise`. */
const TEMPLATE_AGENT = ['orders.view', 'orders.edit', 'orders.confirm', 'orders.release', 'orders.contact_log', 'confirmation.pull', 'confirmation.work'];
/** MANAGER, live, cut to what matters (take any order, hand any out) — plus the call keys this door asks. */
const LIVE_MANAGER = ['orders.view', 'orders.edit', 'orders.confirm', 'orders.contact_log', 'orders.assign', 'orders.unlock', 'confirmation.supervise'];
/** MODERATOR, live, cut to what matters (no `confirmation.work`) — plus `orders.edit`, which this door asks (its scope is simplified). */
const LIVE_MODERATOR = ['orders.view', 'orders.edit', 'orders.confirm', 'orders.contact_log', 'orders.claim'];

async function person(id: string, role: string, keys: string[]): Promise<SessionUser> {
  const base = { id, email: `${id}@x`, name: id, role, roleId: `r-${id}`, status: 'ACTIVE', companyId: 'c1' } as unknown as SessionUser;
  const grants = await computeEffectiveGrants(base as never, {
    roleRows: async () => keys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
    overrideRows: async () => [],
  });
  return attachGrants(base, grants);
}

/** An order whose status the call does not move (`ANSWERED` maps to no status). */
const ORDER: Record<string, unknown> = { id: 'o1', companyId: 'c1', orderNumber: 'ORD-2026-1896', status: 'NEW', confirmationStatus: 'NEW', claimedById: null };

async function logCall(user: SessionUser, over: Record<string, unknown> = {}) {
  requireContext.mockResolvedValue({ user, companyId: 'c1', storeId: 's1' });
  assertOrderAccess.mockResolvedValue({ allowed: true, order: { ...ORDER, ...over } });
  const res = await POST(
    new Request('http://localhost/api/orders/o1/call-logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result: 'ANSWERED', notes: 'كلّمته' }),
    }),
    { params: Promise.resolve({ id: 'o1' }) }
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function expectNothingWritten() {
  expect(db.$transaction, 'فُتحت معاملة كتابة').not.toHaveBeenCalled();
  expect(db.callLog.create, 'انكتب سجلّ مكالمة على طلب ما هو بين يديها').not.toHaveBeenCalled();
  expect(db.orderActivity.create, 'انكتب CALL_MADE على طلب ما هو بين يديها').not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  db.callLog.create.mockResolvedValue({ id: 'cl1', callDate: new Date() });
  db.orderActivity.create.mockResolvedValue({});
});

describe('the live agent (role CONFIRMATION_AGENT, with `confirmation.supervise`) — Abeer', () => {
  it('an order NOBODY holds ⇒ 403 NOT_HELD, in the one sentence, and no row is written', async () => {
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', LIVE_AGENT);
    const res = await logCall(abeer);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.code).toBe('NOT_HELD');
    expect(res.body.errorAr).toBe(NOT_HELD_MESSAGE);
    expectNothingWritten();
  });

  it('an order a COLLEAGUE holds ⇒ the same', async () => {
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', LIVE_AGENT);
    const res = await logCall(abeer, { claimedById: 'someone-else' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_HELD');
    expectNothingWritten();
  });

  it('a CONFIRMED order nobody holds — the 20 of 1/11 had a call logged first ⇒ the same', async () => {
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', LIVE_AGENT);
    const res = await logCall(abeer, { confirmationStatus: 'CONFIRMED', status: 'CONFIRMED' });
    expect(res.body.code).toBe('NOT_HELD');
    expectNothingWritten();
  });

  it('the order SHE holds ⇒ exactly as before: a call log and a CALL_MADE row, written once', async () => {
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', LIVE_AGENT);
    const res = await logCall(abeer, { claimedById: 'abeer' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.success).toBe(true);
    expect(db.callLog.create).toHaveBeenCalledTimes(1);
    expect(db.callLog.create.mock.calls[0][0].data).toMatchObject({ orderId: 'o1', moderatorId: 'abeer', result: 'ANSWERED' });
    expect(db.orderActivity.create).toHaveBeenCalledTimes(1);
    expect(db.orderActivity.create.mock.calls[0][0].data).toMatchObject({ action: 'CALL_MADE', userId: 'abeer' });
  });

  it('a result that would MOVE the order is still sent to the confirmation door, on her own order too — unchanged', async () => {
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', LIVE_AGENT);
    requireContext.mockResolvedValue({ user: abeer, companyId: 'c1', storeId: 's1' });
    assertOrderAccess.mockResolvedValue({ allowed: true, order: { ...ORDER, claimedById: 'abeer' } });
    const res = await POST(
      new Request('http://localhost/api/orders/o1/call-logs', { method: 'POST', body: JSON.stringify({ result: 'CONFIRMED' }) }),
      { params: Promise.resolve({ id: 'o1' }) }
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('USE_CONFIRMATION_DOOR');
    expectNothingWritten();
  });

  it('the old refusals come first: without `orders.contact_log` she is told so, not NOT_HELD', async () => {
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', LIVE_AGENT.filter((k) => k !== 'orders.contact_log'));
    const res = await logCall(abeer);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CONTACT_LOG_NOT_ALLOWED');
    expectNothingWritten();
  });
});

describe('the shipped template (no supervise) is bound too — the rule never depended on that key', () => {
  it('refused on an order nobody holds', async () => {
    const sara = await person('sara', 'CONFIRMATION_AGENT', TEMPLATE_AGENT);
    const res = await logCall(sara);
    expect(res.body.code).toBe('NOT_HELD');
    expectNothingWritten();
  });
});

describe('whoever can take or hand out any order, and whoever is no agent of the queue, are not asked — as before', () => {
  it('the owner (SUPER_ADMIN) logs a call on an order a colleague holds', async () => {
    const owner = await person('owner', 'SUPER_ADMIN', []);
    const res = await logCall(owner, { claimedById: 'someone-else' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(db.callLog.create).toHaveBeenCalledTimes(1);
  });

  it('the live MANAGER (orders.unlock + orders.assign) logs a call on an order nobody holds', async () => {
    const manager = await person('manager', 'MANAGER', LIVE_MANAGER);
    const res = await logCall(manager);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(db.callLog.create).toHaveBeenCalledTimes(1);
  });

  it('an agent whose role was given `orders.unlock` is no longer bound — the rule turns off by a box (the pre-deploy report lists who)', async () => {
    const sara = await person('sara', 'CONFIRMATION_AGENT', [...LIVE_AGENT, 'orders.unlock']);
    const res = await logCall(sara);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('a MODERATOR (orders.contact_log + orders.edit, no confirmation.work) logs a call on an order he can open', async () => {
    const mod = await person('mod', 'MODERATOR', LIVE_MODERATOR);
    const res = await logCall(mod);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(db.callLog.create).toHaveBeenCalledTimes(1);
  });
});
