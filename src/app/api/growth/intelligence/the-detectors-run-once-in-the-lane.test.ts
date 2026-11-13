import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE INTELLIGENCE DETECTORS RUN ONCE PER COMPANY AND STORE, IN THE REPORTS' LANE (13/11 — plan PR-7, item 2).
 *
 * `GET /api/growth/intelligence` ran eleven detectors (about half a second, 21 statements, the whole history, on the pool the rest
 * of the site uses) on EVERY dashboard mount. What they find does not depend on who asks — the key is checked before — so two askers
 * at the same moment share one run, in the lane, and the permission is still asked of each.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, runDetectors, who, held } = vi.hoisted(() => ({
  db: { order: { count: vi.fn() } },
  runDetectors: vi.fn(),
  who: { companyId: 'c1', storeId: 's1' },
  held: { keys: ['growth.intelligence'] as string[] },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({ companyId: who.companyId, storeId: who.storeId, country: { minorUnit: 2, currencyCode: 'USD' } }),
}));
vi.mock('@/lib/authorization', () => ({
  requirePermission: async (key: string) => {
    if (!held.keys.includes(key)) throw new Error(`Forbidden: missing required permission ${key}`);
    return { id: 'u1' };
  },
}));
vi.mock('@/lib/intelligence', async (orig) => ({
  ...(await orig<typeof import('@/lib/intelligence')>()),
  runDetectors: (...a: unknown[]) => runDetectors(...a),
}));

import { GET } from './route';
import { inHeavyLane, laneAnswers } from '@/lib/heavy-lane';

const FINDING = { id: 'f1', family: 'orders', severity: 'ALARM' };

beforeEach(() => {
  vi.clearAllMocks();
  laneAnswers.clear();
  who.companyId = 'c1';
  who.storeId = 's1';
  held.keys = ['growth.intelligence'];
  db.order.count.mockResolvedValue(10);
  runDetectors.mockImplementation(async () => {
    await new Promise((r) => setTimeout(r, 5));
    expect(inHeavyLane(), 'the detectors must run in the reports’ lane').toBe(true);
    return { findings: [FINDING], skipped: [] };
  });
});

describe('one run for one question', () => {
  it('three dashboards at the same moment cost ONE run of the detectors, and all three are answered the same', async () => {
    const res = await Promise.all([GET(), GET(), GET()]);
    expect(res.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(runDetectors).toHaveBeenCalledTimes(1);
    const bodies = await Promise.all(res.map((r) => r.json()));
    expect(bodies[0].findings).toHaveLength(1);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    expect(bodies[0].counts).toEqual({ alarm: 1, watch: 0 });
  });

  it('another company or another store is another run', async () => {
    await GET();
    who.storeId = 's2';
    await GET();
    who.companyId = 'c2';
    await GET();
    expect(runDetectors).toHaveBeenCalledTimes(3);
  });

  it('TENANTS ARE NEVER MIXED: dashboards of DIFFERENT companies or stores at the very same moment are separate runs, never one shared answer', async () => {
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
    expect(runDetectors, 'شركتين أو متجرين انحسبوا بحسبة وحدة').toHaveBeenCalledTimes(3);
  });

  it('the permission is still asked of EVERY caller: a person without the key gets a refusal and no run', async () => {
    held.keys = [];
    const res = await GET();
    expect(res.status).toBe(403);
    expect(runDetectors).not.toHaveBeenCalled();
  });

  it('…even when somebody with the key has just made the answer', async () => {
    await GET();
    held.keys = [];
    const res = await GET();
    expect(res.status).toBe(403);
    expect((await res.json()).findings).toBeUndefined();
  });

  it('NEGATIVE: a failed run is not kept — the next dashboard computes again and is answered', async () => {
    runDetectors.mockRejectedValueOnce(new Error('boom'));
    const bad = await GET();
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(laneAnswers.size).toBe(0);
    const good = await GET();
    expect(good.status).toBe(200);
    expect(runDetectors).toHaveBeenCalledTimes(2);
  });

  it('the count of orders is still read fresh, outside the shared run (it is one statement and it is the shop\'s own)', async () => {
    await Promise.all([GET(), GET()]);
    expect(db.order.count).toHaveBeenCalledTimes(2);
  });
});

describe('a KEPT answer (a minute)', () => {
  it('the second dashboard inside the minute reads the kept run; after the minute it computes again', async () => {
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
    expect(runDetectors, 'قبل الدقيقة').toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(2026, 10, 13, 10, 1, 0, 0));
    await kept();
    expect(runDetectors, 'عند الدقيقة').toHaveBeenCalledTimes(2);
    vi.useRealTimers();
    lane.clear();
    vi.doUnmock('@/lib/heavy-lane');
  });
});
