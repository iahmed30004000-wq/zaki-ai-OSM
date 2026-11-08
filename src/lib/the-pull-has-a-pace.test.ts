import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — the pull has a PACE (the owner, 8/11: «كيف نمنعهم يسحبو طلبات بسرعة مهولة»)
 *
 * One agent held 489 orders, 479 of them at «لا يرد» (one logged no-answer each). Pull → «لا يرد» → «التالي» is three clicks, and the call
 * sheet's «التالي» pulls the next order at once; the two caps (40 with no attempt, 500 in all) bound HOW MANY she holds, and nothing
 * bound how FAST she took them. Now:
 *
 *  1. An agent may pull at most 40 orders in any rolling 60 minutes (`PULL_PACE`): the 40th goes through, the 41st is refused with
 *     `PULL_TOO_FAST` — the count she pulled, the limit, and in how many minutes (rounded UP) the pull opens again.
 *  2. What counts is her `CLAIMED / PULL_NEXT` history rows of the last 60 minutes, whether or not the order was let go since, and
 *     the orders held for her that she takes through the same pull. A pull that found the queue empty wrote no row, so it does not
 *     count; a refused pull writes none either, so pressing again never pushes the opening away. A colleague's pulls, a claim by
 *     number, «الزبون على الخط» and a transfer are not hers to count.
 *  3. The pace is the LAST refusal: an untouched order and the two caps keep their codes, their sentences and their precedence.
 *  4. The refusal ITSELF claims nothing, takes no customer's lock and writes no row. (The release of claims nobody worked on, which runs
 *     before every pull so that the counts are fresh, is as it was — it has to come first, or the untouched order it frees would
 *     still be what she is told. These worlds have nothing stale to release.)
 *  5. The count rides on an index (`userId, action, createdAt`) added by an additive, idempotent migration with its rollback,
 *     and the schema says the same.
 *
 * Driven against an in-memory database that APPLIES the filters (with SQL's three values), so the answer comes from the filter's own
 * text and not from a mock that was told it.
 *
 * Blockers: no money, no order creation, no customer data to any model; the migration only ADDS an index.
 * ═══════════════════════════════════════════════════════════════════════
 */

// A fake database row: its values are read by the filter operators below, whatever their type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const { world } = vi.hoisted(() => ({
  world: {
    orders: [] as Row[],
    users: new Map<string, Row>(),
    history: [] as Row[],
    logs: [] as Row[],
    // The moment the pull under test happens: the real history column defaults to the database's `now()`.
    clock: new Date(0),
    // Every read of the history lines, with the client that made it: the pull's transaction, or the root one beside it.
    historyReads: [] as { via: 'tx' | 'root'; args: Row }[],
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
            case 'lt': return value === null ? null : (value as Date).getTime() < (arg as Date).getTime();
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
  // A read hands back COPIES, as Prisma does.
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
        if ('assignedToId' in data) r.assignee = data.assignedToId ? world.users.get(data.assignedToId) ?? null : null;
      }
      return { count: hit.length };
    }),
  };
  // The pace's own read: her pulls of the last hour. The filter is applied, not told; `via` says which client asked.
  const readHistory = (via: 'tx' | 'root') =>
    vi.fn(async (args: Row) => {
      world.historyReads.push({ via, args });
      const { where, select, orderBy, take, skip } = args;
      const found = sorted(world.history.filter((h) => matches(h, where ?? {})), orderBy);
      const page = found.slice(skip ?? 0, take === undefined ? undefined : (skip ?? 0) + take);
      return page.map((h) =>
        select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, h[k] ?? null])) : { ...h }
      );
    });
  const writeHistory = vi.fn(async ({ data }: Row) => void world.history.push({ createdAt: world.clock, ...data }));
  const shared = {
    order,
    notification: { createMany: vi.fn(async () => ({ count: 1 })) },
    orderStatusLog: { create: vi.fn(async ({ data }: Row) => void world.logs.push(data)) },
    // The pull's per-customer lock and the hold of his other orders (`twins-follow-the-pull.ts`): one agent at a time here.
    orderActivity: { create: vi.fn(async () => undefined) },
    $executeRaw: vi.fn(async () => 1),
  };
  // The transaction's own client and the root one are two objects, as in Prisma: a read that leaves the transaction is seen.
  const tx = { ...shared, orderClaimHistory: { create: writeHistory, findMany: readHistory('tx') } };
  const db = {
    ...shared,
    orderClaimHistory: { create: writeHistory, findMany: readHistory('root') },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
  };
  return { db, default: db };
});
// «نظام الجولات» is off: the pace does not depend on it.
vi.mock('./no-answer-rounds-switch', () => ({ roundsSwitch: async () => ({ enabled: false, enabledAt: null }) }));

