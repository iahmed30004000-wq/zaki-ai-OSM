import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE ROLE DOORS REFUSE AN ACTION WITHOUT THE KEY THAT OPENS ITS SCREEN —
 * and only a NEW one.
 *
 * «تعديل الطلبات» without «عرض الطلبات» is a tick that does nothing. The
 * three doors that write a role (create, replace, copy) refuse a save that
 * ADDS such a pair, with a 400 `ORPHAN_ACTION`. A pair the role already has
 * is left alone: five of the shipped templates hold «عرض العملاء» without
 * the basic tier and nine people stand on them, so a rule that judged the
 * whole list would lock the owner out of editing any of them.
 *
 * The replace door is also saved only OVER THE VERSION IT WAS READ AT
 * (RV171): a role editor opened before a colleague's change and saved after
 * it used to write its old list over the new one.
 * ═══════════════════════════════════════════════════════════════════════
 */

const h = vi.hoisted(() => ({
  db: {
    role: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    rolePermission: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
    user: { updateMany: vi.fn() },
    company: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
  actor: { id: 'u1', name: 'المدير', role: 'COMPANY_ADMIN', companyId: 'c1', status: 'ACTIVE' } as Record<string, unknown>,
}));

vi.mock('@/lib/db', () => ({ db: h.db }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: async () => h.actor,
  can: () => true,
  // The person holds every key at full scope: the granting rules are not what this file is about.
  getPermissionScope: () => ({ scope: 'ALL_COMPANY' }),
}));

import { POST as createRole } from './route';
import { PATCH as replaceRole } from './[id]/route';
import { POST as copyRole } from './[id]/duplicate/route';
import { keyLabel } from '@/lib/user-permissions';

const T = new Date('2026-10-28T10:00:00.000Z');
const rows = (...keys: string[]) => keys.map((permission) => ({ permission, scope: 'ALL_COMPANY', scopeIds: null }));
const role = (keys: string[], updatedAt: Date = T) => ({
  id: 'r1', companyId: 'c1', name: 'دور تجربة', isSystem: false, createdAt: T, updatedAt, permissions: rows(...keys),
});
const refusal = (view: string, action: string) => `لازم «${keyLabel(view)}» مع «${keyLabel(action)}»`;

beforeEach(() => {
  vi.clearAllMocks();
  h.db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(h.db));
  h.db.role.findFirst.mockResolvedValue(null);
  h.db.role.updateMany.mockResolvedValue({ count: 1 });
  h.db.role.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'r1', name: 'دور تجربة', ...data, permissions: [] }));
  h.db.role.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'r-new', ...data, permissions: [] }));
  h.db.rolePermission.findMany.mockResolvedValue([]);
  h.db.user.updateMany.mockResolvedValue({ count: 0 });
});

describe('creating a role', () => {
  const create = (permissions: unknown[]) =>
    createRole(new Request('http://x', { method: 'POST', body: JSON.stringify({ name: 'دور جديد', permissions }) }));

  it('an action alone is refused with ORPHAN_ACTION, naming both keys — and nothing is created', async () => {
    const res = await create([{ permission: 'orders.edit' }]);
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.code).toBe('ORPHAN_ACTION');
    expect(body.error).toBe(refusal('orders.view', 'orders.edit'));
    expect(h.db.role.create).not.toHaveBeenCalled();
  });

  it('the same action with its screen key is created', async () => {
    const res = await create([{ permission: 'orders.view' }, { permission: 'orders.edit' }]);
    expect(res.status, await res.clone().text()).toBe(201);
    expect(h.db.role.create).toHaveBeenCalledTimes(1);
  });

  it('an action that needs another action (import needs create) is refused without it', async () => {
    const res = await create([{ permission: 'orders.import' }]);
    expect((await res.json()).error).toBe(refusal('orders.create', 'orders.import'));
    expect(h.db.role.create).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a standalone action and a view alone are whole — nothing is asked of them', async () => {
    expect((await create([{ permission: 'orders.create' }, { permission: 'customers.create' }])).status).toBe(201);
    expect((await create([{ permission: 'orders.view' }])).status).toBe(201);
  });
});

