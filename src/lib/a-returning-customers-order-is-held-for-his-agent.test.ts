import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE
 *
 * The owner, 31/10: «بس تجي موظفة التأكيد تسحب الطلب للزبون وهو عندو سجل طلبات.. لازم يروح لنفس الموظفة… اريد الطلب يكون ظاهر
 * بخانة الطلبات تابع للموظف اللي كان متابع معه… باقي الموظفات يشوفوه ومايقدرو يسحبوه… إذا حسابها معطّل يكون عام… إذا (س) فعّالة بس
 * غايبة يومين ينتظرها 24 ساعة فقط وبعدها عام».
 *
 * These drive the REAL queue, claim gate and assigner against an in-memory database that APPLIES the filters it is given, so a
 * held order is skipped, counted or taken by the filter's own text and not by a mock that was told the answer.
 *
 *  1. The assigner holds a returning customer's new order for the agent who worked his newest prior order — if she is available —
 *     and writes nothing for a first-time customer, for an unavailable agent (no fallback to an older one), or when it loses a race.
 *  2. «اسحب التالي»: she gets hers first; a colleague never gets it; at 24 hours, or when her account is off, anybody does.
 *  3. The counters: «بانتظارك» is what she may take; the colleagues' held orders are counted apart; the supervisor sees the whole pool.
 *  4. The claim gate (`atomicClaim`) refuses everybody but her at the write.
 *  5. A release lets go of the hold: an order she gave back, or that went back unworked, is not held for her a second time.
 *
 * Blockers: no money, no order creation (the assigner runs AFTER the order exists), no new column.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Row = Record<string, any>;

const { world } = vi.hoisted(() => ({
  world: {
    orders: [] as Row[],
    users: new Map<string, Row>(),
    activities: [] as Row[],
    history: [] as Row[],
    audience: [] as { id: string }[],
  },
}));

/**
 * The operators the filters use — and nothing else, so a filter that starts using a new one fails here by name — with SQL's THREE
 * values: a comparison with a NULL column is UNKNOWN, `NOT` of unknown is unknown, and a WHERE keeps only TRUE. (This file used to
 * answer true/false only, and so could not see `NOT (… assignedAt > $cutoff …)` drop a released order that kept its name.)
 */
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
        if ('assignedToId' in data) r.assignee = data.assignedToId ? world.users.get(data.assignedToId) ?? null : null;
      }
      return { count: hit.length };
    }),
  };
  const db = {
    order,
    orderActivity: { create: vi.fn(async ({ data }: Row) => void world.activities.push(data)) },
    orderClaimHistory: { create: vi.fn(async ({ data }: Row) => void world.history.push(data)) },
    orderStatusLog: { create: vi.fn(async () => undefined) },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return { db, default: db };
});
vi.mock('./notification-audience', () => ({ resolveAudience: vi.fn(async () => world.audience) }));

import {
  pickNextCandidate,
  pullNextOrder,
  readyToPullWhere,
  releaseStaleClaims,
  reservedForColleaguesCount,
  waitingCount,
} from './confirmation-queue';
import { atomicClaim } from './order-locks';
import { reserveReturningCustomers } from './reserve-returning-customers';
import { isReservedNow } from './order-reservation';
import { db } from './db';

const NOW = new Date('2026-10-31T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const scope = { companyId: 'c1', storeId: 's1' };
const CAL = { workHoursStart: '00:00', workHoursEnd: '23:59', weekendDays: [] as number[], timezone: 'UTC' };

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
    id: `o${seq}`, ...scope, customerId: `cust${seq}`,
    confirmationStatus: 'NEW', shippingStatus: 'NOT_READY',
    claimedById: null, claimedAt: null, currentOwnerId: null, confirmedById: null,
    assignedToId: null, assignedAt: null, assignee: null,
    signatureStatus: 'UNSIGNED', createdAt: hoursAgo(2), version: 1, contactAttempts: [],
    lockedById: null, lockExpiresAt: null, claimHistory: [],
    ...over,
  };
  world.orders.push(r);
  return r;
};
/** Held for `who`, `ago` hours back. */
const heldFor = (who: string, ago = 1, over: Row = {}) =>
  order({ assignedToId: who, assignedAt: hoursAgo(ago), assignee: world.users.get(who) ?? null, ...over });
