import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE (Q1a, 19/11) — `GET /api/confirmation/rules/people`, through the REAL engine.
 *
 * Nothing about permissions is mocked. The door's own lookup (`resolveAudience`) runs for real over a fake database that
 * answers role rows by roleId or by the template of a legacy role, and personal ALLOW / DENY rows per person — so each person
 * is built exactly as her session would be (`computeEffectiveGrants` → `attachGrants` → `can`). Only the store-reach lookup
 * (`usersReachingStore`, its own tests elsewhere) is stubbed, and it answers by the person's stores.
 *
 *  1. Listed: every ACTIVE person of this company who reaches this store and holds any desk key — with the readiness.
 *  2. Not listed: another company's person · an inactive person · a person with no access to this store · a person with no
 *     desk key.
 *  3. A personal «منع» / «سماح» is read: the answer is NOT the role template's.
 *  4. The owner is the owner. `confirmation.supervise` frees nobody.
 *  5. 403 without `settings.view`, 403 without `users.view` — and nothing is read.
 *  6. No order and no customer in the answer: exactly id, name, roleLabel, readiness.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Person = { id: string; name: string; role: string; roleId: string | null; status: string; companyId: string; stores: string[] };
type Override = { userId: string; permission: string; effect: 'ALLOW' | 'DENY' };

