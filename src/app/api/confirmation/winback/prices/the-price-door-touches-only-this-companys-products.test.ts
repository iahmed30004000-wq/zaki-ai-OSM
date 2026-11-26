import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * «أسعار الاسترجاع» (F12): the PUT door sets a price only for a product of THIS company (B23 of the review), under `offers.rules`,
 * and the GET /bulk door offers the card only to who holds `orders.assign` (B25). People are built by the engine.
 */
const { state, db, save, logAudit } = vi.hoisted(() => {
  const state = { viewer: null as unknown as SessionUser, products: [] as { id: string; companyId: string }[], productWheres: [] as any[] };
  const db: any = {
    company: { findUnique: vi.fn(async () => ({ settings: '{}' })) },
    product: {
      findFirst: vi.fn(async ({ where }: any) => {
        state.productWheres.push(where);
        return state.products.find((p) => p.id === where.id && (where.companyId === undefined || p.companyId === where.companyId)) ?? null;
      }),
      findMany: vi.fn(async () => []),
    },
  };
  return { state, db, save: vi.fn(async (_c: string, id: string, price: unknown) => ({ [id]: price })), logAudit: vi.fn() };
});
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/winback-prices', async (orig) => ({ ...(await orig<typeof import('@/lib/winback-prices')>()), saveWinbackPrice: (...a: [string, string, unknown]) => save(...a) }));
vi.mock('@/lib/winback-bulk', async (orig) => ({ ...(await orig<typeof import('@/lib/winback-bulk')>()), bulkAgents: async () => [{ id: 'sara', name: 'سارة', room: 5 }] }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({ user: state.viewer, companyId: 'c1', storeId: 's1', countryId: 'co1', country: { currencyCode: 'USD', minorUnit: 2 } }),
}));
vi.mock('@/lib/authorization', async (orig) => {
  const real = await orig<typeof import('@/lib/authorization')>();
  return {
    ...real,
    requirePermission: async (k: string) => {
      if (!real.can(state.viewer, k)) throw new Error(`Forbidden: missing required permission ${k}`);
      return state.viewer;
    },
  };
});

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { PUT } from './route';
import { GET as bulkGET } from '../bulk/route';

async function person(keys: string[]): Promise<SessionUser> {
  const base = { id: 'u', email: 'u@x', name: 'x', role: 'MANAGER', roleId: 'r', status: 'ACTIVE', companyId: 'c1', permissions: [] } as unknown as SessionUser;
  return attachGrants(base, await computeEffectiveGrants(base as never, { roleRows: async () => keys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })), overrideRows: async () => [] }));
}
const put = async (body: unknown) => {
  const res = await PUT(new Request('http://localhost/x', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as any };
};

beforeEach(async () => {
  vi.clearAllMocks();
  state.products = [
    { id: 'mine', companyId: 'c1' },
    { id: 'theirs', companyId: 'c2' },
  ];
  state.productWheres = [];
  state.viewer = await person(['settings.view', 'offers.rules', 'confirmation.supervise', 'confirmation.winback']);
});

describe('the price door', () => {
  it('sets a price for this company’s product', async () => {
    const r = await put({ productId: 'mine', one: 12, three: 20, currency: 'USD' });
    expect(r.status).toBe(200);
    expect(save).toHaveBeenCalledWith('c1', 'mine', { one: 12, three: 20, currency: 'USD' });
  });

  it('B23 — another company’s product is «not found», and nothing is saved', async () => {
    const r = await put({ productId: 'theirs', one: 12, three: 20, currency: 'USD' });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('PRODUCT');
    expect(save).not.toHaveBeenCalled();
    expect(state.productWheres[0]).toMatchObject({ id: 'theirs', companyId: 'c1' });
  });

  it('without `offers.rules` it is refused before anything is read', async () => {
    state.viewer = await person(['confirmation.supervise', 'confirmation.winback']);
    const r = await put({ productId: 'mine', one: 12, three: 20, currency: 'USD' });
    expect(r.status).toBe(403);
    expect(db.product.findFirst).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
});

describe('B25 — the card is offered only to who holds orders.assign', () => {
  it('the agent’s keys (offer + confirmation.reassign) get canBulk false; a manager’s get the agents', async () => {
    state.viewer = await person(['confirmation.supervise', 'confirmation.winback', 'confirmation.reassign', 'confirmation.pull', 'orders.confirm']);
    const a = await (await bulkGET()).json();
    expect(a).toEqual({ canBulk: false, storeRequired: false });
    state.viewer = await person(['confirmation.supervise', 'confirmation.winback', 'orders.assign']);
    const b = await (await bulkGET()).json();
    expect(b.canBulk).toBe(true);
    expect(b.agents).toEqual([{ id: 'sara', name: 'سارة', room: 5 }]);
  });
});
