import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE (request Q4d, 21/11) — «أرقام الطلب» ACT: an order's attempts and their steps, its proof seconds and its postpone limit come from the owner's
 * rules, by the order's store, the products of its CURRENT lines and its channel (`order-numbers.ts`).
 *
 *  1. ZERO ROWS = TODAY: no ORDER_NUMBERS row (or rows that name another store, product, channel, company, a stopped / ended / future one, a broken one, an employee
 *     rule) → the base rule ITSELF (the same object), and the order is never read.
 *  2. Two orders of two products on one desk each follow their own numbers; an order of a third product follows the base.
 *  3. An order that changes product keeps the rule of its CURRENT lines; an order of two products is of both — the most specific wins, and between two equally
 *     specific rules the resolver's own order (never the order of the lines).
 *  4. The reader: one read for many orders; none when nothing can change; a failed read is the base.
 *  5. The screen's side: the schedule is ONE number (3–7 attempts) turned into exactly the two templates' steps; a template's blank is refused when empty; the
 *     preview of an order rule names whoever works its orders, built as their sessions are (`computeEffectiveGrants`), with the reason for whoever it does not reach.
 * ═══════════════════════════════════════════════════════════════════════
 */

vi.mock('./db', () => ({ db: {} }));

import { attachGrants, can, hasFullAccess } from './authorization';
import { computeEffectiveGrants } from './permissions-core';
import { deskReadiness } from './desk-readiness';
import { mustHoldToWork } from './confirmation-queue';
import { CONFIRMATION_RULE_DEFAULT, validateConfirmationRule, type ConfirmationRuleNumbers } from './confirmation-rule-settings';
import { CONFIRMATION_RULE_TEMPLATES, validateConfirmationRuleRow, type ConfirmationRuleRow } from './confirmation-rules';
import { orderNumbersOf, orderRuleOnce, orderRulesFor, readRuleOrders, ruleOrderOf } from './order-numbers';
import { ATTEMPTS_RANGE, candidateFromBody, previewOwnRule, scheduleOfAttempts, templatesAnswer, type PreviewPerson } from './confirmation-own-rules';

const NOW = new Date('2026-11-21T10:00:00Z');
const DAY = 86_400_000;
const BASE = CONFIRMATION_RULE_DEFAULT;

function row(over: Partial<ConfirmationRuleRow>): ConfirmationRuleRow {
  return {
    id: 'r', companyId: 'c1', storeId: null, name: 'قاعدة', kind: 'ORDER_NUMBERS', userIds: null, productId: null, channelKind: null, phase: null,
    hoursFrom: null, hoursTo: null, effectiveFrom: new Date(NOW.getTime() - DAY), effectiveTo: null, isActive: true, payload: { proofSeconds: 20 },
    createdAt: new Date(NOW.getTime() - DAY), ...over,
  };
}
const order = (over: Partial<{ storeId: string | null; productIds: string[]; channelKind: string | null }> = {}) => ({
  storeId: 's1', productIds: ['pA'], channelKind: 'FACEBOOK', phase: null, ...over,
});
const of = (o: ReturnType<typeof order> | null, rules: ConfirmationRuleRow[], base: ConfirmationRuleNumbers = BASE) => orderNumbersOf(o, { companyId: 'c1', base, rules }, NOW);
const sched = (n: number) => scheduleOfAttempts(n)!;

