import { describe, expect, it, vi } from 'vitest';
import {
  LIST_DAYS,
  autoMoveIdleLists,
  expireLists,
  handToList,
  lastFullShift,
  notAWinbackListOrder,
  notOnAPrivateList,
  offeredBeforeWhere,
  planMoves,
} from './winback-private-list';
import { heldWithoutAttemptWhere, idleHeldWhere, ownedCounts, readyToPullWhere, duePostponedWhere } from './confirmation-queue';

/**
 * THE PRIVATE WIN-BACK LIST (F12, the owner's ruling 25/11, «A»). Dates and counts written by hand.
 */

const SCOPE = { companyId: 'c1', storeId: 's1' };
// Damascus: Sun–Thu working (Fri 5, Sat 6 off), 09:00–17:00, UTC+3.
const CAL = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Damascus' };

describe('the list is outside the pull and outside the hand', () => {
  it('a fresh NEW order is pullable; no win-back list order — on a list or let go — is ever in the pool the pull reads', () => {
    for (const where of [readyToPullWhere(SCOPE), readyToPullWhere(SCOPE, 'sara'), duePostponedWhere(SCOPE, new Date())]) {
      expect(where).toMatchObject(notAWinbackListOrder);
    }
    expect(notAWinbackListOrder).toEqual({ winbackListAt: null });
  });

  it('the cap, the contact-first gate and the idle release never read a list row', () => {
    expect(heldWithoutAttemptWhere(SCOPE, 'sara')).toMatchObject(notOnAPrivateList);
    expect(heldWithoutAttemptWhere(SCOPE)).toMatchObject(notOnAPrivateList);
    expect(idleHeldWhere(SCOPE, { idleCut: new Date() })).toMatchObject(notOnAPrivateList);
    expect(notOnAPrivateList).toEqual({ winbackListUserId: null });
  });

  it('ownedCounts — her hand under the cap — asks every count without the list rows', async () => {
    const wheres: unknown[] = [];
    const tx = {
      order: {
        count: vi.fn(async ({ where }: { where: unknown }) => {
          wheres.push(where);
          return 0;
        }),
        findFirst: vi.fn(async ({ where }: { where: unknown }) => {
          wheres.push(where);
          return null;
        }),
      },
    };
    await ownedCounts(tx as never, SCOPE, 'sara');
    // the hand and the untouched count carry the list exclusion; the «held for her» count is the reservation's (assignedToId), which a list row never carries
    const hand = wheres.filter((w) => JSON.stringify(w).includes('"claimedById":"sara"'));
    expect(hand.length).toBeGreaterThanOrEqual(3);
    for (const w of hand) expect(w).toMatchObject(notOnAPrivateList);
  });
});

describe('the hand-out', () => {
  const client = () => {
    const calls: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
    return {
      calls,
      order: { updateMany: vi.fn(async (a: { where: Record<string, unknown>; data: Record<string, unknown> }) => (calls.push(a), { count: 1 })) },
      orderActivity: { create: vi.fn() },
    };
  };
  const now = new Date('2026-11-25T10:00:00Z');

  it('claims the NEW order for her, marks her list and starts the clock — only an order nobody holds and no list holds', async () => {
    const c = client();
    expect(await handToList(c as never, { ...SCOPE, orderId: 'o1', agentId: 'sara', byUserId: 'mgr', now })).toBe(true);
    expect(c.calls[0].where).toMatchObject({ id: 'o1', ...SCOPE, claimedById: null, assignedToId: null, confirmationStatus: 'NEW', winbackListUserId: null, winbackListAt: { not: null } });
    expect(c.calls[0].data).toMatchObject({ claimedById: 'sara', winbackListUserId: 'sara', winbackListAt: now, winbackListSince: now });
  });

  it('a re-hand takes only an order a list let go («انعرض من قبل»), and restarts the clock', async () => {
    const c = client();
    await handToList(c as never, { ...SCOPE, orderId: 'o1', agentId: 'huda', byUserId: 'mgr', now, rehand: true });
    expect(c.calls[0].where).toMatchObject({ winbackListUserId: null, winbackListAt: { not: null } });
    expect(c.calls[0].data).toMatchObject({ winbackListAt: now });
    expect(offeredBeforeWhere(SCOPE)).toMatchObject({ winbackListAt: { not: null }, winbackListUserId: null, claimedById: null, confirmationStatus: 'NEW' });
  });
});

