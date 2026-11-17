import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — A LANDING-PAGE ORDER CARRIES ITS AD (the owner's item 1; contract oms-lp.v1 §4)
 *
 *  1. The landing door takes the optional `attribution` object (it was always sent, and dropped), `event_id` and
 *     `client_user_agent`, and writes them beside the order after the commit:
 *     utm_content → adId · utm_campaign → metaCampaignId (never the `campaignId` foreign key) · utm_term → refCode ·
 *     adSourceType «meta» only for a Meta visit · landingPageId → externalLandingPageId · fbc/fbp sealed ·
 *     client_user_agent → clientUserAgent · event_id → lpPurchaseEventId.
 *  2. An old page's body (none of these) is taken exactly as before, and writes nothing but the page id.
 *  3. A bad value — too long, a control character, a cookie that is not Meta's shape, an `attribution` that is not
 *     an object — is DROPPED, and the order is still taken: a tracking value is never a reason to refuse a customer.
 *  4. Nothing about the ad reaches `createPublicOrder` (order creation is not changed), and a failed write does not
 *     fail the order, nor log a value.
 *  5. The migration is six nullable TEXT columns, nothing else, with a rollback beside it.
 *  6. The media buyer's feed gives the Meta campaign id when the order has no linked campaign.
 * ═══════════════════════════════════════════════════════════════════════
 */

const h = vi.hoisted(() => ({
  db: {
    product: { findMany: vi.fn(), findFirst: vi.fn() },
    region: { findMany: vi.fn() },
    deliveryFee: { findMany: vi.fn() },
    store: { findFirst: vi.fn() },
    orderChannel: { findFirst: vi.fn() },
    order: { updateMany: vi.fn(), findFirst: vi.fn() },
    company: { findUnique: vi.fn() },
  },
  requireSystemToken: vi.fn(),
  activeOffersFor: vi.fn(),
  createPublicOrder: vi.fn(),
  claimIdempotency: vi.fn(),
  rememberIdempotency: vi.fn(),
  releaseIdempotency: vi.fn(),
  resolveCampaign: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db: h.db }));
vi.mock('@/lib/v1/system-token', async () => {
  const real = await vi.importActual<typeof import('./system-token')>('./system-token');
  return { ...real, requireSystemToken: (...a: unknown[]) => h.requireSystemToken(...a) };
});
vi.mock('@/lib/offers', async () => {
  const real = await vi.importActual<typeof import('../offers')>('../offers');
  return { ...real, activeOffersFor: (...a: unknown[]) => h.activeOffersFor(...a) };
});
vi.mock('@/lib/public-order', async () => {
  const real = await vi.importActual<typeof import('../public-order')>('../public-order');
  return { ...real, createPublicOrder: (...a: unknown[]) => h.createPublicOrder(...a) };
});
vi.mock('@/lib/v1/idempotency', async () => {
  const real = await vi.importActual<typeof import('./idempotency')>('./idempotency');
  return {
    ...real,
    claimIdempotency: (...a: unknown[]) => h.claimIdempotency(...a),
    rememberIdempotency: (...a: unknown[]) => h.rememberIdempotency(...a),
    releaseIdempotency: (...a: unknown[]) => h.releaseIdempotency(...a),
  };
});
vi.mock('@/lib/campaigns-server', () => ({ resolveCampaign: (...a: unknown[]) => h.resolveCampaign(...a) }));

import { decryptSecret } from '../secrets';
import { ATTRIBUTION_LIMITS, attributionColumns, cameFromMeta, readLandingAttribution } from './landing-attribution';
import { attributionItem } from './attribution';
import { POST as postOrder } from '@/app/api/v1/landing/orders/route';

const STORE = { id: 's1', name: 'متجر', status: 'ACTIVE', countryId: 'jo', theme: null, country: { code: 'JO', currencyCode: 'JOD', orderPrefix: 'JO', minorUnit: 3 } };
const PRODUCT = { id: 'p1', sku: 'A', name: 'عسل', description: null, image: null, basePrice: 15, status: 'ACTIVE', storeId: 's1', store: STORE };
const OFFER = { id: 'o1', name: 'عبوتان', quantity: 2, freeQuantity: 0, price: 22, listPrice: 25, compareAtPrice: null, isDefault: true, deliveryIncluded: false, endsAt: null };
// An old page's body: what every page sent before this change, minus the attribution it also sent.
const OLD = { productId: 'p1', offerId: 'o1', landingPageId: 'lp-9', full_name: 'زبون تجريبي', phone: '0790000001', address: 'شارع 5', city: 'عمّان', campaign: 'SUMMER1' };
const FBC = 'fb.1.1763380000000.IwAR2abcDEF';
const FBP = 'fb.1.1763380000000.1234567890';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148';
const NEW = {
  ...OLD,
  attribution: { utm_source: 'facebook', utm_campaign: '120210000000000009', utm_content: '123', utm_term: '120210000000000555', fbclid: 'IwAR2abcDEF', fbc: FBC, fbp: FBP, c: 'SUMMER1' },
  event_id: 'ev-5f1c2d',
  client_user_agent: UA,
};

const orderReq = (body: object, key = 'k1') =>
  new Request('https://x.test/api/v1/landing/orders', { method: 'POST', headers: { 'idempotency-key': key }, body: JSON.stringify(body) });
/** The attribution write: the `updateMany` that is not the channel's. */
const written = () => h.db.order.updateMany.mock.calls.map((c) => c[0]).find((a) => !('channelId' in a.data))?.data as Record<string, string> | undefined;

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = 'a'.repeat(64);
});

