import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { Prisma } from '@prisma/client';
import {
  CONFIRMATION_RULE_KINDS,
  CONFIRMATION_RULE_TEMPLATES,
  NUMBERS_OF_KIND,
  overlapRefusal,
  ruleFor,
  validateConfirmationRuleRow,
  validateRulePayload,
  type ConfirmationRuleRow,
  type RuleContext,
  type RuleOrder,
  type RulePerson,
  type ValidRule,
} from './confirmation-rules';
import { CONFIRMATION_RULE_DEFAULT, CONFIRMATION_RULE_RANGES, validateConfirmationRule, type ConfirmationRuleNumbers } from './confirmation-rule-settings';
import { CHANNEL_KINDS } from './order-channel-kinds';
import { STORE_TABLE_MODELS } from './geo-removal';

/**
 * «قواعد خاصة» (request Q4a, 20/11): the table and the resolver, INERT. What this file holds:
 *   · zero rules — or rules that do not apply — answer the base rule exactly, for any person, order, moment, time zone and base (seeded random scenarios);
 *   · most specific wins, number by number, whatever order the rows come in;
 *   · every kind has a validator, its numbers held to the BASE rule's ranges, and the amount of an order is no condition;
 *   · two active rules on the same level, number and target are refused at save — and only those;
 *   · the eight ready templates are data and valid; the migration writes no row; nothing deletes a rule; nothing calls the resolver yet.
 */

const COMPANY = 'co-1';
const T0 = new Date('2026-11-20T09:00:00.000Z');
let seq = 0;

function row(over: Partial<ConfirmationRuleRow> & Pick<ConfirmationRuleRow, 'kind' | 'payload'>): ConfirmationRuleRow {
  seq += 1;
  return {
    id: `r-${String(seq).padStart(4, '0')}`,
    companyId: COMPANY,
    storeId: null,
    name: `قاعدة ${seq}`,
    userIds: null,
    productId: null,
    channelKind: null,
    phase: null,
    hoursFrom: null,
    hoursTo: null,
    effectiveFrom: new Date('2026-11-01T00:00:00.000Z'),
    effectiveTo: null,
    isActive: true,
    createdAt: new Date('2026-11-01T00:00:00.000Z'),
    ...over,
  };
}

const ctx = (rules: ConfirmationRuleRow[], base: ConfirmationRuleNumbers = CONFIRMATION_RULE_DEFAULT, timezone = 'UTC'): RuleContext => ({ companyId: COMPANY, base, timezone, rules });
const AMAL: RulePerson = { id: 'u-a', storeId: 's-1' };
const BASMA: RulePerson = { id: 'u-b', storeId: 's-1' };
const order = (over: Partial<RuleOrder> = {}): RuleOrder => ({ storeId: 's-1', productIds: ['p-1'], channelKind: 'FACEBOOK', phase: 'NEW', ...over });
const valid = (r: ConfirmationRuleRow): ValidRule => {
  const c = validateConfirmationRuleRow(r);
  if (!c.ok) throw new Error(c.errorAr);
  return c.rule;
};

/* ── a seeded generator: the same scenarios on every run ── */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const R = CONFIRMATION_RULE_RANGES;

function randomBase(r: () => number): ConfirmationRuleNumbers {
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const steps = Array.from({ length: int(R.steps.min, R.steps.max) }, () =>
    r() < 0.5 ? { kind: 'after' as const, minutes: int(R.afterMinutes.min, R.afterMinutes.max) } : { kind: 'anchor' as const, anchor: r() < 0.5 ? ('morning' as const) : ('evening' as const), floorHours: int(R.floorHours.min, R.floorHours.max) }
  );
  const anchors = steps.filter((s) => s.kind === 'anchor').length;
  const candidate = {
    steps,
    minDays: int(1, Math.min(R.minDays.max, anchors + 1)),
    proofSeconds: int(R.proofSeconds.min, R.proofSeconds.max),
    hand: int(R.hand.min, R.hand.max),
    idleMinutes: int(R.idleMinutes.min, R.idleMinutes.max),
    morning: `${String(int(6, 11)).padStart(2, '0')}:${r() < 0.5 ? '00' : '30'}`,
    evening: `${String(int(13, 22)).padStart(2, '0')}:${r() < 0.5 ? '00' : '30'}`,
    freshMinutes: int(R.freshMinutes.min, R.freshMinutes.max),
    postponeMax: int(R.postponeMax.min, R.postponeMax.max),
  };
  const v = validateConfirmationRule(candidate);
  if (!v.ok) throw new Error(`generator made an invalid base: ${v.error}`);
  return v.rule;
}