describe('1 · zero rows = today', () => {
  it('no row at all: the base itself, every source «base»', () => {
    const n = of(order(), []);
    expect(n.numbers).toBe(BASE);
    expect([n.schedule.source, n.proofSeconds.source, n.postponeMax.source]).toEqual([{ from: 'BASE' }, { from: 'BASE' }, { from: 'BASE' }]);
  });

  it.each([
    ['another company', row({ companyId: 'c2' })],
    ['another store', row({ storeId: 's2' })],
    ['another product', row({ productId: 'pZ' })],
    ['another channel', row({ channelKind: 'TIKTOK' })],
    ['stopped', row({ isActive: false })],
    ['ended', row({ effectiveTo: new Date(NOW.getTime() - 1) })],
    ['not begun', row({ effectiveFrom: new Date(NOW.getTime() + 1) })],
    ['a broken payload', row({ payload: { proofSeconds: 999 } })],
    ['an employee rule', row({ kind: 'EMPLOYEE_NUMBERS', payload: { hand: 2 } })],
    ['a priority rule of the same product', row({ kind: 'PRIORITY', productId: 'pA', payload: { first: true } })],
  ])('a row that binds nothing here (%s): the base itself', (_name, r) => {
    expect(of(order(), [r]).numbers).toBe(BASE);
  });

  it('an edited BASE rule with no order row is that base, untouched', () => {
    const edited = { ...BASE, proofSeconds: 45, postponeMax: 3 };
    expect(of(order(), [], edited).numbers).toBe(edited);
  });

  it('no order (none read) is the base', () => {
    expect(of(null, [row({})]).numbers).toBe(BASE);
  });
});

describe('2 · two orders of two products on one desk', () => {
  const rules = [
    row({ id: 'expensive', name: 'منتج غالي', productId: 'pA', payload: sched(7) }),
    row({ id: 'once', name: 'تأجيل مرة', productId: 'pB', payload: { postponeMax: 1 } }),
  ];
  it('each follows its own numbers; a third product follows the base', () => {
    const a = of(order({ productIds: ['pA'] }), rules);
    const b = of(order({ productIds: ['pB'] }), rules);
    const c = of(order({ productIds: ['pC'] }), rules);
    expect(a.numbers.steps).toHaveLength(6);
    expect(a.numbers.postponeMax).toBe(BASE.postponeMax);
    expect(a.schedule.source).toMatchObject({ from: 'RULE', ruleId: 'expensive' });
    expect(b.numbers.steps).toEqual(BASE.steps);
    expect(b.numbers.postponeMax).toBe(1);
    expect(c.numbers).toBe(BASE);
    // Every other number of the base is kept as it is.
    for (const k of ['hand', 'idleMinutes', 'morning', 'evening', 'freshMinutes', 'proofSeconds'] as const) expect(a.numbers[k]).toEqual(BASE[k]);
  });
});

describe('3 · the current lines decide', () => {
  const rules = [
    row({ id: 'A7', name: 'سبعة', productId: 'pA', payload: sched(7), effectiveFrom: new Date(NOW.getTime() - 3 * DAY) }),
    row({ id: 'B3', name: 'تلاتة', productId: 'pB', payload: sched(3), effectiveFrom: new Date(NOW.getTime() - 2 * DAY) }),
    row({ id: 'store', name: 'متجر', storeId: 's1', payload: { proofSeconds: 45, postponeMax: 4 } }),
    row({ id: 'chan', name: 'فيسبوك', channelKind: 'FACEBOOK', payload: { proofSeconds: 25 } }),
  ];
  it('a product changed by an edit takes its rule with it', () => {
    expect(of(order({ productIds: ['pA'] }), rules).numbers.steps).toHaveLength(6);
    expect(of(order({ productIds: ['pC'] }), rules).numbers.steps).toEqual(BASE.steps);
    expect(of(order({ productIds: ['pB'] }), rules).numbers.steps).toHaveLength(2);
  });

  it('two products, two rules of one level on one number: the later start wins — whatever the order of the lines', () => {
    const ab = of(order({ productIds: ['pA', 'pB'] }), rules);
    const ba = of(order({ productIds: ['pB', 'pA'] }), rules);
    expect(ab.schedule.source).toMatchObject({ ruleId: 'B3' });
    expect(ba.schedule.source).toMatchObject({ ruleId: 'B3' });
    expect(ab.numbers).toEqual(ba.numbers);
  });

  it('most specific wins per number: the channel (level 2) over the store (level 1) for the seconds, the store for the cap', () => {
    const n = of(order({ productIds: ['pC'] }), rules);
    expect(n.proofSeconds).toMatchObject({ value: 25, source: { ruleId: 'chan', level: 2 } });
    expect(n.postponeMax).toMatchObject({ value: 4, source: { ruleId: 'store', level: 1 } });
  });

  it('an order with no line rows is of its header product; lines win when there are some', () => {
    expect(ruleOrderOf({ storeId: 's1', productId: 'pA', channel: { kind: 'TIKTOK' }, items: [] })).toEqual({ storeId: 's1', productIds: ['pA'], channelKind: 'TIKTOK', phase: null });
    expect(ruleOrderOf({ storeId: 's1', productId: 'pA', channel: null, items: [{ productId: 'pB' }, { productId: 'pB' }, { productId: 'pC' }] })).toEqual({
      storeId: 's1', productIds: ['pB', 'pC'], channelKind: null, phase: null,
    });
  });
});

