import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — «إدخال إشكال» ASKS WHO HOLDS THE ORDER, AND WHETHER THE ORDER IS STILL AT THE DESK
 * (the independent review of #154, 2/11 — BACKLOG RV564)
 *
 * The review ran this door with the keys of the LIVE agent role and got 201 on an order a COLLEAGUE held: a CONFIRMED order became NEW
 * with its holder cleared and its reservation still held. The button is drawn only on the cards of her own desk; the API took any
 * order with a `moderatorId`.
 *
 *  1. an account bound by `mustHoldToWork` is refused 403 `NOT_HELD` — nobody holds the order, or a colleague does — BEFORE any write;
 *  2. on the open order she HOLDS the door does exactly what it always did (all five open states);
 *  3. nobody — the owner and a manager included — sends an order that is past the confirmation desk back to NEW: 409 `PAST_CONFIRMATION`,
 *     the state in the sentence, nothing written (no flow needs it: after the yes the way is «تعديل · إلغاء · تأجيل»);
 *  4. the owner, a manager and a moderator are NOT asked who holds an open order — as before.
 *
 * Nothing about permissions is mocked: each person is built the way a session is (`computeEffectiveGrants` + `attachGrants`) and the REAL
 * `can` answers — the unit tests next door that hand `can` its keys by hand are how the first version of the rule passed every test and
 * would have excused every live agent. Only the database and the side effects are stubbed.
 *
 * Blockers: no money, no order creation, no stock.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, state, requireContext, assertOrderAccess, logAudit, createNotification } = vi.hoisted(() => ({
  db: {
    order: { update: vi.fn(), updateMany: vi.fn() },
    orderIssue: { findFirst: vi.fn(), create: vi.fn() },
    orderNote: { create: vi.fn() },
    $transaction: vi.fn(),
  },
  state: { user: null as unknown },
  requireContext: vi.fn(),
  assertOrderAccess: vi.fn(),
  logAudit: vi.fn(),
  createNotification: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', async (orig) => {
  const real = await orig<typeof import('@/lib/authorization')>();
  return {
    ...real,
    // The route's own key check, answered by the REAL engine for the person under test.
    requirePermission: async (permission: string) => {
      if (!real.can(state.user as SessionUser, permission)) throw new Error(`Forbidden: missing required permission ${permission}`);
      return state.user;
    },
  };
});
vi.mock('@/lib/rbac', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a),
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/notification', () => ({ createNotification: (...a: unknown[]) => createNotification(...a) }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: vi.fn() }));

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { NOT_HELD_MESSAGE, OPEN_CONFIRMATION } from '@/lib/confirmation-queue';
import { POST } from './route';

/** CONFIRMATION_AGENT, live, 1/11 (`GET /api/roles`): all 22 keys, every one at the whole company. `confirmation.supervise` excuses nobody. */
const LIVE_AGENT = [
  'ai.assist', 'ai.use', 'confirmation.issues', 'confirmation.issues_correct', 'confirmation.pull', 'confirmation.raise_issue',
  'confirmation.reassign', 'confirmation.supervise', 'confirmation.winback', 'confirmation.work', 'customers.view_basic', 'insights.view',
  'orders.change_price', 'orders.claim', 'orders.confirm', 'orders.contact_log', 'orders.edit', 'orders.note', 'orders.rating_link',
  'orders.release', 'orders.request_change', 'orders.view',
];
/** The shipped template without `confirmation.supervise` — the rule never depended on that key. */
const TEMPLATE_AGENT = ['orders.edit', 'orders.confirm', 'orders.release', 'orders.contact_log', 'confirmation.pull', 'confirmation.work', 'confirmation.raise_issue'];
/** MANAGER, live, cut to what matters (it can take any order, hand any out, supervise, confirm) — plus the box that opens this door. */
const LIVE_MANAGER = ['orders.view', 'orders.confirm', 'orders.contact_log', 'orders.assign', 'orders.unlock', 'confirmation.supervise', 'confirmation.raise_issue'];
/** MODERATOR, live, cut to what matters (no `confirmation.work`) — plus the issue boxes the PR-7 migration gave whoever held `confirmation.issues`. */
const LIVE_MODERATOR = ['orders.view', 'orders.confirm', 'orders.contact_log', 'orders.claim', 'confirmation.issues', 'confirmation.raise_issue', 'confirmation.issues_correct'];

async function person(id: string, role: string, keys: string[]): Promise<SessionUser> {
  const base = { id, email: `${id}@x`, name: id, role, roleId: `r-${id}`, status: 'ACTIVE', companyId: 'c1' } as unknown as SessionUser;
  const grants = await computeEffectiveGrants(base as never, {
    roleRows: async () => keys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
    overrideRows: async () => [],
  });
  return attachGrants(base, grants);
}

const ORDER_ID = '55555555-5555-4555-8555-555555555555';
const ORDER: Record<string, unknown> = {
  id: ORDER_ID, companyId: 'c1', storeId: 's1', orderNumber: 'ORD-2026-1896', version: 3,
  confirmationStatus: 'IN_PROGRESS', shippingStatus: 'NOT_READY', claimedById: null, moderatorId: 'mod-7',
  shippedAt: null, labelPrintedAt: null,
};

async function raise(user: SessionUser, over: Record<string, unknown> = {}) {
  state.user = user;
  requireContext.mockResolvedValue({ user, companyId: 'c1', storeId: 's1' });
  assertOrderAccess.mockResolvedValue({ allowed: true, order: { ...ORDER, ...over } });
  const res = await POST(
    new Request('http://localhost/api/confirmation/issues', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: ORDER_ID, reason: 'WRONG_PHONE', note: 'الرقم ناقص' }),
    })
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Nothing was written and nobody was told. */
function expectNothingWritten() {
  expect(db.$transaction, 'فُتحت معاملة كتابة').not.toHaveBeenCalled();
  expect(db.orderIssue.create, 'انكتب إشكال').not.toHaveBeenCalled();
  expect(db.order.update, 'تغيّر الطلب').not.toHaveBeenCalled();
  expect(db.order.updateMany, 'تغيّر الطلب').not.toHaveBeenCalled();
  expect(db.orderNote.create, 'انكتبت ملاحظة').not.toHaveBeenCalled();
  expect(logAudit).not.toHaveBeenCalled();
  expect(createNotification).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  db.orderIssue.findFirst.mockResolvedValue(null);
  db.orderIssue.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'iss1', ...data }));
  db.order.update.mockResolvedValue({});
  db.orderNote.create.mockResolvedValue({});
  logAudit.mockResolvedValue(undefined);
  createNotification.mockResolvedValue(0);
});

