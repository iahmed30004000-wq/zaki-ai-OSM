import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './guard-source';
import {
  DAY_IN_FUTURE_AR,
  DAY_INVALID_AR,
  IDLE_RETURN_REASONS,
  NO_ANSWER_RETURN_REASONS,
  REFUSAL_LABEL_AR,
  emptyCounters,
  readFiredRows,
  refusalLabel,
  resolveFiredDay,
  tallyFired,
  type FiredRows,
} from './rule-fired';
import { DESK_REFUSAL_CODES } from './desk-refusals';
import { dayRange } from './eod-report';
import { NO_ANSWER_CLOSE } from './confirmation-workflow';
import { PULL_REASON } from './held-flow';
import { DATE_RETURNED_REASON } from './no-answer-returns';
import { DUE_RELEASE_REASON } from './no-answer-rounds';
import { MANAGER_RETURNED_REASON } from './auto-release';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE (Q2b, 19/11) — «القاعدة اشتغلت عندها كم مرة», the counters of one store's day.
 *
 *  1. The tally: each counter from rows — one that counts, and the neighbour that must not (a manual claim is not a pull, a date
 *     she saved is not an idle return, an early «لا يرد» under the plan is not counted, the press that closed is counted).
 *  2. The reads: every counter's positive row, and three that must not count — another store, the same instant on the other side
 *     of the store's midnight (Damascus, UTC+3: 21:30 UTC is already tomorrow), and a superseded order (for «decided»).
 *  3. A refusal log that cannot be read (the table rolled back) answers null, never an error.
 *  4. The day: the store's day, never the UTC day; a day still to come and a malformed day are refused in Arabic.
 * ═══════════════════════════════════════════════════════════════════════
 */

const TZ = 'Asia/Damascus';
const at = (iso: string) => new Date(iso);

const rows = (over: Partial<FiredRows> = {}): FiredRows => ({
  claims: [],
  noAnswers: [],
  closes: [],
  decisions: [],
  proofRefusals: [],
  refusals: [],
  truncated: false,
  ...over,
});

