import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

/**
 * ═════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — «هالطلبات بس لهالموظفات»: THE OWNER'S ROUTING RULES DECIDE WHO MAY PULL AN ORDER (request Q5b of the rules plan, 21/11)
 *
 *  1. ZERO RULES = TODAY: with no ROUTING rule in force (none, other kinds, another store or company, stopped, out of dates or hours, broken, or every one naming the
 *     puller) the filter is null, no roster is read, and the pick is main's — the same order AND the same statements over random pools (the frozen golden
 *     `routing-rules-never-strand-an-order.main-golden.json`, written by osm/main's `confirmation-queue.ts`).
 *  2. THE FILTER ANSWERS WHAT THE RESOLVER ANSWERS: for random rules, rosters, pullers, orders and moments, «the order passes her filter» ≡ the rule `ruleFor` picks
 *     for the order names her, or nobody it names can pull and the order is past that rule's fallback — the products matched both ways (a line, or the header of an
 *     order with no lines).
 *  3. NO ORDER NOBODY MAY TAKE: every order of every random pool passes the filter of somebody who can pull — now, or once its rule's fallback has passed. Rosters
 *     are built as a session builds them (`resolveAudience` → `computeEffectiveGrants` → `can` → `deskReadiness`): all named people inactive, one deactivated mid-way,
 *     one losing the pull key by a personal «منع», one in another store, a legacy account with no role row.
 *  4. THE PICK: her routed pick is main's pick over the pool without the orders she may not take — every tier, both orders.
 *  5. «طلبات بلا موظفة»: the board's count is the number of pool orders whose governing rule has nobody who can pull; absent with no routing rule.
 *  6. Where it does not act: what is held for her, the claim by number and «الزبون على الخط» keep today's rule; the desk («طلباتي») imports nothing new.
 *
 * Driven against an in-memory database that APPLIES its filters (the neighbouring pull tests' double, taught `items`, `channel`, `channelId` and `count`).
 * ═════════════════════════════════════════════════════════════════
 */

type Person = { id: string; role: string; roleId: string | null; status: string; companyId: string; stores: string[] };

const { world, calls } = vi.hoisted(() => ({
  world: {
    orders: [] as Row[],
    rules: [] as Row[],
    people: [] as Person[],
    roles: {} as Record<string, string[]>,
    templates: {} as Record<string, string[]>,
    overrides: [] as { userId: string; permission: string; effect: 'ALLOW' | 'DENY' }[],
  },
  calls: { n: 0, roster: 0 },
}));

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
      const found = sorted(world.orders.filter((r) => matches(r, where ?? {})), orderBy);
      return (take ? found.slice(0, take) : found).map((r) => ({ ...r }));
    }),
    findFirst: vi.fn(async ({ where, orderBy }: Row) => {
      calls.n += 1;
      const hit = sorted(world.orders.filter((r) => matches(r, where ?? {})), orderBy)[0];
      return hit ? { ...hit } : null;
    }),
    count: vi.fn(async ({ where }: Row) => {
      calls.n += 1;
      return world.orders.filter((r) => matches(r, where ?? {})).length;
    }),
  };
  const pick = (where: Row) =>
    world.people.filter(
      (p) => (where.companyId === undefined || p.companyId === where.companyId) && (where.status === undefined || p.status === where.status) && (where.id?.in === undefined || where.id.in.includes(p.id))
    );
  const db = {
    order,
    confirmationRule: { findMany: vi.fn(async () => world.rules) },
    user: {
      findMany: vi.fn(async ({ where }: Row) => {
        calls.roster += 1;
        return pick(where).map((p) => ({ id: p.id, name: p.id, email: `${p.id}@x`, role: p.role, roleId: p.roleId, status: p.status, companyId: p.companyId }));
      }),
    },
    userPermission: {
      findMany: vi.fn(async ({ where }: Row) =>
        world.overrides
          .filter((o) => (where.userId?.in ?? [where.userId]).includes(o.userId))
          .map((o) => ({ userId: o.userId, permission: o.permission, effect: o.effect, scope: o.effect === 'ALLOW' ? 'ALL_COMPANY' : null, scopeIds: null }))
      ),
    },
    rolePermission: {
      findMany: vi.fn(async ({ where }: Row) => {
        const keys = where.roleId ? world.roles[where.roleId] ?? [] : world.templates[where.role?.name] ?? [];
        return keys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null }));
      }),
    },
  };
  return { db, default: db };
});
vi.mock('./geo-context', () => ({
  usersReachingStore: async (users: { id: string }[], companyId: string, storeId: string) =>
    new Set(users.filter((u) => world.people.find((p) => p.id === u.id && p.companyId === companyId)?.stores.includes(storeId)).map((u) => u.id)),
}));

