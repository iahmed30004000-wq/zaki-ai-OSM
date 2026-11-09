import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE IDLE RELEASE OF «الطلب يرجع للطابور فوراً» (the owner, 9/11)
 *
 *  1. An order in somebody’s hand with NOTHING logged on it for thirty WORKING minutes goes back to the queue as it was: the other
 *     releases’ write, a `RELEASED` line that says nobody pressed «release», ONE notice to her — and a never-rung order is a new
 *     order again to the pull.
 *  2. «Nothing logged» is any attempt: a press of «اتصل» and a sent message reset the thirty minutes, as a call does.
 *  3. Working minutes: an evening and a Friday add none.
 *  4. Never an order that is decided, on a trolley, with a tracking number, with a printed label or already shipping.
 *  5. Bounded: 200 a pass in the job, 25 inside a pull — so the first time the mode is switched on, the old piles come back a page
 *     at a time, and the pull says how many went.
 *  6. It runs where every release runs — in `releaseStaleClaims` (before every pull) and in the five-minute job’s second
 *     transaction (`releaseNoAnswerRounds`) — and ONLY with the mode on: the mode off, not one query for it is asked.
 *  7. A press that wins the race wins: the write is conditional on the very claim that was read.
 *
 * Driven against an in-memory database that APPLIES the filters it is given (SQL’s three values), like `work-first-pull.test.ts`.
 * Blockers: no money, no order creation, no migration.
 * ═══════════════════════════════════════════════════════════════════════
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const { world, sw, rsw } = vi.hoisted(() => ({
  world: { orders: [] as Row[], history: [] as Row[], notices: [] as Row[], clock: new Date() },
  sw: { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } },
  rsw: { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } },
}));

type Tri = true | false | null;
const and = (xs: Tri[]): Tri => (xs.includes(false) ? false : xs.includes(null) ? null : true);
const or = (xs: Tri[]): Tri => (xs.includes(true) ? true : xs.includes(null) ? null : false);
function tri(row: Row, where: Row): Tri {
  return and(
    Object.entries(where).map(([key, cond]): Tri => {
      if (key === 'AND') return and((cond as Row[]).map((w) => tri(row, w)));
      if (key === 'OR') return or((cond as Row[]).map((w) => tri(row, w)));
      const value = row[key] ?? null;
      if (cond === null) return value === null;
      if (cond instanceof Date) return value === null ? null : (value as Date).getTime() === cond.getTime();
      if (typeof cond !== 'object') return value === null ? null : value === cond;
      return and(
        Object.entries(cond as Row).map(([op, arg]): Tri => {
          switch (op) {
            case 'not': return arg === null ? value !== null : value === null ? null : value !== arg;
            case 'in': return value === null ? null : (arg as unknown[]).includes(value);
            case 'gt': return value === null ? null : typeof value === 'string' ? value > (arg as string) : (value as Date).getTime() > (arg as Date).getTime();
            case 'gte': return value === null ? null : (value as Date).getTime() >= (arg as Date).getTime();
            case 'lte': return value === null ? null : (value as Date).getTime() <= (arg as Date).getTime();
            case 'is': return arg === null ? value === null : value === null ? null : tri(value as Row, arg as Row);
            case 'none': return !(row[key] ?? []).some((c: Row) => tri(c, arg as Row) === true);
            case 'some': return (row[key] ?? []).some((c: Row) => tri(c, arg as Row) === true);
            default: throw new Error(`the in-memory database does not know «${op}»`);
          }
        })
      );
    })
  );
}
const matches = (row: Row, where: Row): boolean => tri(row, where) === true;
const sorted = (rows: Row[], orderBy?: Row | Row[]) => {
  const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).flatMap((o) => Object.entries(o));
  return [...rows].sort((a, b) => {
    for (const [k, dir] of keys) {
      const av = a[k]?.getTime?.() ?? a[k] ?? Infinity;
      const bv = b[k]?.getTime?.() ?? b[k] ?? Infinity;
      if (av !== bv) return (av < bv ? -1 : 1) * (dir === 'desc' ? -1 : 1);
    }
    return 0;
  });
};

