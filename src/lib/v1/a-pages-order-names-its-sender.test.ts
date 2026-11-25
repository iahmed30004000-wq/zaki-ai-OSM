import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — WHAT ZAKI PAGES ADDS TO ITS ORDERS (2026-11-21, «Prompt 2»)
 *
 *  1. The landing door takes, all OPTIONAL at the top level: fbp · fbc · client_ip · client_user_agent ·
 *     event_source_url · browser_event_id · pixel_id · utm_* · ad_id · ad_name · page_id · page_slug · cc_sender.
 *  2. Reused columns for what they already hold (fbc/fbp sealed, utm → adId/metaCampaignId/refCode/utmSource/utmMedium,
 *     ad_name → adName, event_source_url → landingUrl without its query, browser_event_id → lpPurchaseEventId,
 *     page_id → externalLandingPageId); new only for what had none: ccSender · lpPixelId · externalPageSlug.
 *  3. client_ip is stored NOWHERE, sealed or not.
 *  4. A bad value is dropped, the order is still taken; an old body is taken exactly as before.
 *  5. cc_sender «pages» stands down the conversion this system queued at creation.
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
    conversionDelivery: { updateMany: vi.fn() },
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
import { mergedAttribution, readLandingAttribution, readPagesFields } from './landing-attribution';
import { PAGES_SENDS_AR } from '../conversions/types';
import { POST as postOrder } from '@/app/api/v1/landing/orders/route';

const STORE = { id: 's1', name: 'متجر', status: 'ACTIVE', countryId: 'jo', theme: null, country: { code: 'JO', currencyCode: 'JOD', orderPrefix: 'JO', minorUnit: 3 } };
const PRODUCT = { id: 'p1', sku: 'A', name: 'عسل', description: null, image: null, basePrice: 15, status: 'ACTIVE', storeId: 's1', store: STORE };
const OFFER = { id: 'o1', name: 'عبوتان', quantity: 2, freeQuantity: 0, price: 22, listPrice: 25, compareAtPrice: null, isDefault: true, deliveryIncluded: false, endsAt: null };
const OLD = { productId: 'p1', offerId: 'o1', landingPageId: 'lp-9', full_name: 'زبون تجريبي', phone: '0790000001', address: 'شارع 5', city: 'عمّان', campaign: 'SUMMER1' };
const FBC = 'fb.1.1763380000000.IwAR2abcDEF';
const FBP = 'fb.1.1763380000000.1234567890';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148';
const IP = '203.0.113.77';
const PAGES = {
  ...OLD,
  fbp: FBP,
  fbc: FBC,
  client_ip: IP,
  client_user_agent: UA,
  event_source_url: 'https://pages.example.test/p/honey?fbclid=IwAR2abcDEF&utm_source=facebook',
  browser_event_id: 'pg-ev-77',
  pixel_id: '1234567890123456',
  utm_source: 'facebook',
  utm_medium: 'paid',
  utm_campaign: '120210000000000009',
  utm_content: '120210000000000111',
  utm_term: '120210000000000555',
  ad_id: '120210000000000222',
  ad_name: 'فيديو العسل 3',
  page_id: 'pg-page-1',
  page_slug: 'honey-offer',
  cc_sender: 'pages',
};

const orderReq = (body: object, key = 'k1') =>
  new Request('https://x.test/api/v1/landing/orders', { method: 'POST', headers: { 'idempotency-key': key }, body: JSON.stringify(body) });
const updates = () => h.db.order.updateMany.mock.calls.map((c) => c[0]);
/** The attribution write: the one that is neither the channel's nor the ad tags' (which is conditional on four nulls). */
const written = () => updates().find((a) => !('channelId' in a.data) && !('adName' in a.where))?.data as Record<string, string> | undefined;
const tags = () => updates().find((a) => 'adName' in a.where)?.data as Record<string, unknown> | undefined;

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
  h.db.conversionDelivery.updateMany.mockResolvedValue({ count: 1 });
  h.activeOffersFor.mockResolvedValue([OFFER]);
  h.claimIdempotency.mockResolvedValue(null);
  h.resolveCampaign.mockResolvedValue('camp-own-1');
  h.createPublicOrder.mockResolvedValue({ ok: true, body: { success: true, orderNumber: 'JO-2026-0007', total: 22, currency: 'JOD', addonToken: 'tok', postOrderOffer: null, postOrderWindowMinutes: 15, recommendations: [] } });
});

