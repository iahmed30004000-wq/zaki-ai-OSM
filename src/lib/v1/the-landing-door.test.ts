import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The standalone landing system's door, answering. `the-systems-door.test.ts`
 * already sweeps these routes for the key, the idempotency and the absence of
 * a model; this file holds what is particular to them: every product is
 * visible, the fee shown can only be at or above the fee charged, and an order
 * goes through `createPublicOrder` with a surface the caller could not choose.
 */

const h = vi.hoisted(() => ({
  db: {
    product: { findMany: vi.fn(), findFirst: vi.fn() },
    country: { findFirst: vi.fn() },
    region: { findMany: vi.fn() },
    deliveryFee: { findMany: vi.fn() },
    store: { findFirst: vi.fn() },
    orderChannel: { findFirst: vi.fn() },
    order: { updateMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    orderItem: { update: vi.fn() },
    orderAddOn: { count: vi.fn(), findMany: vi.fn() },
    orderActivity: { count: vi.fn(), create: vi.fn() },
    company: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
  requireSystemToken: vi.fn(),
  activeOffersFor: vi.fn(),
  activeOffersForProducts: vi.fn(),
  availableStock: vi.fn(),
  createPublicOrder: vi.fn(),
  claimIdempotency: vi.fn(),
  rememberIdempotency: vi.fn(),
  releaseIdempotency: vi.fn(),
  verifyAddonToken: vi.fn(),
  unitCostsOf: vi.fn(),
  resolveCampaign: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db: h.db }));
vi.mock('@/lib/v1/system-token', async () => {
  const real = await vi.importActual<typeof import('./system-token')>('./system-token');
  return { ...real, requireSystemToken: (...a: unknown[]) => h.requireSystemToken(...a) };
});
vi.mock('@/lib/offers', async () => {
  const real = await vi.importActual<typeof import('../offers')>('../offers');
  return {
    ...real,
    activeOffersFor: (...a: unknown[]) => h.activeOffersFor(...a),
    activeOffersForProducts: (...a: unknown[]) => h.activeOffersForProducts(...a),
  };
});
vi.mock('@/lib/reservation', async () => {
  const real = await vi.importActual<typeof import('../reservation')>('../reservation');
  return { ...real, availableStock: (...a: unknown[]) => h.availableStock(...a) };
});
vi.mock('@/lib/public-order', async () => {
  // The pricing is the real one: a test that mocked it would prove nothing about the figures.
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
vi.mock('@/lib/landing-pages', async () => {
  const real = await vi.importActual<typeof import('../landing-pages')>('../landing-pages');
  return { ...real, verifyAddonToken: (...a: unknown[]) => h.verifyAddonToken(...a) };
});
vi.mock('@/lib/product-fixed-cost', () => ({ unitCostsOf: (...a: unknown[]) => h.unitCostsOf(...a) }));
vi.mock('@/lib/campaigns-server', () => ({ resolveCampaign: (...a: unknown[]) => h.resolveCampaign(...a) }));

import { V1Fault, V1_CODE } from './door';
import { GET as listProducts } from '@/app/api/v1/landing/products/route';
import { GET as getProduct } from '@/app/api/v1/landing/products/[id]/route';
import { GET as getQuote } from '@/app/api/v1/landing/quote/route';
import { POST as postOrder } from '@/app/api/v1/landing/orders/route';
import { POST as postAddOn } from '@/app/api/v1/landing/orders/[orderNumber]/post-order-offer/route';

const CALLER = { tokenId: 't', companyId: 'c1', system: 'landing', scopes: [] };
const STORE = { id: 's1', name: 'متجر', status: 'ACTIVE', countryId: 'jo', theme: null, country: { code: 'JO', currencyCode: 'JOD', orderPrefix: 'JO', minorUnit: 3 } };
const PRODUCT = { id: 'p1', sku: 'A', name: 'عسل', description: null, image: '/api/media/companies/11111111-1111-1111-1111-111111111111/products/22222222-2222-2222-2222-222222222222/33333333-3333-3333-3333-333333333333.webp', basePrice: 15, status: 'ACTIVE', storeId: 's1', store: STORE };
const offer = (over: object = {}) => ({ id: 'o1', name: 'عبوتان', quantity: 2, freeQuantity: 0, price: 22, listPrice: 25, compareAtPrice: null, isDefault: true, deliveryIncluded: false, endsAt: null, ...over });
const ORDER = { productId: 'p1', offerId: 'o1', landingPageId: 'lp-9', full_name: 'أحمد', phone: '0790123456', address: 'شارع 5', city: 'عمّان' };

const quoteReq = (q = 'productId=p1&offerId=o1&city=%D8%B9%D9%85%D9%91%D8%A7%D9%86') => new Request(`https://x.test/api/v1/landing/quote?${q}`);
const orderReq = (body: object = ORDER, headers: Record<string, string> = { 'idempotency-key': 'k1' }) =>
  new Request('https://x.test/api/v1/landing/orders', { method: 'POST', headers, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.APP_URL = 'https://oms.test';
  h.requireSystemToken.mockResolvedValue(CALLER);
  h.db.product.findFirst.mockResolvedValue(PRODUCT);
  h.db.region.findMany.mockResolvedValue([{ id: 'amm', name: 'عمّان' }]);
  h.db.deliveryFee.findMany.mockResolvedValue([{ fee: 2.5 }]);
  h.db.store.findFirst.mockResolvedValue({ priceIncludesDelivery: false });
  h.db.orderChannel.findFirst.mockResolvedValue({ id: 'ch1' });
  h.db.order.updateMany.mockResolvedValue({ count: 1 });
  h.activeOffersFor.mockResolvedValue([offer()]);
  h.availableStock.mockResolvedValue(500);
  h.claimIdempotency.mockResolvedValue(null);
  h.resolveCampaign.mockResolvedValue(null);
  h.createPublicOrder.mockResolvedValue({ ok: true, body: { success: true, orderNumber: 'JO-2026-0007', total: 22, currency: 'JOD', addonToken: 'tok', postOrderOffer: null, postOrderWindowMinutes: 15, recommendations: [] } });
});

describe('every product the OMS holds shows up', () => {
  it('lists active and inactive alike, from this company only, with no cost in sight', async () => {
    h.db.product.findMany.mockResolvedValue([PRODUCT, { ...PRODUCT, id: 'p2', name: 'موقوف', status: 'INACTIVE' }]);
    h.activeOffersForProducts.mockResolvedValue(new Map([['p1', [offer()]], ['p2', []]]));
    const res = await listProducts(new Request('https://x.test/api/v1/landing/products'));
    const { products } = await res.json();
    expect(products.map((p: { id: string; status: string }) => [p.id, p.status])).toEqual([['p1', 'ACTIVE'], ['p2', 'INACTIVE']]);
    const where = h.db.product.findMany.mock.calls[0][0].where;
    expect(where.companyId).toBe('c1');
    expect(where.status).toBeUndefined();
    expect(h.db.product.findMany.mock.calls[0][0].take).toBeUndefined();
    expect(JSON.stringify(products)).not.toMatch(/cost/i);
  });

  it('hands a page on another domain an image it can load', async () => {
    h.db.product.findMany.mockResolvedValue([PRODUCT]);
    h.activeOffersForProducts.mockResolvedValue(new Map([['p1', []]]));
    const { products } = await (await listProducts(new Request('https://x.test/'))).json();
    expect(products[0].images[0]).toMatch(/^https:\/\/oms\.test\/api\/public\/media\//);
  });

  it('prints a stock figure only when it is small enough to be shown', async () => {
    const stockOf = async () => (await (await getProduct(new Request('https://x.test/'), { params: Promise.resolve({ id: 'p1' }) })).json()).availableStock;
    expect(await stockOf()).toBeNull();
    h.availableStock.mockResolvedValue(7);
    expect(await stockOf()).toBe(7);
  });

  it('answers 404 for another company’s product', async () => {
    h.db.product.findFirst.mockResolvedValue(null);
    const res = await getProduct(new Request('https://x.test/'), { params: Promise.resolve({ id: 'theirs' }) });
    expect(res.status).toBe(404);
    expect(h.db.product.findFirst.mock.calls[0][0].where.companyId).toBe('c1');
  });
});

describe('the fee a visitor is shown', () => {
  it('adds the fee when the offer does not include it', async () => {
    const q = await (await getQuote(quoteReq())).json();
    expect(q).toMatchObject({ subtotal: 25, discount: 3, net: 22, deliveryFee: 2.5, cod: 24.5, deliveryIncluded: false, feeKnown: true, feeExact: true, currency: 'JOD' });
  });

  it('shows no fee when the offer includes delivery, and does not change the amount', async () => {
    h.activeOffersFor.mockResolvedValue([offer({ deliveryIncluded: true })]);
    const q = await (await getQuote(quoteReq())).json();
    expect(q).toMatchObject({ deliveryFee: 0, cod: 22, deliveryIncluded: true, feeExact: true });
  });

  it('with couriers that disagree, states the highest, so nobody pays more than they saw', async () => {
    h.db.deliveryFee.findMany.mockResolvedValue([{ fee: 2 }, { fee: 3.5 }]);
    const q = await (await getQuote(quoteReq())).json();
    expect(q).toMatchObject({ deliveryFee: 3.5, cod: 25.5, feeExact: false, feeKnown: true });
  });

  it('says it does not know, rather than calling a missing row free', async () => {
    h.db.deliveryFee.findMany.mockResolvedValue([]);
    const q = await (await getQuote(quoteReq())).json();
    expect(q).toMatchObject({ deliveryFee: 0, cod: 22, feeKnown: false });
  });

  it('reads only this store’s and the company-wide couriers', async () => {
    await getQuote(quoteReq());
    expect(h.db.deliveryFee.findMany.mock.calls[0][0].where.provider).toEqual({ isActive: true, OR: [{ storeId: null }, { storeId: 's1' }] });
  });

  it('refuses a city that is not this country’s, in the visitor’s language', async () => {
    const res = await getQuote(quoteReq('productId=p1&offerId=o1&city=Paris'));
    expect(res.status).toBe(400);
    expect((await res.json()).fieldErrors.city).toMatch(/المدينة/);
  });
});

describe('an order through the door', () => {
  it('goes through createPublicOrder, on a surface the caller could not name', async () => {
    const res = await postOrder(orderReq({ ...ORDER, companyId: 'evil', price: 1, total: 1 }));
    expect(res.status).toBe(201);
    const [surface, raw] = h.createPublicOrder.mock.calls[0];
    expect(surface.companyId).toBe('c1');
    expect(surface.store.id).toBe('s1');
    expect(surface.products).toEqual([{ id: 'p1', name: 'عسل', image: PRODUCT.image, basePrice: 15 }]);
    expect(surface.dedupeScope).toBe('lpx:lp-9');
    expect(surface.landingPage).toBeNull();
    expect(raw).not.toHaveProperty('price');
    expect(raw).not.toHaveProperty('total');
    expect(raw).not.toHaveProperty('companyId');
  });

  it('leaves the order’s stored total alone and reports the expected collection beside it', async () => {
    const body = await (await postOrder(orderReq())).json();
    expect(body.total).toBe(22);
    expect(body).toMatchObject({ cod: 24.5, deliveryFee: 2.5, feeKnown: true });
    expect(h.db.order.updateMany.mock.calls[0][0].data).toEqual({ channelId: 'ch1' });
  });

  it('refuses a paused store or a retired product before anything is written', async () => {
    for (const row of [{ ...PRODUCT, store: { ...STORE, status: 'SUSPENDED' } }, { ...PRODUCT, status: 'INACTIVE' }]) {
      h.db.product.findFirst.mockResolvedValue(row);
      const res = await postOrder(orderReq());
      expect(res.status).toBe(409);
    }
    expect(h.createPublicOrder).not.toHaveBeenCalled();
    expect(h.releaseIdempotency).toHaveBeenCalledTimes(2);
  });

  it('needs a key, and a retry is the first answer and no second order', async () => {
    expect((await postOrder(orderReq(ORDER, {}))).status).toBe(400);
    h.claimIdempotency.mockResolvedValue({ status: 200, body: { orderNumber: 'JO-2026-0007', total: 22 } });
    const res = await postOrder(orderReq());
    expect(res.status).toBe(200);
    expect((await res.json()).orderNumber).toBe('JO-2026-0007');
    expect(h.createPublicOrder).not.toHaveBeenCalled();
  });

  it('gives the key back on a refusal, so the corrected form is a real attempt', async () => {
    h.createPublicOrder.mockResolvedValue({ ok: false, status: 400, body: { error: 'يرجى التأكد من صحة بيانات الطلب.', fieldErrors: { phone: 'x' } } });
    const res = await postOrder(orderReq());
    expect(res.status).toBe(400);
    expect((await res.json()).fieldErrors.phone).toBe('x');
    expect(h.releaseIdempotency).toHaveBeenCalledWith('c1', 'k1');
    expect(h.rememberIdempotency).not.toHaveBeenCalled();
  });

  it('answers the machine envelope when the key is bad, and no customer detail in a validation error', async () => {
    h.requireSystemToken.mockRejectedValue(new V1Fault(401, V1_CODE.TOKEN_INVALID, 'no'));
    expect(((await (await postOrder(orderReq())).json()) as { error: { code: string } }).error.code).toBe('TOKEN_INVALID');
    h.requireSystemToken.mockResolvedValue(CALLER);
    const text = await (await postOrder(orderReq({ ...ORDER, productId: '' }))).text();
    expect(text).toContain('productId');
    expect(text).not.toContain('0790123456');
  });
});

describe('the offer after the order replaces the offer', () => {
  const NOW = new Date('2026-11-10T12:00:00Z');
  const addReq = (offerId = 'o3', order = 'JO-2026-0007') =>
    new Request(`https://x.test/api/v1/landing/orders/${order}/post-order-offer`, { method: 'POST', headers: { 'idempotency-key': 'u1' }, body: JSON.stringify({ token: 'x'.repeat(30), offerId }) });
  const ctx = (orderNumber = 'JO-2026-0007') => ({ params: Promise.resolve({ orderNumber }) });
  const one = offer({ id: 'o1', name: 'عبوة', quantity: 1, price: 20, listPrice: null, deliveryIncluded: false });
  const three = offer({ id: 'o3', name: '3 عبوات', quantity: 3, price: 40, listPrice: 50, deliveryIncluded: true });
  const six = offer({ id: 'o6', name: '6 عبوات', quantity: 6, price: 70, listPrice: null, deliveryIncluded: true });
  const stored = (over: object = {}) => ({
    id: 'ord1', status: 'NEW', confirmationStatus: 'NEW', createdAt: new Date(Date.now() - 60_000), currency: 'JOD', productId: 'p1', offerId: 'o1', quantity: 1, freeQuantity: 0, totalAmount: 20,
    discountAmount: 0, shippingCost: 0, deliveryFee: null, region: { name: 'عمّان' }, _count: { contactAttempts: 0 },
    items: [{ id: 'line1', productId: 'p1', quantity: 1, freeQuantity: 0, reservedQty: 0, deliveredQty: null }], ...over,
  });

  beforeEach(() => {
    h.verifyAddonToken.mockResolvedValue({ orderId: 'ord1', orderNumber: 'JO-2026-0007' });
    h.db.order.findFirst.mockResolvedValue(stored());
    h.db.order.update.mockResolvedValue({ id: 'ord1' });
    h.db.orderAddOn.count.mockResolvedValue(0);
    h.db.orderAddOn.findMany.mockResolvedValue([]);
    h.db.orderActivity.count.mockResolvedValue(0);
    h.db.company.findUnique.mockResolvedValue({ settings: null });
    h.db.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(h.db));
    h.activeOffersFor.mockResolvedValue([one, three, six]);
    h.unitCostsOf.mockResolvedValue(new Map([['p1', 4]]));
  });

  it('offers the next larger catalogue offer on the thank-you answer, and not the after-order bundle', async () => {
    h.createPublicOrder.mockResolvedValue({ ok: true, body: { orderNumber: 'JO-2026-0007', total: 20, addonToken: 'tok', postOrderOffer: { id: 'flagged' } } });
    const body = await (await postOrder(orderReq({ ...ORDER, offerId: 'o1' }))).json();
    expect(body.postOrderOffer.id).toBe('o3');
    expect(body.postOrderWindowMinutes).toBe(15);
  });

  it('offers nothing to an order already on the largest offer', async () => {
    h.db.order.findFirst.mockResolvedValue(stored({ quantity: 6, totalAmount: 70 }));
    const body = await (await postOrder(orderReq({ ...ORDER, offerId: 'o6' }))).json();
    expect(body.postOrderOffer).toBeNull();
  });

  it('rewrites the same line, by the door’s own figures, and writes no add-on', async () => {
    const res = await postAddOn(addReq(), ctx());
    expect(res.status).toBe(201);
    expect(h.db.orderItem.update).toHaveBeenCalledTimes(1);
    const line = h.db.orderItem.update.mock.calls[0][0];
    expect(line.where).toEqual({ id: 'line1' });
    expect(line.data).toEqual({ quantity: 3, freeQuantity: 0, unitPrice: 50 / 3, discountShare: 10, lineTotal: 40 });
    const head = h.db.order.update.mock.calls[1][0].data;
    expect(head).toMatchObject({ offerId: 'o3', quantity: 3, sellingPrice: 40, totalAmount: 40, priceIncludesDelivery: true, estimatedCostOfGoods: 12 });
    expect(JSON.parse(h.db.orderActivity.create.mock.calls[0][0].data.metadata)).toMatchObject({ from: { offerId: 'o1', total: 20 }, to: { offerId: 'o3', total: 40 } });
    expect(await res.json()).toMatchObject({ total: 40, added: 20, currency: 'JOD', cod: 40, deliveryIncluded: true, offer: { name: '3 عبوات' } });
  });

  it('keeps an add-on already on the order inside the total', async () => {
    h.db.orderAddOn.findMany.mockResolvedValue([{ quantity: 1, price: 5 }]);
    await postAddOn(addReq(), ctx());
    expect(h.db.order.update.mock.calls[1][0].data.totalAmount).toBe(45);
  });

  it('refuses any offer but the one the server would choose', async () => {
    const res = await postAddOn(addReq('o6'), ctx());
    expect(res.status).toBe(404);
    expect(h.db.orderItem.update).not.toHaveBeenCalled();
  });

  it.each([
    ['confirmed', { confirmationStatus: 'CONFIRMED' }, 'NOT_NEW'],
    ['already called', { _count: { contactAttempts: 1 } }, 'CONTACTED'],
    ['past the window', { createdAt: new Date(NOW.getTime() - 86_400_000 * 900) }, 'WINDOW_PASSED'],
    ['edited by a person', { items: [{ id: 'l', productId: 'p1', quantity: 1, freeQuantity: 0, reservedQty: 0, deliveredQty: null }, { id: 'm', productId: 'p2', quantity: 1, freeQuantity: 0, reservedQty: 0, deliveredQty: null }] }, 'NOT_NEW'],
    ['fee already written', { deliveryFee: 3 }, 'NOT_NEW'],
  ])('leaves an order alone when it is %s', async (_n, over, reason) => {
    h.db.order.findFirst.mockResolvedValue(stored(over));
    const res = await postAddOn(addReq(), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe(reason);
    expect(h.db.orderItem.update).not.toHaveBeenCalled();
  });

  it('swaps once', async () => {
    h.db.orderActivity.count.mockResolvedValue(1);
    const res = await postAddOn(addReq(), ctx());
    expect((await res.json()).reason).toBe('ALREADY_ADDED');
    expect(h.db.orderItem.update).not.toHaveBeenCalled();
  });

  it('two presses at once: the one that waited on the lock changes nothing', async () => {
    h.db.order.findFirst.mockResolvedValueOnce(stored()).mockResolvedValueOnce(stored({ offerId: 'o3' }));
    const res = await postAddOn(addReq(), ctx());
    expect(res.status).toBe(409);
    expect(h.db.orderItem.update).not.toHaveBeenCalled();
  });

  it('refuses a token for another order, and an order of another company', async () => {
    h.verifyAddonToken.mockResolvedValue({ orderId: 'ord1', orderNumber: 'JO-2026-0001' });
    expect((await postAddOn(addReq(), ctx())).status).toBe(401);
    h.verifyAddonToken.mockResolvedValue({ orderId: 'ord1', orderNumber: 'JO-2026-0007' });
    h.db.order.findFirst.mockResolvedValue(null);
    expect((await postAddOn(addReq(), ctx())).status).toBe(404);
    expect(h.db.orderItem.update).not.toHaveBeenCalled();
  });
});
