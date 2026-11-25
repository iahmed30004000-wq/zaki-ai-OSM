import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DEFINITION OF DONE — the profit for a span of days (D2, the owner 17/11: «حط الأشياء ع اليوم التاريخ»).
 * What must work: `profitToDate(scope, window)` adds up the SAME three reads (delivered orders and their commissions by the day they were delivered, expenses by the day they were spent) over
 * the span only; with no window it is exactly what it was (what the partners read). `profitWindow` turns two days of the store into the instants they cover, inclusive of the last day, and
 * is null for anything that is not two days in order.
 * Edge cases: the day is the store's own (a Damascus evening is not the next UTC day); a bad or backwards span is no span, never a throw and never a clamp; a cancelled expense still costs nothing.
 * Blockers: no change of any formula, query predicate or rounding without a window — `the-profit-summary-is-pinned.test.ts` stays green untouched.
 */

type Row = Record<string, unknown>;
const { db, orders, expenses, commission } = vi.hoisted(() => {
  const orders: Row[] = [];
  const expenses: Row[] = [];
  const ok = (have: unknown, want: unknown): boolean => {
    // 25/11 (A1): delivered is `whereDelivered()` — `shippingStatus: { in: [...] }`.
    if (want && typeof want === 'object' && Array.isArray((want as { in?: unknown[] }).in)) return (want as { in: unknown[] }).in.includes(have);
    if (want && typeof want === 'object' && !(want instanceof Date)) {
      const w = want as { gte?: Date; lt?: Date };
      const t = (have as Date | null)?.getTime();
      if (t === undefined || Number.isNaN(t)) return false;
      return (w.gte === undefined || t >= w.gte.getTime()) && (w.lt === undefined || t < w.lt.getTime());
    }
    return have === want;
  };
  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([key, want]) => (key === 'OR' ? (want as Row[]).some((w) => matches(row, w)) : ok(row[key], want)));
  const db = {
    expense: { findMany: vi.fn(async ({ where }: { where: Row }) => expenses.filter((r) => matches(r, where))) },
    order: { findMany: vi.fn(async ({ where }: { where: Row }) => orders.filter((r) => matches(r, where))) },
    // 25/11 (A1): the store's profit epoch is read from its courier statements. None here: no floor, the span is the span asked for.
    courierStatement: { findMany: vi.fn(async () => []) },
  };
  return { db, orders, expenses, commission: vi.fn(async (_where: Row) => 0) };
});
vi.mock('./db', () => ({ db }));
vi.mock('./commission', () => ({ commissionCostForOrders: (w: Row) => commission(w) }));

import { profitToDate, profitWindow } from './profit-to-date';

const SCOPE = { companyId: 'c1', storeId: 's1' };
const TZ = 'Asia/Damascus';
const at = (iso: string) => new Date(iso);

beforeEach(() => {
  orders.length = 0;
  expenses.length = 0;
  commission.mockClear();
  // Damascus is UTC+3 in this period: the 17th local runs from 16th 21:00Z to 17th 21:00Z.
  orders.push(
    { id: 'o1', companyId: 'c1', storeId: 's1', status: 'DELIVERED', shippingStatus: 'DELIVERED', totalAmount: 100, shippingCost: 5, estimatedCostOfGoods: 30, deliveredAt: at('2026-11-17T10:00:00Z') },
    { id: 'o2', companyId: 'c1', storeId: 's1', status: 'DELIVERED', shippingStatus: 'DELIVERED', totalAmount: 200, shippingCost: 5, estimatedCostOfGoods: 50, deliveredAt: at('2026-11-17T22:30:00Z') }, // 18th, 01:30 local
    { id: 'o3', companyId: 'c1', storeId: 's1', status: 'DELIVERED', shippingStatus: 'DELIVERED', totalAmount: 400, shippingCost: 5, estimatedCostOfGoods: 90, deliveredAt: at('2026-11-10T10:00:00Z') }
  );
  expenses.push(
    { id: 'e1', companyId: 'c1', storeId: 's1', amount: 20, expenseDate: at('2026-11-17T09:00:00Z'), voidedAt: null },
    { id: 'e2', companyId: 'c1', storeId: 's1', amount: 70, expenseDate: at('2026-11-10T09:00:00Z'), voidedAt: null },
    { id: 'e3', companyId: 'c1', storeId: 's1', amount: 999, expenseDate: at('2026-11-17T09:00:00Z'), voidedAt: at('2026-11-17T12:00:00Z') }
  );
});