const byId = (id: string) => world.orders.find((r) => r.id === id)!;

beforeEach(() => {
  world.orders = [];
  world.users.clear();
  world.activities = [];
  world.history = [];
  world.audience = [];
  seq = 0;
  vi.clearAllMocks();
  for (const id of ['sara', 'huda', 'noor']) user(id);
});

describe('the assigner', () => {
  const returning = (handler: Row, extra: Row = {}) => {
    const prior = order({ customerId: 'regular', confirmationStatus: 'CONFIRMED', createdAt: hoursAgo(30), ...handler });
    const fresh = order({ customerId: 'regular', createdAt: hoursAgo(1), ...extra });
    return { prior, fresh };
  };

  it('holds his new order for the agent who worked his newest prior order — and writes who, when, and the version', async () => {
    world.audience = [{ id: 'sara' }, { id: 'huda' }];
    const { fresh } = returning({ claimedById: 'sara' });

    expect(await reserveReturningCustomers(scope, NOW)).toBe(1);

    expect(byId(fresh.id)).toMatchObject({ assignedToId: 'sara', claimedById: null, version: 2 });
    expect(byId(fresh.id).assignedAt).toEqual(NOW);
    expect(isReservedNow({ ...byId(fresh.id), assigneeStatus: 'ACTIVE', everClaimed: false }, NOW)).toBe(true);
    expect(world.activities).toEqual([
      expect.objectContaining({ orderId: fresh.id, action: 'HELD_FOR_AGENT', userId: null }),
    ]);
    expect(JSON.parse(world.activities[0].metadata)).toEqual({ agentId: 'sara', reason: 'RETURNING_CUSTOMER' });
  });

  it('holds NOTHING for a win-back offer — its door says «held by nobody: whoever is free calls it»', async () => {
    world.audience = [{ id: 'sara' }];
    // The customer's earlier order was lost (rejected by Sara); the supervisor's offer is a new NEW order that replaces it.
    const { fresh } = returning({ claimedById: 'sara' }, { replacesOrderId: 'the-lost-order' });
    const ordinary = order({ customerId: 'regular', createdAt: hoursAgo(1) });

    expect(await reserveReturningCustomers(scope, NOW)).toBe(1);

    expect(byId(fresh.id).assignedToId).toBeNull();
    expect(byId(ordinary.id).assignedToId).toBe('sara');
  });

  it('holds nothing for a customer with no history, and does not even ask who is available', async () => {
    const { resolveAudience } = await import('./notification-audience');
    order({ customerId: 'first-timer' });
    expect(await reserveReturningCustomers(scope, NOW)).toBe(0);
    expect(resolveAudience).not.toHaveBeenCalled();
  });

  it('holds nothing when the agent is not available (not active / may not pull) — and does NOT fall back to an older agent', async () => {
    world.audience = [{ id: 'huda' }]; // sara is not in the audience: disabled
    const older = order({ customerId: 'regular', confirmationStatus: 'CONFIRMED', createdAt: hoursAgo(80), claimedById: 'huda' });
    order({ customerId: 'regular', confirmationStatus: 'CONFIRMED', createdAt: hoursAgo(30), claimedById: 'sara' });
    const fresh = order({ customerId: 'regular', createdAt: hoursAgo(1) });

    expect(await reserveReturningCustomers(scope, NOW)).toBe(0);
    expect(byId(fresh.id).assignedToId).toBeNull();
    expect(older.assignedToId).toBeNull();
  });

  it('skips a prior order nobody worked and takes the next one back', async () => {
    world.audience = [{ id: 'huda' }];
    order({ customerId: 'regular', confirmationStatus: 'CONFIRMED', createdAt: hoursAgo(80), claimedById: 'huda' });
    order({ customerId: 'regular', confirmationStatus: 'NEW', createdAt: hoursAgo(30) }); // pulled by nobody
    const fresh = order({ customerId: 'regular', createdAt: hoursAgo(1) });

    expect(await reserveReturningCustomers(scope, NOW)).toBe(1);
    expect(byId(fresh.id).assignedToId).toBe('huda');
  });

  it('is scoped to this store: a prior order in another store names nobody', async () => {
    world.audience = [{ id: 'sara' }];
    order({ customerId: 'regular', confirmationStatus: 'CONFIRMED', createdAt: hoursAgo(30), claimedById: 'sara', storeId: 'OTHER' });
    const fresh = order({ customerId: 'regular', createdAt: hoursAgo(1) });
    expect(await reserveReturningCustomers(scope, NOW)).toBe(0);
    expect(byId(fresh.id).assignedToId).toBeNull();
  });

  it('touches only the order that has just arrived: not a claimed one, not one already named, not one older than a day, not a postponed one', async () => {
    world.audience = [{ id: 'sara' }];
    const claimed = returning({ claimedById: 'sara' }, { claimedById: 'huda' }).fresh;
    const named = returning({ claimedById: 'sara' }, { assignedToId: 'noor', assignedAt: hoursAgo(1), assignee: world.users.get('noor') }).fresh;
    const old = returning({ claimedById: 'sara' }, { createdAt: hoursAgo(26) }).fresh;
    const postponed = returning({ claimedById: 'sara' }, { confirmationStatus: 'POSTPONED' }).fresh;

    // Four returning customers' orders; each customer's own prior order is NEW-excluded or confirmed, never a candidate.
    expect(await reserveReturningCustomers(scope, NOW)).toBe(0);
    expect(byId(claimed.id).assignedToId).toBeNull();
    expect(byId(named.id).assignedToId).toBe('noor');
    expect(byId(old.id).assignedToId).toBeNull();
    expect(byId(postponed.id).assignedToId).toBeNull();
  });

  it('can be asked about one order (the claim door asks only about the order in hand)', async () => {
    world.audience = [{ id: 'sara' }];
    const a = returning({ claimedById: 'sara' }).fresh;
    const b = returning({ claimedById: 'sara' }, { customerId: 'regular-2' }).fresh;
    expect(await reserveReturningCustomers(scope, NOW, { orderIds: [a.id] })).toBe(1);
    expect(byId(a.id).assignedToId).toBe('sara');
    expect(byId(b.id).assignedToId).toBeNull();
  });

  it('loses a race quietly: an order claimed between the read and the write is not held, and no activity is written', async () => {
    world.audience = [{ id: 'sara' }];
    const { fresh } = returning({ claimedById: 'sara' });
    const updateMany = db.order.updateMany as unknown as ReturnType<typeof vi.fn>;
    const real = updateMany.getMockImplementation()! as (args: Row) => Promise<unknown>;
    updateMany.mockImplementationOnce(async (args: Row) => {
      byId(fresh.id).claimedById = 'huda'; // somebody pulled it just before our write
      return real(args);
    });
    expect(await reserveReturningCustomers(scope, NOW)).toBe(0);
    expect(world.activities).toHaveLength(0);
    expect(byId(fresh.id).assignedToId).toBeNull();
  });

  it('is idempotent: a second run finds it already named and writes nothing', async () => {
    world.audience = [{ id: 'sara' }];
    returning({ claimedById: 'sara' });
    expect(await reserveReturningCustomers(scope, NOW)).toBe(1);
    expect(await reserveReturningCustomers(scope, NOW)).toBe(0);
    expect(world.activities).toHaveLength(1);
  });
});

