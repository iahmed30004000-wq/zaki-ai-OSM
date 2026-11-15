import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE «أُغلقت اليوم» CARD PRINTS A COUNT ONLY WHEN IT REACHED THE LIMIT (RV2391, the planner's ruling 9)
 *
 * A closed-today card prints «ما ردّ N مرّات» and «أُغلق بعد N محاولات». N is not stored: it is recomputed on read in the desk's CURRENT mode. On the day the switch flips the order was closed by the OTHER mode — a legacy 3-rule
 * close read under the plan counts 0 of 5 («ما ردّ 0 مرّات»), the plan's close read after turning it off counts 5 against a limit of 3 — and the card lies.
 *
 *  1. Under the plan, a closed row whose count is BELOW the limit (CADENCE_LIMIT = 5) carries `closedWords`, the server's number-free sentence; at the limit or past it the key is absent and the row is today's, key for key.
 *  2. The same under «نظام الجولات» (the plan's count wins), on a colleague's desk (`?agent=`), and across the two flip days (legacy lines before `enabledAt`, a re-flip the same day that resets `enabledAt`, four counted of five).
 *  3. Off, nothing changes in ANY state, abnormal ones included: no `closedWords` key, `groupBy` as before, the count is the line count and the limit is 3.
 *  4. No top-level key is added: `closedWords` exists only on a closed row; no new query.
 *
 * NOW = Sunday 15 November 2026, 13:00 in Amman (10:00Z). The plan has been on since 1 November unless a test moves it.
 * Blockers: no money, no order creation, no migration, no `contracts/`, no external model.
 * ═══════════════════════════════════════════════════════════════════════
 */

const NOW = new Date('2026-11-15T10:00:00.000Z').getTime();

const { db, cad, rsw, attempts, closed, groups } = vi.hoisted(() => {
  const cad = { on: true, enabledAt: new Date('2026-11-01T00:00:00.000Z') };
  const rsw = { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } };
  const attempts: Array<{ orderId: string; createdAt: Date; result: string; employeeId: string; attemptNumber: number }> = [];
  const closed: string[] = [];
  const groups: Array<{ orderId: string; _count: { _all: number } }> = [];
  const row = (id: string) => ({
    id,
    orderNumber: `JO-${id}`,
    confirmationStatus: 'CANCELLED',
    shippingStatus: null,
    totalAmount: 10,
    currency: 'JOD',
    claimedAt: new Date('2026-11-12T08:00:00.000Z'),
    nextFollowUpAt: null,
    postponedUntil: null,
    customer: { id: `c-${id}`, fullName: 'زبون', phone: '0791234567', rawPhone: '0791234567', totalOrders: 1 },
    items: [],
    addOns: [],
    _count: { contactAttempts: attempts.filter((a) => a.orderId === id).length, notes: 0 },
  });
  const db = {
    order: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.rejectionReason) return closed.map(row);
        return [];
      }),
      count: vi.fn(async () => 0),
    },
    orderContactAttempt: {
      groupBy: vi.fn(async () => groups),
      findMany: vi.fn(async () => attempts.map((a) => ({ ...a }))),
    },
    company: { findUnique: vi.fn(async () => ({ settings: '{}' })) },
    callHelperDevice: { findFirst: vi.fn(async () => null) },
  };
  return { db, cad, rsw, attempts, closed, groups };
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
  callProofSwitch: async () => (cad.on ? { enabled: true, enabledAt: cad.enabledAt } : { enabled: false, enabledAt: null }),
}));

import { GET } from './route';
import { CLOSED_WITHOUT_COUNT_WORDS } from '@/lib/no-answer-cadence';

type Closed = { id: string; noAnswerCount: number; closedWords?: string } & Record<string, unknown>;
type Desk = { closedToday: Closed[]; noAnswerLimit: number; cadenceOn?: boolean; rounds?: boolean } & Record<string, unknown>;
const desk = async (url = 'http://localhost/api/confirmation/mine') => (await GET(new Request(url))).json() as Promise<Desk>;
const only = (d: Desk) => {
  expect(d.closedToday).toHaveLength(1);
  return d.closedToday[0];
};

/** One line on an order, a «لا يرد» by `u1` unless told otherwise. */
function line(orderId: string, at: string, result = 'NO_ANSWER') {
  attempts.push({ orderId, createdAt: new Date(at), result, employeeId: 'u1', attemptNumber: attempts.filter((a) => a.orderId === orderId).length + 1 });
}
/** The plan's own run of five counted, over two local days (the first `n` of them). */
const PLAN_FIVE = ['2026-11-13T10:00:00.000Z', '2026-11-13T10:30:00.000Z', '2026-11-13T12:30:00.000Z', '2026-11-14T06:00:00.000Z', '2026-11-14T15:00:00.000Z'];
function planned(orderId: string, n = 5) {
  for (const at of PLAN_FIVE.slice(0, n)) line(orderId, at);
}
/** What the legacy rule closed on: three «لا يرد» lines, all before the plan went on (1 November). */
function legacy(orderId: string) {
  for (const at of ['2026-10-20T08:00:00.000Z', '2026-10-20T08:30:00.000Z', '2026-10-20T09:00:00.000Z']) line(orderId, at);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  cad.on = true;
  cad.enabledAt = new Date('2026-11-01T00:00:00.000Z');
  rsw.value = { enabled: false, enabledAt: null };
  attempts.length = 0;
  closed.length = 0;
  groups.length = 0;
  closed.push('x1');
});

