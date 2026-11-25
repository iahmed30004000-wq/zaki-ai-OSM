import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * «قايمة الاسترجاع» (F12, the owner's ruling 25/11): her list, and the 1 ↔ 3 pieces switch — a narrow door. People are built by the
 * engine; the database is a small fake.
 *
 *   · the price is the owner's setting, never the request's (any other field in the body is refused);
 *   · only the list holder or a manager; only a list order; only before confirmation;
 *   · one line, the pieces, no gift, no discount, delivery included; the total IS the setting, to the minor unit.
 */
const { state, db, logAudit } = vi.hoisted(() => {
  const state = {
    viewer: null as unknown as SessionUser,
    order: null as Record<string, any> | null,
    prices: {} as Record<string, unknown>,
    updates: [] as any[],
    lines: [] as any[],
    deleted: 0,
    listRows: [] as any[],
    listWhere: null as any,
  };
  const db: any = {
    company: { findUnique: vi.fn(async () => ({ settings: JSON.stringify({ winbackPrices: state.prices }) })) },
    order: {
      findFirst: vi.fn(async () => state.order),
      findMany: vi.fn(async ({ where }: any) => ((state.listWhere = where), state.listRows)),
      updateMany: vi.fn(async (a: any) => (state.updates.push(a), { count: 1 })),
    },
    orderItem: {
      deleteMany: vi.fn(async () => ((state.deleted += 1), { count: 1 })),
      create: vi.fn(async ({ data }: any) => (state.lines.push(data), data)),
    },
    productFixedCost: { findMany: vi.fn(async () => [{ productId: 'scar', amount: 2 }]) },
    productionBatch: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return { state, db, logAudit: vi.fn() };
});
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({ user: state.viewer, companyId: 'c1', storeId: 's1', country: { currencyCode: 'USD', minorUnit: 2 } }),
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
import { PATCH } from './[id]/route';
import { GET } from './route';

async function person(id: string, keys: string[]): Promise<SessionUser> {
  const base = { id, email: `${id}@x`, name: id, role: 'CONFIRMATION_AGENT', roleId: 'r', status: 'ACTIVE', companyId: 'c1', permissions: [] } as unknown as SessionUser;
  return attachGrants(base, await computeEffectiveGrants(base as never, { roleRows: async () => keys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })), overrideRows: async () => [] }));
}
const AGENT = ['confirmation.work', 'confirmation.pull', 'orders.confirm', 'orders.view'];
const MANAGER = ['confirmation.supervise', 'confirmation.winback', 'orders.assign', 'orders.view'];
const patch = async (body: unknown) => {
  const res = await PATCH(new Request('http://localhost/x', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'w1' }) });
  return { status: res.status, body: (await res.json()) as any };
};
const listOrder = (over: Record<string, unknown> = {}) => ({
  id: 'w1', version: 4, orderNumber: 'WB-1', productId: 'scar', currency: 'USD', quantity: 3, totalAmount: 20,
  confirmationStatus: 'NEW', shippingStatus: 'NOT_READY', shippingBatchId: null, claimedById: 'sara',
  winbackListAt: new Date('2026-11-25T10:00:00Z'), winbackListUserId: 'sara',
  items: [{ productId: 'scar', productName: 'كريم' }],
  // the cancelled order it stands for: 6 pieces that cost 30 — 5 a piece when the product has no fixed figure
  replaces: { estimatedCostOfGoods: 30, quantity: 6, freeQuantity: 0, items: [] },
  ...over,
});

beforeEach(async () => {
  vi.clearAllMocks();
  Object.assign(state, { order: listOrder(), prices: { scar: { one: 12, three: 20, currency: 'USD' } }, updates: [], lines: [], deleted: 0, listRows: [], listWhere: null });
  state.viewer = await person('sara', AGENT);
});

