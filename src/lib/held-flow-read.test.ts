/* eslint-disable @typescript-eslint/no-explicit-any -- the fake database reads rows and `where` objects by their names */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OPEN_CONFIRMATION } from './confirmation-queue';
import { ROW_CAP, REPORT_ROW_CAP, noAnswerBoard } from './no-answer-watch';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «حركة الطلبات» — THE QUESTIONS, AGAINST A DATABASE THAT REALLY ANSWERS THEM.
 *
 * A fake that records what it was asked can only say «the scope was in the question». This one holds orders, claim lines, status
 * logs and attempts of THREE shops — ours, another store of the same company, and another company — and EVALUATES the `where` it is
 * handed, refusing any key or operator it does not know. So a question that loses its company or its store counts the neighbour's
 * rows here exactly as Postgres would, and every claim is about ANSWERS: the number each tile gets from a fixture counted by hand.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Row = Record<string, any>;

const NOW = new Date('2026-11-11T12:00:00.000Z'); // a Wednesday
const min = (m: number) => new Date(NOW.getTime() - m * 60_000);
const hours = (h: number) => min(h * 60);
const days = (d: number) => min(d * 24 * 60);
const UTC_DESK = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'UTC' };

const store: { orders: Row[]; claims: Row[]; logs: Row[]; attempts: Row[]; asked: { model: string; op: string; args: Row }[] } = {
  orders: [],
  claims: [],
  logs: [],
  attempts: [],
  asked: [],
};

// ───────────────────────── the evaluator ─────────────────────────

const same = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);

function cond(value: any, cell: any): boolean {
  if (value === null) return cell === null || cell === undefined;
  if (typeof value !== 'object' || value instanceof Date) return same(cell, value);
  for (const [op, arg] of Object.entries(value)) {
    if (op === 'not') {
      if (arg === null ? cell == null : same(cell, arg)) return false;
    } else if (op === 'in') {
      if (!(arg as unknown[]).some((x) => same(x, cell))) return false;
    } else if (op === 'gte') {
      if (!(cell instanceof Date) || cell < (arg as Date)) return false;
    } else if (op === 'lte') {
      if (!(cell instanceof Date) || cell > (arg as Date)) return false;
    } else throw new Error(`الفيك ما بيعرف العامل ${op}`);
  }
  return true;
}

function matches(row: Row, where: Row, keys: string[], relations: Record<string, (r: Row) => Row | undefined> = {}): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k in relations) {
      const other = relations[k](row);
      if (!other || !matches(other, v as Row, ORDER_KEYS)) return false;
    } else if (keys.includes(k)) {
      if (!cond(v, row[k])) return false;
    } else throw new Error(`الفيك ما بيعرف المفتاح ${k}`);
  }
  return true;
}

const ORDER_KEYS = ['id', 'companyId', 'storeId', 'createdAt', 'claimedById', 'claimedAt', 'confirmationStatus'];
const orderOf = (r: Row) => store.orders.find((o) => o.id === r.orderId);
const THE_ORDER = { order: orderOf };

const MODELS = {
  order: { rows: () => store.orders, keys: ORDER_KEYS, relations: {} },
  orderClaimHistory: { rows: () => store.claims, keys: ['companyId', 'createdAt', 'orderId'], relations: THE_ORDER },
  orderStatusLog: {
    rows: () => store.logs,
    keys: ['companyId', 'statusType', 'previousValue', 'newValue', 'createdAt', 'orderId'],
    relations: THE_ORDER,
  },
  orderContactAttempt: { rows: () => store.attempts, keys: ['companyId', 'createdAt', 'orderId'], relations: THE_ORDER },
} as const;

function find(model: keyof typeof MODELS, args: Row): Row[] {
  store.asked.push({ model, op: 'findMany', args });
  const m = MODELS[model];
  let rows = m.rows().filter((r) => matches(r, args.where, [...m.keys], m.relations as Record<string, (r: Row) => Row | undefined>));
  if (args.orderBy) {
    const [[field, dir]] = Object.entries(args.orderBy) as [string, string][];
    rows = [...rows].sort((a, b) => {
      const x = a[field] instanceof Date ? a[field].getTime() : a[field];
      const y = b[field] instanceof Date ? b[field].getTime() : b[field];
      // PostgreSQL puts NULLs last in an ascending sort.
      if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
      return dir === 'asc' ? x - y : y - x;
    });
  }
  if (args.take !== undefined) rows = rows.slice(0, args.take);
  // Only what was SELECTED comes back: a column the code reads but did not ask for is undefined here, as it would be in the client.
  return rows.map((r) => Object.fromEntries(Object.keys(args.select).map((k) => [k, r[k] ?? null])));
}

