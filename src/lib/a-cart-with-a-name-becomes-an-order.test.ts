import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

/**
 * A CART WITH A NAME AND A PHONE BECOMES AN ORDER BY ITSELF — AND THE CUSTOMER'S OWN ORDER WINS OVER IT (the owner, 17/11).
 *
 * «بدي السلات المهجورة تتحول لطلب مباشرة وتنبعت للطابور». Held here end to end, over an in-memory database: the landing
 * door's cart upsert (`upsertLandingCart`) → the claim and the rules (`abandoned-cart-orders.ts`) → the landing orders'
 * REAL engine (`takeCartOrder` → `createPublicOrder`, not a double) → the order in the queue; and the landing order door
 * (`takeLandingOrder`) ending an unconfirmed automatic order through `endOrder` before it takes the customer's own.
 *
 * What is a double, and why: the order number, the customer row, the blacklist, the offers, the delivery policy, the cost
 * and the twin flag each have their own tests; `endOrder` is the one helper every cancel goes through and is held by
 * `a-cancel-has-one-door.test.ts` and its own — here it is asked, and its answer applied to the row.
 */

type Row = Record<string, any>;

const h = vi.hoisted(() => {
  const state = {
    settings: null as string | null,
    carts: [] as Row[],
    cartActivities: [] as Row[],
    products: [] as Row[],
    customers: [] as Row[],
    orders: [] as Row[],
    orderActivities: [] as Row[],
    offers: [] as Row[],
    slots: new Set<string>(),
    seq: 0,
  };
  const spies = {
    logAudit: vi.fn(),
    notify: vi.fn(),
    emitAppEvent: vi.fn(),
    queueConversions: vi.fn(),
    isBlocked: vi.fn(async () => false),
    flagRecentTwins: vi.fn(async () => []),
    endOrder: vi.fn(),
  };
  return { state, spies };
});
const s = h.state;

vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => h.spies.logAudit(...a) }));
vi.mock('@/lib/notify', () => ({ notify: (...a: unknown[]) => h.spies.notify(...a), afterResponse: (w: () => Promise<unknown>) => void w() }));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: (...a: unknown[]) => h.spies.emitAppEvent(...a) }));
vi.mock('@/lib/conversions/emit', () => ({ queueConversions: (...a: unknown[]) => h.spies.queueConversions(...a) }));
vi.mock('@/lib/blacklist', () => ({ isBlocked: (...a: unknown[]) => h.spies.isBlocked(...(a as [])), NEUTRAL_REFUSAL: 'تعذر إرسال الطلب' }));
vi.mock('@/lib/recent-twin-order', () => ({ flagRecentTwins: (...a: unknown[]) => h.spies.flagRecentTwins(...(a as [])) }));
vi.mock('@/lib/order-cancel', () => ({ endOrder: (...a: unknown[]) => h.spies.endOrder(...a) }));
vi.mock('@/lib/campaigns-server', () => ({ resolveCampaign: async () => null }));
vi.mock('@/lib/product-fixed-cost', () => ({ unitCostsOf: async () => new Map() }));
vi.mock('@/lib/delivery-fees', async (orig) => ({ ...(await orig<object>()), priceIncludesDeliveryFor: async () => false }));
vi.mock('@/lib/order-ref', () => ({ orderRefFields: async () => ({ orderNumber: `ORD-${++h.state.seq}` }) }));
vi.mock('@/lib/rate-limit', () => ({
  rateLimit: (key: string) => {
    if (h.state.slots.has(key)) return { allowed: false, retryAfterSec: 300 };
    h.state.slots.add(key);
    return { allowed: true, retryAfterSec: 0 };
  },
  releaseRateLimit: (key: string) => h.state.slots.delete(key),
}));
vi.mock('@/lib/offers', async (orig) => ({
  ...(await orig<object>()),
  activeOffersFor: async (_db: unknown, _c: string, productId: string) => h.state.offers.filter((o) => o.productId === productId),
  postOrderOfferFor: async () => null,
}));
vi.mock('@/lib/customer-identity', () => ({
  findOrCreateCustomer: async (_db: unknown, seed: Row) => {
    let c = h.state.customers.find((x) => x.companyId === seed.companyId && x.storeId === seed.storeId && x.phone === seed.phone);
    if (!c) {
      c = { id: `cust${++h.state.seq}`, companyId: seed.companyId, storeId: seed.storeId, phone: seed.phone, fullName: seed.fullName, city: seed.city, firstOrderDate: null };
      h.state.customers.push(c);
    }
    return c;
  },
}));

