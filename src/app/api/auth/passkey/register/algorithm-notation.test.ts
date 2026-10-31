import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AN AUTHENTICATION DOOR THAT READ A NUMBER WITH `Number()` — AND WHAT THAT
 * ACTUALLY COST, WHICH IS LESS THAN THE AUDIT SAID.
 *
 * `POST /api/auth/passkey/register` read `Number(body?.algorithm)` under
 * `Number.isFinite`. Measured: `'0x10'` → 16, `null` → 0, `[]` → 0,
 * `''` → 0, `['-7']` → -7, `true` → 1.
 *
 * IT COULD NOT WEAKEN THE AUTHENTICATION, and the real passkey module is
 * imported UNMOCKED below so that claim is checked rather than recited:
 *
 *   `ALLOWED_ALGORITHMS` is the closed pair `[-7, -257]`, and
 *   `verifyRegistration` refuses anything else as UNSUPPORTED_ALGORITHM —
 *   BEFORE `db.passkey.create`. Both accepted values are negative, and
 *   `Number()` of a base-prefixed string is never negative, so no notation
 *   trick reaches an accepted value. `verifyAssertion` then checks the same
 *   allowlist again at sign-in, and the proof is anchored on the stored
 *   PUBLIC KEY — a wrong algorithm number cannot make a signature verify
 *   that the matching private key did not make.
 *
 * WHAT WAS REAL IS SMALLER AND IS WHAT THIS GUARD PINS: `null` and `[]`
 * became `0`, which IS finite, so they slipped past the «بيانات التسجيل
 * ناقصة» check, SPENT THE SINGLE-USE CHALLENGE, and only then came back as
 * «نوع المفتاح غير مدعوم». A missing field now reads as a missing field and
 * the ticket survives.
 */