const ZONES = ['UTC', 'Asia/Damascus', 'Asia/Amman', 'Asia/Riyadh', 'Africa/Cairo', 'America/New_York'];

function randomAsk(r: () => number): { person: RulePerson; order: RuleOrder | null; now: Date } {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  return {
    person: { id: pick(['u-a', 'u-b', 'u-c', 'u-d']), storeId: pick(['s-1', 's-2', null]) },
    order:
      r() < 0.3
        ? null
        : {
            storeId: pick(['s-1', 's-2', null]),
            productIds: ['p-1', 'p-2', 'p-3'].filter(() => r() < 0.5),
            channelKind: pick([...CHANNEL_KINDS, null]),
            phase: pick(['NEW', 'RETRY', null] as const),
          },
    now: new Date(T0.getTime() + Math.floor((r() - 0.5) * 120 * 86_400_000)),
  };
}

function expectBase(eff: ReturnType<typeof ruleFor>, base: ConfirmationRuleNumbers) {
  expect(eff.numbers).toEqual(base);
  for (const k of ['hand', 'idleMinutes', 'schedule', 'proofSeconds', 'postponeMax', 'first', 'onlyFor'] as const) expect(eff[k].source).toEqual({ from: 'BASE' });
  expect(eff.first.value).toBe(false);
  expect(eff.onlyFor.value).toBeNull();
  expect(eff.hand.value).toBe(base.hand);
  expect(eff.schedule.value).toEqual({ steps: base.steps, minDays: base.minDays });
}

describe('zero rules ≡ the base rule, for any person and order', () => {
  it('2000 seeded scenarios: random base, person, order (or none), moment and time zone — every number and source is the base', () => {
    const r = rng(20261120);
    for (let i = 0; i < 2000; i++) {
      const base = randomBase(r);
      const ask = randomAsk(r);
      const eff = ruleFor(ask, ctx([], base, ZONES[i % ZONES.length]));
      expectBase(eff, base);
      expect(eff.skipped).toEqual([]);
    }
  });

  it('the default base comes back as the very same numbers the base reader answers (deep-equal, no field added or dropped)', () => {
    const eff = ruleFor({ person: AMAL, order: order(), now: T0 }, ctx([]));
    expect(Object.keys(eff.numbers).sort()).toEqual(Object.keys(CONFIRMATION_RULE_DEFAULT).sort());
    expect(eff.numbers).toEqual(CONFIRMATION_RULE_DEFAULT);
  });

  it('rules that do not apply are the same as none: another company, stopped, not started, ended, outside the hours, another person / store / product / channel / phase', () => {
    const rules = [
      row({ kind: 'EMPLOYEE_NUMBERS', payload: { hand: 1 }, companyId: 'co-other' }),
      row({ kind: 'EMPLOYEE_NUMBERS', payload: { hand: 1 }, isActive: false }),
      row({ kind: 'EMPLOYEE_NUMBERS', payload: { hand: 1 }, effectiveFrom: new Date('2026-12-01T00:00:00Z') }),
      row({ kind: 'EMPLOYEE_NUMBERS', payload: { hand: 1 }, effectiveTo: new Date('2026-11-20T09:00:00Z') }),
      row({ kind: 'EMPLOYEE_NUMBERS', payload: { idleMinutes: 30 }, hoursFrom: '17:00', hoursTo: '23:00' }),
      row({ kind: 'EMPLOYEE_NUMBERS', payload: { hand: 1 }, userIds: ['u-z'] }),
      row({ kind: 'EMPLOYEE_NUMBERS', payload: { hand: 1 }, storeId: 's-9' }),
      row({ kind: 'ORDER_NUMBERS', payload: { postponeMax: 1 }, productId: 'p-9' }),
      row({ kind: 'ORDER_NUMBERS', payload: { proofSeconds: 20 }, channelKind: 'TIKTOK' }),
      row({ kind: 'ORDER_NUMBERS', payload: { proofSeconds: 20 }, storeId: 's-9' }),
      row({ kind: 'PRIORITY', payload: { first: true }, phase: 'RETRY' }),
      row({ kind: 'ROUTING', payload: { toUserIds: ['u-b'] }, productId: 'p-9' }),
    ];
    expectBase(ruleFor({ person: AMAL, order: order(), now: T0 }, ctx(rules)), CONFIRMATION_RULE_DEFAULT);
  });

  it('an order rule never reaches a question asked without an order; an employee rule never reaches through an order', () => {
    const rules = [row({ kind: 'ORDER_NUMBERS', payload: { postponeMax: 1 } }), row({ kind: 'PRIORITY', payload: { first: true } })];
    expectBase(ruleFor({ person: AMAL, now: T0 }, ctx(rules)), CONFIRMATION_RULE_DEFAULT);
    const emp = ruleFor({ person: { id: 'u-z', storeId: 's-1' }, order: order(), now: T0 }, ctx([row({ kind: 'EMPLOYEE_NUMBERS', payload: { hand: 1 }, userIds: ['u-a'] })]));
    expect(emp.hand.value).toBe(CONFIRMATION_RULE_DEFAULT.hand);
  });

  it('a stored row that no longer validates is skipped (named), never half-applied', () => {
    const broken = row({ kind: 'EMPLOYEE_NUMBERS', payload: { hand: 99 } });
    const unknownKind = row({ kind: 'AMOUNT', payload: {} });
    const eff = ruleFor({ person: AMAL, order: order(), now: T0 }, ctx([broken, unknownKind]));
    expect(eff.skipped).toEqual([broken.id, unknownKind.id]);
    expect(eff.numbers).toEqual(CONFIRMATION_RULE_DEFAULT);
  });
});