vi.mock('@/lib/db', () => {
  const dup = () => new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
  const cartBy = (where: Row) =>
    where.companyId_externalId
      ? s.carts.find((c) => c.companyId === where.companyId_externalId.companyId && c.externalId === where.companyId_externalId.externalId)
      : s.carts.find((c) => c.id === where.id && (!where.companyId || c.companyId === where.companyId));
  const pick = (row: Row | undefined, select?: Row) => {
    if (!row) return null;
    if (!select) return { ...row };
    return Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]));
  };
  const cartView = (c: Row) => ({ ...c, region: c.regionId ? { name: c.regionId === 'amm' ? 'عمّان' : 'إربد' } : null });
  const writeCart = (row: Row, data: Row) => {
    for (const [k, v] of Object.entries(data)) {
      if (k === 'activities') s.cartActivities.push({ id: `ca${++s.seq}`, cartId: row.id, createdAt: new Date(), ...(v as Row).create });
      else row[k] = v;
    }
    row.updatedAt = new Date();
  };
  const inList = (v: unknown, cond: unknown) => (cond && typeof cond === 'object' && 'in' in (cond as Row) ? (cond as Row).in.includes(v) : cond === undefined || v === cond);
  const cartMatches = (c: Row, w: Row) =>
    (!w.id || c.id === w.id) &&
    (!w.companyId || c.companyId === w.companyId) &&
    (!('autoOrderAt' in w) || (w.autoOrderAt === null ? c.autoOrderAt == null : +c.autoOrderAt === +w.autoOrderAt)) &&
    (!('orderId' in w) || (w.orderId === null ? c.orderId == null : c.orderId === w.orderId)) &&
    inList(c.status, w.status) &&
    (!w.productId || c.productId != null) &&
    (!w.customerName || c.customerName != null) &&
    (!w.lastSeenAt || c.lastSeenAt >= w.lastSeenAt.gte);
  const productOf = (o: Row) => [o.productId, ...o.items.map((i: Row) => i.productId)];
  const orderMatches = (o: Row, w: Row) =>
    o.companyId === w.companyId &&
    (!w.orderNumber || o.orderNumber === w.orderNumber) &&
    (!w.id || o.id === w.id) &&
    (!w.storeId || o.storeId === w.storeId) &&
    (!w.customerId || w.customerId.in.includes(o.customerId)) &&
    (!w.source || o.source === w.source) &&
    (!w.confirmationStatus || w.confirmationStatus.in.includes(o.confirmationStatus)) &&
    (!w.createdAt || o.createdAt >= w.createdAt.gte) &&
    (!w.abandonedCarts || s.carts.some((c) => c.orderId === o.id)) &&
    (!w.OR || w.OR.some((x: Row) => (x.productId ? o.productId === x.productId : productOf(o).includes(x.items.some.productId)))) &&
    (!w.activities ||
      s.orderActivities.some(
        (a) => a.orderId === o.id && a.action === w.activities.some.action && a.metadata === w.activities.some.metadata
      ));
  const orderView = (o: Row) => ({ ...o, abandonedCarts: s.carts.filter((c) => c.orderId === o.id).map((c) => ({ id: c.id })) });

  const tx = {
    order: {
      create: async ({ data }: Row) => {
        const row = { id: `ord${++s.seq}`, createdAt: new Date(), items: [], ...data };
        s.orders.push(row);
        return row;
      },
    },
    orderItem: {
      createMany: async ({ data }: Row) => {
        for (const line of data) s.orders.find((o) => o.id === line.orderId)!.items.push(line);
        return { count: data.length };
      },
    },
    customer: { update: async () => ({}) },
    orderActivity: {
      create: async ({ data }: Row) => {
        s.orderActivities.push({ id: `oa${++s.seq}`, ...data });
        return data;
      },
    },
    landingPage: { update: async () => ({}) },
  };

  const db = {
    $transaction: async (fn: (t: unknown) => unknown) => fn(tx),
    company: { findUnique: async () => ({ settings: s.settings }) },
    country: { findFirst: async ({ where }: Row) => (where.code === 'JO' ? { id: 'jo' } : null) },
    region: { findMany: async () => [{ id: 'amm', name: 'عمّان' }, { id: 'irb', name: 'إربد' }] },
    product: {
      findFirst: async ({ where }: Row) => {
        const p = s.products.find((x) => x.id === where.id && x.companyId === where.companyId);
        return p ? { ...p } : null;
      },
    },
    user: { findFirst: async () => ({ id: 'admin', role: 'COMPANY_ADMIN' }) },
    orderChannel: { findFirst: async () => ({ id: 'ch-lp' }) },
    landingPageRecommendation: { findMany: async () => [] },
    deliveryFee: { findMany: async () => [] },
    customer: {
      findMany: async ({ where }: Row) =>
        s.customers.filter((c) => c.companyId === where.companyId && (!where.storeId || c.storeId === where.storeId) && where.phone.in.includes(c.phone)),
    },
    order: {
      findMany: async ({ where }: Row) => s.orders.filter((o) => orderMatches(o, where)).map(orderView),
      findFirst: async ({ where }: Row) => {
        const o = s.orders.find((x) => orderMatches(x, where));
        return o ? orderView(o) : null;
      },
      updateMany: async ({ where, data }: Row) => {
        const hit = s.orders.filter((o) => o.companyId === where.companyId && o.orderNumber === where.orderNumber);
        for (const o of hit) Object.assign(o, data);
        return { count: hit.length };
      },
    },
    orderActivity: tx.orderActivity,
    abandonedCart: {
      findUnique: async ({ where, select }: Row) => pick(cartBy(where), select),
      findFirst: async ({ where }: Row) => {
        const c = cartBy(where);
        return c ? cartView(c) : null;
      },
      create: async ({ data, select }: Row) => {
        if (s.carts.some((c) => c.companyId === data.companyId && c.externalId === data.externalId)) throw dup();
        const row: Row = { id: `cart${++s.seq}`, attempts: 0, orderId: null, autoOrderAt: null, createdAt: new Date() };
        writeCart(row, data);
        s.carts.push(row);
        return pick(row, select);
      },
      update: async ({ where, data, select }: Row) => {
        const row = cartBy(where);
        if (!row) throw new Error('no row');
        writeCart(row, data);
        return pick(row, select);
      },
      updateMany: async ({ where, data }: Row) => {
        const hit = s.carts.filter((c) => cartMatches(c, where));
        for (const c of hit) writeCart(c, data);
        return { count: hit.length };
      },
      groupBy: async ({ where }: Row) => [...new Set(s.carts.filter((c) => cartMatches(c, where)).map((c) => c.companyId))].map((companyId) => ({ companyId })),
      findMany: async ({ where, take }: Row) => s.carts.filter((c) => cartMatches(c, where)).slice(0, take),
    },
    abandonedCartActivity: {
      create: async ({ data }: Row) => {
        s.cartActivities.push({ id: `ca${++s.seq}`, createdAt: new Date(), ...data });
        return data;
      },
    },
  };
  return { db, default: db };
});

