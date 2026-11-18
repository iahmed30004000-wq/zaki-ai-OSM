import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from './guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «القياس كل أسبوع» — THE QUESTIONS: SCOPED, IN THE REPORT LANE, ASKED ONCE, BOUNDED.
 *
 * The database is a small fake that READS the `where` it is given (and refuses a key it does not know), so a question that loses its
 * company or store counts the other store's rows here exactly as it would in Postgres. Every call records whether it ran in the report
 * lane, and every `select` is kept so no customer field can slip in.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Row = Record<string, any>;
const T: { orders: Row[]; attempts: Row[]; claims: Row[]; logs: Row[]; activities: Row[]; selects: string[][]; lane: boolean[] } = {
  orders: [],
  attempts: [],
  claims: [],
  logs: [],
  activities: [],
  selects: [],
  lane: [],
};

function cond(value: any, cell: any): boolean {
  if (value === null) return cell === null || cell === undefined;
  if (typeof value !== 'object' || value instanceof Date) return value instanceof Date ? cell instanceof Date && cell.getTime() === value.getTime() : cell === value;
  for (const [op, arg] of Object.entries(value)) {
    if (op === 'not') { if (arg === null ? cell == null : cell === arg) return false; }
    else if (op === 'in') { if (!(arg as unknown[]).includes(cell)) return false; }
    else if (op === 'gte') { if (!(cell instanceof Date) || cell < (arg as Date)) return false; }
    else if (op === 'gt') { if (!(cell instanceof Date) || cell <= (arg as Date)) return false; }
    else if (op === 'lte') { if (!(cell instanceof Date) || cell > (arg as Date)) return false; }
    else if (op === 'lt') { if (!(cell instanceof Date) || cell >= (arg as Date)) return false; }
    else throw new Error(`الفيك ما بيعرف ${op}`);
  }
  return true;
}
const ORDER_KEYS = ['id', 'companyId', 'storeId', 'createdAt', 'confirmedAt', 'rejectionReason', 'claimedById'];
function orderMatches(o: Row, where: Row): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'contactAttempts') {
      if (!T.attempts.some((a) => a.orderId === o.id && lineMatches(a, (v as Row).some, ['createdAt']))) return false;
    } else if (ORDER_KEYS.includes(k)) {
      if (!cond(v, o[k])) return false;
    } else throw new Error(`الفيك ما بيعرف مفتاح الطلب ${k}`);
  }
  return true;
}
function lineMatches(row: Row, where: Row, keys: string[]): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'order') {
      const o = T.orders.find((x) => x.id === row.orderId);
      if (!o || !orderMatches(o, v as Row)) return false;
    } else if (keys.includes(k)) {
      if (!cond(v, row[k])) return false;
    } else throw new Error(`الفيك ما بيعرف المفتاح ${k}`);
  }
  return true;
}
const pick = (row: Row, select: Row) => {
  T.selects.push(Object.keys(select));
  return Object.fromEntries(Object.keys(select).map((k) => [k, row[k] ?? null]));
};
const sorted = (rows: Row[], orderBy: Row | Row[] | undefined) => {
  if (!orderBy) return rows;
  const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).map((o) => Object.keys(o)[0]);
  return [...rows].sort((a, b) => {
    for (const k of keys) {
      const x = a[k] instanceof Date ? a[k].getTime() : a[k];
      const y = b[k] instanceof Date ? b[k].getTime() : b[k];
      if (x < y) return -1;
      if (x > y) return 1;
    }
    return 0;
  });
};

const { db, laneOf } = vi.hoisted(() => ({ db: {} as Row, laneOf: { now: (): boolean => false } }));
vi.mock('./db', () => ({ db }));
// The report's own bound (review of #361): the real report, with its `truncated` forced when a test says so.
const { reportCut } = vi.hoisted(() => ({ reportCut: { on: false } }));
vi.mock('./no-answer-watch', async (importOriginal) => {
  const real = await importOriginal<typeof import('./no-answer-watch')>();
  return { ...real, answerRateReport: async (...a: Parameters<typeof real.answerRateReport>) => ({ ...(await real.answerRateReport(...a)), ...(reportCut.on ? { truncated: true } : {}) }) };
});

