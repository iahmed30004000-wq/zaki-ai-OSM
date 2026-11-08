import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — «الشغل أول» AT THE PULL (the owner, 8/11)
 *
 * «لازم تجبرها ترن ع طلبات لا يرد، ما تقدر تسحب طلب جديد قبل ما ترن».
 *
 *  1. The pull refuses `WORK_FIRST` while she holds an order she owes a call on (`work-first.ts`): the sentence says how many,
 *     the refusal carries the OLDEST one's id and number, nothing is taken, nothing is written.
 *  2. After every refusal the pull already had — the cap, the untouched order (which keeps winning for a fresh pull) — and
 *     before anything is picked. And BEFORE the pace (#224): forty pulls this hour with a call owed is WORK_FIRST, the sentence
 *     she can act on; with nothing owed it is PULL_TOO_FAST. The order is: caps · untouched order · WORK_FIRST · the pace.
 *  3. Only «نظام الجولات» on. Off, the pull is today's.
 *  4. The first deploy must not wall a desk that already holds a pile: an order the next release pass will take is not owed.
 *  5. Cheap: one read of her held orders however many there are; nothing per order.
 *  6. Claim-by-id, «الزبون على الخط» and transfers do not ask it.
 *
 * Driven against an in-memory database that APPLIES the filters (with SQL's three values), so the answer comes from the
 * filter's own text and not from a mock that was told it — the same approach as `new-orders-first-and-a-cap-of-five-hundred.test.ts`.
 *
 * Blockers: no money, no permission, no order creation, no migration.
 * ═══════════════════════════════════════════════════════════════════════
 */

// A fake database row: its values are read by the filter operators below, whatever their type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const { world, sw } = vi.hoisted(() => ({
  world: { orders: [] as Row[], users: new Map<string, Row>(), history: [] as Row[], logs: [] as Row[], clock: new Date('2026-11-07T12:00:00.000Z') },
  sw: { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } },
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
            // The rounds release carries a cursor between passes (`id: { gt }`): an id is compared as text, a date as an instant.
            case 'gt': return value === null ? null : typeof value === 'string' ? value > (arg as string) : (value as Date).getTime() > (arg as Date).getTime();
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
  // A read hands back COPIES, as Prisma does (see the harness this one is copied from).
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
    // `findMany` is the pace limit's read of her pulls of the last hour (#224, inside the pull's transaction). The `where` is APPLIED to
    // `world.history` — a test that wants her to have pulled forty times writes forty lines, and the answer comes from the query's own
    // text (her `userId`, `CLAIMED`, `PULL_NEXT`, newer than the window), not from a mock that was told it. A line the pull writes
    // carries the pull's clock, as the database's default would.
    orderClaimHistory: {
      create: vi.fn(async ({ data }: Row) => void world.history.push({ createdAt: world.clock, ...data })),
      findMany: vi.fn(async ({ where, select }: Row) =>
        world.history
          .filter((h) => matches(h, where ?? {}))
          .map((h) => (select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, h[k] ?? null])) : { ...h }))
      ),
    },
    notification: { createMany: vi.fn(async () => ({ count: 1 })) },
    orderStatusLog: { create: vi.fn(async ({ data }: Row) => void world.logs.push(data)) },
    orderActivity: { create: vi.fn(async () => undefined) },
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return { db, default: db };
});
// The switch the pull reads before its transaction — the test says what it is.
vi.mock('./no-answer-rounds-switch', () => ({ roundsSwitch: async () => sw.value }));

import { CLAIM_CAPS, OPEN_CONFIRMATION, PULL_PACE, pullNextOrder, pullRefusal } from './confirmation-queue';
import { ROUNDS_OFF, type RoundsSwitch } from './no-answer-rounds';
import { workFirstGate } from './work-first';
import { zonedTimeToInstant } from './business-calendar';
import { db } from './db';

const NOW = world.clock;
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const hoursAgo = (h: number) => minutesAgo(h * 60);
const hoursAhead = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
const scope = { companyId: 'c1', storeId: 's1' };
/** Around the clock, every day: working minutes are minutes, so the numbers below are the owner's numbers as they read. */
const CAL = { workHoursStart: '00:00', workHoursEnd: '23:59', weekendDays: [] as number[], timezone: 'UTC' };
const agent = (id: string) => ({ id, role: 'CONFIRMATION_AGENT' });
const ON: RoundsSwitch = { enabled: true, enabledAt: hoursAgo(24 * 30) };