import { upsertLandingCart, recoverLandingCart, landingCartSchema } from './v1/landing-carts';
import { takeLandingOrder } from './v1/landing-door';
import { autoOrderForCart, convertWaitingCarts } from './abandoned-cart-orders';
import { FROM_ABANDONED_CART_ACTION } from './landing-order-schema';
import { CART_AUTO_ACTION, CART_ORDER_SOURCE, CUSTOMER_ORDERED_HIMSELF_AR } from './abandoned-cart-rules';

const STORE = {
  id: 'store-jo',
  name: 'متجر',
  status: 'ACTIVE',
  countryId: 'jo',
  theme: null,
  country: { code: 'JO', currencyCode: 'JOD', orderPrefix: 'ORD', minorUnit: 3 },
};

const cart = (over: Record<string, unknown> = {}) =>
  landingCartSchema.parse({
    externalId: 'lead-1',
    landingPageId: 'lp1',
    landingPageName: 'رمانة',
    productId: 'p1',
    customerName: 'محمد',
    phone: '962791234567',
    city: 'عمّان',
    country: 'JO',
    ...over,
  });

const autoOrders = () => s.orders.filter((o) => o.source === CART_ORDER_SOURCE);
const cartRow = (externalId = 'lead-1') => s.carts.find((c) => c.externalId === externalId)!;
const cartLines = (action: string) => s.cartActivities.filter((a) => a.action === action);