describe('«اسحب الطلب التالي» and the counters', () => {
  it('gives her the order held for her FIRST — before an older one anybody could take', async () => {
    order({ createdAt: hoursAgo(10) }); // older, nobody's
    const hers = heldFor('sara', 1, { createdAt: hoursAgo(1) });
    expect(await pickNextCandidate(db as never, scope, NOW, 'sara')).toBe(hers.id);
  });

  it('never gives a colleague the order held for her — it takes the next one, or none', async () => {
    const general = order({ createdAt: hoursAgo(5) });
    heldFor('sara', 1, { createdAt: hoursAgo(8) }); // the OLDEST in the queue, held
    expect(await pickNextCandidate(db as never, scope, NOW, 'huda')).toBe(general.id);

    world.orders = world.orders.filter((r) => r.id !== general.id);
    expect(await pickNextCandidate(db as never, scope, NOW, 'huda')).toBeNull();
  });

  it('lets go after 24 hours: the colleague gets it', async () => {
    const stale = heldFor('sara', 25, { createdAt: hoursAgo(26) });
    expect(await pickNextCandidate(db as never, scope, NOW, 'huda')).toBe(stale.id);
  });

  it('lets go the moment her account is not ACTIVE', async () => {
    user('sara', 'DISABLED');
    const hers = heldFor('sara', 1);
    expect(await pickNextCandidate(db as never, scope, NOW, 'huda')).toBe(hers.id);
    user('sara', 'SUSPENDED');
    expect(await pickNextCandidate(db as never, scope, NOW, 'huda')).toBe(hers.id);
  });

  it('pulls: she is given hers, a colleague with only hers in the queue is told it is empty and nothing is claimed', async () => {
    const hers = heldFor('sara', 1);

    const colleague = await pullNextOrder(scope, { id: 'huda', role: 'CONFIRMATION_AGENT' }, CAL, NOW);
    expect(colleague.ok).toBe(false);
    expect(colleague.refusal?.code).toBe('QUEUE_EMPTY');
    expect(byId(hers.id).claimedById).toBeNull();

    const sara = await pullNextOrder(scope, { id: 'sara', role: 'CONFIRMATION_AGENT' }, CAL, NOW);
    expect(sara).toMatchObject({ ok: true, orderId: hers.id });
    expect(byId(hers.id)).toMatchObject({ claimedById: 'sara', confirmationStatus: 'IN_PROGRESS' });
    // Once she holds it, it is no longer «held for» anybody: it is hers.
    expect(isReservedNow({ ...byId(hers.id), assigneeStatus: 'ACTIVE' }, NOW)).toBe(false);
  });

  it('«بانتظارك» is what she may take; the colleagues’ held orders are counted apart; the supervisor sees the whole pool', async () => {
    order(); // everybody's
    heldFor('sara'); // hers
    heldFor('huda'); // a colleague's
    heldFor('huda');

    expect(await waitingCount(db as never, scope, NOW, 'sara')).toBe(2); // everybody's + hers
    expect(await waitingCount(db as never, scope, NOW, 'noor')).toBe(1); // everybody's only
    expect(await waitingCount(db as never, scope, NOW)).toBe(4); // the supervisor: all of it

    expect(await reservedForColleaguesCount(db as never, scope, 'sara', NOW)).toBe(2);
    expect(await reservedForColleaguesCount(db as never, scope, 'noor', NOW)).toBe(3);
  });

  it('does not count a held order as waiting for her once it has let go', async () => {
    heldFor('huda', 30, { createdAt: hoursAgo(31) });
    expect(await waitingCount(db as never, scope, NOW, 'sara')).toBe(1);
    expect(await reservedForColleaguesCount(db as never, scope, 'sara', NOW)).toBe(0);
  });

  it('keeps the pull filter free of the hold when it is asked for the pool as a whole', () => {
    expect(readyToPullWhere(scope)).not.toHaveProperty('AND');
    expect(readyToPullWhere(scope, 'sara', NOW)).toHaveProperty('AND');
  });
});

