import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — «الزبون طلب نكلمو هلّق» UNDER THE PLAN (RV2392, the planner's ruling 10)
 *
 * The customer asks for a call at a time; the day comes and nothing is logged on the order since. With «نظام الجولات» on, the rounds' desk tags that order and puts it in the due block. With «جدول المحاولات»
 * on as well the desk asked the plan alone, and the plan never reads a date: the tag vanished, and the order sat in «بانتظار» or under «اتصلي هلّق» with nothing to say.
 *
 *  1. Rounds ON + plan ON: a PROMISE (the order's later date arrived, no line logged on it since — an attempt AT the date's instant counts as logged) is `dueNow`, reason PROMISE, in «اتصلي هلّق», with the words
 *     «الزبون طلب نكلمو هلّق», whatever the plan's own state (counted 0, counted with its due arrived, counted and still waiting).
 *  2. The plan's number is untouched: `noAnswerCount` stays the counted attempts. The plan's card line («لا يرد راجع — محاولة n من 5») does NOT mask the tag.
 *  3. Only the word PROMISE is taken from the rounds: no «جولة» appears anywhere in the response, and a date still AHEAD changes nothing (the decision of the planner: that half stays open).
 *  4. Rounds OFF + plan ON: no tag (parity with the OFF desk, which never had one). Plan OFF + rounds ON: the rounds-only path, as it was.
 *  5. No new query: the attempts are read ONCE, `groupBy` never; the verdict is asked for the WATCHED agent's orders on a colleague's desk; a closed-today card never gets a verdict.
 *  6. The tag has no extra weight: the due block is ordered by how long the order has been held, a promise among the NEW and the ROUND.
 *
 * NOW = Sunday 15 November 2026, 13:00 in Amman (10:00Z), a working day 09:00–17:00. The plan has been on since 1 November.
 * Blockers: no money, no order creation, no migration, no `contracts/`, no external model.
 * ═══════════════════════════════════════════════════════════════════════
 */

const NOW = new Date('2026-11-15T10:00:00.000Z').getTime(); // 13:00 in Amman (UTC+3)
const ENABLED_AT = new Date('2026-11-01T00:00:00.000Z');
const iso = (s: string) => new Date(s);
const PROMISE_WORDS = 'الزبون طلب نكلمو هلّق';

const { db, cad, rsw, attempts, rows, closed, spy } = vi.hoisted(() => {
  const cad = { on: true };
  const rsw = { value: { enabled: true, enabledAt: new Date('2026-11-01T00:00:00.000Z') } as { enabled: boolean; enabledAt: Date | null } };
  const attempts: Array<{ orderId: string; createdAt: Date; result: string; employeeId: string; attemptNumber: number }> = [];
  const rows: Array<Record<string, unknown>> = [];
  const closed: Array<Record<string, unknown>> = [];
  const spy = { dueVerdict: vi.fn() };
  const count = (id: string) => attempts.filter((a) => a.orderId === id).length;
  const db = {
    order: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.rejectionReason) return closed.map((r) => ({ ...r, _count: { contactAttempts: count(r.id as string), notes: 0 } }));
        if (!('OR' in where)) return [];
        return rows.map((r) => ({ ...r, _count: { contactAttempts: count(r.id as string), notes: 0 } }));
      }),
      count: vi.fn(async () => 0),
    },
    orderContactAttempt: {
      groupBy: vi.fn(async () => []),
      findMany: vi.fn(async () => attempts.map((a) => ({ ...a }))),
    },
    company: { findUnique: vi.fn(async () => ({ settings: '{}' })) },
    callHelperDevice: { findFirst: vi.fn(async () => null) },
  };
  return { db, cad, rsw, attempts, rows, closed, spy };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({
    user: { id: 'u1', name: 'Sara', role: 'CONFIRMATION_AGENT', companyId: 'c1', status: 'ACTIVE', permissions: [] },
    companyId: 'c1',
    storeId: 's1',
    countryId: 'co1',
    country: { id: 'co1', code: 'JO', timezone: 'Asia/Amman', workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6] },
  }),
}));
vi.mock('@/lib/authorization', () => ({
  requirePermission: async () => undefined,
  can: (_u: unknown, k: string) => k === 'confirmation.work',
}));
vi.mock('@/lib/desk-watch', () => ({
  DESK_NOT_FOUND: 'x',
  DESK_WATCH_REFUSAL: 'x',
  mayWatchDesks: () => true,
  watchedAgent: async () => ({ id: 'u2', name: 'Lina' }),
}));
vi.mock('@/lib/insights-key', () => ({ mayReadInsights: () => false }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: async () => undefined }));
vi.mock('@/lib/response-clock', () => ({ firstActionTimes: async () => new Map() }));
vi.mock('@/lib/no-answer-rounds-switch', () => ({ roundsSwitch: async () => rsw.value }));
vi.mock('@/lib/no-answer-returns-switch', () => ({ returnsSwitch: async () => ({ enabled: false, enabledAt: null }) }));
vi.mock('@/lib/call-proof-switch', () => ({
  callProofOn: async () => false,
  callProofSwitch: async () => (cad.on ? { enabled: true, enabledAt: ENABLED_AT } : { enabled: false, enabledAt: null }),
}));
// The real `dueVerdict`, watched: the test reads what it was asked about.
vi.mock('@/lib/work-first', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/work-first')>();
  spy.dueVerdict.mockImplementation(real.dueVerdict);
  return { ...real, dueVerdict: spy.dueVerdict };
});

