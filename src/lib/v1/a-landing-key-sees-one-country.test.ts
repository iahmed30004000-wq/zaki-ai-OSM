import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — ONE COUNTRY PER LANDING KEY (2026-11-21, Zaki Pages per country)
 *
 *  1. A key with no country (every key made before) behaves exactly as before on every landing route: no country is
 *     asked, no query is narrowed, the idempotency key is stored as sent.
 *  2. A key bound to one country, on every landing route, sees and writes only that country:
 *     products listed / read / quoted / ordered, geo, an order by number (read + six writes), carts (+ recovered), chat
 *     relay and chat updates. Another country answers EXACTLY as «there is no such thing» does at that route.
 *  3. A country-bound key at any door that is not the landing door is refused (403 SCOPE_MISSING, `country_bound`),
 *     never widened to the whole company.
 *  4. «توكنات الأنظمة» offers «البلد» (every country, or one active country of this company), stores it, and lists it.
 * ═══════════════════════════════════════════════════════════════════════
 */

const h = vi.hoisted(() => ({
  anyBody: { safeParse: (v: unknown) => ({ success: true, data: v }) },
  db: {
    product: { findMany: vi.fn(), findFirst: vi.fn() },
    order: { findFirst: vi.fn(), updateMany: vi.fn() },
    country: { findFirst: vi.fn(), findMany: vi.fn() },
    region: { findMany: vi.fn() },
    deliveryFee: { findMany: vi.fn() },
    store: { findFirst: vi.fn() },
    orderChannel: { findFirst: vi.fn() },
    company: { findUnique: vi.fn() },
    abandonedCart: { findUnique: vi.fn() },
    abandonedCartAlias: { findUnique: vi.fn() },
    landingChatThread: { findUnique: vi.fn() },
    landingChatMessage: { findMany: vi.fn() },
    systemToken: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn(), create: vi.fn() },
  },
  requireSystemToken: vi.fn(),
  claimIdempotency: vi.fn(),
  rememberIdempotency: vi.fn(),
  releaseIdempotency: vi.fn(),
  activeOffersFor: vi.fn(),
  activeOffersForProducts: vi.fn(),
  availableStock: vi.fn(),
  createPublicOrder: vi.fn(),
  resolveCampaign: vi.fn(),
  chat: {
    readChatOrder: vi.fn(),
    confirmFromChat: vi.fn(),
    cancelFromChat: vi.fn(),
    changeAddressFromChat: vi.fn(),
    changeOfferFromChat: vi.fn(),
    followUpFromChat: vi.fn(),
  },
  swapLandingOffer: vi.fn(),
  upsertLandingCart: vi.fn(),
  recoverLandingCart: vi.fn(),
  relayChatLines: vi.fn(),
  requireCompanyTenant: vi.fn(),
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db: h.db }));
vi.mock('@/lib/v1/system-token', async () => {
  const real = await vi.importActual<typeof import('./system-token')>('./system-token');
  return { ...real, requireSystemToken: (...a: unknown[]) => h.requireSystemToken(...a) };
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
  const real = await vi.importActual<typeof import('../public-order')>('../public-order');
  return { ...real, createPublicOrder: (...a: unknown[]) => h.createPublicOrder(...a) };
});
vi.mock('@/lib/campaigns-server', () => ({ resolveCampaign: (...a: unknown[]) => h.resolveCampaign(...a) }));
vi.mock('@/lib/v1/landing-chat', () => ({
  chatTokenSchema: h.anyBody,
  chatCancelSchema: h.anyBody,
  chatAddressSchema: h.anyBody,
  chatOfferSchema: h.anyBody,
  chatFollowUpSchema: h.anyBody,
  readChatOrder: (...a: unknown[]) => h.chat.readChatOrder(...a),
  confirmFromChat: (...a: unknown[]) => h.chat.confirmFromChat(...a),
  cancelFromChat: (...a: unknown[]) => h.chat.cancelFromChat(...a),
  changeAddressFromChat: (...a: unknown[]) => h.chat.changeAddressFromChat(...a),
  changeOfferFromChat: (...a: unknown[]) => h.chat.changeOfferFromChat(...a),
  followUpFromChat: (...a: unknown[]) => h.chat.followUpFromChat(...a),
}));
vi.mock('@/lib/v1/landing-door', async () => {
  const real = await vi.importActual<typeof import('./landing-door')>('./landing-door');
  return { ...real, landingAddOnSchema: h.anyBody, swapLandingOffer: (...a: unknown[]) => h.swapLandingOffer(...a) };
});
vi.mock('@/lib/v1/landing-carts', async () => {
  const real = await vi.importActual<typeof import('./landing-carts')>('./landing-carts');
  return {
    ...real,
    upsertLandingCart: (...a: unknown[]) => h.upsertLandingCart(...a),
    recoverLandingCart: (...a: unknown[]) => h.recoverLandingCart(...a),
  };
});
vi.mock('@/lib/v1/landing-chat-inbox', async () => {
  const real = await vi.importActual<typeof import('./landing-chat-inbox')>('./landing-chat-inbox');
  return { ...real, relayChatLines: (...a: unknown[]) => h.relayChatLines(...a) };
});
vi.mock('@/lib/auth', () => ({ requireCompanyTenant: () => h.requireCompanyTenant() }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: (p: string) => h.requirePermission(p),
  getPermissionScope: () => ({ scope: 'ALL_COMPANY' }),
  can: () => true,
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => h.logAudit(...a) }));

