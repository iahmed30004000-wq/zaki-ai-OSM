import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE MEDIA BUYER'S READ — `GET /api/v1/orders/attribution` and the
 * catalogue's `?fields=`.
 *
 * The media buyer (its own system, its own database) decides where ad
 * money goes on THIS system's truth. It reads; it never writes here. What
 * this file proves, by running the handlers with the REAL key guard:
 *
 *   · the answer is the contract's shape, field for field
 *   · not one field about the customer leaves — not even when the row
 *     read from the database carries one
 *   · the cursor walks every order exactly once and says when it is done
 *   · the company is the token's, whatever the query string claims
 *   · the replies system's key is refused both reads, and the media
 *     buyer's key is refused everything it was not given
 * ═══════════════════════════════════════════════════════════════════════
 */

const h = vi.hoisted(() => ({
  db: {
    systemToken: { findUnique: vi.fn(), update: vi.fn() },
    order: { findMany: vi.fn(), findFirst: vi.fn() },
    orderItem: { findMany: vi.fn(), aggregate: vi.fn() },
    product: { findMany: vi.fn() },
    productionBatch: { findMany: vi.fn() },
  },
  rateLimit: vi.fn(),
  activeOffersFor: vi.fn(),
  availableStock: vi.fn(),
  reservedElsewhere: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db: h.db }));
