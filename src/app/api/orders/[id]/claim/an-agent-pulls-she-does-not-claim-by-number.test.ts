import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — AN AGENT TAKES AN ORDER BY PULLING THE NEXT ONE, NEVER BY ITS NUMBER
 * (the independent review of #154, 2/11 — BACKLOG RV565)
 *
 * `POST /api/orders/[id]/claim` takes ANY unheld order in ANY state — a confirmed one too — and skips the queue's order. The live agent
 * role holds `orders.claim`, so a request with an order number was a way to pick one out of the pool. Nothing on screen calls it for her:
 * `useOrderOwnership.claim` has no caller, `OrderResponsibility` posts only `?mode=override` (the owner) and DELETE (the release), and no
 * Telegram, system or app door posts here — so no flow needs it.
 *
 *  1. an account bound by `mustHoldToWork` is refused 403 `USE_THE_PULL` (a code of its own, not `NOT_HELD`) with the sentence that
 *     points to «اسحب الطلب التالي» — before anything is read or written, the best-effort hold included;
 *  2. for an account that works orders but holds no `confirmation.pull`, the sentence does not point at a button she does not have;
 *  3. the owner («استلمه أنا»), a manager (`orders.unlock` / `orders.assign`) and a moderator (`orders.claim`, no `confirmation.work`)
 *     take an order exactly as they did — a confirmed one included; the override and the release are untouched.
 *
 * The persons are built the way a session is (`computeEffectiveGrants` + `attachGrants`) and the REAL `can` answers.
 *
 * Blockers: no money, no order creation.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, assertOrderAccess, atomicClaim, logAudit, reserve } = vi.hoisted(() => ({
  db: {
    order: { findUnique: vi.fn(), count: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    user: { findUnique: vi.fn() },
    orderActivity: { create: vi.fn() },
    orderClaimHistory: { create: vi.fn() },
  },
  requireContext: vi.fn(),
  assertOrderAccess: vi.fn(),
  atomicClaim: vi.fn(),
  logAudit: vi.fn(),
  reserve: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/rbac', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a),
}));
vi.mock('@/lib/order-locks', () => ({
  atomicClaim: (...a: unknown[]) => atomicClaim(...a),
  isLockActive: () => false,
  lockConfig: () => ({ lockDurationMs: 60_000 }),
  ownershipSnapshot: () => ({ previousOwnerId: null }),
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/reserve-returning-customers', () => ({ reserveReturningCustomers: (...a: unknown[]) => reserve(...a) }));

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { claimByNumberMessage, NOT_HELD_MESSAGE } from '@/lib/confirmation-queue';
import { DELETE, POST } from './route';

/** CONFIRMATION_AGENT, live, 1/11 (`GET /api/roles`): all 22 keys at the whole company — `orders.claim` among them. */
const LIVE_AGENT = [
  'ai.assist', 'ai.use', 'confirmation.issues', 'confirmation.issues_correct', 'confirmation.pull', 'confirmation.raise_issue',
  'confirmation.reassign', 'confirmation.supervise', 'confirmation.winback', 'confirmation.work', 'customers.view_basic', 'insights.view',
  'orders.change_price', 'orders.claim', 'orders.confirm', 'orders.contact_log', 'orders.edit', 'orders.note', 'orders.rating_link',
  'orders.release', 'orders.request_change', 'orders.view',
];
/** The shipped template without `confirmation.supervise`. */
const TEMPLATE_AGENT = ['orders.edit', 'orders.claim', 'orders.confirm', 'orders.release', 'orders.contact_log', 'confirmation.pull', 'confirmation.work'];
/** An account that works orders and cannot pull: `confirmation.pull` unticked. */
const WORKS_BUT_CANNOT_PULL = LIVE_AGENT.filter((k) => k !== 'confirmation.pull');
/** MANAGER, live, cut to what matters: it can take any order (unlock), hand any out (assign) — and claims. */
const LIVE_MANAGER = ['orders.view', 'orders.claim', 'orders.confirm', 'orders.assign', 'orders.unlock', 'confirmation.supervise'];
/** MODERATOR, live, cut to what matters: `orders.claim` and `orders.confirm`, no `confirmation.work`. */
const LIVE_MODERATOR = ['orders.view', 'orders.confirm', 'orders.contact_log', 'orders.claim'];

async function person(id: string, role: string, keys: string[]): Promise<SessionUser> {
  const base = { id, email: `${id}@x`, name: id, role, roleId: `r-${id}`, status: 'ACTIVE', companyId: 'c1' } as unknown as SessionUser;
  const grants = await computeEffectiveGrants(base as never, {
    roleRows: async () => keys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
    overrideRows: async () => [],
  });
  return attachGrants(base, grants);
}

const QUEUED = { id: 'o1', companyId: 'c1', orderNumber: 'ORD-9', claimedById: null, signatureStatus: 'UNSIGNED', confirmationStatus: 'NEW', version: 3 };
const CONFIRMED_UNHELD = { ...QUEUED, confirmationStatus: 'CONFIRMED' };

async function take(user: SessionUser, order: Record<string, unknown> = QUEUED, query = '') {
  requireContext.mockResolvedValue({ user, companyId: 'c1', storeId: 's1' });
  assertOrderAccess.mockResolvedValue({ allowed: true, order });
  db.order.findUnique.mockResolvedValue(order);
  const res = await POST(new Request(`http://localhost/api/orders/o1/claim${query}`, { method: 'POST' }), { params: Promise.resolve({ id: 'o1' }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Nothing was read to decide it, nothing was held, nothing was claimed, nothing was written. */
function expectUntouched() {
  expect(reserve, 'انكتب حجز لزبون راجع').not.toHaveBeenCalled();
  expect(assertOrderAccess, 'انقرأ الطلب').not.toHaveBeenCalled();
  expect(atomicClaim, 'انسحب الطلب').not.toHaveBeenCalled();
  expect(db.orderClaimHistory.create).not.toHaveBeenCalled();
  expect(db.orderActivity.create).not.toHaveBeenCalled();
  expect(db.order.updateMany).not.toHaveBeenCalled();
  expect(logAudit).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  atomicClaim.mockResolvedValue(true);
  reserve.mockResolvedValue(0);
  db.order.findFirst.mockResolvedValue(null);
  db.order.count.mockResolvedValue(0);
  db.order.updateMany.mockResolvedValue({ count: 1 });
  logAudit.mockResolvedValue(undefined);
});

describe('the live agent (role CONFIRMATION_AGENT, with `orders.claim`) — Abeer', () => {
  it('an unheld order, by its number ⇒ 403 USE_THE_PULL, the sentence points to «اسحب الطلب التالي», and nothing is touched', async () => {
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', LIVE_AGENT);
    const res = await take(abeer);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.code).toBe('USE_THE_PULL');
    expect(res.body.code, 'NOT_HELD is the other doors’ word: she holds nothing yet, and taking is what is refused').not.toBe('NOT_HELD');
    expect(res.body.errorAr).toContain('اسحب الطلب التالي');
    expect(res.body.errorAr).toBe(claimByNumberMessage(() => true));
    expectUntouched();
  });

  it('a CONFIRMED order nobody holds — the worst case, nothing in the WHERE stopped it ⇒ refused the same', async () => {
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', LIVE_AGENT);
    const res = await take(abeer, CONFIRMED_UNHELD);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('USE_THE_PULL');
    expectUntouched();
  });

  it('an order a colleague holds ⇒ USE_THE_PULL as well (not ALREADY_CLAIMED: nothing about the order is asked)', async () => {
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', LIVE_AGENT);
    const res = await take(abeer, { ...QUEUED, claimedById: 'someone-else' });
    expect(res.body.code).toBe('USE_THE_PULL');
    expectUntouched();
  });

  it('even the order she already holds: she took it by the pull, and the pull is the one door', async () => {
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', LIVE_AGENT);
    const res = await take(abeer, { ...QUEUED, claimedById: 'abeer', signatureStatus: 'SIGNED' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('USE_THE_PULL');
    expectUntouched();
  });

  it('`orders.claim` unticked ⇒ the old refusal, first and unchanged', async () => {
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', LIVE_AGENT.filter((k) => k !== 'orders.claim'));
    const res = await take(abeer);
    expect(res.status).toBe(403);
    expect(res.body.code).toBeUndefined();
    expect(res.body.errorAr).toBe('لا تملك صلاحية سحب الطلبات من الطابور.');
    expectUntouched();
  });

  it('the owner’s override door is not hers: `?mode=override` still answers «فكّ القفل للمشرف وحده»', async () => {
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', LIVE_AGENT);
    const res = await take(abeer, QUEUED, '?mode=override');
    expect(res.status).toBe(403);
    expect(res.body.errorAr).toBe('فكّ القفل للمشرف وحده.');
    expect(res.body.code).toBeUndefined();
  });

  it('giving back the order she holds is untouched — the same file’s other door still works for her', async () => {
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', LIVE_AGENT);
    requireContext.mockResolvedValue({ user: abeer, companyId: 'c1', storeId: 's1' });
    const held = { id: 'o1', companyId: 'c1', claimedById: 'abeer', currentOwnerId: 'abeer', lockedById: null, version: 4, confirmationStatus: 'IN_PROGRESS', shippingStatus: 'NOT_READY' };
    assertOrderAccess.mockResolvedValue({ allowed: true, order: held });
    db.order.findUnique.mockResolvedValue({ ...held, claimedById: null });
    const res = await DELETE(new Request('http://localhost/api/orders/o1/claim?reason=%D8%A7%D9%86%D8%AA%D9%87%D9%89', { method: 'DELETE' }), {
      params: Promise.resolve({ id: 'o1' }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
    expect(db.order.updateMany.mock.calls[0][0].data).toMatchObject({ claimedById: null, confirmationStatus: 'NEW' });
  });
});

describe('the shipped template (no supervise) is bound too', () => {
  it('refused by number', async () => {
    const sara = await person('sara', 'CONFIRMATION_AGENT', TEMPLATE_AGENT);
    const res = await take(sara);
    expect(res.body.code).toBe('USE_THE_PULL');
    expectUntouched();
  });
});

describe('an account that works orders and cannot pull is not sent to a button she does not have', () => {
  it('USE_THE_PULL still — but the sentence does not say «اسحب الطلب التالي»', async () => {
    const dina = await person('dina', 'CONFIRMATION_AGENT', WORKS_BUT_CANNOT_PULL);
    const res = await take(dina);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('USE_THE_PULL');
    expect(res.body.errorAr).not.toContain('اسحب الطلب التالي');
    expect(res.body.errorAr).toBe(claimByNumberMessage(() => false));
    expectUntouched();
  });

  it('the two sentences are different, and neither is the other doors’ sentence', () => {
    const withPull = claimByNumberMessage((k) => k === 'confirmation.pull');
    const without = claimByNumberMessage(() => false);
    expect(withPull).not.toBe(without);
    expect([withPull, without]).not.toContain(NOT_HELD_MESSAGE);
  });
});

describe('whoever can take or hand out any order, and whoever is no agent of the queue, take an order exactly as before', () => {
  it('the owner (SUPER_ADMIN) takes an UNHELD CONFIRMED order — «استلمه أنا», the repair of ORD-2026-1896', async () => {
    const owner = await person('owner', 'SUPER_ADMIN', []);
    const res = await take(owner, CONFIRMED_UNHELD);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(atomicClaim).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledTimes(1);
  });

  it('the live MANAGER (orders.unlock + orders.assign) takes an unheld order, and a confirmed one', async () => {
    const manager = await person('manager', 'MANAGER', LIVE_MANAGER);
    for (const order of [QUEUED, CONFIRMED_UNHELD]) {
      atomicClaim.mockClear();
      const res = await take(manager, order);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(atomicClaim).toHaveBeenCalledTimes(1);
    }
  });

  it('the manager’s override (`?mode=override`, with a reason) is untouched', async () => {
    const manager = await person('manager', 'MANAGER', LIVE_MANAGER);
    requireContext.mockResolvedValue({ user: manager, companyId: 'c1', storeId: 's1' });
    assertOrderAccess.mockResolvedValue({ allowed: true, order: { ...QUEUED, claimedById: 'abeer' } });
    const res = await POST(
      new Request('http://localhost/api/orders/o1/claim?mode=override', { method: 'POST', body: JSON.stringify({ reason: 'الزبون طلب موظفة تانية' }) }),
      { params: Promise.resolve({ id: 'o1' }) }
    );
    expect(res.status, await res.clone().text()).toBe(200);
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
    expect(db.orderClaimHistory.create).toHaveBeenCalledTimes(1);
  });

  it('an account that works orders AND hands them out (`orders.assign` only) is not bound — the rule turns off by a box', async () => {
    const dispatcher = await person('dispatcher', 'CONFIRMATION_AGENT', [...LIVE_AGENT, 'orders.assign']);
    const res = await take(dispatcher);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(atomicClaim).toHaveBeenCalledTimes(1);
  });

  it('a MODERATOR (orders.claim, no confirmation.work) takes an unheld NEW order — pinned in the-role-matrix.test.ts, unchanged', async () => {
    const mod = await person('mod', 'MODERATOR', LIVE_MODERATOR);
    const res = await take(mod);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(atomicClaim).toHaveBeenCalledTimes(1);
  });
});
