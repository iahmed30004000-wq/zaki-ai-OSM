import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — ONE STORE PER LANDING KEY (2026-11-23, Zaki Pages per store)
 *
 *  1. A key not bound to a store (every key made before) behaves exactly as before: nothing is narrowed by store and
 *     the idempotency key is stored as it was.
 *  2. A key bound to one store sees and writes only that store on the landing door: products (each naming its
 *     `storeId`), quotes, orders, an order by number, carts and chat. It is bound to that store's country too.
 *  3. Another store of the SAME country answers exactly as «there is no such thing» does at that route.
 *  4. A store-bound key at any other door is refused, never widened.
 *  5. «توكنات الأنظمة» offers «المتجر» (the stores of the country chosen), stores it with its country, and lists it.
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
    store: { findFirst: vi.fn(), findMany: vi.fn() },
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
import { GET as readOrder } from '@/app/api/v1/landing/orders/[orderNumber]/route';
import { POST as confirmOrder } from '@/app/api/v1/landing/orders/[orderNumber]/confirm/route';
import { POST as cancelOrder } from '@/app/api/v1/landing/orders/[orderNumber]/cancel/route';
import { POST as recovered } from '@/app/api/v1/landing/abandoned-carts/[externalId]/recovered/route';
import { POST as relay } from '@/app/api/v1/landing/chat/messages/route';
import { GET as updates } from '@/app/api/v1/landing/chat/updates/route';
import { GET as tokensGet, POST as tokensPost } from '@/app/api/settings/system-tokens/route';
import { LANDING_DOOR, idempotencySlot, productsInCountry, scopeOf } from './landing-country';
import { LANDING_SCOPES } from './system-token';

// ── the company: Jordan with two stores, a product in each ──
const JO_STORE = { id: 's1', name: 'متجر العسل', status: 'ACTIVE', countryId: 'jo', theme: null, country: { code: 'JO', currencyCode: 'JOD', orderPrefix: 'JO', minorUnit: 3 } };
const PRODUCT = { id: 'p1', sku: 'A', name: 'عسل', description: null, image: null, basePrice: 15, status: 'ACTIVE', storeId: 's1', variantOptions: null, store: JO_STORE };
const OFFER = { id: 'o1', name: 'عبوتان', quantity: 2, freeQuantity: 0, price: 22, listPrice: 25, compareAtPrice: null, isDefault: true, deliveryIncluded: false, endsAt: null };
const ORDER_NO = 'JO-2026-0007';

const ALL = { tokenId: 't0', companyId: 'c1', system: 'landing', scopes: LANDING_SCOPES, countryId: null };
const JO = { ...ALL, tokenId: 't1', countryId: 'jo' };
/** Bound to the honey store of Jordan. */
const S1 = { ...ALL, tokenId: 't2', countryId: 'jo', storeId: 's1' };
/** Bound to the other store of Jordan. */
const S2 = { ...ALL, tokenId: 't3', countryId: 'jo', storeId: 's2' };
const as = (caller: object) => h.requireSystemToken.mockResolvedValue(caller);

type Where = { id?: string; AND?: { store: { countryId?: string; id?: string } }[] };
/** The product query, as Postgres would answer it: narrowed by the country and the store when the door asked. */
const productAnswer = ({ where }: { where: Where }) => {
  const f = where.AND?.[0]?.store ?? {};
  const fits = (!f.countryId || f.countryId === JO_STORE.countryId) && (!f.id || f.id === JO_STORE.id);
  return Promise.resolve((where.id === undefined || where.id === 'p1') && fits ? PRODUCT : null);
};

const url = (path: string) => `https://oms.test/api/v1/landing${path}`;
const get = (path: string) => new Request(url(path));
const post = (path: string, body: unknown, key = 'k1') =>
  new Request(url(path), { method: 'POST', headers: { 'idempotency-key': key }, body: JSON.stringify(body) });
const orderCtx = { params: Promise.resolve({ orderNumber: ORDER_NO }) };
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; message: string } }).error;
const ORDER_BODY = { productId: 'p1', offerId: 'o1', landingPageId: 'lp-1', full_name: 'زبون', phone: '0790000001', address: 'شارع', city: 'عمّان' };

