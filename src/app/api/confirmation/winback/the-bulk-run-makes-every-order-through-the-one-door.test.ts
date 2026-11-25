import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE (F12, 25/11) — «وزّع على الموظفات» through the REAL door (`POST /api/confirmation/winback` with an `action`).
 *
 * Permissions are NOT mocked: every person is built as her session builds her (`computeEffectiveGrants` → `attachGrants` → the real
 * `can`). The database is a small fake that answers the door's own questions. The agents' list and rooms (`bulkAgents`: the audience
 * and the cap, read through functions with their own tests) is stubbed.
 *
 *   1. manager only: the agent's live keys (the offer's box AND `confirmation.reassign`) are a 403, and nothing is read;
 *   2. an order cancelled 20 days ago (far past the daily list's 72 hours) is made and held for its agent;
 *   3. the new order's TOTAL is the owner's win-back price (delivery included), whatever price or discount the body carries;
 *   4. a second press with the same ids makes nothing; a race the database refuses is reported on its row;
 *   5. a customer with a live order, one who cancelled twice, a product with no price, two products: none is made;
 *   6. the cancelled order is never written; the logs carry no customer field.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Src = {
  id: string;
  orderNumber: string;
  customerId: string;
  createdAt: Date;
  lostAt: Date;
  rejectionReason: string;
  confirmationStatus: string;
  items: { productId: string; productName: string; quantity: number; freeQuantity: number; unitPrice: number }[];
  discountAmount?: number;
  cost?: number;
  currency?: string;
};

const { state, db, logAudit } = vi.hoisted(() => {
  const state = {
    viewer: null as unknown as SessionUser,
    storeId: 's1' as string | null,
    sources: [] as Src[],
    /** Other orders of the customers: earlier cancellations, deliveries. */
    history: [] as { customerId: string; confirmationStatus: string; rejectionReason: string | null; shippingStatus: string; replacesOrderId: string | null; createdAt: Date; lostAt: Date | null }[],
    live: [] as { customerId: string; confirmationStatus: string; shippingStatus: string; claimedById: string | null; shippedAt: Date | null }[],
    prices: {} as Record<string, unknown>,
    offered: new Map<string, string>(),
    created: [] as Record<string, any>[],
    lines: [] as Record<string, any>[],
    holds: [] as Record<string, any>[],
    race: false,
    n: 0,
    minor: 2,
    team: [] as SessionUser[],
    candidateCalls: [] as any[],
    liveCalls: [] as any[],
    audienceCalls: [] as any[],
    countScopes: [] as any[],
  };
  const ids = (where: unknown): string[] | null => {
    const m = /"id":\{"in":(\[[^\]]*\])/.exec(JSON.stringify(where));
    return m ? (JSON.parse(m[1]) as string[]) : null;
  };
  const customersIn = (where: any): string[] => where?.customerId?.in ?? [];
  const srcRow = (s: Src) => ({
    ...s,
    storeId: 's1', countryId: 'co1', regionId: 'r1', currency: s.currency ?? 'USD', productId: s.items[0].productId,
    quantity: s.items.reduce((n, l) => n + l.quantity, 0), freeQuantity: 0,
    sellingPrice: s.items.reduce((n, l) => n + l.quantity * l.unitPrice, 0), discountAmount: s.discountAmount ?? 0, shippingCost: 0,
    priceIncludesDelivery: false, productNameSnapshot: s.items[0].productName, productImageSnapshot: null,
    moderatorId: null, estimatedCostOfGoods: s.cost ?? 1, source: 'Manual', customerNotes: null,
    shippedAt: null, shippingStatus: 'NOT_READY', offerId: null,
  });
  const db: any = {
    company: { findUnique: vi.fn(async () => ({ settings: JSON.stringify({ winbackPrices: state.prices }) })) },
    order: {
      findMany: vi.fn(async ({ where, select, orderBy }: any) => {
        if (select?.items) {
          state.candidateCalls.push({ where, orderBy });
          const only = ids(where);
          const dir = orderBy?.[0]?.createdAt === 'desc' ? -1 : 1;
          return state.sources
            .filter((s) => !state.offered.has(s.id) && (!only || only.includes(s.id)))
            .sort((a, b) => dir * (a.createdAt.getTime() - b.createdAt.getTime()))
            .map((s) => ({ ...srcRow(s), items: s.items.map((l) => ({ productId: l.productId, quantity: l.quantity, freeQuantity: l.freeQuantity })) }));
        }
        if (select?.statusLogs) {
          const want = customersIn(where);
          return [
            ...state.sources.map((s) => ({ customerId: s.customerId, confirmationStatus: s.confirmationStatus, rejectionReason: s.rejectionReason, shippingStatus: 'NOT_READY', replacesOrderId: null, createdAt: s.createdAt, statusLogs: [{ createdAt: s.lostAt }] })),
            ...state.history.map((h) => ({ ...h, statusLogs: h.lostAt ? [{ createdAt: h.lostAt }] : [] })),
          ].filter((r) => want.includes(r.customerId));
        }
        if (select?.claimedById !== undefined) state.liveCalls.push(where);
        if (select?.claimedById !== undefined) return state.live.filter((r) => customersIn(where).includes(r.customerId));
        return [];
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        const s = state.sources.find((x) => x.id === where.id);
        if (!s) return null;
        const offered = state.offered.get(s.id);
        return { ...srcRow(s), replacedBy: offered && !state.race ? { orderNumber: offered } : null, replaces: null, returnReceipt: null };
      }),
      create: vi.fn(async ({ data }: any) => {
        if (state.offered.has(data.replacesOrderId)) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        const id = `new-${++state.n}`;
        state.offered.set(data.replacesOrderId, data.orderNumber);
        state.created.push({ ...data, id });
        return { id, orderNumber: data.orderNumber };
      }),
      update: vi.fn(),
      updateMany: vi.fn(async (args: any) => {
        state.holds.push(args);
        return { count: 1 };
      }),
    },
    orderItem: {
      findMany: vi.fn(async ({ where }: any) => state.sources.find((s) => s.id === where.orderId)?.items ?? []),
      createMany: vi.fn(async ({ data }: any) => {
        state.lines.push(...data);
        return { count: data.length };
      }),
    },
    orderStatusLog: {
      findFirst: vi.fn(async ({ where }: any) => ({ createdAt: state.sources.find((s) => s.id === where.orderId)!.lostAt })),
      findMany: vi.fn(async () => []),
    },
    orderNote: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
    productFixedCost: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return { state, db, logAudit: vi.fn() };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: vi.fn() }));
vi.mock('@/lib/order-ref', () => ({ orderRefFields: async () => ({ orderNumber: `WB-${state.n + 1}`, merchantRef: `WB-${state.n + 1}` }) }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({
    user: state.viewer,
    companyId: 'c1',
    storeId: state.storeId,
    countryId: 'co1',
    country: { id: 'co1', code: 'SY', currencyCode: 'USD', minorUnit: state.minor, orderPrefix: 'ORD', allowNegativeStock: false },
  }),
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
// The agents: the REAL `bulkAgents` (store, `mayBeHandedAnOrder`, the room) over a stubbed audience and stubbed counts — the people are built by the engine.
vi.mock('@/lib/notification-audience', () => ({
  resolveAudience: async (q: any) => {
    state.audienceCalls.push(q);
    return q.storeId === 's1' && q.audience?.permission === 'confirmation.pull' ? state.team : [];
  },
}));
vi.mock('@/lib/confirmation-queue', async (orig) => ({
  ...(await orig<typeof import('@/lib/confirmation-queue')>()),
  returnsModeOn: async () => false,
  ownedCounts: async (_tx: unknown, scope: unknown) => {
    state.countScopes.push(scope);
    return { total: 0, heldForHer: 0, withoutAttempt: 0, untouched: null };
  },
}));
vi.mock('@/lib/confirmation-rule-settings', async (orig) => ({ ...(await orig<typeof import('@/lib/confirmation-rule-settings')>()), confirmationRuleOnce: () => ({}) }));
vi.mock('@/lib/employee-numbers', async (orig) => ({ ...(await orig<typeof import('@/lib/employee-numbers')>()), confirmationRulesOnce: () => ({}) }));

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { POST } from './route';

/** CONFIRMATION_AGENT as read on the live site 1/11: the offer's box and `confirmation.reassign`, no `orders.assign`. */
const LIVE_AGENT = [
  'confirmation.pull', 'confirmation.reassign', 'confirmation.supervise', 'confirmation.winback', 'confirmation.work',
  'orders.claim', 'orders.confirm', 'orders.contact_log', 'orders.release', 'orders.view',
];
const MANAGER = ['confirmation.supervise', 'confirmation.winback', 'orders.assign', 'orders.view'];

async function person(keys: string[], opts: { role?: string; roleId?: string | null; deny?: string[]; id?: string; name?: string } = {}): Promise<SessionUser> {
  const base = { id: opts.id ?? 'mgr', email: 'm@x', name: opts.name ?? 'المديرة', role: opts.role ?? 'MANAGER', roleId: opts.roleId === undefined ? 'r1' : opts.roleId, status: 'ACTIVE', companyId: 'c1', permissions: [] } as unknown as SessionUser;
  return attachGrants(
    base,
    await computeEffectiveGrants(base as never, {
      roleRows: async () => keys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
      overrideRows: async () => (opts.deny ?? []).map((p) => ({ permission: p, effect: 'DENY', scope: null, scopeIds: null })),
    })
  );
}

const post = async (body: unknown) => {
  const res = await POST(new Request('http://localhost/api/confirmation/winback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as any };
};
const preview = (extra: Record<string, unknown> = {}) => post({ action: 'bulk-preview', count: 200, agentIds: ['sara', 'huda'], ...extra });
const run = (orderIds: string[], extra: Record<string, unknown> = {}) => post({ action: 'bulk-run', orderIds, agentIds: ['sara', 'huda'], ...extra });

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const SCAR = { productId: 'scar', productName: 'كريم', unitPrice: 15, freeQuantity: 0 };
const src = (i: number, over: Partial<Src> = {}): Src => ({
  id: uuid(i),
  orderNumber: `ORD-${i}`,
  customerId: `cust-${i}`,
  createdAt: ago(30 - i / 100),
  lostAt: ago(20),
  rejectionReason: 'PRICE_TOO_HIGH',
  confirmationStatus: 'CANCELLED',
  items: [{ ...SCAR, quantity: 3 }],
  ...over,
});

beforeEach(async () => {
  vi.clearAllMocks();
  Object.assign(state, { storeId: 's1', sources: [], history: [], live: [], offered: new Map(), created: [], lines: [], holds: [], race: false, n: 0, minor: 2, candidateCalls: [], liveCalls: [], audienceCalls: [], countScopes: [] });
  state.team = [
    await person(LIVE_AGENT, { id: 'sara', name: 'سارة', role: 'CONFIRMATION_AGENT' }),
    await person(LIVE_AGENT, { id: 'huda', name: 'هدى', role: 'CONFIRMATION_AGENT' }),
    // can pull and work, but may not confirm: never handed an order (`mayBeHandedAnOrder`)
    await person(['confirmation.pull', 'confirmation.work', 'orders.view'], { id: 'wael', name: 'وائل', role: 'FOLLOW_UP_AGENT' }),
  ];
  state.prices = { scar: { one: 12, three: 20, currency: 'USD' } };
  state.viewer = await person(MANAGER);
});

describe('1 — manager only, read the way the session reads her', () => {
  it('the agent’s live keys (the offer AND confirmation.reassign, no orders.assign) are refused, and nothing is read', async () => {
    state.viewer = await person(LIVE_AGENT, { role: 'CONFIRMATION_AGENT' });
    state.sources = [src(1)];
    expect((await preview()).status).toBe(403);
    expect((await run([uuid(1)])).status).toBe(403);
    expect(db.order.findMany).not.toHaveBeenCalled();
    expect(db.order.create).not.toHaveBeenCalled();
  });

  it('a manager whose orders.assign is denied personally is refused too; with it, she passes', async () => {
    state.viewer = await person(MANAGER, { deny: ['orders.assign'] });
    expect((await preview()).status).toBe(403);
    state.viewer = await person(MANAGER);
    expect((await preview()).status).toBe(200);
  });

  it('a legacy account (no role row) is read through the same engine: the door answers what `can` answers', async () => {
    const { can } = await import('@/lib/authorization');
    for (const role of ['CONFIRMATION_AGENT', 'FOLLOW_UP_AGENT', 'MANAGER', 'ADMIN']) {
      state.viewer = await person([], { role, roleId: null });
      const allowed = can(state.viewer, 'confirmation.winback') && can(state.viewer, 'orders.assign');
      expect((await preview()).status === 200, role).toBe(allowed);
    }
    // the agent of the old matrix never gets it
    state.viewer = await person([], { role: 'CONFIRMATION_AGENT', roleId: null });
    expect((await preview()).status).toBe(403);
  });

  it('without a store the run is refused in Arabic', async () => {
    state.storeId = null;
    const r = await preview();
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('STORE_REQUIRED');
  });
});

describe('2–3 — the run makes the order through the one creator, at the owner’s price', () => {
  it('an order cancelled 20 days ago is made and held for its agent; the TOTAL is the win-back price, delivery included', async () => {
    state.sources = [src(1), src(2, { items: [{ ...SCAR, quantity: 1 }] })];
    const plan = await preview();
    expect(plan.status).toBe(200);
    expect(plan.body.planned.map((p: any) => [p.orderId, p.agentId, p.price])).toEqual([
      [uuid(2), 'sara', 12],
      [uuid(1), 'huda', 20],
    ]);
    expect(db.order.create).not.toHaveBeenCalled(); // the preview writes nothing

    const r = await run(plan.body.planned.map((p: any) => p.orderId));
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(2);
    const byOld = (id: string) => state.created.find((c) => c.replacesOrderId === id)!;
    expect(byOld(uuid(1)).totalAmount).toBe(20); // 3 × 15 = 45 → 20
    expect(byOld(uuid(1)).discountAmount).toBe(25);
    expect(byOld(uuid(2)).totalAmount).toBe(12); // 1 × 15 = 15 → 12
    for (const c of state.created) {
      expect(c.priceIncludesDelivery).toBe(true);
      expect(c.confirmationStatus).toBe('NEW');
      expect(c.shippingCost).toBe(0);
    }
    // the lines carry the same goods, and their totals add up to the price
    const linesOf1 = state.lines.filter((l) => l.orderId === state.created.find((c) => c.replacesOrderId === uuid(1))!.id);
    expect(linesOf1.map((l) => [l.quantity, l.unitPrice, l.lineTotal])).toEqual([[3, 15, 20]]);
    // held for her: her name on an order nobody holds — one conditional write per new order, never a claim
    expect(state.holds.map((h) => [h.where.id, h.data.assignedToId])).toEqual([
      [state.created[0].id, 'sara'],
      [state.created[1].id, 'huda'],
    ]);
    for (const h of state.holds) {
      expect(h.where).toMatchObject({ claimedById: null, assignedToId: null, confirmationStatus: 'NEW' });
      expect(h.data.claimedById).toBeUndefined();
    }
    // and the cancelled order is never written
    expect(db.order.update).not.toHaveBeenCalled();
    expect(state.holds.some((h) => h.where.id === uuid(1) || h.where.id === uuid(2))).toBe(false);
  });

  it('a price or a discount in the body is never read', async () => {
    state.sources = [src(1)];
    const plan = await preview({ price: 1, discount: 40 });
    expect(plan.body.planned[0].price).toBe(20);
    const r = await run([uuid(1)], { price: 1, discount: 40, priced: { price: 1 } });
    expect(r.body.created).toBe(1);
    expect(state.created[0].totalAmount).toBe(20);
  });

  it('the single press keeps its ceiling: a typed discount above the rule’s share is still refused', async () => {
    state.sources = [src(1)];
    const r = await post({ orderId: uuid(1), discount: 25 });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('DISCOUNT_TOO_LARGE');
  });

  it('a price above what the order cost is refused on its row, never turned into a surcharge', async () => {
    state.prices = { scar: { one: 16, three: 50, currency: 'USD' } };
    state.sources = [src(1)];
    const plan = await preview();
    expect(plan.body.planned).toEqual([]);
    expect(plan.body.skipped).toEqual([expect.objectContaining({ code: 'PRICE_NOT_LOWER', count: 1 })]);
  });
});

describe('4 — safe to press twice', () => {
  it('the same ids pressed again make nothing', async () => {
    state.sources = [src(1), src(2)];
    const ids = [uuid(1), uuid(2)];
    expect((await run(ids)).body.created).toBe(2);
    const again = await run(ids);
    expect(again.body.created).toBe(0);
    expect(again.body.results.map((r: any) => r.code)).toEqual(['NOT_IN_POOL', 'NOT_IN_POOL']);
    expect(state.created).toHaveLength(2);
  });

  it('two managers at once: the database refuses the second, and the row says so', async () => {
    state.sources = [src(1)];
    state.offered.set(uuid(1), 'WB-0'); // the other press got there first…
    state.race = true; // …after this one read the pool
    db.order.findMany.mockImplementationOnce(async () => [
      { id: uuid(1), orderNumber: 'ORD-1', customerId: 'cust-1', currency: 'USD', productId: 'scar', quantity: 3, freeQuantity: 0, sellingPrice: 45, discountAmount: 0, items: [{ productId: 'scar', quantity: 3, freeQuantity: 0 }] },
    ]);
    const r = await run([uuid(1)]);
    expect(r.body.created).toBe(0);
    expect(r.body.results[0]).toMatchObject({ ok: false, code: 'ALREADY_OFFERED' });
  });
});

describe('5 — who is not offered', () => {
  it('a customer with a live order is skipped (the duplicate guard), at the plan and again at the press', async () => {
    state.sources = [src(1), src(2)];
    state.live = [{ customerId: 'cust-1', confirmationStatus: 'NEW', shippingStatus: 'NOT_READY', claimedById: null, shippedAt: null }];
    const plan = await preview();
    expect(plan.body.planned.map((p: any) => p.orderId)).toEqual([uuid(2)]);
    expect(plan.body.skipped).toEqual([expect.objectContaining({ code: 'CUSTOMER_HAS_LIVE_ORDER', count: 1 })]);
    const r = await run([uuid(1), uuid(2)]);
    expect(r.body.created).toBe(1);
    expect(r.body.results.find((x: any) => x.orderId === uuid(1))).toMatchObject({ ok: false, code: 'CUSTOMER_HAS_LIVE_ORDER' });
  });

  it('a live order that appears between the plan and the press (another manager’s run) stops that row', async () => {
    state.sources = [src(1), src(2)];
    const real = db.order.findMany.getMockImplementation()!;
    let liveAsks = 0;
    db.order.findMany.mockImplementation(async (args: any) => {
      if (args?.select?.claimedById !== undefined) {
        liveAsks += 1;
        // the plan's own ask sees nothing; the per-row ask at the press sees cust-2's new order
        if (liveAsks > 1 && args.where.customerId.in.includes('cust-2')) return [{ customerId: 'cust-2', confirmationStatus: 'NEW', shippingStatus: 'NOT_READY', claimedById: null, shippedAt: null }];
        return [];
      }
      return real(args);
    });
    const r = await run([uuid(1), uuid(2)]);
    expect(r.body.created).toBe(1);
    expect(r.body.results.find((x: any) => x.orderId === uuid(2))).toMatchObject({ ok: false, code: 'CUSTOMER_HAS_LIVE_ORDER' });
    db.order.findMany.mockImplementation(real);
  });

  it('a customer who cancelled twice is skipped — and the single press refuses him too', async () => {
    state.sources = [src(1)];
    state.history = [{ customerId: 'cust-1', confirmationStatus: 'REJECTED', rejectionReason: 'CUSTOMER_CHANGED_MIND', shippingStatus: 'NOT_READY', replacesOrderId: null, createdAt: ago(60), lostAt: ago(59) }];
    expect((await preview()).body.planned).toEqual([]);
    const single = await post({ orderId: uuid(1), discount: 1 });
    expect(single.status).toBe(409);
    expect(single.body.code).toBe('CUSTOMER_CANCELLED_TWICE');
    // after he placed an order himself and took it, he is back
    state.history.push({ customerId: 'cust-1', confirmationStatus: 'CONFIRMED', rejectionReason: null, shippingStatus: 'DELIVERED', replacesOrderId: null, createdAt: ago(5), lostAt: null });
    expect((await preview()).body.planned.map((p: any) => p.orderId)).toEqual([uuid(1)]);
  });

  it('a product with no win-back price and an order of two products are not offered', async () => {
    state.sources = [
      src(1, { items: [{ productId: 'soap', productName: 'صابون', unitPrice: 20, freeQuantity: 0, quantity: 1 }] }),
      src(2, { items: [{ ...SCAR, quantity: 1 }, { productId: 'soap', productName: 'صابون', unitPrice: 20, freeQuantity: 0, quantity: 1 }] }),
    ];
    const plan = await preview();
    expect(plan.body.planned).toEqual([]);
    expect(Object.fromEntries(plan.body.skipped.map((s: any) => [s.code, s.count]))).toEqual({ NO_WINBACK_PRICE: 1, MIXED_PRODUCTS: 1 });
    const r = await run([uuid(1), uuid(2)]);
    expect(r.body.created).toBe(0);
    expect(db.order.create).not.toHaveBeenCalled();
  });

  it('an agent who cannot receive orders in this store is refused by name of the code', async () => {
    const r = await post({ action: 'bulk-preview', count: 5, agentIds: ['sara', 'stranger'] });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_AGENT');
  });

  it('the count is capped: 201 is refused by the body’s own check', async () => {
    expect((await post({ action: 'bulk-preview', count: 201, agentIds: ['sara'] })).status).toBe(400);
  });
});

describe('6 — no customer field in a log', () => {
  it('the run’s audit lines carry orders, agents and counts — never a name or a phone', async () => {
    state.sources = [src(1)];
    const log = vi.spyOn(console, 'log');
    await run([uuid(1)]);
    const written = JSON.stringify(logAudit.mock.calls);
    expect(written).toContain('WINBACK_BULK_RUN');
    expect(written).not.toMatch(/fullName|phone|address/i);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});

describe('7 — the review round (25/11): each of these went green under a break; now each is held', () => {
  it('B6 — the run makes ONLY the ids it was handed, even when newer orders wait in the pool', async () => {
    state.sources = [src(1), src(2), src(3)]; // 3 is the newest
    const r = await run([uuid(1)]);
    expect(r.body.created).toBe(1);
    expect(state.created.map((c) => c.replacesOrderId)).toEqual([uuid(1)]);
  });

  it('B7 — the plan and the run both read the pool through the «ready» view (never offered, not a second chance, a logged loss)', async () => {
    state.sources = [src(1)];
    await preview();
    await run([uuid(1)]);
    expect(state.candidateCalls).toHaveLength(2);
    for (const c of state.candidateCalls) {
      const w = JSON.stringify(c.where);
      expect(w).toContain('"replacedBy":null');
      expect(w).toContain('"replacesOrderId":null');
      expect(w).toContain('"statusLogs"');
    }
  });

  it('B18 — the candidates are asked newest first', async () => {
    state.sources = [src(1), src(2)];
    await preview();
    expect(state.candidateCalls[0].orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });

  it('B8/B15 — a single press that forges `priced` or `price` is still held to the ceiling', async () => {
    state.sources = [src(1)];
    const r = await post({ orderId: uuid(1), discount: 25, priced: { price: 20 }, price: 20 });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('DISCOUNT_TOO_LARGE');
    expect(db.order.create).not.toHaveBeenCalled();
    // and within the ceiling, the typed discount is what is written — the forged price is not
    const ok = await post({ orderId: uuid(1), discount: 5, priced: { price: 1 }, price: 1 });
    expect(ok.status).toBe(200);
    expect(state.created[0].totalAmount).toBe(40);
    expect(state.created[0].priceIncludesDelivery).toBe(false);
  });

  it('B12/B13 — the agents are this store’s, and only who may be handed an order', async () => {
    const r = await post({ action: 'bulk-preview', count: 5, agentIds: ['sara', 'wael'] });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_AGENT');
    expect(state.audienceCalls.every((q) => q.storeId === 's1' && q.companyId === 'c1')).toBe(true);
    const ok = await preview();
    expect(ok.status).toBe(200);
    expect(state.countScopes.length).toBeGreaterThan(0);
    expect(state.countScopes.every((sc) => sc.storeId === 's1' && sc.companyId === 'c1')).toBe(true);
  });

  it('B14 — the live-order check is asked inside this store', async () => {
    state.sources = [src(1)];
    await run([uuid(1)]);
    expect(state.liveCalls.length).toBeGreaterThanOrEqual(2);
    for (const w of state.liveCalls) expect(w).toMatchObject({ companyId: 'c1', storeId: 's1' });
  });

  it('B20 — the priced discount is rounded to the minor unit: JOD 3 × 3.333 at 7.5 → exactly 2.499', async () => {
    state.minor = 3;
    state.prices = { scar: { one: 5, three: 7.5, currency: 'JOD' } };
    state.sources = [src(1, { currency: 'JOD', items: [{ ...SCAR, unitPrice: 3.333, quantity: 3 }] })];
    const r = await run([uuid(1)]);
    expect(r.body.created).toBe(1);
    expect(state.created[0].discountAmount).toBe(2.499);
    expect(state.created[0].totalAmount).toBe(7.5);
  });

  it('B4/B16 — a discount already on the cancelled order is counted once: 45 less 5 before, at 20 → 20 more, 25 in all, total 20', async () => {
    state.sources = [src(1, { discountAmount: 5 })];
    const r = await run([uuid(1)]);
    expect(r.body.created).toBe(1);
    expect(state.created[0].discountAmount).toBe(25);
    expect(state.created[0].totalAmount).toBe(20);
    expect(state.created[0].internalNotes).toContain('بخصم 20');
    const shares = state.lines.reduce((n, l) => n + l.discountShare, 0);
    expect(shares).toBe(25);
  });

  it('the cost floor: a price below what the goods cost is not offered, at the plan and at the creator', async () => {
    state.sources = [src(1, { cost: 20.5 }), src(2, { cost: 20 })];
    const plan = await preview();
    expect(plan.body.planned.map((p: any) => p.orderId)).toEqual([uuid(2)]);
    expect(plan.body.skipped).toEqual([expect.objectContaining({ code: 'PRICE_BELOW_COST', count: 1 })]);
    const r = await run([uuid(1), uuid(2)]);
    expect(r.body.results.find((x: any) => x.orderId === uuid(1))).toMatchObject({ ok: false, code: 'PRICE_BELOW_COST' });
    expect(state.created.map((c) => c.replacesOrderId)).toEqual([uuid(2)]);
  });

  it('the creator holds the cost floor too: a fixed cost set between the plan and the press refuses that row', async () => {
    state.sources = [src(1)];
    // the plan reads no figure; by the time the creator asks, the owner has set 9 a piece (3 × 9 = 27 > 20)
    db.productFixedCost.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ productId: 'scar', amount: 9 }]);
    const r = await run([uuid(1)]);
    expect(r.body.created).toBe(0);
    expect(r.body.results[0]).toMatchObject({ ok: false, code: 'PRICE_BELOW_COST' });
    expect(db.order.create).not.toHaveBeenCalled();
  });

  it('PENDING THE OWNER — more than three pieces is not offered, by its own reason', async () => {
    state.sources = [src(1, { items: [{ ...SCAR, quantity: 4 }] }), src(2, { items: [{ ...SCAR, quantity: 3 }] })];
    const plan = await preview();
    expect(plan.body.planned.map((p: any) => p.orderId)).toEqual([uuid(2)]);
    expect(plan.body.skipped).toEqual([expect.objectContaining({ code: 'TOO_MANY_PIECES', count: 1, reasonAr: expect.stringContaining('3 قطع') })]);
  });

  it('B27 — every row of the run says its own code, in Arabic', async () => {
    state.prices = { scar: { one: 12, three: 20, currency: 'USD' } };
    state.sources = [
      src(1),
      src(2, { items: [{ productId: 'soap', productName: 'صابون', unitPrice: 20, freeQuantity: 0, quantity: 1 }] }),
      src(3, { customerId: 'cust-1' }),
      src(4, { cost: 50 }),
    ];
    const gone = uuid(99);
    const r = await run([uuid(1), uuid(2), uuid(3), uuid(4), gone]);
    const code = (id: string) => r.body.results.find((x: any) => x.orderId === id);
    expect(code(gone)).toMatchObject({ ok: false, code: 'NOT_IN_POOL' });
    expect(code(uuid(2))).toMatchObject({ ok: false, code: 'NO_WINBACK_PRICE' });
    expect(code(uuid(4))).toMatchObject({ ok: false, code: 'PRICE_BELOW_COST' });
    // cust-1 cancelled two orders (1 and 3): the newest is refused for the customer, the older as the same customer
    expect(code(uuid(3))).toMatchObject({ ok: false, code: 'CUSTOMER_CANCELLED_TWICE' });
    expect(code(uuid(1))).toMatchObject({ ok: false, code: 'SAME_CUSTOMER' });
    for (const x of r.body.results.filter((y: any) => !y.ok)) expect(x.reasonAr).toMatch(/[\u0600-\u06FF]/);
  });
});
