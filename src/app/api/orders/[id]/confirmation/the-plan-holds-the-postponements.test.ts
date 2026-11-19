import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * REQUEST C2 — THE CONFIRMATION DOOR UNDER THE ONE RULE (decisions 4 and 6; the owner's plan of 17/11 §3.1 line 6)
 *
 *  · «لا يرد» IS NEVER A POSTPONEMENT while «إثبات المكالمات وجدول المحاولات» is on: a date whose reason is «لا يرد» (`schedule_follow_up`, or a `contact_result` that carries a
 *    date) is refused 409 `NO_ANSWER_NOT_A_POSTPONE` with a plain Arabic sentence, BEFORE anything is read for writing or written. Any other reason passes as before.
 *  · A customer's date at most TWICE while the plan is on, whatever «أولوية الطابور» says (the third is 409 `POSTPONE_LIMIT`) — the priority key is not even asked.
 *  · The plan OFF: both answer exactly as on main — the «لا يرد» date is accepted, and the cap holds only with «أولوية الطابور» on.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, calls, requireContext, assertOrderAccess, can, plan, priority } = vi.hoisted(() => {
  const calls: string[] = [];
  const db: any = {
    order: { findFirst: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    orderStatusLog: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
    orderClaimHistory: { create: vi.fn(), findFirst: vi.fn() },
    orderContactAttempt: { count: vi.fn(), findMany: vi.fn(async () => []) },
    user: { findUnique: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
  };
  return {
    db,
    calls,
    requireContext: vi.fn(),
    assertOrderAccess: vi.fn(),
    can: vi.fn(),
    plan: { since: null as Date | null },
    priority: { enabled: false, asked: 0 },
  };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/rbac', () => ({
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a),
  ORDER_ACCESS_STATUS: { NOT_FOUND: 404, WRONG_COMPANY: 404, NOT_ASSIGNED: 404 },
}));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/notification', () => ({ createNotification: vi.fn(async () => 1) }));
vi.mock('@/lib/authorization', () => ({ can: (...a: unknown[]) => can(...a), authorize: () => ({ allowed: true }), requirePermission: vi.fn() }));
vi.mock('@/lib/reservation', () => ({ reserveOrderLines: vi.fn(), releaseOrderLines: vi.fn(), orderLinesForGuard: vi.fn(async () => []) }));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: vi.fn() }));
vi.mock('@/lib/conversions/emit', () => ({ queueConversions: vi.fn() }));
vi.mock('@/lib/no-answer-rounds-switch', () => ({ roundsSwitch: async () => ({ enabled: false, enabledAt: null }) }));
vi.mock('@/lib/no-answer-returns-switch', () => ({ returnsSwitch: async () => ({ enabled: false, enabledAt: null }) }));
vi.mock('@/lib/no-answer-cadence-switch', () => ({ cadenceSince: async () => plan.since }));
// The proof is not what these tests are about: its own tests hold it. A press of hers that is old enough is assumed (off here = the guard is not asked).
vi.mock('@/lib/call-proof-switch', () => ({ callProofOn: async () => false, callProofSwitch: async () => ({ enabled: false, enabledAt: null }) }));
vi.mock('@/lib/queue-priority-switch', () => ({ queuePrioritySwitch: async () => ((priority.asked += 1), { enabled: priority.enabled, enabledAt: null }) }));

import { POST } from '@/app/api/orders/[id]/confirmation/route';
import { forgetDeskRefusalFold } from '@/lib/desk-refusals';