beforeEach(() => {
  vi.clearAllMocks();
  h.spies.isBlocked.mockResolvedValue(false);
  h.spies.flagRecentTwins.mockResolvedValue([]);
  h.spies.endOrder.mockImplementation(async (input: Row) => {
    const o = s.orders.find((x) => x.id === input.orderId)!;
    Object.assign(o, { confirmationStatus: input.endAs, status: input.endAs, rejectionReason: input.reason, rejectionNote: input.rejectionNote });
    return { ok: true, orderNumber: o.orderNumber, attested: false, tookOff: false, courierCancelled: false, afterCommit: async () => undefined };
  });
  Object.assign(s, { settings: null, carts: [], cartActivities: [], customers: [], orders: [], orderActivities: [], seq: 0 });
  s.slots.clear();
  s.products = [{ id: 'p1', companyId: 'c1', sku: 'P1', name: 'دبس رمان', description: null, image: null, basePrice: 10, status: 'ACTIVE', storeId: STORE.id, store: STORE }];
  s.offers = [
    { id: 'o-one', productId: 'p1', name: 'عبوة', quantity: 1, freeQuantity: 0, price: 10, listPrice: 10, isDefault: false, deliveryIncluded: false },
    { id: 'o-two', productId: 'p1', name: 'عبوتين', quantity: 2, freeQuantity: 0, price: 18, listPrice: 18, isDefault: true, deliveryIncluded: false },
  ];
});