describe('the live agent (role CONFIRMATION_AGENT, with `confirmation.supervise`) — Abeer', () => {
  it('an open order NOBODY holds ⇒ 403 NOT_HELD, in the one sentence, and nothing is written', async () => {
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', LIVE_AGENT);
    const res = await raise(abeer, { confirmationStatus: 'NEW', claimedById: null });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.code).toBe('NOT_HELD');
    expect(res.body.errorAr).toBe(NOT_HELD_MESSAGE);
    expectNothingWritten();
  });

  it('an open order a COLLEAGUE holds ⇒ the same', async () => {
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', LIVE_AGENT);
    const res = await raise(abeer, { claimedById: 'someone-else' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_HELD');
    expectNothingWritten();
  });

  it('THE REVIEW’S CASE: a CONFIRMED order a colleague holds ⇒ refused, and it stays confirmed, held and reserved', async () => {
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', LIVE_AGENT);
    const res = await raise(abeer, { confirmationStatus: 'CONFIRMED', claimedById: 'someone-else' });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.code).toBe('NOT_HELD');
    expectNothingWritten();
  });

  it.each(OPEN_CONFIRMATION)('the open order SHE holds (%s) ⇒ exactly as before: returned to NEW with the holder cleared, an issue and a note', async (confirmationStatus) => {
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', LIVE_AGENT);
    const res = await raise(abeer, { confirmationStatus, claimedById: 'abeer' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(db.orderIssue.create).toHaveBeenCalledTimes(1);
    expect(db.order.update).toHaveBeenCalledTimes(1);
    expect(db.order.update.mock.calls[0][0].data).toEqual({
      claimedById: null, claimedAt: null, currentOwnerId: null, confirmationStatus: 'NEW', status: 'NEW',
      signatureStatus: 'UNSIGNED', version: { increment: 1 },
    });
    expect(db.orderNote.create).toHaveBeenCalledTimes(1);
    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  it('a store order she does not hold is still NOT_HELD first — the holder is asked before anything about the order', async () => {
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', LIVE_AGENT);
    const res = await raise(abeer, { moderatorId: null, claimedById: null });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_HELD');
    expectNothingWritten();
  });

  it('a store order she HOLDS is refused as before: NOT_MODERATOR_ENTERED', async () => {
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', LIVE_AGENT);
    const res = await raise(abeer, { moderatorId: null, claimedById: 'abeer' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_MODERATOR_ENTERED');
    expectNothingWritten();
  });

  it('an issue already open on the order she holds is refused as before: ISSUE_OPEN', async () => {
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', LIVE_AGENT);
    db.orderIssue.findFirst.mockResolvedValue({ id: 'iss0' });
    const res = await raise(abeer, { claimedById: 'abeer' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ISSUE_OPEN');
    expectNothingWritten();
  });
});

describe('the shipped template (no supervise) is bound too — the rule never depended on that key', () => {
  it('refused on an order nobody holds', async () => {
    const sara = await person('sara', 'CONFIRMATION_AGENT', TEMPLATE_AGENT);
    const res = await raise(sara, { claimedById: null });
    expect(res.body.code).toBe('NOT_HELD');
    expectNothingWritten();
  });
});

describe('an order past the confirmation desk is never sent back to NEW — by anybody', () => {
  const PAST: Array<[string, Record<string, unknown>, string]> = [
    ['confirmed', { confirmationStatus: 'CONFIRMED' }, 'مؤكد'],
    ['confirmed and packing', { confirmationStatus: 'CONFIRMED', shippingStatus: 'PACKING' }, 'قيد التجهيز'],
    ['shipped', { confirmationStatus: 'CONFIRMED', shippingStatus: 'SHIPPED', shippedAt: new Date() }, 'مشحون'],
    ['cancelled', { confirmationStatus: 'CANCELLED' }, 'ملغى'],
    ['rejected', { confirmationStatus: 'REJECTED' }, 'ملغى'],
  ];

  it.each(PAST)('the live agent HOLDING a %s order ⇒ 409 PAST_CONFIRMATION, the state in the sentence, nothing written', async (_name, over, label) => {
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', LIVE_AGENT);
    const res = await raise(abeer, { ...over, claimedById: 'abeer' });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('PAST_CONFIRMATION');
    expect(res.body.errorAr).toContain(`«${label}»`);
    expect(res.body.errorAr, 'الجملة لازم تدلّ على الطريق البديل').toContain('تعديل · إلغاء · تأجيل');
    expectNothingWritten();
  });

  it.each(PAST)('the OWNER on a %s order ⇒ the same: this is about the order, not the person', async (_name, over) => {
    const owner = await person('owner', 'SUPER_ADMIN', []);
    const res = await raise(owner, { ...over, claimedById: 'someone-else' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PAST_CONFIRMATION');
    expectNothingWritten();
  });

  it('a MANAGER on a confirmed order ⇒ the same', async () => {
    const manager = await person('manager', 'MANAGER', LIVE_MANAGER);
    const res = await raise(manager, { confirmationStatus: 'CONFIRMED', claimedById: null });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PAST_CONFIRMATION');
    expectNothingWritten();
  });

  it('and so is a MODERATOR on a confirmed order he entered', async () => {
    const mod = await person('mod', 'MODERATOR', LIVE_MODERATOR);
    const res = await raise(mod, { confirmationStatus: 'CONFIRMED', claimedById: null });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PAST_CONFIRMATION');
    expectNothingWritten();
  });
});

describe('whoever can take or hand out any order, and whoever is no agent of the queue, are not asked who holds an OPEN order', () => {
  it('the owner (SUPER_ADMIN, every key) raises an issue on an open order a colleague holds', async () => {
    const owner = await person('owner', 'SUPER_ADMIN', []);
    const res = await raise(owner, { claimedById: 'someone-else' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(db.order.update).toHaveBeenCalledTimes(1);
  });

  it('the live MANAGER (orders.unlock + orders.assign) on an open order nobody holds', async () => {
    const manager = await person('manager', 'MANAGER', LIVE_MANAGER);
    const res = await raise(manager, { claimedById: null, confirmationStatus: 'NEW' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it('an agent whose role was given `orders.assign` is no longer bound — the rule turns off by a box (the pre-deploy report lists who)', async () => {
    const sara = await person('sara', 'CONFIRMATION_AGENT', [...LIVE_AGENT, 'orders.assign']);
    const res = await raise(sara, { claimedById: 'someone-else' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it('a MODERATOR (orders.confirm / contact_log / claim, no confirmation.work) raises an issue on his own open order', async () => {
    const mod = await person('mod', 'MODERATOR', LIVE_MODERATOR);
    const res = await raise(mod, { claimedById: null, confirmationStatus: 'NEW' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it('a person without the raising box is refused by the box, as before, before anything about the order is asked', async () => {
    const reader = await person('reader', 'CONFIRMATION_AGENT', LIVE_AGENT.filter((k) => k !== 'confirmation.raise_issue'));
    const res = await raise(reader, { claimedById: 'reader' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBeUndefined();
    expect(assertOrderAccess).not.toHaveBeenCalled();
    expectNothingWritten();
  });
});
