import { beforeEach, describe, expect, it } from 'vitest';
import { CONTACT_RESULTS } from './confirmation-workflow';
import { HOLDER_ACTIVE_BUSINESS_MINUTES, isReaching, releaseCutoffs, workClock } from './no-answer-rounds';
import { AUTO_RELEASE_BUSINESS_MINUTES } from './confirmation-queue';
import { zonedTimeToInstant } from './business-calendar';
import { isAutomaticRelease, isReleaseSheDidNotPress, managerReturnNotice, managerReturnedBy, MANAGER_RETURNED_REASON } from './auto-release';
import {
  NOBODY_REACHED_RESULTS,
  RETURN_PILE_LIMIT,
  countReturnable,
  pileCutoffs,
  pileMessage,
  pressPlan,
  returnNoAnswerPile,
  returnablePileWhere,
} from './return-no-answer-pile';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — «أرجِع «لا يرد» للطابور»: A SUPERVISOR RETURNS A HOARDED PILE (the owner, 8/11).
 *
 * Driven against an in-memory database that APPLIES the filters it is handed (with SQL's three values), so every answer comes
 * from the filter's own text and not from a mock that was told it. The transaction is strict: a table or a method the press
 * has no business touching throws by name — the status log and the activity table are not even there.
 *
 *  1. Which orders go: hers, open, never shipped, somebody rang and NOBODY WAS REACHED, and no date ahead. Everything else stays,
 *     byte for byte.
 *  2. What is written: the ninety-minute release's five fields and nothing more, one RELEASED line per order (the reason, and the
 *     presser in the metadata), the customer's twins held for her let go, ONE notice for the press.
 *  3. Up to 200 a press; the answer says how many remain; a second press returns the rest.
 *  4. Nothing to return: no write of any kind.
 *  5. An order she acted on between the read and the write is skipped and counted — never overwritten, never announced.
 *  6. The shape of a REAL pile: the call button writes OPENED before every «لا يرد», so OPENED and MESSAGE_SENT do not mean
 *     "reached". (A rule «every attempt is a no-answer» would have returned none of the owner's pile.)
 *
 * Blockers: no money, no permission, no order creation, no migration.
 * ═══════════════════════════════════════════════════════════════════════
 */

// A row is whatever the filters are asked of: the in-memory database below is as loose as the client it stands in for.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

/* ───────────────────────── the in-memory database ───────────────────────── */

type Tri = true | false | null;
const and = (xs: Tri[]): Tri => (xs.includes(false) ? false : xs.includes(null) ? null : true);
const or = (xs: Tri[]): Tri => (xs.includes(true) ? true : xs.includes(null) ? null : false);
const not = (x: Tri): Tri => (x === null ? null : !x);

/** The operators the press's filters use — and nothing else, so a filter that starts using a new one fails here by name. */
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
            case 'lte': return value === null ? null : (value as Date).getTime() <= (arg as Date).getTime();
            case 'gt': return value === null ? null : (value as Date).getTime() > (arg as Date).getTime();
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

interface World {
  orders: Row[];
  history: Row[];
  notices: Row[];
  /** Every write the press made, in order — so «nothing to return» can be asserted as «nothing at all». */
  writes: string[];
  /** Runs once, right after the press READS its orders — the gap in which she can still act. */
  afterRead: (() => void) | null;
}

/** A transaction that answers honestly, and throws on anything the press was not written to touch. */
function memoryTx(world: World) {
  const order = {
    findMany: async ({ where, orderBy, take, select }: Row) => {
      const found = sorted(world.orders.filter((r) => matches(r, where ?? {})), orderBy);
      const page = (take ? found.slice(0, take) : found).map((r) =>
        Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, r[k]]))
      );
      const gap = world.afterRead;
      world.afterRead = null;
      gap?.();
      return page;
    },
    count: async ({ where }: Row) => world.orders.filter((r) => matches(r, where ?? {})).length,
    updateMany: async ({ where, data }: Row) => {
      world.writes.push('order.updateMany');
      const hit = world.orders.filter((r) => matches(r, where));
      for (const r of hit) {
        for (const [k, v] of Object.entries(data)) r[k] = (v as Row)?.increment !== undefined ? (r[k] ?? 0) + (v as Row).increment : v;
      }
      return { count: hit.length };
    },
  };
  const orderClaimHistory = {
    createMany: async ({ data }: { data: Row[] }) => {
      world.writes.push('orderClaimHistory.createMany');
      for (const line of data) {
        world.history.push({ ...line });
        world.orders.find((o) => o.id === line.orderId)?.claimHistory.push({ action: line.action });
      }
      return { count: data.length };
    },
  };
  const notification = {
    create: async ({ data }: { data: Row }) => {
      world.writes.push('notification.create');
      world.notices.push({ ...data });
      return data;
    },
  };
  const tables: Row = { order, orderClaimHistory, notification };
  const strictly = (name: string, table: Row) =>
    new Proxy(table, {
      get(t, k) {
        if (k in t) return t[k as string];
        throw new Error(`the press touched ${name}.${String(k)} — it has no business there`);
      },
    });
  return new Proxy(
    Object.fromEntries(Object.entries(tables).map(([n, t]) => [n, strictly(n, t)])),
    {
      get(t, k) {
        if (k in t) return t[k as string];
        throw new Error(`the press touched ${String(k)} — it has no business there`);
      },
    }
  ) as never;
}

/* ───────────────────────── the fixtures ───────────────────────── */

const NOW = new Date('2026-11-08T12:00:00.000Z');
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);
const minutesAhead = (n: number) => new Date(NOW.getTime() + n * 60_000);
const SCOPE = { companyId: 'c1', storeId: 's1' };
/** The store's calendar: Amman, Sunday to Thursday 09:00-17:00 (Friday and Saturday off). NOW is Sunday 15:00 local. */
const JO = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' };
const HERS = 'salwa';
const BY = { id: 'owner', name: 'أحمد' };

const attempt = (result: string, n: number) => ({ result, createdAt: minutesAgo(400 - n), attemptNumber: n });
/** What a real desk carries: the dialler press, then the no-answer she logged. */
const REAL_SHAPE = () => [attempt('OPENED', 1), attempt('NO_ANSWER', 2)];
/** An attempt logged at a given moment — the recent ones the two working-clock guards read. */
const attemptAt = (result: string, n: number, when: Date) => ({ result, createdAt: when, attemptNumber: n });
/** The two cut-offs of NOW, drawn from the rounds system's own constant and the queue's own on the store's calendar. */
const CLOCK = workClock(JO);
const QUIET_AT = CLOCK.back(NOW, HOLDER_ACTIVE_BUSINESS_MINUTES); // an attempt AT it is old enough
const HELD_AT = CLOCK.back(NOW, AUTO_RELEASE_BUSINESS_MINUTES); // a claim AT it is old enough
const msAfter = (d: Date, ms = 1) => new Date(d.getTime() + ms);

