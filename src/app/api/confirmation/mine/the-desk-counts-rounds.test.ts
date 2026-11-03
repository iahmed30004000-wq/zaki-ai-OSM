import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «نظام الجولات» on «طلباتي»: the counter is the round the close reads, and an open order never falls out of both tabs —
 * three rounds on one day stay under «لا يرد». OFF, the desk is today's: every no-answer counts and the third is not listed.
 */

const { db, sw } = vi.hoisted(() => ({
  db: {
    order: { findMany: vi.fn(), count: vi.fn(async () => 0) },
    orderContactAttempt: { groupBy: vi.fn(), findMany: vi.fn() },
  },
  sw: { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({
    user: { id: 'u1', name: 'Sara', role: 'CONFIRMATION_AGENT', companyId: 'c1', permissions: [] },
    companyId: 'c1',
    storeId: 's1',
    countryId: 'co1',
    country: { id: 'co1', code: 'JO', timezone: 'Asia/Amman', workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6] },
  }),
}));
vi.mock('@/lib/authorization', () => ({ requirePermission: async () => undefined }));
vi.mock('@/lib/insights-key', () => ({ mayReadInsights: () => false }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: async () => undefined }));
vi.mock('@/lib/response-clock', () => ({ firstActionTimes: async () => new Map() }));
vi.mock('@/lib/no-answer-rounds-switch', () => ({ roundsSwitch: async () => sw.value }));

import { GET } from './route';
import { zonedTimeToInstant } from '@/lib/business-calendar';

const t = (day: number, h: number, m = 0) => zonedTimeToInstant('Asia/Amman', 2026, 11, day, h, m);
const row = (id: string) => ({ id, confirmationStatus: 'IN_PROGRESS', customer: { id: `c-${id}`, totalOrders: 1 } });
const call = (orderId: string, at: Date) => [
  { orderId, createdAt: new Date(at.getTime() - 60_000), result: 'OPENED', employeeId: 'u1', attemptNumber: 1 },
  { orderId, createdAt: at, result: 'NO_ANSWER', employeeId: 'u1', attemptNumber: 2 },
];

beforeEach(() => {
  vi.clearAllMocks();
  // The first findMany is the desk's open orders; the other two (closed today, confirmed) are empty.
  db.order.findMany.mockResolvedValueOnce([row('fresh'), row('oneDay'), row('twice')]).mockResolvedValue([]);
});

describe('ON', () => {
  beforeEach(() => {
    sw.value = { enabled: true, enabledAt: t(1, 8) };
    db.orderContactAttempt.findMany.mockResolvedValue([
      // Three rounds on Sunday: open, round 3 of 3.
      ...call('oneDay', t(1, 9)), ...call('oneDay', t(1, 12)), ...call('oneDay', t(1, 15)),
      // Two presses within the hour: one round.
      ...call('twice', t(1, 9)), ...call('twice', t(1, 9, 30)),
    ]);
  });

  it('counts rounds, says so, and keeps three-on-one-day under «لا يرد»', async () => {
    const data = await (await GET(new Request('http://localhost/api/confirmation/mine'))).json();
    expect(data.rounds).toBe(true);
    expect(data.work.map((o: { id: string }) => o.id)).toEqual(['fresh']);
    const noAnswer = Object.fromEntries(data.noAnswer.map((o: { id: string; noAnswerCount: number }) => [o.id, o.noAnswerCount]));
    expect(noAnswer).toEqual({ oneDay: 3, twice: 1 });
    expect(db.orderContactAttempt.groupBy).not.toHaveBeenCalled();
  });
});

describe('OFF — today’s desk', () => {
  beforeEach(() => {
    sw.value = { enabled: false, enabledAt: null };
    db.orderContactAttempt.groupBy.mockResolvedValue([
      { orderId: 'oneDay', _count: { _all: 3 } },
      { orderId: 'twice', _count: { _all: 2 } },
    ]);
  });

  it('every no-answer counts, the third is not listed, and the attempts are not read', async () => {
    const data = await (await GET(new Request('http://localhost/api/confirmation/mine'))).json();
    expect(data).not.toHaveProperty('rounds');
    expect(data.work.map((o: { id: string }) => o.id)).toEqual(['fresh']);
    expect(data.noAnswer.map((o: { id: string; noAnswerCount: number }) => [o.id, o.noAnswerCount])).toEqual([['twice', 2]]);
    expect(db.orderContactAttempt.findMany).not.toHaveBeenCalled();
  });
});