describe('the tally', () => {
  it('a pull is a CLAIMED line with the pull’s reason — NEGATIVE: a claim by number is not a pull', () => {
    const t = tallyFired(rows({ claims: [{ userId: 'sara', action: 'CLAIMED', reason: PULL_REASON }, { userId: 'sara', action: 'CLAIMED', reason: 'MANUAL_ENTRY' }] }), null);
    expect(t.get('sara')!.pulls).toBe(1);
  });

  it('idle returns: the ninety minutes, the idle return and an untouched re-pull — NEGATIVE: a date she saved, a date passed, a manager’s return', () => {
    const claims = [
      ...IDLE_RETURN_REASONS.map((reason) => ({ userId: 'sara', action: 'RELEASED', reason })),
      { userId: 'sara', action: 'RELEASED', reason: DATE_RETURNED_REASON },
      { userId: 'sara', action: 'RELEASED', reason: DUE_RELEASE_REASON },
      { userId: 'sara', action: 'RELEASED', reason: MANAGER_RETURNED_REASON },
    ];
    const c = tallyFired(rows({ claims }), null).get('sara')!;
    expect(c.idleReturns).toBe(3);
    expect(c.noAnswerReturns).toBe(0);
  });

  it('no-answer returns: her «لا يرد» under «يرجع فوراً» and a round nobody answered — NEGATIVE: a CLAIMED line with that reason', () => {
    const claims = [
      ...NO_ANSWER_RETURN_REASONS.map((reason) => ({ userId: 'sara', action: 'RELEASED', reason })),
      { userId: 'sara', action: 'CLAIMED', reason: NO_ANSWER_RETURN_REASONS[0] },
    ];
    expect(tallyFired(rows({ claims }), null).get('sara')!.noAnswerReturns).toBe(2);
  });

  const since = at('2026-11-10T06:00:00Z');
  const line = (iso: string, due: string | null, orderId = 'o1', employeeId = 'sara') => ({ employeeId, orderId, createdAt: at(iso), nextFollowUpAt: due ? at(due) : null });

  it('under the plan: a line with a stored due counted, a line with none is early', () => {
    const c = tallyFired(rows({ noAnswers: [line('2026-11-18T08:00:00Z', '2026-11-18T08:30:00Z'), line('2026-11-18T08:10:00Z', null)] }), since).get('sara')!;
    expect(c.countedNoAnswer).toBe(1);
    expect(c.earlyNoAnswer).toBe(1);
  });

  it('the press that closed the order stores no due and IS counted (the fifth); the close is hers', () => {
    const c = tallyFired(
      rows({
        noAnswers: [line('2026-11-18T09:00:00Z', null), line('2026-11-18T08:00:00Z', null)],
        closes: [{ changedById: 'sara', orderId: 'o1', createdAt: at('2026-11-18T09:00:00.020Z') }],
      }),
      since
    ).get('sara')!;
    expect(c.autoCloses).toBe(1);
    expect(c.countedNoAnswer).toBe(1);
    expect(c.earlyNoAnswer).toBe(1);
  });

  it('NEGATIVE: a close of ANOTHER order does not make her early press counted', () => {
    const c = tallyFired(
      rows({ noAnswers: [line('2026-11-18T09:00:00Z', null)], closes: [{ changedById: 'sara', orderId: 'o2', createdAt: at('2026-11-18T09:00:00Z') }] }),
      since
    ).get('sara')!;
    expect(c.earlyNoAnswer).toBe(1);
    expect(c.countedNoAnswer).toBe(0);
  });

  it('plan off, or a line before the plan started: every press counts (the rule of three counts them all)', () => {
    expect(tallyFired(rows({ noAnswers: [line('2026-11-18T08:10:00Z', null)] }), null).get('sara')!.countedNoAnswer).toBe(1);
    expect(tallyFired(rows({ noAnswers: [line('2026-11-09T08:10:00Z', null)] }), since).get('sara')!.countedNoAnswer).toBe(1);
  });

  it('call-proof refusals and the log’s refusals by code; decided counts each order once', () => {
    const c = tallyFired(
      rows({
        proofRefusals: [{ userId: 'sara' }, { userId: 'sara' }],
        refusals: [{ userId: 'sara', code: 'CAP_TOTAL', count: 3 }, { userId: 'sara', code: 'NOT_HELD', count: 1 }],
        decisions: [{ changedById: 'sara', orderId: 'o1' }, { changedById: 'sara', orderId: 'o1' }, { changedById: 'sara', orderId: 'o2' }],
      }),
      null
    ).get('sara')!;
    expect(c.callProofRefusals).toBe(2);
    expect(c.refusals).toEqual({ CAP_TOTAL: 3, NOT_HELD: 1 });
    expect(c.decided).toBe(2);
  });

  it('nobody did anything: an empty map — the door fills zeros (`emptyCounters`)', () => {
    expect(tallyFired(rows({ refusals: null }), null).size).toBe(0);
    expect(emptyCounters()).toEqual({ pulls: 0, idleReturns: 0, noAnswerReturns: 0, countedNoAnswer: 0, earlyNoAnswer: 0, autoCloses: 0, callProofRefusals: 0, refusals: {}, decided: 0 });
  });
});

/* ─────────────── the reads, over a fake database that applies the where it is given ─────────────── */

type Row = Record<string, any> & { companyId: string; createdAt: Date; orderId?: string };
interface Order {
  id: string;
  companyId: string;
  storeId: string;
  superseded?: boolean;
}

function fakeDb(data: { orders: Order[]; claims: Row[]; attempts: Row[]; logs: Row[]; audit: Row[]; refusals: Row[] | 'MISSING' }) {
  const orderOf = (id: string) => data.orders.find((o) => o.id === id);
  const inRange = (r: Row, w: any) => !w.createdAt || (r.createdAt >= w.createdAt.gte && r.createdAt < w.createdAt.lt);
  const orderOk = (r: Row, w: any) => {
    if (!w.order) return true;
    const o = orderOf(r.orderId!);
    if (!o || o.storeId !== w.order.storeId) return false;
    if (w.order.NOT && o.superseded) return false;
    return true;
  };
  const inList = (v: unknown, f: any) => (f === undefined ? true : typeof f === 'object' && f && 'in' in f ? f.in.includes(v) : v === f);
  const base = (r: Row, w: any) => r.companyId === w.companyId && inRange(r, w) && orderOk(r, w);
  const pick = (r: Row, select: Record<string, boolean>) => Object.fromEntries(Object.keys(select).map((k) => [k, r[k]]));
  return {
    orderClaimHistory: {
      findMany: async ({ where, select }: any) =>
        data.claims.filter((r) => base(r, where) && where.OR.some((o: any) => r.action === o.action && inList(r.reason, o.reason))).map((r) => pick(r, select)),
    },
    orderContactAttempt: {
      findMany: async ({ where, select }: any) => data.attempts.filter((r) => base(r, where) && inList(r.result, where.result)).map((r) => pick(r, select)),
    },
    orderStatusLog: {
      findMany: async ({ where, select }: any) =>
        data.logs
          .filter((r) => base(r, where) && r.statusType === where.statusType && inList(r.newValue, where.newValue) && inList(r.note, where.note))
          .map((r) => pick(r, select)),
    },
    auditLog: {
      findMany: async ({ where, select }: any) =>
        data.audit.filter((r) => r.companyId === where.companyId && inRange(r, where) && r.action === where.action && r.entity === where.entity && r.userId).map((r) => pick(r, select)),
    },
    order: {
      findMany: async ({ where }: any) => data.orders.filter((o) => o.companyId === where.companyId && o.storeId === where.storeId && where.id.in.includes(o.id)).map((o) => ({ id: o.id })),
    },
    deskRefusal: {
      groupBy: async ({ where }: any) => {
        if (data.refusals === 'MISSING') throw new Error('relation "desk_refusals" does not exist');
        const counts = new Map<string, number>();
        for (const r of data.refusals) {
          if (r.companyId !== where.companyId || r.storeId !== where.storeId || !inRange(r, where)) continue;
          const k = `${r.userId}|${r.code}`;
          counts.set(k, (counts.get(k) ?? 0) + 1);
        }
        return [...counts].map(([k, n]) => ({ userId: k.split('|')[0], code: k.split('|')[1], _count: { _all: n } }));
      },
    },
  } as any;
}