const ATTEMPT_KEYS = ['companyId', 'orderId', 'createdAt', 'result'];
function table(rows: () => Row[], keys: string[]) {
  return {
    findMany: vi.fn(async ({ where, select, take, orderBy }: Row) => {
      T.lane.push(laneOf.now());
      return sorted(rows().filter((r) => lineMatches(r, where, keys)), orderBy).slice(0, take).map((r) => pick(r, select));
    }),
    groupBy: vi.fn(async ({ by, where, _min, _count, take }: Row) => {
      T.lane.push(laneOf.now());
      expect(by).toEqual(['orderId']);
      const groups = new Map<string, Row>();
      for (const r of rows().filter((x) => lineMatches(x, where, keys))) {
        const g = groups.get(r.orderId) ?? { orderId: r.orderId, _min: { createdAt: null as Date | null }, _count: { _all: 0 } };
        if (!g._min.createdAt || r.createdAt < g._min.createdAt) g._min.createdAt = r.createdAt;
        g._count._all++;
        groups.set(r.orderId, g);
      }
      return [...groups.values()]
        .sort((a, b) => (a.orderId < b.orderId ? -1 : 1))
        .slice(0, take)
        .map((g) => ({ orderId: g.orderId, ...(_min ? { _min: g._min } : {}), ...(_count ? { _count: g._count } : {}) }));
    }),
  };
}
Object.assign(db, {
  order: {
    findMany: vi.fn(async ({ where, select, take, orderBy }: Row) => {
      T.lane.push(laneOf.now());
      return sorted(T.orders.filter((o) => orderMatches(o, where)), orderBy).slice(0, take).map((o) => pick(o, select));
    }),
  },
  orderContactAttempt: table(() => T.attempts, ATTEMPT_KEYS),
  orderClaimHistory: table(() => T.claims, ['companyId', 'createdAt']),
  orderStatusLog: table(() => T.logs, ['companyId', 'statusType', 'previousValue', 'newValue', 'createdAt']),
  orderActivity: table(() => T.activities, ['companyId', 'action']),
});

import { inHeavyLane, laneAnswers } from './heavy-lane';
import { weeklyKey, weeklyMeasures } from './weekly-measures-read';

laneOf.now = inHeavyLane;

const CAL = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' };
const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 10, day, hour - 3, minute));
const NOW = at(18, 10);

const order = (id: string, o: Row = {}): Row => ({
  id, companyId: 'c1', storeId: 's1', createdAt: at(15, 9), confirmedAt: null, rejectionReason: null,
  shippingStatus: 'NOT_READY', confirmationStatus: 'NEW', claimedById: null,
  customerName: 'لا يُقرأ', customerPhone: '0790000000', ...o,
});
const attempt = (orderId: string, result: string, createdAt: Date, employeeId = 'u1', n = 1) =>
  ({ orderId, result, createdAt, employeeId, attemptNumber: n, companyId: 'c1', nextFollowUpAt: null });
const claim = (orderId: string, action: string, reason: string | null, createdAt: Date, userId = 'u1') => ({ orderId, action, reason, createdAt, userId, companyId: 'c1' });
const log = (orderId: string, newValue: string, createdAt: Date) =>
  ({ orderId, statusType: 'CONFIRMATION', previousValue: 'NO_ANSWER', newValue, createdAt, companyId: 'c1' });

/** One store's week, by hand. */
function seed() {
  T.selects = [];
  T.lane = [];
  T.orders = [
    order('o1', { createdAt: at(15, 9), confirmedAt: at(15, 12), confirmationStatus: 'CONFIRMED', shippingStatus: 'DELIVERED' }),
    order('o2', { createdAt: at(15, 9) }),
    order('o3', { createdAt: at(16, 9) }), // marked duplicate at intake
    order('o4', { createdAt: at(1, 9) }), // created before the window
  ];
  T.activities = [{ orderId: 'o3', action: 'INTAKE_DUPLICATE', companyId: 'c1' }];
  T.attempts = [
    attempt('o1', 'ANSWERED', at(15, 9, 10)),
    attempt('o2', 'NO_ANSWER', at(15, 9, 20)),
    attempt('o2', 'OPENED', at(15, 9, 19)),
    attempt('o4', 'NO_ANSWER', at(2, 10)), // before the window
    attempt('o4', 'NO_ANSWER', at(15, 10)),
  ];
  T.claims = [claim('o2', 'CLAIMED', 'PULL_NEXT', at(15, 9, 15)), claim('o2', 'RELEASED', 'NO_ANSWER_RETURNED', at(15, 9, 30))];
  T.logs = [log('o4', 'REJECTED', at(16, 10))];
}

/** The same week, copied into another store of the company and into another company: none of it may count. */
function addNeighbours() {
  const copy = <R extends Row>(rows: R[], over: Row, idOf = (id: string) => `${over.storeId ?? over.companyId}-${id}`) =>
    rows.map((r) => ({ ...r, ...('id' in r ? { id: idOf(r.id) } : { orderId: idOf(r.orderId) }), ...over }));
  for (const [over, ids] of [[{ storeId: 's2' }, 's2'], [{ companyId: 'c2' }, 'c2']] as const) {
    const idOf = (id: string) => `${ids}-${id}`;
    T.orders = T.orders.concat(copy(T.orders.filter((o) => o.companyId === 'c1' && o.storeId === 's1'), over, idOf));
    const lineOver = 'companyId' in over ? { companyId: 'c2' } : {};
    T.attempts = T.attempts.concat(copy(T.attempts.filter((a) => !a.orderId.includes('-')), lineOver, idOf));
    T.claims = T.claims.concat(copy(T.claims.filter((a) => !a.orderId.includes('-')), lineOver, idOf));
    T.logs = T.logs.concat(copy(T.logs.filter((a) => !a.orderId.includes('-')), lineOver, idOf));
    T.activities = T.activities.concat(copy(T.activities.filter((a) => !a.orderId.includes('-')), lineOver, idOf));
  }
}