let seq = 0;
/** An order in the pool: nobody holds it and nobody has rung it. */
const order = (over: Row = {}): Row => {
  seq += 1;
  const r: Row = {
    id: `o${String(seq).padStart(4, '0')}`, orderNumber: `ORD-${seq}`, ...scope, customerId: `cust${seq}`,
    confirmationStatus: 'NEW', status: 'NEW', shippingStatus: 'NOT_READY',
    claimedById: null, claimedAt: null, currentOwnerId: null,
    assignedToId: null, assignedAt: null, assignee: null,
    postponedUntil: null, nextFollowUpAt: null,
    createdAt: hoursAgo(50), version: 1, contactAttempts: [], claimHistory: [],
    ...over,
  };
  world.orders.push(r);
  return r;
};
/** «اتصل» a minute before, then «لا يرد» — one real call, by `who`. */
const call = (at: Date, who = 'sara'): Row[] => [
  { createdAt: new Date(at.getTime() - 60_000), result: 'OPENED', employeeId: who, attemptNumber: 1 },
  { createdAt: at, result: 'NO_ANSWER', employeeId: who, attemptNumber: 2 },
];
/** An order Sara holds, rung once `rungMinutesAgo` ago (the round began then), and pulled `pulledHoursAgo` ago. */
const mine = (rungMinutesAgo: number | null, over: Row = {}): Row =>
  order({
    confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS', claimedById: 'sara', currentOwnerId: 'sara', claimedAt: hoursAgo(8),
    claimHistory: [{ action: 'CLAIMED' }],
    contactAttempts: rungMinutesAgo === null ? [] : call(minutesAgo(rungMinutesAgo)),
    ...over,
  });
const byId = (id: string) => world.orders.find((r) => r.id === id)!;
/** The pull's own read of her held orders (the work-first gate) — told apart by its keys. */
const gateReads = () =>
  (db as unknown as Row).order.findMany.mock.calls.filter(([q]: [Row]) => q.where?.claimedById === 'sara' && q.where?.shippingBatchId === null && 'OR' in q.where);

beforeEach(() => {
  world.orders = [];
  world.users.clear();
  world.history = [];
  world.logs = [];
  // `seq` is never reset: the rounds release remembers where its last full page ended (a cursor on the id, module state), and ids
  // that only grow keep one test's page from hiding the next test's rows.
  sw.value = ON;
  vi.clearAllMocks();
});

