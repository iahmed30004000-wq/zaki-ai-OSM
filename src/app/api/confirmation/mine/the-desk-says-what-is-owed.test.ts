import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — «طلباتي» says what she owes (the owner, 8/11: «الشغل أول»)
 *
 * One agent held 489 orders and 479 of them sat in «لا يرد». The tab was decided by a COUNT, so an order she pulled that had
 * been rung before landed there and «للشغل» said 0.
 *
 *  1. The tabs are made from ONE verdict (`work-first.ts`): due now → «اتصلي هلّق»; in the no-answer cycle and not due →
 *     «بانتظار» with the time it falls due; and an order whose last call reached the customer goes where its count put it.
 *  2. A returned «لا يرد» she has just pulled lands in «اتصلي هلّق», whatever its count — and the oldest owed order is first.
 *  3. The response says how many calls she owes, the oldest, and the banner's sentence (`due`), and each row says if it is
 *     owed, why, when it falls due, and the line the card prints (`dueNow`, `dueReason`, `dueAt`, `dueWords` — «جاهز الساعة»
 *     written here on the store's clock, so the screen ships no wording logic).
 *  4. The desk and the pull's gate agree: the same orders, the same count, the same oldest.
 *  5. «نظام الجولات» off: today's tabs, the attempts not read — only a new pull (nobody has rung it) is owed.
 *  6. A desk of 500 orders answers with one read of the attempts, and a verdict per order is arithmetic.
 *
 * Amman, 09:00–17:00, Friday and Saturday off. Time is frozen at Monday 2 November 2026, 14:00.
 * Blockers: no money, no permission, no order creation, no migration.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, sw } = vi.hoisted(() => ({
  db: {
    order: { findMany: vi.fn(), count: vi.fn(async () => 0) },
    orderContactAttempt: { groupBy: vi.fn(), findMany: vi.fn() },
  },
  sw: { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({
    user: { id: 'u1', name: 'Sara', role: 'CONFIRMATION_AGENT', companyId: 'c1', permissions: [] },
    companyId: 'c1',
    storeId: 's1',
    countryId: 'co1',
    country: { id: 'co1', code: 'JO', timezone: 'Asia/Amman', workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6] },
  }),
}));
vi.mock('@/lib/authorization', () => ({ requirePermission: async () => undefined, can: () => false }));
vi.mock('@/lib/insights-key', () => ({ mayReadInsights: () => false }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: async () => undefined }));
vi.mock('@/lib/response-clock', () => ({ firstActionTimes: async () => new Map() }));
vi.mock('@/lib/no-answer-rounds-switch', () => ({ roundsSwitch: async () => sw.value }));

import { GET } from './route';
import { zonedTimeToInstant } from '@/lib/business-calendar';
import { workFirstGate } from '@/lib/work-first';
import { OPEN_CONFIRMATION, CLAIM_CAPS } from '@/lib/confirmation-queue';

const t = (day: number, h: number, m = 0) => zonedTimeToInstant('Asia/Amman', 2026, 11, day, h, m);
const NOW = t(2, 14);
const JO = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' };

type Attempt = { orderId: string; createdAt: Date; result: string; employeeId: string; attemptNumber: number };
/** «اتصل» a minute before, then «لا يرد» — one real call. */
const call = (orderId: string, at: Date, who = 'u1'): Attempt[] => [
  { orderId, createdAt: new Date(at.getTime() - 60_000), result: 'OPENED', employeeId: who, attemptNumber: 1 },
  { orderId, createdAt: at, result: 'NO_ANSWER', employeeId: who, attemptNumber: 2 },
];
const answered = (orderId: string, at: Date): Attempt => ({ orderId, createdAt: at, result: 'ANSWERED', employeeId: 'u1', attemptNumber: 9 });

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  orderNumber: `ORD-${id}`,
  confirmationStatus: 'IN_PROGRESS',
  claimedAt: t(1, 9),
  postponedUntil: null,
  nextFollowUpAt: null,
  customer: { id: `c-${id}`, totalOrders: 1 },
  _count: { contactAttempts: 0, notes: 0 },
  ...over,
});