function order(id: string, over: Row = {}): Row {
  return {
    id,
    companyId: 'c1',
    storeId: 's1',
    customerId: `cu-${id}`,
    claimedById: HERS,
    claimedAt: minutesAgo(600),
    currentOwnerId: HERS,
    signatureStatus: 'SIGNED',
    assignedToId: null,
    assignedAt: null,
    confirmationStatus: 'NO_ANSWER',
    shippingStatus: 'NOT_READY',
    shippingBatchId: null,
    trackingNumber: null,
    labelPrintedAt: null,
    postponedUntil: null,
    nextFollowUpAt: null,
    version: 3,
    totalAmount: 45,
    contactAttempts: REAL_SHAPE(),
    claimHistory: [{ action: 'CLAIMED' }],
    ...over,
  };
}

let world: World;
beforeEach(() => {
  world = { orders: [], history: [], notices: [], writes: [], afterRead: null };
});

const press = (over: Row = {}) => returnNoAnswerPile(memoryTx(world), { scope: SCOPE, agentId: HERS, by: BY, calendar: JO, now: NOW, ...over });
const byId = (id: string) => world.orders.find((o) => o.id === id)!;
const copy = (rows: Row[]) => JSON.parse(JSON.stringify(rows)) as Row[];
const goneIds = () => world.history.map((h) => h.orderId).sort();

/** The five fields the ninety-minute release writes, and nothing else. */
const LET_GO = { claimedById: null, claimedAt: null, currentOwnerId: null, signatureStatus: 'UNSIGNED', assignedAt: null };

/* ───────────────────────── 1 · which orders ───────────────────────── */