describe('1 · she owes calls: the pull says WORK_FIRST and takes nothing', () => {
  it('names how many, carries the oldest one’s id and number, and writes nothing', async () => {
    // Pulled 8, 9 and 7 hours ago; rung 4h, 5h and 1h ago: the first two are due (3 hours passed), the third is waiting.
    const older = mine(300, { claimedAt: hoursAgo(9) });
    const newer = mine(240, { claimedAt: hoursAgo(8) });
    mine(60, { claimedAt: hoursAgo(7) });
    const pool = order({ createdAt: hoursAgo(2) });

    const out = await pullNextOrder(scope, agent('sara'), CAL, NOW);
    expect(out.ok).toBe(false);
    expect(out.refusal).toEqual({
      code: 'WORK_FIRST',
      message: 'عندك طلبين لازم ترني عليهم هلّق قبل سحب طلب جديد — أولها الطلب ' + older.orderNumber + '.',
      orderId: older.id,
      orderNumber: older.orderNumber,
      count: 2,
    });
    expect(newer.id).not.toBe(older.id);
    // Nothing was taken: the pool order is still the pool's, and no history or log line was written.
    expect(byId(pool.id).claimedById).toBeNull();
    expect(world.history).toHaveLength(0);
    expect(world.logs).toHaveLength(0);
  });

  it('a returned «لا يرد» she has just pulled blocks the pull at once (the rounds were counted before)', async () => {
    // Rung by a colleague two days ago; Sara pulled it ten minutes ago and has not touched it.
    const returned = order({
      confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS', claimedById: 'sara', currentOwnerId: 'sara', claimedAt: minutesAgo(10),
      claimHistory: [{ action: 'CLAIMED' }], contactAttempts: call(hoursAgo(48), 'huda'),
    });
    order({ createdAt: hoursAgo(2) });
    const out = await pullNextOrder(scope, agent('sara'), CAL, NOW);
    expect(out.refusal).toMatchObject({ code: 'WORK_FIRST', orderId: returned.id, count: 1 });
  });

  it('a «لا يرد» pressed with no «اتصل» before it counts no round: still owed', async () => {
    const o = mine(null, { contactAttempts: [{ createdAt: minutesAgo(5), result: 'NO_ANSWER', employeeId: 'sara', attemptNumber: 1 }] });
    order({ createdAt: hoursAgo(2) });
    expect((await pullNextOrder(scope, agent('sara'), CAL, NOW)).refusal).toMatchObject({ code: 'WORK_FIRST', orderId: o.id });
  });

  it('a promise that came due with nothing logged since is owed', async () => {
    const promised = mine(null, {
      confirmationStatus: 'POSTPONED', status: 'POSTPONED', postponedUntil: hoursAgo(1), nextFollowUpAt: hoursAgo(1),
      contactAttempts: [{ createdAt: hoursAgo(20), result: 'ANSWERED', employeeId: 'sara', attemptNumber: 1 }],
    });
    order({ createdAt: hoursAgo(2) });
    expect((await pullNextOrder(scope, agent('sara'), CAL, NOW)).refusal).toMatchObject({ code: 'WORK_FIRST', orderId: promised.id, count: 1 });
  });

  it('and once she has rung what she owed, the next pull goes through', async () => {
    const o = mine(300);
    const pool = order({ createdAt: hoursAgo(2) });
    expect((await pullNextOrder(scope, agent('sara'), CAL, NOW)).refusal?.code).toBe('WORK_FIRST');
    // She dials and logs «لا يرد»: a new round began now, so the order is waiting for its three hours.
    o.contactAttempts.push(...call(minutesAgo(1)));
    const out = await pullNextOrder(scope, agent('sara'), CAL, NOW);
    expect(out).toMatchObject({ ok: true, orderId: pool.id });
  });
});

describe('2 · the order of the refusals: every old one first, unchanged', () => {
  it('UNTOUCHED_ORDER keeps winning for a fresh pull — and the gate itself still counts it as owed', async () => {
    const fresh = mine(null, { claimedAt: minutesAgo(5) });
    const due = mine(300);
    order({ createdAt: hoursAgo(2) });

    const out = await pullNextOrder(scope, agent('sara'), CAL, NOW);
    expect(out.refusal).toMatchObject({ code: 'UNTOUCHED_ORDER', orderId: fresh.id, orderNumber: fresh.orderNumber });
    // The predicate is one: asked directly, the gate counts the fresh pull AND the returned one, and names the oldest claim.
    const gate = await workFirstGate(db as never, { scope, userId: 'sara', cal: CAL, now: NOW, rounds: ON, open: OPEN_CONFIRMATION, room: CLAIM_CAPS.total });
    expect(gate).toMatchObject({ code: 'WORK_FIRST', count: 2, orderId: due.id });
  });

  it('the cap wins over it: 500 in her hands is CAP_TOTAL, owed calls or not', async () => {
    for (let i = 0; i < CLAIM_CAPS.total; i++) mine(300, { customerId: `cap${i}`, claimedAt: hoursAgo(10) });
    order({ createdAt: hoursAgo(2) });
    const out = await pullNextOrder(scope, agent('sara'), CAL, NOW);
    expect(out.refusal?.code).toBe('CAP_TOTAL');
  });

  it('and it comes before the pick: with owed calls the pool order is not even looked at', async () => {
    mine(300);
    order({ createdAt: hoursAgo(2) });
    await pullNextOrder(scope, agent('sara'), CAL, NOW);
    const updates = (db as unknown as Row).order.updateMany.mock.calls.filter(([q]: [Row]) => q.data?.claimedById === 'sara');
    expect(updates, 'a claim was attempted').toHaveLength(0);
  });
});