const read = (o: Partial<Parameters<typeof weeklyMeasures>[0]> = {}) =>
  weeklyMeasures({ companyId: 'c1', storeId: 's1', calendar: CAL, week: 'this', now: NOW, ...o });

beforeEach(() => {
  vi.clearAllMocks();
  laneAnswers.clear();
  seed();
});

describe('the figures of one store’s week, by hand', () => {
  it('six figures', async () => {
    const { weekly, window } = await read();
    expect([window.fromDay, window.toDay, window.timezone]).toEqual(['2026-11-11', '2026-11-17', 'Asia/Amman']);
    const f = weekly.figures;
    expect(f.firstCall).toEqual({ medianMinutes: 15, base: 2, noCallYet: 1 }); // o1 10 min, o2 20 min (OPENED is not a call), o3 none
    expect(f.uniqueConfirmed).toEqual({ confirmed: 1, base: 2, duplicates: 1, rate: 50 });
    expect(f.retried).toEqual({ retried: 0, base: 2, rate: 0 }); // o2 and o4 missed on Sunday, neither called again in the week
    expect(f.backlog).toEqual({ entered: 1, finished: 1, net: 0 }); // o2 entered (o4 had missed before); o4 decided after its misses
    expect(f.silentPulls).toEqual({ silent: 0, base: 1, rate: 0 }); // her own attempt came before the return
    expect(f.delivered).toEqual({ delivered: 1, base: 1, onTheRoad: 0, rate: 100 });
    expect(f.truncated).toBe(false);
    expect(weekly.tiles).toHaveLength(6);
    expect(weekly.checks).toHaveLength(2);
  });

  it('NEGATIVE: another store and another company add nothing — the same week copied beside it changes no figure', async () => {
    const alone = await read();
    addNeighbours();
    expect(T.orders.length).toBeGreaterThan(8);
    laneAnswers.clear();
    expect(await read()).toEqual(alone);
  });

  it('reads agents and counts only — no customer field is ever selected', async () => {
    await read();
    expect(T.selects.length).toBeGreaterThan(5);
    for (const keys of T.selects) for (const k of keys) expect(k).not.toMatch(/customer|phone|address|name/i);
  });
});

describe('the report lane', () => {
  it('every question runs in the lane', async () => {
    await read();
    expect(T.lane.length).toBeGreaterThan(5);
    expect(T.lane.every(Boolean)).toBe(true);
    expect(inHeavyLane()).toBe(false);
  });

  it('a second call within the time it is kept does not ask again', async () => {
    await read({ ttlMs: 60_000 });
    const asked = T.lane.length;
    const again = await read({ ttlMs: 60_000 });
    expect(T.lane.length).toBe(asked);
    expect(again.weekly.figures.firstCall.base).toBe(2);
  });

  it('NEGATIVE: kept zero (the test default), it asks again', async () => {
    await read();
    const asked = T.lane.length;
    await read();
    expect(T.lane.length).toBe(2 * asked);
  });

  it('the key names company, store and window — and two stores never share one', () => {
    const w = { fromDay: '2026-11-11', toDay: '2026-11-17' };
    expect(weeklyKey('c1', 's1', w)).toBe('weekly-measures|c1|s1|2026-11-11|2026-11-17');
    expect(weeklyKey('c1', 's1', w)).not.toBe(weeklyKey('c1', 's2', w));
    expect(weeklyKey('c1', 's1', w)).not.toBe(weeklyKey('c2', 's1', w));
    expect(weeklyKey('c1', 's1', w)).not.toBe(weeklyKey('c1', 's1', { fromDay: '2026-11-04', toDay: '2026-11-10' }));
  });

  it('NEGATIVE: kept for a minute, the other store still gets its own figures', async () => {
    await read({ ttlMs: 60_000 });
    const other = await read({ ttlMs: 60_000, storeId: 's2' });
    expect(other.weekly.figures.firstCall.base).toBe(0);
  });
});

describe('a reader that hits its bound says so', () => {
  it('the figures are «حد أدنى»', async () => {
    const r = await read({ caps: { rows: 2 } });
    expect(r.weekly.truncated).toBe(true);
    expect(r.weekly.figures.truncated).toBe(true);
  });

  it('the report’s own bound (the fifth attempt’s base) makes the card say «حد أدنى» too', async () => {
    reportCut.on = true;
    try {
      const r = await read();
      expect(r.weekly.truncated).toBe(true);
    } finally {
      reportCut.on = false;
    }
  });

  it('NEGATIVE: under the bound, nothing is said', async () => {
    expect((await read()).weekly.truncated).toBe(false);
  });
});

describe('read only', () => {
  it('the source asks for no write', () => {
    const src = stripComments(readFileSync('src/lib/weekly-measures-read.ts', 'utf8'));
    expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany|\$executeRaw|\$transaction)\(/);
  });
});
