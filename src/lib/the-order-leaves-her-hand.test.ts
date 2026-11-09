import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — «الطلب يرجع للطابور فوراً (تجريبي)» AT THE PULL (the owner, 9/11)
 *
 * With the mode ON (and «نظام الجولات» on beside it):
 *
 *  1. Five «لا يرد» in a row leave her hand EMPTY and she pulls again; the five are not pullable until THREE WORKING HOURS after
 *     their last «لا يرد», and then they come AFTER every new order and after the promises whose date arrived.
 *  2. The pool is given in the owner’s order — held for her · NEW · a promise whose date arrived (nearest first) · a returned order
 *     that is ready (oldest first) — and a date or a «لا يرد» that has not run out holds an order in a bucket nobody pulls from.
 *  3. A dated order is pullable AT its date (no two-day lead), whichever column carries the date.
 *  4. Her hand is five, in her hands plus held for her: the sixth is refused with the owner’s sentence; at the limit what is held
 *     for her is still hers to take; her twins are held only inside the room that is left.
 *  5. «الشغل أول» is quiet; the untouched-order rule and the pace are not, and are asked in the order they always were.
 *  6. The number the queue shows (`waitingCount`) is exactly what the pull can hand out.
 *
 * With the mode OFF — the switch off, the rounds off, or the calendar unreadable — NOTHING changes: the same worlds are run again
 * and answer as they always did (a 10-minute-old «لا يرد» is pullable, a postponed order two days ahead is pullable, the cap is 500).
 *
 * Driven against an in-memory database that APPLIES the filters it is given (with SQL’s three values), as `work-first-pull.test.ts`
 * does: the answer comes from the filter’s own text, not from a mock that was told it.
 *
 * Blockers: no money, no order creation, no migration.
 * ═══════════════════════════════════════════════════════════════════════
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const { world, sw, rsw } = vi.hoisted(() => ({
  world: { orders: [] as Row[], history: [] as Row[], logs: [] as Row[], activities: [] as Row[], notices: [] as Row[][], audience: [] as { id: string }[], clock: new Date('2026-11-02T10:00:00.000Z') },
  sw: { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } },
  rsw: { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } },
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
    // A line the pull or a release writes lands in the table AND on the order it is about, so `claimHistory: { none: {} }` (the
    // hold’s «never claimed») reads the truth after a pull, as the database would.
    orderClaimHistory: {
      create: vi.fn(async ({ data }: Row) => {
        const line = { createdAt: world.clock, ...data };
        world.history.push(line);
        world.orders.find((r) => r.id === data.orderId)?.claimHistory.push(line);
      }),
      findMany: vi.fn(async ({ where, select }: Row) =>
        world.history
          .filter((h) => matches(h, where ?? {}))
          .map((h) => (select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, h[k] ?? null])) : { ...h }))
      ),
    },
    notification: { createMany: vi.fn(async ({ data }: Row) => void world.notices.push(data)) },
    orderStatusLog: { create: vi.fn(async ({ data }: Row) => void world.logs.push(data)) },
    orderActivity: { create: vi.fn(async ({ data }: Row) => void world.activities.push(data)) },
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return { db, default: db };
});
// The two switches the pull reads before its transaction — the test says what they are.
vi.mock('./no-answer-rounds-switch', () => ({ roundsSwitch: async () => sw.value }));
vi.mock('./no-answer-returns-switch', () => ({ returnsSwitch: async () => rsw.value }));
vi.mock('./notification-audience', () => ({ resolveAudience: vi.fn(async () => world.audience) }));

import {
  CLAIM_CAPS,
  OPEN_CONFIRMATION,
  PULL_PACE,
  RETURNS_MODE,
  pickNextCandidate,
  postponedNotDueCount,
  pullNextOrder,
  readReturnsMode,
  returnToThePool,
  waitingCount,
} from './confirmation-queue';
import { reserveReturningCustomers } from './reserve-returning-customers';
import { NO_ANSWER_RETURNED_REASON, handLimitMessage } from './no-answer-returns';
import { zonedTimeToInstant } from './business-calendar';
import { db } from './db';

/** Jordan: Sunday to Thursday, 09:00 to 17:00. 1 November 2026 is a Sunday. */
const JO = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' };
const t = (day: number, h: number, m = 0) => zonedTimeToInstant(JO.timezone, 2026, 11, day, h, m);
/** Monday 2 November, noon: the cut of «ready» is Monday 09:00 (three working hours back). */
const NOW = t(2, 12);
const scope = { companyId: 'c1', storeId: 's1' };
const agent = (id: string) => ({ id, role: 'CONFIRMATION_AGENT' });
const ON = { enabled: true, enabledAt: t(1, 8) };
const OFF = { enabled: false, enabledAt: null };
const minutesAgo = (m: number, from = NOW) => new Date(from.getTime() - m * 60_000);