describe('2b · the pace (#224) comes AFTER it — caps · untouched order · WORK_FIRST · PULL_TOO_FAST', () => {
  /** `n` pulls of hers (or `who`'s) — what the pace counts: the `userId`, `CLAIMED`, `PULL_NEXT`, newer than the window. */
  const pulledTimes = (n: number, { who = 'sara', newestAgo = 1 } = {}) => {
    for (let i = 0; i < n; i++) {
      world.history.push({ companyId: 'c1', orderId: `earlier-${who}-${i}`, userId: who, action: 'CLAIMED', reason: 'PULL_NEXT', createdAt: minutesAgo(newestAgo + i) });
    }
  };
  const FORTY = PULL_PACE.perHour;

  it('forty pulls this hour AND a call owed: the answer is WORK_FIRST — the sentence she can act on — not PULL_TOO_FAST', async () => {
    const owed = mine(300);
    const pool = order({ createdAt: hoursAgo(2) });
    pulledTimes(FORTY);

    const out = await pullNextOrder(scope, agent('sara'), CAL, NOW);
    expect(out.refusal).toMatchObject({ code: 'WORK_FIRST', orderId: owed.id, orderNumber: owed.orderNumber, count: 1 });
    expect(byId(pool.id).claimedById).toBeNull();
  });

  it('forty pulls this hour and NOTHING owed: PULL_TOO_FAST — the pace still brakes a desk that is up to date', async () => {
    mine(60); // rung an hour ago: waiting for its three hours, owes nothing
    const pool = order({ createdAt: hoursAgo(2) });
    pulledTimes(FORTY);

    const out = await pullNextOrder(scope, agent('sara'), CAL, NOW);
    expect(out.refusal?.code).toBe('PULL_TOO_FAST');
    expect(byId(pool.id).claimedById).toBeNull();
  });

  it('and the fake is not blind: forty pulls that left the hour, or are a colleague’s, make no pace', async () => {
    pulledTimes(FORTY, { newestAgo: 61 });
    pulledTimes(FORTY, { who: 'huda' });
    const pool = order({ createdAt: hoursAgo(2) });
    expect(await pullNextOrder(scope, agent('sara'), CAL, NOW)).toMatchObject({ ok: true, orderId: pool.id });
  });

  it('once she has rung what she owed, the pace speaks — in its own words', async () => {
    const owed = mine(300);
    order({ createdAt: hoursAgo(2) });
    pulledTimes(FORTY);
    expect((await pullNextOrder(scope, agent('sara'), CAL, NOW)).refusal?.code).toBe('WORK_FIRST');

    owed.contactAttempts.push(...call(minutesAgo(1)));
    const out = await pullNextOrder(scope, agent('sara'), CAL, NOW);
    expect(out.refusal?.code).toBe('PULL_TOO_FAST');
    expect(out.refusal?.message).toContain(`سحبت ${FORTY} طلباً`);
  });

  it('the untouched order and the cap keep their own sentence over BOTH', async () => {
    pulledTimes(FORTY);
    const fresh = mine(null, { claimedAt: minutesAgo(5) });
    mine(300); // owed as well
    order({ createdAt: hoursAgo(2) });
    expect((await pullNextOrder(scope, agent('sara'), CAL, NOW)).refusal).toMatchObject({ code: 'UNTOUCHED_ORDER', orderId: fresh.id });

    world.orders = [];
    for (let i = 0; i < CLAIM_CAPS.total; i++) mine(300, { customerId: `cap${i}`, claimedAt: hoursAgo(10) });
    order({ createdAt: hoursAgo(2) });
    expect((await pullNextOrder(scope, agent('sara'), CAL, NOW)).refusal?.code).toBe('CAP_TOTAL');
  });
});

describe('3 · «نظام الجولات» off: the pull is today’s', () => {
  it('owed rounds do not exist — the pull goes through, and the gate reads nothing', async () => {
    sw.value = ROUNDS_OFF;
    mine(300);
    mine(null, { claimedAt: hoursAgo(9), contactAttempts: [{ createdAt: hoursAgo(9), result: 'ANSWERED', employeeId: 'sara', attemptNumber: 1 }] });
    const pool = order({ createdAt: hoursAgo(2) });
    const out = await pullNextOrder(scope, agent('sara'), CAL, NOW);
    expect(out).toMatchObject({ ok: true, orderId: pool.id });
    expect(gateReads()).toHaveLength(0);
  });

  it('and the old rule is the whole of case 1: a held order with no attempt is UNTOUCHED_ORDER, as ever', async () => {
    sw.value = ROUNDS_OFF;
    const fresh = mine(null, { claimedAt: minutesAgo(5) });
    order({ createdAt: hoursAgo(2) });
    expect((await pullNextOrder(scope, agent('sara'), CAL, NOW)).refusal).toMatchObject({ code: 'UNTOUCHED_ORDER', orderId: fresh.id });
  });
});

