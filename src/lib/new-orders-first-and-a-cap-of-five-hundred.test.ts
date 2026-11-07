import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — the pull gives NEW orders first, and one agent may hold 500 (the owner, 7/11)
 *
 * «الأولوية دائما للطلبات الجديدة لما يسحبو الطلبات» · «الحد 500 أفضل شي».
 *
 *  1. The pull's order is: what is held for her · an order NOBODY HAS RUNG YET (the oldest first) · a postponed order that is due
 *     (by its date) · the oldest of the rest. The same with «نظام الجولات» OFF and ON — the pull never reads the switch.
 *  2. The number «بانتظارك» is still exactly the pile the pull draws from: every order counted is pulled, in some order, and
 *     the pull that follows the last one is told the queue is empty.
 *  3. One agent may hold 500 (it was 300): the 500th pull is allowed, the 501st is refused, her own entry and «أكّده الآن» stop at
 *     500 too, the room a hold may take is read from it, and every sentence that names it says 500. The cap of 40 orders
 *     with no attempt is unchanged.
 *
 * Driven against an in-memory database that APPLIES the filters (with SQL's three values), so the answer comes from the
 * filter's own text and not from a mock that was told it.
 *
 * Blockers: no money, no permission, no order creation, no migration.
 * ═══════════════════════════════════════════════════════════════════════
 */

// A fake database row: its values are read by the filter operators below, whatever their type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const { world, sw } = vi.hoisted(() => ({
  world: { orders: [] as Row[], users: new Map<string, Row>(), history: [] as Row[], logs: [] as Row[] },
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
    orderClaimHistory: { create: vi.fn(async ({ data }: Row) => void world.history.push(data)) },
    notification: { createMany: vi.fn(async () => ({ count: 1 })) },
    orderStatusLog: { create: vi.fn(async ({ data }: Row) => void world.logs.push(data)) },
    // The pull's per-customer lock and the hold of his other orders (`twins-follow-the-pull.ts`): one agent at a time here.
    orderActivity: { create: vi.fn(async () => undefined) },
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return { db, default: db };
});
// The switch the pull reads before its transaction — the test says what it is.
vi.mock('./no-answer-rounds-switch', () => ({ roundsSwitch: async () => sw.value }));

import {
  CLAIM_CAPS,
  ENTRY_CAP_FULL_MESSAGE,
  capFullMessage,
  capRoom,
  entryOwnership,
  pickNextCandidate,
  pullNextOrder,
  pullRefusal,
  waitingCount,
} from './confirmation-queue';
import { ROUNDS_OFF } from './no-answer-rounds';
import { db } from './db';

