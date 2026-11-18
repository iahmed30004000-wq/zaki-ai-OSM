import { readFileSync, writeFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «طلباتي» READS ONLY THE ATTEMPT LINES ITS CARDS PRINT (H2, cause 10 of the hang — 18/11).
 *
 * Under «جدول المحاولات» the desk read EVERY line of up to 550 orders, though the plan counts only lines logged strictly after it went on
 * (`enabledAt`, `cadenceStep`). Now the one read asks for those, plus the two things a card still needs from before the floor:
 *
 *   · «إثبات المكالمات» (her own desk): the lines since she took the order (`claimedAt` — her «اتصل» press is only hers from then on), for an
 *     order she took before the switch went on (or with no `claimedAt`, all of them);
 *   · the customer's promise (`promiseArrived`): for an order whose asked date is before the floor, the lines from that date on.
 *
 * Off, the read is today's. The orders she HOLDS are not touched (the 5/11 rule: every order in her hands reaches her desk — 500 held, 500 shown).
 *
 * THE ANSWER IS THE SAME. `the-desk-reads-only-the-lines-it-prints.golden.json` was written by THIS test against osm/main's route (`WRITE_GOLDEN=1`,
 * before the change) on the in-memory database below — a real filter over each `where` — for: the plan on with lines before and after the floor,
 * an old «اتصل» press, a promise from before the floor, a colleague's desk, the rounds stored ON under the plan, the plan off (rounds off and on),
 * and a desk of 500 held orders.
 * ═══════════════════════════════════════════════════════════════════════
 */

// ───────────── a tiny in-memory reading of a Prisma `where` (only what these reads send) ─────────────
type Rec = Record<string, unknown>;
const isPlain = (v: unknown): v is Rec => !!v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v);
const val = (v: unknown) => (v instanceof Date ? v.getTime() : v);
function opMatch(actual: unknown, cond: unknown): boolean {
  if (!isPlain(cond)) return cond === null ? actual == null : val(actual) === val(cond);
  return Object.entries(cond).every(([op, c]) => {
    const a = val(actual);
    const b = val(c);
    switch (op) {
      case 'in': return (c as unknown[]).map(val).includes(a);
      case 'notIn': return !(c as unknown[]).map(val).includes(a);
      case 'equals': return a === b;
      case 'gte': return a != null && (a as number) >= (b as number);
      case 'gt': return a != null && (a as number) > (b as number);
      case 'lte': return a != null && (a as number) <= (b as number);
      case 'lt': return a != null && (a as number) < (b as number);
      case 'not': return !opMatch(actual, c);
      case 'mode': return true;
      default: throw new Error(`the fake does not read «${op}»`);
    }
  });
}
function matches(rec: Rec, where: Rec | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    if (cond === undefined) return true;
    if (k === 'AND') return (Array.isArray(cond) ? cond : [cond]).every((w) => matches(rec, w as Rec));
    if (k === 'OR') return (cond as Rec[]).some((w) => matches(rec, w));
    if (k === 'NOT') return !(Array.isArray(cond) ? cond : [cond]).some((w) => matches(rec, w as Rec));
    return opMatch(rec[k], cond);
  });
}
const project = (rec: Rec, select: Rec | undefined) => (select ? Object.fromEntries(Object.keys(select).filter((k) => select[k] === true).map((k) => [k, rec[k]])) : { ...rec });
// ─────────────────────────────────────────────────────────────────────────

const NOW = new Date('2026-11-15T10:00:00.000Z').getTime(); // Sunday 13:00 in Amman
const ENABLED_AT = new Date('2026-11-10T00:00:00.000Z');


