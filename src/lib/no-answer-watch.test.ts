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
    else throw new Error(`الفيك ما بيعرف ${op}`);
  }
  return true;
}
const ORDER_KEYS = ['companyId', 'storeId', 'claimedById', 'confirmationStatus', 'confirmedById', 'confirmedAt', 'createdAt'];
function orderMatches(o: Row, where: Row): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'contactAttempts') {
      const mine = store.attempts.filter((a) => a.orderId === o.id);
      if (!mine.some((a) => cond((v as Row).some.result, a.result))) return false;
    } else if (ORDER_KEYS.includes(k)) {
      if (!cond(v, o[k])) return false;
    } else throw new Error(`الفيك ما بيعرف المفتاح ${k}`);
  }
  return true;
}
function attemptMatches(a: Row, where: Row): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'order') {
      const o = store.orders.find((x) => x.id === a.orderId);
      if (!o || !orderMatches(o, v as Row)) return false;
    } else if (k === 'companyId' || k === 'createdAt') {
      if (!cond(v, a[k])) return false;
    } else throw new Error(`الفيك ما بيعرف المفتاح ${k}`);
  }
  return true;
}
const pick = (row: Row, select: Row) => {
  store.selects.push(Object.keys(select));
  return Object.fromEntries(Object.keys(select).map((k) => [k, row[k] ?? null]));
};

const { db } = vi.hoisted(() => ({ db: {} as Row }));
vi.mock('./db', () => ({ db }));
Object.assign(db, {
  order: {
    findMany: vi.fn(async ({ where, select, take }: Row) =>
      store.orders.filter((o) => orderMatches(o, where)).slice(0, take).map((o) => pick(o, select))),
    count: vi.fn(async ({ where }: Row) => store.orders.filter((o) => orderMatches(o, where)).length),
    groupBy: vi.fn(async ({ by, where }: Row) => {
      expect(by).toEqual(['confirmedById']);
      const counts = new Map<string, number>();
      for (const o of store.orders.filter((x) => orderMatches(x, where))) counts.set(o.confirmedById, (counts.get(o.confirmedById) ?? 0) + 1);
      return [...counts].map(([confirmedById, n]) => ({ confirmedById, _count: { _all: n } }));
    }),
  },
  orderContactAttempt: {
    groupBy: vi.fn(async ({ by, where }: Row) => {
      expect(by).toEqual(['orderId', 'result']);
      const groups = new Map<string, Row>();
      for (const a of store.attempts.filter((x) => attemptMatches(x, where))) {
        const key = `${a.orderId}|${a.result}`;
        const g = groups.get(key) ?? { orderId: a.orderId, result: a.result, _max: { createdAt: null } };
        if (!g._max.createdAt || a.createdAt > g._max.createdAt) g._max.createdAt = a.createdAt;
        groups.set(key, g);
      }
      return [...groups.values()];
    }),
    findMany: vi.fn(async ({ where, select, take }: Row) =>
      store.attempts.filter((a) => attemptMatches(a, where)).slice(0, take).map((a) => pick(a, select))),
  },
  user: {
    findMany: vi.fn(async ({ where }: Row) => store.users.filter((u) => where.id.in.includes(u.id))),
  },
});

import {
  CONTACT_RESULTS,
  NO_ANSWER_RESULTS,
} from './confirmation-workflow';
import { answerRateReport, isStuck, noAnswerBoard, outcomeOf } from './no-answer-watch';

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
    attempt('o10', 1, 'ANSWERED', at(14, 10)), // قبل المدة
    attempt('x1', 1, 'NO_ANSWER', at(17, 9)),
    attempt('x3', 1, 'NO_ANSWER', at(21, 9)),
    attempt('y1', 1, 'NO_ANSWER', at(17, 9), 'c2'),
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
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
    expect(isStuck(at(17, 16), at(20, 16), CAL)).toBe(false);
  });

  it('Thursday 16:00 to Monday 16:00 is exactly two working days: not yet', () => {
    expect(isStuck(at(17, 16), at(21, 16), CAL)).toBe(false);
  });

  it('one minute past two working days: stuck', () => {
    expect(isStuck(at(17, 16), at(21, 16, 1), CAL)).toBe(true);
  });

  it('Thursday 16:00 to Tuesday 10:00: stuck', () => {
    expect(isStuck(at(17, 16), at(22, 10), CAL)).toBe(true);
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
      ['10', 0, 4, 4, 2, 0],
      ['11', 1, 1, 2, 0, 50],
      ['12', 0, 1, 1, 0, 0],
      ['13', 0, 0, 0, 1, null],
      ['16', 1, 2, 3, 0, 33],
    ]);
  });

  it('by attempt number — 1, 2, 3, 4+', async () => {
    expect((await report()).byAttempt.map(triple)).toEqual([
      ['1', 1, 7, 8, 2, 13],
      ['2', 1, 2, 3, 1, 33],
      ['3', 0, 2, 2, 0, 0],
      ['4+', 1, 0, 1, 0, 100],
    ]);
  });

  it('the whole range: three reached of fourteen, three outside the rate; the day before it is not read', async () => {
    const r = await report();
    expect(triple(r.total)).toEqual(['الكل', 3, 11, 14, 3, 21]);
    expect(r.truncated).toBe(false);
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
