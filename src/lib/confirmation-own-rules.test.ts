import { describe, expect, it } from 'vitest';
import type { SessionUser } from '@/types/auth';
import { attachGrants, can, hasFullAccess } from './authorization';
import { computeEffectiveGrants } from './permissions-core';
import { deskReadiness } from './desk-readiness';
import { mustHoldToWork } from './confirmation-queue';
import { CONFIRMATION_RULE_DEFAULT } from './confirmation-rule-settings';
import { CONFIRMATION_RULE_TEMPLATES, validateConfirmationRuleRow, type ConfirmationRuleRow, type ValidRule } from './confirmation-rules';
import {
  KINDS_THAT_ACT,
  NOT_ACTING_YET_AR,
  candidateFromBody,
  endAfter,
  payloadWords,
  previewOwnRule,
  ruleState,
  scopeWords,
  templatesAnswer,
  type PreviewPerson,
} from './confirmation-own-rules';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE (request Q4c, 21/11) — what the rules screen's doors read and say, as pure functions.
 *
 *  1. A save is read WHOLE: a kind that does not act yet is refused (nothing that looks on and binds nobody); the order's amount is no condition; the length is
 *     1–90 days or none; the start is «هلق» or «من بداية الدوام الجاي» (the default).
 *  2. The preview is computed from PEOPLE BUILT AS THEIR SESSIONS ARE (`computeEffectiveGrants` → `attachGrants` → `can` → `deskReadiness`): a personal «منع» of
 *     the pull is read; a roleId-null legacy account is read through its role's template; the owner is the owner.
 *  3. Each person gets a reason when not bound: not named · the number never reaches her · the number does not act now · a more specific rule wins (asked of the
 *     real resolver).
 *  4. The templates are answered as COPIES: the screen can never change one.
 * ═══════════════════════════════════════════════════════════════════════
 */

const AGENT = ['confirmation.work', 'confirmation.pull', 'orders.confirm', 'orders.contact_log', 'orders.claim', 'orders.edit', 'orders.view', 'orders.release', 'confirmation.raise_issue'];
const MODERATOR = ['orders.view', 'orders.confirm', 'orders.contact_log', 'orders.edit', 'orders.claim', 'orders.release'];

type Spec = { id: string; name: string; role: string; roleId: string | null; roleKeys?: string[]; template?: string[]; deny?: string[]; allow?: string[] };

/** One person, built as her session is — role rows by roleId (or her legacy role's template), then her personal overrides. */
async function person(s: Spec): Promise<PreviewPerson> {
  const base = { id: s.id, email: `${s.id}@x`, name: s.name, role: s.role, roleId: s.roleId, status: 'ACTIVE', companyId: 'c1', permissions: [] } as unknown as SessionUser;
  const grants = await computeEffectiveGrants(base as never, {
    roleRows: async () => (s.roleId ? s.roleKeys ?? [] : s.template ?? []).map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
    overrideRows: async () => [
      ...(s.deny ?? []).map((k) => ({ permission: k, effect: 'DENY' as const, scope: null, scopeIds: null })),
      ...(s.allow ?? []).map((k) => ({ permission: k, effect: 'ALLOW' as const, scope: 'ALL_COMPANY', scopeIds: null })),
    ],
  });
  const u = attachGrants(base, grants);
  const holds = (k: string) => can(u, k);
  return { id: u.id, name: u.name, readiness: deskReadiness(holds, { fullAccess: hasFullAccess(u) }), claimsByNumber: holds('orders.claim') && !mustHoldToWork(holds) };
}

const NOW = Date.parse('2026-11-21T10:00:00Z');
const NEXT = new Date('2026-11-22T06:00:00Z');
const ctx = { companyId: 'c1', userId: 'owner', nowMs: NOW, nextWorkStart: NEXT };
const ON = { hand: true, idleMinutes: true, pullPerHour: true };

function candidate(body: Record<string, unknown>): ValidRule {
  const c = candidateFromBody({ kind: 'EMPLOYEE_NUMBERS', name: 'قاعدة', start: 'NOW', ...body }, ctx);
  if (!c.ok) throw new Error(c.errorAr);
  return { ...c.rule, id: 'new' };
}

