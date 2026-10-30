import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * O7 — THE FIVE ENDPOINTS, ANSWERING.
 *
 * `the-systems-door.test.ts` proves the properties of the TREE and
 * `a-key-is-not-a-session.test.ts` proves the guard. This file runs the
 * handlers and reads what comes back, because three of the required
 * negatives are only visible from out here:
 *
 *   WRONG COMPANY answers 404 and not 403 — 403 would confirm the id
 *   exists somewhere, which is an existence oracle over every order in the
 *   product for anybody holding any valid key.
 *
 *   A REPLAYED REQUEST answers the first call's body, with 200 instead of
 *   201, and creates nothing.
 *
 *   A REFUSAL STILL CARRIES `X-Request-Id`, because a failure in the
 *   calling system and a line in this one's log have to be put side by
 *   side, and that is most needed exactly when something went wrong.
 * ═══════════════════════════════════════════════════════════════════════
 */

const h = vi.hoisted(() => ({
  db: {
    product: { findMany: vi.fn() },
    customer: { findMany: vi.fn() },
    order: { findFirst: vi.fn(), aggregate: vi.fn() },
    orderNote: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
    store: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
  requireSystemToken: vi.fn(),
  activeOffersFor: vi.fn(),
  availableStock: vi.fn(),
  activeBlock: vi.fn(),
  createSystemOrder: vi.fn(),
  claimIdempotency: vi.fn(),
  rememberIdempotency: vi.fn(),
  releaseIdempotency: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db: h.db }));
vi.mock('@/lib/v1/system-token', async () => {
  const real = await vi.importActual<typeof import('./system-token')>('./system-token');
  return { ...real, requireSystemToken: (...a: unknown[]) => h.requireSystemToken(...a) };
});
vi.mock('@/lib/offers', () => ({ activeOffersFor: (...a: unknown[]) => h.activeOffersFor(...a) }));
vi.mock('@/lib/reservation', () => ({ availableStock: (...a: unknown[]) => h.availableStock(...a) }));
vi.mock('@/lib/blacklist', () => ({ activeBlock: (...a: unknown[]) => h.activeBlock(...a) }));
vi.mock('@/lib/v1/order-intake', async () => {
  // The SCHEMA is the real one: a route test that mocked the validation
  // would prove nothing about what the door accepts, which is half of what
  // the contract is.
  const real = await vi.importActual<typeof import('./order-intake')>('./order-intake');
  return { ...real, createSystemOrder: (...a: unknown[]) => h.createSystemOrder(...a) };
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

import { V1_CODE, V1Fault } from './door';
import { GET as getProducts } from '@/app/api/v1/products/route';
import { GET as lookup } from '@/app/api/v1/customers/lookup/route';
import { POST as postOrder } from '@/app/api/v1/orders/route';
import { GET as getOrder } from '@/app/api/v1/orders/[id]/route';
import { POST as postNote } from '@/app/api/v1/orders/[id]/notes/route';

const CALLER = { tokenId: 'tok_1', companyId: 'c1', system: 'replies', scopes: [] };

const ORDER_BODY = {
  customer: { name: 'أبو أحمد', phone: '0936654998', city: 'حلب', address: 'الفرقان' },
  items: [{ product_code: 'TIN01', quantity: 2, unit_price: '15.00' }],
};

const withKey = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  new Request(url, {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { 'idempotency-key': 'k1', 'x-request-id': 'rep_SY-2026-0148', ...headers },
  });

beforeEach(() => {
  vi.clearAllMocks();
  h.requireSystemToken.mockResolvedValue(CALLER);
  h.activeOffersFor.mockResolvedValue([]);
  h.availableStock.mockResolvedValue(20);
  h.activeBlock.mockResolvedValue(null);
  h.claimIdempotency.mockResolvedValue(null);
  h.rememberIdempotency.mockResolvedValue(undefined);
  h.releaseIdempotency.mockResolvedValue(undefined);
  h.db.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
    fn({ orderNote: h.db.orderNote, orderActivity: h.db.orderActivity })
  );
  h.createSystemOrder.mockResolvedValue({
    orderId: 'o1',
    orderNumber: 'SY-2026-0148',
    status: 'NEW',
    priceAdjusted: false,
    totals: { subtotal: 30, discount: 0, deliveryFee: 0, total: 30 },
    currency: 'USD',
    minorUnit: 2,
  });
});

describe('no token, at any of the five', () => {
  it('is 401 in the contract’s envelope, with the request id on it', async () => {
    h.requireSystemToken.mockRejectedValue(
      new V1Fault(401, V1_CODE.TOKEN_MISSING, 'Authorization: Bearer <token> is required')
    );
    const req = new Request('https://oms.test/api/v1/products', {
      headers: { 'x-request-id': 'rep_1' },
    });
    const res = await getProducts(req);
    expect(res.status).toBe(401);
    expect(res.headers.get('X-Request-Id')).toBe('rep_1');
    expect(await res.json()).toEqual({
      error: { code: 'TOKEN_MISSING', message: 'Authorization: Bearer <token> is required', details: null },
      request_id: 'rep_1',
    });
  });

  it('and the write doors refuse before they claim a key', async () => {
    h.requireSystemToken.mockRejectedValue(new V1Fault(401, V1_CODE.TOKEN_MISSING, 'no'));
    const res = await postOrder(withKey('https://oms.test/api/v1/orders', ORDER_BODY));
    expect(res.status).toBe(401);
    expect(h.claimIdempotency).not.toHaveBeenCalled();
    expect(h.releaseIdempotency).not.toHaveBeenCalled();
  });
});

describe('an order from another company', () => {
  it('is 404, not 403 — a 403 would confirm the id exists', async () => {
    h.db.order.findFirst.mockResolvedValue(null);
    const res = await getOrder(new Request('https://oms.test/api/v1/orders/o_other'), {
      params: Promise.resolve({ id: 'o_other' }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
  });

  it('and the company is in the WHERE, from the token', async () => {
    h.db.order.findFirst.mockResolvedValue(null);
    await getOrder(new Request('https://oms.test/api/v1/orders/o1'), {
      params: Promise.resolve({ id: 'o1' }),
    });
    expect(h.db.order.findFirst.mock.calls[0][0].where).toEqual({ id: 'o1', companyId: 'c1' });
  });

  it('and a note on it is refused the same way, before a key is burned', async () => {
    /*
     * Burning the idempotency key on a 404 would mean the caller could not
     * reuse that key once it corrected the id.
     */
    h.db.order.findFirst.mockResolvedValue(null);
    const res = await postNote(
      withKey('https://oms.test/api/v1/orders/o_other/notes', { kind: 'follow_up', note: 'بعد الخمسة' }),
      { params: Promise.resolve({ id: 'o_other' }) }
    );
    expect(res.status).toBe(404);
    expect(h.claimIdempotency).not.toHaveBeenCalled();
    expect(h.db.orderNote.create).not.toHaveBeenCalled();
  });
});

describe('a status read', () => {
  it('says the number, the two statuses that move, and when — and nothing else', async () => {
    h.db.order.findFirst.mockResolvedValue({
      id: 'o1',
      orderNumber: 'SY-2026-0148',
      confirmationStatus: 'CONFIRMED',
      shippingStatus: 'SHIPPED',
      updatedAt: new Date('2026-10-09T17:14:00.000Z'),
      store: { country: { timezone: 'Asia/Damascus' } },
    });
    const res = await getOrder(new Request('https://oms.test/api/v1/orders/o1'), {
      params: Promise.resolve({ id: 'o1' }),
    });
    const answer = await res.json();
    expect(Object.keys(answer).sort()).toEqual([
      'order_id',
      'order_number',
      'shipping_status',
      'status',
      'updated_at',
    ]);
    expect(answer.updated_at).toBe('2026-10-09T20:14:00+03:00');
  });

  it('and nothing about the customer, because this is the call made most often', async () => {
    h.db.order.findFirst.mockResolvedValue(null);
    await getOrder(new Request('https://oms.test/api/v1/orders/o1'), {
      params: Promise.resolve({ id: 'o1' }),
    });
    const select = h.db.order.findFirst.mock.calls[0][0].select;
    expect(select.customer).toBeUndefined();
    expect(select.totalAmount).toBeUndefined();
  });
});

describe('a replayed order', () => {
  it('answers the first call’s body with 200, and creates nothing', async () => {
    h.claimIdempotency.mockResolvedValue({
      status: 200,
      body: { order_id: 'o1', order_number: 'SY-2026-0148', status: 'NEW' },
    });
    const res = await postOrder(withKey('https://oms.test/api/v1/orders', ORDER_BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ order_id: 'o1', order_number: 'SY-2026-0148', status: 'NEW' });
    expect(h.createSystemOrder).not.toHaveBeenCalled();
    // Nothing to remember: the answer is already stored.
    expect(h.rememberIdempotency).not.toHaveBeenCalled();
  });

  it('and a first call answers 201 and stores what it answered', async () => {
    const res = await postOrder(withKey('https://oms.test/api/v1/orders', ORDER_BODY));
    expect(res.status).toBe(201);
    const answer = await res.json();
    expect(answer.order_number).toBe('SY-2026-0148');
    // Money as a decimal string at the currency's places — «"15.00"».
    expect(answer.totals).toEqual({
      subtotal: '30.00',
      discount: '0.00',
      delivery_fee: '0.00',
      total: '30.00',
      currency: 'USD',
    });
    expect(h.rememberIdempotency).toHaveBeenCalledWith('c1', 'k1', 201, answer);
  });

  it('and a malformed body does NOT burn the key', async () => {
    /*
     * The body is parsed before the key is claimed, so a caller that fixes
     * its payload may retry with the same key. A 422 that consumed the key
     * would leave it unable to.
     */
    const res = await postOrder(withKey('https://oms.test/api/v1/orders', { customer: {} }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('VALIDATION_FAILED');
    expect(h.claimIdempotency).not.toHaveBeenCalled();
    expect(h.releaseIdempotency).not.toHaveBeenCalled();
  });

  it('and the refusal names the FIELDS and never the values', async () => {
    const res = await postOrder(
      withKey('https://oms.test/api/v1/orders', {
        ...ORDER_BODY,
        customer: { name: 'ا', phone: '0936654998', city: 'حلب' },
      })
    );
    const refusal = await res.json();
    expect(refusal.error.details.fields).toContain('customer.name');
    // A validation error that echoed the input would put a customer's phone
    // into the calling system's error log.
    expect(JSON.stringify(refusal)).not.toContain('0936654998');
  });

  it('and a write with no Idempotency-Key is refused outright', async () => {
    const res = await postOrder(
      new Request('https://oms.test/api/v1/orders', { method: 'POST', body: JSON.stringify(ORDER_BODY) })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(h.createSystemOrder).not.toHaveBeenCalled();
  });

  it('and a failure gives the key back, so a retry is not locked out for ever', async () => {
    h.createSystemOrder.mockRejectedValue(new Error('database gone'));
    const res = await postOrder(withKey('https://oms.test/api/v1/orders', ORDER_BODY));
    expect(res.status).toBe(500);
    expect(h.releaseIdempotency).toHaveBeenCalledWith('c1', 'k1');
    // And the thrown message never travels: a Prisma message carries the
    // server's own absolute source paths.
    expect(JSON.stringify(await res.json())).not.toContain('database gone');
  });

  it('and a successful call does NOT give the key back', async () => {
    await postOrder(withKey('https://oms.test/api/v1/orders', ORDER_BODY));
    expect(h.releaseIdempotency).not.toHaveBeenCalled();
  });
});

describe('a note from the conversation', () => {
  it('lands on the order’s own thread, with no author, and an activity row beside it', async () => {
    h.db.order.findFirst.mockResolvedValue({ id: 'o1' });
    const res = await postNote(
      withKey('https://oms.test/api/v1/orders/o1/notes', {
        kind: 'follow_up',
        note: 'الزبون طلب التوصيل بعد الساعة 5',
      }),
      { params: Promise.resolve({ id: 'o1' }) }
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });

    expect(h.db.orderNote.create.mock.calls[0][0].data).toEqual({
      companyId: 'c1',
      orderId: 'o1',
      body: 'الزبون طلب التوصيل بعد الساعة 5',
      kind: 'follow_up',
      // No employee wrote this, and naming one would be a false trail.
      authorId: null,
    });
    // So the provenance lives on the activity row instead.
    const activity = h.db.orderActivity.create.mock.calls[0][0].data;
    expect(activity.action).toBe('NOTE_ADDED');
    expect(JSON.parse(activity.metadata)).toMatchObject({ via: 'api/v1', system: 'replies' });
  });

  it('and both writes are one transaction', async () => {
    h.db.order.findFirst.mockResolvedValue({ id: 'o1' });
    await postNote(
      withKey('https://oms.test/api/v1/orders/o1/notes', { kind: 'internal', note: 'ملاحظة' }),
      { params: Promise.resolve({ id: 'o1' }) }
    );
    expect(h.db.$transaction).toHaveBeenCalledTimes(1);
  });

  it('and a kind outside the four the product renders is refused', async () => {
    h.db.order.findFirst.mockResolvedValue({ id: 'o1' });
    const res = await postNote(
      withKey('https://oms.test/api/v1/orders/o1/notes', { kind: 'whatever', note: 'ملاحظة' }),
      { params: Promise.resolve({ id: 'o1' }) }
    );
    // A fifth kind spelled only here would render as nothing on all four
    // screens that read notes.
    expect(res.status).toBe(422);
    expect(h.db.orderNote.create).not.toHaveBeenCalled();
  });
});

describe('the catalogue', () => {
  const row = {
    id: 'p1',
    sku: 'TIN01',
    name: 'منتج الطنين',
    basePrice: 15,
    storeId: 's1',
    store: { country: { currencyCode: 'USD', minorUnit: 2 } },
  };

  it('is this company’s active, non-bench products — priced as decimal strings', async () => {
    h.db.product.findMany.mockResolvedValue([row]);
    const res = await getProducts(new Request('https://oms.test/api/v1/products'));
    const items = (await res.json()).items;
    expect(items[0]).toMatchObject({
      code: 'TIN01',
      name: 'منتج الطنين',
      price: '15.00',
      currency: 'USD',
      stock_status: 'IN_STOCK',
    });
    expect(h.db.product.findMany.mock.calls[0][0].where).toMatchObject({
      companyId: 'c1',
      status: 'ACTIVE',
      store: { isTest: false },
    });
  });

  it('and the two fields this system has not got come back null, not invented', async () => {
    /*
     * `wholesale_price` and `discount_cap` are in the specification's
     * example and in no column, setting or screen here. The nearest thing
     * to a wholesale price is `productCost`, and publishing it would break
     * the same paragraph's own «بلا تكلفة». Null says «we do not have
     * this»; a number would not.
     */
    h.db.product.findMany.mockResolvedValue([row]);
    const items = (await (await getProducts(new Request('https://oms.test/api/v1/products'))).json()).items;
    expect(items[0].wholesale_price).toBeNull();
    expect(items[0].discount_cap).toBeNull();
    expect(items[0].complements).toEqual([]);
  });

  it('and the shelf is a WORD, never a count', async () => {
    h.db.product.findMany.mockResolvedValue([row]);
    for (const [free, word] of [
      [0, 'OUT_OF_STOCK'],
      [-3, 'OUT_OF_STOCK'],
      [4, 'LOW_STOCK'],
      [5, 'IN_STOCK'],
      [900, 'IN_STOCK'],
    ] as const) {
      h.availableStock.mockResolvedValue(free);
      const items = (await (await getProducts(new Request('https://oms.test/api/v1/products'))).json()).items;
      expect(items[0].stock_status, String(free)).toBe(word);
      // «can I promise this?» is answered; «how much does this shop hold?»
      // is a competitor's question.
      expect(JSON.stringify(items[0])).not.toContain(`:${free}`);
    }
  });

  it('and the offers come from the one offer view every public surface renders', async () => {
    h.db.product.findMany.mockResolvedValue([row]);
    h.activeOffersFor.mockResolvedValue([
      {
        id: 'off_1',
        name: 'حبتين بـ 25',
        quantity: 2,
        freeQuantity: 0,
        price: 25,
        listPrice: 30,
        compareAtPrice: null,
        isDefault: false,
        deliveryIncluded: false,
        endsAt: new Date('2026-12-01T00:00:00.000Z'),
      },
    ]);
    const items = (await (await getProducts(new Request('https://oms.test/api/v1/products'))).json()).items;
    expect(items[0].offers[0]).toEqual({
      title: 'حبتين بـ 25',
      quantity: 2,
      price: '25.00',
      saving: '5.00',
      remaining_qty: null,
      expires_at: '2026-12-01T00:00:00.000Z',
    });
  });

  it('and `?limit=abc` is a page size, not a 500', async () => {
    // The shared reader, so one bad character in a URL cannot take a door
    // down — see `a-page-number-is-not-a-crash.test.ts`.
    h.db.product.findMany.mockResolvedValue([]);
    const res = await getProducts(new Request('https://oms.test/api/v1/products?limit=abc'));
    expect(res.status).toBe(200);
    expect(h.db.product.findMany.mock.calls[0][0].take).toBe(100);
  });
});

describe('the customer lookup', () => {
  it('answers a count, a value and a yes/no — and no contact detail', async () => {
    h.db.customer.findMany.mockResolvedValue([{ id: 'cust_1', totalOrders: 3, storeId: 's1' }]);
    h.db.order.aggregate.mockResolvedValue({ _sum: { totalAmount: 60 }, _count: { _all: 2 } });
    h.db.store.findMany.mockResolvedValue([{ country: { minorUnit: 2 } }]);
    const res = await lookup(new Request('https://oms.test/api/v1/customers/lookup?phone=0936654998'));
    const answer = await res.json();
    expect(answer).toEqual({
      exists: true,
      blacklisted: false,
      orders_count: 3,
      delivered_count: 2,
      total_value: '60.00',
    });
  });

  it('and says «blocked» when they are, because that is what stops a promise', async () => {
    h.db.customer.findMany.mockResolvedValue([]);
    h.activeBlock.mockResolvedValue({ id: 'b1', reason: 'رفض ثلاث شحنات' });
    const answer = await (
      await lookup(new Request('https://oms.test/api/v1/customers/lookup?phone=0936654998'))
    ).json();
    expect(answer).toEqual({
      exists: false,
      blacklisted: true,
      orders_count: 0,
      total_value: '0.00',
    });
    // The REASON is still the seller's, not the calling system's.
    expect(JSON.stringify(answer)).not.toContain('رفض');
  });

  it('and the value is what was DELIVERED, not what was ordered', async () => {
    /*
     * Summing every order ever typed would count the ones the customer
     * refused at the door — and a customer who refuses four parcels would
     * read as the shop's best.
     */
    h.db.customer.findMany.mockResolvedValue([{ id: 'cust_1', totalOrders: 9, storeId: 's1' }]);
    h.db.order.aggregate.mockResolvedValue({ _sum: { totalAmount: 15 }, _count: { _all: 1 } });
    h.db.store.findMany.mockResolvedValue([{ country: { minorUnit: 2 } }]);
    await lookup(new Request('https://oms.test/api/v1/customers/lookup?phone=0936654998'));
    expect(h.db.order.aggregate.mock.calls[0][0].where).toMatchObject({
      companyId: 'c1',
      shippingStatus: 'DELIVERED',
      store: { isTest: false },
    });
  });

  it('and a missing phone is a 422, not an empty answer that reads as «unknown»', async () => {
    const res = await lookup(new Request('https://oms.test/api/v1/customers/lookup'));
    expect(res.status).toBe(422);
    expect((await res.json()).error.details).toEqual({ field: 'phone' });
    expect(h.db.customer.findMany).not.toHaveBeenCalled();
  });
});
