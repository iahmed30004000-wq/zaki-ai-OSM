import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — ONE CUSTOMER, ONE AGENT, AT THE PULL (the owner, 2/11; PR-2 of the duplicate-orders pair)
 *
 * His words: «فرض الزبون غبي بعت طلبو 3 مرات، عندي 3 بنات تأكيد، كل طلب سحبتو بنت مختلفة، بنزلو 3 طلبات مؤكدة. زبون غبي تاني طلب من
 * ماسنجر ومن السايت كمان بنتين بسحبو. بدنا حل للكيس هاد». The confirm guard (#165) stops the second «نعم»; this stops the second
 * and third agent from ringing him at all.
 *
 *  1. When an agent pulls an order, the same customer's other orders that are waiting and nobody's (NEW, never claimed, no holder,
 *     no name, not shipping, not a win-back, same company and store) are HELD for her with the existing hold (`assignedToId` +
 *     `assignedAt`, 24 hours) and a history row each. Nothing decided, postponed, claimed, named for someone else, in another store
 *     or company, is touched.
 *  2. Agents pulling at the same instant: every one of his orders ends with ONE agent — modelled with a mutex per lock key and
 *     statements that interleave. The race the lock exists for is the one where the picks DIVERGE (hers for one, his old order for
 *     the other); the same run WITHOUT the lock splits him (the control below), so that test is not vacuous.
 *  3. The cap: no more is held than `CLAIM_CAPS.total − what she holds − 1`; at the cap nothing; never more than `MAX_TWINS_HELD`.
 *  4. The returning-customer rule is unchanged: its holds stay its own, and the two compose.
 *
 * Driven against an in-memory database that APPLIES the filters it is given (with SQL's three values), so a twin is held, skipped or
 * left by the filter's own text and not by a mock that was told the answer.
 *
 * WHAT THIS CANNOT PROVE: that Postgres grants `pg_advisory_xact_lock` the way the mutex does. Writes here land at once; Postgres
 * makes a second conditional UPDATE on a row being written wait and re-check the committed row, which ends the same way.
 * ═══════════════════════════════════════════════════════════════════════
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const { world } = vi.hoisted(() => ({
  world: {
    orders: [] as Row[],
    users: new Map<string, Row>(),
    activities: [] as Row[],
    history: [] as Row[],
    audience: [] as { id: string }[],
    /** Every statement in the order it ran: «tx1:pick», «tx1:lock:pull:dup», «tx1:claim», «tx1:hold». */
    log: [] as string[],
    /** The control: the lock is answered and serialises nothing. */
    lockless: false,
    /** Called before the read of his other orders — the window between a claim and its holds, which a test may hold open. */
    beforeTwinRead: null as null | ((tag: string) => Promise<void>),
  },
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
  /** One step of the event loop between statements, so that transactions launched together interleave as they would. */
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  const tails = new Map<string, Promise<void>>();
  type TxState = { id: number; releases: (() => void)[] } | null;
  let txSeq = 0;

  function client(tx: TxState) {
    const tag = tx ? `tx${tx.id}` : 'root';
    const order = {
      findMany: vi.fn(async ({ where, orderBy, take }: Row) => {
        await tick();
        if (where?.customerId && where?.id?.not && world.beforeTwinRead) await world.beforeTwinRead(tag);
        world.log.push(`${tag}:findMany`);
        const found = sorted(world.orders.filter((r) => matches(r, where ?? {})), orderBy);
        return take ? found.slice(0, take) : found;
      }),
      findFirst: vi.fn(async ({ where, orderBy }: Row) => {
        await tick();
        world.log.push(`${tag}:pick`);
        return sorted(world.orders.filter((r) => matches(r, where ?? {})), orderBy)[0] ?? null;
      }),
      count: vi.fn(async ({ where }: Row) => {
        await tick();
        return world.orders.filter((r) => matches(r, where ?? {})).length;
      }),
      updateMany: vi.fn(async ({ where, data }: Row) => {
        await tick();
        world.log.push(`${tag}:${'claimedById' in data ? 'claim' : 'assignedToId' in data ? 'hold' : 'update'}`);
        const hit = world.orders.filter((r) => matches(r, where));
        for (const r of hit) {
          for (const [k, v] of Object.entries(data)) r[k] = (v as Row)?.increment !== undefined ? (r[k] ?? 0) + (v as Row).increment : v;
          if ('assignedToId' in data) r.assignee = data.assignedToId ? world.users.get(data.assignedToId) ?? null : null;
          if ('claimedById' in data && data.claimedById) r.claimHistory = [...(r.claimHistory ?? []), { action: 'CLAIMED' }];
        }
        return { count: hit.length };
      }),
    };
    return {
      order,
      orderActivity: { create: vi.fn(async ({ data }: Row) => void world.activities.push(data)) },
      orderClaimHistory: { create: vi.fn(async ({ data }: Row) => void world.history.push(data)) },
      orderStatusLog: { create: vi.fn(async () => undefined) },
      $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (!tx) throw new Error('an advisory lock taken outside a transaction protects nothing');
        const sql = strings.join('?');
        if (!sql.includes('pg_advisory_xact_lock(hashtextextended(')) throw new Error(`unexpected raw statement: ${sql}`);
        const key = String(values[0]);
        world.log.push(`${tag}:lock:${key}`);
        await tick();
        if (world.lockless) return 1;
        const prev = tails.get(key) ?? Promise.resolve();
        let release!: () => void;
        const mine = new Promise<void>((r) => (release = r));
        tails.set(key, prev.then(() => mine));
        tx.releases.push(release);
        await prev;
        world.log.push(`${tag}:granted:${key}`);
        return 1;
      }),
    };
  }

  const root = client(null);
  const db = {
    ...root,
    $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => {
      const state = { id: ++txSeq, releases: [] as (() => void)[] };
      try {
        return await fn(client(state));
      } finally {
        // Released at the end of the transaction — commit or rollback — and not before: an xact lock cannot be let go early.
        world.log.push(`tx${state.id}:end`);
        for (const release of state.releases) release();
      }
    }),
    __reset() {
      tails.clear();
      txSeq = 0;
    },
  };
  return { db, default: db };
});
vi.mock('./notification-audience', () => ({ resolveAudience: vi.fn(async () => world.audience) }));