function row(over: Partial<ConfirmationRuleRow>): ConfirmationRuleRow {
  return {
    id: 'r', companyId: 'c1', storeId: null, name: 'تانية', kind: 'EMPLOYEE_NUMBERS', userIds: null, productId: null, channelKind: null, phase: null,
    hoursFrom: null, hoursTo: null, effectiveFrom: new Date(NOW - 86_400_000), effectiveTo: null, isActive: true, payload: { hand: 4 }, createdAt: new Date(NOW - 86_400_000),
    ...over,
  };
}

async function team() {
  return [
    await person({ id: 'sara', name: 'سارة', role: 'CONFIRMATION_AGENT', roleId: 'r-agent', roleKeys: AGENT }),
    await person({ id: 'huda', name: 'هدى', role: 'CONFIRMATION_AGENT', roleId: 'r-agent', roleKeys: AGENT, deny: ['confirmation.pull'] }),
    await person({ id: 'legacy', name: 'ليلى', role: 'FOLLOW_UP_AGENT', roleId: null, template: AGENT }),
    await person({ id: 'mod', name: 'مازن', role: 'MODERATOR', roleId: 'r-mod', roleKeys: MODERATOR }),
    await person({ id: 'owner', name: 'المالك', role: 'SUPER_ADMIN', roleId: null }),
  ];
}
const look = async (rule: ValidRule, over: Partial<Parameters<typeof previewOwnRule>[1]> = {}) =>
  previewOwnRule(rule, { people: await team(), named: [], others: [], base: CONFIRMATION_RULE_DEFAULT, storeId: 's1', nowMs: NOW, inForce: ON, ...over });
const bound = (p: Awaited<ReturnType<typeof look>>) => p.bound.map((b) => b.id).sort();
const reasonOf = (p: Awaited<ReturnType<typeof look>>, id: string) => p.notBound.find((n) => n.id === id)?.reason;

describe('1 · a save is read whole', () => {
  // UPDATED 2026-11-21 (request Q4d): was «only the employee numbers act» with ['EMPLOYEE_NUMBERS'] and ORDER_NUMBERS refused; the order numbers act now
  // (`order-numbers.ts`), so the two kinds of Q5 are the ones still refused.
  it('the employee and the order numbers act — the two other kinds are refused with a sentence, never saved to bind nobody', () => {
    expect(KINDS_THAT_ACT).toEqual(['EMPLOYEE_NUMBERS', 'ORDER_NUMBERS']);
    for (const kind of ['PRIORITY', 'ROUTING']) {
      const c = candidateFromBody({ kind, name: 'x', payload: { proofSeconds: 20 } }, ctx);
      expect(c.ok, kind).toBe(false);
      if (!c.ok) expect([c.code, c.field]).toEqual(['RULE_KIND_NOT_ACTING', 'kind']);
    }
    const unknown = candidateFromBody({ kind: 'AMOUNT', name: 'x', payload: { hand: 2 } }, ctx);
    expect(unknown.ok || unknown.code).toBe('RULE_KIND');
  });

  it('NEGATIVE: the order amount is not a condition — a payload or a scope naming it is refused', () => {
    const c = candidateFromBody({ kind: 'EMPLOYEE_NUMBERS', name: 'x', payload: { hand: 2, minAmount: 100 } }, ctx);
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.field).toBe('payload.minAmount');
  });

  it('the start: «من بداية الدوام الجاي» by default, «هلق» when asked; anything else refused', () => {
    const def = candidateFromBody({ kind: 'EMPLOYEE_NUMBERS', name: 'x', payload: { hand: 2 } }, ctx);
    expect(def.ok && def.rule.effectiveFrom.toISOString()).toBe(NEXT.toISOString());
    const now = candidateFromBody({ kind: 'EMPLOYEE_NUMBERS', name: 'x', payload: { hand: 2 }, start: 'NOW' }, ctx);
    expect(now.ok && now.rule.effectiveFrom.getTime()).toBe(NOW);
    const bad = candidateFromBody({ kind: 'EMPLOYEE_NUMBERS', name: 'x', payload: { hand: 2 }, start: 'TOMORROW' }, ctx);
    expect(bad.ok || bad.field).toBe('start');
  });

  it.each([
    [null, true], [1, true], [90, true], [0, false], [91, false], [2.5, false], ['7', false],
  ])('a length of %s days → %s', (days, ok) => {
    const r = endAfter(new Date(NOW), days);
    expect(r.ok).toBe(ok);
    if (r.ok && typeof days === 'number') expect(r.to!.getTime()).toBe(NOW + days * 86_400_000);
  });

  it('a hand outside the base range is refused by the base validator (one set of ranges)', () => {
    for (const hand of [0, 11]) {
      const c = candidateFromBody({ kind: 'EMPLOYEE_NUMBERS', name: 'x', payload: { hand } }, ctx);
      expect(c.ok || c.field, String(hand)).toBe('payload.hand');
    }
  });

  it('the state of a row: stopped, ended, not begun, on', () => {
    expect(ruleState(row({ isActive: false }), NOW)).toBe('STOPPED');
    expect(ruleState(row({ effectiveTo: new Date(NOW) }), NOW)).toBe('ENDED');
    expect(ruleState(row({ effectiveFrom: new Date(NOW + 1) }), NOW)).toBe('PENDING');
    expect(ruleState(row({}), NOW)).toBe('ACTIVE');
  });
});

