import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * THE DASHBOARD'S ANSWER CARRIED THE MONEY THE DASHBOARD HID.
 *
 * `/api/analytics` held back `financials` from a reader without «عرض
 * المالية», and went on sending the same money in other shapes: every
 * product's revenue, cost and net profit, the most profitable product,
 * every moderator's sales and commission by name, last period's delivered
 * revenue, the money still out with couriers, delivered revenue in the AI
 * context — and the latest ten orders with their customers' phones, which no
 * screen reads at all. The loss panel's money went to the reports key too.
 *
 * Each case is the same reader twice: without the key nothing of it leaves,
 * with the key it all does — so a fix that simply emptied the answer fails.
 */

const { db, requireContext, held } = vi.hoisted(() => ({
  db: {
    order: { findMany: vi.fn(), count: vi.fn() },
    deliveryFee: { findMany: vi.fn() },
  },
  requireContext: vi.fn(),
  held: { keys: [] as string[] },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  can: (_u: unknown, k: string) => held.keys.includes(k),
  requirePermission: vi.fn(async () => ({})),
}));

import { projectAnalytics } from '@/lib/analytics-projection';
import { GET as loss } from '@/app/api/analytics/loss/route';

const USER = { id: 'u1' } as SessionUser;
const PRODUCT = { id: 'p1', name: 'سيروم', sku: 'S1', totalOrders: 10, confirmedOrders: 8, deliveredOrders: 6, rejectedOrders: 2, revenue: 300, cogs: 100, shippingCost: 30, netProfit: 170, profitMargin: 56 };
const MOD = { id: 'm1', name: 'سارة', email: 'sara@x', totalOrders: 20, confirmedOrders: 15, sales: 900, commissions: 45, confirmationRate: 75 };
const ANALYTICS = {
  period: 'all',
  ordersCount: { total: 100 },
  rates: { confirmationRate: 80 },
  financials: { netProfit: 2200 },
  productStats: [PRODUCT],
  rankings: { mostRequested: PRODUCT, mostProfitable: PRODUCT, mostDelivered: PRODUCT },
  moderatorLeaderboard: [MOD],
  topModerator: MOD,
  aiContext: { period: 'all', total_orders: 100, revenue: 5000, net_profit: 2200, top_profitable_product: 'سيروم', top_moderator: 'سارة' },
  orders: [{ id: 'o1', customer: { phone: '079' } }],
};

const as = (...keys: string[]) => {
  held.keys = keys;
  return projectAnalytics(ANALYTICS, USER);
};

describe('the analytics answer', () => {
  it('without «عرض المالية»: counts and rates, and not one money figure in any shape', () => {
    const out = as('reports.view', 'insights.view');
    expect(out.ordersCount).toEqual({ total: 100 });
    expect(out.financials).toBeUndefined();
    const product = (out.productStats as Record<string, unknown>[])[0];
    for (const k of ['revenue', 'cogs', 'shippingCost', 'netProfit', 'profitMargin']) expect(product, k).not.toHaveProperty(k);
    expect(product.totalOrders).toBe(10);
    const rankings = out.rankings as Record<string, Record<string, unknown>>;
    expect(rankings.mostProfitable).toBeUndefined();
    expect(rankings.mostRequested).not.toHaveProperty('netProfit');
    const mod = (out.moderatorLeaderboard as Record<string, unknown>[])[0];
    expect(mod).not.toHaveProperty('sales');
    expect(mod).not.toHaveProperty('commissions');
    expect(mod.confirmedOrders).toBe(15);
    const ai = out.aiContext as Record<string, unknown>;
    // delivered revenue: the one the old pattern missed
    for (const k of ['revenue', 'net_profit', 'top_profitable_product']) expect(ai, k).not.toHaveProperty(k);
    expect(ai.total_orders).toBe(100);
  });

  it('with it: all of the money', () => {
    const out = as('reports.view', 'finance.view', 'insights.view');
    expect(out.financials).toEqual({ netProfit: 2200 });
    expect((out.productStats as Record<string, unknown>[])[0].netProfit).toBe(170);
    expect((out.rankings as Record<string, Record<string, unknown>>).mostProfitable.netProfit).toBe(170);
    expect((out.moderatorLeaderboard as Record<string, unknown>[])[0].commissions).toBe(45);
    expect((out.aiContext as Record<string, unknown>).revenue).toBe(5000);
  });

  it('colleagues by name only with a key of a screen that shows them', () => {
    const plain = as('dashboard.view');
    expect(plain.moderatorLeaderboard).toBeUndefined();
    expect(plain.topModerator).toBeUndefined();
    expect((plain.aiContext as Record<string, unknown>).top_moderator).toBeUndefined();
    for (const key of ['reports.view', 'team.monitor', 'users.view']) {
      expect(as('dashboard.view', key).moderatorLeaderboard, key).toBeTruthy();
    }
  });

  it('the rankings are smart cards: absent — not empty — without insights.view, whole with it (PR-10)', () => {
    for (const keys of [['reports.view'], ['reports.view', 'finance.view'], ['dashboard.view', 'team.monitor']]) {
      expect(as(...keys), keys.join(',')).not.toHaveProperty('rankings');
    }
    expect(as('reports.view', 'insights.view').rankings).toBeTruthy();
    // the counts and the rates stay for everybody
    expect(as('reports.view').ordersCount).toEqual({ total: 100 });
    expect(as('reports.view').rates).toEqual({ confirmationRate: 80 });
  });

  it('PR-10: the two rankings the model is told leave the AI context with the cards — and come back with the key', () => {
    const keys = ['dashboard.view', 'reports.view', 'finance.view'];
    const ctx = (extra: string[]) => (as(...keys, ...extra).aiContext as Record<string, unknown>);
    const WITH = { ...ANALYTICS, aiContext: { ...ANALYTICS.aiContext, top_demanded_product: 'سيروم', highest_rejection_product: 'كريم' } };
    held.keys = keys;
    const without = projectAnalytics(WITH, USER).aiContext as Record<string, unknown>;
    expect(without).not.toHaveProperty('top_demanded_product');
    expect(without).not.toHaveProperty('highest_rejection_product');
    expect(without.total_orders).toBe(100);
    held.keys = [...keys, 'insights.view'];
    const withKey = projectAnalytics(WITH, USER).aiContext as Record<string, unknown>;
    expect(withKey.top_demanded_product).toBe('سيروم');
    expect(withKey.highest_rejection_product).toBe('كريم');
    expect(ctx([])).toBeTruthy();
  });

  it('the latest orders with their customers’ phones leave for nobody — the owner included', () => {
    for (const keys of [['dashboard.view'], ['dashboard.view', 'finance.view', 'reports.view', 'customers.view']]) {
      expect(as(...keys).orders, keys.join(',')).toBeUndefined();
    }
  });
});

