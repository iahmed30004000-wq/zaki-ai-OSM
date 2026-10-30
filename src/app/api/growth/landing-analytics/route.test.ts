import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Marketing numbers need their own permission: a confirmation supervisor
 * opens the performance screen for the team tables, and that is all.
 */

const { requirePermission, landingAnalytics, pageVerdicts, mayReadInsights } = vi.hoisted(() => ({
  mayReadInsights: vi.fn(),
  requirePermission: vi.fn(),
  landingAnalytics: vi.fn(),
  pageVerdicts: vi.fn(),
}));

vi.mock('@/lib/geo-context', () => ({ requireContext: async () => ({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1' }) }));
vi.mock('@/lib/insights-key', () => ({ mayReadInsights: (...a: unknown[]) => mayReadInsights(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/landing-analytics', () => ({
  landingAnalytics: (...a: unknown[]) => landingAnalytics(...a),
  pageVerdicts: (...a: unknown[]) => pageVerdicts(...a),
}));

import { GET } from './route';

class Denied extends Error { status = 403; }
vi.mock('@/lib/api-error', () => ({
  apiErrorResponse: (e: unknown) => new Response(JSON.stringify({ error: 'x' }), { status: (e as { status?: number }).status ?? 500 }),
}));

const get = () => GET(new Request('http://localhost/api/growth/landing-analytics?startDate=2026-09-01&endDate=2026-09-30'));

beforeEach(() => {
  vi.clearAllMocks();
  landingAnalytics.mockResolvedValue({ totals: {} });
  pageVerdicts.mockResolvedValue([]);
  mayReadInsights.mockReturnValue(true);
});

describe('the verdicts are smart cards — insights.view (PR-10)', () => {
  it('a reader of the table without the key gets the table and NO verdicts — absent, not an empty list — and the verdicts are not even computed', async () => {
    requirePermission.mockResolvedValue(undefined);
    mayReadInsights.mockReturnValue(false);
    pageVerdicts.mockResolvedValue([{ productId: 'p1', productName: 'س', pages: 2, verdict: { ok: false, waiting: [] } }]);
    const body = await (await get()).json();
    expect(body).toEqual({ totals: {} });
    expect('verdicts' in body).toBe(false);
    expect(pageVerdicts).not.toHaveBeenCalled();
  });

  it('NEGATIVE (the test of the test): with the key the same reader gets them', async () => {
    requirePermission.mockResolvedValue(undefined);
    pageVerdicts.mockResolvedValue([{ productId: 'p1', productName: 'س', pages: 2, verdict: { ok: false, waiting: [] } }]);
    expect((await (await get()).json()).verdicts).toHaveLength(1);
  });

  it('the key alone opens nothing: the reports’ and the pages’ gates still come first', async () => {
    requirePermission.mockImplementation(async () => { throw new Denied(); });
    expect((await get()).status).toBe(403);
    expect(landingAnalytics).not.toHaveBeenCalled();
  });
});

describe('who may read it', () => {
  it('someone who may read reports and landing pages', async () => {
    requirePermission.mockResolvedValue(undefined);
    expect((await get()).status).toBe(200);
    expect(landingAnalytics.mock.calls[0][0]).toMatchObject({ companyId: 'c1', storeId: 's1' });
  });

  it('and the verdict between page copies comes back on the same answer', async () => {
    // One endpoint, one window, one pair of gates. A second endpoint would
    // be a second place for the date window to be computed differently.
    requirePermission.mockResolvedValue(undefined);
    pageVerdicts.mockResolvedValue([{ productId: 'p1', productName: 'س', pages: 2, verdict: { ok: false, waiting: [] } }]);

    const body = await (await get()).json();
    expect(body.verdicts).toHaveLength(1);
    expect(pageVerdicts.mock.calls[0][0]).toMatchObject(landingAnalytics.mock.calls[0][0]);
  });

  it('not a supervisor with reports but no landing pages', async () => {
    requirePermission.mockImplementation(async (key: string) => {
      if (key === 'landing_pages.view') throw new Denied();
    });
    expect((await get()).status).toBe(403);
    expect(landingAnalytics).not.toHaveBeenCalled();
    expect(pageVerdicts).not.toHaveBeenCalled();
  });

  it('not someone with landing pages but neither reports nor analytics', async () => {
    requirePermission.mockImplementation(async (key: string) => {
      if (key !== 'landing_pages.view') throw new Denied();
    });
    expect((await get()).status).toBe(403);
    expect(landingAnalytics).not.toHaveBeenCalled();
    expect(pageVerdicts).not.toHaveBeenCalled();
  });
});