describe('most specific wins: named employee → product or channel → store → company → base', () => {
  const company = row({ kind: 'EMPLOYEE_NUMBERS', payload: { hand: 5 }, name: 'الشركة' });
  const store = row({ kind: 'EMPLOYEE_NUMBERS', payload: { hand: 4 }, storeId: 's-1', name: 'المتجر' });
  const named = row({ kind: 'EMPLOYEE_NUMBERS', payload: { hand: 2 }, userIds: ['u-a'], name: 'الجديدة' });

  it.each([
    ['company only', [company], AMAL, 5, 'الشركة'],
    ['store beats company', [company, store], AMAL, 4, 'المتجر'],
    ['named beats store and company', [company, store, named], AMAL, 2, 'الجديدة'],
    ['a person the named rule does not name gets the store', [company, store, named], BASMA, 4, 'المتجر'],
    ['in another store the store rule falls away', [company, store, named], { id: 'u-b', storeId: 's-2' }, 5, 'الشركة'],
  ] as const)('%s', (_t, rules, person, hand, name) => {
    const eff = ruleFor({ person, now: T0 }, ctx([...rules]));
    expect(eff.hand.value).toBe(hand);
    expect(eff.hand.source).toMatchObject({ from: 'RULE', name });
    expect(eff.numbers.hand).toBe(hand);
  });

  it('order numbers: product beats store beats company; channel stands level with product', () => {
    const c = row({ kind: 'ORDER_NUMBERS', payload: { proofSeconds: 60 } });
    const s = row({ kind: 'ORDER_NUMBERS', payload: { proofSeconds: 20 }, storeId: 's-1' });
    const p = row({ kind: 'ORDER_NUMBERS', payload: { proofSeconds: 45 }, productId: 'p-1' });
    expect(ruleFor({ person: AMAL, order: order(), now: T0 }, ctx([c])).proofSeconds.value).toBe(60);
    expect(ruleFor({ person: AMAL, order: order(), now: T0 }, ctx([c, s])).proofSeconds.value).toBe(20);
    expect(ruleFor({ person: AMAL, order: order(), now: T0 }, ctx([c, s, p])).proofSeconds).toMatchObject({ value: 45, source: { ruleId: p.id, level: 2 } });
    expect(ruleFor({ person: AMAL, order: order({ productIds: ['p-2'] }), now: T0 }, ctx([c, s, p])).proofSeconds.value).toBe(20);
  });

  it('each number on its own: a product rule on the postpone limit leaves the proof seconds to the store rule', () => {
    const s = row({ kind: 'ORDER_NUMBERS', payload: { proofSeconds: 20 }, storeId: 's-1' });
    const p = row({ kind: 'ORDER_NUMBERS', payload: { postponeMax: 1 }, productId: 'p-1' });
    const eff = ruleFor({ person: AMAL, order: order(), now: T0 }, ctx([s, p]));
    expect(eff.proofSeconds).toMatchObject({ value: 20, source: { ruleId: s.id } });
    expect(eff.postponeMax).toMatchObject({ value: 1, source: { ruleId: p.id } });
    expect(eff.schedule.source).toEqual({ from: 'BASE' });
    expect(eff.numbers).toEqual({ ...CONFIRMATION_RULE_DEFAULT, proofSeconds: 20, postponeMax: 1 });
    // A rule of numbers neither puts the order first nor narrows who may take it.
    expect(eff.first).toEqual({ value: false, source: { from: 'BASE' } });
    expect(eff.onlyFor).toEqual({ value: null, source: { from: 'BASE' } });
  });

  it('the schedule moves as one: steps and their days from the same rule', () => {
    const tpl = CONFIRMATION_RULE_TEMPLATES.find((t) => t.key === 'expensive-product-attempts')!;
    const p = row({ kind: 'ORDER_NUMBERS', payload: tpl.payload, productId: 'p-1' });
    const eff = ruleFor({ person: AMAL, order: order(), now: T0 }, ctx([p]));
    expect(eff.schedule.value.steps).toHaveLength(6);
    expect(eff.numbers.steps.length + 1).toBe(7);
    expect(eff.numbers.minDays).toBe(tpl.payload.minDays);
  });

  it('within one level: more conditions win, then the later start, the later creation, the smaller id — whatever order the rows come in', () => {
    const plain = row({ kind: 'ORDER_NUMBERS', payload: { proofSeconds: 40 }, productId: 'p-1' });
    const withStore = row({ kind: 'ORDER_NUMBERS', payload: { proofSeconds: 50 }, productId: 'p-1', storeId: 's-1' });
    const laterChannel = row({ kind: 'ORDER_NUMBERS', payload: { proofSeconds: 35 }, channelKind: 'FACEBOOK', effectiveFrom: new Date('2026-11-10T00:00:00Z') });
    const r = rng(7);
    for (let i = 0; i < 50; i++) {
      const rows = [plain, withStore, laterChannel].sort(() => r() - 0.5);
      expect(ruleFor({ person: AMAL, order: order(), now: T0 }, ctx(rows)).proofSeconds.value).toBe(50);
    }
    const twins = [row({ kind: 'ORDER_NUMBERS', payload: { proofSeconds: 40 }, productId: 'p-1' }), laterChannel];
    expect(ruleFor({ person: AMAL, order: order(), now: T0 }, ctx(twins)).proofSeconds.value).toBe(35);
    expect(ruleFor({ person: AMAL, order: order(), now: T0 }, ctx([...twins].reverse())).proofSeconds.value).toBe(35);
  });

  it('hours are the store\'s clock and may run through midnight', () => {
    const night = row({ kind: 'EMPLOYEE_NUMBERS', payload: { idleMinutes: 30 }, hoursFrom: '22:00', hoursTo: '02:00' });
    // 23:30 in Damascus (UTC+3) = 20:30 UTC.
    expect(ruleFor({ person: AMAL, now: new Date('2026-11-20T20:30:00Z') }, ctx([night], undefined, 'Asia/Damascus')).idleMinutes.value).toBe(30);
    expect(ruleFor({ person: AMAL, now: new Date('2026-11-20T22:59:00Z') }, ctx([night], undefined, 'Asia/Damascus')).idleMinutes.value).toBe(30);
    expect(ruleFor({ person: AMAL, now: new Date('2026-11-20T23:00:00Z') }, ctx([night], undefined, 'Asia/Damascus')).idleMinutes.value).toBe(CONFIRMATION_RULE_DEFAULT.idleMinutes);
    // The same instant in UTC is 20:30 — outside.
    expect(ruleFor({ person: AMAL, now: new Date('2026-11-20T20:30:00Z') }, ctx([night])).idleMinutes.value).toBe(CONFIRMATION_RULE_DEFAULT.idleMinutes);
  });

  it('dates: in force from effectiveFrom, no longer at effectiveTo', () => {
    const week = row({ kind: 'EMPLOYEE_NUMBERS', payload: { hand: 2 }, userIds: ['u-a'], effectiveFrom: T0, effectiveTo: new Date(T0.getTime() + 7 * 86_400_000) });
    expect(ruleFor({ person: AMAL, now: new Date(T0.getTime() - 1) }, ctx([week])).hand.value).toBe(3);
    expect(ruleFor({ person: AMAL, now: T0 }, ctx([week])).hand.value).toBe(2);
    expect(ruleFor({ person: AMAL, now: new Date(T0.getTime() + 7 * 86_400_000) }, ctx([week])).hand.value).toBe(3);
  });

  it('priority and routing: the order is first, and only the named people may take it', () => {
    const first = row({ kind: 'PRIORITY', payload: { first: true }, productId: 'p-1' });
    const route = row({ kind: 'ROUTING', payload: { toUserIds: ['u-a', 'u-b'] }, storeId: 's-1' });
    const eff = ruleFor({ person: AMAL, order: order(), now: T0 }, ctx([first, route]));
    expect(eff.first).toMatchObject({ value: true, source: { ruleId: first.id } });
    expect(eff.onlyFor).toMatchObject({ value: ['u-a', 'u-b'], source: { ruleId: route.id } });
    expect(eff.numbers).toEqual(CONFIRMATION_RULE_DEFAULT);
  });
});