import { RETURNS_MODE, duePostponedWhere, pickNextCandidate, readyToPullWhere, type PriorityPlan } from './confirmation-queue';
import { ROUTING_FALLBACK, ruleFor, validateRulePayload, type ConfirmationRuleRow } from './confirmation-rules';
import { CONFIRMATION_RULE_DEFAULT } from './confirmation-rule-settings';
import { returnsMode } from './no-answer-returns';
import { workClock } from './no-answer-rounds';
import { fallbackCut, routingRulesInForce, routingWhereFor, routingWhereForPuller } from './routing-rules';
import { readRoutingStaff } from './routing-staff';
import { readUnstaffedOrders } from './routing-health';
import { forgetConfirmationRules } from './employee-numbers';
import { attachGrants, can } from './authorization';
import { computeEffectiveGrants } from './permissions-core';
import { db } from './db';

const NOW = new Date('2026-11-12T12:00:00.000Z');
const SINCE = new Date('2026-11-01T08:00:00.000Z');
const scope = { companyId: 'c1', storeId: 's1' };
const CAL = { workHoursStart: '00:00', workHoursEnd: '23:59', weekendDays: [] as number[], timezone: 'UTC' };
const CADENCE = returnsMode(NOW, workClock(CAL), RETURNS_MODE.idleBusinessMinutes, SINCE);
const minutes = (m: number, from: Date = NOW) => new Date(from.getTime() + m * 60_000);

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
const PEOPLE = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'];
type Kind = 'promise' | 'fresh' | 'new' | 'aged' | 'retry' | 'waiting' | 'postponed';