let seq = 0;
/** An order in the pool: nobody holds it, nobody has rung it. */
const order = (over: Row = {}): Row => {
  seq += 1;
  const r: Row = {
    id: `o${String(seq).padStart(4, '0')}`, orderNumber: `ORD-${seq}`, ...scope, customerId: `cust${seq}`,
    confirmationStatus: 'NEW', status: 'NEW', shippingStatus: 'NOT_READY', shippingBatchId: null, trackingNumber: null, labelPrintedAt: null,
    claimedById: null, claimedAt: null, currentOwnerId: null, signatureStatus: 'UNSIGNED',
    assignedToId: null, assignedAt: null, assignee: null, replacesOrderId: null,
    postponedUntil: null, nextFollowUpAt: null,
    createdAt: new Date(t(1, 9).getTime() + seq * 1000), version: 1, contactAttempts: [], claimHistory: [],
    ...over,
  };
  world.orders.push(r);
  return r;
};
const att = (createdAt: Date, result: string, employeeId = 'sara', n = 1): Row => ({ createdAt, result, employeeId, attemptNumber: n });
/** An order that was rung, pressed «لا يرد» at `pressedAt`, and went back to the pool (what the mode leaves behind). */
const returned = (pressedAt: Date, over: Row = {}): Row =>
  order({
    confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS',
    contactAttempts: [att(minutesAgo(1, pressedAt), 'OPENED'), att(pressedAt, 'NO_ANSWER', 'sara', 2)],
    claimHistory: [{ action: 'CLAIMED' }, { action: 'RELEASED' }],
    createdAt: new Date(t(1, 9).getTime() - 3_600_000 * 24 + seq * 1000),
    ...over,
  });
/** An order Sara holds, with a call logged on it `rungMinutesAgo` ago (so it is neither untouched nor idle). */
const mine = (rungMinutesAgo: number | null = 5, over: Row = {}): Row =>
  order({
    confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS', claimedById: 'sara', currentOwnerId: 'sara', claimedAt: minutesAgo(20),
    claimHistory: [{ action: 'CLAIMED' }],
    contactAttempts: rungMinutesAgo === null ? [] : [att(minutesAgo(rungMinutesAgo), 'OPENED')],
    ...over,
  });
const byId = (id: string) => world.orders.find((r) => r.id === id)!;
const heldBy = (who: string) => world.orders.filter((r) => r.claimedById === who).length;
const names = (rows: Row[]) => rows.map((r) => r.orderNumber);

/**
 * What the pull would hand out next, one order after another until the pool is dry — claiming nobody for good: each order is marked
 * taken while the loop runs (as a pull would take it) and handed back at the end, so a test can ask again at another moment.
 */
async function drain(forUser: string, now: Date, withMode: boolean): Promise<string[]> {
  const out: string[] = [];
  const taken: Row[] = [];
  const mode = withMode ? await readReturnsMode(db as never, 'c1', { now, calendar: () => JO, rounds: sw.value }) : null;
  for (let i = 0; i < 100; i++) {
    const id = await pickNextCandidate(db as never, scope, now, forUser, { returns: mode });
    if (!id) break;
    out.push(byId(id).orderNumber);
    byId(id).claimedById = 'taken';
    taken.push(byId(id));
  }
  for (const o of taken) o.claimedById = null;
  return out;
}

beforeEach(() => {
  world.orders = [];
  world.history = [];
  world.logs = [];
  world.activities = [];
  world.notices = [];
  world.audience = [{ id: 'sara' }];
  world.clock = NOW;
  sw.value = ON;
  rsw.value = ON;
  vi.clearAllMocks();
});

