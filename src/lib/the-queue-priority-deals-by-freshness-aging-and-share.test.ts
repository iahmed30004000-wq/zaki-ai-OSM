import { beforeEach, describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const { world, sw, cp, d } = vi.hoisted(() => ({
  d: { on: false, lanes: [] as ('NEW' | 'BACKLOG')[] },
  world: { orders: [] as Row[], users: new Map<string, Row>(), history: [] as Row[], logs: [] as Row[] },
  sw: { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } },
  cp: { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } },
}));

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
  // A read hands back COPIES, as Prisma does. Like the neighbouring doubles it IGNORES `select`: a row comes back whole, nested lines unfiltered — so the rank
  // must re-apply the line predicate itself (`retryDueOf`), which on Prisma is a no-op.
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
    orderClaimHistory: { create: vi.fn(async ({ data }: Row) => void world.history.push(data)), findMany: vi.fn(async () => []) },
    notification: { createMany: vi.fn(async () => ({ count: 1 })) },
    orderStatusLog: { create: vi.fn(async ({ data }: Row) => void world.logs.push(data)) },
    orderActivity: { create: vi.fn(async () => undefined) },
    orderContactAttempt: { count: vi.fn(async ({ where }: Row) => (world.orders.find((r) => r.id === where.orderId)?.contactAttempts ?? []).length) },
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return { db, default: db };
});
// The switches the pull reads before its transaction — the test says what they are. The cadence is `callProofSwitch`'s `{ enabled, enabledAt }`.
vi.mock('./no-answer-rounds-switch', () => ({ roundsSwitch: async () => sw.value }));
vi.mock('./no-answer-returns-switch', () => ({ returnsSwitch: async () => ({ enabled: false, enabledAt: null }) }));
vi.mock('./call-proof-switch', () => ({ callProofSwitch: async () => cp.value, callProofOn: async () => cp.value.enabled }));
vi.mock('./queue-priority-switch', () => ({ queuePrioritySwitch: async () => ({ enabled: d.on, enabledAt: d.on ? new Date(0) : null }) }));
vi.mock('./queue-priority-share', () => ({
  readBacklogShare: async () => ({ result: { share: 0.37 }, inputs: {}, note: '' }),
  recentPullLanes: async () => d.lanes,
}));
vi.mock('./notification-audience', () => ({ resolveAudience: vi.fn(async () => []) }));

import {
  RETURNS_MODE,
  pickNextCandidate,
  pullNextOrder,
} from './confirmation-queue';
import { returnsMode } from './no-answer-returns';
import { workClock } from './no-answer-rounds';
import { db } from './db';

const NOW = new Date('2026-11-12T12:00:00.000Z');
/** The floor: the moment the owner turned the cadence on. */
const SINCE = new Date('2026-11-10T08:00:00.000Z');
const minutes = (m: number) => new Date(NOW.getTime() + m * 60_000);
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const scope = { companyId: 'c1', storeId: 's1' };
const CAL = { workHoursStart: '00:00', workHoursEnd: '23:59', weekendDays: [] as number[], timezone: 'UTC' };
const clock = workClock(CAL);
/** The mode with the cadence on, and the legacy mode (the rounds' three working hours) — both at the same moment. */
const CADENCE = returnsMode(NOW, clock, RETURNS_MODE.idleBusinessMinutes, SINCE);
const agent = (id: string) => ({ id, role: 'CONFIRMATION_AGENT' });

const user = (id: string, status = 'ACTIVE') => {
  const u = { id, name: id, status };
  world.users.set(id, u);
  return u;
};