const ME = { id: 'actor-1', name: 'منفّذ', role: 'CONFIRMATION_AGENT', status: 'ACTIVE' };
const ctx = { user: ME, companyId: 'c1', storeId: 'store-a', countryId: 'jo', country: { id: 'jo', code: 'JO', timezone: 'Asia/Amman', allowNegativeStock: false, workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5] } };
const order = (over: Record<string, unknown> = {}) => ({
  id: 'o1', companyId: 'c1', storeId: 'store-a', orderNumber: 'ORD-1', version: 1, moderatorId: 'mod-1', claimedById: ME.id,
  confirmationStatus: 'IN_PROGRESS', shippingStatus: 'NOT_READY', lockedById: null, lockExpiresAt: null, shippedAt: null, nextFollowUpAt: null, followUpStatus: null, regionId: 'r1', postponeCount: 0,
  ...over,
});
const params = { params: Promise.resolve({ id: 'o1' }) };
const post = (body: unknown) => POST(new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), params);
const inTwoDays = () => new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
const PLAN_ON = new Date('2026-11-17T10:12:00.000Z');
const postpone = (reason: string) => post({ action: 'schedule_follow_up', nextFollowUpAt: inTwoDays(), followUpReason: reason, expectedVersion: 1 });
const writes = () => calls.filter((c) => c !== 'begin' && c !== 'commit');

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  plan.since = PLAN_ON;
  priority.enabled = false;
  priority.asked = 0;
  requireContext.mockResolvedValue(ctx);
  can.mockImplementation((_u: unknown, key: string) => key === 'orders.contact_log' || key === 'orders.confirm');
  db.$transaction.mockImplementation(async (fn: any) => {
    calls.push('begin');
    const out = await fn(db);
    calls.push('commit');
    return out;
  });
  db.order.updateMany.mockImplementation(async ({ where }: any) => (calls.push('version' in where ? 'write' : 'release'), { count: 1 }));
  db.orderStatusLog.create.mockImplementation(async () => void calls.push('statusLog'));
  db.orderActivity.create.mockImplementation(async () => void calls.push('activity'));
  db.orderClaimHistory.create.mockImplementation(async () => void calls.push('history'));
  db.order.findUnique.mockResolvedValue(order());
  db.order.findFirst.mockResolvedValue({ postponeCount: 0 });
  assertOrderAccess.mockResolvedValue({ allowed: true, order: order() });
  db.orderContactAttempt.count.mockResolvedValue(1);
  db.orderClaimHistory.findFirst.mockResolvedValue(null);
});

describe('the plan ON — «لا يرد» is never a postponement', () => {
  it('a postponement whose reason is «لا يرد» is refused 409 in plain Arabic, with its code — and NOTHING is written', async () => {
    const res = await postpone('NO_ANSWER');
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('NO_ANSWER_NOT_A_POSTPONE');
    expect(body.errorAr).toBe('التأجيل بسبب «لا يرد» ممنوع — سجّلي «لا يرد» وبيرجع الطلب لحالو بموعده.');
    expect(body.error).toBe(body.errorAr);
    expect(/[A-Za-z]/.test(body.errorAr)).toBe(false);
    expect(writes()).toEqual([]);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('a call result that carries a date with the reason «لا يرد» is refused the same way', async () => {
    const res = await post({ action: 'contact_result', result: 'CALLBACK_REQUESTED', nextFollowUpAt: inTwoDays(), followUpReason: 'NO_ANSWER', expectedVersion: 1 });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('NO_ANSWER_NOT_A_POSTPONE');
    expect(writes()).toEqual([]);
  });

  it('every other reason passes as before (the customer asked, postponed, another)', async () => {
    for (const reason of ['CUSTOMER_REQUESTED_CALLBACK', 'POSTPONED', 'OTHER']) {
      calls.length = 0;
      const res = await postpone(reason);
      expect(res.status, reason).toBe(200);
      expect(calls).toContain('write');
    }
  });

  it('a «لا يرد» press WITHOUT a date (the status door\'s own «لا يرد») is not a postponement and is not refused by this rule', async () => {
    const res = await post({ action: 'contact_result', result: 'NO_ANSWER', followUpReason: 'NO_ANSWER', expectedVersion: 1 });
    expect((await res.json()).code).not.toBe('NO_ANSWER_NOT_A_POSTPONE');
  });
});

describe('the plan ON — the customer\'s date at most twice, whatever «أولوية الطابور» says', () => {
  it('the third postponement is refused 409 with «أولوية الطابور» OFF — and the priority key is not even asked', async () => {
    db.order.findFirst.mockResolvedValue({ postponeCount: 2 });
    const res = await postpone('CUSTOMER_REQUESTED_CALLBACK');
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('POSTPONE_LIMIT');
    expect(priority.asked).toBe(0);
    expect(writes()).toEqual([]);
  });

  it('the second is allowed', async () => {
    db.order.findFirst.mockResolvedValue({ postponeCount: 1 });
    expect((await postpone('CUSTOMER_REQUESTED_CALLBACK')).status).toBe(200);
  });
});

describe('the plan OFF — the door is main\'s, line for line', () => {
  beforeEach(() => {
    plan.since = null;
  });

  it('a postponement with the reason «لا يرد» is accepted and written, as on main', async () => {
    const res = await postpone('NO_ANSWER');
    expect(res.status).toBe(200);
    expect(calls).toContain('write');
  });

  it('the third postponement passes with «أولوية الطابور» off (main: the cap is that key\'s)', async () => {
    db.order.findFirst.mockResolvedValue({ postponeCount: 2 });
    expect((await postpone('CUSTOMER_REQUESTED_CALLBACK')).status).toBe(200);
    expect(priority.asked).toBe(1);
  });

  it('…and is refused with «أولوية الطابور» on, with main\'s sentence', async () => {
    priority.enabled = true;
    db.order.findFirst.mockResolvedValue({ postponeCount: 2 });
    const res = await postpone('CUSTOMER_REQUESTED_CALLBACK');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'هالطلب انأجّل 2 مرات — ما بينأجّل مرة تالتة. اتصل فيه وخذ قرار: تأكيد أو رفض.', code: 'POSTPONE_LIMIT' });
  });
});

