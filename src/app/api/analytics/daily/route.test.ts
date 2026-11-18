import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE DAILY SERIES ASKS THE DASHBOARD'S KEY AND REFUSES A SPAN IT CANNOT ANSWER (plan 17/11, R9).
 *
 * `reports.view`, the key of the dashboard's own answer: the refusal comes BEFORE anything is read. A span that is not two real days in
 * order, or longer than 92 days, is answered with a sentence and a 400 — and nothing is computed for it.
 */

const { db, requireContext, requirePermission, rate } = vi.hoisted(() => ({
  db: { order: { findMany: vi.fn() } },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  rate: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/rate-limit', () => ({ rateLimit: (...a: unknown[]) => rate(...a) }));

import { GET } from './route';

const ask = (query: string) => GET(new Request(`http://localhost/api/analytics/daily${query}`));

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1', country: { timezone: 'Asia/Damascus' } });
  requirePermission.mockResolvedValue({});
  rate.mockReturnValue({ allowed: true });
  db.order.findMany.mockResolvedValue([]);
});

describe('GET /api/analytics/daily', () => {
  it('answers a span with one row per day, the store’s timezone, and the span it was asked for', async () => {
    const res = await ask('?from=2026-11-01&to=2026-11-02');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.days.map((d: { day: string }) => d.day)).toEqual(['2026-11-01', '2026-11-02']);
    expect(body).toMatchObject({ from: '2026-11-01', to: '2026-11-02', timezone: 'Asia/Damascus', truncated: false });
    expect(requirePermission).toHaveBeenCalledWith('reports.view');
  });

  it('NEGATIVE: without the key nothing is read', async () => {
    requirePermission.mockRejectedValue(Object.assign(new Error('Forbidden: missing required permission reports.view'), { status: 403 }));
    const res = await ask('?from=2026-11-01&to=2026-11-02');
    expect(res.status).toBe(403);
    expect(db.order.findMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a missing, impossible or backwards span is a 400 with a sentence in Arabic, and nothing is read', async () => {
    for (const q of ['', '?from=2026-11-01', '?from=2026-13-40&to=2026-11-02', '?from=2026-11-05&to=2026-11-01']) {
      const res = await ask(q);
      expect(res.status, q).toBe(400);
      expect((await res.json()).errorAr, q).toMatch(/[؀-ۿ]/);
    }
    expect(db.order.findMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a span of 93 days is refused — it is not shortened to what would fit', async () => {
    const res = await ask('?from=2026-01-01&to=2026-04-03');
    expect(res.status).toBe(400);
    expect((await res.json()).errorAr).toContain('92');
    expect(db.order.findMany).not.toHaveBeenCalled();
  });

  it('a runaway client is slowed, and nothing is read for the refused request', async () => {
    rate.mockReturnValue({ allowed: false, retryAfterSec: 12 });
    const res = await ask('?from=2026-11-01&to=2026-11-02');
    expect(res.status).toBe(429);
    expect(db.order.findMany).not.toHaveBeenCalled();
  });
});