import { GET } from './route';

type Row = { id: string; noAnswerCount: number; dueNow: boolean; dueReason: string | null; dueAt: string | null; dueWords: string | null };
type Desk = { work: Row[]; noAnswer: Row[]; closedToday: Array<Record<string, unknown>>; noAnswerLimit: number; cadenceOn?: boolean; rounds?: boolean };
const desk = async (url = 'http://localhost/api/confirmation/mine') => (await GET(new Request(url))).json() as Promise<Desk>;
const find = (d: Desk, id: string) => [...d.work, ...d.noAnswer].find((r) => r.id === id)!;
const inWork = (d: Desk, id: string) => d.work.some((r) => r.id === id);

/** A held order. `claimedAt` is before every date unless a test says otherwise; both date columns carry the customer's date when `date` is given (the way the callback and the postponement write it). */
function held(id: string, over: { date?: string; claimedAt?: string } = {}) {
  rows.push({
    id,
    orderNumber: `JO-${id}`,
    confirmationStatus: 'IN_PROGRESS',
    shippingStatus: null,
    totalAmount: 10,
    currency: 'JOD',
    claimedAt: iso(over.claimedAt ?? '2026-11-14T08:00:00.000Z'),
    postponedUntil: over.date ? iso(over.date) : null,
    nextFollowUpAt: over.date ? iso(over.date) : null,
    customer: { id: `c-${id}`, fullName: 'زبون', phone: '0791234567', rawPhone: '0791234567', totalOrders: 1 },
    items: [],
    addOns: [],
  });
}
/** One line on an order; the `attemptNumber` follows the order's own sequence. */
function line(orderId: string, at: string, result: string, employeeId = 'u1') {
  attempts.push({ orderId, createdAt: iso(at), result, employeeId, attemptNumber: attempts.filter((a) => a.orderId === orderId).length + 1 });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  cad.on = true;
  rsw.value = { enabled: true, enabledAt: ENABLED_AT };
  attempts.length = 0;
  rows.length = 0;
  closed.length = 0;
});