describe('4 · the reader', () => {
  const findMany = vi.fn();
  const client = { order: { findMany } } as never;
  beforeEach(() => findMany.mockReset());

  it('no ORDER_NUMBERS row: `orderRuleOnce` answers the base object and never reads the order; `orderRulesFor` is null', async () => {
    const base = vi.fn(async () => BASE);
    const once = orderRuleOnce(client, 'c1', 'o1', base, async () => [row({ kind: 'EMPLOYEE_NUMBERS', payload: { hand: 2 } })]);
    expect(await once()).toBe(BASE);
    expect(await once()).toBe(BASE);
    expect(base).toHaveBeenCalledTimes(1);
    expect(await orderRulesFor(client, 'c1', ['o1', 'o2'], BASE, async () => [])).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('with a row: ONE read of the order (its store, header product, channel kind, lines), once per request', async () => {
    findMany.mockResolvedValue([{ id: 'o1', storeId: 's1', productId: 'pA', channel: { kind: 'FACEBOOK' }, items: [{ productId: 'pA' }] }]);
    const once = orderRuleOnce(client, 'c1', 'o1', async () => BASE, async () => [row({ productId: 'pA', payload: { proofSeconds: 20 } })]);
    expect((await once()).proofSeconds).toBe(20);
    await once();
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0]).toEqual({
      where: { id: { in: ['o1'] }, companyId: 'c1' },
      select: { id: true, storeId: true, productId: true, channel: { select: { kind: true } }, items: { select: { productId: true } } },
    });
  });

  it('the desk: one read for every card; the map holds only the orders whose numbers differ', async () => {
    findMany.mockResolvedValue([
      { id: 'o1', storeId: 's1', productId: 'pA', channel: null, items: [{ productId: 'pA' }] },
      { id: 'o2', storeId: 's1', productId: 'pB', channel: null, items: [{ productId: 'pB' }] },
    ]);
    const map = await orderRulesFor(client, 'c1', ['o1', 'o2', 'o1'], BASE, async () => [row({ productId: 'pA', payload: { proofSeconds: 20 } })]);
    expect([...map!.keys()]).toEqual(['o1']);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where.id.in).toEqual(['o1', 'o2']);
  });

  it('NEGATIVE: a read that throws keeps the base numbers, never the request', async () => {
    // A plain throwing reader (a `vi.fn` that throws is reported by the runner even when the code catches it).
    let asked = 0;
    const down = {
      order: {
        findMany: async () => {
          asked++;
          throw new Error('down');
        },
      },
    } as never;
    expect((await readRuleOrders(down, 'c1', ['o1'])).size).toBe(0);
    const once = orderRuleOnce(down, 'c1', 'o1', async () => BASE, async () => [row({ productId: 'pA' })]);
    expect(await once()).toBe(BASE);
    expect(asked).toBe(2);
  });
});

