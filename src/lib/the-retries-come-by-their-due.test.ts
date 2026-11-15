import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE DUE RETRIES ARE PULLED BY THEIR DUE INSTANT (the planner's ruling 2, step B)
 *
 * «الإعادات اللي حان موعدها بتترتّب بالموعد»: with the five-attempt cadence ON, among the ready orders that WERE rung, the pull gives first the retry whose due —
 * the instant its last counted «لا يرد» made it due — is the oldest (a tie: the older order, then the smaller id). Then the rest, oldest first, as ever.
 *
 *  1. Under the cadence: held for her · a NEW order · the customer's PROMISE whose date arrived (any status — widened by the planner 15/11, ruling 13; its own file:
 *     `the-promise-comes-before-the-retries.test.ts`) · the retry with the OLDEST due · the rest oldest-created first. Nothing above the retries moves (the owner, 7/11:
 *     «الأولوية دائما للطلبات الجديدة»).
 *  2. A retry is ranked by the due of its LAST counted line; an early press and the fifth (no due) change nothing; a line at or before the floor, a callback and every
 *     other result never rank. An order with no due line (legacy return, an idle release) keeps today's oldest-first place, after the retries.
 *  3. A due exactly NOW is ranked; a due one millisecond ahead is not pulled at all — and the number the queue shows is what a drain of the pull hands out.
 *  4. The cadence OFF, and the legacy returns mode, run the SAME four queries as before and no other (`findMany` is never asked): byte for byte.
 *  5. The retry read the cadence makes is `readyToPullWhere` + one `some`, oldest-created first, bounded by `RETRY_SCAN_PAGE` (it comes after the promise read); a FULL page is said once in the log.
 *  6. The claim is the same compare-and-set: a lost race re-reads and gives the next due, never the same order twice; an order a colleague holds, a shipped, a decided
 *     or a foreign one with an overdue due is never returned.
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
  RETRY_SCAN_PAGE,
  RETURNS_MODE,
  duePostponedWhere,
  heldForHerWhere,
  pickNextCandidate,
  pullNextOrder,
  readyToPullWhere,
  waitingCount,
} from './confirmation-queue';
import { cadenceDueLineWhere, returnsMode } from './no-answer-returns';
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
const numbers = (ids: (string | null)[]) => ids.map((id) => (id ? byId(id).orderNumber : null));

type Mode = typeof CADENCE | null | undefined;
/** The mode is the cadence unless the test hands one in — an explicit `undefined` or `null` means «no mode», not «the default». */
const pick = (who = 'sara', ...mode: [Mode?]) => pickNextCandidate(db as never, scope, NOW, who, { returns: mode.length ? mode[0] : CADENCE });