/**
 * Monday 14:00. What is on her desk:
 *   fresh     — pulled 15 minutes ago, nobody has rung it                       → owed, NEW
 *   returned  — a colleague rang it on Sunday; she pulled it 30 minutes ago      → owed, ROUND  (the case of the 479)
 *   promise   — the customer asked for Monday 12:00; the day came, nothing since → owed, PROMISE
 *   waiting   — she rang it an hour ago (13:00)                                  → «بانتظار», ready at 16:00
 *   ahead     — rung on Sunday, the customer asked for Monday 17:00              → «بانتظار», ready at 17:00
 *   decision  — rung, then the customer ANSWERED on Sunday; nothing decided      → no call owed; its count puts it in «بانتظار»
 *   leaving   — her run began on Sunday 09:30: twelve working hours ended 13:30  → the next release pass takes it; not owed
 */
const world = () => {
  const rows = [
    row('waiting', { claimedAt: t(2, 9, 30) }),
    row('fresh', { claimedAt: t(2, 13, 45) }),
    row('decision', { claimedAt: t(1, 9) }),
    row('returned', { claimedAt: t(2, 13, 30) }),
    row('ahead', { claimedAt: t(1, 13), nextFollowUpAt: t(2, 17) }),
    row('promise', { claimedAt: t(1, 9), postponedUntil: t(2, 12), nextFollowUpAt: t(2, 12) }),
    row('leaving', { claimedAt: t(1, 9) }),
  ];
  const attempts: Attempt[] = [
    ...call('waiting', t(2, 13)),
    ...call('decision', t(1, 9, 30)), answered('decision', t(1, 10)),
    ...call('returned', t(1, 14), 'huda'),
    ...call('ahead', t(1, 14)),
    answered('promise', t(1, 10)),
    ...call('leaving', t(1, 9, 30)),
  ];
  return { rows, attempts };
};

const desk = async () => (await GET(new Request('http://localhost/api/confirmation/mine'))).json();
const ids = (list: { id: string }[]) => list.map((o) => o.id);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  // The first findMany is the desk's open orders; the other two (closed today, confirmed) are empty.
  const { rows, attempts } = world();
  db.order.findMany.mockReset();
  db.order.findMany.mockResolvedValueOnce(rows).mockResolvedValue([]);
  db.orderContactAttempt.findMany.mockResolvedValue(attempts);
  sw.value = { enabled: true, enabledAt: t(1, 8) };
});
afterEach(() => {
  vi.useRealTimers();
});