let seq = 0;
/** An order nobody holds, nobody has rung, and nobody is shipping. */
const order = (over: Row = {}): Row => {
  seq += 1;
  const r: Row = {
    id: `o${String(seq).padStart(4, '0')}`, orderNumber: `ORD-${seq}`, ...scope, customerId: `cust${seq}`,
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
/** A line the door wrote: pressed `pressedMinutesAgo` ago, with its due `dueInMinutes` from NOW (negative = already past; null = no due, an early press or the fifth). */
const line = (pressedMinutesAgo: number, result: string, dueInMinutes: number | null, n = 1): Row => ({
  createdAt: new Date(NOW.getTime() - pressedMinutesAgo * 60_000),
  result,
  nextFollowUpAt: dueInMinutes === null ? null : minutes(dueInMinutes),
  employeeId: 'x',
  attemptNumber: n,
});
/** A returned order: rung, pressed «لا يرد», back in the pool with its due on the line (status stays IN_PROGRESS — `returnToThePool` keeps it). */
const retry = (dueInMinutes: number | null, over: Row = {}): Row =>
  order({
    confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS',
    contactAttempts: [line(1000, 'NO_ANSWER', dueInMinutes)],
    claimHistory: [{ action: 'CLAIMED' }, { action: 'RELEASED' }],
    ...over,
  });
/** A postponed promise whose date arrived. */
const promise = (over: Row = {}): Row =>
  order({
    confirmationStatus: 'POSTPONED', status: 'POSTPONED', postponedUntil: minutes(-10),
    contactAttempts: [{ createdAt: hoursAgo(60), result: 'POSTPONED', nextFollowUpAt: null, employeeId: 'x', attemptNumber: 1 }], ...over,
  });
const byId = (id: string) => world.orders.find((r) => r.id === id)!;

beforeEach(() => {
  world.orders = [];
  world.users.clear();
  world.history = [];
  world.logs = [];
  seq = 0;
  sw.value = { enabled: false, enabledAt: null };
  d.on = false;
  d.lanes = [];
  cp.value = { enabled: true, enabledAt: SINCE };
  vi.clearAllMocks();
  for (const id of ['sara', 'huda', 'noor', 'abeer']) user(id);
});


/**
 * ═════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — QUEUE PRIORITY v2 DEALS THE NEXT ORDER BY FRESHNESS, AGING AND SHARE (step D1)
 *
 *  1. The key off (no plan): the pull is the old one — a new order, however old, before an overdue retry. The plan is never asked for the old order.
 *  2. The key on, ordinary hours: the customer's promise · a FRESH new order (under 15 minutes) · a retry waiting MORE than 2 hours past its due · then the agent's lane.
 *  3. The lane: the backlog's turn takes the retry with the oldest due and falls back to a new order when none is due; every other turn takes the oldest new order and,
 *     when there is none, falls through to the old order (so the backlog still drains).
 *  4. The two time-of-day modes (09:00–11:00, 21:00–24:00) are the plain base order — new first, OLDEST first (no fresh-first, no aging, no share).
 *  5. The pull records the lane it dealt on the history line (`{ role, lane }`) only under the key; off, the line is `{ role }` as ever. Any failure reading the plan is «no plan».
 *  6. Nothing is written by the rule itself; the claim is the same compare-and-set. No money, no order creation, no migration, no contract, no customer data to a model.
 *
 * Driven against the same in-memory database that APPLIES its filters, as the neighbouring pull tests do.
 * ═════════════════════════════════════════════════════════════════
 */
import { priorityPlanFor } from './confirmation-queue';
import { wantsBacklog } from './queue-priority';
import type { PriorityPlan } from './confirmation-queue';

const plan = (over: Partial<PriorityPlan> = {}): PriorityPlan => ({ mode: 'NORMAL', backlogTurn: false, ...over });
const pickV2 = (p: PriorityPlan | null, who = 'sara') => pickNextCandidate(db as never, scope, NOW, who, { returns: CADENCE, priority: p });
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

describe('the key off: the old pull, query for query', () => {
  it('no plan: a new order — however old — before an overdue retry, as always', async () => {
    const overdue = retry(-600, { createdAt: hoursAgo(100) });
    const oldNew = order({ createdAt: hoursAgo(3) });
    expect(await pickV2(null)).toBe(oldNew.id);
    byId(oldNew.id).claimedById = 'huda';
    expect(await pickV2(null)).toBe(overdue.id);
  });

  it('the plan is read only when the key is on: off → null, and the three queries of the share are never asked', async () => {
    d.on = false;
    expect(await priorityPlanFor(db as never, scope, 'sara', CAL, NOW)).toBeNull();
    d.on = true;
    expect(await priorityPlanFor(db as never, scope, 'sara', CAL, NOW)).toEqual({ mode: 'NORMAL', backlogTurn: false });
    d.lanes = ['NEW', 'NEW'];
    expect(await priorityPlanFor(db as never, scope, 'sara', CAL, NOW)).toEqual({ mode: 'NORMAL', backlogTurn: true });
  });
});

describe('ordinary hours: fresh first, then an aged retry, then the lane', () => {
  it('a FRESH order (5 minutes) comes before an older new order and before an aged retry', async () => {
    const aged = retry(-300, { createdAt: hoursAgo(30) });
    const older = order({ createdAt: hoursAgo(3) });
    const fresh = order({ createdAt: minutesAgo(5) });
    expect(await pickV2(plan())).toBe(fresh.id);
    byId(fresh.id).claimedById = 'huda';
    expect(await pickV2(plan())).toBe(aged.id);
    byId(aged.id).claimedById = 'huda';
    expect(await pickV2(plan())).toBe(older.id);
  });

  it('exactly 15 minutes is no longer fresh; 14 minutes is', async () => {
    const aged = retry(-300, { createdAt: hoursAgo(30) });
    order({ createdAt: minutesAgo(15) });
    expect(await pickV2(plan())).toBe(aged.id);
    const fresh = order({ createdAt: minutesAgo(14) });
    expect(await pickV2(plan())).toBe(fresh.id);
  });

  it('AGING: a retry more than 2 hours past its due outranks an older new order; at exactly 2 hours it does not', async () => {
    const newer = order({ createdAt: hoursAgo(3) });
    const edge = retry(-120, { createdAt: hoursAgo(40) });
    expect(await pickV2(plan())).toBe(newer.id);
    byId(newer.id).claimedById = 'huda';
    // no new order left and not the backlog's turn: the rule has nothing for her, and the old order after it takes the retry — the backlog still drains
    expect(await pickV2(plan())).toBe(edge.id);

    const one = order({ createdAt: hoursAgo(3) });
    byId(edge.id).claimedById = 'huda';
    const past = retry(-121, { createdAt: hoursAgo(41) });
    expect(await pickV2(plan())).toBe(past.id);
    expect(one.id).toBeTruthy();
  });

  it('the BACKLOG\'s turn takes the retry with the oldest due; not its turn, the old new order', async () => {
    const newOrder = order({ createdAt: hoursAgo(3) });
    const soon = retry(-30, { createdAt: hoursAgo(50) });
    const longer = retry(-90, { createdAt: hoursAgo(10) });
    expect(await pickV2(plan({ backlogTurn: false }))).toBe(newOrder.id);
    expect(await pickV2(plan({ backlogTurn: true }))).toBe(longer.id);
    byId(longer.id).claimedById = 'huda';
    expect(await pickV2(plan({ backlogTurn: true }))).toBe(soon.id);
  });

  it('the backlog\'s turn with nothing due falls back to a new order; nothing at all is nothing', async () => {
    const newOrder = order({ createdAt: hoursAgo(3) });
    retry(+45, { createdAt: hoursAgo(50) }); // due in the future: not ready
    expect(await pickV2(plan({ backlogTurn: true }))).toBe(newOrder.id);
    byId(newOrder.id).claimedById = 'huda';
    expect(await pickV2(plan({ backlogTurn: true }))).toBeNull();
  });

  it('the customer\'s PROMISE comes before even a fresh order', async () => {
    order({ createdAt: minutesAgo(2) });
    const asked = promise({ createdAt: hoursAgo(80) });
    expect(await pickV2(plan())).toBe(asked.id);
  });
});

describe('the two time-of-day modes are the plain base order', () => {
  it.each(['NIGHT_FIRST', 'PEAK_NEW_FIRST'] as const)('%s: a new order first, the OLDEST first — no fresh-first, no aging, no share', async (mode) => {
    const aged = retry(-600, { createdAt: hoursAgo(60) });
    const oldest = order({ createdAt: hoursAgo(9) });
    const fresh = order({ createdAt: minutesAgo(3) });
    expect(await pickV2(plan({ mode, backlogTurn: true }))).toBe(oldest.id);
    byId(oldest.id).claimedById = 'huda';
    expect(await pickV2(plan({ mode }))).toBe(fresh.id);
    byId(fresh.id).claimedById = 'huda';
    expect(await pickV2(plan({ mode }))).toBe(aged.id);
  });

  it('the plan names the mode by the STORE\'s clock: 09:30 and 21:00 are modes, 11:00 and 12:00 are not', async () => {
    d.on = true;
    const at = (iso: string) => priorityPlanFor(db as never, scope, 'sara', CAL, new Date(iso));
    expect((await at('2026-11-12T09:30:00.000Z'))?.mode).toBe('NIGHT_FIRST');
    expect((await at('2026-11-12T10:59:00.000Z'))?.mode).toBe('NIGHT_FIRST');
    expect((await at('2026-11-12T11:00:00.000Z'))?.mode).toBe('NORMAL');
    expect((await at('2026-11-12T21:00:00.000Z'))?.mode).toBe('PEAK_NEW_FIRST');
    expect((await at('2026-11-12T23:59:00.000Z'))?.mode).toBe('PEAK_NEW_FIRST');
    expect((await at('2026-11-12T08:59:00.000Z'))?.mode).toBe('NORMAL');
    const damascus = { ...CAL, timezone: 'Asia/Damascus' };
    // Damascus is UTC+3 all year: 05:30 UTC is 08:30 there, not yet a mode; 06:30 UTC is 09:30.
    expect((await priorityPlanFor(db as never, scope, 'sara', damascus, new Date('2026-11-12T05:30:00.000Z')))?.mode).toBe('NORMAL');
    expect((await priorityPlanFor(db as never, scope, 'sara', damascus, new Date('2026-11-12T06:30:00.000Z')))?.mode).toBe('NIGHT_FIRST');
  });
});

describe('the pull records the lane it dealt, only under the key', () => {
  it('on: the history line says {role, lane}; the backlog\'s turn deals the retry and records BACKLOG; a new order records NEW', async () => {
    d.on = true;
    d.lanes = ['NEW', 'NEW']; // two new pulls so far: 1/3 ≤ 37% → the backlog's turn
    const newOrder = order({ createdAt: hoursAgo(3) });
    const due = retry(-90, { createdAt: hoursAgo(40) });

    const first = await pullNextOrder(scope, agent('sara'), CAL, NOW);
    expect(first.orderId).toBe(due.id);
    expect(JSON.parse(world.history.at(-1)!.metadata)).toEqual({ role: 'CONFIRMATION_AGENT', lane: 'BACKLOG' });

    d.lanes = ['BACKLOG', 'NEW', 'NEW'];
    const second = await pullNextOrder(scope, agent('huda'), CAL, NOW);
    expect(second.orderId).toBe(newOrder.id);
    expect(JSON.parse(world.history.at(-1)!.metadata)).toEqual({ role: 'CONFIRMATION_AGENT', lane: 'NEW' });
  });

  it('off: the line is {role} exactly as before — no lane, and the order is the old one', async () => {
    d.on = false;
    const newOrder = order({ createdAt: hoursAgo(3) });
    retry(-600, { createdAt: hoursAgo(40) });
    const out = await pullNextOrder(scope, agent('sara'), CAL, NOW);
    expect(out.orderId).toBe(newOrder.id);
    expect(JSON.parse(world.history.at(-1)!.metadata)).toEqual({ role: 'CONFIRMATION_AGENT' });
  });

  it('the pull keeps going when the share cannot be read: no plan, the old order', async () => {
    d.on = true;
    const shareModule = await import('./queue-priority-share');
    const spy = vi.spyOn(shareModule, 'recentPullLanes').mockRejectedValue(new Error('db down'));
    const newOrder = order({ createdAt: hoursAgo(3) });
    retry(-600, { createdAt: hoursAgo(40) });
    expect(await priorityPlanFor(db as never, scope, 'sara', CAL, NOW)).toBeNull();
    const out = await pullNextOrder(scope, agent('huda'), CAL, NOW);
    expect(out.orderId).toBe(newOrder.id);
    spy.mockRestore();
  });
});


describe('the planner\'s starvation gate (the spec, quality gates §6)', () => {
  it('300 new orders and 100 due backlog items: one agent\'s 30 pulls include at least 10 backlog items, and a backlog item 2 h past due beats a 20-minute-old new order', async () => {
    for (let i = 0; i < 300; i++) order({ createdAt: minutesAgo(20 + (i % 100)) }); // none is fresh (all older than 15 minutes)
    for (let i = 0; i < 100; i++) retry(-(10 + i), { createdAt: hoursAgo(30 + (i % 20)) }); // due 10 to 109 minutes ago: due, none of them aged
    const aged = retry(-(3 * 60), { createdAt: hoursAgo(50) }); // 3 hours past its due

    // the aged one first, though a 20-minute-old new order waits (and the lanes say it is the NEW turn)
    expect(await pickV2(plan({ backlogTurn: false }))).toBe(aged.id);
    byId(aged.id).claimedById = 'taken';

    const lanes: ('NEW' | 'BACKLOG')[] = []; // newest first, as `recentPullLanes` gives them
    let backlog = 0;
    for (let i = 0; i < 30; i++) {
      const id = await pickV2(plan({ backlogTurn: wantsBacklog(0.37, lanes) }));
      expect(id).not.toBeNull();
      const lane = byId(id!).contactAttempts.length > 0 ? 'BACKLOG' : 'NEW';
      if (lane === 'BACKLOG') backlog += 1;
      lanes.unshift(lane);
      byId(id!).claimedById = 'taken';
    }
    expect(backlog).toBeGreaterThanOrEqual(10);
    expect(backlog).toBeLessThanOrEqual(13);
  });
});