const { db, state, COUNTRY } = vi.hoisted(() => {
  const state = {
    cadence: true,
    proof: false,
    rounds: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null },
    held: [] as Record<string, unknown>[],
    closed: [] as Record<string, unknown>[],
    lines: [] as Array<{ orderId: string; createdAt: Date; result: string; employeeId: string; attemptNumber: number }>,
    /** Every attempt row any read handed back, as read. */
    linesRead: [] as Array<{ orderId: string; createdAt: Date }>,
  };
  const db = {
    order: {
      findMany: vi.fn(async ({ where, take }: { where: Record<string, unknown>; take?: number }) => {
        if (where.rejectionReason) return state.closed;
        // the held read honours its `take`: a cut page shows up as cards missing from her desk
        if ('OR' in where) return state.held.slice(0, take ?? Infinity);
        return [];
      }),
      count: vi.fn(async () => 0),
    },
    orderContactAttempt: {
      groupBy: vi.fn(),
      findMany: vi.fn(),
    },
    company: { findUnique: vi.fn(async () => ({ settings: '{}' })) },
    callHelperDevice: { findFirst: vi.fn(async () => null) },
  };
  const COUNTRY = { id: 'co1', code: 'JO', timezone: 'Asia/Amman', workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6] };
  return { db, state, COUNTRY };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({
    user: { id: 'u1', name: 'الموظفة', role: 'CONFIRMATION_AGENT', companyId: 'c1', status: 'ACTIVE', permissions: [] },
    companyId: 'c1',
    storeId: 's1',
    countryId: 'co1',
    country: COUNTRY,
  }),
}));
vi.mock('@/lib/authorization', () => ({ requirePermission: async () => undefined, can: (_u: unknown, k: string) => k === 'confirmation.work' }));
vi.mock('@/lib/desk-watch', () => ({ DESK_NOT_FOUND: 'x', DESK_WATCH_REFUSAL: 'x', mayWatchDesks: () => true, watchedAgent: async () => ({ id: 'u2', name: 'زميلة' }) }));
vi.mock('@/lib/insights-key', () => ({ mayReadInsights: () => false }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: async () => undefined }));
vi.mock('@/lib/response-clock', () => ({ firstActionTimes: async () => new Map() }));
vi.mock('@/lib/no-answer-rounds-switch', () => ({ roundsSwitch: async () => state.rounds }));
vi.mock('@/lib/no-answer-returns-switch', () => ({ returnsSwitch: async () => ({ enabled: false, enabledAt: null }) }));
vi.mock('@/lib/call-proof-switch', () => ({
  callProofOn: async () => state.proof,
  callProofSwitch: async () => (state.cadence ? { enabled: true, enabledAt: ENABLED_AT } : { enabled: false, enabledAt: null }),
}));
const { cadenceDeskCalls } = vi.hoisted(() => ({ cadenceDeskCalls: { n: 0 } }));
vi.mock('@/lib/no-answer-cadence', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/no-answer-cadence')>();
  return { ...real, cadenceDesk: (...a: Parameters<typeof real.cadenceDesk>) => (cadenceDeskCalls.n++, real.cadenceDesk(...a)) };
});

import { GET } from './route';

db.orderContactAttempt.findMany.mockImplementation(async ({ where, select }: { where: Rec; select?: Rec }) => {
  const rows = state.lines.filter((l) => matches(l as unknown as Rec, where));
  state.linesRead.push(...rows.map((r) => ({ orderId: r.orderId, createdAt: r.createdAt })));
  return rows.map((r) => project(r as unknown as Rec, select));
});
db.orderContactAttempt.groupBy.mockImplementation(async ({ where }: { where: Rec }) => {
  const counts = new Map<string, number>();
  for (const l of state.lines) if (matches(l as unknown as Rec, where)) counts.set(l.orderId, (counts.get(l.orderId) ?? 0) + 1);
  return [...counts].map(([orderId, n]) => ({ orderId, _count: { _all: n } }));
});

const at = (s: string) => new Date(s);
function card(id: string, o: { claimedAt?: Date | null; nextFollowUpAt?: Date | null; postponedUntil?: Date | null; status?: string } = {}) {
  return {
    id,
    orderNumber: `JO-${id}`,
    confirmationStatus: o.status ?? 'IN_PROGRESS',
    shippingStatus: 'NOT_READY',
    totalAmount: 10,
    currency: 'JOD',
    claimedAt: o.claimedAt === undefined ? at('2026-11-12T08:00:00.000Z') : o.claimedAt,
    nextFollowUpAt: o.nextFollowUpAt ?? null,
    postponedUntil: o.postponedUntil ?? null,
    customer: { id: `c-${id}`, fullName: 'زبون', phone: '0790000000', rawPhone: '0790000000', totalOrders: 1 },
    items: [],
    addOns: [],
    _count: { contactAttempts: 0, notes: 0 },
  };
}
function line(orderId: string, when: string, result = 'NO_ANSWER', employeeId = 'u1') {
  state.lines.push({ orderId, createdAt: at(when), result, employeeId, attemptNumber: state.lines.filter((l) => l.orderId === orderId).length + 1 });
}
/** Each card's `_count.contactAttempts` is its real number of lines — what the database's `_count` says. */
function settle() {
  for (const c of [...state.held, ...state.closed]) (c._count as { contactAttempts: number }).contactAttempts = state.lines.filter((l) => l.orderId === c.id).length;
}

