import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «جدول المحاولات» ON «طلباتي» (Confirmation Center v2, step B) — the desk counts the plan, and says it in the SERVER's words:
 *
 *   · the limit the screens get is 5 (the constant stays 3), `cadenceOn` is said, there is NO `rounds` key (the chip never says «جولة») and no `due` banner (the returns mode comes with it);
 *   · each card's number is the COUNTED attempts (the same fold the door closes with), `groupBy` is not used, the attempts are read ONCE for the whole desk (the proof shares that read);
 *   · a card whose due is ahead sits in «بانتظار» with its due and its words; the moment the due arrives it is in «اتصلي هلّق» with «لا يرد راجع — محاولة n من 5»; a NEW order keeps its words;
 *   · `closesOnNext` is a fact of the server's clock: only when a press NOW would close it;
 *   · the dues skip the Country's rest days (Friday and Saturday here) and fall inside its work hours (09:00-17:00 here) — #2 and #3 as well as #4 — and print the real due: «جاهز الأحد الساعة 09:00» for a Thursday
 *     #3 and for a Thursday-evening #1, «جاهز بكرة الساعة 09:00» for a Sunday-evening one — and are the very dues the door would store (`cadenceCalOf`, fed the same country);
 *   · lines from before the switch went on count nothing (the order is as if never rung: it lands by its attempt count);
 *   · a colleague's desk (`?agent=`) shows the same limit and numbers;
 *   · OFF (the switch off, or `callProofSwitch` missing from a mock) the desk is today's: limit 3, `groupBy`, no new key.
 *
 * The harness of `the-desk-says-what-the-no-answer-waits-for.test.ts`.
 */

const NOW = new Date('2026-11-15T10:00:00.000Z').getTime(); // 13:00 in Amman (UTC+3)
const ENABLED_AT = new Date('2026-11-01T00:00:00.000Z');
const MIN = 60_000;
const iso = (s: string) => new Date(s);

const { db, cad, rsw, proof, attempts, closedWheres, extraOrders, COUNTRY } = vi.hoisted(() => {
  const cad = { on: true };
  /** The `where` of every «أُغلقت اليوم» query the route made — what the mock filters by, and what the tests read back. */
  type ClosedWhere = { confirmationStatus: string; rejectionReason: unknown; statusLogs: { some: { note: unknown; createdAt: { gte: Date } } } };
  const closedWheres: ClosedWhere[] = [];
  const rsw = { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } };
  const proof = { on: false };
  const attempts: Array<{ orderId: string; createdAt: Date; result: string; employeeId: string; attemptNumber: number }> = [];
  /** Held orders a single test adds to the desk (id → the order's own attempt count); emptied before each test. */
  const extraOrders: Array<{ id: string; attemptCount: number }> = [];
  const row = (id: string, attemptCount: number) => ({
    id,
    orderNumber: `JO-${id}`,
    confirmationStatus: 'IN_PROGRESS',
    shippingStatus: null,
    totalAmount: 10,
    currency: 'JOD',
    claimedAt: new Date('2026-11-12T08:00:00.000Z'),
    nextFollowUpAt: null,
    postponedUntil: null,
    customer: { id: `c-${id}`, fullName: 'زبون', phone: '0791234567', rawPhone: '0791234567', totalOrders: 1 },
    items: [],
    addOns: [],
    _count: { contactAttempts: attemptCount, notes: 0 },
  });
  // What today's closed-card query can meet: the plan's close (x1), the rule of three's close (x3), and two decoys that each match only HALF of the question.
  const closed = [
    { card: row('x1', 5), reason: 'NO_ANSWER_5_ATTEMPTS', note: 'AUTO_CLOSE_NO_ANSWER_5_ATTEMPTS' },
    { card: row('x3', 3), reason: 'NO_ANSWER_3_ATTEMPTS', note: 'AUTO_CLOSE_NO_ANSWER_3_ATTEMPTS' },
    { card: row('x4', 4), reason: 'PRICE_TOO_HIGH', note: 'AUTO_CLOSE_NO_ANSWER_5_ATTEMPTS' },
    { card: row('x5', 4), reason: 'NO_ANSWER_5_ATTEMPTS', note: 'A_PERSON_WROTE_THIS' },
  ];
  const listOf = (v: unknown): string[] => (typeof v === 'string' ? [v] : ((v as { in?: string[] }).in ?? []));
  const db = {
    order: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.rejectionReason) {
          const closedWhere = where as unknown as ClosedWhere;
          closedWheres.push(closedWhere);
          // A real filter, not a truthy check: a one-code or one-note `where` shows up as a missing card.
          return closed
            .filter((r) => closedWhere.confirmationStatus === 'CANCELLED' && listOf(closedWhere.rejectionReason).includes(r.reason) && listOf(closedWhere.statusLogs.some.note).includes(r.note))
            .map((r) => ({ ...r.card, confirmationStatus: 'CANCELLED' }));
        }
        if (!('OR' in where)) return [];
        return [row('nw', 0), row('wt', 1), row('dn', 1), row('c5', 5), row('f4d', 4), row('f4w', 4), row('old', 2), ...extraOrders.map((o) => row(o.id, o.attemptCount))];
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
  /** Jordan's live row: 09:00-17:00, Friday and Saturday off — handed to the route's context AND to the door's builder in the test below, so the two cannot be fed different countries. */
  const COUNTRY = { id: 'co1', code: 'JO', timezone: 'Asia/Amman', workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6] };
  return { db, cad, rsw, proof, attempts, closedWheres, extraOrders, COUNTRY };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({
    user: { id: 'u1', name: 'Sara', role: 'CONFIRMATION_AGENT', companyId: 'c1', status: 'ACTIVE', permissions: [] },
    companyId: 'c1',
    storeId: 's1',
    countryId: 'co1',
    country: COUNTRY,
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
  callProofOn: async () => proof.on,
  callProofSwitch: async () => (cad.on ? { enabled: true, enabledAt: ENABLED_AT } : { enabled: false, enabledAt: null }),
}));