describe('5 · the screen: one number for the schedule, the templates, the blanks', () => {
  const ctx = { companyId: 'c1', userId: 'owner', nowMs: NOW.getTime(), nextWorkStart: new Date(NOW.getTime() + DAY) };

  it('3–7 attempts are each a valid schedule of the base validator, with steps + 1 attempts; anything else is refused', () => {
    expect(ATTEMPTS_RANGE).toEqual({ min: 3, max: 7 });
    for (let n = 3; n <= 7; n++) {
      const s = sched(n);
      expect(s.steps).toHaveLength(n - 1);
      expect(validateConfirmationRule({ ...BASE, ...s }).ok, String(n)).toBe(true);
    }
    expect(sched(5)).toEqual({ steps: BASE.steps, minDays: BASE.minDays });
    for (const bad of [2, 8, 4.5, NaN]) expect(scheduleOfAttempts(bad)).toBeNull();
    const c = candidateFromBody({ kind: 'ORDER_NUMBERS', name: 'x', payload: { attempts: 9 } }, ctx);
    expect(c.ok || [c.code, c.field]).toEqual(['RULE_PAYLOAD', 'payload.attempts']);
  });

  it('the two schedule templates are exactly 7 and 3 attempts of `scheduleOfAttempts` — what the dialog opens with saves back their own steps', () => {
    const answered = templatesAnswer(new Map());
    for (const [key, n] of [['expensive-product-attempts', 7], ['page-leads-attempts', 3]] as const) {
      const t = CONFIRMATION_RULE_TEMPLATES.find((x) => x.key === key)!;
      expect({ steps: t.payload.steps, minDays: t.payload.minDays }).toEqual(sched(n));
      const a = answered.find((x) => x.key === key)!;
      expect(a.prefill.payload).toEqual({ attempts: n });
      const c = candidateFromBody({ ...a.prefill, templateKey: key, productId: 'pA' }, ctx);
      if (!c.ok) throw new Error(c.errorAr);
      expect(c.rule.payload).toEqual(t.payload);
    }
  });

  it('every order template, its blank filled, is a row the resolver reads (never skipped)', () => {
    for (const t of templatesAnswer(new Map()).filter((x) => x.kind === 'ORDER_NUMBERS')) {
      expect(t.acts, t.key).toBe(true);
      const c = candidateFromBody({ ...t.prefill, templateKey: t.key, productId: 'pA', storeId: 's1' }, ctx);
      if (!c.ok) throw new Error(`${t.key}: ${c.errorAr}`);
      expect(validateConfirmationRuleRow({ ...c.row, id: 'x' }).ok).toBe(true);
    }
  });

  it.each([
    ['expensive-product-attempts', 'productId'],
    ['product-postpone-once', 'productId'],
    ['store-proof', 'storeId'],
  ])('NEGATIVE: «%s» saved with its blank empty is refused on that field (it would act on every order)', (key, field) => {
    const t = templatesAnswer(new Map()).find((x) => x.key === key)!;
    const c = candidateFromBody({ ...t.prefill, templateKey: key }, ctx);
    expect(c.ok || [c.code, c.field]).toEqual(['RULE_TEMPLATE_BLANK', field]);
  });

  it('NEGATIVE: an order rule names nobody and no hours (the validator, unchanged)', () => {
    const named = candidateFromBody({ kind: 'ORDER_NUMBERS', name: 'x', userIds: ['sara'], payload: { proofSeconds: 20 } }, ctx);
    expect(named.ok || named.code).toBe('RULE_SCOPE');
    const hours = candidateFromBody({ kind: 'ORDER_NUMBERS', name: 'x', hoursFrom: '17:00', hoursTo: '23:00', payload: { proofSeconds: 20 } }, ctx);
    expect(hours.ok || hours.code).toBe('RULE_HOURS');
  });
});