vi.mock('@/lib/rate-limit', () => ({ rateLimit: (...a: unknown[]) => h.rateLimit(...a) }));
vi.mock('@/lib/offers', () => ({ activeOffersFor: (...a: unknown[]) => h.activeOffersFor(...a) }));
vi.mock('@/lib/reservation', () => ({
  availableStock: (...a: unknown[]) => h.availableStock(...a),
  reservedElsewhere: (...a: unknown[]) => h.reservedElsewhere(...a),
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validate } from '../apps/contract';
import { GET as getAttribution } from '@/app/api/v1/orders/attribution/route';
import { GET as getProducts } from '@/app/api/v1/products/route';
import { CORE_STATES } from '../order-state';
import { ATTRIBUTION_SELECT, MAX_WINDOW_DAYS, STATUS_OF, decodeCursor, encodeCursor } from './attribution';
import { PRODUCT_FIELDS } from './product-figures';
import { MEDIABUYER_SCOPES, REPLIES_SCOPES, V1_SCOPES, V1_SYSTEMS } from './system-token';

/** The fields the media buyer's adapter parses (`zaki-mediabuyer/src/adapters/oms.ts`) plus `first_contact_at`. */
const CONTRACT_FIELDS = [
  'ad_id', 'ad_name', 'adset_id', 'campaign_id', 'canceled_at', 'capi_ref', 'channel', 'collected',
  'confirmed_at', 'country', 'created_at', 'currency', 'delivered_at', 'first_contact_at', 'is_fake',
  'landing_page', 'order_id', 'order_value', 'product_code', 'returned_at', 'shipped_at', 'status',
];

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
  new Request(`https://oms.test${path}`, {
    headers: { authorization: 'Bearer zk1_test', 'x-request-id': 'mb_1' },
  });

/** An order row as the select would return it. */
function orderRow(over: Record<string, unknown> = {}) {
  return {
    id: 'o1',
    orderNumber: 'SY-0001',
    confirmationStatus: 'CONFIRMED',
    shippingStatus: 'NOT_READY',
    claimedById: null,
    shippedAt: null,
    labelPrintedAt: null,
    confirmedAt: new Date('2026-10-26T05:00:00Z'),
    deliveredAt: null,
    returnedAt: null,
    createdAt: new Date('2026-10-26T04:00:00Z'),
    updatedAt: new Date('2026-10-26T05:00:00Z'),
    totalAmount: 20,
    collectedAmount: null,
    currency: 'USD',
    rejectionReason: null,
    source: 'Landing Page',
    externalChannel: null,
    adId: '120211000000000001',
    landingPageId: 'lp1',
    product: { sku: 'TRF01' },
    channel: { kind: 'LANDING_PAGE' },
    campaign: { externalId: '120210000000000009' },
    landingPage: { slug: 'kamaa-eye-water', domain: null, domainVerifiedAt: null },
    store: { country: { code: 'SY', timezone: 'Asia/Damascus', minorUnit: 2 } },
    statusLogs: [],
    contactAttempts: [{ createdAt: new Date('2026-10-26T04:30:00Z') }],
    ...over,
  };
}

const SINCE = '/api/v1/orders/attribution?updated_since=2026-10-26T00:00:00Z';

beforeEach(() => {
  vi.clearAllMocks();
  // The 31-day window is measured from «now»: the clock is pinned so the
  // fixed dates below stay inside it whatever day the suite runs.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-26T12:00:00Z'));
  h.rateLimit.mockReturnValue({ allowed: true, remaining: 59, retryAfterSec: 0 });
  h.db.systemToken.update.mockResolvedValue({});
  h.db.systemToken.findUnique.mockResolvedValue(tokenRow(MEDIABUYER_SCOPES));
  h.db.order.findMany.mockResolvedValue([orderRow()]);
  h.db.product.findMany.mockResolvedValue([]);
  h.db.productionBatch.findMany.mockResolvedValue([]);
  h.activeOffersFor.mockResolvedValue([]);
  h.availableStock.mockResolvedValue(20);
  h.reservedElsewhere.mockResolvedValue(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the attribution answer is the contract, field for field', () => {
  it('has exactly the fields the media buyer reads, and the envelope {items, next_cursor}', async () => {
    const res = await getAttribution(call(SINCE));
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Request-Id')).toBe('mb_1');
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['items', 'next_cursor']);
    expect(Object.keys(body.items[0]).sort()).toEqual(CONTRACT_FIELDS);
  });

  it('with the values from the order’s own columns, money as decimal strings', async () => {
    const [item] = (await (await getAttribution(call(SINCE))).json()).items;
    expect(item).toMatchObject({
      order_id: 'o1',
      product_code: 'TRF01',
      country: 'SY',
      channel: 'landing_page',
      ad_id: '120211000000000001',
      campaign_id: '120210000000000009',
      adset_id: null,
      ad_name: null,
      status: 'confirmed',
      order_value: '20.00',
      collected: null,
      currency: 'USD',
      is_fake: false,
      capi_ref: null,
    });
    // ISO 8601 with the country's offset — Damascus is +03:00.
    expect(item.created_at).toBe('2026-10-26T07:00:00+03:00');
    expect(item.confirmed_at).toBe('2026-10-26T08:00:00+03:00');
    expect(item.first_contact_at).toBe('2026-10-26T07:30:00+03:00');
    expect(item.landing_page).toMatch(/\/lp\/kamaa-eye-water$/);
  });

  it('collected is the door figure on a partial delivery, the total on a whole one', async () => {
    h.db.order.findMany.mockResolvedValue([
      orderRow({ id: 'a', shippingStatus: 'DELIVERED', deliveredAt: new Date('2026-10-26T06:00:00Z') }),
      orderRow({ id: 'b', shippingStatus: 'PARTIALLY_DELIVERED', collectedAmount: { toString: () => '12.5' } }),
    ]);
    const { items } = await (await getAttribution(call(SINCE))).json();
    expect(items.map((i: { status: string; collected: string }) => [i.status, i.collected])).toEqual([
      ['delivered', '20.00'],
      ['delivered', '12.50'],
    ]);
  });

  it('a moment no column recorded is read from the status log', async () => {
    h.db.order.findMany.mockResolvedValue([
      orderRow({
        confirmationStatus: 'CANCELLED',
        confirmedAt: null,
        statusLogs: [
          { newValue: 'CONFIRMED', createdAt: new Date('2026-10-26T05:00:00Z') },
          { newValue: 'CANCELLED', createdAt: new Date('2026-10-26T06:00:00Z') },
        ],
      }),
    ]);
    const [item] = (await (await getAttribution(call(SINCE))).json()).items;
    expect(item.status).toBe('canceled');
    expect(item.confirmed_at).toBe('2026-10-26T08:00:00+03:00');
    expect(item.canceled_at).toBe('2026-10-26T09:00:00+03:00');
  });

  it('a fake order says so', async () => {
    h.db.order.findMany.mockResolvedValue([
      orderRow({ confirmationStatus: 'REJECTED', rejectionReason: 'FAKE_ORDER' }),
    ]);
    const [item] = (await (await getAttribution(call(SINCE))).json()).items;
    expect(item).toMatchObject({ status: 'canceled', is_fake: true });
  });
});

describe('fourteen states onto six', () => {
  it('every core state has a word, and only the contract’s six words are used', () => {
    for (const s of CORE_STATES) expect(STATUS_OF[s], s).toBeDefined();
    expect(new Set(Object.values(STATUS_OF))).toEqual(
      new Set(['new', 'confirmed', 'shipped', 'delivered', 'returned', 'canceled'])
    );
  });

  it('nothing still with the call centre counts as confirmed', () => {
    for (const s of ['NEW', 'CLAIMED', 'NO_ANSWER', 'POSTPONED'] as const) expect(STATUS_OF[s]).toBe('new');
  });

  it('a parcel on its way back is still shipped until it is received', () => {
    expect(STATUS_OF.WAITING_RETURN).toBe('shipped');
    expect(STATUS_OF.RETURNED).toBe('returned');
  });
});

describe('not one byte about the customer', () => {
  it('the select reads no customer, address, note or sealed id', () => {
    const keys = Object.keys(ATTRIBUTION_SELECT);
    for (const forbidden of [
      'customer', 'customerId', 'deliveryAddress', 'internalNotes', 'customerNotes', 'notes',
      'ctwaClidEnc', 'psidEnc', 'conversationRef', 'refCode',
    ]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });

  it('and even a row that carried one does not pass it on', async () => {
    // A widened select one day must still not reach the answer: the item is
    // built field by field, never spread.
    h.db.order.findMany.mockResolvedValue([
      orderRow({
        customer: { fullName: 'أبو أحمد', phone: '0936654998', address: 'حلب، الفرقان' },
        deliveryAddress: 'حلب، الفرقان، بناء 4',
        ctwaClidEnc: 'v2:sealed',
        internalNotes: 'اتصل 0936654998',
      }),
    ]);
    const text = await (await getAttribution(call(SINCE))).text();
    expect(text).not.toMatch(/0936654998|أبو أحمد|الفرقان|sealed|fullName|phone|address/);
  });
});

describe('the cursor walks every order once', () => {
  it('a full page hands back a cursor; the last page hands back null', async () => {
    const rows = ['a', 'b', 'c'].map((id, i) =>
      orderRow({ id, updatedAt: new Date(Date.UTC(2026, 9, 26, 5, 0, i)) })
    );
    h.db.order.findMany.mockResolvedValueOnce(rows);
    const first = await (await getAttribution(call(`${SINCE}&limit=2`))).json();
    expect(first.items.map((i: { order_id: string }) => i.order_id)).toEqual(['a', 'b']);
    expect(first.next_cursor).toEqual(expect.any(String));
    // Asked for one more than the page to know whether another exists.
    expect(h.db.order.findMany.mock.calls[0][0].take).toBe(3);

    h.db.order.findMany.mockResolvedValueOnce([rows[2]]);
    const second = await (
      await getAttribution(call(`${SINCE}&limit=2&cursor=${encodeURIComponent(first.next_cursor)}`))
    ).json();
    expect(second.items.map((i: { order_id: string }) => i.order_id)).toEqual(['c']);
    expect(second.next_cursor).toBeNull();

    // The second query starts strictly after (updatedAt, id) of b.
    const where = h.db.order.findMany.mock.calls[1][0].where;
    expect(where.OR).toEqual([
      { updatedAt: { gt: rows[1].updatedAt } },
      { updatedAt: rows[1].updatedAt, id: { gt: 'b' } },
    ]);
    expect(h.db.order.findMany.mock.calls[1][0].orderBy).toEqual([{ updatedAt: 'asc' }, { id: 'asc' }]);
  });

  it('round-trips, and a cursor this door did not issue is a 422, not a 500', async () => {
    const at = new Date('2026-10-26T05:00:00.123Z');
    expect(decodeCursor(encodeCursor(at, 'o9'))).toEqual({ updatedAt: at, id: 'o9' });
    const res = await getAttribution(call(`${SINCE}&cursor=not-a-cursor`));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'cursor' } });
  });

  it('updated_since is required and must be a date', async () => {
    for (const q of ['', '?updated_since=yesterday']) {
      const res = await getAttribution(call(`/api/v1/orders/attribution${q}`));
      expect(res.status, q).toBe(422);
      expect((await res.json()).error.details).toEqual({ field: 'updated_since' });
    }
    expect(h.db.order.findMany).not.toHaveBeenCalled();
  });

  it('a page is never larger than 200, whatever is asked', async () => {
    await getAttribution(call(`${SINCE}&limit=100000`));
    expect(h.db.order.findMany.mock.calls[0][0].take).toBe(201);
  });
});

