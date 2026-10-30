import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE NUMBER THE PREVIEW PROMISES IS THE NUMBER THE SAVE WRITES.
 *
 * Two places that compute one figure agree today and part ways tomorrow, and the person who pays for it is the one
 * who told the customer what she would be asked for. So the same lines go through BOTH: the preview (the lines
 * engine, reading the order from the database) and the real `PATCH /api/orders/[id]` (the door that writes it), over
 * one fake that holds the order, and the two are held equal on every figure the save writes:
 *
 *      after.cod             === order.totalAmount        (what the courier collects)
 *      after.subtotal        === order.sellingPrice
 *      after.discount        === order.discountAmount
 *      after.discountShares  === items[].discountShare
 *      lines[].totalAfter…   === items[].lineTotal
 *
 * in the three currencies the system holds, with a discount, with the add-ons the customer accepted, and with a
 * price that includes delivery. The save is the real route with the real `computeCod`; only the database is a fake.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Row = Record<string, any>;

const { fake, requireContext, logAudit, notify, availableStock, activeOffersFor } = vi.hoisted(() => {
  const fake = {
    order: {} as Row,
    offerRow: null as Row | null,
    lines: [] as Row[],
    products: [] as Row[],
    addOns: [] as Row[],
    attempts: 1,
    activities: [] as Row[],
    transactions: 0,
    db: null as unknown,
  };

  /** A `where` read the way Prisma reads it, for the few shapes this door sends. */
  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([key, want]) => {
      if (key === 'AND') return (want as Row[]).every((w) => matches(row, w));
      if (key === 'OR') return (want as Row[]).some((w) => matches(row, w));
      if (want !== null && typeof want === 'object') {
        for (const op of Object.keys(want)) {
          if (op !== 'in' && op !== 'gt') throw new Error(`fake db: «${op}» on ${key} is not modelled`);
        }
        if ('in' in want && !(want.in as unknown[]).includes(row[key])) return false;
        if ('gt' in want && !(typeof row[key] === 'number' && row[key] > want.gt)) return false;
        return true;
      }
      return row[key] === want;
    });

  const pick = (row: Row, select?: Row): Row => {
    if (!select) return { ...row };
    return Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]));
  };

  type Answer = (args: Row) => unknown;

  const WINDOW: Record<string, (asked: Row) => unknown> = {
    items: (asked) => fake.lines.map((l) => pick(l, asked.select)),
    _count: () => ({ contactAttempts: fake.attempts, deliveryAttempts: 0 }),
    addOns: () => fake.addOns.map((a) => ({ ...a })),
    commissions: () => [], claimHistory: () => [], callLogs: () => [],
    activities: () => [], telegramMessages: () => [],
    customer: () => null, product: () => null, offer: () => null, region: () => null,
    deliveryProvider: () => null, landingPage: () => null, moderator: () => null,
    shippingBatch: () => null,
    claimer: () => null, owner: () => null, lockHolder: () => null, signer: () => null,
  };

  const answers: Record<string, Record<string, Answer>> = {
    order: {
      findUnique: (args) => {
        if (args.select) throw new Error('fake db: order.findUnique with a select is not modelled');
        if (args.where?.id !== fake.order.id) return null;
        if (!args.include) return { ...fake.order };
        const row: Row = { ...fake.order };
        for (const [key, asked] of Object.entries(args.include as Row)) {
          const answer = WINDOW[key];
          if (!answer) throw new Error(`fake db: order.findUnique asked for «${key}», which this fake does not hold`);
          row[key] = answer(asked === true ? {} : (asked as Row));
        }
        return row;
      },
      findFirst: ({ where, select, include }) => {
        if (select || include) throw new Error('fake db: order.findFirst with relations is not modelled');
        return matches(fake.order, where) ? { ...fake.order } : null;
      },
      updateMany: ({ where, data }) => {
        if (where.id !== fake.order.id || where.version !== fake.order.version) return { count: 0 };
        const { version, ...columns } = data;
        if (version?.increment !== 1) throw new Error('fake db: an order write that does not move the version');
        Object.assign(fake.order, columns, { version: fake.order.version + 1 });
        return { count: 1 };
      },
    },
    orderItem: {
      findFirst: ({ where, select }) => {
        const hit = fake.lines.find((l) => matches(l, where));
        return hit ? pick(hit, select) : null;
      },
      findMany: ({ where, select }) => fake.lines.filter((l) => matches(l, where)).map((l) => pick(l, select)),
      deleteMany: ({ where }) => {
        const kept = fake.lines.filter((l) => !matches(l, where));
        const count = fake.lines.length - kept.length;
        fake.lines = kept;
        return { count };
      },
      createMany: ({ data }) => {
        for (const row of data as Row[]) {
          fake.lines.push({ id: `line-new-${fake.lines.length + 1}`, createdAt: new Date(0), reservedQty: 0, deliveredQty: null, returnedQty: null, ...row });
        }
        return { count: (data as Row[]).length };
      },
    },
    product: {
      findMany: ({ where, select }) => fake.products.filter((p) => matches(p, where)).map((p) => pick(p, select)),
    },
    orderAddOn: { findMany: ({ where }) => fake.addOns.filter((a) => matches(a, where)).map((a) => ({ ...a })) },
    shippingBatch: { findFirst: () => null },
    offer: { findFirst: () => fake.offerRow },
    settlementMatch: { count: () => 0 },
    returnReceipt: { count: () => 0 },
    orderContactAttempt: { count: ({ where }) => (where.orderId === fake.order.id ? fake.attempts : 0) },
    orderActivity: {
      create: ({ data }) => {
        fake.activities.push(data);
        return { id: `activity-${fake.activities.length}`, ...data };
      },
    },
  };

  const client = () => {
    const held: Row = {};
    const model = (key: string, methods: Record<string, Answer>) =>
      new Proxy(
        {},
        {
          get: (_t, method) => {
            if (typeof method === 'symbol' || method === 'then') return undefined;
            return async (args: Row = {}) => {
              const answer = methods[method];
              if (!answer) throw new Error(`fake db: no answer for ${key}.${method}`);
              return answer(args);
            };
          },
        }
      );
    for (const [key, methods] of Object.entries(answers)) held[key] = model(key, methods);
    return new Proxy(held, {
      get: (target, key) => {
        if (typeof key === 'symbol' || key === 'then') return undefined;
        if (key in target) return target[key];
        if (key.startsWith('$')) {
          return () => {
            throw new Error(`fake db: ${key} is not modelled`);
          };
        }
        return model(key, {});
      },
    });
  };

  const db = client();
  const tx = client();
  (db as Row).$transaction = async (fn: (t: unknown) => Promise<unknown>) => {
    fake.transactions += 1;
    const before = { order: { ...fake.order }, lines: fake.lines.map((l) => ({ ...l })), activities: [...fake.activities] };
    try {
      return await fn(tx);
    } catch (e) {
      fake.order = before.order;
      fake.lines = before.lines;
      fake.activities = before.activities;
      throw e;
    }
  };
  fake.db = db;

  return {
    fake,
    requireContext: vi.fn(),
    logAudit: vi.fn(),
    notify: vi.fn(),
    availableStock: vi.fn<(...a: unknown[]) => Promise<number>>(),
    activeOffersFor: vi.fn<(...a: unknown[]) => Promise<Row[]>>(),
  };
});

