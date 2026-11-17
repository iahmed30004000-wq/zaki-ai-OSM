import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE MEDIA BUYER'S SPEND READ — `GET /api/v1/ad-spend`, its two new scopes,
 * and the tags a Pages order carries (PR-A of the media buyer's doors).
 *
 * Run with the REAL key guard, the real reader and the real contract schema:
 *
 *   · O1 — `ads.spend.read` and `notify.send` exist, a NEW media-buyer key
 *     starts with them, a key minted before keeps exactly what it had, and the
 *     replies system never gains them
 *   · O6 — the answer is the contract's shape at every level, bounded
 *     (31 days, 500 rows), paged without repeating or skipping a row, scoped to
 *     the token's company, and it never calls Meta
 *   · O2 — `readAdTags` keeps only tags that fit, `stampAdTags` writes once and
 *     never throws (the door half is in `the-landing-door.test.ts`)
 * ═══════════════════════════════════════════════════════════════════════
 */

const h = vi.hoisted(() => ({
  db: {
    systemToken: { findUnique: vi.fn(), update: vi.fn() },
    adSpendDay: { findMany: vi.fn(), groupBy: vi.fn(), aggregate: vi.fn() },
    order: { updateMany: vi.fn() },
  },
  rateLimit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db: h.db }));
vi.mock('@/lib/rate-limit', () => ({ rateLimit: (...a: unknown[]) => h.rateLimit(...a) }));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validate } from '../apps/contract';
import { GET as getSpend } from '@/app/api/v1/ad-spend/route';
import { GET as getAttribution } from '@/app/api/v1/orders/attribution/route';
import { MEDIABUYER_SCOPES, REPLIES_SCOPES, V1_SCOPES, V1_SCOPE_AR, V1_SYSTEMS, parseScopes } from './system-token';
import { keyScopeLacks } from './token-granter';
import { decodeSpendCursor, encodeSpendCursor } from './ad-spend';
import { readAdTags, stampAdTags } from './ad-tags';
import type { SessionUser } from '@/types/auth';

const tokenRow = (scopes: string[], over: Record<string, unknown> = {}) => ({
  id: 'tok_mb',
  companyId: 'c1',
  system: 'mediabuyer',
  scopes: JSON.stringify(scopes),
  rateLimitPerMin: 60,
  expiresAt: new Date(Date.now() + 86_400_000),
  revokedAt: null,
  lastUsedAt: new Date(),
  ...over,
});

const call = (path: string) =>
  new Request(`https://oms.test${path}`, { headers: { authorization: 'Bearer zk1_test', 'x-request-id': 'mb_2' } });

const WINDOW = '/api/v1/ad-spend?date_from=2026-11-01&date_to=2026-11-17';