import { CLAIM_CAPS, pullNextOrder, waitingCount, reservedForColleaguesCount } from './confirmation-queue';
import { MAX_TWINS_HELD, TWIN_HELD_ACTION, holdTwinsForPuller, pullLockKey, twinsToHoldWhere } from './twins-follow-the-pull';
import { reserveReturningCustomers } from './reserve-returning-customers';
import { isReservedNow, reservedWhere } from './order-reservation';
import { db } from './db';

const NOW = new Date('2026-11-02T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const scope = { companyId: 'c1', storeId: 's1' };
const CAL = { workHoursStart: '00:00', workHoursEnd: '23:59', weekendDays: [] as number[], timezone: 'UTC' };
const agent = (id: string) => ({ id, role: 'CONFIRMATION_AGENT' });

const user = (id: string, status = 'ACTIVE') => {
  const u = { id, name: id, status };
  world.users.set(id, u);
  return u;
};

let seq = 0;
/** An order that has just arrived and nobody has taken. */
const order = (over: Row = {}): Row => {
  seq += 1;
  const r: Row = {
    id: `o${seq}`, orderNumber: `ORD-${seq}`, ...scope, customerId: `cust${seq}`,
    confirmationStatus: 'NEW', status: 'NEW', shippingStatus: 'NOT_READY',
    claimedById: null, claimedAt: null, currentOwnerId: null, confirmedById: null,
    assignedToId: null, assignedAt: null, assignee: null, replacesOrderId: null,
    postponedUntil: null, nextFollowUpAt: null,
    createdAt: hoursAgo(2), version: 1, contactAttempts: [], claimHistory: [],
    ...over,
  };
  world.orders.push(r);
  return r;
};
const byId = (id: string) => world.orders.find((r) => r.id === id)!;
/** Who has this order: whoever holds it, else whoever it is held for. */
const whose = (r: Row) => byId(r.id).claimedById ?? byId(r.id).assignedToId;
/** She rang the customer of the order she pulled, so the pull gate lets her pull again. */
const rang = (id: string) => void (byId(id).contactAttempts = [{ result: 'ANSWERED' }]);

beforeEach(() => {
  world.orders = [];
  world.users.clear();
  world.activities = [];
  world.history = [];
  world.audience = [];
  world.log = [];
  world.lockless = false;
  world.beforeTwinRead = null;
  seq = 0;
  vi.clearAllMocks();
  (db as unknown as { __reset(): void }).__reset();
  for (const id of ['sara', 'huda', 'noor']) user(id);
});

describe('his other orders follow the one she pulled', () => {
  it('pulls his oldest order and holds the other two for her — the hold the returning rule writes, with a history row each', async () => {
    const a = order({ customerId: 'dup', createdAt: minutesAgo(30) });
    const b = order({ customerId: 'dup', createdAt: minutesAgo(20) });
    const c = order({ customerId: 'dup', createdAt: minutesAgo(10) });

    const out = await pullNextOrder(scope, agent('sara'), CAL, NOW);

    expect(out).toMatchObject({ ok: true, orderId: a.id });
    for (const twin of [b, c]) {
      expect(byId(twin.id)).toMatchObject({ claimedById: null, assignedToId: 'sara', confirmationStatus: 'NEW', version: 2 });
      expect(byId(twin.id).assignedAt).toEqual(NOW);
      // Held by the ONE definition every screen reads: the list, the order sheet and the supervisor's rows show her name.
      expect(isReservedNow({ ...byId(twin.id), assigneeStatus: 'ACTIVE', everClaimed: false }, NOW)).toBe(true);
      expect(matches(byId(twin.id), reservedWhere(NOW))).toBe(true);
    }
    expect(world.activities).toEqual([
      expect.objectContaining({ orderId: b.id, action: TWIN_HELD_ACTION, userId: null, companyId: 'c1' }),
      expect.objectContaining({ orderId: c.id, action: TWIN_HELD_ACTION, userId: null, companyId: 'c1' }),
    ]);
    expect(JSON.parse(world.activities[0].metadata)).toEqual({ agentId: 'sara', pulledOrderId: a.id, withOrder: a.orderNumber });
  });

  it('a colleague is not given them; she is, one by one, once she has rung', async () => {
    const a = order({ customerId: 'dup', createdAt: minutesAgo(30) });
    const b = order({ customerId: 'dup', createdAt: minutesAgo(20) });

    await pullNextOrder(scope, agent('sara'), CAL, NOW);

    const huda = await pullNextOrder(scope, agent('huda'), CAL, NOW);
    expect(huda.ok).toBe(false);
    expect(huda.refusal?.code).toBe('QUEUE_EMPTY');
    expect(await waitingCount(db as never, scope, NOW, 'huda')).toBe(0);
    expect(await reservedForColleaguesCount(db as never, scope, 'huda', NOW)).toBe(1);

    rang(a.id);
    const sara = await pullNextOrder(scope, agent('sara'), CAL, NOW);
    expect(sara).toMatchObject({ ok: true, orderId: b.id });
    expect(byId(b.id)).toMatchObject({ claimedById: 'sara', confirmationStatus: 'IN_PROGRESS' });
  });

  it('a customer with one order: nothing is held, nothing else is written', async () => {
    const only = order({ customerId: 'single' });
    order({ customerId: 'someone-else' });
    expect(await pullNextOrder(scope, agent('sara'), CAL, NOW)).toMatchObject({ ok: true, orderId: only.id });
    expect(world.orders.filter((r) => r.assignedToId)).toHaveLength(0);
    expect(world.activities).toHaveLength(0);
  });

  it('when the order she is given is the one held for her, his other un-named orders follow it too', async () => {
    const hers = order({ customerId: 'dup', createdAt: minutesAgo(5), assignedToId: 'sara', assignedAt: minutesAgo(4), assignee: world.users.get('sara') });
    const later = order({ customerId: 'dup', createdAt: minutesAgo(3) });
    expect(await pullNextOrder(scope, agent('sara'), CAL, NOW)).toMatchObject({ ok: true, orderId: hers.id });
    expect(byId(later.id).assignedToId).toBe('sara');
  });
});

describe('only an order that is waiting and nobody’s is ever held', () => {
  it('decided, postponed, worked before, claimed by a colleague, shipping or a win-back: untouched', async () => {
    const pulled = order({ customerId: 'dup', createdAt: hoursAgo(6) });
    const untouched = [
      order({ customerId: 'dup', confirmationStatus: 'CONFIRMED', status: 'CONFIRMED' }),
      order({ customerId: 'dup', confirmationStatus: 'REJECTED', status: 'REJECTED' }),
      order({ customerId: 'dup', confirmationStatus: 'CANCELLED', status: 'CANCELLED' }),
      order({ customerId: 'dup', confirmationStatus: 'POSTPONED', postponedUntil: new Date(NOW.getTime() + 9 * 86_400_000) }),
      order({ customerId: 'dup', confirmationStatus: 'NO_ANSWER', claimHistory: [{ action: 'CLAIMED' }, { action: 'RELEASED' }] }),
      order({ customerId: 'dup', confirmationStatus: 'IN_PROGRESS', claimedById: 'huda', claimHistory: [{ action: 'CLAIMED' }] }),
      // NEW but once claimed and given back: a hold is for an order that has just ARRIVED.
      order({ customerId: 'dup', claimHistory: [{ action: 'CLAIMED' }, { action: 'RELEASED' }] }),
      order({ customerId: 'dup', shippingStatus: 'READY_TO_SHIP' }),
      order({ customerId: 'dup', replacesOrderId: 'the-lost-order' }),
    ];
    const before = untouched.map((r) => ({ ...r }));

    expect(await pullNextOrder(scope, agent('sara'), CAL, NOW)).toMatchObject({ ok: true, orderId: pulled.id });

    untouched.forEach((r, i) => expect(byId(r.id), r.confirmationStatus).toEqual(before[i]));
    expect(world.activities).toHaveLength(0);
  });

  it('another store and another company with the same customer id: untouched', async () => {
    order({ customerId: 'dup', createdAt: hoursAgo(3) });
    const otherStore = order({ customerId: 'dup', storeId: 's2' });
    const otherCompany = order({ customerId: 'dup', companyId: 'c2' });
    await pullNextOrder(scope, agent('sara'), CAL, NOW);
    expect(byId(otherStore.id).assignedToId).toBeNull();
    expect(byId(otherCompany.id).assignedToId).toBeNull();
  });

  it('a twin already held for another agent (the returning rule spoke first) stays hers — and Sara never takes it', async () => {
    order({ customerId: 'dup', createdAt: hoursAgo(30) }); // older than a day: the returning rule never held it
    const forNoor = order({ customerId: 'dup', createdAt: minutesAgo(10), assignedToId: 'noor', assignedAt: minutesAgo(9), assignee: world.users.get('noor') });

    await pullNextOrder(scope, agent('sara'), CAL, NOW);

    expect(byId(forNoor.id)).toMatchObject({ assignedToId: 'noor', claimedById: null, version: 1 });
    expect(byId(forNoor.id).assignedAt).toEqual(minutesAgo(9));
  });

  it('loses a race quietly: a twin claimed between the read and the write is not held and no row is written', async () => {
    order({ customerId: 'dup', createdAt: minutesAgo(30) });
    const b = order({ customerId: 'dup', createdAt: minutesAgo(20) });
    const tx = { ...(db as Row), order: { ...(db as Row).order } } as Row;
    const realFindMany = tx.order.findMany;
    tx.order.findMany = async (args: Row) => {
      const found = await realFindMany(args);
      byId(b.id).claimedById = 'huda'; // somebody took it by a door with no lock
      return found;
    };
    const held = await holdTwinsForPuller(tx as never, { scope, customerId: 'dup', pulled: { id: 'o1', orderNumber: 'ORD-1' }, agentId: 'sara', room: 10, now: NOW });
    expect(held).toEqual([]);
    expect(byId(b.id)).toMatchObject({ claimedById: 'huda', assignedToId: null });
    expect(world.activities).toHaveLength(0);
  });

  it('no customer on the order, or no room: it reads nothing at all (never an empty filter over the whole store)', async () => {
    order({ customerId: 'dup' });
    for (const [customerId, room] of [[null, 10], [undefined, 10], ['', 10], ['dup', 0], ['dup', -3]] as const) {
      expect(await holdTwinsForPuller(db as never, { scope, customerId, pulled: { id: 'x' }, agentId: 'sara', room, now: NOW })).toEqual([]);
    }
    expect((db as Row).order.findMany).not.toHaveBeenCalled();
    expect(world.orders[0].assignedToId).toBeNull();
  });

  it('the filter names every clause it promises', () => {
    expect(twinsToHoldWhere(scope, 'dup', 'o9')).toEqual({
      companyId: 'c1', storeId: 's1', customerId: 'dup', id: { not: 'o9' },
      claimedById: null, assignedToId: null, confirmationStatus: 'NEW', shippingStatus: 'NOT_READY',
      claimHistory: { none: {} }, replacesOrderId: null,
    });
  });
});

describe('the cap', () => {
  /** She already holds `n` open orders, every one rung (so the pull gate is about the cap alone). */
  const holding = (n: number) => {
    for (let i = 0; i < n; i++) {
      order({ customerId: `mine-${i}`, confirmationStatus: 'IN_PROGRESS', claimedById: 'sara', claimedAt: hoursAgo(1), contactAttempts: [{}], claimHistory: [{ action: 'CLAIMED' }] });
    }
  };

  it(`holds no more than the room left: ${CLAIM_CAPS.total} − what she held − 1 — the oldest first`, async () => {
    holding(CLAIM_CAPS.total - 3); // 297: the pull makes 298, room for two
    const a = order({ customerId: 'dup', createdAt: minutesAgo(50) });
    const twins = [40, 30, 20, 10].map((m) => order({ customerId: 'dup', createdAt: minutesAgo(m) }));

    expect(await pullNextOrder(scope, agent('sara'), CAL, NOW)).toMatchObject({ ok: true, orderId: a.id });
    expect(twins.map((t) => byId(t.id).assignedToId)).toEqual(['sara', 'sara', null, null]);
  });

  it('one short of the cap: the pull is hers, nothing is held, his other orders stay in the shared queue', async () => {
    holding(CLAIM_CAPS.total - 1);
    order({ customerId: 'dup', createdAt: minutesAgo(50) });
    const b = order({ customerId: 'dup', createdAt: minutesAgo(40) });
    expect((await pullNextOrder(scope, agent('sara'), CAL, NOW)).ok).toBe(true);
    expect(byId(b.id).assignedToId).toBeNull();
    expect(world.activities).toHaveLength(0);
  });

  it('at the cap the pull is refused as before, and nothing is held', async () => {
    holding(CLAIM_CAPS.total);
    const a = order({ customerId: 'dup' });
    const out = await pullNextOrder(scope, agent('sara'), CAL, NOW);
    expect(out.refusal?.code).toBe('CAP_TOTAL');
    expect(byId(a.id)).toMatchObject({ claimedById: null, assignedToId: null });
  });

  it(`never more than ${MAX_TWINS_HELD} in one pull, whatever the room`, async () => {
    order({ customerId: 'spam', createdAt: hoursAgo(5) });
    for (let i = 0; i < MAX_TWINS_HELD + 7; i++) order({ customerId: 'spam', createdAt: minutesAgo(200 - i) });
    await pullNextOrder(scope, agent('sara'), CAL, NOW);
    expect(world.orders.filter((r) => r.assignedToId === 'sara')).toHaveLength(MAX_TWINS_HELD);
  });
});

describe('three agents pull at the same instant', () => {
  const threeAtOnce = async () => {
    const dup = [30, 20, 10].map((m) => order({ customerId: 'dup', createdAt: minutesAgo(m) }));
    const others = [5, 4, 3].map((m) => order({ createdAt: minutesAgo(m) }));
    const outs = await Promise.all(['sara', 'huda', 'noor'].map((id) => pullNextOrder(scope, agent(id), CAL, NOW)));
    return { dup, others, outs };
  };

  it('all three of his orders end with ONE agent; the other two are given somebody else’s order', async () => {
    const { dup, others, outs } = await threeAtOnce();

    expect(outs.every((o) => o.ok)).toBe(true);
    const owners = new Set(dup.map(whose));
    expect(owners.size, `his orders went to ${[...owners].join(', ')}`).toBe(1);
    const [winner] = [...owners];
    expect(dup.filter((r) => byId(r.id).claimedById === winner)).toHaveLength(1);
    expect(dup.filter((r) => byId(r.id).assignedToId === winner && !byId(r.id).claimedById)).toHaveLength(2);
    // The two who lost him each pulled one of the other customers' orders.
    const losers = outs.filter((o) => !dup.some((r) => r.id === o.orderId));
    expect(losers).toHaveLength(2);
    expect(losers.every((o) => others.some((r) => r.id === o.orderId))).toBe(true);
  });

  it('the lock is taken inside the transaction, on «pull:<customer>», before the claim — and the losers wait at it', async () => {
    await threeAtOnce();
    const lockAt = world.log.indexOf('tx1:lock:pull:dup');
    const claimAt = world.log.indexOf('tx1:claim');
    expect(lockAt).toBeGreaterThan(-1);
    expect(lockAt).toBeLessThan(claimAt);
    // Every pull asked for his lock (they all picked his oldest order first), and the second was granted only after the first ended.
    const granted = world.log.filter((l) => l.includes(':granted:pull:dup'));
    expect(granted).toHaveLength(3);
    const firstEnd = world.log.findIndex((l) => l.endsWith(':end'));
    expect(world.log.indexOf(granted[1])).toBeGreaterThan(firstEnd);
    expect(pullLockKey('dup')).toBe('pull:dup');
  });

  it('the raw statement is pg_advisory_xact_lock over hashtextextended of the key, through $executeRaw', async () => {
    order({ customerId: 'dup' });
    const seen: string[] = [];
    const real = (db as Row).$transaction;
    (db as Row).$transaction = vi.fn(async (fn: (t: Row) => Promise<unknown>) =>
      real(async (t: Row) => {
        const exec = t.$executeRaw;
        t.$executeRaw = async (s: TemplateStringsArray, ...v: unknown[]) => {
          seen.push(`${s.join('$')}|${v.join(',')}`);
          return exec(s, ...v);
        };
        return fn(t);
      })
    );
    try {
      await pullNextOrder(scope, agent('sara'), CAL, NOW);
    } finally {
      (db as Row).$transaction = real;
    }
    expect(seen).toEqual(['SELECT pg_advisory_xact_lock(hashtextextended($::text, 0))|pull:dup']);
  });

  /**
   * THE RACE THE LOCK IS FOR. When every pull picks his oldest order first, the losers fail on that very row and, by the time they
   * pick again, the winner has held the rest (in Postgres the row lock on that order makes them wait for her commit). The picks DIVERGE
   * when one agent is given his order held for her and another takes his day-old order at the head of the queue: two different rows,
   * nothing to wait on — and her hold of the old one comes after her own claim. The barrier below keeps that window open long enough
   * for the colleague's claim to land in it if nothing stops her; the lock is what stops her.
   */
  const divergent = async () => {
    const hers = order({ customerId: 'dup', createdAt: minutesAgo(5), assignedToId: 'sara', assignedAt: minutesAgo(4), assignee: world.users.get('sara') });
    const old = order({ customerId: 'dup', createdAt: hoursAgo(30) }); // older than a day: the returning rule never named it
    const other = order({ createdAt: hoursAgo(1) });
    const tick = () => new Promise<void>((r) => setTimeout(r, 0));
    world.beforeTwinRead = async (tag) => {
      if (tag !== 'tx1') return;
      for (let i = 0; i < 40 && !world.log.includes('tx2:claim'); i++) await tick();
    };
    const outs = await Promise.all(['sara', 'huda'].map((id) => pullNextOrder(scope, agent(id), CAL, NOW)));
    return { hers, old, other, outs };
  };

  it('picks that differ (hers for one, his old order for the other): both his orders end with her, the colleague gets somebody else’s', async () => {
    const { hers, old, other, outs } = await divergent();
    expect(outs[0]).toMatchObject({ ok: true, orderId: hers.id });
    expect(outs[1]).toMatchObject({ ok: true, orderId: other.id });
    expect(byId(old.id)).toMatchObject({ claimedById: null, assignedToId: 'sara' });
    // Huda asked for his lock and was granted it only after Sara's transaction ended.
    expect(world.log.indexOf('tx2:granted:pull:dup')).toBeGreaterThan(world.log.indexOf('tx1:end'));
  });

  it('CONTROL — the same race with a lock that serialises nothing splits him across two agents (so the test above is not vacuous)', async () => {
    world.lockless = true;
    const { hers, old } = await divergent();
    expect(whose(hers)).toBe('sara');
    expect(whose(old)).toBe('huda');
  });

  it('Messenger and the site, two agents at once: both his orders with one of them', async () => {
    const messenger = order({ customerId: 'twice', createdAt: minutesAgo(8) });
    const site = order({ customerId: 'twice', createdAt: minutesAgo(7) });
    order({ createdAt: minutesAgo(1) });
    const outs = await Promise.all(['sara', 'huda'].map((id) => pullNextOrder(scope, agent(id), CAL, NOW)));
    expect(outs.every((o) => o.ok)).toBe(true);
    expect(whose(messenger)).toBe(whose(site));
  });

  it('two different customers pulled at once never wait for each other', async () => {
    order({ customerId: 'p', createdAt: minutesAgo(9) });
    order({ customerId: 'q', createdAt: minutesAgo(8) });
    // Sara is given p's order through a hold for her, Huda the oldest everybody's: two keys, two locks, no waiting.
    byId('o2').assignedToId = 'sara';
    byId('o2').assignedAt = minutesAgo(1);
    byId('o2').assignee = world.users.get('sara');
    const outs = await Promise.all(['sara', 'huda'].map((id) => pullNextOrder(scope, agent(id), CAL, NOW)));
    expect(outs.map((o) => o.orderId).sort()).toEqual(['o1', 'o2']);
    expect(world.log.filter((l) => l.includes(':granted:'))).toHaveLength(2);
  });
});

describe('the returning-customer rule is unchanged, and the two compose', () => {
  it('his orders already held for his old agent stay hers: a colleague gets none of them, she gets them, no twin row is written', async () => {
    world.audience = [{ id: 'sara' }, { id: 'huda' }];
    order({ customerId: 'regular', confirmationStatus: 'CONFIRMED', status: 'CONFIRMED', createdAt: hoursAgo(40), claimedById: 'sara' });
    const fresh = [30, 20, 10].map((m) => order({ customerId: 'regular', createdAt: minutesAgo(m) }));

    expect(await reserveReturningCustomers(scope, NOW)).toBe(3);
    const huda = await pullNextOrder(scope, agent('huda'), CAL, NOW);
    expect(huda.refusal?.code).toBe('QUEUE_EMPTY');

    expect(await pullNextOrder(scope, agent('sara'), CAL, NOW)).toMatchObject({ ok: true, orderId: fresh[0].id });
    expect(fresh.slice(1).map((r) => byId(r.id).assignedToId)).toEqual(['sara', 'sara']);
    expect(world.activities.map((a) => a.action)).toEqual(['HELD_FOR_AGENT', 'HELD_FOR_AGENT', 'HELD_FOR_AGENT']);
  });

  it('after a twin hold the scheduled run of the returning rule finds nothing to write and changes nothing', async () => {
    world.audience = [{ id: 'sara' }, { id: 'huda' }];
    order({ customerId: 'dup', createdAt: minutesAgo(30) });
    order({ customerId: 'dup', createdAt: minutesAgo(20) });
    await pullNextOrder(scope, agent('huda'), CAL, NOW);
    const snapshot = JSON.stringify(world.orders);

    expect(await reserveReturningCustomers(scope, NOW)).toBe(0);
    expect(JSON.stringify(world.orders)).toBe(snapshot);
  });

  it('an order of his that arrives AFTER the pull is held for her by the returning rule, as it always would be', async () => {
    world.audience = [{ id: 'sara' }, { id: 'huda' }];
    order({ customerId: 'dup', createdAt: minutesAgo(30) });
    await pullNextOrder(scope, agent('huda'), CAL, NOW);
    const late = order({ customerId: 'dup', createdAt: minutesAgo(1) });

    expect(await reserveReturningCustomers(scope, NOW)).toBe(1);
    expect(byId(late.id).assignedToId).toBe('huda');
  });

  it('DIFFERENTIAL — with no pull in between, the returning rule writes exactly what it wrote before this change', async () => {
    world.audience = [{ id: 'sara' }];
    // A returning customer, a first-timer, a twin pair of a first-timer, a win-back, an old one: the rule's whole table.
    order({ customerId: 'regular', confirmationStatus: 'CONFIRMED', createdAt: hoursAgo(40), claimedById: 'sara' });
    const regular = order({ customerId: 'regular', createdAt: minutesAgo(10) });
    const first = order({ customerId: 'first', createdAt: minutesAgo(10) });
    const pair = [order({ customerId: 'pair', createdAt: minutesAgo(9) }), order({ customerId: 'pair', createdAt: minutesAgo(8) })];
    const winback = order({ customerId: 'regular', createdAt: minutesAgo(7), replacesOrderId: 'lost' });
    const old = order({ customerId: 'regular', createdAt: hoursAgo(26) });

    expect(await reserveReturningCustomers(scope, NOW)).toBe(1);
    expect([regular, first, ...pair, winback, old].map((r) => byId(r.id).assignedToId)).toEqual(['sara', null, null, null, null, null]);
  });
});