/** What the pull would hand out next, one after another until the pool is dry — each order is marked taken while the loop runs. */
async function drain(who: string, ...mode: [Mode?]): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < 60; i++) {
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

describe('the ruling: of two ready retries, the one with the OLDER DUE comes first — not the older order', () => {
  it('the retry that became due first is pulled first even when its order is the younger', async () => {
    const olderOrder = retry(-30, { createdAt: hoursAgo(50) });
    const youngerOrder = retry(-200, { createdAt: hoursAgo(5) });

    expect(await pick()).toBe(youngerOrder.id);
    byId(youngerOrder.id).claimedById = 'huda';
    expect(await pick()).toBe(olderOrder.id);
    byId(olderOrder.id).claimedById = 'huda';
    expect(await pick()).toBeNull();
  });

  it('the control: the same world WITHOUT the cadence is the oldest-created order first, as it always was', async () => {
    const olderOrder = retry(-30, { createdAt: hoursAgo(50) });
    const youngerOrder = retry(-200, { createdAt: hoursAgo(5) });

    expect(await pick('sara', LEGACY)).toBe(olderOrder.id);
    expect(await pick('sara', null)).toBe(olderOrder.id);
    expect(await pick('sara', undefined)).toBe(olderOrder.id);
    byId(olderOrder.id).claimedById = 'huda';
    expect(await pick('sara', LEGACY)).toBe(youngerOrder.id);
  });
});

describe('what is above the retries does not move', () => {
  it('a NEW order, created later than an overdue retry, still comes first; the retry comes after it is taken', async () => {
    const overdue = retry(-600, { createdAt: hoursAgo(100) });
    const fresh = order({ createdAt: hoursAgo(1) });

    expect(await pick()).toBe(fresh.id);
    byId(fresh.id).claimedById = 'huda';
    expect(await pick()).toBe(overdue.id);
  });

  it('held for her first of all, then a new order, then a due promise, and only then the most overdue retry', async () => {
    const overdue = retry(-9000, { createdAt: hoursAgo(300) });
    const due = promise({ createdAt: hoursAgo(80) });
    const fresh = order({ createdAt: hoursAgo(1) });
    const hers = order({ createdAt: hoursAgo(1), assignedToId: 'sara', assignedAt: hoursAgo(0.5), assignee: world.users.get('sara') });

    const sequence: string[] = [];
    for (let i = 0; i < 4; i++) {
      const id = await pick();
      expect(id).not.toBeNull();
      sequence.push(id!);
      byId(id!).claimedById = 'taken';
    }
    expect(sequence).toEqual([hers.id, fresh.id, due.id, overdue.id]);
  });
});

describe('equal dues — the norm for the next-day-morning instant', () => {
  it('equal due: the older order first; equal due and equal age: the smaller id', async () => {
    const youngest = retry(-60, { id: 'm-young', createdAt: hoursAgo(5) });
    const oldest = retry(-60, { id: 'm-old', createdAt: hoursAgo(20) });
    const middle = retry(-60, { id: 'm-mid', createdAt: hoursAgo(10) });
    expect(await drain('sara')).toEqual([oldest.id, middle.id, youngest.id]);

    world.orders = [];
    const same = hoursAgo(7);
    retry(-60, { id: 'z3', createdAt: same });
    retry(-60, { id: 'z1', createdAt: same });
    retry(-60, { id: 'z2', createdAt: same });
    expect(await drain('sara')).toEqual(['z1', 'z2', 'z3']);
  });
});

describe('the boundary of ready is the boundary of the rank', () => {
  it('a due exactly NOW is ranked; a due one millisecond ahead is not pulled at all — and the number shown is what a drain hands out', async () => {
    const dueNow = retry(0, { createdAt: hoursAgo(10) });
    const earlier = retry(-5, { createdAt: hoursAgo(3) });
    const notYet = retry(null, { createdAt: hoursAgo(50), contactAttempts: [{ ...line(1000, 'NO_ANSWER', null), nextFollowUpAt: new Date(NOW.getTime() + 1) }] });
    const fresh = order({ createdAt: hoursAgo(1) });

    const shown = await waitingCount(db as never, scope, NOW, 'sara', CADENCE);
    const pulled = await drain('sara');
    // Three are ready (the new order, the retry due 5 minutes ago, the one due exactly now); the one due in a millisecond is held and never pulled.
    expect(pulled).toEqual([fresh.id, earlier.id, dueNow.id]);
    expect(pulled).toHaveLength(shown);
    expect(pulled).not.toContain(notYet.id);
  });
});

describe('an order is ranked by the due of its LAST counted press', () => {
  it('lines due long ago and recently rank by the recent one: an order with an in-between due goes first', async () => {
    // X was due at -300, was pressed again and is now due at -20 (dues grow with every counted press). Y has one line due at -100.
    const x = order({
      confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS', createdAt: hoursAgo(100),
      contactAttempts: [line(1500, 'NO_ANSWER', -300, 1), line(290, 'BUSY', -20, 2)],
    });
    const y = retry(-100, { createdAt: hoursAgo(1) });
    expect(await drain('sara')).toEqual([y.id, x.id]);
  });

  it('an early press (no due) after a counted one, and a fifth press (no due), change nothing: the last NON-null due ranks', async () => {
    const early = order({
      confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS', createdAt: hoursAgo(1),
      contactAttempts: [line(1000, 'NO_ANSWER', -200, 1), line(50, 'NO_ANSWER', null, 2)],
    });
    const fifth = order({
      confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS', createdAt: hoursAgo(2),
      contactAttempts: [line(1800, 'NO_ANSWER', -300, 1), line(1500, 'BUSY', -250, 2), line(900, 'UNREACHABLE', -250, 3), line(600, 'NO_ANSWER', -250, 4), line(30, 'NO_ANSWER', null, 5)],
    });
    const control = retry(-100, { createdAt: hoursAgo(100) });
    // fifth (-250) < early (-200) < control (-100). A reading that took the LAST line's null would drop both of them behind the control.
    expect(await drain('sara')).toEqual([fifth.id, early.id, control.id]);
  });

  it('a «لا يرد» line logged at or before the floor is not a retry: the order falls to the oldest-first group, behind a younger real retry', async () => {
    const preFloor = order({
      confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS', createdAt: hoursAgo(200),
      contactAttempts: [{ createdAt: new Date(SINCE.getTime() - 3_600_000), result: 'NO_ANSWER', nextFollowUpAt: minutes(-500), employeeId: 'x', attemptNumber: 1 }],
    });
    const atFloor = order({
      confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS', createdAt: hoursAgo(190),
      contactAttempts: [{ createdAt: SINCE, result: 'NO_ANSWER', nextFollowUpAt: minutes(-600), employeeId: 'x', attemptNumber: 1 }],
    });
    const real = retry(-10, { createdAt: hoursAgo(1) });
    expect(await drain('sara')).toEqual([real.id, preFloor.id, atFloor.id]);
  });
});

describe('the rest of the rung orders keep today’s place: after the retries, oldest-created first', () => {
  it('a promise whose date arrived comes BEFORE every retry (the planner 15/11, ruling 13); a legacy return (no date, no due) stays after them', async () => {
    const legacy = order({
      confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS', createdAt: hoursAgo(60),
      contactAttempts: [{ createdAt: hoursAgo(30), result: 'OPENED', nextFollowUpAt: null, employeeId: 'x', attemptNumber: 1 }],
    });
    const followUp = order({
      confirmationStatus: 'FOLLOW_UP_REQUIRED', status: 'FOLLOW_UP_REQUIRED', createdAt: hoursAgo(80), nextFollowUpAt: minutes(-60),
      contactAttempts: [{ createdAt: hoursAgo(40), result: 'CALLBACK_REQUESTED', nextFollowUpAt: minutes(-60), employeeId: 'x', attemptNumber: 1 }],
    });
    const youngRetry = retry(-10, { createdAt: hoursAgo(1) });
    const oldRetry = retry(-5, { createdAt: hoursAgo(300) });
    // The follow-up is the customer's promise (its date arrived, nothing logged since): first. Then the retries by their due (-10 before -5), then the legacy return.
    expect(await drain('sara')).toEqual([followUp.id, youngRetry.id, oldRetry.id, legacy.id]);
  });
});

describe('the pull of the rest, in worlds nobody wrote by hand', () => {
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
   * THE ORACLE, written the other way round: classify each order by its own facts, then sort by (step, key) — never calling the pull's rank. Steps: 0 a NEW order · 1 the customer's PROMISE (a date
   * arrived, no line at or after the later date; the date that came first first, then the older order) · 2 a postponed order the promise group leaves (a line was logged after its date) · 3 the
   * retries by due · 4 the rest by age.
   */
  function expectedSequence(orders: Row[]): string[] {
    const ranked: { step: number; key: number[]; number: string }[] = [];
    orders.forEach((o, index) => {
      const holding = (o.contactAttempts as Row[]).filter((l) => NA.includes(l.result) && l.createdAt.getTime() > SINCE.getTime());
      if (holding.some((l) => l.nextFollowUpAt !== null && l.nextFollowUpAt.getTime() > NOW.getTime())) return; // a due still ahead holds the order
      const dates = [o.postponedUntil, o.nextFollowUpAt].filter((d: Date | null): d is Date => d !== null).map((d) => d.getTime());
      const asked = dates.length ? Math.max(...dates) : null;
      const worked = asked !== null && (o.contactAttempts as Row[]).some((l) => l.createdAt.getTime() >= asked);
      if (o.confirmationStatus === 'POSTPONED') {
        if (o.postponedUntil.getTime() > NOW.getTime()) return;
        if (asked !== null && !worked) ranked.push({ step: 1, key: [asked, o.createdAt.getTime(), index], number: o.orderNumber });
        else ranked.push({ step: 2, key: [o.postponedUntil.getTime(), index], number: o.orderNumber });
        return;
      }
      if (dates.some((d) => d > NOW.getTime())) return; // a date ahead holds it
      if (o.contactAttempts.length === 0) {
        ranked.push({ step: 0, key: [o.createdAt.getTime(), index], number: o.orderNumber });
        return;
      }
      if (asked !== null && !worked) {
        ranked.push({ step: 1, key: [asked, o.createdAt.getTime(), index], number: o.orderNumber });
        return;
      }
      const dues = holding.filter((l) => l.nextFollowUpAt !== null).map((l) => l.nextFollowUpAt.getTime() as number);
      // 4a: the retries (by the latest due, then age, then id = insertion order); 4b: the rest by age (a tie: the order they were stored in, as the double sorts).
      if (dues.length) ranked.push({ step: 3, key: [Math.max(...dues), o.createdAt.getTime(), index], number: o.orderNumber });
      else ranked.push({ step: 4, key: [o.createdAt.getTime(), index], number: o.orderNumber });
    });
    ranked.sort((a, b) => a.step - b.step || a.key.reduce((d, k, i) => d || k - (b.key[i] ?? 0), 0));
    return ranked.map((r) => r.number);
  }

  it('a drain through the pick equals the oracle in hundreds of random worlds (retries with ties and boundaries, legacy, promises, new, postponed)', async () => {
    const next = rng(20261115);
    const pressedAt = [new Date(SINCE.getTime() - 3_600_000), SINCE, new Date(SINCE.getTime() + 1), minutes(-2000), minutes(-1500), minutes(-1000)];
    const dues = [null, null, minutes(-1000), minutes(-600), minutes(-120), minutes(-1), NOW, new Date(NOW.getTime() + 1), minutes(60)];
    const results = [...NA, 'OPENED', 'CALLBACK_REQUESTED'];
    let nonEmpty = 0;

    for (let w = 0; w < 400; w++) {
      world.orders = [];
      seq = 0;
      const n = 1 + Math.floor(next() * 12);
      for (let i = 0; i < n; i++) {
        const roll = next();
        // Ages come from a small set, so equal ages (and, with the dues below, equal ranks) are common.
        const createdAt = hoursAgo(10 + 5 * Math.floor(next() * 5));
        const lines = (): Row[] =>
          Array.from({ length: 1 + Math.floor(next() * 4) }, (_, j) => ({
            createdAt: pickOf(next, pressedAt), result: pickOf(next, results), nextFollowUpAt: pickOf(next, dues), employeeId: 'x', attemptNumber: j + 1,
          }));
        if (roll < 0.15) order({ createdAt });
        else if (roll < 0.35) {
          const extra = next() < 0.3 ? [{ createdAt: pickOf(next, pressedAt), result: pickOf(next, NA), nextFollowUpAt: pickOf(next, dues), employeeId: 'x', attemptNumber: 2 }] : [];
          promise({
            createdAt, postponedUntil: next() < 0.25 ? minutes(60) : minutes(-5 - 30 * Math.floor(next() * 6)),
            contactAttempts: [{ createdAt: hoursAgo(60), result: 'POSTPONED', nextFollowUpAt: null, employeeId: 'x', attemptNumber: 1 }, ...extra],
          });
        } else if (roll < 0.85) order({ createdAt, confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS', contactAttempts: lines() });
        else {
          order({
            createdAt, confirmationStatus: 'FOLLOW_UP_REQUIRED', status: 'FOLLOW_UP_REQUIRED', nextFollowUpAt: next() < 0.3 ? minutes(30) : minutes(-30),
            contactAttempts: lines(),
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
    }
    // The generator must have produced real work, or the property proves nothing.
    expect(nonEmpty).toBeGreaterThan(300);
  });
});

describe('OFF stays byte for byte: the four queries of today and no other', () => {
  it.each([
    ['no mode at all (undefined)', undefined],
    ['the mode read as off (null)', null],
    ['the legacy returns mode (no cadence key)', LEGACY],
  ])('%s: findMany is never asked and the four findFirst are the old ones, call for call', async (_label, returns) => {
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
    // The mode itself never gained a key for the cadence.
    if (returns) expect(Object.keys(returns)).not.toContain('cadence');
  });

  it('the pull’s own path (heldForHerAsked) is the same three: findMany stays untouched', async () => {
    await pickNextCandidate(db as never, scope, NOW, 'sara', { heldForHerAsked: true, returns: LEGACY });
    expect(db.order.findMany).not.toHaveBeenCalled();
    expect(db.order.findFirst).toHaveBeenCalledTimes(3);
  });
});

describe('the cadence ON: the retry read is exactly this one (it follows the promise read: `the-promise-comes-before-the-retries.test.ts`)', () => {
  it('with no promise and no due line anywhere it asks twice — the promise read, then this one, both empty — and then today’s step 4 gives the answer OFF would give', async () => {
    // An order that was rung, but whose lines carry no due: a legacy return.
    const legacy = order({
      confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS', createdAt: hoursAgo(30),
      contactAttempts: [{ createdAt: hoursAgo(20), result: 'OPENED', nextFollowUpAt: null, employeeId: 'x', attemptNumber: 1 }],
    });
    const findMany = db.order.findMany as unknown as Mock;
    const findFirst = db.order.findFirst as unknown as Mock;

    expect(await pick('sara', CADENCE)).toBe(legacy.id);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(await findMany.mock.results[0].value).toEqual([]);
    expect(await findMany.mock.results[1].value).toEqual([]);
    expect(findFirst).toHaveBeenCalledTimes(4);
    // The promise read runs after the NEW query and before step 3; the retry scan after step 3 and before the last query.
    expect(findMany.mock.invocationCallOrder[0]).toBeGreaterThan(findFirst.mock.invocationCallOrder[1]);
    expect(findMany.mock.invocationCallOrder[0]).toBeLessThan(findFirst.mock.invocationCallOrder[2]);
    expect(findMany.mock.invocationCallOrder[1]).toBeGreaterThan(findFirst.mock.invocationCallOrder[2]);
    expect(findMany.mock.invocationCallOrder[1]).toBeLessThan(findFirst.mock.invocationCallOrder[3]);
    // OFF gives the same order.
    expect(await pick('sara', LEGACY)).toBe(legacy.id);
  });

  it('the read is `readyToPullWhere` plus one `some`, oldest-created first, bounded — the counters’ own predicate', async () => {
    await pick('sara', CADENCE);
    const findMany = db.order.findMany as unknown as Mock;
    expect(findMany).toHaveBeenCalledTimes(2);
    // The second read of the pick (the first is the promise scan).
    const scan = findMany.mock.calls[1][0];
    expect(scan.where).toEqual({ ...readyToPullWhere(scope, 'sara', NOW, CADENCE), contactAttempts: { some: cadenceDueLineWhere(SINCE) } });
    expect(scan.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
    expect(scan.take).toBe(RETRY_SCAN_PAGE);
    expect(RETRY_SCAN_PAGE).toBe(2000);
    expect(scan.select).toEqual({
      id: true, createdAt: true,
      contactAttempts: { where: cadenceDueLineWhere(SINCE), select: { result: true, createdAt: true, nextFollowUpAt: true } },
    });
    // Everything but the added `some` is what the counter asks: no second definition of «ready».
    const rest = { ...scan.where };
    delete rest.contactAttempts;
    expect(rest).toEqual(readyToPullWhere(scope, 'sara', NOW, CADENCE));
  });

  it('a pile past the page ranks its OLDEST-CREATED page (the documented degrade): the most overdue one outside the page waits its turn', async () => {
    const ids: string[] = [];
    for (let i = 0; i < RETRY_SCAN_PAGE; i++) {
      // Created oldest first; dues repeat every 50 orders, so the page has a real best: due -50 → the first order that carries it (i = 49).
      const r = retry(-(1 + (i % 50)), { createdAt: new Date(NOW.getTime() - (3_000_000 - i) * 1000) });
      ids.push(r.id);
    }
    const outside = retry(-9999, { createdAt: new Date(NOW.getTime() - (3_000_000 - RETRY_SCAN_PAGE) * 1000) });
    // A full page is said in the log (the planner 15/11, ruling 10) — silenced here, asserted below.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const first = await pick('sara', CADENCE);
      expect(first).toBe(ids[49]);
      expect(first).not.toBe(outside.id);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(String(RETRY_SCAN_PAGE));
      // Once one is taken the page has room again: the order that was outside is read, and as the most overdue of all it comes next.
      byId(ids[49]).claimedById = 'taken';
      expect(await pick('sara', CADENCE)).toBe(outside.id);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('through the pull: the claim is the same compare-and-set', () => {
  it('three pulls take the dues in order, never the same order twice', async () => {
    const r1 = retry(-300, { createdAt: hoursAgo(1) });
    const r2 = retry(-200, { createdAt: hoursAgo(2) });
    const r3 = retry(-100, { createdAt: hoursAgo(3) });

    const got = [
      (await pullNextOrder(scope, agent('sara'), CAL, NOW)).orderId,
      (await pullNextOrder(scope, agent('huda'), CAL, NOW)).orderId,
      (await pullNextOrder(scope, agent('noor'), CAL, NOW)).orderId,
    ];
    expect(got).toEqual([r1.id, r2.id, r3.id]);
    expect(byId(r1.id).claimedById).toBe('sara');
    const again = await pullNextOrder(scope, agent('abeer'), CAL, NOW);
    expect(again.ok).toBe(false);
    expect(again.refusal?.code).toBe('QUEUE_EMPTY');
  });

  it('a lost race re-reads: a colleague takes the top retry between the pick and the claim, and this pull gets the NEXT due', async () => {
    const r1 = retry(-300, { createdAt: hoursAgo(1) });
    const r2 = retry(-200, { createdAt: hoursAgo(2) });
    const r3 = retry(-100, { createdAt: hoursAgo(3) });
    (db.order.updateMany as unknown as Mock).mockImplementationOnce(async () => {
      byId(r1.id).claimedById = 'huda'; // the colleague's claim lands first
      return { count: 0 };
    });

    const out = await pullNextOrder(scope, agent('sara'), CAL, NOW);
    expect(out.orderId).toBe(r2.id);
    expect(byId(r1.id).claimedById).toBe('huda');
    expect(byId(r2.id).claimedById).toBe('sara');
    // The scan ran twice (once per attempt) and the lost order was not offered the second time.
    const scans = (db.order.findMany as unknown as Mock).mock.calls.filter((c) => c[0].where?.contactAttempts?.some);
    expect(scans).toHaveLength(2);
    expect((await pullNextOrder(scope, agent('noor'), CAL, NOW)).orderId).toBe(r3.id);
  });
});

describe('an order that is not takeable is never returned, however overdue its due', () => {
  it('claimed by a colleague, shipped, decided, of another store or company, or held for a colleague: none of them; only the real one', async () => {
    const overdue = [line(1000, 'NO_ANSWER', -500)];
    retry(-500, { claimedById: 'huda', claimedAt: minutes(-5), currentOwnerId: 'huda' });
    retry(-500, { shippingStatus: 'SHIPPED' });
    for (const status of ['CONFIRMED', 'REJECTED', 'CANCELLED']) retry(-500, { confirmationStatus: status, status });
    retry(-500, { companyId: 'c2' });
    retry(-500, { storeId: 's2' });
    // A new-status order named for a colleague (his returning customer), carrying an overdue line: held for him, not for her.
    order({ createdAt: hoursAgo(9), assignedToId: 'huda', assignedAt: minutes(-5), assignee: world.users.get('huda'), contactAttempts: overdue });
    const real = retry(-50, { createdAt: hoursAgo(1) });

    expect(await waitingCount(db as never, scope, NOW, 'sara', CADENCE)).toBe(1);
    expect(await pick('sara', CADENCE)).toBe(real.id);
    byId(real.id).claimedById = 'taken';
    expect(await pick('sara', CADENCE)).toBeNull();
  });
});
