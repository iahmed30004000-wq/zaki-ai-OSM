import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE NUMBER ON THE PROFIT SCREEN IS PINNED — figure by figure, over a worked example (13/11).
 *
 * «صافي الربح» on `/finance/profit` is `summary.netProfit` of `GET /api/finance`. The partners' shares are cut from THAT number
 * (the owner: «الربح لازم يتم توزيعه وفق هاي النسب — الربح الصافي انا بحكي»), so the arithmetic behind it moved out of the route
 * into one function both read (`lib/profit-to-date.ts`). This file was written BEFORE the move, against the route as it stood,
 * and it passed there with these exact figures; it is what says the move changed nothing.
 *
 * THE WORKED EXAMPLE — store s1, three delivered orders, four expenses, a commission of 12.70:
 *
 *   orders (status DELIVERED, store s1)          total     shipping   cost of goods
 *     o1                                         100.10      5.05        30.30
 *     o2                                         250.55      8.10         0.00      ← no cost typed
 *     o3                                          49.99      4.00        12.345
 *   expenses                                      e1 s1 40.25 · e2 no store 9.99 · e3 s1 100.00 CANCELLED · e4 s2 77.00
 *   so the store's live expenses are e1 + e2 = 50.24 (not e3, which is cancelled, and not e4, which is the other store's).
 *
 *   revenue  400.64 · cost of goods 42.645 → 42.65 · shipping 17.15 · commissions 12.70 · expenses 50.24
 *   net      400.64 − 42.645 − 17.15 − 12.70 − 50.24 = 277.905 on paper. In floats the subtraction lands on 277.90500000000003 and the
 *            route rounds that ONCE, to two places: 277.91. That is what the route printed before the move and what it prints
 *            now — a figure like this one is exactly why the partners' split starts from `summary.netProfit` and never from a
 *            second subtraction of its own.
 */

type Row = Record<string, unknown>;

const { db, orders, expenses, commission, requireContext, requirePermission } = vi.hoisted(() => {
  const orders: Row[] = [];
  const expenses: Row[] = [];
  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([key, want]) => {
      if (key === 'OR') return (want as Row[]).some((w) => matches(row, w));
      return row[key] === want;
    });
  const db = {
    expense: {
      findMany: vi.fn(async ({ where }: { where: Row }) => expenses.filter((r) => matches(r, where))),
      groupBy: vi.fn(async () => []),
    },
    order: {
      findMany: vi.fn(async ({ where }: { where: Row }) => orders.filter((r) => matches(r, where))),
    },
  };
  return { db, orders, expenses, commission: vi.fn(async () => 12.7), requireContext: vi.fn(), requirePermission: vi.fn() };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/commission', () => ({ commissionCostForOrders: (...a: unknown[]) => commission(...(a as [])) }));
vi.mock('@/lib/analytics', () => ({
  getCompanyAnalytics: async () => ({ financials: { deliveredRevenue: 0 } }),
  getDateRange: () => ({ start: new Date('2026-11-01T00:00:00Z'), end: new Date('2026-11-30T23:59:59Z') }),
  previousRange: () => null,
}));

import { GET } from './route';

const order = (id: string, storeId: string, totalAmount: number, shippingCost: number, estimatedCostOfGoods: number, status = 'DELIVERED'): Row => ({
  id, orderNumber: id, companyId: 'c1', storeId, status, totalAmount, shippingCost, estimatedCostOfGoods, deliveredAt: new Date('2026-11-05T10:00:00Z'),
});
const expense = (id: string, storeId: string | null, amount: number, voidedAt: Date | null = null, companyId = 'c1'): Row => ({
  id, companyId, storeId, amount, voidedAt, category: 'OTHER', title: id, expenseDate: new Date('2026-11-10T10:00:00Z'), walletId: 'w1',
});

beforeEach(() => {
  vi.clearAllMocks();
  orders.length = 0;
  expenses.length = 0;
  orders.push(
    order('o1', 's1', 100.1, 5.05, 30.3),
    order('o2', 's1', 250.55, 8.1, 0),
    order('o3', 's1', 49.99, 4, 12.345),
    // None of these reaches store 1's profit: another store's, another company's, and one that is not delivered.
    order('o-other-store', 's2', 999, 9, 9),
    { ...order('o-other-company', 's1', 888, 8, 8), companyId: 'c2' },
    order('o-not-delivered', 's1', 777, 7, 7, 'CONFIRMED'),
  );
  expenses.push(
    expense('e1', 's1', 40.25),
    expense('e2', null, 9.99),
    expense('e3', 's1', 100, new Date('2026-11-09T00:00:00Z')),
    expense('e4', 's2', 77),
    expense('e5', null, 9999, null, 'c2'),
  );
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1', country: { currencyCode: 'USD', minorUnit: 2 } });
  requirePermission.mockResolvedValue({});
  commission.mockResolvedValue(12.7);
});

const read = async () => (await GET(new Request('http://localhost/api/finance'))).json();

describe('the profit screen’s figures, over the worked example', () => {
  it('every figure of `summary` is the one the screen has always printed', async () => {
    const { summary } = await read();
    expect(summary).toEqual({
      totalRevenue: 400.64,
      totalCOGS: 42.65,
      totalShipping: 17.15,
      totalCommissions: 12.7,
      shippingAndCommissions: 29.85,
      totalOperationalExpenses: 50.24,
      netProfit: 277.91,
      profitMargin: 69.4,
    });
  });

  it('the screen’s lists are the same rows: the live and the cancelled expenses of this store, the delivered orders newest first', async () => {
    const body = await read();
    expect(body.expenses.map((e: Row) => e.id)).toEqual(['e1', 'e2', 'e3']);
    expect(body.recentDeliveredOrders.map((o: Row) => o.id)).toEqual(['o1', 'o2', 'o3']);
    expect(body.currency).toBe('USD');
  });

  it('the commission is asked for THIS store’s delivered orders, through the one commission function', async () => {
    await read();
    expect(commission).toHaveBeenCalledTimes(1);
    expect(commission).toHaveBeenCalledWith({ companyId: 'c1', storeId: 's1', shippingStatus: 'DELIVERED' });
  });

  it('a loss stays a loss: the net is negative and is not floored here — the floor is the partners’ rule, not the profit’s', async () => {
    expenses.push(expense('e-big', 's1', 1000));
    const { summary } = await read();
    expect(summary.netProfit).toBe(-722.1);
    expect(summary.totalOperationalExpenses).toBe(1050.24);
  });

  it('no delivered order and no expense: every figure is zero and the margin is zero, not NaN', async () => {
    orders.length = 0;
    expenses.length = 0;
    commission.mockResolvedValue(0);
    const { summary } = await read();
    expect(summary).toEqual({
      totalRevenue: 0, totalCOGS: 0, totalShipping: 0, totalCommissions: 0, shippingAndCommissions: 0,
      totalOperationalExpenses: 0, netProfit: 0, profitMargin: 0,
    });
  });
});
