import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * REQUEST C2b (18/11): «طلباتي» READS THE DUE THE DOOR STORED, AS THE DOOR AND THE POOL DO.
 *
 * C2 kept HISTORY'S VERDICTS: the fold (`cadenceFold`) uses the due a counted line STORED (`OrderContactAttempt.nextFollowUpAt`) and computes the new anchors only
 * for a line without one. The door and the pool select the column; the desk's attempts read did not, so for an order whose #3 was pressed before C2 (its #4 stored
 * at the old 09:00, the start of work) the card recomputed 11:00 — it printed «جاهز الساعة 11:00» while the pool brought the order back at 09:00, and a #4 pressed
 * at 09:30 counted at the door but not on the card (one lower). The mine route now selects the column.
 *
 *   · a card whose #4 was stored at 09:00 prints 09:00, and is due from 09:00 — the stored time, not the anchor;
 *   · its count equals the door's (`cadencePress`, fed the same lines with their stored dues, line after line);
 *   · a line with no stored due (old history, null) falls back to the computed due, as on main;
 *   · a colleague's desk (`?agent=`) reads the same;
 *   · DIFFERENTIAL on random desks: the answer with the column equals the answer without it (= the select on main) everywhere except the cards that carry an
 *     old-anchor stored due — and on those only the due fields move. Plan OFF (rounds on or off): byte-identical.
 *
 * The attempts mock PROJECTS the route's `select` (a column the route does not select does not reach it), so the select is what is under test.
 * ═══════════════════════════════════════════════════════════════════════
 */

const ENABLED_AT = new Date('2026-11-01T00:00:00.000Z');

type Line = { orderId: string; createdAt: Date; result: string; employeeId: string; attemptNumber: number; nextFollowUpAt: Date | null };

const { db, cad, rsw, lines, orders, strip, COUNTRY } = vi.hoisted(() => {
  const cad = { on: true };
  const rsw = { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } };
  const lines: Line[] = [];
  const orders: string[] = [];
  /** Drop the stored due from every line the route reads — the answer of the select on main, for the differential. */
  const strip = { on: false };
  const row = (id: string) => ({
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
    _count: { contactAttempts: lines.filter((l) => l.orderId === id).length, notes: 0 },
  });
  const project = (rec: Record<string, unknown>, select: Record<string, unknown> | undefined) =>
    select ? Object.fromEntries(Object.keys(select).filter((k) => select[k] === true).map((k) => [k, rec[k]])) : { ...rec };
  const db = {
    order: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.rejectionReason) return [];
        if (!('OR' in where)) return [];
        return orders.map(row);
      }),
      count: vi.fn(async () => 0),
    },
    orderContactAttempt: {
      groupBy: vi.fn(async () => {
        const by = new Map<string, number>();
        for (const l of lines) by.set(l.orderId, (by.get(l.orderId) ?? 0) + 1);
        return [...by].map(([orderId, n]) => ({ orderId, _count: { _all: n } }));
      }),
      findMany: vi.fn(async ({ where, select }: { where: { orderId?: { in?: string[] } }; select?: Record<string, unknown> }) => {
        const ids = where?.orderId?.in;
        return lines
          .filter((l) => !ids || ids.includes(l.orderId))
          .map((l) => {
            const out = project(l as unknown as Record<string, unknown>, select);
            if (strip.on) delete out.nextFollowUpAt;
            return out;
          });
      }),
    },
    company: { findUnique: vi.fn(async () => ({ settings: '{}' })) },
    callHelperDevice: { findFirst: vi.fn(async () => null) },
  };
  const COUNTRY = { id: 'co1', code: 'JO', timezone: 'Asia/Amman', workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6] };
  return { db, cad, rsw, lines, orders, strip, COUNTRY };
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
vi.mock('@/lib/authorization', () => ({ requirePermission: async () => undefined, can: (_u: unknown, k: string) => k === 'confirmation.work' }));
vi.mock('@/lib/desk-watch', () => ({ DESK_NOT_FOUND: 'x', DESK_WATCH_REFUSAL: 'x', mayWatchDesks: () => true, watchedAgent: async () => ({ id: 'u2', name: 'Lina' }) }));
vi.mock('@/lib/insights-key', () => ({ mayReadInsights: () => false }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: async () => undefined }));
vi.mock('@/lib/response-clock', () => ({ firstActionTimes: async () => new Map() }));
vi.mock('@/lib/no-answer-rounds-switch', () => ({ roundsSwitch: async () => rsw.value }));
vi.mock('@/lib/no-answer-returns-switch', () => ({ returnsSwitch: async () => ({ enabled: false, enabledAt: null }) }));
vi.mock('@/lib/call-proof-switch', () => ({
  callProofOn: async () => false,
  callProofSwitch: async () => (cad.on ? { enabled: true, enabledAt: ENABLED_AT } : { enabled: false, enabledAt: null }),
}));