beforeEach(() => {
  vi.clearAllMocks();
  as(ALL);
  h.db.product.findMany.mockImplementation(({ where }: { where: Where }) => productAnswer({ where }).then((p) => (p ? [p] : [])));
  h.db.product.findFirst.mockImplementation(productAnswer);
  h.db.country.findFirst.mockResolvedValue({ code: 'JO' });
  h.db.country.findMany.mockResolvedValue([{ id: 'jo', code: 'JO', name: 'الأردن' }]);
  h.db.region.findMany.mockResolvedValue([{ id: 'amm', name: 'عمّان' }]);
  h.db.deliveryFee.findMany.mockResolvedValue([{ fee: 2.5 }]);
  h.db.store.findFirst.mockResolvedValue({ priceIncludesDelivery: false });
  h.db.orderChannel.findFirst.mockResolvedValue({ id: 'ch1' });
  h.db.order.updateMany.mockResolvedValue({ count: 1 });
  h.db.order.findFirst.mockResolvedValue({ countryId: 'jo', storeId: 's1', store: { countryId: 'jo' } });
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
  h.upsertLandingCart.mockResolvedValue({ status: 201, body: { id: 'cart1', status: 'NEW' } });
  h.recoverLandingCart.mockResolvedValue({ id: 'cart1', status: 'RECOVERED' });
  h.relayChatLines.mockResolvedValue({ status: 201, body: { threadId: 'th1', botPaused: false, written: 1 } });
});

describe('1 · keys not bound to a store: exactly as before', () => {
  it('a key of every country and a key of one country narrow nothing by store', () => {
    expect(productsInCountry(scopeOf(ALL))).toEqual({});
    expect(productsInCountry(scopeOf(JO))).toEqual({ AND: [{ store: { countryId: 'jo' } }] });
    // A bare country id, as every caller passed before, reads the same.
    expect(productsInCountry('jo')).toEqual({ AND: [{ store: { countryId: 'jo' } }] });
    expect(productsInCountry(null)).toEqual({});
  });

  it('their idempotency keys are stored as before', () => {
    expect(idempotencySlot(ALL, 'k1')).toBe('k1');
    expect(idempotencySlot(JO, 'k1')).toBe('jo:k1');
  });
});

describe('2 · a key bound to one store, on its own store', () => {
  beforeEach(() => as(S1));

  it('lists its store’s products only, each naming its store', async () => {
    const res = await listProducts(get('/products'));
    expect(h.db.product.findMany.mock.calls[0][0].where.AND).toEqual([{ store: { countryId: 'jo', id: 's1' } }]);
    const body = (await res.json()) as { products: { id: string; storeId: string; currency: string }[] };
    expect(body.products.map((p) => [p.id, p.storeId, p.currency])).toEqual([['p1', 's1', 'JOD']]);
  });

  it('reads and quotes its own product', async () => {
    expect((await readProduct(get('/products/p1'), { params: Promise.resolve({ id: 'p1' }) })).status).toBe(200);
    expect((await quote(get('/quote?productId=p1&offerId=o1&city=%D8%B9%D9%85%D9%91%D8%A7%D9%86'))).status).toBe(200);
  });

  it('places an order for its own product', async () => {
    const res = await placeOrder(post('/orders', ORDER_BODY));
    expect(res.status).toBe(201);
  });

  it('reaches its own store’s order', async () => {
    expect((await confirmOrder(post(`/orders/${ORDER_NO}/confirm`, {}), orderCtx)).status).toBe(200);
  });

  it('keeps its idempotency keys apart from the other store’s and from the country key’s', () => {
    expect(idempotencySlot(S1, 'k1')).toBe('jo:s1:k1');
    expect(idempotencySlot(S2, 'k1')).toBe('jo:s2:k1');
    expect(new Set([idempotencySlot(S1, 'k1'), idempotencySlot(S2, 'k1'), idempotencySlot(JO, 'k1')]).size).toBe(3);
  });

  it('opens its chat threads in its store, and reads only its store’s updates', async () => {
    await relay(post('/chat/messages', { sessionId: 'session-001' }));
    expect(h.relayChatLines.mock.calls[0].slice(3)).toEqual(['jo', 's1']);
    await updates(get('/chat/updates'));
    expect(h.db.landingChatMessage.findMany.mock.calls[0][0].where.thread).toEqual({ countryId: 'jo', storeId: 's1' });
  });
});