describe('which of her orders go back', () => {
  /** [id, the order] — every one is on HER desk in this store; the name says why it goes or why it stays. */
  const goes = (): [string, Row][] => [
    ['real-shape', order('real-shape')],
    ['bare-no-answer', order('bare-no-answer', { contactAttempts: [attempt('NO_ANSWER', 1)] })],
    ['busy', order('busy', { contactAttempts: [attempt('OPENED', 1), attempt('BUSY', 2)] })],
    ['unreachable', order('unreachable', { contactAttempts: [attempt('OPENED', 1), attempt('UNREACHABLE', 2)] })],
    ['three-presses', order('three-presses', { contactAttempts: [attempt('OPENED', 1), attempt('NO_ANSWER', 2), attempt('OPENED', 3), attempt('NO_ANSWER', 4)] })],
    ['whatsapp-after-no-answer', order('whatsapp-after-no-answer', { contactAttempts: [...REAL_SHAPE(), attempt('MESSAGE_SENT', 3)] })],
    ['in-progress', order('in-progress', { confirmationStatus: 'IN_PROGRESS' })],
    ['follow-up-required', order('follow-up-required', { confirmationStatus: 'FOLLOW_UP_REQUIRED' })],
    ['follow-up-date-passed', order('follow-up-date-passed', { nextFollowUpAt: minutesAgo(5) })],
    ['follow-up-date-is-now', order('follow-up-date-is-now', { nextFollowUpAt: NOW })],
    ['postponed-and-due', order('postponed-and-due', { confirmationStatus: 'POSTPONED', postponedUntil: minutesAgo(60) })],
    // the working-clock guards, from the allowed side: a quiet quarter of an hour, a claim that has had its ninety minutes
    ['last-press-exactly-the-window-ago', order('last-press-exactly-the-window-ago', { contactAttempts: [...REAL_SHAPE(), attemptAt('OPENED', 3, QUIET_AT)] })],
    ['last-press-sixteen-minutes-ago', order('last-press-sixteen-minutes-ago', { contactAttempts: [...REAL_SHAPE(), attemptAt('NO_ANSWER', 3, minutesAgo(16))] })],
    ['pulled-exactly-ninety-minutes-ago', order('pulled-exactly-ninety-minutes-ago', { claimedAt: HELD_AT })],
    ['pulled-two-hours-ago', order('pulled-two-hours-ago', { claimedAt: minutesAgo(120) })],
  ];
  const stays = (): [string, Row][] => [
    // not «لا يرد» at all
    ['never-rung', order('never-rung', { confirmationStatus: 'NEW', contactAttempts: [] })],
    ['only-the-dialler-press', order('only-the-dialler-press', { contactAttempts: [attempt('OPENED', 1)] })],
    ['only-a-message', order('only-a-message', { contactAttempts: [attempt('MESSAGE_SENT', 1)] })],
    // a date ahead is a promise to a customer
    ['postponed-ahead', order('postponed-ahead', { confirmationStatus: 'POSTPONED', postponedUntil: minutesAhead(60) })],
    ['callback-she-was-asked-for', order('callback-she-was-asked-for', { confirmationStatus: 'FOLLOW_UP_REQUIRED', nextFollowUpAt: minutesAhead(120) })],
    ['postponed-ahead-and-follow-up-passed', order('postponed-ahead-and-follow-up-passed', { postponedUntil: minutesAhead(30), nextFollowUpAt: minutesAgo(30) })],
    ['follow-up-ahead-and-postponed-passed', order('follow-up-ahead-and-postponed-passed', { postponedUntil: minutesAgo(30), nextFollowUpAt: minutesAhead(30) })],
    // a customer was reached — whatever else was logged
    ['answered', order('answered', { contactAttempts: [...REAL_SHAPE(), attempt('ANSWERED', 3)] })],
    ['asked-for-a-callback', order('asked-for-a-callback', { contactAttempts: [...REAL_SHAPE(), attempt('CALLBACK_REQUESTED', 3)] })],
    ['said-yes-in-the-log', order('said-yes-in-the-log', { contactAttempts: [...REAL_SHAPE(), attempt('CONFIRMED', 3)] })],
    ['said-no-in-the-log', order('said-no-in-the-log', { contactAttempts: [...REAL_SHAPE(), attempt('REJECTED', 3)] })],
    ['wrong-number', order('wrong-number', { contactAttempts: [...REAL_SHAPE(), attempt('WRONG_NUMBER', 3)] })],
    ['other-outcome', order('other-outcome', { contactAttempts: [...REAL_SHAPE(), attempt('OTHER', 3)] })],
    ['a-result-nobody-listed', order('a-result-nobody-listed', { contactAttempts: [...REAL_SHAPE(), attempt('SOMETHING_NEW', 3)] })],
    ['answered-first-then-no-answer', order('answered-first-then-no-answer', { contactAttempts: [attempt('ANSWERED', 1), attempt('NO_ANSWER', 2)] })],
    // decided, or on its way
    ['confirmed', order('confirmed', { confirmationStatus: 'CONFIRMED' })],
    ['cancelled-by-the-third-no-answer', order('cancelled-by-the-third-no-answer', { confirmationStatus: 'CANCELLED' })],
    ['rejected', order('rejected', { confirmationStatus: 'REJECTED' })],
    ['shipped', order('shipped', { shippingStatus: 'SHIPPED' })],
    ['waiting-for-the-courier', order('waiting-for-the-courier', { shippingStatus: 'READY_FOR_PICKUP' })],
    ['in-a-batch', order('in-a-batch', { shippingBatchId: 'b1' })],
    ['has-a-tracking-number', order('has-a-tracking-number', { trackingNumber: 'T-100' })],
    ['has-a-printed-label', order('has-a-printed-label', { labelPrintedAt: minutesAgo(10) })],
    // not hers, not here
    ['held-by-a-colleague', order('held-by-a-colleague', { claimedById: 'hind' })],
    ['in-the-queue', order('in-the-queue', { claimedById: null, claimedAt: null, currentOwnerId: null })],
    ['her-desk-in-another-store', order('her-desk-in-another-store', { storeId: 's2' })],
    ['her-desk-in-another-company', order('her-desk-in-another-company', { companyId: 'c2' })],
    // a hand that is on the phone: an attempt of ANY kind in the last quarter of an hour (the customer may be answering now)
    ['dialled-again-a-minute-ago', order('dialled-again-a-minute-ago', { contactAttempts: [...REAL_SHAPE(), attemptAt('OPENED', 3, minutesAgo(1))] })],
    ['message-two-minutes-ago', order('message-two-minutes-ago', { contactAttempts: [...REAL_SHAPE(), attemptAt('MESSAGE_SENT', 3, minutesAgo(2))] })],
    ['no-answer-logged-three-minutes-ago', order('no-answer-logged-three-minutes-ago', { contactAttempts: [...REAL_SHAPE(), attemptAt('NO_ANSWER', 3, minutesAgo(3))] })],
    ['busy-logged-thirty-seconds-ago', order('busy-logged-thirty-seconds-ago', { contactAttempts: [...REAL_SHAPE(), attemptAt('BUSY', 3, minutesAgo(0.5))] })],
    ['last-press-one-millisecond-inside-the-window', order('last-press-one-millisecond-inside-the-window', { contactAttempts: [...REAL_SHAPE(), attemptAt('OPENED', 3, msAfter(QUIET_AT))] })],
    // an order she has just taken: it still carries the PREVIOUS holder's old no-answer, and she has had no chance yet
    ['pulled-thirty-seconds-ago-with-a-previous-holders-no-answer', order('pulled-thirty-seconds-ago-with-a-previous-holders-no-answer', { claimedAt: minutesAgo(0.5) })],
    ['pulled-eighty-nine-minutes-ago', order('pulled-eighty-nine-minutes-ago', { claimedAt: minutesAgo(89) })],
    ['pulled-one-millisecond-inside-the-ninety', order('pulled-one-millisecond-inside-the-ninety', { claimedAt: msAfter(HELD_AT) })],
    ['pulled-at-a-time-nobody-recorded', order('pulled-at-a-time-nobody-recorded', { claimedAt: null })],
  ];

  it('the fixture table is not vacuous: it has orders that go AND orders that stay, of every kind', () => {
    expect(goes().length).toBeGreaterThanOrEqual(10);
    expect(stays().length).toBeGreaterThanOrEqual(25);
    expect(new Set([...goes(), ...stays()].map(([id]) => id)).size).toBe(goes().length + stays().length);
  });

  it('exactly the ones that qualify go back; every other order is left byte for byte as it was', async () => {
    world.orders = [...goes(), ...stays()].map(([, o]) => o);
    const before = copy(world.orders);

    const out = await press();

    expect(out).toMatchObject({ returned: goes().length, skipped: 0, remaining: 0, limit: 200 });
    expect(goneIds()).toEqual(goes().map(([id]) => id).sort());
    for (const [id] of stays()) expect(copy([byId(id)])[0], `«${id}» لازم يضل عندها`).toEqual(before.find((o) => o.id === id)!);
    // The ones that left were only let go of: the same five fields moved, nothing else.
    for (const [id] of goes()) {
      const was = before.find((o) => o.id === id)!;
      expect(copy([byId(id)])[0], id).toEqual({ ...was, ...LET_GO, claimHistory: [...was.claimHistory, { action: 'RELEASED' }] });
    }
  });

  it('the count a desk shows is the very set a press takes (one filter for both)', async () => {
    world.orders = [...goes(), ...stays()].map(([, o]) => o);
    expect(await countReturnable(memoryTx(world), SCOPE, HERS, JO, NOW)).toBe(goes().length);
    // each agent's count is her own desk's: the colleague's one order that qualifies is hers, nobody else's
    expect(await countReturnable(memoryTx(world), SCOPE, 'hind', JO, NOW)).toBe(1);
    expect(await countReturnable(memoryTx(world), SCOPE, 'nobody', JO, NOW)).toBe(0);
  });

  it('a date that passes by the clock of the press is passed; a date a minute ahead is not', async () => {
    world.orders = [
      order('a', { nextFollowUpAt: new Date(NOW.getTime() - 1) }),
      order('b', { nextFollowUpAt: new Date(NOW.getTime() + 1) }),
      order('c', { postponedUntil: new Date(NOW.getTime() - 1) }),
      order('d', { postponedUntil: new Date(NOW.getTime() + 1) }),
    ];
    await press();
    expect(goneIds()).toEqual(['a', 'c']);
  });
});

/* ───────────────────────── 6 · what «reached» means ───────────────────────── */

describe('«nobody was reached» is the repo’s own definition, and the call button’s OPENED does not break it', () => {
  it('the set is exactly: a no-answer, a busy line, an unreachable phone, and the two presses that claim no outcome', () => {
    expect([...NOBODY_REACHED_RESULTS].sort()).toEqual(['BUSY', 'MESSAGE_SENT', 'NO_ANSWER', 'OPENED', 'UNREACHABLE']);
    for (const result of CONTACT_RESULTS) expect(NOBODY_REACHED_RESULTS.includes(result), result).toBe(!isReaching(result));
  });

  it('the SHAPE OF THE OWNER’S PILE — OPENED then NO_ANSWER, «جولة 1 من 3» — goes back (a literal «every attempt is a no-answer» would keep all of it)', async () => {
    world.orders = Array.from({ length: 30 }, (_, i) => order(`o${i}`, { contactAttempts: REAL_SHAPE() }));
    const out = await press();
    expect(out.returned).toBe(30);
  });

  it('but one real answer anywhere in the log keeps the order with her, wherever it stands in the list', async () => {
    world.orders = [
      order('first', { contactAttempts: [attempt('ANSWERED', 1), attempt('OPENED', 2), attempt('NO_ANSWER', 3)] }),
      order('middle', { contactAttempts: [attempt('OPENED', 1), attempt('REJECTED', 2), attempt('NO_ANSWER', 3)] }),
      order('last', { contactAttempts: [attempt('OPENED', 1), attempt('NO_ANSWER', 2), attempt('CALLBACK_REQUESTED', 3)] }),
    ];
    expect((await press()).returned).toBe(0);
  });
});

