import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE LANDING DOOR, FOR A PRODUCT WITH VARIANTS (contract oms-lp.v1 §10, the owner 2026-11-18).
 *
 * The product read carries its options and combinations (available or not, a count only from 1 to 20); the quote and
 * the order take one combination per piece; an old body — no `units` — is taken exactly as before; a product without
 * variants answers `variants: null` and nothing else changes.
 */

const h = vi.hoisted(() => ({
  db: {
    product: { findMany: vi.fn(), findFirst: vi.fn() },
    region: { findMany: vi.fn() },
    deliveryFee: { findMany: vi.fn() },
    store: { findFirst: vi.fn() },
    orderChannel: { findFirst: vi.fn() },
    order: { updateMany: vi.fn(), findFirst: vi.fn() },
    productVariant: { findMany: vi.fn() },
    orderItemVariant: { groupBy: vi.fn() },
  },
  requireSystemToken: vi.fn(),
  activeOffersFor: vi.fn(),
  availableStock: vi.fn(),
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
vi.mock('@/lib/reservation', async () => {
  const real = await vi.importActual<typeof import('../reservation')>('../reservation');
  return { ...real, availableStock: (...a: unknown[]) => h.availableStock(...a) };
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
vi.mock('@/lib/cart-order-stand-down', () => ({ replaceableCartOrders: async () => [], standDownCartOrders: async () => [], cartsRecoveredBy: async () => {} }));
vi.mock('@/lib/v1/ad-tags', () => ({ stampAdTags: async () => {} }));

import { GET as getProduct } from '@/app/api/v1/landing/products/[id]/route';
import { GET as getQuote } from '@/app/api/v1/landing/quote/route';
import { POST as postOrder } from '@/app/api/v1/landing/orders/route';

const OPTIONS = [
  { id: 'o1', name: 'المقاس', values: [{ id: 's', label: 'S', swatch: null }, { id: 'xl', label: 'XL', swatch: null }] },
  { id: 'o2', name: 'اللون', values: [{ id: 'blk', label: 'أسود', swatch: '#111111' }] },
];
const STORE = { id: 's1', name: 'متجر', status: 'ACTIVE', countryId: 'jo', theme: null, country: { code: 'JO', currencyCode: 'JOD', orderPrefix: 'JO', minorUnit: 3 } };
const PLAIN = { id: 'p0', sku: 'H', name: 'عسل', description: null, image: null, basePrice: 15, status: 'ACTIVE', storeId: 's1', variantOptions: null, store: STORE };
const SHIRT = { ...PLAIN, id: 'p1', sku: 'TS', name: 'قميص', basePrice: 12, variantOptions: JSON.stringify(OPTIONS) };
const ROWS = [
  { id: 'v-s', optionValues: '["s","blk"]', label: 'S · أسود', sku: null, priceDelta: 0, onHand: 4, status: 'ACTIVE', sortOrder: 0 },
  { id: 'v-xl', optionValues: '["xl","blk"]', label: 'XL · أسود', sku: null, priceDelta: 2, onHand: 0, status: 'ACTIVE', sortOrder: 1 },
];
const OFFER = { id: 'of2', name: 'قطعتين', quantity: 2, freeQuantity: 0, price: 22, listPrice: 22, compareAtPrice: null, isDefault: true, deliveryIncluded: false, endsAt: null };
const BODY = { productId: 'p1', offerId: 'of2', landingPageId: 'lp-1', full_name: 'أحمد', phone: '0790123456', address: 'شارع 5', city: 'عمّان' };
const CALLER = { tokenId: 't', companyId: 'c1', system: 'landing', scopes: [] };

const orderReq = (body: object) =>
  new Request('https://x.test/api/v1/landing/orders', { method: 'POST', headers: { 'idempotency-key': 'k1' }, body: JSON.stringify(body) });
const quoteReq = (q: string) => new Request(`https://x.test/api/v1/landing/quote?${q}`);

beforeEach(() => {
  vi.clearAllMocks();
  h.requireSystemToken.mockResolvedValue(CALLER);
  h.db.product.findFirst.mockResolvedValue(SHIRT);
  h.db.region.findMany.mockResolvedValue([{ id: 'amm', name: 'عمّان' }]);
  h.db.deliveryFee.findMany.mockResolvedValue([{ fee: 2 }]);
  h.db.store.findFirst.mockResolvedValue({ priceIncludesDelivery: false });
  h.db.orderChannel.findFirst.mockResolvedValue(null);
  h.db.order.updateMany.mockResolvedValue({ count: 1 });
  h.db.order.findFirst.mockResolvedValue(null);
  h.db.productVariant.findMany.mockResolvedValue(ROWS);
  h.db.orderItemVariant.groupBy.mockResolvedValue([{ variantId: 'v-s', _sum: { quantity: 1, freeQuantity: 0 } }]);
  h.activeOffersFor.mockResolvedValue([OFFER]);
  h.availableStock.mockResolvedValue(500);
  h.claimIdempotency.mockResolvedValue(null);
  h.resolveCampaign.mockResolvedValue(null);
  h.createPublicOrder.mockResolvedValue({ ok: true, body: { success: true, orderNumber: 'JO-1', total: 22, currency: 'JOD' } });
});

describe('§10 — the product read', () => {
  it('carries the options and every active combination: available or not, and a count only from 1 to 20', async () => {
    const res = await getProduct(new Request('https://x.test/api/v1/landing/products/p1'), { params: Promise.resolve({ id: 'p1' }) });
    const p = await res.json();
    expect(p.variants.options).toEqual(OPTIONS);
    // S · أسود: 4 counted, 1 held by a confirmed order → 3 left.
    expect(p.variants.combinations).toEqual([
      { id: 'v-s', values: ['s', 'blk'], label: 'S · أسود', priceDelta: 0, available: true, availableStock: 3 },
      { id: 'v-xl', values: ['xl', 'blk'], label: 'XL · أسود', priceDelta: 2, available: false, availableStock: null },
    ]);
  });
  it('a product without variants answers null and reads no combination', async () => {
    h.db.product.findFirst.mockResolvedValue(PLAIN);
    const res = await getProduct(new Request('https://x.test/api/v1/landing/products/p0'), { params: Promise.resolve({ id: 'p0' }) });
    expect((await res.json()).variants).toBeNull();
    expect(h.db.productVariant.findMany).not.toHaveBeenCalled();
  });
});

describe('§3 — the quote takes a combination per piece', () => {
  it('prices the pieces and says how many the offer needs', async () => {
    h.db.productVariant.findMany.mockResolvedValue([ROWS[0], { ...ROWS[1], onHand: 3 }]);
    const res = await getQuote(quoteReq('productId=p1&offerId=of2&city=&units=v-s,v-xl'));
    expect(await res.json()).toMatchObject({ subtotal: 24, net: 24, variantsDelta: 2, unitsRequired: 2 });
  });
  it('without units: the base offer, and the count the page must ask for', async () => {
    const res = await getQuote(quoteReq('productId=p1&offerId=of2&city='));
    expect(await res.json()).toMatchObject({ subtotal: 22, variantsDelta: 0, unitsRequired: 2 });
  });
  it('a sold-out piece is the visitor\'s to fix: 400 with the field on that piece', async () => {
    const res = await getQuote(quoteReq('productId=p1&offerId=of2&city=&units=v-s,v-xl'));
    expect(res.status).toBe(400);
    expect((await res.json()).fieldErrors).toEqual({ units: 'نفد «XL · أسود». اختر خيارًا آخر.', 'units.1': 'نفد «XL · أسود». اختر خيارًا آخر.' });
  });
  it('a product without variants: 0 and 0, and the figures it always had', async () => {
    h.db.product.findFirst.mockResolvedValue(PLAIN);
    const res = await getQuote(quoteReq('productId=p0&offerId=of2&city='));
    expect(await res.json()).toMatchObject({ subtotal: 22, variantsDelta: 0, unitsRequired: 0 });
  });
});

describe('§4 — the order', () => {
  it('hands the pieces to the one order engine, with the product\'s options', async () => {
    const res = await postOrder(orderReq({ ...BODY, units: [{ variantId: 'v-s' }, { variantId: 'v-s' }] }));
    expect(res.status).toBe(201);
    const [surface] = h.createPublicOrder.mock.calls[0];
    expect(surface.units).toEqual(['v-s', 'v-s']);
    expect(surface.products[0].variantOptions).toBe(SHIRT.variantOptions);
  });
  it('an old body — no units — is taken exactly as before: no pieces on the surface', async () => {
    const res = await postOrder(orderReq(BODY));
    expect(res.status).toBe(201);
    const [surface] = h.createPublicOrder.mock.calls[0];
    expect('units' in surface).toBe(false);
  });
  it('a malformed units list is refused by the door\'s own schema, nothing created', async () => {
    const res = await postOrder(orderReq({ ...BODY, units: [{ variantId: '' }] }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(h.createPublicOrder).not.toHaveBeenCalled();
  });
});