describe('rounds ON + plan ON — the promise is back', () => {
  it('counted 0 (only a call that reached her), the date arrived two hours ago, nothing since → «اتصلي هلّق», PROMISE, with the words', async () => {
    held('p0', { date: '2026-11-15T08:00:00.000Z', claimedAt: '2026-11-15T08:30:00.000Z' });
    line('p0', '2026-11-15T07:30:00.000Z', 'ANSWERED');
    const d = await desk();
    expect(d.cadenceOn).toBe(true);
    expect(inWork(d, 'p0')).toBe(true);
    expect(find(d, 'p0')).toMatchObject({ dueNow: true, dueReason: 'PROMISE', dueWords: PROMISE_WORDS, noAnswerCount: 0 });
  });

  it('counted 2 with the plan’s own due arrived and a date arrived: the PROMISE words, never «لا يرد راجع — محاولة 3 من 5»; the count is still the plan’s 2', async () => {
    held('p2', { date: '2026-11-15T09:00:00.000Z' });
    line('p2', '2026-11-15T07:00:00.000Z', 'NO_ANSWER');
    line('p2', '2026-11-15T07:40:00.000Z', 'NO_ANSWER');
    const d = await desk();
    expect(find(d, 'p2')).toMatchObject({ dueNow: true, dueReason: 'PROMISE', dueWords: PROMISE_WORDS, noAnswerCount: 2 });
    expect(inWork(d, 'p2')).toBe(true);

    // The same order without the customer's date: the plan speaks, as it always did.
    rows.length = 0;
    held('p2');
    const plain = await desk();
    expect(find(plain, 'p2')).toMatchObject({ dueNow: true, dueReason: 'ROUND', dueWords: 'لا يرد راجع — محاولة 3 من 5', noAnswerCount: 2 });
  });

  it('counted 1 with the plan still waiting and a date arrived → out of «بانتظار», into «اتصلي هلّق», due now', async () => {
    held('p1', { date: '2026-11-15T09:55:00.000Z' });
    line('p1', '2026-11-15T09:50:00.000Z', 'NO_ANSWER'); // #2 is due 10:20Z — the plan alone says «بانتظار»
    const d = await desk();
    expect(inWork(d, 'p1')).toBe(true);
    expect(d.noAnswer.some((r) => r.id === 'p1')).toBe(false);
    expect(find(d, 'p1')).toMatchObject({ dueNow: true, dueReason: 'PROMISE', dueWords: PROMISE_WORDS, noAnswerCount: 1 });

    rows.length = 0;
    held('p1');
    const plain = await desk();
    expect(plain.noAnswer.some((r) => r.id === 'p1')).toBe(true);
    expect(find(plain, 'p1').dueNow).toBe(false);
  });

  it('five counted and still open, with a date arrived → PROMISE too', async () => {
    held('p5', { date: '2026-11-15T09:00:00.000Z' });
    for (const at of ['2026-11-08T07:00:00.000Z', '2026-11-08T07:30:00.000Z', '2026-11-08T09:30:00.000Z', '2026-11-09T07:00:00.000Z', '2026-11-09T15:00:00.000Z']) line('p5', at, 'NO_ANSWER');
    const d = await desk();
    expect(find(d, 'p5')).toMatchObject({ dueNow: true, dueReason: 'PROMISE', dueWords: PROMISE_WORDS, noAnswerCount: 5 });
  });
});

