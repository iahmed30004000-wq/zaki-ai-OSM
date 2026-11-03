import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «نظام الجولات» R2 · R3 · R5 at the contact door — the same mocks as `no-answer-rule.test.ts` (the OFF rule), with the
 * switch answered by this test instead of the company's settings.
 */

const { db, requireContext, assertOrderAccess, logAudit, endOrder, sw } = vi.hoisted(() => ({
  db: {
    orderContactAttempt: { findFirst: vi.fn(), create: vi.fn(), count: vi.fn(), findMany: vi.fn() },
    order: { update: vi.fn() },
    $transaction: vi.fn(async (fn: any) => fn(db)),
  } as any,
  requireContext: vi.fn(),
  assertOrderAccess: vi.fn(),
  logAudit: vi.fn(),
  endOrder: vi.fn(),
  sw: { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/rbac', () => ({ assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/order-cancel', () => ({ endOrder: (...a: unknown[]) => endOrder(...a) }));
vi.mock('@/lib/authorization', () => ({ can: () => true, authorize: () => ({ allowed: true }) }));
vi.mock('@/lib/no-answer-rounds-switch', () => ({ roundsSwitch: async () => sw.value }));

import { POST } from '@/app/api/orders/[id]/contact-attempts/route';
import { zonedTimeToInstant } from '@/lib/business-calendar';

const TZ = 'Asia/Amman';
const t = (day: number, h: number, m = 0) => zonedTimeToInstant(TZ, 2026, 11, day, h, m);
const params = { params: Promise.resolve({ id: 'o1' }) };
const press = (result = 'NO_ANSWER') =>
  new Request('http://localhost/x', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contactMethod: 'PHONE', result }),
  });
/** One real call by Sara: «اتصل», then «لا يرد». */
const call = (at: Date, n: number) => [
  { createdAt: new Date(at.getTime() - 60_000), result: 'OPENED', employeeId: 'u1', attemptNumber: n },
  { createdAt: at, result: 'NO_ANSWER', employeeId: 'u1', attemptNumber: n + 1 },
];

beforeEach(() => {
  vi.clearAllMocks();
  sw.value = { enabled: true, enabledAt: t(1, 8) };
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
  db.orderContactAttempt.findFirst.mockResolvedValue({ attemptNumber: 5 });
  db.orderContactAttempt.create.mockResolvedValue({ id: 'a1' });
  db.$transaction.mockImplementation(async (fn: any) => fn(db));
  endOrder.mockResolvedValue({ ok: true, orderNumber: 'ORD-1' });
});

describe('ON — the close reads rounds', () => {
  it('three rounds on ONE day close nothing, and the counter says three', async () => {
    db.orderContactAttempt.findMany.mockResolvedValue([...call(t(1, 9), 1), ...call(t(1, 12), 3), ...call(t(1, 15), 5)]);
    const data = await (await POST(press(), params)).json();
    expect(data).toMatchObject({ autoClosed: false, noAnswerCount: 3 });
    expect(endOrder).not.toHaveBeenCalled();
  });

  it('three rounds over two days close it — through the same helper, with the same reason as OFF', async () => {
    db.orderContactAttempt.findMany.mockResolvedValue([...call(t(1, 9), 1), ...call(t(1, 12), 3), ...call(t(2, 10), 5)]);
    const data = await (await POST(press(), params)).json();
    expect(data.autoClosed).toBe(true);
    expect(endOrder).toHaveBeenCalledTimes(1);
    expect(endOrder.mock.calls[0][0]).toMatchObject({
      orderId: 'o1', door: 'CONTACT_AUTO_CLOSE', kind: 'CANCEL', endAs: 'CANCELLED', reason: 'NO_ANSWER_3_ATTEMPTS',
    });
  });

  it('presses within three working hours are one round: seven presses, two rounds, no close', async () => {
    db.orderContactAttempt.findMany.mockResolvedValue([
      ...call(t(1, 9), 1), ...call(t(1, 9, 30), 3), ...call(t(1, 10), 5), ...call(t(1, 11), 7),
      ...call(t(2, 9), 9), ...call(t(2, 9, 10), 11), ...call(t(2, 9, 20), 13),
    ]);
    const data = await (await POST(press(), params)).json();
    expect(data).toMatchObject({ autoClosed: false, noAnswerCount: 2 });
  });

  it('presses with no «اتصل» before them are kept and not counted', async () => {
    db.orderContactAttempt.findMany.mockResolvedValue([
      { createdAt: t(1, 9), result: 'NO_ANSWER', employeeId: 'u1' },
      { createdAt: t(1, 13), result: 'NO_ANSWER', employeeId: 'u1' },
      { createdAt: t(2, 13), result: 'NO_ANSWER', employeeId: 'u1' },
    ]);
    const data = await (await POST(press(), params)).json();
    expect(data).toMatchObject({ autoClosed: false, noAnswerCount: 0 });
    expect(db.orderContactAttempt.create).toHaveBeenCalledTimes(1);
  });

  it('and the all-time count is not asked', async () => {
    db.orderContactAttempt.findMany.mockResolvedValue([]);
    await POST(press(), params);
    expect(db.orderContactAttempt.count).not.toHaveBeenCalled();
  });
});

describe('OFF — today’s rule, untouched (ROLLBACK: turning it off is this, at once)', () => {
  beforeEach(() => {
    sw.value = { enabled: false, enabledAt: null };
  });

  it('the third no-answer of all time closes, whatever the days, and the attempts are not read', async () => {
    db.orderContactAttempt.count.mockResolvedValue(3);
    const data = await (await POST(press(), params)).json();
    expect(data.autoClosed).toBe(true);
    expect(db.orderContactAttempt.findMany).not.toHaveBeenCalled();
  });

  it('the second leaves it open', async () => {
    db.orderContactAttempt.count.mockResolvedValue(2);
    expect((await (await POST(press(), params)).json()).autoClosed).toBe(false);
  });
});