import { GET } from './route';
import { cadenceCalOf, cadencePress, cadenceState } from '@/lib/no-answer-cadence';

type Row = { id: string; noAnswerCount: number; dueNow: boolean; dueReason: string | null; dueAt: string | null; dueWords: string | null; closesOnNext?: boolean } & Record<string, unknown>;
type Desk = { work: Row[]; noAnswer: Row[]; closedToday: Row[] } & Record<string, unknown>;
const desk = async (url = 'http://localhost/api/confirmation/mine') => (await GET(new Request(url))).json() as Promise<Desk>;
const all = (d: Desk) => [...d.work, ...d.noAnswer];
const byId = (d: Desk, id: string) => all(d).find((r) => r.id === id)!;

const CAL = cadenceCalOf(ENABLED_AT, COUNTRY);
const iso = (s: string) => new Date(s);
const HOUR = 3_600_000;

/**
 * Press the lines as the door does: each press is decided on the lines before it, WITH their stored dues, and the line stores the door's `dueAt`.
 * `override(n, due)` may replace the due stored by the press that made `n` counted — how a press written before C2 (old anchors) looks.
 */
function press(orderId: string, times: string[] | Date[], override?: (counted: number, due: Date) => Date | null | undefined): Line[] {
  const out: Line[] = [];
  times.forEach((t, i) => {
    const at = t instanceof Date ? t : iso(t);
    const door = cadencePress(out, { at, result: 'NO_ANSWER' }, CAL);
    let due = door.dueAt;
    if (door.counted && due && override) {
      const o = override(door.next.counted.length, due);
      if (o !== undefined) due = o;
    }
    out.push({ orderId, createdAt: at, result: 'NO_ANSWER', employeeId: 'u1', attemptNumber: i + 1, nextFollowUpAt: due });
  });
  lines.push(...out);
  orders.push(orderId);
  return out;
}

/** The old anchor of #4: the start of work (09:00 Amman) on the day the new anchor (11:00) names. */
const oldMorning = (counted: number, due: Date) => (counted === 3 ? new Date(due.getTime() - 2 * HOUR) : undefined);

// Sunday 8/11, Amman: #1 10:00, #2 10:30, #3 12:30 → #4 is due Monday 9/11 at 11:00 (08:00Z) under C2's anchor, 09:00 (06:00Z) when pressed before C2.
const RUN3 = ['2026-11-08T07:00:00.000Z', '2026-11-08T07:30:00.000Z', '2026-11-08T09:30:00.000Z'];

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  cad.on = true;
  rsw.value = { enabled: false, enabledAt: null };
  strip.on = false;
  lines.length = 0;
  orders.length = 0;
});

describe('the fixture is what it claims', () => {
  it('C2’s door stores #4 at 11:00 (08:00Z); the old anchor stored 09:00 (06:00Z)', () => {
    const fresh = press('chk-new', RUN3);
    const old = press('chk-old', RUN3, oldMorning);
    expect(fresh[2].nextFollowUpAt?.toISOString()).toBe('2026-11-09T08:00:00.000Z');
    expect(old[2].nextFollowUpAt?.toISOString()).toBe('2026-11-09T06:00:00.000Z');
  });
});