describe('every kind has a validator, held to the base rule\'s ranges', () => {
  it('the four kinds, each with its numbers, and no other', () => {
    expect([...CONFIRMATION_RULE_KINDS]).toEqual(['EMPLOYEE_NUMBERS', 'ORDER_NUMBERS', 'PRIORITY', 'ROUTING']);
    for (const k of CONFIRMATION_RULE_KINDS) {
      expect(NUMBERS_OF_KIND[k].length).toBeGreaterThan(0);
      expect(validateRulePayload(k, {}).ok).toBe(false);
      expect(validateRulePayload(k, null).ok).toBe(false);
    }
  });

  it.each([
    ['hand', R.hand],
    ['idleMinutes', R.idleMinutes],
  ] as const)('EMPLOYEE_NUMBERS %s: accepted at both edges of the base range, refused one past each', (field, range) => {
    expect(validateRulePayload('EMPLOYEE_NUMBERS', { [field]: range.min }).ok).toBe(true);
    expect(validateRulePayload('EMPLOYEE_NUMBERS', { [field]: range.max }).ok).toBe(true);
    expect(validateRulePayload('EMPLOYEE_NUMBERS', { [field]: range.min - 1 })).toMatchObject({ ok: false, field: `payload.${field}` });
    expect(validateRulePayload('EMPLOYEE_NUMBERS', { [field]: range.max + 1 })).toMatchObject({ ok: false, field: `payload.${field}` });
    expect(validateRulePayload('EMPLOYEE_NUMBERS', { [field]: 2.5 }).ok).toBe(false);
  });

  it.each([
    ['proofSeconds', R.proofSeconds],
    ['postponeMax', R.postponeMax],
  ] as const)('ORDER_NUMBERS %s: the base range, both edges', (field, range) => {
    expect(validateRulePayload('ORDER_NUMBERS', { [field]: range.min }).ok).toBe(true);
    expect(validateRulePayload('ORDER_NUMBERS', { [field]: range.max }).ok).toBe(true);
    expect(validateRulePayload('ORDER_NUMBERS', { [field]: range.min - 1 }).ok).toBe(false);
    expect(validateRulePayload('ORDER_NUMBERS', { [field]: range.max + 1 }).ok).toBe(false);
  });

  it('ORDER_NUMBERS schedule: steps and days together, held to the base validator (count, each step, days against anchors)', () => {
    const after = (minutes: number) => ({ kind: 'after', minutes });
    const morning = { kind: 'anchor', anchor: 'morning', floorHours: 8 };
    expect(validateRulePayload('ORDER_NUMBERS', { steps: [after(30), morning], minDays: 2 }).ok).toBe(true);
    expect(validateRulePayload('ORDER_NUMBERS', { steps: [after(30), morning] })).toMatchObject({ ok: false, field: 'payload.steps' });
    expect(validateRulePayload('ORDER_NUMBERS', { minDays: 2 })).toMatchObject({ ok: false, field: 'payload.steps' });
    expect(validateRulePayload('ORDER_NUMBERS', { steps: [after(30)], minDays: 1 })).toMatchObject({ ok: false, field: 'payload.steps' });
    expect(validateRulePayload('ORDER_NUMBERS', { steps: Array(7).fill(after(30)), minDays: 1 }).ok).toBe(false);
    expect(validateRulePayload('ORDER_NUMBERS', { steps: [after(5), morning], minDays: 2 })).toMatchObject({ ok: false, field: 'payload.steps.0' });
    expect(validateRulePayload('ORDER_NUMBERS', { steps: [after(30), after(60)], minDays: 2 })).toMatchObject({ ok: false, field: 'payload.minDays' });
  });

  it('a kind changes only its own numbers', () => {
    expect(validateRulePayload('EMPLOYEE_NUMBERS', { proofSeconds: 30 })).toMatchObject({ ok: false, field: 'payload.proofSeconds' });
    expect(validateRulePayload('ORDER_NUMBERS', { hand: 2 })).toMatchObject({ ok: false, field: 'payload.hand' });
    expect(validateRulePayload('ORDER_NUMBERS', { morning: '09:00' }).ok).toBe(false);
    expect(validateRulePayload('ORDER_NUMBERS', { freshMinutes: 10 }).ok).toBe(false);
    expect(validateRulePayload('PRIORITY', { first: false }).ok).toBe(false);
    expect(validateRulePayload('PRIORITY', { first: true, hand: 2 }).ok).toBe(false);
    expect(validateRulePayload('ROUTING', { toUserIds: [] }).ok).toBe(false);
    expect(validateRulePayload('ROUTING', { toUserIds: ['u-a', 'u-a'] }).ok).toBe(false);
    expect(validateRulePayload('ROUTING', { toUserIds: ['u-a', 7] }).ok).toBe(false);
    expect(validateRulePayload('ROUTING', { toUserIds: Array.from({ length: 51 }, (_, i) => `u-${i}`) }).ok).toBe(false);
  });

  it('the amount of an order is NOT a condition (the owner, 20/11): no column for it, and the payload refuses it', () => {
    for (const k of CONFIRMATION_RULE_KINDS) {
      for (const key of ['amount', 'minAmount', 'totalAmount', 'price']) expect(validateRulePayload(k, { [key]: 100 }).ok).toBe(false);
    }
    const model = Prisma.dmmf.datamodel.models.find((m) => m.name === 'ConfirmationRule');
    expect(model, 'model ConfirmationRule generated').toBeTruthy();
    const fields = model!.fields.map((f) => f.name);
    expect(fields.filter((f) => /amount|price|total|value/i.test(f))).toEqual([]);
    expect(fields).toEqual(expect.arrayContaining(['companyId', 'storeId', 'name', 'kind', 'userIds', 'productId', 'channelKind', 'phase', 'hoursFrom', 'hoursTo', 'effectiveFrom', 'effectiveTo', 'isActive', 'payload', 'createdById']));
  });

  it.each([
    ['an unknown kind', { kind: 'AMOUNT', payload: { hand: 2 } }, 'RULE_KIND'],
    ['an empty name', { kind: 'EMPLOYEE_NUMBERS', payload: { hand: 2 }, name: '  ' }, 'RULE_NAME'],
    ['an empty list of people', { kind: 'EMPLOYEE_NUMBERS', payload: { hand: 2 }, userIds: [] }, 'RULE_PEOPLE'],
    ['people on an order rule', { kind: 'ORDER_NUMBERS', payload: { postponeMax: 1 }, userIds: ['u-a'] }, 'RULE_SCOPE'],
    ['people on a routing rule', { kind: 'ROUTING', payload: { toUserIds: ['u-a'] }, userIds: ['u-a'] }, 'RULE_SCOPE'],
    ['a product on an employee rule', { kind: 'EMPLOYEE_NUMBERS', payload: { hand: 2 }, productId: 'p-1' }, 'RULE_SCOPE'],
    ['a phase on an order rule', { kind: 'ORDER_NUMBERS', payload: { postponeMax: 1 }, phase: 'NEW' }, 'RULE_SCOPE'],
    ['hours on an order rule', { kind: 'ORDER_NUMBERS', payload: { postponeMax: 1 }, hoursFrom: '17:00', hoursTo: '23:00' }, 'RULE_HOURS'],
    ['an unknown channel', { kind: 'PRIORITY', payload: { first: true }, channelKind: 'PIGEON' }, 'RULE_CHANNEL'],
    ['an unknown phase', { kind: 'PRIORITY', payload: { first: true }, phase: 'LATER' }, 'RULE_PHASE'],
    ['one hour without the other', { kind: 'PRIORITY', payload: { first: true }, hoursFrom: '17:00' }, 'RULE_HOURS'],
    ['equal hours', { kind: 'PRIORITY', payload: { first: true }, hoursFrom: '17:00', hoursTo: '17:00' }, 'RULE_HOURS'],
    ['a malformed hour', { kind: 'PRIORITY', payload: { first: true }, hoursFrom: '5pm', hoursTo: '23:00' }, 'RULE_HOURS'],
    ['an end before the start', { kind: 'PRIORITY', payload: { first: true }, effectiveTo: new Date('2026-10-01T00:00:00Z') }, 'RULE_DATES'],
    ['a payload out of range', { kind: 'EMPLOYEE_NUMBERS', payload: { hand: 11 } }, 'RULE_PAYLOAD'],
  ] as [string, Partial<ConfirmationRuleRow> & Pick<ConfirmationRuleRow, 'kind' | 'payload'>, string][])('refused: %s', (_t, over, code) => {
    const c = validateConfirmationRuleRow(row(over));
    expect(c).toMatchObject({ ok: false, code });
    if (!c.ok) expect(c.errorAr).toMatch(/[؀-ۿ]/);
  });
});

