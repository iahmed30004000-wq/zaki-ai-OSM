import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE THREE PROFIT DOORS ASK ONCE A MINUTE, IN THE REPORTS LANE (H2, cause 6 of the hang — 18/11).
 *
 * `/api/finance` (`profitToDate` and the month's two revenue readings), `/api/finance/profitability` and `/api/finance/summary` (`getCompanyAnalytics`)
 * read every delivered order of their span on the site's main pool at every return to the tab. Each computation now runs on the reports' own pool
 * (`inHeavyLane()` is true inside it), and a second asker of the SAME question within the minute gets the kept answer. The question is the company,
 * the store and the span — never the reader; for `/api/finance` also the store's live expenses as they stand, so a new expense is on the screen at once.
 * What stays live: the settlement counts of the summary, and the expense stamp itself. The TTL is injected (it is 0 under test).
 */

const { state, profitToDate, analytics } = vi.hoisted(() => ({
  state: { stamp: { _count: { _all: 2 }, _sum: { amount: 30 }, _max: { createdAt: new Date('2026-11-10T08:00:00Z') as Date | null } }, monthRows: [] as unknown[], storeId: 's1', lanes: [] as boolean[], statements: [] as { createdAt: Date; fileHash: string }[], keys: [] as string[] },
  profitToDate: vi.fn(),
  analytics: vi.fn(),
}));

vi.mock('@/lib/heavy-lane', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/heavy-lane')>();
  // 25/11 (A1): every key asked is written down, so the key's parts can be pinned.
  return { ...real, REPORT_TTL_MS: 60_000, heavyOnce: (key: string, ttl: number, fn: () => Promise<unknown>) => (state.keys.push(key), real.heavyOnce(key, ttl, fn)) };
});
vi.mock('@/lib/db', () => ({
  db: {
    expense: { aggregate: vi.fn(async () => state.stamp), groupBy: vi.fn(async () => state.monthRows) },
    order: { count: vi.fn(async () => 1) },
    // 25/11 (A1): the profit door reads the store's profit epoch to name its kept answer; `state.statements` are its courier statements.
    courierStatement: { findMany: vi.fn(async () => state.statements) },
  },
}));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({ user: { id: 'u1' }, companyId: 'c1', storeId: state.storeId, country: { currencyCode: 'SYP', timezone: 'Asia/Damascus' } }),
}));
vi.mock('@/lib/authorization', () => ({ requirePermission: vi.fn(async () => ({})) }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/profit-to-date', async (orig) => ({ ...(await orig<typeof import('@/lib/profit-to-date')>()), profitToDate: (...a: unknown[]) => profitToDate(...a) }));
vi.mock('@/lib/analytics', async (orig) => ({ ...(await orig<typeof import('@/lib/analytics')>()), getCompanyAnalytics: (...a: unknown[]) => analytics(...a) }));

import { inHeavyLane, laneAnswers } from '@/lib/heavy-lane';
import { db } from '@/lib/db';
import { GET as financeGET } from './route';
import { GET as profitabilityGET } from './profitability/route';
import { GET as summaryGET } from './summary/route';

beforeEach(() => {
  laneAnswers.clear();
  vi.mocked(db.order.count).mockClear();
  state.storeId = 's1';
  state.monthRows = [];
  state.lanes = [];
  state.statements = [];
  state.keys = [];
  state.stamp = { _count: { _all: 2 }, _sum: { amount: 30 }, _max: { createdAt: new Date('2026-11-10T08:00:00Z') } };
  profitToDate.mockReset().mockImplementation(async () => {
    state.lanes.push(inHeavyLane());
    return { expenses: [], liveExpenses: [], deliveredOrders: [], summary: { netProfit: 1 } };
  });
  analytics.mockReset().mockImplementation(async () => {
    state.lanes.push(inHeavyLane());
    return { productStats: [], financials: { deliveredRevenue: 5, grossProfit: 0, netProfit: 0, profitMargin: 0, costOfGoodsSold: 0, shippingCosts: 0, commission: 0, operationalExpenses: 0 }, ordersCount: { confirmed: 0, delivered: 0 } };
  });
});

const finance = (qs = '') => financeGET(new Request(`http://localhost/api/finance${qs}`));
const profitability = (qs = '') => profitabilityGET(new Request(`http://localhost/api/finance/profitability${qs}`));
const summary = (qs = '') => summaryGET(new Request(`http://localhost/api/finance/summary${qs}`));

describe('/api/finance', () => {
  it('profitToDate runs in the reports lane, and a second ask within the minute is the kept answer', async () => {
    expect((await finance()).status).toBe(200);
    expect((await finance()).status).toBe(200);
    expect(profitToDate).toHaveBeenCalledTimes(1);
    expect(state.lanes).toEqual([true]);
  });

  it('another store, or another span, is another question', async () => {
    await finance();
    state.storeId = 's2';
    await finance();
    await finance('?from=2026-11-17&to=2026-11-18');
    expect(profitToDate).toHaveBeenCalledTimes(3);
  });

  it('an expense recorded or cancelled a second ago is another question: the list is never a minute behind', async () => {
    await finance();
    state.stamp = { _count: { _all: 3 }, _sum: { amount: 45 }, _max: { createdAt: new Date('2026-11-18T08:00:00Z') } };
    await finance();
    state.stamp = { _count: { _all: 2 }, _sum: { amount: 15 }, _max: { createdAt: new Date('2026-11-18T08:00:00Z') } };
    await finance();
    expect(profitToDate).toHaveBeenCalledTimes(3);
  });

  it('A1 (25/11): the first courier statement is another question — the key carries the profit epoch, so the figures move the moment one is uploaded', async () => {
    await finance();
    await finance();
    expect(profitToDate).toHaveBeenCalledTimes(1);
    // An open manual draft is not a statement: the same key, the kept answer.
    state.statements = [{ createdAt: new Date('2026-10-28T09:00:00Z'), fileHash: 'manual:draft:x' }];
    await finance();
    expect(profitToDate).toHaveBeenCalledTimes(1);
    // A real one: a new key, a new computation, and the epoch is handed to the engine rather than read twice.
    state.statements = [{ createdAt: new Date('2026-10-28T09:00:00Z'), fileHash: 'abc' }];
    const body = await (await finance()).json();
    expect(profitToDate).toHaveBeenCalledTimes(2);
    expect((profitToDate.mock.calls[1] as unknown[])[2]).toEqual({ epoch: { at: new Date('2026-10-27T21:00:00.000Z'), day: '2026-10-28' } });
    expect(body.since).toBe('2026-10-27T21:00:00.000Z');
    expect(body.sinceDay).toBe('2026-10-28');
  });

  it('A1: the key carries the epoch INSTANT, not a yes/no — a first statement on another day is another key', async () => {
    state.statements = [{ createdAt: new Date('2026-10-28T09:00:00Z'), fileHash: 'abc' }];
    await finance();
    state.statements = [{ createdAt: new Date('2026-10-29T09:00:00Z'), fileHash: 'abc' }];
    await finance();
    const profitKeys = state.keys.filter((k) => k.startsWith('finance-profit|'));
    expect(profitKeys[0]).toContain('|since:2026-10-27T21:00:00.000Z|');
    expect(profitKeys[1]).toContain('|since:2026-10-28T21:00:00.000Z|');
    expect(profitToDate).toHaveBeenCalledTimes(2);
    state.statements = [];
    await finance();
    expect(state.keys.filter((k) => k.startsWith('finance-profit|'))[2]).toContain('|since:none|');
  });

  it('the month\'s two revenue readings run in the lane too, and are kept', async () => {
    state.monthRows = [{ category: 'OFFICE', _count: { _all: 1 }, _sum: { amount: 10 } }];
    await finance();
    await finance();
    expect(analytics).toHaveBeenCalledTimes(2); // this month and last month, once each
    expect(state.lanes).toEqual([true, true, true]);
  });
});

describe('/api/finance/profitability and /api/finance/summary', () => {
  it('the engine runs in the lane, and the two doors share ONE computation for the same span', async () => {
    await summary();
    await profitability();
    await summary();
    expect(analytics).toHaveBeenCalledTimes(1);
    expect(state.lanes).toEqual([true]);
  });

  it('another store, or another span, is another question', async () => {
    await summary('?from=2026-11-01&to=2026-11-10');
    await summary('?from=2026-11-01&to=2026-11-11');
    state.storeId = 's2';
    await profitability('?from=2026-11-01&to=2026-11-11');
    expect(analytics).toHaveBeenCalledTimes(3);
  });

  it('the settlement counts of the summary stay live: asked at every call', async () => {
    await summary();
    await summary();
    expect(db.order.count).toHaveBeenCalledTimes(6); // three counts per call, both calls
  });
});