describe('3 · a key bound to the other store of the same country: the honey store answered as if it did not exist', () => {
  beforeEach(() => as(S2));

  it('does not list the honey store’s products', async () => {
    const body = (await (await listProducts(get('/products'))).json()) as { products: unknown[] };
    expect(body.products).toEqual([]);
  });

  it('reads its product as an unknown one: 404', async () => {
    const res = await readProduct(get('/products/p1'), { params: Promise.resolve({ id: 'p1' }) });
    expect(res.status).toBe(404);
  });

  it('does not place an order for it, writes nothing and gives the key back', async () => {
    const res = await placeOrder(post('/orders', ORDER_BODY));
    expect(res.status).toBe(409);
    expect(h.createPublicOrder).not.toHaveBeenCalled();
    expect(h.releaseIdempotency).toHaveBeenCalled();
  });

  it('reaches none of the honey store’s orders: 404 «No such order», as an unknown number', async () => {
    for (const res of [
      await readOrder(get(`/orders/${ORDER_NO}?token=x`), orderCtx),
      await confirmOrder(post(`/orders/${ORDER_NO}/confirm`, {}), orderCtx),
      await cancelOrder(post(`/orders/${ORDER_NO}/cancel`, {}), orderCtx),
    ]) {
      expect(res.status).toBe(404);
      expect((await errorOf(res)).message).toBe('No such order');
    }
    expect(h.chat.confirmFromChat).not.toHaveBeenCalled();
    expect(h.chat.cancelFromChat).not.toHaveBeenCalled();
  });

  it('the honey store’s cart (by its product) is 404 «No such abandoned cart»', async () => {
    h.db.abandonedCart.findUnique.mockResolvedValue({ country: 'JO', product: { storeId: 's1' } });
    const res = await recovered(post('/abandoned-carts/lead1/recovered', { orderNumber: null }), { params: Promise.resolve({ externalId: 'lead1' }) });
    expect(res.status).toBe(404);
    expect(h.recoverLandingCart).not.toHaveBeenCalled();
  });

  it('a chat thread of the country key or the honey store is 404', async () => {
    for (const storeId of [null, 's1']) {
      h.db.landingChatThread.findUnique.mockResolvedValue({ countryId: 'jo', storeId });
      const res = await relay(post('/chat/messages', { sessionId: 'session-001' }));
      expect(res.status).toBe(404);
    }
    expect(h.relayChatLines).not.toHaveBeenCalled();
  });
});

describe('4 · the guard (`requireSystemToken`, the real one)', () => {
  const real = async () => (await vi.importActual<typeof import('./system-token')>('./system-token')).requireSystemToken;
  const req = () => new Request('https://oms.test/api/v1/x', { headers: { authorization: 'Bearer zk1_abc' } });
  const row = (countryId: string | null, storeId: string | null) => ({
    id: `row-${storeId}`, companyId: 'c1', system: 'landing', scopes: JSON.stringify(['products.read', 'orders.create']),
    rateLimitPerMin: 600, expiresAt: null, revokedAt: null, lastUsedAt: new Date(), countryId, storeId,
  });

  it('a store-bound key is handed its store and its country at the landing door', async () => {
    h.db.systemToken.findUnique.mockResolvedValue(row('jo', 's1'));
    const caller = await (await real())(req(), 'orders.create', LANDING_DOOR);
    expect([caller.countryId, caller.storeId]).toEqual(['jo', 's1']);
  });

  it('and is refused at any other door', async () => {
    h.db.systemToken.findUnique.mockResolvedValue(row('jo', 's1'));
    await expect((await real())(req(), 'products.read')).rejects.toMatchObject({ status: 403, code: 'SCOPE_MISSING' });
  });

  it('a key with no store is handed no store (the caller is unchanged)', async () => {
    h.db.systemToken.findUnique.mockResolvedValue(row('jo', null));
    const caller = await (await real())(req(), 'orders.create', LANDING_DOOR);
    expect('storeId' in caller).toBe(false);
  });
});

