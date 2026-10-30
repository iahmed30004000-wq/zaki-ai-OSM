import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A2 — «أصدر رمز تفعيل»: WHO MAY, FOR WHOM, AND WHAT IS KEPT.
 *
 * The code is returned once and stored only as a hash. It is issued by the holders of
 * `users.security` (D6), never for yourself, never for an account that already has a factor.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, logAudit, requireContext, canActOnUser } = vi.hoisted(() => ({
  db: { user: { findFirst: vi.fn(), update: vi.fn() } },
  logAudit: vi.fn(),
  requireContext: vi.fn(),
  canActOnUser: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/user-permissions', () => ({ canActOnUser: (...a: unknown[]) => canActOnUser(...a) }));

import { POST } from './route';
import { judgeEnrolCode } from '@/lib/enrol-code';

const as = (role: string, id = 'boss', permissions: string[] = []): SessionUser =>
  ({ id, role, name: 'المدير', status: 'ACTIVE', companyId: 'c1', permissions }) as unknown as SessionUser;
const target = (over: Record<string, unknown> = {}) => ({
  id: 'emp', name: 'سارة', email: 's@x.example', role: 'MODERATOR', roleId: null, companyId: 'c1', totpEnabledAt: null, status: 'ACTIVE', ...over,
});
const issue = (id = 'emp') => POST(new Request(`http://localhost/api/users/${id}/enrol-code`, { method: 'POST' }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: as('SUPER_ADMIN'), companyId: 'c1' });
  db.user.findFirst.mockResolvedValue(target());
  db.user.update.mockResolvedValue({});
  canActOnUser.mockResolvedValue({ ok: true });
});

describe('issuing', () => {
  it('PASSES for the owner: the code comes back once, in a shape a person can read out', async () => {
    const res = await issue();
    const out = await res.json();
    expect(res.status).toBe(200);
    expect(out.code).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    expect(out.hours).toBe(24);
  });

  it('stores only the hash and the expiry — never the code — and the hash is the code\'s', async () => {
    const out = await (await issue()).json();
    const data = db.user.update.mock.calls[0][0].data as { enrolCodeHash: string; enrolCodeExpiresAt: Date };
    expect(JSON.stringify(data)).not.toContain(out.code.replace('-', ''));
    expect(await judgeEnrolCode(data, out.code)).toBe('ok');
    expect(db.user.update.mock.calls[0][0].where).toEqual({ id: 'emp' });
  });

  it('writes the audit row without the code', async () => {
    const out = await (await issue()).json();
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit.mock.calls[0][0]).toMatchObject({ action: 'ENROL_CODE_ISSUED', entityId: 'emp' });
    expect(JSON.stringify(logAudit.mock.calls[0][0])).not.toContain(out.code);
  });

  it('PASSES for a company admin who holds users.security (D6)', async () => {
    requireContext.mockResolvedValue({ user: as('COMPANY_ADMIN', 'boss', ['users.security']), companyId: 'c1' });
    expect((await issue()).status).toBe(200);
  });

  it('a new code replaces the old one — the one sent to the wrong person is cancelled by issuing another', async () => {
    await issue();
    await issue();
    expect(db.user.update).toHaveBeenCalledTimes(2);
    const [a, b] = db.user.update.mock.calls.map((c) => c[0].data.enrolCodeHash);
    expect(a).not.toBe(b);
  });
});

describe('refusing', () => {
  it('REFUSES a manager holding users.edit but not the key', async () => {
    requireContext.mockResolvedValue({ user: as('MANAGER', 'boss', ['users.view', 'users.edit']), companyId: 'c1' });
    const res = await issue();
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('NO_SECURITY_KEY');
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('REFUSES the owner issuing a code for themselves', async () => {
    const res = await issue('boss');
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('NOT_YOURSELF');
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('REFUSES an account that already has a second factor, and one that is not active', async () => {
    db.user.findFirst.mockResolvedValueOnce(target({ totpEnabledAt: new Date() }));
    const enrolled = await issue();
    expect(enrolled.status).toBe(409);
    expect((await enrolled.json()).code).toBe('ALREADY_ENROLLED');

    db.user.findFirst.mockResolvedValueOnce(target({ status: 'SUSPENDED' }));
    expect((await issue()).status).toBe(409);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('REFUSES a company admin reaching for the owner\'s account, and anyone beyond their reach', async () => {
    requireContext.mockResolvedValue({ user: as('COMPANY_ADMIN', 'boss', ['users.security']), companyId: 'c1' });
    db.user.findFirst.mockResolvedValueOnce(target({ role: 'SUPER_ADMIN' }));
    expect((await issue()).status).toBe(403);

    canActOnUser.mockResolvedValueOnce({ ok: false, status: 403, error: 'خارج صلاحيتك' });
    expect((await issue()).status).toBe(403);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('answers «غير موجود» for somebody else\'s company', async () => {
    db.user.findFirst.mockResolvedValueOnce(null);
    expect((await issue()).status).toBe(404);
    db.user.findFirst.mockResolvedValueOnce(target({ companyId: 'other-company' }));
    requireContext.mockResolvedValue({ user: as('COMPANY_ADMIN', 'boss', ['users.security']), companyId: 'c1' });
    expect((await issue()).status).toBe(404);
  });
});
