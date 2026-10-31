import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A1 — CHANGING YOUR OWN PASSWORD ENDS YOUR OTHER SESSIONS, AND NOW YOUR FINGERPRINTS TOO.
 * A key added from a stolen session must not survive the password change that answers the theft.
 * A plain profile edit (name, picture) touches neither.
 */

type Fn<R> = (...a: unknown[]) => Promise<R>;
type Tx = {
  user: { update: Fn<unknown> };
  passkey: { deleteMany: Fn<{ count: number }> };
  passkeyChallenge: { deleteMany: Fn<{ count: number }> };
};

const { tx, db } = vi.hoisted(() => {
  const tx = {
    user: { update: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})) },
    passkey: { deleteMany: vi.fn(async (..._a: unknown[]) => ({ count: 1 })) },
    passkeyChallenge: { deleteMany: vi.fn(async (..._a: unknown[]) => ({ count: 0 })) },
  };
  return {
    tx,
    db: {
      user: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ passwordHash: 'hash:Old-Password1' })), update: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})) },
      $transaction: vi.fn(async (fn: (t: Tx) => Promise<unknown>) => fn(tx as unknown as Tx)),
    },
  };
});
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/auth', () => ({
  requireAuth: async () => ({ id: 'me', companyId: 'c1' }),
  hashPassword: async (p: string) => `hash:${p}`,
  verifyPassword: async (plain: string, hash: string) => hash === `hash:${plain}`,
}));

import { PATCH } from './route';

const patch = (body: unknown) => PATCH(new Request('http://localhost/api/profile', { method: 'PATCH', body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.AUTH_PASSKEY_WIPE;
});
afterEach(() => {
  delete process.env.AUTH_PASSKEY_WIPE;
});

describe('a password changed from the profile', () => {
  it('sets the password, ends the other sessions, and removes the fingerprints and their challenges — together', async () => {
    const res = await patch({ currentPassword: 'Old-Password1', newPassword: 'Brand-New-Pass9' });
    expect(res.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.user.update.mock.calls[0]?.[0]).toMatchObject({ where: { id: 'me' }, data: { passwordHash: 'hash:Brand-New-Pass9', tokenVersion: { increment: 1 } } });
    expect(tx.passkey.deleteMany).toHaveBeenCalledWith({ where: { userId: 'me' } });
    expect(tx.passkeyChallenge.deleteMany).toHaveBeenCalledWith({ where: { userId: 'me' } });
  });

  it('a WRONG current password changes nothing and removes nothing', async () => {
    const res = await patch({ currentPassword: 'nope', newPassword: 'Brand-New-Pass9' });
    expect(res.status).toBe(400);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(tx.passkey.deleteMany).not.toHaveBeenCalled();
  });

  it('a name or picture edit keeps the fingerprints — the single update it always was', async () => {
    const res = await patch({ name: 'سارة أحمد' });
    expect(res.status).toBe(200);
    expect(db.user.update).toHaveBeenCalledTimes(1);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(tx.passkey.deleteMany).not.toHaveBeenCalled();
  });

  it('with the switch off the password still changes and the fingerprints stay', async () => {
    process.env.AUTH_PASSKEY_WIPE = 'off';
    expect((await patch({ currentPassword: 'Old-Password1', newPassword: 'Brand-New-Pass9' })).status).toBe(200);
    expect(tx.user.update).toHaveBeenCalledTimes(1);
    expect(tx.passkey.deleteMany).not.toHaveBeenCalled();
  });
});