const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const dayRow = (over: Record<string, unknown> = {}) => ({
  date: day('2026-11-17'),
  adId: '120211000000000001',
  adsetId: '120210000000000005',
  campaignId: '120210000000000009',
  spend: { toString: () => '42' },
  currency: 'USD',
  impressions: 5200,
  linkClicks: 130,
  ...over,
});

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-17T12:00:00Z'));
  fetchSpy = vi.fn(() => {
    throw new Error('the spend door must never call out');
  });
  vi.stubGlobal('fetch', fetchSpy);
  h.rateLimit.mockReturnValue({ allowed: true, remaining: 59, retryAfterSec: 0 });
  h.db.systemToken.update.mockResolvedValue({});
  h.db.systemToken.findUnique.mockResolvedValue(tokenRow(MEDIABUYER_SCOPES));
  h.db.adSpendDay.findMany.mockResolvedValue([dayRow()]);
  h.db.adSpendDay.groupBy.mockResolvedValue([]);
  h.db.adSpendDay.aggregate.mockResolvedValue({ _max: { pulledAt: new Date('2026-11-17T03:05:00Z') } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('O1 — the two new scopes', () => {
  it('exist, are named in Arabic, and a NEW media-buyer key starts with them', () => {
    for (const s of ['ads.spend.read', 'notify.send']) {
      expect(V1_SCOPES).toContain(s);
      expect(MEDIABUYER_SCOPES).toContain(s);
      expect(V1_SCOPE_AR[s as keyof typeof V1_SCOPE_AR]).toMatch(/\S/);
    }
    expect(V1_SYSTEMS.find((s) => s.key === 'mediabuyer')?.scopes).toEqual(MEDIABUYER_SCOPES);
  });

  it('a key minted BEFORE keeps exactly what it had: it reads orders, and is refused the spend', async () => {
    const old = ['products.read', 'products.costs.read', 'orders.attribution.read'];
    expect(parseScopes(JSON.stringify(old))).toEqual(old);
    h.db.systemToken.findUnique.mockResolvedValue(tokenRow(old));
    h.db.order = { ...h.db.order, findMany: vi.fn().mockResolvedValue([]) } as typeof h.db.order;
    const spend = await getSpend(call(WINDOW));
    expect(spend.status).toBe(403);
    expect((await spend.json()).error.code).toBe('SCOPE_MISSING');
    expect(h.db.adSpendDay.findMany).not.toHaveBeenCalled();
    expect((await getAttribution(call('/api/v1/orders/attribution?updated_since=2026-11-10T00:00:00Z'))).status).toBe(200);
  });

  it('the replies system never gains them', async () => {
    for (const s of ['ads.spend.read', 'notify.send']) expect(REPLIES_SCOPES).not.toContain(s);
    h.db.systemToken.findUnique.mockResolvedValue(tokenRow([...REPLIES_SCOPES], { system: 'replies' }));
    expect((await getSpend(call(WINDOW))).status).toBe(403);
  });

  it('whoever mints them must hold what they open: campaigns for the spend, the Telegram bot for the message', () => {
    const none = { id: 'u', companyId: 'c1', role: 'AGENT', permissions: [] } as unknown as SessionUser;
    expect(keyScopeLacks(none, 'ads.spend.read')).toBe('campaigns.view');
    expect(keyScopeLacks(none, 'notify.send')).toBe('telegram.manage');
  });
});

describe('O6 — GET /api/v1/ad-spend answers the contract', () => {
  type Schema = Record<string, unknown>;
  const DIR = join(process.cwd(), 'contracts', 'oms-mediabuyer.v1');
  const file = (n: string) => JSON.parse(readFileSync(join(DIR, n), 'utf8'));
  const SCHEMA = file('ad-spend-page.schema.json') as Schema;
  const arrays = (schema: Schema, value: unknown, path: string): string[] => {
    const errs: string[] = [];
    if (schema.type === 'array' && Array.isArray(value) && schema.items) {
      value.forEach((el, i) => {
        const sub = schema.items as Schema;
        errs.push(...validate(sub, el, `${path}[${i}]`), ...arrays(sub, el, `${path}[${i}]`));
      });
    } else if (schema.type === 'object' && value && typeof value === 'object') {
      for (const [k, sub] of Object.entries((schema.properties ?? {}) as Record<string, Schema>)) {
        if (k in (value as object)) errs.push(...arrays(sub, (value as Record<string, unknown>)[k], `${path}.${k}`));
      }
    }
    return errs;
  };
  const check = (value: unknown) => [...validate(SCHEMA, value), ...arrays(SCHEMA, value, 'root')];

  it('the golden page fits its schema, and the checker is not vacuous', () => {
    const page = file('ad-spend-page.example.json');
    expect(check(page)).toEqual([]);
    expect(check({ ...page, items: [{ ...page.items[0], spend: 42 }] }).length).toBeGreaterThan(0);
    expect(check({ ...page, items: [{ ...page.items[0], phone: '0936654998' }] }).length).toBeGreaterThan(0);
    expect(check({ ...page, items: [{ ...page.items[0], currency: 'usd' }] }).length).toBeGreaterThan(0);
    const noAsOf = { ...page };
    delete noAsOf.as_of;
    expect(check(noAsOf).length).toBeGreaterThan(0);
  });

  it('at the ad level: one row per day per ad, money as a two-place string, as_of in Amman’s offset', async () => {
    const res = await getSpend(call(WINDOW));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      items: [
        {
          date: '2026-11-17',
          ad_id: '120211000000000001',
          adset_id: '120210000000000005',
          campaign_id: '120210000000000009',
          spend: '42.00',
          currency: 'USD',
          impressions: 5200,
          link_clicks: 130,
        },
      ],
      next_cursor: null,
      as_of: '2026-11-17T06:05:00+03:00',
    });
    expect(check(body)).toEqual([]);
  });

  it('a figure the table does not hold is null, never 0', async () => {
    h.db.adSpendDay.findMany.mockResolvedValue([dayRow({ impressions: null, linkClicks: null, adsetId: null, campaignId: null })]);
    const { items } = await (await getSpend(call(WINDOW))).json();
    expect(items[0]).toMatchObject({ impressions: null, link_clicks: null, adset_id: null, campaign_id: null });
  });

  it('at the adset and campaign levels the row’s own id is ad_id, and the sums fit the schema', async () => {
    h.db.adSpendDay.groupBy.mockResolvedValue([
      {
        date: day('2026-11-17'),
        adsetId: '120210000000000005',
        _sum: { spend: { toString: () => '60.5' }, impressions: 9000, linkClicks: 200 },
        _min: { currency: 'USD', campaignId: '120210000000000009' },
      },
    ]);
    const adset = await (await getSpend(call(`${WINDOW}&level=adset`))).json();
    expect(adset.items[0]).toEqual({
      date: '2026-11-17',
      ad_id: '120210000000000005',
      adset_id: '120210000000000005',
      campaign_id: '120210000000000009',
      spend: '60.50',
      currency: 'USD',
      impressions: 9000,
      link_clicks: 200,
    });
    expect(check(adset)).toEqual([]);

    h.db.adSpendDay.groupBy.mockResolvedValue([
      {
        date: day('2026-11-17'),
        campaignId: '120210000000000009',
        _sum: { spend: { toString: () => '120' }, impressions: null, linkClicks: null },
        _min: { currency: 'USD', campaignId: '120210000000000009' },
      },
    ]);
    const camp = await (await getSpend(call(`${WINDOW}&level=campaign`))).json();
    expect(camp.items[0]).toMatchObject({ ad_id: '120210000000000009', adset_id: null, campaign_id: '120210000000000009', spend: '120.00', impressions: null });
    expect(check(camp)).toEqual([]);
  });

  it('reads only the token’s company and the asked window, ordered by day then id', async () => {
    await getSpend(call(`${WINDOW}&companyId=evil`));
    const arg = h.db.adSpendDay.findMany.mock.calls[0][0];
    expect(arg.where.companyId).toBe('c1');
    expect(arg.where.date).toEqual({ gte: day('2026-11-01'), lte: day('2026-11-17') });
    expect(arg.orderBy).toEqual([{ date: 'asc' }, { adId: 'asc' }]);
    expect(JSON.stringify(arg.where)).not.toContain('evil');
  });

  it('never calls Meta, however it is asked', async () => {
    await getSpend(call(WINDOW));
    await getSpend(call(`${WINDOW}&level=campaign`));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never selects anything but spend columns — no order, no customer', async () => {
    await getSpend(call(WINDOW));
    const select = h.db.adSpendDay.findMany.mock.calls[0][0].select;
    expect(Object.keys(select).sort()).toEqual(['adId', 'adsetId', 'campaignId', 'currency', 'date', 'impressions', 'linkClicks', 'spend']);
  });

  it('with nothing ever pulled, as_of is the epoch — «قديم», not «now»', async () => {
    h.db.adSpendDay.aggregate.mockResolvedValue({ _max: { pulledAt: null } });
    h.db.adSpendDay.findMany.mockResolvedValue([]);
    const body = await (await getSpend(call(WINDOW))).json();
    expect(body.items).toEqual([]);
    expect(body.as_of.startsWith('1970-01-01')).toBe(true);
    expect(check(body)).toEqual([]);
  });
});