/** One random pool: orders of every kind; a line product (some with no line rows: the header product), maybe a channel, ages around the fallbacks. */
function pool(seed: number): Row[] {
  const r = prng(seed);
  const pickOf = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const n = 4 + Math.floor(r() * 10);
  const out: Row[] = [];
  for (let i = 0; i < n; i++) {
    const kind = pickOf<Kind>(['promise', 'fresh', 'new', 'new', 'aged', 'retry', 'waiting', 'postponed']);
    const createdAgo = kind === 'fresh' ? 1 + Math.floor(r() * 13) : 20 + Math.floor(r() * 900);
    const header = pickOf(PRODUCTS);
    const items = r() < 0.2 ? [] : [{ productId: pickOf(PRODUCTS) }, ...(r() < 0.3 ? [{ productId: pickOf(PRODUCTS) }] : [])];
    const channel = r() < 0.6 ? { kind: pickOf(KINDS) } : null;
    const line = (pressedAgo: number, result: string, dueIn: number | null) => ({
      createdAt: minutes(-pressedAgo), result, nextFollowUpAt: dueIn === null ? null : minutes(dueIn), employeeId: 'x', attemptNumber: 1,
    });
    const base: Row = {
      id: `${kind}-${seed}-${String(i).padStart(2, '0')}`, ...scope, customerId: `cust-${seed}-${i}`, productId: header,
      confirmationStatus: 'NEW', status: 'NEW', shippingStatus: 'NOT_READY', claimedById: null, claimedAt: null, currentOwnerId: null,
      assignedToId: null, assignedAt: null, assignee: null, postponedUntil: null, nextFollowUpAt: null,
      createdAt: minutes(-createdAgo), version: 1, contactAttempts: [], claimHistory: [], items, channel, channelId: channel ? `ch-${channel.kind}` : null,
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
  id, companyId: 'c1', storeId: null, name: id, kind: 'ROUTING', userIds: null, productId: null, channelKind: null, phase: null, hoursFrom: null, hoursTo: null,
  effectiveFrom: new Date('2026-11-01T00:00:00.000Z'), effectiveTo: null, isActive: true, payload: { toUserIds: ['u1'] }, createdAt: new Date('2026-11-01T00:00:00.000Z'), ...over,
});

/** Random ROUTING rules (and a few that never act): product, channel, phase, hours, store, people (some unknown ids), their own fallback or the default. */
function rules(seed: number): ConfirmationRuleRow[] {
  const r = prng(seed * 7 + 3);
  const pickOf = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const n = 1 + Math.floor(r() * 4);
  return Array.from({ length: n }, (_, i) => {
    const over: Partial<ConfirmationRuleRow> = {};
    if (r() < 0.6) over.productId = pickOf(PRODUCTS);
    if (r() < 0.35) over.channelKind = pickOf(KINDS);
    if (r() < 0.3) over.phase = pickOf(['NEW', 'RETRY']);
    if (r() < 0.2) Object.assign(over, pickOf([{ hoursFrom: '10:00', hoursTo: '14:00' }, { hoursFrom: '20:00', hoursTo: '06:00' }]));
    if (r() < 0.15) over.storeId = pickOf(['s1', 's2']);
    if (r() < 0.08) over.isActive = false;
    if (r() < 0.05) over.kind = 'PRIORITY';
    const people = [...new Set(Array.from({ length: 1 + Math.floor(r() * 3) }, () => pickOf([...PEOPLE, 'gone-1'])))];
    over.payload = { toUserIds: people, ...(r() < 0.6 ? { fallbackMinutes: pickOf([5, 30, 120, 480]) } : {}) };
    if (over.kind === 'PRIORITY') over.payload = { first: true };
    over.createdAt = new Date(Date.UTC(2026, 10, 1, 0, i));
    return rule(`rule-${seed}-${i}`, over);
  });
}

/** The agent template: the keys the desk needs. A supervisor watches (no pull). A custom role row by id. */
const AGENT = ['confirmation.work', 'confirmation.pull', 'orders.confirm', 'orders.contact_log', 'orders.claim', 'orders.view'];
const WATCHER = ['confirmation.supervise', 'orders.view'];

/** A random roster of the six people, built from role rows, a legacy account (no roleId), personal ALLOW / DENY and the store each reaches. */
function roster(seed: number): void {
  const r = prng(seed * 13 + 5);
  world.templates = { CONFIRMATION_AGENT: AGENT, MANAGER: WATCHER };
  world.roles = { 'r-agent': AGENT, 'r-watch': WATCHER };
  world.overrides = [];
  world.people = PEOPLE.map((id) => {
    const legacy = r() < 0.25;
    const p: Person = {
      id,
      role: r() < 0.8 ? 'CONFIRMATION_AGENT' : 'MANAGER',
      roleId: legacy ? null : r() < 0.8 ? 'r-agent' : 'r-watch',
      status: r() < 0.8 ? 'ACTIVE' : 'INACTIVE',
      companyId: 'c1',
      stores: r() < 0.85 ? ['s1'] : ['s2'],
    };
    if (r() < 0.15) world.overrides.push({ userId: id, permission: 'confirmation.pull', effect: 'DENY' });
    if (r() < 0.1) world.overrides.push({ userId: id, permission: 'confirmation.pull', effect: 'ALLOW' });
    return p;
  });
}

/** The INDEPENDENT truth of «can pull in s1»: each person built by the real engine straight from the rows (not through `resolveAudience` / `staffOf`). */
async function canPullNow(): Promise<Set<string>> {
  const out = new Set<string>();
  for (const p of world.people) {
    if (p.status !== 'ACTIVE' || p.companyId !== 'c1' || !p.stores.includes('s1')) continue;
    const session = { id: p.id, name: p.id, email: `${p.id}@x`, role: p.role, status: p.status, companyId: p.companyId, permissions: [] } as unknown as SessionUser;
    const grants = await computeEffectiveGrants(
      { id: p.id, role: p.role, roleId: p.roleId },
      {
        roleRows: async () => (p.roleId ? world.roles[p.roleId] ?? [] : world.templates[p.role] ?? []).map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
        overrideRows: async () =>
          world.overrides.filter((o) => o.userId === p.id).map((o) => ({ permission: o.permission, effect: o.effect, scope: o.effect === 'ALLOW' ? 'ALL_COMPANY' : null, scopeIds: null })),
      }
    );
    if (can(attachGrants(session, grants), 'confirmation.pull')) out.add(p.id);
  }
  return out;
}

/** The phase of an order: rung once = RETRY. */
const phaseOf = (o: Row) => (o.contactAttempts.length > 0 ? ('RETRY' as const) : ('NEW' as const));
/** The order as the resolver asks it — the lines, else the header product (`ruleOrderOf`). */
const ruleOrder = (o: Row) => ({
  storeId: o.storeId as string,
  productIds: (o.items.length ? [...new Set<string>(o.items.map((i: Row) => i.productId as string))] : [o.productId as string]) as string[],
  channelKind: o.channel?.kind ?? null,
  phase: phaseOf(o),
});

/** THE ORACLE: may `userId` take `o` at `at`? From `ruleFor` over every row (the rule it picks for the order), the independent roster and the calendar. */
function mayTake(o: Row, userId: string, list: readonly ConfirmationRuleRow[], staff: ReadonlySet<string>, at: Date): boolean {
  const eff = ruleFor({ person: { id: '', storeId: 's1' }, order: ruleOrder(o), now: at }, { companyId: 'c1', base: CONFIRMATION_RULE_DEFAULT, timezone: CAL.timezone, rules: list });
  if (eff.onlyFor.value === null) return true;
  if (eff.onlyFor.value.includes(userId)) return true;
  if (eff.onlyFor.value.some((u) => staff.has(u))) return false;
  const src = eff.onlyFor.source;
  const winner = list.find((r) => src.from === 'RULE' && r.id === src.ruleId)!;
  const fallback = (winner.payload as Row).fallbackMinutes ?? ROUTING_FALLBACK.defaultMinutes;
  return o.createdAt.getTime() <= at.getTime() - fallback * 60_000;
}

const PLANS: (PriorityPlan | null)[] = [
  null,
  { mode: 'NORMAL', backlogTurn: false },
  { mode: 'NORMAL', backlogTurn: true },
  { mode: 'NIGHT_FIRST', backlogTurn: false },
];

async function pickNow(plan: PriorityPlan | null, routing?: Row | null, userId = 'u1') {
  return pickNextCandidate(db as never, scope, NOW, userId, { heldForHerAsked: true, returns: CADENCE, priority: plan, ...(routing ? { routing } : {}) });
}

async function dealAll(rows: Row[], plan: PriorityPlan | null, routing?: Row | null): Promise<{ ids: string[]; statements: number[] }> {
  world.orders = rows.map((o) => ({ ...o, claimedById: null }));
  const ids: string[] = [];
  const statements: number[] = [];
  for (let i = 0; i < 40; i++) {
    calls.n = 0;
    const id = await pickNow(plan, routing);
    statements.push(calls.n);
    if (!id) break;
    ids.push(id);
    world.orders.find((o) => o.id === id)!.claimedById = 'u1';
  }
  return { ids, statements };
}

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'routing-rules-never-strand-an-order.main-golden.json');
const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);
const cutOf = fallbackCut(NOW, CAL);