vi.mock('@/lib/db', () => ({ db: fake.db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/notify', () => ({ notify: (...a: unknown[]) => notify(...a) }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: vi.fn() }));
vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn() }));
// The shelf and the offers are the test's to set: plenty on the shelf and nothing on sale unless a test says otherwise.
vi.mock('@/lib/reservation', async (original) => ({
  ...(await original<typeof import('@/lib/reservation')>()),
  availableStock: (...a: unknown[]) => availableStock(...a),
}));
vi.mock('@/lib/offers', async (original) => ({
  ...(await original<typeof import('@/lib/offers')>()),
  activeOffersFor: (...a: unknown[]) => activeOffersFor(...a),
}));

import { PATCH } from './route';
import { previewOrderEdit } from '@/lib/order-edit-facts';
import type { OrderEditPreview, PreviewDraft } from '@/lib/order-line-edit';

const COMPANY = 'company-0001';
const STORE = 'store-0001';
const ORDER_ID = 'id-ord-2026-0044';
const CREAM = 'prod-cream-01';
const SOAP = 'prod-soap-02';
const DROPS = 'prod-drops-03';

const AGENT = {
  id: 'agent-reem-01',
  name: 'ريم',
  role: 'CONFIRMATION_AGENT',
  email: 'agent@osm.local',
  status: 'ACTIVE',
  companyId: COMPANY,
  permissions: [] as string[],
  effectiveGrants: {
    fullAccess: false,
    grants: { 'orders.view': { scope: 'ASSIGNED' }, 'orders.edit': { scope: 'ASSIGNED' }, 'orders.change_price': { scope: 'ASSIGNED' } },
  },
};