const { state, db } = vi.hoisted(() => {
  const state = {
    viewer: null as unknown as SessionUser,
    storeId: 's1',
    people: [] as Person[],
    /** role rows: by roleId, and the system templates by name (companyId null). */
    roles: {} as Record<string, { name: string; keys: string[] }>,
    templates: {} as Record<string, string[]>,
    overrides: [] as Override[],
    limited: false,
  };
  const pick = (where: Record<string, any>) =>
    state.people.filter(
      (p) =>
        (where.companyId === undefined || p.companyId === where.companyId) &&
        (where.status === undefined || p.status === where.status) &&
        (where.id?.in === undefined || where.id.in.includes(p.id))
    );
  const db = {
    user: {
      findMany: vi.fn(async ({ where }: { where: Record<string, any> }) =>
        pick(where).map((p) => ({
          id: p.id, name: p.name, email: `${p.id}@x`, role: p.role, roleId: p.roleId, status: p.status, companyId: p.companyId,
          roleRef: p.roleId ? { name: state.roles[p.roleId]?.name ?? null } : null,
        }))
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
  };
  return { state, db };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({ user: state.viewer, companyId: 'c1', storeId: state.storeId, countryId: 'co1', country: {} }),
  usersReachingStore: async (users: { id: string }[], companyId: string, storeId: string) =>
    new Set(users.filter((u) => state.people.find((p) => p.id === u.id && p.companyId === companyId)?.stores.includes(storeId)).map((u) => u.id)),
}));
vi.mock('@/lib/rate-limit', () => ({
  rateLimit: () => (state.limited ? { allowed: false, remaining: 0, retryAfterSec: 42 } : { allowed: true, remaining: 1, retryAfterSec: 0 }),
}));
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

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { GET } from './route';

/** CONFIRMATION_AGENT, read on the live site 1/11 — holds confirmation.supervise, no orders.unlock / orders.assign. */
const LIVE_AGENT = [
  'ai.assist', 'ai.use', 'confirmation.issues', 'confirmation.issues_correct', 'confirmation.pull', 'confirmation.raise_issue',
  'confirmation.reassign', 'confirmation.supervise', 'confirmation.winback', 'confirmation.work', 'customers.view_basic', 'insights.view',
  'orders.change_price', 'orders.claim', 'orders.confirm', 'orders.contact_log', 'orders.edit', 'orders.note', 'orders.rating_link',
  'orders.release', 'orders.request_change', 'orders.view',
];
const FOLLOW_UP = ['confirmation.work', 'confirmation.pull', 'orders.confirm', 'orders.contact_log', 'orders.claim', 'orders.view', 'orders.release'];
const MODERATOR = ['orders.view', 'orders.confirm', 'orders.contact_log', 'orders.edit', 'orders.claim', 'orders.release'];
const WAREHOUSE = ['orders.view', 'dashboard.view'];
const ADMIN_VIEW = ['settings.view', 'users.view', 'orders.view'];

async function viewer(keys: string[]): Promise<SessionUser> {
  const base = { id: 'viewer', email: 'v@x', name: 'المدير', role: 'MANAGER', roleId: 'r-viewer', status: 'ACTIVE', companyId: 'c1', permissions: [] } as unknown as SessionUser;
  return attachGrants(
    base,
    await computeEffectiveGrants(base as never, {
      roleRows: async () => keys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
      overrideRows: async () => [],
    })
  );
}

const read = async () => {
  const res = await GET();
  return { status: res.status, body: (await res.json()) as any };
};
const row = (body: any, id: string) => body.people.find((p: any) => p.id === id);

beforeEach(async () => {
  vi.clearAllMocks();
  state.storeId = 's1';
  state.limited = false;
  state.roles = {
    'r-agent': { name: 'موظفة تأكيد', keys: LIVE_AGENT },
    'r-mod': { name: 'موديريتور', keys: MODERATOR },
    'r-wh': { name: 'مستودع', keys: WAREHOUSE },
    'r-viewer': { name: 'مدير', keys: ADMIN_VIEW },
  };
  state.templates = { FOLLOW_UP_AGENT: FOLLOW_UP };
  state.people = [
    { id: 'sara', name: 'سارة', role: 'CONFIRMATION_AGENT', roleId: 'r-agent', status: 'ACTIVE', companyId: 'c1', stores: ['s1'] },
    { id: 'huda', name: 'هدى', role: 'CONFIRMATION_AGENT', roleId: 'r-agent', status: 'ACTIVE', companyId: 'c1', stores: ['s1'] },
    { id: 'mona', name: 'منى', role: 'CONFIRMATION_AGENT', roleId: 'r-agent', status: 'ACTIVE', companyId: 'c1', stores: ['s1'] },
    { id: 'legacy', name: 'ليلى', role: 'FOLLOW_UP_AGENT', roleId: null, status: 'ACTIVE', companyId: 'c1', stores: ['s1'] },
    { id: 'mod', name: 'مازن', role: 'MODERATOR', roleId: 'r-mod', status: 'ACTIVE', companyId: 'c1', stores: ['s1'] },
    { id: 'owner', name: 'المالك', role: 'SUPER_ADMIN', roleId: null, status: 'ACTIVE', companyId: 'c1', stores: ['s1'] },
    { id: 'wh', name: 'وائل', role: 'WAREHOUSE', roleId: 'r-wh', status: 'ACTIVE', companyId: 'c1', stores: ['s1'] },
    { id: 'away', name: 'رنا', role: 'CONFIRMATION_AGENT', roleId: 'r-agent', status: 'ACTIVE', companyId: 'c1', stores: ['s2'] },
    { id: 'gone', name: 'دانة', role: 'CONFIRMATION_AGENT', roleId: 'r-agent', status: 'SUSPENDED', companyId: 'c1', stores: ['s1'] },
    { id: 'other', name: 'غريبة', role: 'CONFIRMATION_AGENT', roleId: 'r-agent', status: 'ACTIVE', companyId: 'c2', stores: ['s1'] },
  ];
  state.overrides = [
    { userId: 'huda', permission: 'confirmation.work', effect: 'DENY' },
    { userId: 'mona', permission: 'orders.assign', effect: 'ALLOW' },
  ];
  state.viewer = await viewer(ADMIN_VIEW);
});

describe('who is listed', () => {
  it('every ACTIVE person of this company who reaches this store and holds a desk key — nobody else', async () => {
    const { status, body } = await read();
    expect(status).toBe(200);
    expect(body.people.map((p: any) => p.id).sort()).toEqual(['huda', 'legacy', 'mod', 'mona', 'owner', 'sara']);
  });

  it('another company’s person never appears, even if she reaches a store of the same id', async () => {
    const { body } = await read();
    expect(row(body, 'other')).toBeUndefined();
  });

  it('an inactive person never appears', async () => {
    const { body } = await read();
    expect(row(body, 'gone')).toBeUndefined();
  });

  it('a person with no access to this store is not listed here — she is listed in her own store', async () => {
    expect(row((await read()).body, 'away')).toBeUndefined();
    state.storeId = 's2';
    expect(row((await read()).body, 'away')).toBeDefined();
  });

  it('nobody at the desk → an empty list, not an error', async () => {
    state.people = state.people.filter((p) => p.id === 'wh');
    const { status, body } = await read();
    expect(status).toBe(200);
    expect(body.people).toEqual([]);
  });
});

describe('each person as her session builds her', () => {
  it('the live agent holds confirmation.supervise and is BOUND — supervise frees nobody', async () => {
    const r = row((await read()).body, 'sara').readiness;
    expect(r.boundToHold).toBe(true);
    expect(r.hold).toBe('BOUND');
    expect(r.exemptBy).toEqual([]);
    expect(r.tools.every((t: any) => t.has)).toBe(true);
  });

  it('a personal «منع» on confirmation.work is read — not the role template that carries it', async () => {
    const r = row((await read()).body, 'huda').readiness;
    expect(r.worksDesk).toBe(false);
    expect(r.boundToHold).toBe(false);
    expect(r.decidesWithoutWork).toBe(true);
    const onTheLine = r.tools.find((t: any) => t.id === 'on_the_line');
    expect(onTheLine.has).toBe(false);
    expect(onTheLine.missing).toEqual([{ keys: ['confirmation.work'], label: '«العمل على طلباتي والمؤجلة»' }]);
  });

  it('a personal «سماح» of orders.assign frees her, and the answer names the key in Arabic', async () => {
    const r = row((await read()).body, 'mona').readiness;
    expect(r.boundToHold).toBe(false);
    expect(r.hold).toBe('EXEMPT');
    expect(r.exemptBy).toEqual([{ key: 'orders.assign', label: 'إسناد الطلبات' }]);
  });

  it('a roleId-null legacy account is built from the template of her role name', async () => {
    const r = row((await read()).body, 'legacy').readiness;
    expect(r.boundToHold).toBe(true);
    expect(r.tools.find((t: any) => t.id === 'pull').has).toBe(true);
    expect(r.tools.find((t: any) => t.id === 'raise_issue').missing).toEqual([{ keys: ['confirmation.raise_issue'], label: expect.any(String) }]);
  });

  it('a moderator decides without working, and is flagged, not bound', async () => {
    const r = row((await read()).body, 'mod').readiness;
    expect(r.decidesWithoutWork).toBe(true);
    expect(r.boundToHold).toBe(false);
    expect(r.hold).toBe('DOES_NOT_WORK');
  });

  it('the owner is the owner — never missing a key', async () => {
    const r = row((await read()).body, 'owner').readiness;
    expect(r.owner).toBe(true);
    expect(r.hold).toBe('OWNER');
    expect(r.tools.every((t: any) => t.has && t.missing.length === 0)).toBe(true);
  });

  it('the role label is the role row’s name, or the Arabic name of a legacy role', async () => {
    const { body } = await read();
    expect(row(body, 'sara').roleLabel).toBe('موظفة تأكيد');
    expect(row(body, 'legacy').roleLabel).toBe('موظف المتابعة');
  });
});

describe('who may ask, and what the answer carries', () => {
  it('403 without settings.view — and nobody is read', async () => {
    state.viewer = await viewer(['users.view']);
    const { status, body } = await read();
    expect(status).toBe(403);
    expect(body.errorAr).toBeTruthy();
    expect(db.user.findMany).not.toHaveBeenCalled();
  });

  it('403 without users.view — and nobody is read', async () => {
    state.viewer = await viewer(['settings.view']);
    const { status } = await read();
    expect(status).toBe(403);
    expect(db.user.findMany).not.toHaveBeenCalled();
  });

  it('rate-limited with an Arabic sentence and nothing read', async () => {
    state.limited = true;
    const { status, body } = await read();
    expect(status).toBe(429);
    expect(body.code).toBe('RATE_LIMITED');
    expect(body.errorAr).toMatch(/[؀-ۿ]/);
    expect(db.user.findMany).not.toHaveBeenCalled();
  });

  it('exactly id, name, roleLabel, readiness — no order, no customer, no email', async () => {
    const { body } = await read();
    for (const p of body.people) expect(Object.keys(p).sort()).toEqual(['id', 'name', 'readiness', 'roleLabel']);
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/customer|phone|address|email|@x|orderId/i);
  });

  it('writes nothing: the fake database has no write, and the door asked only reads', async () => {
    await read();
    for (const model of Object.values(db)) for (const fn of Object.keys(model)) expect(fn).toMatch(/^find/);
  });
});