/** The desk the scenarios share: the plan's own cards, an old press, two promises from before the floor, a never-rung order, a closed card. */
function theDesk() {
  state.held = [
    card('before-and-after'),
    card('old-press', { claimedAt: at('2026-11-08T07:00:00.000Z') }),
    card('old-press-answered', { claimedAt: at('2026-11-08T07:00:00.000Z') }),
    card('no-claim-old-press', { claimedAt: null }),
    card('promise-kept-before-floor', { nextFollowUpAt: at('2026-11-05T09:00:00.000Z') }),
    card('promise-broken-before-floor', { postponedUntil: at('2026-11-06T09:00:00.000Z') }),
    card('promise-after-floor', { nextFollowUpAt: at('2026-11-14T09:00:00.000Z') }),
    card('never-rung'),
    card('waiting'),
  ];
  state.closed = [{ ...card('closed-today', { status: 'CANCELLED' }) }];
  // lines before the floor count nothing, after it they do
  line('before-and-after', '2026-11-03T08:00:00.000Z');
  line('before-and-after', '2026-11-04T08:00:00.000Z');
  line('before-and-after', '2026-11-12T08:30:00.000Z');
  line('before-and-after', '2026-11-12T09:30:00.000Z');
  // her «اتصل» press from before the floor (after she took it), nothing after it: the proof is READY on it
  line('old-press', '2026-11-08T07:30:00.000Z', 'NO_ANSWER');
  line('old-press', '2026-11-09T08:00:00.000Z', 'OPENED');
  // the same, but the press was answered: NO_OPENED
  line('old-press-answered', '2026-11-08T08:00:00.000Z', 'OPENED');
  line('old-press-answered', '2026-11-08T08:05:00.000Z', 'ANSWERED');
  line('old-press-answered', '2026-11-12T08:05:00.000Z', 'NO_ANSWER');
  // no claim time: every press of hers counts for the proof
  line('no-claim-old-press', '2026-10-01T08:00:00.000Z', 'OPENED');
  // promise date before the floor, a line logged after the date (still before the floor): kept — no PROMISE tag
  line('promise-kept-before-floor', '2026-11-04T08:00:00.000Z', 'NO_ANSWER');
  line('promise-kept-before-floor', '2026-11-07T08:00:00.000Z', 'ANSWERED');
  // promise date before the floor, nothing logged since: PROMISE
  line('promise-broken-before-floor', '2026-11-02T08:00:00.000Z', 'NO_ANSWER');
  line('promise-after-floor', '2026-11-12T08:00:00.000Z', 'NO_ANSWER');
  line('waiting', '2026-11-15T09:50:00.000Z');
  line('closed-today', '2026-11-01T08:00:00.000Z');
  line('closed-today', '2026-11-11T08:00:00.000Z');
  line('closed-today', '2026-11-11T08:40:00.000Z');
  // a colleague's lines on her orders count for the plan as well
  line('waiting', '2026-11-13T09:00:00.000Z', 'BUSY', 'u2');
  settle();
}

const SCENARIOS: Record<string, { cadence: boolean; proof: boolean; rounds: boolean; url?: string; big?: boolean }> = {
  'plan-on-proof-on': { cadence: true, proof: true, rounds: false },
  'plan-on-proof-off': { cadence: true, proof: false, rounds: false },
  'plan-on-colleague-desk': { cadence: true, proof: false, rounds: false, url: '?agent=u2' },
  'plan-on-rounds-stored-on': { cadence: true, proof: true, rounds: true },
  'plan-off-rounds-off': { cadence: false, proof: false, rounds: false },
  'plan-off-rounds-on': { cadence: false, proof: false, rounds: true },
  'plan-on-500-held': { cadence: true, proof: true, rounds: false, big: true },
};

function arrange(name: string) {
  const s = SCENARIOS[name];
  state.cadence = s.cadence;
  state.proof = s.proof;
  state.rounds = s.rounds ? { enabled: true, enabledAt: at('2026-11-01T00:00:00.000Z') } : { enabled: false, enabledAt: null };
  state.lines.length = 0;
  state.linesRead.length = 0;
  theDesk();
  if (s.big) {
    for (let k = 0; k < 491; k++) {
      state.held.push(card(`h${k}`, { claimedAt: at('2026-11-14T08:00:00.000Z') }));
      if (k % 3 === 0) line(`h${k}`, '2026-11-09T08:00:00.000Z');
      if (k % 2 === 0) line(`h${k}`, '2026-11-14T09:00:00.000Z');
    }
    settle();
  }
}
const desk = async (name: string) => (await GET(new Request(`http://localhost/api/confirmation/mine${SCENARIOS[name].url ?? ''}`))).json() as Promise<Rec>;

const GOLDEN = 'src/app/api/confirmation/mine/the-desk-reads-only-the-lines-it-prints.golden.json';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  cadenceDeskCalls.n = 0;
  db.orderContactAttempt.findMany.mockClear();
  db.orderContactAttempt.groupBy.mockClear();
});

