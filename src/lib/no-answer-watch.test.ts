import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «لا رد والطلبات المحجوزة» — EVERY FIGURE AGAINST A HAND COUNT.
 *
 * The database is a small fake that READS the `where` it is given and refuses
 * any key it does not understand, so a query that loses its store or company
 * filter counts the other store's rows here exactly as it would in Postgres.
 * The fixture is one store's desk with a second store and a second company
 * beside it; the comments on each order say what it must add to which card.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Row = Record<string, any>;
const store: { orders: Row[]; attempts: Row[]; users: Row[]; selects: string[][] } = {
  orders: [],
  attempts: [],
  users: [],
  selects: [],
};

function cond(value: any, cell: any): boolean {
  if (value === null) return cell === null || cell === undefined;
  if (typeof value !== 'object' || value instanceof Date) return cell === value;
  for (const [op, arg] of Object.entries(value)) {
    if (op === 'not') { if (arg === null ? cell == null : cell === arg) return false; }
    else if (op === 'in') { if (!(arg as unknown[]).includes(cell)) return false; }
    else if (op === 'gte') { if (!(cell instanceof Date) || cell < (arg as Date)) return false; }
    else if (op === 'lte') { if (!(cell instanceof Date) || cell > (arg as Date)) return false; }
    else if (op === 'lt') { if (!(cell instanceof Date) || cell >= (arg as Date)) return false; }
    else if (op === 'gt') { if (!(cell instanceof Date) || cell <= (arg as Date)) return false; }
    else throw new Error(`الفيك ما بيعرف ${op}`);
  }
  return true;
}

/** Built per query, so a fixture of thousands of rows stays linear. */
function indexes() {
  const orderById = new Map(store.orders.map((o) => [o.id, o]));
  const attemptsOf = new Map<string, Row[]>();
  for (const a of store.attempts) {
    const list = attemptsOf.get(a.orderId);
    if (list) list.push(a);
    else attemptsOf.set(a.orderId, [a]);
  }
  return { orderById, attemptsOf };
}
type Ix = ReturnType<typeof indexes>;

const ORDER_KEYS = ['companyId', 'storeId', 'claimedById', 'confirmationStatus', 'confirmedById', 'confirmedAt', 'createdAt'];
function orderMatches(o: Row, where: Row, ix: Ix): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'contactAttempts') {
      const some = (v as Row).some;
      if (!(ix.attemptsOf.get(o.id) ?? []).some((a) => attemptMatches(a, some, ix))) return false;
    } else if (ORDER_KEYS.includes(k)) {
      if (!cond(v, o[k])) return false;
    } else throw new Error(`الفيك ما بيعرف المفتاح ${k}`);
  }
  return true;
}
function attemptMatches(a: Row, where: Row, ix: Ix): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'order') {
      const o = ix.orderById.get(a.orderId);
      if (!o || !orderMatches(o, v as Row, ix)) return false;
    } else if (k === 'companyId' || k === 'createdAt' || k === 'result') {
      if (!cond(v, a[k])) return false;
    } else throw new Error(`الفيك ما بيعرف المفتاح ${k}`);
  }
  return true;
}
const pick = (row: Row, select: Row) => {
  store.selects.push(Object.keys(select));
  return Object.fromEntries(Object.keys(select).map((k) => [k, row[k] ?? null]));
};
/** `orderBy` as Prisma reads it: one object or a list of them, each `{ field: 'asc' | 'desc' }`. */
function sortBy(rows: Row[], orderBy: Row | Row[] | undefined): Row[] {
  if (!orderBy) return rows;
  const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).map((o) => Object.entries(o)[0] as [string, string]);
  return [...rows].sort((a, b) => {
    for (const [k, dir] of keys) {
      const x = a[k] instanceof Date ? a[k].getTime() : a[k];
      const y = b[k] instanceof Date ? b[k].getTime() : b[k];
      if (x < y) return dir === 'asc' ? -1 : 1;
      if (x > y) return dir === 'asc' ? 1 : -1;
    }
    return 0;
  });
}

