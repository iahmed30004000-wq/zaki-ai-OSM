import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';

/**
 * «اربط هذا التلفون» — the pairing code is made only for a signed-in person who holds «طلباتي»'s key
 * (`confirmation.work`), and it comes back as the contract's pair link plus the Android intent that opens it, with
 * the PUBLIC origin as `base` — never the Host header as it came. Only the code's hash is stored.
 */

const { db, state } = vi.hoisted(() => {
  const state = {
    session: true,
    perms: new Set<string>(),
    created: [] as { companyId: string; userId: string; codeHash: string; expiresAt: Date }[],
  };
  const db = {
    callHelperPairCode: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(async ({ data }: { data: (typeof state.created)[number] }) => {
        state.created.push(data);
        return data;
      }),
    },
  };
  return { db, state };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/auth', () => ({
  requireCompanyTenant: async () => {
    if (!state.session) throw new Error('Unauthorized');
    return { user: { id: 'u1', role: 'CONFIRMATION_AGENT', status: 'ACTIVE', companyId: 'co1' }, companyId: 'co1' };
  },
}));
vi.mock('@/lib/authorization', () => ({ can: (_u: unknown, k: string) => state.perms.has(k) }));

import { POST } from './route';

const before = { APP_URL: process.env.APP_URL, KEY: process.env.APP_ENCRYPTION_KEY };
process.env.APP_ENCRYPTION_KEY = ['test', 'only', 'encryption', 'key', 'not', 'real'].join('-').padEnd(40, 'z');
afterAll(() => {
  process.env.APP_URL = before.APP_URL;
  process.env.APP_ENCRYPTION_KEY = before.KEY;
});

const ask = (host = 'evil.example') =>
  POST(new Request('http://localhost:3000/api/call-helper/pair-code', { method: 'POST', headers: { host } }));

beforeEach(() => {
  vi.clearAllMocks();
  state.session = true;
  state.perms = new Set(['confirmation.work']);
  state.created = [];
  process.env.APP_URL = 'https://crm.example.test';
});

describe('who may ask for a code', () => {
  it('nobody signed in: 401, and nothing is made', async () => {
    state.session = false;
    expect((await ask()).status).toBe(401);
    expect(db.callHelperPairCode.create).not.toHaveBeenCalled();
  });

  it('signed in without «طلباتي»’s key: 403 in Arabic, and nothing is made', async () => {
    state.perms = new Set();
    const res = await ask();
    expect(res.status).toBe(403);
    expect((await res.json()).errorAr).toMatch(/[؀-ۿ]/);
    expect(db.callHelperPairCode.create).not.toHaveBeenCalled();
  });
});

describe('the code she is given', () => {
  it('is the contract’s pair link and its intent, on the public origin, for ten minutes', async () => {
    const res = await ask();
    expect(res.status).toBe(200);
    const body = await res.json();
    const link = new URL(body.pairLink);
    expect(link.protocol).toBe('zakicall:');
    expect(link.searchParams.get('base')).toBe('https://crm.example.test');
    const code = link.searchParams.get('code')!;
    expect(code).toMatch(/^[A-Za-z0-9_-]{32}$/);

    expect(body.intentUrl).toMatch(/^intent:\/\/pair\?base=[^#]+#Intent;scheme=zakicall;package=io\.zakiai\.callhelper;S\.browser_fallback_url=[^;]+;end$/);
    const fallback = decodeURIComponent(/S\.browser_fallback_url=([^;]+);end$/.exec(body.intentUrl)![1]);
    expect(fallback).toBe('https://crm.example.test/confirmation/mine#call-helper-install');

    const left = new Date(body.expiresAt).getTime() - Date.now();
    expect(left).toBeGreaterThan(9 * 60_000);
    expect(left).toBeLessThanOrEqual(10 * 60_000);

    // Stored for her, in her company — as a hash, never the code.
    expect(state.created).toHaveLength(1);
    expect(state.created[0]).toMatchObject({ companyId: 'co1', userId: 'u1' });
    expect(state.created[0].codeHash).toBe(crypto.createHash('sha256').update(code).digest('hex'));
    expect(JSON.stringify(state.created[0])).not.toContain(code);
  });

  it('never names the Host header’s domain', async () => {
    const body = await (await ask('evil.example')).json();
    expect(body.pairLink).not.toContain('evil.example');
    expect(body.intentUrl).not.toContain('evil.example');
  });

  it('is not made without an encryption key — the pairing could not keep the callKey', async () => {
    const key = process.env.APP_ENCRYPTION_KEY;
    const old = process.env.WHATSAPP_ENCRYPTION_KEY;
    delete process.env.APP_ENCRYPTION_KEY;
    delete process.env.WHATSAPP_ENCRYPTION_KEY;
    try {
      const res = await ask();
      expect(res.status).toBe(503);
      expect(db.callHelperPairCode.create).not.toHaveBeenCalled();
    } finally {
      process.env.APP_ENCRYPTION_KEY = key;
      if (old !== undefined) process.env.WHATSAPP_ENCRYPTION_KEY = old;
    }
  });
});