describe('a cart with a name and a phone becomes ONE order in the queue', () => {
  it('the door answers CONVERTED; the order is NEW, from «سلة مهجورة», at the default offer, with no address, and says so', async () => {
    const r = await upsertLandingCart('c1', cart());
    expect(r).toEqual({ status: 201, body: { id: cartRow().id, status: 'CONVERTED' } });

    expect(autoOrders()).toHaveLength(1);
    const o = autoOrders()[0];
    expect(o).toMatchObject({ status: 'NEW', confirmationStatus: 'NEW', source: CART_ORDER_SOURCE, offerId: 'o-two', regionId: 'amm', deliveryAddress: null, channelId: 'ch-lp' });
    expect(Number(o.totalAmount)).toBe(18);

    const lines = s.orderActivities.filter((a) => a.orderId === o.id).map((a) => a.action);
    expect(lines).toEqual(['ORDER_CREATED', FROM_ABANDONED_CART_ACTION]);
    const line = s.orderActivities.find((a) => a.action === FROM_ABANDONED_CART_ACTION)!;
    expect(line).toMatchObject({ userId: null });
    expect(JSON.parse(line.metadata)).toEqual({ cartId: cartRow().id });

    // the queue is told, as for any new order
    expect(h.spies.notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'طلب جديد من سلة مهجورة', orderId: o.id, type: 'ORDER_NEW' }));
    expect(h.spies.emitAppEvent).toHaveBeenCalledWith('c1', 'order.created', expect.objectContaining({ orderId: o.id, source: CART_ORDER_SOURCE }));

    // the cart: CONVERTED, pointing at it, its history in nobody's name
    expect(cartRow()).toMatchObject({ status: 'CONVERTED', orderId: o.id });
    expect(cartRow().autoOrderAt).toBeInstanceOf(Date);
    const converted = cartLines('CONVERTED')[0];
    expect(converted).toMatchObject({ userId: null, fromStatus: 'NEW', toStatus: 'CONVERTED' });
    expect(JSON.parse(converted.metadata)).toEqual({ orderId: o.id, orderNumber: o.orderNumber, auto: true });
    expect(h.spies.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'ABANDONED_CART_CONVERTED', userId: null }));
  });

  it('no city (or one that is no governorate) ⇒ no region, both lines on the order, and the typed city on its note', async () => {
    await upsertLandingCart('c1', cart({ city: 'ماركا الجنوبية' }));
    const o = autoOrders()[0];
    expect(o.regionId).toBeNull();
    expect(o.customerNotes).toBe('المدينة كما كتبها الزائر: ماركا الجنوبية');
    expect(s.orderActivities.filter((a) => a.orderId === o.id).map((a) => a.action)).toEqual([
      'ORDER_CREATED',
      'ARRIVED_WITHOUT_REGION',
      FROM_ABANDONED_CART_ACTION,
    ]);
  });

  it('a re-sent cart (a new key, a changed name) makes no second order and still answers CONVERTED', async () => {
    await upsertLandingCart('c1', cart());
    const again = await upsertLandingCart('c1', cart({ customerName: 'محمد علي' }));
    expect(again).toEqual({ status: 200, body: { id: cartRow().id, status: 'CONVERTED' } });
    expect(autoOrders()).toHaveLength(1);
  });

  it('two callers on the same cart in the same moment (the door and the job) make one order', async () => {
    s.settings = JSON.stringify({ abandonedCarts: { autoConvert: false } });
    await upsertLandingCart('c1', cart());
    s.settings = null;
    const id = cartRow().id;
    const both = await Promise.all([autoOrderForCart('c1', id), autoOrderForCart('c1', id), convertWaitingCarts(new Date())]);
    expect(autoOrders()).toHaveLength(1);
    expect(both.filter((b) => 'kind' in b && b.kind === 'CONVERTED').length + (both[2] as { converted: number }).converted).toBe(1);
  });

  it('a phone-only cart stays a cart — and becomes an order when its name arrives', async () => {
    const r = await upsertLandingCart('c1', cart({ customerName: '' }));
    expect(r.body.status).toBe('NEW');
    expect(s.orders).toHaveLength(0);
    expect(cartRow().autoOrderAt).toBeNull();
    expect(cartLines(CART_AUTO_ACTION.SKIPPED)).toEqual([]);

    // one letter is not a name either
    expect((await upsertLandingCart('c1', cart({ customerName: 'م' }))).body.status).toBe('NEW');
    expect(s.orders).toHaveLength(0);

    const named = await upsertLandingCart('c1', cart({ customerName: 'سارة' }));
    expect(named.body.status).toBe('CONVERTED');
    expect(autoOrders()).toHaveLength(1);
  });

  it('the engine throws AFTER the order was saved ⇒ that order is the cart’s, tied — never a second one', async () => {
    h.spies.emitAppEvent.mockRejectedValueOnce(new Error('apps down'));
    const r = await upsertLandingCart('c1', cart());
    expect(r.body.status).toBe('CONVERTED');
    expect(autoOrders()).toHaveLength(1);
    expect(cartRow()).toMatchObject({ status: 'CONVERTED', orderId: autoOrders()[0].id });
    expect(await convertWaitingCarts(new Date())).toEqual({ converted: 0, skipped: 0, tried: 0 });
    expect(autoOrders()).toHaveLength(1);
  });

  it('the engine throws BEFORE anything was saved ⇒ the door still answers, the claim goes back, and the job makes it later', async () => {
    h.spies.isBlocked.mockRejectedValueOnce(new Error('db hiccup'));
    const r = await upsertLandingCart('c1', cart());
    expect(r).toEqual({ status: 201, body: { id: cartRow().id, status: 'NEW' } });
    expect(s.orders).toHaveLength(0);
    expect(cartRow().autoOrderAt).toBeNull();
    expect(await convertWaitingCarts(new Date())).toEqual({ converted: 1, skipped: 0, tried: 1 });
    expect(autoOrders()).toHaveLength(1);
  });

  it('a cart the team closed as «غير مهتم» or «رقم غير صالح» never becomes an order', async () => {
    s.settings = JSON.stringify({ abandonedCarts: { autoConvert: false } });
    await upsertLandingCart('c1', cart());
    cartRow().status = 'NOT_INTERESTED';
    s.settings = null;
    expect(await autoOrderForCart('c1', cartRow().id)).toEqual({ kind: 'NONE' });
    expect(s.orders).toHaveLength(0);
  });
});

