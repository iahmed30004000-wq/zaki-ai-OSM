import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A PERSONAL EXCEPTION IS A ROLE-MATRIX ACT (perm-plan PR-13, D9 — the owner's: «اي قرار بعد الان اتخذو دون الرجوع الي»).
 *
 * Saving or lifting a personal «سماح» / «منع» on an employee asked `users.edit` — the PROFILE key, held by every manager who may
 * correct a phone number. It changes what a person may do exactly as a role's matrix does, so it asks `roles.edit` now.
 * Reading the inspector (GET) stays on `users.view`.
 *
 * THIS IS A DELIBERATE NARROWING and the migration does not hand `roles.edit` to profile editors: that would give them the
 * whole role matrix, which is the very gain D9 exists to stop. The pre-deploy report (part C) counts the roles it touches.
 *
 * Asked of the door: a refusal must come before anything is read, and nothing is written.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, held, loaded } = vi.hoisted(() => ({
  db: {
    userPermission: { findMany: vi.fn(), findUnique: vi.fn(), delete: vi.fn(), createMany: vi.fn(), deleteMany: vi.fn() },
    user: { update: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
  held: { keys: new Set<string>() },
  loaded: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: async (key: string) => {
    if (!held.keys.has(key)) throw new Error(`Forbidden: missing required permission ${key}`);
    return { id: 'admin', name: 'مدير', role: 'MANAGER', companyId: 'c1', status: 'ACTIVE' };
  },
}));
vi.mock('@/lib/permissions-core', () => ({ computeEffectiveGrants: vi.fn(async () => ({ fullAccess: false, grants: {} })) }));
// Everything after the key is somebody else's test: the loader stops the request here, which is all these cases need to see.
vi.mock('@/lib/user-permissions', () => ({
  PERMISSION_TARGET_SELECT: {},
  canActOnUser: vi.fn(),
  denyRemovalRefusal: vi.fn(),
  heldOrCovered: vi.fn(),
  keyLabel: (k: string) => k,
  loadPermissionTarget: (...a: unknown[]) => loaded(...a),
  overrideOrphanRefusal: vi.fn(),
  orphanResponse: vi.fn(),
  StalePermissionsError: class extends Error {},
  staleResponse: vi.fn(),
  superAdminOverrideGuard: vi.fn(),
  userVersionIsCurrent: vi.fn(),
}));

import { GET, PUT } from './route';
import { DELETE } from './[permission]/route';

const put = () =>
  PUT(new Request('http://localhost/x', { method: 'PUT', body: JSON.stringify({ overrides: [] }) }), { params: Promise.resolve({ id: 'u2' }) });
const del = () =>
  DELETE(new Request('http://localhost/x', { method: 'DELETE' }), { params: Promise.resolve({ id: 'u2', permission: 'orders.view' }) });

beforeEach(() => {
  vi.clearAllMocks();
  held.keys = new Set();
  // The loader's answer is "no such person": the request ends there with a 404, after the key has been asked.
  loaded.mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ error: 'المستخدم غير موجود' }), { status: 404 }) });
});

describe('saving the list of exceptions (PUT)', () => {
  it('NEGATIVE: «تعديل المستخدمين» alone is refused before the person is even loaded', async () => {
    held.keys = new Set(['users.view', 'users.edit']);
    const res = await put();
    expect(res.status).toBe(403);
    expect(loaded, 'وصل للقاعدة قبل ما يرفض').not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.userPermission.createMany).not.toHaveBeenCalled();
  });

  it('with roles.edit the request goes on to the person (and the owner’s other guards take over from there)', async () => {
    held.keys = new Set(['roles.edit']);
    const res = await put();
    expect(loaded).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(404);
  });

  it('and the refusal names the box in Arabic, not the key', async () => {
    held.keys = new Set(['users.edit']);
    const res = await put();
    const body = await res.json();
    expect(body.errorAr).toMatch(/تعديل الأدوار والصلاحيات/);
    expect(body.errorAr).not.toMatch(/roles\.edit/);
  });
});

describe('lifting one exception (DELETE)', () => {
  it('NEGATIVE: «تعديل المستخدمين» alone is refused before the person is even loaded, and no row is removed', async () => {
    held.keys = new Set(['users.view', 'users.edit']);
    const res = await del();
    expect(res.status).toBe(403);
    expect(loaded).not.toHaveBeenCalled();
    expect(db.userPermission.delete).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('with roles.edit the request goes on to the person', async () => {
    held.keys = new Set(['roles.edit']);
    const res = await del();
    expect(loaded).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(404);
  });
});

describe('reading the inspector did NOT move', () => {
  it('still asks users.view — a roles.edit holder without it, and an editor with it, are judged by that key alone', async () => {
    held.keys = new Set(['roles.edit']);
    expect((await GET(new Request('http://localhost/x'), { params: Promise.resolve({ id: 'u2' }) })).status).toBe(403);
    held.keys = new Set(['users.view']);
    const res = await GET(new Request('http://localhost/x'), { params: Promise.resolve({ id: 'u2' }) });
    expect(loaded).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(404);
  });
});