describe('the mode is on only when BOTH switches are', () => {
  it('both plainly on: the mode, with its two cut-offs placed from the store’s calendar', async () => {
    const mode = await readReturnsMode(db as never, 'c1', { now: NOW, calendar: () => JO });
    expect(mode?.readyCut.getTime()).toBe(t(2, 9).getTime());
    expect(mode?.idleCut.getTime()).toBe(t(2, 11, 30).getTime());
  });

  it.each([
    ['its own switch off', () => { rsw.value = OFF; }],
    ['the rounds off (whatever the mode’s own switch holds)', () => { sw.value = OFF; }],
    ['both off', () => { sw.value = OFF; rsw.value = OFF; }],
    // «On» is a real `true` WITH a real date, here as in the settings store: a half-written value is off, never “on since 1970”.
    ['its own switch stored “on” with NO date', () => { rsw.value = { enabled: true, enabledAt: null }; }],
    ['its own switch “on” with a date that is not a date', () => { rsw.value = { enabled: true, enabledAt: new Date('nope') }; }],
    ['the rounds “on” with NO date (whatever the mode’s own switch holds)', () => { sw.value = { enabled: true, enabledAt: null }; }],
  ])('%s: no mode, and the calendar is not even read', async (_name, set) => {
    set();
    const calendar = vi.fn(() => JO);
    expect(await readReturnsMode(db as never, 'c1', { now: NOW, calendar })).toBeNull();
    expect(calendar).not.toHaveBeenCalled();
  });

  it('the hand limit and the idle time are the owner’s numbers: five orders, thirty working minutes', () => {
    expect(RETURNS_MODE).toEqual({ handLimit: 5, idleBusinessMinutes: 30 });
    // …and the cap of 500 and the 40 untouched are exactly what they were.
    expect(CLAIM_CAPS).toEqual({ withoutAttempt: 40, total: 500 });
  });
});

describe('1 · five «لا يرد» in a row leave her hand empty', () => {
  it('she pulls, rings, presses «لا يرد» — five times — and holds nothing; the sixth pull is a new order, not one of the five', async () => {
    for (let i = 0; i < 8; i++) order();
    const five: string[] = [];
    for (let i = 0; i < 5; i++) {
      const pulled = await pullNextOrder(scope, agent('sara'), JO, NOW);
      expect(pulled.ok, `pull ${i + 1}`).toBe(true);
      five.push(pulled.orderId!);
      // Her press: the attempt (the dial, then the answer nobody gave), and the door’s release in the same breath.
      byId(pulled.orderId!).contactAttempts.push(att(minutesAgo(1), 'OPENED', 'sara', 1), att(NOW, 'NO_ANSWER', 'sara', 2));
      expect(await returnToThePool(db as never, { companyId: 'c1', orderId: pulled.orderId!, holderId: 'sara', reason: NO_ANSWER_RETURNED_REASON })).toBe(true);
    }
    expect(heldBy('sara')).toBe(0);
    const sixth = await pullNextOrder(scope, agent('sara'), JO, NOW);
    expect(sixth.ok).toBe(true);
    expect(five).not.toContain(sixth.orderId);
  });

  it('the five are not pullable until three WORKING hours after their last «لا يرد»; then they come AFTER every new order, oldest first', async () => {
    // Pressed between 11:50 and 11:54 on Monday: each is ready three working hours after its own press, 14:50 for the first, 14:54 for the last.
    const five = Array.from({ length: 5 }, (_, i) => returned(minutesAgo(10 - i)));
    expect((await pullNextOrder(scope, agent('sara'), JO, NOW)).refusal?.code).toBe('QUEUE_EMPTY');
    expect(await drain('sara', t(2, 14, 49), true)).toEqual([]);
    // A new order arrived meanwhile, and a promise whose date is half past three.
    const fresh = order({ createdAt: t(2, 11, 30) });
    const promise = order({
      confirmationStatus: 'POSTPONED', postponedUntil: t(2, 15, 30), nextFollowUpAt: t(2, 15, 30),
      contactAttempts: [att(t(1, 10), 'OPENED')], claimHistory: [{ action: 'CLAIMED' }, { action: 'RELEASED' }],
    });
    const returnedOnes = five.map((o) => o.orderNumber);
    expect(await drain('sara', t(2, 14, 49), true)).toEqual([fresh.orderNumber]);
    // One press at a time: at 14:51 two of the five are ready; at 14:54 all of them are
    expect(await drain('sara', t(2, 14, 51), true)).toEqual([fresh.orderNumber, ...returnedOnes.slice(0, 2)]);
    // At 14:54 the five are ready — and they stand behind the new order.
    expect(await drain('sara', t(2, 14, 54), true)).toEqual([fresh.orderNumber, ...returnedOnes]);
    // Half past three: the promise’s date has arrived — after the new order, before the returned ones.
    expect(await drain('sara', t(2, 15, 31), true)).toEqual([fresh.orderNumber, promise.orderNumber, ...returnedOnes]);
  });
});