const JOD = { id: 'country-jo', code: 'JO', currencyCode: 'JOD', minorUnit: 3, allowNegativeStock: false };
const USD = { id: 'country-iq', code: 'IQ', currencyCode: 'USD', minorUnit: 2, allowNegativeStock: false };
const SYP = { id: 'country-sy', code: 'SY', currencyCode: 'SYP', minorUnit: 0, allowNegativeStock: false };

const line = (over: Row): Row => ({
  companyId: COMPANY, orderId: ORDER_ID, discountShare: 0, reservedQty: 0, deliveredQty: null, returnedQty: null,
  addedById: null, addedStage: 'INTAKE', createdAt: new Date(0), ...over,
});

const baseOrder = (country: Row, over: Row = {}): Row => ({
  id: ORDER_ID, orderNumber: 'ORD-2026-0044', companyId: COMPANY, storeId: STORE, countryId: country.id,
  customerId: 'customer-0044', productId: CREAM, productNameSnapshot: 'كريم',
  quantity: 5, freeQuantity: 1, sellingPrice: 46, discountAmount: 0, shippingCost: 2.5, deliveryFee: null, totalAmount: 48.5,
  priceIncludesDelivery: false, version: 7, status: 'CONTACTING', confirmationStatus: 'IN_PROGRESS', shippingStatus: 'NOT_READY',
  settlementStatus: 'NOT_APPLICABLE', signatureStatus: 'UNSIGNED', shippedAt: null, labelPrintedAt: null, deliveredAt: null,
  confirmedAt: null, moderatorId: null, createdById: null, assignedToId: null, claimedById: AGENT.id, currentOwnerId: AGENT.id,
  lockedById: null, lockExpiresAt: null, deliveryProviderId: null, regionId: null, customerNotes: null, internalNotes: null,
  trackingNumber: null, courierSendStartedAt: null, offerId: null,
  ...over,
});

/** The order as three-place JOD holds it: كريم 3 for 36, صابون 2 for 10. */
const seed = (country: Row, scale: number, over: Row = {}) => {
  fake.order = baseOrder(country, over);
  fake.lines = [
    line({ id: 'line-cream-01', productId: CREAM, productName: 'كريم', quantity: 3, freeQuantity: 1, unitPrice: (36 * scale) / 3, lineTotal: 36 * scale }),
    line({ id: 'line-soap-02', productId: SOAP, productName: 'صابون', quantity: 2, freeQuantity: 0, unitPrice: (10 * scale) / 2, lineTotal: 10 * scale }),
  ];
  fake.products = [
    { id: CREAM, companyId: COMPANY, name: 'كريم', basePrice: 12 * scale, status: 'ACTIVE' },
    { id: SOAP, companyId: COMPANY, name: 'صابون', basePrice: 5 * scale, status: 'ACTIVE' },
    { id: DROPS, companyId: COMPANY, name: 'قطرة', basePrice: 8.5 * scale, status: 'ACTIVE' },
  ];
  fake.order.sellingPrice = 46 * scale;
  fake.order.shippingCost = 2.5 * scale;
  fake.order.totalAmount = 46 * scale + 2.5 * scale;
};