beforeEach(() => {
  vi.clearAllMocks();
  h.requireSystemToken.mockResolvedValue({ tokenId: 't', companyId: 'c1', system: 'landing', scopes: [] });
  h.db.product.findFirst.mockResolvedValue(PRODUCT);
  h.db.region.findMany.mockResolvedValue([{ id: 'amm', name: 'عمّان' }]);
  h.db.deliveryFee.findMany.mockResolvedValue([{ fee: 2.5 }]);
  h.db.store.findFirst.mockResolvedValue({ priceIncludesDelivery: false });
  h.db.orderChannel.findFirst.mockResolvedValue({ id: 'ch1' });
  h.db.order.updateMany.mockResolvedValue({ count: 1 });
  h.db.order.findFirst.mockResolvedValue(null);
  h.db.company.findUnique.mockResolvedValue({ settings: null });
  h.activeOffersFor.mockResolvedValue([OFFER]);
  h.claimIdempotency.mockResolvedValue(null);
  h.resolveCampaign.mockResolvedValue('camp-own-1');
  h.createPublicOrder.mockResolvedValue({ ok: true, body: { success: true, orderNumber: 'JO-2026-0007', total: 22, currency: 'JOD', addonToken: 'tok', postOrderOffer: null, postOrderWindowMinutes: 15, recommendations: [] } });
});