describe('2 · the pool in the owner’s order', () => {
  it('held for her · new (oldest first) · a promise whose date arrived (nearest first) · a returned order that is ready (oldest first)', async () => {
    const readyOld = returned(t(1, 10), { createdAt: t(1, 9, 1) });
    const readyNew = returned(t(1, 11), { createdAt: t(1, 9, 2) });
    const promiseFar = order({ confirmationStatus: 'POSTPONED', postponedUntil: t(2, 11), nextFollowUpAt: t(2, 11), contactAttempts: [att(t(1, 10), 'OPENED')], claimHistory: [{ action: 'CLAIMED' }, { action: 'RELEASED' }] });
    const promiseNear = order({ confirmationStatus: 'POSTPONED', postponedUntil: t(2, 9, 30), nextFollowUpAt: t(2, 9, 30), contactAttempts: [att(t(1, 10), 'OPENED')], claimHistory: [{ action: 'CLAIMED' }, { action: 'RELEASED' }] });
    const newer = order({ createdAt: t(2, 11) });
    const older = order({ createdAt: t(2, 10) });
    const held = order({ createdAt: t(2, 11, 59), assignedToId: 'sara', assignedAt: minutesAgo(10), assignee: { id: 'sara', name: 'سارة', status: 'ACTIVE' } });
    expect(await drain('sara', NOW, true)).toEqual(names([held, older, newer, promiseNear, promiseFar, readyOld, readyNew]));
  });

  it('a «لا يرد» 2h59 old is not ready; 3h00 old is — to the second', async () => {
    const edge = returned(t(2, 9)); // exactly at the cut (Monday 09:00): three working hours before noon
    const justAfter = returned(new Date(t(2, 9).getTime() + 1_000));
    expect(await drain('sara', NOW, true)).toEqual([edge.orderNumber]);
    expect(justAfter.claimedById).toBeNull();
  });

  it('a press of «اتصل» or a sent message does not hold an order back; every result that reached nobody does', async () => {
    const dialled = order({ confirmationStatus: 'IN_PROGRESS', contactAttempts: [att(minutesAgo(5), 'OPENED'), att(minutesAgo(3), 'MESSAGE_SENT')] });
    const busy = returned(minutesAgo(30)); busy.contactAttempts[1].result = 'BUSY';
    const off = returned(minutesAgo(30)); off.contactAttempts[1].result = 'UNREACHABLE';
    const noAnswer = returned(minutesAgo(30));
    expect(await drain('sara', NOW, true)).toEqual([dialled.orderNumber]);
    for (const o of [busy, off, noAnswer]) expect(o.claimedById).toBeNull();
  });

  it('an order held for a colleague is not hers to be given, ready or not', async () => {
    order({ assignedToId: 'noor', assignedAt: minutesAgo(10), assignee: { id: 'noor', name: 'نور', status: 'ACTIVE' } });
    expect(await drain('sara', NOW, true)).toEqual([]);
  });
});

describe('3 · a date holds an order until the date — whichever column carries it — and not a day earlier', () => {
  it('a postponed order is pullable AT its date: ahead of it, no; with the switch off, the two-day lead of ever', async () => {
    const o = order({ confirmationStatus: 'POSTPONED', postponedUntil: t(2, 14), nextFollowUpAt: t(2, 14), contactAttempts: [att(t(1, 10), 'ANSWERED')], claimHistory: [{ action: 'CLAIMED' }, { action: 'RELEASED' }] });
    expect(await drain('sara', NOW, true)).toEqual([]);
    o.claimedById = null;
    expect(await drain('sara', t(2, 14), true)).toEqual([o.orderNumber]);
    o.claimedById = null;
    // The same order, the same moment, the switch OFF: pullable two days ahead (POSTPONE_LEAD_DAYS), as it always was.
    rsw.value = OFF;
    expect(await drain('sara', NOW, false)).toEqual([o.orderNumber]);
  });

  it('a follow-up date on a waiting order (not “postponed”) holds it too — today it did not', async () => {
    const o = order({ confirmationStatus: 'FOLLOW_UP_REQUIRED', nextFollowUpAt: t(3, 10), contactAttempts: [att(t(1, 10), 'CALLBACK_REQUESTED')], claimHistory: [{ action: 'CLAIMED' }, { action: 'RELEASED' }] });
    expect(await drain('sara', NOW, true)).toEqual([]);
    expect(await drain('sara', t(3, 10), true)).toEqual([o.orderNumber]);
  });

  it('a stale postponement date beside a fresh follow-up date: the order waits for the later of the two', async () => {
    const o = order({ confirmationStatus: 'POSTPONED', postponedUntil: t(1, 10), nextFollowUpAt: t(3, 10), contactAttempts: [att(t(1, 10), 'ANSWERED')], claimHistory: [{ action: 'CLAIMED' }, { action: 'RELEASED' }] });
    expect(await drain('sara', NOW, true)).toEqual([]);
    expect(await drain('sara', t(3, 10), true)).toEqual([o.orderNumber]);
  });

  it('a promise whose day came and who was pressed «لا يرد» this morning waits its three hours first', async () => {
    const o = order({ confirmationStatus: 'POSTPONED', postponedUntil: t(2, 9), nextFollowUpAt: t(2, 9), contactAttempts: [att(t(2, 9, 40), 'NO_ANSWER')], claimHistory: [{ action: 'CLAIMED' }, { action: 'RELEASED' }] });
    expect(await drain('sara', NOW, true)).toEqual([]);
    expect(await drain('sara', t(2, 13), true)).toEqual([o.orderNumber]);
  });

  it('a postponed order with no date at all is not takeable — as it never was', async () => {
    order({ confirmationStatus: 'POSTPONED' });
    expect(await drain('sara', NOW, true)).toEqual([]);
  });
});

