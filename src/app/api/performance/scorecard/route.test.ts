import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The scorecard's door (step G1): the team table's own key before anything is read; the window is the last 7 days unless asked and never longer than 31; the grain is a
 * day unless it is plainly «week»; the answer is the reader's rows and rules — and the door reads, it never writes.
 */
const { requirePermission, readScorecard } = vi.hoisted(() => ({
  requirePermission: vi.fn(async (_key: string) => undefined),
  readScorecard: vi.fn(async (..._a: unknown[]) => ({ rows: [], rules: { claims: 'x' } })),
}));

vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({
    companyId: 'c1', storeId: 's1',
    country: { workHoursStart: '10:00', workHoursEnd: '22:00', weekendDays: [], timezone: 'Asia/Damascus' },
  }),
}));
vi.mock('@/lib/authorization', () => ({ requirePermission: (k: string) => requirePermission(k) }));
vi.mock('@/lib/agent-scorecard', () => ({ readScorecard: (...a: unknown[]) => readScorecard(...a) }));

import { GET } from './route';

const get = (qs = '') => GET(new Request(`http://localhost/api/performance/scorecard${qs}`));
const scopeOf = () => readScorecard.mock.calls.at(-1)![1] as { start: Date; end: Date; grain: string; companyId: string; storeId: string; calendar: { timezone: string } };

beforeEach(() => vi.clearAllMocks());

describe('GET /api/performance/scorecard', () => {
  it('asks the team table\'s key first, and a refusal reads nothing', async () => {
    requirePermission.mockRejectedValueOnce(Object.assign(new Error('FORBIDDEN'), { status: 403 }));
    const res = await get();
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(requirePermission).toHaveBeenCalledWith('team.monitor');
    expect(readScorecard).not.toHaveBeenCalled();
  });

  it('reads this company and store with the store\'s calendar, a day grain and the last 7 days when nothing is asked', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const s = scopeOf();
    expect(s).toMatchObject({ companyId: 'c1', storeId: 's1', grain: 'day' });
    expect(s.calendar.timezone).toBe('Asia/Damascus');
    const days = (s.end.getTime() - s.start.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    expect(await res.json()).toMatchObject({ grain: 'day', rows: [], rules: { claims: 'x' }, deliveryMaturityDays: 7 });
  });

  it('the grain is «week» only when plainly asked; anything else is a day', async () => {
    await get('?grain=week');
    expect(scopeOf().grain).toBe('week');
    await get('?grain=month');
    expect(scopeOf().grain).toBe('day');
  });

  it('a window longer than 31 days is cut to 31 from its end', async () => {
    await get('?startDate=2026-01-01&endDate=2026-11-10');
    const s = scopeOf();
    expect(Math.round((s.end.getTime() - s.start.getTime()) / 86_400_000)).toBe(31);
  });

  it('writes nothing: the door only reads', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/app/api/performance/scorecard/route.ts', 'utf8');
    expect(src).not.toMatch(/\.(create|update|upsert|delete)\w*\(/);
    expect(src).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/);
  });
});