describe('a card whose #4 was stored at 09:00', () => {
  it('before 09:00 it waits for 09:00 and SAYS 09:00 — the stored time, not the anchor; a C2 line and a line with no stored due say 11:00', async () => {
    vi.setSystemTime(iso('2026-11-09T05:30:00.000Z')); // Monday 08:30 Amman
    press('old3', RUN3, oldMorning);
    press('new3', RUN3);
    press('none3', RUN3, () => null); // old history with no stored due at all
    lines.filter((l) => l.orderId === 'none3').forEach((l) => (l.nextFollowUpAt = null));
    const d = await desk();
    const old = d.noAnswer.find((r) => r.id === 'old3')!;
    expect(old.dueAt).toBe('2026-11-09T06:00:00.000Z');
    expect(old.dueWords).toBe('محاولة 4 من 5 — جاهز الساعة 09:00');
    expect(byId(d, 'new3').dueWords).toBe('محاولة 4 من 5 — جاهز الساعة 11:00');
    expect(byId(d, 'none3').dueAt).toBe('2026-11-09T08:00:00.000Z');
    expect(byId(d, 'none3').dueWords).toBe('محاولة 4 من 5 — جاهز الساعة 11:00');
  });

  it('at 09:45 it is DUE (in «اتصلي هلّق»), as the pool brings it back — the anchor would say «wait till 11:00»', async () => {
    vi.setSystemTime(iso('2026-11-09T06:45:00.000Z'));
    press('old3', RUN3, oldMorning);
    press('new3', RUN3);
    const d = await desk();
    const old = d.work.find((r) => r.id === 'old3')!;
    expect(old).toBeDefined();
    expect(old.dueNow).toBe(true);
    expect(old.dueReason).toBe('ROUND');
    expect(d.noAnswer.some((r) => r.id === 'new3')).toBe(true);
  });

  it('a #4 pressed at 09:30 counted at the door — the card counts it too (4, not 3), and its #5 words are the door’s', async () => {
    vi.setSystemTime(iso('2026-11-09T07:00:00.000Z')); // Monday 10:00
    const run = press('old4', [...RUN3, '2026-11-09T06:30:00.000Z'], oldMorning);
    // The door's own decision on the press, line after line with the stored dues.
    const door = cadencePress(run.slice(0, 3), { at: run[3].createdAt, result: 'NO_ANSWER' }, CAL);
    expect(door.counted).toBe(true);
    const doorCount = cadenceState(run, CAL).counted.length;
    expect(doorCount).toBe(4);
    const d = await desk();
    const r = byId(d, 'old4');
    expect(r.noAnswerCount).toBe(doorCount);
    expect(r.dueWords).toBe('محاولة 5 من 5 — جاهز الساعة 16:00');
    expect(r.closesOnNext).toBe(cadencePress(run, { at: new Date(), result: 'NO_ANSWER' }, CAL).closes);
  });

  it('a colleague’s desk (`?agent=`) reads the same stored due', async () => {
    vi.setSystemTime(iso('2026-11-09T05:30:00.000Z'));
    press('old3', RUN3, oldMorning);
    const d = await desk('http://localhost/api/confirmation/mine?agent=u2');
    expect(byId(d, 'old3').dueWords).toBe('محاولة 4 من 5 — جاهز الساعة 09:00');
  });

  it('the select reads one column more and the same lines: ONE attempts read, the column named', async () => {
    vi.setSystemTime(iso('2026-11-09T05:30:00.000Z'));
    press('old3', RUN3, oldMorning);
    await desk();
    expect(db.orderContactAttempt.findMany).toHaveBeenCalledTimes(1);
    const arg = db.orderContactAttempt.findMany.mock.calls[0][0] as { select: Record<string, unknown>; where: Record<string, unknown> };
    expect(arg.select).toEqual({ orderId: true, createdAt: true, result: true, employeeId: true, attemptNumber: true, nextFollowUpAt: true });
    // H2's floor still holds: lines after the plan's start only (plus per-order spans) — a filter on rows, untouched.
    expect(JSON.stringify(arg.where)).toContain(ENABLED_AT.toISOString());
  });
});