// The store's 18/11 in Damascus (UTC+3): from 17/11 21:00 UTC to 18/11 21:00 UTC.
const DAY = dayRange('2026-11-18', TZ)!;
const IN = '2026-11-17T22:30:00Z'; // 01:30 of 18/11 in the store — the UTC day says 17/11
const OUT = '2026-11-18T21:30:00Z'; // 00:30 of 19/11 in the store — the UTC day still says 18/11

function world(refusals: Row[] | 'MISSING' = []) {
  const orders: Order[] = [
    { id: 'here', companyId: 'c1', storeId: 's1' },
    { id: 'there', companyId: 'c1', storeId: 's2' },
    { id: 'replaced', companyId: 'c1', storeId: 's1', superseded: true },
  ];
  const each = (make: (orderId: string, when: string) => Row) => [make('here', IN), make('there', IN), make('here', OUT)];
  return fakeDb({
    orders,
    claims: [
      ...each((orderId, w) => ({ companyId: 'c1', orderId, userId: 'sara', action: 'CLAIMED', reason: PULL_REASON, createdAt: at(w) })),
      ...each((orderId, w) => ({ companyId: 'c1', orderId, userId: 'sara', action: 'RELEASED', reason: IDLE_RETURN_REASONS[0], createdAt: at(w) })),
      ...each((orderId, w) => ({ companyId: 'c1', orderId, userId: 'sara', action: 'RELEASED', reason: NO_ANSWER_RETURN_REASONS[0], createdAt: at(w) })),
    ],
    attempts: each((orderId, w) => ({ companyId: 'c1', orderId, employeeId: 'sara', result: 'NO_ANSWER', nextFollowUpAt: null, createdAt: at(w) })),
    logs: [
      ...each((orderId, w) => ({ companyId: 'c1', orderId, changedById: 'sara', statusType: 'CONFIRMATION', newValue: 'CANCELLED', note: NO_ANSWER_CLOSE.five.note, createdAt: at(w) })),
      ...each((orderId, w) => ({ companyId: 'c1', orderId, changedById: 'sara', statusType: 'CONFIRMATION', newValue: 'CONFIRMED', note: null, createdAt: at(w) })),
      { companyId: 'c1', orderId: 'replaced', changedById: 'sara', statusType: 'CONFIRMATION', newValue: 'CONFIRMED', note: null, createdAt: at(IN) },
    ],
    audit: each((orderId, w) => ({ companyId: 'c1', userId: 'sara', action: 'CALL_PROOF_REFUSED', entity: 'Order', entityId: orderId, createdAt: at(w) })),
    refusals:
      refusals === 'MISSING'
        ? 'MISSING'
        : [
            { companyId: 'c1', storeId: 's1', userId: 'sara', code: 'CAP_TOTAL', createdAt: at(IN) },
            { companyId: 'c1', storeId: 's2', userId: 'sara', code: 'CAP_TOTAL', createdAt: at(IN) },
            { companyId: 'c1', storeId: 's1', userId: 'sara', code: 'CAP_TOTAL', createdAt: at(OUT) },
            { companyId: 'c2', storeId: 's1', userId: 'sara', code: 'CAP_TOTAL', createdAt: at(IN) },
            ...refusals,
          ],
  });
}