/* ───────────────────────── 2 · what is written ───────────────────────── */

describe('what a press writes', () => {
  beforeEach(() => {
    world.orders = [order('o1'), order('o2'), order('o3'), order('stays', { confirmationStatus: 'CONFIRMED' })];
  });

  it('a RELEASED line per order that went — in HER name (whose order it was), the reason, and the presser in the metadata', async () => {
    await press();
    expect(world.history).toHaveLength(3);
    for (const line of world.history) {
      expect(line).toMatchObject({ companyId: 'c1', userId: HERS, action: 'RELEASED', reason: 'MANAGER_RETURNED' });
      expect(JSON.parse(line.metadata)).toEqual({ pulledBack: true, from: HERS, by: { id: 'owner', name: 'أحمد' } });
    }
    expect(goneIds()).toEqual(['o1', 'o2', 'o3']);
    expect(MANAGER_RETURNED_REASON).toBe('MANAGER_RETURNED');
  });

  it('it is NOT the system’s line (no «automatic») and NOT her work (attendance reads it by its reason), and it names who pressed', async () => {
    await press();
    const line = world.history[0] as { action: string; reason: string; metadata: string };
    expect(isAutomaticRelease(line)).toBe(false);
    expect(isReleaseSheDidNotPress(line)).toBe(true);
    expect(managerReturnedBy(line)).toEqual({ id: 'owner', name: 'أحمد' });
  });

  it('ONE notice for the whole press — to her, in this store, saying who and how many, leading to her own desk', async () => {
    await press();
    expect(world.notices).toHaveLength(1);
    const [n] = world.notices;
    expect(n).toMatchObject({ companyId: 'c1', storeId: 's1', userId: HERS, type: 'SYSTEM_ALERT', link: '/confirmation/mine' });
    expect(n.title).toBe('أحمد أرجع 3 طلب «لا يرد» للطابور');
    expect(n.message).toContain('أحمد أرجع 3 طلب «لا يرد» من طلباتك للطابور');
    expect(n.message).toContain('بتضل بإيدك اللي عليهم موعد أو اللي ردّ زبونهم');
  });

  it('a press writes only what it should: updates, one batch of lines, one notice — in that order', async () => {
    await press();
    expect(world.writes).toEqual([
      'order.updateMany', 'order.updateMany', 'order.updateMany',
      'orderClaimHistory.createMany',
      // the twins of the customers whose orders went (none here, but the step is one query for the whole press)
      'order.updateMany',
      'notification.create',
    ]);
  });
});

/* ───────────────────────── 3 · two hundred a press ───────────────────────── */

describe('two hundred a press, and a second press for the rest', () => {
  const pile = (n: number) =>
    Array.from({ length: n }, (_, i) => order(`p${String(i).padStart(3, '0')}`, { claimedAt: minutesAgo(1000 - i) }));

  it('the limit is 200', () => {
    expect(RETURN_PILE_LIMIT).toBe(200);
  });

  it('250 qualify: the first press returns the 200 held longest, says 50 remain; the second returns the 50 and says none', async () => {
    world.orders = pile(250);

    const first = await press();
    expect(first).toEqual({ returned: 200, skipped: 0, remaining: 50, limit: 200 });
    expect(world.history).toHaveLength(200);
    // the oldest holds went first
    expect(goneIds()).toEqual(Array.from({ length: 200 }, (_, i) => `p${String(i).padStart(3, '0')}`));
    expect(world.notices).toHaveLength(1);
    expect(world.notices[0].title).toBe('أحمد أرجع 200 طلب «لا يرد» للطابور');

    const second = await press();
    expect(second).toEqual({ returned: 50, skipped: 0, remaining: 0, limit: 200 });
    expect(world.history).toHaveLength(250);
    // one notice per PRESS — never one per order
    expect(world.notices).toHaveLength(2);
    expect(world.notices[1].title).toBe('أحمد أرجع 50 طلب «لا يرد» للطابور');
  });

  it('exactly 200 qualify: one press takes them all and nothing remains', async () => {
    world.orders = pile(200);
    expect(await press()).toEqual({ returned: 200, skipped: 0, remaining: 0, limit: 200 });
  });

  it('201 qualify: 200, then one', async () => {
    world.orders = pile(201);
    expect((await press()).remaining).toBe(1);
    expect((await press()).returned).toBe(1);
  });

  it('the plan the desk shows is the same arithmetic', () => {
    expect(pressPlan(479)).toEqual({ eligible: 479, limit: 200, thisPress: 200, remainingAfter: 279 });
    expect(pressPlan(200)).toEqual({ eligible: 200, limit: 200, thisPress: 200, remainingAfter: 0 });
    expect(pressPlan(12)).toEqual({ eligible: 12, limit: 200, thisPress: 12, remainingAfter: 0 });
    expect(pressPlan(0)).toEqual({ eligible: 0, limit: 200, thisPress: 0, remainingAfter: 0 });
  });
});

/* ───────────────────────── 4 · nothing to return ───────────────────────── */

describe('nothing to return', () => {
  it('writes nothing at all — no update, no line, no notice — and says so', async () => {
    world.orders = [
      order('dated', { postponedUntil: minutesAhead(60) }),
      order('reached', { contactAttempts: [...REAL_SHAPE(), attempt('ANSWERED', 3)] }),
      order('shipped', { shippingStatus: 'SHIPPED' }),
    ];
    const before = copy(world.orders);
    const out = await press();
    expect(out).toEqual({ returned: 0, skipped: 0, remaining: 0, limit: 200 });
    expect(world.writes).toEqual([]);
    expect(world.history).toEqual([]);
    expect(world.notices).toEqual([]);
    expect(copy(world.orders)).toEqual(before);
    expect(pileMessage(out)).toBe('ما في طلب «لا يرد» يرجع هلأ — اللي عليه موعد أو اللي ردّ زبونه بيضل عندها');
  });

  it('a desk with no orders at all is the same', async () => {
    world.orders = [];
    expect(await press()).toEqual({ returned: 0, skipped: 0, remaining: 0, limit: 200 });
    expect(world.writes).toEqual([]);
  });

  it('a second press right after the first finds nothing and writes nothing', async () => {
    world.orders = [order('o1'), order('o2')];
    await press();
    const written = world.writes.length;
    const again = await press();
    expect(again.returned).toBe(0);
    expect(world.writes.length).toBe(written);
    expect(world.notices).toHaveLength(1);
  });
});

/* ───────────────────────── 5 · she acted between the read and the write ───────────────────────── */