const { db, plan } = vi.hoisted(() => ({ db: {} as Row, plan: { since: null as Date | null } }));
vi.mock('./db', () => ({ db }));
// The plan's floor (request C3): off unless a test turns it on.
vi.mock('./no-answer-cadence-switch', () => ({ cadenceSince: async () => plan.since }));
Object.assign(db, {
  order: {
    findMany: vi.fn(async ({ where, select, take }: Row) => {
      const ix = indexes();
      return store.orders.filter((o) => orderMatches(o, where, ix)).slice(0, take).map((o) => pick(o, select));
    }),
    count: vi.fn(async ({ where }: Row) => {
      const ix = indexes();
      return store.orders.filter((o) => orderMatches(o, where, ix)).length;
    }),
    groupBy: vi.fn(async ({ by, where }: Row) => {
      expect(by).toEqual(['confirmedById']);
      const ix = indexes();
      const counts = new Map<string, number>();
      for (const o of store.orders.filter((x) => orderMatches(x, where, ix))) counts.set(o.confirmedById, (counts.get(o.confirmedById) ?? 0) + 1);
      return [...counts].map(([confirmedById, n]) => ({ confirmedById, _count: { _all: n } }));
    }),
  },
  orderContactAttempt: {
    groupBy: vi.fn(async ({ by, where, _max, _count, take }: Row) => {
      const ix = indexes();
      const groups = new Map<string, Row>();
      for (const a of store.attempts.filter((x) => attemptMatches(x, where, ix))) {
        const key = by.map((k: string) => a[k]).join('|');
        const g = groups.get(key) ?? { ...Object.fromEntries(by.map((k: string) => [k, a[k]])), _max: { createdAt: null }, _count: { _all: 0 } };
        if (!g._max.createdAt || a.createdAt > g._max.createdAt) g._max.createdAt = a.createdAt;
        g._count._all++;
        groups.set(key, g);
      }
      return [...groups.values()].slice(0, take).map((g) => ({
        ...Object.fromEntries(by.map((k: string) => [k, g[k]])),
        ...(_max ? { _max: g._max } : {}),
        ...(_count ? { _count: g._count } : {}),
      }));
    }),
    findMany: vi.fn(async ({ where, select, take, orderBy }: Row) => {
      const ix = indexes();
      return sortBy(store.attempts.filter((a) => attemptMatches(a, where, ix)), orderBy).slice(0, take).map((a) => pick(a, select));
    }),
  },
  user: {
    findMany: vi.fn(async ({ where }: Row) => store.users.filter((u) => where.id.in.includes(u.id))),
  },
});

import {
  CONTACT_RESULTS,
  NO_ANSWER_RESULTS,
} from './confirmation-workflow';
import { businessMinutesBetween } from './business-calendar';
import {
  ATTEMPT_BUCKETS,
  REPORT_ROW_CAP,
  answerRateReport,
  isStuck,
  noAnswerBoard,
  numberingOf,
  outcomeOf,
  stuckCutoff,
  tallyAnswerRate,
  type AttemptRow,
} from './no-answer-watch';
import { cadenceCalOf } from './no-answer-cadence';

/** Sunday to Thursday, 09:00–17:00, Amman — Friday and Saturday off. */
const CAL = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' };
/** A local wall-clock moment in Amman (UTC+3). September 2026: the 17th is a Thursday, the 20th a Sunday, the 22nd a Tuesday. */
const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 8, day, hour - 3, minute));
const NOW = at(22, 10);

const SARA = 'u-sara';
const LINA = 'u-lina';
const MAHA = 'u-maha';

const order = (id: string, o: Row): Row => ({
  id, companyId: 'c1', storeId: 's1', claimedById: null, confirmationStatus: 'NEW', createdAt: at(10, 9),
  confirmedById: null, confirmedAt: null, nextFollowUpAt: null, followUpReason: null, followUpStatus: null,
  customerName: 'لا يُقرأ', customerPhone: '0790000000', ...o,
});
const attempt = (orderId: string, attemptNumber: number, result: string, createdAt: Date, companyId = 'c1') =>
  ({ orderId, attemptNumber, result, createdAt, companyId });