describe('two active rules on the same level, number and target are refused at save — and only those', () => {
  const base = () => row({ kind: 'ORDER_NUMBERS', payload: { proofSeconds: 20 }, productId: 'p-1', name: 'المنتج الغالي' });

  it('the same number for the same product → RULE_OVERLAP naming the other rule', () => {
    const other = base();
    const refusal = overlapRefusal(valid(base()), [other]);
    expect(refusal).toMatchObject({ code: 'RULE_OVERLAP', otherRuleId: other.id });
    expect(refusal!.errorAr).toContain('المنتج الغالي');
  });

  it('named people in common, hours that meet, dates that meet → refused', () => {
    const a = row({ kind: 'EMPLOYEE_NUMBERS', payload: { hand: 2 }, userIds: ['u-a', 'u-b'], hoursFrom: '22:00', hoursTo: '02:00' });
    const b = row({ kind: 'EMPLOYEE_NUMBERS', payload: { hand: 1 }, userIds: ['u-b'], hoursFrom: '01:00', hoursTo: '03:00', effectiveTo: new Date('2026-12-01T00:00:00Z') });
    expect(overlapRefusal(valid(a), [b])?.code).toBe('RULE_OVERLAP');
  });

  it.each([
    ['a different number', { payload: { postponeMax: 1 } }],
    ['another product', { productId: 'p-2' }],
    ['a different level (store, not product)', { productId: null, storeId: 's-1' }],
    ['the channel instead of the product', { productId: null, channelKind: 'FACEBOOK' }],
    ['another store beside the product', { storeId: 's-1' }],
    ['stopped', { isActive: false }],
    ['another company', { companyId: 'co-other' }],
    ['dates that do not meet', { effectiveFrom: new Date('2026-12-01T00:00:00Z') }],
  ] as [string, Partial<ConfirmationRuleRow>][])('allowed: %s', (_t, over) => {
    const candidate = valid(row({ kind: 'ORDER_NUMBERS', payload: { proofSeconds: 20 }, productId: 'p-1', effectiveTo: new Date('2026-11-25T00:00:00Z') }));
    expect(overlapRefusal(candidate, [row({ kind: 'ORDER_NUMBERS', payload: { proofSeconds: 30 }, productId: 'p-1', ...over })])).toBeNull();
  });

  it('allowed: no person in common, hours that do not meet, a stopped candidate, the rule compared with itself', () => {
    const a = row({ kind: 'EMPLOYEE_NUMBERS', payload: { hand: 2 }, userIds: ['u-a'] });
    expect(overlapRefusal(valid(a), [row({ kind: 'EMPLOYEE_NUMBERS', payload: { hand: 1 }, userIds: ['u-b'] })])).toBeNull();
    const eve = row({ kind: 'EMPLOYEE_NUMBERS', payload: { idleMinutes: 30 }, hoursFrom: '17:00', hoursTo: '23:00' });
    expect(overlapRefusal(valid(eve), [row({ kind: 'EMPLOYEE_NUMBERS', payload: { idleMinutes: 15 }, hoursFrom: '09:00', hoursTo: '17:00' })])).toBeNull();
    expect(overlapRefusal(valid(row({ kind: 'EMPLOYEE_NUMBERS', payload: { idleMinutes: 15 }, hoursFrom: '23:00', hoursTo: '09:00' })), [eve])).toBeNull();
    expect(overlapRefusal(valid({ ...a, isActive: false }), [row({ kind: 'EMPLOYEE_NUMBERS', payload: { hand: 1 }, userIds: ['u-a'] })])).toBeNull();
    expect(overlapRefusal(valid(a), [a])).toBeNull();
  });

  it('a company-wide rule and a named one on the same number stand together: the named one wins by level', () => {
    const all = row({ kind: 'EMPLOYEE_NUMBERS', payload: { hand: 4 } });
    const named = row({ kind: 'EMPLOYEE_NUMBERS', payload: { hand: 2 }, userIds: ['u-a'] });
    expect(overlapRefusal(valid(named), [all])).toBeNull();
    expect(ruleFor({ person: AMAL, now: T0 }, ctx([all, named])).hand.value).toBe(2);
  });
});

