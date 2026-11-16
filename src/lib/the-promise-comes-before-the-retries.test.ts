import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE CUSTOMER'S PROMISE IS PULLED BEFORE THE RETRIES (the planner 15/11, rulings 9, 10 and 13; Confirmation Center v2, step B)
 *
 * «الترتيب: الوعد اللي وصل وقته أول، بعدين الإعادات بالموعد، بعدين الباقي بالأقدم إنشاءً»: with the five-attempt cadence ON, after a NEW order the pull gives the PROMISE — an order whose
 * customer-asked date (`postponedUntil` / `nextFollowUpAt`, the later of the two) has arrived with no line logged at or after it, the very fact the desk's tag reads (`promiseArrived`) — and then,
 * as before, the retries by their due and the rest oldest-created first.
 *
 *  1. The order is: held for her · a NEW order · the promise whose date came first (ties: the older order, then the smaller id) · the retry with the oldest due · the rest by age.
 *  2. A promise is ANY pullable order — POSTPONED, FOLLOW_UP_REQUIRED, a returned retry the customer asked about, an idle release carrying a date — not only POSTPONED. An order that is both a
 *     promise and a ready retry is a promise.
 *  3. Edges: a date exactly NOW has arrived, one millisecond ahead has not (and is not pulled at all); a line at the date's own millisecond or after it ends the promise (the order falls back to its
 *     retry or rest place; a POSTPONED one the group leaves keeps today's step 3, ahead of the retries); a NEW order with a date is still NEW first.
 *  4. Every pool invariant holds: held for a colleague, decided, shipped, claimed, another store or company are never returned; the claim is the same compare-and-set (a lost race gives the next
 *     promise, never the same twice); at the hand cap the pick is not reached; the number the queue shows is what a drain hands out.
 *  5. The cadence OFF and the legacy returns mode run the SAME four queries as before and no other: `findMany` is never asked (byte for byte).
 *  6. The promise read is the two counter predicates (`readyToPullWhere` OR `duePostponedWhere`) narrowed to orders that carry a date, oldest-created first, bounded, ONE line per order. A FULL page
 *     (`RETRY_SCAN_PAGE`) says so once per scan in the log (`console.warn`, the page size and a fixed sentence, never a customer's name, phone or address); a page that is not full says nothing.
 *  7. A drain equals an independent model in hundreds of seeded random worlds (promises with ties and boundaries, lines before/at/after the date, retries, legacy, new, postponed, held for a colleague).
 *
 * Driven against an in-memory database that APPLIES the filters it is given (with SQL's three values), as the neighbouring pull tests do.
 * Blockers: no money, no order creation, no migration, no contract, no customer data to a model.
 * ═══════════════════════════════════════════════════════════════════════
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const { world, sw, cp } = vi.hoisted(() => ({
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
  // A read hands back COPIES, as Prisma does. Like the neighbouring doubles it IGNORES `select`: a row comes back whole, nested lines unfiltered and unsorted — so the promise rank must
  // read the lines itself (`promiseArrived` asks «any line at or after the date», which a whole history answers as the newest line does).
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
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return { db, default: db };
});
// The switches the pull reads before its transaction — the test says what they are. The cadence is `callProofSwitch`'s `{ enabled, enabledAt }`.
vi.mock('./no-answer-rounds-switch', () => ({ roundsSwitch: async () => sw.value }));
vi.mock('./no-answer-returns-switch', () => ({ returnsSwitch: async () => ({ enabled: false, enabledAt: null }) }));
vi.mock('./call-proof-switch', () => ({ callProofSwitch: async () => cp.value, callProofOn: async () => cp.value.enabled }));
vi.mock('./notification-audience', () => ({ resolveAudience: vi.fn(async () => []) }));

import {
  CLAIM_CAPS,
  RETRY_SCAN_PAGE,
  RETURNS_MODE,
  duePostponedWhere,
  heldForHerWhere,
  pickNextCandidate,
  pullNextOrder,
  readyToPullWhere,
  waitingCount,
} from './confirmation-queue';
import { firstPromiseByDate, returnsMode } from './no-answer-returns';
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
const LEGACY = returnsMode(NOW, clock, RETURNS_MODE.idleBusinessMinutes);
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
/** A line at an absolute instant, for the tests that place a press relative to a date. */
const lineAt = (at: Date, result = 'ANSWERED', n = 1): Row => ({ createdAt: at, result, nextFollowUpAt: null, employeeId: 'x', attemptNumber: n });

/** A returned order: rung, pressed «لا يرد», back in the pool with its due on the line (status stays IN_PROGRESS — `returnToThePool` keeps it). */
const retry = (dueInMinutes: number | null, over: Row = {}): Row =>
  order({
    confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS',
    contactAttempts: [line(1000, 'NO_ANSWER', dueInMinutes)],
    claimHistory: [{ action: 'CLAIMED' }, { action: 'RELEASED' }],
    ...over,
  });
/** A postponed promise: the customer's date `dateInMinutes` from NOW; the only line was logged long before it. */
const postponed = (dateInMinutes: number, over: Row = {}): Row =>
  order({
    confirmationStatus: 'POSTPONED', status: 'POSTPONED', postponedUntil: minutes(dateInMinutes), nextFollowUpAt: minutes(dateInMinutes),
    contactAttempts: [{ createdAt: hoursAgo(60), result: 'POSTPONED', nextFollowUpAt: null, employeeId: 'x', attemptNumber: 1 }], ...over,
  });
/** A follow-up the customer asked for (a callback): FOLLOW_UP_REQUIRED, its date `dateInMinutes` from NOW, the only line long before. */
const followUp = (dateInMinutes: number, over: Row = {}): Row =>
  order({
    confirmationStatus: 'FOLLOW_UP_REQUIRED', status: 'FOLLOW_UP_REQUIRED', nextFollowUpAt: minutes(dateInMinutes),
    contactAttempts: [{ createdAt: hoursAgo(60), result: 'CALLBACK_REQUESTED', nextFollowUpAt: minutes(dateInMinutes), employeeId: 'x', attemptNumber: 1 }], ...over,
  });
const byId = (id: string) => world.orders.find((r) => r.id === id)!;
const numbers = (ids: (string | null)[]) => ids.map((id) => (id ? byId(id).orderNumber : null));

type Mode = typeof CADENCE | null | undefined;
/** The mode is the cadence unless the test hands one in — an explicit `undefined` or `null` means «no mode», not «the default». */
const pick = (who = 'sara', ...mode: [Mode?]) => pickNextCandidate(db as never, scope, NOW, who, { returns: mode.length ? mode[0] : CADENCE });

/** What the pull would hand out next, one after another until the pool is dry — each order is marked taken while the loop runs. */
async function drain(who: string, ...mode: [Mode?]): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < 80; i++) {
    const id = await pick(who, ...(mode.length ? [mode[0]] : []) as [Mode?]);
    if (!id) break;
    out.push(id);
    byId(id).claimedById = 'taken';
  }
  return out;
}

beforeEach(() => {
  world.orders = [];
  world.users.clear();
  world.history = [];
  world.logs = [];
  seq = 0;
  sw.value = { enabled: false, enabledAt: null };
  cp.value = { enabled: true, enabledAt: SINCE };
  vi.clearAllMocks();
  for (const id of ['sara', 'huda', 'noor', 'abeer']) user(id);
});

describe('the ruling: NEW, then the promise, then the retries by due, then the rest by age', () => {
  it('the whole order in one world — and the promise whose date came first goes first, whatever the age of its order', async () => {
    const legacy = order({
      confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS', createdAt: hoursAgo(90),
      contactAttempts: [{ createdAt: hoursAgo(30), result: 'OPENED', nextFollowUpAt: null, employeeId: 'x', attemptNumber: 1 }],
    });
    const oldRetry = retry(-600, { createdAt: hoursAgo(200) });
    const youngRetry = retry(-10, { createdAt: hoursAgo(1) });
    const laterPromise = followUp(-30, { createdAt: hoursAgo(300) });
    const earlierPromise = postponed(-300, { createdAt: hoursAgo(5) });
    const fresh = order({ createdAt: hoursAgo(1) });
    const hers = order({ createdAt: hoursAgo(1), assignedToId: 'sara', assignedAt: hoursAgo(0.5), assignee: world.users.get('sara') });

    expect(await drain('sara')).toEqual([hers.id, fresh.id, earlierPromise.id, laterPromise.id, oldRetry.id, youngRetry.id, legacy.id]);
  });

  it('the control: without the cadence the same world is the old order — due postponed first, then the rest by age (no promise group, the follow-up is just old)', async () => {
    const older = followUp(-30, { createdAt: hoursAgo(300) });
    const retried = retry(-600, { createdAt: hoursAgo(200) });
    const dated = postponed(-300, { createdAt: hoursAgo(5) });

    expect(await drain('sara', LEGACY)).toEqual([dated.id, older.id, retried.id]);
    for (const o of world.orders) o.claimedById = null;
    expect(await drain('sara', null)).toEqual([dated.id, older.id, retried.id]);
  });

  it('a promise is ANY pullable status, not only POSTPONED: a follow-up, a returned retry the customer asked about, an idle release with a date', async () => {
    const control = retry(-5000, { createdAt: hoursAgo(500) }); // the oldest due of all: first, were there no promise rule
    const asked = retry(-1, { createdAt: hoursAgo(2), nextFollowUpAt: minutes(-20), postponedUntil: null }); // rung long before the date; due −1; the customer asked for −20
    asked.contactAttempts = [line(1000, 'NO_ANSWER', -990)]; // one old counted press, its due long past, before the date
    const idle = order({
      confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS', createdAt: hoursAgo(3), nextFollowUpAt: minutes(-50),
      contactAttempts: [{ createdAt: hoursAgo(40), result: 'OPENED', nextFollowUpAt: null, employeeId: 'x', attemptNumber: 1 }],
      claimHistory: [{ action: 'CLAIMED' }, { action: 'RELEASED' }],
    });
    const waiting = followUp(-100, { createdAt: hoursAgo(4) });

    // By the date that came first: the follow-up (−100), the idle release (−50), the returned retry the customer asked about (−20) — and the control retry, which has no date, last.
    expect(await drain('sara')).toEqual([waiting.id, idle.id, asked.id, control.id]);
  });

  it('an order that is BOTH a promise and a ready retry is a promise: it goes before a retry with an older due', async () => {
    const olderDue = retry(-5000, { createdAt: hoursAgo(400) });
    const both = order({
      confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS', createdAt: hoursAgo(1), postponedUntil: minutes(-20), nextFollowUpAt: minutes(-20),
      contactAttempts: [line(1000, 'NO_ANSWER', -990)],
    });

    expect(await pick('sara')).toBe(both.id);
    byId(both.id).claimedById = 'taken';
    expect(await pick('sara')).toBe(olderDue.id);
    // The control: take the date off and it is an ordinary retry — and now the older due wins.
    byId(both.id).claimedById = null;
    byId(both.id).postponedUntil = null;
    byId(both.id).nextFollowUpAt = null;
    expect(await pick('sara')).toBe(olderDue.id);
  });

  it('a NEW order with an arrived date is still NEW first — the 7/11 decision stands, and it is the oldest NEW that goes', async () => {
    const promise = postponed(-300, { createdAt: hoursAgo(500) });
    const freshDated = order({ createdAt: hoursAgo(2), nextFollowUpAt: minutes(-30) });
    const freshOlder = order({ createdAt: hoursAgo(9) });

    expect(await drain('sara')).toEqual([freshOlder.id, freshDated.id, promise.id]);
  });
});

describe('ties and edges of the promise', () => {
  it('equal date: the older order first; equal date and age: the smaller id', async () => {
    const young = postponed(-60, { id: 'm-young', createdAt: hoursAgo(5) });
    const old = followUp(-60, { id: 'm-old', createdAt: hoursAgo(20) });
    const mid = postponed(-60, { id: 'm-mid', createdAt: hoursAgo(10) });
    expect(await drain('sara')).toEqual([old.id, mid.id, young.id]);

    world.orders = [];
    const same = hoursAgo(7);
    postponed(-60, { id: 'z3', createdAt: same });
    followUp(-60, { id: 'z1', createdAt: same });
    postponed(-60, { id: 'z2', createdAt: same });
    expect(await drain('sara')).toEqual(['z1', 'z2', 'z3']);
  });

  it('the later of the two date columns is the ask: a stale postponement date beside a fresher follow-up date ranks by the fresher one', async () => {
    const stale = postponed(-500, { nextFollowUpAt: minutes(-10), createdAt: hoursAgo(1) }); // asked −10
    const plain = postponed(-100, { createdAt: hoursAgo(2) }); // asked −100
    expect(await drain('sara')).toEqual([plain.id, stale.id]);
  });

  it('a date exactly NOW is a promise (and is counted); one millisecond ahead is not pulled at all — and the number the queue shows is what a drain hands out', async () => {
    const exactlyNow = followUp(0, { createdAt: hoursAgo(10) });
    const earlier = postponed(-5, { createdAt: hoursAgo(3) });
    const notYet = followUp(0, { createdAt: hoursAgo(50), nextFollowUpAt: new Date(NOW.getTime() + 1) });
    const control = retry(-9000, { createdAt: hoursAgo(100) });

    const shown = await waitingCount(db as never, scope, NOW, 'sara', CADENCE);
    const pulled = await drain('sara');
    expect(pulled).toEqual([earlier.id, exactlyNow.id, control.id]);
    expect(pulled).toHaveLength(shown);
    expect(pulled).not.toContain(notYet.id);
  });

  it('a line logged at the date’s own millisecond, or after it, ends the promise: the order falls back to the retries; one millisecond before it, the promise stands', async () => {
    const date = minutes(-60);
    const make = (pressed: Date) =>
      order({
        confirmationStatus: 'FOLLOW_UP_REQUIRED', status: 'FOLLOW_UP_REQUIRED', nextFollowUpAt: date, createdAt: hoursAgo(1),
        contactAttempts: [lineAt(hoursAgo(60), 'CALLBACK_REQUESTED', 1), lineAt(pressed, 'OPENED', 2)],
      });
    const before = make(new Date(date.getTime() - 1));
    const at = make(date);
    const after = make(new Date(date.getTime() + 1));
    const control = retry(-9000, { createdAt: hoursAgo(100) });

    // `before` is the only promise. The other two are rung orders with no due line: the rest of the pool, after the retry, oldest-created first (a tie: the order they were stored in).
    expect(await drain('sara')).toEqual([before.id, control.id, at.id, after.id]);
  });

  it('a POSTPONED order the promise group leaves (a line was logged after its date) keeps today’s step 3: after the promises, ahead of the retries', async () => {
    const worked = postponed(-120, { createdAt: hoursAgo(50), contactAttempts: [lineAt(hoursAgo(60), 'POSTPONED'), lineAt(minutes(-100), 'ANSWERED', 2)] });
    const promise = followUp(-30, { createdAt: hoursAgo(1) });
    const control = retry(-9000, { createdAt: hoursAgo(100) });

    expect(await drain('sara')).toEqual([promise.id, worked.id, control.id]);
  });
});

describe('every pool invariant holds inside the promise group', () => {
  it('claimed by a colleague, shipped, decided, of another store or company, or held for a colleague: none of them; only the real promise', async () => {
    followUp(-100, { claimedById: 'huda', claimedAt: minutes(-5), currentOwnerId: 'huda' });
    followUp(-100, { shippingStatus: 'SHIPPED' });
    for (const status of ['CONFIRMED', 'REJECTED', 'CANCELLED']) followUp(-100, { confirmationStatus: status, status });
    followUp(-100, { companyId: 'c2' });
    followUp(-100, { storeId: 's2' });
    // A new-status order named for a colleague (his returning customer), carrying a date that arrived: held for him, not for her.
    order({ createdAt: hoursAgo(9), assignedToId: 'huda', assignedAt: minutes(-5), assignee: world.users.get('huda'), nextFollowUpAt: minutes(-100), contactAttempts: [lineAt(hoursAgo(60), 'CALLBACK_REQUESTED')] });
    const real = followUp(-50, { createdAt: hoursAgo(1) });

    expect(await waitingCount(db as never, scope, NOW, 'sara', CADENCE)).toBe(1);
    expect(await pick('sara')).toBe(real.id);
    byId(real.id).claimedById = 'taken';
    expect(await pick('sara')).toBeNull();
  });

  it('what is held for HER is still first of all — before a NEW order and before any promise', async () => {
    const promise = postponed(-300, { createdAt: hoursAgo(500) });
    const fresh = order({ createdAt: hoursAgo(9) });
    const hers = order({ createdAt: hoursAgo(1), assignedToId: 'sara', assignedAt: hoursAgo(0.5), assignee: world.users.get('sara'), nextFollowUpAt: minutes(-30), contactAttempts: [lineAt(hoursAgo(60), 'CALLBACK_REQUESTED')] });

    expect(await drain('sara')).toEqual([hers.id, fresh.id, promise.id]);
    // …and for the colleague, hers is not on offer at all.
    for (const o of world.orders) o.claimedById = null;
    expect(await drain('huda')).toEqual([fresh.id, promise.id]);
  });

  it('an order the plan still holds back is not pullable even when the customer’s date arrived: the plan’s own readiness is inside the group (pool readiness is unchanged)', async () => {
    // The customer's date arrived 5 minutes ago and the last press (30 minutes ago, before the date) says the next attempt counts in an hour: by the fact it is a promise, by the pool it is waiting.
    const waiting = order({
      confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS', createdAt: hoursAgo(6), nextFollowUpAt: minutes(-5),
      contactAttempts: [line(30, 'NO_ANSWER', 60, 1)],
    });
    const real = followUp(-10, { createdAt: hoursAgo(1) });
    expect(await waitingCount(db as never, scope, NOW, 'sara', CADENCE)).toBe(1);
    expect(await drain('sara')).toEqual([real.id]);
    expect(await pick('sara')).toBeNull();
    expect(byId(waiting.id).claimedById).toBeNull();
  });
});

/** The promise reads the pick made — the `findMany` whose select carries the order's dates and ONE newest line (the retry scan selects neither). */
const promiseScans = () => (db.order.findMany as unknown as Mock).mock.calls.filter((c) => c[0].select?.postponedUntil === true);

describe('through the pull: the claim is the same compare-and-set', () => {
  it('three pulls take the promises in order of their date, never the same order twice — then the retry', async () => {
    const p1 = followUp(-300, { createdAt: hoursAgo(1) });
    const p2 = postponed(-200, { createdAt: hoursAgo(2) });
    const p3 = followUp(-100, { createdAt: hoursAgo(3) });
    const r = retry(-5000, { createdAt: hoursAgo(500) });

    const got = [
      (await pullNextOrder(scope, agent('sara'), CAL, NOW)).orderId,
      (await pullNextOrder(scope, agent('huda'), CAL, NOW)).orderId,
      (await pullNextOrder(scope, agent('noor'), CAL, NOW)).orderId,
      (await pullNextOrder(scope, agent('abeer'), CAL, NOW)).orderId,
    ];
    expect(got).toEqual([p1.id, p2.id, p3.id, r.id]);
    expect(byId(p1.id).claimedById).toBe('sara');
    expect(byId(p2.id).confirmationStatus).toBe('IN_PROGRESS');
    expect((await pullNextOrder(scope, agent('sara'), CAL, NOW)).refusal?.code).toBeDefined();
  });

  it('a lost race re-reads: a colleague takes the top promise between the pick and the claim, and this pull gets the NEXT promise', async () => {
    const p1 = followUp(-300, { createdAt: hoursAgo(1) });
    const p2 = followUp(-200, { createdAt: hoursAgo(2) });
    (db.order.updateMany as unknown as Mock).mockImplementationOnce(async () => {
      byId(p1.id).claimedById = 'huda'; // the colleague's claim lands first
      return { count: 0 };
    });

    const out = await pullNextOrder(scope, agent('sara'), CAL, NOW);
    expect(out.orderId).toBe(p2.id);
    expect(byId(p1.id).claimedById).toBe('huda');
    expect(byId(p2.id).claimedById).toBe('sara');
    // The promise read ran once per attempt, and the lost order was not offered the second time.
    expect(promiseScans()).toHaveLength(2);
  });

  it('at the hand cap nothing is picked: the refusal comes before the pick, so no promise read is made', async () => {
    for (let i = 0; i < RETURNS_MODE.handLimit; i++) {
      order({ claimedById: 'sara', claimedAt: minutes(-5), currentOwnerId: 'sara', confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS', contactAttempts: [lineAt(minutes(-4), 'ANSWERED')] });
    }
    const promise = followUp(-100);
    const out = await pullNextOrder(scope, agent('sara'), CAL, NOW);
    expect(out.ok).toBe(false);
    expect(out.orderId).toBeUndefined();
    expect(out.refusal).toBeDefined();
    expect(byId(promise.id).claimedById).toBeNull();
    expect(promiseScans()).toHaveLength(0);
    expect(CLAIM_CAPS.total).toBeGreaterThan(RETURNS_MODE.handLimit);
  });
});

describe('OFF stays byte for byte: the four queries of today and no other', () => {
  it.each([
    ['no mode at all (undefined)', undefined],
    ['the mode read as off (null)', null],
    ['the legacy returns mode (no cadence key)', LEGACY],
  ])('%s: findMany is never asked (no promise read) and the four findFirst are the old ones, call for call', async (_label, returns) => {
    followUp(-100); // a promise world: the old queries must not care
    await pickNextCandidate(db as never, scope, NOW, 'sara', { returns });

    expect(db.order.findMany).not.toHaveBeenCalled();
    expect(db.order.count).not.toHaveBeenCalled();
    const calls = (db.order.findFirst as unknown as Mock).mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(4);
    const ready = (m: typeof LEGACY | null | undefined) => (m ? readyToPullWhere(scope, 'sara', NOW, m) : readyToPullWhere(scope, 'sara', NOW));
    const m = returns ?? undefined;
    expect(calls[0]).toEqual({ where: heldForHerWhere(scope, 'sara', NOW), orderBy: { createdAt: 'asc' }, select: { id: true } });
    expect(calls[1]).toEqual({ where: { ...ready(m), contactAttempts: { none: {} } }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    expect(calls[2]).toEqual({ where: m ? duePostponedWhere(scope, NOW, m) : duePostponedWhere(scope, NOW), orderBy: [{ postponedUntil: 'asc' }, { nextFollowUpAt: 'asc' }], select: { id: true } });
    expect(calls[3]).toEqual({ where: ready(m), orderBy: { createdAt: 'asc' }, select: { id: true } });
  });

  it('and the same world gives the OLD order without the cadence: a follow-up promise is not ahead of an older-created order', async () => {
    const olderRetry = retry(-30, { createdAt: hoursAgo(400) });
    const promise = followUp(-100, { createdAt: hoursAgo(1) });
    expect(await pick('sara', LEGACY)).toBe(olderRetry.id);
    expect(await pick('sara', null)).toBe(olderRetry.id);
    expect(await pick('sara', CADENCE)).toBe(promise.id);
  });
});

describe('the promise read: exactly this, bounded, one line per order — and a full page is said in the log', () => {
  it('it is the two counter predicates narrowed to a date, oldest-created first, bounded, with ONLY the newest line of each order', async () => {
    await pick('sara', CADENCE);
    const findMany = db.order.findMany as unknown as Mock;
    // The first read of the cadence pick (the second is the retry scan).
    const scan = findMany.mock.calls[0][0];
    expect(scan.where).toEqual({
      AND: [
        { OR: [readyToPullWhere(scope, 'sara', NOW, CADENCE), duePostponedWhere(scope, NOW, CADENCE)] },
        { OR: [{ postponedUntil: { not: null } }, { nextFollowUpAt: { not: null } }] },
      ],
    });
    expect(scan.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
    expect(scan.take).toBe(RETRY_SCAN_PAGE);
    expect(scan.select).toEqual({
      id: true, createdAt: true, postponedUntil: true, nextFollowUpAt: true,
      contactAttempts: { orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } },
    });
    // Both counter predicates are inside it, untouched: no second definition of «pullable» or of «held for a colleague».
    expect(scan.where.AND[0].OR).toHaveLength(2);
  });

  it('a page that is full says so ONCE with the page size and a fixed sentence — no name, no phone, no address — and the rank still comes from the page', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ids: string[] = [];
    for (let i = 0; i < RETRY_SCAN_PAGE; i++) {
      // Created oldest first; one date in every 50, so the page has a real best: date −50 → the first order carrying it (i = 49).
      const r = postponed(-(1 + (i % 50)), { createdAt: new Date(NOW.getTime() - (3_000_000 - i) * 1000), customer: { fullName: 'سارة', phone: '0791234567' } });
      ids.push(r.id);
    }
    const outside = postponed(-9999, { createdAt: new Date(NOW.getTime() - (3_000_000 - RETRY_SCAN_PAGE) * 1000) });

    try {
      const first = await pick('sara', CADENCE);
      expect(first).toBe(ids[49]);
      expect(first).not.toBe(outside.id);
      expect(warn).toHaveBeenCalledTimes(1);
      const said = String(warn.mock.calls[0][0]);
      expect(said).toContain(String(RETRY_SCAN_PAGE));
      expect(said).toContain('promise');
      for (const leak of ['سارة', '0791234567', 'o0001', 'ORD-']) expect(said).not.toContain(leak);
      expect(warn.mock.calls[0]).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('a page that is not full says nothing, and neither does the OFF pick', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      for (let i = 0; i < 30; i++) followUp(-(1 + i));
      await drain('sara');
      expect(warn).not.toHaveBeenCalled();
      for (const o of world.orders) o.claimedById = null;
      await drain('sara', LEGACY);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('firstPromiseByDate: the pure rank', () => {
  const row = (id: string, over: Row = {}) => ({ id, createdAt: hoursAgo(5), contactAttempts: [], ...over });

  it('the date that came first wins; equal date → the older order → the smaller id; a row that is no promise is skipped; none → null', () => {
    expect(firstPromiseByDate([row('a', { postponedUntil: minutes(-10) }), row('b', { postponedUntil: minutes(-20) })], NOW)).toBe('b');
    expect(firstPromiseByDate([row('a', { nextFollowUpAt: minutes(-10), createdAt: hoursAgo(1) }), row('b', { nextFollowUpAt: minutes(-10), createdAt: hoursAgo(9) })], NOW)).toBe('b');
    const same = hoursAgo(3);
    expect(firstPromiseByDate([row('b', { nextFollowUpAt: minutes(-10), createdAt: same }), row('a', { nextFollowUpAt: minutes(-10), createdAt: same })], NOW)).toBe('a');
    expect(firstPromiseByDate([row('worked', { postponedUntil: minutes(-30), contactAttempts: [{ createdAt: minutes(-30) }] }), row('ahead', { postponedUntil: minutes(30) }), row('none')], NOW)).toBeNull();
    expect(firstPromiseByDate([], NOW)).toBeNull();
  });

  it('dates and lines may be strings (a JSON row); the newest line alone answers as the whole history does', () => {
    const date = minutes(-30);
    const whole = [{ createdAt: hoursAgo(60) }, { createdAt: minutes(-31) }];
    expect(firstPromiseByDate([row('a', { postponedUntil: date.toISOString(), contactAttempts: whole.map((l) => ({ createdAt: l.createdAt.toISOString() })) })], NOW)).toBe('a');
    expect(firstPromiseByDate([row('a', { postponedUntil: date, contactAttempts: [whole[1]] })], NOW)).toBe('a');
    expect(firstPromiseByDate([row('a', { postponedUntil: date, contactAttempts: [{ createdAt: date }] })], NOW)).toBeNull();
  });
});

describe('a drain through the pick, in worlds nobody wrote by hand', () => {
  /** A tiny seeded generator, so a red run can be replayed. */
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }
  const pickOf = <T,>(next: () => number, xs: readonly T[]): T => xs[Math.floor(next() * xs.length)];
  const NA = ['NO_ANSWER', 'BUSY', 'UNREACHABLE'];

  /**
   * THE ORACLE, written the other way round: classify each order by its own facts, then sort by (step, key) — never calling the pull's rank or `promiseArrived`. Steps: 0 a NEW order (the oldest
   * first) · 1 the customer's PROMISE (the later date came first first, then the older order, then the id) · 2 a POSTPONED order the promise group leaves (today's step 3) · 3 the retries by
   * their latest due · 4 the rest by age. An order held for a colleague, or held back by a date or a plan due still ahead, is not pullable at all.
   */
  function expectedSequence(orders: Row[]): string[] {
    const ranked: { step: number; key: number[]; number: string }[] = [];
    orders.forEach((o, index) => {
      if (o.assignedToId === 'huda' && o.confirmationStatus === 'NEW') return; // held for a colleague
      const lines = o.contactAttempts as Row[];
      const holding = lines.filter((l) => NA.includes(l.result) && l.createdAt.getTime() > SINCE.getTime());
      if (holding.some((l) => l.nextFollowUpAt !== null && l.nextFollowUpAt.getTime() > NOW.getTime())) return; // a plan due still ahead holds the order
      const dates = [o.postponedUntil, o.nextFollowUpAt].filter((d: Date | null): d is Date => d !== null).map((d) => d.getTime());
      if (dates.some((d) => d > NOW.getTime())) return; // a date ahead holds it, whichever column carries it
      const asked = dates.length ? Math.max(...dates) : null;
      const worked = asked !== null && lines.some((l) => l.createdAt.getTime() >= asked);
      const promised = asked !== null && !worked;
      if (o.confirmationStatus === 'POSTPONED') {
        if (promised) ranked.push({ step: 1, key: [asked, o.createdAt.getTime(), index], number: o.orderNumber });
        else ranked.push({ step: 2, key: [o.postponedUntil.getTime(), o.nextFollowUpAt?.getTime() ?? Infinity, index], number: o.orderNumber });
        return;
      }
      if (lines.length === 0) {
        ranked.push({ step: 0, key: [o.createdAt.getTime(), index], number: o.orderNumber });
        return;
      }
      if (promised) {
        ranked.push({ step: 1, key: [asked, o.createdAt.getTime(), index], number: o.orderNumber });
        return;
      }
      const dues = holding.filter((l) => l.nextFollowUpAt !== null).map((l) => l.nextFollowUpAt.getTime() as number);
      if (dues.length) ranked.push({ step: 3, key: [Math.max(...dues), o.createdAt.getTime(), index], number: o.orderNumber });
      else ranked.push({ step: 4, key: [o.createdAt.getTime(), index], number: o.orderNumber });
    });
    ranked.sort((a, b) => a.step - b.step || a.key.reduce((d, k, i) => d || k - (b.key[i] ?? 0), 0));
    return ranked.map((r) => r.number);
  }

  it('equals the oracle in 400 random worlds: promises with ties and boundaries, lines before/at/after the date, retries, legacy, new, postponed, held for a colleague — and the number shown is the drain', async () => {
    const next = rng(20261115);
    // The customer's dates: well past, recent, exactly now (arrived), a millisecond ahead and an hour ahead (not arrived). Few values, so equal dates are common.
    const dates = [minutes(-300), minutes(-120), minutes(-30), minutes(-5), NOW, new Date(NOW.getTime() + 1), minutes(60)];
    const dues = [null, null, minutes(-1000), minutes(-600), minutes(-120), minutes(-1), NOW, new Date(NOW.getTime() + 1), minutes(60)];
    const results = [...NA, 'OPENED', 'CALLBACK_REQUESTED', 'ANSWERED'];
    const pressedAt = [new Date(SINCE.getTime() - 3_600_000), SINCE, new Date(SINCE.getTime() + 1), minutes(-2000), minutes(-1500), minutes(-1000)];
    let nonEmpty = 0;
    let promises = 0;

    for (let w = 0; w < 400; w++) {
      world.orders = [];
      seq = 0;
      const n = 1 + Math.floor(next() * 12);
      for (let i = 0; i < n; i++) {
        const roll = next();
        const createdAt = hoursAgo(10 + 5 * Math.floor(next() * 5));
        /** A press relative to a date: a millisecond before, at it, a millisecond after, long before. Never later than NOW (a press cannot be in the future). */
        const around = (date: Date): Date => {
          const t = pickOf(next, [date.getTime() - 1, date.getTime(), date.getTime() + 1, date.getTime() - 3_600_000, date.getTime() - 86_400_000]);
          return new Date(Math.min(t, NOW.getTime()));
        };
        const someLines = (date: Date | null): Row[] =>
          Array.from({ length: 1 + Math.floor(next() * 3) }, (_, j) => ({
            createdAt: date && next() < 0.7 ? around(date) : pickOf(next, pressedAt),
            result: pickOf(next, results), nextFollowUpAt: pickOf(next, dues), employeeId: 'x', attemptNumber: j + 1,
          }));
        const date = pickOf(next, dates);
        if (roll < 0.1) order({ createdAt, ...(next() < 0.5 ? { nextFollowUpAt: date } : {}) }); // a NEW order, sometimes carrying a date
        else if (roll < 0.2) {
          order({
            createdAt, assignedToId: 'huda', assignedAt: minutes(-5), assignee: world.users.get('huda'),
            ...(next() < 0.6 ? { nextFollowUpAt: date, contactAttempts: someLines(date) } : {}),
          });
        } else if (roll < 0.45) {
          const later = next() < 0.2 ? { nextFollowUpAt: new Date(date.getTime() + 600_000) } : { nextFollowUpAt: date };
          postponed(0, { createdAt, postponedUntil: date, ...later, contactAttempts: [lineAt(hoursAgo(60), 'POSTPONED'), ...(next() < 0.6 ? someLines(date) : [])] });
        } else if (roll < 0.65) {
          order({ createdAt, confirmationStatus: 'FOLLOW_UP_REQUIRED', status: 'FOLLOW_UP_REQUIRED', nextFollowUpAt: date, contactAttempts: [lineAt(hoursAgo(60), 'CALLBACK_REQUESTED'), ...(next() < 0.6 ? someLines(date) : [])] });
        } else {
          const dated = next() < 0.35;
          order({
            createdAt, confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS',
            ...(dated ? (next() < 0.5 ? { postponedUntil: date, nextFollowUpAt: date } : { nextFollowUpAt: date }) : {}),
            contactAttempts: someLines(dated ? date : null),
          });
        }
      }
      const expected = expectedSequence(world.orders);
      const ids = await drain('sara');
      expect(numbers(ids), `world ${w}`).toEqual(expected);
      if (expected.length > 0) nonEmpty++;
      // …and the number shown is what the drain handed out.
      for (const o of world.orders) o.claimedById = null;
      expect(await waitingCount(db as never, scope, NOW, 'sara', CADENCE), `world ${w} (the number)`).toBe(expected.length);
      promises += ids.filter((id) => byId(id).postponedUntil || byId(id).nextFollowUpAt).length;
    }
    // The generator must have produced real work and real promises, or the property proves nothing.
    expect(nonEmpty).toBeGreaterThan(300);
    expect(promises).toBeGreaterThan(400);
  });
});
