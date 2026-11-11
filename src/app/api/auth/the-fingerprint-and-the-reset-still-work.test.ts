import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { decodeJwt } from 'jose';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE OTHER WAYS IN AND AROUND THE SECOND CODE — TWO OF THEM, AT THE DOOR.
 *
 * The owner's ruling 11/11 (`AUTH_TWO_FACTOR_REQUIRED` off by default, sign-ins a year long):
 *
 *   · THE FINGERPRINT (`/api/auth/passkey/login`) never asked for the second code — it was the second code and the password
 *     in one. It must work in both states, and the session it makes is a year long like every other.
 *   · THE PASSWORD RESET (`/api/auth/reset-password`) makes NO session, in either state: it ends at the login page, where
 *     the password now opens the account (switch off) or the second code is asked as before (switch on).
 *
 * Real routes and real requests; the database, the audit trail and the WebAuthn signature check are stood in for.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, verifyAssertion, logAudit } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a loose stand-in for the database; every call below is checked by its result
  const db: Record<string, any> = {
    user: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(async () => ({ tokenVersion: 3, id: 'u1', email: 'a@b.c', companyId: 'c1', status: 'ACTIVE' })) },
    userSession: {
      create: vi.fn(async () => ({ id: 'session-1' })),
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    passkey: {
      findUnique: vi.fn(),
      update: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    passkeyChallenge: {
      create: vi.fn(async () => ({})),
      findFirst: vi.fn(async () => ({ id: 'ch1', challenge: 'CHALLENGE' })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return {
    db,
    verifyAssertion: vi.fn<(...a: unknown[]) => { ok: boolean; counter?: number; code?: string }>(() => ({ ok: true, counter: 5 })),
    logAudit: vi.fn<(...a: unknown[]) => Promise<undefined>>(async () => undefined),
  };
});
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/attendance', () => ({ markLogin: vi.fn(async () => undefined) }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => ({ get: () => null }),
}));
vi.mock('@/lib/passkey', async (orig) => ({
  ...(await orig<typeof import('@/lib/passkey')>()),
  relyingParty: () => ({ rpId: 'oms.example.test', origin: 'https://oms.example.test' }),
  publicOrigin: () => 'https://oms.example.test',
  verifyAssertion: (...a: unknown[]) => verifyAssertion(...a),
}));

import { POST as fingerprint } from './passkey/login/route';
import { POST as reset } from './reset-password/route';
import { POST as login } from './login/route';
import { storedForm } from '@/lib/reset-token';

type Audit = { action: string; newData: { factor?: string } };
const YEAR = 365 * 24 * 60 * 60;
let n = 0;
const post = (handler: (req: Request) => Promise<Response>, url: string, body: unknown) =>
  handler(
    new Request(`https://oms.example.test${url}`, {
      method: 'POST',
      headers: { 'x-forwarded-for': `198.51.100.${++n % 250}` },
      body: JSON.stringify(body),
    })
  );

const user = (over: Record<string, unknown> = {}) => ({
  id: `u-${++n}`,
  email: `person${n}@shop.example`,
  name: 'شخص',
  role: 'MANAGER',
  status: 'ACTIVE',
  companyId: 'c1',
  commissionRate: null,
  passwordHash: bcrypt.hashSync('Right-Password1', 4),
  totpEnabledAt: new Date('2026-09-01T00:00:00Z'),
  company: { name: 'زكي' },
  ...over,
});

