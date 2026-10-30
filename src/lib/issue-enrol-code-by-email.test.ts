import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ENROL_CODE_TTL_MS, issueEnrolCodeByEmail, judgeEnrolCode, type ServerIssueDb } from './enrol-code';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A2 — THE OWNER'S WAY OUT, FROM THE SERVER'S SHELL.
 *
 * The door will not issue a code for yourself, so an owner who is the only holder of the key
 * (or who lost the phone and the recovery codes) needs a path that does not go through the
 * door. It runs where somebody holds the server, issues the same hashed one-day code, and
 * clears a stored second factor ONLY when asked for by name.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Row = { id: string; name: string | null; status: string; companyId: string | null; totpEnabledAt: Date | null };

const NOW = new Date('2026-10-30T10:00:00Z');
let row: Row | null;
const findUnique = vi.fn(async (..._a: unknown[]): Promise<Row | null> => row);
const update = vi.fn(async (..._a: unknown[]): Promise<unknown> => ({}));
const recoveryDelete = vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ count: 8 }));
const passkeyDelete = vi.fn(async (..._a: unknown[]) => ({ count: 1 }));
const challengeDelete = vi.fn(async (..._a: unknown[]) => ({ count: 0 }));

const fakeDb: ServerIssueDb = {
  user: { findUnique: (a) => findUnique(a), update: (a) => update(a) },
  twoFactorRecoveryCode: { deleteMany: (a) => recoveryDelete(a) },
  passkey: { deleteMany: (a) => passkeyDelete(a) },
  passkeyChallenge: { deleteMany: (a) => challengeDelete(a) },
  $transaction: async (fn) => fn(fakeDb),
};

beforeEach(() => {
  vi.clearAllMocks();
  row = { id: 'owner1', name: 'المالك', status: 'ACTIVE', companyId: 'c1', totpEnabledAt: null };
});

const written = () => (update.mock.calls[0]?.[0] as { where: { id: string }; data: Record<string, unknown> }) ?? null;

describe('an owner with no second factor yet', () => {
  it('gets a code that works, kept only as a hash, good for a day — and nothing else is touched', async () => {
    const out = await issueEnrolCodeByEmail(fakeDb, '  Owner@Shop.Example ', { resetFactor: false, now: NOW });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(findUnique.mock.calls[0]?.[0]).toMatchObject({ where: { email: 'owner@shop.example' } });
    const w = written();
    expect(w.where).toEqual({ id: 'owner1' });
    expect(JSON.stringify(w.data)).not.toContain(out.code.replace('-', ''));
    expect(Object.keys(w.data).sort()).toEqual(['enrolCodeExpiresAt', 'enrolCodeHash']);
    expect(out.expiresAt.getTime() - NOW.getTime()).toBe(ENROL_CODE_TTL_MS);
    expect(await judgeEnrolCode({ enrolCodeHash: w.data.enrolCodeHash as string, enrolCodeExpiresAt: w.data.enrolCodeExpiresAt as Date }, out.code, NOW)).toBe('ok');
    expect(recoveryDelete).not.toHaveBeenCalled();
    expect(passkeyDelete).not.toHaveBeenCalled();
    expect(out.factorReset).toBe(false);
  });
});

describe('refusals', () => {
  it('an unknown email, an inactive account', async () => {
    row = null;
    expect(await issueEnrolCodeByEmail(fakeDb, 'x@y.example', { resetFactor: false })).toEqual({ ok: false, reason: 'NOT_FOUND' });
    row = { id: 'o', name: null, status: 'SUSPENDED', companyId: null, totpEnabledAt: null };
    expect(await issueEnrolCodeByEmail(fakeDb, 'x@y.example', { resetFactor: false })).toEqual({ ok: false, reason: 'NOT_ACTIVE' });
    expect(update).not.toHaveBeenCalled();
  });

  it('an account that already has a second factor is NOT reset unless asked for by name', async () => {
    row = { id: 'o', name: null, status: 'ACTIVE', companyId: null, totpEnabledAt: new Date() };
    expect(await issueEnrolCodeByEmail(fakeDb, 'x@y.example', { resetFactor: false })).toEqual({ ok: false, reason: 'ALREADY_ENROLLED' });
    expect(update).not.toHaveBeenCalled();
    expect(recoveryDelete).not.toHaveBeenCalled();
  });
});

describe('the lost-phone case, asked for by name', () => {
  it('clears the factor, its recovery codes, the sessions and the fingerprints of THAT account, then issues the code', async () => {
    row = { id: 'owner1', name: 'المالك', status: 'ACTIVE', companyId: 'c1', totpEnabledAt: new Date() };
    const out = await issueEnrolCodeByEmail(fakeDb, 'owner@shop.example', { resetFactor: true, now: NOW });
    expect(out.ok && out.factorReset).toBe(true);
    expect(written().data).toMatchObject({ totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null, tokenVersion: { increment: 1 } });
    expect(recoveryDelete).toHaveBeenCalledWith({ where: { userId: 'owner1' } });
    expect(passkeyDelete).toHaveBeenCalledWith({ where: { userId: 'owner1' } });
    expect(challengeDelete).toHaveBeenCalledWith({ where: { userId: 'owner1' } });
  });

  it('asking for it on an account that has none to clear changes nothing but the code', async () => {
    const out = await issueEnrolCodeByEmail(fakeDb, 'owner@shop.example', { resetFactor: true, now: NOW });
    expect(out.ok && out.factorReset).toBe(false);
    expect(Object.keys(written().data).sort()).toEqual(['enrolCodeExpiresAt', 'enrolCodeHash']);
    expect(recoveryDelete).not.toHaveBeenCalled();
  });
});

describe('the script itself', () => {
  const script = readFileSync(path.join(process.cwd(), 'scripts/issue-enrol-code.ts'), 'utf8');
  it('uses the shared function, writes an audit row without the code, and needs the flag by name', () => {
    expect(script).toContain('issueEnrolCodeByEmail(');
    expect(script).toContain("process.argv.includes('--reset-factor')");
    expect(script).toContain("action: 'ENROL_CODE_ISSUED_BY_SERVER'");
    expect(script).not.toMatch(/newData:[^}]*code[^}]*\}/);
  });
});
