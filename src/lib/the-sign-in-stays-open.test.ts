import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, decodeJwt } from 'jose';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { stepFor, requiresTwoFactor } from './two-factor';
import { LONG_SESSION_DAYS, REMEMBERED_SESSION_DAYS, SHORT_SESSION_DAYS, longestSessionDays, sessionDays } from './session-length';
import { createDeviceToken, createSessionToken, sessionCookieOptions, verifySessionToken } from './auth';
import { claimsFor, deviceCookieOptions, trustDays } from './trusted-device';
import { idleSignOutOn, shortSessionsOn, twoFactorRequired } from './auth-switches';
import { bootAlarms } from './boot-alarms';
import { stripComments } from './guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «بدي الغي ال 2fa و قصة انو يطلع كل ١٥ دقيقة و كمان يحتفظ بتسجيل الدخول ع طول» — THE LIBRARY SIDE.
 *
 * The owner's ruling 11/11, as three switches that all start OFF and mean «the old protection comes back» when `on`:
 *   AUTH_TWO_FACTOR_REQUIRED · AUTH_IDLE_SIGN_OUT · AUTH_SHORT_SESSIONS
 *
 * Nothing was deleted to grant it, so every test of the old rule still runs — under `vi.stubEnv`. This file holds the new
 * rule and the places where the two meet: the second step, the length of a sign-in (one number, four readers), the cookies
 * already in browsers, and which doors can hold a person at a step.
 * ═══════════════════════════════════════════════════════════════════════
 */

const ROOT = process.cwd();
const DAY = 24 * 60 * 60;
const ENROLLED = new Date('2026-09-01T00:00:00Z');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the second code — stepFor', () => {
  const ROLES = [
    'SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'ACCOUNTANT', 'SETTLEMENT_OFFICER', 'MODERATOR', 'CONFIRMATION_AGENT',
    'FOLLOW_UP_AGENT', 'WAREHOUSE', 'DELIVERY_MANAGER', 'CONFIRMATION_SUPERVISOR', 'PENDING_USER', 'دور من صنع الشركة',
  ];

  it('OFF (nothing set): every role gets none — enrolled or not', () => {
    for (const role of ROLES) {
      expect(stepFor({ role, totpEnabledAt: null }), `${role} · not enrolled`).toBe('none');
      expect(stepFor({ role, totpEnabledAt: ENROLLED }), `${role} · enrolled`).toBe('none');
    }
  });

  it('ON: the rule of before 11/11 — enrolled → verify, not enrolled → enrol, for every role', () => {
    vi.stubEnv('AUTH_TWO_FACTOR_REQUIRED', 'on');
    for (const role of ROLES) {
      expect(stepFor({ role, totpEnabledAt: null }), `${role} · not enrolled`).toBe('enrol');
      expect(stepFor({ role, totpEnabledAt: ENROLLED }), `${role} · enrolled`).toBe('verify');
    }
  });

  it('a value nobody can read is OFF — a typo shuts nobody out; every word that means «on» turns it on', () => {
    for (const word of ['', 'onn', 'enabled', 'y', 'off', '0', 'false', 'no', 'garbage']) {
      vi.stubEnv('AUTH_TWO_FACTOR_REQUIRED', word);
      expect(stepFor({ role: 'MANAGER', totpEnabledAt: ENROLLED }), `«${word}»`).toBe('none');
    }
    for (const word of ['on', 'ON', '1', 'true', 'yes', ' on ']) {
      vi.stubEnv('AUTH_TWO_FACTOR_REQUIRED', word);
      expect(stepFor({ role: 'MANAGER', totpEnabledAt: ENROLLED }), `«${word}»`).toBe('verify');
    }
  });

  it('the policy by role is untouched under the switch — `requiresTwoFactor` still says every role', () => {
    for (const role of ROLES) expect(requiresTwoFactor(role), role).toBe(true);
  });

  it('and `stepFor` reads the switch ITSELF, in its own body — the one place that decides', () => {
    const src = stripComments(readFileSync(join(ROOT, 'src/lib/two-factor.ts'), 'utf8'));
    const body = src.slice(src.indexOf('export function stepFor'));
    expect(body.slice(0, body.indexOf('\n}\n'))).toMatch(/if \(!twoFactorRequired\(\)\) return 'none';/);
  });
});

