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
    order: { updateMany: vi.fn(), findMany: vi.fn() },
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
    h.db.order.findMany.mockResolvedValue([]);
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
    ad_name: 'CR00147_TRF01_hook2',
    utm_source: 'fb',
    utm_medium: 'Facebook_Mobile_Feed',
    landing_url: 'https://pages.zakiai.io/p/kamaa-eye-water',
  };

  it('reads the four the landing door does not already keep: the ad’s name, the utm source and medium, the page', () => {
    expect(readAdTags(GOOD)).toEqual({
      adName: 'CR00147_TRF01_hook2',
      utmSource: 'fb',
      utmMedium: 'Facebook_Mobile_Feed',
      landingUrl: 'https://pages.zakiai.io/p/kamaa-eye-water',
    });
  });

  it('the ids are NOT read here — they already have their columns (adId, refCode, metaCampaignId)', () => {
    const t = readAdTags({ ...GOOD, ad_id: '120211000000000001', utm_content: '120211000000000001', utm_term: '120210000000000005', utm_campaign: '120210000000000009' });
    expect(Object.keys(t ?? {}).sort()).toEqual(['adName', 'landingUrl', 'utmMedium', 'utmSource']);
  });

  it('names and links are bounded, and a link that is not http(s) is dropped', () => {
    expect(readAdTags({ ...GOOD, ad_name: 'x'.repeat(121) })?.adName).toBeNull();
    expect(readAdTags({ ...GOOD, ad_name: 'x'.repeat(120) })?.adName).toHaveLength(120);
    expect(readAdTags({ ...GOOD, utm_source: 'f'.repeat(41) })?.utmSource).toBeNull();
    expect(readAdTags({ ...GOOD, utm_medium: 'm'.repeat(61) })?.utmMedium).toBeNull();
    expect(readAdTags({ ...GOOD, landing_url: 'javascript:alert(1)' })?.landingUrl).toBeNull();
    expect(readAdTags({ ...GOOD, landing_url: 'ftp://x.test/a' })?.landingUrl).toBeNull();
    expect(readAdTags({ ...GOOD, ad_name: 'bad\u0000name' })?.adName).toBeNull();
  });

  it('the link is kept WITHOUT its query string or fragment — that is where the click id rides', () => {
    expect(readAdTags({ landing_url: 'https://pages.zakiai.io/p/a?fbclid=zzz&utm_source=fb#top' })?.landingUrl).toBe('https://pages.zakiai.io/p/a');
  });

  it('an unfilled macro is a name like any other — the ad’s name is kept as sent', () => {
    expect(readAdTags({ ad_name: '{{ad.name}}' })?.adName).toBe('{{ad.name}}');
  });

  it('nothing usable, or not an object, is no tags at all', () => {
    expect(readAdTags(null)).toBeNull();
    expect(readAdTags('oops')).toBeNull();
    expect(readAdTags([GOOD])).toBeNull();
    expect(readAdTags({})).toBeNull();
    expect(readAdTags({ ad_name: 7, utm_source: '' })).toBeNull();
  });
});

describe('O2 — stampAdTags writes once and never throws', () => {
  it('scopes the update to the company and to an order that carries none of the four yet', async () => {
    h.db.order.updateMany.mockResolvedValue({ count: 1 });
    expect(await stampAdTags('c1', 'SY-0001', { ad_name: 'CR00147', utm_source: 'fb' })).toBe(true);
    const { where, data } = h.db.order.updateMany.mock.calls[0][0];
    expect(where).toEqual({ companyId: 'c1', orderNumber: 'SY-0001', adName: null, utmSource: null, utmMedium: null, landingUrl: null });
    expect(data).toEqual({ adName: 'CR00147', utmSource: 'fb', utmMedium: null, landingUrl: null });
  });

  it('a second stamp finds nothing to fill and says so', async () => {
    h.db.order.updateMany.mockResolvedValue({ count: 0 });
    expect(await stampAdTags('c1', 'SY-0001', { ad_name: 'CR00147' })).toBe(false);
  });

  it('no usable tag: no query at all', async () => {
    expect(await stampAdTags('c1', 'SY-0001', { ad_name: 7 })).toBe(false);
    expect(await stampAdTags('c1', 'SY-0001', undefined)).toBe(false);
    expect(h.db.order.updateMany).not.toHaveBeenCalled();
  });

  it('a database failure is swallowed — the order is already saved — and only its code is logged', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.db.order.updateMany.mockRejectedValue(Object.assign(new Error('value "CR00147" too long'), { code: 'P2000' }));
    await expect(stampAdTags('c1', 'SY-0001', { ad_name: 'CR00147' })).resolves.toBe(false);
    expect(JSON.stringify(log.mock.calls)).toContain('P2000');
    expect(JSON.stringify(log.mock.calls)).not.toContain('CR00147');
    log.mockRestore();
  });
});