const { db, logAudit, getCurrentUser } = vi.hoisted(() => ({
  db: {
    passkeyChallenge: { findFirst: vi.fn(), updateMany: vi.fn() },
    passkey: { findUnique: vi.fn(), create: vi.fn() },
  },
  logAudit: vi.fn(),
  getCurrentUser: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/auth', () => ({ getCurrentUser: (...a: unknown[]) => getCurrentUser(...a) }));
// `@/lib/passkey` is NOT mocked: the allowlist is the thing being measured.

import { POST } from './route';
import { COSE_ES256, COSE_RS256, b64url } from '@/lib/passkey';

const CHALLENGE = 'Y2hhbGxlbmdlLWZvci1hLXRlc3QtMzJieXRlcw';
const ORIGIN = 'http://localhost';

/** The clientDataJSON a browser would hand back for this ceremony. */
const clientData = (over: Record<string, unknown> = {}) =>
  b64url.encode(
    Buffer.from(
      JSON.stringify({ type: 'webauthn.create', challenge: CHALLENGE, origin: ORIGIN, ...over }),
      'utf8'
    )
  );

const SOUND = {
  credentialId: 'Y3JlZC1pZA',
  publicKey: 'cHVibGljLWtleQ',
  clientDataJSON: clientData(),
  label: 'آيفون العمل',
};

const post = (body: unknown) =>
  POST(new Request(`${ORIGIN}/api/auth/passkey/register`, { method: 'POST', body: JSON.stringify(body) }));

/** The algorithm exactly as it reached the database. */
const stored = () => db.passkey.create.mock.calls.map((c) => c[0].data.algorithm);
/** Whether the single-use challenge was spent. */
const spent = () => db.passkeyChallenge.updateMany.mock.calls.length;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.APP_URL;
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.TRUST_PROXY;
  getCurrentUser.mockResolvedValue({ id: 'u1', name: 'سارة', companyId: 'c1', status: 'ACTIVE' });
  db.passkeyChallenge.findFirst.mockResolvedValue({ id: 'tk1', challenge: CHALLENGE });
  db.passkeyChallenge.updateMany.mockResolvedValue({ count: 1 });
  db.passkey.findUnique.mockResolvedValue(null);
  db.passkey.create.mockResolvedValue({ id: 'pk1', label: 'آيفون العمل', createdAt: new Date(0) });
});

describe('the allowlist is the gate, and it is closed', () => {
  it('registers ES256, which is what a phone sends', async () => {
    const res = await post({ ...SOUND, algorithm: COSE_ES256 });
    expect(stored()).toEqual([-7]);
    expect(res.status).toBe(200);
  });

  it('registers RS256, which is what some Windows keys send', async () => {
    const res = await post({ ...SOUND, algorithm: COSE_RS256 });
    expect(stored()).toEqual([-257]);
    expect(res.status).toBe(200);
  });

  it('refuses 16 — and this is WHY the notation defect could not weaken anything', async () => {
    expect(Number('0x10'), 'the hazard is measured here').toBe(16);
    const res = await post({ ...SOUND, algorithm: 16 });
    expect(
      stored(),
      '16 is not in ALLOWED_ALGORITHMS, so verifyRegistration refuses it before db.passkey.create'
    ).toEqual([]);
    expect(res.status).toBe(400);
    const { code } = await res.json();
    expect(code).toBe('UNSUPPORTED_ALGORITHM');
  });

  it('no base-prefixed notation can reach an accepted value, because both are negative', async () => {
    for (const s of ['-0x7', '-0b111', '-0o7', '-0x101']) {
      expect(Number(s), `${s} is NaN, not a negative number`).toBeNaN();
    }
    expect(Number('0x10')).toBeGreaterThan(0);
  });
});

describe('a missing algorithm is a missing field again, and the challenge survives', () => {
  const ZEROISH = [
    ['null', null],
    ['an empty array', []],
    ['an empty string', ''],
  ] as const;

  it.each(ZEROISH)('refuses %s without spending the single-use challenge', async (_label, value) => {
    expect(Number(value as never), 'which is finite, which is how it slipped past').toBe(0);
    const res = await post({ ...SOUND, algorithm: value });
    expect(stored()).toEqual([]);
    expect(
      spent(),
      'the ticket was burned by a request that was never going to register anything'
    ).toBe(0);
    expect(db.passkeyChallenge.findFirst).not.toHaveBeenCalled();
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toBe('بيانات التسجيل ناقصة');
  });

  it('refuses a one-element array holding a REAL algorithm — a shape nobody sends', async () => {
    expect(Number(['-7']), 'Number() reads it as a valid COSE algorithm').toBe(-7);
    const res = await post({ ...SOUND, algorithm: ['-7'] });
    expect(
      stored(),
      "['-7'] would have registered a passkey: harmless in itself, and still a shape the door should not take"
    ).toEqual([]);
    expect(spent()).toBe(0);
    expect(res.status).toBe(400);
  });

  it("refuses «0x10» as a string, without spending the challenge either", async () => {
    const res = await post({ ...SOUND, algorithm: '0x10' });
    expect(stored()).toEqual([]);
    expect(spent()).toBe(0);
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toBe('بيانات التسجيل ناقصة');
  });

  it('still accepts the numeric string a form could post', async () => {
    const res = await post({ ...SOUND, algorithm: '-7' });
    expect(stored()).toEqual([-7]);
    expect(res.status).toBe(200);
  });

  it('refuses an overflowing exponent, though isNaN(Infinity) is false', async () => {
    expect(Number('1e400')).toBe(Infinity);
    expect(isNaN(Infinity)).toBe(false);
    const res = await post({ ...SOUND, algorithm: '1e400' });
    expect(stored()).toEqual([]);
    expect(spent()).toBe(0);
    expect(res.status).toBe(400);
  });
});

describe('the figure that is stored is the figure that is audited', () => {
  it('the audit row carries the number, not the reader', async () => {
    await post({ ...SOUND, algorithm: '-257' });
    expect(stored()).toEqual([-257]);
    expect(logAudit.mock.calls[0][0].newData).toMatchObject({ algorithm: -257 });
  });
});
