import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * THE WAREHOUSE DOORS — /api/geo/warehouses, /:id, /:id/keepers.
 *
 * People are built the way a session builds them: `computeEffectiveGrants`
 * over role rows, personal overrides (ALLOW and DENY) and a roleId-null legacy
 * account, and the REAL `can` decides every door. The database is a small
 * in-memory one that answers the few queries these doors ask, so tenancy
 * (another company), reach (another country, a keeper's confinement) and the
 * stop refusals are judged by the code under test, not by a mock's answer.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- an in-memory table row; every field is read by name
type Row = Record<string, any>;
const S = vi.hoisted(() => ({
  current: null as unknown as SessionUser,
  data: {} as Record<string, Row[]>,
  rolePerms: {} as Record<string, string[]>,
  overrides: {} as Record<string, { permission: string; effect: 'ALLOW' | 'DENY' }[]>,
  audit: [] as Row[],
  asked: [] as Row[],
  seq: 0,
}));

function matches(row: Row, where: Row = {}): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (v === undefined) continue;
    if (k === 'AND') { if (!(v as Row[]).every((w) => matches(row, w))) return false; continue; }
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      if ('in' in v && !(v.in as unknown[]).includes(row[k])) return false;
      if ('notIn' in v && (v.notIn as unknown[]).includes(row[k])) return false;
      if ('not' in v && row[k] === v.not) return false;
      continue;
    }
    if (row[k] !== v) return false;
  }
  return true;
}

vi.mock('@/lib/db', () => {
  const t = (name: string) => ({
    findMany: async ({ where }: Row = {}) => (S.data[name] ?? []).filter((r) => matches(r, where)).map((r) => ({ ...r })),
    findFirst: async ({ where }: Row = {}) => {
      const r = (S.data[name] ?? []).find((x) => matches(x, where));
      return r ? { ...r } : null;
    },
    count: async ({ where }: Row = {}) => (S.data[name] ?? []).filter((r) => matches(r, where)).length,
  });
  const keepersOf = (w: Row) => (S.data.userWarehouseAccess ?? []).filter((k) => k.warehouseId === w.id);
  const user = (id: string) => (S.data.user ?? []).find((u) => u.id === id);
  const db: Row = {
    country: t('country'),
    store: t('store'),
    user: t('user'),
    productionBatch: t('productionBatch'),
    userCountryAccess: t('userCountryAccess'),
    userStoreAccess: {
      findMany: async ({ where }: Row) =>
        (S.data.userStoreAccess ?? []).filter((r) => matches(r, where)).map((r) => ({
          ...r,
          store: { countryId: (S.data.store ?? []).find((s) => s.id === r.storeId)?.countryId },
        })),
    },
    userWarehouseAccess: {
      ...t('userWarehouseAccess'),
      deleteMany: async ({ where }: Row) => {
        const before = S.data.userWarehouseAccess.length;
        S.data.userWarehouseAccess = S.data.userWarehouseAccess.filter((r) => !matches(r, where));
        return { count: before - S.data.userWarehouseAccess.length };
      },
      createMany: async ({ data }: Row) => {
        for (const d of data as Row[]) {
          if (!S.data.userWarehouseAccess.some((r) => r.userId === d.userId && r.warehouseId === d.warehouseId)) {
            S.data.userWarehouseAccess.push({ id: `uwa${++S.seq}`, ...d });
          }
        }
        return { count: (data as Row[]).length };
      },
    },
    warehouse: {
      findMany: async ({ where }: Row) =>
        (S.asked.push(where), S.data.warehouse ?? []).filter((r) => matches(r, where)).map((w) => ({
          ...w,
          keepers: keepersOf(w).map((k) => ({ userId: k.userId, user: { id: k.userId, name: user(k.userId)?.name } })),
        })),
      findFirst: async ({ where, select }: Row) => {
        const w = (S.data.warehouse ?? []).find((x) => matches(x, where));
        if (!w) return null;
        return select?.keepers ? { ...w, keepers: keepersOf(w).map((k) => ({ userId: k.userId })) } : { ...w };
      },
      create: async ({ data }: Row) => {
        if (S.data.warehouse.some((w) => w.companyId === data.companyId && w.countryId === data.countryId && w.name === data.name)) {
          throw new Error('unique');
        }
        const row = { id: `w${++S.seq}`, isActive: true, createdAt: new Date(), ...data };
        S.data.warehouse.push(row);
        return { ...row };
      },
      update: async ({ where, data }: Row) => {
        const w = S.data.warehouse.find((x) => x.id === where.id)!;
        Object.assign(w, data);
        return { ...w };
      },
    },
    rolePermission: {
      findMany: async ({ where }: Row) =>
        (where.roleId ? S.rolePerms[where.roleId] ?? [] : []).map((permission) => ({ permission, scope: 'ALL_COMPANY', scopeIds: null })),
    },
    userPermission: {
      findMany: async ({ where }: Row) =>
        (S.overrides[where.userId] ?? []).map((o) => ({ ...o, scope: 'ALL_COMPANY', scopeIds: null })),
    },
  };
  db.$transaction = async (fn: (tx: Row) => unknown) => fn(db);
  // 19/11 (W2a): the stop locks the warehouse row FOR UPDATE before it counts (`warehouse-intake.lockWarehouseForStop`).
  db.$executeRaw = async () => 1;
  return { db };
});

