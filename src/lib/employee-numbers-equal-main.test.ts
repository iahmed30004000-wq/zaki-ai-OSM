import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * REQUEST Q4b — THE DIFFERENTIAL: «NO RULE OF THE OWNER = osm/main, BYTE FOR BYTE»
 *
 * `employee-numbers.main-golden.json` was written by THIS file (with `Q4B_GOLDEN_FROM` naming a copy of `confirmation-queue.ts` as it is on `osm/main` 7d6dcf30, before
 * the employee numbers acted) over the seeded scenarios below: random desks in an in-memory database that applies its filters, every switch the numbers depend on (the
 * plan «جدول المحاولات», «أولوية الطابور»), a base rule stored or not, and — for the branch — rule rows that bind NOBODY on that desk (another company, stopped,
 * expired, not yet started, another store, a person who is not there, another kind). Recorded: the five-minute job's pass (count, every order's hands, the history
 * lines, the notices), one pull by a random agent (its answer and the desk after it), the store's limits and hers, and the pace's answer over random pull times.
 *
 * Today's code answers them with NO rule row, and again with the rows that bind nobody: both must be the golden, record for record. (Before the PR the same comparison
 * ran locally over 2 000 scenarios, the `osm/main` copy against today, live: identical.)
 * ═══════════════════════════════════════════════════════════════════════
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const { world, sw } = vi.hoisted(() => ({
  world: { orders: [] as Row[], history: [] as Row[], notices: [] as Row[], rules: [] as Row[], clock: new Date(), settings: '{}' },
  sw: { plan: null as Date | null },
}));

type Tri = true | false | null;
const and = (xs: Tri[]): Tri => (xs.includes(false) ? false : xs.includes(null) ? null : true);
const or = (xs: Tri[]): Tri => (xs.includes(true) ? true : xs.includes(null) ? null : false);
function tri(row: Row, where: Row): Tri {
  return and(
    Object.entries(where).map(([key, cond]): Tri => {
      if (key === 'AND') return and((cond as Row[]).map((w) => tri(row, w)));
      if (key === 'OR') return or((cond as Row[]).map((w) => tri(row, w)));
      if (key === 'NOT') return ((r: Tri) => (r === null ? null : !r))(and((Array.isArray(cond) ? cond : [cond]).map((w: Row) => tri(row, w))));
      const value = row[key] ?? null;
      if (cond === null) return value === null;
      if (cond instanceof Date) return value === null ? null : (value as Date).getTime() === cond.getTime();
      if (typeof cond !== 'object') return value === null ? null : value === cond;
      return and(
        Object.entries(cond as Row).map(([op, arg]): Tri => {
          switch (op) {
            case 'not': return arg === null ? value !== null : value === null ? null : value !== arg;
            case 'in': return value === null ? null : (arg as unknown[]).includes(value);
            case 'notIn': return value === null ? null : !(arg as unknown[]).includes(value);
            case 'gt': return value === null ? null : (value as Date).getTime() > (arg as Date).getTime();
            case 'gte': return value === null ? null : (value as Date).getTime() >= (arg as Date).getTime();
            case 'lt': return value === null ? null : (value as Date).getTime() < (arg as Date).getTime();
            case 'lte': return value === null ? null : (value as Date).getTime() <= (arg as Date).getTime();
            case 'is': return arg === null ? value === null : value === null ? null : tri(value as Row, arg as Row);
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
  const pick = (row: Row, select?: Row) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k] ?? null])) : { ...row });
  const db = {
    order: {
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
        for (const r of hit) for (const [k, v] of Object.entries(data)) r[k] = (v as Row)?.increment !== undefined ? (r[k] ?? 0) + (v as Row).increment : v;
        return { count: hit.length };
      }),
    },
    orderClaimHistory: {
      create: vi.fn(async ({ data }: Row) => {
        const line = { createdAt: world.clock, ...data };
        world.history.push(line);
        world.orders.find((r) => r.id === data.orderId)?.claimHistory.push(line);
      }),
      findMany: vi.fn(async ({ where, select }: Row) => world.history.filter((h) => matches(h, where ?? {})).map((h) => pick(h, select))),
      findFirst: vi.fn(async ({ where }: Row) => world.history.find((h) => matches(h, where ?? {})) ?? null),
    },
    orderContactAttempt: { count: vi.fn(async ({ where }: Row) => (world.orders.find((o) => o.id === where.orderId)?.contactAttempts ?? []).length) },
    company: { findUnique: vi.fn(async () => ({ settings: world.settings })) },
    confirmationRule: { findMany: vi.fn(async ({ where }: Row) => world.rules.filter((r) => matches(r, where ?? {})).map((r) => ({ ...r }))) },
    store: { findUnique: vi.fn(async () => ({ country: { timezone: 'UTC' } })) },
    notification: { createMany: vi.fn(async ({ data }: Row) => void world.notices.push(...(data as Row[]))) },
    orderStatusLog: { create: vi.fn(async () => undefined) },
    orderActivity: { create: vi.fn(async () => undefined) },
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return { db, default: db };
});
const OFF = { enabled: false, enabledAt: null };
vi.mock('./no-answer-cadence-switch', () => ({ cadenceSince: async () => sw.plan }));
vi.mock('./no-answer-rounds-switch', () => ({ roundsSwitch: async () => OFF }));
vi.mock('./no-answer-returns-switch', () => ({ returnsSwitch: async () => OFF }));