describe('O6 — bounded, and the cursor walks every row once', () => {
  const refused = async (path: string) => {
    const res = await getSpend(call(path));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(h.db.adSpendDay.findMany).not.toHaveBeenCalled();
    expect(h.db.adSpendDay.groupBy).not.toHaveBeenCalled();
    return body;
  };

  it('a missing, malformed or impossible date is a 400 before any query', async () => {
    await refused('/api/v1/ad-spend');
    await refused('/api/v1/ad-spend?date_from=2026-11-01');
    await refused('/api/v1/ad-spend?date_from=17-11-2026&date_to=2026-11-17');
    await refused('/api/v1/ad-spend?date_from=2026-02-30&date_to=2026-03-02');
    await refused('/api/v1/ad-spend?date_from=2026-11-17&date_to=2026-11-01');
  });

  it('31 days apart is the most: 32 is refused, exactly 31 is read', async () => {
    const body = await refused('/api/v1/ad-spend?date_from=2026-10-01&date_to=2026-11-02');
    expect(body.error.details).toMatchObject({ field: 'date_to', max_days: 31 });
    expect((await getSpend(call('/api/v1/ad-spend?date_from=2026-10-01&date_to=2026-11-01'))).status).toBe(200);
  });

  it('an unknown level is refused, and a page is never larger than 500', async () => {
    await refused(`${WINDOW}&level=pixel`);
    await getSpend(call(`${WINDOW}&limit=99999`));
    expect(h.db.adSpendDay.findMany.mock.calls[0][0].take).toBe(501);
    await getSpend(call(`${WINDOW}&limit=3`));
    expect(h.db.adSpendDay.findMany.mock.calls[1][0].take).toBe(4);
  });

  it('a full page hands back a cursor that resumes AFTER its last row; the last page hands back null', async () => {
    h.db.adSpendDay.findMany.mockResolvedValue([
      dayRow({ adId: '120211000000000001' }),
      dayRow({ adId: '120211000000000002' }),
      dayRow({ adId: '120211000000000003' }),
    ]);
    const first = await (await getSpend(call(`${WINDOW}&limit=2`))).json();
    expect(first.items.map((i: { ad_id: string }) => i.ad_id)).toEqual(['120211000000000001', '120211000000000002']);
    expect(decodeSpendCursor(first.next_cursor)).toEqual({ day: day('2026-11-17'), key: '120211000000000002' });

    h.db.adSpendDay.findMany.mockResolvedValue([dayRow({ adId: '120211000000000003' })]);
    const second = await (await getSpend(call(`${WINDOW}&limit=2&cursor=${first.next_cursor}`))).json();
    expect(second.next_cursor).toBeNull();
    const where = h.db.adSpendDay.findMany.mock.calls[1][0].where;
    expect(where.OR).toEqual([{ date: { gt: day('2026-11-17') } }, { date: day('2026-11-17'), adId: { gt: '120211000000000002' } }]);
  });

  it('the cursor round-trips, and one this door did not issue is a 400, not a 500', async () => {
    expect(decodeSpendCursor(encodeSpendCursor('2026-11-17', 'abc'))).toEqual({ day: day('2026-11-17'), key: 'abc' });
    await refused(`${WINDOW}&cursor=not-a-cursor`);
    await refused(`${WINDOW}&cursor=${Buffer.from(JSON.stringify({ d: 'x', k: 1 })).toString('base64url')}`);
  });

  it('a key that is revoked or expired is refused on the next call', async () => {
    h.db.systemToken.findUnique.mockResolvedValue(tokenRow(MEDIABUYER_SCOPES, { revokedAt: new Date() }));
    expect((await getSpend(call(WINDOW))).status).toBe(401);
    h.db.systemToken.findUnique.mockResolvedValue(tokenRow(MEDIABUYER_SCOPES, { expiresAt: new Date(Date.now() - 1000) }));
    expect((await getSpend(call(WINDOW))).status).toBe(401);
    expect(h.db.adSpendDay.findMany).not.toHaveBeenCalled();
  });

  it('the key’s own allowance holds: over it is 429 and no query', async () => {
    h.rateLimit.mockReturnValue({ allowed: false, remaining: 0, retryAfterSec: 12 });
    const res = await getSpend(call(WINDOW));
    expect(res.status).toBe(429);
    expect(h.db.adSpendDay.findMany).not.toHaveBeenCalled();
  });
});

