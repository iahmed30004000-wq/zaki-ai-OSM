import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE CONFIRMATION DOOR OF «الطلب يرجع للطابور فوراً» (the owner, 9/11)
 *
 * With the mode ON (and the rounds on beside it):
 *
 *  1. A DATE the HOLDER saves — a postponement («تأجيل»), «اتصل لاحقاً», or a call result that carries a date — takes the order out of
 *     her hand in the SAME transaction as the write, with the other releases’ write and a `RELEASED` line (reason `DATE_RETURNED`).
 *  2. The status and the dates are what the action made them: the release writes neither (the order is POSTPONED and dated, in the pool).
 *  3. No date, no release: a result without one, a confirmation, a start.
 *  4. Somebody else’s press (a supervisor setting a date on a colleague’s order) releases nothing.
 *  5. A write that lost the version race is rolled back whole — no release rides on it.
 *  6. The order sheet’s «لا يرد» is two calls — the attempt, then the status. With the mode on the first has already sent the order back, so
 *     the second is answered as DONE, writing nothing — and only the second half of HER OWN press: not a confirmation, a postponement, a date,
 *     an answered call, nor anybody else’s order.
 *
 * With the mode OFF the door is today’s: one write, no line, not one extra query that matters.
 *
 * The mocks of `a-date-on-a-result-is-a-postponement.test.ts` (the same door), plus the two switches answered by this test.
 * Blockers: no money, no order creation, no migration.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, calls, requireContext, assertOrderAccess, can, sw, rsw } = vi.hoisted(() => {
  const calls: string[] = [];
  const db: any = {
    order: { findFirst: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    orderStatusLog: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
    orderClaimHistory: { create: vi.fn(), findFirst: vi.fn() },
    orderContactAttempt: { count: vi.fn() },
    user: { findUnique: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(),
  };
  return {
    db,
    calls,
    requireContext: vi.fn(),
    assertOrderAccess: vi.fn(),
    can: vi.fn(),
    sw: { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } },
    rsw: { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } },
  };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/rbac', () => ({
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a),
  // The real map (`rbac.ts`): every reason the work door can give for an order she may not reach is a 404.
  ORDER_ACCESS_STATUS: { NOT_FOUND: 404, WRONG_COMPANY: 404, NOT_ASSIGNED: 404 },
}));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/notification', () => ({ createNotification: vi.fn(async () => 1) }));
vi.mock('@/lib/authorization', () => ({
  can: (...a: unknown[]) => can(...a),
  authorize: () => ({ allowed: true }),
  requirePermission: vi.fn(),
}));
vi.mock('@/lib/reservation', () => ({ reserveOrderLines: vi.fn(), releaseOrderLines: vi.fn(), orderLinesForGuard: vi.fn(async () => []) }));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: vi.fn() }));
vi.mock('@/lib/conversions/emit', () => ({ queueConversions: vi.fn() }));
vi.mock('@/lib/no-answer-rounds-switch', () => ({ roundsSwitch: async () => sw.value }));
vi.mock('@/lib/no-answer-returns-switch', () => ({ returnsSwitch: async () => rsw.value }));

import { POST } from '@/app/api/orders/[id]/confirmation/route';

const ME = { id: 'actor-1', name: 'منفّذ', role: 'CONFIRMATION_AGENT', status: 'ACTIVE' };
const ctx = {
  user: ME, companyId: 'c1', storeId: 'store-a', countryId: 'jo',
  country: { id: 'jo', code: 'JO', timezone: 'Asia/Amman', allowNegativeStock: false, workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5] },
};
const order = (over: Record<string, unknown> = {}) => ({
  id: 'o1', companyId: 'c1', storeId: 'store-a', orderNumber: 'ORD-1', version: 1, moderatorId: 'mod-1', claimedById: ME.id,
  confirmationStatus: 'IN_PROGRESS', shippingStatus: 'NOT_READY', lockedById: null, lockExpiresAt: null, shippedAt: null,
  nextFollowUpAt: null, followUpStatus: null, regionId: 'r1',
  ...over,
});
const params = { params: Promise.resolve({ id: 'o1' }) };
const post = (body: unknown) =>
  POST(new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), params);