const { db } = vi.hoisted(() => ({ db: {} as Row }));
vi.mock('./db', () => ({ db }));
function installFake() {
  Object.assign(db, {
    order: {
      count: vi.fn(async (args: Row) => {
        store.asked.push({ model: 'order', op: 'count', args });
        return store.orders.filter((o) => matches(o, args.where, ORDER_KEYS)).length;
      }),
      findMany: vi.fn(async (args: Row) => find('order', args)),
    },
    orderClaimHistory: { findMany: vi.fn(async (args: Row) => find('orderClaimHistory', args)) },
    orderStatusLog: { findMany: vi.fn(async (args: Row) => find('orderStatusLog', args)) },
    orderContactAttempt: { findMany: vi.fn(async (args: Row) => find('orderContactAttempt', args)) },
  });
}

import { heldFlow, FLOW_CAPS } from './held-flow-read';

// ───────────────────────── the three shops ─────────────────────────

const OURS = { companyId: 'c1', storeId: 's1' };
const OTHER_STORE = { companyId: 'c1', storeId: 's2' };
const OTHER_COMPANY = { companyId: 'c2', storeId: 's9' };

let n = 0;
const order = (over: Row = {}): Row => ({
  id: `o${++n}`,
  ...OURS,
  createdAt: hours(50),
  claimedById: null,
  claimedAt: null,
  confirmationStatus: 'NEW',
  ...over,
});
const claim = (o: Row, userId: string, action: string, reason: string | null, at: Date): Row => ({
  companyId: o.companyId,
  orderId: o.id,
  userId,
  action,
  reason,
  createdAt: at,
});
const log = (o: Row, previousValue: string | null, newValue: string, at: Date, statusType = 'CONFIRMATION'): Row => ({
  companyId: o.companyId,
  orderId: o.id,
  statusType,
  previousValue,
  newValue,
  createdAt: at,
});
const attempt = (o: Row, employeeId: string, at: Date): Row => ({ companyId: o.companyId, orderId: o.id, employeeId, createdAt: at });

const ask = (windowKey: '6h' | '24h' | '7d' = '24h', extra: Row = {}) =>
  heldFlow({ ...OURS, calendar: UTC_DESK, windowKey, now: NOW, ...extra });

beforeEach(() => {
  n = 0;
  store.orders = [];
  store.claims = [];
  store.logs = [];
  store.attempts = [];
  store.asked = [];
  installFake();
});

/**
 * ONE SHOP, COUNTED BY HAND. (`now` is Wednesday 12:00; the window is the last 24 hours unless a test says otherwise.)
 *
 *   o1  created 2h ago.   Pulled by A 100 min ago, rung by A 90 min ago (10 minutes), confirmed by A 40 min ago.      → pull, fast, exit «أُكِّد»
 *   o2  created 30h ago.  Pulled by A 5h ago, never rung, released by the 90-minute rule 3h ago; pulled by B 2h ago,
 *                          rung by B 100 min ago (20 minutes) — and held now (claimed 2h ago).                         → 2 pulls, 1 bounce, exit «رجع»
 *   o3  created 4h ago.   Claimed BEFORE the window (2 days ago), cancelled by A 30 min ago (NO_ANSWER → CANCELLED).  → exit «انلغى», no pull
 *   o4  created 3h ago.   Typed by A 3h ago (MANUAL_ENTRY), confirmed by A 2h50 ago.                                  → entered «بغير السحب», exit «أُكِّد»
 *   o5  created 1h ago.   Still in the pool.                                                                          → «دخل النظام» only
 *   o6  created 5h ago.   Held by C since 4 days ago (POSTPONED) — over three days.                                   → held, old
 *   o7  created 5h ago.   Confirmed by the MANAGER from the list: nobody ever held it.                               → NOT an exit from a hand
 *   o8  created 7h ago.   Held by B since 30 hours ago (IN_PROGRESS).                                                 → held, 1–3 days
 *
 * Then the same rows again in the other store and in the other company, with the same shapes: none of them may be counted.
 */