/** The roster's cache is keyed by time: a read placed far in the past makes the next read at NOW (or later) a fresh one. */
let forgets = 0;
const forgetStaff = async () => {
  forgets += 1;
  await readRoutingStaff('c1', 's1', -forgets * 1e12);
};

beforeEach(async () => {
  await forgetStaff();
  world.orders = [];
  world.rules = [];
  calls.n = 0;
  calls.roster = 0;
  forgetConfirmationRules('c1');
});

describe('1 · zero rules = today: no filter, no roster, main\'s order and statements', () => {
  const NEVER: ConfirmationRuleRow[][] = [
    [],
    [rule('x', { kind: 'EMPLOYEE_NUMBERS', payload: { hand: 2 } })],
    [rule('x', { kind: 'PRIORITY', payload: { first: true }, productId: 'pA' })],
    [rule('x', { storeId: 's2', productId: 'pA', payload: { toUserIds: ['u2'] } })],
    [rule('x', { companyId: 'c2', payload: { toUserIds: ['u2'] } })],
    [rule('x', { isActive: false, payload: { toUserIds: ['u2'] } })],
    [rule('x', { effectiveFrom: new Date('2026-11-13T00:00:00.000Z'), payload: { toUserIds: ['u2'] } })],
    [rule('x', { effectiveTo: new Date('2026-11-12T11:00:00.000Z'), payload: { toUserIds: ['u2'] } })],
    [rule('x', { hoursFrom: '13:00', hoursTo: '15:00', payload: { toUserIds: ['u2'] } })],
    [rule('x', { payload: { toUserIds: [] } })], // broken: names nobody
    [rule('x', { payload: { toUserIds: ['u2'], fallbackMinutes: 2 } })], // broken: a wait outside the range
    [rule('x', { userIds: ['u2'], payload: { toUserIds: ['u2'] } })], // broken: a «who» on a routing rule
    [rule('x', { productId: 'pA', payload: { toUserIds: ['u1'] } }), rule('y', { payload: { toUserIds: ['u1', 'u3'] } })], // every rule names the puller
  ];

  it('rules that do not act, or all name her, give NO filter — and the roster is never read', async () => {
    roster(1);
    for (const list of NEVER) {
      expect(routingWhereFor(routingRulesInForce(list, { ...scope, now: NOW, timezone: 'UTC' }), { userId: 'u1', staff: new Set(), cutOf })).toBeNull();
      expect(await routingWhereForPuller({ scope, userId: 'u1', cal: CAL, now: NOW, rules: async () => list })).toBeNull();
    }
    expect(calls.roster).toBe(0);
  });

  it('the deal of every random pool and plan, with no filter, is osm/main\'s — order and statements (the frozen golden)', async () => {
    const got: Record<string, { ids: string[]; statements: number[] }> = {};
    for (const seed of SEEDS) {
      for (const [k, plan] of PLANS.entries()) {
        const list = NEVER[seed % NEVER.length];
        const routing = routingWhereFor(routingRulesInForce(list, { ...scope, now: NOW, timezone: 'UTC' }), { userId: 'u1', staff: new Set(), cutOf });
        got[`${seed}/${k}`] = await dealAll(pool(seed), plan, routing);
      }
    }
    if (process.env.Q5B_WRITE_GOLDEN === '1') writeFileSync(GOLDEN, `${JSON.stringify(got, null, 1)}\n`);
    expect(existsSync(GOLDEN)).toBe(true);
    expect(got).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
  });
});