describe('the desk answers exactly what osm/main answered', () => {
  it('every scenario, key for key (golden)', async () => {
    const out: Record<string, unknown> = {};
    // The 500-order desk is held in the golden by what each card SAYS (its tab, number, due, words and proof) — the rest of a card is the order row
    // itself, the same 500 times — so the file stays small.
    const said = (r: Rec) => [r.id, r.noAnswerCount, r.dueNow, r.dueReason, r.dueAt, r.dueWords, r.callProof, r.attemptWords, r.noAnswerHint, r.closesOnNext];
    for (const name of Object.keys(SCENARIOS)) {
      arrange(name);
      const d = await desk(name);
      if (!SCENARIOS[name].big) out[name] = d;
      else {
        const { work, noAnswer, closedToday, confirmed, serverNow, ...rest } = d as { work: Rec[]; noAnswer: Rec[]; closedToday: Rec[]; confirmed: unknown; serverNow: string };
        out[name] = { ...rest, serverNow, confirmed, closedToday, work: work.map(said), noAnswer: noAnswer.map(said) };
      }
    }
    if (process.env.WRITE_GOLDEN === '1') writeFileSync(GOLDEN, `${JSON.stringify(out)}\n`);
    expect(JSON.parse(JSON.stringify(out))).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
  });

  it('the golden is the world it says: the old press is READY, the answered one NO_OPENED, the broken promise is due PROMISE, the kept one is not', async () => {
    arrange('plan-on-proof-on');
    const d = (await desk('plan-on-proof-on')) as { work: Rec[]; noAnswer: Rec[] };
    const row = (id: string) => [...d.work, ...d.noAnswer].find((r) => r.id === id)!;
    expect(row('old-press').callProof).toEqual({ state: 'READY', unlocksAtMs: null });
    expect(row('old-press-answered').callProof).toEqual({ state: 'NO_OPENED', unlocksAtMs: null });
    expect(row('no-claim-old-press').callProof).toEqual({ state: 'READY', unlocksAtMs: null });
    expect(row('promise-broken-before-floor').dueReason).toBe('PROMISE');
    expect(row('promise-kept-before-floor').dueReason).not.toBe('PROMISE');
    expect(row('before-and-after').noAnswerCount).toBe(2);
  });

  it('500 held orders: all 500 on her desk', async () => {
    arrange('plan-on-500-held');
    const d = (await desk('plan-on-500-held')) as { work: Rec[]; noAnswer: Rec[] };
    expect(state.held).toHaveLength(500);
    expect(d.work.length + d.noAnswer.length).toBe(500);
  });
});

describe('…reading fewer lines', () => {
  const floor = ENABLED_AT.getTime();
  const old = () => state.linesRead.filter((l) => l.createdAt.getTime() <= floor);

  it('the plan on, no proof: the only lines from before the floor it reads are the promises\' (from their date on)', async () => {
    arrange('plan-on-proof-off');
    await desk('plan-on-proof-off');
    expect(old().map((l) => `${l.orderId}@${l.createdAt.toISOString()}`).sort()).toEqual(['promise-kept-before-floor@2026-11-07T08:00:00.000Z']);
  });

  it('the plan on, a desk with no promise and no old claim: not ONE line from before the floor is read', async () => {
    arrange('plan-on-proof-on');
    state.held = state.held.filter((c) => ['before-and-after', 'never-rung', 'waiting'].includes(c.id as string));
    await desk('plan-on-proof-on');
    expect(old()).toEqual([]);
    expect(state.linesRead.length).toBeGreaterThan(0);
  });

  it('the plan on, the proof on: an order she took before the floor brings its lines since she took it — never older', async () => {
    arrange('plan-on-proof-on');
    await desk('plan-on-proof-on');
    const byOrder = (id: string) => old().filter((l) => l.orderId === id).map((l) => l.createdAt.toISOString()).sort();
    expect(byOrder('before-and-after')).toEqual([]);
    expect(byOrder('old-press')).toEqual(['2026-11-08T07:30:00.000Z', '2026-11-09T08:00:00.000Z']);
    expect(byOrder('closed-today')).toEqual([]);
    expect(byOrder('promise-broken-before-floor')).toEqual([]);
  });

  it('the plan on: still ONE read of the attempts for the whole desk, and each card\'s plan computed once', async () => {
    arrange('plan-on-proof-on');
    await desk('plan-on-proof-on');
    expect(db.orderContactAttempt.findMany).toHaveBeenCalledTimes(1);
    expect(cadenceDeskCalls.n).toBe(state.held.length + state.closed.length);
  });

  it('the plan off: the read is today\'s (every line of the shown orders, or the grouped count)', async () => {
    arrange('plan-off-rounds-on');
    await desk('plan-off-rounds-on');
    expect(state.linesRead).toHaveLength(state.lines.length);
    arrange('plan-off-rounds-off');
    await desk('plan-off-rounds-off');
    expect(db.orderContactAttempt.groupBy).toHaveBeenCalled();
  });
});
