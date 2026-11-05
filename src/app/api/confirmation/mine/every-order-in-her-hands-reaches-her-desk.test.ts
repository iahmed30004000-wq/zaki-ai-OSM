import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * سلوى، 5/11: 233 in her hands, 200 of them «لا يرد» with a follow-up date, and one fresh pull with none. The desk read
 * `take: 200` by `nextFollowUpAt asc` — Postgres puts a NULL LAST in an ascending sort — so the fresh pull was the row cut
 * off: «للشغل (0)», and the pull refused her «سجّل محاولة على ORD-…» about an order on no card of hers.
 *
 * The mock below sorts and cuts the way Postgres does (NULL last unless `nulls: 'first'`), so the test fails on the old
 * read and passes on the new one — a mock that ignored `orderBy` and `take` would pass both.
 */

type Row = { id: string; confirmationStatus: string; nextFollowUpAt: Date | null; claimedAt: Date; customer: { id: string; totalOrders: number } };
type Sort = 'asc' | 'desc' | { sort: 'asc' | 'desc'; nulls?: 'first' | 'last' };
type FindArgs = { orderBy?: Record<string, Sort>[]; take?: number };

const { db, rows } = vi.hoisted(() => ({
  db: {
    order: { findMany: vi.fn(), count: vi.fn(async () => 0) },
    orderContactAttempt: { groupBy: vi.fn(), findMany: vi.fn(async () => []) },
  },
  rows: { value: [] as Row[] },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({
    user: { id: 'u1', name: 'Salwa', role: 'CONFIRMATION_AGENT', companyId: 'c1', permissions: [] },
    companyId: 'c1',
    storeId: 's1',
    countryId: 'co1',
    country: { id: 'co1', code: 'SY', timezone: 'Asia/Damascus', workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5] },
  }),
}));
vi.mock('@/lib/authorization', () => ({ requirePermission: async () => undefined, can: () => false }));
vi.mock('@/lib/insights-key', () => ({ mayReadInsights: () => false }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: async () => undefined }));
vi.mock('@/lib/response-clock', () => ({ firstActionTimes: async () => new Map() }));
vi.mock('@/lib/no-answer-rounds-switch', () => ({ roundsSwitch: async () => ({ enabled: false, enabledAt: null }) }));

import { GET } from './route';
import { CLAIM_CAPS } from '@/lib/confirmation-queue';

/** Postgres's ORDER BY … LIMIT: NULL sorts LAST ascending (FIRST descending) unless the sort says otherwise. */
function asPostgres(all: Row[], args: FindArgs): Row[] {
  const keys = (args.orderBy ?? []).flatMap((o) => Object.entries(o)) as [keyof Row, Sort][];
  const sorted = [...all].sort((a, b) => {
    for (const [key, s] of keys) {
      const dir = typeof s === 'string' ? s : s.sort;
      const nulls = typeof s === 'string' ? (dir === 'asc' ? 'last' : 'first') : (s.nulls ?? (dir === 'asc' ? 'last' : 'first'));
      const x = a[key] as Date | null;
      const y = b[key] as Date | null;
      if (x === null && y === null) continue;
      if (x === null) return nulls === 'first' ? -1 : 1;
      if (y === null) return nulls === 'first' ? 1 : -1;
      const d = (x.getTime() - y.getTime()) * (dir === 'asc' ? 1 : -1);
      if (d !== 0) return d;
    }
    return 0;
  });
  return args.take === undefined ? sorted : sorted.slice(0, args.take);
}

const at = (min: number) => new Date(Date.UTC(2026, 10, 5, 6, min));
const noAnswer = (i: number): Row => ({
  id: `na-${i}`,
  confirmationStatus: 'NO_ANSWER',
  nextFollowUpAt: at(i % 600),
  claimedAt: at(i % 600),
  customer: { id: `c-na-${i}`, totalOrders: 1 },
});
const fresh: Row = { id: 'ord-2912', confirmationStatus: 'IN_PROGRESS', nextFollowUpAt: null, claimedAt: at(700), customer: { id: 'c-2912', totalOrders: 1 } };

beforeEach(() => {
  vi.clearAllMocks();
  // The first findMany is the desk's open orders; the other two (closed today, confirmed) are empty.
  db.order.findMany.mockImplementationOnce(async (args: FindArgs) => asPostgres(rows.value, args)).mockResolvedValue([]);
  db.orderContactAttempt.groupBy.mockImplementation(async () =>
    rows.value.filter((r) => r.id.startsWith('na-')).map((r) => ({ orderId: r.id, _count: { _all: 1 } }))
  );
});

describe('«طلباتي» — every order in her hands reaches her desk', () => {
  it('سلوى: 232 «لا يرد» with a date and one fresh pull — the fresh pull is under «للشغل»', async () => {
    rows.value = [...Array.from({ length: 232 }, (_, i) => noAnswer(i)), fresh];
    const data = await (await GET(new Request('http://localhost/api/confirmation/mine'))).json();
    expect(data.work.map((o: { id: string }) => o.id)).toEqual(['ord-2912']);
    expect(data.noAnswer).toHaveLength(232);
  });

  it('at the cap — 299 dated and one undated — all 300 are listed, nothing past the end', async () => {
    rows.value = [...Array.from({ length: CLAIM_CAPS.total - 1 }, (_, i) => noAnswer(i)), fresh];
    const data = await (await GET(new Request('http://localhost/api/confirmation/mine'))).json();
    expect(data.work.length + data.noAnswer.length).toBe(CLAIM_CAPS.total);
    expect(data.work.map((o: { id: string }) => o.id)).toEqual(['ord-2912']);
  });

  it('the read asks for the whole cap, the undated first', () => {
    // Pinned on the call itself too, so a later «tidy» back to `'asc'` or a smaller page is caught here by name.
    return GET(new Request('http://localhost/api/confirmation/mine')).then(() => {
      const args = db.order.findMany.mock.calls[0][0] as FindArgs;
      expect(args.take).toBeGreaterThanOrEqual(CLAIM_CAPS.total);
      expect(args.orderBy?.[0]).toEqual({ nextFollowUpAt: { sort: 'asc', nulls: 'first' } });
    });
  });
});