/**
 * «سجل الرفض» (request Q2a, 19/11): each of the confirmation door's four rule refusals leaves ONE row (code, door, the order) through the
 * real `logDeskRefusal`, written after the refusal is decided and outside the door's transaction (none is opened); an accepted press
 * leaves none; a failing insert changes nothing.
 */
describe('«سجل الرفض» — the confirmation door', () => {
  const deskRows = () =>
    db.$executeRaw.mock.calls
      .filter((c: unknown[]) => (c[0] as string[]).join('').includes('desk_refusals'))
      .map((c: unknown[]) => ({ companyId: c[2], storeId: c[3], userId: c[4], orderId: c[5], code: c[6], door: c[7] }));
  const one = (code: string) => [{ companyId: 'c1', storeId: 'store-a', userId: ME.id, orderId: 'o1', code, door: 'confirmation' }];
  beforeEach(() => {
    forgetDeskRefusalFold();
    db.$executeRaw.mockResolvedValue(1);
  });

  it('NO_ANSWER_NOT_A_POSTPONE: one row, no transaction', async () => {
    expect((await postpone('NO_ANSWER')).status).toBe(409);
    expect(deskRows()).toEqual(one('NO_ANSWER_NOT_A_POSTPONE'));
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('POSTPONE_LIMIT: one row', async () => {
    db.order.findFirst.mockResolvedValue({ postponeCount: 2 });
    expect((await postpone('CUSTOMER_REQUESTED_CALLBACK')).status).toBe(409);
    expect(deskRows()).toEqual(one('POSTPONE_LIMIT'));
  });

  it('CONTACT_FIRST: one row', async () => {
    db.orderContactAttempt.count.mockResolvedValue(0);
    const res = await postpone('CUSTOMER_REQUESTED_CALLBACK');
    expect((await res.json()).code).toBe('CONTACT_FIRST');
    expect(deskRows()).toEqual(one('CONTACT_FIRST'));
  });

  it('NOT_HELD: one row', async () => {
    can.mockImplementation((_u: unknown, key: string) => ['orders.contact_log', 'orders.confirm', 'confirmation.work'].includes(key));
    assertOrderAccess.mockResolvedValue({ allowed: true, order: order({ claimedById: 'someone-else' }) });
    const res = await postpone('CUSTOMER_REQUESTED_CALLBACK');
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('NOT_HELD');
    expect(deskRows()).toEqual(one('NOT_HELD'));
  });

  it('NEGATIVE: an accepted postponement writes no row', async () => {
    expect((await postpone('OTHER')).status).toBe(200);
    expect(deskRows()).toEqual([]);
  });

  it('a failing insert changes neither the status nor the body', async () => {
    const ok = await postpone('NO_ANSWER');
    forgetDeskRefusalFold();
    db.$executeRaw.mockRejectedValue(new Error('relation "desk_refusals" does not exist'));
    const failed = await postpone('NO_ANSWER');
    expect(failed.status).toBe(ok.status);
    expect(await failed.json()).toEqual(await ok.json());
  });
});
