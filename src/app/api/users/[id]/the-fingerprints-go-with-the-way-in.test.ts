import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A1 — WHEN A WAY IN IS CLOSED, THE FINGERPRINTS GO WITH IT.
 *
 * Forcing a sign-out, suspending, disabling, setting a new password and resetting the second
 * factor all end the sessions. They now also remove the person's fingerprints and the open
 * challenges, in the SAME transaction. Changing a role, re-activating, or a plain edit leaves
 * them alone: this must never sign anybody's phone out for nothing.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { tx, db, requirePermission, canActOnUser } = vi.hoisted(() => {
  const tx = {
    user: { update: vi.fn(async () => ({ id: 'emp', name: 'سارة', email: 's@x.example', role: 'MODERATOR', status: 'ACTIVE', assignedById: null, assignedAt: null })) },
    passkey: { deleteMany: vi.fn(async () => ({ count: 2 })) },
    passkeyChallenge: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    twoFactorRecoveryCode: { deleteMany: vi.fn(async () => ({ count: 8 })) },
  };
  return {
    tx,
    db: {
      user: { findUnique: vi.fn(), findFirst: vi.fn() },
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    },
    requirePermission: vi.fn(),
    canActOnUser: vi.fn(async () => ({ ok: true })),
  };
});
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/auth', () => ({ hashPassword: vi.fn(async (p: string) => `hash:${p}`), resolveSingleCompanyId: vi.fn() }));
vi.mock('@/lib/authorization', () => ({ can: () => true, requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/user-permissions', async (orig) => ({
  ...(await orig<typeof import('@/lib/user-permissions')>()),
  canActOnUser: (...a: unknown[]) => canActOnUser(...(a as [])),
}));
vi.mock('@/lib/geo-context', () => ({ requireContext: vi.fn(async () => ({ user: ADMIN, companyId: 'c1' })) }));

import { PATCH } from './route';
import { DELETE as resetTwoFactor } from './two-factor/route';

const ADMIN = { id: 'boss', role: 'SUPER_ADMIN', name: 'المدير', status: 'ACTIVE', companyId: 'c1', permissions: [] };
const TARGET = { id: 'emp', name: 'سارة', email: 's@x.example', role: 'MODERATOR', roleId: null, status: 'ACTIVE', companyId: 'c1', totpEnabledAt: new Date(), assignedBy: null };

const patch = (body: Record<string, unknown>) =>
  PATCH(new Request('http://localhost/api/users/emp', { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'emp' }) });

const wiped = () => tx.passkey.deleteMany.mock.calls.map((c) => (c[0] as { where: { userId: string } }).where.userId);
const challengesWiped = () => tx.passkeyChallenge.deleteMany.mock.calls.length;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.AUTH_PASSKEY_WIPE;
  requirePermission.mockResolvedValue(ADMIN);
  db.user.findUnique.mockResolvedValue(TARGET);
  db.user.findFirst.mockResolvedValue(TARGET);
});
afterEach(() => {
  delete process.env.AUTH_PASSKEY_WIPE;
});

describe('the actions that close the way in', () => {
  it('forcing a sign-out removes the fingerprints and their challenges, for that person only', async () => {
    expect((await patch({ action: 'forceLogout' })).status).toBe(200);
    expect(wiped()).toEqual(['emp']);
    expect(challengesWiped()).toBe(1);
    expect(tx.user.update.mock.calls[0][0].data).toMatchObject({ tokenVersion: { increment: 1 } });
  });

  it('suspending and disabling remove them', async () => {
    await patch({ action: 'changeStatus', status: 'SUSPENDED' });
    await patch({ action: 'changeStatus', status: 'DISABLED' });
    expect(wiped()).toEqual(['emp', 'emp']);
  });

  it('setting a new password removes them, in the same transaction as the new hash', async () => {
    const res = await patch({ action: 'resetPassword', newPassword: 'Brand-New-Pass9' });
    expect(res.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.user.update.mock.calls[0][0].data).toMatchObject({ passwordHash: 'hash:Brand-New-Pass9' });
    expect(wiped()).toEqual(['emp']);
  });

  it('resetting the second factor removes them too', async () => {
    const res = await resetTwoFactor(new Request('http://localhost/api/users/emp/two-factor', { method: 'DELETE' }), { params: Promise.resolve({ id: 'emp' }) });
    expect(res.status).toBe(200);
    expect(tx.twoFactorRecoveryCode.deleteMany).toHaveBeenCalledTimes(1);
    expect(wiped()).toEqual(['emp']);
  });
});

describe('the actions that must NOT take a person\'s fingerprints', () => {
  it('re-activating an account, changing the role, or a plain contact edit leave them alone', async () => {
    await patch({ action: 'changeStatus', status: 'ACTIVE' });
    await patch({ action: 'changeStatus', status: 'PENDING' });
    await patch({ action: 'updateContact', phone: '+963999111222' });
    expect(wiped()).toEqual([]);
    expect(challengesWiped()).toBe(0);
  });
});

describe('the switch', () => {
  it('AUTH_PASSKEY_WIPE=off puts back the old behaviour on every one of the doors', async () => {
    process.env.AUTH_PASSKEY_WIPE = 'off';
    await patch({ action: 'forceLogout' });
    await patch({ action: 'changeStatus', status: 'SUSPENDED' });
    await patch({ action: 'resetPassword', newPassword: 'Brand-New-Pass9' });
    await resetTwoFactor(new Request('http://localhost/api/users/emp/two-factor', { method: 'DELETE' }), { params: Promise.resolve({ id: 'emp' }) });
    expect(wiped()).toEqual([]);
    expect(challengesWiped()).toBe(0);
  });
});