import { GET as listProducts } from '@/app/api/v1/landing/products/route';
import { GET as readProduct } from '@/app/api/v1/landing/products/[id]/route';
import { GET as quote } from '@/app/api/v1/landing/quote/route';
import { POST as placeOrder } from '@/app/api/v1/landing/orders/route';
import { GET as geo } from '@/app/api/v1/landing/geo/[country]/route';
import { GET as health } from '@/app/api/v1/landing/health/route';
import { GET as readOrder } from '@/app/api/v1/landing/orders/[orderNumber]/route';
import { POST as confirmOrder } from '@/app/api/v1/landing/orders/[orderNumber]/confirm/route';
import { POST as cancelOrder } from '@/app/api/v1/landing/orders/[orderNumber]/cancel/route';
import { POST as changeAddress } from '@/app/api/v1/landing/orders/[orderNumber]/address/route';
import { POST as changeOffer } from '@/app/api/v1/landing/orders/[orderNumber]/offer/route';
import { POST as followUp } from '@/app/api/v1/landing/orders/[orderNumber]/follow-up/route';
import { POST as postOrderOffer } from '@/app/api/v1/landing/orders/[orderNumber]/post-order-offer/route';
import { POST as postCart } from '@/app/api/v1/landing/abandoned-carts/route';
import { POST as recovered } from '@/app/api/v1/landing/abandoned-carts/[externalId]/recovered/route';
import { POST as relay } from '@/app/api/v1/landing/chat/messages/route';
import { GET as updates } from '@/app/api/v1/landing/chat/updates/route';
import { GET as tokensGet, POST as tokensPost } from '@/app/api/settings/system-tokens/route';
import { CART_OTHER_COUNTRY_AR, LANDING_DOOR, idempotencySlot, productsInCountry } from './landing-country';
import { LANDING_SCOPES } from './system-token';

// ── the company: two countries, a product in Jordan ──
const COUNTRIES: Record<string, string> = { jo: 'JO', sy: 'SY' };
const STORE = { id: 's1', name: 'متجر', status: 'ACTIVE', countryId: 'jo', theme: null, country: { code: 'JO', currencyCode: 'JOD', orderPrefix: 'JO', minorUnit: 3 } };
const PRODUCT = { id: 'p1', sku: 'A', name: 'عسل', description: null, image: null, basePrice: 15, status: 'ACTIVE', storeId: 's1', variantOptions: null, store: STORE };
const OFFER = { id: 'o1', name: 'عبوتان', quantity: 2, freeQuantity: 0, price: 22, listPrice: 25, compareAtPrice: null, isDefault: true, deliveryIncluded: false, endsAt: null };
const ORDER_NO = 'JO-2026-0007';

const ALL = { tokenId: 't0', companyId: 'c1', system: 'landing', scopes: LANDING_SCOPES, countryId: null };
const JO = { ...ALL, tokenId: 't1', countryId: 'jo' };
const SY = { ...ALL, tokenId: 't2', countryId: 'sy' };
const as = (caller: object) => h.requireSystemToken.mockResolvedValue(caller);