describe('1 + 2 · the tabs come from the verdict', () => {
  it('«اتصلي هلّق» holds what she owes — the longest-waiting first — and the returned «لا يرد» is among them', async () => {
    const data = await desk();
    expect(data.rounds).toBe(true);
    // Owed: promise (held since Sunday), returned (30 minutes), fresh (15 minutes).
    expect(ids(data.work)).toEqual(['promise', 'returned', 'fresh']);
    expect(data.work.map((o: { dueReason: string }) => o.dueReason)).toEqual(['PROMISE', 'ROUND', 'NEW']);
    // …and the line each card prints, written on the server.
    expect(data.work.map((o: { dueWords: string }) => o.dueWords)).toEqual(['الزبون طلب نكلمو هلّق', 'لا يرد راجع — جولة 1 من 3', 'جديد — سحبتيه هلّق']);
    expect(data.work.every((o: { dueNow: boolean }) => o.dueNow)).toBe(true);
    // The returned one has a count of 1 — the old rule put it in «لا يرد» and «للشغل» said two.
    expect(data.work.find((o: { id: string }) => o.id === 'returned').noAnswerCount).toBe(1);
  });

  it('«بانتظار» holds what did not answer and is not due — each with the time it falls due', async () => {
    const data = await desk();
    expect(ids(data.noAnswer)).toEqual(['waiting', 'decision', 'ahead', 'leaving']);
    const byId = Object.fromEntries(data.noAnswer.map((o: { id: string }) => [o.id, o]));
    expect(byId.waiting).toMatchObject({ dueNow: false, dueReason: null, dueAt: t(2, 16).toISOString(), dueWords: 'جاهز الساعة 16:00' });
    expect(byId.ahead).toMatchObject({ dueNow: false, dueAt: t(2, 17).toISOString(), dueWords: 'جاهز الساعة 17:00' });
    // Not owed and no time: a decision pending, and an order the release is about to take — and nothing to say about either.
    expect(byId.decision).toMatchObject({ dueNow: false, dueAt: null, dueWords: null });
    expect(byId.leaving).toMatchObject({ dueNow: false, dueAt: null, dueWords: null });
  });

  it('an order whose last call reached the customer, with no date, stays where its count always put it', async () => {
    const data = await desk();
    expect(ids(data.noAnswer)).toContain('decision');
    // The same order with no earlier no-answer is under «اتصلي هلّق» (count zero), owed or not.
    db.order.findMany.mockReset();
    db.order.findMany.mockResolvedValueOnce([row('clean', { claimedAt: t(1, 9) })]).mockResolvedValue([]);
    db.orderContactAttempt.findMany.mockResolvedValue([answered('clean', t(1, 10))]);
    const again = await desk();
    expect(again.work).toHaveLength(1);
    expect(again.work[0]).toMatchObject({ id: 'clean', dueNow: false, dueAt: null });
    expect(again.due).toEqual({ count: 0, first: null, sentence: null });
    expect(again.work[0].dueWords).toBeNull();
  });

  it('no open order is on neither list: every held row is in exactly one tab', async () => {
    const data = await desk();
    const listed = [...ids(data.work), ...ids(data.noAnswer)].sort();
    expect(listed).toEqual(['ahead', 'decision', 'fresh', 'leaving', 'promise', 'returned', 'waiting']);
  });
});

describe('3 · what the response says about it', () => {
  it('how many she owes, the oldest, and the banner’s sentence — what the banner and the button say', async () => {
    const data = await desk();
    expect(data.due).toEqual({ count: 3, first: { id: 'promise', orderNumber: 'ORD-promise' }, sentence: 'عندك 3 طلبات لازم ترني عليهم هلّق' });
  });

  it('«جاهز الساعة» is the store’s clock (the country’s timezone, not the machine’s — work-first.test.ts holds three zones apart)', async () => {
    const data = await desk();
    expect(data.noAnswer.find((o: { id: string }) => o.id === 'waiting').dueWords).toBe('جاهز الساعة 16:00');
  });

  it('the count equals the rows that say they are owed — one verdict, said twice', async () => {
    const data = await desk();
    const owed = [...data.work, ...data.noAnswer].filter((o: { dueNow: boolean }) => o.dueNow);
    expect(owed).toHaveLength(data.due.count);
  });
});

describe('4 · the desk and the pull’s gate agree', () => {
  it('the same orders give the same count and the same oldest order', async () => {
    const { rows, attempts } = world();
    // The gate reads her held orders with their attempts nested; here the very same facts, handed to it the way the pull would read them.
    const tx = {
      order: {
        findMany: vi.fn(async () =>
          rows.map((r) => ({ ...r, claimedById: 'u1', contactAttempts: attempts.filter((a) => a.orderId === r.id) }))
        ),
      },
    };
    const gate = await workFirstGate(tx as never, {
      scope: { companyId: 'c1', storeId: 's1' },
      userId: 'u1',
      cal: JO,
      now: NOW,
      rounds: { enabled: true, enabledAt: t(1, 8) },
      open: OPEN_CONFIRMATION,
      room: CLAIM_CAPS.total,
    });
    const data = await desk();
    expect(gate?.count).toBe(data.due.count);
    expect(gate?.orderId).toBe(data.due.first.id);
    expect(gate?.orderNumber).toBe(data.due.first.orderNumber);
  });
});