describe('2 · the filter answers what the resolver answers', () => {
  it('for random rules, rosters, pullers, orders and moments: «passes her filter» ≡ the oracle', async () => {
    let checked = 0;
    let kept = 0;
    let fellBack = 0;
    for (const seed of Array.from({ length: 200 }, (_, i) => i + 1)) {
      roster(seed);
      await forgetStaff();
      const list = rules(seed);
      const at = new Date(NOW.getTime() + (seed % 24) * 3_600_000);
      const truthStaff = await canPullNow();
      const staff = await readRoutingStaff('c1', 's1', at.getTime());
      // The roster the code reads (through `resolveAudience` and `deskReadiness`) is the engine's own answer.
      expect([...(staff ?? [])].sort(), `seed ${seed}`).toEqual([...truthStaff].sort());
      const inForce = routingRulesInForce(list, { ...scope, now: at, timezone: 'UTC' });
      for (const userId of [...PEOPLE, 'stranger']) {
        const where = routingWhereFor(inForce, { userId, staff, cutOf: fallbackCut(at, CAL) });
        for (const o of pool(seed + 1000)) {
          const truth = mayTake(o, userId, list, truthStaff, at);
          expect(where === null ? true : matches(o, where), `seed ${seed} ${userId} ${o.id}`).toBe(truth);
          if (!truth) kept += 1;
          checked += 1;
          const eff = ruleFor({ person: { id: '', storeId: 's1' }, order: ruleOrder(o), now: at }, { companyId: 'c1', base: CONFIRMATION_RULE_DEFAULT, timezone: 'UTC', rules: list });
          if (truth && eff.onlyFor.value && !eff.onlyFor.value.includes(userId)) fellBack += 1;
        }
      }
    }
    // Not vacuous: orders were kept from people, and some went to everyone by the fallback.
    expect(checked).toBeGreaterThan(5000);
    expect(kept).toBeGreaterThan(500);
    expect(fellBack).toBeGreaterThan(100);
  });

  it('the product is matched both ways: a line of it, or the header of an order with no lines — never the header of an order whose lines are others', () => {
    const inForce = routingRulesInForce([rule('p', { productId: 'pA', payload: { toUserIds: ['u2'] } })], { ...scope, now: NOW, timezone: 'UTC' });
    const where = routingWhereFor(inForce, { userId: 'u1', staff: new Set(['u2']), cutOf })!;
    const o = (over: Row) => ({ ...pool(1)[0], createdAt: minutes(-10_000), ...over });
    expect(matches(o({ productId: 'pA', items: [] }), where)).toBe(false); // header pA, no lines: pA's
    expect(matches(o({ productId: 'pA', items: [{ productId: 'pB' }] }), where)).toBe(true); // lines say pB: not pA's
    expect(matches(o({ productId: 'pB', items: [{ productId: 'pB' }, { productId: 'pA' }] }), where)).toBe(false); // a line of pA
    expect(matches(o({ productId: 'pB', items: [] }), where)).toBe(true);
  });

  it('an order with no channel is of no channel; the more specific rule wins over the store-wide one', () => {
    const list = [rule('store', { payload: { toUserIds: ['u2'] } }), rule('wa', { channelKind: 'WHATSAPP', payload: { toUserIds: ['u1'] } })];
    const inForce = routingRulesInForce(list, { ...scope, now: NOW, timezone: 'UTC' });
    expect(inForce.map((r) => r.id)).toEqual(['wa', 'store']);
    const where = routingWhereFor(inForce, { userId: 'u1', staff: new Set(['u2']), cutOf })!;
    const o = (over: Row) => ({ ...pool(1)[0], createdAt: NOW, ...over });
    expect(matches(o({ channel: { kind: 'WHATSAPP' }, channelId: 'ch-w' }), where)).toBe(true);
    expect(matches(o({ channel: null, channelId: null }), where)).toBe(false);
    expect(matches(o({ channel: { kind: 'FACEBOOK' }, channelId: 'ch-f' }), where)).toBe(false);
  });

  it('a clock that cannot be read leaves out the rules WITH hours, never the rest', () => {
    const list = [rule('h', { productId: 'pA', hoursFrom: '00:00', hoursTo: '23:59' }), rule('p', { productId: 'pB' })];
    expect(routingRulesInForce(list, { ...scope, now: NOW, timezone: 'Not/AZone' }).map((r) => r.id)).toEqual(['p']);
    expect(routingRulesInForce([list[0]], { ...scope, now: NOW, timezone: null })).toEqual([]);
  });

  it('the wait is in WORKING minutes of the store; a calendar with no working time still ends it (wall-clock)', () => {
    const work = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [] as number[], timezone: 'UTC' };
    // 12:00 with a 09:00 opening: 30 working minutes back is 11:30; 300 working minutes back is 180 today and 120 of the day before: 15:00.
    expect(fallbackCut(NOW, work)(30).toISOString()).toBe('2026-11-12T11:30:00.000Z');
    expect(fallbackCut(NOW, work)(300).toISOString()).toBe('2026-11-11T15:00:00.000Z');
    const never = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [0, 1, 2, 3, 4, 5, 6], timezone: 'UTC' };
    expect(fallbackCut(NOW, never)(30).toISOString()).toBe('2026-11-12T11:30:00.000Z');
    expect(fallbackCut(NOW, { ...work, timezone: 'Not/AZone' })(30).toISOString()).toBe('2026-11-12T11:30:00.000Z');
  });

  it('NEGATIVE: the wait is a number the validator holds to its range; absent, the default stands', () => {
    expect(validateRulePayload('ROUTING', { toUserIds: ['u1'] })).toEqual({ ok: true, payload: { toUserIds: ['u1'] } });
    expect(validateRulePayload('ROUTING', { toUserIds: ['u1'], fallbackMinutes: 45 })).toEqual({ ok: true, payload: { toUserIds: ['u1'], fallbackMinutes: 45 } });
    for (const bad of [4, 481, 30.5, '30', null]) expect(validateRulePayload('ROUTING', { toUserIds: ['u1'], fallbackMinutes: bad }).ok, String(bad)).toBe(false);
    expect(validateRulePayload('PRIORITY', { first: true, fallbackMinutes: 30 }).ok).toBe(false);
    const [r] = routingRulesInForce([rule('d', {})], { ...scope, now: NOW, timezone: 'UTC' });
    expect(r.fallbackMinutes).toBe(ROUTING_FALLBACK.defaultMinutes);
  });
});