describe('the company is the token’s', () => {
  it('whatever the query string names, and a test bench is not the business', async () => {
    await getAttribution(call(`${SINCE}&companyId=c2&company_id=c2`));
    const where = h.db.order.findMany.mock.calls[0][0].where;
    expect(where.companyId).toBe('c1');
    expect(where.store).toEqual({ isTest: false });
    expect(where.updatedAt).toEqual({ gte: new Date('2026-10-26T00:00:00Z') });
  });

  it('and another company’s key reads its own company only', async () => {
    h.db.systemToken.findUnique.mockResolvedValue(tokenRow(MEDIABUYER_SCOPES, { companyId: 'c2' }));
    await getAttribution(call(SINCE));
    expect(h.db.order.findMany.mock.calls[0][0].where.companyId).toBe('c2');
  });
});

describe('each key reads what it was given and nothing else', () => {
  it('the replies system’s key is refused the attribution read', async () => {
    h.db.systemToken.findUnique.mockResolvedValue(tokenRow(REPLIES_SCOPES, { system: 'replies' }));
    const res = await getAttribution(call(SINCE));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatchObject({
      code: 'SCOPE_MISSING',
      details: { required: 'orders.attribution.read' },
    });
    expect(h.db.order.findMany).not.toHaveBeenCalled();
  });

  it('and the cost figures, before any product is read', async () => {
    h.db.systemToken.findUnique.mockResolvedValue(tokenRow(REPLIES_SCOPES, { system: 'replies' }));
    for (const f of ['unit_cost_usd', 'stock_days', 'delivery_fee', 'return_fee', 'cod_fee_pct']) {
      const res = await getProducts(call(`/api/v1/products?fields=code,name,${f}`));
      expect(res.status, f).toBe(403);
      expect((await res.json()).error.details.required).toBe('products.costs.read');
    }
    expect(h.db.product.findMany).not.toHaveBeenCalled();
  });

  it('the media buyer’s key is read-only: three scopes, none that writes or looks up a number', () => {
    expect([...MEDIABUYER_SCOPES].sort()).toEqual(['orders.attribution.read', 'products.costs.read', 'products.read']);
    for (const s of ['orders.create', 'orders.note', 'customers.lookup', 'orders.read']) {
      expect(MEDIABUYER_SCOPES).not.toContain(s);
    }
    // And the replies system did not gain the new two.
    expect(REPLIES_SCOPES).not.toContain('orders.attribution.read');
    expect(REPLIES_SCOPES).not.toContain('products.costs.read');
    for (const s of MEDIABUYER_SCOPES) expect(V1_SCOPES).toContain(s);
    expect(V1_SYSTEMS.map((s) => s.key)).toEqual(['replies', 'mediabuyer', 'landing']);
  });

  it('a key with orders.attribution.read alone may not read the catalogue', async () => {
    h.db.systemToken.findUnique.mockResolvedValue(tokenRow(['orders.attribution.read']));
    const res = await getProducts(call('/api/v1/products'));
    expect(res.status).toBe(403);
  });
});

