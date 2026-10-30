import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * WHAT THE EMPLOYEE'S PAGE CHANGES.
 *
 * The role changed from the list's modal set only the role's NAME, and
 * permissions resolve by roleId — so the badge said one role and the
 * grants were another's. And the phone, set at creation, had no editor.
 */

const { db, logAudit, canConferRole, actor } = vi.hoisted(() => ({
  db: { user: { findUnique: vi.fn(), update: vi.fn() }, role: { findFirst: vi.fn(), findUnique: vi.fn() }, company: { findMany: vi.fn() } },
  logAudit: vi.fn(),
  canConferRole: vi.fn(),
  /** Who is doing the administering. Mutable: the defect below was about WHO. */
  actor: { current: { id: 'admin', name: 'مدير', role: 'COMPANY_ADMIN', companyId: 'c1' as string | null } },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/auth', () => ({
  hashPassword: vi.fn(),
  // The real one: the single company, resolved server-side for an actor who
  // has none. `POST /api/users` already used it; this door did not.
  resolveSingleCompanyId: async () => 'c1',
}));
vi.mock('@/lib/authorization', () => ({
  requirePermission: async () => actor.current,
  // PR-13 (قديم ← جديد): moving a shift asks `users.shift` through `can`; this file is about the role and the phone, so the actor holds it.
  can: () => true,
}));
// Acting on a more senior account is its own test (people-act-within-their-reach).
vi.mock('@/lib/user-permissions', () => ({
  canConferRole: (...a: unknown[]) => canConferRole(...a),
  canActOnUser: async () => ({ ok: true }),
}));

import { PATCH } from './route';

const patch = (body: unknown) =>
  PATCH(new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'u2' }) });

beforeEach(() => {
  vi.clearAllMocks();
  actor.current = { id: 'admin', name: 'مدير', role: 'COMPANY_ADMIN', companyId: 'c1' };
  canConferRole.mockResolvedValue({ ok: true });
  db.user.findUnique.mockResolvedValue({
    id: 'u2', name: 'سارة', email: 's@x.com', role: 'CONFIRMATION_AGENT', roleId: 'role-agent',
    status: 'ACTIVE', companyId: 'c1', phone: null, assignedBy: null,
  });
  db.user.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'u2', name: 'سارة', email: 's@x.com', role: data.role ?? 'CONFIRMATION_AGENT', status: 'ACTIVE',
  }));
});

describe('changing the role by name', () => {
  it('points roleId at the role of that name, so the grants follow the badge', async () => {
    db.role.findFirst.mockResolvedValue({ id: 'role-supervisor' });
    const res = await patch({ action: 'assignRole', role: 'CONFIRMATION_SUPERVISOR' });
    expect(res.status).toBe(200);
    const data = db.user.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ role: 'CONFIRMATION_SUPERVISOR', roleId: 'role-supervisor' });
    expect(data.permissionsVersion).toEqual({ increment: 1 });
  });

  it('asks the conferral policy about the role row it will point at, not just the name', async () => {
    db.role.findFirst.mockResolvedValue({ id: 'role-supervisor' });
    await patch({ action: 'assignRole', role: 'CONFIRMATION_SUPERVISOR' });
    expect(canConferRole).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'admin' }),
      { id: 'role-supervisor', name: 'CONFIRMATION_SUPERVISOR' }
    );
  });

  it('refuses a role whose grants the admin does not hold — nothing is written', async () => {
    // The company widened its own role of this name beyond the admin.
    db.role.findFirst.mockResolvedValue({ id: 'role-widened' });
    canConferRole.mockResolvedValue({ ok: false, error: 'لا تملك هذه الصلاحيات', status: 403 });
    const res = await patch({ action: 'assignRole', role: 'CONFIRMATION_SUPERVISOR' });
    expect(res.status).toBe(403);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('looks only in the admin\'s company and the system roles', async () => {
    db.role.findFirst.mockResolvedValue(null);
    await patch({ action: 'assignRole', role: 'CONFIRMATION_SUPERVISOR' });
    expect(db.role.findFirst.mock.calls[0][0].where.OR).toEqual([{ companyId: 'c1' }, { companyId: null }]);
    // No such role row: roleId is cleared so the name rules, never left pointing at the old role.
    expect(db.user.update.mock.calls[0][0].data.roleId).toBeNull();
  });
});