describe('under the plan', () => {
  it('a card closed by the plan itself (five counted over two days): the count reached the limit — no `closedWords`, the row is today’s', async () => {
    planned('x1');
    const d = await desk();
    const r = only(d);
    expect(d.noAnswerLimit).toBe(5);
    expect(r.noAnswerCount).toBe(5);
    expect('closedWords' in r).toBe(false);
  });

  it('the flip day OFF→ON: closed by the legacy rule (three lines BEFORE the switch) → counts 0 of 5 → the number-free sentence', async () => {
    legacy('x1');
    const r = only(await desk());
    expect(r.noAnswerCount).toBe(0);
    expect(r.closedWords).toBe(CLOSED_WITHOUT_COUNT_WORDS);
  });

  it('four counted of five (the `>=` boundary: 4 against 5) → the sentence; five → none', async () => {
    planned('x1', 4);
    const r = only(await desk());
    expect(r.noAnswerCount).toBe(4);
    expect(r.closedWords).toBe(CLOSED_WITHOUT_COUNT_WORDS);

    attempts.length = 0;
    planned('x1', 5);
    expect('closedWords' in only(await desk())).toBe(false);
  });

  it('a re-flip the same day (`enabledAt` newer than the plan’s own five lines): they count nothing now → 0 → the sentence', async () => {
    planned('x1');
    cad.enabledAt = new Date('2026-11-14T20:00:00.000Z');
    const r = only(await desk());
    expect(r.noAnswerCount).toBe(0);
    expect(r.closedWords).toBe(CLOSED_WITHOUT_COUNT_WORDS);
  });

  it('a sixth press after the close (a refused close retried) never counts: still five → no `closedWords`', async () => {
    planned('x1');
    line('x1', '2026-11-15T07:00:00.000Z');
    const r = only(await desk());
    expect(r.noAnswerCount).toBe(5);
    expect('closedWords' in r).toBe(false);
  });

  it('no top-level key is added, no new query: the attempts are read once, groupBy never', async () => {
    legacy('x1');
    const d = await desk();
    expect(Object.keys(d).sort()).not.toContain('closedWords');
    expect(db.orderContactAttempt.findMany).toHaveBeenCalledTimes(1);
    expect(db.orderContactAttempt.groupBy).not.toHaveBeenCalled();
  });
});

describe('under the plan with «نظام الجولات» on as well: the plan’s count wins, so the rule is the same', () => {
  it('five counted → none; legacy lines → the sentence; no «جولة» anywhere', async () => {
    rsw.value = { enabled: true, enabledAt: new Date('2026-11-01T00:00:00.000Z') };
    planned('x1');
    const full = await GET(new Request('http://localhost/api/confirmation/mine'));
    const text = await full.text();
    expect(text).not.toContain('جولة');
    const a = (JSON.parse(text) as Desk).closedToday[0];
    expect(a.noAnswerCount).toBe(5);
    expect('closedWords' in a).toBe(false);

    attempts.length = 0;
    legacy('x1');
    const b = only(await desk());
    expect(b.noAnswerCount).toBe(0);
    expect(b.closedWords).toBe(CLOSED_WITHOUT_COUNT_WORDS);
  });
});

describe('a colleague’s desk (`?agent=`)', () => {
  it('says the same: the sentence on a flip-day card, nothing on a normal one', async () => {
    legacy('x1');
    const flipped = only(await desk('http://localhost/api/confirmation/mine?agent=u2'));
    expect(flipped.closedWords).toBe(CLOSED_WITHOUT_COUNT_WORDS);

    attempts.length = 0;
    planned('x1');
    const normal = only(await desk('http://localhost/api/confirmation/mine?agent=u2'));
    expect('closedWords' in normal).toBe(false);
  });
});

describe('OFF — the desk is today’s, in every state', () => {
  it('the switch off, a closed row counting 0 (an abnormal state): still NO `closedWords` key; the limit is 3 and the count is the groupBy’s', async () => {
    cad.on = false;
    const d = await desk();
    const r = only(d);
    expect(d.noAnswerLimit).toBe(3);
    expect('cadenceOn' in d).toBe(false);
    expect(r.noAnswerCount).toBe(0);
    expect('closedWords' in r).toBe(false);
    expect(db.orderContactAttempt.groupBy).toHaveBeenCalledTimes(1);
    expect(db.orderContactAttempt.findMany).not.toHaveBeenCalled();
  });

  it('the flip day ON→OFF: the plan closed it (five lines), the limit is 3 → no key; the count is the five lines, as before (the screen now prints that real count)', async () => {
    cad.on = false;
    groups.push({ orderId: 'x1', _count: { _all: 5 } });
    const d = await desk();
    const r = only(d);
    expect(d.noAnswerLimit).toBe(3);
    expect(r.noAnswerCount).toBe(5);
    expect('closedWords' in r).toBe(false);
  });

  it('the rounds on, the plan off: a closed row below its limit has no key either (that flip stays as it was)', async () => {
    cad.on = false;
    rsw.value = { enabled: true, enabledAt: new Date('2026-11-01T00:00:00.000Z') };
    const d = await desk();
    const r = only(d);
    expect(d.rounds).toBe(true);
    expect('closedWords' in r).toBe(false);
  });
});
