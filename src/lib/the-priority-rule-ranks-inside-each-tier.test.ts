import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

/**
 * ═════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — «هالطلبات أول»: THE OWNER'S PRIORITY RULES RANK INSIDE EACH TIER OF THE PULL (request Q5a of the rules plan, 21/11)
 *
 *  1. ZERO RULES = TODAY: with no PRIORITY rule in force (none, other kinds only, another store or company, stopped, out of its dates or hours, broken) the plan
 *     carries no `boost` and the pick is main's — the same order AND the same statements, over many random pools (the frozen golden
 *     `the-priority-rule-ranks-inside-each-tier.main-golden.json`, written by main's `confirmation-queue.ts`).
 *  2. THE TIERS DO NOT MOVE: with rules, every pick is of the same tier as main's pick at the same moment — a boosted retry never passes a fresh new order, a promise
 *     is never passed, the owner's «الجديد أول» holds across tiers, the two time-of-day modes are main's.
 *  3. INSIDE A TIER the boosted orders come first, in the tier's own order; with none boosted, the tier's own first. Everything is still dealt in the end.
 *  4. The filter answers what the resolver answers: for random rules and orders, «matches the filter» ≡ `ruleFor(...).first.value`.
 *  5. The pull reads the rules once (its cached reader): a warm cache asks the rules table nothing; the desk («طلباتي») imports nothing new.
 *
 * Driven against an in-memory database that APPLIES its filters (the neighbouring pull tests' double, taught `items` and `channel`).
 * ═════════════════════════════════════════════════════════════════
 */

const { world, calls } = vi.hoisted(() => ({ world: { orders: [] as Row[] }, calls: { n: 0, log: [] as string[] } }));

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
            case 'gt': return value === null ? null : (value as Date).getTime() > (arg as Date).getTime();
            case 'gte': return value === null ? null : (value as Date).getTime() >= (arg as Date).getTime();
            case 'lt': return value === null ? null : (value as Date).getTime() < (arg as Date).getTime();
            case 'lte': return value === null ? null : (value as Date).getTime() <= (arg as Date).getTime();
            case 'is':
              if (arg === null) return value === null;
              return value === null ? false : tri(value as Row, arg as Row);
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
      calls.n += 1;
      calls.log.push('order.findMany');
      const found = sorted(world.orders.filter((r) => matches(r, where ?? {})), orderBy);
      return (take ? found.slice(0, take) : found).map((r) => ({ ...r }));
    }),
    findFirst: vi.fn(async ({ where, orderBy }: Row) => {
      calls.n += 1;
      calls.log.push('order.findFirst');
      const hit = sorted(world.orders.filter((r) => matches(r, where ?? {})), orderBy)[0];
      return hit ? { ...hit } : null;
    }),
  };
  const db = { order, confirmationRule: { findMany: vi.fn(async () => []) } };
  return { db, default: db };
});

import { RETURNS_MODE, pickNextCandidate, priorityPlanFor, type PriorityPlan } from './confirmation-queue';
import { ruleFor, type ConfirmationRuleRow } from './confirmation-rules';
import { CONFIRMATION_RULE_DEFAULT } from './confirmation-rule-settings';
import { returnsMode } from './no-answer-returns';
import { workClock } from './no-answer-rounds';
import { priorityBoostOf, type PriorityBoost } from './priority-rules';
import { db } from './db';

const NOW = new Date('2026-11-12T12:00:00.000Z');
const SINCE = new Date('2026-11-01T08:00:00.000Z');
const scope = { companyId: 'c1', storeId: 's1' };
const CAL = { workHoursStart: '00:00', workHoursEnd: '23:59', weekendDays: [] as number[], timezone: 'UTC' };
const CADENCE = returnsMode(NOW, workClock(CAL), RETURNS_MODE.idleBusinessMinutes, SINCE);
const minutes = (m: number) => new Date(NOW.getTime() + m * 60_000);

