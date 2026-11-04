import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';

/**
 * «مساعد الاتصال» — THE PAIRING CODE IS THE CREDENTIAL, ONCE.
 *
 *   · a good code → `{ token, userName, callKey }`, the callKey 43+ base64url characters the app keeps (CallSig.kt);
 *   · the token is stored only as its SHA-256, the callKey only encrypted;
 *   · a code used once, or past its ten minutes, is refused in Arabic (the app shows the sentence as it came);
 *   · a person who is not ACTIVE is refused;
 *   · pairing revokes her previous phone — one active device per person;
 *   · no session is asked: there is no cookie on a phone app.
 */

type Code = { id: string; companyId: string; userId: string; codeHash: string; expiresAt: Date; usedAt: Date | null };
type Device = { id: string; companyId: string; userId: string; deviceName: string; tokenHash: string; callKeyEncrypted: string; revokedAt: Date | null };

const { db, state } = vi.hoisted(() => {
  const state = {
    codes: [] as Code[],
    devices: [] as Device[],
    users: new Map<string, { name: string; status: string; companyId: string | null; role: string }>(),
    locks: [] as { sql: string; values: unknown[]; devicesAtLock: number }[],
  };
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && 'gt' in (v as object)) return (row[k] as Date).getTime() > ((v as { gt: Date }).gt).getTime();
      return row[k] === v;
    });
  const db = {
    callHelperPairCode: {
      findUnique: vi.fn(async ({ where }: { where: { codeHash: string } }) => state.codes.find((c) => c.codeHash === where.codeHash) ?? null),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Code> }) => {
        const hit = state.codes.filter((c) => matches(c, where));
        hit.forEach((c) => Object.assign(c, data));
        return { count: hit.length };
      }),
    },
    callHelperDevice: {
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Device> }) => {
        const hit = state.devices.filter((d) => matches(d, where));
        hit.forEach((d) => Object.assign(d, data));
        return { count: hit.length };
      }),
      create: vi.fn(async ({ data }: { data: Omit<Device, 'id' | 'revokedAt'> }) => {
        const d = { id: `d${state.devices.length + 1}`, revokedAt: null, ...data };
        state.devices.push(d);
        return d;
      }),
    },
    user: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => state.users.get(where.id) ?? null) },
    /** The lock on her user row — recorded, so the order of the transaction can be held. */
    $queryRaw: vi.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
      state.locks.push({ sql: sql.join('?'), values, devicesAtLock: state.devices.length });
      return [];
    }),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return { db, state };
});

vi.mock('@/lib/db', () => ({ db }));
// No session exists for this door; if anything asked for one, the test would see it.
vi.mock('next/headers', () => ({
  cookies: () => {
    throw new Error('the pair door must not read a session');
  },
}));

import { POST } from './route';
import { decryptSecret } from '@/lib/secrets';

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
// Obviously fake, assembled — never a real key.
process.env.APP_ENCRYPTION_KEY = ['test', 'only', 'encryption', 'key', 'not', 'real'].join('-').padEnd(40, 'z');

let n = 0;
const freshCode = () => {
  n += 1;
  return `code${String(n).padStart(4, '0')}`.padEnd(32, 'Q');
};
const issue = (over: Partial<Code> = {}) => {
  const code = freshCode();
  state.codes.push({ id: `c${n}`, companyId: 'co1', userId: 'u1', codeHash: sha(code), expiresAt: new Date(Date.now() + 5 * 60_000), usedAt: null, ...over });
  return code;
};
const pair = (code: unknown, deviceName: unknown = 'Samsung SM-A515F', ip = '10.0.0.1') =>
  POST(
    new Request('http://localhost/api/call-helper/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ code, deviceName }),
    })
  );

beforeEach(() => {
  vi.clearAllMocks();
  state.codes = [];
  state.devices = [];
  state.locks = [];
  state.users = new Map([['u1', { name: 'سارة', status: 'ACTIVE', companyId: 'co1', role: 'CONFIRMATION_AGENT' }]]);
});