function theShop() {
  const o1 = order({ createdAt: hours(2), claimedById: 'A', claimedAt: min(100), confirmationStatus: 'CONFIRMED' });
  const o2 = order({ createdAt: hours(30), claimedById: 'B', claimedAt: hours(2), confirmationStatus: 'IN_PROGRESS' });
  const o3 = order({ createdAt: hours(4), claimedById: 'A', claimedAt: days(2), confirmationStatus: 'CANCELLED' });
  const o4 = order({ createdAt: hours(3), claimedById: 'A', claimedAt: hours(3), confirmationStatus: 'CONFIRMED' });
  const o5 = order({ createdAt: hours(1) });
  const o6 = order({ createdAt: hours(5), claimedById: 'C', claimedAt: days(4), confirmationStatus: 'POSTPONED' });
  const o7 = order({ createdAt: hours(5), confirmationStatus: 'CONFIRMED' });
  const o8 = order({ createdAt: hours(7), claimedById: 'B', claimedAt: hours(30), confirmationStatus: 'IN_PROGRESS' });
  store.orders.push(o1, o2, o3, o4, o5, o6, o7, o8);

  store.claims.push(
    claim(o1, 'A', 'CLAIMED', 'PULL_NEXT', min(100)),
    claim(o2, 'A', 'CLAIMED', 'PULL_NEXT', hours(5)),
    claim(o2, 'A', 'RELEASED', 'AUTO_RELEASE_90_BUSINESS_MINUTES', hours(3)),
    claim(o2, 'B', 'CLAIMED', 'PULL_NEXT', hours(2)),
    claim(o3, 'A', 'CLAIMED', 'PULL_NEXT', days(2)), // before the window
    claim(o4, 'A', 'CLAIMED', 'MANUAL_ENTRY', hours(3)),
    claim(o6, 'C', 'CLAIMED', 'PULL_NEXT', days(4)), // before the window
    claim(o8, 'B', 'CLAIMED', 'PULL_NEXT', hours(30)) // before the window
  );
  store.logs.push(
    log(o1, 'IN_PROGRESS', 'CONFIRMED', min(40)),
    log(o3, 'NO_ANSWER', 'CANCELLED', min(30)),
    log(o4, 'NEW', 'CONFIRMED', min(170)),
    log(o7, 'NEW', 'CONFIRMED', hours(2)),
    log(o1, null, 'IN_PROGRESS', min(100)) // the pull's own line: not a decision
  );
  store.attempts.push(attempt(o1, 'A', min(90)), attempt(o2, 'B', min(100)));

  // The neighbours — every shape again, in the other store and in the other company.
  for (const shop of [OTHER_STORE, OTHER_COMPANY]) {
    const x = order({ ...shop, createdAt: hours(2), claimedById: 'X', claimedAt: min(100), confirmationStatus: 'CONFIRMED' });
    const y = order({ ...shop, createdAt: hours(1), claimedById: 'X', claimedAt: days(5), confirmationStatus: 'IN_PROGRESS' });
    store.orders.push(x, y);
    store.claims.push(
      claim(x, 'X', 'CLAIMED', 'PULL_NEXT', min(100)),
      claim(x, 'Y', 'CLAIMED', 'PULL_NEXT', min(90)),
      claim(y, 'X', 'CLAIMED', 'MANUAL_ENTRY', min(80)),
      claim(y, 'X', 'RELEASED', null, min(70))
    );
    store.logs.push(log(x, 'IN_PROGRESS', 'CONFIRMED', min(40)), log(y, 'NEW', 'CANCELLED', min(30)));
    store.attempts.push(attempt(x, 'X', min(95)));
  }
  return { o1, o2, o3, o4, o5, o6, o7, o8 };
}

