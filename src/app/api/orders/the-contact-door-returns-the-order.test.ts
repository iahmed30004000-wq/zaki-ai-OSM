import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE CONTACT DOOR OF «الطلب يرجع للطابور فوراً» (the owner, 9/11)
 *
 * With the mode ON (and the rounds on beside it):
 *
 *  1. The HOLDER’s «لا يرد» / «مشغول» / «مسكّر» takes the order out of her hand IN THE SAME TRANSACTION as the attempt, with the other
 *     releases’ write and a `RELEASED` line that says nobody pressed «release» (reason `NO_ANSWER_RETURNED`); the answer says so.
 *  2. A press that claims no outcome — «اتصل», a sent message — and every result that REACHED somebody release nothing.
 *  3. Somebody else’s press (a supervisor logging a call on a colleague’s order) releases nothing.
 *  4. The close comes first: an order the third round closed is not released; a close the helper refused leaves the order alone.
 *  5. Her twins held for her are not touched (one write, the order’s own).
 *
 * With the mode OFF — its own switch off, or the rounds off whatever it holds — the door is today’s: not one extra write, and the
 * answer carries not one extra key.
 *
 * The same mocks as `no-answer-rounds-close.test.ts` (the rounds’ half of this door), the two switches answered by this test.
 * Blockers: no money, no order creation, no migration.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, calls, requireContext, assertOrderAccess, logAudit, endOrder, sw, rsw } = vi.hoisted(() => {
  const calls: string[] = [];
  const db = {
    orderContactAttempt: { findFirst: vi.fn(), create: vi.fn(), count: vi.fn(), findMany: vi.fn() },
    order: { update: vi.fn(), updateMany: vi.fn() },
    orderClaimHistory: { create: vi.fn() },
    $transaction: vi.fn(),
  } as any;
  return {
    db,
    calls,
    requireContext: vi.fn(),
    assertOrderAccess: vi.fn(),
    logAudit: vi.fn(),
    endOrder: vi.fn(),
    sw: { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } },
    rsw: { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } },
  };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/rbac', () => ({ assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/order-cancel', () => ({ endOrder: (...a: unknown[]) => endOrder(...a) }));
vi.mock('@/lib/authorization', () => ({ can: () => true, authorize: () => ({ allowed: true }) }));
vi.mock('@/lib/no-answer-rounds-switch', () => ({ roundsSwitch: async () => sw.value }));
vi.mock('@/lib/no-answer-returns-switch', () => ({ returnsSwitch: async () => rsw.value }));

import { POST } from '@/app/api/orders/[id]/contact-attempts/route';
import { zonedTimeToInstant } from '@/lib/business-calendar';

const TZ = 'Asia/Amman';
const t = (day: number, h: number, m = 0) => zonedTimeToInstant(TZ, 2026, 11, day, h, m);
const params = { params: Promise.resolve({ id: 'o1' }) };
const press = (result = 'NO_ANSWER') =>
  POST(
    new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contactMethod: 'PHONE', result }) }),
    params
  );
/** One real call by u1: «اتصل», then «لا يرد». */
const call = (at: Date, n: number) => [
  { createdAt: new Date(at.getTime() - 60_000), result: 'OPENED', employeeId: 'u1', attemptNumber: n },
  { createdAt: at, result: 'NO_ANSWER', employeeId: 'u1', attemptNumber: n + 1 },
];
const ON = { enabled: true, enabledAt: t(1, 8) };
const OFF = { enabled: false, enabledAt: null };

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  sw.value = ON;
  rsw.value = ON;
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'Agent', role: 'CONFIRMATION_AGENT', status: 'ACTIVE' },
    companyId: 'c1',
    storeId: 's1',
    country: { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: TZ },
  });
  assertOrderAccess.mockResolvedValue({
    allowed: true,
    order: { id: 'o1', claimedById: 'u1', confirmationStatus: 'IN_PROGRESS', nextFollowUpAt: null, followUpStatus: null, shippingStatus: 'NOT_READY' },
  });
  db.orderContactAttempt.findFirst.mockResolvedValue({ attemptNumber: 1 });
  db.orderContactAttempt.create.mockImplementation(async () => (calls.push('attempt'), { id: 'a1' }));
  db.orderContactAttempt.findMany.mockResolvedValue([...call(t(2, 9), 1)]);
  db.order.updateMany.mockImplementation(async () => (calls.push('release'), { count: 1 }));
  db.orderClaimHistory.create.mockImplementation(async () => void calls.push('history'));
  db.$transaction.mockImplementation(async (fn: any) => {
    calls.push('begin');
    const out = await fn(db);
    calls.push('commit');
    return out;
  });
  endOrder.mockResolvedValue({ ok: true, orderNumber: 'ORD-1' });
});

