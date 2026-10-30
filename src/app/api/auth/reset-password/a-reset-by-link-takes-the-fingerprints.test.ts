import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A1 — A PASSWORD CHANGED BY THE EMAILED LINK ALSO TAKES THE FINGERPRINTS.
 * Whoever held the old password may have added a key; the new password must not sit beside it.
 * A bad or expired link changes nothing at all.
 */

const { tx, db } = vi.hoisted(() => {
  const tx = {
    user: { update: vi.fn(async () => ({ id: 'u1', status: 'ACTIVE', email: 'a@x.example', companyId: 'c1' })) },
    passkey: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    passkeyChallenge: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  };
  return {
    tx,
    db: { user: { findFirst: vi.fn() }, $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) },
  };
});
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/auth', () => ({ hashPassword: vi.fn(async (p: string) => `hash:${p}`) }));

import { POST } from './route';

let n = 0;
const reset = () =>
  POST(
    new Request('http://localhost/api/auth/reset-password', {
      method: 'POST',
      headers: { 'x-forwarded-for': `192.0.2.${++n}` },
      body: JSON.stringify({ token: 'a-long-enough-token', password: 'Brand-New-Pass9', confirmPassword: 'Brand-New-Pass9' }),
    })
  );

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TRUST_PROXY = 'true';
  delete process.env.AUTH_PASSKEY_WIPE;
  db.user.findFirst.mockResolvedValue({ id: 'u1' });
});
afterEach(() => {
  delete process.env.TRUST_PROXY;
  delete process.env.AUTH_PASSKEY_WIPE;
});

describe('a reset by link', () => {
  it('sets the password, ends the sessions, and removes the fingerprints and their challenges — together', async () => {
    const res = await reset();
    expect(res.status).toBe(200);
    expect(tx.user.update.mock.calls[0][0].data).toMatchObject({ passwordHash: 'hash:Brand-New-Pass9', tokenVersion: { increment: 1 } });
    expect(tx.passkey.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    expect(tx.passkeyChallenge.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
  });

  it('with a bad or expired link changes nothing and removes nothing', async () => {
    db.user.findFirst.mockResolvedValueOnce(null);
    const res = await reset();
    expect(res.status).toBe(400);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(tx.passkey.deleteMany).not.toHaveBeenCalled();
  });

  it('with the switch off the password still changes and the fingerprints stay', async () => {
    process.env.AUTH_PASSKEY_WIPE = 'off';
    expect((await reset()).status).toBe(200);
    expect(tx.user.update).toHaveBeenCalledTimes(1);
    expect(tx.passkey.deleteMany).not.toHaveBeenCalled();
  });
});