describe('O2 — readAdTags keeps the tags that fit and drops the rest', () => {
  const GOOD = {
    method: 'url_tags',
    ad_id: '120211000000000001',
    adset_id: '120210000000000005',
    campaign_id: '120210000000000009',
    ad_name: 'CR00147_TRF01_hook2',
    utm_source: 'fb',
    utm_medium: 'Facebook_Mobile_Feed',
    fbclid: 'IwAR0example',
    fbc: 'fb.1.1762200000000.IwAR0example',
    fbp: 'fb.1.1762200000000.1234567890',
    landing_url: 'https://pages.zakiai.io/p/kamaa-eye-water',
  };

  it('reads every tag of the contract', () => {
    expect(readAdTags(GOOD)).toEqual({
      method: 'url_tags',
      adId: '120211000000000001',
      adsetId: '120210000000000005',
      campaignId: '120210000000000009',
      adName: 'CR00147_TRF01_hook2',
      utmSource: 'fb',
      utmMedium: 'Facebook_Mobile_Feed',
      utmCampaign: null,
      utmTerm: null,
      utmContent: null,
      landingUrl: 'https://pages.zakiai.io/p/kamaa-eye-water',
      fbclid: 'IwAR0example',
      fbc: 'fb.1.1762200000000.IwAR0example',
      fbp: 'fb.1.1762200000000.1234567890',
    });
  });

  it('the ads’ own links: utm_campaign, utm_term, utm_content become the campaign, the ad set and the ad — and stay readable as text', () => {
    const link = { utm_source: 'fb', utm_campaign: '120210000000000009', utm_term: '120210000000000005', utm_content: '120211000000000001', ad_name: 'CR00147_TRF01_hook2' };
    expect(readAdTags(link)).toMatchObject({
      campaignId: '120210000000000009',
      adsetId: '120210000000000005',
      adId: '120211000000000001',
      adName: 'CR00147_TRF01_hook2',
      utmSource: 'fb',
      utmCampaign: '120210000000000009',
      utmTerm: '120210000000000005',
      utmContent: '120211000000000001',
    });
  });

  it('a utm value that is not a number is kept as text and its id is left EMPTY — an unfilled macro, a name, a short number', () => {
    const t = readAdTags({ utm_campaign: 'summer-sale', utm_term: '{{adset.id}}', utm_content: '12345', ad_name: '{{ad.name}}' });
    expect(t).toMatchObject({ utmCampaign: 'summer-sale', utmTerm: '{{adset.id}}', utmContent: '12345', adName: '{{ad.name}}' });
    expect(t).toMatchObject({ campaignId: null, adsetId: null, adId: null });
  });

  it('a valid explicit id wins over the macro; a bad one falls back to the macro’s digits', () => {
    const both = readAdTags({ ad_id: '999999999', utm_content: '120211000000000001' });
    expect(both?.adId).toBe('999999999');
    expect(both?.utmContent).toBe('120211000000000001');
    expect(readAdTags({ ad_id: 'nope', utm_content: '120211000000000001' })?.adId).toBe('120211000000000001');
  });

  it('a utm value longer than 120 characters is dropped, not cut', () => {
    expect(readAdTags({ utm_source: 'fb', utm_campaign: 'c'.repeat(121) })?.utmCampaign).toBeNull();
    expect(readAdTags({ utm_campaign: 'c'.repeat(120) })?.utmCampaign).toHaveLength(120);
  });

  it('ids are digits only, 6 to 25 of them', () => {
    for (const bad of ['12345', '1'.repeat(26), '12a456', ' ', '12 3456', 120211000000000001]) {
      expect(readAdTags({ ...GOOD, ad_id: bad })?.adId ?? null, String(bad)).toBeNull();
    }
    expect(readAdTags({ ...GOOD, ad_id: '123456' })?.adId).toBe('123456');
  });

  it('names and links are bounded, and a link that is not http(s) is dropped', () => {
    expect(readAdTags({ ...GOOD, ad_name: 'x'.repeat(121) })?.adName).toBeNull();
    expect(readAdTags({ ...GOOD, ad_name: 'x'.repeat(120) })?.adName).toHaveLength(120);
    expect(readAdTags({ ...GOOD, utm_source: 'f'.repeat(41) })?.utmSource).toBeNull();
    expect(readAdTags({ ...GOOD, utm_medium: 'm'.repeat(61) })?.utmMedium).toBeNull();
    expect(readAdTags({ ...GOOD, landing_url: 'javascript:alert(1)' })?.landingUrl).toBeNull();
    expect(readAdTags({ ...GOOD, landing_url: 'ftp://x.test/a' })?.landingUrl).toBeNull();
    expect(readAdTags({ ...GOOD, landing_url: 'https://pages.zakiai.io/p/a?fbclid=zzz#top' })?.landingUrl).toBe('https://pages.zakiai.io/p/a');
  });

  it('nothing usable, or not an object, is no tags at all', () => {
    expect(readAdTags(null)).toBeNull();
    expect(readAdTags('oops')).toBeNull();
    expect(readAdTags([GOOD])).toBeNull();
    expect(readAdTags({})).toBeNull();
    expect(readAdTags({ method: 'url_tags', ad_id: 'zz', fbc: 7 })).toBeNull();
  });
});