describe('the switch («حوّل السلات اللي فيها اسم ورقم لطلبات تلقائيًا»)', () => {
  it('off ⇒ the door makes no order and the job leaves the cart; on again ⇒ the job converts the cart that waited', async () => {
    s.settings = JSON.stringify({ abandonedCarts: { retentionDays: 30, autoConvert: false } });
    const r = await upsertLandingCart('c1', cart());
    expect(r.body.status).toBe('NEW');
    expect(await convertWaitingCarts(new Date())).toEqual({ converted: 0, skipped: 0, tried: 0 });
    expect(s.orders).toHaveLength(0);
    expect(cartRow().autoOrderAt).toBeNull();

    s.settings = JSON.stringify({ abandonedCarts: { retentionDays: 30, autoConvert: true } });
    expect(await convertWaitingCarts(new Date())).toEqual({ converted: 1, skipped: 0, tried: 1 });
    expect(cartRow().status).toBe('CONVERTED');
    expect(autoOrders()).toHaveLength(1);
  });

  it('the job leaves a cart older than seven days, and takes twenty a run at most', async () => {
    s.settings = JSON.stringify({ abandonedCarts: { autoConvert: false } });
    const now = new Date('2026-11-17T12:00:00Z');
    await upsertLandingCart('c1', cart({ externalId: 'old', phone: '0781111111', lastSeenAt: '2026-11-09T12:00:00Z' }));
    for (let i = 0; i < 22; i++) await upsertLandingCart('c1', cart({ externalId: `n${i}`, phone: `07922222${String(i).padStart(2, '0')}`, lastSeenAt: '2026-11-17T10:00:00Z' }));
    s.settings = null;
    const run = await convertWaitingCarts(now);
    expect(run).toEqual({ converted: 20, skipped: 0, tried: 20 });
    expect(cartRow('old').status).toBe('NEW');
    expect((await convertWaitingCarts(now)).converted).toBe(2);
    expect(cartRow('old').status).toBe('NEW');
  });
});

