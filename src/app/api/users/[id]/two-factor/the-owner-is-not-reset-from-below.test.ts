import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * NOBODY STRIPS THE SECOND FACTOR OFF THE ACCOUNT ABOVE THEM.
 *
 * `mayResetTwoFactor` admits the holders of `users.security` (SUPER_ADMIN centrally, COMPANY_ADMIN by the migration), by design:
 * the owner of a company unlocks their own locked-out staff. What it
 * cannot know, holding only an id, is WHOSE account the id belongs to.
 *
 * `manageableUserWhere` then finds the row, and it says yes to an unplaced
 * account (`companyId: null`) on purpose — seeing one is how a new signup
 * gets adopted. So a COMPANY_ADMIN sending the platform owner's id was
 * matched either way: the owner is either inside their company or unplaced.
 *
 * The press cleared the owner's enrolment, deleted their recovery codes,
 * and — once the session-ending bump was added beside it — signed them out
 * of every device at the same instant. The account that can do everything,
 * locked out and re-enrolling, at the press of somebody junior to it,
 * repeatable at will.
 *
 * These ask the DOOR, not the source: what status comes back, and whether
 * anything was written. A guard that returns 403 while the transaction
 * still runs is not a guard.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, logAudit } = vi.hoisted(() => ({
  db: {
    user: { findFirst: vi.fn(), update: vi.fn() },
    twoFactorRecoveryCode: { deleteMany: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
// The reach rule (canActOnUser): open by default; its refusal is asked below.
const reach = vi.hoisted(() => ({ canActOnUser: vi.fn(async (..._a: unknown[]) => ({ ok: true }) as { ok: boolean; status?: number; error?: string }) }));
vi.mock('@/lib/user-permissions', () => ({ canActOnUser: (...a: unknown[]) => reach.canActOnUser(...a) }));
// Surfaced rather than swallowed: an unexpected throw should fail an
// assertion with its message in the body, not look like a tidy refusal.
vi.mock('@/lib/api-error', () => ({
  apiErrorResponse: (e: unknown) =>
    new Response(JSON.stringify({ error: `UNEXPECTED: ${(e as Error)?.message}` }), { status: 500 }),
}));

import { DELETE } from './route';

const COMPANY = 'c1';
const ENROLLED = new Date('2026-09-01T10:00:00.000Z');

/**
 * The person pressing the button. PR-13 (قديم ← جديد): the reset is the key `users.security` now, which the migration gave to the
 * company admin — so that role carries it here; SUPER_ADMIN passes centrally and lists nothing.
 */
const admin = (role: string, companyId: string | null, id = 'admin-1', permissions: string[] = role === 'COMPANY_ADMIN' ? ['users.security'] : []) => ({
  id,
  name: 'الضاغط',
  role,
  companyId,
  permissions,
});

/** The row the database returns for the id in the URL. */
const target = (role: string, companyId: string | null, id = 'target-1') => ({
  id,
  name: 'صاحب الحساب',
  email: 'x@example.com',
  role,
  companyId,
  totpEnabledAt: ENROLLED,
});

const press = (id: string) =>
  DELETE(new Request(`http://localhost/api/users/${id}/two-factor`, { method: 'DELETE' }), {
    params: Promise.resolve({ id }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(db));
  db.user.update.mockResolvedValue({});
  db.twoFactorRecoveryCode.deleteMany.mockResolvedValue({ count: 0 });
  logAudit.mockResolvedValue(undefined);
});

describe('the second factor of an account above you', () => {
  it('a company owner cannot reset a SUPER_ADMIN, and nothing is written', async () => {
    requireContext.mockResolvedValue({ user: admin('COMPANY_ADMIN', COMPANY), companyId: COMPANY });
    db.user.findFirst.mockResolvedValue(target('SUPER_ADMIN', COMPANY));

    const res = await press('target-1');
    const body = await res.json();

    expect(res.status, JSON.stringify(body)).toBe(403);
    expect(body.code).toBe('SUPER_ADMIN_ONLY');
    expect(db.$transaction, 'انمسح التحقّق رغم الرفض').not.toHaveBeenCalled();
    expect(db.user.update, 'انتهت جلسات المالك رغم الرفض').not.toHaveBeenCalled();
    expect(db.twoFactorRecoveryCode.deleteMany).not.toHaveBeenCalled();
  });

  it('and not even when the owner is an unplaced platform account', async () => {
    /*
     * `manageableUserWhere` shows an unplaced account to a company admin so
     * it can be adopted. Showing is not acting — and here the tenancy line
     * is reached first, so the answer is «غير موجود» rather than «ممنوع».
     * That is the stronger of the two: 403 would confirm that this id is a
     * platform owner to somebody who may not touch it.
     */
    requireContext.mockResolvedValue({ user: admin('COMPANY_ADMIN', COMPANY), companyId: COMPANY });
    db.user.findFirst.mockResolvedValue(target('SUPER_ADMIN', null));

    const res = await press('target-1');
    expect(res.status).toBe(404);
    expect(db.$transaction, 'انمسح تحقّق مالك المنصّة').not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('and a company owner cannot reach an unplaced employee either — 404, not 403', async () => {
    // Confirming that an id exists outside your tenancy is itself an answer.
    requireContext.mockResolvedValue({ user: admin('COMPANY_ADMIN', COMPANY), companyId: COMPANY });
    db.user.findFirst.mockResolvedValue(target('MODERATOR', null));

    const res = await press('target-1');
    expect(res.status).toBe(404);
    expect(db.$transaction, 'انمسح تحقّق حساب برّا الشركة').not.toHaveBeenCalled();
  });
});

describe('without the key nothing is read and nothing is written', () => {
  it('a company admin the owner took users.security from is refused before the account is even looked up', async () => {
    requireContext.mockResolvedValue({ user: admin('COMPANY_ADMIN', COMPANY, 'admin-1', ['users.view', 'users.edit']), companyId: COMPANY });
    const res = await press('target-1');
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('NO_SECURITY_KEY');
    expect(db.user.findFirst, 'وصل للقاعدة قبل ما يرفض').not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('and a manager who was handed the key can reset an ordinary employee — the key is the rule, not a name', async () => {
    requireContext.mockResolvedValue({ user: admin('MANAGER', COMPANY, 'admin-1', ['users.security']), companyId: COMPANY });
    db.user.findFirst.mockResolvedValue(target('MODERATOR', COMPANY));
    expect((await press('target-1')).status).toBe(200);
  });

  it('but holding the key never lifts the rank rule: nobody resets a SUPER_ADMIN from below', async () => {
    requireContext.mockResolvedValue({ user: admin('MANAGER', COMPANY, 'admin-1', ['users.security']), companyId: COMPANY });
    db.user.findFirst.mockResolvedValue(target('SUPER_ADMIN', COMPANY));
    const res = await press('target-1');
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('SUPER_ADMIN_ONLY');
    expect(db.user.update).not.toHaveBeenCalled();
  });
});

describe('and the door still does its job', () => {
  it('a company owner resets his own employee, and the sessions end', async () => {
    requireContext.mockResolvedValue({ user: admin('COMPANY_ADMIN', COMPANY), companyId: COMPANY });
    db.user.findFirst.mockResolvedValue(target('MODERATOR', COMPANY));

    const res = await press('target-1');
    expect(res.status).toBe(200);
    expect(db.user.update).toHaveBeenCalledTimes(1);
    expect(db.user.update.mock.calls[0][0].data).toMatchObject({
      totpSecretEnc: null,
      totpEnabledAt: null,
      tokenVersion: { increment: 1 },
    });
    expect(db.twoFactorRecoveryCode.deleteMany).toHaveBeenCalledTimes(1);
  });

  it('an employee holding powers the resetter lacks: refused, and nothing is cleared', async () => {
    // A company admin the owner restricted, resetting the other company admin:
    // the reset-role check lets them through, the reach rule does not.
    requireContext.mockResolvedValue({ user: admin('COMPANY_ADMIN', COMPANY), companyId: COMPANY });
    db.user.findFirst.mockResolvedValue(target('COMPANY_ADMIN', COMPANY));
    reach.canActOnUser.mockResolvedValueOnce({ ok: false, status: 403, error: 'لا يمكنك إدارة هذا الحساب' });
    const res = await press('target-1');
    expect(reach.canActOnUser).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(403);
    expect(db.user.update).not.toHaveBeenCalled();
    expect(db.twoFactorRecoveryCode.deleteMany).not.toHaveBeenCalled();
  });

  it('and the platform owner may reset another SUPER_ADMIN — the rule is rank, not a wall', async () => {
    requireContext.mockResolvedValue({ user: admin('SUPER_ADMIN', null), companyId: COMPANY });
    db.user.findFirst.mockResolvedValue(target('SUPER_ADMIN', COMPANY));

    const res = await press('target-1');
    expect(res.status).toBe(200);
    expect(db.user.update).toHaveBeenCalledTimes(1);
  });

  it('and never on himself — the rule that was already there stays', async () => {
    requireContext.mockResolvedValue({ user: admin('SUPER_ADMIN', null, 'me'), companyId: COMPANY });

    const res = await press('me');
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.code).toBe('NOT_YOURSELF');
    expect(db.user.findFirst, 'وصل للقاعدة قبل ما يرفض').not.toHaveBeenCalled();
  });
});