describe('replacing a role', () => {
  const replace = (body: Record<string, unknown>) =>
    replaceRole(new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'r1' }) });
  const perms = (...keys: string[]) => keys.map((permission) => ({ permission }));

  it('taking the screen key out from under an action it holds is refused', async () => {
    h.db.role.findUnique.mockResolvedValue(role(['orders.view', 'orders.edit']));
    const res = await replace({ permissions: perms('orders.edit'), version: T.toISOString() });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(refusal('orders.view', 'orders.edit'));
    expect(h.db.rolePermission.deleteMany).not.toHaveBeenCalled();
  });

  it('an old pair is left alone: the role keeps saving, and a standalone key may be added beside it', async () => {
    h.db.role.findUnique.mockResolvedValue(role(['orders.edit']));
    const res = await replace({ permissions: perms('orders.edit', 'customers.create'), version: T.toISOString() });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(h.db.rolePermission.createMany).toHaveBeenCalledTimes(1);
  });

  it('but a SECOND action on a missing key is new, and is refused naming it', async () => {
    h.db.role.findUnique.mockResolvedValue(role(['orders.edit']));
    const res = await replace({ permissions: perms('orders.edit', 'products.edit'), version: T.toISOString() });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(refusal('products.view', 'products.edit'));
    expect(h.db.rolePermission.deleteMany).not.toHaveBeenCalled();
  });

  it('a rename alone is saved even on a role with an old pair — it carries no list, so no version either', async () => {
    h.db.role.findUnique.mockResolvedValue(role(['orders.edit']));
    const res = await replace({ name: 'اسم جديد' });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(h.db.rolePermission.deleteMany).not.toHaveBeenCalled();
    expect(h.db.role.updateMany).not.toHaveBeenCalled();
  });

  describe('over the version it was read at', () => {
    beforeEach(() => h.db.role.findUnique.mockResolvedValue(role(['orders.view'])));

    it('the current version is saved, and the claim is made on exactly that version in the same transaction', async () => {
      const res = await replace({ permissions: perms('orders.view', 'orders.edit'), version: T.toISOString() });
      expect(res.status, await res.clone().text()).toBe(200);
      expect(h.db.role.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'r1', updatedAt: T } }));
      expect(h.db.rolePermission.createMany).toHaveBeenCalledTimes(1);
    });

    it('an older version is refused with 409 and the Arabic sentence — and nothing is written', async () => {
      const res = await replace({ permissions: perms('orders.view'), version: '2026-10-28T09:00:00.000Z' });
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.code).toBe('STALE_VERSION');
      expect(body.error).toContain('حدّث الصفحة');
      expect(h.db.rolePermission.deleteMany).not.toHaveBeenCalled();
      expect(h.db.rolePermission.createMany).not.toHaveBeenCalled();
    });

    it('a save that names no version is refused too — a screen that predates this rule must read again', async () => {
      const res = await replace({ permissions: perms('orders.view') });
      expect(res.status).toBe(409);
      expect(h.db.rolePermission.deleteMany).not.toHaveBeenCalled();
    });

    it.each([[null], [12345], ['not a date'], [{}]])('an unreadable version (%o) is stale', async (version) => {
      const res = await replace({ permissions: perms('orders.view'), version });
      expect(res.status).toBe(409);
    });

    it('two saves of one version cannot both win: the loser of the claim is refused, before it deletes anything', async () => {
      h.db.role.updateMany.mockResolvedValue({ count: 0 });
      const res = await replace({ permissions: perms('orders.view'), version: T.toISOString() });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('STALE_VERSION');
      expect(h.db.rolePermission.deleteMany).not.toHaveBeenCalled();
      expect(h.db.rolePermission.createMany).not.toHaveBeenCalled();
    });
  });
});

describe('copying a role', () => {
  const copy = () => copyRole(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ id: 'r1' }) });

  it('a template with an old pair is copied as it is — the copy is not refused for what the source already holds', async () => {
    h.db.role.findUnique.mockResolvedValue(role(['customers.view', 'orders.view']));
    h.db.rolePermission.findMany.mockResolvedValue(rows('customers.view', 'orders.view'));
    const res = await copy();
    expect(res.status, await res.clone().text()).toBe(201);
    const data = h.db.role.create.mock.calls[0][0].data;
    expect(data.permissions.create.map((p: { permission: string }) => p.permission)).toEqual(['customers.view', 'orders.view']);
    expect(data.defaults.create).toHaveLength(2);
  });
});
