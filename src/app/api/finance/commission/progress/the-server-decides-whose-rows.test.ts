import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * GET /api/finance/commission/progress — WHOSE ROWS IS DECIDED BY THE SERVER (perm-plan finding 58).
 *
 * The route read «mine=1» from the query string and dropped the other people's rows only when the CALLER asked:
 * anybody who left the flag off — a script, a second tab, a copied address — got every agent's running count.
 *
 *   · commission.view          → everybody's rows, whatever the query string says;
 *   · settings.view alone      → their OWN row, whatever the query string says (the door the route asked before:
 *                                nobody who could not open it can open it now);
 *   · neither                  → 403.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, held, USER } = vi.hoisted(() => ({
  db: { commissionRule: { findMany: vi.fn() }, user: { findMany: vi.fn() } },
  held: { keys: new Set<string>() },
  USER: { id: 'me', name: 'أنا', role: 'MODERATOR', status: 'ACTIVE', companyId: 'c1' },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: async () => ({ user: USER, companyId: 'c1', storeId: 's1' }) }));
vi.mock('@/lib/authorization', () => ({
  can: (_u: unknown, k: string) => held.keys.has(k),
  requirePermission: async (k: string) => {
    if (!held.keys.has(k)) throw new Error(`Forbidden: missing required permission ${k}`);
    return USER;
  },
}));
vi.mock('@/lib/commission-metrics', () => ({ measure: vi.fn(async (_db: unknown, _m: string, o: { userId: string }) => ({ count: o.userId === 'me' ? 4 : 9 })) }));

import { GET } from './route';

const RULE = {
  id: 'r1', name: 'قاعدة', metric: 'ORDERS_DELIVERED', period: 'DAILY', type: 'TIERED', tiers: null,
  appliesToUserId: null, appliesToRole: 'MODERATOR', productId: null, minOrders: null,
};

// the handler takes no argument any more (it ignores the query string); the tests still send one, to prove that
const handler = GET as unknown as (req: Request) => Promise<Response>;
const get = (qs = '') => handler(new Request(`http://localhost/api/finance/commission/progress${qs}`));
const ids = async (res: Response) => ((await res.json()).rows as Array<{ userId: string }>).map((r) => r.userId).sort();

beforeEach(() => {
  vi.clearAllMocks();
  held.keys = new Set();
  db.commissionRule.findMany.mockResolvedValue([RULE]);
  db.user.findMany.mockResolvedValue([
    { id: 'me', name: 'أنا' },
    { id: 'a', name: 'أحمد' },
    { id: 'b', name: 'باسل' },
  ]);
});

describe('the team’s rows', () => {
  it('commission.view sees everybody — with no flag at all', async () => {
    held.keys = new Set(['commission.view']);
    const res = await get();
    expect(res.status).toBe(200);
    expect(await ids(res)).toEqual(['a', 'b', 'me']);
  });

  it('and a «mine» in the query string changes NOTHING (the caller no longer decides)', async () => {
    held.keys = new Set(['commission.view']);
    expect(await ids(await get('?mine=1'))).toEqual(['a', 'b', 'me']);
    expect(await ids(await get('?mine=0'))).toEqual(['a', 'b', 'me']);
  });
});

describe('NEGATIVE: whoever lacks commission.view never gets another person’s row', () => {
  it('settings.view alone sees only their own — WITHOUT the flag (the old hole)', async () => {
    held.keys = new Set(['settings.view']);
    const res = await get();
    expect(res.status).toBe(200);
    expect(await ids(res)).toEqual(['me']);
  });

  it('and with «mine=0» asking for everybody, still only their own', async () => {
    held.keys = new Set(['settings.view']);
    expect(await ids(await get('?mine=0'))).toEqual(['me']);
  });

  it('no figure of anybody else is even measured for them', async () => {
    held.keys = new Set(['settings.view']);
    const { measure } = await import('@/lib/commission-metrics');
    await get();
    expect((measure as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[2] as { userId: string }).userId)).toEqual(['me']);
  });

  it('a person with neither key is refused outright', async () => {
    held.keys = new Set(['orders.view', 'finance.view', 'settings.edit']);
    expect((await get()).status).toBe(403);
    expect(db.commissionRule.findMany).not.toHaveBeenCalled();
  });
});

describe('the door’s source', () => {
  it('does not read the query string any more', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/app/api/finance/commission/progress/route.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(src).not.toContain('searchParams');
    expect(src).not.toMatch(/\bmine\b/);
    expect(src).toContain(`can(user, 'commission.view')`);
  });
});