describe('an order she acted on between the read and the write is skipped, counted, and never overwritten', () => {
  /** Every way she can move between the press reading her orders and writing them. */
  const ACTS: [string, (o: Row) => void][] = [
    ['she postponed it to tomorrow', (o) => { o.confirmationStatus = 'POSTPONED'; o.postponedUntil = minutesAhead(24 * 60); }],
    ['the customer asked for a callback and she logged a date', (o) => { o.confirmationStatus = 'FOLLOW_UP_REQUIRED'; o.nextFollowUpAt = minutesAhead(90); }],
    ['she reached the customer', (o) => { o.contactAttempts.push(attempt('ANSWERED', 9)); }],
    ['the customer said he will call back', (o) => { o.contactAttempts.push(attempt('CALLBACK_REQUESTED', 9)); }],
    ['she confirmed it', (o) => { o.confirmationStatus = 'CONFIRMED'; }],
    ['she cancelled it', (o) => { o.confirmationStatus = 'CANCELLED'; }],
    ['it went into a batch', (o) => { o.shippingBatchId = 'b1'; }],
    ['a label was printed', (o) => { o.labelPrintedAt = NOW; }],
    ['it was handed to the courier', (o) => { o.shippingStatus = 'SHIPPED'; }],
    ['a colleague took it over', (o) => { o.claimedById = 'hind'; }],
    ['she gave it back and pulled it again (a new claim)', (o) => { o.claimedAt = minutesAgo(1); }],
    // (e) the call that begins in the gap: a press of «اتصال», a message, a result she has just logged — all after the read
    ['she pressed «اتصال» and the customer picked up — nothing logged yet', (o) => { o.contactAttempts.push(attemptAt('OPENED', 9, NOW)); }],
    ['a message went out to the customer', (o) => { o.contactAttempts.push(attemptAt('MESSAGE_SENT', 9, NOW)); }],
    ['she logged one more no-answer — a call she has just made', (o) => { o.contactAttempts.push(attemptAt('NO_ANSWER', 9, NOW)); }],
  ];

  it.each(ACTS)('%s', async (_name, act) => {
    // What the world makes of the order in that gap — computed on a clone, so the press can be held to it.
    const acted = order('hit');
    act(acted);
    world.orders = [order('hit'), order('quiet')];
    world.afterRead = () => act(byId('hit'));

    const out = await press();

    expect(out.returned).toBe(1);
    expect(out.skipped).toBe(1);
    expect(goneIds()).toEqual(['quiet']);
    // The skipped order is exactly what she (or the world) made it: the press wrote nothing on it and wrote no line for it.
    expect(copy([byId('hit')])[0]).toEqual(copy([acted])[0]);
    // One notice, counting only what really went
    expect(world.notices).toHaveLength(1);
    expect(world.notices[0].title).toBe('أحمد أرجع 1 طلب «لا يرد» للطابور');
  });

  it('the window is TIME, not «anything changed in the log»: a line dated before it, landing in the gap, does not stop the return', async () => {
    world.orders = [order('hit')];
    world.afterRead = () => { byId('hit').contactAttempts.push(attemptAt('NO_ANSWER', 9, minutesAgo(16))); };
    expect(await press()).toMatchObject({ returned: 1, skipped: 0 });
  });

  it('when every order was acted on: nothing returned, all counted as skipped, no line, no notice', async () => {
    world.orders = [order('a'), order('b'), order('c')];
    world.afterRead = () => { for (const o of world.orders) o.confirmationStatus = 'CONFIRMED'; };
    const out = await press();
    expect(out).toEqual({ returned: 0, skipped: 3, remaining: 0, limit: 200 });
    expect(world.history).toEqual([]);
    expect(world.notices).toEqual([]);
    expect(world.writes.filter((w) => w !== 'order.updateMany')).toEqual([]);
    expect(pileMessage(out)).toBe('تغيّرت الطلبات وقت الإرجاع (3) — حدّث الشاشة وجرّب تاني');
  });
});

/* ───────────────────────── 2b · one customer, one agent ───────────────────────── */

describe('the customer’s other orders held FOR her go back with her order (one customer, one agent)', () => {
  /** A twin: NEW, nobody's, never claimed, held for her by name. */
  const twin = (id: string, customerId: string, over: Row = {}) =>
    order(id, {
      customerId,
      claimedById: null,
      claimedAt: null,
      currentOwnerId: null,
      confirmationStatus: 'NEW',
      contactAttempts: [],
      claimHistory: [],
      assignedToId: HERS,
      assignedAt: minutesAgo(30),
      version: 1,
      ...over,
    });

  it('her twin is let go: the name and the hold are cleared and the version moves, nothing else', async () => {
    world.orders = [order('mine', { customerId: 'cu-x' }), twin('twin', 'cu-x')];
    const before = copy([byId('twin')])[0];
    await press();
    expect(copy([byId('twin')])[0]).toEqual({ ...before, assignedToId: null, assignedAt: null, version: 2 });
  });

  it('and only that: a twin held for a colleague, already claimed, already worked on, shipping, in another store, or of a customer whose order stayed', async () => {
    world.orders = [
      order('mine', { customerId: 'cu-x' }),
      order('dated', { customerId: 'cu-y', postponedUntil: minutesAhead(60) }),
      twin('held-for-hind', 'cu-x', { assignedToId: 'hind' }),
      twin('claimed-by-hind', 'cu-x', { claimedById: 'hind', claimedAt: minutesAgo(5) }),
      twin('has-history', 'cu-x', { claimHistory: [{ action: 'CLAIMED' }, { action: 'RELEASED' }] }),
      twin('not-new', 'cu-x', { confirmationStatus: 'NO_ANSWER' }),
      twin('shipping', 'cu-x', { shippingStatus: 'SHIPPED' }),
      twin('other-store', 'cu-x', { storeId: 's2' }),
      twin('other-customer-whose-order-stays', 'cu-y'),
    ];
    const before = copy(world.orders.filter((o) => o.id !== 'mine'));
    await press();
    expect(goneIds()).toEqual(['mine']);
    for (const was of before) expect(copy([byId(was.id)])[0], was.id).toEqual(was);
  });

  it('one query for the whole press, whatever the number of customers; and none when no order went', async () => {
    world.orders = [order('a', { customerId: 'cu-1' }), order('b', { customerId: 'cu-2' }), twin('t1', 'cu-1'), twin('t2', 'cu-2')];
    await press();
    expect(byId('t1').assignedToId).toBeNull();
    expect(byId('t2').assignedToId).toBeNull();
    expect(world.writes.filter((w) => w === 'order.updateMany')).toHaveLength(3); // two orders + one for all the twins

    world = { orders: [order('x', { confirmationStatus: 'CONFIRMED', customerId: 'cu-1' }), twin('t3', 'cu-1')], history: [], notices: [], writes: [], afterRead: null };
    await press();
    expect(byId('t3').assignedToId).toBe(HERS);
  });

  it('an order of the pile whose customer is missing does not break the step', async () => {
    world.orders = [order('anon', { customerId: null })];
    expect((await press()).returned).toBe(1);
  });
});

/* ───────────────────────── the words ───────────────────────── */