vi.mock('@/lib/auth', () => ({
  requireCompanyTenant: async () => ({ user: S.current, companyId: (S.current as Row).companyId }),
}));
vi.mock('@/lib/authorization', async (orig) => {
  const real = await orig<typeof import('@/lib/authorization')>();
  return {
    ...real,
    requirePermission: async (k: string) => {
      if (!real.can(S.current, k)) throw new Error(`Forbidden: missing required permission ${k}`);
      return S.current;
    },
  };
});
vi.mock('@/lib/audit', () => ({ logAudit: async (e: Row) => void S.audit.push(e) }));

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import * as collection from './route';
import * as one from './[id]/route';
import * as keepers from './[id]/keepers/route';

const C1 = 'c1';
const C2 = 'c2';
const SY = '11111111-1111-4111-8111-111111111111';
const JO = '22222222-2222-4222-8222-222222222222';
const FOREIGN = '33333333-3333-4333-8333-333333333333';

/** Puts the person in the session exactly as a login would. */
async function as(id: string) {
  const u = S.data.user.find((x) => x.id === id)!;
  const base = { ...u, permissions: [] } as unknown as SessionUser;
  S.current = attachGrants(base, await computeEffectiveGrants({ id: u.id, role: u.role, roleId: u.roleId ?? null }));
}