describe('the reads: one store, the store’s day', () => {
  it('each counter counts its one row of this store and this day — not the other store, not 00:30 of the next local day, not a superseded order', async () => {
    const got = await readFiredRows(world(), { companyId: 'c1', storeId: 's1', ...DAY });
    const c = tallyFired(got, null).get('sara')!;
    expect(c).toEqual({ pulls: 1, idleReturns: 1, noAnswerReturns: 1, countedNoAnswer: 1, earlyNoAnswer: 0, autoCloses: 1, callProofRefusals: 1, refusals: { CAP_TOTAL: 1 }, decided: 1 });
    expect(got.truncated).toBe(false);
  });

  it('the next day of the store picks up exactly the 00:30 rows', async () => {
    const next = dayRange('2026-11-19', TZ)!;
    const c = tallyFired(await readFiredRows(world(), { companyId: 'c1', storeId: 's1', ...next }), null).get('sara')!;
    expect(c.pulls).toBe(1);
    expect(c.decided).toBe(1);
    expect(c.refusals).toEqual({ CAP_TOTAL: 1 });
  });

  it('the refusal log rolled back: null (said on the screen), and every other counter still counts', async () => {
    const got = await readFiredRows(world('MISSING'), { companyId: 'c1', storeId: 's1', ...DAY });
    expect(got.refusals).toBeNull();
    expect(tallyFired(got, null).get('sara')!.pulls).toBe(1);
  });

  it('the refusal log empty: no refusal, nothing else changes', async () => {
    const empty = fakeDb({ orders: [], claims: [], attempts: [], logs: [], audit: [], refusals: [] });
    const got = await readFiredRows(empty, { companyId: 'c1', storeId: 's1', ...DAY });
    expect(got.refusals).toEqual([]);
    expect(tallyFired(got, null).size).toBe(0);
  });
});

describe('the day is the store’s', () => {
  // 22:30 UTC on 18/11 is 01:30 of 19/11 in Damascus.
  const now = at('2026-11-18T22:30:00Z');

  it('no day: the store’s today — not the UTC day', () => {
    const v = resolveFiredDay(null, now, TZ);
    expect(v.ok && v.day).toBe('2026-11-19');
    expect(v.ok && v.today).toBe(true);
    expect(v.ok && v.start.toISOString()).toBe('2026-11-18T21:00:00.000Z');
  });

  it('yesterday is allowed and is not today', () => {
    const v = resolveFiredDay('2026-11-18', now, TZ);
    expect(v.ok && v.today).toBe(false);
  });

  it('NEGATIVE: a day still to come → DAY_IN_FUTURE, in Arabic', () => {
    expect(resolveFiredDay('2026-11-20', now, TZ)).toEqual({ ok: false, code: 'DAY_IN_FUTURE', errorAr: DAY_IN_FUTURE_AR });
  });

  it('NEGATIVE: not a day → INVALID_DAY, in Arabic', () => {
    for (const bad of ['2026-02-30', '19/11/2026', 'today', '2026-11-1']) {
      expect(resolveFiredDay(bad, now, TZ), bad).toEqual({ ok: false, code: 'INVALID_DAY', errorAr: DAY_INVALID_AR });
    }
  });
});

describe('the words and the source', () => {
  it('every code the log keeps has an Arabic name; an unknown code is «another refusal», never the code', () => {
    for (const code of DESK_REFUSAL_CODES) expect(REFUSAL_LABEL_AR[code], code).toMatch(/[؀-ۿ]/);
    for (const label of Object.values(REFUSAL_LABEL_AR)) expect(label).not.toMatch(/[A-Za-z]/);
    expect(refusalLabel('SOMETHING_NEW')).not.toMatch(/[A-Za-z]/);
  });

  const src = stripComments(readFileSync(join(process.cwd(), 'src/lib/rule-fired.ts'), 'utf8'));

  it('NEGATIVE: no UTC day anywhere (`toISOString().slice`), and the day comes from the store’s `localDay` / `dayRange`', () => {
    expect(src).not.toMatch(/toISOString\(\)\s*\.slice/);
    expect(src).toMatch(/localDay\(now, timeZone\)/);
    expect(src).toMatch(/dayRange\(day, timeZone\)/);
  });

  it('reads only: no create, update, delete or raw write', () => {
    expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw/);
  });

  it('no customer field is read', () => {
    expect(src).not.toMatch(/customer|phone|address|fullName/i);
  });
});
