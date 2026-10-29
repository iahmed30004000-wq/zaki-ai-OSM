import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * SEEING THE BLACKLIST AND CHANGING IT ARE TWO KEYS (perm-plan PR-6): `control.blacklist` reads the list,
 * `control.blacklist_manage` blocks a number and lifts a block. The migration gave the second to everybody who held the
 * first, so nobody lost a door; from then on the owner can leave a person looking at the list without letting her touch it.
 *
 * Through the REAL engine. The same four-way test at each door: the new key → past the gate; the old key alone → 403;
 * the new key alone → 403 (it opens no screen); a «منع» on the new key beats a role that carries it.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, blockPhone, releaseBlock, current } = vi.hoisted(() => ({
  db: { customerBlock: { findMany: vi.fn(async () => []) }, customer: { findMany: vi.fn(async () => []) } },
  requireContext: vi.fn(),
  blockPhone: vi.fn(),
  releaseBlock: vi.fn(),
  current: { user: null as unknown as SessionUser },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: vi.fn() }));
vi.mock('@/lib/blacklist', async (orig) => ({
  ...(await orig<typeof import('@/lib/blacklist')>()),
  blockPhone: (...a: unknown[]) => blockPhone(...a),
  releaseBlock: (...a: unknown[]) => releaseBlock(...a),
}));
vi.mock('@/lib/authorization', async (orig) => {
  const real = await orig<typeof import('@/lib/authorization')>();
  return {
    ...real,
    requirePermission: async (k: string) => {
      if (!real.can(current.user, k)) throw new Error(`Forbidden: missing required permission ${k}`);
      return current.user;
    },
  };
});

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { GET, PATCH, POST } from './blacklist/route';

async function person(roleKeys: string[], deny: string[] = []): Promise<SessionUser> {
  const base = { id: 'u1', email: 'u@x', name: 'سارة', role: 'CUSTOM', roleId: 'r1', status: 'ACTIVE', companyId: 'c1' } as unknown as SessionUser;
  return attachGrants(
    base,
    await computeEffectiveGrants(base as never, {
      roleRows: async () => roleKeys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
      overrideRows: async () => deny.map((k) => ({ permission: k, effect: 'DENY', scope: null, scopeIds: null })),
    })
  );
}

const json = (b: unknown, method: string) => new Request('http://x/api/control/blacklist', { method, body: JSON.stringify(b) });
const BLOCK = { phone: '0944555666', reason: 'طلب وهمي' };
const RELEASE = { blockId: '11111111-2222-4333-8444-555555555555', reason: 'تأكدنا' };

beforeEach(() => {
  vi.clearAllMocks();
  blockPhone.mockResolvedValue({ id: 'b1', phone: '0944555666', reason: 'طلب وهمي' });
  releaseBlock.mockResolvedValue({ id: 'b1', phone: '0944555666' });
});

async function as(roleKeys: string[], deny: string[] = []) {
  current.user = await person(roleKeys, deny);
  requireContext.mockResolvedValue({ user: current.user, companyId: 'c1' });
}

const DOORS = [
  { name: 'POST (block a number)', call: () => POST(json(BLOCK, 'POST')), wrote: () => blockPhone, ok: 201 },
  { name: 'PATCH (release a block)', call: () => PATCH(json(RELEASE, 'PATCH')), wrote: () => releaseBlock, ok: 200 },
];

describe.each(DOORS)('$name', ({ call, wrote, ok }) => {
  it('lets in who holds the manage key (and the list key it sits behind)', async () => {
    await as(['control.blacklist', 'control.blacklist_manage']);
    const res = await call();
    expect(res.status).toBe(ok);
    expect(wrote()).toHaveBeenCalledTimes(1);
  });

  it('NEGATIVE: refuses who only SEES the list — the old key no longer opens the write, and nothing is written', async () => {
    await as(['control.blacklist']);
    expect((await call()).status).toBe(403);
    expect(wrote()).not.toHaveBeenCalled();
  });

  it('the door asks ONLY its own key; the manage key without the list is a combination the roles door refuses to SAVE (the catalog says it requires the list)', async () => {
    await as(['control.blacklist_manage']);
    const res = await call();
    expect(res.status).toBe(ok);
    const { catalogItem } = await import('@/lib/permission-catalog');
    expect(catalogItem('control.blacklist_manage')!.requires).toBe('control.blacklist');
  });

  it('NEGATIVE: a «منع» on the manage key beats a role that carries it', async () => {
    await as(['control.blacklist', 'control.blacklist_manage'], ['control.blacklist_manage']);
    expect((await call()).status).toBe(403);
    expect(wrote()).not.toHaveBeenCalled();
  });
});

describe('the list itself is read with the old key alone', () => {
  it('GET answers 200 to who only sees the list, and 403 to who does not', async () => {
    await as(['control.blacklist']);
    expect((await GET(new Request('http://x/api/control/blacklist'))).status).toBe(200);
    await as(['control.blacklist_manage']);
    expect((await GET(new Request('http://x/api/control/blacklist'))).status).toBe(403);
  });
});