describe('4 · her hand is five', () => {
  it('five in her hands: the sixth pull is refused with the owner’s sentence, and nothing is taken', async () => {
    for (let i = 0; i < 5; i++) mine(2);
    order();
    const out = await pullNextOrder(scope, agent('sara'), JO, NOW);
    expect(out.refusal).toEqual({ code: 'CAP_TOTAL', message: 'وصلت للحد (5) — خلّصي واحد أو اضغطي «أعِدْه إلى الطابور»' });
    expect(out.refusal?.message).toBe(handLimitMessage(RETURNS_MODE.handLimit));
    expect(heldBy('sara')).toBe(5);
  });

  it('four in her hands: the fifth pull works', async () => {
    for (let i = 0; i < 4; i++) mine(2);
    order();
    expect((await pullNextOrder(scope, agent('sara'), JO, NOW)).ok).toBe(true);
    expect(heldBy('sara')).toBe(5);
  });

  it('three in her hands and two held for her make five: a NEW order is refused, what is held for her is still hers to take', async () => {
    for (let i = 0; i < 3; i++) mine(2);
    const heldFor = (n: number) => order({ createdAt: t(2, 8, n), assignedToId: 'sara', assignedAt: minutesAgo(10), assignee: { id: 'sara', name: 'سارة', status: 'ACTIVE' } });
    const h1 = heldFor(1);
    heldFor(2);
    order({ createdAt: t(1, 9) }); // an older NEW order in the pool: she is given HER hold first, never this one
    const out = await pullNextOrder(scope, agent('sara'), JO, NOW);
    expect(out.ok).toBe(true);
    expect(out.orderId).toBe(h1.id);
  });

  it('five in her hands and a hold: refused whatever she takes (the hold is counted too)', async () => {
    for (let i = 0; i < 5; i++) mine(2);
    order({ assignedToId: 'sara', assignedAt: minutesAgo(10), assignee: { id: 'sara', name: 'سارة', status: 'ACTIVE' } });
    expect((await pullNextOrder(scope, agent('sara'), JO, NOW)).refusal?.code).toBe('CAP_TOTAL');
  });

  it('her twins are held only inside the room that is left: five minus what she holds minus the order she pulls', async () => {
    mine(2); mine(2); // two in her hands
    const first = order({ customerId: 'X', createdAt: t(1, 9) });
    for (let i = 0; i < 6; i++) order({ customerId: 'X', createdAt: t(1, 10, i) });
    const out = await pullNextOrder(scope, agent('sara'), JO, NOW);
    expect(out.orderId).toBe(first.id);
    // 5 − (2 in her hands) − (the one she pulled) = 2 twins held for her, the other four stay in the shared queue.
    expect(world.orders.filter((r) => r.customerId === 'X' && r.assignedToId === 'sara')).toHaveLength(2);
    expect(world.orders.filter((r) => r.customerId === 'X' && r.assignedToId === null && r.claimedById === null)).toHaveLength(4);
  });

  it('OFF: the same five in her hands are nothing — the cap is 500, and its sentence is the old one', async () => {
    sw.value = OFF;
    rsw.value = OFF;
    for (let i = 0; i < 5; i++) mine(2);
    order();
    expect((await pullNextOrder(scope, agent('sara'), JO, NOW)).ok).toBe(true);
    // …and at 500 the old words, with the old number.
    world.orders = [];
    for (let i = 0; i < CLAIM_CAPS.total; i++) mine(2);
    order();
    const refused = await pullNextOrder(scope, agent('sara'), JO, NOW);
    expect(refused.refusal).toMatchObject({ code: 'CAP_TOTAL', message: `بلغت الحد الأقصى (${CLAIM_CAPS.total} طلب لديك).` });
  });
});