describe('the phone', () => {
  it('is saved and audited with before and after', async () => {
    const res = await patch({ action: 'updateContact', phone: ' +962 79 123 4567 ' });
    expect(res.status).toBe(200);
    expect(db.user.update.mock.calls[0][0].data).toEqual({ phone: '+962 79 123 4567' });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'USER_CONTACT_UPDATED',
      previousData: expect.objectContaining({ phone: null }),
      newData: expect.objectContaining({ phone: '+962 79 123 4567' }),
    }));
  });

  it('accepts the digits of an Arabic keyboard, and stores them as 0-9', async () => {
    const res = await patch({ action: 'updateContact', phone: '٠٧٩١٢٣٤٥٦٧' });
    expect(res.status).toBe(200);
    expect(db.user.update.mock.calls[0][0].data).toEqual({ phone: '0791234567' });
  });

  it('is cleared by an empty value', async () => {
    await patch({ action: 'updateContact', phone: '' });
    expect(db.user.update.mock.calls[0][0].data).toEqual({ phone: null });
  });

  it('refuses what is not a phone number', async () => {
    for (const bad of ['abc', '<script>', '12']) {
      expect((await patch({ action: 'updateContact', phone: bad })).status).toBe(400);
    }
    expect(db.user.update).not.toHaveBeenCalled();
  });

  /**
   * AND IT IS NOT WIPED BY A CARD THAT DOES NOT SEND IT.
   *
   * The shift, salary and commission-currency cards save through the same
   * action without a phone, and an absent phone read as «cleared»: every one
   * of those saves wiped the employee's number. Absent means untouched.
   */
  it('a save that does not carry the phone leaves it as it was', async () => {
    db.user.findUnique.mockResolvedValue({
      id: 'u2', name: 'سارة', email: 's@x.com', role: 'CONFIRMATION_AGENT', roleId: 'role-agent',
      status: 'ACTIVE', companyId: 'c1', phone: '0791234567', assignedBy: null,
    });
    const res = await patch({ action: 'updateContact', shiftStart: '10:00', shiftEnd: '18:00' });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(db.user.update.mock.calls[0][0].data).not.toHaveProperty('phone');
  });
});

/**
 * HIRING SOMEBODY PUTS THEM IN THE COMPANY — WHOEVER DOES THE HIRING.
 *
 * Reported as five separate faults and it was one line. Self-registration
 * creates an account with no company on purpose, and giving it a role was
 * meant to adopt it. The adoption read `admin.companyId && admin.role !==
 * 'SUPER_ADMIN'` — and the person who actually approves new staff is the
 * owner, a PLATFORM SUPER_ADMIN with no company of their own. BOTH halves
 * were false for them.
 *
 * So the employee got a role, an ACTIVE account and a working login, and kept
 * `companyId: null`. Every screen looks a person up with `{ id, companyId }`,
 * so that one employee was invisible to all of them at once: «الموظف غير
 * موجود» on their page, «المستخدم غير موجود» on their access, and a
 * commission rule for them refused. The users list showed them the whole
 * time, because it alone also reads `companyId: null` — the single screen
 * that could have revealed it was the one written to tolerate it.
 */
describe('adopting a self-registered account', () => {
  const orphan = {
    id: 'u9', name: 'abc', email: 'abc@x.com', role: 'PENDING_USER', roleId: null,
    status: 'PENDING', companyId: null, phone: null, assignedBy: null,
  };
  const modRole = { id: 'role-mod', name: 'MODERATOR', companyId: null, _count: { users: 0 } };

  beforeEach(() => {
    db.user.findUnique.mockResolvedValue({ ...orphan });
    db.role.findUnique.mockResolvedValue(modRole);
    db.role.findFirst.mockResolvedValue(modRole);
  });

  const companyOf = () => db.user.update.mock.calls[0]?.[0]?.data?.companyId;

  it('puts them in the company when a company admin gives them a role', async () => {
    const res = await patch({ action: 'assignRole', roleId: 'role-mod' });
    expect(res.status).toBe(200);
    expect(companyOf()).toBe('c1');
  });

  /**
   * AND THIS IS THE CASE THAT WAS BROKEN.
   *
   * The owner is a platform SUPER_ADMIN with `companyId: null`. The old
   * condition required the admin to HAVE a company and NOT to be a
   * SUPER_ADMIN, so for the only person who ever approves staff it was false
   * twice — and the employee was left company-less for ever, invisible to
   * every screen that looks a person up with `{ id, companyId }`.
   */
  it('and when the OWNER does it — a platform super-admin with no company', async () => {
    actor.current = { id: 'owner', name: 'المالك', role: 'SUPER_ADMIN', companyId: null };
    const res = await patch({ action: 'assignRole', roleId: 'role-mod' });
    expect(res.status).toBe(200);
    expect(companyOf(), 'الموظّف بقي بلا شركة — وهذا أصل خمسة أعطال').toBe('c1');
  });

  it('through the legacy role string too', async () => {
    actor.current = { id: 'owner', name: 'المالك', role: 'SUPER_ADMIN', companyId: null };
    const res = await patch({ action: 'assignRole', role: 'MODERATOR' });
    expect(res.status).toBe(200);
    expect(companyOf()).toBe('c1');
  });

  /** A platform administrator has no company on purpose. */
  it('but never a new super-admin', async () => {
    actor.current = { id: 'owner', name: 'المالك', role: 'SUPER_ADMIN', companyId: null };
    db.role.findUnique.mockResolvedValue({ id: 'role-su', name: 'SUPER_ADMIN', companyId: null, _count: { users: 1 } });
    await patch({ action: 'assignRole', roleId: 'role-su' });
    expect(companyOf(), 'مدير المنصّة أُلحق بشركة').toBeUndefined();
  });

  /**
   * AND AN ACTIVE ACCOUNT FROM SOMEWHERE ELSE IS STILL NOT CAPTURABLE.
   *
   * Adoption is for onboarding, not for taking over an account that already
   * belongs to a person somewhere. A company admin may only adopt a PENDING
   * one — that boundary is unchanged.
   */
  it('and a company admin still cannot capture an active company-less account', async () => {
    db.user.findUnique.mockResolvedValue({ ...orphan, status: 'ACTIVE' });
    const res = await patch({ action: 'assignRole', roleId: 'role-mod' });
    expect(res.status).toBe(403);
    expect(db.user.update).not.toHaveBeenCalled();
  });
});
