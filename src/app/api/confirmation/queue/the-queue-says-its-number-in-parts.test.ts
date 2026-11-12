import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE QUEUE SAYS ITS NUMBER IN PARTS (the owner, 12/11: «لسا مش مفصولة» · «طلب جديد وخانة تانية طلب الراجع»)
 *
 *  1. `GET /api/confirmation/queue` answers `waitingNew` (nobody has rung it), `waitingReturned` (rung before, back in the pool) and
 *     `waitingDue` (a postponed order whose date came), next to the old `waiting`.
 *  2. `waiting` IS THEIR SUM — the one figure on the panel can never disagree with the parts under it, and both come from the one
 *     counter the pull’s own predicates feed (`waitingBreakdown`), asked for the agent herself, or for the whole pool of a supervisor.
 *  3. Nothing else moved: the rest of the answer is what it was (the date line, the colleagues’ line, the caps, `canPull`).
 *
 * The counter is a stand-in that RECORDS what it is asked; its answers against filters are `the-waiting-number-is-said-in-parts.test.ts`.
 * Blockers: no money, no order creation, no migration.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, can, queue } = vi.hoisted(() => ({
  db: { order: { findMany: vi.fn() } },
  requireContext: vi.fn(),
  can: vi.fn(),
  queue: {
    waitingBreakdown: vi.fn(),
    ownedCounts: vi.fn(),
    postponedNotDueCount: vi.fn(),
    reservedForColleaguesCount: vi.fn(),
  },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ can: (...a: unknown[]) => can(...a), requirePermission: vi.fn(async () => ({})) }));
vi.mock('@/lib/confirmation-queue', async (orig) => ({
  ...(await orig<typeof import('@/lib/confirmation-queue')>()),
  waitingBreakdown: (...a: unknown[]) => queue.waitingBreakdown(...a),
  ownedCounts: (...a: unknown[]) => queue.ownedCounts(...a),
  postponedNotDueCount: (...a: unknown[]) => queue.postponedNotDueCount(...a),
  reservedForColleaguesCount: (...a: unknown[]) => queue.reservedForColleaguesCount(...a),
}));

import { GET } from './route';

const COUNTRY = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' };
const as = (id: string, keys: string[]) => {
  requireContext.mockResolvedValue({ user: { id }, companyId: 'c1', storeId: 's1', country: COUNTRY });
  can.mockImplementation((_u: unknown, k: string) => keys.includes(k));
};
const read = async () => (await GET()).json();

beforeEach(() => {
  vi.clearAllMocks();
  queue.waitingBreakdown.mockResolvedValue({ fresh: 5, returned: 417, due: 0 });
  queue.ownedCounts.mockResolvedValue({ total: 0, withoutAttempt: 0, untouched: null });
  queue.postponedNotDueCount.mockResolvedValue(67);
  queue.reservedForColleaguesCount.mockResolvedValue(0);
  db.order.findMany.mockResolvedValue([]);
});

describe('the answer carries the parts, and the big number is their sum', () => {
  it('the owner’s screenshot: 5 new and 417 returned say 422 — and the 67 waiting on a date stay outside it', async () => {
    as('huda', ['confirmation.pull']);
    const body = await read();
    expect(body).toMatchObject({ waiting: 422, waitingNew: 5, waitingReturned: 417, waitingDue: 0, waitingOnADate: 67 });
  });

  it.each([
    [{ fresh: 0, returned: 0, due: 0 }],
    [{ fresh: 12, returned: 0, due: 7 }],
    [{ fresh: 0, returned: 300, due: 1 }],
    [{ fresh: 1, returned: 2, due: 3 }],
  ])('%j: waiting = new + returned + due, always', async (parts) => {
    as('huda', ['confirmation.pull']);
    queue.waitingBreakdown.mockResolvedValue(parts);
    const body = await read();
    expect(body.waiting).toBe(parts.fresh + parts.returned + parts.due);
    expect(body.waitingNew + body.waitingReturned + body.waitingDue).toBe(body.waiting);
  });

  it('an agent is counted for HER; a supervisor reads the whole pool — and both get the parts', async () => {
    as('huda', ['confirmation.pull']);
    expect(await read()).toHaveProperty('waitingNew', 5);
    expect(queue.waitingBreakdown.mock.calls[0][3]).toBe('huda');

    vi.clearAllMocks();
    queue.waitingBreakdown.mockResolvedValue({ fresh: 9, returned: 40, due: 2 });
    queue.ownedCounts.mockResolvedValue({ total: 0, withoutAttempt: 0, untouched: null });
    queue.postponedNotDueCount.mockResolvedValue(0);
    db.order.findMany.mockResolvedValue([]);
    as('boss', ['confirmation.supervise']);
    const body = await read();
    expect(queue.waitingBreakdown.mock.calls[0][3], 'a supervisor pulls nothing: the whole pool').toBeUndefined();
    expect(body).toMatchObject({ waiting: 51, waitingNew: 9, waitingReturned: 40, waitingDue: 2 });
  });
});

describe('nothing else in the answer moved', () => {
  it('the cap, the refusal, the date line and the colleagues’ line are what they were', async () => {
    as('huda', ['confirmation.pull']);
    queue.reservedForColleaguesCount.mockResolvedValue(3);
    const body = await read();
    expect(body.caps).toEqual({ withoutAttempt: 40, total: 500 });
    expect(body).toMatchObject({ canPull: true, refusal: null, waitingOnADate: 67, reservedForColleagues: 3, orders: null });
  });
});