describe('3 · no order nobody may take — random rules and rosters built as a session builds them', () => {
  it('every order passes the filter of somebody who can pull now, or of everybody who can once its rule\'s fallback has passed', async () => {
    let stranded = 0;
    let waited = 0;
    for (const seed of Array.from({ length: 300 }, (_, i) => i + 1)) {
      roster(seed);
      await forgetStaff();
      const list = rules(seed);
      const staff = await readRoutingStaff('c1', 's1', NOW.getTime());
      if (!staff || staff.size === 0) continue; // nobody can pull at all: nothing is pulled today either
      const later = minutes(ROUTING_FALLBACK.max + 1);
      for (const o of pool(seed + 2000)) {
        const nowOk = [...staff].some((u) => {
          const w = routingWhereFor(routingRulesInForce(list, { ...scope, now: NOW, timezone: 'UTC' }), { userId: u, staff, cutOf });
          return w === null || matches(o, w);
        });
        if (nowOk) continue;
        waited += 1;
        // The rules in force at the later moment (hours may end; the order is no younger): everybody who can pull may take it, or a named person can.
        const inLater = routingRulesInForce(list, { ...scope, now: later, timezone: 'UTC' });
        const laterOk = [...staff].some((u) => {
          const w = routingWhereFor(inLater, { userId: u, staff, cutOf: fallbackCut(later, CAL) });
          return w === null || matches(o, w);
        });
        if (!laterOk) stranded += 1;
      }
    }
    expect(stranded).toBe(0);
    expect(waited).toBeGreaterThan(0);
  });

  /** One rule: pA's orders only for u2 and u3. */
  const PA = [rule('pa', { productId: 'pA', payload: { toUserIds: ['u2', 'u3'], fallbackMinutes: 30 } })];
  const agentRoster = (over: Partial<Record<string, Partial<Person>>> = {}) => {
    world.templates = { CONFIRMATION_AGENT: AGENT };
    world.roles = { 'r-agent': AGENT };
    world.overrides = [];
    world.people = PEOPLE.map((id) => ({ id, role: 'CONFIRMATION_AGENT', roleId: 'r-agent', status: 'ACTIVE', companyId: 'c1', stores: ['s1'], ...over[id] }));
  };
  const paOrder = (ageMinutes: number): Row => ({ ...pool(1)[0], id: 'pa-order', productId: 'pA', items: [{ productId: 'pA' }], createdAt: minutes(-ageMinutes) });
  const mayU1 = async (o: Row, at: Date = NOW) => {
    const w = await routingWhereForPuller({ scope, userId: 'u1', cal: CAL, now: at, rules: async () => PA });
    return w === null || matches(o, w);
  };

  it('named people who can pull: only they take it, at any age', async () => {
    agentRoster();
    expect(await mayU1(paOrder(10))).toBe(false);
    expect(await mayU1(paOrder(10_000))).toBe(false);
    const w2 = await routingWhereForPuller({ scope, userId: 'u2', cal: CAL, now: NOW, rules: async () => PA });
    expect(w2 === null || matches(paOrder(10), w2)).toBe(true);
  });

  it('ALL named people inactive: the order waits its fallback, then anyone takes it', async () => {
    agentRoster({ u2: { status: 'INACTIVE' }, u3: { status: 'INACTIVE' } });
    expect(await mayU1(paOrder(10))).toBe(false);
    expect(await mayU1(paOrder(31))).toBe(true);
  });

  it('a named person deactivated mid-way: counted until the roster is read again (30 s), then the fallback acts', async () => {
    agentRoster({ u3: { status: 'INACTIVE' } });
    const o = paOrder(60);
    expect(await mayU1(o)).toBe(false); // u2 can pull: kept for her
    world.people.find((p) => p.id === 'u2')!.status = 'INACTIVE';
    expect(await mayU1(o, new Date(NOW.getTime() + 10_000))).toBe(false); // the cached roster still has her
    expect(await mayU1(o, new Date(NOW.getTime() + 31_000))).toBe(true); // read again: nobody named can pull, the order is past 30 minutes
  });

  it('a named person losing the pull key by a personal «منع», or moved to another store: she no longer counts', async () => {
    agentRoster({ u3: { stores: ['s2'] } });
    world.overrides.push({ userId: 'u2', permission: 'confirmation.pull', effect: 'DENY' });
    expect(await mayU1(paOrder(31))).toBe(true);
    expect(await mayU1(paOrder(10))).toBe(false);
  });

  it('a legacy account (no role row) named by the rule counts by her role\'s template', async () => {
    agentRoster({ u2: { roleId: null }, u3: { status: 'INACTIVE' } });
    expect(await mayU1(paOrder(10_000))).toBe(false);
  });

  it('a roster that cannot be read counts as nobody: the wait, then everyone', async () => {
    agentRoster();
    vi.mocked(db as unknown as { user: { findMany: ReturnType<typeof vi.fn> } }).user.findMany.mockRejectedValueOnce(new Error('down'));
    expect(await mayU1(paOrder(10))).toBe(false);
    await forgetStaff();
    vi.mocked(db as unknown as { user: { findMany: ReturnType<typeof vi.fn> } }).user.findMany.mockRejectedValueOnce(new Error('down'));
    expect(await mayU1(paOrder(31))).toBe(true);
  });

  it('a rules read that throws is today\'s pull (no filter)', async () => {
    expect(await routingWhereForPuller({ scope, userId: 'u1', cal: CAL, now: NOW, rules: async () => { throw new Error('down'); } })).toBeNull();
  });
});