describe('the eight ready templates: data, OFF, and valid once their blanks are filled', () => {
  const FILL = { userIds: ['u-a'], productId: 'p-1', storeId: 's-1', toUserIds: ['u-a', 'u-b'] };

  it('eight of them, one key each, covering the four kinds', () => {
    expect(CONFIRMATION_RULE_TEMPLATES).toHaveLength(8);
    expect(new Set(CONFIRMATION_RULE_TEMPLATES.map((t) => t.key)).size).toBe(8);
    expect(new Set(CONFIRMATION_RULE_TEMPLATES.map((t) => t.kind))).toEqual(new Set(CONFIRMATION_RULE_KINDS));
  });

  it.each(CONFIRMATION_RULE_TEMPLATES.map((t) => [t.key, t] as const))('%s passes the row validator once filled', (_k, t) => {
    const filled = row({
      kind: t.kind,
      name: t.name,
      payload: t.needs.includes('toUserIds') ? { ...t.payload, toUserIds: FILL.toUserIds } : t.payload,
      userIds: t.needs.includes('userIds') ? FILL.userIds : null,
      productId: t.needs.includes('productId') ? FILL.productId : null,
      storeId: t.needs.includes('storeId') ? FILL.storeId : null,
      channelKind: t.scope.channelKind ?? null,
      phase: t.scope.phase ?? null,
      hoursFrom: t.scope.hoursFrom ?? null,
      hoursTo: t.scope.hoursTo ?? null,
      effectiveTo: t.days ? new Date(new Date('2026-11-01T00:00:00Z').getTime() + t.days * 86_400_000) : null,
    });
    const c = validateConfirmationRuleRow(filled);
    expect(c.ok, c.ok ? '' : c.errorAr).toBe(true);
  });

  it('the numbers the owner was shown: hand 2, idle 30, 7 attempts, 3 attempts, proof 20, postpone once', () => {
    const by = (k: string) => CONFIRMATION_RULE_TEMPLATES.find((t) => t.key === k)!.payload;
    expect(by('new-employee-hand').hand).toBe(2);
    expect(by('evening-idle').idleMinutes).toBe(30);
    expect(by('expensive-product-attempts').steps!.length + 1).toBe(7);
    expect(by('page-leads-attempts').steps!.length + 1).toBe(3);
    expect(by('store-proof').proofSeconds).toBe(20);
    expect(by('product-postpone-once').postponeMax).toBe(1);
    expect(by('product-first').first).toBe(true);
  });
});

