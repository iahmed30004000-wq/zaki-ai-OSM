import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NOT_HELD_MESSAGE, mustHoldToWork } from '@/lib/confirmation-queue';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — AN AGENT WORKS ONLY THE ORDER SHE HOLDS (the owner, 1/11)
 *
 * His words: «البنت ضغطت … أكدت … الطلب اتسجل إنو اتأكد بس 20 طلب … بتقدر تسحب الطلبات بتكبس ع الطلب من خانة الطلبات بتضغط ع الطلب
 * وبتأكدو. كيف نمنع أو نحل هاد الاشي». Twenty orders were confirmed by one agent straight from the orders list: nobody had pulled them, so
 * they carry NO holder («لم يستلمه أحد بعد — متاح في الطابور» beside «مؤكَّد»), and the contact-first rule (which binds only a holder)
 * never applied. The door asked `orders.confirm` only, and that key is company-wide for the shipped agent.
 *
 *  1. For every account that works a queue (`confirmation.work`, by PERMISSION and never by role name) and cannot take or hand out any
 *     order (`orders.unlock`, `orders.assign`), every action of the confirmation door — confirm, reject, postpone, a call result,
 *     start, cancel, resolve — is refused with 403 `NOT_HELD` unless `claimedById` is HER. Nothing is written, reserved or notified.
 *     THE KEYS OF THIS TEST ARE THE LIVE ROLE'S, measured on the site on 1/11 (read-only `GET /api/roles`): CONFIRMATION_AGENT holds
 *     `confirmation.supervise` and `confirmation.reassign` too. The first version of the rule excused anybody holding `supervise`, which
 *     would have excused all ten agents — including the one the incident came from — and every unit test passed, because the keys
 *     were handed to the door by hand. `supervise` gates what she SEES, not what she may take; it excuses nobody.
 *  2. The order she holds works exactly as before; so does an order held by nobody for whoever can take or hand out any order (a
 *     manager: `orders.unlock` / `orders.assign`), for the owner (who holds every key), and for a person who holds `orders.confirm`
 *     without the queue key (a moderator — see BACKLOG RV563: she is not bound, and that is the owner's call).
 *  3. An order held by a COLLEAGUE is not hers either.
 *  4. The sentence is one, the same at the door and on the screen, Arabic only.
 *
 * Blockers: no money, no creation, no migration; permission behaviour of one door — hence the explicit negative for every action and
 * for every kind of person.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, can, authorize, assertOrderAccess, releaseOrderLines, reserveOrderLines, notify } = vi.hoisted(() => ({
  db: {
    order: { updateMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
    customer: { findUnique: vi.fn(async () => null), update: vi.fn() },
    orderNote: { create: vi.fn() },
    orderContactAttempt: { count: vi.fn(async () => 1) },
    orderStatusLog: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
    user: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  can: vi.fn(),
  authorize: vi.fn(),
  assertOrderAccess: vi.fn(),
  releaseOrderLines: vi.fn(async () => undefined),
  reserveOrderLines: vi.fn(async () => undefined),
  notify: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  can: (...a: unknown[]) => can(...a),
  authorize: (...a: unknown[]) => authorize(...a),
  requirePermission: vi.fn(),
}));
vi.mock('@/lib/rbac', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a),
}));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/notify', () => ({ notify: (...a: unknown[]) => notify(...a) }));
vi.mock('@/lib/reservation', () => ({
  releaseOrderLines: (...a: unknown[]) => releaseOrderLines(...(a as [])),
  reserveOrderLines: (...a: unknown[]) => reserveOrderLines(...(a as [])),
}));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: vi.fn() }));
vi.mock('@/lib/conversions/emit', () => ({ queueConversions: vi.fn() }));
vi.mock('@/lib/blacklist', () => ({ AlreadyBlocked: class extends Error {}, blockPhone: vi.fn() }));

import { POST } from './route';

const ME = { id: 'agent-1', name: 'عبير', role: 'CONFIRMATION_AGENT' };
const ORDER: Record<string, unknown> = {
  id: 'o1', companyId: 'c1', storeId: 's1', version: 3, orderNumber: 'ORD-2026-1896',
  confirmationStatus: 'NEW', shippingStatus: 'NOT_READY', shippedAt: null, labelPrintedAt: null,
  claimedById: null, lockedById: null, lockExpiresAt: null, confirmedAt: null, customerId: 'cu1',
  nextFollowUpAt: null, followUpStatus: null, moderatorId: null,
  shippingBatchId: null, shippingBatch: null, deliveryProviderId: null, trackingNumber: null,
  courierSendStartedAt: null, totalAmount: 10, currency: 'USD',
  regionId: 'r1',
};

