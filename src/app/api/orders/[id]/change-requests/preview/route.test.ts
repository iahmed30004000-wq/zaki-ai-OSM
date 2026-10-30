import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE PREVIEW OF AN ORDER EDIT — a read that answers before anybody asks.
 *
 * `POST /api/orders/:id/change-requests/preview` takes a draft and says what the order would be, what each product
 * would do to the shelf and what is wrong with it. The things it must be held to:
 *
 *   · it WRITES NOTHING — the database handed to it fails the run on any create, update, delete, upsert or raw call;
 *   · it has the raise door's key and the raise door's 404 (an order of another store is not there);
 *   · it is rate-limited per person;
 *   · it never answers with the shelf's whole balance, or with the customer's fields it was given.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Row = Record<string, any>;

const { fake, requireContext, assertOrderAccess, can, availableStock, activeOffersFor } = vi.hoisted(() => {
  const WRITE_METHODS = ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'];
  const fake = {
    items: [] as Row[],
    addOns: [] as Row[],
    products: [] as Row[],
    offerRow: null as Row | null,
    settlementMatches: 0,
    dupeCustomer: null as Row | null,
    region: { id: 'region-1' } as Row | null,
    calls: [] as string[],
    queries: [] as Array<{ model: string; method: string; where: Row | undefined }>,
    writes: [] as string[],
    db: null as unknown,
  };

  const read = (model: string, method: string, impl: (args: Row) => unknown) => async (args: Row = {}) => {
    fake.calls.push(`${model}.${method}`);
    fake.queries.push({ model, method, where: args.where });
    return impl(args);
  };

  const models: Record<string, Row> = {
    orderItem: { findMany: read('orderItem', 'findMany', () => fake.items.map((r) => ({ ...r }))) },
    orderAddOn: { findMany: read('orderAddOn', 'findMany', () => fake.addOns.map((r) => ({ ...r }))) },
    product: {
      findMany: read('product', 'findMany', ({ where }) => fake.products.filter((p) => where.id.in.includes(p.id) && p.companyId === where.companyId)),
    },
    offer: { findFirst: read('offer', 'findFirst', () => fake.offerRow) },
    shippingBatch: { findFirst: read('shippingBatch', 'findFirst', () => null) },
    settlementMatch: { count: read('settlementMatch', 'count', () => fake.settlementMatches) },
    customer: { findFirst: read('customer', 'findFirst', () => fake.dupeCustomer) },
    region: { findFirst: read('region', 'findFirst', () => fake.region) },
    deliveryFee: { findFirst: read('deliveryFee', 'findFirst', () => null) },
  };

  // A model nobody gave an answer for refuses, and a WRITE refuses loudly and is remembered.
  const db = new Proxy(
    {},
    {
      get: (_t, name) => {
        if (typeof name === 'symbol' || name === 'then') return undefined;
        if (name.startsWith('$')) {
          return () => {
            fake.writes.push(`db.${name}`);
            throw new Error(`the preview touched db.${name}`);
          };
        }
        return new Proxy(models[name] ?? {}, {
          get: (target, method) => {
            if (typeof method === 'symbol' || method === 'then') return undefined;
            if (WRITE_METHODS.includes(method)) {
              return () => {
                fake.writes.push(`${name}.${method}`);
                throw new Error(`the preview wrote: ${name}.${method}`);
              };
            }
            if (method in target) return target[method];
            return async () => {
              throw new Error(`fake db: no answer for ${name}.${method}`);
            };
          },
        });
      },
    }
  );
  fake.db = db;

  return {
    fake,
    requireContext: vi.fn(),
    assertOrderAccess: vi.fn(),
    can: vi.fn<(...a: unknown[]) => boolean>(),
    availableStock: vi.fn<(...a: unknown[]) => Promise<number>>(),
    activeOffersFor: vi.fn<(...a: unknown[]) => Promise<Row[]>>(),
  };
});