function seed() {
  store.selects = [];
  store.users = [{ id: SARA, name: 'سارة' }, { id: LINA, name: 'لينا' }, { id: MAHA, name: 'مها' }];
  store.orders = [
    // ── سارة: بيدها 7 ──
    order('o1', { claimedById: SARA, confirmationStatus: 'IN_PROGRESS' }),           // لا رد فقط
    order('o2', { claimedById: SARA, confirmationStatus: 'NO_ANSWER' }),             // لا رد فقط · عالق (آخر محاولة الخميس 16:30)
    order('o3', { claimedById: SARA, confirmationStatus: 'FOLLOW_UP_REQUIRED',       // وعد حان وقته · ردّ مرة فما هو «لا رد فقط»
      nextFollowUpAt: at(22, 9), followUpReason: 'CUSTOMER_REQUESTED_CALLBACK', followUpStatus: 'SCHEDULED' }),
    order('o4', { claimedById: SARA, confirmationStatus: 'POSTPONED',                // وعد لبكرة · فتح زر فقط · عالق
      nextFollowUpAt: at(23, 10), followUpReason: 'POSTPONED', followUpStatus: 'SCHEDULED' }),
    order('o5', { claimedById: SARA, confirmationStatus: 'NEW' }),                   // بلا محاولة
    order('o6', { claimedById: SARA, confirmationStatus: 'POSTPONED',                // موعده فات بس سببه مش طلب الزبون
      nextFollowUpAt: at(21, 9), followUpReason: 'NO_ANSWER', followUpStatus: 'SCHEDULED' }),
    order('o7', { claimedById: SARA, confirmationStatus: 'POSTPONED',                // وعد انتهى
      nextFollowUpAt: at(22, 8), followUpReason: 'POSTPONED', followUpStatus: 'COMPLETED' }),
    // ── سارة: أكّدت اليوم 2 ──
    order('o8', { claimedById: SARA, confirmationStatus: 'CONFIRMED', confirmedById: SARA, confirmedAt: at(22, 9, 30) }),
    order('o9', { confirmationStatus: 'CONFIRMED', confirmedById: SARA, confirmedAt: at(22, 8) }),
    order('o10', { confirmationStatus: 'CONFIRMED', confirmedById: SARA, confirmedAt: at(21, 12) }), // مبارح
    // ── لينا: بيدها 2 ──
    order('o12', { claimedById: LINA, confirmationStatus: 'NO_ANSWER' }),            // لا رد فقط
    order('o13', { claimedById: LINA, confirmationStatus: 'IN_PROGRESS' }),          // رسالة فقط · عالق
    order('o14', { claimedById: LINA, confirmationStatus: 'REJECTED' }),             // مقفول
    // ── مها: ما بيدها شي، أكّدت اليوم 1 ──
    order('o15', { confirmationStatus: 'CONFIRMED', confirmedById: MAHA, confirmedAt: at(22, 9, 45) }),
    // ── بلا صاحب ──
    order('o16', { createdAt: at(22, 9, 15) }),                                      // جديد أحدث من ساعتين
    order('o17', { createdAt: at(22, 7) }),                                          // جديد عمره 3 ساعات
    order('o18', { confirmationStatus: 'NO_ANSWER' }),                               // مفتوح وفيه لا رد
    order('o19', { confirmationStatus: 'IN_PROGRESS' }),                             // مفتوح، ردّ
    order('o20', { confirmationStatus: 'CANCELLED' }),                               // مقفول بثلاث لا رد
    // ── متجر تاني بنفس الشركة: ولا رقم منه ──
    order('x1', { storeId: 's2', claimedById: SARA, confirmationStatus: 'IN_PROGRESS' }),
    order('x2', { storeId: 's2', createdAt: at(22, 9, 30) }),
    order('x3', { storeId: 's2', confirmationStatus: 'NO_ANSWER' }),
    order('x4', { storeId: 's2', confirmationStatus: 'CONFIRMED', confirmedById: SARA, confirmedAt: at(22, 9) }),
    // ── شركة تانية: ولا رقم منها ──
    order('y1', { companyId: 'c2', claimedById: SARA, confirmationStatus: 'NO_ANSWER' }),
    order('y2', { companyId: 'c2', createdAt: at(22, 9, 50) }),
  ];
  store.attempts = [
    attempt('o1', 1, 'NO_ANSWER', at(21, 11)),
    attempt('o2', 1, 'NO_ANSWER', at(17, 16)),
    attempt('o2', 2, 'BUSY', at(17, 16, 30)),
    attempt('o3', 1, 'NO_ANSWER', at(20, 10)),
    attempt('o3', 2, 'CALLBACK_REQUESTED', at(20, 11)),
    attempt('o4', 1, 'OPENED', at(17, 10)),
    attempt('o12', 1, 'UNREACHABLE', at(22, 9)),
    attempt('o13', 1, 'MESSAGE_SENT', at(15, 10)),
    attempt('o18', 1, 'NO_ANSWER', at(21, 10)),
    attempt('o19', 1, 'ANSWERED', at(21, 16)),
    attempt('o20', 1, 'NO_ANSWER', at(19, 10)),
    attempt('o20', 2, 'NO_ANSWER', at(20, 10)),
    attempt('o20', 3, 'NO_ANSWER', at(20, 12)),
    attempt('o8', 1, 'NO_ANSWER', at(20, 9)),
    attempt('o8', 2, 'OPENED', at(20, 13)),
    attempt('o8', 3, 'NO_ANSWER', at(21, 9)),
    attempt('o8', 4, 'CONFIRMED', at(22, 9, 30)),
    attempt('o10', 1, 'ANSWERED', at(14, 10)), // قبل المدة — بس بيخلّي اللي بعده الاتصال التاني
    attempt('o10', 2, 'NO_ANSWER', at(16, 10)),
    attempt('x1', 1, 'NO_ANSWER', at(17, 9)),
    attempt('x3', 1, 'NO_ANSWER', at(21, 9)),
    attempt('y1', 1, 'NO_ANSWER', at(17, 9), 'c2'),
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  plan.since = null;
  seed();
});

const board = () => noAnswerBoard({ companyId: 'c1', storeId: 's1', calendar: CAL, now: NOW });
const report = () => answerRateReport({ companyId: 'c1', storeId: 's1', timezone: 'Asia/Amman', start: at(15, 0), end: at(22, 23, 59) });