/**
 * THE LIVE AGENT: the system role CONFIRMATION_AGENT as `GET /api/roles` returned it on crm.zakiai.io, 1/11 (22 keys; configuration, no
 * customer data). It holds `confirmation.supervise` and `confirmation.reassign`, and neither `orders.unlock` nor `orders.assign`.
 */
const PRODUCTION_CONFIRMATION_AGENT = [
  'ai.assist', 'ai.use', 'confirmation.issues', 'confirmation.issues_correct', 'confirmation.pull', 'confirmation.raise_issue',
  'confirmation.reassign', 'confirmation.supervise', 'confirmation.winback', 'confirmation.work', 'customers.view_basic', 'insights.view',
  'orders.change_price', 'orders.claim', 'orders.confirm', 'orders.contact_log', 'orders.edit', 'orders.note', 'orders.rating_link',
  'orders.release', 'orders.request_change', 'orders.view',
];
const AGENT_KEYS = PRODUCTION_CONFIRMATION_AGENT;

function holding(...keys: string[]) {
  can.mockImplementation((_u: unknown, key: string) => keys.includes(key));
  authorize.mockImplementation((_u: unknown, key: string) => ({ allowed: keys.includes(key) }));
}
function orderIs(over: Record<string, unknown>) {
  const o = { ...ORDER, ...over };
  assertOrderAccess.mockResolvedValue({ allowed: true, order: o });
  db.order.findFirst.mockResolvedValue(o);
  db.order.findUnique.mockResolvedValue(o);
}

const send = async (body: Record<string, unknown>) => {
  const res = await POST(
    new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 3, ...body }),
    }),
    { params: Promise.resolve({ id: 'o1' }) }
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

/** One request per action the door has, each with the body it needs to get past validation if it were allowed. */
const ACTIONS: Array<[string, Record<string, unknown>]> = [
  ['confirm', { action: 'confirm' }],
  ['reject', { action: 'reject', rejectionReason: 'FAKE_ORDER' }],
  ['schedule_follow_up', { action: 'schedule_follow_up', nextFollowUpAt: new Date(Date.now() + 3_600_000).toISOString() }],
  ['contact_result', { action: 'contact_result', result: 'ANSWERED' }],
  ['start', { action: 'start' }],
  ['cancel', { action: 'cancel', note: 'سبب الإلغاء مكتوب' }],
  ['resolve_follow_up', { action: 'resolve_follow_up' }],
];

/** Nothing was decided, written, reserved or told to anybody. */
function expectUntouched() {
  expect(db.order.updateMany).not.toHaveBeenCalled();
  expect(db.$transaction).not.toHaveBeenCalled();
  expect(db.orderStatusLog.create).not.toHaveBeenCalled();
  expect(db.orderActivity.create).not.toHaveBeenCalled();
  expect(reserveOrderLines).not.toHaveBeenCalled();
  expect(releaseOrderLines).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: ME, companyId: 'c1', storeId: 's1', country: { allowNegativeStock: false } });
  holding(...AGENT_KEYS);
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.orderContactAttempt.count.mockResolvedValue(1);
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  orderIs({});
});

describe('the rule itself', () => {
  it('is the queue account: confirmation.work — by permission, never by role name', () => {
    const holds = (...keys: string[]) => (p: string) => keys.includes(p);
    expect(mustHoldToWork(holds('confirmation.work'))).toBe(true);
    expect(mustHoldToWork(holds('confirmation.work', 'orders.confirm', 'orders.contact_log', 'confirmation.pull'))).toBe(true);
    expect(mustHoldToWork(holds('orders.confirm'))).toBe(false); // confirms, but is not an agent of the queue
    expect(mustHoldToWork(holds())).toBe(false);
  });

  it('THE LIVE AGENT IS BOUND — the measured CONFIRMATION_AGENT key list, `confirmation.supervise` and all', () => {
    expect(PRODUCTION_CONFIRMATION_AGENT).toContain('confirmation.supervise');
    expect(PRODUCTION_CONFIRMATION_AGENT).toContain('confirmation.reassign');
    expect(mustHoldToWork((p) => PRODUCTION_CONFIRMATION_AGENT.includes(p))).toBe(true);
  });

  it('NEGATIVE: `confirmation.supervise` alone excuses nobody — it is what she SEES, not what she may take', () => {
    const holds = (...keys: string[]) => (p: string) => keys.includes(p);
    expect(mustHoldToWork(holds('confirmation.work', 'confirmation.supervise'))).toBe(true);
    expect(mustHoldToWork(holds('confirmation.work', 'confirmation.supervise', 'confirmation.reassign'))).toBe(true);
  });

  it('and not whoever can TAKE any order (orders.unlock) or GIVE any order away (orders.assign): binding them gains nothing', () => {
    const holds = (...keys: string[]) => (p: string) => keys.includes(p);
    expect(mustHoldToWork(holds('confirmation.work', 'orders.unlock'))).toBe(false);
    expect(mustHoldToWork(holds('confirmation.work', 'orders.assign'))).toBe(false);
    expect(mustHoldToWork(holds('confirmation.work', 'orders.unlock', 'orders.assign'))).toBe(false);
  });

  it('says one sentence, in Arabic, that tells her what to do', () => {
    expect(NOT_HELD_MESSAGE).toBe('اسحب الطلب أولاً — لا يمكن العمل على طلب ليس بين يديك');
    expect(NOT_HELD_MESSAGE).not.toMatch(/[A-Za-z]/);
  });
});