describe('the claim gate', () => {
  const lock = new Date(NOW.getTime() + 60_000);

  it('refuses everybody but her, at the write', async () => {
    const hers = heldFor('sara', 1);
    expect(await atomicClaim({ orderId: hers.id, userId: 'huda', now: NOW, lockExpiresAt: lock })).toBe(false);
    expect(byId(hers.id).claimedById).toBeNull();
    expect(await atomicClaim({ orderId: hers.id, userId: 'sara', now: NOW, lockExpiresAt: lock })).toBe(true);
    expect(byId(hers.id).claimedById).toBe('sara');
  });

  it('lets a colleague take it after 24 hours, and when her account is off', async () => {
    const stale = heldFor('sara', 25);
    expect(await atomicClaim({ orderId: stale.id, userId: 'huda', now: NOW, lockExpiresAt: lock })).toBe(true);

    user('noor', 'DISABLED');
    const off = heldFor('noor', 1);
    expect(await atomicClaim({ orderId: off.id, userId: 'huda', now: NOW, lockExpiresAt: lock })).toBe(true);
  });

  it('an order nobody holds is anybody’s, as it always was', async () => {
    const free = order();
    expect(await atomicClaim({ orderId: free.id, userId: 'huda', now: NOW, lockExpiresAt: lock })).toBe(true);
  });
});