describe('the words', () => {
  it('what the press says, in each case', () => {
    expect(pileMessage({ returned: 200, skipped: 0, remaining: 279, limit: 200 })).toBe('رجع 200 طلب «لا يرد» للطابور — باقي 279 — اضغط تاني');
    expect(pileMessage({ returned: 12, skipped: 0, remaining: 0, limit: 200 })).toBe('رجع 12 طلب «لا يرد» للطابور');
    expect(pileMessage({ returned: 10, skipped: 2, remaining: 0, limit: 200 })).toBe('رجع 10 طلب «لا يرد» للطابور — و2 تغيّروا وبقوا عندها');
    expect(pileMessage({ returned: 0, skipped: 0, remaining: 0, limit: 200 })).toContain('ما في طلب «لا يرد» يرجع هلأ');
  });

  it('the sentences carry none of the glyphs the screens forbid (✓ ≠ and the Arabic question mark)', () => {
    const FORBIDDEN = new RegExp(`[${String.fromCharCode(0x2713, 0x2260, 0x061f)}]`);
    for (const r of [
      { returned: 200, skipped: 1, remaining: 5, limit: 200 },
      { returned: 0, skipped: 3, remaining: 0, limit: 200 },
      { returned: 0, skipped: 0, remaining: 0, limit: 200 },
    ]) {
      expect(pileMessage(r)).not.toMatch(FORBIDDEN);
    }
  });
});

describe('a line that says who pressed, and a line that cannot', () => {
  it('is read only from a RELEASED line with this reason, and an id', () => {
    const meta = JSON.stringify({ pulledBack: true, from: HERS, by: { id: 'owner', name: ' أحمد ' } });
    expect(managerReturnedBy({ action: 'RELEASED', reason: MANAGER_RETURNED_REASON, metadata: meta })).toEqual({ id: 'owner', name: 'أحمد' });
    // NEGATIVE
    expect(managerReturnedBy({ action: 'CLAIMED', reason: MANAGER_RETURNED_REASON, metadata: meta })).toBeNull();
    expect(managerReturnedBy({ action: 'RELEASED', reason: 'MANUAL_RELEASE', metadata: meta })).toBeNull();
    expect(managerReturnedBy({ action: 'RELEASED', reason: MANAGER_RETURNED_REASON, metadata: null })).toBeNull();
    expect(managerReturnedBy({ action: 'RELEASED', reason: MANAGER_RETURNED_REASON, metadata: '{not json' })).toBeNull();
    expect(managerReturnedBy({ action: 'RELEASED', reason: MANAGER_RETURNED_REASON, metadata: JSON.stringify({ by: { id: 7 } }) })).toBeNull();
    expect(managerReturnedBy({ action: 'RELEASED', reason: MANAGER_RETURNED_REASON, metadata: JSON.stringify({ by: { id: '' } }) })).toBeNull();
    expect(managerReturnedBy({ action: 'RELEASED', reason: MANAGER_RETURNED_REASON, metadata: 'null' })).toBeNull();
  });

  it('a name is optional (an account without one is still named by id), and a line with this reason is never her work, readable or not', () => {
    expect(managerReturnedBy({ action: 'RELEASED', reason: MANAGER_RETURNED_REASON, metadata: JSON.stringify({ by: { id: 'owner' } }) })).toEqual({ id: 'owner', name: null });
    expect(isReleaseSheDidNotPress({ action: 'RELEASED', reason: MANAGER_RETURNED_REASON, metadata: '{not json' })).toBe(true);
    expect(isReleaseSheDidNotPress({ action: 'RELEASED', reason: MANAGER_RETURNED_REASON, metadata: null })).toBe(true);
    // NEGATIVE: only a release; her own release and a supervisor's one-order pull-back are still hers
    expect(isReleaseSheDidNotPress({ action: 'CLAIMED', reason: MANAGER_RETURNED_REASON, metadata: null })).toBe(false);
    expect(isReleaseSheDidNotPress({ action: 'RELEASED', reason: 'MANUAL_RELEASE', metadata: JSON.stringify({ previousOwner: HERS }) })).toBe(false);
  });
});

describe('the filter, read as text', () => {
  it('names every clause the definition lists (a change to any of them is a change to the definition)', () => {
    const cut = pileCutoffs(NOW, JO);
    const w = returnablePileWhere(SCOPE, HERS, NOW, cut);
    expect(w).toMatchObject({
      companyId: 'c1', storeId: 's1', claimedById: HERS, shippingStatus: 'NOT_READY',
      shippingBatchId: null, trackingNumber: null, labelPrintedAt: null,
    });
    expect(w.confirmationStatus.in).toEqual(['NEW', 'IN_PROGRESS', 'NO_ANSWER', 'FOLLOW_UP_REQUIRED', 'POSTPONED']);
    expect(w.contactAttempts.some.result.in).toEqual(['NO_ANSWER', 'BUSY', 'UNREACHABLE']);
    // nobody reached, AND nothing of any kind in the window: one `none`, two ways to be disqualified
    expect(w.contactAttempts.none.OR).toHaveLength(2);
    const [reachedClause, recentClause] = w.contactAttempts.none.OR as [{ result: { notIn: string[] } }, unknown];
    expect(reachedClause.result.notIn).toEqual(expect.arrayContaining(['NO_ANSWER', 'BUSY', 'UNREACHABLE']));
    expect(recentClause).toEqual({ createdAt: { gt: cut.quiet } });
    // the two dates, and the claim old enough — inside AND, so the write's own `claimedAt` cannot replace it
    expect(w.AND).toHaveLength(3);
    expect(w.AND).toContainEqual({ claimedAt: { lte: cut.held } });
    expect(w).not.toHaveProperty('claimedAt');
  });
});

/* ───────────────────────── 7 · NOT out of a hand that is on the phone, and not an order she has just taken ───────────────────────── */

