import { describe, expect, it } from 'vitest';
import type { SessionUser } from '@/types/auth';
import { attachGrants, can, hasFullAccess } from './authorization';
import { computeEffectiveGrants } from './permissions-core';
import { deskReadiness } from './desk-readiness';
import { mustHoldToWork } from './confirmation-queue';
import { CONFIRMATION_RULE_DEFAULT } from './confirmation-rule-settings';
import { CONFIRMATION_RULE_TEMPLATES, ROUTING_FALLBACK, type ValidRule } from './confirmation-rules';
import {
  OWN_RULE_NUMBERS,
  PRIORITY_EFFECT_AR,
  PRIORITY_NOT_IN_FORCE_AR,
  ROUTING_OFF_SHIFT_AR,
  ROUTING_OWNERS_ONLY_AR,
  ROUTING_UNSTAFFED_AR,
  candidateFromBody,
  previewOwnRule,
  routingEffect,
  templatesAnswer,
  type PreviewPerson,
} from './confirmation-own-rules';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE (request Q5c, 21/11) — the previews of «هالطلبات أول» and «هالطلبات بس لهالموظفات», on people BUILT AS THEIR SESSIONS ARE.
 *
 *  1. Both kinds are offered in the dialog's list, each with its side effect in the server's words (the routing one with its minutes).
 *  2. Priority: it reaches whoever pulls, and only while «أولوية الطابور» is on — off, it binds nobody and says why.
 *  3. Routing: it binds the named people who can pull (the pull tool on their REAL grants); the others are told the orders are not theirs (or only after the minutes).
 *  4. The WARNING is the server's: nobody named can pull · only people with full access can · none of them works the rule's hours.
 *  5. The routing template ships with nobody: its prefill is a fresh list, and a save without people is refused as the template's blank.
 * People: `computeEffectiveGrants` (role rows · a personal DENY · a roleId-null legacy account · the owner) → `attachGrants` → `can` → `deskReadiness`.
 * ═══════════════════════════════════════════════════════════════════════
 */

const AGENT = ['confirmation.work', 'confirmation.pull', 'orders.confirm', 'orders.contact_log', 'orders.claim', 'orders.edit', 'orders.view', 'orders.release', 'confirmation.raise_issue'];
const MODERATOR = ['orders.view', 'orders.confirm', 'orders.contact_log', 'orders.edit', 'orders.claim', 'orders.release'];

type Spec = { id: string; name: string; role: string; roleId: string | null; roleKeys?: string[]; template?: string[]; deny?: string[] };