describe('5 · «توكنات الأنظمة»: the store of a key', () => {
  const JO_ID = '11111111-2222-4333-8444-555555555555';
  const SY_ID = '22222222-2222-4333-8444-555555555555';
  const S1_ID = '33333333-2222-4333-8444-555555555555';
  const OTHER_ID = '99999999-2222-4333-8444-555555555555';
  const create = (body: object) => tokensPost(new Request('https://oms.test/api/settings/system-tokens', { method: 'POST', body: JSON.stringify(body) }));

  beforeEach(() => {
    h.requireCompanyTenant.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1' });
    h.requirePermission.mockResolvedValue({ id: 'u1' });
    h.db.country.findMany.mockResolvedValue([{ id: JO_ID, code: 'JO', name: 'الأردن' }, { id: SY_ID, code: 'SY', name: 'سوريا' }]);
    h.db.store.findMany.mockResolvedValue([{ id: S1_ID, name: 'متجر العسل', countryId: JO_ID }]);
    h.db.systemToken.findMany.mockResolvedValue([
      { id: 'b', name: 'صفحات · العسل', system: 'landing', prefix: 'zk1_b', scopes: '[]', rateLimitPerMin: 600, expiresAt: null, revokedAt: null, lastUsedAt: null, createdAt: new Date(), country: { id: JO_ID, code: 'JO', name: 'الأردن' }, store: { id: S1_ID, name: 'متجر العسل' } },
    ]);
    h.db.systemToken.create.mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'tok_1', createdAt: new Date(), ...data }));
  });

  it('offers the company’s real stores (never a test bench) and lists each key’s store', async () => {
    const body = (await (await tokensGet()).json()) as { stores: unknown[]; tokens: { store: unknown }[] };
    expect(h.db.store.findMany.mock.calls[0][0].where).toEqual({ companyId: 'c1', isTest: false, country: { isActive: true } });
    expect(body.stores).toEqual([{ id: S1_ID, name: 'متجر العسل', countryId: JO_ID }]);
    expect(body.tokens[0].store).toEqual({ id: S1_ID, name: 'متجر العسل' });
  });

  it('a store-bound key is bound to its store and to the store’s country, even with no country sent', async () => {
    const res = await create({ name: 'صفحات · العسل', system: 'landing', scopes: LANDING_SCOPES, storeId: S1_ID });
    expect(res.status).toBe(201);
    const data = h.db.systemToken.create.mock.calls[0][0].data;
    expect([data.storeId, data.countryId]).toEqual([S1_ID, JO_ID]);
    expect(h.logAudit.mock.calls[0][0].newData).toMatchObject({ country: 'JO', store: 'متجر العسل' });
  });

  it('a key with no store is written with no store at all, as before', async () => {
    await create({ name: 'صفحات · الأردن', system: 'landing', scopes: LANDING_SCOPES, countryId: JO_ID });
    expect('storeId' in h.db.systemToken.create.mock.calls[0][0].data).toBe(false);
  });

  it('refuses a store that is not one of this company’s, and a store of another country than the one chosen', async () => {
    const unknown = await create({ name: 'صفحات · ؟', system: 'landing', scopes: LANDING_SCOPES, storeId: OTHER_ID });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { code: string }).code).toBe('STORE_UNKNOWN');
    const other = await create({ name: 'صفحات · ؟', system: 'landing', scopes: LANDING_SCOPES, countryId: SY_ID, storeId: S1_ID });
    expect(other.status).toBe(400);
    expect(((await other.json()) as { code: string }).code).toBe('STORE_OTHER_COUNTRY');
    expect(h.db.systemToken.create).not.toHaveBeenCalled();
  });
});