describe('ON — her «لا يرد» takes the order out of her hand', () => {
  it('releases in the SAME transaction, after the attempt, with the other releases’ write and a line that says nobody pressed', async () => {
    const res = await press('NO_ANSWER');
    expect(await res.json()).toMatchObject({ success: true, autoClosed: false, returnedToQueue: true });
    expect(calls).toEqual(['begin', 'attempt', 'release', 'history', 'commit']);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
    const write = db.order.updateMany.mock.calls[0][0];
    // The same write the other releases make — and not a column more.
    expect(write.data).toEqual({ claimedById: null, claimedAt: null, currentOwnerId: null, signatureStatus: 'UNSIGNED', assignedAt: null });
    // Guarded at the write: hers, still at the desk, never shipped.
    expect(write.where).toEqual({
      id: 'o1', companyId: 'c1', claimedById: 'u1',
      confirmationStatus: { in: ['NEW', 'IN_PROGRESS', 'NO_ANSWER', 'FOLLOW_UP_REQUIRED', 'POSTPONED'] },
      shippingStatus: 'NOT_READY', shippingBatchId: null, trackingNumber: null, labelPrintedAt: null,
    });
    expect(db.orderClaimHistory.create).toHaveBeenCalledWith({
      data: { companyId: 'c1', orderId: 'o1', userId: 'u1', action: 'RELEASED', reason: 'NO_ANSWER_RETURNED', metadata: JSON.stringify({ automatic: true, holder: 'u1' }) },
    });
  });

  it.each(['BUSY', 'UNREACHABLE'])('«%s» is a call that reached nobody: it releases too', async (result) => {
    const data = await (await press(result)).json();
    expect(data.returnedToQueue).toBe(true);
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
  });

  it('her twins held for her are not touched: the order’s own write is the only write', async () => {
    await press('NO_ANSWER');
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
    expect(db.order.updateMany.mock.calls[0][0].where).not.toHaveProperty('customerId');
    expect(db.order.updateMany.mock.calls[0][0].data).not.toHaveProperty('assignedToId');
  });

  it('a write that matched nothing (the order moved in the same instant) releases nothing and says nothing', async () => {
    db.order.updateMany.mockResolvedValue({ count: 0 });
    const data = await (await press('NO_ANSWER')).json();
    expect(data.returnedToQueue).toBeUndefined();
    expect(data.success).toBe(true);
    expect(db.orderClaimHistory.create).not.toHaveBeenCalled();
  });
});

describe('ON — a press that is not a «لا يرد» releases nothing', () => {
  it.each(['OPENED', 'MESSAGE_SENT', 'ANSWERED', 'WRONG_NUMBER', 'CALLBACK_REQUESTED', 'OTHER'])('«%s» stays in her hand', async (result) => {
    const res = await press(result);
    expect(res.status).toBe(200);
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.orderClaimHistory.create).not.toHaveBeenCalled();
    expect(await res.json()).not.toHaveProperty('returnedToQueue');
  });

  it('a realistic call — «اتصل» then «لا يرد»: the dial keeps it, the «لا يرد» lets it go', async () => {
    await press('OPENED');
    expect(db.order.updateMany).not.toHaveBeenCalled();
    await press('NO_ANSWER');
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe('ON — only the holder’s press releases', () => {
  it('a supervisor logging a call on a colleague’s order lets nothing go', async () => {
    assertOrderAccess.mockResolvedValue({
      allowed: true,
      order: { id: 'o1', claimedById: 'noor', confirmationStatus: 'IN_PROGRESS', nextFollowUpAt: null, followUpStatus: null, shippingStatus: 'NOT_READY' },
    });
    const res = await press('NO_ANSWER');
    expect(res.status).toBe(200);
    expect(db.orderContactAttempt.create).toHaveBeenCalledTimes(1);
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(await res.json()).not.toHaveProperty('returnedToQueue');
  });

  it('an order nobody holds is not “hers”: nothing to release', async () => {
    assertOrderAccess.mockResolvedValue({
      allowed: true,
      order: { id: 'o1', claimedById: null, confirmationStatus: 'NEW', nextFollowUpAt: null, followUpStatus: null, shippingStatus: 'NOT_READY' },
    });
    await press('NO_ANSWER');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });
});

describe('ON — the close comes first', () => {
  // Three counted rounds on two different days: the third press closes the order (the rounds’ R3, unchanged).
  const threeRoundsOnTwoDays = () =>
    db.orderContactAttempt.findMany.mockResolvedValue([...call(t(1, 9), 1), ...call(t(1, 13), 3), ...call(t(2, 10), 5)]);

  it('an order the third round closed is NOT released — it is closed, as ever, by the one helper', async () => {
    threeRoundsOnTwoDays();
    const data = await (await press('NO_ANSWER')).json();
    expect(data.autoClosed).toBe(true);
    expect(endOrder).toHaveBeenCalledTimes(1);
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.orderClaimHistory.create).not.toHaveBeenCalled();
    expect(data).not.toHaveProperty('returnedToQueue');
  });

  it('a close the helper refused leaves the attempt recorded and the order alone — no release either', async () => {
    threeRoundsOnTwoDays();
    endOrder.mockResolvedValue({ ok: false, status: 409, error: 'moved', code: 'X' });
    const data = await (await press('NO_ANSWER')).json();
    expect(data.autoClosed).toBe(false);
    expect(db.orderContactAttempt.create).toHaveBeenCalledTimes(1);
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('two rounds are not three: the order does not close and goes back to the pool', async () => {
    db.orderContactAttempt.findMany.mockResolvedValue([...call(t(1, 9), 1), ...call(t(2, 10), 3)]);
    const data = await (await press('NO_ANSWER')).json();
    expect(data).toMatchObject({ autoClosed: false, noAnswerCount: 2, returnedToQueue: true });
    expect(endOrder).not.toHaveBeenCalled();
  });
});

describe('OFF — the door is today’s, with not one write and not one key more', () => {
  it.each([
    ['its own switch off', () => { rsw.value = OFF; }],
    ['the rounds off, whatever the mode’s own switch holds', () => { sw.value = OFF; }],
    ['both off', () => { sw.value = OFF; rsw.value = OFF; }],
  ])('%s', async (_name, set) => {
    set();
    db.orderContactAttempt.count.mockResolvedValue(1);
    const res = await press('NO_ANSWER');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.orderClaimHistory.create).not.toHaveBeenCalled();
    expect(Object.keys(data).sort()).toEqual(['attempt', 'autoClosed', 'noAnswerCount', 'noAnswerLimit', 'success']);
  });
});