describe('4 · the pick: her routed pick is main\'s pick over the pool without what she may not take', () => {
  it('every tier, both orders, random rules and rosters', async () => {
    let differed = 0;
    for (const seed of SEEDS) {
      roster(seed);
      await forgetStaff();
      const list = rules(seed);
      const staff = await readRoutingStaff('c1', 's1', NOW.getTime());
      const truthStaff = await canPullNow();
      const routing = routingWhereFor(routingRulesInForce(list, { ...scope, now: NOW, timezone: 'UTC' }), { userId: 'u1', staff, cutOf });
      for (const plan of PLANS) {
        const rows = pool(seed + 3000);
        const allowed = rows.filter((o) => mayTake(o, 'u1', list, truthStaff, NOW));
        const mine = await dealAll(rows, plan, routing);
        const main = await dealAll(allowed, plan, null);
        expect(mine.ids, `seed ${seed} ${JSON.stringify(plan)}`).toEqual(main.ids);
        if (allowed.length !== rows.length) differed += 1;
      }
    }
    expect(differed).toBeGreaterThan(20);
  });

  it('what is held for her is not routed: a returning customer\'s twin comes to the agent he spoke to', async () => {
    const o = { ...pool(1)[0], id: 'held', productId: 'pA', items: [{ productId: 'pA' }], assignedToId: 'u1', assignedAt: minutes(-5) };
    world.orders = [o];
    const routing = routingWhereFor(routingRulesInForce([rule('pa', { productId: 'pA', payload: { toUserIds: ['u2'] } })], { ...scope, now: NOW, timezone: 'UTC' }), {
      userId: 'u1', staff: new Set(['u2']), cutOf,
    })!;
    expect(matches(o, routing)).toBe(false);
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'confirmation-queue.ts'), 'utf8');
    // The pull asks what is held for her with no routing, and hands the filter only to the pick.
    expect(src).toMatch(/const hers = await pickHeldForHer\(tx, scope, user\.id, now\);/);
    expect(src).toMatch(/pickNextCandidate\(tx, scope, now, user\.id, \{ heldForHerAsked: true, returns, priority, \.\.\.\(routing \? \{ routing \} : \{\}\) \}\)/);
    expect(src).toMatch(/const routing = await routingWhereForPuller\(\{ scope, userId: user\.id, cal, now, rules \}\);/);
  });
});