describe('2 · the preview reads each person as her session does', () => {
  it('a rule for everyone binds whoever pulls — a personal «منع» of the pull, and the moderator who never pulls, are not bound, each with the reason', async () => {
    const p = await look(candidate({ payload: { pullPerHour: 20 } }));
    // sara (role), legacy (no role row: her role's template), owner (full access) pull; huda is denied the pull personally; the moderator has no pull.
    expect(bound(p)).toEqual(['legacy', 'owner', 'sara']);
    expect(reasonOf(p, 'huda')).toMatch(/ما بتسحب/);
    expect(reasonOf(p, 'mod')).toMatch(/ما بتسحب/);
    expect(p.bindsNobody).toBe(false);
  });

  it('MUTATION: read from the role template alone, huda would be bound — her personal «منع» is what keeps her out', async () => {
    const asTemplate = await person({ id: 'huda', name: 'هدى', role: 'CONFIRMATION_AGENT', roleId: 'r-agent', roleKeys: AGENT });
    const p = previewOwnRule(candidate({ payload: { pullPerHour: 20 } }), { people: [asTemplate], named: [], others: [], base: CONFIRMATION_RULE_DEFAULT, storeId: 's1', nowMs: NOW, inForce: ON });
    expect(bound(p)).toEqual(['huda']);
  });

  it('the hand reaches whoever takes an order by its number (review of #446): the moderator is bound by a hand rule, the pace still skips her', async () => {
    const hand = await look(candidate({ userIds: ['mod'], payload: { hand: 2 } }));
    expect(bound(hand)).toEqual(['mod']);
    const pace = await look(candidate({ userIds: ['mod'], payload: { pullPerHour: 20 } }));
    expect(pace.bindsNobody).toBe(true);
    // An agent bound to «اسحبي الطلب أول» with her pull denied cannot claim by number either: the hand does not reach her.
    const deniedPull = await look(candidate({ userIds: ['huda'], payload: { hand: 2 } }));
    expect(reasonOf(deniedPull, 'huda')).toMatch(/حد اليد ما بيوصلها/);
  });

  it('the idle minutes reach every person of the desk — whoever holds an order is released by her own minutes, the moderator too', async () => {
    const p = await look(candidate({ payload: { idleMinutes: 30 } }));
    expect(bound(p)).toEqual(['huda', 'legacy', 'mod', 'owner', 'sara']);
  });

  it('a named rule: the others are «not named»; a named person not at the desk is said so', async () => {
    const p = await look(candidate({ userIds: ['sara', 'gone'], payload: { hand: 2 } }), { named: [{ id: 'gone', name: 'موقوفة' }] });
    expect(bound(p)).toEqual(['sara']);
    expect(reasonOf(p, 'legacy')).toBe('مش مكتوبة بالقاعدة');
    expect(reasonOf(p, 'gone')).toMatch(/مش على مكتب التأكيد/);
  });

  it('a number that does not act now binds nobody, and the note says why', async () => {
    const p = await look(candidate({ payload: { hand: 2 } }), { inForce: { hand: false, idleMinutes: false, pullPerHour: true } });
    expect(p.bound).toEqual([]);
    expect(p.bindsNobody).toBe(true);
    expect(p.notes.join(' ')).toMatch(/ما بيشتغل هلق/);
    expect(reasonOf(p, 'sara')).toMatch(/ما بيشتغل هلق/);
  });

  it('a more specific rule wins — asked of the real resolver: a named rule beats a rule for everyone on the same number', async () => {
    const named = row({ id: 'n1', name: 'سارة الجديدة', userIds: ['sara'], payload: { hand: 1 } });
    const p = await look(candidate({ payload: { hand: 4 } }), { others: [named] });
    // Review of #446: the moderator is reached by the hand too (claim by number). Was ['legacy', 'owner'].
    expect(bound(p)).toEqual(['legacy', 'mod', 'owner']);
    expect(reasonOf(p, 'sara')).toMatch(/«سارة الجديدة» أخص منها/);
    // A stopped rule does not win.
    const q = await look(candidate({ payload: { hand: 4 } }), { others: [{ ...named, isActive: false }] });
    expect(bound(q)).toContain('sara');
  });

  it('notes: a later start, an end, hours, every store', async () => {
    const c = candidateFromBody({ kind: 'EMPLOYEE_NUMBERS', name: 'مسا', payload: { idleMinutes: 30 }, hoursFrom: '17:00', hoursTo: '23:00', days: 7 }, ctx);
    if (!c.ok) throw new Error(c.errorAr);
    const p = await look({ ...c.rule, id: 'new' });
    expect(p.notes).toHaveLength(4);
    expect(p.notes.join(' ')).toMatch(/17:00/);
  });

  // UPDATED 2026-11-21 (request Q4d): the kind that does not act was ORDER_NUMBERS; it acts now (its preview: `order-numbers-act.test.ts`), PRIORITY does not yet.
  it('a kind that does not act binds nobody, whatever the people', async () => {
    const order = validateConfirmationRuleRow(row({ kind: 'PRIORITY', payload: { first: true }, storeId: 's1' }));
    if (!order.ok) throw new Error(order.errorAr);
    const p = await look(order.rule);
    expect(p).toEqual({ bound: [], notBound: [], notes: [NOT_ACTING_YET_AR], bindsNobody: true });
  });
});