import * as today from './confirmation-queue';
import { CONFIRMATION_RULE_DEFAULT, documentAfterSave, type ConfirmationRuleNumbers } from './confirmation-rule-settings';
import { forgetQueuePrioritySwitch } from './queue-priority-switch';
import { db } from './db';

type Queue = Pick<typeof today, 'pullNextOrder' | 'readReturnsMode' | 'releaseNoAnswerRounds' | 'returnsLimits' | 'pullPaceRefusal' | 'releaseStaleClaims'>;

const GOLDEN = join(process.cwd(), 'src/lib/employee-numbers.main-golden.json');
const N = 160;
const SEED = 20261121;
const CAL = { workHoursStart: '08:00', workHoursEnd: '20:00', weekendDays: [] as number[], timezone: 'UTC' };
const NOW = new Date('2026-11-16T12:00:00.000Z');
const PEOPLE = ['p1', 'p2', 'p3', 'p4'];

/** The rows that bind NOBODY on the scenario's desk (company `co-<i>`, store s1, holders p1–p4). */
function rowsThatBindNobody(co: string): Row[] {
  const base = {
    storeId: null, kind: 'EMPLOYEE_NUMBERS', userIds: null, productId: null, channelKind: null, phase: null, hoursFrom: null, hoursTo: null,
    effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveTo: null, isActive: true, createdAt: new Date('2026-01-01T00:00:00Z'), name: 'لا تمسك حدا',
  };
  return [
    { ...base, id: 'x1', companyId: 'another-company', payload: { hand: 1, idleMinutes: 10, pullPerHour: 10 } },
    { ...base, id: 'x2', companyId: co, isActive: false, payload: { hand: 1, idleMinutes: 10, pullPerHour: 10 } },
    { ...base, id: 'x3', companyId: co, effectiveTo: new Date('2026-02-01T00:00:00Z'), payload: { hand: 1, idleMinutes: 10, pullPerHour: 10 } },
    { ...base, id: 'x4', companyId: co, effectiveFrom: new Date('2027-01-01T00:00:00Z'), payload: { hand: 1, idleMinutes: 10, pullPerHour: 10 } },
    { ...base, id: 'x5', companyId: co, storeId: 's9', payload: { hand: 1, idleMinutes: 10, pullPerHour: 10 } },
    { ...base, id: 'x6', companyId: co, userIds: ['somebody-else'], payload: { hand: 1, idleMinutes: 10, pullPerHour: 10 } },
    { ...base, id: 'x7', companyId: co, kind: 'ORDER_NUMBERS', storeId: 's1', payload: { proofSeconds: 20 } },
    { ...base, id: 'x8', companyId: co, hoursFrom: '01:00', hoursTo: '02:00', payload: { hand: 1, idleMinutes: 10 } },
  ];
}

