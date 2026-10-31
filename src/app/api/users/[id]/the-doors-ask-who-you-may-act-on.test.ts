import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE PEOPLE DOORS, DRIVEN — each refusal with the case that must still pass.
 *
 * The rules themselves are tested in src/lib/people-act-within-their-reach;
 * this file proves the doors ask them before writing anything:
 *
 *   · PATCH /api/users/:id — suspend, sign out, delete… an account the actor
 *     may not act on is refused, and nothing is written;
 *   · the commission currency is pay: «تعديل المستخدمين» alone no longer sets it;
 *   · DELETE /api/users/:id/permissions/:key — removing a «منع» is granting.
 */

const { db, actor, canActOnUser, held } = vi.hoisted(() => ({
  db: {
    // updateMany: the exceptions door claims the user's version in the transaction that writes (RV171).
    user: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    role: { findFirst: vi.fn(), findUnique: vi.fn() },
    company: { findMany: vi.fn() },
    // The payload the exception door answers with reads the role's rows.
    rolePermission: { findMany: vi.fn(async () => []) },
    userPermission: { findUnique: vi.fn(), delete: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
    // PR-A (A1): suspending also removes the fingerprints, in one transaction that runs on this same object.
    passkey: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    passkeyChallenge: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    $transaction: vi.fn(),
  },
  actor: { current: { id: 'manager', name: 'مدير', role: 'MANAGER', companyId: 'c1', status: 'ACTIVE' } as Record<string, unknown> },
  canActOnUser: vi.fn(),
  held: { keys: [] as string[] },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/auth', () => ({ hashPassword: vi.fn(), resolveSingleCompanyId: async () => 'c1' }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: async () => actor.current,
  can: (_u: unknown, k: string) => held.keys.includes(k),
  getPermissionScope: (_u: unknown, k: string) => (held.keys.includes(k) ? { scope: 'ALL_COMPANY' } : null),
}));
vi.mock('@/lib/user-permissions', async (orig) => ({
  ...(await orig<typeof import('@/lib/user-permissions')>()),
  canActOnUser: (...a: unknown[]) => canActOnUser(...a),
  canConferRole: async () => ({ ok: true }),
}));

import { PATCH } from './route';
import { DELETE as removeOverride } from './permissions/[permission]/route';
import { PUT as replaceOverrides } from './permissions/route';

const patch = (body: unknown) =>
  PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'admin2' }) });

beforeEach(() => {
  vi.clearAllMocks();
  held.keys = ['users.edit'];
  canActOnUser.mockResolvedValue({ ok: true });
  db.user.findUnique.mockResolvedValue({
    id: 'admin2', name: 'المدير العام', email: 'a@x', role: 'COMPANY_ADMIN', roleId: 'r-admin',
    status: 'ACTIVE', companyId: 'c1', phone: null, assignedBy: null, permissionsVersion: 1,
  });
  db.user.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'admin2', ...data }));
  db.user.updateMany.mockResolvedValue({ count: 1 });
  db.$transaction.mockImplementation(async (ops: unknown) => (Array.isArray(ops) ? ops : null));
});