import {
  CLAIM_CAPS,
  MANUAL_ENTRY_REASON,
  PULL_PACE,
  pullNextOrder,
  pullPaceRefusal,
  pullPermission,
  pullRefusal,
} from './confirmation-queue';
import { repoFile, stripComments } from './guard-source';
import { db } from './db';

const NOW = new Date('2026-11-08T12:00:00.000Z');
const secondsAgo = (s: number) => new Date(NOW.getTime() - s * 1000);
const minutesAgo = (m: number) => secondsAgo(m * 60);
const hoursAgo = (h: number) => secondsAgo(h * 3600);
const scope = { companyId: 'c1', storeId: 's1' };
const CAL = { workHoursStart: '00:00', workHoursEnd: '23:59', weekendDays: [] as number[], timezone: 'UTC' };
const agent = (id: string) => ({ id, role: 'CONFIRMATION_AGENT' });

/** The sentence an agent reads, in the words the owner reads it. `opensIn` is the minutes as they are said: «7 دقائق», «دقيقة». */
const SENTENCE = (pulled: number, opensIn: string) =>
  `سحبت ${pulled} طلباً خلال آخر 60 دقيقة — الحد 40. اشتغل على اللي بإيدك، والسحب بيفتح بعد ${opensIn}.`;

let seq = 0;
/** An order nobody holds, nobody has rung, and nobody is shipping. */
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
/** She rang it: the pull's gate («سجّل محاولة اتصال قبل سحب طلب جديد») is then out of her way. */
const ring = (id: string, who: string) => {
  byId(id).contactAttempts = [{ createdAt: NOW, result: 'NO_ANSWER', employeeId: who }];
};
/** `n` orders already in her hands and rung — the pull gate is then about the cap alone. */
const holding = (n: number, who = 'sara') => {
  for (let i = 0; i < n; i++) {
    order({
      customerId: `mine-${who}-${i}`, confirmationStatus: 'IN_PROGRESS', claimedById: who, claimedAt: hoursAgo(1),
      contactAttempts: [{ createdAt: minutesAgo(30), result: 'NO_ANSWER', employeeId: who }], claimHistory: [{ action: 'CLAIMED' }],
    });
  }
};
/** One pull of hers, `ago` seconds before NOW — what `pullNextOrder` writes at the claim. */
const pulled = (who: string, ago: number, over: Row = {}) =>
  world.history.push({
    companyId: 'c1', orderId: `old-${world.history.length}`, userId: who, action: 'CLAIMED', reason: 'PULL_NEXT',
    metadata: null, createdAt: secondsAgo(ago), ...over,
  });
const pulledTimes = (who: string, n: number, ago = 300, over: Row = {}) => {
  for (let i = 0; i < n; i++) pulled(who, ago, over);
};
/** The pull, at a moment the test names (the same moment is the clock the history row is stamped with). */
const pull = (who: string, at: Date = NOW) => {
  world.clock = at;
  return pullNextOrder(scope, agent(who), CAL, at);
};
/** One order the pull can give, so that a refusal is a refusal and not an empty queue. */
const poolOrder = (over: Row = {}) => order({ customerId: 'pool', createdAt: hoursAgo(10), ...over });

const reset = () => {
  world.orders = [];
  world.users.clear();
  world.history = [];
  world.logs = [];
  world.historyReads = [];
  world.clock = NOW;
  seq = 0;
  vi.clearAllMocks();
  for (const id of ['sara', 'huda', 'noor']) world.users.set(id, { id, name: id, status: 'ACTIVE' });
};
beforeEach(reset);