describe('1, 2 · every field Zaki Pages sends lands in its column', () => {
  it('201, and the reused columns and the three new ones are written beside the order', async () => {
    const res = await postOrder(orderReq(PAGES));
    expect(res.status).toBe(201);
    const data = written()!;
    expect(data).toMatchObject({
      adId: '120210000000000222', // ad_id before utm_content
      metaCampaignId: '120210000000000009',
      refCode: '120210000000000555',
      adSourceType: 'meta',
      externalLandingPageId: 'lp-9', // landingPageId still wins: page_id is its fallback
      clientUserAgent: UA,
      lpPurchaseEventId: 'pg-ev-77',
      ccSender: 'pages',
      lpPixelId: '1234567890123456',
      externalPageSlug: 'honey-offer',
    });
    expect(decryptSecret(data.fbcEnc)).toBe(FBC);
    expect(decryptSecret(data.fbpEnc)).toBe(FBP);
    // The ad tags: ad_name, the utm source and medium, and the page — without its query.
    expect(tags()).toEqual({ adName: 'فيديو العسل 3', utmSource: 'facebook', utmMedium: 'paid', landingUrl: 'https://pages.example.test/p/honey' });
  });

  it('event_id still wins over browser_event_id', async () => {
    await postOrder(orderReq({ ...PAGES, event_id: 'ev-own' }));
    expect(written()).toMatchObject({ lpPurchaseEventId: 'ev-own' });
  });

  it('page_id stands in only for a landing page id that gives none', () => {
    expect(readLandingAttribution({ landingPageId: '  ', page_id: 'pg-page-1' }).externalLandingPageId).toBe('pg-page-1');
    expect(readLandingAttribution({ landingPageId: 'lp-9', page_id: 'pg-page-1' }).externalLandingPageId).toBe('lp-9');
  });

  it('the older `attribution` object wins over the same name at the top level', () => {
    expect(mergedAttribution({ fbc: 'fb.1.1.top', attribution: { fbc: 'fb.1.1.inner', utm_source: 'ig' } })).toEqual({ fbc: 'fb.1.1.inner', utm_source: 'ig' });
  });

  it('3 · client_ip is stored nowhere — not in the order write, not in the tags, not sealed, not logged', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await postOrder(orderReq(PAGES));
      const everything = JSON.stringify(h.db.order.updateMany.mock.calls);
      expect(everything).not.toContain(IP);
      for (const data of updates().map((u) => u.data)) {
        for (const [k, v] of Object.entries(data)) {
          expect(k.toLowerCase()).not.toContain('ip');
          if (typeof v === 'string' && v.startsWith('v1:')) expect(decryptSecret(v)).not.toBe(IP);
        }
      }
      expect(JSON.stringify(err.mock.calls)).not.toContain(IP);
      // …and nothing of the ad reaches the order engine.
      expect(JSON.stringify(h.createPublicOrder.mock.calls)).not.toContain(IP);
    } finally {
      err.mockRestore();
    }
  });
});

describe('4 · a bad value is dropped and the order is still taken', () => {
  it.each([
    ['a cc_sender that is no sender', { cc_sender: 'meta' }, 'ccSender'],
    ['a cc_sender that is a number', { cc_sender: 1 }, 'ccSender'],
    ['a pixel id with letters', { pixel_id: '12ab' }, 'lpPixelId'],
    ['a pixel id over the limit', { pixel_id: '9'.repeat(33) }, 'lpPixelId'],
    ['a slug with a space', { page_slug: 'honey offer' }, 'externalPageSlug'],
    ['a slug over the limit', { page_slug: 's'.repeat(121) }, 'externalPageSlug'],
    ['a slug with a control character', { page_slug: 'honey\u0007' }, 'externalPageSlug'],
  ])('%s → null', (_n, body, key) => {
    expect(readPagesFields(body)[key as 'ccSender']).toBeNull();
  });

  it('a sender is read in any case, and only «pages» or «oms»', () => {
    expect(readPagesFields({ cc_sender: ' PAGES ' }).ccSender).toBe('pages');
    expect(readPagesFields({ cc_sender: 'oms' }).ccSender).toBe('oms');
  });

  it('junk in every new field: 201, and none of it is written', async () => {
    const res = await postOrder(
      orderReq({
        ...OLD,
        fbp: 'not-a-cookie', fbc: { x: 1 }, client_ip: ['x'], event_source_url: 'javascript:alert(1)', browser_event_id: 7,
        pixel_id: 'px', utm_campaign: 'x'.repeat(500), ad_id: '\n', ad_name: 'n'.repeat(500), page_id: 42, page_slug: 'a b', cc_sender: true,
      })
    );
    expect(res.status).toBe(201);
    expect(written()).toEqual({ externalLandingPageId: 'lp-9' });
    expect(tags()).toBeUndefined();
    expect(h.db.conversionDelivery.updateMany).not.toHaveBeenCalled();
  });

  it('an old page’s body is taken exactly as before: the channel, then only its page id, and no conversion touched', async () => {
    const res = await postOrder(orderReq(OLD));
    expect(res.status).toBe(201);
    expect(h.db.order.updateMany.mock.calls[0][0].data).toEqual({ channelId: 'ch1' });
    expect(written()).toEqual({ externalLandingPageId: 'lp-9' });
    expect(h.db.conversionDelivery.updateMany).not.toHaveBeenCalled();
  });
});

describe('5 · «pages» stands down what this system queued at creation', () => {
  it('the order’s PENDING conversions become SKIPPED with the reason — nothing else is touched', async () => {
    h.db.order.findFirst.mockImplementation(async (a: { where: Record<string, unknown> }) =>
      a.where.orderNumber === 'JO-2026-0007' ? { id: 'ord-1' } : null
    );
    await postOrder(orderReq(PAGES));
    expect(h.db.conversionDelivery.updateMany).toHaveBeenCalledTimes(1);
    expect(h.db.conversionDelivery.updateMany.mock.calls[0][0]).toEqual({
      where: { companyId: 'c1', orderId: 'ord-1', status: 'PENDING' },
      data: { status: 'SKIPPED', nextAttemptAt: null, lastError: PAGES_SENDS_AR },
    });
  });

  it('NEGATIVE: a sender of «oms» stands nothing down', async () => {
    await postOrder(orderReq({ ...PAGES, cc_sender: 'oms' }));
    expect(written()).toMatchObject({ ccSender: 'oms' });
    expect(h.db.conversionDelivery.updateMany).not.toHaveBeenCalled();
  });

  it('a failure there does not fail the order, and logs a code only', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.db.order.findFirst.mockResolvedValue({ id: 'ord-1' });
    h.db.conversionDelivery.updateMany.mockRejectedValue(Object.assign(new Error(`boom ${FBC}`), { code: 'P2025' }));
    try {
      expect((await postOrder(orderReq(PAGES))).status).toBe(201);
      const logged = JSON.stringify(err.mock.calls);
      expect(logged).toContain('P2025');
      expect(logged).not.toContain(FBC);
    } finally {
      err.mockRestore();
    }
  });
});
