import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE DAILY GRAIN OF AD SPEND (PR-A of the media buyer's doors) — what Meta is asked, how the answer is stored, and what a bad answer
 * is never allowed to do. The door that reads it is `src/lib/v1/the-ad-spend-door.test.ts`; this is the half that fills the table.
 */

const h = vi.hoisted(() => ({
  db: {
    adAccount: { findMany: vi.fn() },
    adSpendDay: { count: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
    $transaction: vi.fn(),
  },
  fetchDaily: vi.fn(),
  readCredentials: vi.fn(),
  platform: { value: 'META' as string | null, daily: true },
}));

vi.mock('../db', () => ({ db: h.db }));
vi.mock('./index', async (original) => {
  const real = await original<typeof import('./index')>();
  return {
    ...real,
    readCredentials: (...a: unknown[]) => h.readCredentials(...a),
    adapterFor: (p: string) =>
      p === 'META'
        ? {
            platform: 'META',
            ...(h.platform.daily ? { fetchDailyAdSpend: (...a: unknown[]) => h.fetchDaily(...a) } : {}),
            explainError: (e: unknown) => `explained: ${(e as Error).message}`,
          }
        : null,
  };
});

import { BACKFILL_DAYS, REFRESH_DAYS, syncDailyAdSpend } from './daily';
import { fetchDailyAdSpend } from './meta';

const NOW = new Date('2026-11-17T12:00:00Z');
const account = (over: Record<string, unknown> = {}) => ({
  id: 'a1', storeId: 'st1', platform: 'META', accountId: 'act_1234567890', accountName: 'كيوان 3', tokenEncrypted: 'enc', ...over,
});
const row = (over: Record<string, unknown> = {}) => ({
  date: '2026-11-16', adId: '120211000000000001', adsetId: '120210000000000005', campaignId: '120210000000000009',
  spend: 42.5, currency: 'USD', impressions: 5200, linkClicks: 130, ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  h.platform.daily = true;
  h.readCredentials.mockReturnValue({ token: 't' });
  h.db.adAccount.findMany.mockResolvedValue([account()]);
  h.db.adSpendDay.count.mockResolvedValue(0);
  h.db.adSpendDay.deleteMany.mockReturnValue('del');
  h.db.adSpendDay.createMany.mockReturnValue('add');
  h.db.$transaction.mockResolvedValue([]);
  h.fetchDaily.mockResolvedValue([row()]);
});

describe('what Meta is asked, and for how long back', () => {
  it('the first time an account is seen: 31 days; afterwards: 7 (Meta restates recent days, not old ones)', async () => {
    await syncDailyAdSpend({ companyId: 'co', storeId: 'st1' }, NOW);
    expect(h.fetchDaily).toHaveBeenLastCalledWith({ token: 't' }, 'act_1234567890', '2026-10-17', '2026-11-17');
    expect(BACKFILL_DAYS).toBe(31);

    h.db.adSpendDay.count.mockResolvedValue(400);
    await syncDailyAdSpend({ companyId: 'co', storeId: 'st1' }, NOW);
    expect(h.fetchDaily).toHaveBeenLastCalledWith({ token: 't' }, 'act_1234567890', '2026-11-10', '2026-11-17');
    expect(REFRESH_DAYS).toBe(7);
  });

  it('touches only accounts with a platform on the other end, and only platforms that report per ad', async () => {
    await syncDailyAdSpend({ companyId: 'co', storeId: 'st1' }, NOW);
    expect(JSON.stringify(h.db.adAccount.findMany.mock.calls[0][0].where)).toContain('MANUAL');
    h.platform.daily = false;
    h.fetchDaily.mockClear();
    expect(await syncDailyAdSpend({ companyId: 'co', storeId: 'st1' }, NOW)).toEqual({ rows: 0, errors: [] });
    expect(h.fetchDaily).not.toHaveBeenCalled();
  });
});

describe('how the answer is stored', () => {
  it('replaces the account’s window with the rows Meta sent, in one transaction', async () => {
    const out = await syncDailyAdSpend({ companyId: 'co', storeId: 'st1' }, NOW);
    expect(out).toEqual({ rows: 1, errors: [] });
    expect(h.db.$transaction).toHaveBeenCalledWith(['del', 'add']);
    expect(h.db.adSpendDay.deleteMany.mock.calls[0][0].where).toMatchObject({ companyId: 'co', adAccountId: 'a1' });
    const { data } = h.db.adSpendDay.createMany.mock.calls[0][0];
    expect(data[0]).toMatchObject({
      companyId: 'co', storeId: 'st1', adAccountId: 'a1', adId: '120211000000000001', adsetId: '120210000000000005',
      campaignId: '120210000000000009', spend: 42.5, currency: 'USD', impressions: 5200, linkClicks: 130,
    });
    expect(data[0].date).toEqual(new Date('2026-11-16T00:00:00.000Z'));
  });

  it('an EMPTY answer never wipes what is stored', async () => {
    h.fetchDaily.mockResolvedValue([]);
    expect(await syncDailyAdSpend({ companyId: 'co', storeId: 'st1' }, NOW)).toEqual({ rows: 0, errors: [] });
    expect(h.db.$transaction).not.toHaveBeenCalled();
  });

  it('a row with no usable currency or date is skipped, and a repeated (day, ad) is stored once', async () => {
    h.fetchDaily.mockResolvedValue([row(), row(), row({ adId: '120211000000000002', currency: '' }), row({ adId: '120211000000000003', date: 'yesterday' })]);
    const out = await syncDailyAdSpend({ companyId: 'co', storeId: 'st1' }, NOW);
    expect(out.rows).toBe(1);
    expect(h.db.adSpendDay.createMany.mock.calls[0][0].data).toHaveLength(1);
  });

  it('one account failing is a line in the report, not an exception, and the next account still runs', async () => {
    h.db.adAccount.findMany.mockResolvedValue([account(), account({ id: 'a2', accountName: 'حساب 2', accountId: 'act_2222222222' })]);
    h.fetchDaily.mockRejectedValueOnce(new Error('token expired')).mockResolvedValueOnce([row()]);
    const out = await syncDailyAdSpend({ companyId: 'co', storeId: 'st1' }, NOW);
    expect(out.errors).toEqual(['كيوان 3: explained: token expired']);
    expect(out.rows).toBe(1);
  });

  it('writes nothing on a campaign, an order or an account', async () => {
    await syncDailyAdSpend({ companyId: 'co', storeId: 'st1' }, NOW);
    expect(Object.keys(h.db).sort()).toEqual(['$transaction', 'adAccount', 'adSpendDay']);
    expect(h.db.adAccount).not.toHaveProperty('update');
  });
});

describe('Meta’s own insights call, per ad per day', () => {
  const originalFetch = globalThis.fetch;
  let urls: string[] = [];
  const page = (data: unknown[], after?: string) => ({
    ok: true,
    status: 200,
    json: async () => ({ data, ...(after ? { paging: { cursors: { after }, next: 'https://graph/next' } } : {}) }),
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('asks level=ad, one row per day, for the link clicks — and the token rides in the header', async () => {
    urls = [];
    globalThis.fetch = vi.fn(async (u: string | URL | Request, init?: RequestInit) => {
      urls.push(String(u));
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
      return page([]) as Response;
    }) as typeof fetch;
    await fetchDailyAdSpend('tok', 'act_1234567890', '2026-11-10', '2026-11-17');
    const q = new URL(urls[0]).searchParams;
    expect(q.get('level')).toBe('ad');
    expect(q.get('time_increment')).toBe('1');
    expect(q.get('fields')).toBe('ad_id,adset_id,campaign_id,spend,impressions,inline_link_clicks,account_currency');
    expect(JSON.parse(q.get('time_range')!)).toEqual({ since: '2026-11-10', until: '2026-11-17' });
    expect(urls[0]).not.toContain('tok');
  });

  it('maps rows, follows the cursor to the end, and drops a line that is not an ad', async () => {
    urls = [];
    const pages = [
      page(
        [
          { date_start: '2026-11-16', ad_id: '111111', adset_id: '222222', campaign_id: '333333', spend: '42.50', impressions: '5200', inline_link_clicks: '130', account_currency: 'usd' },
          { date_start: '2026-11-16', spend: '9' },
        ],
        'CURSOR1'
      ),
      page([{ date_start: '2026-11-17', ad_id: '111111', spend: '', impressions: undefined, account_currency: 'USD' }]),
    ];
    globalThis.fetch = vi.fn(async (u: string | URL | Request) => {
      urls.push(String(u));
      return pages.shift() as Response;
    }) as typeof fetch;
    const rows = await fetchDailyAdSpend('tok', 'act_1234567890', '2026-11-10', '2026-11-17');
    expect(urls).toHaveLength(2);
    expect(new URL(urls[1]).searchParams.get('after')).toBe('CURSOR1');
    expect(rows).toEqual([
      { date: '2026-11-16', adId: '111111', adsetId: '222222', campaignId: '333333', spend: 42.5, currency: 'USD', impressions: 5200, linkClicks: 130 },
      { date: '2026-11-17', adId: '111111', adsetId: null, campaignId: null, spend: 0, currency: 'USD', impressions: null, linkClicks: null },
    ]);
  });

  it('a runaway account stops at the page cap instead of looping for ever', async () => {
    urls = [];
    globalThis.fetch = vi.fn(async (u: string | URL | Request) => {
      urls.push(String(u));
      return page([{ date_start: '2026-11-16', ad_id: '111111', spend: '1', account_currency: 'USD' }], 'MORE') as Response;
    }) as typeof fetch;
    await fetchDailyAdSpend('tok', 'act_1234567890', '2026-11-10', '2026-11-17');
    expect(urls).toHaveLength(40);
  });

  it('an account id that is not one is refused before any call', async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    await expect(fetchDailyAdSpend('tok', '123/../x', '2026-11-10', '2026-11-17')).rejects.toThrow();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