describe('reached or not — every value the contact door accepts', () => {
  const expected: Record<string, string> = {
    ANSWERED: 'REACHED',
    NO_ANSWER: 'NOT_REACHED',
    BUSY: 'NOT_REACHED',
    WRONG_NUMBER: 'REACHED',
    CALLBACK_REQUESTED: 'REACHED',
    CONFIRMED: 'REACHED',
    REJECTED: 'REACHED',
    MESSAGE_SENT: 'NOT_A_CALL',
    OPENED: 'NOT_A_CALL',
    UNREACHABLE: 'NOT_REACHED',
    OTHER: 'REACHED',
  };

  it('names every one of CONTACT_RESULTS — a value added there must be decided here', () => {
    expect(Object.keys(expected).sort()).toEqual([...CONTACT_RESULTS].sort());
  });

  it.each(Object.entries(expected))('%s → %s', (result, outcome) => {
    expect(outcomeOf(result)).toBe(outcome);
  });

  it('the not-reached side is exactly the three that count toward the close', () => {
    expect(CONTACT_RESULTS.filter((r) => outcomeOf(r) === 'NOT_REACHED').sort()).toEqual([...NO_ANSWER_RESULTS].sort());
  });

  it('a stored value nobody knows is never counted as reached', () => {
    expect(outcomeOf('SOMETHING_OLD')).toBe('NOT_A_CALL');
  });
});

describe('stuck — two WORKING days since the last attempt', () => {
  it('Thursday 16:00 to Sunday 16:00 is three days on the wall and one working day: not stuck', () => {
    expect(isStuck(at(17, 16), stuckCutoff(at(20, 16), CAL))).toBe(false);
  });

  it('Thursday 16:00 to Monday 16:00 is exactly two working days: not yet', () => {
    expect(isStuck(at(17, 16), stuckCutoff(at(21, 16), CAL))).toBe(false);
  });

  it('one minute past two working days: stuck', () => {
    expect(isStuck(at(17, 16), stuckCutoff(at(21, 16, 1), CAL))).toBe(true);
  });

  it('Thursday 16:00 to Tuesday 10:00: stuck', () => {
    expect(isStuck(at(17, 16), stuckCutoff(at(22, 10), CAL))).toBe(true);
  });
});

describe('the board, against the hand count', () => {
  it('per agent: held · only no-answer · promises due · stuck · confirmed today', async () => {
    const b = await board();
    const rows = b.agents.map(({ name, held, onlyNoAnswer, promisesDue, stuck, confirmedToday }) =>
      [name, held, onlyNoAnswer, promisesDue, stuck, confirmedToday]);
    expect(rows).toEqual([
      ['سارة', 7, 2, 1, 2, 2],
      ['لينا', 2, 1, 0, 1, 0],
      ['مها', 0, 0, 0, 0, 1],
    ]);
    expect(b.totals).toEqual({ held: 9, onlyNoAnswer: 3, promisesDue: 1, stuck: 3, confirmedToday: 3 });
  });

  it('the team: one fresh NEW order nobody pulled, one open order nobody holds that carries a no-answer', async () => {
    expect((await board()).team).toEqual({ freshUnclaimed: 1, unclaimedWithNoAnswer: 1 });
  });

  it('NEGATIVE: another store and another company add nothing — not a held order, not a confirmation, not a team figure', async () => {
    const before = await board();
    store.orders = store.orders.filter((o) => o.storeId === 's1' && o.companyId === 'c1');
    store.attempts = store.attempts.filter((a) => store.orders.some((o) => o.id === a.orderId));
    expect(await board()).toEqual(before);
  });

  it('reads agents and counts only — no customer field is ever selected', async () => {
    await board();
    await report();
    for (const keys of store.selects) for (const k of keys) expect(k).not.toMatch(/customer|phone|address|name/i);
  });
});

describe('the answer-rate report, against the hand count', () => {
  const triple = (r: { key: string; reached: number; notReached: number; base: number; notACall: number; rate: number | null }) =>
    [r.key, r.reached, r.notReached, r.base, r.notACall, r.rate];

  it('by local hour — only hours with an attempt, in order', async () => {
    expect((await report()).byHour.map(triple)).toEqual([
      ['9', 1, 3, 4, 0, 25],
      ['10', 0, 5, 5, 2, 0],
      ['11', 1, 1, 2, 0, 50],
      ['12', 0, 1, 1, 0, 0],
      ['13', 0, 0, 0, 1, null],
      ['16', 1, 2, 3, 0, 33],
    ]);
  });

  it('by call number — only rows with an outcome are numbered, after the calls the order had before the range', async () => {
    // UPDATED 2026-11-18 (request C3): the buckets were «1 · 2 · 3 · 4+»; they are «1 · 2 · 3 · 4 · 5 · 6+» (the plan has five attempts). The same rows, the old «4+» split, nothing dropped.
    expect((await report()).byAttempt.map(triple)).toEqual([
      ['1', 1, 7, 8, 0, 13],
      ['2', 1, 4, 5, 0, 20],
      ['3', 1, 1, 2, 0, 50],
      ['4', 0, 0, 0, 0, null],
      ['5', 0, 0, 0, 0, null],
      ['6+', 0, 0, 0, 0, null],
    ]);
  });

  it('the whole range: three reached of fifteen, three outside the rate; the day before it is not read', async () => {
    const r = await report();
    expect(triple(r.total)).toEqual(['الكل', 3, 12, 15, 3, 20]);
    expect(r.truncated).toBe(false);
  });
});