describe('the shop, counted by hand', () => {
  it('«دخل النظام» is the orders CREATED in the window — ours only', async () => {
    theShop();
    // o1 · o3 · o4 · o5 · o6 · o7 · o8 (o2 is 30 hours old).
    expect((await ask()).created).toBe(7);
    expect((await ask('6h')).created).toBe(6); // o1 · o3 · o4 · o5 · o6 · o7 (o8 is seven hours old)
    expect((await ask('7d')).created).toBe(8);
  });

  it('«انسحب» and the rest of the entries, from the claim ledger', async () => {
    theShop();
    const f = await ask();
    // pulls inside 24h: o1 (A), o2 (A), o2 (B). The pulls of o3, o6, o8 were before the window; o4 was typed.
    expect(f.entered).toEqual({ pulled: 3, typed: 1, onTheLine: 0, total: 4 });
  });

  it('«طلع من الأيدي»: the yes, the no, and the release — and a yes nobody held is not a hand letting go', async () => {
    theShop();
    const f = await ask();
    // confirmed: o1 and o4 (o7 was the manager's, no holder). cancelled: o3. returned: o2's release.
    expect(f.exits).toEqual({ confirmed: 2, returned: 1, cancelled: 1, total: 4 });
    expect(f.net).toBe(0);
  });

  it('the pile now, by age: wall clock, and the oldest', async () => {
    theShop();
    const f = await ask();
    // held now: o2 (2h) · o6 (4 days) · o8 (30h).
    expect(f.held).toEqual({
      total: 3,
      under6h: 1,
      from6hTo24h: 0,
      from1dTo3d: 1,
      over3d: 1,
      unknownAge: 0,
      oldestMs: 4 * 24 * 3_600_000,
    });
  });

  it('how smooth: o1 rung in 10 minutes by A, o2’s first pull never rung, o2’s second rung in 20 minutes by B', async () => {
    theShop();
    const f = await ask();
    // The UTC desk works 09:00–17:00 on a Wednesday: every minute here is a working minute (07:20–12:00 is partly before opening
    // for o2’s first pull, whose own 30 working minutes have long passed).
    expect(f.speed).toEqual({ judged: 3, withAttempt: 2, fast: 2, medianMinutes: 15 });
    expect(f.bounced).toEqual({ orders: 1, of: 2 });
  });

  it('the window moves what it counts: six hours, a day, a week', async () => {
    theShop();
    expect((await ask('6h')).entered.pulled).toBe(3); // o1 (100 min), o2 B (2h), o2 A (5h)
    expect((await ask('6h')).exits.total).toBe(4);
    const week = await ask('7d');
    // the week also holds the pulls of o3 (2 days), o6 (4 days) and o8 (30 hours)
    expect(week.entered.pulled).toBe(6);
  });

  it('the result says which window it is, in ISO time', async () => {
    theShop();
    const f = await ask('6h');
    expect(f.window).toEqual({ key: '6h', label: 'آخر 6 ساعات', start: hours(6).toISOString(), end: NOW.toISOString() });
    expect(f.rules).toEqual({ fastMinutes: 30 });
  });

  it('the reading is made from these very figures', async () => {
    theShop();
    const f = await ask();
    // 4 entered, 4 left: few events, calm — and the three held orders are too few to be «old» (ten is the floor).
    expect(f.reading).toEqual({ tone: 'CALM', label: 'ماشية', sentences: ['حركة قليلة: سحبوا 3 وأخدوا 1 بغير السحب وطلع من أيديهم 4.'] });
  });
});

describe('a reason nobody taught the table', () => {
  it('is counted in «غير ذلك», said, and in no sum — whichever door wrote it — while a person’s words on a release stay an exit', async () => {
    const o = order({ claimedById: 'A', claimedAt: hours(1), confirmationStatus: 'IN_PROGRESS' });
    store.orders.push(o);
    store.claims.push(
      claim(o, 'A', 'CLAIMED', 'PULL_NEXT', min(50)),
      claim(o, 'M', 'CLAIMED', 'استلام يدوي', min(40)), // the claim-by-number door: its reason is a free text
      claim(o, 'A', 'RELEASED', 'NEW_AUTO_RULE', min(30)), // a release written like a code nobody taught the table
      claim(o, 'A', 'UNLOCKED', null, min(20)), // an action nobody writes today
      claim(o, 'A', 'RELEASED', 'ما بقدر أكمل', min(10)) // the release button: an exit
    );
    const f = await ask();
    expect(f.unknown).toBe(3);
    expect(f.entered).toEqual({ pulled: 1, typed: 0, onTheLine: 0, total: 1 });
    expect(f.exits).toEqual({ confirmed: 0, returned: 1, cancelled: 0, total: 1 });
    expect(f.net).toBe(0);
  });
});