describe('the loss panel is a smart card (PR-10)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireContext.mockResolvedValue({ user: USER, companyId: 'c1', storeId: 's1' });
  });

  it('refuses a reader of the reports who lacks insights.view, in Arabic in both fields, and reads nothing', async () => {
    held.keys = ['reports.view', 'finance.view'];
    const res = await loss(new Request('http://x/api/analytics/loss?period=all'));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('INSIGHTS_REQUIRED');
    expect(body.error).toMatch(/[\u0600-\u06FF]/);
    expect(body.errorAr).toBe(body.error);
    expect(db.order.findMany).not.toHaveBeenCalled();
    expect(db.order.count).not.toHaveBeenCalled();
  });

  it('NEGATIVE: the cards’ key alone, without the reports’ key, is still the reports’ refusal', async () => {
    const authorization = await import('@/lib/authorization');
    (authorization.requirePermission as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('FORBIDDEN'));
    held.keys = ['insights.view'];
    const res = await loss(new Request('http://x/api/analytics/loss?period=all'));
    expect(res.status).not.toBe(200);
    expect(db.order.findMany).not.toHaveBeenCalled();
  });
});

describe('the loss panel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireContext.mockResolvedValue({ user: USER, companyId: 'c1', storeId: 's1' });
    db.order.findMany.mockResolvedValue([
      { rejectionReason: null, deliveryFailureReason: null, returnReason: 'CUSTOMER_REFUSED', deliveryFee: 2.5, productCost: 1, quantity: 3, regionId: 'r1', deliveryProviderId: 'dp1' },
    ]);
    db.order.count.mockResolvedValue(1);
    db.deliveryFee.findMany.mockResolvedValue([{ regionId: 'r1', deliveryProviderId: 'dp1', fee: '2.5', returnFee: '1' }]);
  });
  const read = async () => (await loss(new Request('http://x/api/analytics/loss?period=all'))).json();

  it('without «عرض المالية»: the counts and reasons, every money figure zero, and it says so', async () => {
    held.keys = ['reports.view', 'insights.view'];
    const body = await read();
    expect(body.moneyWithheld).toBe(true);
    expect(body.after.count).toBe(1);
    expect(body.after.money).toBe(0);
    expect(JSON.stringify(body)).not.toMatch(/"money":[1-9]/);
  });

  it('with it: what the parcel cost', async () => {
    held.keys = ['reports.view', 'finance.view', 'insights.view'];
    const body = await read();
    expect(body.moneyWithheld).toBeUndefined();
    expect(body.after.money).toBeGreaterThan(0);
  });
});