describe('NOT out of a hand that is on the phone', () => {
  it('(a) she dialled again a minute ago and the customer picked up — nothing is logged yet, so nothing is taken, and her result press will not meet NOT_HELD', async () => {
    world.orders = [order('on-the-call', { contactAttempts: [...REAL_SHAPE(), attemptAt('OPENED', 3, minutesAgo(1))] })];
    const before = copy(world.orders);
    const out = await press();
    expect(out).toEqual({ returned: 0, skipped: 0, remaining: 0, limit: 200 });
    expect(world.writes).toEqual([]);
    expect(world.history).toEqual([]);
    expect(world.notices).toEqual([]);
    expect(copy(world.orders)).toEqual(before);
    // …and the number on the desk's button agrees: it does not offer what the press would not take
    expect(await countReturnable(memoryTx(world), SCOPE, HERS, JO, NOW)).toBe(0);
  });

  it.each([
    ['(a) a dialler press a minute ago', 'OPENED', 1],
    ['(c) a message while the customer answers on WhatsApp, two minutes ago', 'MESSAGE_SENT', 2],
    ['a no-answer she has just logged, three minutes ago', 'NO_ANSWER', 3],
    ['a busy line, five minutes ago', 'BUSY', 5],
    ['an unreachable phone, ten minutes ago', 'UNREACHABLE', 10],
    ['the last minute of the window (fourteen minutes and fifty-nine seconds ago)', 'OPENED', 14.98],
  ])('stays with her: %s', async (_name, result, ago) => {
    world.orders = [order('hit', { contactAttempts: [...REAL_SHAPE(), attemptAt(result, 3, minutesAgo(ago))] })];
    expect((await press()).returned).toBe(0);
    expect(world.writes).toEqual([]);
    expect(await countReturnable(memoryTx(world), SCOPE, HERS, JO, NOW)).toBe(0);
  });

  it('and the same order goes once the quarter of an hour has passed — nothing else about it changed', async () => {
    world.orders = [order('hit', { contactAttempts: [...REAL_SHAPE(), attemptAt('OPENED', 3, minutesAgo(16))] })];
    expect((await press()).returned).toBe(1);
  });

  it('the window is anyone’s line, not only hers: a colleague’s press on the order counts the same (the order is hers now)', async () => {
    world.orders = [order('hit', { contactAttempts: [...REAL_SHAPE(), { ...attemptAt('OPENED', 3, minutesAgo(2)), employeeId: 'hind' }] })];
    expect((await press()).returned).toBe(0);
  });

  it('only the order on the call is held back: the rest of the pile goes', async () => {
    world.orders = [
      order('on-the-call', { contactAttempts: [...REAL_SHAPE(), attemptAt('OPENED', 3, minutesAgo(1))] }),
      order('quiet-1'),
      order('quiet-2'),
    ];
    expect(await press()).toEqual({ returned: 2, skipped: 0, remaining: 0, limit: 200 });
    expect(goneIds()).toEqual(['quiet-1', 'quiet-2']);
    expect(byId('on-the-call').claimedById).toBe(HERS);
    expect(world.notices[0].title).toBe('أحمد أرجع 2 طلب «لا يرد» للطابور');
  });
});

describe('NOT an order she has just taken', () => {
  it('(b) re-pulled thirty seconds ago, still carrying the PREVIOUS holder’s old no-answer: it stays, however old the no-answer is', async () => {
    world.orders = [order('just-pulled', { claimedAt: minutesAgo(0.5), contactAttempts: REAL_SHAPE() })];
    const before = copy(world.orders);
    expect(await press()).toEqual({ returned: 0, skipped: 0, remaining: 0, limit: 200 });
    expect(world.writes).toEqual([]);
    expect(copy(world.orders)).toEqual(before);
    expect(await countReturnable(memoryTx(world), SCOPE, HERS, JO, NOW)).toBe(0);
  });

  it.each([
    ['one minute ago', minutesAgo(1)],
    ['an hour ago', minutesAgo(60)],
    ['eighty-nine minutes ago', minutesAgo(89)],
  ])('stays until she has had her ninety working minutes: pulled %s', async (_name, claimedAt) => {
    world.orders = [order('hit', { claimedAt })];
    expect((await press()).returned).toBe(0);
  });

  it('and goes once she has: pulled ninety-one minutes ago', async () => {
    world.orders = [order('hit', { claimedAt: minutesAgo(91) })];
    expect((await press()).returned).toBe(1);
  });
});

describe('the boundary minute of each window', () => {
  it('(i) an attempt AT the edge of the quarter of an hour is old enough; one millisecond inside it is not', async () => {
    world.orders = [
      order('at-the-edge', { contactAttempts: [...REAL_SHAPE(), attemptAt('OPENED', 3, QUIET_AT)] }),
      order('one-ms-inside', { contactAttempts: [...REAL_SHAPE(), attemptAt('OPENED', 3, msAfter(QUIET_AT))] }),
      order('one-ms-outside', { contactAttempts: [...REAL_SHAPE(), attemptAt('OPENED', 3, msAfter(QUIET_AT, -1))] }),
    ];
    await press();
    expect(goneIds()).toEqual(['at-the-edge', 'one-ms-outside']);
  });

  it('(ii) a claim AT the ninety-minute edge is old enough; one millisecond inside it is not', async () => {
    world.orders = [
      order('at-the-edge', { claimedAt: HELD_AT }),
      order('one-ms-inside', { claimedAt: msAfter(HELD_AT) }),
      order('one-ms-outside', { claimedAt: msAfter(HELD_AT, -1) }),
    ];
    await press();
    expect(goneIds()).toEqual(['at-the-edge', 'one-ms-outside']);
  });

  it('the two edges are the rounds system’s own: 15 and 90 working minutes — in the middle of a working day, the wall clock’s', () => {
    expect(HOLDER_ACTIVE_BUSINESS_MINUTES).toBe(15);
    expect(AUTO_RELEASE_BUSINESS_MINUTES).toBe(90);
    expect(NOW.getTime() - QUIET_AT.getTime()).toBe(15 * 60_000);
    expect(NOW.getTime() - HELD_AT.getTime()).toBe(90 * 60_000);
  });

  it('pileCutoffs is exactly the rounds release’s «recent» cut-off and the queue’s ninety minutes, on the same working clock', () => {
    expect(pileCutoffs(NOW, JO)).toEqual({ quiet: releaseCutoffs(NOW, CLOCK).recent, held: CLOCK.back(NOW, AUTO_RELEASE_BUSINESS_MINUTES) });
  });
});

describe('the guard is in the READ and in the WRITE, each on its own', () => {
  it('READ: orders on a call do not use up the 200 — the hundred oldest are on the phone, and the other hundred and fifty all go in one press', async () => {
    world.orders = Array.from({ length: 250 }, (_, i) =>
      order(`p${String(i).padStart(3, '0')}`, {
        claimedAt: minutesAgo(1000 - i),
        contactAttempts: i < 100 ? [...REAL_SHAPE(), attemptAt('OPENED', 3, minutesAgo(2))] : REAL_SHAPE(),
      })
    );
    const out = await press();
    // without the guard in the read, the 200 oldest are read (a hundred of them blocked) and this would be 100 returned, 100 skipped, 50 remaining
    expect(out).toEqual({ returned: 150, skipped: 0, remaining: 0, limit: 200 });
    expect(goneIds()).toEqual(Array.from({ length: 150 }, (_, i) => `p${String(i + 100).padStart(3, '0')}`));
  });

  it('READ: the count on the desk skips them too (the same filter)', async () => {
    world.orders = [order('on-the-call', { contactAttempts: [...REAL_SHAPE(), attemptAt('OPENED', 3, minutesAgo(1))] }), order('quiet'), order('fresh', { claimedAt: minutesAgo(2) })];
    expect(await countReturnable(memoryTx(world), SCOPE, HERS, JO, NOW)).toBe(1);
    expect(pressPlan(await countReturnable(memoryTx(world), SCOPE, HERS, JO, NOW))).toMatchObject({ eligible: 1, thisPress: 1 });
  });

  it('WRITE: (e) a press of «اتصال» that lands between the read and the write stops that order, counted as skipped, and nothing is written on it', async () => {
    world.orders = [order('hit'), order('quiet')];
    world.afterRead = () => byId('hit').contactAttempts.push(attemptAt('OPENED', 9, msAfter(NOW, 5_000)));
    const before = copy([byId('hit')])[0];
    const out = await press();
    expect(out).toMatchObject({ returned: 1, skipped: 1 });
    expect(goneIds()).toEqual(['quiet']);
    expect(copy([byId('hit')])[0]).toEqual({ ...before, contactAttempts: [...before.contactAttempts, expect.objectContaining({ result: 'OPENED' })] });
  });

  it('WRITE: a claim re-pulled in the gap is stopped (the new claim is neither the one she read nor ninety minutes old)', async () => {
    world.orders = [order('hit')];
    world.afterRead = () => { byId('hit').claimedAt = minutesAgo(5); };
    expect(await press()).toMatchObject({ returned: 0, skipped: 1 });
  });
});