describe('the pull’s own write asks «is it held for somebody else?» again', () => {
  it('a hold that lands AFTER the pick is not taken over by the pull — the order stays hers, and nothing is written for the puller', async () => {
    const o = order({ customerId: 'regular' });
    // The pick answers `o`, and THEN Sara is named for it: the assigner ran between the pick and the write.
    type Pick = { getMockImplementation(): (a: Row) => Promise<Row | null>; mockImplementation(f: (a: Row) => Promise<Row | null>): void };
    const pick = db.order.findFirst as unknown as Pick;
    const real = pick.getMockImplementation()!;
    let landed = false;
    pick.mockImplementation(async (args) => {
      const found = await real(args);
      if (found && !landed) {
        landed = true;
        Object.assign(found, { assignedToId: 'sara', assignedAt: NOW, assignee: world.users.get('sara') });
      }
      return found;
    });
    try {
      const out = await pullNextOrder(scope, { id: 'huda', role: 'CONFIRMATION_AGENT' }, CAL, NOW);
      expect(out.ok).toBe(false);
      expect(byId(o.id).claimedById).toBeNull();
      expect(byId(o.id).assignedToId).toBe('sara');
      expect(world.history).toHaveLength(0);
    } finally {
      pick.mockImplementation(real);
    }
  });
});

describe('a release lets go of the hold', () => {
  it('the auto-release of an unworked claim writes `assignedAt: null` — it is not held for her a second time', async () => {
    // She pulled the order held for her and never rang the customer: ninety business minutes later it goes back.
    const hers = heldFor('sara', 5, { claimedById: 'sara', claimedAt: hoursAgo(3), confirmationStatus: 'IN_PROGRESS', claimHistory: [{ action: 'CLAIMED' }] });

    expect(await releaseStaleClaims(db as never, scope, CAL, NOW)).toBe(1);

    expect(byId(hers.id)).toMatchObject({ claimedById: null, assignedAt: null });
    // The name stays (history of who it was for), the TIME goes — and the hold is measured by the time.
    expect(byId(hers.id).assignedToId).toBe('sara');
    expect(isReservedNow({ ...byId(hers.id), assigneeStatus: 'ACTIVE' }, NOW)).toBe(false);
    expect(await pickNextCandidate(db as never, scope, NOW, 'huda')).toBe(hers.id);
  });
});