/* ── the table: additive, writes nothing, never deleted, and nobody reads it yet ── */

const ROOT = process.cwd();
const MIGRATION = join(ROOT, 'prisma', 'migrations', '20261120180000_confirmation_rules');
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}
const SRC = filesUnder(join(ROOT, 'src'));
const rel = (p: string) => relative(ROOT, p).split(sep).join('/');

describe('the table', () => {
  it('the migration is additive and writes no row (the templates are data in the lib)', () => {
    const sql = readFileSync(join(MIGRATION, 'migration.sql'), 'utf8').replace(/--[^\n]*/g, '');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "confirmation_rules"/);
    // Statements, not words: «ON DELETE CASCADE» of the company key is a clause, not a delete.
    expect(sql).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|DROP|TRUNCATE|COPY)\b/im);
    expect(sql).not.toMatch(/ALTER\s+TABLE\s+(?!"confirmation_rules")/i);
    expect(sql).not.toMatch(/ALTER\s+COLUMN|DROP\s+(TABLE|COLUMN|INDEX)/i);
    const rollback = readFileSync(join(MIGRATION, 'rollback.sql'), 'utf8');
    expect(rollback).toMatch(/DROP TABLE IF EXISTS "confirmation_rules"/);
  });

  it('a store that has rules is not empty: the model is in geo-removal\'s list', () => {
    expect(STORE_TABLE_MODELS).toContain('confirmationRule');
  });

  it('no code deletes a rule (a rule is stopped, never deleted)', () => {
    const deleters = SRC.filter((f) => !f.endsWith('.test.ts') && /confirmationRule\.(delete|deleteMany)\s*\(/.test(readFileSync(f, 'utf8'))).map(rel);
    expect(deleters).toEqual([]);
  });

  it('NO_CALLER_FOUND (20/11): nothing outside this module reads the resolver or the table yet — Q4b removes this pin when it wires the pull', () => {
    const readers = SRC.filter((f) => {
      const r = rel(f);
      if (r === 'src/lib/confirmation-rules.ts' || r === 'src/lib/confirmation-rules.test.ts') return false;
      const text = readFileSync(f, 'utf8');
      return /from\s+['"][^'"]*confirmation-rules['"]/.test(text) || /\.confirmationRule\.(find|create|update|upsert|count|aggregate|groupBy)/.test(text);
    }).map(rel);
    expect(readers).toEqual([]);
  });

  it('the confirmation desk does not import it (its bundle is at its ceiling)', () => {
    const desk = readFileSync(join(ROOT, 'src', 'components', 'screens', 'ConfirmationMineScreen.tsx'), 'utf8');
    expect(desk).not.toMatch(/confirmation-rules['"]/);
  });
});