describe('a good code', () => {
  it('pairs: a token, her name, and a callKey the app keeps', async () => {
    const res = await pair(issue());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['callKey', 'token', 'userName']);
    expect(body.userName).toBe('سارة');
    expect(body.callKey.length).toBeGreaterThanOrEqual(43);
    expect(body.callKey).toMatch(/^[A-Za-z0-9_-]{43,}={0,2}$/);
    expect(body.token.length).toBeGreaterThanOrEqual(43);

    expect(state.devices).toHaveLength(1);
    const d = state.devices[0];
    expect(d).toMatchObject({ companyId: 'co1', userId: 'u1', deviceName: 'Samsung SM-A515F', revokedAt: null });
    // Only the hash of the token, and the callKey only encrypted.
    expect(d.tokenHash).toBe(sha(body.token));
    expect(JSON.stringify(d)).not.toContain(body.token);
    expect(d.callKeyEncrypted).not.toContain(body.callKey);
    expect(decryptSecret(d.callKeyEncrypted)).toBe(body.callKey);
  });

  it('revokes the phone she paired before', async () => {
    state.devices.push({ id: 'old', companyId: 'co1', userId: 'u1', deviceName: 'old', tokenHash: 'h', callKeyEncrypted: 'x', revokedAt: null });
    state.devices.push({ id: 'other', companyId: 'co1', userId: 'u2', deviceName: 'colleague', tokenHash: 'h2', callKeyEncrypted: 'x', revokedAt: null });
    expect((await pair(issue())).status).toBe(200);
    expect(state.devices.find((d) => d.id === 'old')!.revokedAt).toBeInstanceOf(Date);
    // A colleague's phone is not hers to revoke.
    expect(state.devices.find((d) => d.id === 'other')!.revokedAt).toBeNull();
    expect(state.devices.filter((d) => d.userId === 'u1' && !d.revokedAt)).toHaveLength(1);
  });

  it('locks her user row first, inside the transaction, so two codes at once leave one active phone', async () => {
    expect((await pair(issue())).status).toBe(200);
    expect(state.locks).toHaveLength(1);
    expect(state.locks[0].sql).toMatch(/FROM "users" WHERE "id" = \? FOR UPDATE/);
    expect(state.locks[0].values).toEqual(['u1']);
    // Taken before the revoke and the new device are written.
    expect(state.locks[0].devicesAtLock).toBe(0);
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(db.callHelperDevice.updateMany.mock.invocationCallOrder[0]);
  });
});

describe('a code that is not good any more', () => {
  it('used once is refused the second time, in Arabic', async () => {
    const code = issue();
    expect((await pair(code)).status).toBe(200);
    const again = await pair(code);
    expect(again.status).toBe(400);
    expect((await again.json()).error).toMatch(/[؀-ۿ]/);
    expect(state.devices).toHaveLength(1);
  });

  it('past its ten minutes is refused', async () => {
    const res = await pair(issue({ expiresAt: new Date(Date.now() - 1000) }));
    expect(res.status).toBe(400);
    expect(state.devices).toHaveLength(0);
  });

  it('unknown, or not of the contract’s shape, is refused', async () => {
    expect((await pair('Z'.repeat(32))).status).toBe(400);
    expect((await pair('short')).status).toBe(400);
    expect((await pair(undefined)).status).toBe(400);
    expect(state.devices).toHaveLength(0);
  });
});

describe('the person behind the code', () => {
  it('not ACTIVE: refused, and the code is not spent on her', async () => {
    state.users.set('u1', { name: 'سارة', status: 'SUSPENDED', companyId: 'co1', role: 'CONFIRMATION_AGENT' });
    const res = await pair(issue());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/[؀-ۿ]/);
    expect(state.devices).toHaveLength(0);
  });

  it('moved to another company since the code was made: refused', async () => {
    state.users.set('u1', { name: 'سارة', status: 'ACTIVE', companyId: 'co2', role: 'CONFIRMATION_AGENT' });
    expect((await pair(issue())).status).toBe(403);
  });
});

describe('the device name', () => {
  it('is kept short and printable, and a phone that sends none is «تلفون أندرويد»', async () => {
    await pair(issue(), 'A\u0000B\nC'.padEnd(200, 'x'));
    expect(state.devices[0].deviceName.length).toBeLessThanOrEqual(80);
    expect(state.devices[0].deviceName).not.toMatch(/[\u0000-\u001f]/);
    await pair(issue(), 42);
    expect(state.devices[1].deviceName).toBe('تلفون أندرويد');
  });
});
