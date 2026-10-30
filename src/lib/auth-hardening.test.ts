import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * PR-A — THE SIGN-IN HARDENING, THE PIECES THAT NEED NO REQUEST.
 *
 * Every part has two kinds of test: the one that REFUSES the thing it exists to
 * stop, and the one that proves an honest sign-in still passes. A hardening
 * that cannot show the second is a way to lock the owner out.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, checkSecondFactor, verifyPassword } = vi.hoisted(() => ({
  db: { user: { findUnique: vi.fn() } },
  checkSecondFactor: vi.fn(),
  verifyPassword: vi.fn(async (plain: string, hash: string) => hash === `hash:${plain}`),
}));
vi.mock('./db', () => ({ db }));
vi.mock('./auth', () => ({ verifyPassword, hashPassword: vi.fn(async (p: string) => `hash:${p}`) }));
vi.mock('./two-factor', async (orig) => ({
  ...(await orig<typeof import('./two-factor')>()),
  checkSecondFactor: (...a: unknown[]) => checkSecondFactor(...a),
}));

import {
  bootstrapGuardOn,
  enrolCodeRequired,
  loginEmailLimitOn,
  offUnlessOn,
  onUnlessOff,
  passkeyStepUpOn,
  passkeyWipeOn,
  publicMediaStrict,
  selfSignupOn,
} from './auth-switches';
import { mayBootstrapOwner } from './bootstrap-owner';
import { showForgotLink } from './forgot-link';
import { peekRateLimit, rateLimit } from './rate-limit';
import { TwoFactorRefused } from './two-factor';
import { checkStepUp, wipePasskeys } from './passkey-guard';
import { ENROL_CODE_TTL_MS, gateEnrolment, judgeEnrolCode, newEnrolCode, sealEnrolCode } from './enrol-code';
import { mayIssueEnrolCode } from './two-factor-reset';
import type { SessionUser } from '@/types/auth';

const SWITCHES = [
  'AUTH_PASSKEY_STEP_UP',
  'AUTH_PASSKEY_WIPE',
  'AUTH_BOOTSTRAP_GUARD',
  'AUTH_LOGIN_EMAIL_LIMIT',
  'AUTH_SELF_SIGNUP',
  'AUTH_ENROL_CODE_REQUIRED',
  'PUBLIC_MEDIA_STRICT',
];
beforeEach(() => {
  vi.clearAllMocks();
  for (const name of SWITCHES) delete process.env[name];
});
afterEach(() => {
  for (const name of SWITCHES) delete process.env[name];
});

describe('the switches', () => {
  it('start where the plan put them: the closers on, the ones that need the owner ready off', () => {
    expect([passkeyStepUpOn(), passkeyWipeOn(), bootstrapGuardOn(), loginEmailLimitOn()]).toEqual([true, true, true, true]);
    expect([selfSignupOn(), enrolCodeRequired(), publicMediaStrict()]).toEqual([false, false, false]);
  });

  it('an «on by default» part goes off only by an explicit word, and a typo leaves it on', () => {
    for (const word of ['off', 'OFF', '0', 'false', 'no', ' off ']) {
      process.env.AUTH_PASSKEY_STEP_UP = word;
      expect(passkeyStepUpOn(), word).toBe(false);
    }
    for (const word of ['', 'of', 'disabled', 'nope']) {
      process.env.AUTH_PASSKEY_STEP_UP = word;
      expect(passkeyStepUpOn(), word).toBe(true);
    }
  });

  it('an «off by default» part comes on only by an explicit word, and a typo leaves it off — nobody is locked out by a typo', () => {
    for (const word of ['on', 'ON', '1', 'true', 'yes']) {
      process.env.AUTH_ENROL_CODE_REQUIRED = word;
      expect(enrolCodeRequired(), word).toBe(true);
    }
    for (const word of ['', 'onn', 'enabled', 'y']) {
      process.env.AUTH_ENROL_CODE_REQUIRED = word;
      expect(enrolCodeRequired(), word).toBe(false);
    }
    expect(onUnlessOff('NOT_SET_ANYWHERE')).toBe(true);
    expect(offUnlessOn('NOT_SET_ANYWHERE')).toBe(false);
  });
});