describe('the tag is the rounds’ own definition, not a second one', () => {
  it('a date still AHEAD gives no tag and moves nothing (the half the planner left open): counted 0 stays where its count puts it; counted 1 waiting keeps the plan’s words', async () => {
    held('ahead0', { date: '2026-11-15T12:00:00.000Z' });
    line('ahead0', '2026-11-15T07:30:00.000Z', 'ANSWERED');
    held('ahead1', { date: '2026-11-15T12:00:00.000Z' });
    line('ahead1', '2026-11-15T09:50:00.000Z', 'NO_ANSWER');
    const d = await desk();
    expect(find(d, 'ahead0')).toMatchObject({ dueNow: false, dueReason: null, dueWords: null });
    expect(find(d, 'ahead1')).toMatchObject({ dueNow: false, dueReason: null, dueWords: 'محاولة 2 من 5 — جاهز الساعة 13:20' });
    expect(d.noAnswer.some((r) => r.id === 'ahead1')).toBe(true);
  });

  it('a line logged at or after the date — an `OPENED` included — kills the tag, to the millisecond; one millisecond before it, the tag stands', async () => {
    const at = '2026-11-15T08:00:00.000Z';
    held('on', { date: at });
    line('on', '2026-11-15T07:30:00.000Z', 'ANSWERED');
    line('on', at, 'OPENED');
    held('before', { date: at });
    line('before', '2026-11-15T07:30:00.000Z', 'ANSWERED');
    line('before', '2026-11-15T07:59:59.999Z', 'OPENED');
    const d = await desk();
    expect(find(d, 'on')).toMatchObject({ dueNow: false, dueReason: null, dueWords: null });
    expect(find(d, 'before')).toMatchObject({ dueNow: true, dueReason: 'PROMISE', dueWords: PROMISE_WORDS });
  });

  it('a no-answer logged after the date falls back to the plan’s own verdict and words (the plan’s #1 is due again 30 minutes later)', async () => {
    held('after', { date: '2026-11-15T08:00:00.000Z' });
    line('after', '2026-11-15T07:30:00.000Z', 'ANSWERED');
    line('after', '2026-11-15T09:00:00.000Z', 'NO_ANSWER'); // counted #1; #2 due 09:30Z — arrived
    const d = await desk();
    expect(find(d, 'after')).toMatchObject({ dueNow: true, dueReason: 'ROUND', dueWords: 'لا يرد راجع — محاولة 2 من 5', noAnswerCount: 1 });
  });

  it('the rounds’ own exclusions hold: an order the release pass is about to take (a promise three working hours old, held through it, nothing since) has no tag', async () => {
    // The date came at 09:00 Amman (06:00Z); its three working hours of grace ended at 12:00 Amman and it is 13:00 now — held through the date with nothing logged since, the release pass takes it.
    held('stale', { date: '2026-11-15T06:00:00.000Z', claimedAt: '2026-11-14T08:00:00.000Z' });
    line('stale', '2026-11-14T08:30:00.000Z', 'ANSWERED');
    const d = await desk();
    expect(find(d, 'stale')).toMatchObject({ dueNow: false, dueReason: null, dueWords: null });
  });
});

describe('only the word PROMISE crosses over', () => {
  it('no «جولة» anywhere in the response, with a promise row on the desk; the attempts are read ONCE, groupBy never', async () => {
    held('p0', { date: '2026-11-15T08:00:00.000Z' });
    line('p0', '2026-11-15T07:30:00.000Z', 'ANSWERED');
    held('p2', { date: '2026-11-15T09:00:00.000Z' });
    line('p2', '2026-11-15T07:00:00.000Z', 'NO_ANSWER');
    line('p2', '2026-11-15T07:40:00.000Z', 'NO_ANSWER');
    held('r2');
    line('r2', '2026-11-15T07:00:00.000Z', 'NO_ANSWER');
    line('r2', '2026-11-15T07:40:00.000Z', 'NO_ANSWER');
    const res = await GET(new Request('http://localhost/api/confirmation/mine'));
    const text = await res.text();
    const d = JSON.parse(text) as Desk;
    expect(text).not.toContain('جولة');
    expect('rounds' in d).toBe(false);
    expect('due' in d).toBe(false);
    expect(d.noAnswerLimit).toBe(5);
    expect(find(d, 'r2').dueReason).toBe('ROUND');
    expect(db.orderContactAttempt.findMany).toHaveBeenCalledTimes(1);
    expect(db.orderContactAttempt.groupBy).not.toHaveBeenCalled();
  });
});

describe('the other two modes', () => {
  it('rounds OFF + plan ON: no tag, parity with the desk that never had one (the plan decides alone)', async () => {
    rsw.value = { enabled: false, enabledAt: null };
    held('p0', { date: '2026-11-15T08:00:00.000Z' });
    line('p0', '2026-11-15T07:30:00.000Z', 'ANSWERED');
    held('p2', { date: '2026-11-15T09:00:00.000Z' });
    line('p2', '2026-11-15T07:00:00.000Z', 'NO_ANSWER');
    line('p2', '2026-11-15T07:40:00.000Z', 'NO_ANSWER');
    const d = await desk();
    expect(spy.dueVerdict).not.toHaveBeenCalled();
    expect(find(d, 'p0')).toMatchObject({ dueNow: false, dueReason: null, dueWords: null });
    expect(find(d, 'p2')).toMatchObject({ dueNow: true, dueReason: 'ROUND', dueWords: 'لا يرد راجع — محاولة 3 من 5' });
  });

  it('plan OFF + rounds ON: the rounds-only path still tags the promise, with the rounds’ own count', async () => {
    cad.on = false;
    held('p0', { date: '2026-11-15T08:00:00.000Z' });
    line('p0', '2026-11-15T07:30:00.000Z', 'ANSWERED');
    const d = await desk();
    expect(d.rounds).toBe(true);
    expect('cadenceOn' in d).toBe(false);
    expect(d.noAnswerLimit).toBe(3);
    expect(find(d, 'p0')).toMatchObject({ dueNow: true, dueReason: 'PROMISE', dueWords: PROMISE_WORDS });
  });
});