/** A small seeded generator, so every run (and the golden) sees the same pools. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PRODUCTS = ['pA', 'pB', 'pC'];
const KINDS = ['WHATSAPP', 'FACEBOOK', 'LANDING_PAGE'];
type Kind = 'promise' | 'fresh' | 'new' | 'aged' | 'retry' | 'waiting' | 'postponed';

/** One random pool: orders of every kind, each with a product line and maybe a channel. Ids carry the kind, so a test can name the tier of a pick. */
function pool(seed: number): Row[] {
  const r = prng(seed);
  const pickOf = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const n = 4 + Math.floor(r() * 10);
  const out: Row[] = [];
  for (let i = 0; i < n; i++) {
    const kind = pickOf<Kind>(['promise', 'fresh', 'new', 'new', 'aged', 'retry', 'waiting', 'postponed']);
    const createdAgo = kind === 'fresh' ? 1 + Math.floor(r() * 13) : 20 + Math.floor(r() * 5000);
    const items = [{ productId: pickOf(PRODUCTS) }, ...(r() < 0.3 ? [{ productId: pickOf(PRODUCTS) }] : [])];
    const channel = r() < 0.6 ? { kind: pickOf(KINDS) } : null;
    const line = (pressedAgo: number, result: string, dueIn: number | null) => ({
      createdAt: minutes(-pressedAgo), result, nextFollowUpAt: dueIn === null ? null : minutes(dueIn), employeeId: 'x', attemptNumber: 1,
    });
    const base: Row = {
      id: `${kind}-${seed}-${String(i).padStart(2, '0')}`, ...scope, customerId: `cust-${seed}-${i}`,
      confirmationStatus: 'NEW', status: 'NEW', shippingStatus: 'NOT_READY', claimedById: null, claimedAt: null, currentOwnerId: null,
      assignedToId: null, assignedAt: null, assignee: null, postponedUntil: null, nextFollowUpAt: null,
      createdAt: minutes(-createdAgo), version: 1, contactAttempts: [], claimHistory: [], items, channel,
    };
    if (kind === 'promise') Object.assign(base, { confirmationStatus: 'POSTPONED', status: 'POSTPONED', postponedUntil: minutes(-(5 + Math.floor(r() * 300))), contactAttempts: [line(4000, 'POSTPONED', null)] });
    if (kind === 'postponed') Object.assign(base, { confirmationStatus: 'POSTPONED', status: 'POSTPONED', postponedUntil: minutes(-(400 + Math.floor(r() * 300))), contactAttempts: [line(200, 'POSTPONED', null)] });
    if (kind === 'aged') Object.assign(base, { confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS', contactAttempts: [line(2000, 'NO_ANSWER', -(121 + Math.floor(r() * 900)))] });
    if (kind === 'retry') Object.assign(base, { confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS', contactAttempts: [line(2000, 'NO_ANSWER', -(1 + Math.floor(r() * 110)))] });
    if (kind === 'waiting') Object.assign(base, { confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS', contactAttempts: [line(20, 'NO_ANSWER', 30 + Math.floor(r() * 200))] });
    out.push(base);
  }
  return out;
}

const rule = (id: string, over: Partial<ConfirmationRuleRow> = {}): ConfirmationRuleRow => ({
  id, companyId: 'c1', storeId: null, name: id, kind: 'PRIORITY', userIds: null, productId: null, channelKind: null, phase: null, hoursFrom: null, hoursTo: null,
  effectiveFrom: new Date('2026-11-01T00:00:00.000Z'), effectiveTo: null, isActive: true, payload: { first: true }, createdAt: new Date('2026-11-01T00:00:00.000Z'), ...over,
});

/** Random rules: PRIORITY ones that name a product, a channel, a phase, hours, a store — and some that never act. */
function rules(seed: number): ConfirmationRuleRow[] {
  const r = prng(seed * 7 + 3);
  const pickOf = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const n = Math.floor(r() * 4);
  return Array.from({ length: n }, (_, i) => {
    const over: Partial<ConfirmationRuleRow> = {};
    if (r() < 0.6) over.productId = pickOf(PRODUCTS);
    if (r() < 0.35) over.channelKind = pickOf(KINDS);
    if (r() < 0.35) over.phase = pickOf(['NEW', 'RETRY']);
    if (r() < 0.2) Object.assign(over, pickOf([{ hoursFrom: '10:00', hoursTo: '14:00' }, { hoursFrom: '20:00', hoursTo: '06:00' }]));
    if (r() < 0.15) over.storeId = pickOf(['s1', 's2']);
    if (r() < 0.1) over.isActive = false;
    return rule(`rule-${seed}-${i}`, over);
  });
}

/** The resolver's answer for one order — the independent oracle (never the filter under test). */
function boostedByResolver(o: Row, list: readonly ConfirmationRuleRow[]): boolean {
  const order = { storeId: o.storeId, productIds: o.items.map((i: Row) => i.productId), channelKind: o.channel?.kind ?? null, phase: o.contactAttempts.length > 0 ? ('RETRY' as const) : ('NEW' as const) };
  return ruleFor({ person: { id: '', storeId: o.storeId }, order, now: NOW }, { companyId: 'c1', base: CONFIRMATION_RULE_DEFAULT, timezone: CAL.timezone, rules: list }).first.value;
}

/** The tier of a pick, read from the kind its id carries. «retry» and «aged» are one kind of order; the aged tier is said by its due. */
const tierOf = (id: string | null) => (id === null ? 'none' : id.split('-')[0]);

const PLANS: PriorityPlan[] = [
  { mode: 'NORMAL', backlogTurn: false },
  { mode: 'NORMAL', backlogTurn: true },
  { mode: 'NORMAL', backlogTurn: false, freshMinutes: 30 },
  { mode: 'NIGHT_FIRST', backlogTurn: false },
  { mode: 'PEAK_NEW_FIRST', backlogTurn: true },
];

async function pickNow(plan: PriorityPlan | null) {
  return pickNextCandidate(db as never, scope, NOW, 'sara', { heldForHerAsked: true, returns: CADENCE, priority: plan });
}

/** Deal the whole pool with one plan: the ids in order, and the statements each pick asked. */
async function dealAll(rows: Row[], plan: PriorityPlan | null): Promise<{ ids: string[]; statements: number[] }> {
  world.orders = rows.map((o) => ({ ...o, claimedById: null }));
  const ids: string[] = [];
  const statements: number[] = [];
  for (let i = 0; i < 40; i++) {
    calls.n = 0;
    const id = await pickNow(plan);
    statements.push(calls.n);
    if (!id) break;
    ids.push(id);
    world.orders.find((o) => o.id === id)!.claimedById = 'sara';
  }
  return { ids, statements };
}

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'the-priority-rule-ranks-inside-each-tier.main-golden.json');
const SEEDS = Array.from({ length: 60 }, (_, i) => i + 1);

beforeEach(() => {
  world.orders = [];
  calls.n = 0;
  calls.log = [];
});

describe('zero rules = today: the order and the statements of main, over random pools', () => {
  it('rules that do not act give NO boost — the plan is main\'s object, key for key', () => {
    const never = [
      [] as ConfirmationRuleRow[],
      [rule('x', { kind: 'EMPLOYEE_NUMBERS', payload: { hand: 2 } })],
      [rule('x', { storeId: 's2', productId: 'pA' })],
      [rule('x', { companyId: 'c2', productId: 'pA' })],
      [rule('x', { productId: 'pA', isActive: false })],
      [rule('x', { productId: 'pA', effectiveFrom: new Date('2026-11-13T00:00:00.000Z') })],
      [rule('x', { productId: 'pA', effectiveTo: new Date('2026-11-12T11:00:00.000Z') })],
      [rule('x', { productId: 'pA', hoursFrom: '13:00', hoursTo: '15:00' })],
      [rule('x', { productId: 'pA', payload: { first: false } })],
      [rule('x', { productId: 'pA', userIds: ['sara'] })],
      [rule('x', {})], // every order of the store: reorders nothing
      [rule('x', { storeId: 's1' })],
      [rule('x', { phase: 'NEW' }), rule('y', { phase: 'RETRY' })],
    ];
    for (const list of never) expect(priorityBoostOf(list, { companyId: 'c1', storeId: 's1', now: NOW, timezone: 'UTC' })).toBeNull();
  });

  it('the deal of every random pool and plan, with no boost, is main\'s — order and statements (the frozen golden)', async () => {
    const got: Record<string, { ids: string[]; statements: number[] }> = {};
    for (const seed of SEEDS) {
      for (const [k, plan] of PLANS.entries()) {
        // The boost a no-acting rule set gives: none. On main the key does not exist; here it must not either.
        const boost = priorityBoostOf(rules(seed).filter((r) => r.isActive === false), { companyId: 'c1', storeId: 's1', now: NOW, timezone: 'UTC' });
        got[`${seed}/${k}`] = await dealAll(pool(seed), { ...plan, ...(boost ? { boost } : {}) });
      }
      got[`${seed}/none`] = await dealAll(pool(seed), null);
    }
    if (process.env.Q5A_WRITE_GOLDEN === '1') writeFileSync(GOLDEN, `${JSON.stringify(got, null, 1)}\n`);
    expect(existsSync(GOLDEN)).toBe(true);
    expect(got).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
  });
});

describe('with rules: the tiers do not move, and inside a tier the boosted come first', () => {
  it('every pick is of main\'s tier; a boosted one is taken whenever main\'s pick is not boosted and the tier holds one; all is dealt in the end', async () => {
    let boostedPicks = 0;
    let movedInsideATier = 0;
    for (const seed of SEEDS) {
      const list = rules(seed);
      const boost = priorityBoostOf(list, { companyId: 'c1', storeId: 's1', now: NOW, timezone: 'UTC' });
      for (const plan of PLANS) {
        const rows = pool(seed);
        const isBoosted = new Map(rows.map((o) => [o.id, boostedByResolver(o, list)]));
        world.orders = rows.map((o) => ({ ...o }));
        const dealt: string[] = [];
        for (let i = 0; i < 40; i++) {
          const mine = await pickNow({ ...plan, ...(boost ? { boost } : {}) });
          const main = await pickNow(plan);
          // THE TIER: the same kind of order as main would deal now (a fresh new order is never passed by a retry; a promise never by anything).
          const sameTier = tierOf(mine) === tierOf(main) || (['aged', 'retry'].includes(tierOf(mine)) && ['aged', 'retry'].includes(tierOf(main)));
          expect(sameTier, `seed ${seed} ${JSON.stringify(plan)}: main ${main}, mine ${mine}`).toBe(true);
          if (tierOf(main) === 'promise' || plan.mode !== 'NORMAL' || !boost) expect(mine).toBe(main);
          // INSIDE THE TIER: main's pick boosted → the same; mine differs → mine is boosted.
          if (main && isBoosted.get(main)) expect(mine).toBe(main);
          if (mine !== main) {
            expect(isBoosted.get(mine!), `seed ${seed}: ${mine} passed ${main} without a rule`).toBe(true);
            movedInsideATier += 1;
          }
          if (mine && isBoosted.get(mine)) boostedPicks += 1;
          if (!mine) break;
          dealt.push(mine);
          world.orders.find((o) => o.id === mine)!.claimedById = 'sara';
        }
        const all = (await dealAll(pool(seed), plan)).ids;
        expect([...dealt].sort()).toEqual([...all].sort());
      }
    }
    // The scenarios are not vacuous: rules did move orders inside their tiers.
    expect(movedInsideATier).toBeGreaterThan(20);
    expect(boostedPicks).toBeGreaterThan(50);
  });

  /** A plain order nobody holds or has rung, for the hand-built cases. */
  const plainOrder = (id: string, over: Row = {}): Row => ({
    id, ...scope, customerId: `cust-${id}`, confirmationStatus: 'NEW', status: 'NEW', shippingStatus: 'NOT_READY', claimedById: null, claimedAt: null,
    currentOwnerId: null, assignedToId: null, assignedAt: null, assignee: null, postponedUntil: null, nextFollowUpAt: null, createdAt: minutes(-300),
    version: 1, contactAttempts: [], claimHistory: [], items: [{ productId: 'pA' }], channel: null, ...over,
  });
  const noAnswer = (dueIn: number) => [{ createdAt: minutes(-3000), result: 'NO_ANSWER', nextFollowUpAt: minutes(dueIn), employeeId: 'x', attemptNumber: 1 }];
  const asked = [{ createdAt: minutes(-4000), result: 'POSTPONED', nextFollowUpAt: null, employeeId: 'x', attemptNumber: 1 }];

  it('a boosted retry never passes a FRESH new order — even when it is aged and it is the backlog\'s turn', async () => {
    world.orders = [
      plainOrder('fresh-x', { createdAt: minutes(-5) }),
      plainOrder('aged-x', { confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS', items: [{ productId: 'pB' }], createdAt: minutes(-5000), contactAttempts: noAnswer(-900) }),
    ];
    const boost = priorityBoostOf([rule('b', { productId: 'pB' })], { companyId: 'c1', storeId: 's1', now: NOW, timezone: 'UTC' })!;
    expect(await pickNow({ mode: 'NORMAL', backlogTurn: true, boost })).toBe('fresh-x');
    world.orders[0].claimedById = 'huda';
    expect(await pickNow({ mode: 'NORMAL', backlogTurn: true, boost })).toBe('aged-x');
  });

  it('a boosted retry that is NOT aged never passes an old new order when it is not the backlog\'s turn', async () => {
    world.orders = [
      plainOrder('new-x', { createdAt: minutes(-600) }),
      plainOrder('retry-x', { confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS', items: [{ productId: 'pB' }], createdAt: minutes(-5000), contactAttempts: noAnswer(-30) }),
    ];
    const boost = priorityBoostOf([rule('b', { productId: 'pB' })], { companyId: 'c1', storeId: 's1', now: NOW, timezone: 'UTC' })!;
    expect(await pickNow({ mode: 'NORMAL', backlogTurn: false, boost })).toBe('new-x');
    expect(await pickNow({ mode: 'NORMAL', backlogTurn: true, boost })).toBe('retry-x');
  });

  it('a boosted new order never passes a promise; a boosted promise is not reordered either', async () => {
    const rows: Row[] = [
      plainOrder('fresh-y', { createdAt: minutes(-2), items: [{ productId: 'pB' }] }),
      plainOrder('promise-a', { confirmationStatus: 'POSTPONED', status: 'POSTPONED', postponedUntil: minutes(-60), contactAttempts: asked }),
      plainOrder('promise-b', { confirmationStatus: 'POSTPONED', status: 'POSTPONED', postponedUntil: minutes(-10), items: [{ productId: 'pB' }], contactAttempts: asked }),
    ];
    const boost = priorityBoostOf([rule('b', { productId: 'pB' })], { companyId: 'c1', storeId: 's1', now: NOW, timezone: 'UTC' })!;
    world.orders = rows;
    expect(await pickNow({ mode: 'NORMAL', backlogTurn: false, boost })).toBe('promise-a');
    world.orders.find((o) => o.id === 'promise-a')!.claimedById = 'huda';
    expect(await pickNow({ mode: 'NORMAL', backlogTurn: false, boost })).toBe('promise-b');
  });

  it('the two time-of-day modes are main\'s: the boost is not even asked', async () => {
    const boost = priorityBoostOf([rule('b', { productId: 'pB' })], { companyId: 'c1', storeId: 's1', now: NOW, timezone: 'UTC' })!;
    for (const mode of ['NIGHT_FIRST', 'PEAK_NEW_FIRST'] as const) {
      const a = await dealAll(pool(9), { mode, backlogTurn: true, boost });
      const b = await dealAll(pool(9), { mode, backlogTurn: true });
      expect(a).toEqual(b);
    }
  });
});

describe('the filter answers what the resolver answers', () => {
  it('for random rules and orders: «matches the filter of its phase» ≡ ruleFor(...).first — or the phase is all-or-nothing', () => {
    let checked = 0;
    for (const seed of Array.from({ length: 300 }, (_, i) => i + 1)) {
      const list = rules(seed);
      const at = new Date(NOW.getTime() + (seed % 24) * 3_600_000);
      const boost: PriorityBoost = priorityBoostOf(list, { companyId: 'c1', storeId: 's1', now: at, timezone: 'UTC' }) ?? {};
      const byPhase = new Map<string, boolean[]>();
      for (const o of pool(seed + 1000)) {
        const phase = o.contactAttempts.length > 0 ? 'RETRY' : 'NEW';
        const order = { storeId: 's1', productIds: o.items.map((i: Row) => i.productId), channelKind: o.channel?.kind ?? null, phase: phase as 'NEW' | 'RETRY' };
        const truth = ruleFor({ person: { id: '', storeId: 's1' }, order, now: at }, { companyId: 'c1', base: CONFIRMATION_RULE_DEFAULT, timezone: 'UTC', rules: list }).first.value;
        const where = boost[phase as 'NEW' | 'RETRY'];
        if (where) expect(matches(o, where as Row), `seed ${seed} ${o.id}`).toBe(truth);
        else byPhase.set(phase, [...(byPhase.get(phase) ?? []), truth]);
        // The postponed tier's filter holds both phases.
        if (boost.ANY) expect(matches(o, boost.ANY as Row)).toBe(truth);
        checked += 1;
      }
      for (const truths of byPhase.values()) expect(new Set(truths).size).toBeLessThanOrEqual(1);
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('a timezone the runtime cannot read leaves out the rules WITH hours, never the rest', () => {
    const list = [rule('h', { productId: 'pA', hoursFrom: '00:00', hoursTo: '23:59' }), rule('p', { productId: 'pB' })];
    const boost = priorityBoostOf(list, { companyId: 'c1', storeId: 's1', now: NOW, timezone: 'Not/AZone' })!;
    expect(boost.NEW).toEqual({ items: { some: { productId: 'pB' } } });
    expect(priorityBoostOf([list[0]], { companyId: 'c1', storeId: 's1', now: NOW, timezone: null })).toBeNull();
  });

  it('a rule of the whole NEW phase reorders the postponed tier only (new ones before rung ones), never the single-phase tiers', () => {
    const boost = priorityBoostOf([rule('n', { phase: 'NEW' })], { companyId: 'c1', storeId: 's1', now: NOW, timezone: 'UTC' })!;
    expect(boost).toEqual({ ANY: { contactAttempts: { none: {} } } });
  });
});

describe('the pull reads the rules once, and the desk imports nothing new', () => {
  it('priorityPlanFor with the pull\'s reader asks the rules table nothing; the plan carries the boost the rules make', async () => {
    vi.resetModules();
    vi.doMock('./queue-priority-switch', () => ({ queuePrioritySwitch: async () => ({ enabled: true, enabledAt: new Date(0) }) }));
    vi.doMock('./queue-priority-share', () => ({ readBacklogShare: async () => ({ result: { share: 0.37 }, inputs: {}, note: '' }), recentPullLanes: async () => [] }));
    const q = await import('./confirmation-queue');
    const client = { confirmationRule: { findMany: vi.fn(async () => []) } };
    const at = new Date('2026-11-12T13:00:00.000Z');
    const list = [rule('b', { productId: 'pB' })];
    const plan = await q.priorityPlanFor(client as never, scope, 'sara', CAL as never, at, undefined, async () => list);
    expect(client.confirmationRule.findMany).not.toHaveBeenCalled();
    expect(plan).toEqual({ mode: 'NORMAL', backlogTurn: false, boost: priorityBoostOf(list, { companyId: 'c1', storeId: 's1', now: at, timezone: 'UTC' }) });
    const none = await q.priorityPlanFor(client as never, scope, 'sara', CAL as never, at, undefined, async () => []);
    expect(none).toEqual({ mode: 'NORMAL', backlogTurn: false });
    vi.doUnmock('./queue-priority-switch');
    vi.doUnmock('./queue-priority-share');
  });

  it('the pull hands its one reader of the rules to the plan', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'confirmation-queue.ts'), 'utf8');
    expect(src).toMatch(/const priority = await priorityPlanFor\(db, scope, user\.id, cal, now, rule, rules\);/);
    expect(priorityPlanFor.length).toBeGreaterThanOrEqual(5);
  });

  it('«طلباتي» reaches neither the rules nor this file through a static import', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const SPEC = /^\s*(?:import|export)\s+(type\s+)?([^;]*?)\s+from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm;
    const resolveSpec = (from: string, spec: string): string | null => {
      const base = spec.startsWith('@/') ? join(root, 'src', spec.slice(2)) : spec.startsWith('.') ? resolve(dirname(from), spec) : null;
      if (!base) return null;
      for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx', '']) if (existsSync(base + ext) && /\.(tsx?)$/.test(base + ext)) return base + ext;
      return null;
    };
    const start = join(root, 'src', 'components', 'screens', 'ConfirmationMineScreen.tsx');
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const f = queue.shift()!;
      for (const m of readFileSync(f, 'utf8').matchAll(SPEC)) {
        if (m[1]) continue;
        const names = m[2]?.trim();
        if (names && /^\{[^}]*\}$/.test(names) && names.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean).every((n) => n.startsWith('type '))) continue;
        const next = resolveSpec(f, m[3] ?? m[4]);
        if (next && !seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    const names = [...seen].map((f) => f.replace(/\\/g, '/').split('/src/lib/')[1]).filter(Boolean);
    expect(seen.size).toBeGreaterThan(50);
    for (const banned of ['priority-rules.ts', 'confirmation-rules.ts', 'employee-numbers.ts', 'confirmation-queue.ts']) expect(names).not.toContain(banned);
  });
});