describe('the switch', () => {
  it('her list order goes from 3 pieces to 1 at the single price — one line, no gift, no discount, delivery included — and back', async () => {
    const r = await patch({ pieces: 1 });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, pieces: 1, total: 12 });
    expect(state.updates[0].where).toMatchObject({ id: 'w1', version: 4, confirmationStatus: { in: expect.arrayContaining(['NEW']) }, shippingStatus: 'NOT_READY', shippingBatchId: null });
    expect(state.updates[0].data).toMatchObject({ quantity: 1, freeQuantity: 0, sellingPrice: 12, discountAmount: 0, totalAmount: 12, priceIncludesDelivery: true, estimatedCostOfGoods: 2 });
    expect(state.deleted).toBe(1);
    expect(state.lines).toEqual([expect.objectContaining({ productId: 'scar', quantity: 1, freeQuantity: 0, unitPrice: 12, discountShare: 0, lineTotal: 12 })]);
    const back = await patch({ pieces: 3 });
    expect(back.body).toEqual({ ok: true, pieces: 3, total: 20 });
    expect(state.updates[1].data).toMatchObject({ quantity: 3, totalAmount: 20, estimatedCostOfGoods: 6 });
    expect(state.lines[1].lineTotal).toBe(20);
  });

  it('a price, a total or any other field in the body is refused — the price comes only from the settings', async () => {
    for (const body of [{ pieces: 1, price: 1 }, { pieces: 1, total: 1 }, { pieces: 2 }, { pieces: '1' }, {}]) {
      const r = await patch(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.code).toBe('INVALID_PIECES');
    }
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('only the list holder or a manager: a colleague is refused', async () => {
    state.viewer = await person('huda', AGENT);
    expect((await patch({ pieces: 1 })).status).toBe(403);
    state.viewer = await person('mgr', MANAGER);
    expect((await patch({ pieces: 1 })).status).toBe(200);
  });

  it('only a list order, only before confirmation, only with a price in the order’s currency', async () => {
    state.order = listOrder({ winbackListAt: null });
    expect((await patch({ pieces: 1 })).body.code).toBe('NOT_A_LIST_ORDER');
    state.order = listOrder({ confirmationStatus: 'CONFIRMED' });
    expect((await patch({ pieces: 1 })).body.code).toBe('NOT_PENDING');
    state.order = listOrder({ shippingBatchId: 'b1' });
    expect((await patch({ pieces: 1 })).body.code).toBe('NOT_PENDING');
    state.order = listOrder({ currency: 'SYP' });
    expect((await patch({ pieces: 1 })).body.code).toBe('NO_WINBACK_PRICE');
    state.order = listOrder();
    state.prices = {};
    expect((await patch({ pieces: 1 })).body.code).toBe('NO_WINBACK_PRICE');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });
});

describe('the switch holds the cost floor for the NEW pieces (the coordinator, 25/11)', () => {
  it('no fixed figure: the old order per piece (30 / 6 = 5) × the new pieces — 3→1 costs 5 and passes; 1→3 costs 15 and passes', async () => {
    db.productFixedCost.findMany.mockResolvedValue([]);
    expect((await patch({ pieces: 1 })).status).toBe(200);
    expect(state.updates[0].data.estimatedCostOfGoods).toBe(5);
    expect((await patch({ pieces: 3 })).status).toBe(200);
    expect(state.updates[1].data.estimatedCostOfGoods).toBe(15);
    db.productFixedCost.findMany.mockResolvedValue([{ productId: 'scar', amount: 2 }]);
  });

  it('a switch the floor refuses: 7 a piece makes 3 pieces cost 21 > 20 (1→3 refused); 13 a piece makes 1 cost 13 > 12 (3→1 refused)', async () => {
    db.productFixedCost.findMany.mockResolvedValue([{ productId: 'scar', amount: 7 }]);
    state.order = listOrder({ quantity: 1, totalAmount: 12 });
    const up = await patch({ pieces: 3 });
    expect(up.status).toBe(409);
    expect(up.body.code).toBe('PRICE_BELOW_COST');
    db.productFixedCost.findMany.mockResolvedValue([{ productId: 'scar', amount: 13 }]);
    state.order = listOrder();
    const down = await patch({ pieces: 1 });
    expect(down.body.code).toBe('PRICE_BELOW_COST');
    expect(db.order.updateMany).not.toHaveBeenCalled();
    db.productFixedCost.findMany.mockResolvedValue([{ productId: 'scar', amount: 2 }]);
  });
});

describe('her list', () => {
  it('reads only HER open list rows in this store, with the two prices and the old quantity as information', async () => {
    state.listRows = [
      {
        id: 'w1', orderNumber: 'WB-1', productId: 'scar', productNameSnapshot: 'كريم', quantity: 3, totalAmount: 20, currency: 'USD', confirmationStatus: 'NEW',
        winbackListAt: new Date('2026-11-25T10:00:00Z'), _count: { contactAttempts: 0 },
        replaces: { orderNumber: 'ORD-9', quantity: 6, freeQuantity: 0, items: [] },
      },
    ];
    const res = await GET(new Request('http://localhost/api/confirmation/winback/list'));
    const body = (await res.json()) as any;
    expect(state.listWhere).toMatchObject({ companyId: 'c1', storeId: 's1', winbackListUserId: 'sara', claimedById: 'sara' });
    expect(body.rows[0]).toMatchObject({ pieces: 3, total: 20, oldOrderNumber: 'ORD-9', oldPieces: 6, options: { one: 12, three: 20 }, touched: false, leavesAt: '2026-11-28T10:00:00.000Z' });
    expect(JSON.stringify(body)).not.toMatch(/phone|fullName|address/);
  });

  it('another agent’s list is a manager’s to read only', async () => {
    const res = await GET(new Request('http://localhost/api/confirmation/winback/list?agentId=huda'));
    expect(res.status).toBe(403);
    state.viewer = await person('mgr', [...MANAGER, 'confirmation.work']);
    await GET(new Request('http://localhost/api/confirmation/winback/list?agentId=huda'));
    expect(state.listWhere).toMatchObject({ winbackListUserId: 'huda', claimedById: 'huda' });
  });
});