describe('1 · the mapping', () => {
  it('utm_content → adId, utm_campaign → metaCampaignId, utm_term → refCode, a Meta visit → «meta», and the rest beside them', () => {
    expect(readLandingAttribution(NEW)).toEqual({
      adId: '123',
      metaCampaignId: '120210000000000009',
      refCode: '120210000000000555',
      adSourceType: 'meta',
      externalLandingPageId: 'lp-9',
      fbc: FBC,
      fbp: FBP,
      clientUserAgent: UA,
      lpPurchaseEventId: 'ev-5f1c2d',
    });
  });

  it.each([
    [{ fbclid: 'x' }, true],
    [{ utm_source: 'facebook' }, true],
    [{ utm_source: 'FB' }, true],
    [{ utm_source: ' Instagram ' }, true],
    [{ utm_source: 'ig' }, true],
    [{ utm_source: 'Meta' }, true],
    [{ utm_source: 'google' }, false],
    [{ utm_source: 'tiktok', utm_content: '123' }, false],
    [{ utm_source: 'facebook.com' }, false],
    [{}, false],
  ])('%j came from Meta: %s', (attr, meta) => {
    expect(cameFromMeta(attr)).toBe(meta);
  });

  it('a visit that is not from Meta keeps its utm values, with no source type', () => {
    const a = readLandingAttribution({ landingPageId: 'lp-9', attribution: { utm_source: 'google', utm_campaign: 'spring', utm_content: 'banner-2', utm_term: 'honey' } });
    expect(a).toMatchObject({ adSourceType: null, adId: 'banner-2', metaCampaignId: 'spring', refCode: 'honey' });
  });

  it('the click and browser ids are sealed on the way to the row, and the plain ones are not written', () => {
    const cols = attributionColumns(readLandingAttribution(NEW));
    expect(Object.keys(cols).sort()).toEqual(
      ['adId', 'adSourceType', 'clientUserAgent', 'externalLandingPageId', 'fbcEnc', 'fbpEnc', 'lpPurchaseEventId', 'metaCampaignId', 'refCode'].sort()
    );
    expect(cols.fbcEnc).not.toContain('IwAR');
    expect(decryptSecret(cols.fbcEnc)).toBe(FBC);
    expect(decryptSecret(cols.fbpEnc)).toBe(FBP);
    // Never the order's own campaign foreign key, nor the page foreign key.
    expect(cols).not.toHaveProperty('campaignId');
    expect(cols).not.toHaveProperty('landingPageId');
  });

  it('with no key configured, a cookie is dropped — never written in the clear', () => {
    const saved = process.env.APP_ENCRYPTION_KEY;
    delete process.env.APP_ENCRYPTION_KEY;
    try {
      const cols = attributionColumns(readLandingAttribution(NEW));
      expect(cols).not.toHaveProperty('fbcEnc');
      expect(cols).not.toHaveProperty('fbpEnc');
      expect(JSON.stringify(cols)).not.toContain(FBC);
      expect(cols.adId).toBe('123');
    } finally {
      process.env.APP_ENCRYPTION_KEY = saved;
    }
  });
});

describe('3 · a bad value is dropped, never cut down, and never refuses the order', () => {
  it.each([
    ['an ad id over the limit', { attribution: { utm_content: '9'.repeat(ATTRIBUTION_LIMITS.id + 1) } }, 'adId'],
    ['a campaign id with a control character', { attribution: { utm_campaign: '1202\n10' } }, 'metaCampaignId'],
    ['an fbc that is not Meta’s shape', { attribution: { fbc: 'IwAR2abcDEF' } }, 'fbc'],
    ['an fbc over the limit', { attribution: { fbc: `fb.1.1.${'a'.repeat(ATTRIBUTION_LIMITS.fbc)}` } }, 'fbc'],
    ['an fbp with a space', { attribution: { fbp: 'fb.1.1 .2' } }, 'fbp'],
    ['a user agent over the limit', { client_user_agent: 'M'.repeat(ATTRIBUTION_LIMITS.userAgent + 1) }, 'clientUserAgent'],
    ['an event id that is a number', { event_id: 42 }, 'lpPurchaseEventId'],
    ['a blank ad id', { attribution: { utm_content: '   ' } }, 'adId'],
  ])('%s → null', (_name, body, key) => {
    expect(readLandingAttribution({ landingPageId: 'lp-9', ...body })[key as 'adId']).toBeNull();
  });

  it('the limits themselves fit', () => {
    const a = readLandingAttribution({ landingPageId: 'lp-9', attribution: { utm_content: '9'.repeat(ATTRIBUTION_LIMITS.id) }, client_user_agent: 'M'.repeat(ATTRIBUTION_LIMITS.userAgent) });
    expect(a.adId).toHaveLength(ATTRIBUTION_LIMITS.id);
    expect(a.clientUserAgent).toHaveLength(ATTRIBUTION_LIMITS.userAgent);
  });

  it.each([
    ['a string', 'utm_source=facebook'],
    ['an array', ['facebook']],
    ['null', null],
    ['a number', 7],
  ])('an attribution that is %s is no attribution, and the order is still taken', async (_n, attribution) => {
    const res = await postOrder(orderReq({ ...OLD, attribution, event_id: { x: 1 }, client_user_agent: ['x'] }));
    expect(res.status).toBe(201);
    expect(written()).toEqual({ externalLandingPageId: 'lp-9' });
  });

  it('values over the limit at the door: 201, and only the good ones are written', async () => {
    const res = await postOrder(orderReq({ ...NEW, attribution: { ...NEW.attribution, utm_content: '9'.repeat(500), fbc: 'x'.repeat(5000) }, client_user_agent: 'M'.repeat(5000) }));
    expect(res.status).toBe(201);
    const data = written()!;
    expect(data).not.toHaveProperty('adId');
    expect(data).not.toHaveProperty('fbcEnc');
    expect(data).not.toHaveProperty('clientUserAgent');
    expect(data).toMatchObject({ metaCampaignId: '120210000000000009', refCode: '120210000000000555', adSourceType: 'meta' });
  });
});