describe('where it sits', () => {
  it('a promise is inside the due block and ahead of the not-due row; among the due ones the order is by how long each has been held — the promise has no extra weight', async () => {
    held('late', { claimedAt: '2026-11-12T08:00:00.000Z' }); // rung and answered, no date: not due, still «اتصلي هلّق» by its count (0)
    line('late', '2026-11-15T07:30:00.000Z', 'ANSWERED');
    held('nw', { claimedAt: '2026-11-14T08:00:00.000Z' }); // NEW
    held('pr', { date: '2026-11-15T08:00:00.000Z', claimedAt: '2026-11-13T08:00:00.000Z' });
    line('pr', '2026-11-13T09:00:00.000Z', 'ANSWERED');
    let d = await desk();
    expect(d.work.map((r) => r.id)).toEqual(['pr', 'nw', 'late']);
    expect(d.work.map((r) => r.dueReason)).toEqual(['PROMISE', 'NEW', null]);

    // The promise held for LESS time than the new one: the new one is first.
    rows.length = 0;
    attempts.length = 0;
    held('late', { claimedAt: '2026-11-12T08:00:00.000Z' });
    line('late', '2026-11-15T07:30:00.000Z', 'ANSWERED');
    held('nw', { claimedAt: '2026-11-13T08:00:00.000Z' });
    held('pr', { date: '2026-11-15T08:00:00.000Z', claimedAt: '2026-11-14T08:00:00.000Z' });
    line('pr', '2026-11-14T09:00:00.000Z', 'ANSWERED');
    d = await desk();
    expect(d.work.map((r) => r.id)).toEqual(['nw', 'pr', 'late']);
  });

  it('a closed-today card never gets a verdict: no dueNow, no dueReason, no dueWords, even with a promise date on it', async () => {
    closed.push({
      id: 'x1',
      orderNumber: 'JO-x1',
      confirmationStatus: 'CANCELLED',
      shippingStatus: null,
      totalAmount: 10,
      currency: 'JOD',
      claimedAt: iso('2026-11-13T08:00:00.000Z'),
      postponedUntil: iso('2026-11-15T08:00:00.000Z'),
      nextFollowUpAt: iso('2026-11-15T08:00:00.000Z'),
      customer: { id: 'c-x1', fullName: 'زبون', phone: '0791234567', rawPhone: '0791234567', totalOrders: 1 },
      items: [],
      addOns: [],
    });
    line('x1', '2026-11-13T09:00:00.000Z', 'ANSWERED');
    const d = await desk();
    expect(d.closedToday).toHaveLength(1);
    for (const key of ['dueNow', 'dueReason', 'dueWords']) expect(key in d.closedToday[0]).toBe(false);
  });

  it('a colleague’s desk (`?agent=u2`) tags the same, and the verdict is asked for HER orders (claimedById = the watched agent)', async () => {
    held('p0', { date: '2026-11-15T08:00:00.000Z' });
    line('p0', '2026-11-15T07:30:00.000Z', 'ANSWERED');
    const d = await desk('http://localhost/api/confirmation/mine?agent=u2');
    expect(find(d, 'p0')).toMatchObject({ dueNow: true, dueReason: 'PROMISE', dueWords: PROMISE_WORDS });
    expect(spy.dueVerdict).toHaveBeenCalled();
    for (const call of spy.dueVerdict.mock.calls) expect(call[0]).toMatchObject({ claimedById: 'u2' });
    expect(db.orderContactAttempt.findMany).toHaveBeenCalledTimes(1);
  });
});
