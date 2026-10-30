import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * ISSUING AND STOPPING A KEY THAT OTHER SYSTEMS CALL /api/v1 WITH ASKS apps.tokens (perm-plan PR-13).
 *
 * It rode on `apps.manage` — the key that installs a courier. A key that READS the company's orders and customers is a different
 * grant: the owner could not give a person the shelf and keep the keys away from her. The migration gave the new box to
 * everybody who held `apps.manage`, so nobody lost the door on the day.
 *
 * Asked of the door, on all three verbs: a holder of `apps.manage` ALONE gets 403 before anything is read, minted or stopped.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, held, actor } = vi.hoisted(() => ({
  db: { systemToken: { findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() } },
  held: { keys: new Set<string>() },
  actor: { current: { id: 'u1', name: 'المالك', role: 'COMPANY_ADMIN', companyId: 'c1', status: 'ACTIVE' } },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/auth', () => ({ requireCompanyTenant: async () => ({ user: actor.current, companyId: 'c1' }) }));
const holds = (key: string) => actor.current.role === 'SUPER_ADMIN' || held.keys.has(key);
vi.mock('@/lib/authorization', () => ({
  requirePermission: async (key: string) => {
    if (!holds(key)) throw new Error(`Forbidden: missing required permission ${key}`);
    return actor.current;
  },
}));
// What the minter may put on a key is another test's business (token-granter): here the minter is allowed everything.
vi.mock('@/lib/v1/token-granter', () => ({ keyScopeLacks: () => null, mayMintForCompany: () => true, scopeBeyondMinter: () => null }));

import { GET, POST, DELETE } from './route';

const ID = '5b0f6d3e-2c1f-4a8e-9c52-3a1d6f0a7b11';
const body = (b: unknown, method = 'POST') => new Request('http://localhost/api/settings/system-tokens', { method, body: JSON.stringify(b) });

beforeEach(() => {
  vi.clearAllMocks();
  held.keys = new Set(['apps.view', 'apps.manage']);
  actor.current = { id: 'u1', name: 'المالك', role: 'COMPANY_ADMIN', companyId: 'c1', status: 'ACTIVE' };
  db.systemToken.findMany.mockResolvedValue([]);
  db.systemToken.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'tok_1', createdAt: new Date(), expiresAt: new Date(), ...data }));
  db.systemToken.updateMany.mockResolvedValue({ count: 1 });
});

describe('NEGATIVE: apps.manage alone — the shelf — does not open the keys', () => {
  it('the list is refused and nothing is read', async () => {
    const res = await GET();
    expect(res.status).toBe(403);
    expect(db.systemToken.findMany).not.toHaveBeenCalled();
  });

  it('the creation is refused, nothing is stored and no key is shown', async () => {
    const res = await POST(body({ name: 'نظام الردود', scopes: ['orders.read'] }));
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toMatch(/secret|zk_/);
    expect(db.systemToken.create).not.toHaveBeenCalled();
  });

  it('the stop is refused and no key is stopped', async () => {
    const res = await DELETE(body({ id: ID }, 'DELETE'));
    expect(res.status).toBe(403);
    expect(db.systemToken.updateMany).not.toHaveBeenCalled();
  });

  it('and the refusal names the box in Arabic', async () => {
    const res = await GET();
    expect((await res.json()).errorAr).toMatch(/إصدار وإيقاف مفاتيح ربط الأنظمة الخارجية/);
  });
});

describe('with apps.tokens the three verbs work as they did', () => {
  beforeEach(() => {
    held.keys = new Set(['apps.view', 'apps.tokens']);
  });

  it('lists', async () => {
    expect((await GET()).status).toBe(200);
    expect(db.systemToken.findMany).toHaveBeenCalledTimes(1);
  });

  it('creates, once, and shows the key once', async () => {
    const res = await POST(body({ name: 'نظام الردود', scopes: ['orders.read'] }));
    expect(res.status).toBe(201);
    expect(typeof (await res.json()).secret).toBe('string');
    expect(db.systemToken.create).toHaveBeenCalledTimes(1);
  });

  it('stops', async () => {
    expect((await DELETE(body({ id: ID }, 'DELETE'))).status).toBe(200);
    expect(db.systemToken.updateMany.mock.calls[0][0].data).toHaveProperty('revokedAt');
  });

  it('and the owner does all three with nothing listed — the way back in', async () => {
    actor.current = { id: 'root', name: 'المالك', role: 'SUPER_ADMIN', companyId: 'c1', status: 'ACTIVE' };
    held.keys = new Set();
    expect((await GET()).status).toBe(200);
    expect((await POST(body({ name: 'نظام الردود', scopes: ['orders.read'] }))).status).toBe(201);
    expect((await DELETE(body({ id: ID }, 'DELETE'))).status).toBe(200);
  });
});