describe('profitWindow', () => {
  it('covers whole days of the store, the last day included', () => {
    const w = profitWindow('2026-11-17', '2026-11-17', TZ)!;
    expect(w.start.toISOString()).toBe('2026-11-16T21:00:00.000Z');
    expect(w.end.getTime() - w.start.getTime()).toBe(24 * 3_600_000);
    const two = profitWindow('2026-11-16', '2026-11-17', TZ)!;
    expect(two.end.getTime() - two.start.getTime()).toBe(48 * 3_600_000);
  });

  it.each([
    [null, '2026-11-17'], ['2026-11-17', undefined], ['', ''], ['17/11/2026', '2026-11-17'], ['2026-11-18', '2026-11-17'], ['2026-13-40', '2026-13-41'],
  ])('is no window for %s → %s', (from, to) => {
    expect(profitWindow(from as never, to as never, TZ)).toBeNull();
  });
});

describe('profitToDate over a window', () => {
  it('with no window it adds up everything since the beginning, as before', async () => {
    const r = await profitToDate(SCOPE);
    expect(r.summary.totalRevenue).toBe(700);
    expect(r.summary.totalOperationalExpenses).toBe(90);
    // MOVED 25/11 (A1): was `shippingStatus: 'DELIVERED'` — the commissions are asked over the revenue's own set, `whereDelivered()`.
    expect(commission.mock.calls[0][0]).toEqual({ companyId: 'c1', storeId: 's1', shippingStatus: { in: ['DELIVERED', 'PARTIALLY_DELIVERED'] } });
  });

  it('with the 17th of the store: only the orders delivered that local day and the expenses spent that day — the evening one counts for the 18th', async () => {
    const r = await profitToDate(SCOPE, profitWindow('2026-11-17', '2026-11-17', TZ));
    expect(r.deliveredOrders.map((o) => o.id)).toEqual(['o1']);
    expect(r.summary.totalRevenue).toBe(100);
    expect(r.summary.totalCOGS).toBe(30);
    expect(r.summary.totalShipping).toBe(5);
    expect(r.summary.totalOperationalExpenses).toBe(20); // the cancelled 999 costs nothing
    expect(r.summary.netProfit).toBe(45);
  });

  it('a span of two days takes in both, and the commissions are asked about the same window of orders', async () => {
    const w = profitWindow('2026-11-17', '2026-11-18', TZ)!;
    const r = await profitToDate(SCOPE, w);
    expect(r.deliveredOrders.map((o) => o.id).sort()).toEqual(['o1', 'o2']);
    expect(r.summary.totalRevenue).toBe(300);
    // MOVED 25/11 (A1): the same set as the revenue (`whereDelivered()`), the same window.
    expect(commission.mock.calls[0][0]).toEqual({ companyId: 'c1', storeId: 's1', shippingStatus: { in: ['DELIVERED', 'PARTIALLY_DELIVERED'] }, deliveredAt: { gte: w.start, lt: w.end } });
  });

  it('a span with nothing in it is zeros, not a throw', async () => {
    const r = await profitToDate(SCOPE, profitWindow('2026-01-01', '2026-01-02', TZ));
    expect(r.summary.netProfit).toBe(0);
    expect(r.summary.profitMargin).toBe(0);
  });
});