describe('the call number is the number of the CALL, not of the row', () => {
  it('OPENED #1 · NO_ANSWER #2 · OPENED #3 · ANSWERED #4 is «the first call: not answered, the second: answered»', async () => {
    store.orders = [order('p1', { claimedById: SARA, confirmationStatus: 'IN_PROGRESS' })];
    store.attempts = [
      attempt('p1', 1, 'OPENED', at(20, 10)),
      attempt('p1', 2, 'NO_ANSWER', at(20, 10, 1)),
      attempt('p1', 3, 'OPENED', at(21, 11)),
      attempt('p1', 4, 'ANSWERED', at(21, 11, 2)),
    ];
    const r = await report();
    expect(r.byAttempt.map(({ key, reached, base, rate }) => [key, reached, base, rate])).toEqual([
      ['1', 0, 1, 0],
      ['2', 1, 1, 100],
      ['3', 0, 0, null],
      // UPDATED 2026-11-18 (request C3): the buckets were «1 · 2 · 3 · 4+»; they are «1 · 2 · 3 · 4 · 5 · 6+» (the plan has five attempts). The same rows, the old «4+» split, nothing dropped.
      ['4', 0, 0, null],
      ['5', 0, 0, null],
      ['6+', 0, 0, null],
    ]);
    // The two presses are still counted — in the hour table, outside the rate.
    expect(r.total.notACall).toBe(2);
  });

  it('a call before the range is counted in the number, and not in the figures', async () => {
    store.orders = [order('p2', { claimedById: SARA, confirmationStatus: 'IN_PROGRESS' })];
    store.attempts = [
      attempt('p2', 1, 'NO_ANSWER', at(10, 10)), // before the range
      attempt('p2', 2, 'MESSAGE_SENT', at(10, 11)), // before the range, and no call
      attempt('p2', 3, 'BUSY', at(16, 10)),
      attempt('p2', 4, 'NO_ANSWER', at(17, 10)),
      attempt('p2', 5, 'CONFIRMED', at(20, 10)),
    ];
    const r = await report();
    expect(r.byAttempt.map(({ key, reached, notReached }) => [key, reached, notReached])).toEqual([
      ['1', 0, 0],
      ['2', 0, 1],
      ['3', 0, 1],
      // UPDATED 2026-11-18 (request C3): the buckets were «1 · 2 · 3 · 4+»; they are «1 · 2 · 3 · 4 · 5 · 6+» (the plan has five attempts). The same rows, the old «4+» split, nothing dropped.
      ['4', 1, 0],
      ['5', 0, 0],
      ['6+', 0, 0],
    ]);
    expect([r.total.reached, r.total.notReached]).toEqual([1, 2]);
  });
});

describe('«عالق» from one cut-off per request', () => {
  it('agrees with businessMinutesBetween(lastAt, now) > two working days, on hundreds of instants', () => {
    // A fixed walk of pseudo-random instants: weekends, nights, seconds, and exact boundaries all turn up.
    let seed = 7;
    const next = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let i = 0; i < 400; i++) {
      const now = new Date(at(14, 0).getTime() + Math.floor(next() * 21 * 1440) * 60_000 + Math.floor(next() * 60) * 1000);
      const lastAt = new Date(now.getTime() - Math.floor(next() * 7 * 1440) * 60_000 - Math.floor(next() * 60) * 1000);
      const expected = businessMinutesBetween(lastAt, now, CAL) > 2 * 480;
      expect(isStuck(lastAt, stuckCutoff(now, CAL)), `${lastAt.toISOString()} → ${now.toISOString()}`).toBe(expected);
    }
  });
});