function sessionCookie(res: Response): { maxAge: number; tokenSeconds: number } | null {
  const header = res.headers.get('set-cookie') ?? '';
  const mine = header.split(/,(?=\s*[A-Za-z_]+=)/).find((c) => c.trim().startsWith('salesflow_session='));
  if (!mine) return null;
  const claims = decodeJwt(/salesflow_session=([^;]+)/.exec(mine)![1]);
  return { maxAge: Number(/Max-Age=(\d+)/i.exec(mine)?.[1]), tokenSeconds: (claims.exp as number) - (claims.iat as number) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('JWT_SECRET', 'k'.repeat(40));
  vi.stubEnv('TRUST_PROXY', 'true');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the fingerprint sign-in', () => {
  const signWithFinger = async (who: ReturnType<typeof user>) => {
    db.passkey.findUnique.mockResolvedValue({ id: 'k1', userId: who.id, publicKey: 'PK', algorithm: -7, counter: 1 });
    db.user.findUnique.mockResolvedValue(who);
    return post(fingerprint, '/api/auth/passkey/login', {
      credentialId: 'cred-1',
      challenge: 'CHALLENGE',
      authenticatorData: 'a',
      clientDataJSON: 'b',
      signature: 'c',
      remember: false,
    });
  };

  for (const mode of ['off (the default)', 'on'] as const) {
    it(`opens the account with the second code ${mode} — never asks for it — and the session is a year long`, async () => {
      if (mode === 'on') vi.stubEnv('AUTH_TWO_FACTOR_REQUIRED', 'on');
      const res = await signWithFinger(user());
      expect(res.status).toBe(200);
      expect(await res.json()).not.toHaveProperty('twoFactor');
      expect(sessionCookie(res)).toEqual({ maxAge: YEAR, tokenSeconds: YEAR });
      expect(logAudit.mock.calls.some(([a]) => (a as Audit).action === 'USER_LOGGED_IN' && (a as Audit).newData.factor === 'passkey')).toBe(true);
    });
  }

  it('a bad signature is still refused, and nothing is issued', async () => {
    verifyAssertion.mockReturnValueOnce({ ok: false, code: 'BAD_SIGNATURE' });
    const res = await signWithFinger(user());
    expect(res.status).toBe(401);
    expect(sessionCookie(res)).toBeNull();
  });

  it('and under the old short rule it is 7 days, as before', async () => {
    vi.stubEnv('AUTH_SHORT_SESSIONS', 'on');
    const res = await signWithFinger(user());
    expect(sessionCookie(res)).toEqual({ maxAge: 7 * 86400, tokenSeconds: 7 * 86400 });
  });
});

describe('the password reset', () => {
  const link = 'reset-link-0123456789';
  const resetWith = async (who: ReturnType<typeof user>) => {
    db.user.findFirst.mockResolvedValue(who);
    db.user.update.mockResolvedValue({ ...who, tokenVersion: 4 });
    return post(reset, '/api/auth/reset-password', { token: link, password: 'Brand-New-Pass1', confirmPassword: 'Brand-New-Pass1' });
  };

  for (const mode of ['off (the default)', 'on'] as const) {
    it(`makes no session with the second code ${mode}: it sends the person to the login page, and ends every old session`, async () => {
      if (mode === 'on') vi.stubEnv('AUTH_TWO_FACTOR_REQUIRED', 'on');
      const who = user();
      const res = await resetWith(who);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ success: true, signIn: true });
      expect(sessionCookie(res), 'الاستعادة فتحت جلسة').toBeNull();
      // the link was looked up by its hash, and every older session ends with the change
      expect(db.user.findFirst.mock.calls[0][0].where.resetToken).toBe(storedForm(link));
      expect(db.user.update.mock.calls[0][0].data.tokenVersion).toEqual({ increment: 1 });
    });
  }

  it('and the very next sign-in, with the new password alone, is a session (switch off) — nobody is held at a step', async () => {
    const fresh = user({ passwordHash: bcrypt.hashSync('Brand-New-Pass1', 4) });
    db.user.findUnique.mockResolvedValue(fresh);
    const res = await post(login, '/api/auth/login', { email: fresh.email, password: 'Brand-New-Pass1' });
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty('twoFactor');
    expect(sessionCookie(res)).toEqual({ maxAge: YEAR, tokenSeconds: YEAR });
  });

  it('while with the switch on the same sign-in is asked for the second code, as before', async () => {
    vi.stubEnv('AUTH_TWO_FACTOR_REQUIRED', 'on');
    const fresh = user({ passwordHash: bcrypt.hashSync('Brand-New-Pass1', 4) });
    db.user.findUnique.mockResolvedValue(fresh);
    const res = await post(login, '/api/auth/login', { email: fresh.email, password: 'Brand-New-Pass1' });
    expect((await res.json()).twoFactor).toBe('verify');
  });
});