const NOW = new Date('2026-11-07T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const hoursAhead = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
const scope = { companyId: 'c1', storeId: 's1' };
const CAL = { workHoursStart: '00:00', workHoursEnd: '23:59', weekendDays: [] as number[], timezone: 'UTC' };
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
/** Rung before and nobody answered: let go, so it is in the queue with an attempt on it. */
const rung = (over: Row = {}) =>
  order({ confirmationStatus: 'NO_ANSWER', status: 'NO_ANSWER', contactAttempts: [{ createdAt: hoursAgo(30), result: 'NO_ANSWER', employeeId: 'x' }], ...over });
/** A postponed order whose date is within the lead days. */
const due = (over: Row = {}) =>
  order({
    confirmationStatus: 'POSTPONED', status: 'POSTPONED', postponedUntil: hoursAhead(1),
    contactAttempts: [{ createdAt: hoursAgo(60), result: 'POSTPONED', employeeId: 'x' }], ...over,
  });
const byId = (id: string) => world.orders.find((r) => r.id === id)!;

beforeEach(() => {
  world.orders = [];
  world.users.clear();
  world.history = [];
  world.logs = [];
  seq = 0;
  sw.value = ROUNDS_OFF;
  vi.clearAllMocks();
  for (const id of ['sara', 'huda', 'noor', 'abeer']) user(id);
});

describe.each([
  ['OFF', ROUNDS_OFF],
  ['ON', { enabled: true, enabledAt: hoursAgo(300) }],
])('the pull with «نظام الجولات» %s — a new order first', (_label, value) => {
  beforeEach(() => {
    sw.value = value;
  });

  it('a new order, then a due postponed one, then the rest — whatever their ages', async () => {
    // The oldest is the rung one, then the postponed one; the new ones are the youngest of all.
    const rest = rung({ createdAt: hoursAgo(50) });
    const postponed = due({ createdAt: hoursAgo(40) });
    const newer = order({ createdAt: hoursAgo(1) });
    const newest = order({ createdAt: hoursAgo(0.5) });

    const pulls: string[] = [];
    for (const who of ['sara', 'huda', 'noor', 'abeer']) {
      const out = await pullNextOrder(scope, agent(who), CAL, NOW);
      expect(out.ok, who).toBe(true);
      pulls.push(out.orderId!);
    }
    expect(pulls).toEqual([newer.id, newest.id, postponed.id, rest.id]);
  });

  it('and then the queue is empty, and the number said so all along: every order counted was pulled', async () => {
    rung({ createdAt: hoursAgo(50) });
    due({ createdAt: hoursAgo(40) });
    order({ createdAt: hoursAgo(1) });
    // A postponed order whose day is far off is neither counted nor pulled.
    due({ postponedUntil: hoursAhead(24 * 10), createdAt: hoursAgo(70) });

    expect(await waitingCount(db as never, scope, NOW, 'sara')).toBe(3);
    let pulled = 0;
    for (const who of ['sara', 'huda', 'noor', 'abeer']) {
      const out = await pullNextOrder(scope, agent(who), CAL, NOW);
      if (out.ok) pulled += 1;
      else expect(out.refusal?.code, who).toBe('QUEUE_EMPTY');
    }
    expect(pulled).toBe(3);
  });

  it('the older new order first among the new ones', async () => {
    const younger = order({ createdAt: hoursAgo(1) });
    const older = order({ createdAt: hoursAgo(9) });
    expect(await pickNextCandidate(db as never, scope, NOW, 'sara')).toBe(older.id);
    byId(older.id).claimedById = 'huda';
    expect(await pickNextCandidate(db as never, scope, NOW, 'sara')).toBe(younger.id);
  });

  it('a due postponed order still comes before the rest — the rung ones (by its date, not by age)', async () => {
    const rest = rung({ createdAt: hoursAgo(90) });
    const later = due({ postponedUntil: hoursAhead(20), createdAt: hoursAgo(10) });
    const sooner = due({ postponedUntil: hoursAhead(2), createdAt: hoursAgo(5) });
    expect(await pickNextCandidate(db as never, scope, NOW, 'sara')).toBe(sooner.id);
    byId(sooner.id).claimedById = 'huda';
    expect(await pickNextCandidate(db as never, scope, NOW, 'sara')).toBe(later.id);
    byId(later.id).claimedById = 'huda';
    expect(await pickNextCandidate(db as never, scope, NOW, 'sara')).toBe(rest.id);
  });

  it('what is held for her is still first of all — a new order that is not hers waits behind it', async () => {
    const general = order({ createdAt: hoursAgo(30) });
    const hers = order({ createdAt: hoursAgo(1), assignedToId: 'sara', assignedAt: hoursAgo(0.5), assignee: world.users.get('sara') });
    const p = due({ createdAt: hoursAgo(80) });

    expect(await pickNextCandidate(db as never, scope, NOW, 'sara')).toBe(hers.id);
    expect((await pullNextOrder(scope, agent('sara'), CAL, NOW)).orderId).toBe(hers.id);
    // A colleague is not given hers: the oldest new order, then the postponed one.
    expect((await pullNextOrder(scope, agent('huda'), CAL, NOW)).orderId).toBe(general.id);
    expect((await pullNextOrder(scope, agent('noor'), CAL, NOW)).orderId).toBe(p.id);
  });

  it('a new order held for a COLLEAGUE is not new to her — it is not offered', async () => {
    order({ createdAt: hoursAgo(5), assignedToId: 'huda', assignedAt: hoursAgo(1), assignee: world.users.get('huda') });
    const p = due();
    expect(await pickNextCandidate(db as never, scope, NOW, 'sara')).toBe(p.id);
  });

  it('only an order with no attempt at all is new: one she or a colleague only pressed «اتصل» on is not', async () => {
    const pressed = order({ createdAt: hoursAgo(20), contactAttempts: [{ createdAt: hoursAgo(10), result: 'OPENED', employeeId: 'x' }] });
    const p = due({ createdAt: hoursAgo(15) });
    expect(await pickNextCandidate(db as never, scope, NOW, 'sara')).toBe(p.id);
    byId(p.id).claimedById = 'huda';
    expect(await pickNextCandidate(db as never, scope, NOW, 'sara')).toBe(pressed.id);
  });

  it('a decided order is in no step of it', async () => {
    for (const status of ['REJECTED', 'CANCELLED', 'CONFIRMED']) order({ confirmationStatus: status, status, createdAt: hoursAgo(99) });
    expect(await pickNextCandidate(db as never, scope, NOW, 'sara')).toBeNull();
  });
});

describe('the cap is 500 (the owner, 7/11)', () => {
  /** She already holds `n` open orders, every one rung (so the pull gate is about the cap alone). */
  const holding = (n: number, who = 'sara') => {
    for (let i = 0; i < n; i++) {
      order({ customerId: `mine-${who}-${i}`, confirmationStatus: 'IN_PROGRESS', claimedById: who, claimedAt: hoursAgo(1), contactAttempts: [{ createdAt: hoursAgo(0.5), result: 'NO_ANSWER', employeeId: who }], claimHistory: [{ action: 'CLAIMED' }] });
    }
  };

  it('the numbers: 500 in all, 40 without an attempt', () => {
    expect(CLAIM_CAPS).toEqual({ withoutAttempt: 40, total: 500 });
  });

  it('the 500th pull is allowed, and the 501st is refused — in the sentence that says 500', async () => {
    holding(499);
    order({ customerId: 'pool-1', createdAt: hoursAgo(3) });
    order({ customerId: 'pool-2', createdAt: hoursAgo(2) });

    const five00th = await pullNextOrder(scope, agent('sara'), CAL, NOW);
    expect(five00th.ok, JSON.stringify(five00th.refusal)).toBe(true);
    // She rings it, so the only thing in her way is the cap.
    byId(five00th.orderId!).contactAttempts = [{ createdAt: NOW, result: 'NO_ANSWER', employeeId: 'sara' }];

    const five01st = await pullNextOrder(scope, agent('sara'), CAL, NOW);
    expect(five01st.ok).toBe(false);
    expect(five01st.refusal).toEqual({ code: 'CAP_TOTAL', message: 'بلغت الحد الأقصى (500 طلب لديك).' });
    expect(world.orders.filter((r) => r.claimedById === 'sara')).toHaveLength(500);
  });

  it('what is held for her counts, and the sentence says so: 490 in her hands + 10 held = 500', async () => {
    holding(490);
    for (let i = 0; i < 10; i++) {
      order({ customerId: `held-${i}`, createdAt: hoursAgo(9), assignedToId: 'sara', assignedAt: hoursAgo(1), assignee: world.users.get('sara') });
    }
    order({ customerId: 'pool', createdAt: hoursAgo(20) });

    // At the cap by holds, anything NEW is refused — in the pull, what is held for her is still hers to take.
    const out = await pullNextOrder(scope, agent('sara'), CAL, NOW);
    expect(out.ok).toBe(true);
    expect(byId(out.orderId!).customerId).toMatch(/^held-/);
    expect(capFullMessage({ total: 490, heldForHer: 10, withoutAttempt: 0 })).toBe(
      'بلغت الحد الأقصى (500 طلب): 490 بين يديك و10 محجوز لك — المحجوز لك بينعدّ من الحد. خلّص من اللي بإيدك أو اسحب المحجوز لك.'
    );
  });

  it('the room a hold may take: 499 leaves one, 500 leaves none, 490 + 10 held leaves none', () => {
    expect(capRoom({ total: 499, withoutAttempt: 0 })).toBe(1);
    expect(capRoom({ total: 500, withoutAttempt: 0 })).toBe(0);
    expect(capRoom({ total: 490, heldForHer: 10, withoutAttempt: 0 })).toBe(0);
    expect(capRoom({ total: 100, withoutAttempt: 0 })).toBe(400);
  });

  it('her own entry: the 500th is hers, the 501st goes to the queue — and the sentence says 500', () => {
    const holds = (k: string) => k === 'confirmation.work';
    const base = { userId: 'sara', holds, now: NOW };
    expect(entryOwnership({ ...base, heldTotal: 499 }).claimedById).toBe('sara');
    expect(entryOwnership({ ...base, heldTotal: 500 })).toEqual({ claimedById: null, claimedAt: null, currentOwnerId: null, capFull: true });
    expect(ENTRY_CAP_FULL_MESSAGE).toBe('وصلت للحد (500) — الطلب راح للطابور');
  });

  it('the cap of 40 with no attempt is unchanged', () => {
    expect(pullRefusal({ total: 50, withoutAttempt: 40 })?.code).toBe('CAP_WITHOUT_ATTEMPT');
    expect(pullRefusal({ total: 50, withoutAttempt: 40 })?.message).toBe('لديك 40 طلباً بلا محاولة اتصال — الحد 40.');
    expect(pullRefusal({ total: 50, withoutAttempt: 39 })?.code).toBe('UNTOUCHED_ORDER');
    expect(pullRefusal({ total: 50, withoutAttempt: 0 })).toBeNull();
  });
});
