import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * O7 — «توكنات الأنظمة»: THE SCREEN THAT HANDS OUT A KEY.
 *
 * Three things have to hold here and none of them is about the happy path:
 *
 *   THE KEY IS SHOWN ONCE. Only the SHA-256 is stored, so there is nothing
 *   to show a second time — `GET` cannot return it and neither can anything
 *   else. That is the same rule `/api/apps` states for an app's signing
 *   secret: «An endpoint that can return it will one day return it to the
 *   wrong person.»
 *
 *   EVERY HANDLER ASKS FOR THE PERMISSION. Handing out a system key is the
 *   same act as registering an app, so it is `apps.manage` — and a control
 *   hidden in the UI but permitted by the API «is not a permission, it is a
 *   decoration». So the refusal is tested by making it happen, on all three
 *   verbs.
 *
 *   STOPPING IS NOT DELETING. `revokedAt` is set and the row stays: who
 *   opened a door and who shut it survives the shutting, like a released
 *   block or a reversed entry.
 * ═══════════════════════════════════════════════════════════════════════
 */

const h = vi.hoisted(() => ({
  db: {
    systemToken: { findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  },
  requireCompanyTenant: vi.fn(),
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db: h.db }));
vi.mock('@/lib/auth', () => ({ requireCompanyTenant: () => h.requireCompanyTenant() }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: (p: string) => h.requirePermission(p),
  // The minter holds every key at full scope here; minting beyond one's keys is its own test.
  getPermissionScope: () => ({ scope: 'ALL_COMPANY' }),
  // …and reaches every store (geo.manage), which minting needs.
  can: () => true,
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => h.logAudit(...a) }));

import { DELETE, GET, POST } from '@/app/api/settings/system-tokens/route';
import { MEDIABUYER_SCOPES, REPLIES_SCOPES, V1_SCOPES, hashToken } from './system-token';

const body = (value: unknown) =>
  new Request('https://oms.test/api/settings/system-tokens', {
    method: 'POST',
    body: JSON.stringify(value),
  });

const ID = '11111111-2222-4333-8444-555555555555';

beforeEach(() => {
  vi.clearAllMocks();
  h.requireCompanyTenant.mockResolvedValue({ user: { id: 'u1', name: 'المالك' }, companyId: 'c1' });
  h.requirePermission.mockResolvedValue({ id: 'u1' });
  h.db.systemToken.findMany.mockResolvedValue([]);
  h.db.systemToken.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: 'tok_1', createdAt: new Date(), ...data })
  );
  h.db.systemToken.updateMany.mockResolvedValue({ count: 1 });
});

describe('the permission, on every verb', () => {
  it('refuses a reader who does not hold apps.tokens', async () => {
    h.requirePermission.mockRejectedValue(
      new Error('Forbidden: missing required permission apps.tokens')
    );
    const res = await GET();
    expect(res.status).toBe(403);
    expect(h.db.systemToken.findMany).not.toHaveBeenCalled();
  });

  it('and refuses the creation, which is the one that hands out a key', async () => {
    h.requirePermission.mockRejectedValue(
      new Error('Forbidden: missing required permission apps.tokens')
    );
    const res = await POST(body({ name: 'نظام الردود', scopes: REPLIES_SCOPES }));
    expect(res.status).toBe(403);
    expect(h.db.systemToken.create).not.toHaveBeenCalled();
  });

  it('and refuses the stop, because stopping somebody else’s door is an act too', async () => {
    h.requirePermission.mockRejectedValue(
      new Error('Forbidden: missing required permission apps.tokens')
    );
    const res = await DELETE(body({ id: ID }));
    expect(res.status).toBe(403);
    expect(h.db.systemToken.updateMany).not.toHaveBeenCalled();
  });

  it('and it is the SAME permission in all three, asked by name', async () => {
    await GET();
    await POST(body({ name: 'نظام الردود', scopes: REPLIES_SCOPES }));
    await DELETE(body({ id: ID }));
    // PR-13 (قديم ← جديد): the keys have a box of their own — `apps.tokens`, no longer `apps.manage`.
    expect(h.requirePermission.mock.calls.map((c) => c[0])).toEqual([
      'apps.tokens',
      'apps.tokens',
      'apps.tokens',
    ]);
  });
});