describe('O2 — the feed hands out ids only when they are numbers, and only reads refCode for a landing order', () => {
  const orderRow = (over: Record<string, unknown> = {}) => ({
    id: 'o1', orderNumber: 'SY-0001', confirmationStatus: 'CONFIRMED', shippingStatus: 'NOT_READY', claimedById: null, shippedAt: null, labelPrintedAt: null,
    confirmedAt: new Date('2026-11-17T05:00:00Z'), deliveredAt: null, returnedAt: null, createdAt: new Date('2026-11-17T04:00:00Z'), updatedAt: new Date('2026-11-17T05:00:00Z'),
    totalAmount: 20, collectedAmount: null, currency: 'USD', rejectionReason: null, source: 'Landing Page', externalChannel: null,
    adId: '120211000000000001', metaCampaignId: '120210000000000009', refCode: '120210000000000005', externalLandingPageId: 'lp-9', adName: 'CR00147', landingUrl: 'https://pages.zakiai.io/p/a',
    landingPageId: null, product: { sku: 'TRF01' }, channel: null, campaign: null, landingPage: null,
    store: { country: { code: 'SY', timezone: 'Asia/Damascus', minorUnit: 2 } }, statusLogs: [], contactAttempts: [],
    ...over,
  });
  const feed = async (row: Record<string, unknown>) => {
    h.db.order.findMany.mockResolvedValue([row]);
    const body = await (await getAttribution(call('/api/v1/orders/attribution?updated_since=2026-11-10T00:00:00Z'))).json();
    return body.items[0];
  };

  it('a landing order: ad, ad set and campaign from utm_content, utm_term, utm_campaign, plus the name and the page', async () => {
    expect(await feed(orderRow())).toMatchObject({
      ad_id: '120211000000000001',
      adset_id: '120210000000000005',
      campaign_id: '120210000000000009',
      ad_name: 'CR00147',
      landing_page: 'https://pages.zakiai.io/p/a',
    });
  });

  it('a macro the platform did not fill in, or a name, is no id — null, while the order keeps the text', async () => {
    const item = await feed(orderRow({ adId: '{{ad.id}}', refCode: 'broad-audience', metaCampaignId: '{{campaign.id}}' }));
    expect(item).toMatchObject({ ad_id: null, adset_id: null, campaign_id: null });
    const short = await feed(orderRow({ adId: '12345', refCode: '99999' }));
    expect(short).toMatchObject({ ad_id: null, adset_id: null });
  });

  it('refCode is a code a customer quoted on every other door: only a landing order’s is read as an ad set', async () => {
    const other = await feed(orderRow({ externalLandingPageId: null, refCode: '120210000000000005', adId: 'CODE-77' }));
    expect(other.adset_id).toBeNull();
    // and every other door’s ad id is read exactly as it was, number or not
    expect(other.ad_id).toBe('CODE-77');
  });

  it('a linked campaign’s own platform id wins over the one a link named', async () => {
    const item = await feed(orderRow({ campaign: { externalId: '555555555555' } }));
    expect(item.campaign_id).toBe('555555555555');
  });

  it('an order with none of it: every one null, as before', async () => {
    const item = await feed(orderRow({ adId: null, metaCampaignId: null, refCode: null, externalLandingPageId: null, adName: null, landingUrl: null }));
    expect(item).toMatchObject({ ad_id: null, adset_id: null, campaign_id: null, ad_name: null, landing_page: null });
  });
});
