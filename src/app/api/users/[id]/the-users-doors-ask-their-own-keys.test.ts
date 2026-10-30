import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * EACH ACT ON AN EMPLOYEE'S ACCOUNT ASKS ITS OWN BOX (perm-plan PR-13).
 *
 *   delete the account              users.edit  →  users.delete
 *   set a password                  users.edit + the NAMES SUPER_ADMIN / COMPANY_ADMIN  →  users.edit + users.security
 *   move a shift / rest days        users.edit  →  users.shift   (only a CHANGE asks: the card posts all three together)
 *   a personal exception (PUT, DELETE)  users.edit  →  roles.edit   (D9 — see the end of this file)
 *
 * The questions are asked of the DOOR, not of the source: what status comes back, and whether anything was read or
 * written. A guard that returns 403 while the delete still runs is not a guard. Every box has its NEGATIVE — the same
 * request, the key absent — and the owner (SUPER_ADMIN) passes every one of them with nothing listed.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, logAudit, actor, held, hashPassword } = vi.hoisted(() => ({
  db: {
    user: { findUnique: vi.fn(), update: vi.fn(), delete: vi.fn() },
    role: { findFirst: vi.fn(), findUnique: vi.fn() },
    company: { findMany: vi.fn() },
  },
  logAudit: vi.fn(),
  actor: { current: { id: 'admin', name: 'مدير', role: 'COMPANY_ADMIN', companyId: 'c1' as string | null } },
  held: { keys: new Set<string>() },
  hashPassword: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/auth', () => ({ hashPassword: (...a: unknown[]) => hashPassword(...a), resolveSingleCompanyId: async () => 'c1' }));
// The engine's rule in four lines: the owner passes every key centrally; everybody else needs the key in their list.
const holds = (key: string) => actor.current.role === 'SUPER_ADMIN' || held.keys.has(key);
vi.mock('@/lib/authorization', () => ({
  requirePermission: async (key: string) => {
    if (!holds(key)) throw new Error(`Forbidden: missing required permission ${key}`);
    return actor.current;
  },
  can: (_u: unknown, key: string) => holds(key),
}));
vi.mock('@/lib/user-permissions', () => ({
  canConferRole: async () => ({ ok: true }),
  canActOnUser: async () => ({ ok: true }),
}));

import { PATCH } from './route';

const patch = (id: string, body: unknown) =>
  PATCH(new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

const STORED = { shiftStart: '09:00', shiftEnd: '17:00', restDays: '5' };
const row = (id: string, role = 'CONFIRMATION_AGENT') => ({
  id, name: 'سارة', email: 's@x.com', role, roleId: 'role-agent', status: 'ACTIVE',
  companyId: 'c1', phone: '0911222333', ...STORED, assignedBy: null,
});

// The session carries its effective keys (`permissions`), which is what the screens and the pure rules read; the engine's `can` reads the set.
const holding = (...keys: string[]) => {
  held.keys = new Set(keys);
  actor.current = { ...actor.current, permissions: keys } as typeof actor.current;
};

beforeEach(() => {
  vi.clearAllMocks();
  actor.current = { id: 'admin', name: 'مدير', role: 'COMPANY_ADMIN', companyId: 'c1' };
  holding('users.edit');
  db.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => row(where.id));
  db.user.update.mockImplementation(async () => row('x'));
  db.user.delete.mockResolvedValue({});
  hashPassword.mockResolvedValue('hashed');
  logAudit.mockResolvedValue(undefined);
});

describe('deleting an account asks users.delete', () => {
  it('NEGATIVE: «تعديل المستخدمين» alone is refused — before the account is even looked up, and nothing is deleted', async () => {
    const res = await patch('u2', { action: 'delete' });
    expect(res.status).toBe(403);
    expect((await res.json()).errorAr).toMatch(/حذف حساب موظف/);
    expect(db.user.findUnique, 'وصل للقاعدة قبل ما يرفض').not.toHaveBeenCalled();
    expect(db.user.delete).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('NEGATIVE: the delete key without the edit key is refused too — the door still opens on the edit key', async () => {
    holding('users.delete');
    const res = await patch('u2', { action: 'delete' });
    expect(res.status).toBe(403);
    expect(db.user.delete).not.toHaveBeenCalled();
  });

  it('with both keys the account is deleted, and the audit says who did it', async () => {
    holding('users.edit', 'users.delete');
    const res = await patch('u2', { action: 'delete' });
    expect(res.status).toBe(200);
    expect(db.user.delete).toHaveBeenCalledWith({ where: { id: 'u2' } });
    expect(logAudit.mock.calls[0][0]).toMatchObject({ action: 'USER_DELETED', userId: 'admin' });
  });

  it('NEGATIVE: holding the key never lets you delete yourself, nor a SUPER_ADMIN', async () => {
    holding('users.edit', 'users.delete');
    expect((await patch('admin', { action: 'delete' })).status).toBe(400);
    db.user.findUnique.mockResolvedValue(row('boss', 'SUPER_ADMIN'));
    expect((await patch('boss', { action: 'delete' })).status).toBe(403);
    expect(db.user.delete).not.toHaveBeenCalled();
  });

  it('the owner deletes with nothing listed — the way back in', async () => {
    actor.current = { id: 'root', name: 'المالك', role: 'SUPER_ADMIN', companyId: null };
    holding();
    const res = await patch('u2', { action: 'delete' });
    expect(res.status).toBe(200);
    expect(db.user.delete).toHaveBeenCalledTimes(1);
  });
});

describe('setting a password asks users.security — on top of the edit key', () => {
  it('NEGATIVE: «تعديل المستخدمين» alone (a manager) is refused, nothing is hashed, nothing is written', async () => {
    const res = await patch('u2', { action: 'resetPassword' });
    expect(res.status).toBe(403);
    expect(db.user.findUnique).not.toHaveBeenCalled();
    expect(hashPassword).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a company admin the key was taken from is refused — the NAME no longer opens it', async () => {
    actor.current = { id: 'admin', name: 'مدير', role: 'COMPANY_ADMIN', companyId: 'c1' };
    holding('users.edit', 'users.delete', 'users.shift', 'roles.edit_system');
    expect((await patch('u2', { action: 'resetPassword' })).status).toBe(403);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('NEGATIVE: the key without the edit key is refused too', async () => {
    holding('users.security');
    expect((await patch('u2', { action: 'resetPassword' })).status).toBe(403);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('with both keys, an ordinary employee’s password is set, once, and the sessions end', async () => {
    holding('users.edit', 'users.security');
    const res = await patch('u2', { action: 'resetPassword' });
    expect(res.status).toBe(200);
    expect(typeof (await res.json()).temporaryPassword).toBe('string');
    expect(db.user.update.mock.calls[0][0].data).toMatchObject({ passwordHash: 'hashed', tokenVersion: { increment: 1 } });
  });

  it('NEGATIVE: holding the key never lifts the rest — not your own, not a SUPER_ADMIN’s', async () => {
    holding('users.edit', 'users.security');
    const own = await patch('admin', { action: 'resetPassword' });
    expect(own.status).toBe(403);
    expect((await own.json()).code).toBe('NOT_YOURSELF');
    db.user.findUnique.mockResolvedValue(row('boss', 'SUPER_ADMIN'));
    expect((await patch('boss', { action: 'resetPassword' })).status).toBe(403);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('the owner sets a password with nothing listed', async () => {
    actor.current = { id: 'root', name: 'المالك', role: 'SUPER_ADMIN', companyId: null };
    holding();
    expect((await patch('u2', { action: 'resetPassword' })).status).toBe(200);
  });
});

describe('moving a shift asks users.shift — only a CHANGE asks', () => {
  it.each([
    ['the start time', { shiftStart: '11:00' }],
    ['the hand-over time', { shiftEnd: '19:00' }],
    ['the rest days', { restDays: [6] }],
    ['all of them, as the shift card posts them', { shiftStart: '12:00', shiftEnd: '20:00', restDays: [0] }],
  ])('NEGATIVE: %s, with the edit key alone, is refused and nothing is written', async (_n, change) => {
    const res = await patch('u2', { action: 'updateContact', ...change });
    expect(res.status).toBe(403);
    expect((await res.json()).errorAr).toMatch(/دوام الموظف/);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('with the key the shift is written', async () => {
    holding('users.edit', 'users.shift');
    const res = await patch('u2', { action: 'updateContact', shiftStart: '11:00', shiftEnd: '19:00', restDays: [6] });
    expect(res.status).toBe(200);
    expect(db.user.update.mock.calls[0][0].data).toMatchObject({ shiftStart: '11:00', shiftEnd: '19:00', restDays: '6' });
  });

  it('saving the values the account already has is not a change: a phone edit beside an untouched shift passes without the key', async () => {
    const res = await patch('u2', { action: 'updateContact', phone: '0933444555', shiftStart: '09:00', shiftEnd: '17:00', restDays: [5] });
    expect(res.status).toBe(200);
    expect(db.user.update.mock.calls[0][0].data.phone).toBe('0933444555');
  });

  it('and a phone alone never asked for it', async () => {
    expect((await patch('u2', { action: 'updateContact', phone: '0933444555' })).status).toBe(200);
  });

  it('NEGATIVE: a changed shift beside the same phone is still refused — the phone does not carry it through', async () => {
    const res = await patch('u2', { action: 'updateContact', phone: '0911222333', shiftStart: '10:00' });
    expect(res.status).toBe(403);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('on top of it your OWN shift still needs the pay key (RV159) — the new key does not replace that rule', async () => {
    holding('users.edit', 'users.shift');
    const res = await patch('admin', { action: 'updateContact', shiftStart: '11:00' });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('OWN_SHIFT');
    holding('users.edit', 'users.shift', 'payroll.pay');
    expect((await patch('admin', { action: 'updateContact', shiftStart: '11:00' })).status).toBe(200);
  });

  it('the owner moves a shift with nothing listed', async () => {
    actor.current = { id: 'root', name: 'المالك', role: 'SUPER_ADMIN', companyId: null };
    holding();
    expect((await patch('u2', { action: 'updateContact', shiftStart: '11:00' })).status).toBe(200);
  });
});

describe('the other acts did NOT move', () => {
  it('forcing a sign-out and changing a status still ask only the edit key', async () => {
    expect((await patch('u2', { action: 'forceLogout' })).status).toBe(200);
    expect((await patch('u2', { action: 'changeStatus', status: 'SUSPENDED' })).status).toBe(200);
  });

  it('and without even the edit key everything is refused', async () => {
    holding();
    for (const body of [{ action: 'forceLogout' }, { action: 'delete' }, { action: 'resetPassword' }, { action: 'updateContact', shiftStart: '11:00' }]) {
      expect((await patch('u2', body)).status, JSON.stringify(body)).toBe(403);
    }
    expect(db.user.update).not.toHaveBeenCalled();
    expect(db.user.delete).not.toHaveBeenCalled();
  });
});