describe('5 · «الشغل أول» is quiet; the untouched order and the pace are not', () => {
  /** She holds a call she has dialled and not answered for: the rounds’ rule owes it (due, “لا يرد راجع”). */
  const owed = () => mine(5);

  it('rounds only (the mode off): the pull refuses WORK_FIRST for the call she owes — today’s rule', async () => {
    rsw.value = OFF;
    owed();
    order();
    expect((await pullNextOrder(scope, agent('sara'), JO, NOW)).refusal?.code).toBe('WORK_FIRST');
  });

  it('the mode on: the same hand, the same pool — no WORK_FIRST, the pull gives the next order', async () => {
    owed();
    const next = order();
    const out = await pullNextOrder(scope, agent('sara'), JO, NOW);
    expect(out.ok).toBe(true);
    expect(out.orderId).toBe(next.id);
  });

  it('an order in her hands with no attempt still refuses the pull: UNTOUCHED_ORDER names it', async () => {
    const untouched = mine(null);
    order();
    const out = await pullNextOrder(scope, agent('sara'), JO, NOW);
    expect(out.refusal).toMatchObject({ code: 'UNTOUCHED_ORDER', orderId: untouched.id });
  });

  it('the pace brake is the same forty an hour, and is asked AFTER the untouched order and the hand limit', async () => {
    order();
    for (let i = 0; i < PULL_PACE.perHour; i++) world.history.push({ createdAt: minutesAgo(10 + (i % 40)), userId: 'sara', action: 'CLAIMED', reason: 'PULL_NEXT' });
    expect((await pullNextOrder(scope, agent('sara'), JO, NOW)).refusal?.code).toBe('PULL_TOO_FAST');
    // With an untouched order in her hands the sentence she can act on comes first…
    mine(null);
    expect((await pullNextOrder(scope, agent('sara'), JO, NOW)).refusal?.code).toBe('UNTOUCHED_ORDER');
  });

  it('five in her hands AND forty pulls this hour: the hand limit speaks before the pace', async () => {
    for (let i = 0; i < 5; i++) mine(2);
    for (let i = 0; i < PULL_PACE.perHour; i++) world.history.push({ createdAt: minutesAgo(10 + (i % 40)), userId: 'sara', action: 'CLAIMED', reason: 'PULL_NEXT' });
    order();
    expect((await pullNextOrder(scope, agent('sara'), JO, NOW)).refusal?.code).toBe('CAP_TOTAL');
  });

  it('contact-first, region-first and the twin guard are the doors’: this file does not touch them', () => {
    // A guard against the wrong reading of «quiet»: only work-first goes quiet. (The doors keep their own tests.)
    expect(OPEN_CONFIRMATION).toContain('IN_PROGRESS');
  });
});