describe('A3 — the owner bootstrap runs only while there is no owner', () => {
  const base = { configuredEmail: 'Owner@Shop.com', email: 'owner@shop.com' };

  it('creates the owner when the email matches and nobody is an owner yet (case and spaces do not matter)', () => {
    expect(mayBootstrapOwner({ ...base, superAdminCount: 0 })).toBe(true);
    expect(mayBootstrapOwner({ configuredEmail: ' owner@shop.com ', email: 'OWNER@SHOP.COM', superAdminCount: 0 })).toBe(true);
  });

  it('refuses once an owner exists — the same email registering later is an ordinary registration', () => {
    expect(mayBootstrapOwner({ ...base, superAdminCount: 1 })).toBe(false);
    expect(mayBootstrapOwner({ ...base, superAdminCount: 3 })).toBe(false);
  });

  it('refuses another email, and refuses everything when no email is configured', () => {
    expect(mayBootstrapOwner({ ...base, email: 'someone@else.com', superAdminCount: 0 })).toBe(false);
    expect(mayBootstrapOwner({ configuredEmail: undefined, email: 'owner@shop.com', superAdminCount: 0 })).toBe(false);
    expect(mayBootstrapOwner({ configuredEmail: '   ', email: '', superAdminCount: 0 })).toBe(false);
  });

  it('the guard can be taken off for a recovery the owner chooses to make', () => {
    process.env.AUTH_BOOTSTRAP_GUARD = 'off';
    expect(mayBootstrapOwner({ ...base, superAdminCount: 2 })).toBe(true);
    expect(mayBootstrapOwner({ ...base, email: 'x@y.com', superAdminCount: 2 })).toBe(false);
  });
});

describe('A5 — «نسيت كلمة المرور» is hidden in production only', () => {
  it('shown in development and in tests, where the token is printed for the developer', () => {
    expect(showForgotLink({ nodeEnv: 'development', show: undefined })).toBe(true);
    expect(showForgotLink({ nodeEnv: 'test', show: undefined })).toBe(true);
    expect(showForgotLink({ nodeEnv: undefined, show: undefined })).toBe(true);
  });

  it('hidden in production, unless the build says otherwise', () => {
    expect(showForgotLink({ nodeEnv: 'production', show: undefined })).toBe(false);
    expect(showForgotLink({ nodeEnv: 'production', show: '' })).toBe(false);
    expect(showForgotLink({ nodeEnv: 'production', show: 'yes' })).toBe(false);
    expect(showForgotLink({ nodeEnv: 'production', show: 'true' })).toBe(true);
    expect(showForgotLink({ nodeEnv: 'production', show: ' TRUE ' })).toBe(true);
  });
});