/** One seeded desk, run through the module `q`; returns everything a person or the database would see. */
async function scenario(q: Queue, i: number, rules: 'none' | 'nobody') {
  let s = SEED + i * 7919;
  const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
  const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
  const co = `co-${i}-${rules}`;
  const scope = { companyId: co, storeId: 's1' };
  world.orders = [];
  world.history = [];
  world.notices = [];
  world.clock = NOW;
  world.rules = rules === 'nobody' ? rowsThatBindNobody(co) : [];
  forgetQueuePrioritySwitch();

  // The switches and the base rule.
  sw.plan = rnd() < 0.6 ? new Date('2026-11-01T00:00:00Z') : null;
  const priority = rnd() < 0.5;
  const edited: ConfirmationRuleNumbers | null = rnd() < 0.5 ? { ...CONFIRMATION_RULE_DEFAULT, hand: int(1, 6), idleMinutes: int(10, 60) } : null;
  const settings: Row = {};
  if (priority) settings.queuePriority = { enabled: true, enabledAt: '2026-11-01T00:00:00.000Z' };
  if (edited) settings.confirmationRule = documentAfterSave(null, { rule: edited, effectiveAt: new Date(0), byUserId: 'u' }, 0);
  world.settings = JSON.stringify(settings);

  // The desk: orders in hands (idle or rung), and a pool.
  let seq = 0;
  const add = (over: Row) => {
    seq += 1;
    world.orders.push({
      id: `o${String(seq).padStart(3, '0')}`, orderNumber: `ORD-${seq}`, ...scope, customerId: `c${int(1, 30)}`,
      confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS', shippingStatus: 'NOT_READY', shippingBatchId: null, trackingNumber: null, labelPrintedAt: null,
      claimedById: null, claimedAt: null, currentOwnerId: null, signatureStatus: 'SIGNED', assignedToId: null, assignedAt: null, assignee: null,
      replacesOrderId: null, postponedUntil: null, nextFollowUpAt: null, createdAt: new Date(NOW.getTime() - int(60, 3000) * 60_000), version: 1,
      contactAttempts: [], claimHistory: [],
      ...over,
    });
  };
  for (let k = int(0, 10); k > 0; k--) {
    const who = PEOPLE[int(0, 3)];
    const rung = rnd() < 0.4;
    add({
      claimedById: who, currentOwnerId: who, claimedAt: new Date(NOW.getTime() - int(0, 90) * 60_000), claimHistory: [{ action: 'CLAIMED' }],
      contactAttempts: rung ? [{ createdAt: new Date(NOW.getTime() - int(0, 60) * 60_000), result: 'OPENED', employeeId: who, attemptNumber: 1, nextFollowUpAt: null }] : [],
    });
  }
  for (let k = int(0, 5); k > 0; k--) add({ confirmationStatus: 'NEW', status: 'NEW' });
  for (const who of PEOPLE) for (let k = int(0, 45); k > 0 && rnd() < 0.3; k--) {
    world.history.push({ companyId: co, orderId: `old-${k}`, userId: who, action: 'CLAIMED', reason: 'PULL_NEXT', createdAt: new Date(NOW.getTime() - int(1, 59) * 60_000) });
  }
  const snap = () => ({
    hands: world.orders.map((o) => [o.id, o.claimedById, o.confirmationStatus, o.assignedToId]),
    history: world.history.filter((h) => h.createdAt.getTime() === NOW.getTime()).map((h) => [h.orderId, h.userId, h.action, h.reason]),
    notices: world.notices.map((n) => [n.userId, n.title, n.message]),
  });

  // The store's limits, and one person's (main has no `her`: it answers the store's — and so must today's with no rule naming her).
  const limits = await q.returnsLimits(db as never, co, NOW.getTime());
  const her = await (q.returnsLimits as (...a: unknown[]) => Promise<unknown>)(db as never, co, NOW.getTime(), undefined, { userId: PEOPLE[int(0, 3)], storeId: 's1', timezone: 'UTC' });

  // The job's pass (plan on → the plan's idle release; plan off with priority → nothing runs here, the rounds being off).
  const returns = await q.readReturnsMode(db as never, co, { now: NOW, calendar: () => CAL, rounds: OFF });
  const job = await q.releaseNoAnswerRounds(db as never, scope, CAL, NOW, { rounds: OFF, returns });
  const afterJob = snap();

  // One pull — priority off only (its share and modes are another file's world).
  let pull: unknown = null;
  if (!priority) {
    const out = await q.pullNextOrder(scope, { id: PEOPLE[int(0, 3)], role: 'CONFIRMATION_AGENT' }, CAL, NOW);
    pull = { out, desk: snap() };
  }

  // The pace over random times.
  const times = Array.from({ length: int(30, 50) }, () => new Date(NOW.getTime() - int(0, 59) * 60_000));
  const pace = q.pullPaceRefusal(times, NOW);

  return JSON.parse(JSON.stringify({ i, plan: !!sw.plan, priority, edited: !!edited, limits, her, job, afterJob, pull, pace }));
}

