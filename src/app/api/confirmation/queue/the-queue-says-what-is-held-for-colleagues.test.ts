import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — the queue read, with the orders held for the agent who worked the customer
 *
 *  1. An agent's «بانتظارك» is what SHE may take (asked with her id) and the orders held for colleagues are counted APART in
 *     `reservedForColleagues`, so the first number is never a button that answers «لا توجد طلبات».
 *  2. The supervisor reads the whole pool, as before (no agent id on the counter), with each row's `reservedFor` — the name
 *     while the hold stands, `null` once it has let go.
 *  3. The hold is made before anything is counted, and a hold that could not be made never breaks the read.
 *
 * Blockers: no money, no order creation.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, can, reserve, queue } = vi.hoisted(() => ({
  db: { order: { findMany: vi.fn() } },
  requireContext: vi.fn(),
  can: vi.fn(),
  reserve: vi.fn(),
  queue: {
    releaseStaleClaims: vi.fn(),
    waitingCount: vi.fn(),
    ownedCounts: vi.fn(),
    postponedNotDueCount: vi.fn(),
    reservedForColleaguesCount: vi.fn(),
  },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ can: (...a: unknown[]) => can(...a), requirePermission: vi.fn(async () => ({})) }));
vi.mock('@/lib/reserve-returning-customers', () => ({ reserveReturningCustomers: (...a: unknown[]) => reserve(...a) }));
vi.mock('@/lib/confirmation-queue', async (orig) => ({
  ...(await orig<typeof import('@/lib/confirmation-queue')>()),
  releaseStaleClaims: (...a: unknown[]) => queue.releaseStaleClaims(...a),
  waitingCount: (...a: unknown[]) => queue.waitingCount(...a),
  ownedCounts: (...a: unknown[]) => queue.ownedCounts(...a),
  postponedNotDueCount: (...a: unknown[]) => queue.postponedNotDueCount(...a),
  reservedForColleaguesCount: (...a: unknown[]) => queue.reservedForColleaguesCount(...a),
}));

import { GET } from './route';

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
const COUNTRY = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' };
const as = (id: string, keys: string[]) => {
  requireContext.mockResolvedValue({ user: { id }, companyId: 'c1', storeId: 's1', country: COUNTRY });
  can.mockImplementation((_u: unknown, k: string) => keys.includes(k));
};
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, orderNumber: id.toUpperCase(), merchantRef: null, createdAt: hoursAgo(2), confirmationStatus: 'NEW', postponedUntil: null,
  postponeCount: 0, totalAmount: 20, customer: { fullName: 'زبون', city: 'دمشق' }, product: { name: 'منتج' },
  claimedById: null, assignedToId: null, assignedAt: null, assignee: null, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  reserve.mockResolvedValue(0);
  queue.releaseStaleClaims.mockResolvedValue(0);
  queue.waitingCount.mockResolvedValue(4);
  queue.ownedCounts.mockResolvedValue({ total: 0, withoutAttempt: 0, untouched: null });
  queue.postponedNotDueCount.mockResolvedValue(0);
  queue.reservedForColleaguesCount.mockResolvedValue(3);
  db.order.findMany.mockResolvedValue([]);
});

describe('an agent reading the queue', () => {
  it('is counted for HER, and told apart how many are held for colleagues; she gets no list', async () => {
    as('huda', ['confirmation.pull']);
    const body = await (await GET()).json();

    expect(queue.waitingCount.mock.calls[0][3]).toBe('huda');
    expect(queue.reservedForColleaguesCount.mock.calls[0][2]).toBe('huda');
    expect(body.waiting).toBe(4);
    expect(body.reservedForColleagues).toBe(3);
    expect(body.orders).toBeNull();
    expect(db.order.findMany).not.toHaveBeenCalled();
  });
});

describe('a supervisor reading the queue', () => {
  it('sees the whole pool (no agent on the counter) and each row with whom it is held for — only while the hold stands', async () => {
    as('boss', ['confirmation.supervise']);
    db.order.findMany.mockResolvedValue([
      row('o1', { assignedToId: 'sara', assignedAt: hoursAgo(2), assignee: { id: 'sara', name: 'سارة', status: 'ACTIVE' } }),
      row('o2', { assignedToId: 'sara', assignedAt: hoursAgo(30), assignee: { id: 'sara', name: 'سارة', status: 'ACTIVE' } }),
      row('o3', { assignedToId: 'noor', assignedAt: hoursAgo(2), assignee: { id: 'noor', name: 'نور', status: 'DISABLED' } }),
      row('o4'),
    ]);

    const body = await (await GET()).json();

    expect(queue.waitingCount.mock.calls[0][3]).toBeUndefined();
    expect(queue.reservedForColleaguesCount).not.toHaveBeenCalled();
    expect(body.reservedForColleagues).toBe(0);
    expect(body.orders.map((o: { id: string; reservedFor: unknown }) => [o.id, o.reservedFor])).toEqual([
      ['o1', { id: 'sara', name: 'سارة' }],
      ['o2', null], // a day gone
      ['o3', null], // her account is off
      ['o4', null],
    ]);
    // The raw ownership columns and the assignee's status are not sent.
    expect(Object.keys(body.orders[0]).sort()).not.toEqual(expect.arrayContaining(['assignedToId', 'claimedById', 'assignee']));
  });
});

describe('the hold', () => {
  it('is made before anything is counted', async () => {
    as('huda', ['confirmation.pull']);
    await GET();
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(reserve.mock.invocationCallOrder[0]).toBeLessThan(queue.waitingCount.mock.invocationCallOrder[0]);
  });

  it('never breaks the read when it could not be made', async () => {
    as('huda', ['confirmation.pull']);
    reserve.mockRejectedValue(new Error('the audience query failed'));
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).waiting).toBe(4);
  });
});