describe('6 · the number shown is what the pull can hand out', () => {
  /** A pool with every kind of order the mode tells apart. */
  function pool() {
    order(); order(); // two new
    returned(t(1, 10)); returned(t(2, 11)); // one ready, one pressed an hour ago
    order({ confirmationStatus: 'POSTPONED', postponedUntil: t(2, 11), nextFollowUpAt: t(2, 11), contactAttempts: [att(t(1, 10), 'ANSWERED')], claimHistory: [{ action: 'CLAIMED' }, { action: 'RELEASED' }] }); // promise arrived
    order({ confirmationStatus: 'POSTPONED', postponedUntil: t(3, 10), nextFollowUpAt: t(3, 10), contactAttempts: [att(t(1, 10), 'ANSWERED')], claimHistory: [{ action: 'CLAIMED' }, { action: 'RELEASED' }] }); // tomorrow
    order({ confirmationStatus: 'POSTPONED' }); // no date at all
    order({ confirmationStatus: 'FOLLOW_UP_REQUIRED', nextFollowUpAt: t(2, 17), contactAttempts: [att(t(1, 10), 'CALLBACK_REQUESTED')], claimHistory: [{ action: 'CLAIMED' }, { action: 'RELEASED' }] }); // later today
    order({ confirmationStatus: 'NO_ANSWER', contactAttempts: [att(t(1, 11), 'BUSY')], claimHistory: [{ action: 'CLAIMED' }, { action: 'RELEASED' }] }); // ready
    order({ assignedToId: 'noor', assignedAt: minutesAgo(10), assignee: { id: 'noor', name: 'نور', status: 'ACTIVE' } }); // held for a colleague
    order({ confirmationStatus: 'CONFIRMED', status: 'CONFIRMED' }); // decided: not in the pool
  }

  it('waitingCount equals the number of orders the pick hands out, one after the other, until the pool is dry', async () => {
    pool();
    const mode = await readReturnsMode(db as never, 'c1', { now: NOW, calendar: () => JO });
    const shown = await waitingCount(db as never, scope, NOW, 'sara', mode);
    const handed = await drain('sara', NOW, true);
    expect(handed.length).toBe(shown);
    // Two new orders, the returned one that is ready, the promise whose date arrived, and the «مشغول» one a day old. Not: the one pressed an
    // hour ago, tomorrow’s promise, the dateless one, today’s later follow-up, the one held for a colleague, the confirmed one.
    expect(shown).toBe(5);
  });

  it('what a date or an hour holds back is said apart and never counted as waiting for her', async () => {
    pool();
    const mode = await readReturnsMode(db as never, 'c1', { now: NOW, calendar: () => JO });
    // Tomorrow’s promise, today’s later follow-up, and the postponed order with no date at all.
    expect(await postponedNotDueCount(db as never, scope, NOW, mode)).toBe(3);
    // OFF: the old complement — only the postponed ones, with the two-day lead (tomorrow’s promise is inside it, so just the dateless one).
    expect(await postponedNotDueCount(db as never, scope, NOW)).toBe(1);
  });

  it('the SUPERVISOR’s number (no agent) is the mode’s too: the whole pool, but only what is READY', async () => {
    pool();
    const mode = await readReturnsMode(db as never, 'c1', { now: NOW, calendar: () => JO });
    // What an agent reads is five. A supervisor pulls nothing, so the order held for Noor is part of the pool she reads: six. Not: the
    // one pressed an hour ago, tomorrow’s promise, the dateless one, today’s later follow-up, the confirmed one.
    expect(await waitingCount(db as never, scope, NOW, 'sara', mode)).toBe(5);
    expect(await waitingCount(db as never, scope, NOW, undefined, mode)).toBe(6);
    // The same world with the mode off is the old nine: the readiness is the mode’s, and a supervisor’s number does not escape it.
    expect(await waitingCount(db as never, scope, NOW, undefined, null)).toBe(9);
    expect(await waitingCount(db as never, scope, NOW)).toBe(9);
  });

  it('OFF: the numbers are the old ones — a returned order pressed ten minutes ago counts, a postponed one inside the lead counts', async () => {
    rsw.value = OFF;
    order(); returned(minutesAgo(10));
    order({ confirmationStatus: 'POSTPONED', postponedUntil: t(3, 10), nextFollowUpAt: t(3, 10), contactAttempts: [att(t(1, 10), 'ANSWERED')], claimHistory: [{ action: 'CLAIMED' }, { action: 'RELEASED' }] });
    expect(await waitingCount(db as never, scope, NOW, 'sara')).toBe(3);
    expect(await waitingCount(db as never, scope, NOW, 'sara', null)).toBe(3);
  });
});

describe('a returning customer’s order is held for the agent who worked him — inside her hand', () => {
  /** Sara confirmed a prior order of customer X; two new orders of X arrive. Who may be named for them is the hand’s room. */
  function arrivals(inHer: number) {
    for (let i = 0; i < inHer; i++) mine(2);
    order({ customerId: 'X', confirmationStatus: 'CONFIRMED', status: 'CONFIRMED', confirmedById: 'sara', createdAt: t(1, 9) });
    return [order({ customerId: 'X', createdAt: t(2, 11) }), order({ customerId: 'X', createdAt: t(2, 11, 5) })];
  }

  it('ON: with four in her hands there is room for ONE hold, and the other order stays the shared queue’s', async () => {
    const [first, second] = arrivals(4);
    expect(await reserveReturningCustomers(scope, NOW)).toBe(1);
    expect(first.assignedToId).toBe('sara');
    expect(second.assignedToId).toBeNull();
  });

  it('ON: with five in her hands there is none', async () => {
    const [first, second] = arrivals(5);
    expect(await reserveReturningCustomers(scope, NOW)).toBe(0);
    expect([first.assignedToId, second.assignedToId]).toEqual([null, null]);
  });

  it('OFF: the same arrivals are both held — the room is 500', async () => {
    rsw.value = OFF;
    const [first, second] = arrivals(4);
    expect(await reserveReturningCustomers(scope, NOW)).toBe(2);
    expect([first.assignedToId, second.assignedToId]).toEqual(['sara', 'sara']);
  });
});

