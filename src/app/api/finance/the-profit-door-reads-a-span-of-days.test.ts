import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DEFINITION OF DONE — `GET /api/finance?from=YYYY-MM-DD&to=YYYY-MM-DD` hands the span, as days of the STORE's country, to `profitToDate`; without it (or with a bad one) it hands none — what the
 * screen and every other caller got before. The arithmetic itself is pinned in `lib/the-profit-can-be-asked-for-a-span-of-days.test.ts` and `the-profit-summary-is-pinned.test.ts`.
 */
const { profitToDate, requireContext } = vi.hoisted(() => ({
  profitToDate: vi.fn(async () => ({ expenses: [], liveExpenses: [], deliveredOrders: [], summary: { netProfit: 0 } })),
  requireContext: vi.fn(),
}));
// 18/11 (H2): `aggregate` — the door now reads the store's live expenses as they stand (count, sum, newest) to name its kept answer.
vi.mock('@/lib/db', () => ({
  // 25/11 (A1): `courierStatement` — the door reads the store's profit epoch; none here, so the span is handed on exactly as asked.
  db: {
    expense: { groupBy: vi.fn(async () => []), aggregate: vi.fn(async () => ({ _count: { _all: 0 }, _sum: { amount: null }, _max: { createdAt: null } })) },
    courierStatement: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: vi.fn(async () => ({})) }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/profit-to-date', async (orig) => ({ ...(await orig<typeof import('@/lib/profit-to-date')>()), profitToDate: (...a: unknown[]) => (profitToDate as (...x: unknown[]) => unknown)(...a) }));
vi.mock('@/lib/analytics', () => ({
  getCompanyAnalytics: async () => ({ financials: { deliveredRevenue: 0 } }),
  getDateRange: () => ({ start: new Date('2026-11-01T00:00:00Z'), end: new Date('2026-11-30T23:59:59Z') }),
  previousRange: () => null,
}));

import { GET } from './route';

beforeEach(() => {
  profitToDate.mockClear();
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1', country: { currencyCode: 'SYP', timezone: 'Asia/Damascus' } });
});

const ask = (qs: string) => GET(new Request(`http://localhost/api/finance${qs}`));
const windowOf = () => (profitToDate.mock.calls[0] as unknown as [unknown, { start: Date; end: Date } | null | undefined])[1] ?? null;

describe('the span of days on the profit door', () => {
  it('two days of the store become the window the engine adds up', async () => {
    await ask('?from=2026-11-17&to=2026-11-18');
    const w = windowOf()!;
    expect(w.start.toISOString()).toBe('2026-11-16T21:00:00.000Z');
    expect(w.end.toISOString()).toBe('2026-11-18T21:00:00.000Z');
  });

  it.each(['', '?from=2026-11-17', '?from=x&to=y', '?from=2026-11-18&to=2026-11-17'])('%s asks for no window — since the beginning, as always', async (qs) => {
    await ask(qs);
    expect(windowOf()).toBeNull();
  });
});