const inTwoDays = () => new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
const ON = { enabled: true, enabledAt: new Date('2026-11-01T06:00:00.000Z') };
const OFF = { enabled: false, enabledAt: null };

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  sw.value = ON;
  rsw.value = ON;
  requireContext.mockResolvedValue(ctx);
  can.mockImplementation((_u: unknown, key: string) => key === 'orders.contact_log' || key === 'orders.confirm');
  db.$transaction.mockImplementation(async (fn: any) => {
    calls.push('begin');
    const out = await fn(db);
    calls.push('commit');
    return out;
  });
  // The first updateMany of a press is the version-guarded write of the action; any other is the release.
  db.order.updateMany.mockImplementation(async ({ where }: any) => (calls.push('version' in where ? 'write' : 'release'), { count: 1 }));
  db.orderStatusLog.create.mockImplementation(async () => void calls.push('statusLog'));
  db.orderActivity.create.mockImplementation(async () => void calls.push('activity'));
  db.orderClaimHistory.create.mockImplementation(async () => void calls.push('history'));
  db.order.findUnique.mockResolvedValue(order());
  assertOrderAccess.mockResolvedValue({ allowed: true, order: order() });
  db.orderContactAttempt.count.mockResolvedValue(1);
  db.orderClaimHistory.findFirst.mockResolvedValue(null);
});

describe('ON — a date she saves takes the order out of her hand', () => {
  it('«تأجيل» (schedule_follow_up): the write first, then the release, in ONE transaction — and a line that says nobody pressed «release»', async () => {
    const date = inTwoDays();
    const res = await post({ action: 'schedule_follow_up', nextFollowUpAt: date, followUpReason: 'CUSTOMER_REQUESTED_CALLBACK', expectedVersion: 1 });
    expect(res.status).toBe(200);
    expect(calls).toEqual(['begin', 'write', 'statusLog', 'activity', 'release', 'history', 'commit']);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.orderClaimHistory.create).toHaveBeenCalledWith({
      data: { companyId: 'c1', orderId: 'o1', userId: ME.id, action: 'RELEASED', reason: 'DATE_RETURNED', metadata: JSON.stringify({ automatic: true, holder: ME.id }) },
    });
  });

  it('the status and the dates are what the action wrote — the release writes none of them', async () => {
    const date = inTwoDays();
    await post({ action: 'schedule_follow_up', nextFollowUpAt: date, expectedVersion: 1 });
    const [write, release] = db.order.updateMany.mock.calls.map((c: any) => c[0]);
    expect(write.data).toMatchObject({ confirmationStatus: 'POSTPONED', nextFollowUpAt: new Date(date), postponedUntil: new Date(date), followUpStatus: 'SCHEDULED' });
    expect(release.data).toEqual({ claimedById: null, claimedAt: null, currentOwnerId: null, signatureStatus: 'UNSIGNED', assignedAt: null });
    expect(release.where).toEqual({
      id: 'o1', companyId: 'c1', claimedById: ME.id,
      confirmationStatus: { in: ['NEW', 'IN_PROGRESS', 'NO_ANSWER', 'FOLLOW_UP_REQUIRED', 'POSTPONED'] },
      shippingStatus: 'NOT_READY', shippingBatchId: null, trackingNumber: null, labelPrintedAt: null,
    });
  });

  it('a call result that carries a date (the customer answered and asked to be rung later) releases too', async () => {
    await post({ action: 'contact_result', result: 'CALLBACK_REQUESTED', nextFollowUpAt: inTwoDays(), expectedVersion: 1 });
    expect(calls).toEqual(['begin', 'write', 'statusLog', 'activity', 'release', 'history', 'commit']);
  });

  it('an answered call with a date leaves the status in progress and the date on the order — and the order in the pool', async () => {
    await post({ action: 'contact_result', result: 'ANSWERED', nextFollowUpAt: inTwoDays(), expectedVersion: 1 });
    const [write, release] = db.order.updateMany.mock.calls.map((c: any) => c[0]);
    expect(write.data.confirmationStatus).toBe('IN_PROGRESS');
    expect(write.data.nextFollowUpAt).toBeInstanceOf(Date);
    expect(release).toBeDefined();
  });

  it('a release the database refuses (the order moved in the same instant) is harmless: the press still succeeds, no line is written', async () => {
    db.order.updateMany.mockImplementation(async ({ where }: any) => ({ count: 'version' in where ? 1 : 0 }));
    const res = await post({ action: 'schedule_follow_up', nextFollowUpAt: inTwoDays(), expectedVersion: 1 });
    expect(res.status).toBe(200);
    expect(db.orderClaimHistory.create).not.toHaveBeenCalled();
  });
});

