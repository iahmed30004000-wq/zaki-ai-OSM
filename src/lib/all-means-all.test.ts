import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «الكل مش اخر 90 يوم» — the owner, 23/10, over a dashboard that said «الكل»
 * and counted 12,449 of 17,328 orders. On the DASHBOARD, «الكل» is the whole
 * history; everywhere else the safety window that `getDateRange` keeps is
 * unchanged.
 *
 * The first version of this (#102) put `reportRange` inside the engine's
 * default, so every caller of `getCompanyAnalytics` widened at once — the
 * finance summary, the profitability report and the AI summaries started
 * reading the whole history, and the loss panel on the dashboard itself
 * stayed on 90 days. These tests read the WHERE the engine and the loss door
 * actually send, not the words in their source.
 */

const { db, requireContext, requirePermission } = vi.hoisted(() => ({
  db: {
    order: { groupBy: vi.fn(), count: vi.fn(), aggregate: vi.fn(), findMany: vi.fn() },
    orderItem: { groupBy: vi.fn(async () => []) },
    expense: { aggregate: vi.fn(async () => ({ _sum: { amount: 0 } })) },
    user: { findMany: vi.fn(async () => []) },
    product: { findMany: vi.fn(async () => []) },
    deliveryFee: { findMany: vi.fn(async () => []) },
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
}));
vi.mock('./db', () => ({ db }));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('./commission', () => ({
  commissionCostForOrders: async () => 0,
  commissionByUserForOrders: async () => new Map(),
}));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  can: () => true,
  requirePermission: (...a: unknown[]) => requirePermission(...a),
}));

import { getCompanyAnalytics, getDateRange, reportRange } from './analytics';
import { notSuperseded } from './superseded';
import { GET as lossDoor } from '@/app/api/analytics/loss/route';

beforeEach(() => {
  vi.clearAllMocks();
  db.order.groupBy.mockResolvedValue([]);
  db.order.count.mockResolvedValue(0);
  db.order.aggregate.mockResolvedValue({ _count: { _all: 0 }, _sum: {} });
  db.order.findMany.mockResolvedValue([]);
  requireContext.mockResolvedValue({ companyId: 'c1', storeId: 's1' });
  requirePermission.mockResolvedValue({});
});

/** The WHERE of the engine's first GROUP BY — what it counted. */
const engineWhere = () => db.order.groupBy.mock.calls[0][0].where as Record<string, unknown>;

describe('reportRange — what «الكل» means on the dashboard', () => {
  it('has no start and no end', () => {
    expect(reportRange({ period: 'all' })).toEqual({});
    expect(reportRange({})).toEqual({});
  });

  it('a named period is still that period', () => {
    expect(reportRange({ period: '30d' })).toEqual(getDateRange({ period: '30d' }));
    expect(reportRange({ period: 'month' }).start).toBeInstanceOf(Date);
  });

  it('two picked dates are still a window, even under «all»', () => {
    const r = reportRange({ period: 'all', startDate: '2026-10-01', endDate: '2026-10-05' });
    expect(r.start).toBeInstanceOf(Date);
    expect(r.end).toBeInstanceOf(Date);
  });

  it('and getDateRange itself keeps its safety window for the screens that read it as a span', () => {
    expect(getDateRange({ period: 'all' }).start).toBeInstanceOf(Date);
  });
});

describe('the engine counts the whole history only when asked by name', () => {
  it('handed reportRange under «الكل» (the dashboard), it sends no date condition', async () => {
    await getCompanyAnalytics({ companyId: 'c1', storeId: 's1' }, { period: 'all' }, reportRange({ period: 'all' }));
    // No date condition. The one clause beside the company and the store is
    // the replaced-order exclusion every count carries (superseded.ts) — the
    // date window is what this test is about.
    expect(engineWhere()).toEqual({ companyId: 'c1', storeId: 's1', ...notSuperseded });
  });

  it('called without a window (finance, profitability, the AI summaries), «الكل» is still the 90-day window', async () => {
    await getCompanyAnalytics({ companyId: 'c1', storeId: null }, { period: 'all' });
    const createdAt = engineWhere().createdAt as { gte: Date; lte: Date } | undefined;
    expect(createdAt, 'the engine default widened to the whole history again').toBeDefined();
    const days = (createdAt!.lte.getTime() - createdAt!.gte.getTime()) / 86_400_000;
    expect(days).toBeLessThanOrEqual(91);
  });

  it('a named period on the dashboard is still that period', async () => {
    await getCompanyAnalytics({ companyId: 'c1', storeId: 's1' }, { period: '7d' }, reportRange({ period: '7d' }));
    expect(engineWhere().createdAt).toBeDefined();
  });
});

describe('the loss panel counts what the tiles above it count', () => {
  const lossWhere = async (query: string) => {
    const res = await lossDoor(new Request(`http://localhost/api/analytics/loss${query}`));
    expect(res.status).toBe(200);
    return db.order.findMany.mock.calls[0][0].where as Record<string, unknown>;
  };

  it('under «الكل» it reads the whole history, like the dashboard', async () => {
    expect((await lossWhere('?period=all')).createdAt).toBeUndefined();
  });

  it('under a named period it keeps that window', async () => {
    expect((await lossWhere('?period=30d')).createdAt).toBeDefined();
  });
});