type Where = { id?: string; code?: string; AND?: { store: { countryId: string } }[] };
/** The product query, as Postgres would answer it: narrowed by the country when the door asked for one. */
const productAnswer = ({ where }: { where: Where }) => {
  const country = where.AND?.[0]?.store.countryId;
  return Promise.resolve(where.id === 'p1' && (!country || country === STORE.countryId) ? PRODUCT : null);
};

const url = (path: string) => `https://oms.test/api/v1/landing${path}`;
const get = (path: string) => new Request(url(path));
const post = (path: string, body: unknown, key = 'k1') =>
  new Request(url(path), { method: 'POST', headers: { 'idempotency-key': key }, body: JSON.stringify(body) });
const orderCtx = { params: Promise.resolve({ orderNumber: ORDER_NO }) };
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; message: string } }).error;

beforeEach(() => {
  vi.clearAllMocks();
  as(ALL);
  h.db.product.findMany.mockResolvedValue([]);
  h.db.product.findFirst.mockImplementation(productAnswer);
  h.db.country.findFirst.mockImplementation(({ where }: { where: { id?: string; code?: string } }) => {
    if (where.id) return Promise.resolve(COUNTRIES[where.id] ? { code: COUNTRIES[where.id] } : null);
    const id = Object.keys(COUNTRIES).find((k) => COUNTRIES[k] === where.code);
    return Promise.resolve(id ? { id, code: where.code } : null);
  });
  h.db.country.findMany.mockResolvedValue([{ id: 'jo', code: 'JO', name: 'الأردن' }]);
  h.db.region.findMany.mockResolvedValue([{ id: 'amm', name: 'عمّان' }]);
  h.db.deliveryFee.findMany.mockResolvedValue([{ fee: 2.5 }]);
  h.db.store.findFirst.mockResolvedValue({ priceIncludesDelivery: false });
  h.db.orderChannel.findFirst.mockResolvedValue({ id: 'ch1' });
  h.db.order.updateMany.mockResolvedValue({ count: 1 });
  h.db.order.findFirst.mockResolvedValue({ countryId: 'jo', store: { countryId: 'jo' } });
  h.db.company.findUnique.mockResolvedValue({ settings: null });
  h.db.abandonedCart.findUnique.mockResolvedValue(null);
  h.db.abandonedCartAlias.findUnique.mockResolvedValue(null);
  h.db.landingChatThread.findUnique.mockResolvedValue(null);
  h.db.landingChatMessage.findMany.mockResolvedValue([]);
  h.activeOffersFor.mockResolvedValue([OFFER]);
  h.activeOffersForProducts.mockResolvedValue(new Map());
  h.availableStock.mockResolvedValue(100);
  h.claimIdempotency.mockResolvedValue(null);
  h.resolveCampaign.mockResolvedValue(null);
  h.createPublicOrder.mockResolvedValue({ ok: true, body: { success: true, orderNumber: ORDER_NO, total: 22, currency: 'JOD', addonToken: 'tok' } });
  for (const fn of Object.values(h.chat)) fn.mockResolvedValue({ ok: true, body: { done: true } });
  h.swapLandingOffer.mockResolvedValue({ ok: true, body: { done: true } });
  h.upsertLandingCart.mockResolvedValue({ status: 201, body: { id: 'cart1', status: 'NEW' } });
  h.recoverLandingCart.mockResolvedValue({ id: 'cart1', status: 'RECOVERED' });
  h.relayChatLines.mockResolvedValue({ status: 201, body: { threadId: 'th1', botPaused: false, written: 1 } });
});

describe('every landing route asks for its caller as a country-aware door', () => {
  it('passes LANDING_DOOR to requireSystemToken on all of them', async () => {
    await listProducts(get('/products'));
    await readProduct(get('/products/p1'), { params: Promise.resolve({ id: 'p1' }) });
    await quote(get('/quote?productId=p9'));
    await geo(get('/geo/jo'), { params: Promise.resolve({ country: 'jo' }) });
    await health(get('/health'));
    await readOrder(get(`/orders/${ORDER_NO}?token=x`), orderCtx);
    await updates(get('/chat/updates'));
    expect(h.requireSystemToken.mock.calls.every((c) => c[2] === LANDING_DOOR)).toBe(true);
    expect(LANDING_DOOR).toEqual({ countryAware: true });
  });
});