describe('5b · the preview of an order rule — people built as their sessions are', () => {
  const AGENT = ['confirmation.work', 'confirmation.pull', 'orders.confirm', 'orders.contact_log', 'orders.claim', 'orders.edit', 'orders.view', 'orders.release'];
  type Spec = { id: string; name: string; role: string; roleId: string | null; keys?: string[]; deny?: string[] };
  async function person(s: Spec): Promise<PreviewPerson> {
    const base = { id: s.id, email: `${s.id}@x`, name: s.name, role: s.role, roleId: s.roleId, status: 'ACTIVE', companyId: 'c1', permissions: [] } as unknown as SessionUser;
    const grants = await computeEffectiveGrants(base as never, {
      roleRows: async () => (s.keys ?? []).map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
      overrideRows: async () => (s.deny ?? []).map((k) => ({ permission: k, effect: 'DENY' as const, scope: null, scopeIds: null })),
    });
    const u = attachGrants(base, grants);
    const holds = (k: string) => can(u, k);
    return { id: u.id, name: u.name, readiness: deskReadiness(holds, { fullAccess: hasFullAccess(u) }), claimsByNumber: holds('orders.claim') && !mustHoldToWork(holds) };
  }
  const team = async () => [
    await person({ id: 'sara', name: 'سارة', role: 'CONFIRMATION_AGENT', roleId: 'r-agent', keys: AGENT }),
    await person({ id: 'huda', name: 'هدى', role: 'CONFIRMATION_AGENT', roleId: 'r-agent', keys: AGENT, deny: ['orders.contact_log'] }),
    await person({ id: 'legacy', name: 'ليلى', role: 'FOLLOW_UP_AGENT', roleId: null, keys: AGENT }),
    await person({ id: 'owner', name: 'المالك', role: 'SUPER_ADMIN', roleId: null }),
  ];
  const ctx = { companyId: 'c1', userId: 'owner', nowMs: NOW.getTime(), nextWorkStart: new Date(NOW.getTime() + DAY) };
  const ruleOf = (body: Record<string, unknown>) => {
    const c = candidateFromBody({ kind: 'ORDER_NUMBERS', name: 'متجر', start: 'NOW', storeId: 's1', ...body }, ctx);
    if (!c.ok) throw new Error(c.errorAr);
    return { ...c.rule, id: 'new' };
  };
  const ON = { hand: true, idleMinutes: true, pullPerHour: true };
  const look = async (rule: ReturnType<typeof ruleOf>, over: Partial<Parameters<typeof previewOwnRule>[1]> = {}) =>
    previewOwnRule(rule, { people: await team(), named: [], others: [], base: BASE, storeId: 's1', nowMs: NOW.getTime(), inForce: ON, ...over });

  it('the proof seconds bind whoever logs a call: a personal «منع» of the call log is not bound, with the reason', async () => {
    const p = await look(ruleOf({ payload: { proofSeconds: 20 } }));
    expect(p.bound.map((b) => b.id).sort()).toEqual(['legacy', 'owner', 'sara']);
    expect(p.bound.find((b) => b.id === 'sara')!.numbers).toEqual(['ثواني إثبات الاتصال: 20']);
    expect(p.notBound).toEqual([{ id: 'huda', name: 'هدى', reason: 'ما بتسجّل نتيجة اتصال — المحاولات والإثبات ما بيوصلوها' }]);
    expect(p.bindsNobody).toBe(false);
  });

  it('the cap binds whoever decides — the personal «منع» of the call log does not keep her from it', async () => {
    const p = await look(ruleOf({ payload: { postponeMax: 1 } }));
    expect(p.bound.map((b) => b.id).sort()).toEqual(['huda', 'legacy', 'owner', 'sara']);
  });

  it('a number that does not act now binds nobody and says why (the switch it rides on)', async () => {
    const p = await look(ruleOf({ payload: { attempts: 7 } }), { orderInForce: { schedule: false, proofSeconds: false, postponeMax: true } });
    expect(p.bindsNobody).toBe(true);
    expect(p.notes.some((n) => n.startsWith('عدد محاولات «لا يرد»: ما بيشتغل هلق'))).toBe(true);
    expect(p.notBound.find((n) => n.id === 'sara')!.reason).toBe('عدد محاولات «لا يرد» ما بيشتغل هلق');
  });

  it('a more specific rule on some of its orders is named in the notes', async () => {
    const others = [row({ id: 'p', name: 'منتج غالي', productId: 'pA', payload: { proofSeconds: 45 } }), row({ id: 'q', name: 'متجر تاني', storeId: 's2', productId: 'pA', payload: { proofSeconds: 50 } })];
    const p = await look(ruleOf({ payload: { proofSeconds: 20 } }), { others });
    expect(p.notes).toContain('على بعض الطلبات قاعدة «منتج غالي» أخص منها على ثواني إثبات الاتصال.');
    expect(p.notes.join(' ')).not.toMatch(/متجر تاني/);
  });
});