describe('A7 — peekRateLimit asks without counting', () => {
  it('an empty bucket and a bucket under the ceiling are open, and asking never fills it', () => {
    expect(peekRateLimit('peek:empty', 3).blocked).toBe(false);
    for (let i = 0; i < 50; i += 1) peekRateLimit('peek:asked', 3);
    rateLimit('peek:asked', 3, 60_000);
    expect(peekRateLimit('peek:asked', 3).blocked).toBe(false);
  });

  it('is blocked once the ceiling is reached, says how long, and the lock ends by itself', () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 3; i += 1) rateLimit('peek:full', 3, 60_000);
      const held = peekRateLimit('peek:full', 3);
      expect(held.blocked).toBe(true);
      expect(held.retryAfterSec).toBeGreaterThan(0);
      expect(held.retryAfterSec).toBeLessThanOrEqual(60);
      vi.advanceTimersByTime(61_000);
      expect(peekRateLimit('peek:full', 3)).toEqual({ blocked: false, retryAfterSec: 0 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('A1 — adding a fingerprint asks who you are', () => {
  beforeEach(() => {
    db.user.findUnique.mockResolvedValue({ passwordHash: 'hash:right-Password1' });
  });

  it('REFUSES a session with no password and no code — the stolen-session case', async () => {
    const r = await checkStepUp({ userId: 'u-none', status: 'ACTIVE' });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it('REFUSES a wrong password, and a code that is not six digits', async () => {
    expect(await checkStepUp({ userId: 'u-wrong', status: 'ACTIVE', password: 'nope' })).toMatchObject({ ok: false, status: 401 });
    expect(await checkStepUp({ userId: 'u-short', status: 'ACTIVE', code: '12345' })).toMatchObject({ ok: false, status: 400 });
    expect(checkSecondFactor).not.toHaveBeenCalled();
  });

  it('PASSES the right password — an honest owner adding a key is let through', async () => {
    expect(await checkStepUp({ userId: 'u-right', status: 'ACTIVE', password: 'right-Password1' })).toEqual({ ok: true });
  });

  it('PASSES a fresh six-digit code, written with spaces, and refuses a code the authenticator refuses', async () => {
    checkSecondFactor.mockResolvedValueOnce({ usedRecovery: false, recoveryLeft: 8 });
    expect(await checkStepUp({ userId: 'u-code', status: 'ACTIVE', code: '123 456' })).toEqual({ ok: true });
    expect(checkSecondFactor).toHaveBeenCalledWith(db, { userId: 'u-code', code: '123456' });

    checkSecondFactor.mockRejectedValueOnce(new TwoFactorRefused('BAD_CODE', 'x'));
    expect(await checkStepUp({ userId: 'u-code2', status: 'ACTIVE', code: '000000' })).toMatchObject({ ok: false, status: 401 });
  });

  it('REFUSES an account that is not active, even with the right password', async () => {
    for (const status of ['SUSPENDED', 'DISABLED', 'PENDING']) {
      expect(await checkStepUp({ userId: `u-${status}`, status, password: 'right-Password1' }), status).toMatchObject({ ok: false, status: 403 });
    }
  });

  it('REFUSES the ninth try in five minutes — a stolen session cannot walk the password', async () => {
    const results = [];
    for (let i = 0; i < 9; i += 1) results.push(await checkStepUp({ userId: 'u-walk', status: 'ACTIVE', password: `guess${i}` }));
    expect(results.slice(0, 8).every((r) => !r.ok && r.status === 401)).toBe(true);
    expect(results[8]).toMatchObject({ ok: false, status: 429 });
    // and the owner, pausing, is not locked for ever: the message says how long.
    expect((results[8] as { error: string }).error).toMatch(/ثانية/);
  });

  it('the switch off puts back the old behaviour: a session is enough', async () => {
    process.env.AUTH_PASSKEY_STEP_UP = 'off';
    expect(await checkStepUp({ userId: 'u-off', status: 'ACTIVE' })).toEqual({ ok: true });
    // but a suspended account still adds nothing
    expect(await checkStepUp({ userId: 'u-off', status: 'SUSPENDED' })).toMatchObject({ ok: false, status: 403 });
  });
});

describe('A1 — the fingerprints go when the way in is closed', () => {
  const tables = () => ({
    passkey: { deleteMany: vi.fn(async () => ({ count: 2 })) },
    passkeyChallenge: { deleteMany: vi.fn(async () => ({ count: 1 })) },
  });

  it('removes the keys AND their open challenges for that person only', async () => {
    const tx = tables();
    expect(await wipePasskeys(tx, 'u1')).toBe(2);
    expect(tx.passkey.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    expect(tx.passkeyChallenge.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
  });

  it('touches nothing with the switch off', async () => {
    process.env.AUTH_PASSKEY_WIPE = 'off';
    const tx = tables();
    expect(await wipePasskeys(tx, 'u1')).toBe(0);
    expect(tx.passkey.deleteMany).not.toHaveBeenCalled();
    expect(tx.passkeyChallenge.deleteMany).not.toHaveBeenCalled();
  });
});

describe('A2 — the owner-issued enrolment code', () => {
  it('has the shape a person can read over a phone, and two codes differ', () => {
    const a = newEnrolCode();
    expect(a).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    expect(newEnrolCode()).not.toBe(a);
  });

  it('is kept as a hash that is not the code, expiring in a day', async () => {
    const now = new Date('2026-10-30T10:00:00Z');
    const code = newEnrolCode();
    const sealed = await sealEnrolCode(code, now);
    expect(sealed.enrolCodeHash).not.toContain(code.replace('-', ''));
    expect(sealed.enrolCodeHash.startsWith('$2')).toBe(true);
    expect(sealed.enrolCodeExpiresAt.getTime() - now.getTime()).toBe(ENROL_CODE_TTL_MS);
    expect(ENROL_CODE_TTL_MS).toBe(24 * 3600 * 1000);
  });

  it('accepts the code typed in any case, with or without the dash — and refuses everything else', async () => {
    const now = new Date('2026-10-30T10:00:00Z');
    const code = newEnrolCode();
    const row = await sealEnrolCode(code, now);
    expect(await judgeEnrolCode(row, code, now)).toBe('ok');
    expect(await judgeEnrolCode(row, code.toLowerCase().replace('-', ' '), now)).toBe('ok');
    expect(await judgeEnrolCode(row, newEnrolCode(), now)).toBe('wrong');
    expect(await judgeEnrolCode(row, '', now)).toBe('missing');
    expect(await judgeEnrolCode(row, undefined, now)).toBe('missing');
    expect(await judgeEnrolCode(row, 12345, now)).toBe('missing');
    expect(await judgeEnrolCode({ enrolCodeHash: null, enrolCodeExpiresAt: null }, code, now)).toBe('none-issued');
    expect(await judgeEnrolCode(row, code, new Date(now.getTime() + ENROL_CODE_TTL_MS))).toBe('expired');
    expect(await judgeEnrolCode(row, code, new Date(now.getTime() + ENROL_CODE_TTL_MS - 1000))).toBe('ok');
  });

  it('the gate lets everybody through while the switch is off — nobody is stranded by shipping this', async () => {
    const none = { enrolCodeHash: null, enrolCodeExpiresAt: null };
    expect(await gateEnrolment('g-off', none, undefined)).toEqual({ ok: true });
    expect(await gateEnrolment('g-off', none, 'garbage')).toEqual({ ok: true });
  });

  it('with the switch on, the gate refuses no code, no issued code, a wrong one — and lets the right one through', async () => {
    process.env.AUTH_ENROL_CODE_REQUIRED = 'on';
    const code = newEnrolCode();
    const row = await sealEnrolCode(code);
    expect(await gateEnrolment('g-1', row, undefined)).toMatchObject({ ok: false, status: 400, code: 'ENROL_CODE_REQUIRED' });
    expect(await gateEnrolment('g-1', { enrolCodeHash: null, enrolCodeExpiresAt: null }, code)).toMatchObject({ ok: false, status: 400, code: 'ENROL_CODE_REFUSED' });
    expect(await gateEnrolment('g-1', row, newEnrolCode())).toMatchObject({ ok: false, status: 403, code: 'ENROL_CODE_REFUSED' });
    expect(await gateEnrolment('g-1', row, code)).toEqual({ ok: true });
  });

  it('ten wrong guesses pause the account for a while — even the right code waits — and the pause is not a lock for ever', async () => {
    process.env.AUTH_ENROL_CODE_REQUIRED = 'on';
    vi.useFakeTimers();
    try {
      const code = newEnrolCode();
      const row = await sealEnrolCode(code);
      for (let i = 0; i < 10; i += 1) await gateEnrolment('g-walk', row, newEnrolCode());
      expect(await gateEnrolment('g-walk', row, code)).toMatchObject({ ok: false, status: 429, code: 'ENROL_CODE_PAUSED' });
      // another account is untouched
      expect(await gateEnrolment('g-other', row, code)).toEqual({ ok: true });
      vi.advanceTimersByTime(16 * 60 * 1000);
      expect(await gateEnrolment('g-walk', row, code)).toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a missing code does not count against the account — only a wrong one does', async () => {
    process.env.AUTH_ENROL_CODE_REQUIRED = 'on';
    const code = newEnrolCode();
    const row = await sealEnrolCode(code);
    for (let i = 0; i < 30; i += 1) await gateEnrolment('g-missing', row, undefined);
    expect(await gateEnrolment('g-missing', row, code)).toEqual({ ok: true });
  });
});

describe('A2 — who may issue the code', () => {
  const who = (role: string, id = 'me', permissions: string[] = []): SessionUser => ({ id, role, status: 'ACTIVE', permissions }) as unknown as SessionUser;

  it('the owner centrally, and whoever holds users.security; never anybody else', () => {
    expect(mayIssueEnrolCode(who('SUPER_ADMIN'), 'other')).toEqual({ ok: true });
    expect(mayIssueEnrolCode(who('COMPANY_ADMIN', 'me', ['users.security']), 'other')).toEqual({ ok: true });
    for (const role of ['MANAGER', 'ACCOUNTANT', 'MODERATOR', 'COMPANY_ADMIN']) {
      expect(mayIssueEnrolCode(who(role, 'me', ['users.view', 'users.edit']), 'other'), role).toMatchObject({ ok: false, status: 403, code: 'NO_SECURITY_KEY' });
    }
  });

  it('never for yourself, owner or not', () => {
    expect(mayIssueEnrolCode(who('SUPER_ADMIN', 'me'), 'me')).toMatchObject({ ok: false, status: 403, code: 'NOT_YOURSELF' });
  });
});

describe('A2 — the migration adds two columns and nothing else', () => {
  const dir = path.join(process.cwd(), 'prisma/migrations/20261031000000_enrol_code');
  const sql = readFileSync(path.join(dir, 'migration.sql'), 'utf8');
  const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

  it('is ADD COLUMN IF NOT EXISTS on users, nullable, no default — no DROP, DELETE, UPDATE, TRUNCATE, no index', () => {
    const statements = code.split(';').map((s) => s.trim()).filter(Boolean);
    expect(statements).toEqual([
      'ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "enrol_code_hash" TEXT',
      'ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "enrol_code_expires_at" TIMESTAMP(3)',
    ]);
    expect(code).not.toMatch(/\b(DROP|DELETE|UPDATE|TRUNCATE|INSERT|CREATE|NOT NULL|DEFAULT)\b/i);
  });

  it('matches the schema, name for name', () => {
    const schema = readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    expect(schema).toMatch(/enrolCodeHash\s+String\?\s+@map\("enrol_code_hash"\)/);
    expect(schema).toMatch(/enrolCodeExpiresAt\s+DateTime\?\s+@map\("enrol_code_expires_at"\)/);
  });

  it('has a rollback that undoes exactly that, and says when it is safe to run', () => {
    const rollback = readFileSync(path.join(dir, 'rollback.sql'), 'utf8');
    expect(rollback).toMatch(/DROP COLUMN IF EXISTS "enrol_code_hash"/);
    expect(rollback).toMatch(/DROP COLUMN IF EXISTS "enrol_code_expires_at"/);
    expect(rollback).toMatch(/_prisma_migrations/);
    expect(rollback).toMatch(/Run ONLY after the code/);
  });
});