describe('ON — no date, no release', () => {
  it.each([
    ['a call nobody answered, with no date (the contact door lets that one go)', { action: 'contact_result', result: 'NO_ANSWER' }],
    ['an answered call with no date', { action: 'contact_result', result: 'ANSWERED' }],
    ['a confirmation', { action: 'confirm' }],
    ['a start', { action: 'start' }],
  ])('%s: one write, no release', async (_why, body) => {
    assertOrderAccess.mockResolvedValue({ allowed: true, order: order({ confirmationStatus: body.action === 'start' ? 'NEW' : 'IN_PROGRESS' }) });
    // A confirmation may be refused by the twin guard and others; what matters is that no release was ever asked.
    await post({ ...body, expectedVersion: 1 });
    expect(calls).not.toContain('release');
    expect(db.orderClaimHistory.create).not.toHaveBeenCalled();
  });
});

describe('ON — only the holder’s press releases', () => {
  it('a supervisor setting a date on a colleague’s order lets nothing go', async () => {
    assertOrderAccess.mockResolvedValue({ allowed: true, order: order({ claimedById: 'someone-else' }) });
    const res = await post({ action: 'schedule_follow_up', nextFollowUpAt: inTwoDays(), expectedVersion: 1 });
    expect(res.status).toBe(200);
    expect(calls).toEqual(['begin', 'write', 'statusLog', 'activity', 'commit']);
    expect(db.orderClaimHistory.create).not.toHaveBeenCalled();
  });
});

describe('ON — a write that lost the race is rolled back whole', () => {
  it('the version moved: 409, and no release rides on it', async () => {
    db.order.updateMany.mockImplementation(async () => ({ count: 0 }));
    const res = await post({ action: 'schedule_follow_up', nextFollowUpAt: inTwoDays(), expectedVersion: 1 });
    expect(res.status).toBe(409);
    expect(calls).not.toContain('release');
    expect(db.orderClaimHistory.create).not.toHaveBeenCalled();
  });
});

describe('OFF — the door is today’s', () => {
  it.each([
    ['its own switch off', () => { rsw.value = OFF; }],
    ['the rounds off, whatever the mode’s own switch holds', () => { sw.value = OFF; }],
  ])('%s: a date saves, and the order stays in her hand', async (_name, set) => {
    set();
    const res = await post({ action: 'schedule_follow_up', nextFollowUpAt: inTwoDays(), expectedVersion: 1 });
    expect(res.status).toBe(200);
    expect(calls).toEqual(['begin', 'write', 'statusLog', 'activity', 'commit']);
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
    expect(db.orderClaimHistory.create).not.toHaveBeenCalled();
  });
});

