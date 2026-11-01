import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE LIVE ROLES, THROUGH THE REAL PERMISSION ENGINE (the owner, 1/11: «ح تفحصو كامل؟»)
 *
 * The door tests next door hand `can` its keys by hand, which is how the first version of the rule passed every test and would have
 * excused the ten real agents (the live CONFIRMATION_AGENT role holds `confirmation.supervise`). Here nothing about permissions is
 * mocked: each person is built the way a session is — keys and scopes turned into `effectiveGrants` by `computeEffectiveGrants` and
 * attached by `attachGrants` — and the REAL `can` and `authorize` answer for the REAL door. Only the database and the side effects are
 * stubbed.
 *
 * The key lists are what `GET /api/roles` returned on the live site on 1/11 (configuration, no customer data), except where a line says
 * it is a subset: the manager's and moderator's lists are cut to the keys that matter here.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, assertOrderAccess, reserveOrderLines } = vi.hoisted(() => ({
  db: {
    order: { updateMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
    customer: { findUnique: vi.fn(async () => null), update: vi.fn() },
    orderContactAttempt: { count: vi.fn(async () => 1) },
    orderStatusLog: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
    user: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  assertOrderAccess: vi.fn(),
  reserveOrderLines: vi.fn(async () => undefined),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', async (orig) => ({ ...(await orig<Record<string, unknown>>()), requirePermission: vi.fn() }));
vi.mock('@/lib/rbac', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a),
}));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/notify', () => ({ notify: vi.fn() }));
vi.mock('@/lib/reservation', () => ({ releaseOrderLines: vi.fn(async () => undefined), reserveOrderLines: (...a: unknown[]) => reserveOrderLines(...(a as [])) }));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: vi.fn() }));
vi.mock('@/lib/conversions/emit', () => ({ queueConversions: vi.fn() }));
vi.mock('@/lib/blacklist', () => ({ AlreadyBlocked: class extends Error {}, blockPhone: vi.fn() }));

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { NOT_HELD_MESSAGE } from '@/lib/confirmation-queue';
import { POST } from './route';

/** CONFIRMATION_AGENT, live, 1/11: all 22 keys, every one at the whole company. */
const LIVE_AGENT = [
  'ai.assist', 'ai.use', 'confirmation.issues', 'confirmation.issues_correct', 'confirmation.pull', 'confirmation.raise_issue',
  'confirmation.reassign', 'confirmation.supervise', 'confirmation.winback', 'confirmation.work', 'customers.view_basic', 'insights.view',
  'orders.change_price', 'orders.claim', 'orders.confirm', 'orders.contact_log', 'orders.edit', 'orders.note', 'orders.rating_link',
  'orders.release', 'orders.request_change', 'orders.view',
];
/** MANAGER, live, cut to what matters: it can take any order (unlock), hand any order out (assign), supervise and confirm. */
const LIVE_MANAGER = ['orders.view', 'orders.confirm', 'orders.contact_log', 'orders.assign', 'orders.unlock', 'confirmation.supervise'];
/** MODERATOR, live, cut to what matters: confirm and the call key company-wide, `orders.claim`, but NOT `confirmation.work`. */
const LIVE_MODERATOR = ['orders.view', 'orders.confirm', 'orders.contact_log', 'orders.claim'];
/** The shipped template that CI used to assume: no supervise. */
const TEMPLATE_AGENT = ['orders.edit', 'orders.confirm', 'orders.release', 'orders.contact_log', 'confirmation.pull', 'confirmation.work'];

async function person(id: string, role: string, keys: string[]): Promise<SessionUser> {
  const base = { id, email: `${id}@x`, name: id, role, roleId: `r-${id}`, status: 'ACTIVE', companyId: 'c1' } as unknown as SessionUser;
  const grants = await computeEffectiveGrants(base as never, {
    roleRows: async () => keys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
    overrideRows: async () => [],
  });
  return attachGrants(base, grants);
}