describe('when it stays a cart, its history says why — and the door still answers', () => {
  it('a blacklisted number', async () => {
    h.spies.isBlocked.mockResolvedValue(true);
    const r = await upsertLandingCart('c1', cart());
    expect(r).toEqual({ status: 201, body: { id: cartRow().id, status: 'NEW' } });
    expect(s.orders).toHaveLength(0);
    const line = cartLines(CART_AUTO_ACTION.SKIPPED)[0];
    expect(line).toMatchObject({ userId: null, note: 'الرقم محظور — ما انعمل طلب.' });
    expect(JSON.parse(line.metadata)).toEqual({ reason: 'BLOCKED' });
    // tried once: a re-send does not ask again
    await upsertLandingCart('c1', cart({ customerName: 'محمد علي' }));
    expect(cartLines(CART_AUTO_ACTION.SKIPPED)).toHaveLength(1);
    expect(await convertWaitingCarts(new Date())).toEqual({ converted: 0, skipped: 0, tried: 0 });
  });

  it('a product that is stopped', async () => {
    s.products[0].status = 'INACTIVE';
    expect((await upsertLandingCart('c1', cart())).body.status).toBe('NEW');
    expect(s.orders).toHaveLength(0);
    expect(JSON.parse(cartLines(CART_AUTO_ACTION.SKIPPED)[0].metadata)).toEqual({ reason: 'UNAVAILABLE' });
  });

  it('the same phone already ordered the same product this week (a real order)', async () => {
    s.customers.push({ id: 'cust-x', companyId: 'c1', storeId: STORE.id, phone: '791234567' });
    s.orders.push({ id: 'real-1', orderNumber: 'ORD-R1', companyId: 'c1', storeId: STORE.id, customerId: 'cust-x', productId: 'p1', items: [], source: 'Landing Page', confirmationStatus: 'NEW', createdAt: new Date() });
    expect((await upsertLandingCart('c1', cart())).body.status).toBe('NEW');
    expect(autoOrders()).toHaveLength(0);
    expect(JSON.parse(cartLines(CART_AUTO_ACTION.SKIPPED)[0].metadata)).toEqual({ reason: 'HAS_ORDER', orderNumber: 'ORD-R1' });
  });

  it('the order door refuses what the cart holds (a number that is not the country’s) — its own words, nothing typed', async () => {
    expect((await upsertLandingCart('c1', cart({ phone: '0612345678' }))).body.status).toBe('NEW');
    expect(s.orders).toHaveLength(0);
    const line = cartLines(CART_AUTO_ACTION.SKIPPED)[0];
    expect(JSON.parse(line.metadata)).toEqual({ reason: 'REFUSED' });
    expect(line.note).toMatch(/^باب الطلبات ما قبلها: /);
    expect(line.note).not.toContain('0612345678');
  });
});