describe('the clock is the store’s WORKING clock — a Friday, and the evening, add no minutes', () => {
  /** A moment in Amman. 2026-11-12 is a Thursday, 11-13 a Friday (the weekend), 11-08 the Sunday NOW falls on. */
  const at = (day: number, hour: number, minute = 0) => zonedTimeToInstant('Asia/Amman', 2026, 11, day, hour, minute);
  const FRIDAY_NOON = at(13, 12);
  /**
   * An order that is hers and long taken on `now`'s own WORKING clock (three days back: a weekend's wall-clock hours are not
   * working minutes, so «ten hours ago» on a Friday would be no time at all) — so only the guard under test can stop it.
   */
  const hers = (now: Date, id: string, over: Row = {}) => {
    const longAgo = new Date(now.getTime() - 3 * 24 * 60 * 60_000);
    return order(id, {
      claimedAt: longAgo,
      contactAttempts: [attemptAt('OPENED', 1, msAfter(longAgo, 60_000)), attemptAt('NO_ANSWER', 2, msAfter(longAgo, 120_000))],
      ...over,
    });
  };

  it('on a Friday, a press logged ten working minutes before Thursday’s close is still «right now» — the wall clock says nineteen hours', async () => {
    world.orders = [hers(FRIDAY_NOON, 'pressed-1650', { contactAttempts: [attemptAt('NO_ANSWER', 0, at(12, 10)), attemptAt('OPENED', 1, at(12, 16, 50))] })];
    expect(FRIDAY_NOON.getTime() - at(12, 16, 50).getTime()).toBeGreaterThan(18 * 60 * 60_000);
    expect((await press({ now: FRIDAY_NOON })).returned).toBe(0);
  });

  it('…and thirty working minutes before the close is old enough', async () => {
    world.orders = [hers(FRIDAY_NOON, 'pressed-1630', { contactAttempts: [attemptAt('NO_ANSWER', 0, at(12, 10)), attemptAt('OPENED', 1, at(12, 16, 30))] })];
    expect((await press({ now: FRIDAY_NOON })).returned).toBe(1);
  });

  it('on a Friday, a claim taken at 16:30 on Thursday has had thirty working minutes, not ninety — it stays; taken at 15:30 it has had exactly ninety — it goes', async () => {
    world.orders = [hers(FRIDAY_NOON, 'taken-1630', { claimedAt: at(12, 16, 30) }), hers(FRIDAY_NOON, 'taken-1531', { claimedAt: at(12, 15, 31) }), hers(FRIDAY_NOON, 'taken-1530', { claimedAt: at(12, 15, 30) })];
    await press({ now: FRIDAY_NOON });
    expect(goneIds()).toEqual(['taken-1530']);
  });

  it('after closing the minutes do not run either: at 18:30 a press at 17:30 is after the 16:45 edge — it stays; one at 16:40 goes', async () => {
    const evening = at(8, 18, 30);
    world.orders = [
      hers(evening, 'pressed-1730', { contactAttempts: [attemptAt('NO_ANSWER', 0, at(8, 10)), attemptAt('OPENED', 1, at(8, 17, 30))] }),
      hers(evening, 'pressed-1640', { contactAttempts: [attemptAt('NO_ANSWER', 0, at(8, 10)), attemptAt('OPENED', 1, at(8, 16, 40))] }),
    ];
    await press({ now: evening });
    expect(goneIds()).toEqual(['pressed-1640']);
  });

  it('the plan on the desk reads the same clock: on a Friday the count is what the press would take', async () => {
    world.orders = [
      hers(FRIDAY_NOON, 'pressed-1650', { contactAttempts: [attemptAt('NO_ANSWER', 0, at(12, 10)), attemptAt('OPENED', 1, at(12, 16, 50))] }),
      hers(FRIDAY_NOON, 'quiet'),
    ];
    expect(await countReturnable(memoryTx(world), SCOPE, HERS, JO, FRIDAY_NOON)).toBe(1);
  });

  it('it is the STORE’S calendar: a store whose weekend is Sunday-Saturday has a press at 16:50 on Friday still inside the quarter of an hour on Sunday afternoon; ours does not', async () => {
    const lastFriday = at(6, 16, 50);
    const mk = () => order('hit', { claimedAt: minutesAgo(5 * 24 * 60), contactAttempts: [...REAL_SHAPE(), attemptAt('OPENED', 3, lastFriday)] });
    world.orders = [mk()];
    expect((await press({ calendar: JO })).returned).toBe(1);
    world = { orders: [mk()], history: [], notices: [], writes: [], afterRead: null };
    expect((await press({ calendar: { ...JO, weekendDays: [0, 6] } })).returned).toBe(0);
  });
});

describe('a supervisor with no name', () => {
  it('the notice calls him «المشرف» — never a blank before «أرجع» — and a name is trimmed', () => {
    for (const name of ['', '   ']) {
      const n = managerReturnNotice({ companyId: 'c1', storeId: 's1', holderId: HERS, by: { name }, returned: 4 });
      expect(n.title).toBe('المشرف أرجع 4 طلب «لا يرد» للطابور');
      expect(n.message.startsWith('المشرف أرجع 4 طلب «لا يرد» من طلباتك للطابور.')).toBe(true);
    }
    expect(managerReturnNotice({ companyId: 'c1', storeId: 's1', holderId: HERS, by: { name: '  أحمد  ' }, returned: 1 }).title).toBe('أحمد أرجع 1 طلب «لا يرد» للطابور');
  });

  it('and through a real press: a supervisor whose account has no name is still told to her as «المشرف»', async () => {
    world.orders = [order('o1')];
    await press({ by: { id: 'owner', name: '' } });
    expect(world.notices[0].title).toBe('المشرف أرجع 1 طلب «لا يرد» للطابور');
  });
});