describe('what is NOT owed', () => {
  it('an order still inside its three hours is waiting, not owed', async () => {
    mine(179);
    mine(60);
    const pool = order({ createdAt: hoursAgo(2) });
    expect(await pullNextOrder(scope, agent('sara'), CAL, NOW)).toMatchObject({ ok: true, orderId: pool.id });
  });

  it('…and the minute the three hours are over it is owed', async () => {
    mine(180);
    order({ createdAt: hoursAgo(2) });
    expect((await pullNextOrder(scope, agent('sara'), CAL, NOW)).refusal?.code).toBe('WORK_FIRST');
  });

  it('a date still ahead is neither: the customer asked for later', async () => {
    mine(300, { nextFollowUpAt: hoursAhead(5) });
    mine(null, {
      confirmationStatus: 'POSTPONED', status: 'POSTPONED', postponedUntil: hoursAhead(30), nextFollowUpAt: hoursAhead(30),
      contactAttempts: [{ createdAt: hoursAgo(2), result: 'ANSWERED', employeeId: 'sara', attemptNumber: 1 }],
    });
    const pool = order({ createdAt: hoursAgo(2) });
    expect(await pullNextOrder(scope, agent('sara'), CAL, NOW)).toMatchObject({ ok: true, orderId: pool.id });
  });

  it('a call that REACHED the customer, with no date, needs a decision and is no blocker', async () => {
    mine(null, { contactAttempts: [...call(hoursAgo(30)), { createdAt: hoursAgo(29), result: 'ANSWERED', employeeId: 'sara', attemptNumber: 3 }] });
    const pool = order({ createdAt: hoursAgo(2) });
    expect(await pullNextOrder(scope, agent('sara'), CAL, NOW)).toMatchObject({ ok: true, orderId: pool.id });
  });

  it('a promise she has already worked (anything logged after the date) is not a promise any more', async () => {
    mine(null, {
      confirmationStatus: 'POSTPONED', status: 'POSTPONED', postponedUntil: hoursAgo(2), nextFollowUpAt: hoursAgo(2),
      contactAttempts: [
        { createdAt: hoursAgo(20), result: 'ANSWERED', employeeId: 'sara', attemptNumber: 1 },
        { createdAt: hoursAgo(1), result: 'ANSWERED', employeeId: 'sara', attemptNumber: 2 },
      ],
    });
    const pool = order({ createdAt: hoursAgo(2) });
    expect(await pullNextOrder(scope, agent('sara'), CAL, NOW)).toMatchObject({ ok: true, orderId: pool.id });
  });

  it('what is only HELD FOR her, a colleague’s orders, decided orders and shipped ones are not hers to work', async () => {
    // Held for her (a returning customer’s): not in her hands.
    order({ assignedToId: 'sara', assignedAt: hoursAgo(1), contactAttempts: call(hoursAgo(10), 'huda') });
    // A colleague’s, long overdue.
    order({ confirmationStatus: 'IN_PROGRESS', claimedById: 'huda', claimedAt: hoursAgo(9), contactAttempts: call(hoursAgo(8), 'huda') });
    // Hers but decided / shipping.
    mine(300, { confirmationStatus: 'CONFIRMED', status: 'CONFIRMED' });
    mine(300, { shippingBatchId: 'b1' });
    mine(300, { trackingNumber: 'T1' });
    mine(300, { labelPrintedAt: hoursAgo(1) });
    mine(300, { shippingStatus: 'SHIPPED' });
    const pool = order({ createdAt: hoursAgo(2) });
    const out = await pullNextOrder(scope, agent('sara'), CAL, NOW);
    expect(out.refusal?.code, JSON.stringify(out.refusal)).not.toBe('WORK_FIRST');
    expect(out.ok).toBe(true);
    expect(pool.id).toBeTruthy();
  });
});