async function person(s: Spec): Promise<PreviewPerson> {
  const base = { id: s.id, email: `${s.id}@x`, name: s.name, role: s.role, roleId: s.roleId, status: 'ACTIVE', companyId: 'c1', permissions: [] } as unknown as SessionUser;
  const grants = await computeEffectiveGrants(base as never, {
    roleRows: async () => (s.roleId ? s.roleKeys ?? [] : s.template ?? []).map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
    overrideRows: async () => (s.deny ?? []).map((k) => ({ permission: k, effect: 'DENY' as const, scope: null, scopeIds: null })),
  });
  const u = attachGrants(base, grants);
  const holds = (k: string) => can(u, k);
  return { id: u.id, name: u.name, readiness: deskReadiness(holds, { fullAccess: hasFullAccess(u) }), claimsByNumber: holds('orders.claim') && !mustHoldToWork(holds) };
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

const NOW = Date.parse('2026-11-21T10:00:00Z');
const ctx = { companyId: 'c1', userId: 'owner', nowMs: NOW, nextWorkStart: new Date('2026-11-22T06:00:00Z') };
const ON = { hand: true, idleMinutes: true, pullPerHour: true };

function rule(body: Record<string, unknown>): ValidRule {
  const c = candidateFromBody({ name: 'قاعدة', start: 'NOW', storeId: 's1', ...body }, ctx);
  if (!c.ok) throw new Error(`${c.code} ${c.errorAr}`);
  return { ...c.rule, id: 'new' };
}
const priority = (extra: Record<string, unknown> = {}) => rule({ kind: 'PRIORITY', productId: 'p1', payload: { first: true }, ...extra });
const routing = (toUserIds: string[], extra: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) =>
  rule({ kind: 'ROUTING', payload: { toUserIds, ...payload }, ...extra });

type Over = Partial<Parameters<typeof previewOwnRule>[1]>;
const look = async (r: ValidRule, over: Over = {}) =>
  previewOwnRule(r, { people: await team(), named: [], others: [], base: CONFIRMATION_RULE_DEFAULT, storeId: 's1', nowMs: NOW, inForce: ON, ...over });
const bound = (p: Awaited<ReturnType<typeof look>>) => p.bound.map((b) => b.id).sort();
const reasonOf = (p: Awaited<ReturnType<typeof look>>, id: string) => p.notBound.find((n) => n.id === id)?.reason;

describe('1 · both kinds in the dialog\'s list, with their side effect', () => {
  it('«هالطلبات أول» types nothing; «هالطلبات بس لهالموظفات» types its minutes, 5–480, default 30', () => {
    const first = OWN_RULE_NUMBERS.find((n) => n.kind === 'PRIORITY')!;
    const only = OWN_RULE_NUMBERS.find((n) => n.kind === 'ROUTING')!;
    expect([first.key, first.label, first.range, first.effectAr]).toEqual(['first', 'هالطلبات أول', null, PRIORITY_EFFECT_AR]);
    expect([only.key, only.label, only.range, only.defaultValue]).toEqual(['toUserIds', 'هالطلبات بس لهالموظفات', { min: 5, max: 480 }, ROUTING_FALLBACK.defaultMinutes]);
    expect(PRIORITY_EFFECT_AR).toContain('«أولوية الطابور»');
    expect(PRIORITY_EFFECT_AR).toContain('جوّا كل درجة');
    expect(PRIORITY_EFFECT_AR).toContain('وعد الزبون');
    expect(routingEffect(45)).toBe('الطلبات بتروح لهالموظفات بس، وإذا ما حدا منهن قادر بتصير للكل بعد 45 دقيقة دوام.');
    expect(routingEffect(45)).not.toMatch(/[{}]/);
  });
});

describe('2 · the priority preview', () => {
  it('on: it reaches whoever pulls — a personal «منع» of the pull and the moderator who never pulls are left out, each with the reason', async () => {
    const p = await look(priority(), { priorityOn: true });
    expect(bound(p)).toEqual(['legacy', 'owner', 'sara']);
    expect(reasonOf(p, 'huda')).toMatch(/ما بتسحب/);
    expect(reasonOf(p, 'mod')).toMatch(/ما بتسحب/);
    expect(p.notes[0]).toBe(PRIORITY_EFFECT_AR);
    expect(p.bindsNobody).toBe(false);
    expect(p.warnings).toBeUndefined();
  });

  it('NEGATIVE: «أولوية الطابور» off — it binds nobody, the note and every reason say why', async () => {
    const p = await look(priority(), { priorityOn: false });
    expect(p.bound).toEqual([]);
    expect(p.bindsNobody).toBe(true);
    expect(p.notes).toContain(PRIORITY_NOT_IN_FORCE_AR);
    expect(reasonOf(p, 'sara')).toMatch(/«أولوية الطابور» مطفية/);
  });

  it('its phase, hours, later start and «every store» are said', async () => {
    const p = await look(priority({ phase: 'RETRY', hoursFrom: '17:00', hoursTo: '23:00', start: 'NEXT_WORK_START', storeId: null }), { priorityOn: true });
    const all = p.notes.join(' ');
    expect(all).toMatch(/طلبات الإعادة/);
    expect(all).toMatch(/17:00/);
    expect(all).toMatch(/مش هلق/);
    expect(all).toMatch(/لكل المتاجر/);
  });

  it('MUTATION: built from the role template alone, huda would be reached — her personal «منع» is what keeps her out', async () => {
    const asTemplate = await person({ id: 'huda', name: 'هدى', role: 'CONFIRMATION_AGENT', roleId: 'r-agent', roleKeys: AGENT });
    const p = await look(priority(), { people: [asTemplate], priorityOn: true });
    expect(bound(p)).toEqual(['huda']);
  });
});

describe('3 · the routing preview', () => {
  it('to sara: she is bound; the other pullers are told the orders are not theirs; the effect is the first note; no warning', async () => {
    const p = await look(routing(['sara']));
    expect(bound(p)).toEqual(['sara']);
    expect(reasonOf(p, 'legacy')).toBe('مش مكتوبة بالقاعدة — طلباتها ما بتوصلها');
    expect(p.notes[0]).toBe(routingEffect(30));
    expect(p.warnings).toBeUndefined();
  });

  it('a roleId-null legacy account named is read through her role\'s template — bound', async () => {
    expect(bound(await look(routing(['legacy'])))).toEqual(['legacy']);
  });

  it('WARNING: nobody named can pull (a personal «منع», a moderator) — every order waits its minutes, the others get them after', async () => {
    const p = await look(routing(['huda', 'mod'], {}, { fallbackMinutes: 45 }));
    expect(p.warnings).toEqual([ROUTING_UNSTAFFED_AR(45)]);
    expect(p.bindsNobody).toBe(true);
    expect(reasonOf(p, 'huda')).toMatch(/ما بتسحب/);
    expect(reasonOf(p, 'sara')).toBe('مش مكتوبة بالقاعدة — طلباتها بتوصلها بس بعد 45 دقيقة دوام');
    expect(p.notes[0]).toBe(routingEffect(45));
  });

  it('WARNING: only the owner (full access) can pull — counted present, so the minutes never send the orders to everyone', async () => {
    const p = await look(routing(['owner', 'huda']));
    expect(p.warnings).toEqual([ROUTING_OWNERS_ONLY_AR]);
    expect(p.bound).toEqual([]);
    expect(reasonOf(p, 'owner')).toMatch(/صلاحية كاملة/);
  });

  it('WARNING: the owner named beside a real agent — he is counted present when she is away, so the orders never reach everyone; sara stays bound', async () => {
    const p = await look(routing(['owner', 'sara']));
    expect(p.warnings).toEqual([ROUTING_OWNERS_ONLY_AR]);
    expect(bound(p)).toEqual(['sara']);
    expect(reasonOf(p, 'owner')).toMatch(/صلاحية كاملة/);
  });

  it('MUTATION: built from the role template alone, huda could pull and no warning would come — the DENY is what raises it', async () => {
    const asTemplate = await person({ id: 'huda', name: 'هدى', role: 'CONFIRMATION_AGENT', roleId: 'r-agent', roleKeys: AGENT });
    const p = await look(routing(['huda']), { people: [asTemplate] });
    expect(p.warnings).toBeUndefined();
    expect(bound(p)).toEqual(['huda']);
  });

  it.each([
    ['her own hours never meet the rule\'s', { shiftStart: '09:00', shiftEnd: '15:00' }, true],
    ['her own hours meet them', { shiftStart: '16:00', shiftEnd: '20:00' }, false],
    ['a shift that ends before it starts is the store\'s', { shiftStart: '20:00', shiftEnd: '08:00' }, false],
    ['half a shift is the store\'s', { shiftStart: '09:00', shiftEnd: null }, false],
    ['no own hours', { shiftStart: null, shiftEnd: null }, false],
  ])('the rule\'s hours 17:00–23:00 — %s → warned: %s', async (_n, shift, warned) => {
    const p = await look(routing(['sara'], { hoursFrom: '17:00', hoursTo: '23:00' }), { shifts: new Map([['sara', shift]]) });
    expect(p.warnings?.includes(ROUTING_OFF_SHIFT_AR) ?? false).toBe(warned);
    expect(bound(p)).toEqual(['sara']);
  });

  it('one named person on shift is enough — no warning', async () => {
    const shifts = new Map([['sara', { shiftStart: '09:00', shiftEnd: '15:00' }], ['legacy', { shiftStart: '18:00', shiftEnd: '23:00' }]]);
    const p = await look(routing(['sara', 'legacy'], { hoursFrom: '17:00', hoursTo: '23:00' }), { shifts });
    expect(p.warnings).toBeUndefined();
  });

  it('a named person not at the desk is said so', async () => {
    const p = await look(routing(['sara', 'gone']), { named: [{ id: 'gone', name: 'موقوفة' }] });
    expect(reasonOf(p, 'gone')).toMatch(/مش على مكتب التأكيد/);
  });
});

describe('4 · the routing template ships with nobody', () => {
  it('its prefill is a fresh list — filling it never touches the shipped template', () => {
    const t = templatesAnswer(new Map()).find((x) => x.key === 'store-to-its-team')!;
    expect(t.acts).toBe(true);
    expect(t.prefill.payload).toEqual({ toUserIds: [], fallbackMinutes: 30 });
    (t.prefill.payload.toUserIds as string[]).push('sara');
    expect(CONFIRMATION_RULE_TEMPLATES.find((x) => x.key === 'store-to-its-team')!.payload.toUserIds).toEqual([]);
    expect(templatesAnswer(new Map()).find((x) => x.key === 'store-to-its-team')!.prefill.payload.toUserIds).toEqual([]);
  });

  it('NEGATIVE: saved without people it is refused as the template\'s blank, beside the people', () => {
    const t = templatesAnswer(new Map()).find((x) => x.key === 'store-to-its-team')!;
    const c = candidateFromBody({ ...t.prefill, storeId: 's1', templateKey: t.key }, ctx);
    expect(c.ok || [c.code, c.field]).toEqual(['RULE_TEMPLATE_BLANK', 'payload.toUserIds']);
    const filled = candidateFromBody({ ...t.prefill, storeId: 's1', templateKey: t.key, payload: { ...t.prefill.payload, toUserIds: ['sara'] } }, ctx);
    expect(filled.ok).toBe(true);
  });

  it('NEGATIVE: a routing rule never names people in its «who», and no kind has an amount', () => {
    const c = candidateFromBody({ kind: 'ROUTING', name: 'x', userIds: ['sara'], payload: { toUserIds: ['sara'] } }, ctx);
    expect(c.ok || c.code).toBe('RULE_SCOPE');
    const amount = candidateFromBody({ kind: 'PRIORITY', name: 'x', payload: { first: true, minAmount: 100 } }, ctx);
    expect(amount.ok || amount.field).toBe('payload.minAmount');
  });
});