describe('1 · a key for every country: exactly as before', () => {
  it('lists every product with no country in the query', async () => {
    await listProducts(get('/products'));
    expect(h.db.product.findMany.mock.calls[0][0].where).not.toHaveProperty('AND');
    expect(productsInCountry(null)).toEqual({});
  });

  it('asks nothing about an order’s country, and hands the per-order write on', async () => {
    const res = await confirmOrder(post(`/orders/${ORDER_NO}/confirm`, { token: 'x' }), orderCtx);
    expect(res.status).toBe(200);
    expect(h.db.order.findFirst).not.toHaveBeenCalled();
    expect(h.chat.confirmFromChat).toHaveBeenCalledWith('c1', ORDER_NO, { token: 'x' });
  });

  it('keeps the idempotency key as sent', async () => {
    await confirmOrder(post(`/orders/${ORDER_NO}/confirm`, { token: 'x' }), orderCtx);
    expect(h.claimIdempotency.mock.calls[0][1]).toBe('k1');
    expect(idempotencySlot(ALL, 'k1')).toBe('k1');
  });

  it('reads the cities of any country of the company', async () => {
    const res = await geo(get('/geo/sy'), { params: Promise.resolve({ country: 'sy' }) });
    expect(res.status).toBe(200);
  });

  it('hands a cart, a relay and the updates on untouched', async () => {
    await postCart(post('/abandoned-carts', { externalId: 'e1', phone: '0790000001', country: 'SY', productId: 'p1' }));
    expect(h.upsertLandingCart.mock.calls[0][1]).toMatchObject({ country: 'SY', productId: 'p1' });
    await relay(post('/chat/messages', { sessionId: 'session-001', orderNumber: ORDER_NO }));
    expect(h.relayChatLines.mock.calls[0][1]).toMatchObject({ orderNumber: ORDER_NO });
    expect(h.relayChatLines.mock.calls[0][3]).toBeNull();
    await updates(get('/chat/updates'));
    expect(h.db.landingChatMessage.findMany.mock.calls[0][0].where).not.toHaveProperty('thread');
    expect(h.db.abandonedCart.findUnique).not.toHaveBeenCalled();
    expect(h.db.landingChatThread.findUnique).not.toHaveBeenCalled();
  });
});

