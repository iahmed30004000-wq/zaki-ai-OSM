import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE DAILY AD-SPEND PULL ASKS AGAIN FOR WHAT FAILED.
 *
 * It runs once a day at 06:00 and a day's schedule does not run twice, so one
 * bad minute at the platform (a rate limit, a dropped connection) used to mean
 * a day of campaigns with yesterday's cost. A store whose account failed is
 * asked again — twice more, 90 s and 300 s apart — and a store that came
 * through is never asked twice. A failure that does not go away is still said
 * in the detail line, with how many times it was tried.
 */

const { syncAdSpend, activeStores } = vi.hoisted(() => ({
  syncAdSpend: vi.fn(),
  activeStores: vi.fn(),
}));

vi.mock('@/lib/ads/sync', () => ({ syncAdSpend: (...a: unknown[]) => syncAdSpend(...a) }));
// The per-ad, per-day grain (`ads/daily.ts`) has its own tests; here it is a pull that finds nothing, so these stay about the retries.
vi.mock('@/lib/ads/daily', () => ({ syncDailyAdSpend: async () => ({ rows: 0, errors: [] }) }));
vi.mock('@/lib/jobs/definitions/shared', () => ({ activeStores: () => activeStores() }));

import { pullAdSpend } from './definitions/pull-ad-spend';

const store = (id: string) => ({ id, companyId: 'c1', countryId: 'sy', country: { id: 'sy' } });
const ok = (updated = 0) => ({ updated, accounts: [{ account: 'A', updated, error: null }] });
const failed = (account = 'حساب ميتا', error = 'ميتا أوقفت الطلبات مؤقتاً') => ({
  updated: 0,
  accounts: [{ account, updated: 0, error }],
});
const callsFor = (id: string) => syncAdSpend.mock.calls.filter(([scope]) => scope.storeId === id).length;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-15T03:00:00.000Z'));
  syncAdSpend.mockReset();
  activeStores.mockReset();
  activeStores.mockResolvedValue([store('s1'), store('s2')]);
});

afterEach(() => {
  vi.useRealTimers();
});

const run = () => pullAdSpend.run({ now: new Date(), db: {} as never });

describe('a pull that came through', () => {
  it('asks each store once, never waits, and says nothing about tries', async () => {
    syncAdSpend.mockResolvedValue(ok(2));
    const result = await run();

    expect(callsFor('s1')).toBe(1);
    expect(callsFor('s2')).toBe(1);
    expect(result.processed).toBe(4);
    expect(result.detail).toBe('حُدِّثت 4 حملة');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('a store whose account failed', () => {
  it('is asked again after 90 seconds, and the store that came through is not', async () => {
    syncAdSpend.mockImplementation(async (scope: { storeId: string }) =>
      scope.storeId === 's2' && callsFor('s2') === 1 ? failed() : ok(1)
    );

    const pending = run();
    await vi.advanceTimersByTimeAsync(89_999);
    expect(callsFor('s2')).toBe(1); // still waiting: the first retry is at 90 s
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(callsFor('s1')).toBe(1);
    expect(callsFor('s2')).toBe(2);
    expect(result.processed).toBe(2);
    expect(result.detail).toBe('حُدِّثت 2 حملة (بعد 2 محاولات)');
    expect(result.detail).not.toContain('بخطأ');
  });

  it('is asked a third time 300 seconds after the second, and then the failure is said with the tries', async () => {
    syncAdSpend.mockImplementation(async (scope: { storeId: string }) => (scope.storeId === 's1' ? failed() : ok(0)));

    const pending = run();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(callsFor('s1')).toBe(2);
    await vi.advanceTimersByTimeAsync(299_999);
    expect(callsFor('s1')).toBe(2); // the second retry is at +300 s from the first
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(callsFor('s1')).toBe(3);
    expect(callsFor('s2')).toBe(1);
    expect(result.detail).toBe('حُدِّثت 0 حملة · 1 حساب بخطأ · بعد 3 محاولات: حساب ميتا: ميتا أوقفت الطلبات مؤقتاً');
  });

  it('keeps what an earlier pass wrote: the updates of every pass are counted', async () => {
    syncAdSpend.mockImplementation(async (scope: { storeId: string }) => {
      if (scope.storeId !== 's1') return ok(0);
      return callsFor('s1') === 1 ? { updated: 3, accounts: [{ account: 'A', updated: 3, error: 'x' }] } : ok(2);
    });

    const pending = run();
    await vi.advanceTimersByTimeAsync(90_000);
    const result = await pending;

    expect(result.processed).toBe(5);
  });

  it('is not asked again when the job has already used up its budget', async () => {
    // The runner treats a RUNNING row older than 30 minutes as abandoned, so the retries stop
    // starting once 15 minutes are gone — a slow first pass leaves no room for a wait.
    syncAdSpend.mockImplementation(async () => {
      vi.advanceTimersByTime(14 * 60_000);
      return failed();
    });
    activeStores.mockResolvedValue([store('s1')]);

    const result = await run();

    expect(callsFor('s1')).toBe(1);
    expect(result.detail).toContain('1 حساب بخطأ');
    expect(result.detail).not.toContain('بعد');
    expect(vi.getTimerCount()).toBe(0);
  });
});