describe('which doors can hold a person at a step — read from the source, so a NEW door cannot slip in unseen', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? files(p) : [p];
    });
  const prod = files(join(ROOT, 'src'))
    .map((p) => relative(ROOT, p).split(sep).join('/'))
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f));
  const text = (f: string) => stripComments(readFileSync(join(ROOT, f), 'utf8'));
  const callers = (re: RegExp) => prod.filter((f) => re.test(text(f))).sort();

  it('only the login door asks stepFor — so with the switch off no other door sends anybody to a second step', () => {
    expect(callers(/\bstepFor\(/).filter((f) => !f.startsWith('src/components/') && f !== 'src/lib/two-factor.ts')).toEqual([
      'src/app/api/auth/login/route.ts',
    ]);
  });

  it('and only the login door issues the ticket the second-step doors take', () => {
    expect(callers(/\bissueChallenge\(/).filter((f) => f !== 'src/lib/two-factor-challenge.ts')).toEqual([
      'src/app/api/auth/login/route.ts',
    ]);
  });

  it('the doors that take a ticket are exactly the four, and each refuses a request with none (a clean 401)', () => {
    const doors = callers(/\breadChallenge\(/).filter((f) => f !== 'src/lib/two-factor-challenge.ts');
    expect(doors).toEqual([
      'src/app/api/auth/2fa/enrol/route.ts',
      'src/app/api/auth/2fa/start/route.ts',
      'src/app/api/auth/2fa/verify/route.ts',
      'src/app/api/auth/passkey/assert/route.ts',
    ]);
    for (const door of doors) expect(text(door), door).toMatch(/if \(!ticket\) \{[\s\S]{0,160}status: 401/);
  });

  it('no other door asks for a code: register, reset-password, passkey login, profile, call-helper pairing', () => {
    for (const door of [
      'src/app/api/auth/register/route.ts',
      'src/app/api/auth/reset-password/route.ts',
      'src/app/api/auth/passkey/login/route.ts',
      'src/app/api/auth/passkey/register/route.ts',
      'src/app/api/profile/route.ts',
      'src/app/api/call-helper/pair-code/route.ts',
      'src/app/api/users/[id]/two-factor/route.ts',
      'src/app/api/users/[id]/enrol-code/route.ts',
    ]) {
      const src = text(door);
      expect(src, `${door}: بيسأل stepFor`).not.toMatch(/\bstepFor\(/);
      expect(src, `${door}: بيصدر تذكرة`).not.toMatch(/\bissueChallenge\(/);
      expect(src, `${door}: بيتحقق من رمز`).not.toMatch(/\bcheckSecondFactor\(/);
    }
  });

  it('and the secret, the recovery codes, the trusted-device token and the fingerprints are all still in the code', () => {
    const tf = readFileSync(join(ROOT, 'src/lib/two-factor.ts'), 'utf8');
    for (const name of ['completeEnrolment', 'checkSecondFactor', 'beginEnrolment', 'RECOVERY_COUNT', 'encryptSecret']) {
      expect(tf, name).toContain(name);
    }
    const td = readFileSync(join(ROOT, 'src/lib/trusted-device.ts'), 'utf8');
    for (const name of ['judgeTrust', 'claimsFor', 'DEVICE_COOKIE', 'noteBadPassword']) expect(td, name).toContain(name);
    for (const rel of ['src/app/api/auth/passkey/login/route.ts', 'src/app/api/auth/passkey/assert/route.ts', 'src/app/api/auth/passkey/register/route.ts']) {
      expect(readFileSync(join(ROOT, rel), 'utf8').length, rel).toBeGreaterThan(500);
    }
  });
});

describe('how long a sign-in lasts — one number, in one place', () => {
  it('the numbers themselves: a year by default; 7 days, or 30 with «تذكرني», under AUTH_SHORT_SESSIONS=on', () => {
    expect([LONG_SESSION_DAYS, SHORT_SESSION_DAYS, REMEMBERED_SESSION_DAYS]).toEqual([365, 7, 30]);
    expect([sessionDays(true), sessionDays(false), longestSessionDays()]).toEqual([365, 365, 365]);
    vi.stubEnv('AUTH_SHORT_SESSIONS', 'on');
    expect([sessionDays(true), sessionDays(false), longestSessionDays()]).toEqual([30, 7, 30]);
  });

  it('the cookie and the token read it, and cannot disagree — for both ticks of the box, in both states', async () => {
    for (const short of [false, true]) {
      if (short) vi.stubEnv('AUTH_SHORT_SESSIONS', 'on');
      for (const remember of [true, false]) {
        const days = sessionDays(remember);
        expect(sessionCookieOptions(remember).maxAge, `short=${short} remember=${remember}: cookie`).toBe(days * DAY);
        const claims = decodeJwt(
          await createSessionToken({ userId: 'u', email: 'a@b.c', role: 'MANAGER' as never, status: 'ACTIVE' as never, companyId: 'c', tv: 1, remember })
        );
        expect((claims.exp as number) - (claims.iat as number), `short=${short} remember=${remember}: token`).toBe(days * DAY);
      }
    }
  });

  it('the cookie’s other settings are exactly what they were — http-only, lax, whole site', () => {
    const o = sessionCookieOptions(false);
    expect([o.httpOnly, o.sameSite, o.path]).toEqual([true, 'lax', '/']);
  });

  it('the trusted device follows the LONGEST sign-in: a year by default, 30 days under the old rule', async () => {
    expect(trustDays()).toBe(365);
    expect(deviceCookieOptions().maxAge).toBe(365 * DAY);
    const long = decodeJwt(await createDeviceToken(claimsFor({ id: 'u', totpEnabledAt: ENROLLED })));
    expect((long.exp as number) - (long.iat as number)).toBe(365 * DAY);
    vi.stubEnv('AUTH_SHORT_SESSIONS', 'on');
    expect(trustDays()).toBe(30);
    expect(deviceCookieOptions().maxAge).toBe(30 * DAY);
    const short = decodeJwt(await createDeviceToken(claimsFor({ id: 'u', totpEnabledAt: ENROLLED })));
    expect((short.exp as number) - (short.iat as number)).toBe(30 * DAY);
  });

  it('nothing else writes a session length: auth.ts, sign-in.ts and trusted-device.ts all read session-length.ts', () => {
    const read = (rel: string) => stripComments(readFileSync(join(ROOT, rel), 'utf8'));
    expect(read('src/lib/auth.ts')).toContain('sessionDays(');
    expect(read('src/lib/sign-in.ts')).toContain('longestSessionDays()');
    expect(read('src/lib/trusted-device.ts')).toContain('longestSessionDays()');
    // no second copy of «30» / «7» as days left behind
    expect(read('src/lib/auth.ts')).not.toMatch(/\bremember \? ['"]?30|\(remember \? 30 : 7\)|'30d'|'7d'/);
    expect(read('src/lib/sign-in.ts')).not.toMatch(/\b30 \* 24 \* 60 \* 60 \* 1000\b/);
  });
});

describe('cookies already in browsers keep working — nobody is signed out by the deploy', () => {
  const secret = new TextEncoder().encode(
    process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32 ? process.env.JWT_SECRET : 'development_only_insecure_jwt_secret_key_0000'
  );
  const issued = (life: string, issuedAgoSeconds = 0) =>
    new SignJWT({ userId: 'u1', email: 'a@b.c', role: 'MANAGER', status: 'ACTIVE', companyId: 'c', tv: 1, remember: life === '30d' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - issuedAgoSeconds)
      .setExpirationTime(Math.floor(Date.now() / 1000) - issuedAgoSeconds + Number(life.replace('d', '')) * DAY)
      .sign(secret);

  it('a 7-day and a 30-day token from before are accepted, under the long rule and under the short one', async () => {
    for (const short of [false, true]) {
      if (short) vi.stubEnv('AUTH_SHORT_SESSIONS', 'on');
      for (const life of ['7d', '30d']) {
        const token = await issued(life, 3 * DAY);
        expect((await verifySessionToken(token))?.userId, `${life} short=${short}`).toBe('u1');
      }
    }
  });

  it('and they keep their OWN life: a 7-day token six days old is good, an eight-day-old one is not — the new rule does not resurrect it', async () => {
    expect(await verifySessionToken(await issued('7d', 6 * DAY))).not.toBeNull();
    expect(await verifySessionToken(await issued('7d', 8 * DAY)), 'كوكي منتهي رجع شغّال').toBeNull();
    expect(await verifySessionToken(await issued('30d', 31 * DAY))).toBeNull();
  });

  it('the account-wide levers are untouched: a token carries `tv`, and `tokenVersion` is still read on every request', () => {
    const auth = stripComments(readFileSync(join(ROOT, 'src/lib/auth.ts'), 'utf8'));
    expect(auth).toContain('user.tokenVersion !== decoded.tv');
    expect(auth).toContain('session.revokedAt');
    expect(stripComments(readFileSync(join(ROOT, 'src/lib/sign-in.ts'), 'utf8'))).toContain('export const DEVICES_PER_ACCOUNT = 2;');
  });
});

describe('the audit still says how a sign-in was proved', () => {
  it('USER_LOGGED_IN keeps writing `factor`, and «password» is still one of its words', () => {
    const src = readFileSync(join(ROOT, 'src/lib/sign-in.ts'), 'utf8');
    expect(src).toMatch(/newData: \{ email: user\.email, role: user\.role, status: user\.status, ip, factor: input\.factor, replaced \}/);
    expect(src).toContain("| 'password'");
  });
});

describe('the three switches — what each one is, read from the one place that names them', () => {
  it('start OFF, and say so in the file’s own header (with the exact variable names)', () => {
    expect([twoFactorRequired(), idleSignOutOn(), shortSessionsOn()]).toEqual([false, false, false]);
    const head = readFileSync(join(ROOT, 'src/lib/auth-switches.ts'), 'utf8').slice(0, 4000);
    for (const name of ['AUTH_TWO_FACTOR_REQUIRED', 'AUTH_IDLE_SIGN_OUT', 'AUTH_SHORT_SESSIONS']) expect(head, name).toContain(name);
  });

  it('can be handed an environment instead of reading the real one — the boot check does', () => {
    expect(twoFactorRequired({ AUTH_TWO_FACTOR_REQUIRED: 'on' })).toBe(true);
    expect(twoFactorRequired({})).toBe(false);
    expect(idleSignOutOn({ AUTH_IDLE_SIGN_OUT: 'yes' })).toBe(true);
    expect(shortSessionsOn({ AUTH_SHORT_SESSIONS: '1' })).toBe(true);
    // and the real one is not touched by that
    expect(twoFactorRequired()).toBe(false);
  });

  it('the boot alarm follows the same switch: no «nobody can sign in» while nobody is asked for a code', () => {
    expect(bootAlarms({})[0]).not.toContain('مفروض');
    expect(bootAlarms({ AUTH_TWO_FACTOR_REQUIRED: 'on' })[0]).toContain('مفروض');
  });
});

describe('docs — the three switches are written down where the others are', () => {
  it('docs/ops/AUTH-HARDENING-LOCAL-TRIAL.md names them, with their default and the way back', () => {
    const doc = readFileSync(join(ROOT, 'docs/ops/AUTH-HARDENING-LOCAL-TRIAL.md'), 'utf8');
    for (const name of ['AUTH_TWO_FACTOR_REQUIRED', 'AUTH_IDLE_SIGN_OUT', 'AUTH_SHORT_SESSIONS']) expect(doc, name).toContain(name);
  });
});