describe('another store’s rows and another company’s are never counted — by any of the five questions', () => {
  it('a neighbour with nothing of ours in it counts for nothing', async () => {
    // Only the neighbours' rows (theShop adds them beside ours; here WITHOUT ours).
    theShop();
    store.orders = store.orders.filter((o) => o.companyId !== 'c1' || o.storeId !== 's1');
    store.claims = store.claims.filter((c) => store.orders.some((o) => o.id === c.orderId));
    store.logs = store.logs.filter((c) => store.orders.some((o) => o.id === c.orderId));
    store.attempts = store.attempts.filter((c) => store.orders.some((o) => o.id === c.orderId));
    const f = await ask();
    expect(f.created).toBe(0);
    expect(f.entered.total).toBe(0);
    expect(f.exits.total).toBe(0);
    expect(f.held.total).toBe(0);
    expect(f.speed).toEqual({ judged: 0, withAttempt: 0, fast: 0, medianMinutes: null });
    expect(f.bounced).toEqual({ orders: 0, of: 0 });
  });

  it('every question carries the company, and the store — directly or through the order', async () => {
    theShop();
    await ask();
    expect(store.asked).toHaveLength(5);
    for (const { model, args } of store.asked) {
      const where = args.where as Row;
      expect(where.companyId, `${model}.${args && 'companyId'}`).toBe('c1');
      const storeId = where.storeId ?? where.order?.storeId;
      expect(storeId, `${model} is scoped to the store`).toBe('s1');
    }
  });

  it('asks five GROUPED questions, never one per agent or per order — however many there are', async () => {
    theShop();
    for (let i = 0; i < 40; i++) {
      const o = order({ claimedById: `agent${i}`, claimedAt: hours(i), confirmationStatus: 'IN_PROGRESS' });
      store.orders.push(o);
      store.claims.push(claim(o, `agent${i}`, 'CLAIMED', 'PULL_NEXT', hours(1)));
      store.attempts.push(attempt(o, `agent${i}`, min(30)));
    }
    store.asked = [];
    await ask('7d');
    expect(store.asked).toHaveLength(5);
  });

  it('reads no customer field — only ids, times, actions and reasons', async () => {
    theShop();
    await ask();
    const allowed = new Set(['orderId', 'userId', 'action', 'reason', 'createdAt', 'newValue', 'employeeId', 'claimedAt']);
    for (const { args } of store.asked) for (const key of Object.keys(args.select ?? {})) expect(allowed.has(key), key).toBe(true);
    // The count has no select at all: a number and nothing else.
    expect(store.asked.find((a) => a.op === 'count')?.args.select).toBeUndefined();
  });
});

describe('the window’s own edges', () => {
  it('a line AT the start and AT now is inside; a millisecond outside either is not', async () => {
    const o = order({ createdAt: hours(30) });
    store.orders.push(o);
    const start = hours(24);
    store.claims.push(
      claim(o, 'A', 'CLAIMED', 'PULL_NEXT', new Date(start.getTime() - 1)),
      claim(o, 'A', 'CLAIMED', 'PULL_NEXT', start),
      claim(o, 'B', 'CLAIMED', 'PULL_NEXT', NOW),
      claim(o, 'B', 'CLAIMED', 'PULL_NEXT', new Date(NOW.getTime() + 1))
    );
    expect((await ask()).entered.pulled).toBe(2);
  });

  it('an order created at the edge is counted at both edges and not outside', async () => {
    store.orders.push(order({ createdAt: new Date(hours(24).getTime() - 1) }), order({ createdAt: hours(24) }), order({ createdAt: NOW }), order({ createdAt: new Date(NOW.getTime() + 1) }));
    expect((await ask()).created).toBe(2);
  });
});