describe('the cost does not grow with the rows', () => {
  /** Counts every `new Intl.DateTimeFormat` while `run` works — the thing that cost seconds per request. */
  async function formattersDuring(run: () => Promise<unknown>): Promise<number> {
    const Real = Intl.DateTimeFormat;
    let built = 0;
    const Counting = function (this: unknown, ...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
      built++;
      return new Real(...args);
    } as unknown as typeof Intl.DateTimeFormat;
    Object.assign(Counting, { supportedLocalesOf: Real.supportedLocalesOf });
    Intl.DateTimeFormat = Counting;
    try {
      await run();
    } finally {
      Intl.DateTimeFormat = Real;
    }
    return built;
  }

  /** `n` held orders, each with an attempt somewhere in the last ninety days, and as many report rows. */
  function synthetic(n: number) {
    store.selects = [];
    store.users = [{ id: SARA, name: 'سارة' }];
    store.orders = [];
    store.attempts = [];
    for (let i = 0; i < n; i++) {
      store.orders.push(order(`s${i}`, { claimedById: SARA, confirmationStatus: 'NO_ANSWER' }));
      store.attempts.push(attempt(`s${i}`, 1, i % 3 ? 'NO_ANSWER' : 'OPENED', new Date(NOW.getTime() - (i % 90) * 86_400_000 - (i % 480) * 60_000)));
    }
  }

  it('the board: the same handful of formatters for 300 held orders and for 3,000', async () => {
    synthetic(300);
    const few = await formattersDuring(board);
    synthetic(3000);
    let b: Awaited<ReturnType<typeof board>> | undefined;
    const many = await formattersDuring(async () => (b = await board()));
    expect(many).toBe(few);
    expect(many).toBeLessThanOrEqual(40);
    expect(b!.totals.held).toBe(3000);
    // Every order whose one attempt is at or before the cut-off is stuck (the cut-off itself is checked against
    // businessMinutesBetween above).
    const cutoff = stuckCutoff(NOW, CAL);
    expect(b!.totals.stuck).toBe(store.attempts.filter((a) => a.createdAt <= cutoff).length);
  });

  it('the report: one formatter for 5,000 rows', async () => {
    synthetic(5000);
    const built = await formattersDuring(() =>
      answerRateReport({ companyId: 'c1', storeId: 's1', timezone: 'Asia/Amman', start: at(1, 0), end: at(22, 23, 59) }));
    expect(built).toBe(1);
  });
});

describe('where it lives', () => {
  const screen = stripComments(readFileSync(join(process.cwd(), 'src/components/screens/PerformanceScreen.tsx'), 'utf8'));

  it('a tab of «لوحة الأداء», drawn only for whoever holds the team table’s key — no menu entry of its own', () => {
    expect(screen).toContain("const canScores = userCan(currentUser, 'team.monitor')");
    expect(screen).toContain("...(canScores ? [['noanswer', 'لا رد والطلبات المحجوزة']");
    expect(screen).toContain("tab === 'noanswer' && canScores ? (");
    const registry = readFileSync(join(process.cwd(), 'src/lib/route-registry.ts'), 'utf8');
    expect(registry).not.toMatch(/no-answer|noanswer/);
  });
});

describe('read only', () => {
  it('the fake has no write door, and the source asks for none', () => {
    for (const file of ['src/lib/no-answer-watch.ts', 'src/app/api/orders/confirmation/no-answer/route.ts']) {
      const src = stripComments(readFileSync(join(process.cwd(), file), 'utf8'));
      expect(src, file).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany|\$executeRaw|\$transaction)\(/);
    }
  });
});

/*
 * ═══════════════════════════════════════════════════════════════════════
 * REQUEST C3 (18/11) — THE ATTEMPTS NUMBERED 1–5 AND «أكثر من 5», AND UNDER THE PLAN THE ATTEMPT THE ONE COUNTER COUNTED.
 * ═══════════════════════════════════════════════════════════════════════
 */

/** main's numbering, copied from `osm/main` before C3 (the call order, «4+» folded) — the reference a range before the floor must equal. */
function mainByAttempt(rows: AttemptRow[], priorCalls: Map<string, number>): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>([['1', [0, 0]], ['2', [0, 0]], ['3', [0, 0]], ['4+', [0, 0]]]);
  const so = new Map(priorCalls);
  for (const r of [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.attemptNumber - b.attemptNumber)) {
    const o = outcomeOf(r.result);
    if (o === 'NOT_A_CALL') continue;
    const n = (so.get(r.orderId) ?? 0) + 1;
    so.set(r.orderId, n);
    const cell = out.get(n >= 4 ? '4+' : String(n))!;
    cell[o === 'REACHED' ? 0 : 1]++;
  }
  return out;
}

const COUNTRY = { timezone: 'Asia/Amman', weekendDays: [5, 6], workHoursStart: '09:00', workHoursEnd: '17:00' };
const row = (orderId: string, n: number, result: string, createdAt: Date): AttemptRow => ({ orderId, attemptNumber: n, result, createdAt, nextFollowUpAt: null });
const pairs = (r: ReturnType<typeof tallyAnswerRate>) => r.byAttempt.map((x) => [x.key, x.reached, x.notReached]);

