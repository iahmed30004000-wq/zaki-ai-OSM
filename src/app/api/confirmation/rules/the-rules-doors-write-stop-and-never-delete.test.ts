import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE (request Q4c, 21/11) — the doors of «قواعد خاصة», through the REAL permission engine.
 *
 * Nothing about permissions is mocked: the people are built by `resolveAudience` → `computeEffectiveGrants` → `can` over a fake database that answers role rows
 * by roleId or a legacy role's template, and personal ALLOW / DENY rows. Only the store reach and the switches a number rides on are stubbed.
 *
 *  1. create → preview → active → the employee numbers read it at once (this process's cache is forgotten at the save).
 *  2. The preview names who it binds and who it does not, from each person's REAL grants (a personal «منع» of the pull is read).
 *  3. A rule that binds nobody is saved only with an explicit «I know» (409 `RULE_BINDS_NOBODY` with the preview, nothing written, otherwise).
 *  4. Refused: a kind that does not act yet · a person or store of another company · a second rule on the same number, level and target · 403 without the keys.
 *  5. Stop keeps the row (no delete anywhere); a stopped rule changes no more; rename and dates go through the validator; another company's rule is «not found».
 *  6. One audit row per write, each with an Arabic label.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Person = { id: string; name: string; role: string; roleId: string | null; status: string; companyId: string; stores: string[] };
type Override = { userId: string; permission: string; effect: 'ALLOW' | 'DENY' };
type Rule = Record<string, any>;

const { state, db, audit } = vi.hoisted(() => {
  const state = {
    viewer: null as unknown as SessionUser,
    people: [] as Person[],
    roles: {} as Record<string, { name: string; keys: string[] }>,
    templates: {} as Record<string, string[]>,
    overrides: [] as Override[],
    rules: [] as Rule[],
    audits: [] as { entityId: string; newData: string }[],
    returnsOn: true,
    planOn: true,
    seq: 0,
  };
  const pick = (where: Record<string, any>) =>
    state.people.filter(
      (p) =>
        (where.companyId === undefined || p.companyId === where.companyId) &&
        (where.status === undefined || p.status === where.status) &&
        (where.id?.in === undefined || where.id.in.includes(p.id))
    );
  const matches = (r: Rule, where: Record<string, any>) =>
    Object.entries(where).every(([k, v]) => (v && typeof v === 'object' && 'in' in v ? (v.in as unknown[]).includes(r[k]) : r[k] === v));
  const db = {
    user: {
      findMany: vi.fn(async ({ where }: { where: Record<string, any> }) =>
        pick(where).map((p) => ({ id: p.id, name: p.name, email: `${p.id}@x`, role: p.role, roleId: p.roleId, status: p.status, companyId: p.companyId }))
      ),
    },
    userPermission: {
      findMany: vi.fn(async ({ where }: { where: Record<string, any> }) =>
        state.overrides
          .filter((o) => (where.userId?.in ?? [where.userId]).includes(o.userId))
          .map((o) => ({ userId: o.userId, permission: o.permission, effect: o.effect, scope: o.effect === 'ALLOW' ? 'ALL_COMPANY' : null, scopeIds: null }))
      ),
    },
    rolePermission: {
      findMany: vi.fn(async ({ where }: { where: Record<string, any> }) => {
        const keys = where.roleId ? state.roles[where.roleId]?.keys ?? [] : state.templates[where.role?.name] ?? [];
        return keys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null }));
      }),
    },
    confirmationRule: {
      findMany: vi.fn(async ({ where }: { where: Record<string, any> }) => state.rules.filter((r) => matches(r, where)).map((r) => ({ ...r }))),
      findFirst: vi.fn(async ({ where }: { where: Record<string, any> }) => {
        const r = state.rules.find((x) => matches(x, where));
        return r ? { ...r } : null;
      }),
      create: vi.fn(async ({ data }: { data: Rule }) => {
        const r = { id: `rule-${++state.seq}`, createdAt: new Date(), userIds: null, ...data };
        state.rules.push(r);
        return { id: r.id };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, any>; data: Rule }) => {
        const hit = state.rules.filter((r) => matches(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      }),
    },
    store: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, any> }) => (['s1', 's2'].includes(where.id) && where.companyId === 'c1' ? { id: where.id } : null)),
      findMany: vi.fn(async () => [{ id: 's1', name: 'متجر أول' }, { id: 's2', name: 'متجر تاني' }]),
    },
    product: { findMany: vi.fn(async () => []) },
    auditLog: {
      findMany: vi.fn(async ({ where }: { where: Record<string, any> }) => state.audits.filter((a) => where.entityId.in.includes(a.entityId))),
    },
  };
  const audit = vi.fn(async (row: { action: string; entityId: string; newData?: unknown }) => {
    state.audits.push({ entityId: row.entityId, newData: JSON.stringify(row.newData ?? null) });
  });
  return { state, db, audit };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit: audit }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({
    user: state.viewer, companyId: 'c1', storeId: 's1', countryId: 'co1',
    country: { timezone: 'Asia/Damascus', workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5] },
  }),
  usersReachingStore: async (users: { id: string }[], companyId: string, storeId: string) =>
    new Set(users.filter((u) => state.people.find((p) => p.id === u.id && p.companyId === companyId)?.stores.includes(storeId)).map((u) => u.id)),
}));
vi.mock('@/lib/rate-limit', () => ({ rateLimit: () => ({ allowed: true, remaining: 1, retryAfterSec: 0 }) }));
vi.mock('@/lib/authorization', async (orig) => {
  const real = await orig<typeof import('@/lib/authorization')>();
  return {
    ...real,
    requirePermission: async (k: string) => {
      if (!real.can(state.viewer, k)) throw new Error(`Forbidden: missing required permission ${k}`);
      return state.viewer;
    },
  };
});
// The switches a number rides on (their own tests elsewhere): the returns mode and the plan, read as the pull reads them.
vi.mock('@/lib/no-answer-rounds-switch', () => ({ roundsSwitch: async () => ({ enabled: false }) }));
vi.mock('@/lib/no-answer-cadence-switch', () => ({ cadenceSince: async () => (state.planOn ? new Date(0) : null) }));
vi.mock('@/lib/queue-priority-switch', () => ({ queuePrioritySwitch: async () => ({ enabled: false }) }));
vi.mock('@/lib/confirmation-queue', async (orig) => ({
  ...(await orig<typeof import('@/lib/confirmation-queue')>()),
  readReturnsMode: async () => (state.returnsOn ? ({ on: true } as never) : null),
}));
vi.mock('@/lib/confirmation-rule-settings', async (orig) => {
  const real = await orig<typeof import('@/lib/confirmation-rule-settings')>();
  return { ...real, confirmationRuleOnce: () => async () => real.CONFIRMATION_RULE_DEFAULT, readConfirmationRule: async () => real.CONFIRMATION_RULE_DEFAULT };
});

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { readConfirmationRules } from '@/lib/employee-numbers';
import { describeAction } from '@/lib/audit-view';
import * as listDoor from './route';
import * as oneDoor from './[id]/route';
import * as previewDoor from './preview/route';

