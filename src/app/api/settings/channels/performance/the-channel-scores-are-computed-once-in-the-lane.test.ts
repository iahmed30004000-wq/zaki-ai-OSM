import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE CHANNEL SCORES' READS ARE COMPUTED ONCE PER COMPANY, STORE AND WINDOW, IN THE REPORTS' LANE (13/11 — plan PR-7, item 3).
 *
 * `GET /api/settings/channels/performance` ran fifteen statements on the main pool on every opening of the board and every return to
 * the tab. The reads do not depend on the person — the two keys are checked before them — so they are one computation per company,
 * store and window, in the lane, kept a minute. The scoring after them is cheap arithmetic and stays per request.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, channelPerformance, held, who } = vi.hoisted(() => ({
  db: {
    orderChannel: { findMany: vi.fn() },
    order: { groupBy: vi.fn(), count: vi.fn() },
  },
  channelPerformance: vi.fn(),
  held: { keys: ['reports.view'] as string[], insights: true },
  who: { companyId: 'c1', storeId: 's1' },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({ user: { id: 'u1' }, companyId: who.companyId, storeId: who.storeId }),
}));
vi.mock('@/lib/authorization', () => ({
  requirePermission: async (key: string) => {
    if (!held.keys.includes(key)) throw new Error(`Forbidden: missing required permission ${key}`);
    return { id: 'u1' };
  },
}));
vi.mock('@/lib/insights-key', () => ({
  mayReadInsights: () => held.insights,
  insightsRefused: () => new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }),
}));
vi.mock('@/lib/attribution-performance', () => ({ channelPerformance: (...a: unknown[]) => channelPerformance(...a) }));

import { GET } from './route';
import { inHeavyLane, laneAnswers } from '@/lib/heavy-lane';

const CHANNEL = { id: 'ch1', name: 'فيسبوك', kind: 'ADS', isActive: true };
const ROW = { id: 'ch1', brought: 20, confirmed: 15, decided: 12, delivered: 9, returned: 2, revenue: 450, confirmationRate: 75, deliveryRate: 75 };

beforeEach(() => {
  vi.clearAllMocks();
  laneAnswers.clear();
  held.keys = ['reports.view'];
  held.insights = true;
  who.companyId = 'c1';
  who.storeId = 's1';
  channelPerformance.mockImplementation(async () => {
    await new Promise((r) => setTimeout(r, 5));
    expect(inHeavyLane(), 'the reads must run in the reports’ lane').toBe(true);
    return [ROW];
  });
  db.orderChannel.findMany.mockResolvedValue([CHANNEL]);
  db.order.groupBy.mockResolvedValue([]);
  db.order.count.mockResolvedValue(30);
});

/** Every statement of the fifteen, counted. */
const statements = () => channelPerformance.mock.calls.length + db.orderChannel.findMany.mock.calls.length + db.order.groupBy.mock.calls.length + db.order.count.mock.calls.length;

describe('one computation for one question', () => {
  it('three tabs at the same moment cost ONE set of reads, and all three are answered the same', async () => {
    const res = await Promise.all([GET(), GET(), GET()]);
    expect(res.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(channelPerformance).toHaveBeenCalledTimes(1);
    expect(db.order.groupBy).toHaveBeenCalledTimes(2);
    expect(db.order.count).toHaveBeenCalledTimes(4);
    const bodies = await Promise.all(res.map((r) => r.json()));
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });

  it('every read of the fifteen runs in the lane (not only the first)', async () => {
    const seen: boolean[] = [];
    db.orderChannel.findMany.mockImplementation(async () => {
      seen.push(inHeavyLane());
      return [CHANNEL];
    });
    db.order.count.mockImplementation(async () => {
      seen.push(inHeavyLane());
      return 30;
    });
    await GET();
    expect(seen.length).toBeGreaterThan(3);
    expect(seen.every(Boolean), 'a read escaped the lane').toBe(true);
  });

  it('another company or another store is another computation', async () => {
    await GET();
    const one = statements();
    who.storeId = 's2';
    await GET();
    who.companyId = 'c2';
    await GET();
    expect(statements()).toBe(3 * one);
  });

  it('TENANTS ARE NEVER MIXED: tabs of DIFFERENT companies or stores at the very same moment are separate computations, never one shared answer', async () => {
    // `requireContext` is read when each call starts, so each call sees the tenant that was set just before it.
    who.companyId = 'c1';
    who.storeId = 's1';
    const a = GET();
    who.companyId = 'c2';
    const b = GET();
    who.companyId = 'c1';
    who.storeId = 's2';
    const c = GET();
    await Promise.all([a, b, c]);
    expect(channelPerformance, 'شركتين أو متجرين انحسبوا بحسبة وحدة').toHaveBeenCalledTimes(3);
  });

  it('NEGATIVE: a failed computation is not kept — the next opening computes again and is answered', async () => {
    channelPerformance.mockRejectedValueOnce(new Error('boom'));
    const bad = await GET();
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(laneAnswers.size).toBe(0);
    const good = await GET();
    expect(good.status).toBe(200);
    expect(channelPerformance).toHaveBeenCalledTimes(2);
  });
});

describe('the keys are asked of EVERY caller, before anything is shared', () => {
  it('a person without «عرض التقارير» is refused and nothing is read', async () => {
    held.keys = [];
    const res = await GET();
    expect(res.status).toBe(403);
    expect(statements()).toBe(0);
  });

  it('a person without the smart cards\' key is refused even when somebody with it has just made the answer', async () => {
    await GET();
    const before = statements();
    held.insights = false;
    const res = await GET();
    expect(res.status).toBe(403);
    expect(statements(), 'الرفض ما قرا شي').toBe(before);
  });
});

describe('a KEPT answer (a minute)', () => {
  it('the second opening inside the minute reads the kept computation; after the minute it computes again', async () => {
    vi.resetModules();
    vi.doMock('@/lib/heavy-lane', async (orig) => ({ ...(await orig<typeof import('@/lib/heavy-lane')>()), REPORT_TTL_MS: 60_000 }));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 13, 10, 0, 0));
    const { GET: kept } = await import('./route');
    const { laneAnswers: lane } = await import('@/lib/heavy-lane');
    lane.clear();
    who.companyId = 'c-kept';
    await kept();
    vi.setSystemTime(new Date(2026, 10, 13, 10, 0, 59, 999));
    await kept();
    expect(channelPerformance, 'قبل الدقيقة').toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(2026, 10, 13, 10, 1, 0, 0));
    await kept();
    expect(channelPerformance, 'عند الدقيقة').toHaveBeenCalledTimes(2);
    vi.useRealTimers();
    lane.clear();
    vi.doUnmock('@/lib/heavy-lane');
  });
});