describe('the customer then orders by himself on the page — his order wins', () => {
  const landing = (over: Record<string, unknown> = {}) =>
    takeLandingOrder('c1', {
      productId: 'p1',
      offerId: 'o-one',
      landingPageId: 'lp1',
      full_name: 'محمد',
      phone: '0791234567',
      alt_phone: null,
      address: 'شارع الجامعة، بناية ٣',
      city: 'عمّان',
      notes: null,
      campaign: null,
      deviceClass: 'mobile',
      ...over,
    } as never);

  it('the automatic order, still unconfirmed, is ended through `endOrder` («الزبون طلب بنفسه»), and his order is taken', async () => {
    await upsertLandingCart('c1', cart());
    const auto = autoOrders()[0];

    const r = await landing();
    expect(r.ok, JSON.stringify(r)).toBe(true);

    expect(h.spies.endOrder).toHaveBeenCalledTimes(1);
    expect(h.spies.endOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: auto.id,
        companyId: 'c1',
        door: 'CONFIRMATION',
        kind: 'CANCEL',
        endAs: 'REJECTED',
        reason: 'DUPLICATE_ORDER',
        rejectionNote: CUSTOMER_ORDERED_HIMSELF_AR,
        expectedVersion: auto.version,
        by: expect.objectContaining({ id: 'admin', name: 'النظام (سلة مهجورة)' }),
      })
    );
    expect(auto.confirmationStatus).toBe('REJECTED');

    const real = s.orders.find((o) => o.source === 'Landing Page')!;
    expect(real).toMatchObject({ confirmationStatus: 'NEW', offerId: 'o-one', deliveryAddress: 'شارع الجامعة، بناية ٣' });
    expect(r.ok && r.body.orderNumber).toBe(real.orderNumber);

    // the cart reads «طلب لحاله», pointing at his order, and says what happened to the automatic one
    expect(cartRow()).toMatchObject({ status: 'RECOVERED', orderId: real.id });
    expect(cartLines(CART_AUTO_ACTION.STOOD_DOWN)[0]).toMatchObject({ note: CUSTOMER_ORDERED_HIMSELF_AR, userId: null });
    expect(JSON.parse(cartLines('RECOVERED')[0].metadata)).toEqual({ orderNumber: real.orderNumber, replaced: auto.orderNumber });

    // and Zaki pages' «recovered», when it comes, is a repeat that changes nothing and brings nothing back
    const before = JSON.stringify({ carts: s.carts, orders: s.orders });
    expect(await recoverLandingCart('c1', 'lead-1', real.orderNumber)).toEqual({ id: cartRow().id, status: 'RECOVERED' });
    expect(JSON.stringify({ carts: s.carts, orders: s.orders })).toBe(before);
    expect(auto.confirmationStatus).toBe('REJECTED');
  });

  it('NEGATIVE: an automatic order somebody CONFIRMED is left alone, and his order is taken as today (a twin for the desk)', async () => {
    await upsertLandingCart('c1', cart());
    const auto = autoOrders()[0];
    auto.confirmationStatus = 'CONFIRMED';

    const r = await landing();
    expect(r.ok).toBe(true);
    expect(h.spies.endOrder).not.toHaveBeenCalled();
    expect(auto.confirmationStatus).toBe('CONFIRMED');
    expect(s.orders.filter((o) => o.source === 'Landing Page')).toHaveLength(1);
    expect(cartRow().status).toBe('CONVERTED');
    // the twin guard is asked about the customer's order exactly as at any landing order
    expect(h.spies.flagRecentTwins).toHaveBeenCalledTimes(2);

    // «recovered» keeps the cart as the team's conversion, as before — and touches no order
    expect(await recoverLandingCart('c1', 'lead-1', null)).toEqual({ id: cartRow().id, status: 'CONVERTED' });
    expect(auto.confirmationStatus).toBe('CONFIRMED');
  });

  it('the automatic order never refuses his order as a duplicate: it holds its own slot, not the page’s', async () => {
    await upsertLandingCart('c1', cart());
    expect([...s.slots].some((k) => k.startsWith('pub_order_dup:cart:'))).toBe(true);
    expect([...s.slots].some((k) => k.startsWith('pub_order_dup:lpx:'))).toBe(false);
    const r = await landing();
    expect(r.ok).toBe(true);
  });

  it('a body that does not pass the form leaves the automatic order as it is — the visitor fixes it and sends again', async () => {
    await upsertLandingCart('c1', cart());
    const r = await landing({ address: 'ش' });
    expect(r.ok).toBe(false);
    expect(h.spies.endOrder).not.toHaveBeenCalled();
    expect(autoOrders()[0].confirmationStatus).toBe('NEW');
  });

  it('another product, or another number, is not his order for this cart', async () => {
    await upsertLandingCart('c1', cart());
    s.products.push({ ...s.products[0], id: 'p2', name: 'زيت' });
    s.offers.push({ id: 'o-p2', productId: 'p2', name: 'زيت', quantity: 1, freeQuantity: 0, price: 7, listPrice: 7, isDefault: true, deliveryIncluded: false });
    expect((await landing({ productId: 'p2', offerId: 'o-p2' })).ok).toBe(true);
    expect((await landing({ phone: '0795555555' })).ok).toBe(true);
    expect(h.spies.endOrder).not.toHaveBeenCalled();
    expect(autoOrders()[0].confirmationStatus).toBe('NEW');
  });
});