describe('O2 — stampAdTags writes once and never throws', () => {
  const OLD = process.env.APP_ENCRYPTION_KEY;
  afterEach(() => {
    if (OLD === undefined) delete process.env.APP_ENCRYPTION_KEY;
    else process.env.APP_ENCRYPTION_KEY = OLD;
  });

  it('scopes the update to the company and to an order that carries no tag yet', async () => {
    h.db.order.updateMany.mockResolvedValue({ count: 1 });
    expect(await stampAdTags('c1', 'SY-0001', { ad_id: '120211000000000001', adset_id: '120210000000000005' })).toBe(true);
    expect(h.db.order.updateMany.mock.calls[0][0].where).toEqual({ companyId: 'c1', orderNumber: 'SY-0001', adId: null, adsetId: null });
  });

  it('a second stamp finds nothing to fill and says so', async () => {
    h.db.order.updateMany.mockResolvedValue({ count: 0 });
    expect(await stampAdTags('c1', 'SY-0001', { ad_id: '120211000000000001' })).toBe(false);
  });

  it('no usable tag: no query at all', async () => {
    expect(await stampAdTags('c1', 'SY-0001', { ad_id: 'x' })).toBe(false);
    expect(await stampAdTags('c1', 'SY-0001', undefined)).toBe(false);
    expect(h.db.order.updateMany).not.toHaveBeenCalled();
  });

  it('a database failure is swallowed — the order is already saved', async () => {
    h.db.order.updateMany.mockRejectedValue(new Error('db down'));
    await expect(stampAdTags('c1', 'SY-0001', { ad_id: '120211000000000001' })).resolves.toBe(false);
  });

  it('Meta’s click id and browser ids are sealed — never stored in the clear', async () => {
    process.env.APP_ENCRYPTION_KEY = 'a'.repeat(64);
    h.db.order.updateMany.mockResolvedValue({ count: 1 });
    await stampAdTags('c1', 'SY-0001', { ad_id: '120211000000000001', fbclid: 'IwAR0example', fbc: 'fb.1.1762200000000.IwAR0example', fbp: 'fb.1.1762200000000.1234567890' });
    const { data } = h.db.order.updateMany.mock.calls[0][0];
    for (const k of ['fbclidEnc', 'fbcEnc', 'fbpEnc']) {
      expect(typeof data[k]).toBe('string');
      expect(data[k]).not.toMatch(/IwAR0example|1234567890/);
    }
  });

  it('and with no encryption key they are dropped, not written plain', async () => {
    delete process.env.APP_ENCRYPTION_KEY;
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.db.order.updateMany.mockResolvedValue({ count: 1 });
    await stampAdTags('c1', 'SY-0001', { ad_id: '120211000000000001', fbclid: 'IwAR0example' });
    const { data } = h.db.order.updateMany.mock.calls[0][0];
    expect(data.fbclidEnc).toBeNull();
    expect(JSON.stringify(data)).not.toContain('IwAR0example');
    log.mockRestore();
  });
});