describe('the numbers', () => {
  it('40 pulls in any rolling 60 minutes — the one place the number lives', () => {
    expect(PULL_PACE).toEqual({ perHour: 40, windowMinutes: 60 });
  });

  it('the two caps are untouched: 40 without an attempt, 500 in all', () => {
    expect(CLAIM_CAPS).toEqual({ withoutAttempt: 40, total: 500 });
  });

  it('the old rules do not know the pace: the cap rule, and the authority that comes before it', () => {
    expect(pullRefusal({ total: 0, withoutAttempt: 0 })).toBeNull();
    expect(pullPermission(true, { total: 0, withoutAttempt: 0 })).toBeNull();
    // A supervisor is refused by the authority first, however many she pulled — she never pulls.
    expect(pullPermission(false, { total: 0, withoutAttempt: 0 })?.code).toBe('NOT_YOUR_DESK');
  });
});

describe('the rule on its own — pullPaceRefusal(the times of her pulls in the window, now)', () => {
  const at = (ago: number) => secondsAgo(ago);
  /** Forty pulls: the oldest `oldestAgo` seconds ago, the other thirty-nine this very moment — so the oldest is the one that must leave. */
  const forty = (oldestAgo: number) => [at(oldestAgo), ...Array.from({ length: 39 }, () => at(0))];

  it('no pulls, and thirty-nine, are allowed', () => {
    expect(pullPaceRefusal([], NOW)).toBeNull();
    expect(pullPaceRefusal(Array.from({ length: 39 }, () => at(10)), NOW)).toBeNull();
  });

  it('the fortieth pull on the books is the end of the hour: refused, with the count, the limit and the minutes in one sentence', () => {
    expect(pullPaceRefusal(forty(3180), NOW)).toEqual({
      code: 'PULL_TOO_FAST',
      message: 'سحبت 40 طلباً خلال آخر 60 دقيقة — الحد 40. اشتغل على اللي بإيدك، والسحب بيفتح بعد 7 دقائق.',
    });
  });

  // The minutes are counted from the pull whose leaving lets her through, and ROUNDED UP: she is told a time she can trust.
  it.each([
    [0, '60 دقيقة'],
    [60, '59 دقيقة'],
    [2940, '11 دقيقة'],
    [3000, '10 دقائق'],
    [3180, '7 دقائق'],
    [3220, '7 دقائق'], // 6 minutes 20 seconds left → seven, not six
    [3420, '3 دقائق'],
    [3480, 'دقيقتين'],
    [3539, 'دقيقتين'], // 61 seconds left → two
    [3540, 'دقيقة'], // exactly 60 seconds left → one
    [3541, 'دقيقة'],
    [3599, 'دقيقة'], // one second left → still a whole minute
    [3600, 'دقيقة'], // it is leaving this very instant: never «0 دقيقة»
    [3601, 'دقيقة'],
  ])('the oldest pull %i seconds ago → opens in %s', (oldestAgo, said) => {
    expect(pullPaceRefusal(forty(oldestAgo), NOW)).toEqual({ code: 'PULL_TOO_FAST', message: SENTENCE(40, said) });
  });

  it('over the limit (a race, or the hour before the rule): the pull that must leave is the one that brings her back UNDER it', () => {
    // 41 pulls: when the oldest leaves she is at 40 — still refused. The second oldest is the one that opens the door.
    const times = [at(3540), at(3000), ...Array.from({ length: 39 }, () => at(300))];
    expect(pullPaceRefusal(times, NOW)).toEqual({ code: 'PULL_TOO_FAST', message: SENTENCE(41, '10 دقائق') });
    // 45 pulls: five leave before she is under the limit; the sixth oldest is the one.
    const five = [at(3590), at(3580), at(3570), at(3560), at(3550)];
    const forty5 = [...five, at(3000), ...Array.from({ length: 39 }, () => at(300))];
    expect(pullPaceRefusal(forty5, NOW)).toEqual({ code: 'PULL_TOO_FAST', message: SENTENCE(45, '10 دقائق') });
  });

  it('the order the times arrive in changes nothing', () => {
    const times = forty(3180);
    expect(pullPaceRefusal([...times].reverse(), NOW)).toEqual(pullPaceRefusal(times, NOW));
    expect(pullPaceRefusal([times[5], times[0], ...times.slice(1, 5), ...times.slice(6)], NOW)).toEqual(pullPaceRefusal(times, NOW));
    // And what it was given is read, not reordered: a frozen list goes through whole.
    const frozen = Object.freeze([...times]);
    expect(pullPaceRefusal(frozen, NOW)).toEqual(pullPaceRefusal(times, NOW));
    expect(frozen).toEqual(times);
  });

  it('the sentence is in Arabic and names no code', () => {
    const message = pullPaceRefusal(forty(3180), NOW)!.message;
    expect(message).toMatch(/[؀-ۿ]/);
    expect(message).not.toMatch(/[A-Za-z]/);
  });
});

