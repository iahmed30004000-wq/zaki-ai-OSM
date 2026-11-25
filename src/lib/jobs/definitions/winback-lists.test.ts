import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «قوايم الاسترجاع» job (F12): store by store, the 3-day expiry, then the one-shift move with the REAL eligible list of that store
 * (`bulkAgents` — who may be handed an order there) and the store country's calendar. A store with no list row moves nothing.
 */
const { expireLists, autoMoveIdleLists, bulkAgents, count } = vi.hoisted(() => ({
  expireLists: vi.fn(async () => 2),
  autoMoveIdleLists: vi.fn(async () => 1),
  bulkAgents: vi.fn(async () => [{ id: 'sara', name: 'س', listOpen: 0 }, { id: 'huda', name: 'ه', listOpen: 3 }]),
  count: vi.fn(async () => 5),
}));
vi.mock('../../db', () => ({ db: { order: { count } } }));
vi.mock('../../winback-private-list', () => ({ expireLists, autoMoveIdleLists }));
vi.mock('../../winback-bulk', () => ({ bulkAgents }));
vi.mock('./shared', () => ({
  activeStores: async () => [
    { id: 's1', companyId: 'c1', country: { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Damascus' } },
    { id: 's2', companyId: 'c1', country: { workHoursStart: '10:00', workHoursEnd: '18:00', weekendDays: [5], timezone: 'Asia/Amman' } },
  ],
}));

import { winbackLists } from './winback-lists';

beforeEach(() => vi.clearAllMocks());

describe('the job', () => {
  it('B36/B37 — expires, then moves with the real eligible list and the calendar of EACH store', async () => {
    const now = new Date('2026-11-29T05:00:00Z');
    const r = await winbackLists.run({ now } as never);
    expect(expireLists.mock.calls.map((c: any[]) => c[1])).toEqual([{ companyId: 'c1', storeId: 's1' }, { companyId: 'c1', storeId: 's2' }]);
    expect(bulkAgents.mock.calls.map((c: any[]) => c[0])).toEqual([{ companyId: 'c1', storeId: 's1' }, { companyId: 'c1', storeId: 's2' }]);
    const first = autoMoveIdleLists.mock.calls[0] as any[];
    expect(first[1]).toEqual({ companyId: 'c1', storeId: 's1' });
    expect(first[2]).toEqual({ workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Damascus' });
    expect(first[3]).toBe(now);
    expect(first[4]).toEqual(['sara', 'huda']);
    expect((autoMoveIdleLists.mock.calls[1] as any[])[2].timezone).toBe('Asia/Amman');
    expect(r.processed).toBe(2 * 2 + 2 * 1);
  });

  it('a store with no list row expires (nothing) and moves nothing', async () => {
    count.mockResolvedValue(0);
    await winbackLists.run({ now: new Date() } as never);
    expect(expireLists).toHaveBeenCalledTimes(2);
    expect(autoMoveIdleLists).not.toHaveBeenCalled();
    expect(bulkAgents).not.toHaveBeenCalled();
  });
});