async function runAll(q: Queue, rules: 'none' | 'nobody', n = N) {
  const out: unknown[] = [];
  for (let i = 0; i < n; i++) out.push(await scenario(q, i, rules));
  return out;
}

beforeEach(() => vi.clearAllMocks());

// The golden's writer: `Q4B_GOLDEN_FROM=src/lib/confirmation-queue.main-copy.ts` (a copy of the file on osm/main) — never in CI.
const FROM = process.env.Q4B_GOLDEN_FROM;
describe.runIf(!!FROM)('write the golden from the osm/main copy', () => {
  it('writes', async () => {
    const main = (await import(/* @vite-ignore */ join(process.cwd(), FROM!))) as Queue;
    const n = Number(process.env.Q4B_N ?? N);
    const golden = await runAll(main, 'none', n);
    if (n === N) writeFileSync(GOLDEN, JSON.stringify(golden, null, 1) + '\n');
    // The live comparison over n scenarios, both rule sets.
    expect(await runAll(today, 'none', n)).toEqual(golden);
    expect(await runAll(today, 'nobody', n)).toEqual(golden);
  }, 600_000);
});

describe.runIf(!FROM)('no rule of the owner → osm/main, record for record', () => {
  const golden = existsSync(GOLDEN) ? (JSON.parse(readFileSync(GOLDEN, 'utf8')) as unknown[]) : [];

  it('the golden is the one the recipe writes: n = 160, every switch combination present', () => {
    expect(golden).toHaveLength(N);
    const combos = new Set(golden.map((g) => { const r = g as Row; return `${r.plan}-${r.priority}-${r.edited}`; }));
    expect(combos.size).toBe(8);
    // And it is not empty of events: releases, pulls and refusals all happened.
    expect(golden.some((g) => (g as Row).job > 0)).toBe(true);
    expect(golden.some((g) => (g as Row).pull?.out?.ok === true)).toBe(true);
    expect(golden.some((g) => (g as Row).pull?.out?.refusal)).toBe(true);
    expect(golden.some((g) => (g as Row).pace)).toBe(true);
  });

  it.each([['no rule row', 'none'], ['rows that bind nobody here', 'nobody']] as const)('%s', async (_name, rules) => {
    const now = await runAll(today, rules);
    for (let i = 0; i < golden.length; i++) expect(now[i], `scenario ${i}`).toEqual(golden[i]);
  }, 120_000);
});