const AGENT = ['confirmation.work', 'confirmation.pull', 'orders.confirm', 'orders.contact_log', 'orders.claim', 'orders.edit', 'orders.view', 'orders.release'];
const MODERATOR = ['orders.view', 'orders.confirm', 'orders.contact_log', 'orders.edit', 'orders.claim', 'orders.release'];
const OWNER_KEYS = ['settings.view', 'settings.manage', 'users.view'];

async function viewer(keys: string[]): Promise<SessionUser> {
  const base = { id: 'boss', email: 'b@x', name: 'المدير', role: 'MANAGER', roleId: 'r-boss', status: 'ACTIVE', companyId: 'c1', permissions: [] } as unknown as SessionUser;
  return attachGrants(base, await computeEffectiveGrants(base as never, { roleRows: async () => keys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })), overrideRows: async () => [] }));
}

const json = (body: unknown) => new Request('http://x/api/confirmation/rules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const create = async (body: unknown) => {
  const res = await listDoor.POST(json(body));
  return { status: res.status, body: (await res.json()) as any };
};
const preview = async (body: unknown) => {
  const res = await previewDoor.POST(json(body));
  return { status: res.status, body: (await res.json()) as any };
};
const patch = async (id: string, body: unknown) => {
  const res = await oneDoor.PATCH(new Request(`http://x/api/confirmation/rules/${id}`, { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
  return { status: res.status, body: (await res.json()) as any };
};
const list = async () => {
  const res = await listDoor.GET();
  return { status: res.status, body: (await res.json()) as any };
};
const handFor = (userIds: string[] | null, hand = 2, extra: Record<string, unknown> = {}) => ({ kind: 'EMPLOYEE_NUMBERS', name: 'الجديدة', userIds, start: 'NOW', payload: { hand }, ...extra });

beforeEach(async () => {
  vi.clearAllMocks();
  state.returnsOn = true;
  state.planOn = true;
  state.rules = [];
  state.audits = [];
  state.roles = { 'r-agent': { name: 'موظفة تأكيد', keys: AGENT }, 'r-mod': { name: 'موديريتور', keys: MODERATOR } };
  state.templates = { FOLLOW_UP_AGENT: AGENT };
  state.people = [
    { id: 'sara', name: 'سارة', role: 'CONFIRMATION_AGENT', roleId: 'r-agent', status: 'ACTIVE', companyId: 'c1', stores: ['s1'] },
    { id: 'huda', name: 'هدى', role: 'CONFIRMATION_AGENT', roleId: 'r-agent', status: 'ACTIVE', companyId: 'c1', stores: ['s1'] },
    { id: 'legacy', name: 'ليلى', role: 'FOLLOW_UP_AGENT', roleId: null, status: 'ACTIVE', companyId: 'c1', stores: ['s1'] },
    { id: 'mod', name: 'مازن', role: 'MODERATOR', roleId: 'r-mod', status: 'ACTIVE', companyId: 'c1', stores: ['s1'] },
    { id: 'other', name: 'غريبة', role: 'CONFIRMATION_AGENT', roleId: 'r-agent', status: 'ACTIVE', companyId: 'c2', stores: ['s9'] },
  ];
  state.overrides = [{ userId: 'huda', permission: 'confirmation.pull', effect: 'DENY' }];
  state.viewer = await viewer(OWNER_KEYS);
});

describe('1 · create → preview → active → read at once', () => {
  it('the preview names who it binds and why the others are not, from their REAL grants — and writes nothing', async () => {
    const { status, body } = await preview(handFor(null));
    expect(status).toBe(200);
    expect(body.preview.bound.map((b: any) => b.id).sort()).toEqual(['legacy', 'sara']);
    const why = Object.fromEntries(body.preview.notBound.map((n: any) => [n.id, n.reason]));
    expect(why.huda).toMatch(/ما بتسحب/); // her personal «منع» — a role template would have bound her
    expect(why.mod).toMatch(/ما بتسحب/);
    expect(why.other).toBeUndefined(); // another company's person never appears
    expect(db.confirmationRule.create).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('a save writes ONE row, ONE audit row with an Arabic label — and the employee numbers read it without waiting thirty seconds', async () => {
    expect(await readConfirmationRules(db as never, 'c1')).toHaveLength(0); // warms the cache with «no rule»
    const { status, body } = await create({ ...handFor(['sara']), templateKey: 'new-employee-hand' });
    expect(status).toBe(201);
    expect(state.rules).toHaveLength(1);
    expect(state.rules[0]).toMatchObject({ companyId: 'c1', kind: 'EMPLOYEE_NUMBERS', userIds: ['sara'], isActive: true, payload: { hand: 2 }, createdById: 'boss' });
    expect(body.preview.bound.map((b: any) => b.id)).toEqual(['sara']);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(describeAction(audit.mock.calls[0][0].action as string, 'ConfirmationRule')).toBe('إنشاء قاعدة خاصة لمركز التأكيد');
    expect((await readConfirmationRules(db as never, 'c1')).map((r) => r.id)).toEqual([body.id]);
  });

  it('GET lists it with its words and source names, counts it under its template, and keeps the seven others OFF', async () => {
    await create({ ...handFor(['sara']), templateKey: 'new-employee-hand' });
    const { body } = await list();
    expect(body.rules).toHaveLength(1);
    expect(body.rules[0]).toMatchObject({ name: 'الجديدة', state: 'ACTIVE', stateAr: 'شغّالة', whatAr: 'حد اليد 2', createdBy: null });
    expect(body.rules[0].scopeAr).toBe('على: سارة · بكل المتاجر');
    const counts = Object.fromEntries(body.templates.map((t: any) => [t.key, t.activeCount]));
    expect(counts['new-employee-hand']).toBe(1);
    expect(Object.values(counts).filter((n) => n === 0)).toHaveLength(7);
    expect(body.numbers.map((n: any) => n.key)).toEqual(['hand', 'idleMinutes', 'pullPerHour']);
    expect(body.people.map((p: any) => p.id).sort()).toEqual(['huda', 'legacy', 'mod', 'sara']);
    expect(body.canEdit).toBe(true);
  });

  it('GET without «عرض الموظفين»: no names at all — counts instead', async () => {
    await create(handFor(['sara']));
    state.viewer = await viewer(['settings.view']);
    const { status, body } = await list();
    expect(status).toBe(200);
    expect(body.people).toBeNull();
    expect(body.canEdit).toBe(false);
    expect(JSON.stringify(body)).not.toContain('سارة');
  });
});

describe('2 · a rule that binds nobody needs an explicit «I know»', () => {
  it('a hand for the moderator alone (she never pulls): 409 with the preview, nothing written; with confirmBindsNobody it is saved', async () => {
    const first = await create(handFor(['mod']));
    expect(first.status).toBe(409);
    expect(first.body.code).toBe('RULE_BINDS_NOBODY');
    expect(first.body.errorAr).toMatch(/ما بتمسك حدا/);
    expect(first.body.preview.bound).toEqual([]);
    expect(first.body.preview.notBound.find((n: any) => n.id === 'mod').reason).toMatch(/ما بتسحب/);
    expect(state.rules).toHaveLength(0);
    const second = await create({ ...handFor(['mod']), confirmBindsNobody: true });
    expect(second.status).toBe(201);
    expect(JSON.parse(state.audits[0].newData).confirmedBindsNobody).toBe(true);
  });

  it('a hand while the switches it rides on are off binds nobody — the preview says it does not act now', async () => {
    state.returnsOn = false;
    const { status, body } = await create(handFor(null));
    expect(status).toBe(409);
    expect(body.preview.notes.join(' ')).toMatch(/ما بيشتغل هلق/);
  });
});

describe('3 · refused saves write nothing', () => {
  it.each([
    ['a kind that does not act yet', { kind: 'ORDER_NUMBERS', name: 'x', storeId: 's1', payload: { proofSeconds: 20 } }, 400, 'RULE_KIND_NOT_ACTING'],
    ['a hand outside its range', handFor(null, 11), 400, 'RULE_PAYLOAD'],
    ['a person of another company', handFor(['other']), 400, 'RULE_PEOPLE'],
    ['a store of another company', handFor(null, 2, { storeId: 's9' }), 400, 'RULE_SCOPE'],
    ['a length of 0 days', handFor(null, 2, { days: 0 }), 400, 'RULE_DATES'],
  ])('%s', async (_n, body, status, code) => {
    const r = await create(body);
    expect([r.status, r.body.code]).toEqual([status, code]);
    expect(typeof r.body.errorAr).toBe('string');
    expect(state.rules).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it('a second rule on the same number, level and target is refused with the other rule named', async () => {
    await create(handFor(['sara']));
    const r = await create({ ...handFor(['sara'], 3), name: 'تانية' });
    expect([r.status, r.body.code]).toEqual([409, 'RULE_OVERLAP']);
    expect(r.body.errorAr).toContain('«الجديدة»');
    expect(state.rules).toHaveLength(1);
  });

  it.each([
    ['settings.manage', ['settings.view', 'users.view']],
    ['users.view', ['settings.view', 'settings.manage']],
  ])('403 without %s — nothing written', async (_k, keys) => {
    state.viewer = await viewer(keys);
    const res = await listDoor.POST(json(handFor(['sara'])));
    expect(res.status).toBe(403);
    expect(state.rules).toHaveLength(0);
  });

  it('the preview asks «عرض الموظفين» too (it names people)', async () => {
    state.viewer = await viewer(['settings.view', 'settings.manage']);
    expect((await previewDoor.POST(json(handFor(null)))).status).toBe(403);
  });
});

describe('4 · stop, rename, dates — never delete', () => {
  it('stop keeps the row, writes one audit row, and the employee numbers stop reading it at once', async () => {
    const { body } = await create(handFor(['sara']));
    expect(await readConfirmationRules(db as never, 'c1')).toHaveLength(1);
    const r = await patch(body.id, { action: 'stop' });
    expect(r.status).toBe(200);
    expect(state.rules).toHaveLength(1);
    expect(state.rules[0].isActive).toBe(false);
    expect(describeAction(audit.mock.calls.at(-1)![0].action as string, 'ConfirmationRule')).toBe('إيقاف قاعدة خاصة لمركز التأكيد');
    expect(await readConfirmationRules(db as never, 'c1')).toHaveLength(0);
    // A stopped rule changes no more.
    expect((await patch(body.id, { action: 'rename', name: 'جديد' })).body.code).toBe('RULE_STOPPED');
    expect((await patch(body.id, { action: 'stop' })).status).toBe(409);
  });

  it('rename and dates go through the validator; an empty name and a length of 91 days are refused', async () => {
    const { body } = await create(handFor(['sara']));
    expect((await patch(body.id, { action: 'rename', name: '  ' })).body.code).toBe('RULE_NAME');
    expect((await patch(body.id, { action: 'rename', name: 'سارة أسبوع' })).body.name).toBe('سارة أسبوع');
    expect((await patch(body.id, { action: 'dates', days: 91 })).body.code).toBe('RULE_DATES');
    const dated = await patch(body.id, { action: 'dates', days: 7 });
    expect(dated.status).toBe(200);
    expect(Date.parse(dated.body.effectiveTo) - Date.parse(dated.body.effectiveFrom)).toBe(7 * 86_400_000);
    // The start of a rule that has begun does not move.
    expect((await patch(body.id, { action: 'dates', days: 7, start: 'NEXT_WORK_START' })).body.code).toBe('RULE_STARTED');
  });

  it('another company\'s rule is «not found»; an unknown action is refused; there is no DELETE door', async () => {
    state.rules.push({ id: 'theirs', companyId: 'c2', storeId: null, name: 'لإلهم', kind: 'EMPLOYEE_NUMBERS', userIds: null, productId: null, channelKind: null, phase: null, hoursFrom: null, hoursTo: null, effectiveFrom: new Date(0), effectiveTo: null, isActive: true, payload: { hand: 2 }, createdAt: new Date(0) });
    expect((await patch('theirs', { action: 'stop' })).status).toBe(404);
    expect(state.rules[0].isActive).toBe(true);
    expect((await patch('theirs', { action: 'delete' })).body.code).toBe('UNKNOWN_ACTION');
    expect('DELETE' in oneDoor).toBe(false);
    expect('DELETE' in listDoor).toBe(false);
    expect('delete' in db.confirmationRule).toBe(false);
  });

  it('403 without settings.manage', async () => {
    const { body } = await create(handFor(['sara']));
    state.viewer = await viewer(['settings.view', 'users.view']);
    expect((await patch(body.id, { action: 'stop' })).status).toBe(403);
    expect(state.rules[0].isActive).toBe(true);
  });
});
