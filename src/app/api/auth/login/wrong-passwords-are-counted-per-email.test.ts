import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A7 + A4 — THE SIGN-IN, AT THE DOOR.
 *
 * A7: wrong passwords are counted per EMAIL, whatever address they come from. What counts is
 * what went wrong; a right password never uses the ceiling up, and the pause ends by itself.
 * A4: an email that is not an account costs the same password check a real one does.
 *
 * The honest case is tested first and last: a person who types the right password still
 * reaches the second step, with the switch on and with it off.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, verifyPassword, issueChallenge } = vi.hoisted(() => ({
  db: { user: { findUnique: vi.fn() } },
  verifyPassword: vi.fn(async (plain: string, hash: string) => hash === `hash:${plain}`),
  issueChallenge: vi.fn(async () => 'ticket'),
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/auth', () => ({
  verifyPassword: (...a: [string, string]) => verifyPassword(...a),
  hashPassword: vi.fn(async (p: string) => `hash:${p}`),
  verifyDeviceToken: vi.fn(async () => null),
}));
vi.mock('@/lib/sign-in', () => ({ issueSession: vi.fn() }));
vi.mock('@/lib/two-factor-challenge', () => ({ issueChallenge: (...a: unknown[]) => issueChallenge(...a) }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));

import { POST } from './route';

let n = 0;
/** A request from a NEW address each time (a trusted proxy is on), so only the per-email ceiling can stop it. */
const attempt = (email: string, password: string, fromIp = `203.0.113.${++n % 250}`) =>
  POST(
    new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'x-forwarded-for': fromIp },
      body: JSON.stringify({ email, password }),
    })
  );

const account = (email: string) => ({
  id: `id-${email}`,
  email,
  role: 'MANAGER',
  status: 'ACTIVE',
  passwordHash: 'hash:Right-Password1',
  totpEnabledAt: new Date('2026-09-01T00:00:00Z'),
  company: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TRUST_PROXY = 'true';
  delete process.env.AUTH_LOGIN_EMAIL_LIMIT;
  db.user.findUnique.mockImplementation(async ({ where }: { where: { email: string } }) =>
    where.email.startsWith('ghost') ? null : account(where.email)
  );
});
afterEach(() => {
  delete process.env.TRUST_PROXY;
  delete process.env.AUTH_LOGIN_EMAIL_LIMIT;
  vi.useRealTimers();
});

describe('A7 — twenty wrong passwords per email, from any number of addresses', () => {
  it('PAUSES the email after 20 wrong ones — even the right password waits — with the wait in the message', async () => {
    const email = 'a7.pause@shop.example';
    for (let i = 0; i < 20; i += 1) expect((await attempt(email, `wrong${i}`)).status).toBe(401);
    const blocked = await attempt(email, 'Right-Password1');
    expect(blocked.status).toBe(429);
    const { error } = await blocked.json();
    expect(error).toMatch(/انتظر \d+ (دقائق|دقيقة|ثانية)/);
    expect(issueChallenge).not.toHaveBeenCalled();
  });

  it('is per EMAIL, not shared: another account is untouched, and case does not dodge the count', async () => {
    const email = 'a7.case@shop.example';
    for (let i = 0; i < 20; i += 1) await attempt(i % 2 ? email.toUpperCase() : email, `wrong${i}`);
    expect((await attempt(email.toUpperCase(), 'Right-Password1')).status).toBe(429);
    const other = await attempt('a7.other@shop.example', 'Right-Password1');
    expect(other.status).toBe(200);
    expect((await other.json()).twoFactor).toBe('verify');
  });

  it('the pause is NOT a lock for ever — a quarter of an hour later the right password gets in', async () => {
    vi.useFakeTimers();
    const email = 'a7.ends@shop.example';
    for (let i = 0; i < 20; i += 1) await attempt(email, `wrong${i}`);
    expect((await attempt(email, 'Right-Password1')).status).toBe(429);
    vi.advanceTimersByTime(15 * 60 * 1000 + 2000);
    expect((await attempt(email, 'Right-Password1')).status).toBe(200);
  });

  it('PASSES: a hundred RIGHT passwords never use the ceiling up', async () => {
    const email = 'a7.honest@shop.example';
    for (let i = 0; i < 100; i += 1) expect((await attempt(email, 'Right-Password1')).status, `try ${i}`).toBe(200);
  });

  it('PASSES: a few typos then the right password — the owner is not punished for a bad morning', async () => {
    const email = 'a7.typos@shop.example';
    for (let i = 0; i < 5; i += 1) await attempt(email, `typo${i}`);
    expect((await attempt(email, 'Right-Password1')).status).toBe(200);
  });

  it('counts wrong passwords against an email that does not exist too — and says the same thing about it', async () => {
    const email = 'ghost.a7@shop.example';
    for (let i = 0; i < 20; i += 1) expect((await attempt(email, `wrong${i}`)).status).toBe(401);
    const blocked = await attempt(email, 'anything');
    expect(blocked.status).toBe(429);
  });

  it('with the switch off the old behaviour returns: no per-email ceiling', async () => {
    process.env.AUTH_LOGIN_EMAIL_LIMIT = 'off';
    const email = 'a7.off@shop.example';
    for (let i = 0; i < 25; i += 1) await attempt(email, `wrong${i}`);
    expect((await attempt(email, 'Right-Password1')).status).toBe(200);
  });
});

describe('A4 — an unknown email pays for a password check like a real one', () => {
  it('compares the typed password against a hash nobody can match — once, same as a known email', async () => {
    verifyPassword.mockClear();
    const unknown = await attempt('ghost.timing@shop.example', 'Whatever1');
    expect(unknown.status).toBe(401);
    expect(verifyPassword).toHaveBeenCalledTimes(1);

    verifyPassword.mockClear();
    const known = await attempt('known.timing@shop.example', 'Whatever1');
    expect(known.status).toBe(401);
    expect(verifyPassword).toHaveBeenCalledTimes(1);

    expect(await unknown.json()).toEqual(await known.json());
  });

  it('can never let a stranger in: the dummy comparison is false for every password', async () => {
    const res = await attempt('ghost.never@shop.example', 'hash:anything');
    expect(res.status).toBe(401);
    expect(issueChallenge).not.toHaveBeenCalled();
  });
});

describe('the sign-in an honest person does every day is unchanged', () => {
  it('right password, second factor enrolled: the second step is asked for', async () => {
    const res = await attempt('daily@shop.example', 'Right-Password1');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ twoFactor: 'verify', challenge: 'ticket', email: 'daily@shop.example' });
  });

  it('right password, no second factor yet: the setup is offered, not refused', async () => {
    db.user.findUnique.mockResolvedValueOnce({ ...account('fresh@shop.example'), totpEnabledAt: null });
    const res = await attempt('fresh@shop.example', 'Right-Password1');
    expect(await res.json()).toMatchObject({ twoFactor: 'enrol' });
  });

  it('a suspended account is still told so, and a wrong password is still a plain 401', async () => {
    db.user.findUnique.mockResolvedValueOnce({ ...account('susp@shop.example'), status: 'SUSPENDED' });
    expect((await attempt('susp@shop.example', 'Right-Password1')).status).toBe(403);
    expect((await attempt('plain@shop.example', 'nope')).status).toBe(401);
  });
});
