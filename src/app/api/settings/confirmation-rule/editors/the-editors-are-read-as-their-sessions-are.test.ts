import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE (Q3c, 20/11) — `GET /api/settings/confirmation-rule/editors`, through the REAL engine.
 *
 * Nothing about permissions is mocked: `resolveAudience` runs for real over a fake database that answers role rows by roleId or
 * by the template of a legacy role, and personal ALLOW / DENY rows — so each person is built as her session would be.
 *
 *  1. `editors`: every ACTIVE person of this company who holds `settings.manage` — a personal «سماح» adds her, a personal «منع»
 *     removes her, the owner (full access) is in, another company and an inactive person never.
 *  2. `names`: the authors the stored document mentions — this company only.
 *  3. Without `users.view`: no names at all, the key's Arabic label still answered. Without `settings.view`: 403 in Arabic.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Person = { id: string; name: string; role: string; roleId: string | null; status: string; companyId: string };
type Override = { userId: string; permission: string; effect: 'ALLOW' | 'DENY' };

const { state, db } = vi.hoisted(() => {
  const state = {
    viewer: null as unknown as SessionUser,
    people: [] as Person[],
    roles: {} as Record<string, string[]>,
    templates: {} as Record<string, string[]>,
    overrides: [] as Override[],
    settings: {} as Record<string, unknown>,
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
        const keys = where.roleId ? state.roles[where.roleId] ?? [] : state.templates[where.role?.name] ?? [];
        return keys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null }));
      }),
    },
    company: { findUnique: vi.fn(async () => ({ settings: JSON.stringify(state.settings) })) },
  };
  return { state, db };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({ user: state.viewer, companyId: 'c1', storeId: 's1', countryId: 'k1', country: {} }),
  usersReachingStore: async (users: { id: string }[]) => new Set(users.map((u) => u.id)),
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

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { catalogItem } from '@/lib/permission-catalog';
import { CONFIRMATION_RULE_DEFAULT } from '@/lib/confirmation-rule-settings';
import { GET } from './route';

async function viewer(keys: string[]): Promise<SessionUser> {
  const base = { id: 'viewer', email: 'v@x', name: 'المدير', role: 'MANAGER', roleId: 'r-v', status: 'ACTIVE', companyId: 'c1', permissions: [] } as unknown as SessionUser;
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

let seq = 0;
beforeEach(async () => {
  vi.clearAllMocks();
  state.roles = { 'r-admin': ['settings.view', 'settings.manage', 'users.view'], 'r-agent': ['confirmation.work', 'orders.view'], 'r-viewer': ['settings.view'] };
  state.templates = { MANAGER: ['settings.view', 'settings.manage'] };
  state.overrides = [
    { userId: 'given', permission: 'settings.manage', effect: 'ALLOW' },
    { userId: 'denied', permission: 'settings.manage', effect: 'DENY' },
  ];
  state.people = [
    { id: 'admin', name: 'أمل', role: 'ADMIN', roleId: 'r-admin', status: 'ACTIVE', companyId: 'c1' },
    { id: 'denied', name: 'دانة', role: 'ADMIN', roleId: 'r-admin', status: 'ACTIVE', companyId: 'c1' },
    { id: 'given', name: 'بشرى', role: 'CONFIRMATION_AGENT', roleId: 'r-agent', status: 'ACTIVE', companyId: 'c1' },
    { id: 'agent', name: 'سلمى', role: 'CONFIRMATION_AGENT', roleId: 'r-agent', status: 'ACTIVE', companyId: 'c1' },
    { id: 'legacy', name: 'جود', role: 'MANAGER', roleId: null, status: 'ACTIVE', companyId: 'c1' },
    { id: 'owner', name: 'المالك', role: 'SUPER_ADMIN', roleId: null, status: 'ACTIVE', companyId: 'c1' },
    { id: 'gone', name: 'هالة', role: 'ADMIN', roleId: 'r-admin', status: 'INACTIVE', companyId: 'c1' },
    { id: 'other', name: 'غريبة', role: 'ADMIN', roleId: 'r-admin', status: 'ACTIVE', companyId: 'c2' },
  ];
  state.settings = {};
  state.viewer = await viewer(['settings.view', 'users.view']);
  seq++;
});

describe('who may edit «أرقام القاعدة»', () => {
  it('every active holder of the edit key, as her session is built: role rows, a personal «سماح», a legacy template, the owner — never a «منع», an inactive person or another company', async () => {
    const { status, body } = await read();
    expect(status).toBe(200);
    expect(body.editors.map((e: any) => e.id).sort()).toEqual(['admin', 'given', 'legacy', 'owner'].sort());
    expect(Object.keys(body.editors[0]).sort()).toEqual(['id', 'name']);
    expect(body.keyLabel).toBe(catalogItem('settings.manage')!.ar);
  });

  it('NEGATIVE: a personal «منع» is her truth — her role holds the key, she is not listed (drop the override and she is)', async () => {
    expect((await read()).body.editors.some((e: any) => e.id === 'denied')).toBe(false);
    state.overrides = state.overrides.filter((o) => o.userId !== 'denied');
    expect((await read()).body.editors.some((e: any) => e.id === 'denied')).toBe(true);
  });
});

describe('the names behind the versions', () => {
  it('names every author the stored document mentions — this company only, whatever her status today', async () => {
    vi.resetModules();
    const r = { ...structuredClone(CONFIRMATION_RULE_DEFAULT) };
    state.settings = {
      confirmationRule: {
        v: 1, current: r, effectiveAt: '2026-11-19T09:00:00.000Z', savedAt: '2026-11-19T08:00:00.000Z', byUserId: 'admin',
        previous: [
          { rule: r, replacedAt: '2026-11-19T09:00:00.000Z', byUserId: 'gone' },
          { rule: r, replacedAt: '2026-11-18T09:00:00.000Z', byUserId: 'other' },
          { rule: r, replacedAt: '2026-11-17T09:00:00.000Z', byUserId: null },
        ],
      },
    };
    const { GET: fresh } = await import('./route');
    const body = (await (await fresh()).json()) as any;
    expect(body.names).toEqual({ admin: 'أمل', gone: 'هالة' });
  });
});

describe('who may ask', () => {
  it('without «عرض المستخدمين»: no names at all — the key label only', async () => {
    state.viewer = await viewer(['settings.view']);
    const { status, body } = await read();
    expect(status).toBe(200);
    expect(body).toEqual({ keyLabel: catalogItem('settings.manage')!.ar, editors: null, names: null });
    expect(db.user.findMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: without «عرض الإعدادات» — 403 in Arabic, nothing read', async () => {
    state.viewer = await viewer(['users.view']);
    const { status, body } = await read();
    expect(status).toBe(403);
    expect(body.errorAr).toMatch(/[؀-ۿ]/);
    expect(db.user.findMany).not.toHaveBeenCalled();
  });
});