describe('the pull — the 40th goes through and the 41st does not', () => {
  it('forty pulls in a row, then the 41st is refused with the sentence — and it claims nothing', async () => {
    for (let i = 0; i < 41; i++) order({ customerId: `pool-${i}`, createdAt: minutesAgo(600 - i) });
    for (let n = 1; n <= 40; n++) {
      const out = await pull('sara');
      expect(out.ok, `pull ${n}: ${JSON.stringify(out.refusal)}`).toBe(true);
      ring(out.orderId!, 'sara');
    }
    expect(world.orders.filter((r) => r.claimedById === 'sara')).toHaveLength(40);

    const orders = JSON.stringify(world.orders);
    const history = world.history.length;
    const logs = world.logs.length;
    const claims = vi.mocked(db.order.updateMany).mock.calls.length;
    const locks = vi.mocked(db.$executeRaw).mock.calls.length;

    const out = await pull('sara');
    expect(out.ok).toBe(false);
    // All forty were pulled in this one moment, so the first of them leaves in a whole hour.
    expect(out.refusal).toEqual({ code: 'PULL_TOO_FAST', message: SENTENCE(40, '60 دقيقة') });

    // The refusal claims nothing, lets nothing go, takes no customer's lock and writes no row.
    expect(JSON.stringify(world.orders)).toBe(orders);
    expect(world.orders.filter((r) => r.claimedById === 'sara')).toHaveLength(40);
    expect(byId('o41').claimedById).toBeNull();
    expect(world.history).toHaveLength(history);
    expect(world.logs).toHaveLength(logs);
    expect(vi.mocked(db.order.updateMany).mock.calls.length).toBe(claims);
    expect(vi.mocked(db.$executeRaw).mock.calls.length).toBe(locks);
  });

  it('the thirty-ninth is not the last: 39 pulls on the books, the next is the fortieth and goes through', async () => {
    pulledTimes('sara', 39);
    poolOrder();
    poolOrder({ customerId: 'pool-2' });
    const fortieth = await pull('sara');
    expect(fortieth.ok, JSON.stringify(fortieth.refusal)).toBe(true);
    ring(fortieth.orderId!, 'sara');
    const forty1st = await pull('sara');
    expect(forty1st.refusal?.code).toBe('PULL_TOO_FAST');
  });
});

describe('the pull — the window slides', () => {
  /** Thirty-nine pulls five minutes ago, one older pull `ago` seconds ago, and one order to give. */
  const withOldest = (ago: number) => {
    pulledTimes('sara', 39, 300);
    pulled('sara', ago);
    poolOrder();
  };

  it.each([
    [3661], // 61 minutes and a second: out
    [3660],
    [3601],
    [3600], // exactly sixty minutes: it has left the window
  ])('a pull %i seconds ago is not counted: 39 in the window, so she pulls', async (ago) => {
    withOldest(ago);
    const out = await pull('sara');
    expect(out.ok, JSON.stringify(out.refusal)).toBe(true);
  });

  it.each([
    [3599, 'دقيقة'], // 59 minutes 59 seconds: still counted, opens in a second → «دقيقة»
    [3540, 'دقيقة'], // 59 minutes
    [3539, 'دقيقتين'],
    [3220, '7 دقائق'],
    [300, '55 دقيقة'],
  ])('a pull %i seconds ago is counted: 40 in the window, refused, opens in %s', async (ago, said) => {
    withOldest(ago);
    const out = await pull('sara');
    expect(out.ok).toBe(false);
    expect(out.refusal).toEqual({ code: 'PULL_TOO_FAST', message: SENTENCE(40, said) });
  });

  it('pressing again does not push the opening away: it counts down, and then she pulls', async () => {
    pulledTimes('sara', 39, 300);
    pulled('sara', 3000); // fifty minutes ago: leaves in ten
    poolOrder();
    const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

    expect((await pull('sara', at(0))).refusal).toEqual({ code: 'PULL_TOO_FAST', message: SENTENCE(40, '10 دقائق') });
    for (let i = 0; i < 5; i++) await pull('sara', at(1));
    expect((await pull('sara', at(3))).refusal).toEqual({ code: 'PULL_TOO_FAST', message: SENTENCE(40, '7 دقائق') });
    expect((await pull('sara', at(9.5))).refusal).toEqual({ code: 'PULL_TOO_FAST', message: SENTENCE(40, 'دقيقة') });
    // Ten minutes on, the fiftieth-minute pull has left; the thirty-nine others are 14 minutes old: she pulls.
    const open = await pull('sara', at(10));
    expect(open.ok, JSON.stringify(open.refusal)).toBe(true);
    // Not a single refusal wrote a row: forty-one rows (the 40 seeded + this pull), no more.
    expect(world.history.filter((h) => h.userId === 'sara')).toHaveLength(41);
  });
});