describe('what counts as a decision from a hand', () => {
  it('only a move out of an OPEN status into a decision, on an order that has a holder, from the CONFIRMATION log, in this store', async () => {
    const held = order({ claimedById: 'A', claimedAt: hours(1), confirmationStatus: 'CONFIRMED' });
    const none = order({ confirmationStatus: 'CONFIRMED' });
    store.orders.push(held, none);
    store.logs.push(
      log(held, 'IN_PROGRESS', 'CONFIRMED', min(10)), // ✓
      log(held, 'NO_ANSWER', 'REJECTED', min(9)), // ✓ (a second decision on it: an event)
      log(held, 'CONFIRMED', 'CANCELLED', min(8)), // ✗ out of «confirmed»: not a hand
      log(held, null, 'CONFIRMED', min(7)), // ✗ the order was born confirmed
      log(held, 'IN_PROGRESS', 'CONFIRMED', min(6), 'SHIPPING'), // ✗ another log
      log(held, 'IN_PROGRESS', 'POSTPONED', min(5)), // ✗ not a decision
      log(none, 'NEW', 'CONFIRMED', min(4)) // ✗ nobody held it
    );
    const f = await ask();
    expect(f.exits).toEqual({ confirmed: 1, returned: 0, cancelled: 1, total: 2 });
  });

  it('the same four statuses the board calls open — and none else', () => {
    expect(OPEN_CONFIRMATION).toEqual(['NEW', 'IN_PROGRESS', 'NO_ANSWER', 'FOLLOW_UP_REQUIRED', 'POSTPONED']);
  });
});

describe('«بيد الموظفات الآن» is the board’s own number', () => {
  it('the held list is asked with the very `where` the board asks for its first tile — the two screens cannot drift', async () => {
    const seen: Row[] = [];
    // The board reads six things; this stand-in answers all of them with nothing and keeps what the held question was.
    Object.assign(db, {
      order: {
        findMany: vi.fn(async (args: Row) => {
          seen.push(args.where);
          return [];
        }),
        groupBy: vi.fn(async () => []),
        count: vi.fn(async () => 0),
      },
      orderContactAttempt: { groupBy: vi.fn(async () => []), findMany: vi.fn(async () => []) },
      orderClaimHistory: { findMany: vi.fn(async () => []) },
      orderStatusLog: { findMany: vi.fn(async () => []) },
      user: { findMany: vi.fn(async () => []) },
    });
    await noAnswerBoard({ ...OURS, calendar: UTC_DESK, now: NOW });
    await heldFlow({ ...OURS, calendar: UTC_DESK, windowKey: '24h', now: NOW });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[0]).toEqual({ ...OURS, claimedById: { not: null }, confirmationStatus: { in: OPEN_CONFIRMATION } });
  });
});