describe('the catalogue’s ?fields= adds, and never takes away', () => {
  const product = {
    id: 'p1',
    sku: 'TRF01',
    name: 'ماء الكمأة',
    nameEn: 'KamaaEye',
    basePrice: 20,
    storeId: 's1',
    store: { country: { currencyCode: 'USD', minorUnit: 2 } },
  };

  it('without fields the item is what it always was', async () => {
    h.db.product.findMany.mockResolvedValue([product]);
    const { items } = await (await getProducts(call('/api/v1/products'))).json();
    expect(Object.keys(items[0]).sort()).toEqual(
      ['code', 'complements', 'currency', 'discount_cap', 'name', 'offers', 'price', 'stock_status', 'wholesale_price']
    );
    expect(h.db.productionBatch.findMany).not.toHaveBeenCalled();
  });

  it('with them, each asked-for field is added beside the old ones', async () => {
    h.db.product.findMany.mockResolvedValue([product]);
    h.activeOffersFor.mockResolvedValue([
      { name: '2 قطع', quantity: 2, price: 35, listPrice: 40, endsAt: null },
    ]);
    // productCosts' query: one batch of 10 left at 3.25 a unit.
    h.db.productionBatch.findMany.mockResolvedValue([
      { productId: 'p1', quantityRemaining: 10, costPerUnit: 3.25, productionDate: new Date('2026-10-01') },
    ]);
    h.db.order.findFirst.mockResolvedValue(null);
    h.db.orderItem.findMany.mockResolvedValue([]);

    const res = await getProducts(
      call('/api/v1/products?fields=code,name,aliases,unit_cost_usd,price_options,stock_days,delivery_fee,return_fee,cod_fee_pct')
    );
    expect(res.status).toBe(200);
    const [item] = (await res.json()).items;
    expect(item).toMatchObject({
      code: 'TRF01',
      price: '20.00',
      stock_status: 'IN_STOCK',
      aliases: ['KamaaEye'],
      unit_cost_usd: '3.25',
      price_options: [
        { title: null, quantity: 1, price: '20.00' },
        { title: '2 قطع', quantity: 2, price: '35.00' },
      ],
      // No delivery record yet: a cover cannot be stated, so it is not.
      stock_days: null,
      // No single source per product — said as null, never guessed.
      delivery_fee: null,
      return_fee: null,
      cod_fee_pct: null,
    });
  });

  it('a cost kept in another currency is not converted at a made-up rate', async () => {
    h.db.product.findMany.mockResolvedValue([
      { ...product, store: { country: { currencyCode: 'SYP', minorUnit: 2 } } },
    ]);
    h.db.productionBatch.findMany.mockResolvedValue([
      { productId: 'p1', quantityRemaining: 10, costPerUnit: 30000, productionDate: new Date('2026-10-01') },
    ]);
    const [item] = (await (await getProducts(call('/api/v1/products?fields=unit_cost_usd'))).json()).items;
    expect(item.unit_cost_usd).toBeNull();
  });

  it('a product with no costed stock is unknown, not free', async () => {
    h.db.product.findMany.mockResolvedValue([product]);
    const [item] = (await (await getProducts(call('/api/v1/products?fields=unit_cost_usd'))).json()).items;
    expect(item.unit_cost_usd).toBeNull();
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * THE OWNER'S SAFETY RULES (2026-10-26): «بدنا حل جذري… ما بدنا نخرب ع حالنا»
 * ───────────────────────────────────────────────────────────────────────── */

describe('it cannot overload production', () => {
  it('updated_since more than 31 days back is refused before any query', async () => {
    const old = new Date(Date.now() - (MAX_WINDOW_DAYS + 1) * 86_400_000).toISOString();
    const res = await getAttribution(call(`/api/v1/orders/attribution?updated_since=${old}`));
    expect(res.status).toBe(422);
    expect((await res.json()).error.details).toEqual({ field: 'updated_since', max_days: 31 });
    expect(h.db.order.findMany).not.toHaveBeenCalled();
  });

  it('just inside 31 days is still allowed', async () => {
    const edge = new Date(Date.now() - MAX_WINDOW_DAYS * 86_400_000 + 1000).toISOString();
    expect((await getAttribution(call(`/api/v1/orders/attribution?updated_since=${edge}`))).status).toBe(200);
  });

  it('the key’s own allowance is enforced: over it is 429 with Retry-After, and no query', async () => {
    h.rateLimit.mockReturnValue({ allowed: false, remaining: 0, retryAfterSec: 42 });
    h.db.systemToken.findUnique.mockResolvedValue(tokenRow(MEDIABUYER_SCOPES, { rateLimitPerMin: 30 }));
    const res = await getAttribution(call(SINCE));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('42');
    expect(h.rateLimit).toHaveBeenCalledWith('v1:tok_mb', 30, 60_000);
    expect(h.db.order.findMany).not.toHaveBeenCalled();
  });
});

describe('stopping the key stops every call on the next request', () => {
  it('a key revoked between two calls: the first is answered, the second refused at both doors', async () => {
    expect((await getAttribution(call(SINCE))).status).toBe(200);
    h.db.systemToken.findUnique.mockResolvedValue(tokenRow(MEDIABUYER_SCOPES, { revokedAt: new Date() }));
    h.db.order.findMany.mockClear();
    for (const res of [await getAttribution(call(SINCE)), await getProducts(call('/api/v1/products'))]) {
      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe('TOKEN_INVALID');
    }
    expect(h.db.order.findMany).not.toHaveBeenCalled();
    expect(h.db.product.findMany).not.toHaveBeenCalled();
  });

  it('and an expired key the same', async () => {
    h.db.systemToken.findUnique.mockResolvedValue(tokenRow(MEDIABUYER_SCOPES, { expiresAt: new Date(Date.now() - 1000) }));
    expect((await getAttribution(call(SINCE))).status).toBe(401);
  });
});

describe('no customer data, ever — under any key name, at any depth', () => {
  const FORBIDDEN_KEY = /^(?:name|full_?name|customer\w*|phone|raw_?phone|alt_?phone|address|delivery_?address|city|email)$/i;
  const keysDeep = (v: unknown, out: string[] = []): string[] => {
    if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        out.push(k);
        keysDeep(x, out);
      }
    }
    return out;
  };

  it('the attribution answer carries no name, phone, address, rawPhone or altPhone key', async () => {
    h.db.order.findMany.mockResolvedValue([
      orderRow({
        customer: { fullName: 'أبو أحمد', phone: '0936654998', rawPhone: '0936654998', altPhone: '0944000000', address: 'حلب' },
      }),
    ]);
    const body = await (await getAttribution(call(SINCE))).json();
    expect(keysDeep(body).filter((k) => FORBIDDEN_KEY.test(k))).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(/09[0-9]{8}|\+?9639[0-9]{8}/);
  });

  it('and capi_ref is opaque: null, or an enc: reference — never a readable number', async () => {
    const { items } = await (await getAttribution(call(SINCE))).json();
    for (const i of items) expect(i.capi_ref === null || /^enc:[A-Za-z0-9_-]+$/.test(i.capi_ref)).toBe(true);
  });
});

describe('the frozen contract — contracts/oms-mediabuyer.v1', () => {
  type Schema = Record<string, unknown>;
  const DIR = join(process.cwd(), 'contracts', 'oms-mediabuyer.v1');
  const file = (n: string) => JSON.parse(readFileSync(join(DIR, n), 'utf8'));

  /** `validate` does not descend into `items`; this walks the arrays it skips. */
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
  const check = (schema: Schema, value: unknown) => [...validate(schema, value), ...arrays(schema, value, 'root')];

  const ATTR = file('attribution-page.schema.json');
  const PROD = file('products-page.schema.json');

  it('the golden pages fit their schemas', () => {
    expect(check(ATTR, file('attribution-page.example.json'))).toEqual([]);
    expect(check(PROD, file('products-page.example.json'))).toEqual([]);
  });

  it('and the checker is not vacuous: a field too many, a field missing, a wrong type all fail', () => {
    const page = file('attribution-page.example.json');
    const first = page.items[0];
    expect(check(ATTR, { ...page, items: [{ ...first, phone: '0936654998' }] }).length).toBeGreaterThan(0);
    const noStatus = { ...first };
    delete noStatus.status;
    expect(check(ATTR, { ...page, items: [noStatus] }).length).toBeGreaterThan(0);
    expect(check(ATTR, { ...page, items: [{ ...first, order_value: 20 }] }).length).toBeGreaterThan(0);
    expect(check(ATTR, { ...page, items: [{ ...first, capi_ref: '0936654998' }] }).length).toBeGreaterThan(0);
  });

  it('what the door answers today fits the contract — every kind of order', async () => {
    h.db.order.findMany.mockResolvedValue([
      orderRow(),
      orderRow({
        id: 'b',
        shippingStatus: 'PARTIALLY_DELIVERED',
        collectedAmount: { toString: () => '12.5' },
        deliveredAt: new Date('2026-10-26T06:00:00Z'),
      }),
      orderRow({ id: 'c', confirmationStatus: 'REJECTED', rejectionReason: 'FAKE_ORDER', adId: null, campaign: null, landingPage: null, contactAttempts: [] }),
      orderRow({ id: 'd', currency: 'JOD', store: { country: { code: 'JO', timezone: 'Asia/Amman', minorUnit: 3 } }, totalAmount: 25 }),
    ]);
    expect(check(ATTR, await (await getAttribution(call(SINCE))).json())).toEqual([]);
  });

  it('and so does the catalogue, without fields and with every one', async () => {
    h.db.product.findMany.mockResolvedValue([
      { id: 'p1', sku: 'TRF01', name: 'ماء الكمأة', nameEn: 'KamaaEye', basePrice: 20, storeId: 's1', store: { country: { currencyCode: 'USD', minorUnit: 2 } } },
    ]);
    h.activeOffersFor.mockResolvedValue([{ name: '2 قطع', quantity: 2, price: 35, listPrice: 40, endsAt: null }]);
    h.db.order.findFirst.mockResolvedValue(null);
    h.db.orderItem.findMany.mockResolvedValue([]);
    expect(check(PROD, await (await getProducts(call('/api/v1/products'))).json())).toEqual([]);
    const all = `/api/v1/products?fields=code,name,${PRODUCT_FIELDS.join(',')}`;
    expect(check(PROD, await (await getProducts(call(all))).json())).toEqual([]);
  });

  it('every optional field the door can add is declared in the contract', () => {
    const declared = Object.keys(PROD.properties.items.items.properties);
    for (const f of PRODUCT_FIELDS) expect(declared, f).toContain(f);
  });
});