describe('every way an order comes back to the queue leaves it everybody’s — the independent review’s four findings', () => {
  const given = (over: Row = {}) => heldFor('sara', 1, { claimHistory: [{ action: 'CLAIMED' }, { action: 'RELEASED' }], ...over });

  it('1 · released with its name kept and its time cleared: counted, picked and claimed by a colleague (NOT(…) over a NULL used to drop it)', async () => {
    const back = given({ assignedAt: null });
    expect(await waitingCount(db as never, scope, NOW, 'huda')).toBe(1);
    expect(await pickNextCandidate(db as never, scope, NOW, 'huda')).toBe(back.id);
    expect(await reservedForColleaguesCount(db as never, scope, 'huda', NOW)).toBe(0);
    expect(await atomicClaim({ orderId: back.id, userId: 'huda', now: NOW, lockExpiresAt: new Date(NOW.getTime() + 60_000) })).toBe(true);
  });

  it('1b · …and the owner takes it with «استلمه أنا» then releases it: that leaves exactly that row, and it is everybody’s too', async () => {
    const afterOverride = given({ assignedToId: 'owner', assignedAt: null, assignee: user('owner') });
    expect(await pickNextCandidate(db as never, scope, NOW, 'huda')).toBe(afterOverride.id);
  });

  it('2 · the pull itself takes it: a colleague with only that order in the queue is given it, with the claim written', async () => {
    const back = given({ assignedAt: null });
    const pulled = await pullNextOrder(scope, { id: 'huda', role: 'CONFIRMATION_AGENT' }, CAL, NOW);
    expect(pulled).toMatchObject({ ok: true, orderId: back.id });
    expect(byId(back.id).claimedById).toBe('huda');
  });

  it('3 · the issues door leaves the name AND a recent time on an order that was claimed once: it is not held for her again', async () => {
    const left = given({ assignedAt: hoursAgo(1) });
    expect(isReservedNow({ ...byId(left.id), assigneeStatus: 'ACTIVE', everClaimed: true }, NOW)).toBe(false);
    expect(await pickNextCandidate(db as never, scope, NOW, 'huda')).toBe(left.id);
    expect(await waitingCount(db as never, scope, NOW, 'huda')).toBe(1);
    expect(await reservedForColleaguesCount(db as never, scope, 'huda', NOW)).toBe(0);
  });

  it('4 · the owner’s pull-back (name and time cleared, NEW) is NOT held again by the assigner for the customer’s old agent', async () => {
    world.audience = [{ id: 'sara' }];
    order({ customerId: 'regular', confirmationStatus: 'CONFIRMED', createdAt: hoursAgo(40), claimedById: 'sara' });
    const pulledBack = order({ customerId: 'regular', createdAt: hoursAgo(3), claimHistory: [{ action: 'CLAIMED' }, { action: 'RELEASED', reason: 'الزبون طلب موظفة تانية' }] });

    expect(await reserveReturningCustomers(scope, NOW)).toBe(0);
    expect(byId(pulledBack.id).assignedToId).toBeNull();
    expect(await pickNextCandidate(db as never, scope, NOW, 'huda')).toBe(pulledBack.id);
  });

  it('5 · the assigner holds only an order that has just ARRIVED: one that was claimed once is left alone even before its name is cleared', async () => {
    world.audience = [{ id: 'sara' }];
    order({ customerId: 'regular', confirmationStatus: 'CONFIRMED', createdAt: hoursAgo(40), claimedById: 'sara' });
    const arrival = order({ customerId: 'regular', createdAt: hoursAgo(2) });
    const claimedBefore = order({ customerId: 'regular', createdAt: hoursAgo(3), claimHistory: [{ action: 'CLAIMED' }] });

    expect(await reserveReturningCustomers(scope, NOW)).toBe(1);
    expect(byId(arrival.id).assignedToId).toBe('sara');
    expect(byId(claimedBefore.id).assignedToId).toBeNull();
  });

  it('6 · a row that was released BEFORE holds existed (name and a recent time, history) is not held on the day this ships', async () => {
    const old = given({ assignedAt: hoursAgo(2) });
    expect(await reservedForColleaguesCount(db as never, scope, 'huda', NOW)).toBe(0);
    expect(await pickNextCandidate(db as never, scope, NOW, 'huda')).toBe(old.id);
  });
});