describe('1, 2, 4 · through the door', () => {
  it('a new page’s order: 201, and the ad written beside the row the engine created', async () => {
    const res = await postOrder(orderReq(NEW));
    expect(res.status).toBe(201);
    const call = h.db.order.updateMany.mock.calls.map((c) => c[0]).find((a) => !('channelId' in a.data))!;
    expect(call.where).toEqual({ companyId: 'c1', orderNumber: 'JO-2026-0007' });
    expect(call.data).toMatchObject({
      adId: '123',
      metaCampaignId: '120210000000000009',
      refCode: '120210000000000555',
      adSourceType: 'meta',
      externalLandingPageId: 'lp-9',
      clientUserAgent: UA,
      lpPurchaseEventId: 'ev-5f1c2d',
    });
    expect(decryptSecret(call.data.fbcEnc)).toBe(FBC);
    expect(decryptSecret(call.data.fbpEnc)).toBe(FBP);
  });

  it('the campaign short code still resolves to the OMS campaign, exactly as before', async () => {
    await postOrder(orderReq(NEW));
    expect(h.resolveCampaign).toHaveBeenCalledWith('c1', 's1', 'SUMMER1');
    expect(h.createPublicOrder.mock.calls[0][0].campaignId).toBe('camp-own-1');
  });

  it('nothing about the ad reaches the order engine', async () => {
    await postOrder(orderReq(NEW));
    const [surface, raw] = h.createPublicOrder.mock.calls[0];
    const sent = JSON.stringify([surface, raw]);
    for (const v of ['120210000000000009', FBC, FBP, UA, 'ev-5f1c2d', 'IwAR']) expect(sent).not.toContain(v);
  });

  it('an old page’s body is taken as before: the channel, then only its page id', async () => {
    const res = await postOrder(orderReq(OLD));
    expect(res.status).toBe(201);
    expect(h.db.order.updateMany.mock.calls[0][0].data).toEqual({ channelId: 'ch1' });
    expect(written()).toEqual({ externalLandingPageId: 'lp-9' });
  });

  it('a refused order writes no attribution', async () => {
    h.createPublicOrder.mockResolvedValue({ ok: false, status: 400, body: { error: 'يرجى التأكد من صحة بيانات الطلب.', fieldErrors: { phone: 'x' } } });
    expect((await postOrder(orderReq(NEW))).status).toBe(400);
    expect(h.db.order.updateMany).not.toHaveBeenCalled();
  });

  it('a failed write does not fail the order, and the log names a code, never a value', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.db.order.updateMany.mockImplementation(async (a: { data: object }) => {
      if ('channelId' in a.data) return { count: 1 };
      throw Object.assign(new Error(`Invalid invocation: ${JSON.stringify(a)}`), { code: 'P2022' });
    });
    try {
      const res = await postOrder(orderReq(NEW));
      expect(res.status).toBe(201);
      const logged = JSON.stringify(err.mock.calls);
      expect(logged).toContain('P2022');
      for (const v of ['123', '120210000000000009', UA, 'ev-5f1c2d', 'v1:']) expect(logged).not.toContain(v);
    } finally {
      err.mockRestore();
    }
  });
});