import { GET } from './route';
import { cadenceCalOf, cadencePress } from '@/lib/no-answer-cadence';

type Row = { id: string; noAnswerCount: number; dueNow: boolean; dueReason: string | null; dueAt: string | null; dueWords: string | null; closesOnNext?: boolean; attemptWords?: string; noAnswerHint?: string };
type Desk = {
  work: Row[]; noAnswer: Row[]; closedToday: Row[]; noAnswerLimit: number; cadenceOn?: boolean; rounds?: boolean; due?: unknown; callProofOn?: boolean;
};
const desk = async (url = 'http://localhost/api/confirmation/mine') => (await GET(new Request(url))).json() as Promise<Desk>;
const all = (d: Desk) => [...d.work, ...d.noAnswer];
const byId = (d: Desk, id: string) => all(d).find((r) => r.id === id)!;

/** An on-plan run of `n` counted attempts ending at the last of `times`; every line is a «لا يرد» by `u1`. */
function plan(orderId: string, times: string[]) {
  times.forEach((t, i) => attempts.push({ orderId, createdAt: iso(t), result: 'NO_ANSWER', employeeId: 'u1', attemptNumber: i + 1 }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  cad.on = true;
  proof.on = false;
  rsw.value = { enabled: false, enabledAt: null };
  attempts.length = 0;
  closedWheres.length = 0;
  extraOrders.length = 0;
  // wt: #1 ten minutes ago → #2 due in 20 minutes (13:20 Amman).
  plan('wt', ['2026-11-15T09:50:00.000Z']);
  // dn: #1 forty minutes ago → #2 was due ten minutes ago.
  plan('dn', ['2026-11-15T09:20:00.000Z']);
  // The mocked country (Jordan's live row) works 09:00-17:00 with Friday and Saturday off, and #4 is due at ITS start of work (09:00 = 06:00Z in Amman): the fixtures sit on working days, #2 and #3
  // inside the work hours and #4 on its due — a press on a rest day, or outside the hours, before its due would be EARLY and would not count.
  // c5: five counted over two working days (Sunday and Monday last week); still open (the close did not go through).
  plan('c5', ['2026-11-08T10:00:00.000Z', '2026-11-08T10:30:00.000Z', '2026-11-08T12:30:00.000Z', '2026-11-09T06:00:00.000Z', '2026-11-09T15:00:00.000Z']);
  // f4d: four counted (Monday and Tuesday last week), the evening of #5 passed days ago — a press now would close it.
  plan('f4d', ['2026-11-09T10:00:00.000Z', '2026-11-09T10:30:00.000Z', '2026-11-09T12:30:00.000Z', '2026-11-10T06:00:00.000Z']);
  // f4w: four counted — #3 was Thursday 15:00 (#1 12:30, #2 13:00, all inside the hours), Friday and Saturday are rest days, so #4 was this morning, Sunday, at 09:00 (06:00Z); #5 is due at 16:00 today (ruling 16: an hour before Jordan's 17:00 end),
  // so a press now is early and closes nothing.
  plan('f4w', ['2026-11-12T09:30:00.000Z', '2026-11-12T10:00:00.000Z', '2026-11-12T12:00:00.000Z', '2026-11-15T06:00:00.000Z']);
  // x1: today's closed card — its five counted attempts (Monday and Tuesday last week).
  plan('x1', ['2026-11-09T10:00:00.000Z', '2026-11-09T10:30:00.000Z', '2026-11-09T12:30:00.000Z', '2026-11-10T06:00:00.000Z', '2026-11-10T15:00:00.000Z']);
  // old: two lines from BEFORE the switch went on — invisible to the plan.
  plan('old', ['2026-10-20T08:00:00.000Z', '2026-10-20T08:30:00.000Z']);
});

describe('ON — the numbers', () => {
  it('limit 5, cadenceOn, no `rounds`, no `due` banner; the counts are the COUNTED attempts; groupBy is not used; the attempts are read once', async () => {
    const d = await desk();
    expect(d.noAnswerLimit).toBe(5);
    expect(d.cadenceOn).toBe(true);
    expect('rounds' in d).toBe(false);
    expect('due' in d).toBe(false);
    expect(Object.fromEntries(all(d).map((r) => [r.id, r.noAnswerCount]))).toEqual({ nw: 0, wt: 1, dn: 1, c5: 5, f4d: 4, f4w: 4, old: 0 });
    expect(db.orderContactAttempt.groupBy).not.toHaveBeenCalled();
    expect(db.orderContactAttempt.findMany).toHaveBeenCalledTimes(1);
  });

  it('the closed-today card reads the counted five too', async () => {
    const d = await desk();
    expect(d.closedToday.find((r) => r.id === 'x1')?.noAnswerCount).toBe(5);
  });

  /**
   * THE PLAN'S CLOSE MUST NOT VANISH FROM THE DESK THE MINUTE SHE PRESSES.
   *
   * The close writes `CANCELLED` + `NO_ANSWER_5_ATTEMPTS` + the note `AUTO_CLOSE_NO_ANSWER_5_ATTEMPTS`, and leaves the order claimed by her. A card query that names the old
   * code alone, or the old note alone, hides it (the note is `…_5_…`). The mock filters for real, so both halves are needed to see it — and the rule of three's close still shows.
   */
  it('the closed-today card finds BOTH closes — the plan’s (five) and the rule of three’s — and neither decoy', async () => {
    const d = await desk();
    expect(d.closedToday.map((r) => r.id).sort()).toEqual(['x1', 'x3']);
    expect(closedWheres).toHaveLength(1);
    const where = closedWheres[0];
    expect(where.confirmationStatus).toBe('CANCELLED');
    const inOf = (v: unknown) => (v as { in: string[] }).in;
    expect([...inOf(where.rejectionReason)].sort()).toEqual(['NO_ANSWER_3_ATTEMPTS', 'NO_ANSWER_5_ATTEMPTS']);
    expect([...inOf(where.statusLogs.some.note)].sort()).toEqual(['AUTO_CLOSE_NO_ANSWER_3_ATTEMPTS', 'AUTO_CLOSE_NO_ANSWER_5_ATTEMPTS']);
    expect(where.statusLogs.some.createdAt.gte).toBeInstanceOf(Date);
  });

  it('with the plan off the same two closes still show — the card does not know which rule wrote the code', async () => {
    cad.on = false;
    const d = await desk();
    expect(d.closedToday.map((r) => r.id).sort()).toEqual(['x1', 'x3']);
  });

  it('the proof shares the read: with the proof on there is still ONE read of the attempts', async () => {
    proof.on = true;
    const d = await desk();
    expect(d.callProofOn).toBe(true);
    expect(db.orderContactAttempt.findMany).toHaveBeenCalledTimes(1);
  });
});

describe('ON — where each card sits and what it says', () => {
  it('a waiting card (counted 1, due ahead) is in «بانتظار» with its due and its words', async () => {
    const d = await desk();
    const r = d.noAnswer.find((x) => x.id === 'wt')!;
    expect(r).toBeDefined();
    expect(r.dueNow).toBe(false);
    expect(r.dueAt).toBe('2026-11-15T10:20:00.000Z');
    expect(r.dueWords).toBe('محاولة 2 من 5 — جاهز الساعة 13:20');
  });

  it('a due card (the due arrived ten minutes ago) is in «اتصلي هلّق», due now, reason ROUND, with the server’s words', async () => {
    const d = await desk();
    const r = d.work.find((x) => x.id === 'dn')!;
    expect(r).toBeDefined();
    expect(r.dueNow).toBe(true);
    expect(r.dueReason).toBe('ROUND');
    expect(r.dueWords).toBe('لا يرد راجع — محاولة 2 من 5');
  });

  it('the moment the due arrives (to the millisecond) the card moves to «اتصلي هلّق»; one millisecond before it waits', async () => {
    vi.setSystemTime(new Date('2026-11-15T10:20:00.000Z').getTime() - 1);
    expect((await desk()).noAnswer.some((r) => r.id === 'wt')).toBe(true);
    vi.setSystemTime(new Date('2026-11-15T10:20:00.000Z').getTime());
    const d = await desk();
    expect(d.work.some((r) => r.id === 'wt')).toBe(true);
    expect(byId(d, 'wt').dueWords).toBe('لا يرد راجع — محاولة 2 من 5');
  });

  it('a NEW order keeps its own words and sits in «اتصلي هلّق»', async () => {
    const d = await desk();
    const r = d.work.find((x) => x.id === 'nw')!;
    expect(r.dueNow).toBe(true);
    expect(r.dueReason).toBe('NEW');
    expect(r.dueWords).toBe('جديد — سحبتيه هلّق');
  });

  it('#5 reads its real due «جاهز الساعة 16:00» on the same day (ruling 16: an hour before Jordan’s 17:00 end); five counted and still open says nothing and stays in «بانتظار»', async () => {
    const d = await desk();
    expect(d.noAnswer.find((x) => x.id === 'f4w')!.dueWords).toBe('محاولة 5 من 5 — جاهز الساعة 16:00');
    const c5 = d.noAnswer.find((x) => x.id === 'c5')!;
    expect(c5).toBeDefined();
    expect(c5.dueNow).toBe(false);
    expect(c5.dueWords).toBeNull();
  });

  it('lines from before the switch went on count nothing: the order lands by its attempt count, with no plan words', async () => {
    const d = await desk();
    const r = byId(d, 'old');
    expect(r.noAnswerCount).toBe(0);
    expect(r.dueWords).toBeNull();
    expect(d.work.some((x) => x.id === 'old')).toBe(true);
  });

  it('`closesOnNext` is true only when a press NOW would close the order (4 counted with the due reached, and 5 counted still open)', async () => {
    const d = await desk();
    expect(byId(d, 'f4d').closesOnNext).toBe(true);
    expect(byId(d, 'c5').closesOnNext).toBe(true);
    expect(byId(d, 'f4w').closesOnNext).toBe(false);
    expect(byId(d, 'wt').closesOnNext).toBe(false);
    expect(byId(d, 'dn').closesOnNext).toBe(false);
    expect(byId(d, 'nw').closesOnNext).toBe(false);
    expect(byId(d, 'old').closesOnNext).toBe(false);
  });

  it('C1 (18/11): every held card carries the one counter’s words for its button — the attempt the next press will be, never past five', async () => {
    const d = await desk();
    expect(byId(d, 'nw').attemptWords).toBe('محاولة 1 من 5');
    expect(byId(d, 'wt').attemptWords).toBe('محاولة 2 من 5');
    expect(byId(d, 'f4d').attemptWords).toBe('محاولة 5 من 5');
    expect(byId(d, 'c5').attemptWords).toBe('محاولة 5 من 5');
    // …and the hint beside it only where a press NOW would close the order (finding #11): the server's fact, never a countdown.
    expect(byId(d, 'f4d').noAnswerHint).toBe('المحاولة القادمة تُغلق الطلب تلقائياً');
    expect(byId(d, 'f4w').noAnswerHint).toBeUndefined();
    expect(byId(d, 'wt').noAnswerHint).toBeUndefined();
  });

  it('on a THURSDAY with Friday and Saturday off: a card whose #3 was Thursday afternoon waits in «بانتظار» for SUNDAY 09:00 (the country’s own start of work) — and that is the very due the door would store for the same lines', async () => {
    extraOrders.push({ id: 'th', attemptCount: 3 });
    // #1 12:30, #2 13:00, #3 15:00 Amman (all inside 09:00-17:00); now is Thursday 17:00.
    plan('th', ['2026-11-19T09:30:00.000Z', '2026-11-19T10:00:00.000Z', '2026-11-19T12:00:00.000Z']);
    vi.setSystemTime(new Date('2026-11-19T14:00:00.000Z'));
    const d = await desk();
    const r = d.noAnswer.find((x) => x.id === 'th')!;
    expect(r).toBeDefined();
    expect(r.noAnswerCount).toBe(3);
    expect(r.dueNow).toBe(false);
    expect(r.dueAt).toBe('2026-11-22T06:00:00.000Z');
    expect(r.dueWords).toBe('محاولة 4 من 5 — جاهز الأحد الساعة 09:00'); // the weekday, not «بكرة»: Friday and Saturday are skipped
    expect(d.work.some((x) => x.id === 'th')).toBe(false);
    // the door asks `cadencePress` with the lines before the press and the press itself, on the calendar `cadenceCalOf` builds — the same function the desk used, fed the same country
    const lines = attempts.filter((a) => a.orderId === 'th');
    const door = cadencePress(lines.slice(0, 2), { at: lines[2].createdAt, result: 'NO_ANSWER' }, cadenceCalOf(ENABLED_AT, COUNTRY));
    expect(door.dueAt?.toISOString()).toBe(r.dueAt);
  });

  it('a #1 pressed after hours waits for the NEXT start of work, not for +30 minutes: Sunday 16:50 → «بكرة الساعة 09:00»; Thursday 16:50 → «الأحد الساعة 09:00» — each the very due the door would store', async () => {
    extraOrders.push({ id: 'sun', attemptCount: 1 }, { id: 'thu', attemptCount: 1 });
    plan('sun', ['2026-11-15T13:50:00.000Z']); // Sunday 16:50 Amman → raw 17:20, after the 17:00 end
    plan('thu', ['2026-11-19T13:50:00.000Z']); // Thursday 16:50 Amman → raw 17:20 → Friday and Saturday are rest days
    for (const [id, now, due, words] of [
      ['sun', '2026-11-15T14:00:00.000Z', '2026-11-16T06:00:00.000Z', 'محاولة 2 من 5 — جاهز بكرة الساعة 09:00'],
      ['thu', '2026-11-19T14:00:00.000Z', '2026-11-22T06:00:00.000Z', 'محاولة 2 من 5 — جاهز الأحد الساعة 09:00'],
    ] as const) {
      vi.setSystemTime(new Date(now));
      const r = byId(await desk(), id);
      expect(r.noAnswerCount).toBe(1);
      expect(r.dueNow).toBe(false);
      expect(r.dueAt).toBe(due);
      expect(r.dueWords).toBe(words);
      const lines = attempts.filter((a) => a.orderId === id);
      expect(cadencePress([], { at: lines[0].createdAt, result: 'NO_ANSWER' }, cadenceCalOf(ENABLED_AT, COUNTRY)).dueAt?.toISOString()).toBe(due);
    }
  });

  it('a #1 pressed ON a rest day, inside the hours (Friday 10:00), waits for SUNDAY 09:00 — the rest day is not work time — and the door stores the same due', async () => {
    extraOrders.push({ id: 'fri', attemptCount: 1 });
    plan('fri', ['2026-11-20T07:00:00.000Z']); // Friday 10:00 Amman
    vi.setSystemTime(new Date('2026-11-20T08:00:00.000Z'));
    const r = byId(await desk(), 'fri');
    expect(r.dueNow).toBe(false);
    expect(r.dueAt).toBe('2026-11-22T06:00:00.000Z');
    expect(r.dueWords).toBe('محاولة 2 من 5 — جاهز الأحد الساعة 09:00');
    expect(cadencePress([], { at: attempts.find((a) => a.orderId === 'fri')!.createdAt, result: 'NO_ANSWER' }, cadenceCalOf(ENABLED_AT, COUNTRY)).dueAt?.toISOString()).toBe(r.dueAt);
  });

  it('the very minute the after-hours due arrives (to the millisecond) the card moves to «اتصلي هلّق»; a millisecond before it waits', async () => {
    extraOrders.push({ id: 'sun', attemptCount: 1 });
    plan('sun', ['2026-11-15T13:50:00.000Z']);
    vi.setSystemTime(new Date('2026-11-16T06:00:00.000Z').getTime() - 1);
    expect((await desk()).noAnswer.some((r) => r.id === 'sun')).toBe(true);
    vi.setSystemTime(new Date('2026-11-16T06:00:00.000Z'));
    const d = await desk();
    expect(d.work.some((r) => r.id === 'sun')).toBe(true);
    expect(byId(d, 'sun').dueWords).toBe('لا يرد راجع — محاولة 2 من 5');
  });

  it('the work tab puts the cards that are due first', async () => {
    const d = await desk();
    const flags = d.work.map((r) => r.dueNow);
    expect(flags.indexOf(false) === -1 || flags.lastIndexOf(true) < flags.indexOf(false)).toBe(true);
    expect(flags.some(Boolean)).toBe(true);
  });
});

describe('ON with «نظام الجولات» ON as well', () => {
  it('the plan wins: no `rounds` key, the rounds’ counting is not used, and the word «جولة» appears nowhere in the response', async () => {
    rsw.value = { enabled: true, enabledAt: new Date('2026-11-01T00:00:00.000Z') };
    const res = await GET(new Request('http://localhost/api/confirmation/mine'));
    const text = await res.text();
    const d = JSON.parse(text) as Desk;
    expect('rounds' in d).toBe(false);
    expect(d.cadenceOn).toBe(true);
    expect(d.noAnswerLimit).toBe(5);
    expect(text).not.toContain('جولة');
    expect(Object.fromEntries(all(d).map((r) => [r.id, r.noAnswerCount]))).toMatchObject({ wt: 1, dn: 1, c5: 5, old: 0 });
  });
});

describe('a colleague’s desk (`?agent=`)', () => {
  it('shows the same limit and the same numbers, and no callProof keys', async () => {
    proof.on = true;
    const d = await desk('http://localhost/api/confirmation/mine?agent=u2');
    expect(d.noAnswerLimit).toBe(5);
    expect(d.cadenceOn).toBe(true);
    expect(Object.fromEntries(all(d).map((r) => [r.id, r.noAnswerCount]))).toMatchObject({ wt: 1, dn: 1, c5: 5 });
    expect('callProofOn' in d).toBe(false);
  });
});

describe('OFF — the desk is today’s', () => {
  it('the switch off: limit 3, groupBy not findMany, no cadenceOn, no closesOnNext, a `due` banner', async () => {
    cad.on = false;
    const d = await desk();
    expect(d.noAnswerLimit).toBe(3);
    expect('cadenceOn' in d).toBe(false);
    expect('due' in d).toBe(true);
    expect(db.orderContactAttempt.groupBy).toHaveBeenCalledTimes(1);
    expect(db.orderContactAttempt.findMany).not.toHaveBeenCalled();
    for (const r of all(d)) expect('closesOnNext' in r).toBe(false);
  });
});
