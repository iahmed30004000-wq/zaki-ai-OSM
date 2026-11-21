import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * REQUEST Q4b — «أرقام الموظفة» ACT: HER HAND LIMIT, HER IDLE MINUTES AND HER PULL PACE COME FROM THE OWNER'S RULES
 *
 * DEFINITION OF DONE (the row): the hand limit, the idle minutes and the pull pace come from `ruleFor(person)` at the pull, the claim by number, «الزبون على الخط», the
 * returning-customer hold and the idle release job (each holder's OWN minutes); the queue door and «افحص موظفة» show her numbers and their source. Zero rows ≡ today; a
 * rule for one person changes only her; the job never releases a colleague by another's minutes; the pull asks nothing new on a warm cache.
 *
 * Driven against an in-memory database that APPLIES the filters it is given (SQL's three values), like `the-idle-order-goes-back.test.ts`, with the plan «جدول
 * المحاولات» on (where the base rule's hand and idle minutes act). `employee-numbers-equal-main.test.ts` holds «zero rows = osm/main» against a frozen golden.
 * ═══════════════════════════════════════════════════════════════════════
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const { world, sw } = vi.hoisted(() => ({
  world: {
    orders: [] as Row[], history: [] as Row[], notices: [] as Row[], rules: [] as Row[], clock: new Date(), settings: '{}', timezone: 'UTC' as string | null,
    ruleReads: 0, storeReads: 0,
  },
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
  const order = {
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
      for (const r of hit) {
        for (const [k, v] of Object.entries(data)) r[k] = (v as Row)?.increment !== undefined ? (r[k] ?? 0) + (v as Row).increment : v;
      }
      return { count: hit.length };
    }),
  };
  const db = {
    order,
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
    // The owner's rules: the filter is applied, and every read is counted (the warm-cache question).
    confirmationRule: {
      findMany: vi.fn(async ({ where }: Row) => {
        world.ruleReads += 1;
        return world.rules.filter((r) => matches(r, where ?? {})).map((r) => ({ ...r }));
      }),
    },
    store: { findUnique: vi.fn(async () => ((world.storeReads += 1), { country: { timezone: world.timezone } })) },
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

import {
  CLAIM_CAPS,
  PULL_PACE,
  idleHeldWhere,
  idlePlanFor,
  pullNextOrder,
  pullPaceRefusal,
  readReturnsMode,
  releaseNoAnswerRounds,
  returnsLimits,
} from './confirmation-queue';
import { IDLE_RETURNED_REASON, handLimitMessage } from './no-answer-returns';
import { CONFIRMATION_RULE_DEFAULT, confirmationRuleOnce } from './confirmation-rule-settings';
import { PULL_PACE_RANGE, ruleFor, validateRulePayload, type ConfirmationRuleRow } from './confirmation-rules';
import {
  NOBODY_NAMED,
  confirmationRulesOnce,
  employeeNumbers,
  employeeNumbersOf,
  namedByRules,
  numbersAnswer,
  pullPaceOf,
  readConfirmationRules,
  sourceWords,
} from './employee-numbers';
import { db } from './db';

const NOW = new Date('2026-11-16T12:00:00.000Z'); // a Monday, inside the window below
const CAL = { workHoursStart: '08:00', workHoursEnd: '20:00', weekendDays: [] as number[], timezone: 'UTC' };
const minutesAgo = (m: number, from = NOW) => new Date(from.getTime() - m * 60_000);
const IDLE = CONFIRMATION_RULE_DEFAULT.idleMinutes; // 20
const HAND = CONFIRMATION_RULE_DEFAULT.hand; // 3

let companySeq = 0;
let CO = 'co-0';
const scope = () => ({ companyId: CO, storeId: 's1' });

let ruleSeq = 0;
const rule = (over: Partial<ConfirmationRuleRow> & { payload: unknown }): Row => {
  ruleSeq += 1;
  const r: Row = {
    id: `rule-${String(ruleSeq).padStart(3, '0')}`, companyId: CO, storeId: null, name: `قاعدة ${ruleSeq}`, kind: 'EMPLOYEE_NUMBERS', userIds: null, productId: null,
    channelKind: null, phase: null, hoursFrom: null, hoursTo: null, effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveTo: null, isActive: true,
    createdAt: new Date('2026-01-01T00:00:00Z'), ...over,
  };
  world.rules.push(r);
  return r;
};

let seq = 0;
/** An order in `holder`'s hand, claimed `minutes` ago, nothing logged (never rung unless `attempts`). */
const held = (holder: string, minutes: number, over: Row = {}): Row => {
  seq += 1;
  const r: Row = {
    id: `o${String(seq).padStart(4, '0')}`, orderNumber: `ORD-${seq}`, ...scope(), customerId: `cust${seq}`,
    confirmationStatus: 'IN_PROGRESS', status: 'IN_PROGRESS', shippingStatus: 'NOT_READY', shippingBatchId: null, trackingNumber: null, labelPrintedAt: null,
    claimedById: holder, claimedAt: minutesAgo(minutes), currentOwnerId: holder, signatureStatus: 'SIGNED', assignedToId: null, assignedAt: null, assignee: null,
    replacesOrderId: null, postponedUntil: null, nextFollowUpAt: null, createdAt: minutesAgo(600), version: 1, contactAttempts: [], claimHistory: [{ action: 'CLAIMED' }],
    ...over,
  };
  world.orders.push(r);
  return r;
};
/** An order nobody holds and nobody has rung: what a pull can take. */
const pool = (over: Row = {}) =>
  held('nobody', 0, { claimedById: null, claimedAt: null, currentOwnerId: null, confirmationStatus: 'NEW', status: 'NEW', claimHistory: [], createdAt: minutesAgo(300 + seq), ...over });
/** `n` orders in her hand, already rung a minute ago (so neither the untouched rule nor the idle release is about them). */
const holding = (who: string, n: number) => {
  for (let i = 0; i < n; i++) held(who, 5, { contactAttempts: [{ createdAt: minutesAgo(1), result: 'NO_ANSWER', employeeId: who, attemptNumber: 1, nextFollowUpAt: null }] });
};
const pulledBefore = (who: string, n: number) => {
  for (let i = 0; i < n; i++) world.history.push({ companyId: CO, orderId: `old-${i}`, userId: who, action: 'CLAIMED', reason: 'PULL_NEXT', createdAt: minutesAgo(10) });
};

/** The job's pass for this store, as `release-stale-claims.ts` runs it with the plan on. */
async function jobPass(now = NOW) {
  world.clock = now;
  const r = confirmationRuleOnce(db as never, CO, now.getTime());
  const rules = confirmationRulesOnce(db as never, CO, now.getTime());
  await rules();
  const returns = await readReturnsMode(db as never, CO, { now, calendar: () => CAL, rounds: OFF, rule: r });
  return releaseNoAnswerRounds(db as never, scope(), CAL, now, { rounds: OFF, returns, rule: r, rules });
}

beforeEach(() => {
  companySeq += 1;
  CO = `co-${companySeq}`;
  world.orders = [];
  world.history = [];
  world.notices = [];
  world.rules = [];
  world.settings = '{}';
  world.timezone = 'UTC';
  world.clock = NOW;
  world.ruleReads = 0;
  world.storeReads = 0;
  sw.plan = new Date('2026-11-01T00:00:00Z');
  vi.clearAllMocks();
});

/* ─────────────────────────── the numbers of one person ─────────────────────────── */

describe('her numbers, and where they came from', () => {
  const ctx = (rules: Row[], timezone: string | null = 'UTC') => ({ companyId: CO, base: CONFIRMATION_RULE_DEFAULT, timezone, rules: rules as ConfirmationRuleRow[] });
  const ask = (id: string, now = NOW) => ({ person: { id, storeId: 's1' }, now });

  it('no rule: the base numbers, «من القاعدة الأساسية», and the pace is the base 40', () => {
    const n = employeeNumbersOf(ask('sara'), ctx([]));
    expect(n).toEqual({
      hand: { value: HAND, source: { from: 'BASE' } },
      idleMinutes: { value: IDLE, source: { from: 'BASE' } },
      pullPerHour: { value: PULL_PACE.perHour, source: { from: 'BASE' } },
    });
    expect(numbersAnswer(n).hand.from).toBe('من القاعدة الأساسية');
  });

  it('a rule naming her changes HER three numbers; a colleague keeps the base', () => {
    const r = rule({ name: 'الموظفة الجديدة', userIds: ['sara'], payload: { hand: 2, idleMinutes: 40, pullPerHour: 15 } });
    const sara = employeeNumbersOf(ask('sara'), ctx([r]));
    expect([sara.hand.value, sara.idleMinutes.value, sara.pullPerHour.value]).toEqual([2, 40, 15]);
    expect(sourceWords(sara.hand.source)).toBe('من قاعدة «الموظفة الجديدة»');
    const huda = employeeNumbersOf(ask('huda'), ctx([r]));
    expect([huda.hand.value, huda.idleMinutes.value, huda.pullPerHour.value]).toEqual([HAND, IDLE, PULL_PACE.perHour]);
    expect(huda.hand.source).toEqual({ from: 'BASE' });
  });

  it('the person no rule names (NOBODY_NAMED) gets what everyone gets: a rule for everyone, never a named one', () => {
    const all = rule({ payload: { idleMinutes: 30 } });
    const named = rule({ userIds: ['sara'], payload: { idleMinutes: 10 } });
    expect(employeeNumbersOf(ask(NOBODY_NAMED), ctx([all, named])).idleMinutes.value).toBe(30);
    expect(employeeNumbersOf(ask('sara'), ctx([all, named])).idleMinutes.value).toBe(10);
    expect(namedByRules([all, named] as ConfirmationRuleRow[], CO)).toEqual(['sara']);
  });

  it('a rule with hours, in a timezone the runtime cannot read — or none — does not act, and nothing throws (Q4a review note)', () => {
    const night = rule({ hoursFrom: '00:00', hoursTo: '23:59', payload: { hand: 1 } });
    const plain = rule({ userIds: ['sara'], payload: { idleMinutes: 45 } });
    for (const tz of ['Not/AZone', null]) {
      const n = employeeNumbersOf(ask('sara'), ctx([night, plain], tz));
      expect(n.hand.value).toBe(HAND);
      expect(n.idleMinutes.value).toBe(45);
    }
    expect(() => ruleFor({ person: { id: 'sara', storeId: 's1' }, now: NOW }, { companyId: CO, base: CONFIRMATION_RULE_DEFAULT, timezone: 'Not/AZone', rules: [night as ConfirmationRuleRow] })).toThrow(RangeError);
    // A readable one: the rule acts inside its hours.
    expect(employeeNumbersOf(ask('sara'), ctx([night, plain], 'UTC')).hand.value).toBe(1);
  });

  it('the pace: a payload inside 10–80 is accepted, outside refused with an Arabic sentence; another kind may not carry it', () => {
    expect(validateRulePayload('EMPLOYEE_NUMBERS', { pullPerHour: PULL_PACE_RANGE.min }).ok).toBe(true);
    expect(validateRulePayload('EMPLOYEE_NUMBERS', { pullPerHour: PULL_PACE_RANGE.max }).ok).toBe(true);
    for (const bad of [PULL_PACE_RANGE.min - 1, PULL_PACE_RANGE.max + 1, 12.5, '20', null]) {
      const out = validateRulePayload('EMPLOYEE_NUMBERS', { pullPerHour: bad });
      expect(out).toMatchObject({ ok: false, field: 'payload.pullPerHour' });
      expect((out as { errorAr: string }).errorAr).toMatch(/سرعة السحب/);
    }
    expect(validateRulePayload('ORDER_NUMBERS', { pullPerHour: 20 }).ok).toBe(false);
    expect(validateRulePayload('EMPLOYEE_NUMBERS', { pullPerHour: 20, hand: 2 })).toEqual({ ok: true, payload: { pullPerHour: 20, hand: 2 } });
  });

  it('a stored rule whose pace is out of range is skipped: she keeps the base pace', () => {
    const broken = rule({ userIds: ['sara'], payload: { pullPerHour: 500 } });
    expect(employeeNumbersOf(ask('sara'), ctx([broken])).pullPerHour).toEqual({ value: PULL_PACE.perHour, source: { from: 'BASE' } });
  });
});

/* ─────────────────────────── the reader ─────────────────────────── */

describe('the rules are read once, through a thirty-second cache', () => {
  it('a warm cache asks nothing; the thirty-first second reads again', async () => {
    rule({ payload: { hand: 2 } });
    await readConfirmationRules(db as never, CO, NOW.getTime());
    expect(world.ruleReads).toBe(1);
    await readConfirmationRules(db as never, CO, NOW.getTime() + 29_999);
    expect(world.ruleReads).toBe(1);
    await readConfirmationRules(db as never, CO, NOW.getTime() + 30_000);
    expect(world.ruleReads).toBe(2);
  });

  it('only ACTIVE rows of THIS company are read', async () => {
    rule({ payload: { hand: 2 } });
    rule({ payload: { hand: 1 }, isActive: false });
    rule({ payload: { hand: 1 }, companyId: 'someone-else' });
    expect((await readConfirmationRules(db as never, CO, NOW.getTime())).map((r) => r.payload)).toEqual([{ hand: 2 }]);
  });

  it('a read that throws is «no rule» — never a half-read rule — and later the last good rows', async () => {
    vi.mocked(db.confirmationRule.findMany).mockRejectedValueOnce(new Error('down'));
    expect(await readConfirmationRules(db as never, CO, NOW.getTime())).toEqual([]);
    rule({ payload: { hand: 2 } });
    expect(await readConfirmationRules(db as never, CO, NOW.getTime() + 31_000)).toHaveLength(1);
    vi.mocked(db.confirmationRule.findMany).mockRejectedValueOnce(new Error('down'));
    expect(await readConfirmationRules(db as never, CO, NOW.getTime() + 62_000)).toHaveLength(1);
  });

  it('confirmationRulesOnce reads nothing until asked, then answers the same rows to every helper', async () => {
    const once = confirmationRulesOnce(db as never, CO, NOW.getTime());
    expect(world.ruleReads).toBe(0);
    const [a, b] = await Promise.all([once(), once()]);
    expect(a).toBe(b);
    expect(world.ruleReads).toBe(1);
  });

  it('the store\'s timezone is read only when a rule with hours exists and the caller did not hand one in', async () => {
    rule({ userIds: ['sara'], payload: { hand: 2 } });
    await employeeNumbers(db as never, CO, NOW.getTime(), CONFIRMATION_RULE_DEFAULT, { userId: 'sara', storeId: 's1' });
    expect(world.storeReads).toBe(0);
    rule({ userIds: ['sara'], hoursFrom: '00:00', hoursTo: '23:59', payload: { idleMinutes: 50 } });
    const later = NOW.getTime() + 31_000;
    expect((await employeeNumbers(db as never, CO, later, CONFIRMATION_RULE_DEFAULT, { userId: 'sara', storeId: 's1' })).idleMinutes.value).toBe(50);
    expect(world.storeReads).toBe(1);
    await employeeNumbers(db as never, CO, later, CONFIRMATION_RULE_DEFAULT, { userId: 'sara', storeId: 's1', timezone: 'UTC' });
    expect(world.storeReads).toBe(1);
  });
});

/* ─────────────────────────── the hand ─────────────────────────── */

describe('the hand limit is hers — where the base rule\'s hand acts', () => {
  const her = (userId: string) => ({ userId, storeId: 's1', timezone: 'UTC' });

  it('returnsLimits with her: a rule naming her changes HER hand; the store\'s figure (no her) and a colleague\'s are the base', async () => {
    rule({ userIds: ['sara'], payload: { hand: 2, idleMinutes: 35 } });
    expect(await returnsLimits(db as never, CO, NOW.getTime(), undefined, her('sara'))).toEqual({ handLimit: 2, idleBusinessMinutes: 35 });
    expect(await returnsLimits(db as never, CO, NOW.getTime(), undefined, her('huda'))).toEqual({ handLimit: HAND, idleBusinessMinutes: IDLE });
    expect(await returnsLimits(db as never, CO, NOW.getTime())).toEqual({ handLimit: HAND, idleBusinessMinutes: IDLE });
  });

  it('with the plan and «أولوية الطابور» both off the hand is RETURNS_MODE\'s, whatever a rule says — and the rules are not even read', async () => {
    sw.plan = null;
    rule({ userIds: ['sara'], payload: { hand: 1 } });
    expect((await returnsLimits(db as never, CO, NOW.getTime(), undefined, her('sara'))).handLimit).toBe(5);
    expect(world.ruleReads).toBe(0);
  });

  it('THE PULL: her rule of hand 1 refuses her with the hand\'s own sentence; a colleague holding the same one order pulls', async () => {
    rule({ name: 'جديدة', userIds: ['sara'], payload: { hand: 1 } });
    holding('sara', 1);
    holding('huda', 1);
    pool();
    pool();
    const sara = await pullNextOrder(scope(), { id: 'sara', role: 'CONFIRMATION_AGENT' }, CAL, NOW);
    expect(sara).toMatchObject({ ok: false, refusal: { code: 'CAP_TOTAL', message: handLimitMessage(1) } });
    const huda = await pullNextOrder(scope(), { id: 'huda', role: 'CONFIRMATION_AGENT' }, CAL, NOW);
    expect(huda.ok).toBe(true);
  });

  it('THE PULL with no rule: the same desk, the base hand of 3 — both pull', async () => {
    holding('sara', 1);
    pool();
    expect((await pullNextOrder(scope(), { id: 'sara', role: 'CONFIRMATION_AGENT' }, CAL, NOW)).ok).toBe(true);
  });

  it('a rule may RAISE her hand too: base 3 refuses at 3, her rule of 4 lets her pull the fourth', async () => {
    holding('sara', 3);
    holding('huda', 3);
    pool();
    pool();
    rule({ userIds: ['sara'], payload: { hand: 4 } });
    expect((await pullNextOrder(scope(), { id: 'sara', role: 'CONFIRMATION_AGENT' }, CAL, NOW)).ok).toBe(true);
    expect(await pullNextOrder(scope(), { id: 'huda', role: 'CONFIRMATION_AGENT' }, CAL, NOW)).toMatchObject({ ok: false, refusal: { code: 'CAP_TOTAL', message: handLimitMessage(HAND) } });
  });
});

/* ─────────────────────────── the pace ─────────────────────────── */

describe('the pull pace is hers — everywhere the pull asks it', () => {
  it('no rule: main\'s sentence, letter for letter, at 40', () => {
    const times = Array.from({ length: 40 }, () => minutesAgo(10));
    expect(pullPaceRefusal(times, NOW)?.message).toBe('سحبت 40 طلباً خلال آخر 60 دقيقة — الحد 40. اشتغل على اللي بإيدك، والسحب بيفتح بعد 50 دقيقة.');
    expect(pullPaceRefusal(times, NOW, 40)).toEqual(pullPaceRefusal(times, NOW));
    expect(pullPaceRefusal(times.slice(1), NOW)).toBeNull();
  });

  it('her pace of 10: the eleventh pull in the hour is refused, saying «الحد 10»; a colleague with ten pulls goes on', async () => {
    rule({ userIds: ['sara'], payload: { pullPerHour: 10 } });
    pulledBefore('sara', 10);
    pulledBefore('huda', 10);
    pool();
    pool();
    const sara = await pullNextOrder(scope(), { id: 'sara', role: 'CONFIRMATION_AGENT' }, CAL, NOW);
    expect(sara.refusal?.code).toBe('PULL_TOO_FAST');
    expect(sara.refusal?.message).toContain('الحد 10');
    expect((await pullNextOrder(scope(), { id: 'huda', role: 'CONFIRMATION_AGENT' }, CAL, NOW)).ok).toBe(true);
  });

  it('a rule may raise it: 40 pulls refuse the base, her 50 lets her pull — and the pace acts with the plan OFF too, as on main', async () => {
    sw.plan = null;
    rule({ userIds: ['sara'], payload: { pullPerHour: 50 } });
    pulledBefore('sara', 40);
    pulledBefore('huda', 40);
    pool();
    pool();
    expect((await pullNextOrder(scope(), { id: 'sara', role: 'CONFIRMATION_AGENT' }, CAL, NOW)).ok).toBe(true);
    expect((await pullNextOrder(scope(), { id: 'huda', role: 'CONFIRMATION_AGENT' }, CAL, NOW)).refusal?.code).toBe('PULL_TOO_FAST');
  });

  it('pullPaceOf with no employee rule does not read the base rule at all', async () => {
    const base = vi.fn(async () => CONFIRMATION_RULE_DEFAULT);
    expect(await pullPaceOf(db as never, CO, NOW.getTime(), { userId: 'sara', storeId: 's1' }, base)).toEqual({ value: 40, source: { from: 'BASE' } });
    expect(base).not.toHaveBeenCalled();
  });
});

/* ─────────────────────────── the idle release ─────────────────────────── */

describe('the idle release judges EACH holder by her own minutes', () => {
  it('her rule of 40: at 30 minutes her order stays and a colleague\'s (base 20) goes; at 45 both go', async () => {
    rule({ userIds: ['sara'], payload: { idleMinutes: 40 } });
    const hers = held('sara', 30);
    const his = held('huda', 30);
    expect(await jobPass()).toBe(1);
    expect(hers.claimedById).toBe('sara');
    expect(his.claimedById).toBeNull();
    // 15 minutes later: 45 for both.
    const later = new Date(NOW.getTime() + 15 * 60_000);
    expect(await jobPass(later)).toBe(1);
    expect(hers.claimedById).toBeNull();
  });

  it('her rule of 10: her 15-minute order goes, a colleague\'s 15-minute order stays — the release is by HER minutes, not the store\'s', async () => {
    rule({ userIds: ['sara'], payload: { idleMinutes: 10 } });
    const hers = held('sara', 15);
    const his = held('huda', 15);
    expect(await jobPass()).toBe(1);
    expect(hers.claimedById).toBeNull();
    expect(his.claimedById).toBe('huda');
  });

  it('each notice says the minutes HER order was released by', async () => {
    rule({ userIds: ['sara'], payload: { idleMinutes: 10 } });
    const hers = held('sara', 25);
    const his = held('huda', 25);
    expect(await jobPass()).toBe(2);
    const said = Object.fromEntries(world.notices.map((n) => [n.userId, n.message]));
    expect(said.sara).toBe(`رجع ${hers.orderNumber} للطابور: ما انسجّلت عليه أي محاولة خلال 10 دقيقة عمل`);
    expect(said.huda).toBe(`رجع ${his.orderNumber} للطابور: ما انسجّلت عليه أي محاولة خلال ${IDLE} دقيقة عمل`);
  });

  it('a store-wide rule for everyone (30) and a named one (10): the named holder by 10, everyone else by 30', async () => {
    rule({ storeId: 's1', payload: { idleMinutes: 30 } });
    rule({ userIds: ['sara'], payload: { idleMinutes: 10 } });
    const hers = held('sara', 15);
    const his = held('huda', 25);
    const old = held('noor', 31);
    expect(await jobPass()).toBe(2);
    expect([hers.claimedById, his.claimedById, old.claimedById]).toEqual([null, 'huda', null]);
  });

  it('a rule of ANOTHER store does not move this store\'s holders', async () => {
    rule({ storeId: 's9', payload: { idleMinutes: 10 } });
    const his = held('huda', 15);
    expect(await jobPass()).toBe(0);
    expect(his.claimedById).toBe('huda');
  });

  it('the write asks her own question again: a call logged after HER cut keeps her order', async () => {
    rule({ userIds: ['sara'], payload: { idleMinutes: 40 } });
    const hers = held('sara', 50, { contactAttempts: [{ createdAt: minutesAgo(35), result: 'OPENED', employeeId: 'sara' }] });
    // Nothing logged for 35 minutes is idle by the base 20 — but not by her 40.
    expect(await jobPass()).toBe(0);
    expect(hers.claimedById).toBe('sara');
  });

  it('and the write is judged by HER cut too: her rule of 10, a call twelve minutes ago — idle by her ten, released (the store\'s twenty would have kept it)', async () => {
    rule({ userIds: ['sara'], payload: { idleMinutes: 10 } });
    const hers = held('sara', 15, { contactAttempts: [{ createdAt: minutesAgo(12), result: 'OPENED', employeeId: 'sara' }] });
    expect(await jobPass()).toBe(1);
    expect(hers.claimedById).toBeNull();
  });

  it('the pull releases by the same plan: her 40 keeps her order inside a colleague\'s pull', async () => {
    rule({ userIds: ['sara'], payload: { idleMinutes: 40 } });
    const hers = held('sara', 30);
    const his = held('huda', 30);
    pool();
    const out = await pullNextOrder(scope(), { id: 'noor', role: 'CONFIRMATION_AGENT' }, CAL, NOW);
    expect(out.released).toBe(1);
    expect(hers.claimedById).toBe('sara');
    // His went back (and, a never-rung order being NEW again, may be the very one the pull handed out).
    expect(his.claimedById).not.toBe('huda');
    expect(world.history.filter((h) => h.reason === IDLE_RETURNED_REASON).map((h) => h.userId)).toEqual(['huda']);
  });

  it('no employee rule: no plan — the pass is main\'s one query, with main\'s where', async () => {
    rule({ kind: 'PRIORITY', productId: 'p1', payload: { first: true } });
    held('huda', 30);
    const returns = (await readReturnsMode(db as never, CO, { now: NOW, calendar: () => CAL, rounds: OFF }))!;
    expect(await idlePlanFor(db as never, scope(), returns, CAL, confirmationRuleOnce(db as never, CO, NOW.getTime()), confirmationRulesOnce(db as never, CO, NOW.getTime()))).toBeNull();
    vi.mocked(db.order.findMany).mockClear();
    expect(await jobPass()).toBe(1);
    const asked = vi.mocked(db.order.findMany).mock.calls.map(([a]) => (a as Row).where);
    expect(asked).toContainEqual(idleHeldWhere(scope(), returns));
  });

  it('with the plan and «أولوية الطابور» off (RETURNS_MODE\'s 30), a rule does not act: no plan', async () => {
    sw.plan = null;
    rule({ userIds: ['sara'], payload: { idleMinutes: 10 } });
    const fake = { now: NOW, readyCut: NOW, idleCut: minutesAgo(30) };
    expect(await idlePlanFor(db as never, scope(), fake as never, CAL, confirmationRuleOnce(db as never, CO, NOW.getTime()), confirmationRulesOnce(db as never, CO, NOW.getTime()))).toBeNull();
  });

  it('PROPERTY: 300 random desks and rule sets — an order goes back iff ITS holder\'s own minutes have passed, never by a colleague\'s', async () => {
    let s = 20261121;
    const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
    const people = ['a1', 'a2', 'a3', 'a4', 'a5'];
    for (let round = 0; round < 300; round++) {
      companySeq += 1;
      CO = `co-prop-${companySeq}`;
      world.orders = [];
      world.notices = [];
      world.history = [];
      world.rules = [];
      const n = Math.floor(rnd() * 4);
      for (let i = 0; i < n; i++) {
        const named = rnd() < 0.7 ? people.filter(() => rnd() < 0.4) : [];
        rule({
          userIds: named.length ? named : null,
          storeId: rnd() < 0.3 ? (rnd() < 0.5 ? 's1' : 's2') : null,
          payload: { idleMinutes: 10 + Math.floor(rnd() * 51) },
          effectiveFrom: new Date(`2026-01-0${1 + Math.floor(rnd() * 9)}T00:00:00Z`),
        });
      }
      const orders = Array.from({ length: 12 }, () => held(people[Math.floor(rnd() * people.length)], Math.floor(rnd() * 70)));
      const own = (id: string) =>
        ruleFor({ person: { id, storeId: 's1' }, now: NOW }, { companyId: CO, base: CONFIRMATION_RULE_DEFAULT, timezone: 'UTC', rules: world.rules as ConfirmationRuleRow[] }).idleMinutes.value;
      const expected = orders.map((o) => (NOW.getTime() - o.claimedAt.getTime()) / 60_000 >= own(o.claimedById));
      const holders = orders.map((o) => o.claimedById);
      await jobPass();
      expect(orders.map((o) => o.claimedById === null), `round ${round}`).toEqual(expected);
      // Every notice names the minutes of the holder it went to.
      for (const note of world.notices) expect(note.message).toContain(`خلال ${own(note.userId)} دقيقة عمل`);
      expect(world.history.filter((h) => h.reason === IDLE_RETURNED_REASON).map((h) => h.userId).sort()).toEqual(holders.filter((_, i) => expected[i]).sort());
    }
  });
});

/* ─────────────────────────── the warm path ─────────────────────────── */

describe('the pull asks nothing new on a warm cache', () => {
  it('a second pull inside thirty seconds reads the rules NOT AT ALL, with or without rules', async () => {
    for (const withRule of [false, true]) {
      companySeq += 1;
      CO = `co-warm-${companySeq}`;
      world.rules = [];
      if (withRule) rule({ userIds: ['sara'], payload: { hand: 2 } });
      pool();
      pool();
      await pullNextOrder(scope(), { id: 'huda', role: 'CONFIRMATION_AGENT' }, CAL, NOW);
      const reads = world.ruleReads;
      const company = vi.mocked(db.company.findUnique).mock.calls.length;
      await pullNextOrder(scope(), { id: 'sara', role: 'CONFIRMATION_AGENT' }, CAL, new Date(NOW.getTime() + 5_000));
      expect(world.ruleReads, `withRule=${withRule}`).toBe(reads);
      expect(vi.mocked(db.company.findUnique).mock.calls.length).toBe(company);
      expect(world.storeReads).toBe(0);
    }
  });

  it('the rules are read BEFORE the pull\'s transaction, never inside it', () => {
    const src = stripComments(readFileSync(join(process.cwd(), 'src/lib/confirmation-queue.ts'), 'utf8'));
    const pull = src.slice(src.indexOf('export async function pullNextOrder('));
    const tx = pull.indexOf('db.$transaction(');
    expect(pull.indexOf('confirmationRulesOnce(db,')).toBeGreaterThan(-1);
    expect(pull.indexOf('await rules();')).toBeLessThan(tx);
    expect(pull.indexOf('pullPaceOf(db,')).toBeLessThan(tx);
  });
});

/* ─────────────────────────── every door asks for HER ─────────────────────────── */

describe('every door that asks the hand names who asks', () => {
  const src = (p: string) => stripComments(readFileSync(join(process.cwd(), 'src', p), 'utf8'));
  it.each([
    ['app/api/orders/[id]/claim/route.ts', /returnsLimits\(db, companyId, Date\.now\(\), undefined, \{ userId: user\.id, storeId/],
    ['lib/customer-on-the-line.ts', /returnsLimits\(db, scope\.companyId, now\.getTime\(\), undefined, \{ userId: user\.id, storeId: scope\.storeId/],
    ['lib/reserve-returning-customers.ts', /returnsLimits\(db, scope\.companyId, now\.getTime\(\), rule, \{ userId: agent, storeId: scope\.storeId/],
    ['lib/confirmation-queue.ts', /returnsLimits\(db, scope\.companyId, now\.getTime\(\), rule, her\)/],
    ['app/api/confirmation/queue/route.ts', /returnsLimits\(db, companyId, now\.getTime\(\), rule, her\)/],
    ['app/api/confirmation/rules/check/route.ts', /returnsLimits\(db, companyId, now\.getTime\(\), rule, her\)/],
  ])('%s', (file, pattern) => {
    expect(src(file)).toMatch(pattern);
  });

  it('the pace is asked with HER number at the pull and at «افحص موظفة»', () => {
    expect(src('lib/confirmation-queue.ts')).toMatch(/pullPaceRefusal\(await recentPullTimes\(tx, user\.id, now\), now, perHour\)/);
    expect(src('app/api/confirmation/rules/check/route.ts')).toMatch(/pullPaceRefusal\(pulledAt, now, perHour\)/);
  });

  it('the release job hands the rules to the plan pass, read before its transaction', () => {
    const job = src('lib/jobs/definitions/release-stale-claims.ts');
    expect(job.match(/releaseNoAnswerRounds\(tx, scope, cal, now, \{[^}]*rules[^}]*\}\)/g)).toHaveLength(1);
    expect(job.indexOf('await rules();')).toBeLessThan(job.indexOf('rule, rules }'));
  });

  it('the desk imports nothing new: «طلباتي» does not import the rules, their reader or the queue', () => {
    const desk = readFileSync(join(process.cwd(), 'src/components/screens/ConfirmationMineScreen.tsx'), 'utf8');
    expect(desk).not.toMatch(/employee-numbers|confirmation-rules['"]|confirmation-queue['"]/);
  });

  it('the cap of 500 and the 40 untouched are untouched', () => {
    expect(CLAIM_CAPS).toEqual({ withoutAttempt: 40, total: 500 });
    expect(PULL_PACE).toEqual({ perHour: 40, windowMinutes: 60 });
  });
});