describe('5 · «طلبات بلا موظفة» on the board', () => {
  it('counts the pool orders whose governing rule has nobody who can pull; absent with no routing rule', async () => {
    let counted = 0;
    for (const seed of Array.from({ length: 60 }, (_, i) => i + 1)) {
      roster(seed);
      await forgetStaff();
      forgetConfirmationRules('c1');
      world.rules = rules(seed);
      world.orders = pool(seed + 4000);
      // A colleague holds some of them: they are not waiting, so not counted.
      for (const o of world.orders) if (prng(seed)() < 0.3) o.claimedById = 'u4';
      const truthStaff = await canPullNow();
      const inPool = { OR: [readyToPullWhere(scope, undefined, NOW), duePostponedWhere(scope, NOW)] };
      // The oracle: the rule the resolver picks for the order names nobody who can pull.
      const expected = world.orders.filter((o) => {
        const eff = ruleFor({ person: { id: '', storeId: 's1' }, order: ruleOrder(o), now: NOW }, { companyId: 'c1', base: CONFIRMATION_RULE_DEFAULT, timezone: 'UTC', rules: world.rules as ConfirmationRuleRow[] });
        return matches(o, inPool) && eff.onlyFor.value !== null && !eff.onlyFor.value.some((u) => truthStaff.has(u));
      }).length;
      const inForce = routingRulesInForce(world.rules as ConfirmationRuleRow[], { ...scope, now: NOW, timezone: 'UTC' });
      const got = await readUnstaffedOrders(db as never, scope, CAL, NOW);
      if (inForce.length === 0) expect(got, `seed ${seed}`).toBeUndefined();
      else {
        expect(got, `seed ${seed}`).toBe(expected);
        if (expected > 0) counted += 1;
      }
    }
    expect(counted).toBeGreaterThan(5);
  });

  it('a hand-made case: three orders of pA, nobody of the rule active — three; one of them a colleague holds — two', async () => {
    world.templates = { CONFIRMATION_AGENT: AGENT };
    world.roles = { 'r-agent': AGENT };
    world.overrides = [];
    world.people = [{ id: 'u1', role: 'CONFIRMATION_AGENT', roleId: 'r-agent', status: 'ACTIVE', companyId: 'c1', stores: ['s1'] }];
    world.rules = [rule('pa', { productId: 'pA', payload: { toUserIds: ['u9'] } })];
    const o = (id: string, over: Row = {}) => ({ ...pool(1)[0], id, confirmationStatus: 'NEW', status: 'NEW', contactAttempts: [], postponedUntil: null, productId: 'pA', items: [{ productId: 'pA' }], ...over });
    world.orders = [o('a'), o('b'), o('c'), o('d', { productId: 'pB', items: [{ productId: 'pB' }] })];
    expect(await readUnstaffedOrders(db as never, scope, CAL, NOW)).toBe(3);
    world.orders[0].claimedById = 'u1';
    forgetConfirmationRules('c1');
    expect(await readUnstaffedOrders(db as never, scope, CAL, NOW)).toBe(2);
    world.people.push({ id: 'u9', role: 'CONFIRMATION_AGENT', roleId: 'r-agent', status: 'ACTIVE', companyId: 'c1', stores: ['s1'] });
    await forgetStaff();
    calls.n = 0;
    expect(await readUnstaffedOrders(db as never, scope, CAL, NOW)).toBe(0);
    expect(calls.n).toBe(0);
    world.rules = [];
    forgetConfirmationRules('c1');
    expect(await readUnstaffedOrders(db as never, scope, CAL, NOW)).toBeUndefined();
  });

  it('the board says the count only when a routing rule is in force', () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'api', 'confirmation', 'health', 'route.ts'), 'utf8');
    expect(src).toMatch(/readUnstaffedOrders\(db, \{ companyId, storeId \}, cal, now\)/);
    expect(src).toMatch(/unstaffed === undefined \? h : \{ \.\.\.h, unstaffed \}/);
  });
});

describe('6 · where routing does not act, and the desk', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  it('the claim by number and «الزبون على الخط» keep today\'s rule: neither door reads the routing rules', () => {
    for (const door of ['src/app/api/orders/[id]/claim/route.ts', 'src/app/api/confirmation/callback-take/route.ts', 'src/lib/customer-on-the-line.ts']) {
      expect(readFileSync(join(root, door), 'utf8'), door).not.toMatch(/routing-rules|routing-staff|routingWhere/);
    }
  });

  it('an empty pull under a routing rule says why, with the same code', () => {
    const src = readFileSync(join(root, 'src', 'lib', 'confirmation-queue.ts'), 'utf8');
    expect(src).toMatch(/code: 'QUEUE_EMPTY', message: routing \? ROUTED_EMPTY_MESSAGE : 'لا توجد طلبات بانتظار التأكيد الآن\.'/);
  });

  it('«طلباتي» reaches none of the routing files through a static import', () => {
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
    for (const banned of ['routing-rules.ts', 'routing-staff.ts', 'routing-health.ts', 'confirmation-queue.ts', 'confirmation-rules.ts']) expect(names).not.toContain(banned);
  });
});