describe('4 · THE FIRST DEPLOY MUST NOT WALL A DESK THAT ALREADY HOLDS A PILE', () => {
  /** `n` orders she pulled two days ago and rung once then — long past the twelve working hours the release waits. */
  const oldPile = (n: number) => Array.from({ length: n }, (_, i) => mine(48 * 60, { customerId: `old${i}`, claimedAt: hoursAgo(50) }));

  it('479 old no-answers: the pull does not answer WORK_FIRST for orders the next release pass is about to take', async () => {
    oldPile(479);
    const pool = order({ createdAt: hoursAgo(2) });

    const out = await pullNextOrder(scope, agent('sara'), CAL, NOW);
    expect(out.refusal, JSON.stringify(out.refusal)).toBeUndefined();
    expect(out).toMatchObject({ ok: true, orderId: pool.id });
    // The pull's own pass let 25 of them go; the other 454 are leaving too and block nothing.
    expect(out.released).toBe(25);
    expect(world.orders.filter((r) => r.claimedById === 'sara' && r.id !== pool.id)).toHaveLength(454);
  });

  it('the same 479, rung only five hours ago: past the three hours, inside the twelve — NOW they are owed, all of them', async () => {
    for (let i = 0; i < 479; i++) mine(300, { customerId: `fresh${i}`, claimedAt: hoursAgo(6 + (i % 5) * 0.01) });
    order({ createdAt: hoursAgo(2) });
    const out = await pullNextOrder(scope, agent('sara'), CAL, NOW);
    expect(out.released).toBe(0);
    expect(out.refusal).toMatchObject({ code: 'WORK_FIRST', count: 479 });
  });

  it('a mix: 400 leaving and 5 owed — the sentence counts the five', async () => {
    oldPile(400);
    for (let i = 0; i < 5; i++) mine(300 + i, { customerId: `due${i}`, claimedAt: hoursAgo(6) });
    order({ createdAt: hoursAgo(2) });
    const out = await pullNextOrder(scope, agent('sara'), CAL, NOW);
    expect(out.refusal).toMatchObject({ code: 'WORK_FIRST', count: 5 });
    expect(out.refusal?.message).toContain('5 طلبات');
  });

  it('12 hours exactly is the line: an order whose run began 11h59 ago is owed, one 12h00 ago is leaving', async () => {
    // The gate alone (no release pass in between), so each side of the line is read as the pull would read it.
    const gate = () => workFirstGate(db as never, { scope, userId: 'sara', cal: CAL, now: NOW, rounds: ON, open: OPEN_CONFIRMATION, room: CLAIM_CAPS.total });
    const o = mine(11 * 60 + 59, { claimedAt: hoursAgo(13) });
    expect(await gate()).toMatchObject({ code: 'WORK_FIRST', count: 1 });
    o.contactAttempts = call(minutesAgo(12 * 60));
    expect(await gate()).toBeNull();
  });
});

describe('5 · cheap: one read of her held orders, nothing per order', () => {
  it('the number of reads does not depend on the number of orders she holds', async () => {
    mine(300);
    order({ createdAt: hoursAgo(2) });
    await pullNextOrder(scope, agent('sara'), CAL, NOW);
    const few = gateReads().length;
    vi.clearAllMocks();
    for (let i = 0; i < 300; i++) mine(300 + (i % 20), { customerId: `many${i}` });
    await pullNextOrder(scope, agent('sara'), CAL, NOW);
    expect(few).toBe(1);
    expect(gateReads()).toHaveLength(1);
  });

  it('and it is bounded by the cap: the read asks for no more than a desk may hold, oldest claim first', async () => {
    mine(300);
    await pullNextOrder(scope, agent('sara'), CAL, NOW);
    const read = gateReads()[0][0] as Row;
    expect(read.take).toBe(CLAIM_CAPS.total);
    expect(read.orderBy).toEqual({ claimedAt: 'asc' });
    expect(read.select.contactAttempts.select).toEqual({ createdAt: true, result: true, attemptNumber: true, employeeId: true });
  });

  it('the database is told what it can cheaply leave out: a date still ahead — but an order with no attempt is kept whatever its dates', async () => {
    mine(300);
    await pullNextOrder(scope, agent('sara'), CAL, NOW);
    const where = (gateReads()[0][0] as Row).where;
    expect(where).toMatchObject({ claimedById: 'sara', shippingStatus: 'NOT_READY', shippingBatchId: null, trackingNumber: null, labelPrintedAt: null });
    expect(where.OR[0]).toEqual({ contactAttempts: { none: {} } });
    expect(where.OR[1].AND[0]).toEqual({ OR: [{ postponedUntil: null }, { postponedUntil: { lte: NOW } }] });
    expect(where.OR[1].AND[1]).toEqual({ OR: [{ nextFollowUpAt: null }, { nextFollowUpAt: { lte: NOW } }] });
  });

  it('500 held orders with six attempts each: every verdict is arithmetic, and it is quick', async () => {
    for (let i = 0; i < 500; i++) {
      mine(null, {
        customerId: `q${i}`,
        // Pulled before the first call — otherwise "nothing logged since she took it" would let the release take it.
        claimedAt: hoursAgo(9),
        // One round began 400 minutes ago; the two presses after it are inside its three hours and count nothing.
        contactAttempts: [...call(minutesAgo(400 + (i % 50))), ...call(minutesAgo(380)), ...call(minutesAgo(360))],
      });
    }
    const started = performance.now();
    const gate = await workFirstGate(db as never, { scope, userId: 'sara', cal: CAL, now: NOW, rounds: ON, open: OPEN_CONFIRMATION, room: CLAIM_CAPS.total });
    const ms = performance.now() - started;
    // The one counted round began more than three hours ago for all of them, and less than twelve: all 500 are owed.
    expect(gate).toMatchObject({ code: 'WORK_FIRST', count: 500 });
    // Wide on purpose: the read count above is the proof of "no query per order"; this only catches a verdict that went quadratic.
    expect(ms).toBeLessThan(5_000);
  });

  it('she holds nothing: the gate reads nothing when told so', async () => {
    const gate = await workFirstGate(db as never, { scope, userId: 'sara', cal: CAL, now: NOW, rounds: ON, open: OPEN_CONFIRMATION, room: CLAIM_CAPS.total, held: 0 });
    expect(gate).toBeNull();
    expect((db as unknown as Row).order.findMany).not.toHaveBeenCalled();
  });
});