// ─────────────────────────────── the differential ───────────────────────────────

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GAPS_MIN = [5, 20, 35, 60, 150, 200, 9 * 60, 20 * 60, 26 * 60, 50 * 60];

/** A random desk of `n` held orders; returns the ids whose history carries an old-anchor stored due. */
function randomDesk(seed: number, n: number, now: Date): Set<string> {
  const rnd = mulberry32(seed);
  const changed = new Set<string>();
  for (let i = 0; i < n; i++) {
    const id = `r${seed}-${i}`;
    const old = rnd() < 0.5;
    let t = Date.UTC(2026, 10, 2 + Math.floor(rnd() * 12), 6 + Math.floor(rnd() * 8), Math.floor(rnd() * 60));
    const times: Date[] = [];
    const k = Math.floor(rnd() * 7);
    for (let j = 0; j < k && t < now.getTime(); j++) {
      times.push(new Date(t));
      t += GAPS_MIN[Math.floor(rnd() * GAPS_MIN.length)] * 60_000;
    }
    press(id, times, old ? (c, due) => {
      const o = oldMorning(c, due);
      if (o) changed.add(id);
      return o;
    } : undefined);
  }
  return changed;
}

const DUE_FIELDS = new Set(['noAnswerCount', 'dueNow', 'dueReason', 'dueAt', 'dueWords', 'closesOnNext', 'attemptWords', 'noAnswerHint', 'waiting']);

function withoutIds(d: Desk, ids: Set<string>) {
  const keep = (rows: Row[]) => rows.filter((r) => !ids.has(r.id));
  return { ...d, work: keep(d.work), noAnswer: keep(d.noAnswer), closedToday: keep(d.closedToday) };
}

describe('DIFFERENTIAL — the answer with the column vs without it (the select on main)', () => {
  const NOWS = ['2026-11-15T10:00:00.000Z', '2026-11-16T05:30:00.000Z', '2026-11-16T06:30:00.000Z', '2026-11-16T14:00:00.000Z'];

  it('plan ON: identical except the cards with an old-anchor stored due, and on those only the due fields move', async () => {
    let differed = 0;
    for (let seed = 1; seed <= 24; seed++) {
      const now = iso(NOWS[seed % NOWS.length]);
      vi.setSystemTime(now);
      lines.length = 0;
      orders.length = 0;
      const changed = randomDesk(seed, 12, now);
      strip.on = false;
      const withCol = await desk();
      strip.on = true;
      const onMain = await desk();
      strip.on = false;
      expect(withoutIds(withCol, changed), `seed ${seed}`).toEqual(withoutIds(onMain, changed));
      for (const id of changed) {
        const a = all(withCol).find((r) => r.id === id);
        const b = all(onMain).find((r) => r.id === id);
        expect(!!a, `seed ${seed} ${id} on the desk in both`).toBe(!!b);
        if (!a || !b) continue;
        const moved = Object.keys({ ...a, ...b }).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
        if (moved.length) differed += 1;
        expect(moved.filter((k) => !DUE_FIELDS.has(k)), `seed ${seed} ${id}`).toEqual([]);
      }
    }
    // The differential is not vacuous: some old-anchor cards really read differently.
    expect(differed).toBeGreaterThan(0);
  });

  it('plan OFF (rounds off, then on): byte-identical whatever the lines stored', async () => {
    cad.on = false;
    for (const roundsOn of [false, true]) {
      rsw.value = roundsOn ? { enabled: true, enabledAt: ENABLED_AT } : { enabled: false, enabledAt: null };
      for (let seed = 101; seed <= 112; seed++) {
        const now = iso(NOWS[seed % NOWS.length]);
        vi.setSystemTime(now);
        lines.length = 0;
        orders.length = 0;
        randomDesk(seed, 10, now);
        strip.on = false;
        const withCol = JSON.stringify(await desk());
        strip.on = true;
        const onMain = JSON.stringify(await desk());
        strip.on = false;
        expect(withCol, `seed ${seed} rounds ${roundsOn}`).toBe(onMain);
      }
    }
  });
});