describe('the pull — what counts as hers', () => {
  it('a released order still counts: forty pulled and given back, and she holds nothing — refused', async () => {
    // Forty orders pulled in the last twenty minutes and let go since: they are in the queue again, with their RELEASED line.
    for (let i = 0; i < 40; i++) {
      pulled('sara', 1200);
      world.history.push({ companyId: 'c1', orderId: `old-${i}`, userId: 'sara', action: 'RELEASED', reason: 'AGENT_RELEASED', createdAt: secondsAgo(600) });
    }
    poolOrder();
    expect(world.orders.filter((r) => r.claimedById === 'sara')).toHaveLength(0);
    const out = await pull('sara');
    expect(out.ok).toBe(false);
    expect(out.refusal).toEqual({ code: 'PULL_TOO_FAST', message: SENTENCE(40, '40 دقيقة') });
  });

  it('two agents are independent: hers are hers, his are his', async () => {
    pulledTimes('sara', 40);
    poolOrder();
    poolOrder({ customerId: 'pool-2' });

    const huda = await pull('huda');
    expect(huda.ok, JSON.stringify(huda.refusal)).toBe(true);
    expect(byId(huda.orderId!).claimedById).toBe('huda');
    // And her colleague's pull is not hers: she is still at forty, not at forty-one.
    const sara = await pull('sara');
    expect(sara.refusal).toEqual({ code: 'PULL_TOO_FAST', message: SENTENCE(40, '55 دقيقة') });
  });

  it('a colleague at forty does not stop her: the count is by person', async () => {
    pulledTimes('huda', 40);
    poolOrder();
    const sara = await pull('sara');
    expect(sara.ok, JSON.stringify(sara.refusal)).toBe(true);
  });

  it('a claim that is not a pull does not count: her own entries, a claim by number, a call-back', async () => {
    const reasons = [MANUAL_ENTRY_REASON, 'CUSTOMER_CALLED_BACK', null, 'سبب مكتوب بالإيد'];
    for (let i = 0; i < 40; i++) pulled('sara', 300, { reason: reasons[i % reasons.length] });
    poolOrder();
    const out = await pull('sara');
    expect(out.ok, JSON.stringify(out.refusal)).toBe(true);
  });

  it('a line that is not a claim does not count: let go, handed over, taken over, held with a twin', async () => {
    const actions = ['RELEASED', 'TRANSFERRED', 'OVERRIDDEN', 'HELD_WITH_HIS_OTHER_ORDER'];
    for (let i = 0; i < 40; i++) pulled('sara', 300, { action: actions[i % actions.length] });
    poolOrder();
    const out = await pull('sara');
    expect(out.ok, JSON.stringify(out.refusal)).toBe(true);
  });

  it('what is held for her counts when she takes it through the pull: it is the fortieth', async () => {
    pulledTimes('sara', 39);
    const held = order({ customerId: 'held', assignedToId: 'sara', assignedAt: minutesAgo(30), assignee: world.users.get('sara') });
    poolOrder();
    const hers = await pull('sara');
    expect(hers.ok, JSON.stringify(hers.refusal)).toBe(true);
    expect(hers.orderId).toBe(held.id);
    expect(world.history.filter((h) => h.userId === 'sara' && h.reason === 'PULL_NEXT')).toHaveLength(40);
    ring(held.id, 'sara');
    expect((await pull('sara')).refusal).toEqual({ code: 'PULL_TOO_FAST', message: SENTENCE(40, '55 دقيقة') });
  });

  it('a pull that found the queue empty does not count', async () => {
    pulledTimes('sara', 39);
    // Nothing to give: the empty queue, as before — and no row, so the next real pull is still her fortieth.
    const empty = await pull('sara');
    expect(empty.ok).toBe(false);
    expect(empty.refusal?.code).toBe('QUEUE_EMPTY');
    expect(world.history.filter((h) => h.userId === 'sara')).toHaveLength(39);
    for (let i = 0; i < 3; i++) await pull('sara');

    poolOrder();
    const fortieth = await pull('sara');
    expect(fortieth.ok, JSON.stringify(fortieth.refusal)).toBe(true);
    ring(fortieth.orderId!, 'sara');
    poolOrder({ customerId: 'pool-2' });
    expect((await pull('sara')).refusal?.code).toBe('PULL_TOO_FAST');
  });
});