/** What the preview says, and then what the real save writes for the same lines. */
const bothWays = async (country: typeof JOD, draft: PreviewDraft) => {
  const order = { ...fake.order };
  const preview: OrderEditPreview = await previewOrderEdit({
    order: order as any,
    companyId: COMPANY,
    country,
    draft,
  });

  // The save takes each line as its TOTAL before the discount, which is exactly what the preview reports.
  const body: Row = {
    expectedVersion: order.version,
    items: preview.lines.map((l) => ({ productId: l.productId.to, quantity: l.quantity.to, unitPrice: String(l.lineTotal.to) })),
    discountAmount: draft.discountAmount ?? Number(order.discountAmount ?? 0),
  };
  requireContext.mockResolvedValue({ user: AGENT, companyId: COMPANY, storeId: STORE, countryId: country.id, country });
  const res = await PATCH(
    new Request(`http://localhost/api/orders/${ORDER_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: ORDER_ID }) }
  );
  const saved = (await res.json()) as Row;
  expect(res.status, JSON.stringify(saved)).toBe(200);
  return { preview, written: { order: fake.order, lines: fake.lines } };
};

const holds = (preview: OrderEditPreview, written: { order: Row; lines: Row[] }) => {
  expect(written.order.totalAmount, 'ما يجمعه الكاشير ≠ ما وعدت به المعاينة').toBe(preview.after.cod);
  expect(written.order.sellingPrice).toBe(preview.after.subtotal);
  expect(written.order.discountAmount).toBe(preview.after.discount);
  expect(written.lines.map((l) => l.discountShare)).toEqual(preview.after.discountShares);
  expect(written.lines.map((l) => l.lineTotal)).toEqual(preview.lines.map((l) => l.totalAfterDiscount));
  expect(written.lines.map((l) => l.quantity)).toEqual(preview.lines.map((l) => l.quantity.to));
};

beforeEach(() => {
  vi.clearAllMocks();
  fake.attempts = 1;
  fake.offerRow = null;
  availableStock.mockResolvedValue(100_000);
  activeOffersFor.mockResolvedValue([]);
  fake.addOns = [];
  fake.activities = [];
  fake.transactions = 0;
  logAudit.mockResolvedValue(undefined);
  notify.mockResolvedValue(undefined);
});

describe('Ⅰ · the same lines, the preview and the save', () => {
  it('JOD: quantity and price together — 3 for 36 becomes 5 for 58, a second line swapped, 3.500 off', async () => {
    seed(JOD, 1);
    const { preview, written } = await bothWays(JOD, {
      lines: [{ lineId: 'line-cream-01', quantity: 5, lineTotal: 58 }, { lineId: 'line-soap-02', productId: DROPS, unitPrice: 6.5 }],
      discountAmount: 3.5,
    });
    // 58 + 13 = 71 subtotal; 3.5 off; 2.5 to deliver → 70
    expect(preview.after.cod).toBe(70);
    holds(preview, written);
  });

  it('JOD: a quantity alone re-prices at the line’s own piece price, and a discount that does not divide', async () => {
    seed(JOD, 1);
    const { preview, written } = await bothWays(JOD, {
      lines: [{ lineId: 'line-cream-01', quantity: 7 }, { lineId: 'line-soap-02', quantity: 3 }],
      discountAmount: 6.8,
    });
    // 84 + 15 = 99; shares 84/99 × 6.8 = 5.770 and 15/99 × 6.8 = 1.030
    expect(preview.after.subtotal).toBe(99);
    expect(preview.after.discountShares).toEqual([5.77, 1.03]);
    holds(preview, written);
  });

  it('JOD: «٣ بـ٢٥» — a line stored as 25 for three is 41.667 for five, and the save writes the same', async () => {
    seed(JOD, 1);
    fake.lines[0] = line({ id: 'line-cream-01', productId: CREAM, productName: 'كريم', quantity: 3, freeQuantity: 0, unitPrice: 8.333, lineTotal: 25 });
    fake.order.sellingPrice = 35;
    fake.order.totalAmount = 37.5;
    const { preview, written } = await bothWays(JOD, { lines: [{ lineId: 'line-cream-01', quantity: 5 }] });
    expect(preview.lines[0].lineTotal.to).toBe(41.667);
    holds(preview, written);
  });

  it('USD: two places, the shares sum to the discount', async () => {
    seed(USD, 1);
    const { preview, written } = await bothWays(USD, {
      lines: [{ lineId: 'line-cream-01', quantity: 4 }, { lineId: 'line-soap-02', quantity: 5 }],
      discountAmount: 7,
    });
    expect(preview.after.discountShares.reduce((a, b) => a + b, 0)).toBeCloseTo(7, 2);
    holds(preview, written);
  });

  it('SYP: no minor unit — whole pounds, the remainder on the largest line', async () => {
    seed(SYP, 1000);
    const { preview, written } = await bothWays(SYP, {
      lines: [{ lineId: 'line-cream-01', quantity: 4 }, { lineId: 'line-soap-02', quantity: 3 }],
      discountAmount: 7001,
    });
    expect(Number.isInteger(preview.after.cod)).toBe(true);
    holds(preview, written);
  });

  it('with the add-ons the customer accepted: they are collected, and not discounted', async () => {
    seed(JOD, 1);
    fake.addOns = [{ companyId: COMPANY, orderId: ORDER_ID, productId: DROPS, quantity: 2, price: 4, reservedQty: 0 }];
    fake.order.totalAmount = 56.5;
    const { preview, written } = await bothWays(JOD, {
      lines: [{ lineId: 'line-cream-01', quantity: 5 }],
      discountAmount: 4,
    });
    expect(preview.after.addOns).toBe(8);
    holds(preview, written);
  });

  it('a price that includes delivery: the total is the net, and both agree', async () => {
    seed(JOD, 1, { priceIncludesDelivery: true });
    fake.order.totalAmount = 46;
    const { preview, written } = await bothWays(JOD, { lines: [{ lineId: 'line-cream-01', quantity: 6 }] });
    expect(preview.after.cod).toBe(preview.after.subtotal);
    holds(preview, written);
  });

  it('a discount alone, with no line touched: the same shares the save re-spreads', async () => {
    seed(JOD, 1);
    const { preview, written } = await bothWays(JOD, { discountAmount: 4.1 });
    holds(preview, written);
  });

  it('two lines of one product: each is its own line in the preview and in the save', async () => {
    seed(JOD, 1);
    fake.lines[1] = line({ id: 'line-cream-02', productId: CREAM, productName: 'كريم', quantity: 2, freeQuantity: 0, unitPrice: 5, lineTotal: 10 });
    const { preview, written } = await bothWays(JOD, { lines: [{ lineId: 'line-cream-02', quantity: 6 }] });
    expect(preview.lines.map((l) => l.quantity.to)).toEqual([3, 6]);
    holds(preview, written);
  });

  it('after a save, the preview of the order as it now stands is a preview of NO change at the same number', async () => {
    seed(JOD, 1);
    const first = await bothWays(JOD, { lines: [{ lineId: 'line-cream-01', quantity: 5, lineTotal: 58 }], discountAmount: 3 });
    holds(first.preview, first.written);
    const again = await previewOrderEdit({ order: { ...fake.order } as any, companyId: COMPANY, country: JOD, draft: {} });
    expect(again.after.cod).toBe(again.before.cod);
    expect(again.before.cod).toBe(first.written.order.totalAmount);
    expect(again.problems.map((p) => p.code)).not.toContain('COD_DRIFT');
  });
});

describe('Ⅱ · and where they are meant to differ, they say so', () => {
  it('a stored total that is not the lines’ total is reported as drift — the save would silently rewrite it', async () => {
    seed(JOD, 1);
    fake.order.totalAmount = 51;
    const preview = await previewOrderEdit({
      order: { ...fake.order } as any, companyId: COMPANY, country: JOD, draft: { lines: [{ lineId: 'line-cream-01', quantity: 4 }] },
    });
    expect(preview.problems.map((p) => p.code)).toContain('COD_DRIFT');
  });
});

/*
 * ═══════════════════════════════════════════════════════════════════════
 * THE THREE THINGS THE FIRST HALF DID NOT VARY — a real offer on sale, a shelf that is short, and an order whose
 * delivery fee is written twice and differently. The first half feeds the save the preview's own line totals, with
 * plenty on the shelf, nothing on sale and one fee: a test that agrees with itself on the easy case.
 * ═══════════════════════════════════════════════════════════════════════
 */
describe('Ⅲ · a real offer, a short shelf, two fees', () => {
  const offerRow = {
    id: 'offer-3-plus-1', productId: CREAM, name: '3 + 1', quantity: 3, freeQuantity: 1, sellingPrice: 25,
    discount: 0, compareAtPrice: null, isDefault: false, deliveryIncluded: true, endsAt: null,
  };
  const onSale = [{ id: 'offer-3-plus-1', name: '3 + 1', quantity: 3, freeQuantity: 1, price: 25, listPrice: null }];

  it('an order taken on the offer: 3 + 1 for 25 becomes 6 + 2 for 50 — the offer’s price, and the save writes the same total', async () => {
    seed(JOD, 1, { offerId: 'offer-3-plus-1' });
    fake.offerRow = offerRow;
    activeOffersFor.mockImplementation(async (...a: unknown[]) => (a[2] === CREAM ? onSale : []));
    fake.lines[0] = line({ id: 'line-cream-01', productId: CREAM, productName: 'كريم', quantity: 3, freeQuantity: 1, unitPrice: 8.333, lineTotal: 25 });
    fake.order.sellingPrice = 35;
    fake.order.totalAmount = 37.5;

    const { preview, written } = await bothWays(JOD, { lines: [{ lineId: 'line-cream-01', quantity: 6 }] });
    // by hand: two bundles of 25 = 50, the soap 10, 2.5 to deliver
    expect(preview.lines[0]).toMatchObject({ lineTotal: { to: 50 }, freeQuantity: { to: 2 }, basis: 'OFFER', offerId: 'offer-3-plus-1' });
    expect(preview.after.cod).toBe(62.5);
    expect(preview.problems.filter((p) => p.blocking)).toEqual([]);
    holds(preview, written);
  });

  it('the same order with the offer ended: the piece price is kept (8.333 × 6 → 50), the gift stays, and it is said', async () => {
    seed(JOD, 1, { offerId: 'offer-3-plus-1' });
    fake.offerRow = offerRow;
    fake.lines[0] = line({ id: 'line-cream-01', productId: CREAM, productName: 'كريم', quantity: 3, freeQuantity: 1, unitPrice: 8.333, lineTotal: 25 });
    fake.order.sellingPrice = 35;
    fake.order.totalAmount = 37.5;
    const { preview, written } = await bothWays(JOD, { lines: [{ lineId: 'line-cream-01', quantity: 6 }] });
    expect(preview.lines[0]).toMatchObject({ lineTotal: { to: 50 }, freeQuantity: { to: 1 }, basis: 'KEEP_UNIT' });
    expect(preview.problems.map((p) => p.code)).toContain('OFFER_ENDED');
    holds(preview, written);
  });

  it('a short shelf on a confirmed order: the preview refuses what the shelf cannot give — without saying how much it holds', async () => {
    seed(JOD, 1, { confirmationStatus: 'CONFIRMED', settlementStatus: 'PENDING_COLLECTION' });
    availableStock.mockImplementation(async (...a: unknown[]) => (a[2] === CREAM ? 6 : 100_000));
    const preview = await previewOrderEdit({
      order: { ...fake.order } as any, companyId: COMPANY, country: JOD, draft: { lines: [{ lineId: 'line-cream-01', quantity: 9 }] },
    });
    // 9 + 1 gift = 10 against 6
    expect(preview.stock.find((s) => s.productId === CREAM)).toMatchObject({ status: 'SHORT_BLOCKED', enough: false });
    expect(preview.blocked).toBe(true);
    expect(JSON.stringify(preview)).not.toMatch(/"needed"|"missing"|"available"/);
    // …and the same order with shelf enough goes through
    availableStock.mockResolvedValue(100_000);
    const fine = await previewOrderEdit({
      order: { ...fake.order } as any, companyId: COMPANY, country: JOD, draft: { lines: [{ lineId: 'line-cream-01', quantity: 9 }] },
    });
    expect(fine.blocked).toBe(false);
  });

  it('two delivery fees on one order (3.500 from the courier table, 2.500 on the order): the preview refuses, because the save would not collect the courier’s fee', async () => {
    seed(JOD, 1, { deliveryFee: 3.5 });
    const order = { ...fake.order };
    const preview = await previewOrderEdit({
      order: order as any, companyId: COMPANY, country: JOD, draft: { lines: [{ lineId: 'line-cream-01', quantity: 5 }] },
    });
    expect(preview.problems.find((p) => p.code === 'FEE_SOURCE_DRIFT')!.blocking).toBe(true);
    expect(preview.blocked).toBe(true);

    // What the save does with those same lines, were it let through: 60 + 10 = 70, and 2.500 on top — the order's own
    // fee, not the courier's 3.500. That one-dinar gap is the reason for the refusal.
    requireContext.mockResolvedValue({ user: AGENT, companyId: COMPANY, storeId: STORE, countryId: JOD.id, country: JOD });
    const res = await PATCH(
      new Request(`http://localhost/api/orders/${ORDER_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedVersion: order.version,
          items: preview.lines.map((l) => ({ productId: l.productId.to, quantity: l.quantity.to, unitPrice: String(l.lineTotal.to) })),
        }),
      }),
      { params: Promise.resolve({ id: ORDER_ID }) }
    );
    expect(res.status).toBe(200);
    expect(fake.order.totalAmount).toBe(72.5);
    expect(fake.order.totalAmount).not.toBe(70 + 3.5);
  });
});