describe('5 · the migration adds six nullable columns and nothing else', () => {
  const root = join(__dirname, '..', '..', '..');
  const MIGRATION = join(root, 'prisma', 'migrations', '20261117130000_landing_ad_attribution');
  const sqlOf = (f: string) =>
    readFileSync(join(MIGRATION, f), 'utf8').replace(/\r\n/g, '\n').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').replace(/\s+/g, ' ').trim();
  const COLUMNS = ['metaCampaignId', 'externalLandingPageId', 'fbcEnc', 'fbpEnc', 'clientUserAgent', 'lpPurchaseEventId'];

  it('one idempotent ALTER on "orders": nullable TEXT, no default, no backfill, nothing dropped', () => {
    const sql = sqlOf('migration.sql');
    expect(sql).toBe(`ALTER TABLE "orders" ${COLUMNS.map((c) => `ADD COLUMN IF NOT EXISTS "${c}" TEXT`).join(', ')};`);
    expect(sql).not.toMatch(/NOT NULL|DEFAULT|DROP|UPDATE|DELETE|INSERT/i);
  });

  it('a rollback beside it drops only those columns and forgets only that migration', () => {
    expect(sqlOf('rollback.sql')).toBe(
      `ALTER TABLE "orders" ${COLUMNS.map((c) => `DROP COLUMN IF EXISTS "${c}"`).join(', ')}; DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261117130000_landing_ad_attribution';`
    );
  });

  it('and the schema declares each as an optional String on Order', () => {
    const schema = readFileSync(join(root, 'prisma', 'schema.prisma'), 'utf8').replace(/\r\n/g, '\n');
    const m = schema.slice(schema.indexOf('model Order {'));
    const order = m.slice(0, m.indexOf('\n}'));
    for (const c of COLUMNS) expect(order, c).toMatch(new RegExp(`\\n  ${c}\\s+String\\?\\n`));
  });
});

describe('6 · the media buyer’s feed', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = (over: object): any => ({
    id: 'o1', orderNumber: 'JO-1', confirmationStatus: 'NEW', shippingStatus: 'NOT_READY', claimedById: null, shippedAt: null, labelPrintedAt: null,
    confirmedAt: null, deliveredAt: null, returnedAt: null, createdAt: new Date('2026-11-17T08:00:00Z'), updatedAt: new Date('2026-11-17T08:00:00Z'),
    totalAmount: 22, collectedAmount: null, currency: 'JOD', rejectionReason: null, source: 'Landing Page', externalChannel: null, adId: '123',
    metaCampaignId: null, landingPageId: null, product: { sku: 'A' }, channel: null, campaign: null, landingPage: null,
    store: { country: { code: 'JO', timezone: 'Asia/Amman', minorUnit: 3 } }, statusLogs: [], contactAttempts: [], ...over,
  });

  it('gives the Meta campaign id of a landing order with no linked campaign', () => {
    expect(attributionItem(row({ metaCampaignId: '120210000000000009' }), null).campaign_id).toBe('120210000000000009');
  });

  it('a linked campaign’s own platform id still wins, and an order with neither says null', () => {
    expect(attributionItem(row({ metaCampaignId: '999', campaign: { externalId: '120210000000000001' } }), null).campaign_id).toBe('120210000000000001');
    expect(attributionItem(row({}), null).campaign_id).toBeNull();
  });
});