describe('the pull — the old refusals keep their codes, their sentences and their precedence', () => {
  const untouchedOne = () => void order({ customerId: 'u', confirmationStatus: 'IN_PROGRESS', claimedById: 'sara', claimedAt: minutesAgo(5) });
  const untouchedForty = () => {
    for (let i = 0; i < 40; i++) order({ customerId: `u${i}`, confirmationStatus: 'IN_PROGRESS', claimedById: 'sara', claimedAt: minutesAgo(5) });
  };
  const fiveHundred = () => holding(500);

  const refusalWith = async (setup: () => void, atPace: boolean) => {
    reset();
    setup();
    if (atPace) pulledTimes('sara', 40);
    poolOrder();
    return (await pull('sara')).refusal;
  };

  it.each([
    ['UNTOUCHED_ORDER', untouchedOne, 'سجّل محاولة اتصال على الطلب ORD-1 قبل سحب طلب جديد.'],
    ['CAP_WITHOUT_ATTEMPT', untouchedForty, 'لديك 40 طلباً بلا محاولة اتصال — الحد 40.'],
    ['CAP_TOTAL', fiveHundred, 'بلغت الحد الأقصى (500 طلب لديك).'],
  ])('%s is still what she is told — at the pace limit too, and word for word', async (code, setup, message) => {
    const alone = await refusalWith(setup, false);
    expect(alone?.code).toBe(code);
    expect(alone?.message).toBe(message);
    const atPace = await refusalWith(setup, true);
    expect(atPace).toEqual(alone);
  });

  it('with nothing else in her way, the pace is what she is told', async () => {
    const out = await refusalWith(() => undefined, true);
    expect(out?.code).toBe('PULL_TOO_FAST');
  });

  it('the pace is checked after them and before anything is picked: no pick, no lock, no claim', async () => {
    pulledTimes('sara', 40);
    poolOrder();
    await pull('sara');
    expect(vi.mocked(db.order.updateMany)).not.toHaveBeenCalled();
    expect(vi.mocked(db.$executeRaw)).not.toHaveBeenCalled();
  });

  it('the release of a claim nobody worked on still comes first: it frees her untouched order, and THEN the pace is what she is told', async () => {
    pulledTimes('sara', 40);
    // An order she took 120 minutes ago and never rang: past the ninety, the pull lets it go before it counts anything.
    const stale = order({ customerId: 'stale', confirmationStatus: 'IN_PROGRESS', claimedById: 'sara', claimedAt: minutesAgo(120) });
    poolOrder();
    const out = await pull('sara');
    expect(out.released).toBe(1);
    expect(byId(stale.id).claimedById).toBeNull();
    expect(out.refusal?.code).toBe('PULL_TOO_FAST');
    // The release is a RELEASED line, not a pull: it did not move the count (still forty).
    expect(out.refusal?.message).toBe(SENTENCE(40, '55 دقيقة'));
  });

  it('over the pace with nothing left to pull, she is told the pace — she could not pull anyway, and the sentence says when', async () => {
    pulledTimes('sara', 40);
    const out = await pull('sara');
    expect(out.ok).toBe(false);
    expect(out.refusal).toEqual({ code: 'PULL_TOO_FAST', message: SENTENCE(40, '55 دقيقة') });
    expect(out.released).toBe(0);
  });
});