describe('C3 — the buckets are 1 · 2 · 3 · 4 · 5 · 6+', () => {
  it('the fifth call is its own row, the sixth is «أكثر من 5», and the rows still sum to the total', () => {
    const rows = [1, 2, 3, 4, 5, 6, 7].map((n) => row('o', n, n === 5 ? 'ANSWERED' : 'NO_ANSWER', at(15, 9, n)));
    const r = tallyAnswerRate(rows, new Map(), 'Asia/Amman');
    expect(ATTEMPT_BUCKETS).toEqual(['1', '2', '3', '4', '5', '6+']);
    expect(pairs(r)).toEqual([['1', 0, 1], ['2', 0, 1], ['3', 0, 1], ['4', 0, 1], ['5', 1, 0], ['6+', 0, 2]]);
    const sum = r.byAttempt.reduce((s, x) => s + x.base, 0);
    expect(sum).toBe(r.total.base);
  });

  it('NO PLAN — a differential against main: the first three rows equal, and 4 + 5 + 6+ is main’s «4+», on a few hundred random sequences', () => {
    let seed = 11;
    const next = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    const results = ['NO_ANSWER', 'BUSY', 'ANSWERED', 'OPENED', 'MESSAGE_SENT', 'CONFIRMED', 'UNREACHABLE'];
    for (let k = 0; k < 300; k++) {
      const rows: AttemptRow[] = [];
      const prior = new Map<string, number>();
      for (let o = 0; o < 4; o++) {
        if (next() < 0.3) prior.set(`o${o}`, Math.floor(next() * 4));
        const n = Math.floor(next() * 9);
        for (let i = 0; i < n; i++) rows.push(row(`o${o}`, i + 1, results[Math.floor(next() * results.length)], at(15 + Math.floor(next() * 6), 9 + Math.floor(next() * 8), i)));
      }
      const now = tallyAnswerRate(rows, prior, 'Asia/Amman');
      const main = mainByAttempt(rows, prior);
      const get = (key: string) => now.byAttempt.find((x) => x.key === key)!;
      for (const key of ['1', '2', '3']) expect([get(key).reached, get(key).notReached]).toEqual(main.get(key));
      expect([4, 5].map(String).concat('6+').reduce((s, key) => [s[0] + get(key).reached, s[1] + get(key).notReached], [0, 0])).toEqual(main.get('4+'));
    }
  });

  it('A FLOOR AFTER THE RANGE numbers exactly as with no plan (the range is entirely before it)', () => {
    const rows = [row('o', 1, 'NO_ANSWER', at(15, 9)), row('o', 2, 'NO_ANSWER', at(15, 9, 5)), row('o', 3, 'ANSWERED', at(15, 9, 6))];
    const cal = cadenceCalOf(at(23, 0), COUNTRY);
    expect(tallyAnswerRate(rows, new Map(), 'Asia/Amman', { cal, priorLines: new Map() })).toEqual(tallyAnswerRate(rows, new Map(), 'Asia/Amman'));
  });
});

describe('C3 — under the plan, the attempt the one counter counted', () => {
  it('an early press does not advance the number; the next real call is numbered right; a reached call is the attempt it was', () => {
    // Floor Monday the 14th at noon. #1 on the 14th 13:00 (before the range), #2 on Tuesday 10:00, an EARLY press at 11:00 (#3 is due at 12:00),
    // #3 at 12:05, and an answer on Wednesday 09:00 — the fourth attempt.
    const prior = [row('q', 1, 'NO_ANSWER', at(14, 13))];
    const rows = [row('q', 2, 'NO_ANSWER', at(15, 10)), row('q', 3, 'NO_ANSWER', at(15, 11)), row('q', 4, 'NO_ANSWER', at(15, 12, 5)), row('q', 5, 'ANSWERED', at(16, 9))];
    const cal = cadenceCalOf(at(14, 12), COUNTRY);
    const r = tallyAnswerRate(rows, new Map([['q', 1]]), 'Asia/Amman', { cal, priorLines: new Map([['q', prior]]) });
    expect(pairs(r)).toEqual([['1', 0, 0], ['2', 0, 1], ['3', 0, 2], ['4', 1, 0], ['5', 0, 0], ['6+', 0, 0]]);
    // NEGATIVE: by the call order the answer would have been the fifth.
    expect(pairs(tallyAnswerRate(rows, new Map([['q', 1]]), 'Asia/Amman'))).toEqual([['1', 0, 0], ['2', 0, 1], ['3', 0, 1], ['4', 0, 1], ['5', 1, 0], ['6+', 0, 0]]);
  });

  it('NEGATIVE: an early press followed by an answer — the answer is the attempt the early press tried to be, not one more', () => {
    // #1 Tuesday 10:00 (#2 due 10:30), an EARLY press at 10:10, then the customer answers at 10:15: that answer is attempt 2.
    const rows = [row('e', 1, 'NO_ANSWER', at(15, 10)), row('e', 2, 'NO_ANSWER', at(15, 10, 10)), row('e', 3, 'ANSWERED', at(15, 10, 15))];
    const cal = cadenceCalOf(at(14, 12), COUNTRY);
    expect(pairs(tallyAnswerRate(rows, new Map(), 'Asia/Amman', { cal, priorLines: new Map() })).slice(0, 3)).toEqual([['1', 0, 1], ['2', 1, 1], ['3', 0, 0]]);
  });

  it('NEGATIVE: the prior plan lines are needed — without them the order starts at one', () => {
    const rows = [row('q', 2, 'NO_ANSWER', at(15, 10))];
    const cal = cadenceCalOf(at(14, 12), COUNTRY);
    expect(pairs(tallyAnswerRate(rows, new Map(), 'Asia/Amman', { cal, priorLines: new Map([['q', [row('q', 1, 'NO_ANSWER', at(14, 13))]]]) }))[1]).toEqual(['2', 0, 1]);
    expect(pairs(tallyAnswerRate(rows, new Map(), 'Asia/Amman', { cal, priorLines: new Map() }))[0]).toEqual(['1', 0, 1]);
  });

  it('a range that straddles the floor: the call order before it, the plan from one after it', () => {
    const rows = [row('s', 1, 'NO_ANSWER', at(15, 10)), row('s', 2, 'NO_ANSWER', at(16, 10)), row('s', 3, 'ANSWERED', at(16, 11))];
    const cal = cadenceCalOf(at(16, 0), COUNTRY);
    expect(pairs(tallyAnswerRate(rows, new Map(), 'Asia/Amman', { cal, priorLines: new Map() })).slice(0, 3)).toEqual([['1', 0, 2], ['2', 1, 0], ['3', 0, 0]]);
  });

  it('the numbering is said: CALLS with no floor or a floor after the range, PLAN before it, SPLIT inside it — by the local day', () => {
    const [s, e] = [at(15, 0), at(22, 23, 59)];
    expect(numberingOf(null, s, e, 'Asia/Amman')).toEqual({ mode: 'CALLS', fromDay: null });
    expect(numberingOf(at(23, 1), s, e, 'Asia/Amman')).toEqual({ mode: 'CALLS', fromDay: null });
    expect(numberingOf(at(10, 1), s, e, 'Asia/Amman')).toEqual({ mode: 'PLAN', fromDay: '2026-09-10' });
    // 00:30 in Amman is still the day before in UTC: the day said is Amman's.
    expect(numberingOf(at(17, 0, 30), s, e, 'Asia/Amman')).toEqual({ mode: 'SPLIT', fromDay: '2026-09-17' });
  });
});

