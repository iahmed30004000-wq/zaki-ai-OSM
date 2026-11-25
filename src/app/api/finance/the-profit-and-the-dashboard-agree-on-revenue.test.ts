import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A1 (25/11) — ONE REVENUE: THE PROFIT SCREEN, THE DASHBOARD AND THE PARTNERS READ THE SAME NUMBER FOR THE SAME ORDERS.
 *
 * The month that read 125 on «الأرباح» read 39,149.70 on the dashboard: the profit selected by the legacy `status` column and added
 * up the order's price, the dashboard by `shippingStatus` and added up what was collected. Here the REAL `GET /api/finance`, the REAL
 * dashboard engine (`getCompanyAnalytics`, what `GET /api/analytics` answers from) and the REAL partners' statement door run over one
 * in-memory book that evaluates every `where` it is handed, on hundreds of random books mixing every road an order is delivered by:
 *   · revenue: the profit screen's «إيراد الموصّل» = the dashboard's delivered revenue, to the cent;
 *   · commissions: the same set, so the same ledger total;
 *   · the partners' statement is cut from the profit screen's «صافي الربح», floored at the same epoch.
 */

type Row = Record<string, any>;

const { db, tables, current } = vi.hoisted(() => {
  const tables = {
    order: [] as Row[], expense: [] as Row[], courierStatement: [] as Row[], commissionEntry: [] as Row[],
    partner: [] as Row[], walletMovement: [] as Row[],
  };
  const ok = (have: unknown, want: unknown): boolean => {
    if (want === null) return have === null || have === undefined;
    if (want instanceof Date) return have instanceof Date && have.getTime() === want.getTime();
    if (want && typeof want === 'object') {
      const w = want as Row;
      if (Array.isArray(w.in)) return w.in.includes(have);
      if ('not' in w) return w.not === null ? have !== null && have !== undefined : have !== w.not;
      if ('gte' in w || 'lt' in w || 'lte' in w) {
        const t = (have as Date | null)?.getTime?.();
        if (t === undefined || Number.isNaN(t)) return false;
        return (w.gte === undefined || t >= w.gte.getTime()) && (w.lt === undefined || t < w.lt.getTime()) && (w.lte === undefined || t <= w.lte.getTime());
      }
      return matches((have ?? {}) as Row, w);
    }
    return have === want;
  };
  const matches = (row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([key, want]) => {
      if (key === 'OR') return (want as Row[]).some((w) => matches(row, w));
      if (key === 'AND') return (want as Row[]).every((w) => matches(row, w));
      if (key === 'NOT') return !(Array.isArray(want) ? want.some((w) => matches(row, w)) : matches(row, want as Row));
      return ok(row[key], want);
    });
  const aggregate = (rows: Row[], q: Row) => {
    const hit = rows.filter((r) => matches(r, q.where));
    const out: Row = {};
    if (q._sum) out._sum = Object.fromEntries(Object.keys(q._sum).map((k) => [k, hit.length ? hit.reduce((s, r) => s + Number(r[k] ?? 0), 0) : null]));
    if (q._count) out._count = { _all: hit.length };
    if (q._max) out._max = Object.fromEntries(Object.keys(q._max).map((k) => [k, null]));
    return out;
  };
  const byDate = (key: string, dir: 'asc' | 'desc') => (a: Row, b: Row) => (dir === 'asc' ? 1 : -1) * ((a[key]?.getTime?.() ?? 0) - (b[key]?.getTime?.() ?? 0));
  const db = {
    order: {
      findMany: vi.fn(async (q: Row) => tables.order.filter((r) => matches(r, q.where)).sort(byDate('deliveredAt', 'desc'))),
      aggregate: vi.fn(async (q: Row) => aggregate(tables.order, q)),
      groupBy: vi.fn(async () => []),
      count: vi.fn(async (q: Row) => tables.order.filter((r) => matches(r, q.where)).length),
    },
    orderItem: { groupBy: vi.fn(async () => []) },
    product: { findMany: vi.fn(async () => []) },
    user: { findMany: vi.fn(async () => []) },
    expense: {
      findMany: vi.fn(async (q: Row) => tables.expense.filter((r) => matches(r, q.where)).sort(byDate('expenseDate', 'desc'))),
      aggregate: vi.fn(async (q: Row) => aggregate(tables.expense, q)),
      groupBy: vi.fn(async () => []),
    },
    courierStatement: { findMany: vi.fn(async (q: Row) => tables.courierStatement.filter((r) => matches(r, q.where)).sort(byDate('createdAt', 'asc'))) },
    // The partners' statement reads the store's clock from its country (the profit door is handed it by the session): the same clock.
    store: { findUnique: vi.fn(async () => ({ country: { timezone: 'Asia/Damascus' } })) },
    partner: { findMany: vi.fn(async () => tables.partner) },
    walletMovement: { findMany: vi.fn(async () => tables.walletMovement) },
  };
  return { db, tables, current: { storeId: 's1' } };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({ user: { id: 'u1' }, companyId: 'c1', storeId: current.storeId, country: { currencyCode: 'USD', minorUnit: 2, timezone: 'Asia/Damascus' } }),
}));
vi.mock('@/lib/authorization', () => ({ requirePermission: async () => ({}), can: () => true }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
// The ledger, evaluated over the orders the `where` names: a wrong set is a wrong total.
vi.mock('@/lib/commission', () => {
  const total = async (where: Row) => {
    const ids = new Set((await db.order.findMany({ where })).map((o: Row) => o.id));
    return tables.commissionEntry.filter((e) => ids.has(e.orderId)).reduce((s, e) => s + e.amount, 0);
  };
  return { commissionCostForOrders: total, commissionByUserForOrders: async () => new Map() };
});

import { GET as finance } from './route';
import { GET as partnersStatement } from './partners/statement/route';
import { getCompanyAnalytics } from '@/lib/analytics';
import { laneAnswers } from '@/lib/heavy-lane';

const cents = (n: number) => Math.round(n * 100);

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** A random book: every road an order is delivered by, every state it may be in, the legacy column in or out of step. */
function book(seed: number, opts: { statement?: boolean } = {}) {
  const r = rng(seed);
  for (const t of Object.values(tables)) t.length = 0;
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const count = Math.floor(r() * 14);
  for (let i = 0; i < count; i++) {
    const shippingStatus = pick(['DELIVERED', 'DELIVERED', 'PARTIALLY_DELIVERED', 'SHIPPED', 'RETURNED', 'NOT_SHIPPED'] as const);
    const total = Math.round(r() * 50000) / 100;
    tables.order.push({
      id: `o${i}`, orderNumber: `ORD-${i}`, companyId: 'c1', storeId: r() < 0.85 ? 's1' : 's2',
      shippingStatus,
      // the legacy column: in step (the shipping door), stale (the statement close, the «استلم» door), or wrong
      status: pick(['DELIVERED', 'SHIPPED', 'CONFIRMED', 'RETURNED']),
      totalAmount: total,
      collectedAmount: r() < 0.5 ? null : Math.round(r() * total * 100) / 100,
      shippingCost: Math.round(r() * 500) / 100,
      estimatedCostOfGoods: r() < 0.3 ? 0 : Math.round(r() * 20000) / 100,
      deliveredAt: new Date(Date.UTC(2026, 9, 1 + Math.floor(r() * 55), Math.floor(r() * 24))),
      createdAt: new Date(Date.UTC(2026, 8, 1 + Math.floor(r() * 30))),
    });
    if (r() < 0.6) tables.commissionEntry.push({ orderId: `o${i}`, amount: Math.round(r() * 300) / 100 });
  }
  for (let i = 0; i < Math.floor(r() * 4); i++) {
    tables.expense.push({
      id: `e${i}`, companyId: 'c1', storeId: r() < 0.3 ? null : 's1', amount: Math.round(r() * 9000) / 100, title: `e${i}`, category: 'OTHER',
      voidedAt: r() < 0.2 ? new Date('2026-11-20') : null, expenseDate: new Date(Date.UTC(2026, 9, 1 + Math.floor(r() * 55))), walletId: 'w1',
    });
  }
  if (opts.statement) tables.courierStatement.push({ companyId: 'c1', storeId: 's1', createdAt: new Date(Date.UTC(2026, 9, 1 + Math.floor(r() * 50), 9)), fileHash: `sha-${seed}` });
  tables.partner.push({ id: 'pa', companyId: 'c1', name: 'شريك أ', sharePercent: 40, isActive: true, sortOrder: 0, createdAt: new Date(0) }, { id: 'pb', companyId: 'c1', name: 'شريك ب', sharePercent: 60, isActive: true, sortOrder: 1, createdAt: new Date(1) });
}

const SEEDS = Array.from({ length: 150 }, (_, i) => 25112026 + i);

beforeEach(() => {
  laneAnswers.clear();
  current.storeId = 's1';
});

describe('the profit screen and the dashboard: the same revenue for the same orders', () => {
  it.each(SEEDS)('book %i: «إيراد الموصّل» on /api/finance is the dashboard’s delivered revenue, and the commissions are the same', async (seed) => {
    book(seed);
    const shown = await (await finance(new Request('http://localhost/api/finance'))).json();
    const board = await getCompanyAnalytics({ companyId: 'c1', storeId: 's1' }, {}, {});
    expect(cents(shown.summary.totalRevenue), `book ${seed}`).toBe(cents(board.financials.deliveredRevenue));
    expect(cents(shown.summary.totalCommissions), `book ${seed}`).toBe(cents(board.financials.commission));
    expect(cents(shown.summary.totalCOGS), `book ${seed}`).toBe(cents(board.financials.costOfGoodsSold));
    expect(cents(shown.summary.totalShipping), `book ${seed}`).toBe(cents(board.financials.shippingCosts));
    expect(shown.since).toBeNull();
  });

  it('worked: one order of each road — the dashboard and the profit agree, and the legacy column moves neither', async () => {
    for (const t of Object.values(tables)) t.length = 0;
    const o = (id: string, shippingStatus: string, status: string, totalAmount: number, collectedAmount: number | null) =>
      ({ id, orderNumber: id, companyId: 'c1', storeId: 's1', shippingStatus, status, totalAmount, collectedAmount, shippingCost: 0, estimatedCostOfGoods: 0, deliveredAt: new Date('2026-11-05T10:00:00Z'), createdAt: new Date('2026-11-01') });
    tables.order.push(
      o('closed', 'DELIVERED', 'SHIPPED', 25, 22), //       the statement close: 22 collected
      o('door', 'DELIVERED', 'CONFIRMED', 40, null), //     the «استلم» door, before its statement: 40
      o('partial', 'PARTIALLY_DELIVERED', 'SHIPPED', 50, 30), // 30
      o('legacy', 'RETURNED', 'DELIVERED', 999, null), //   the legacy column lies: nothing
    );
    const shown = await (await finance(new Request('http://localhost/api/finance'))).json();
    const board = await getCompanyAnalytics({ companyId: 'c1', storeId: 's1' }, {}, {});
    expect(shown.summary.totalRevenue).toBe(92);
    expect(board.financials.deliveredRevenue).toBe(92);
  });
});

describe('the partners are cut from the same number — floored at the same start', () => {
  it.each(SEEDS.slice(0, 60))('book %i (with a first statement): the statement’s net profit is the profit screen’s, and both name the same start', async (seed) => {
    book(seed, { statement: true });
    const shown = await (await finance(new Request('http://localhost/api/finance'))).json();
    const cut = await (await partnersStatement()).json();
    expect(cut.netProfit, `book ${seed}`).toBe(shown.summary.netProfit);
    expect(cut.since).toBe(shown.since);
    expect(cut.sinceDay).toBe(shown.sinceDay);
    // and the floor is real: nothing delivered before the start is in the revenue
    const epoch = new Date(shown.since).getTime();
    const after = tables.order.filter((r) => r.storeId === 's1' && ['DELIVERED', 'PARTIALLY_DELIVERED'].includes(r.shippingStatus) && r.deliveredAt.getTime() >= epoch);
    const expected = after.reduce((s, r) => s + (r.collectedAmount ?? r.totalAmount), 0);
    expect(cents(shown.summary.totalRevenue), `book ${seed}`).toBe(cents(expected));
  });

  it('a store with no statement: the partners’ statement carries no start at all — exactly the shape it had', async () => {
    book(SEEDS[0]);
    const cut = await (await partnersStatement()).json();
    expect('since' in cut).toBe(false);
    expect('sinceDay' in cut).toBe(false);
  });
});