const call = (body: unknown, method = 'POST') =>
  new Request('http://x/api/geo/warehouses', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const p = (id: string) => ({ params: Promise.resolve({ id }) });
const list = async (q = '') => {
  const res = await collection.GET(new Request(`http://x/api/geo/warehouses${q}`));
  return { status: res.status, body: await res.json() };
};

beforeEach(() => {
  S.seq = 0;
  S.audit = [];
  S.rolePerms = {
    'r-admin': ['geo.view', 'geo.manage', 'inventory.view', 'inventory.adjust', 'ops.prepare'],
    'r-viewer': ['geo.view', 'inventory.view'],
    'r-keeper': ['geo.view', 'inventory.view', 'inventory.adjust', 'ops.prepare'],
    'r-finance': ['geo.view', 'finance.view', 'wallets.manage'],
  };
  S.overrides = {
    'u-plus': [{ permission: 'geo.manage', effect: 'ALLOW' }],
    'u-denied': [{ permission: 'geo.manage', effect: 'DENY' }],
  };
  S.data = {
    country: [
      { id: SY, companyId: C1, isActive: true },
      { id: JO, companyId: C1, isActive: true },
      { id: FOREIGN, companyId: C2, isActive: true },
    ],
    store: [
      { id: 's-sy', companyId: C1, countryId: SY },
      { id: 's-jo', companyId: C1, countryId: JO },
    ],
    user: [
      { id: 'u-owner', name: 'المالك', email: 'o@x', role: 'SUPER_ADMIN', roleId: null, status: 'ACTIVE', companyId: C1 },
      { id: 'u-admin', name: 'مدير', email: 'a@x', role: 'CUSTOM', roleId: 'r-admin', status: 'ACTIVE', companyId: C1 },
      { id: 'u-legacy-admin', name: 'مدير قديم', email: 'la@x', role: 'COMPANY_ADMIN', roleId: null, status: 'ACTIVE', companyId: C1 },
      { id: 'u-legacy-wh', name: 'مخزن قديم', email: 'lw@x', role: 'WAREHOUSE', roleId: null, status: 'ACTIVE', companyId: C1 },
      { id: 'u-viewer', name: 'مشاهد', email: 'v@x', role: 'CUSTOM', roleId: 'r-viewer', status: 'ACTIVE', companyId: C1 },
      { id: 'u-keeper', name: 'أمينة', email: 'k@x', role: 'CUSTOM', roleId: 'r-keeper', status: 'ACTIVE', companyId: C1 },
      { id: 'u-keeper2', name: 'أمين تاني', email: 'k2@x', role: 'CUSTOM', roleId: 'r-keeper', status: 'ACTIVE', companyId: C1 },
      { id: 'u-store-jo', name: 'متجر الأردن', email: 'sj@x', role: 'CUSTOM', roleId: 'r-viewer', status: 'ACTIVE', companyId: C1 },
      { id: 'u-plus', name: 'زيادة', email: 'p@x', role: 'CUSTOM', roleId: 'r-keeper', status: 'ACTIVE', companyId: C1 },
      { id: 'u-denied', name: 'ممنوع', email: 'd@x', role: 'CUSTOM', roleId: 'r-admin', status: 'ACTIVE', companyId: C1 },
      { id: 'u-finance', name: 'مالية', email: 'f@x', role: 'CUSTOM', roleId: 'r-finance', status: 'ACTIVE', companyId: C1 },
      { id: 'u-other-co', name: 'غريب', email: 'g@x', role: 'CUSTOM', roleId: 'r-admin', status: 'ACTIVE', companyId: C2 },
    ],
    userCountryAccess: [
      { userId: 'u-viewer', countryId: SY },
      { userId: 'u-keeper', countryId: SY },
      { userId: 'u-keeper2', countryId: SY },
      { userId: 'u-store-jo', countryId: SY },
      { userId: 'u-store-jo', countryId: JO },
      { userId: 'u-finance', countryId: SY },
    ],
    userStoreAccess: [{ userId: 'u-store-jo', storeId: 's-jo' }],
    warehouse: [
      { id: 'w-sy1', companyId: C1, countryId: SY, name: 'الرئيسي', isActive: true, createdAt: new Date() },
      { id: 'w-sy2', companyId: C1, countryId: SY, name: 'الفرع', isActive: true, createdAt: new Date() },
      { id: 'w-jo1', companyId: C1, countryId: JO, name: 'الرئيسي', isActive: true, createdAt: new Date() },
      { id: 'w-c2', companyId: C2, countryId: FOREIGN, name: 'غريب', isActive: true, createdAt: new Date() },
    ],
    userWarehouseAccess: [{ id: 'uwa0', userId: 'u-keeper', warehouseId: 'w-sy1' }],
    productionBatch: [],
  };
});

const ids = (b: { warehouses: { id: string }[] }) => b.warehouses.map((w) => w.id).sort();

describe('GET — the warehouses a person reaches, never another company’s', () => {
  it('the owner: every warehouse of HIS company, with keepers', async () => {
    await as('u-owner');
    const { status, body } = await list();
    expect(status).toBe(200);
    expect(ids(body)).toEqual(['w-jo1', 'w-sy1', 'w-sy2']);
    expect(body.warehouses.find((w: Row) => w.id === 'w-sy1').keepers).toEqual([{ id: 'u-keeper', name: 'أمينة' }]);
    expect(JSON.stringify(body)).not.toContain('companyId');
  });

  it('the read itself is scoped to the session company (the reach filter is the second lock, not the only one)', async () => {
    await as('u-owner');
    S.asked = [];
    await list();
    expect(S.asked).toEqual([expect.objectContaining({ companyId: C1 })]);
  });

  it('a viewer assigned Syria: Syria’s warehouses only, and NO staff names', async () => {
    await as('u-viewer');
    const { body } = await list();
    expect(ids(body)).toEqual(['w-sy1', 'w-sy2']);
    expect(body.warehouses.every((w: Row) => !('keepers' in w))).toBe(true);
  });

  it('a keeper: only the warehouse she keeps', async () => {
    await as('u-keeper');
    expect(ids((await list()).body)).toEqual(['w-sy1']);
  });

  it('a keeper who lost her country: nothing, although her keeper row stays', async () => {
    S.data.userCountryAccess = S.data.userCountryAccess.filter((r) => r.userId !== 'u-keeper');
    await as('u-keeper');
    expect(ids((await list()).body)).toEqual([]);
    expect(S.data.userWarehouseAccess).toHaveLength(1);
  });

  it('somebody confined to a named store in Jordan: Jordan only, though Syria is assigned too', async () => {
    await as('u-store-jo');
    expect(ids((await list()).body)).toEqual(['w-jo1']);
  });

  it('a stopped country hides its warehouses from everyone but the owner’s reach rule', async () => {
    S.data.country.find((c) => c.id === SY)!.isActive = false;
    await as('u-viewer');
    expect(ids((await list()).body)).toEqual([]);
  });

  it('NEGATIVE: without «geo.view» — 403', async () => {
    S.rolePerms['r-viewer'] = ['inventory.view'];
    await as('u-viewer');
    expect((await list()).status).toBe(403);
  });
});

describe('POST — define a warehouse (geo.manage only)', () => {
  it('a role holding geo.manage creates it, and the audit says so', async () => {
    await as('u-admin');
    const res = await collection.POST(call({ countryId: SY, name: '  الشمال ' }));
    expect(res.status).toBe(201);
    expect((await res.json()).warehouse).toMatchObject({ companyId: C1, countryId: SY, name: 'الشمال' });
    expect(S.audit.map((a) => a.action)).toEqual(['WAREHOUSE_CREATED']);
  });

  it('a roleId-null legacy COMPANY_ADMIN creates it (the fallback gives geo.manage)', async () => {
    await as('u-legacy-admin');
    expect((await collection.POST(call({ countryId: JO, name: 'الجنوب' }))).status).toBe(201);
  });

  it('a personal ALLOW of geo.manage opens it', async () => {
    await as('u-plus');
    expect((await collection.POST(call({ countryId: SY, name: 'الشمال' }))).status).toBe(201);
  });

  it.each([
    ['a viewer', 'u-viewer'],
    ['a keeper', 'u-keeper'],
    ['a roleId-null legacy WAREHOUSE account', 'u-legacy-wh'],
    ['an admin role with a personal DENY of geo.manage', 'u-denied'],
  ])('NEGATIVE: %s — 403, nothing created', async (_l, who) => {
    await as(who);
    const res = await collection.POST(call({ countryId: SY, name: 'الشمال' }));
    expect(res.status).toBe(403);
    expect(S.data.warehouse).toHaveLength(4);
  });

  it('NEGATIVE: a country of another company — 404, nothing created', async () => {
    await as('u-admin');
    const res = await collection.POST(call({ countryId: FOREIGN, name: 'الشمال' }));
    expect(res.status).toBe(404);
    expect(S.data.warehouse).toHaveLength(4);
  });

  it('the same name twice in ONE country — 409 in Arabic; in ANOTHER country — allowed', async () => {
    await as('u-admin');
    const dup = await collection.POST(call({ countryId: SY, name: 'الفرع' }));
    expect(dup.status).toBe(409);
    const body = await dup.json();
    expect(body.code).toBe('NAME_TAKEN');
    expect(body.errorAr).toMatch(/[؀-ۿ]/);
    expect((await collection.POST(call({ countryId: JO, name: 'الفرع' }))).status).toBe(201);
  });

  it.each([
    [{ countryId: SY, name: 'ا' }],
    [{ countryId: SY }],
    [{ name: 'الشمال' }],
    [{ countryId: SY, name: 'الشمال', isActive: false }],
  ])('NEGATIVE: a malformed body %j — 400 with an Arabic sentence', async (body) => {
    await as('u-admin');
    const res = await collection.POST(call(body));
    expect(res.status).toBe(400);
    expect((await res.json()).errorAr).toMatch(/[؀-ۿ]/);
  });
});

describe('PATCH — rename, stop, start; never delete', () => {
  it('there is no DELETE door at all', () => {
    expect((one as Row).DELETE).toBeUndefined();
    expect((collection as Row).DELETE).toBeUndefined();
  });

  it('renames', async () => {
    await as('u-admin');
    const res = await one.PATCH(call({ name: 'المستودع الكبير' }, 'PATCH'), p('w-sy1'));
    expect(res.status).toBe(200);
    expect(S.audit.map((a) => a.action)).toEqual(['WAREHOUSE_RENAMED']);
  });

  it('NEGATIVE: a rename onto a sibling’s name — 409', async () => {
    await as('u-admin');
    expect((await one.PATCH(call({ name: 'الفرع' }, 'PATCH'), p('w-sy1'))).status).toBe(409);
    expect(S.data.warehouse.find((w) => w.id === 'w-sy1')!.name).toBe('الرئيسي');
  });

  it('NEGATIVE: stop refused while a batch holds units there — 409 in Arabic, still active', async () => {
    S.data.productionBatch.push({ companyId: C1, warehouseId: 'w-sy1', quantityRemaining: 5 });
    await as('u-admin');
    const res = await one.PATCH(call({ isActive: false }, 'PATCH'), p('w-sy1'));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('WAREHOUSE_NOT_EMPTY');
    expect(body.errorAr).toContain('فيه بضاعة');
    expect(S.data.warehouse.find((w) => w.id === 'w-sy1')!.isActive).toBe(true);
    expect(S.audit).toEqual([]);
  });

  it('NEGATIVE: a NEGATIVE row (the shelf owes units there) refuses the stop too', async () => {
    S.data.productionBatch.push({ companyId: C1, warehouseId: 'w-sy1', quantityRemaining: -2 });
    await as('u-admin');
    expect((await one.PATCH(call({ isActive: false }, 'PATCH'), p('w-sy1'))).status).toBe(409);
  });

  it('empty batches, another warehouse’s units and another company’s rows do not block; stopped, it stays in the list', async () => {
    S.data.productionBatch.push(
      { companyId: C1, warehouseId: 'w-sy1', quantityRemaining: 0 },
      { companyId: C1, warehouseId: 'w-sy2', quantityRemaining: 9 },
      { companyId: C1, warehouseId: null, quantityRemaining: 9 }
    );
    await as('u-admin');
    const res = await one.PATCH(call({ isActive: false }, 'PATCH'), p('w-sy1'));
    expect(res.status).toBe(200);
    expect(S.audit.map((a) => a.action)).toEqual(['WAREHOUSE_STOPPED']);
    const { body } = await list();
    expect(body.warehouses.find((w: Row) => w.id === 'w-sy1')).toMatchObject({ isActive: false });
    expect((await one.PATCH(call({ isActive: true }, 'PATCH'), p('w-sy1'))).status).toBe(200);
    expect(S.audit.map((a) => a.action)).toEqual(['WAREHOUSE_STOPPED', 'WAREHOUSE_STARTED']);
  });

  it('NEGATIVE: another company’s warehouse — 404, untouched', async () => {
    await as('u-admin');
    expect((await one.PATCH(call({ name: 'لي' }, 'PATCH'), p('w-c2'))).status).toBe(404);
    expect(S.data.warehouse.find((w) => w.id === 'w-c2')!.name).toBe('غريب');
  });

  it.each([[{}], [{ countryId: JO }], [{ name: 'x', companyId: C2 }]])('NEGATIVE: body %j — 400 (a warehouse never moves country)', async (body) => {
    await as('u-admin');
    const res = await one.PATCH(call(body, 'PATCH'), p('w-sy1'));
    expect(res.status).toBe(400);
    expect((await res.json()).errorAr).toMatch(/[؀-ۿ]/);
    expect(S.data.warehouse.find((w) => w.id === 'w-sy1')!.countryId).toBe(SY);
  });

  it('NEGATIVE: a viewer cannot stop it — 403', async () => {
    await as('u-viewer');
    expect((await one.PATCH(call({ isActive: false }, 'PATCH'), p('w-sy1'))).status).toBe(403);
    expect(S.data.warehouse.find((w) => w.id === 'w-sy1')!.isActive).toBe(true);
  });
});

describe('keepers — only people who reach the country, only by geo.manage', () => {
  const put = (id: string, userIds: string[]) => keepers.PUT(call({ userIds }, 'PUT'), p(id));
  const keepersOf = (w: string) => S.data.userWarehouseAccess.filter((r) => r.warehouseId === w).map((r) => r.userId).sort();

  it('sets the whole list', async () => {
    await as('u-admin');
    const res = await put('w-sy2', ['u-keeper2', 'u-viewer']);
    expect(res.status).toBe(200);
    expect(keepersOf('w-sy2')).toEqual(['u-keeper2', 'u-viewer']);
    expect(S.audit.map((a) => a.action)).toEqual(['WAREHOUSE_KEEPERS_SET']);
    expect((await put('w-sy2', ['u-keeper2'])).status).toBe(200);
    expect(keepersOf('w-sy2')).toEqual(['u-keeper2']);
    expect((await put('w-sy2', [])).status).toBe(200);
    expect(keepersOf('w-sy2')).toEqual([]);
    expect(keepersOf('w-sy1')).toEqual(['u-keeper']); // another warehouse's keepers untouched
  });

  it('a person who sees every country (geo.manage) may be named anywhere', async () => {
    await as('u-owner');
    expect((await put('w-jo1', ['u-plus'])).status).toBe(200);
  });

  it('NEGATIVE: somebody who does not reach the country — 400 naming her, nothing written', async () => {
    await as('u-admin');
    const res = await put('w-jo1', ['u-keeper']);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('KEEPER_OUTSIDE_COUNTRY');
    expect(body.errorAr).toContain('أمينة');
    expect(keepersOf('w-jo1')).toEqual([]);
  });

  it('NEGATIVE: somebody confined to a named store in Jordan cannot keep a Syrian warehouse', async () => {
    await as('u-admin');
    expect((await put('w-sy2', ['u-store-jo'])).status).toBe(400);
  });

  it('NEGATIVE: a person of another company — 400, nothing written', async () => {
    await as('u-admin');
    expect((await put('w-sy2', ['u-other-co'])).status).toBe(400);
    expect(keepersOf('w-sy2')).toEqual([]);
  });

  it('NEGATIVE: another company’s warehouse — 404', async () => {
    await as('u-admin');
    expect((await put('w-c2', ['u-keeper2'])).status).toBe(404);
    expect((await keepers.GET(new Request('http://x'), p('w-c2'))).status).toBe(404);
  });

  it('NEGATIVE: naming an account whose keys go beyond the caller’s — 403 (the geo-access rule)', async () => {
    await as('u-admin');
    const res = await put('w-sy2', ['u-finance']);
    expect(res.status).toBe(403);
    expect(keepersOf('w-sy2')).toEqual([]);
  });

  it('NEGATIVE: un-naming such an account is refused too', async () => {
    S.data.userWarehouseAccess.push({ id: 'uwa9', userId: 'u-finance', warehouseId: 'w-sy2' });
    await as('u-admin');
    expect((await put('w-sy2', [])).status).toBe(403);
    expect(keepersOf('w-sy2')).toEqual(['u-finance']);
  });

  it('GET flags a keeper who lost her country', async () => {
    await as('u-admin');
    let body = await (await keepers.GET(new Request('http://x'), p('w-sy1'))).json();
    expect(body.keepers).toEqual([{ id: 'u-keeper', name: 'أمينة', reachesCountry: true }]);
    S.data.userCountryAccess = S.data.userCountryAccess.filter((r) => r.userId !== 'u-keeper');
    body = await (await keepers.GET(new Request('http://x'), p('w-sy1'))).json();
    expect(body.keepers).toEqual([{ id: 'u-keeper', name: 'أمينة', reachesCountry: false }]);
  });

  // 19/11 (W0b): the GET answer gained `candidates` — the picker's list. Additive: `keepers` above is unchanged.
  describe('candidates — the picker’s list: active people of THIS company who reach the country, by the PUT’s own rule', () => {
    const candidates = async (w: string) =>
      ((await (await keepers.GET(new Request('http://x'), p(w))).json()).candidates as { id: string }[]).map((c) => c.id).sort();

    it('Syria: the owner, the geo.manage holders (role, legacy, personal ALLOW) and the people assigned Syria — no store-confined Jordanian, no stranger', async () => {
      await as('u-admin');
      expect(await candidates('w-sy1')).toEqual(
        ['u-admin', 'u-finance', 'u-keeper', 'u-keeper2', 'u-legacy-admin', 'u-owner', 'u-plus', 'u-viewer'].sort()
      );
    });

    it('Jordan: the store-confined Jordanian joins, the Syrians leave', async () => {
      await as('u-admin');
      expect(await candidates('w-jo1')).toEqual(['u-admin', 'u-legacy-admin', 'u-owner', 'u-plus', 'u-store-jo'].sort());
    });

    it('NEGATIVE: a suspended account and one who lost the country are not offered', async () => {
      S.data.user.find((u) => u.id === 'u-keeper2')!.status = 'SUSPENDED';
      S.data.userCountryAccess = S.data.userCountryAccess.filter((r) => r.userId !== 'u-viewer');
      await as('u-admin');
      const ids = await candidates('w-sy1');
      expect(ids).not.toContain('u-keeper2');
      expect(ids).not.toContain('u-viewer');
    });

    it('NEGATIVE: a personal DENY of geo.manage on an admin role takes away «every country» — no Syria row, not offered', async () => {
      await as('u-admin');
      expect(await candidates('w-sy1')).not.toContain('u-denied');
    });
  });

  it.each(['u-viewer', 'u-keeper', 'u-legacy-wh', 'u-denied'])('NEGATIVE: %s cannot read or set keepers — 403', async (who) => {
    await as(who);
    expect((await keepers.GET(new Request('http://x'), p('w-sy1'))).status).toBe(403);
    expect((await put('w-sy1', [])).status).toBe(403);
    expect(keepersOf('w-sy1')).toEqual(['u-keeper']);
  });
});
