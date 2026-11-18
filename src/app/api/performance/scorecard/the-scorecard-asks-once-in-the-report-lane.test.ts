import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE SCORECARD ASKS ONCE A MINUTE, IN THE REPORTS LANE (H2, cause 8 of the hang — 18/11). Up to 4 × 50,000 + 100,000 rows were read on the
 * site's main pool at every opening of the board. The reading now runs on the reports' pool (`inHeavyLane()` inside it), and the same question within
 * the minute is the kept answer. The question is the company, the store, the window and the grain — never the reader. The TTL is injected (0 under test).
 */

const { state, readScorecard } = vi.hoisted(() => ({
  state: { storeId: 's1', lanes: [] as boolean[] },
  readScorecard: vi.fn(),
}));

vi.mock('@/lib/heavy-lane', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/heavy-lane')>()), REPORT_TTL_MS: 60_000 }));
vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({
    companyId: 'c1',
    storeId: state.storeId,
    country: { workHoursStart: '10:00', workHoursEnd: '22:00', weekendDays: [], timezone: 'Asia/Damascus' },
  }),
}));
vi.mock('@/lib/authorization', () => ({ requirePermission: async () => undefined }));
vi.mock('@/lib/agent-scorecard', () => ({ readScorecard: (...a: unknown[]) => readScorecard(...a) }));

import { inHeavyLane, laneAnswers } from '@/lib/heavy-lane';
import { GET } from './route';

const get = (qs = '?startDate=2026-11-10&endDate=2026-11-16') => GET(new Request(`http://localhost/api/performance/scorecard${qs}`));

beforeEach(() => {
  laneAnswers.clear();
  state.storeId = 's1';
  state.lanes = [];
  readScorecard.mockReset().mockImplementation(async () => {
    state.lanes.push(inHeavyLane());
    return { rows: [{ userId: 'u1' }], rules: { claims: 'x' } };
  });
});

describe('the scorecard door', () => {
  it('reads in the reports lane, and the same question within the minute is the kept answer — the same body', async () => {
    const a = await (await get()).json();
    const b = await (await get()).json();
    expect(readScorecard).toHaveBeenCalledTimes(1);
    expect(state.lanes).toEqual([true]);
    expect(b).toEqual(a);
  });

  it('another store of the company is another question', async () => {
    await get();
    state.storeId = 's2';
    await get();
    expect(readScorecard).toHaveBeenCalledTimes(2);
  });

  it('another window, or another grain, is another question', async () => {
    await get();
    await get('?startDate=2026-11-10&endDate=2026-11-15');
    await get('?startDate=2026-11-10&endDate=2026-11-16&grain=week');
    expect(readScorecard).toHaveBeenCalledTimes(3);
  });
});
