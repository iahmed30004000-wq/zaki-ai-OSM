import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — a decided order never comes back to the confirmation queue
 *
 * ORD-2026-1166, from its own event log (1/11): rejected as a duplicate at 12:18 (NEW → REJECTED), pulled from the queue at
 * 13:50 (— → IN_PROGRESS) and confirmed at 13:53, cancelled before the shipment at 15:54 (the claim cleared), pulled again at
 * 15:56 and postponed, and pulled again the next day. `readyToPullWhere` spread `claimableWhere` (open statuses only) and then
 * wrote `confirmationStatus: { not: 'POSTPONED' }` after it — the later key replaced the open list, so every unclaimed
 * NOT_READY order that was not postponed was in the pool, the oldest first.
 *
 *  1. An unclaimed, not-shipping order that is REJECTED, CANCELLED or CONFIRMED is never picked, never pulled and never counted —
 *     for an agent, for the supervisor's whole pool, and in the «held for a colleague» number.
 *  2. NEW, a released IN_PROGRESS, NO_ANSWER and FOLLOW_UP_REQUIRED still are; a due POSTPONED still comes first, and a far one
 *     is still counted apart.
 *  3. The pull's write asks «still open, still not shipping» again: an order decided between the pick and the write is not
 *     turned back into IN_PROGRESS.
 *  4. Holds for a returning customer are unchanged; the stale-claim release never touches a decided order.
 *
 * Driven against an in-memory database that APPLIES the filters (with SQL's three values), so the answer comes from the filter's
 * own text and not from a mock that was told it.
 *
 * Blockers: no money, no permission, no order creation, no migration.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Row = Record<string, any>;

const { world } = vi.hoisted(() => ({
  world: { orders: [] as Row[], users: new Map<string, Row>(), history: [] as Row[], logs: [] as Row[] },
}));

/** The operators the queue's filters use — and nothing else, so a filter that starts using a new one fails here by name. */
type Tri = true | false | null;
const and = (xs: Tri[]): Tri => (xs.includes(false) ? false : xs.includes(null) ? null : true);
const or = (xs: Tri[]): Tri => (xs.includes(true) ? true : xs.includes(null) ? null : false);
const not = (x: Tri): Tri => (x === null ? null : !x);
function tri(row: Row, where: Row): Tri {
  return and(
    Object.entries(where).map(([key, cond]): Tri => {
      if (key === 'AND') return and((cond as Row[]).map((w) => tri(row, w)));
      if (key === 'OR') return or((cond as Row[]).map((w) => tri(row, w)));
      if (key === 'NOT') return not(or((Array.isArray(cond) ? cond : [cond]).map((w) => tri(row, w as Row))));
      const value = row[key] ?? null;
      if (cond === null) return value === null;
      if (cond instanceof Date) return value === null ? null : value instanceof Date && value.getTime() === cond.getTime();
      if (typeof cond !== 'object') return value === null ? null : value === cond;
      return and(
        Object.entries(cond as Row).map(([op, arg]): Tri => {
          switch (op) {
            case 'not':
              if (arg === null) return value !== null;
              return value === null ? null : value !== arg;
            case 'in': return value === null ? null : (arg as unknown[]).includes(value);
            case 'notIn': return value === null ? null : !(arg as unknown[]).includes(value);
            case 'gt': return value === null ? null : (value as Date).getTime() > (arg as Date).getTime();
            case 'gte': return value === null ? null : (value as Date).getTime() >= (arg as Date).getTime();
            case 'lte': return value === null ? null : (value as Date).getTime() <= (arg as Date).getTime();
            case 'is':
              if (arg === null) return value === null;
              return value === null ? null : tri(value as Row, arg as Row);
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
      return take ? found.slice(0, take) : found;
    }),
    findFirst: vi.fn(async ({ where, orderBy }: Row) => sorted(world.orders.filter((r) => matches(r, where ?? {})), orderBy)[0] ?? null),
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
    // `findMany`: the pull's pace reads her pulls of the last hour (`pullPaceRefusal`); this world has none, the pace has its own test.
    orderClaimHistory: { create: vi.fn(async ({ data }: Row) => void world.history.push(data)), findMany: vi.fn(async () => []) },
    notification: { createMany: vi.fn(async () => ({ count: 1 })) },
    orderStatusLog: { create: vi.fn(async ({ data }: Row) => void world.logs.push(data)) },
    // The pull's per-customer lock and the hold of his other orders (`twins-follow-the-pull.ts`): one agent at a time here.
    orderActivity: { create: vi.fn(async () => undefined) },
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return { db, default: db };
});

import {
  OPEN_CONFIRMATION,
  READY_CONFIRMATION,
  pickNextCandidate,
  postponedNotDueCount,
  pullNextOrder,
  releaseStaleClaims,
  reservedForColleaguesCount,
  waitingCount,
} from './confirmation-queue';
import { db } from './db';

const NOW = new Date('2026-11-01T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const hoursAhead = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
const scope = { companyId: 'c1', storeId: 's1' };
const CAL = { workHoursStart: '00:00', workHoursEnd: '23:59', weekendDays: [] as number[], timezone: 'UTC' };
const AGENT = { id: 'rawda', role: 'CONFIRMATION_AGENT' };

const DECIDED = ['REJECTED', 'CANCELLED', 'CONFIRMED'] as const;
const WAITING = ['NEW', 'IN_PROGRESS', 'NO_ANSWER', 'FOLLOW_UP_REQUIRED'] as const;

const user = (id: string, status = 'ACTIVE') => {
  const u = { id, name: id, status };
  world.users.set(id, u);
  return u;
};

let seq = 0;
/** An order nobody holds and nobody is shipping. */
const order = (over: Row = {}): Row => {
  seq += 1;
  const r: Row = {
    id: `o${seq}`, orderNumber: `ORD-${seq}`, ...scope, customerId: `cust${seq}`,
    confirmationStatus: 'NEW', status: 'NEW', shippingStatus: 'NOT_READY',
    claimedById: null, claimedAt: null, currentOwnerId: null,
    assignedToId: null, assignedAt: null, assignee: null,
    postponedUntil: null, nextFollowUpAt: null,
    createdAt: hoursAgo(2), version: 1, contactAttempts: [], claimHistory: [],
    ...over,
  };
  world.orders.push(r);
  return r;
};
const byId = (id: string) => world.orders.find((r) => r.id === id)!;

const counters = async (forUserId?: string) => ({
  waiting: await waitingCount(db as never, scope, NOW, forUserId),
  colleagues: forUserId ? await reservedForColleaguesCount(db as never, scope, forUserId, NOW) : 0,
  later: await postponedNotDueCount(db as never, scope, NOW),
});

beforeEach(() => {
  world.orders = [];
  world.users.clear();
  world.history = [];
  world.logs = [];
  seq = 0;
  vi.clearAllMocks();
  for (const id of ['abeer', 'rawda', 'salwa']) user(id);
});

describe('ORD-2026-1166 — a rejected order is not pulled again', () => {
  it('rejected as a duplicate, unclaimed and older than a fresh order: the pull takes the fresh one, the rejected one is untouched', async () => {
    // Rejected at 12:18 from NEW by an agent who never held it; created long before the order that arrived since.
    const rejected = order({ confirmationStatus: 'REJECTED', status: 'REJECTED', createdAt: hoursAgo(30) });
    const fresh = order({ createdAt: hoursAgo(1) });

    const pulled = await pullNextOrder(scope, AGENT, CAL, NOW);

    expect(pulled).toMatchObject({ ok: true, orderId: fresh.id });
    expect(byId(rejected.id)).toMatchObject({ confirmationStatus: 'REJECTED', claimedById: null, version: 1 });
    expect(byId(fresh.id)).toMatchObject({ confirmationStatus: 'IN_PROGRESS', claimedById: 'rawda' });
  });

  it('with nothing else in the queue: «لا توجد طلبات», nothing claimed, no history, no status log', async () => {
    const rejected = order({ confirmationStatus: 'REJECTED', status: 'REJECTED', createdAt: hoursAgo(30) });
    // And the same order once it had been confirmed and cancelled before the shipment (the claim cleared by the stand-down).
    const cancelled = order({ confirmationStatus: 'CANCELLED', status: 'CANCELLED', createdAt: hoursAgo(29) });

    const pulled = await pullNextOrder(scope, AGENT, CAL, NOW);

    expect(pulled.ok).toBe(false);
    expect(pulled.refusal?.code).toBe('QUEUE_EMPTY');
    expect(byId(rejected.id)).toMatchObject({ confirmationStatus: 'REJECTED', claimedById: null });
    expect(byId(cancelled.id)).toMatchObject({ confirmationStatus: 'CANCELLED', claimedById: null });
    expect(world.history).toHaveLength(0);
    expect(world.logs).toHaveLength(0);
    expect(await counters('rawda')).toEqual({ waiting: 0, colleagues: 0, later: 0 });
  });
});

describe('a decided order is in no pool', () => {
  it.each(DECIDED)('%s, unclaimed and not shipping: never picked, for an agent or for the whole pool', async (status) => {
    order({ confirmationStatus: status, status, createdAt: hoursAgo(40) });
    expect(await pickNextCandidate(db as never, scope, NOW, 'rawda')).toBeNull();
    expect(await pickNextCandidate(db as never, scope, NOW)).toBeNull();
  });

  it.each(DECIDED)('%s: never counted — not «بانتظارك», not the supervisor\'s pool, not «held for a colleague»', async (status) => {
    // Named for a colleague within the hold window too, so the «held for a colleague» count would see it if it were open.
    order({ confirmationStatus: status, status, assignedToId: 'abeer', assignedAt: hoursAgo(1), assignee: world.users.get('abeer') });
    expect(await counters('rawda')).toEqual({ waiting: 0, colleagues: 0, later: 0 });
    expect(await waitingCount(db as never, scope, NOW)).toBe(0);
  });

  it.each(DECIDED)('%s with a postponement date in the window is still not «due»', async (status) => {
    order({ confirmationStatus: status, status, postponedUntil: hoursAhead(1), nextFollowUpAt: hoursAhead(1) });
    expect(await pickNextCandidate(db as never, scope, NOW, 'rawda')).toBeNull();
    expect(await waitingCount(db as never, scope, NOW, 'rawda')).toBe(0);
  });

  it.each(DECIDED)('%s is never pulled: the agent is told the queue is empty and the order is left as it was', async (status) => {
    const decided = order({ confirmationStatus: status, status, createdAt: hoursAgo(40) });
    const pulled = await pullNextOrder(scope, AGENT, CAL, NOW);
    expect(pulled.refusal?.code).toBe('QUEUE_EMPTY');
    expect(byId(decided.id)).toMatchObject({ confirmationStatus: status, claimedById: null, version: 1 });
  });
});

describe('what is still waiting is still handed out', () => {
  it.each(WAITING)('%s, unclaimed: picked, pulled and counted', async (status) => {
    // IN_PROGRESS with nobody holding it is a released claim that kept its status.
    const waiting = order({ confirmationStatus: status, status });
    order({ confirmationStatus: 'REJECTED', status: 'REJECTED', createdAt: hoursAgo(50) });

    expect(await counters('rawda')).toEqual({ waiting: 1, colleagues: 0, later: 0 });
    expect(await waitingCount(db as never, scope, NOW)).toBe(1);
    expect(await pickNextCandidate(db as never, scope, NOW, 'rawda')).toBe(waiting.id);

    const pulled = await pullNextOrder(scope, AGENT, CAL, NOW);
    expect(pulled).toMatchObject({ ok: true, orderId: waiting.id });
    expect(byId(waiting.id)).toMatchObject({ confirmationStatus: 'IN_PROGRESS', claimedById: 'rawda' });
  });

  it('a due postponement still comes before an older waiting order that was RUNG; a far one is counted apart and not handed out', async () => {
    // Rung once, nobody answered, let go: it has an attempt, so it is not a «new» order (the owner, 7/11: new ones come first).
    const older = order({ createdAt: hoursAgo(20), contactAttempts: [{ createdAt: hoursAgo(12), result: 'NO_ANSWER' }] });
    const due = order({ confirmationStatus: 'POSTPONED', status: 'POSTPONED', postponedUntil: hoursAhead(3), createdAt: hoursAgo(1) });
    order({ confirmationStatus: 'POSTPONED', status: 'POSTPONED', postponedUntil: hoursAhead(24 * 10), createdAt: hoursAgo(60) });

    expect(await counters('rawda')).toEqual({ waiting: 2, colleagues: 0, later: 1 });
    expect(await pickNextCandidate(db as never, scope, NOW, 'rawda')).toBe(due.id);

    byId(due.id).claimedById = 'salwa';
    expect(await pickNextCandidate(db as never, scope, NOW, 'rawda')).toBe(older.id);
  });

  it('but a NEW order — one nobody has rung — comes before a due postponement, the younger one too (7/11)', async () => {
    const due = order({ confirmationStatus: 'POSTPONED', status: 'POSTPONED', postponedUntil: hoursAhead(3), createdAt: hoursAgo(40) });
    const fresh = order({ createdAt: hoursAgo(1) });

    // The counter is unchanged: both are in the pile she can take, whichever order they come in.
    expect(await counters('rawda')).toEqual({ waiting: 2, colleagues: 0, later: 0 });
    expect(await pickNextCandidate(db as never, scope, NOW, 'rawda')).toBe(fresh.id);

    byId(fresh.id).claimedById = 'salwa';
    expect(await pickNextCandidate(db as never, scope, NOW, 'rawda')).toBe(due.id);
  });

  it('a pool of nothing but far postponements: none handed out, all of them counted apart', async () => {
    order({ confirmationStatus: 'POSTPONED', status: 'POSTPONED', postponedUntil: hoursAhead(24 * 10) });
    expect(await pickNextCandidate(db as never, scope, NOW, 'rawda')).toBeNull();
    expect(await counters('rawda')).toEqual({ waiting: 0, colleagues: 0, later: 1 });
  });

  it('the takeable list is the open list without POSTPONED — derived, never a second copy', () => {
    expect(READY_CONFIRMATION).toEqual(OPEN_CONFIRMATION.filter((s) => s !== 'POSTPONED'));
    for (const s of DECIDED) expect(READY_CONFIRMATION).not.toContain(s);
    expect(READY_CONFIRMATION).not.toContain('POSTPONED');
  });
});

describe('the pull\'s write asks again', () => {
  const decideBeforeTheWrite = (id: string, patch: Row) => {
    const updateMany = db.order.updateMany as unknown as ReturnType<typeof vi.fn>;
    const real = updateMany.getMockImplementation()! as (args: Row) => Promise<unknown>;
    updateMany.mockImplementationOnce(async (args: Row) => {
      Object.assign(byId(id), patch); // decided by somebody else between the pick and this write
      return real(args);
    });
  };

  it.each(DECIDED)('an order turned %s between the pick and the write is not made IN_PROGRESS', async (status) => {
    const o = order();
    decideBeforeTheWrite(o.id, { confirmationStatus: status, status });

    const pulled = await pullNextOrder(scope, AGENT, CAL, NOW);

    expect(pulled.ok).toBe(false);
    expect(byId(o.id)).toMatchObject({ confirmationStatus: status, claimedById: null });
    expect(world.history).toHaveLength(0);
  });

  it('an order sent to packing between the pick and the write is not claimed either', async () => {
    const o = order();
    decideBeforeTheWrite(o.id, { shippingStatus: 'PACKING' });

    const pulled = await pullNextOrder(scope, AGENT, CAL, NOW);

    expect(pulled.ok).toBe(false);
    expect(byId(o.id)).toMatchObject({ confirmationStatus: 'NEW', claimedById: null, shippingStatus: 'PACKING' });
  });

  it('a due postponement is still taken by the write (POSTPONED is open)', async () => {
    const due = order({ confirmationStatus: 'POSTPONED', status: 'POSTPONED', postponedUntil: hoursAhead(1) });
    const pulled = await pullNextOrder(scope, AGENT, CAL, NOW);
    expect(pulled).toMatchObject({ ok: true, orderId: due.id });
    expect(byId(due.id)).toMatchObject({ confirmationStatus: 'IN_PROGRESS', claimedById: 'rawda' });
  });
});

describe('holds and releases are unchanged', () => {
  it('her held order still comes first for her and is still not a colleague\'s', async () => {
    order({ createdAt: hoursAgo(10) });
    const hers = order({ assignedToId: 'abeer', assignedAt: hoursAgo(1), assignee: world.users.get('abeer'), createdAt: hoursAgo(1) });

    expect(await pickNextCandidate(db as never, scope, NOW, 'abeer')).toBe(hers.id);
    expect(await pickNextCandidate(db as never, scope, NOW, 'rawda')).not.toBe(hers.id);
    expect(await reservedForColleaguesCount(db as never, scope, 'rawda', NOW)).toBe(1);
  });

  it('a decided order named for her is not «hers» to pull', async () => {
    order({ confirmationStatus: 'REJECTED', status: 'REJECTED', assignedToId: 'abeer', assignedAt: hoursAgo(1), assignee: world.users.get('abeer') });
    expect(await pickNextCandidate(db as never, scope, NOW, 'abeer')).toBeNull();
  });

  it('the stale-claim release lets go of an open order and never of a decided one it holds', async () => {
    const open = order({ claimedById: 'salwa', claimedAt: hoursAgo(5) });
    const decided = order({ confirmationStatus: 'REJECTED', status: 'REJECTED', claimedById: 'salwa', claimedAt: hoursAgo(5) });

    expect(await releaseStaleClaims(db as never, scope, CAL, NOW)).toBe(1);
    expect(byId(open.id).claimedById).toBeNull();
    expect(byId(decided.id)).toMatchObject({ claimedById: 'salwa', confirmationStatus: 'REJECTED' });
  });
});