describe('an agent on an order NOBODY holds — ORD-2026-1896, from the orders list', () => {
  it.each(ACTIONS)('%s ⇒ 403 NOT_HELD, in the sentence, and nothing is written, reserved or told', async (_name, body) => {
    const res = await send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.code).toBe('NOT_HELD');
    expect(res.body.errorAr).toBe(NOT_HELD_MESSAGE);
    expect(res.body.error).toBe(NOT_HELD_MESSAGE);
    expectUntouched();
  });
});

describe('an agent on an order a COLLEAGUE holds', () => {
  it.each(ACTIONS)('%s ⇒ 403 NOT_HELD — it is not hers either', async (_name, body) => {
    orderIs({ claimedById: 'agent-2' });
    const res = await send(body);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_HELD');
    expectUntouched();
  });
});

describe('the order she HOLDS works exactly as before', () => {
  it('confirms it: written once, reserved once', async () => {
    orderIs({ claimedById: ME.id, confirmationStatus: 'IN_PROGRESS' });
    const res = await send({ action: 'confirm' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
    expect(reserveOrderLines).toHaveBeenCalledTimes(1);
  });

  it('postpones it, and logs a call result on it', async () => {
    orderIs({ claimedById: ME.id, confirmationStatus: 'IN_PROGRESS' });
    expect((await send(ACTIONS.find(([n]) => n === 'schedule_follow_up')![1])).status).toBe(200);
  });
});

describe('everybody else is unbound — an order nobody holds still works for them', () => {
  const confirms = async () => send({ action: 'confirm' });

  it('a moderator: holds orders.confirm and the call key but NOT the queue key — not bound (BACKLOG RV563: the owner decides)', async () => {
    holding('orders.confirm', 'orders.contact_log', 'orders.claim', 'orders.view');
    const res = await confirms();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('a manager who can take any order (orders.unlock) or hand any order out (orders.assign)', async () => {
    for (const key of ['orders.unlock', 'orders.assign']) {
      vi.clearAllMocks();
      holding('confirmation.work', 'orders.confirm', 'orders.contact_log', key);
      requireContext.mockResolvedValue({ user: ME, companyId: 'c1', storeId: 's1', country: { allowNegativeStock: false } });
      db.order.updateMany.mockResolvedValue({ count: 1 });
      db.orderContactAttempt.count.mockResolvedValue(1);
      db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
      orderIs({});
      const res = await confirms();
      expect(res.status, key + ' ' + JSON.stringify(res.body)).toBe(200);
    }
  });

  it('the owner, who holds every key', async () => {
    can.mockReturnValue(true);
    authorize.mockReturnValue({ allowed: true });
    const res = await confirms();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('somebody who may confirm but is not an agent of the queue (orders.confirm without confirmation.work)', async () => {
    holding('orders.confirm', 'orders.contact_log');
    const res = await confirms();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('and a manager on an order a colleague holds — as before', async () => {
    holding('confirmation.work', 'confirmation.supervise', 'orders.confirm', 'orders.unlock');
    orderIs({ claimedById: 'agent-2' });
    expect((await confirms()).status).toBe(200);
  });
});

describe('the order of the checks', () => {
  it('a person with no confirm key is still told so first (the new rule adds a refusal, it does not reorder the old ones)', async () => {
    holding('confirmation.work'); // no orders.confirm
    authorize.mockImplementation((_u: unknown, key: string) => ({ allowed: key !== 'orders.confirm' }));
    const res = await send({ action: 'confirm' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBeUndefined();
    expect(String(res.body.error)).toContain('صلاحية تغيير حالة التأكيد');
  });
});