describe('three days: what is untouched goes back to the win-back pool, marked «انعرض من قبل»', () => {
  it('the cut is three days after the hand-out; only untouched rows; the mark is KEPT and the holder cleared', async () => {
    const updateMany = vi.fn(async () => ({ count: 4 }));
    const now = new Date('2026-11-28T10:00:00Z');
    expect(await expireLists({ order: { updateMany } } as never, SCOPE, now)).toBe(4);
    const [{ where, data }] = updateMany.mock.calls[0] as unknown as [{ where: Record<string, any>; data: Record<string, unknown> }];
    expect(LIST_DAYS).toBe(3);
    expect(where).toMatchObject({ ...SCOPE, winbackListUserId: { not: null }, confirmationStatus: 'NEW', contactAttempts: { none: {} } });
    expect(where.winbackListAt.lte.toISOString()).toBe('2026-11-25T10:00:00.000Z');
    expect(data).toMatchObject({ claimedById: null, winbackListUserId: null });
    expect('winbackListAt' in data).toBe(false);
    // it never names an order without a list mark: the 165 handed out by hand carry none
    expect(where.winbackListUserId).toEqual({ not: null });
  });
});

describe('one full shift untouched → the active agent with the fewest open rows', () => {
  it('the last full shift is the last working day, whole, in the store’s hours (a weekend is skipped)', () => {
    // Sunday 2026-11-29 08:00 Damascus = 05:00Z → the last working day is Thursday 26/11 (Fri, Sat off).
    const s = lastFullShift(CAL, new Date('2026-11-29T05:00:00Z'))!;
    expect(s.start.toISOString()).toBe('2026-11-26T06:00:00.000Z');
    expect(s.end.toISOString()).toBe('2026-11-26T14:00:00.000Z');
    // Wednesday 18:00 local: yesterday (Tuesday) is the last FULL one; today's shift is not over until it is.
    const w = lastFullShift(CAL, new Date('2026-11-25T15:00:00Z'))!;
    expect(w.start.toISOString()).toBe('2026-11-24T06:00:00.000Z');
  });

  it('rows go one by one to the active agent with the fewest open rows; never back to the idle holder; nobody active, nothing moves', () => {
    const moves = planMoves(
      [{ userId: 'abeer', rows: ['a', 'b', 'c'] }],
      [
        { userId: 'salwa', open: 2 },
        { userId: 'mona', open: 0 },
        { userId: 'abeer', open: 0 },
      ]
    );
    expect(moves.map((m) => [m.orderId, m.to])).toEqual([
      ['a', 'mona'],
      ['b', 'mona'],
      ['c', 'salwa'],
    ]);
    expect(planMoves([{ userId: 'abeer', rows: ['a'] }], [])).toEqual([]);
    expect(planMoves([{ userId: 'abeer', rows: ['a'] }], [{ userId: 'abeer', open: 0 }])).toEqual([]);
  });

  it('end to end: an idle holder’s untouched rows move; a holder who touched her list keeps hers; the clock is not reset', async () => {
    const now = new Date('2026-11-29T05:00:00Z'); // shift = Thu 26/11 06:00–14:00Z
    const before = new Date('2026-11-25T10:00:00Z');
    const writes: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
    const client = {
      order: {
        findMany: vi.fn(async () => [
          { id: 'a1', winbackListUserId: 'abeer' },
          { id: 'a2', winbackListUserId: 'abeer' },
          { id: 's1', winbackListUserId: 'salwa' },
        ]),
        groupBy: vi.fn(async () => [{ winbackListUserId: 'salwa', _count: { _all: 5 } }]),
        updateMany: vi.fn(async (a: { where: Record<string, unknown>; data: Record<string, unknown> }) => (writes.push(a), { count: 1 })),
      },
      orderContactAttempt: {
        findMany: vi.fn(async () => [
          // salwa worked her list in the shift; mona worked the pool; abeer did nothing
          { employeeId: 'salwa', order: { winbackListUserId: 'salwa' } },
          { employeeId: 'mona', order: { winbackListUserId: null } },
        ]),
      },
      orderStatusLog: { findMany: vi.fn(async () => []) },
      orderActivity: { create: vi.fn() },
    };
    const moved = await autoMoveIdleLists(client as never, SCOPE, CAL, now, ['abeer', 'salwa', 'mona']);
    expect(moved).toBe(2);
    expect(writes.map((w) => [w.where.id, w.data.winbackListUserId])).toEqual([
      ['a1', 'mona'],
      ['a2', 'mona'],
    ]);
    for (const w of writes) {
      expect(w.where).toMatchObject({ winbackListUserId: 'abeer', claimedById: 'abeer', confirmationStatus: 'NEW', contactAttempts: { none: {} } });
      expect('winbackListAt' in w.data).toBe(false);
      expect(w.data.winbackListSince).toEqual(now);
    }
    // the rows read were handed out before the shift began, and only untouched ones, in this store
    const where = (client.order.findMany.mock.calls[0] as unknown as [{ where: Record<string, any> }])[0].where;
    expect(where).toMatchObject({ ...SCOPE, winbackListSince: { lt: new Date('2026-11-26T06:00:00.000Z') }, contactAttempts: { none: {} } });
    expect(before.getTime()).toBeLessThan(where.winbackListSince.lt.getTime());
  });

  const moveClient = (worked: unknown[], decided: unknown[]) => ({
    order: {
      findMany: vi.fn(async () => [{ id: 'a1', winbackListUserId: 'abeer' }]),
      groupBy: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    orderContactAttempt: { findMany: vi.fn(async () => worked) },
    orderStatusLog: { findMany: vi.fn(async () => decided) },
    orderActivity: { create: vi.fn() },
  });

  it('B21 — an agent who worked the shift but may not be handed an order (not in eligible) never receives one', async () => {
    const c = moveClient([{ employeeId: 'wael', order: { winbackListUserId: null } }, { employeeId: 'mona', order: { winbackListUserId: null } }], []);
    await autoMoveIdleLists(c as never, SCOPE, CAL, new Date('2026-11-29T05:00:00Z'), ['abeer', 'mona']);
    expect((c.order.updateMany.mock.calls as any[]).map((x) => x[0].data.winbackListUserId)).toEqual(['mona']);
    const c2 = moveClient([{ employeeId: 'wael', order: { winbackListUserId: null } }], []);
    expect(await autoMoveIdleLists(c2 as never, SCOPE, CAL, new Date('2026-11-29T05:00:00Z'), ['abeer', 'mona'])).toBe(0);
  });

  it('B22 — a DECISION she made on her list in the shift (a status line by her) counts as touching it: nothing moves', async () => {
    const c = moveClient([{ employeeId: 'mona', order: { winbackListUserId: null } }], [{ changedById: 'abeer', order: { winbackListUserId: 'abeer' } }]);
    expect(await autoMoveIdleLists(c as never, SCOPE, CAL, new Date('2026-11-29T05:00:00Z'), ['abeer', 'mona'])).toBe(0);
    expect(c.order.updateMany).not.toHaveBeenCalled();
    // and a status line by her on ANOTHER list's order is not touching hers
    const c2 = moveClient([{ employeeId: 'mona', order: { winbackListUserId: null } }], [{ changedById: 'abeer', order: { winbackListUserId: 'mona' } }]);
    expect(await autoMoveIdleLists(c2 as never, SCOPE, CAL, new Date('2026-11-29T05:00:00Z'), ['abeer', 'mona'])).toBe(1);
  });

  it('nobody active in the shift: nothing moves', async () => {
    const client = {
      order: { findMany: vi.fn(async () => [{ id: 'a1', winbackListUserId: 'abeer' }]), groupBy: vi.fn(), updateMany: vi.fn() },
      orderContactAttempt: { findMany: vi.fn(async () => []) },
      orderStatusLog: { findMany: vi.fn(async () => []) },
      orderActivity: { create: vi.fn() },
    };
    expect(await autoMoveIdleLists(client as never, SCOPE, CAL, new Date('2026-11-29T05:00:00Z'), ['abeer', 'salwa'])).toBe(0);
    expect(client.order.updateMany).not.toHaveBeenCalled();
  });
});