vi.mock('./db', () => {
  const order = {
    findMany: vi.fn(async ({ where, orderBy, take }: Row) => {
      const found = sorted(world.orders.filter((r) => matches(r, where ?? {})), orderBy);
      return (take ? found.slice(0, take) : found).map((r) => ({ ...r }));
    }),
    findFirst: vi.fn(async ({ where, orderBy }: Row) => {
      const hit = sorted(world.orders.filter((r) => matches(r, where ?? {})), orderBy)[0];
      return hit ? { ...hit } : null;
    }),
    count: vi.fn(async ({ where }: Row) => world.orders.filter((r) => matches(r, where ?? {})).length),
    updateMany: vi.fn(async ({ where, data }: Row) => {
      const hit = world.orders.filter((r) => matches(r, where));
      for (const r of hit) {
        for (const [k, v] of Object.entries(data)) r[k] = (v as Row)?.increment !== undefined ? (r[k] ?? 0) + (v as Row).increment : v;
      }
      return { count: hit.length };
    }),
  };
  const db = {
    order,
    orderClaimHistory: {
      create: vi.fn(async ({ data }: Row) => {
        const line = { createdAt: world.clock, ...data };
        world.history.push(line);
        world.orders.find((r) => r.id === data.orderId)?.claimHistory.push(line);
      }),
      findMany: vi.fn(async () => []),
    },
    notification: { createMany: vi.fn(async ({ data }: Row) => void world.notices.push(...(data as Row[]))) },
    orderStatusLog: { create: vi.fn(async () => undefined) },
    orderActivity: { create: vi.fn(async () => undefined) },
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return { db, default: db };
});
vi.mock('./no-answer-rounds-switch', () => ({ roundsSwitch: async () => sw.value }));
vi.mock('./no-answer-returns-switch', () => ({ returnsSwitch: async () => rsw.value }));

import {
  PULL_ROUNDS_RELEASE_LIMIT,
  ROUNDS_RELEASE_LIMIT,
  idleHeldWhere,
  pickNextCandidate,
  pullNextOrder,
  releaseIdleReturns,
  releaseNoAnswerRounds,
  releaseStaleClaims,
  readReturnsMode,
} from './confirmation-queue';
import { IDLE_RETURNED_REASON } from './no-answer-returns';
import { zonedTimeToInstant } from './business-calendar';
import { db } from './db';

const JO = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' };
const t = (day: number, h: number, m = 0) => zonedTimeToInstant(JO.timezone, 2026, 11, day, h, m);
/** Monday 2 November 2026, noon: the idle cut is 11:30. */
const NOW = t(2, 12);
const scope = { companyId: 'c1', storeId: 's1' };
const ON = { enabled: true, enabledAt: t(1, 8) };
const OFF = { enabled: false, enabledAt: null };
const minutesAgo = (m: number, from = NOW) => new Date(from.getTime() - m * 60_000);

let seq = 0;
/** An order in somebody’s hand: claimed `claimedMinutesAgo` ago by `by`, with `attempts` logged on it (none = never rung). */
const held = (claimedMinutesAgo: number, attempts: Row[] = [], over: Row = {}): Row => {
  seq += 1;
  const r: Row = {
    id: `o${String(seq).padStart(4, '0')}`, orderNumber: `ORD-${seq}`, ...scope, customerId: `cust${seq}`,
    confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS', shippingStatus: 'NOT_READY', shippingBatchId: null, trackingNumber: null, labelPrintedAt: null,
    claimedById: 'sara', claimedAt: minutesAgo(claimedMinutesAgo), currentOwnerId: 'sara', signatureStatus: 'SIGNED',
    assignedToId: null, assignedAt: null, assignee: null, replacesOrderId: null, postponedUntil: null, nextFollowUpAt: null,
    createdAt: new Date(t(1, 9).getTime() + seq * 1000), version: 3, contactAttempts: attempts, claimHistory: [{ action: 'CLAIMED' }],
    ...over,
  };
  world.orders.push(r);
  return r;
};
const att = (createdAt: Date, result: string, employeeId = 'sara'): Row => ({ createdAt, result, employeeId, attemptNumber: 1 });
const run = (now = NOW, opts: Row = {}) => releaseNoAnswerRounds(db as never, scope, JO, now, { rounds: sw.value, ...opts });

beforeEach(() => {
  world.orders = [];
  world.history = [];
  world.notices = [];
  world.clock = NOW;
  sw.value = ON;
  rsw.value = ON;
  vi.clearAllMocks();
});

describe('1 · thirty working minutes with nothing logged: the order goes back', () => {
  it('releases with the other releases’ write, a line that says nobody pressed, and ONE notice to her', async () => {
    const o = held(31, [], { confirmationStatus: 'NEW', status: 'NEW', version: 9 });
    expect(await run()).toBe(1);
    expect(o).toMatchObject({ claimedById: null, claimedAt: null, currentOwnerId: null, signatureStatus: 'UNSIGNED', assignedAt: null });
    // Status, dates and version are not its business.
    expect(o).toMatchObject({ confirmationStatus: 'NEW', version: 9 });
    expect(world.history).toEqual([
      { createdAt: NOW, companyId: 'c1', orderId: o.id, userId: 'sara', action: 'RELEASED', reason: IDLE_RETURNED_REASON, metadata: JSON.stringify({ automatic: true, holder: 'sara' }) },
    ]);
    expect(world.notices).toEqual([
      {
        companyId: 'c1', storeId: 's1', userId: 'sara', title: `رجع ${o.orderNumber} للطابور`, type: 'SYSTEM_ALERT', link: '/confirmation/mine',
        message: `رجع ${o.orderNumber} للطابور: ما انسجّلت عليه أي محاولة خلال 30 دقيقة عمل`,
      },
    ]);
  });

  it('and a never-rung order is a NEW order to the pull again — the oldest new order first, as before', async () => {
    const o = held(31, [], { createdAt: t(1, 9) });
    await run();
    expect(await pickNextCandidate(db as never, scope, NOW, 'noor', { returns: await readReturnsMode(db as never, 'c1', { now: NOW, calendar: () => JO, rounds: ON }) })).toBe(o.id);
  });

  it('29 working minutes is not idle; 30 is — to the minute', async () => {
    const early = held(29);
    const exact = held(30);
    expect(await run()).toBe(1);
    expect(early.claimedById).toBe('sara');
    expect(exact.claimedById).toBeNull();
  });

  it('an order with attempts, none of them in the last thirty minutes, is idle too — a call she made at ten is not “activity” at noon', async () => {
    const o = held(120, [att(minutesAgo(90), 'OPENED'), att(minutesAgo(80), 'ANSWERED')]);
    expect(await run()).toBe(1);
    expect(o.claimedById).toBeNull();
    // …and the attempts are what they were: nothing is deleted, nothing is written to them.
    expect(o.contactAttempts).toHaveLength(2);
  });

  it('the customer’s other orders held for her go back with it — one customer, one agent', async () => {
    const o = held(31, [], { customerId: 'X' });
    const twin = { ...held(0, [], { customerId: 'X', claimedById: null, claimedAt: null, currentOwnerId: null, confirmationStatus: 'NEW', assignedToId: 'sara', assignedAt: minutesAgo(25), assignee: { id: 'sara', name: 'سارة', status: 'ACTIVE' }, claimHistory: [] }) };
    const other = held(0, [], { customerId: 'Y', claimedById: null, claimedAt: null, currentOwnerId: null, confirmationStatus: 'NEW', assignedToId: 'sara', assignedAt: minutesAgo(25), claimHistory: [] });
    await run();
    expect(o.claimedById).toBeNull();
    expect(world.orders.find((r) => r.id === twin.id)).toMatchObject({ assignedToId: null, assignedAt: null });
    // Another customer’s order named for her stays named for her.
    expect(other.assignedToId).toBe('sara');
  });
});

describe('2 · any attempt is activity', () => {
  it.each(['OPENED', 'MESSAGE_SENT', 'NO_ANSWER', 'ANSWERED', 'BUSY', 'WRONG_NUMBER'])('a %s ten minutes ago keeps it in her hand', async (result) => {
    const o = held(120, [att(minutesAgo(10), result)]);
    expect(await run()).toBe(0);
    expect(o.claimedById).toBe('sara');
  });

  it('by anybody: a colleague’s or a supervisor’s attempt on the order resets it too', async () => {
    const o = held(120, [att(minutesAgo(10), 'OPENED', 'the-boss')]);
    expect(await run()).toBe(0);
    expect(o.claimedById).toBe('sara');
  });

  it('an attempt exactly at the cut is old enough (nothing newer): it goes back; one millisecond newer keeps it', async () => {
    const atCut = held(120, [att(t(2, 11, 30), 'OPENED')]);
    const afterCut = held(120, [att(new Date(t(2, 11, 30).getTime() + 1), 'OPENED')]);
    await run();
    expect(atCut.claimedById).toBeNull();
    expect(afterCut.claimedById).toBe('sara');
  });
});

describe('3 · working minutes: an evening and a Friday add none', () => {
  it('taken Sunday 16:50 and looked at Monday 09:20: ten minutes of Sunday and twenty of Monday — thirty, idle; at 09:19 not yet', async () => {
    const o = held(0, [], { claimedAt: t(1, 16, 50) });
    expect(await run(t(2, 9, 19))).toBe(0);
    expect(o.claimedById).toBe('sara');
    expect(await run(t(2, 9, 20))).toBe(1);
  });

  it('taken Thursday 16:40 and looked at on Sunday 09:05: twenty-five working minutes over the weekend — not idle; at 09:10 it is', async () => {
    const o = held(0, [], { claimedAt: t(5, 16, 40) });
    expect(await run(t(8, 9, 5))).toBe(0);
    expect(await run(t(8, 9, 10))).toBe(1);
    expect(o.claimedById).toBeNull();
  });

  it('a calendar with no working day: nothing is ever idle, and no date before 1970 reaches the database', async () => {
    const o = held(100000, []);
    const dead = { ...JO, weekendDays: [0, 1, 2, 3, 4, 5, 6] };
    expect(await releaseNoAnswerRounds(db as never, scope, dead, NOW, { rounds: ON })).toBe(0);
    expect(o.claimedById).toBe('sara');
    const model = (db as unknown as { order: Record<string, { mock: { calls: unknown[] } }> }).order;
    expect(JSON.stringify(['findFirst', 'findMany', 'count', 'updateMany'].map((m) => model[m].mock.calls))).not.toContain('-271821');
  });
});

describe('4 · never an order that is decided or on its way', () => {
  it.each([
    ['confirmed', { confirmationStatus: 'CONFIRMED', status: 'CONFIRMED' }],
    ['cancelled', { confirmationStatus: 'CANCELLED', status: 'CANCELLED' }],
    ['rejected', { confirmationStatus: 'REJECTED', status: 'REJECTED' }],
    ['on a trolley', { shippingBatchId: 'b1' }],
    ['with a tracking number', { trackingNumber: 'T-1' }],
    ['with its label printed', { labelPrintedAt: t(2, 10) }],
    ['packing', { shippingStatus: 'PACKING' }],
  ])('NEGATIVE: %s — left alone, not read, not written, not told', async (_why, over) => {
    const o = held(300, [], over);
    expect(await run()).toBe(0);
    expect(o.claimedById).toBe('sara');
    expect(world.history).toHaveLength(0);
    expect(world.notices).toHaveLength(0);
  });
});

describe('5 · bounded: 200 a pass in the job, 25 inside a pull — the oldest first', () => {
  const pile = (n: number) => Array.from({ length: n }, (_, i) => held(31 + i, [], { claimedById: `agent-${i}` }));

  it('the job’s pass lets go of 200 of 230, and the next pass of the other 30', async () => {
    pile(230);
    expect(ROUNDS_RELEASE_LIMIT).toBe(200);
    expect(await run()).toBe(200);
    expect(world.orders.filter((o) => o.claimedById !== null)).toHaveLength(30);
    expect(await run()).toBe(30);
    expect(world.notices).toHaveLength(230);
  });

  it('the oldest claims go first', async () => {
    const rows = pile(5); // claimed 31, 32, 33, 34, 35 minutes ago — the last is the oldest
    expect(await run(NOW, { roundsLimit: 2 })).toBe(2);
    expect(rows[4].claimedById).toBeNull();
    expect(rows[3].claimedById).toBeNull();
    expect(rows[2].claimedById).not.toBeNull();
  });

  it('inside a pull: 25, and the pull says how many went (she still holds the rest, so the hand limit speaks)', async () => {
    expect(PULL_ROUNDS_RELEASE_LIMIT).toBe(25);
    for (let i = 0; i < 40; i++) held(31 + (i % 20), [att(minutesAgo(2), 'OPENED')], { claimedAt: minutesAgo(31 + (i % 20)) });
    // 40 orders with a call two minutes ago are not idle: none goes. The pile that IS idle is the one with nothing logged:
    world.orders = [];
    for (let i = 0; i < 40; i++) held(31 + (i % 20), []);
    const out = await pullNextOrder(scope, { id: 'sara', role: 'CONFIRMATION_AGENT' }, JO, NOW);
    expect(out.released).toBe(25);
    expect(world.orders.filter((o) => o.claimedById === 'sara')).toHaveLength(15);
    expect(out.refusal?.code).toBe('CAP_TOTAL');
  });
});

describe('6 · it runs where every release runs — and only with the mode on', () => {
  it('each pull runs it first: five idle orders in her hand are back in the queue before the hand is counted, and she pulls', async () => {
    for (let i = 0; i < 5; i++) held(40 + i, [att(minutesAgo(35), 'OPENED')]);
    const fresh = held(0, [], { claimedById: null, claimedAt: null, currentOwnerId: null, confirmationStatus: 'NEW', status: 'NEW', createdAt: t(1, 9), claimHistory: [] });
    const out = await pullNextOrder(scope, { id: 'sara', role: 'CONFIRMATION_AGENT' }, JO, NOW);
    expect(out.released).toBe(5);
    expect(out.ok).toBe(true);
    // The oldest NEW order first: the fresh one, not one of the five she just let go (they were rung).
    expect(out.orderId).toBe(fresh.id);
  });

  it('releaseStaleClaims (what the pull runs) returns the idle ones in its count', async () => {
    held(40, []);
    expect(await releaseStaleClaims(db as never, scope, JO, NOW, { rounds: ON })).toBe(1);
  });

  it('the mode OFF: not one query for the idle release is asked (the rounds release asks its one), and the order stays', async () => {
    rsw.value = OFF;
    const o = held(300, []);
    await run();
    expect(db.order.findMany).toHaveBeenCalledTimes(1);
    expect(o.claimedById).toBe('sara');
  });

  it('the mode ON: the same pass asks for it as a second query', async () => {
    held(300, []);
    await run();
    expect(db.order.findMany).toHaveBeenCalledTimes(2);
  });

  it('the rounds OFF: the mode is off whatever it holds — nothing is released and nothing is asked', async () => {
    sw.value = OFF;
    const o = held(300, []);
    expect(await releaseNoAnswerRounds(db as never, scope, JO, NOW, { rounds: OFF })).toBe(0);
    expect(o.claimedById).toBe('sara');
    expect(db.order.findMany).not.toHaveBeenCalled();
  });

  it('the filter is the whole rule, so every order it returns qualifies (no row is read and thrown away)', async () => {
    const ok = held(60, []);
    held(10, []);
    held(120, [att(minutesAgo(5), 'OPENED')]);
    const mode = (await readReturnsMode(db as never, 'c1', { now: NOW, calendar: () => JO, rounds: ON }))!;
    const rows = await db.order.findMany({ where: idleHeldWhere(scope, mode) } as never);
    expect((rows as unknown as Row[]).map((r) => r.id)).toEqual([ok.id]);
  });
});

describe('7 · a press that wins the race wins', () => {
  it('the write misses (she logged a call, or somebody took the order, after the read): nothing is released, no line, no notice', async () => {
    const o = held(60, []);
    (db as unknown as { order: { updateMany: { mockImplementationOnce: (f: () => Promise<{ count: number }>) => void } } }).order.updateMany.mockImplementationOnce(async () => ({ count: 0 }));
    const mode = (await readReturnsMode(db as never, 'c1', { now: NOW, calendar: () => JO, rounds: ON }))!;
    expect(await releaseIdleReturns(db as never, scope, mode)).toBe(0);
    expect(o.claimedById).toBe('sara');
    expect(world.history).toHaveLength(0);
    expect(world.notices).toHaveLength(0);
  });

  it('the write is guarded on the very claim that was read: a claim made again since is not released', async () => {
    const o = held(60, []);
    const mode = (await readReturnsMode(db as never, 'c1', { now: NOW, calendar: () => JO, rounds: ON }))!;
    const spy = (db as unknown as { order: { updateMany: { mock: { calls: Row[][] } } } }).order.updateMany;
    await releaseIdleReturns(db as never, scope, mode);
    const guard = spy.mock.calls[0][0].where;
    expect(guard).toMatchObject({
      id: o.id, claimedById: 'sara', claimedAt: expect.any(Date), shippingStatus: 'NOT_READY', shippingBatchId: null, trackingNumber: null, labelPrintedAt: null,
      // …and `nothing logged since the cut` is asked AGAIN at the write, not only at the read.
      contactAttempts: { none: { createdAt: { gt: mode.idleCut } } },
    });
  });

  it('a press of «اتصل» that lands between the read and the write keeps the order in her hand — and tells nobody it went', async () => {
    const o = held(60, []);
    const mode = (await readReturnsMode(db as never, 'c1', { now: NOW, calendar: () => JO, rounds: ON }))!;
    // The gap: she dialled after the read. The database evaluates the write’s own filter, as it would.
    (db as unknown as { order: { updateMany: { mockImplementationOnce: (f: (q: Row) => Promise<{ count: number }>) => void } } }).order.updateMany.mockImplementationOnce(
      async ({ where, data }: Row) => {
        o.contactAttempts.push(att(NOW, 'OPENED'));
        const hit = world.orders.filter((r) => matches(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      }
    );
    expect(await releaseIdleReturns(db as never, scope, mode)).toBe(0);
    expect(o.claimedById).toBe('sara');
    expect(world.history).toHaveLength(0);
    expect(world.notices).toHaveLength(0);
  });
});