describe('an account the actor may not act on', () => {
  it.each([
    [{ action: 'changeStatus', status: 'SUSPENDED' }],
    [{ action: 'forceLogout' }],
    [{ action: 'delete' }],
    [{ action: 'changeStatus', status: 'ACTIVE' }],
  ])('%o is refused, and nothing is written', async (body) => {
    canActOnUser.mockResolvedValue({ ok: false, status: 403, error: 'لا يمكنك إدارة حساب دوره أوسع من صلاحياتك' });
    const res = await patch(body);
    expect(res.status).toBe(403);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('an account within reach is suspended as before', async () => {
    db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
    const res = await patch({ action: 'changeStatus', status: 'SUSPENDED' });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(canActOnUser).toHaveBeenCalledWith(expect.objectContaining({ id: 'manager' }), expect.objectContaining({ id: 'admin2', roleId: 'r-admin' }));
  });
});

describe('the clerical record', () => {
  it('a phone correction is not held by the reach rule — it is not power over anybody', async () => {
    canActOnUser.mockResolvedValue({ ok: false, status: 403, error: 'لا يمكنك إدارة هذا الحساب' });
    const res = await patch({ action: 'updateContact', phone: '0790000000' });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(canActOnUser).not.toHaveBeenCalled();
  });
});

describe('the commission currency', () => {
  it('is refused on «تعديل المستخدمين» alone — it is pay', async () => {
    const res = await patch({ action: 'updateContact', phone: '0790000000', commissionCurrency: 'SYP' });
    expect(res.status).toBe(403);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('is set with «تحديد الرواتب وصرفها»', async () => {
    held.keys = ['users.edit', 'payroll.pay'];
    const res = await patch({ action: 'updateContact', phone: '0790000000', commissionCurrency: 'SYP' });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(db.user.update.mock.calls[0][0].data.commissionCurrency).toBe('SYP');
  });
});

describe('removing one exception', () => {
  const remove = (permission: string) =>
    removeOverride(new Request('http://x', { method: 'DELETE' }), { params: Promise.resolve({ id: 'agent', permission }) });

  beforeEach(() => {
    db.user.findUnique.mockResolvedValue({ id: 'agent', companyId: 'c1', role: 'CONFIRMATION_AGENT', name: 'ليلى', email: 'l@x', roleId: 'r-agent', permissionsVersion: 1 });
    // The door now reads the person's exceptions when removing one could matter (it never removed an orphan before).
    db.userPermission.findMany.mockResolvedValue([{ permission: 'finance.view', effect: 'ALLOW', scope: 'ALL_COMPANY', scopeIds: null }]);
  });

  it('a «منع» on a key the actor lacks stays — removing it would hand the key back', async () => {
    db.userPermission.findUnique.mockResolvedValue({ permission: 'finance.view', effect: 'DENY', scope: null, scopeIds: null });
    const res = await remove('finance.view');
    expect(res.status).toBe(403);
    expect(db.userPermission.delete).not.toHaveBeenCalled();
  });

  it('the same «منع» is removed by somebody who holds the key', async () => {
    held.keys = ['users.edit', 'finance.view'];
    db.userPermission.findUnique.mockResolvedValue({ permission: 'finance.view', effect: 'DENY', scope: null, scopeIds: null });
    const res = await remove('finance.view');
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    expect(db.userPermission.delete).toHaveBeenCalled();
  });

  it('an account out of reach: no exception of theirs is removed', async () => {
    canActOnUser.mockResolvedValue({ ok: false, status: 403, error: 'لا يمكنك إدارة هذا الحساب' });
    db.userPermission.findUnique.mockResolvedValue({ permission: 'finance.view', effect: 'ALLOW', scope: 'ALL_COMPANY', scopeIds: null });
    expect((await remove('finance.view')).status).toBe(403);
    expect(db.userPermission.delete).not.toHaveBeenCalled();
  });

  it('removing an ALLOW takes a key away, and needs no such holding', async () => {
    db.userPermission.findUnique.mockResolvedValue({ permission: 'finance.view', effect: 'ALLOW', scope: 'ALL_COMPANY', scopeIds: null });
    expect((await remove('finance.view')).status).toBeLessThan(300);
  });
});

describe('replacing the exceptions wholesale', () => {
  const replace = (overrides: unknown[]) =>
    // `version`: the list replaces the stored one, so it is saved over the version it was read at (the person's is 1).
    replaceOverrides(new Request('http://x', { method: 'PUT', body: JSON.stringify({ overrides, version: 1 }) }), { params: Promise.resolve({ id: 'agent' }) });

  beforeEach(() => {
    db.user.findUnique.mockResolvedValue({ id: 'agent', companyId: 'c1', role: 'CONFIRMATION_AGENT', name: 'ليلى', email: 'l@x', roleId: 'r-agent', permissionsVersion: 1 });
    db.userPermission.findMany.mockResolvedValue([{ permission: 'finance.view', effect: 'DENY', scope: null, scopeIds: null }]);
    db.$transaction.mockImplementation(async (fn: unknown) => (typeof fn === 'function' ? (fn as (tx: unknown) => unknown)(db) : fn));
  });

  it('a replacement that simply leaves a «منع» out is refused — that is granting the key', async () => {
    const res = await replace([]);
    expect(res.status).toBe(403);
    expect(db.userPermission.deleteMany).not.toHaveBeenCalled();
  });

  it('keeping the «منع» is fine', async () => {
    const res = await replace([{ permission: 'finance.view', effect: 'DENY' }]);
    expect(res.status, await res.clone().text()).toBeLessThan(300);
  });

  it('a holder of the key may lift it', async () => {
    held.keys = ['users.edit', 'finance.view'];
    expect((await replace([])).status).toBeLessThan(300);
  });

  /*
   * REVERSED ON PURPOSE, after the independent review: a per-person
   * exception gets NO shift-work exemption. «إشكالات التأكيد» on one person
   * opens the customers of every issue, and the role door's reason (hiring
   * an agent is not working the queue) does not apply to one exception.
   */
  it('a shift-work key on one person needs the granter to hold it, like any exception', async () => {
    db.userPermission.findMany.mockResolvedValue([]);
    const res = await replace([{ permission: 'confirmation.issues', effect: 'ALLOW', scope: 'ALL_COMPANY' }]);
    expect(res.status).toBe(403);
    expect(db.userPermission.deleteMany).not.toHaveBeenCalled();
  });

  it('the broader customer view covers the basic one, as in every granting door', async () => {
    held.keys = ['users.edit', 'customers.view'];
    db.userPermission.findMany.mockResolvedValue([]);
    const res = await replace([{ permission: 'customers.view_basic', effect: 'ALLOW', scope: 'ALL_COMPANY' }]);
    expect(res.status, await res.clone().text()).toBeLessThan(300);
  });

  it('an account out of reach: refused before anything is written', async () => {
    canActOnUser.mockResolvedValue({ ok: false, status: 403, error: 'لا يمكنك إدارة هذا الحساب' });
    const res = await replace([{ permission: 'finance.view', effect: 'DENY' }]);
    expect(res.status).toBe(403);
    expect(db.userPermission.deleteMany).not.toHaveBeenCalled();
  });
});