describe('a calendar with no working day', () => {
  it('a new order is pulled as ever; a returned one is never ready; nothing throws and no date before 1970 reaches the database', async () => {
    const dead = { ...JO, weekendDays: [0, 1, 2, 3, 4, 5, 6] };
    const fresh = order();
    returned(minutesAgo(600));
    const out = await pullNextOrder(scope, agent('sara'), dead, NOW);
    expect(out.orderId).toBe(fresh.id);
    const model = (db as unknown as { order: Record<string, { mock: { calls: unknown[] } }> }).order;
    const asked = JSON.stringify(['findFirst', 'findMany', 'count', 'updateMany'].map((m) => model[m].mock.calls));
    expect(asked).not.toContain('-271821');
    expect((await pullNextOrder(scope, agent('noor'), dead, NOW)).refusal?.code).toBe('QUEUE_EMPTY');
  });
});

describe('the writer of «the order leaves her hand»', () => {
  const hers = (over: Row = {}) => mine(2, { assignedAt: minutesAgo(5), ...over });
  const release = (o: Row, extra: Row = {}) =>
    returnToThePool(db as never, { companyId: 'c1', orderId: o.id, holderId: 'sara', reason: NO_ANSWER_RETURNED_REASON, ...extra });

  it('writes what the other releases write — and only that — and a history line that says nobody pressed «release»', async () => {
    const o = hers({ confirmationStatus: 'POSTPONED', postponedUntil: t(3, 10), nextFollowUpAt: t(3, 10), version: 7 });
    expect(await release(o)).toBe(true);
    expect(o).toMatchObject({ claimedById: null, claimedAt: null, currentOwnerId: null, signatureStatus: 'UNSIGNED', assignedAt: null });
    // Status, dates and version are not its business.
    expect(o).toMatchObject({ confirmationStatus: 'POSTPONED', postponedUntil: t(3, 10), nextFollowUpAt: t(3, 10), version: 7 });
    expect(world.history.at(-1)).toEqual({
      createdAt: NOW, companyId: 'c1', orderId: o.id, userId: 'sara', action: 'RELEASED', reason: 'NO_ANSWER_RETURNED',
      metadata: JSON.stringify({ automatic: true, holder: 'sara' }),
    });
  });

  it('her twins held for her STAY held for her', async () => {
    const o = hers({ customerId: 'X' });
    const twin = order({ customerId: 'X', assignedToId: 'sara', assignedAt: minutesAgo(5), assignee: { id: 'sara', name: 'سارة', status: 'ACTIVE' } });
    await release(o);
    expect(twin).toMatchObject({ assignedToId: 'sara', claimedById: null });
  });

  it.each([
    ['somebody else holds it now', { claimedById: 'noor' }],
    ['it is confirmed', { confirmationStatus: 'CONFIRMED' }],
    ['it is cancelled (the third round closed it)', { confirmationStatus: 'CANCELLED' }],
    ['it is on a trolley', { shippingBatchId: 'b1' }],
    ['it has a tracking number', { trackingNumber: 'T-1' }],
    ['its label was printed', { labelPrintedAt: NOW }],
    ['it is shipping', { shippingStatus: 'PACKING' }],
  ])('NEGATIVE: %s — nothing is released, written or told', async (_why, over) => {
    const o = hers(over);
    const before = { ...o };
    expect(await release(o)).toBe(false);
    expect(o).toMatchObject({ claimedById: before.claimedById, claimedAt: before.claimedAt });
    expect(world.history).toHaveLength(0);
  });

  it('the claim the caller read is the claim it releases: a claim made again since is left alone', async () => {
    const o = hers();
    expect(await release(o, { claimedAt: minutesAgo(999) })).toBe(false);
    expect(o.claimedById).toBe('sara');
    expect(await release(o, { claimedAt: o.claimedAt })).toBe(true);
  });
});