describe('the working calendar reaches the gate: owed at 180 WORKING minutes, across the end of the day', () => {
  const JO = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' };
  const at = (day: number, h: number, m = 0) => zonedTimeToInstant(JO.timezone, 2026, 11, day, h, m);

  /** Rung at 16:00 on Sunday: one working hour left that day, two on Monday — owed at 11:00, not a minute before. */
  const world1 = () => {
    sw.value = { enabled: true, enabledAt: at(1, 8) };
    mine(null, { claimedAt: at(1, 9), contactAttempts: call(at(1, 16)) });
    return order({ createdAt: at(1, 8) });
  };

  it('the gate: at 10:59 on Monday it is waiting, at 11:00 it is owed', async () => {
    world1();
    const gate = (now: Date) =>
      workFirstGate(db as never, { scope, userId: 'sara', cal: JO, now, rounds: { enabled: true, enabledAt: at(1, 8) }, open: OPEN_CONFIRMATION, room: CLAIM_CAPS.total });
    expect(await gate(at(2, 10, 59))).toBeNull();
    expect(await gate(at(2, 11))).toMatchObject({ code: 'WORK_FIRST', count: 1 });
  });

  it('and the pull hands its own calendar to the gate: 10:59 goes through, 11:00 is refused', async () => {
    const pool = world1();
    expect(await pullNextOrder(scope, agent('sara'), JO, at(2, 10, 59))).toMatchObject({ ok: true, orderId: pool.id });
  });

  it('…the same world a minute later', async () => {
    world1();
    expect((await pullNextOrder(scope, agent('sara'), JO, at(2, 11))).refusal).toMatchObject({ code: 'WORK_FIRST', count: 1 });
  });
});

describe('6 · what the pull does NOT touch', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

  it('claim-by-id, «الزبون على الخط» and the transfer door never ask it', () => {
    for (const file of [
      'src/app/api/orders/[id]/claim/route.ts',
      'src/lib/customer-on-the-line.ts',
      'src/app/api/orders/[id]/transfer/route.ts',
      'src/app/api/confirmation/callback-take/route.ts',
    ]) {
      const src = read(file);
      expect(src, file).not.toMatch(/work-first|workFirst|WORK_FIRST/);
    }
  });

  it('and the shared refusal function (claim-by-id reads it) knows nothing of it', () => {
    expect(pullRefusal({ total: 3, withoutAttempt: 0 })).toBeNull();
    expect(pullRefusal({ total: 3, withoutAttempt: 1 })?.code).toBe('UNTOUCHED_ORDER');
  });
});