describe('ON — the order sheet’s second call after her own returning press', () => {
  /** Her own press a moment ago: the contact door let the order go and wrote this line. */
  const sheLetItGo = () => db.orderClaimHistory.findFirst.mockResolvedValue({ id: 'h1' });
  /** Bound to the orders she holds, as the live agents are: she works a queue and may take or hand out nothing. */
  const bound = () => can.mockImplementation((_u: unknown, key: string) => ['orders.contact_log', 'orders.confirm', 'confirmation.work'].includes(key));
  const noAnswer = { action: 'contact_result', result: 'NO_ANSWER', expectedVersion: 1 };

  it('the order is no longer visible to her (she is on “assigned”): the status call is answered as done, and writes nothing', async () => {
    sheLetItGo();
    assertOrderAccess.mockResolvedValue({ allowed: false, reason: 'NOT_ASSIGNED' });
    const res = await post(noAnswer);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, returnedToQueue: true });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.orderClaimHistory.create).not.toHaveBeenCalled();
    // The question is HER line, of THIS reason, in the last two minutes.
    const where = db.orderClaimHistory.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ companyId: 'c1', orderId: 'o1', userId: ME.id, action: 'RELEASED', reason: 'NO_ANSWER_RETURNED' });
    expect(Date.now() - where.createdAt.gt.getTime()).toBeGreaterThanOrEqual(119_000);
    expect(Date.now() - where.createdAt.gt.getTime()).toBeLessThan(125_000);
  });

  it('the order is still visible but no longer in her hand (she is bound to what she holds): the same', async () => {
    bound();
    sheLetItGo();
    assertOrderAccess.mockResolvedValue({ allowed: true, order: order({ claimedById: null }) });
    const res = await post(noAnswer);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, returnedToQueue: true });
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('«مشغول» is the same call', async () => {
    sheLetItGo();
    assertOrderAccess.mockResolvedValue({ allowed: false, reason: 'NOT_ASSIGNED' });
    expect((await post({ action: 'contact_result', result: 'BUSY', expectedVersion: 1 })).status).toBe(200);
  });

  it('NEGATIVE: with no line of hers in the last two minutes the answer is the refusal it always was (404, or NOT_HELD)', async () => {
    assertOrderAccess.mockResolvedValue({ allowed: false, reason: 'NOT_ASSIGNED' });
    expect((await post(noAnswer)).status).toBe(404);
    bound();
    assertOrderAccess.mockResolvedValue({ allowed: true, order: order({ claimedById: null }) });
    const held = await post(noAnswer);
    expect(held.status).toBe(403);
    expect((await held.json()).code).toBe('NOT_HELD');
  });

  it.each([
    ['a confirmation', { action: 'confirm', expectedVersion: 1 }],
    ['a postponement', { action: 'schedule_follow_up', nextFollowUpAt: new Date(Date.now() + 86_400_000).toISOString(), expectedVersion: 1 }],
    ['an answered call', { action: 'contact_result', result: 'ANSWERED', expectedVersion: 1 }],
    ['a «لا يرد» that carries a date', { action: 'contact_result', result: 'NO_ANSWER', nextFollowUpAt: new Date(Date.now() + 86_400_000).toISOString(), expectedVersion: 1 }],
    ['a result this door does not take here', { action: 'contact_result', result: 'WRONG_NUMBER', expectedVersion: 1 }],
  ])('NEGATIVE: %s is refused as ever, though her line is there', async (_why, body) => {
    sheLetItGo();
    assertOrderAccess.mockResolvedValue({ allowed: false, reason: 'NOT_ASSIGNED' });
    const res = await post(body);
    expect(res.status).toBe(404);
    expect(await res.json()).not.toHaveProperty('success');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('a body that is not JSON is the refusal it always was', async () => {
    sheLetItGo();
    assertOrderAccess.mockResolvedValue({ allowed: false, reason: 'NOT_ASSIGNED' });
    const res = await POST(new Request('http://localhost/x', { method: 'POST', body: 'not json' }), params);
    expect(res.status).toBe(404);
  });

  it.each([
    ['its own switch off', () => { rsw.value = OFF; }],
    ['the rounds off, whatever the mode’s own switch holds', () => { sw.value = OFF; }],
  ])('OFF — %s: refused as ever, and the history is not even asked', async (_name, set) => {
    set();
    sheLetItGo();
    assertOrderAccess.mockResolvedValue({ allowed: false, reason: 'NOT_ASSIGNED' });
    expect((await post(noAnswer)).status).toBe(404);
    expect(db.orderClaimHistory.findFirst).not.toHaveBeenCalled();
  });
});