describe('NOT limited — they are not «pulling from the queue»', () => {
  it.each([
    ['the claim-by-number door', 'src/app/api/orders/[id]/claim/route.ts'],
    ['«الزبون على الخط»', 'src/lib/customer-on-the-line.ts'],
    ['the transfer door', 'src/app/api/orders/[id]/transfer/route.ts'],
  ])('%s never asks the pace', (_name, file) => {
    expect(stripComments(repoFile(file))).not.toMatch(/PULL_PACE|pullPaceRefusal|PULL_TOO_FAST/);
  });

  it('the cap rule they share (pullRefusal) knows nothing of it either', () => {
    const source = stripComments(repoFile('src/lib/confirmation-queue.ts'));
    const rule = source.slice(source.indexOf('export function pullRefusal('), source.indexOf('export function pullPermission('));
    expect(rule).not.toMatch(/PULL_PACE|pullPaceRefusal|PULL_TOO_FAST/);
  });

  it('only the pull asks it', () => {
    const source = stripComments(repoFile('src/lib/confirmation-queue.ts'));
    const pullBody = source.slice(source.indexOf('export async function pullNextOrder('));
    expect(pullBody).toMatch(/pullPaceRefusal\(/);
    // ...and after the other refusals.
    expect(pullBody.indexOf('pullRefusal(counts)')).toBeGreaterThan(-1);
    expect(pullBody.indexOf('pullRefusal(counts)')).toBeLessThan(pullBody.indexOf('pullPaceRefusal('));
  });
});

describe('the index the count rides on', () => {
  const DIR = 'prisma/migrations/20261108190000_claim_history_pace_index';
  const INDEX = 'order_claim_history_userId_action_createdAt_idx';
  /** The statements of an SQL file, comments gone. */
  const statements = (sql: string) =>
    sql
      .replace(/^\s*--.*$/gm, '')
      .split(';')
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

  it('the count reads the three columns the index leads with — her id, the action, the time — and the reason on top', async () => {
    pulledTimes('sara', 3);
    poolOrder();
    await pull('sara');
    expect(world.historyReads).toHaveLength(1);
    const { where } = world.historyReads[0].args;
    expect(Object.keys(where).sort()).toEqual(['action', 'createdAt', 'reason', 'userId']);
    expect(where).toMatchObject({ userId: 'sara', action: 'CLAIMED', reason: 'PULL_NEXT' });
    // The window opens sixty minutes before the moment of the pull — strictly after it.
    expect(where.createdAt).toEqual({ gt: minutesAgo(60) });
  });

  it('and it is one read, on the pull\'s own connection: inside its transaction, never beside it', async () => {
    pulledTimes('sara', 3);
    poolOrder();
    await pull('sara');
    // A read through the root client would wait for a second connection while the pull holds the first.
    expect(world.historyReads.map((r) => r.via)).toEqual(['tx']);
    // And a refused pull makes the same single read.
    reset();
    pulledTimes('sara', 40);
    poolOrder();
    await pull('sara');
    expect(world.historyReads.map((r) => r.via)).toEqual(['tx']);
  });

  it('the schema says it on OrderClaimHistory', () => {
    const schema = repoFile('prisma/schema.prisma');
    const from = schema.indexOf('model OrderClaimHistory {');
    const block = schema.slice(from, schema.indexOf('\n}', from));
    expect(block).toContain('@@index([userId, action, createdAt])');
    // The two it had before are still there.
    expect(block).toContain('@@index([orderId, createdAt])');
    expect(block).toContain('@@index([companyId, userId])');
  });

  it('the migration adds that one index, idempotently, and nothing else', () => {
    expect(statements(repoFile(`${DIR}/migration.sql`))).toEqual([
      `CREATE INDEX IF NOT EXISTS "${INDEX}" ON "order_claim_history"("userId", "action", "createdAt")`,
    ]);
  });

  it('the rollback drops it and forgets the migration', () => {
    expect(statements(repoFile(`${DIR}/rollback.sql`))).toEqual([
      `DROP INDEX IF EXISTS "${INDEX}"`,
      `DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261108190000_claim_history_pace_index'`,
    ]);
  });
});