describe('3 · words and templates', () => {
  it('payload and scope words', () => {
    expect(payloadWords({ hand: 2, pullPerHour: 20 })).toEqual(['حد اليد 2', 'سرعة السحب 20 طلب بالساعة']);
    const r = candidate({ userIds: ['sara'], payload: { hand: 2 } });
    const words = scopeWords(r, { person: (id) => (id === 'sara' ? 'سارة' : null), store: () => null, product: () => null });
    expect(words).toEqual(['على: سارة', 'بكل المتاجر']);
    // Without names (no «عرض الموظفين»), a count — never an id.
    expect(scopeWords(r, { person: () => null, store: () => null, product: () => null })[0]).toBe('على 1 موظفات بالاسم');
  });

  // UPDATED 2026-11-21 (request Q4d): was «only the employee kinds pressable» (two keys) and the copy was proved on the steps of template 2; the four order templates
  // are pressable now, and a schedule template opens as its ATTEMPTS (the dialog's one number) — the copy is proved on a payload the screen receives as it is.
  it('eight templates, every one OFF (no rule from it), the employee and the order kinds pressable — and each a COPY', () => {
    const t = templatesAnswer(new Map());
    expect(t).toHaveLength(8);
    expect(t.every((x) => x.activeCount === 0)).toBe(true);
    expect(t.filter((x) => x.acts).map((x) => x.key).sort()).toEqual([
      'evening-idle', 'expensive-product-attempts', 'new-employee-hand', 'page-leads-attempts', 'product-postpone-once', 'store-proof',
    ]);
    expect(t.filter((x) => !x.acts).every((x) => x.blockedAr)).toBe(true);
    expect(t[2].prefill.payload).toEqual({ attempts: 7 });
    (t[0].prefill.payload as Record<string, unknown>).hand = 9;
    expect(CONFIRMATION_RULE_TEMPLATES[0].payload.hand).toBe(2);
    expect(templatesAnswer(new Map([['evening-idle', 2]])).find((x) => x.key === 'evening-idle')!.activeCount).toBe(2);
  });

  it('a pressable template, its blanks filled, is a rule the door accepts', () => {
    for (const t of templatesAnswer(new Map()).filter((x) => x.acts)) {
      // UPDATED 2026-11-21 (request Q4d): the order templates need a product or a store — filled here as the owner fills them on the screen.
      const c = candidateFromBody(
        { ...t.prefill, userIds: t.needs.includes('userIds') ? ['sara'] : null, productId: t.needs.includes('productId') ? 'p1' : null, storeId: t.needs.includes('storeId') ? 's1' : null },
        ctx
      );
      expect(c.ok, t.key).toBe(true);
    }
  });
});
