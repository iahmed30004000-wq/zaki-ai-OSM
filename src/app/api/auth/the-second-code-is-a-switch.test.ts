import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { decodeJwt } from 'jose';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «بدي الغي ال 2fa ... و كمان يحتفظ بتسجيل الدخول ع طول» — THE SIGN-IN DOORS, AT THE DOOR.
 *
 * The owner's ruling 11/11. With `AUTH_TWO_FACTOR_REQUIRED` unset (the default) the password alone opens an account —
 * enrolled or not — and the session it makes lasts a year. With it `on`, every door is the door it was before: the login
 * answers with a second step and a ticket, and the ticket opens the three doors that take it.
 *
 * The routes are the REAL ones, called with real requests. Only the database, the audit trail, the attendance mark and the
 * authenticator maths are stood in for; the ticket (`issueChallenge`) and the session (`issueSession`, `createSessionToken`,
 * the cookie) are the real code, so a cookie's life is read off the actual `Set-Cookie` header and the actual token.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, checkSecondFactor, beginEnrolment, completeEnrolment, logAudit } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a loose stand-in for the database; every call below is checked by its result
  const db: Record<string, any> = {
    user: { findUnique: vi.fn(), update: vi.fn(async () => ({ tokenVersion: 3 })) },
    userSession: {
      create: vi.fn(async () => ({ id: 'session-1' })),
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    passkey: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return {
    db,
    checkSecondFactor: vi.fn<(...a: unknown[]) => Promise<{ usedRecovery: boolean; recoveryLeft: number }>>(async () => ({ usedRecovery: false, recoveryLeft: 8 })),
    beginEnrolment: vi.fn<(...a: unknown[]) => { secret: string; uri: string }>(() => ({ secret: 'SECRET', uri: 'otpauth://totp/x' })),
    completeEnrolment: vi.fn<(...a: unknown[]) => Promise<{ recoveryCodes: string[] }>>(async () => ({ recoveryCodes: ['AAAAA-BBBBB'] })),
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
vi.mock('qrcode', () => ({ default: { toDataURL: async () => 'data:image/png;base64,AAAA' } }));
vi.mock('@/lib/two-factor', async (orig) => ({
  ...(await orig<typeof import('@/lib/two-factor')>()),
  checkSecondFactor: (...a: unknown[]) => checkSecondFactor(...a),
  beginEnrolment: (...a: unknown[]) => beginEnrolment(...a),
  completeEnrolment: (...a: unknown[]) => completeEnrolment(...a),
}));

import { POST as login } from './login/route';
import { POST as start } from './2fa/start/route';
import { POST as enrol } from './2fa/enrol/route';
import { POST as verify } from './2fa/verify/route';
import { POST as assert } from './passkey/assert/route';
import { issueChallenge } from '@/lib/two-factor-challenge';

type Audit = { action: string; newData: { factor?: string } };
const YEAR = 365 * 24 * 60 * 60;
const PASSWORD = 'Right-Password1';
const HASH = bcrypt.hashSync(PASSWORD, 4);

let n = 0;
/** A request from a NEW address each time, so no per-address bucket is what answers. */
const post = (handler: (req: Request) => Promise<Response>, url: string, body: unknown) =>
  handler(
    new Request(`http://localhost${url}`, {
      method: 'POST',
      headers: { 'x-forwarded-for': `203.0.113.${++n % 250}` },
      body: JSON.stringify(body),
    })
  );

const account = (over: Record<string, unknown> = {}) => ({
  id: `u-${++n}`,
  email: `person${n}@shop.example`,
  name: 'شخص',
  role: 'MANAGER',
  status: 'ACTIVE',
  companyId: 'c1',
  commissionRate: null,
  passwordHash: HASH,
  totpEnabledAt: new Date('2026-09-01T00:00:00Z'),
  company: { name: 'زكي' },
  ...over,
});

const signIn = (user: ReturnType<typeof account>, remember?: boolean) => {
  db.user.findUnique.mockResolvedValue(user);
  return post(login, '/api/auth/login', { email: user.email, password: PASSWORD, remember });
};

/** The session cookie as the browser would receive it: its `Max-Age`, and the token's own life (exp − iat). */
function sessionCookie(res: Response): { maxAge: number; tokenSeconds: number } | null {
  const header = res.headers.get('set-cookie') ?? '';
  const mine = header.split(/,(?=\s*[A-Za-z_]+=)/).find((c) => c.trim().startsWith('salesflow_session='));
  if (!mine) return null;
  const maxAge = Number(/Max-Age=(\d+)/i.exec(mine)?.[1]);
  const token = /salesflow_session=([^;]+)/.exec(mine)![1];
  const claims = decodeJwt(token);
  return { maxAge, tokenSeconds: (claims.exp as number) - (claims.iat as number) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('JWT_SECRET', 'k'.repeat(40));
  vi.stubEnv('TRUST_PROXY', 'true');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the second code OFF — the default: the password alone opens the account', () => {
  it('an ENROLLED manager gets a session at once — no second step, no ticket', async () => {
    const res = await signIn(account());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body, 'ظهرت خطوة رمز').not.toHaveProperty('twoFactor');
    expect(body, 'انصرف تذكرة').not.toHaveProperty('challenge');
    expect(sessionCookie(res), 'ما انكتب كوكي جلسة').not.toBeNull();
    // and the audit says how it was proved: the password alone
    expect(logAudit.mock.calls.some(([a]) => (a as Audit).action === 'USER_LOGGED_IN' && (a as Audit).newData.factor === 'password')).toBe(true);
  });

  it('and so does an account that NEVER enrolled — it is not sent to «سجّل الرمز»', async () => {
    const res = await signIn(account({ totpEnabledAt: null }));
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty('twoFactor');
    expect(sessionCookie(res)).not.toBeNull();
  });

  it('whatever the role — the owner, an accountant, a moderator, a role the company made up', async () => {
    for (const role of ['SUPER_ADMIN', 'COMPANY_ADMIN', 'ACCOUNTANT', 'MODERATOR', 'WAREHOUSE', 'موظّف تأكيد — من صنع الشركة']) {
      for (const totpEnabledAt of [null, new Date('2026-09-01T00:00:00Z')]) {
        const res = await signIn(account({ role, totpEnabledAt }));
        const body = await res.json();
        expect(res.status, `${role} ${totpEnabledAt ? 'enrolled' : 'not enrolled'}`).toBe(200);
        expect(body, `${role}: خطوة ثانية`).not.toHaveProperty('twoFactor');
        expect(sessionCookie(res), `${role}: بلا جلسة`).not.toBeNull();
      }
    }
  });

  it('the session lasts 365 days — the cookie AND the token — with «تذكرني» ticked or not', async () => {
    for (const remember of [true, false, undefined]) {
      const cookie = sessionCookie(await signIn(account(), remember));
      expect(cookie, `remember=${remember}`).not.toBeNull();
      expect(cookie!.maxAge, `remember=${remember}: Max-Age`).toBe(YEAR);
      expect(cookie!.tokenSeconds, `remember=${remember}: عمر الرمز`).toBe(YEAR);
    }
  });

  it('a wrong password is still a plain 401 and a suspended account is still told so — nothing else loosened', async () => {
    db.user.findUnique.mockResolvedValue(account());
    const wrong = await post(login, '/api/auth/login', { email: 'x@y.z', password: 'nope' });
    expect(wrong.status).toBe(401);
    expect(sessionCookie(wrong)).toBeNull();
    const suspended = await signIn(account({ status: 'SUSPENDED' }));
    expect(suspended.status).toBe(403);
    expect(sessionCookie(suspended)).toBeNull();
  });

  it('the second-step doors answer a clean 401 to a request with no ticket — they throw nothing and hold nobody', async () => {
    for (const [name, door] of [['2fa/start', start], ['2fa/enrol', enrol], ['2fa/verify', verify], ['passkey/assert', assert]] as const) {
      const res = await post(door, `/api/auth/${name}`, {});
      expect(res.status, name).toBe(401);
      const body = await res.json();
      expect(typeof body.error, name).toBe('string');
      expect(body.error, `${name}: رسالة بالعربي`).toMatch(/[؀-ۿ]/);
    }
  });

  it('and a ticket issued BEFORE the switch was turned off is still honoured to the end — nobody is stranded half-way', async () => {
    const user = account();
    db.user.findUnique.mockResolvedValue(user);
    const ticket = await issueChallenge({ userId: user.id, purpose: 'verify', remember: false });
    const res = await post(verify, '/api/auth/2fa/verify', { challenge: ticket, code: '123456' });
    expect(res.status).toBe(200);
    expect(sessionCookie(res)!.maxAge).toBe(YEAR);
  });
});

describe('the second code ON — every door is the door it was before 11/11', () => {
  beforeEach(() => {
    vi.stubEnv('AUTH_TWO_FACTOR_REQUIRED', 'on');
  });

  it('an enrolled account is asked for the six digits — a ticket, and NO session', async () => {
    const res = await signIn(account());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.twoFactor).toBe('verify');
    expect(typeof body.challenge).toBe('string');
    expect(sessionCookie(res), 'انكتب كوكي جلسة قبل الرمز').toBeNull();
  });

  it('one that never enrolled is sent to set it up — and gets no session either', async () => {
    const res = await signIn(account({ totpEnabledAt: null, role: 'MODERATOR' }));
    const body = await res.json();
    expect(body.twoFactor).toBe('enrol');
    expect(sessionCookie(res)).toBeNull();
  });

  it('the verify ticket opens /2fa/verify, which then issues the session', async () => {
    const user = account();
    const first = await signIn(user);
    const { challenge } = await first.json();
    const res = await post(verify, '/api/auth/2fa/verify', { challenge, code: '123456' });
    expect(res.status).toBe(200);
    expect(checkSecondFactor).toHaveBeenCalledTimes(1);
    expect(sessionCookie(res), 'الرمز صح وما انفتحت جلسة').not.toBeNull();
  });

  it('the enrol ticket opens /2fa/start (a secret and a QR) and /2fa/enrol (the recovery codes)', async () => {
    const user = account({ totpEnabledAt: null });
    const first = await signIn(user);
    const { challenge } = await first.json();
    db.user.findUnique.mockResolvedValue({ ...user, enrolCodeHash: null, enrolCodeExpiresAt: null });
    const started = await post(start, '/api/auth/2fa/start', { challenge });
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({ secret: 'SECRET', qr: expect.stringContaining('data:image') });
    const done = await post(enrol, '/api/auth/2fa/enrol', { challenge, secret: 'SECRET', code: '123456' });
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ success: true, recoveryCodes: ['AAAAA-BBBBB'] });
  });

  it('a verify ticket is not an enrol ticket, and the other way round — the doors still tell them apart', async () => {
    const user = account();
    const verifyTicket = await issueChallenge({ userId: user.id, purpose: 'verify', remember: false });
    const enrolTicket = await issueChallenge({ userId: user.id, purpose: 'enrol', remember: false });
    expect((await post(start, '/api/auth/2fa/start', { challenge: verifyTicket })).status).toBe(401);
    expect((await post(verify, '/api/auth/2fa/verify', { challenge: enrolTicket, code: '123456' })).status).toBe(401);
  });

  it('the session after the code is a year too — the second code and the long sign-in are two switches', async () => {
    const user = account();
    const first = await signIn(user, false);
    const { challenge } = await first.json();
    const res = await post(verify, '/api/auth/2fa/verify', { challenge, code: '123456' });
    expect(sessionCookie(res)).toEqual({ maxAge: YEAR, tokenSeconds: YEAR });
  });
});

describe('the short sessions ON — 7 days, 30 with «تذكرني», exactly as before', () => {
  beforeEach(() => {
    vi.stubEnv('AUTH_SHORT_SESSIONS', 'on');
  });

  it('a plain sign-in lasts 7 days, a remembered one 30 — cookie and token alike', async () => {
    expect(sessionCookie(await signIn(account(), false))).toEqual({ maxAge: 7 * 86400, tokenSeconds: 7 * 86400 });
    expect(sessionCookie(await signIn(account(), true))).toEqual({ maxAge: 30 * 86400, tokenSeconds: 30 * 86400 });
    expect(sessionCookie(await signIn(account()))).toEqual({ maxAge: 7 * 86400, tokenSeconds: 7 * 86400 });
  });

  it('a value nobody can read leaves the long rule — a typo shuts nobody out and signs nobody out', async () => {
    vi.stubEnv('AUTH_SHORT_SESSIONS', 'onn');
    expect(sessionCookie(await signIn(account(), false))).toEqual({ maxAge: YEAR, tokenSeconds: YEAR });
  });
});
