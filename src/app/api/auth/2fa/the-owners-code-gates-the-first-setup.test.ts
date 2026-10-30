import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A2 — THE FIRST SETUP OF A SECOND FACTOR ASKS FOR THE OWNER'S CODE (when the owner turned it on).
 *
 * OFF by default: with the switch off, setup is exactly what it was, and nobody is stranded by
 * the release. ON: no secret before the code, no saving without it, and the code is spent only
 * when the setup is saved, so a mistyped six-digit number does not burn the owner's code.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, tx, readChallenge, completeEnrolment, beginEnrolment } = vi.hoisted(() => {
  const tx = { user: { update: vi.fn() } };
  return {
    tx,
    db: {
      user: { findUnique: vi.fn() },
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    },
    readChallenge: vi.fn(),
    completeEnrolment: vi.fn(),
    beginEnrolment: vi.fn(() => ({ secret: 'SECRET', uri: 'otpauth://x' })),
  };
});
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/two-factor-challenge', () => ({ readChallenge: (...a: unknown[]) => readChallenge(...a) }));
vi.mock('qrcode', () => ({ default: { toDataURL: async () => 'data:image/png;base64,AAAA' } }));
vi.mock('@/lib/two-factor', async (orig) => ({
  ...(await orig<typeof import('@/lib/two-factor')>()),
  completeEnrolment: (...a: unknown[]) => completeEnrolment(...a),
  beginEnrolment: (...a: unknown[]) => beginEnrolment(...a),
}));

import { POST as start } from './start/route';
import { POST as enrol } from './enrol/route';
import { newEnrolCode, sealEnrolCode } from '@/lib/enrol-code';
import { TwoFactorRefused } from '@/lib/two-factor';

let n = 0;
const call = (handler: typeof start, url: string, body: unknown) =>
  handler(
    new Request(`http://localhost${url}`, {
      method: 'POST',
      headers: { 'x-forwarded-for': `198.51.100.${++n % 250}` },
      body: JSON.stringify(body),
    })
  );

let userId = '';
let code = '';
let row: { email: string; totpEnabledAt: null; enrolCodeHash: string | null; enrolCodeExpiresAt: Date | null };

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.TRUST_PROXY = 'true';
  delete process.env.AUTH_ENROL_CODE_REQUIRED;
  userId = `user-${++n}`;
  code = newEnrolCode();
  row = { email: 'e@x.example', totpEnabledAt: null, ...(await sealEnrolCode(code)) };
  readChallenge.mockResolvedValue({ userId, remember: false });
  db.user.findUnique.mockImplementation(async () => row);
  completeEnrolment.mockResolvedValue({ recoveryCodes: ['AAAAA-BBBBB'] });
});
afterEach(() => {
  delete process.env.TRUST_PROXY;
  delete process.env.AUTH_ENROL_CODE_REQUIRED;
});

describe('with the switch OFF (the default) — setup is exactly what it was', () => {
  it('start hands out the secret with no code', async () => {
    const res = await call(start, '/api/auth/2fa/start', { challenge: 't' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ secret: 'SECRET' });
  });

  it('enrol saves the setup with no code', async () => {
    const res = await call(enrol, '/api/auth/2fa/enrol', { challenge: 't', secret: 'SECRET', code: '123456' });
    expect(res.status).toBe(200);
    expect((await res.json()).recoveryCodes).toEqual(['AAAAA-BBBBB']);
  });
});

describe('with the switch OFF the two new columns are never named in a query', () => {
  it('start asks for the email and the enrolment, nothing else', async () => {
    await call(start, '/api/auth/2fa/start', { challenge: 't' });
    expect(Object.keys(db.user.findUnique.mock.calls[0][0].select).sort()).toEqual(['email', 'totpEnabledAt']);
  });

  it('enrol reads no code row and spends no code', async () => {
    await call(enrol, '/api/auth/2fa/enrol', { challenge: 't', secret: 'SECRET', code: '123456' });
    for (const [args] of db.user.findUnique.mock.calls) expect(JSON.stringify(args)).not.toContain('enrolCode');
    expect(tx.user.update).not.toHaveBeenCalled();
  });
});

describe('with the switch ON', () => {
  beforeEach(() => {
    process.env.AUTH_ENROL_CODE_REQUIRED = 'on';
  });

  it('start REFUSES to hand out a secret with no code, or with a wrong one', async () => {
    const missing = await call(start, '/api/auth/2fa/start', { challenge: 't' });
    expect(missing.status).toBe(400);
    expect((await missing.json()).code).toBe('ENROL_CODE_REQUIRED');

    const wrong = await call(start, '/api/auth/2fa/start', { challenge: 't', enrolCode: newEnrolCode() });
    expect(wrong.status).toBe(403);
    expect(beginEnrolment).not.toHaveBeenCalled();
  });

  it('start PASSES with the owner-issued code', async () => {
    const res = await call(start, '/api/auth/2fa/start', { challenge: 't', enrolCode: code });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ secret: 'SECRET' });
  });

  it('start tells an account nobody issued a code for to ask the owner', async () => {
    row = { ...row, enrolCodeHash: null, enrolCodeExpiresAt: null };
    const res = await call(start, '/api/auth/2fa/start', { challenge: 't', enrolCode: code });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/اطلبه منه/);
  });

  it('start REFUSES an expired code and says to ask for a new one', async () => {
    row = { ...row, enrolCodeExpiresAt: new Date(Date.now() - 1000) };
    const res = await call(start, '/api/auth/2fa/start', { challenge: 't', enrolCode: code });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/انتهت صلاحية/);
  });

  it('enrol REFUSES to save without the code — a ticket that got a secret some other way gets nowhere', async () => {
    const res = await call(enrol, '/api/auth/2fa/enrol', { challenge: 't', secret: 'SECRET', code: '123456' });
    expect(res.status).toBe(400);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(completeEnrolment).not.toHaveBeenCalled();
  });

  it('enrol SAVES with the code, and SPENDS it in the same transaction', async () => {
    const res = await call(enrol, '/api/auth/2fa/enrol', { challenge: 't', secret: 'SECRET', code: '123456', enrolCode: code });
    expect(res.status).toBe(200);
    expect(completeEnrolment).toHaveBeenCalledTimes(1);
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: userId }, data: { enrolCodeHash: null, enrolCodeExpiresAt: null } });
  });

  it('a mistyped six-digit number does NOT burn the owner\'s code', async () => {
    completeEnrolment.mockRejectedValueOnce(new TwoFactorRefused('BAD_CODE', 'الرمز غير صحيح'));
    const res = await call(enrol, '/api/auth/2fa/enrol', { challenge: 't', secret: 'SECRET', code: '000000', enrolCode: code });
    expect(res.status).toBe(400);
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('the code works once: after the spend the row has none, so the same code is refused', async () => {
    row = { ...row, enrolCodeHash: null, enrolCodeExpiresAt: null };
    const res = await call(enrol, '/api/auth/2fa/enrol', { challenge: 't', secret: 'SECRET', code: '123456', enrolCode: code });
    expect(res.status).toBe(400);
    expect(completeEnrolment).not.toHaveBeenCalled();
  });

  it('still refuses a ticket that is not an enrol ticket, as before', async () => {
    readChallenge.mockResolvedValue(null);
    expect((await call(start, '/api/auth/2fa/start', { challenge: 'bad', enrolCode: code })).status).toBe(401);
    expect((await call(enrol, '/api/auth/2fa/enrol', { challenge: 'bad', secret: 'S', code: '1', enrolCode: code })).status).toBe(401);
  });
});