describe('2 · a key bound to Jordan, on its own country', () => {
  beforeEach(() => as(JO));

  it('lists only Jordan’s stores', async () => {
    await listProducts(get('/products'));
    expect(h.db.product.findMany.mock.calls[0][0].where).toMatchObject({ AND: [{ store: { countryId: 'jo' } }] });
  });

  it('reads its own product', async () => {
    const res = await readProduct(get('/products/p1'), { params: Promise.resolve({ id: 'p1' }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { country: string }).country).toBe('JO');
  });

  it('places an order for its own product', async () => {
    const res = await placeOrder(post('/orders', { productId: 'p1', offerId: 'o1', landingPageId: 'lp-1', full_name: 'زبون', phone: '0790000001', address: 'شارع', city: 'عمّان' }));
    expect(res.status).toBe(201);
    expect(h.createPublicOrder).toHaveBeenCalledTimes(1);
  });

  it('reaches its own country’s order on every per-order route', async () => {
    for (const [route, body] of [
      [confirmOrder, { token: 'x' }],
      [cancelOrder, { token: 'x' }],
      [changeAddress, { token: 'x' }],
      [changeOffer, { token: 'x' }],
      [followUp, { token: 'x' }],
      [postOrderOffer, { token: 'x' }],
    ] as const) {
      const res = await route(post(`/orders/${ORDER_NO}/x`, body), orderCtx);
      expect(res.status).toBeLessThan(300);
    }
    expect((await readOrder(get(`/orders/${ORDER_NO}?token=x`), orderCtx)).status).toBe(200);
  });

  it('reads Jordan’s cities', async () => {
    expect((await geo(get('/geo/jo'), { params: Promise.resolve({ country: 'jo' }) })).status).toBe(200);
  });

  it('keeps its idempotency keys apart from another country’s', async () => {
    await confirmOrder(post(`/orders/${ORDER_NO}/confirm`, { token: 'x' }), orderCtx);
    expect(h.claimIdempotency.mock.calls[0][1]).toBe('jo:k1');
    expect(h.rememberIdempotency.mock.calls[0][1]).toBe('jo:k1');
  });

  it('writes its carts with its own country', async () => {
    await postCart(post('/abandoned-carts', { externalId: 'e1', phone: '0790000001', productId: 'p1' }));
    expect(h.upsertLandingCart.mock.calls[0][1]).toMatchObject({ country: 'JO', productId: 'p1' });
  });

  it('opens its chat threads in its own country, and reads only their updates', async () => {
    await relay(post('/chat/messages', { sessionId: 'session-001', orderNumber: ORDER_NO }));
    expect(h.relayChatLines.mock.calls[0][3]).toBe('jo');
    expect(h.relayChatLines.mock.calls[0][1]).toMatchObject({ orderNumber: ORDER_NO });
    await updates(get('/chat/updates'));
    expect(h.db.landingChatMessage.findMany.mock.calls[0][0].where).toMatchObject({ thread: { countryId: 'jo' } });
  });
});

describe('2 · a key bound to Syria, on Jordan’s things: answered as if they did not exist', () => {
  beforeEach(() => as(SY));

  it('does not list Jordan’s products', async () => {
    await listProducts(get('/products'));
    expect(h.db.product.findMany.mock.calls[0][0].where).toMatchObject({ AND: [{ store: { countryId: 'sy' } }] });
  });

  it('reads Jordan’s product as an unknown one: 404 «No such product»', async () => {
    const res = await readProduct(get('/products/p1'), { params: Promise.resolve({ id: 'p1' }) });
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toMatchObject({ code: 'NOT_FOUND', message: 'No such product' });
  });

  it('quotes Jordan’s product as one no longer sold: the same 409 Arabic sentence', async () => {
    const res = await quote(get('/quote?productId=p1&offerId=o1&city=عمّان'));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'هذا العرض لم يعد متاحًا' });
  });

  it('does not place an order for Jordan’s product, writes nothing and gives the key back', async () => {
    const res = await placeOrder(post('/orders', { productId: 'p1', offerId: 'o1', landingPageId: 'lp-1', full_name: 'زبون', phone: '0790000001', address: 'شارع', city: 'عمّان' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'هذا العرض لم يعد متاحًا' });
    expect(h.createPublicOrder).not.toHaveBeenCalled();
    expect(h.releaseIdempotency).toHaveBeenCalledWith('c1', 'sy:k1');
  });

  it.each([
    ['read', () => readOrder(get(`/orders/${ORDER_NO}?token=x`), orderCtx), h.chat.readChatOrder],
    ['confirm', () => confirmOrder(post(`/orders/${ORDER_NO}/confirm`, { token: 'x' }), orderCtx), h.chat.confirmFromChat],
    ['cancel', () => cancelOrder(post(`/orders/${ORDER_NO}/cancel`, { token: 'x' }), orderCtx), h.chat.cancelFromChat],
    ['address', () => changeAddress(post(`/orders/${ORDER_NO}/address`, { token: 'x' }), orderCtx), h.chat.changeAddressFromChat],
    ['offer', () => changeOffer(post(`/orders/${ORDER_NO}/offer`, { token: 'x' }), orderCtx), h.chat.changeOfferFromChat],
    ['follow-up', () => followUp(post(`/orders/${ORDER_NO}/follow-up`, { token: 'x' }), orderCtx), h.chat.followUpFromChat],
    ['post-order-offer', () => postOrderOffer(post(`/orders/${ORDER_NO}/post-order-offer`, { token: 'x' }), orderCtx), h.swapLandingOffer],
  ])('%s on Jordan’s order: 404 «No such order», nothing done, no key held', async (_name, call, handler) => {
    const res = await call();
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toMatchObject({ code: 'NOT_FOUND', message: 'No such order' });
    expect(handler).not.toHaveBeenCalled();
    expect(h.claimIdempotency).not.toHaveBeenCalled();
  });

  it('an order of its own country stamped only on the store still counts as its own', async () => {
    h.db.order.findFirst.mockResolvedValue({ countryId: null, store: { countryId: 'sy' } });
    expect((await readOrder(get(`/orders/${ORDER_NO}?token=x`), orderCtx)).status).toBe(200);
  });

  it('an unknown order number is left to the route’s own answer', async () => {
    h.db.order.findFirst.mockResolvedValue(null);
    await readOrder(get(`/orders/${ORDER_NO}?token=x`), orderCtx);
    expect(h.chat.readChatOrder).toHaveBeenCalledTimes(1);
  });

  it('asks for Jordan’s cities as an unknown code: 404 «No such country»', async () => {
    const res = await geo(get('/geo/jo'), { params: Promise.resolve({ country: 'jo' }) });
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toMatchObject({ code: 'NOT_FOUND', message: 'No such country' });
  });

  it('a cart naming Jordan is refused with the cart’s own 400 sentence, nothing written', async () => {
    const res = await postCart(post('/abandoned-carts', { externalId: 'e1', phone: '0790000001', country: 'jo' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: CART_OTHER_COUNTRY_AR });
    expect(h.upsertLandingCart).not.toHaveBeenCalled();
  });

  it('a cart for Jordan’s product is kept in Syria, the product not linked', async () => {
    await postCart(post('/abandoned-carts', { externalId: 'e1', phone: '0990000001', productId: 'p1', productName: 'عسل' }));
    expect(h.upsertLandingCart.mock.calls[0][1]).toMatchObject({ country: 'SY', productId: null, productName: 'عسل' });
  });

  it('Jordan’s cart, by its id or an alias, is 404 «No such abandoned cart» — to send and to recover', async () => {
    h.db.abandonedCart.findUnique.mockResolvedValue({ country: 'JO' });
    const sent = await postCart(post('/abandoned-carts', { externalId: 'e1', phone: '0990000001' }));
    expect(sent.status).toBe(404);
    expect(await errorOf(sent)).toMatchObject({ code: 'NOT_FOUND', message: 'No such abandoned cart' });
    h.db.abandonedCart.findUnique.mockResolvedValue(null);
    h.db.abandonedCartAlias.findUnique.mockResolvedValue({ cart: { country: 'JO' } });
    const back = await recovered(post('/abandoned-carts/e1/recovered', {}), { params: Promise.resolve({ externalId: 'e1' }) });
    expect(back.status).toBe(404);
    expect(h.upsertLandingCart).not.toHaveBeenCalled();
    expect(h.recoverLandingCart).not.toHaveBeenCalled();
  });

  it('its own cart recovered by Jordan’s order: recovered, the order not linked', async () => {
    h.db.abandonedCart.findUnique.mockResolvedValue({ country: 'SY' });
    const res = await recovered(post('/abandoned-carts/e1/recovered', { orderNumber: ORDER_NO }), { params: Promise.resolve({ externalId: 'e1' }) });
    expect(res.status).toBe(200);
    expect(h.recoverLandingCart).toHaveBeenCalledWith('c1', 'e1', null);
  });

  it('Jordan’s chat thread is 404; a new thread naming Jordan’s order or product links neither', async () => {
    h.db.landingChatThread.findUnique.mockResolvedValue({ countryId: 'jo' });
    const res = await relay(post('/chat/messages', { sessionId: 'session-001' }));
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toMatchObject({ code: 'NOT_FOUND', message: 'No such chat thread' });
    expect(h.relayChatLines).not.toHaveBeenCalled();

    h.db.landingChatThread.findUnique.mockResolvedValue(null);
    await relay(post('/chat/messages', { sessionId: 'session-002', orderNumber: ORDER_NO, productId: 'p1', productName: 'عسل' }, 'k2'));
    expect(h.relayChatLines.mock.calls[0][1]).toMatchObject({ orderNumber: null, productId: null, productName: 'عسل' });
    expect(h.relayChatLines.mock.calls[0][3]).toBe('sy');
  });

  it('a thread opened by a key of every country is not a bound key’s either', async () => {
    h.db.landingChatThread.findUnique.mockResolvedValue({ countryId: null });
    expect((await relay(post('/chat/messages', { sessionId: 'session-001' }))).status).toBe(404);
  });

  it('reads only Syria’s chat updates', async () => {
    await updates(get('/chat/updates?after=5'));
    expect(h.db.landingChatMessage.findMany.mock.calls[0][0].where).toMatchObject({ thread: { countryId: 'sy' } });
  });
});

describe('3 · the guard itself (`requireSystemToken`, the real one)', () => {
  const real = async () => (await vi.importActual<typeof import('./system-token')>('./system-token')).requireSystemToken;
  const req = () => new Request('https://oms.test/api/v1/x', { headers: { authorization: 'Bearer zk1_abc' } });
  const row = (countryId: string | null) => ({
    id: `row-${countryId}`,
    companyId: 'c1',
    system: 'landing',
    scopes: JSON.stringify(['products.read', 'orders.create']),
    rateLimitPerMin: 600,
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: new Date(),
    countryId,
  });

  it('a key for every country is accepted everywhere, with no country', async () => {
    h.db.systemToken.findUnique.mockResolvedValue(row(null));
    const guard = await real();
    expect((await guard(req(), 'products.read')).countryId).toBeNull();
    expect((await guard(req(), 'products.read', LANDING_DOOR)).countryId).toBeNull();
  });

  it('a country-bound key is handed its country at the landing door', async () => {
    h.db.systemToken.findUnique.mockResolvedValue(row('jo'));
    const guard = await real();
    expect((await guard(req(), 'orders.create', LANDING_DOOR)).countryId).toBe('jo');
  });

  it('and is refused at any other door, never widened to the company', async () => {
    h.db.systemToken.findUnique.mockResolvedValue(row('jo'));
    const guard = await real();
    await expect(guard(req(), 'products.read')).rejects.toMatchObject({
      status: 403,
      code: 'SCOPE_MISSING',
      details: { required: 'products.read', country_bound: true },
    });
  });
});

describe('4 · «توكنات الأنظمة»: the country of a key', () => {
  const JO_ID = '11111111-2222-4333-8444-555555555555';
  const OTHER_ID = '99999999-2222-4333-8444-555555555555';
  const create = (body: object) => tokensPost(new Request('https://oms.test/api/settings/system-tokens', { method: 'POST', body: JSON.stringify(body) }));

  beforeEach(() => {
    h.requireCompanyTenant.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1' });
    h.requirePermission.mockResolvedValue({ id: 'u1' });
    h.db.country.findMany.mockResolvedValue([{ id: JO_ID, code: 'JO', name: 'الأردن' }]);
    h.db.systemToken.findMany.mockResolvedValue([
      { id: 'a', name: 'صفحات ذكي', system: 'landing', prefix: 'zk1_a', scopes: '[]', rateLimitPerMin: 600, expiresAt: null, revokedAt: null, lastUsedAt: null, createdAt: new Date(), country: null },
      { id: 'b', name: 'صفحات ذكي · الأردن', system: 'landing', prefix: 'zk1_b', scopes: '[]', rateLimitPerMin: 600, expiresAt: null, revokedAt: null, lastUsedAt: null, createdAt: new Date(), country: { id: JO_ID, code: 'JO', name: 'الأردن' } },
    ]);
    h.db.systemToken.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'tok_1', createdAt: new Date(), ...data })
    );
  });

  it('offers the company’s active countries and lists each key’s country', async () => {
    const body = (await (await tokensGet()).json()) as { countries: unknown[]; tokens: { country: unknown }[] };
    expect(h.db.country.findMany.mock.calls[0][0].where).toEqual({ companyId: 'c1', isActive: true });
    expect(body.countries).toEqual([{ id: JO_ID, code: 'JO', name: 'الأردن' }]);
    expect(body.tokens.map((t) => t.country)).toEqual([null, { id: JO_ID, code: 'JO', name: 'الأردن' }]);
  });

  it('a key with no country is every country, as before', async () => {
    const res = await create({ name: 'صفحات ذكي', system: 'landing', scopes: LANDING_SCOPES });
    expect(res.status).toBe(201);
    expect(h.db.systemToken.create.mock.calls[0][0].data.countryId).toBeNull();
  });

  it('stores the one country chosen, and says so in the audit', async () => {
    const res = await create({ name: 'صفحات ذكي · الأردن', system: 'landing', scopes: LANDING_SCOPES, countryId: JO_ID });
    expect(res.status).toBe(201);
    expect(h.db.systemToken.create.mock.calls[0][0].data.countryId).toBe(JO_ID);
    expect(h.logAudit.mock.calls[0][0].newData.country).toBe('JO');
  });

  it('refuses a country that is not one of this company’s active ones — never a key for every country instead', async () => {
    const res = await create({ name: 'صفحات ذكي · ؟', system: 'landing', scopes: LANDING_SCOPES, countryId: OTHER_ID });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('COUNTRY_UNKNOWN');
    expect(h.db.systemToken.create).not.toHaveBeenCalled();
  });
});