describe('5 · «نظام الجولات» off — today’s tabs', () => {
  beforeEach(() => {
    sw.value = { enabled: false, enabledAt: null };
    const { rows } = world();
    // The count a row carries: how many attempts of any kind it has.
    const withCount = (id: string, n: number) => ({ ...rows.find((r) => r.id === id)!, _count: { contactAttempts: n, notes: 0 } });
    db.order.findMany.mockReset();
    db.order.findMany
      .mockResolvedValueOnce([withCount('fresh', 0), withCount('returned', 2), withCount('promise', 1), withCount('waiting', 2)])
      .mockResolvedValue([]);
    db.orderContactAttempt.groupBy.mockResolvedValue([
      { orderId: 'returned', _count: { _all: 1 } },
      { orderId: 'waiting', _count: { _all: 1 } },
    ]);
  });

  it('the old split by count — and the attempts are not read at all', async () => {
    const data = await desk();
    expect(data).not.toHaveProperty('rounds');
    expect(ids(data.work)).toEqual(['fresh', 'promise']);
    expect(ids(data.noAnswer)).toEqual(['returned', 'waiting']);
    expect(db.orderContactAttempt.findMany).not.toHaveBeenCalled();
  });

  it('only a new pull is owed (case 1 is today’s rule: it blocks the pull); no round, no promise, no time', async () => {
    const data = await desk();
    expect(data.due).toEqual({ count: 1, first: { id: 'fresh', orderNumber: 'ORD-fresh' }, sentence: 'عندك طلب واحد لازم ترني عليه هلّق' });
    expect(data.work.map((o: { dueWords: string | null }) => o.dueWords)).toEqual(['جديد — سحبتيه هلّق', null]);
    expect(data.work.map((o: { dueNow: boolean }) => o.dueNow)).toEqual([true, false]);
    expect(data.work[0].dueReason).toBe('NEW');
    expect([...data.work, ...data.noAnswer].every((o: { dueAt: string | null }) => o.dueAt === null)).toBe(true);
  });

  it('and the query’s own order stays (no re-sort under the old rule)', async () => {
    db.order.findMany.mockReset();
    const { rows } = world();
    db.order.findMany
      .mockResolvedValueOnce([
        { ...rows[1], claimedAt: t(2, 13), _count: { contactAttempts: 1, notes: 0 } },
        { ...rows[2], claimedAt: t(2, 12), _count: { contactAttempts: 0, notes: 0 } },
      ])
      .mockResolvedValue([]);
    const data = await desk();
    // `decision` is owed here (nobody has rung it) but comes SECOND, as the query returned it: the re-sort belongs to «نظام الجولات».
    expect(ids(data.work)).toEqual(['fresh', 'decision']);
  });
});

describe('6 · a desk of 500 orders', () => {
  it('reads the attempts ONCE, whatever the number of orders, and answers quickly', async () => {
    // The instants are placed once for the whole fixture; the request below is what is timed.
    const [nine, ten, eleven] = [t(2, 9), t(2, 10), t(2, 11)];
    const rows = Array.from({ length: 500 }, (_, i) => row(`m${i}`, { claimedAt: nine }));
    const attempts = rows.flatMap((r, i) => [...call(r.id, new Date(ten.getTime() - (i % 50) * 60_000)), ...call(r.id, eleven)]);
    db.order.findMany.mockReset();
    db.order.findMany.mockResolvedValueOnce(rows).mockResolvedValue([]);
    db.orderContactAttempt.findMany.mockResolvedValue(attempts);

    const started = performance.now();
    const data = await desk();
    const ms = performance.now() - started;

    expect(db.orderContactAttempt.findMany).toHaveBeenCalledTimes(1);
    expect(db.orderContactAttempt.groupBy).not.toHaveBeenCalled();
    expect(data.work.length + data.noAnswer.length).toBe(500);
    // One round began between 09:11 and 10:00, the second call (11:00) is inside its gap: owed from 12:11 to 13:00 — at 14:00, all.
    expect(data.due.count).toBe(500);
    // Wide on purpose: the single read above is the proof; the clock only catches a verdict that went quadratic.
    expect(ms).toBeLessThan(10_000);
  });
});