vi.mock('@/lib/db', () => ({ db: fake.db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/rbac', () => ({ assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a) }));
vi.mock('@/lib/authorization', () => ({ can: (...a: unknown[]) => can(...a) }));
vi.mock('@/lib/reservation', () => ({ availableStock: (...a: unknown[]) => availableStock(...a) }));
vi.mock('@/lib/offers', async (original) => ({
  ...(await original<typeof import('@/lib/offers')>()),
  activeOffersFor: (...a: unknown[]) => activeOffersFor(...a),
}));

import { POST } from './route';
import { ORDER_WORK_DOOR } from '@/lib/order-work-door';

const COMPANY = 'company-0001';
const STORE = 'store-0001';
const ORDER_ID = 'order-0001';
const CREAM = 'prod-cream-0001';
const SOAP = 'prod-soap-00002';
const SHELF = 1_234_567;

const JOD = { id: 'country-jo', code: 'JO', currencyCode: 'JOD', minorUnit: 3, allowNegativeStock: false };

let userCounter = 0;
const newUser = () => ({ id: `user-${++userCounter}`, name: 'ريم', role: 'CONFIRMATION_AGENT' });

const orderRow = (over: Row = {}): Row => ({
  id: ORDER_ID,
  companyId: COMPANY,
  storeId: STORE,
  countryId: JOD.id,
  customerId: 'customer-1',
  regionId: null,
  deliveryProviderId: null,
  confirmationStatus: 'CONFIRMED',
  shippingStatus: 'NOT_READY',
  shippedAt: null,
  labelPrintedAt: null,
  trackingNumber: null,
  courierSendStartedAt: null,
  settlementStatus: 'PENDING_COLLECTION',
  priceIncludesDelivery: false,
  totalAmount: 48.5,
  shippingCost: 2.5,
  deliveryFee: null,
  discountAmount: 0,
  offerId: null,
  version: 7,
  ...over,
});

const item = (over: Row): Row => ({
  productName: 'كريم',
  freeQuantity: 0,
  unitPrice: 12,
  discountShare: 0,
  reservedQty: 0,
  deliveredQty: null,
  returnedQty: null,
  ...over,
});

const ask = async (draft: unknown, id = ORDER_ID) => {
  const res = await POST(
    new Request(`http://localhost/api/orders/${id}/change-requests/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
    }),
    { params: Promise.resolve({ id }) }
  );
  return { status: res.status, headers: res.headers, body: (await res.json()) as Row };
};

beforeEach(() => {
  vi.clearAllMocks();
  fake.items = [
    item({ id: 'line-1', productId: CREAM, quantity: 3, freeQuantity: 1, unitPrice: 12, lineTotal: 36, reservedQty: 4 }),
    item({ id: 'line-2', productId: SOAP, productName: 'صابون', quantity: 2, unitPrice: 5, lineTotal: 10, reservedQty: 2 }),
  ];
  fake.addOns = [];
  fake.products = [
    { id: CREAM, companyId: COMPANY, name: 'كريم', basePrice: 12, status: 'ACTIVE' },
    { id: SOAP, companyId: COMPANY, name: 'صابون', basePrice: 5, status: 'ACTIVE' },
  ];
  fake.offerRow = null;
  fake.settlementMatches = 0;
  fake.dupeCustomer = null;
  fake.region = { id: 'region-1' };
  fake.calls = [];
  fake.queries = [];
  fake.writes = [];
  requireContext.mockResolvedValue({ user: newUser(), companyId: COMPANY, storeId: STORE, countryId: JOD.id, country: JOD });
  can.mockReturnValue(true);
  assertOrderAccess.mockResolvedValue({ allowed: true, order: orderRow() });
  availableStock.mockResolvedValue(SHELF);
  activeOffersFor.mockResolvedValue([]);
});

describe('Ⅰ · who may ask', () => {
  it('an order of another store is not there: 404, with the raise door’s own words, and nothing is read', async () => {
    assertOrderAccess.mockResolvedValue({ allowed: false, reason: 'NOT_FOUND' });
    const res = await ask({ lines: [{ lineId: 'line-1', quantity: 4 }] });
    expect(res.status).toBe(404);
    expect(res.body.errorAr).toMatch(/[؀-ۿ]/);
    expect(fake.calls).toEqual([]);
  });

  it('asks the access check through the WORK door, in this company and store', async () => {
    await ask({});
    const [id, , scope, door] = assertOrderAccess.mock.calls[0] as unknown[];
    expect(id).toBe(ORDER_ID);
    expect(scope).toEqual({ companyId: COMPANY, storeId: STORE });
    expect(door).toBe(ORDER_WORK_DOOR);
  });

  it('without the key to raise a request: 403, REQUEST_CHANGE_FORBIDDEN, and nothing is read', async () => {
    can.mockImplementation((...a: unknown[]) => a[1] !== 'orders.request_change');
    const res = await ask({ lines: [{ lineId: 'line-1', quantity: 4 }] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('REQUEST_CHANGE_FORBIDDEN');
    expect(fake.calls).toEqual([]);
    expect(can).toHaveBeenCalledWith(expect.anything(), 'orders.request_change');
  });

  it('the 404 comes before the 403: a person is not told an order exists by being refused on it', async () => {
    assertOrderAccess.mockResolvedValue({ allowed: false, reason: 'NOT_FOUND' });
    can.mockReturnValue(false);
    expect((await ask({})).status).toBe(404);
  });
});

describe('Ⅱ · how often', () => {
  it('ninety previews a minute, the ninety-first is 429 with a Retry-After — and another person is not charged for it', async () => {
    const user = newUser();
    requireContext.mockResolvedValue({ user, companyId: COMPANY, storeId: STORE, countryId: JOD.id, country: JOD });
    let last = { status: 0, headers: new Headers(), body: {} as Row };
    for (let i = 0; i < 90; i++) {
      last = await ask({});
      expect(last.status).toBe(200);
    }
    last = await ask({});
    expect(last.status).toBe(429);
    expect(last.body.code).toBe('RATE_LIMITED');
    expect(Number(last.headers.get('Retry-After'))).toBeGreaterThan(0);

    requireContext.mockResolvedValue({ user: newUser(), companyId: COMPANY, storeId: STORE, countryId: JOD.id, country: JOD });
    expect((await ask({})).status).toBe(200);
  });
});

describe('Ⅲ · the draft', () => {
  it('a price typed two ways at once is 400, in Arabic, and nothing is read', async () => {
    const res = await ask({ lines: [{ lineId: 'line-1', unitPrice: 5, lineTotal: 15 }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DRAFT');
    expect(res.body.errorAr).toMatch(/[؀-ۿ]/);
    expect(fake.calls).toEqual([]);
  });

  it('not JSON at all is 400 too, not 500', async () => {
    const res = await POST(new Request('http://localhost/x', { method: 'POST', body: 'not json' }), { params: Promise.resolve({ id: ORDER_ID }) });
    expect(res.status).toBe(400);
  });
});

describe('Ⅳ · the answer', () => {
  it('quantity, price and discount together: before, after, the lines and the shelf', async () => {
    const res = await ask({
      lines: [{ lineId: 'line-1', quantity: 5, lineTotal: 58 }, { lineId: 'line-2', quantity: 4 }],
      discountAmount: 3,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const b = res.body;
    // before: 36 + 10 + 2.5 = 48.500
    expect(b.before).toMatchObject({ subtotal: 46, discount: 0, deliveryFee: 2.5, cod: 48.5, giftUnits: 1 });
    // after: line 1 is 58, line 2 is 20 (5 each, four pieces): 78 − 3 + 2.5 = 77.500
    expect(b.after).toMatchObject({ subtotal: 78, discount: 3, deliveryFee: 2.5, cod: 77.5, giftUnits: 1 });
    expect(b.after.discountShares.reduce((a: number, c: number) => a + c, 0)).toBe(3);
    expect(b.lines).toHaveLength(2);
    expect(b.lines[0]).toMatchObject({ lineId: 'line-1', changed: true, quantity: { from: 3, to: 5 }, lineTotal: { from: 36, to: 58 }, basis: 'MANUAL' });
    expect(b.stock.map((s: Row) => [s.productId, s.status])).toEqual([[CREAM, 'ENOUGH'], [SOAP, 'ENOUGH']]);
    expect(b).toMatchObject({ blocked: false, door: 'REQUEST', orderVersion: 7, minorUnit: 3 });
    expect(Array.isArray(b.suggestions)).toBe(true);
    expect(Array.isArray(b.problems)).toBe(true);
  });

  it('the shelf is asked the way the reservation asks it: this order’s own holding left out, no store named', async () => {
    await ask({ lines: [{ lineId: 'line-1', quantity: 5 }] });
    const calls = availableStock.mock.calls as unknown[][];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) {
      expect(c[1]).toBe(COMPANY);
      expect(c[3]).toBe(ORDER_ID);
      expect(c).toHaveLength(4);
    }
    expect(calls.map((c) => c[2]).sort()).toEqual([CREAM, SOAP].sort());
  });

  it('a shortage on the shelf is reported as a number missing, and blocks the request — without the balance', async () => {
    availableStock.mockImplementation(async (...a: unknown[]) => (a[2] === CREAM ? 5 : SHELF));
    const res = await ask({ lines: [{ lineId: 'line-1', quantity: 9 }] });
    expect(res.status).toBe(200);
    const cream = res.body.stock.find((s: Row) => s.productId === CREAM);
    // 9 + 1 gift = 10 needed against 5: five missing
    expect(cream).toMatchObject({ status: 'SHORT_BLOCKED', needed: 10, missing: 5, enough: false });
    expect(res.body.blocked).toBe(true);
    expect(res.body.problems.find((p: Row) => p.code === 'STOCK_SHORT_BLOCKED').blocking).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/"available"/);
  });

  it('never answers with the shelf’s whole balance, or with the customer’s fields it was handed', async () => {
    const res = await ask({
      lines: [{ lineId: 'line-1', quantity: 5 }],
      customerName: 'سامر الأحمد',
      customerPhone: '0791234567',
      customerAddress: 'شارع الجامعة، عمّان',
    });
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(String(SHELF));
    expect(text).not.toContain('سامر');
    expect(text).not.toContain('0791234567');
    expect(text).not.toContain('الجامعة');
  });

  it('a phone another customer already holds is refused — by the code, not by naming them', async () => {
    fake.dupeCustomer = { id: 'customer-2', fullName: 'خالد المصري' };
    const res = await ask({ customerPhone: '0791234567' });
    expect(res.status).toBe(200);
    expect(res.body.problems.map((p: Row) => p.code)).toContain('DUPLICATE_PHONE');
    expect(JSON.stringify(res.body)).not.toContain('خالد');
    expect(res.body.blocked).toBe(true);
  });

  it('a governorate of another country is refused', async () => {
    fake.region = null;
    const res = await ask({ regionId: '11111111-1111-4111-8111-111111111111' });
    expect(res.body.problems.map((p: Row) => p.code)).toContain('REGION_NOT_IN_COUNTRY');
  });

  it('an order a courier statement claims is refused for a money draft: the statement writes the money', async () => {
    fake.settlementMatches = 1;
    const res = await ask({ lines: [{ lineId: 'line-1', quantity: 5 }] });
    expect(res.body.problems.find((p: Row) => p.code === 'STATEMENT_LINKED').blocking).toBe(true);
    expect(res.body.blocked).toBe(true);
  });

  it('every read that can be scoped to the company is: the lines, the add-ons, the products, the trolley, the statements, the customers', async () => {
    await ask({ lines: [{ lineId: 'line-1', quantity: 4 }], customerPhone: '0791234567' });
    for (const model of ['orderItem', 'orderAddOn', 'product', 'shippingBatch', 'settlementMatch', 'customer']) {
      const reads = fake.queries.filter((q) => q.model === model);
      expect(reads.length, `${model} ما انقرا`).toBeGreaterThan(0);
      for (const q of reads) expect(q.where?.companyId, `${model}.${q.method} بلا حدّ الشركة`).toBe(COMPANY);
    }
    // and the lines are this order's own
    expect(fake.queries.find((q) => q.model === 'orderItem')!.where?.orderId).toBe(ORDER_ID);
    expect(fake.queries.find((q) => q.model === 'orderAddOn')!.where?.orderId).toBe(ORDER_ID);
  });

  it('an order that is not confirmed is edited in place: the door is DIRECT and the shelf blocks nothing', async () => {
    assertOrderAccess.mockResolvedValue({ allowed: true, order: orderRow({ confirmationStatus: 'IN_PROGRESS' }) });
    availableStock.mockResolvedValue(0);
    const res = await ask({ lines: [{ lineId: 'line-1', quantity: 9 }] });
    expect(res.body.door).toBe('DIRECT');
    expect(res.body.stock.every((s: Row) => s.status === 'NOT_HELD')).toBe(true);
    expect(res.body.blocked).toBe(false);
  });

  it('the order’s offer, ended or not on sale, is read from its own row and reported as ended', async () => {
    fake.offerRow = {
      id: 'offer-1', productId: CREAM, name: '3+1', quantity: 3, freeQuantity: 1, sellingPrice: 36,
      discount: 0, compareAtPrice: null, isDefault: false, deliveryIncluded: true, endsAt: new Date(Date.now() - 1000),
    };
    assertOrderAccess.mockResolvedValue({ allowed: true, order: orderRow({ offerId: 'offer-1' }) });
    const res = await ask({ lines: [{ lineId: 'line-1', quantity: 6 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.problems.map((p: Row) => p.code)).toContain('OFFER_ENDED');
    expect(res.body.lines[0].freeQuantity).toEqual({ from: 1, to: 1 });
  });

  it('a live offer of the order prices the new quantity by the bundle and moves the gift with it', async () => {
    fake.offerRow = {
      id: 'offer-1', productId: CREAM, name: '3+1', quantity: 3, freeQuantity: 1, sellingPrice: 36,
      discount: 0, compareAtPrice: null, isDefault: false, deliveryIncluded: true, endsAt: null,
    };
    activeOffersFor.mockImplementation(async (...a: unknown[]) =>
      a[2] === CREAM ? [{ id: 'offer-1', name: '3+1', quantity: 3, freeQuantity: 1, price: 36, listPrice: null }] : []
    );
    assertOrderAccess.mockResolvedValue({ allowed: true, order: orderRow({ offerId: 'offer-1' }) });
    const res = await ask({ lines: [{ lineId: 'line-1', quantity: 6 }] });
    expect(res.body.lines[0]).toMatchObject({ lineTotal: { from: 36, to: 72 }, freeQuantity: { from: 1, to: 2 }, basis: 'OFFER', offerId: 'offer-1' });
    expect(res.body.after.giftUnits).toBe(2);
    // the gift is stock, not money: 72 + 10 + 2.5
    expect(res.body.after.cod).toBe(84.5);
  });
});

describe('Ⅴ · it is a read', () => {
  it('not one write reaches the database — on a rich draft, a refused draft and a blocked one alike', async () => {
    fake.settlementMatches = 1;
    fake.dupeCustomer = { id: 'x' };
    for (const draft of [
      {},
      { lines: [{ lineId: 'line-1', quantity: 9, lineTotal: 10 }, { lineId: 'ghost' }], discountAmount: 500, customerPhone: '0791234567', regionId: '11111111-1111-4111-8111-111111111111' },
      { lines: [{ lineId: 'line-1', unitPrice: 1, lineTotal: 2 }] },
    ]) {
      await ask(draft);
    }
    expect(fake.writes).toEqual([]);
  });

  it('and the guard would notice: a write on this database is remembered and throws', async () => {
    const db = fake.db as Row;
    expect(() => db.order.update({})).toThrow(/preview wrote/);
    expect(() => db.$transaction(() => {})).toThrow(/touched/);
    expect(fake.writes).toEqual(['order.update', 'db.$transaction']);
  });
});
