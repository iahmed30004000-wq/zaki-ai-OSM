import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A1 — A SESSION IS NOT ENOUGH TO ADD A WAY INTO AN ACCOUNT.
 *
 * Starting a fingerprint registration asks for the current password (or a fresh six-digit
 * code). A challenge exists only for somebody who passed, and the finish accepts nothing but
 * an unspent challenge. The ordinary case, an owner typing their own password, still works.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, getCurrentUser, checkSecondFactor } = vi.hoisted(() => ({
  db: {
    user: { findUnique: vi.fn() },
    passkey: { findMany: vi.fn() },
    passkeyChallenge: { create: vi.fn() },
  },
  getCurrentUser: vi.fn(),
  checkSecondFactor: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/auth', () => ({
  getCurrentUser: (...a: unknown[]) => getCurrentUser(...a),
  verifyPassword: async (plain: string, hash: string) => hash === `hash:${plain}`,
}));
vi.mock('@/lib/two-factor', async (orig) => ({
  ...(await orig<typeof import('@/lib/two-factor')>()),
  checkSecondFactor: (...a: unknown[]) => checkSecondFactor(...a),
}));

import { POST } from './route';

let who = 0;
const me = (over: Record<string, unknown> = {}) => ({ id: `u${++who}`, name: 'سارة', email: 's@x.example', companyId: 'c1', status: 'ACTIVE', ...over });
const start = (body?: unknown) =>
  POST(new Request('http://localhost/api/auth/passkey', { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.AUTH_PASSKEY_STEP_UP;
  getCurrentUser.mockImplementation(async () => me());
  db.user.findUnique.mockResolvedValue({ passwordHash: 'hash:Right-Password1' });
  db.passkey.findMany.mockResolvedValue([]);
  db.passkeyChallenge.create.mockResolvedValue({});
});
afterEach(() => {
  delete process.env.AUTH_PASSKEY_STEP_UP;
});

describe('starting a registration', () => {
  it('REFUSES a signed-in session that knows no password — no challenge exists afterwards', async () => {
    for (const body of [undefined, {}, { password: '' }, { password: 42 }, { code: '12' }]) {
      const res = await start(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).code).toBe('STEP_UP');
    }
    expect(db.passkeyChallenge.create).not.toHaveBeenCalled();
  });

  it('REFUSES a wrong password', async () => {
    const res = await start({ password: 'guess' });
    expect(res.status).toBe(401);
    expect(db.passkeyChallenge.create).not.toHaveBeenCalled();
  });

  it('PASSES the right password — the challenge is issued exactly as before', async () => {
    const res = await start({ password: 'Right-Password1' });
    const out = await res.json();
    expect(res.status).toBe(200);
    expect(out.challenge).toEqual(expect.any(String));
    expect(out.rp).toMatchObject({ id: 'localhost' });
    expect(db.passkeyChallenge.create).toHaveBeenCalledTimes(1);
    expect(db.passkeyChallenge.create.mock.calls[0][0].data).toMatchObject({ kind: 'REGISTER' });
  });

  it('PASSES a fresh six-digit code in place of the password', async () => {
    checkSecondFactor.mockResolvedValue({ usedRecovery: false, recoveryLeft: 8 });
    const res = await start({ code: '123456' });
    expect(res.status).toBe(200);
    expect(checkSecondFactor).toHaveBeenCalledTimes(1);
    expect(db.passkeyChallenge.create).toHaveBeenCalledTimes(1);
  });

  it('REFUSES an account that is suspended, disabled or pending, password right or not', async () => {
    for (const status of ['SUSPENDED', 'DISABLED', 'PENDING']) {
      getCurrentUser.mockResolvedValueOnce(me({ status }));
      expect((await start({ password: 'Right-Password1' })).status, status).toBe(403);
    }
    expect(db.passkeyChallenge.create).not.toHaveBeenCalled();
  });

  it('still refuses a visitor with no session at all', async () => {
    getCurrentUser.mockResolvedValueOnce(null);
    expect((await start({ password: 'Right-Password1' })).status).toBe(401);
  });

  it('with the switch off the old behaviour returns: a session is enough', async () => {
    process.env.AUTH_PASSKEY_STEP_UP = 'off';
    expect((await start()).status).toBe(200);
    expect(db.passkeyChallenge.create).toHaveBeenCalledTimes(1);
  });
});
