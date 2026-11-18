import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE QUEUE'S HEALTH BOARD ASKS ONCE A MINUTE PER STORE, IN THE REPORTS LANE (H2, cause 7 of the hang — 18/11). Every supervisor with the board open
 * asked every two minutes; the same store's counts are now computed once on the reports' pool and kept the minute. The key is the company and the store —
 * never the reader. The switch stays live: off, nothing is read. The job that raises the alerts keeps reading fresh (another process; not this door).
 * The TTL is injected (0 under test).
 */

const { state, readQueueHealth, readRecalibration } = vi.hoisted(() => ({
  state: { storeId: 's1', on: true, lanes: [] as boolean[] },
  readQueueHealth: vi.fn(),
  readRecalibration: vi.fn(),
}));

vi.mock('@/lib/heavy-lane', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/heavy-lane')>()), REPORT_TTL_MS: 60_000 }));
vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({
    companyId: 'c1',
    storeId: state.storeId,
    country: { workHoursStart: '09:00', workHoursEnd: '21:00', weekendDays: [5], timezone: 'Asia/Damascus' },
  }),
}));
vi.mock('@/lib/authorization', () => ({ requirePermission: async () => undefined }));
vi.mock('@/lib/queue-priority-switch', () => ({ queuePrioritySwitch: async () => ({ enabled: state.on }) }));
vi.mock('@/lib/queue-health', () => ({ readQueueHealth: (...a: unknown[]) => readQueueHealth(...a) }));
vi.mock('@/lib/queue-recalibration', () => ({ readRecalibration: (...a: unknown[]) => readRecalibration(...a) }));

import { inHeavyLane, laneAnswers } from '@/lib/heavy-lane';
import { GET } from './route';

const HEALTH = { backlog: 3, dueNow: 1, oldestDueHours: 2, enteredToday: 1, closedToday: 0, newWaiting: 0, oldestNewMinutes: null, noPullMinutes: 5, inShift: true };

beforeEach(() => {
  laneAnswers.clear();
  state.storeId = 's1';
  state.on = true;
  state.lanes = [];
  readQueueHealth.mockReset().mockImplementation(async () => {
    state.lanes.push(inHeavyLane());
    return HEALTH;
  });
  readRecalibration.mockReset().mockImplementation(async () => {
    state.lanes.push(inHeavyLane());
    return { note: 'ملاحظة' };
  });
});

describe('the health board', () => {
  it('reads in the reports lane; the same store within the minute is the kept answer, word for word', async () => {
    const a = await (await GET()).json();
    const b = await (await GET()).json();
    expect(readQueueHealth).toHaveBeenCalledTimes(1);
    expect(readRecalibration).toHaveBeenCalledTimes(1);
    expect(state.lanes).toEqual([true, true]);
    expect(b).toEqual(a);
    expect(a).toMatchObject({ enabled: true, health: HEALTH, weekly: 'ملاحظة' });
  });

  it('another store of the company is another question', async () => {
    await GET();
    state.storeId = 's2';
    await GET();
    expect(readQueueHealth).toHaveBeenCalledTimes(2);
    expect(readQueueHealth.mock.calls.map((c) => (c[1] as { storeId: string }).storeId)).toEqual(['s1', 's2']);
  });

  it('the switch is read live: off, the answer is «off» and nothing is read, even with an answer kept', async () => {
    await GET();
    state.on = false;
    expect(await (await GET()).json()).toEqual({ enabled: false });
    expect(readQueueHealth).toHaveBeenCalledTimes(1);
  });
});