describe('bounds — when a read is cut, the end of the window goes, and it is said', () => {
  function manyPulls(count: number) {
    const o = order({ createdAt: hours(30) });
    store.orders.push(o);
    for (let i = 0; i < count; i++) store.claims.push(claim(o, 'A', 'CLAIMED', 'PULL_NEXT', min(600 - i)));
    return o;
  }

  it('the caps are the board’s and the report’s own', () => {
    expect(FLOW_CAPS).toEqual({ ledger: ROW_CAP, decisions: ROW_CAP, attempts: REPORT_ROW_CAP, held: ROW_CAP });
  });

  it('a cut claim ledger keeps the OLDEST lines, says so, draws no speed, and the sentence says «حد أدنى»', async () => {
    const o = manyPulls(10);
    store.attempts.push(attempt(o, 'A', min(590)));
    const f = await ask('24h', { caps: { ledger: 4 } });
    expect(f.entered.pulled).toBe(4);
    expect(f.truncated).toEqual({ ledger: true, decisions: false, attempts: false, held: false });
    expect(f.speed).toBeNull();
    expect(f.reading.tone).toBe('WATCH');
    expect(f.reading.sentences[0]).toContain('حد أدنى');
  });

  it('…and WHICH lines it keeps is the oldest, never the newest: the end of the window is what goes', async () => {
    // Ten lines of one order: the four oldest are pulls, the six newest are orders the agent typed.
    const o = order({ createdAt: hours(30) });
    store.orders.push(o);
    for (let i = 0; i < 10; i++) store.claims.push(claim(o, 'A', 'CLAIMED', i < 4 ? 'PULL_NEXT' : 'MANUAL_ENTRY', min(600 - i)));
    const f = await ask('24h', { caps: { ledger: 4 } });
    expect(f.entered).toEqual({ pulled: 4, typed: 0, onTheLine: 0, total: 4 });
    // Uncut, the same ten lines are four pulls and six typed.
    expect((await ask('24h')).entered).toEqual({ pulled: 4, typed: 6, onTheLine: 0, total: 10 });
  });

  it('a cut list of decisions keeps the OLDEST too, and says its own bound', async () => {
    const o = order({ claimedById: 'A', claimedAt: hours(3), confirmationStatus: 'CONFIRMED' });
    store.orders.push(o);
    store.logs.push(log(o, 'NEW', 'CONFIRMED', min(30)), log(o, 'NEW', 'CONFIRMED', min(20)), log(o, 'NEW', 'REJECTED', min(10)));
    const f = await ask('24h', { caps: { decisions: 2 } });
    expect(f.truncated.decisions).toBe(true);
    expect(f.exits).toEqual({ confirmed: 2, returned: 0, cancelled: 0, total: 2 });
    expect(f.reading.tone).toBe('WATCH');
    expect(f.reading.sentences[0]).toContain('حد أدنى');
    // Uncut: the rejection is there.
    expect((await ask('24h')).exits).toEqual({ confirmed: 2, returned: 0, cancelled: 1, total: 3 });
  });

  it('a list one short of its bound is not cut; at the bound it is — each of the four', async () => {
    manyPulls(4);
    expect((await ask('24h', { caps: { ledger: 5 } })).truncated.ledger).toBe(false);
    expect((await ask('24h', { caps: { ledger: 4 } })).truncated.ledger).toBe(true);

    const o = order({ claimedById: 'A', claimedAt: hours(1), confirmationStatus: 'IN_PROGRESS' });
    store.orders.push(o);
    store.logs.push(log(o, 'NEW', 'CONFIRMED', min(10)), log(o, 'NEW', 'CONFIRMED', min(9)));
    store.attempts.push(attempt(o, 'A', min(8)), attempt(o, 'A', min(7)));
    // The order is held (1) and has two decisions and two attempts: one short of each bound, then exactly at it.
    const under = await ask('24h', { caps: { decisions: 3, attempts: 3, held: 2 } });
    expect(under.truncated).toEqual({ ledger: false, decisions: false, attempts: false, held: false });
    const at = await ask('24h', { caps: { decisions: 2, attempts: 2, held: 1 } });
    expect(at.truncated).toEqual({ ledger: false, decisions: true, attempts: true, held: true });
  });

  it('each list has its own bound, and says its own', async () => {
    const o = order({ claimedById: 'A', claimedAt: hours(1), confirmationStatus: 'CONFIRMED' });
    store.orders.push(
      o,
      order({ claimedById: 'B', claimedAt: hours(2), confirmationStatus: 'IN_PROGRESS' }),
      order({ claimedById: 'C', claimedAt: hours(3), confirmationStatus: 'IN_PROGRESS' }),
      order({ claimedById: 'D', claimedAt: hours(1), confirmationStatus: 'IN_PROGRESS' })
    );
    store.logs.push(log(o, 'NEW', 'CONFIRMED', min(10)), log(o, 'NEW', 'CONFIRMED', min(9)));
    store.attempts.push(attempt(o, 'A', min(8)), attempt(o, 'A', min(7)));
    const f = await ask('24h', { caps: { decisions: 2, attempts: 2, held: 2 } });
    expect(f.truncated).toEqual({ ledger: false, decisions: true, attempts: true, held: true });
    expect(f.held.total).toBe(2);
    // The held list is read oldest claim first: of the three held, the cut takes the youngest (D, one hour) and keeps C and B.
    expect(f.held.oldestMs).toBe(3 * 3_600_000);
    expect(f.held.under6h).toBe(2);
    expect(f.speed).toBeNull(); // the attempts were cut
  });

  it('a cut HELD list still has its old buckets exact — the oldest are read first', async () => {
    for (let i = 0; i < 6; i++) store.orders.push(order({ claimedById: 'A', claimedAt: days(10 - i), confirmationStatus: 'IN_PROGRESS' }));
    const f = await ask('24h', { caps: { held: 3 } });
    expect(f.held.over3d).toBe(3);
    expect(f.truncated.held).toBe(true);
  });
});

