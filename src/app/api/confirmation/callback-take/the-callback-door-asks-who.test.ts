import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * «الزبون على الخط» — THE DOOR: who may knock, how often, and what it hands the rule (`customer-on-the-line.ts`, tested on its own).
 *
 * Through the REAL permission engine: the three keys an agent works with (`confirmation.pull`, `confirmation.work`, `orders.view`)
 * open it; any one missing is a 403 before anything is read. The search is counted per person, and the envelope passed to the rule
 * is her own `orderVisibilityWhere`, never a wider one. And the claim-by-number door is untouched: it still answers her `USE_THE_PULL`.
 */

const { requireContext, current, search, take } = vi.hoisted(() => ({
  requireContext: vi.fn(),
  current: { user: null as unknown as SessionUser },
  search: vi.fn(),
  take: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/customer-on-the-line', async (orig) => ({
  ...(await orig<typeof import('@/lib/customer-on-the-line')>()),
  searchOnTheLine: (...a: unknown[]) => search(...a),
  takeOnTheLine: (...a: unknown[]) => take(...a),
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
import { GET, POST } from './route';
import { CALLBACK_SEARCHES_PER_WINDOW } from '@/lib/customer-on-the-line';

let n = 0;
async function as(keys: string[], scope: 'ALL_COMPANY' | 'ASSIGNED' = 'ALL_COMPANY') {
  // A fresh id per test, so the per-person search count of one test never leaks into the next.
  const base = { id: `u${++n}`, email: 'u@x', name: 'سارة', role: 'CUSTOM', roleId: 'r1', status: 'ACTIVE', companyId: 'c1' } as unknown as SessionUser;
  current.user = attachGrants(
    base,
    await computeEffectiveGrants(base as never, {
      roleRows: async () => keys.map((k) => ({ permission: k, scope: k === 'orders.view' ? scope : 'ALL_COMPANY', scopeIds: null })),
      overrideRows: async () => [],
    })
  );
  requireContext.mockResolvedValue({ user: current.user, companyId: 'c1', storeId: 's1', country: { code: 'SY' } });
}

const AGENT = ['confirmation.pull', 'confirmation.work', 'orders.view', 'orders.confirm', 'orders.claim', 'confirmation.supervise'];
const find = (phone = '0966793918') => GET(new Request(`http://x/api/confirmation/callback-take?phone=${encodeURIComponent(phone)}`));
const press = (orderId: unknown = 'o1') =>
  POST(new Request('http://x/api/confirmation/callback-take', { method: 'POST', body: JSON.stringify({ orderId }), headers: { 'Content-Type': 'application/json' } }));

beforeEach(() => {
  vi.clearAllMocks();
  search.mockResolvedValue([]);
  take.mockResolvedValue({ ok: true, orderId: 'o1', orderNumber: 'ORD-1' });
});

describe('who may knock', () => {
  it('the live agent (pull + work + «عرض الطلبات») — past the gate on both verbs', async () => {
    await as(AGENT);
    expect((await find()).status).toBe(200);
    expect((await press()).status).toBe(201);
  });

  it.each(['confirmation.pull', 'confirmation.work', 'orders.view'])('NEGATIVE: without %s — 403, and nothing is read or taken', async (missing) => {
    await as(AGENT.filter((k) => k !== missing));
    expect((await find()).status).toBe(403);
    expect((await press()).status).toBe(403);
    expect(search).not.toHaveBeenCalled();
    expect(take).not.toHaveBeenCalled();
  });

  it('hands the rule HER envelope: an ASSIGNED «عرض الطلبات» is passed narrowed, never as the whole store', async () => {
    await as(AGENT, 'ASSIGNED');
    await find();
    await press();
    for (const call of [search.mock.calls[0][1], take.mock.calls[0][0]]) {
      expect(call.visibility).not.toEqual({});
      expect(call.scope).toEqual({ companyId: 'c1', storeId: 's1' });
    }
  });
});

describe('what it says', () => {
  it('a number too short to be one — 400 with the reason', async () => {
    await as(AGENT);
    search.mockResolvedValue(null);
    const res = await find('12');
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('PHONE_TOO_SHORT');
  });

  it(`counts her searches: the ${CALLBACK_SEARCHES_PER_WINDOW + 1}th in the window is 429, and is not run`, async () => {
    await as(AGENT);
    for (let i = 0; i < CALLBACK_SEARCHES_PER_WINDOW; i++) expect((await find()).status).toBe(200);
    const res = await find();
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe('SEARCH_LIMIT');
    expect(search).toHaveBeenCalledTimes(CALLBACK_SEARCHES_PER_WINDOW);
  });

  it('a refusal travels with its code and the colleague’s name', async () => {
    await as(AGENT);
    take.mockResolvedValue({ ok: false, code: 'HELD_BY_COLLEAGUE', message: 'الطلب مع هند', heldBy: 'هند' });
    const res = await press();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'HELD_BY_COLLEAGUE', heldBy: 'هند', errorAr: 'الطلب مع هند' });
  });

  it('no order id — 404, and the rule is not asked', async () => {
    await as(AGENT);
    expect((await press(42)).status).toBe(404);
    expect(take).not.toHaveBeenCalled();
  });
});

describe('the claim-by-number door is as it was', () => {
  it('still sends the bound agent to the pull', async () => {
    const src = (await import('node:fs')).readFileSync(
      (await import('node:path')).join(process.cwd(), 'src/app/api/orders/[id]/claim/route.ts'),
      'utf8'
    );
    expect(src).toMatch(/if \(mustHoldToWork\(\(permission\) => can\(user, permission\)\)\) \{[\s\S]{0,200}USE_THE_PULL_CODE/);
  });
});
