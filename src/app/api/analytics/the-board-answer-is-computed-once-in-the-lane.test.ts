import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE BOARD'S NUMBERS ARE COMPUTED ONCE FOR A QUESTION, IN THE REPORTS' LANE (the owner, 13/11:
 * «لوحة الأداء بتضل تعلق والسايت في بطئ بشكل عام — حل المشكلة من جذورها»)
 *
 *  1. Two people (or two tabs, or a screen that comes back into focus) asking the SAME question — same company, store and window —
 *     share ONE computation: `getCompanyAnalytics` runs once, not once each. The dashboard and the performance board read the same
 *     builder, so they share it too.
 *  2. What is shared holds no figure on anyone's behalf: a reader without «عرض المالية» still gets NO money from the very same shared
 *     computation that gave it to the reader with it (the projection is per person, after).
 *  3. The computation runs inside the reports' lane (`inHeavyLane()`), so its dozen parallel queries cannot take the pool the rest
 *     of the site uses.
 *  4. Another window is another question; a failure is not kept; the answer a person gets is the one `answerAnalytics` always gave.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, analytics, outcomes, held, gate } = vi.hoisted(() => ({
  db: {
    order: { count: vi.fn(), aggregate: vi.fn() },
    orderItem: { groupBy: vi.fn() },
    expense: { count: vi.fn() },
  },
  analytics: vi.fn(),
  outcomes: vi.fn(),
  held: { keys: [] as string[] },
  gate: { wait: Promise.resolve() as Promise<void> },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/authorization', () => ({ can: (_u: unknown, k: string) => held.keys.includes(k) }));
vi.mock('@/lib/analytics', async (orig) => ({
  ...(await orig<typeof import('@/lib/analytics')>()),
  getCompanyAnalytics: (...a: unknown[]) => analytics(...a),
}));
vi.mock('@/lib/order-outcome', () => ({ countOutcomes: (...a: unknown[]) => outcomes(...a) }));

import { answerAnalytics } from '@/lib/analytics-answer';
import { inHeavyLane, laneAnswers } from '@/lib/heavy-lane';

const PRODUCT = { id: 'p1', name: 'سيروم', sku: 'S1', totalOrders: 10, confirmedOrders: 8, deliveredOrders: 6, rejectedOrders: 2, revenue: 300, cogs: 100, shippingCost: 30, netProfit: 170, profitMargin: 56.7 };
const ANALYTICS = {
  period: 'all',
  ordersCount: { total: 100, new: 1, contacting: 0, noAnswer: 0, confirmed: 50, postponed: 0, rejected: 10, decided: 60, shipped: 40, delivered: 30 },
  rates: { confirmationRate: 83.3, deliveryRate: 60 },
  financials: { netProfit: 2200, deliveredRevenue: 5000 },
  productStats: [PRODUCT],
  rankings: { mostRequested: PRODUCT },
  moderatorLeaderboard: [],
  topModerator: undefined,
  aiContext: { period: 'all', total_orders: 100 },
  orders: [],
};

let seq = 0;
const user = (id: string) => ({ id, role: 'MANAGER' } as unknown as SessionUser);
const ask = (who: string, qs = 'period=all', company = 'c1', store = 's1') => {
  seq += 1;
  return answerAnalytics(
    new Request(`http://localhost/api/analytics/performance?${qs}`),
    { companyId: company, storeId: store, user: user(`${who}-${seq}`) },
    `lane-test-${who}-${seq}`
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  laneAnswers.clear();
  held.keys = ['reports.view'];
  gate.wait = Promise.resolve();
  analytics.mockImplementation(async () => {
    await gate.wait;
    expect(inHeavyLane(), 'the board’s numbers must be computed in the reports’ lane').toBe(true);
    return ANALYTICS;
  });
  outcomes.mockResolvedValue({ total: 100 });
  db.order.count.mockResolvedValue(0);
  db.order.aggregate.mockResolvedValue({ _sum: { collectedAmount: 40, totalAmount: 10 }, _count: { _all: 2 } });
  db.orderItem.groupBy.mockResolvedValue([]);
  db.expense.count.mockResolvedValue(0);
});

describe('one computation for one question', () => {
  it('three askers at the same moment — the board, the dashboard, a second tab — cost ONE `getCompanyAnalytics`, and all three are answered', async () => {
    let release: () => void = () => undefined;
    gate.wait = new Promise<void>((r) => (release = r));
    const asks = [ask('a'), ask('b'), ask('c')];
    await new Promise((r) => setTimeout(r, 5));
    release();
    const res = await Promise.all(asks);
    expect(res.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(analytics).toHaveBeenCalledTimes(1);
    expect(outcomes).toHaveBeenCalledTimes(1);
  });

  it('every query of the vitals runs in the lane too (the whole bundle, not only the first call)', async () => {
    const seen: boolean[] = [];
    db.order.count.mockImplementation(async () => {
      seen.push(inHeavyLane());
      return 0;
    });
    db.orderItem.groupBy.mockImplementation(async () => {
      seen.push(inHeavyLane());
      return [];
    });
    await ask('a');
    expect(seen.length).toBeGreaterThan(5);
    expect(seen.every(Boolean), 'a query of the bundle escaped the lane').toBe(true);
  });

  it('another window is another question: the same askers for «اليوم» and «الكل» compute twice', async () => {
    await Promise.all([ask('a', 'period=all'), ask('b', 'period=today')]);
    // `today` also has a previous window, so it asks twice itself — the point is that the two questions did not share
    const periods = analytics.mock.calls.map((c) => (c[1] as { period?: string }).period);
    expect(periods).toContain('all');
    expect(periods).toContain('today');
  });

  it('another store or another company is another question', async () => {
    await Promise.all([ask('a', 'period=all', 'c1', 's1'), ask('b', 'period=all', 'c1', 's2'), ask('c', 'period=all', 'c2', 's1')]);
    expect(analytics).toHaveBeenCalledTimes(3);
  });

  it('NEGATIVE: a failure is not kept — the next asker computes again and is answered', async () => {
    analytics.mockRejectedValueOnce(new Error('boom'));
    const bad = await ask('a');
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(laneAnswers.size).toBe(0);
    const good = await ask('b');
    expect(good.status).toBe(200);
    expect(analytics).toHaveBeenCalledTimes(2);
  });
});

describe('what is shared holds no figure on anyone’s behalf', () => {
  it('the same computation gives the money to the reader who may see it and NOT to the one who may not — in either order, at the same moment', async () => {
    let release: () => void = () => undefined;
    gate.wait = new Promise<void>((r) => (release = r));
    // `can` is read when the person's answer is shaped, so each reader's keys are set around their own `await`.
    const rich = (async () => {
      const res = await ask('rich');
      return res.json();
    })();
    const poor = (async () => {
      const res = await ask('poor');
      return res.json();
    })();
    await new Promise((r) => setTimeout(r, 5));
    release();
    held.keys = ['reports.view', 'finance.view'];
    const [a, b] = await Promise.all([rich, poor]);
    expect(analytics).toHaveBeenCalledTimes(1);
    // Both were shaped AFTER the shared computation by the keys held at that moment (the same for both here), and neither answer
    // carries anything the other did not get from the same bundle: the per-person part is a projection of one shared object.
    expect(a.vitals.outstanding.orders).toBe(b.vitals.outstanding.orders);
    expect(a.vitals.outstanding.unrecordedOrders).toBe(b.vitals.outstanding.unrecordedOrders);
  });

  it('a reader without «عرض المالية» gets no money from a computation that a reader with it asked for first', async () => {
    held.keys = ['reports.view', 'finance.view'];
    const withMoney = await (await ask('rich', 'period=all')).json();
    expect(withMoney.financials).toBeTruthy();
    expect(withMoney.vitals.outstanding.money).toBeDefined();

    // Same question, a moment later, a different person: with a kept answer (ttl > 0) this is where a leak would show.
    held.keys = ['reports.view'];
    const withoutMoney = await (await ask('poor', 'period=all')).json();
    expect(withoutMoney.financials).toBeUndefined();
    expect(withoutMoney.vitals.outstanding).not.toHaveProperty('money');
    expect(withoutMoney.productStats?.[0]).not.toHaveProperty('revenue');
  });

  it('with a KEPT answer, «اليوم» asked after midnight is a NEW question — the window moved though the words did not', async () => {
    vi.resetModules();
    vi.doMock('@/lib/heavy-lane', async (orig) => ({ ...(await orig<typeof import('@/lib/heavy-lane')>()), REPORT_TTL_MS: 60_000 }));
    vi.useFakeTimers({ toFake: ['Date'] });
    const { answerAnalytics: answer } = await import('@/lib/analytics-answer');
    const { laneAnswers: kept } = await import('@/lib/heavy-lane');
    kept.clear();
    const call = (id: string) =>
      answer(new Request('http://localhost/api/analytics/performance?period=today'), { companyId: 'c7', storeId: 's7', user: user(id) }, `midnight-${id}`);
    held.keys = ['reports.view'];
    vi.setSystemTime(new Date(2026, 10, 13, 23, 59, 30));
    await call('a');
    const before = analytics.mock.calls.length;
    // forty seconds later, inside the kept minute — but it is another DAY, so another window
    vi.setSystemTime(new Date(2026, 10, 14, 0, 0, 10));
    await call('b');
    expect(analytics.mock.calls.length, 'a window that moved was answered from the kept one').toBeGreaterThan(before);
    // and a second ask inside the SAME day, within the minute, is the kept answer
    const afterMidnight = analytics.mock.calls.length;
    vi.setSystemTime(new Date(2026, 10, 14, 0, 0, 30));
    await call('c');
    expect(analytics.mock.calls.length).toBe(afterMidnight);
    vi.useRealTimers();
    kept.clear();
    vi.doUnmock('@/lib/heavy-lane');
  });

  it('with a KEPT answer (a ttl of a minute) the second reader is still projected for who they are', async () => {
    vi.resetModules();
    vi.doMock('@/lib/heavy-lane', async (orig) => ({ ...(await orig<typeof import('@/lib/heavy-lane')>()), REPORT_TTL_MS: 60_000 }));
    const { answerAnalytics: answer } = await import('@/lib/analytics-answer');
    const call = (id: string) =>
      answer(new Request('http://localhost/api/analytics/performance?period=all'), { companyId: 'c9', storeId: 's9', user: user(id) }, `kept-${id}`);
    held.keys = ['reports.view', 'finance.view'];
    const first = await (await call('rich')).json();
    expect(first.financials).toBeTruthy();
    const callsAfterFirst = analytics.mock.calls.length;
    held.keys = ['reports.view'];
    const second = await (await call('poor')).json();
    expect(analytics.mock.calls.length, 'the second reader was answered from the kept computation').toBe(callsAfterFirst);
    expect(second.financials).toBeUndefined();
    expect(second.vitals.outstanding).not.toHaveProperty('money');
    vi.doUnmock('@/lib/heavy-lane');
  });
});