describe('the calendar', () => {
  it('counts working minutes of the window from the store’s own calendar — a night is not a standstill', async () => {
    // Wednesday 12:00 UTC desk, 09:00–17:00, weekend Friday and Saturday.
    expect((await ask('6h')).workMinutes).toBe(180);
    expect((await ask('24h')).workMinutes).toBe(480); // Tue 12:00–17:00 and Wed 09:00–12:00
    expect((await ask('7d')).workMinutes).toBe(2400); // no Friday, no Saturday
  });

  it('a window at night with held orders and nothing moving is a calm «no work» sentence', async () => {
    store.orders.push(order({ claimedById: 'A', claimedAt: hours(2), confirmationStatus: 'IN_PROGRESS' }));
    const night = new Date('2026-11-11T02:00:00.000Z'); // 02:00 on a Wednesday
    const f = await heldFlow({ ...OURS, calendar: UTC_DESK, windowKey: '6h', now: night });
    expect(f.workMinutes).toBe(0);
    expect(f.reading.tone).toBe('CALM');
    expect(f.reading.sentences).toEqual(['ما في حركة بهالمدة — وما كان فيها دوام تقريباً.']);
  });

  it('the same silence during working hours is a standstill', async () => {
    store.orders.push(order({ claimedById: 'A', claimedAt: hours(2), confirmationStatus: 'IN_PROGRESS' }));
    const f = await ask('6h');
    expect(f.reading.tone).toBe('PROBLEM');
    expect(f.reading.sentences[0]).toContain('ما تحرّك شي بهالمدة رغم الدوام');
  });

  it('a calendar with no working time at all never throws — the speed is simply what the clock says', async () => {
    const o = order({ claimedById: 'A', claimedAt: min(100), confirmationStatus: 'IN_PROGRESS' });
    store.orders.push(o);
    store.claims.push(claim(o, 'A', 'CLAIMED', 'PULL_NEXT', min(100)));
    const f = await heldFlow({ ...OURS, calendar: { ...UTC_DESK, workHoursStart: '17:00', workHoursEnd: '09:00' }, windowKey: '24h', now: NOW });
    expect(f.workMinutes).toBe(0);
    expect(f.speed).toEqual({ judged: 0, withAttempt: 0, fast: 0, medianMinutes: null });
  });
});

describe('an empty store', () => {
  it('answers zeros, a calm sentence, and nothing to divide by', async () => {
    const f = await ask();
    expect(f.created).toBe(0);
    expect(f.entered.total).toBe(0);
    expect(f.exits.total).toBe(0);
    expect(f.net).toBe(0);
    expect(f.held.total).toBe(0);
    expect(f.held.oldestMs).toBeNull();
    expect(f.speed).toEqual({ judged: 0, withAttempt: 0, fast: 0, medianMinutes: null });
    expect(f.bounced).toEqual({ orders: 0, of: 0 });
    expect(f.reading.sentences).toEqual(['ما في حركة بهالمدة، ولا في طلبات محجوزة عند الموظفات.']);
    expect(f.reading.tone).toBe('CALM');
  });
});

describe('an order claimed before the window and decided inside it', () => {
  it('is an exit and never a pull — and is not a pull for the speed either', async () => {
    const o = order({ claimedById: 'A', claimedAt: days(3), confirmationStatus: 'CONFIRMED' });
    store.orders.push(o);
    store.claims.push(claim(o, 'A', 'CLAIMED', 'PULL_NEXT', days(3)));
    store.logs.push(log(o, 'NO_ANSWER', 'CONFIRMED', min(20)));
    store.attempts.push(attempt(o, 'A', min(25)));
    const f = await ask();
    expect(f.entered.total).toBe(0);
    expect(f.exits.confirmed).toBe(1);
    expect(f.speed).toEqual({ judged: 0, withAttempt: 0, fast: 0, medianMinutes: null });
  });
});