const ORDER: Record<string, unknown> = {
  id: 'o1', companyId: 'c1', storeId: 's1', version: 3, orderNumber: 'ORD-2026-1896',
  confirmationStatus: 'NEW', shippingStatus: 'NOT_READY', shippedAt: null, labelPrintedAt: null,
  claimedById: null, lockedById: null, lockExpiresAt: null, confirmedAt: null, customerId: 'cu1',
  nextFollowUpAt: null, followUpStatus: null, moderatorId: null,
  shippingBatchId: null, shippingBatch: null, deliveryProviderId: null, trackingNumber: null,
  courierSendStartedAt: null, totalAmount: 10, currency: 'USD', regionId: 'r1',
};

async function confirmAs(user: SessionUser, over: Record<string, unknown> = {}) {
  const order = { ...ORDER, ...over };
  requireContext.mockResolvedValue({ user, companyId: 'c1', storeId: 's1', country: { allowNegativeStock: false } });
  assertOrderAccess.mockResolvedValue({ allowed: true, order });
  db.order.findFirst.mockResolvedValue(order);
  db.order.findUnique.mockResolvedValue(order);
  const res = await POST(
    new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'confirm', expectedVersion: 3 }) }),
    { params: Promise.resolve({ id: 'o1' }) }
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.orderContactAttempt.count.mockResolvedValue(1);
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
});

describe('the ten live agents (role CONFIRMATION_AGENT, with `confirmation.supervise`) — Abeer', () => {
  it('confirming ORD-2026-1896 from the orders list, nobody holding it ⇒ refused NOT_HELD, nothing written', async () => {
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', LIVE_AGENT);
    const res = await confirmAs(abeer);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.code).toBe('NOT_HELD');
    expect(res.body.errorAr).toBe(NOT_HELD_MESSAGE);
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(reserveOrderLines).not.toHaveBeenCalled();
  });

  it('…and an order a colleague holds', async () => {
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', LIVE_AGENT);
    expect((await confirmAs(abeer, { claimedById: 'someone-else' })).body.code).toBe('NOT_HELD');
  });

  it('…and the order SHE pulled: confirmed, written once, reserved once', async () => {
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', LIVE_AGENT);
    const res = await confirmAs(abeer, { claimedById: 'abeer', confirmationStatus: 'IN_PROGRESS' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
    expect(reserveOrderLines).toHaveBeenCalledTimes(1);
  });

  it('the grants really are the live ones: she holds supervise and reassign, and neither unlock nor assign', async () => {
    const { can } = await import('@/lib/authorization');
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', LIVE_AGENT);
    expect(can(abeer, 'confirmation.supervise')).toBe(true);
    expect(can(abeer, 'confirmation.reassign')).toBe(true);
    expect(can(abeer, 'orders.unlock')).toBe(false);
    expect(can(abeer, 'orders.assign')).toBe(false);
  });
});

describe('the shipped template (no supervise) is bound too — the rule never depended on that key', () => {
  it('refused on an unheld order', async () => {
    const sara = await person('sara', 'CONFIRMATION_AGENT', TEMPLATE_AGENT);
    expect((await confirmAs(sara)).body.code).toBe('NOT_HELD');
  });
});

describe('whoever can take or hand out any order is not bound', () => {
  it('the live MANAGER confirms an order nobody holds', async () => {
    const manager = await person('manager', 'MANAGER', LIVE_MANAGER);
    const res = await confirmAs(manager);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('the owner (SUPER_ADMIN, who holds every key) confirms an order a colleague holds', async () => {
    const owner = await person('owner', 'SUPER_ADMIN', []);
    const res = await confirmAs(owner, { claimedById: 'someone-else' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});

describe('the one person the rule does NOT reach — and why it is written down', () => {
  it('a MODERATOR (live: orders.confirm + the call key, company-wide; no confirmation.work) can still confirm an unheld order — BACKLOG RV563', async () => {
    const mod = await person('mod', 'MODERATOR', LIVE_MODERATOR);
    const res = await confirmAs(mod);
    // Not an agent of the queue, so «اسحبه أولاً» is not hers to be told. Whether she should be bound is the owner's call.
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});