describe('creating a key', () => {
  it('stores the hash and never the key', async () => {
    const res = await POST(body({ name: 'نظام الردود', scopes: REPLIES_SCOPES }));
    expect(res.status).toBe(201);
    const secret = (await res.json()).secret as string;
    const stored = h.db.systemToken.create.mock.calls[0][0].data;

    expect(stored.tokenHash).toBe(hashToken(secret));
    // The plaintext is in NO column. Read as one string so a field added
    // later cannot quietly carry it.
    expect(JSON.stringify(stored)).not.toContain(secret.slice(4));
  });

  it('and hands it back exactly once, with the warning beside it', async () => {
    const made = await (await POST(body({ name: 'نظام الردود', scopes: REPLIES_SCOPES }))).json();
    expect(made.secret).toMatch(/^zk1_/);
    // A person who closes the box without copying has to make another one,
    // and being told that afterwards is being told too late.
    expect(made.notice).toMatch(/لن يظهر مرة أخرى/);
  });

  it('and the list afterwards can never return it, because it is not selected', async () => {
    await GET();
    const select = h.db.systemToken.findMany.mock.calls[0][0].select;
    expect(select.tokenHash).toBeUndefined();
    // The prefix is what a person recognises a key by — it is not the key.
    expect(select.prefix).toBe(true);
  });

  it('and the audit says what was issued and to whom, never the value', async () => {
    const made = await (await POST(body({ name: 'نظام الردود', scopes: REPLIES_SCOPES }))).json();
    const entry = h.logAudit.mock.calls[0][0];
    expect(entry).toMatchObject({ companyId: 'c1', userId: 'u1', action: 'SYSTEM_TOKEN_CREATED' });
    expect(JSON.stringify(entry)).not.toContain(made.secret.slice(4));
  });

  it('and the key belongs to the caller’s company, which is never in the body', async () => {
    await POST(body({ name: 'نظام الردود', scopes: REPLIES_SCOPES, companyId: 'c_other' }));
    expect(h.db.systemToken.create.mock.calls[0][0].data.companyId).toBe('c1');
  });

  it('and it expires — ninety days by default, never «no end»', async () => {
    const before = Date.now();
    await POST(body({ name: 'نظام الردود', scopes: REPLIES_SCOPES }));
    const expiresAt = h.db.systemToken.create.mock.calls[0][0].data.expiresAt as Date;
    const days = (expiresAt.getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThan(90.1);
  });

  it('and refuses a key with no scopes at all, which would be a key for nothing', async () => {
    const res = await POST(body({ name: 'نظام الردود', scopes: [] }));
    expect(res.status).toBe(400);
    expect(h.db.systemToken.create).not.toHaveBeenCalled();
  });

  it('and refuses a scope this product does not define', async () => {
    const res = await POST(body({ name: 'نظام الردود', scopes: ['orders.delete'] }));
    expect(res.status).toBe(400);
    expect(h.db.systemToken.create).not.toHaveBeenCalled();
  });

  it('and refuses a body that is not a body', async () => {
    const res = await POST(
      new Request('https://oms.test/api/settings/system-tokens', { method: 'POST', body: 'nonsense' })
    );
    expect(res.status).toBe(400);
  });
});

describe('stopping a key', () => {
  it('sets revokedAt and deletes nothing', async () => {
    const res = await DELETE(body({ id: ID }));
    expect(res.status).toBe(200);
    const call = h.db.systemToken.updateMany.mock.calls[0][0];
    expect(call.data.revokedAt).toBeInstanceOf(Date);
    // A deleted row would leave nothing to explain a key that used to work.
    expect(Object.keys(call.data)).toEqual(['revokedAt']);
  });

  it('and is scoped to the company, so one company cannot stop another’s', async () => {
    await DELETE(body({ id: ID }));
    expect(h.db.systemToken.updateMany.mock.calls[0][0].where).toEqual({
      id: ID,
      companyId: 'c1',
      revokedAt: null,
    });
  });

  it('and a key that is already stopped, or is not ours, answers 404 in Arabic', async () => {
    h.db.systemToken.updateMany.mockResolvedValue({ count: 0 });
    const res = await DELETE(body({ id: ID }));
    expect(res.status).toBe(404);
    const refusal = await res.json();
    // A sentence a person reads, and it says what to do next.
    expect(refusal.errorAr).toMatch(/[؀-ۿ]/);
    expect(refusal.errorAr).toMatch(/أعد تحميل/);
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it('and an id that is not an id is refused before the database is touched', async () => {
    const res = await DELETE(body({ id: 'not-a-uuid' }));
    expect(res.status).toBe(400);
    expect(h.db.systemToken.updateMany).not.toHaveBeenCalled();
  });
});

describe('what the list says about each key', () => {
  it('tells «stopped» apart from «expired», because they need different buttons', async () => {
    const soon = new Date(Date.now() + 86_400_000);
    const past = new Date(Date.now() - 86_400_000);
    h.db.systemToken.findMany.mockResolvedValue([
      { id: 'a', name: 'A', system: 'replies', prefix: 'zk1_aaa', scopes: '["orders.read"]', rateLimitPerMin: 60, expiresAt: soon, revokedAt: null, lastUsedAt: null, createdAt: past },
      { id: 'b', name: 'B', system: 'replies', prefix: 'zk1_bbb', scopes: '["orders.read"]', rateLimitPerMin: 60, expiresAt: past, revokedAt: null, lastUsedAt: null, createdAt: past },
      { id: 'c', name: 'C', system: 'replies', prefix: 'zk1_ccc', scopes: '["orders.read"]', rateLimitPerMin: 60, expiresAt: soon, revokedAt: past, lastUsedAt: null, createdAt: past },
    ]);
    const listed = (await (await GET()).json()).tokens as { id: string; state: string }[];
    expect(listed.map((t) => `${t.id}:${t.state}`)).toEqual(['a:ACTIVE', 'b:EXPIRED', 'c:REVOKED']);
  });

  it('and a revoked key that has not expired is still REVOKED, not ACTIVE', async () => {
    // The decision somebody made wins over the clock.
    h.db.systemToken.findMany.mockResolvedValue([
      { id: 'a', name: 'A', system: 'replies', prefix: 'zk1_aaa', scopes: '[]', rateLimitPerMin: 60, expiresAt: new Date(Date.now() + 86_400_000), revokedAt: new Date(), lastUsedAt: null, createdAt: new Date() },
    ]);
    const listed = (await (await GET()).json()).tokens as { state: string }[];
    expect(listed[0].state).toBe('REVOKED');
  });

  it('and offers the scopes from the one list that defines them', async () => {
    const shelf = await (await GET()).json();
    // Was «the five» — the replies system's. Two read-only scopes for the
    // media buyer joined the list on 2026-10-26; the replies key still
    // starts from exactly its five (`repliesScopes`, below).
    expect((shelf.scopeCatalog as { key: string }[]).map((s) => s.key).sort()).toEqual(
      [...V1_SCOPES].sort()
    );
    expect([...shelf.repliesScopes].sort()).toEqual([...REPLIES_SCOPES].sort());
    // And each system a key may be made for, with the scopes it starts from.
    expect(shelf.systems).toEqual([
      { key: 'replies', ar: 'نظام الردود', scopes: REPLIES_SCOPES, rateLimitPerMin: 60 },
      { key: 'mediabuyer', ar: 'الميديا باير', scopes: MEDIABUYER_SCOPES, rateLimitPerMin: 30 },
    ]);
    // Each with Arabic, because a checkbox labelled `orders.note` is a
    // checkbox a seller does not tick.
    for (const s of shelf.scopeCatalog as { ar: string }[]) {
      expect(s.ar).toMatch(/[؀-ۿ]/);
    }
  });
});

describe('a key starts with its own system’s allowance', () => {
  it('the media buyer’s key is held to thirty a minute unless somebody chooses otherwise', async () => {
    await POST(body({ name: 'الميديا باير', system: 'mediabuyer', scopes: MEDIABUYER_SCOPES }));
    expect(h.db.systemToken.create.mock.calls[0][0].data.rateLimitPerMin).toBe(30);
  });

  it('and the replies system keeps its sixty', async () => {
    await POST(body({ name: 'نظام الردود', scopes: REPLIES_SCOPES }));
    expect(h.db.systemToken.create.mock.calls[0][0].data.rateLimitPerMin).toBe(60);
  });
});
