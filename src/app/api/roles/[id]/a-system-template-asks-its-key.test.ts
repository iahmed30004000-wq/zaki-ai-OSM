import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * REWRITING A SYSTEM ROLE TEMPLATE ASKS roles.edit_system (perm-plan PR-13).
 *
 * It was two role NAMES (`admin.role === 'COMPANY_ADMIN' || 'SUPER_ADMIN'`). A template — COMPANY_ADMIN, MANAGER, MODERATOR… —
 * moves every person who carries it, so it is a box the owner can untick from a company admin; the migration gave it to the
 * company admin by name, so nobody lost the door on the day.
 *
 * The SUPER_ADMIN template stays read-only for EVERYBODY, owner included, whatever keys are held: «مفتوحٌ بالتصميم». And the
 * owner passes the system-template door with nothing listed — the way back in if the key is ever unticked from everyone else.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, held, actor, tx } = vi.hoisted(() => ({
  db: { role: { findUnique: vi.fn() }, user: { count: vi.fn() }, $transaction: vi.fn() },
  held: { keys: new Set<string>() },
  actor: { current: { id: 'admin', name: 'مدير', role: 'COMPANY_ADMIN', companyId: 'c1' as string | null, status: 'ACTIVE' } },
  tx: { role: { updateMany: vi.fn(), update: vi.fn() }, rolePermission: { deleteMany: vi.fn(), createMany: vi.fn() }, user: { updateMany: vi.fn() } },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
const holds = (key: string) => actor.current.role === 'SUPER_ADMIN' || held.keys.has(key);
vi.mock('@/lib/authorization', () => ({
  requirePermission: async (key: string) => {
    if (!holds(key)) throw new Error(`Forbidden: missing required permission ${key}`);
    return actor.current;
  },
  can: (_u: unknown, key: string) => holds(key),
}));
vi.mock('@/lib/user-permissions', () => ({
  granterHoldsAll: () => null,
  canConferRole: async () => ({ ok: true }),
  roleScopeRefusal: async () => null,
  newOrphanRefusal: () => null,
  orphanResponse: vi.fn(),
  StalePermissionsError: class extends Error {},
  roleVersionIsCurrent: () => true,
  staleResponse: vi.fn(),
}));

import { PATCH } from './route';

const patch = (id: string, body: unknown) =>
  PATCH(new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

const role = (id: string, name: string, isSystem: boolean, companyId: string | null) => ({
  id, name, isSystem, companyId, updatedAt: new Date('2026-10-01T00:00:00Z'), permissions: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  held.keys = new Set(['roles.edit']);
  actor.current = { id: 'admin', name: 'مدير', role: 'COMPANY_ADMIN', companyId: 'c1', status: 'ACTIVE' };
  db.role.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
    if (where.id === 'tpl') return role('tpl', 'MANAGER', true, null);
    if (where.id === 'owner-tpl') return role('owner-tpl', 'SUPER_ADMIN', true, null);
    if (where.id === 'mine') return role('mine', 'مسؤول المخزن', false, 'c1');
    return null;
  });
  db.$transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(tx));
  tx.role.updateMany.mockResolvedValue({ count: 1 });
  tx.role.update.mockResolvedValue({ id: 'x', name: 'x', permissions: [] });
  tx.user.updateMany.mockResolvedValue({ count: 0 });
});

describe('a system template', () => {
  it('NEGATIVE: roles.edit alone is refused — even for a person whose role string is COMPANY_ADMIN — and nothing is written', async () => {
    const res = await patch('tpl', { name: 'مدير عام' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/تعديل قوالب الأدوار الأساسية/);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(tx.role.update).not.toHaveBeenCalled();
  });

  it('with roles.edit_system the template is rewritten', async () => {
    held.keys = new Set(['roles.edit', 'roles.edit_system']);
    const res = await patch('tpl', { name: 'مدير عام' });
    expect(res.status).toBe(200);
    expect(tx.role.update).toHaveBeenCalledTimes(1);
  });

  it('NEGATIVE: roles.edit_system without roles.edit is refused at the first door', async () => {
    held.keys = new Set(['roles.edit_system']);
    expect((await patch('tpl', { name: 'مدير عام' })).status).toBe(403);
    expect(db.role.findUnique).not.toHaveBeenCalled();
  });

  it('a company’s own role never needed it', async () => {
    const res = await patch('mine', { name: 'مسؤول المستودع' });
    expect(res.status).toBe(200);
  });

  it('the SUPER_ADMIN template is read-only for EVERYBODY — the owner and a holder of every key included', async () => {
    held.keys = new Set(['roles.edit', 'roles.edit_system']);
    expect((await patch('owner-tpl', { name: 'x' })).status).toBe(403);
    actor.current = { id: 'root', name: 'المالك', role: 'SUPER_ADMIN', companyId: null, status: 'ACTIVE' };
    held.keys = new Set();
    const res = await patch('owner-tpl', { name: 'x' });
    expect(res.status).toBe(403);
    expect((await res.json()).errorAr).toMatch(/مفتوحٌ بالتصميم/);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('THE WAY BACK IN: the owner rewrites a template with nothing listed', async () => {
    actor.current = { id: 'root', name: 'المالك', role: 'SUPER_ADMIN', companyId: null, status: 'ACTIVE' };
    held.keys = new Set();
    const res = await patch('tpl', { name: 'مدير عام' });
    expect(res.status).toBe(200);
    expect(tx.role.update).toHaveBeenCalledTimes(1);
  });
});