describe('C3 — the report reads the plan when it is on, and only then', () => {
  it('plan on before the range: the prior plan lines are read and the attempts numbered by the plan', async () => {
    plan.since = at(14, 12);
    store.orders = [order('q', { claimedById: SARA, confirmationStatus: 'NO_ANSWER' })];
    store.attempts = [
      attempt('q', 1, 'NO_ANSWER', at(14, 13)),
      attempt('q', 2, 'NO_ANSWER', at(15, 10)),
      attempt('q', 3, 'NO_ANSWER', at(15, 11)),
      attempt('q', 4, 'NO_ANSWER', at(15, 12, 5)),
      attempt('q', 5, 'ANSWERED', at(16, 9)),
    ];
    const r = await report();
    expect(r.numbering).toEqual({ mode: 'PLAN', fromDay: '2026-09-14' });
    expect(r.byAttempt.map(({ key, reached, notReached }) => [key, reached, notReached]).slice(0, 5)).toEqual([['1', 0, 0], ['2', 0, 1], ['3', 0, 2], ['4', 1, 0], ['5', 0, 0]]);
  });

  it('a prior-plan read that hits its bound says so: the report is «truncated» (review of #361)', async () => {
    plan.since = at(14, 12);
    store.orders = [order('q', { claimedById: SARA, confirmationStatus: 'NO_ANSWER' })];
    store.attempts = [attempt('q', 1, 'NO_ANSWER', at(14, 13)), attempt('q', 2, 'NO_ANSWER', at(15, 10))];
    const real = db.orderContactAttempt.findMany.getMockImplementation()!;
    db.orderContactAttempt.findMany.mockImplementation(async (args: Row) =>
      args.where.createdAt?.gt ? Array.from({ length: REPORT_ROW_CAP }, (_, i) => ({ orderId: 'q', result: 'NO_ANSWER', createdAt: at(14, 13), attemptNumber: i, nextFollowUpAt: null })) : real(args));
    try {
      expect((await report()).truncated).toBe(true);
    } finally {
      db.orderContactAttempt.findMany.mockImplementation(real);
    }
    // NEGATIVE: the same order under the bound is not.
    expect((await report()).truncated).toBe(false);
  });

  it('NEGATIVE: plan off — the numbering says CALLS, and the reads are main’s two (no due selected, no third read)', async () => {
    const r = await report();
    expect(r.numbering).toEqual({ mode: 'CALLS', fromDay: null });
    expect(db.orderContactAttempt.findMany).toHaveBeenCalledTimes(1);
    for (const keys of store.selects) expect(keys).not.toContain('nextFollowUpAt');
  });
});
