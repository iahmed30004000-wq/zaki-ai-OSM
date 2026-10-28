import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE LABELED DOOR, AGAINST A DATABASE THAT REMEMBERS WHAT WAS WRITTEN.
 *
 * In the style of `store-scope.test.ts`, but the fake keeps rows: a refusal is proved by what is NOT in the tables
 * afterwards (no customer, no order, no line), and the money by the rows that are — then carried to the shipment through
 * the same `codForOrder` the shipments route calls, with a delivery fee the order never saw.
 *
 * The owner, 28/10: «أريده يسحب الطلبات بهذه الصيغة … ولازم يكون مكتوب بهذي الصيغة عشان يرتفع كطلب جديد» and
 * «لا الكمية يعني قطعتين فقط ولا تربطها بالعرض بل اربطها بقطع المنتج نفسو» — and then: «اريد التنسيق يقبل كل انواع الارقام
 * والمفتاح السوري … واريد كمان يكون نص العرض مربوط بالعرض» («اذا الرقم غير صالح مثل 12 خلي الطلب بخانة المراجعة»).
 * So the offer is a REAL offer of the product, priced by the storefront door's own functions, and the phone is read leniently.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a fake table row: every test reads its own fields
type Row = Record<string, any>;

const { db, state, gate } = vi.hoisted(() => {
  const state = {
    messages: [] as Row[],
    sources: [] as Row[],
    products: [] as Row[],
    customers: [] as Row[],
    blocks: [] as Row[],
    orders: [] as Row[],
    items: [] as Row[],
    regions: [] as Row[],
    offers: [] as Row[],
    storePolicy: false,
    country: { id: 'country-sy', code: 'SY', name: 'سوريا', currencyCode: 'USD', minorUnit: 2, orderPrefix: 'SY' },
    seq: 0,
    storeWrites: 0,
  };
  /** Holds every transaction at its door until `waitFor` of them are inside — two presses at the same moment. */
  const gate = { waitFor: 1, inside: 0, open: () => {}, opened: Promise.resolve() };

  const sourceOf = (m: Row) => state.sources.find((s) => s.id === m.sourceId) ?? null;
  const matchesScope = (m: Row, cond: Row): boolean => {
    if ('sourceId' in cond) return m.sourceId === cond.sourceId;
    if (cond.source) return (sourceOf(m)?.storeId ?? null) === cond.source.storeId;
    return true;
  };
  const statusMatches = (row: Row, want: unknown) =>
    want === undefined || (typeof want === 'string' ? row.processingStatus === want : (want as { in: string[] }).in.includes(row.processingStatus));
  const phoneMatches = (row: Row, want: unknown) =>
    typeof want === 'string' ? row.phone === want : (want as { in: string[] }).in.includes(row.phone);

  const db: Row = {
    telegramMessage: {
      findUnique: vi.fn(async ({ where }: Row) => {
        const m = state.messages.find((x) => x.id === where.id);
        return m ? { ...m } : null;
      }),
      findFirst: vi.fn(async ({ where }: Row) => {
        const m = state.messages.find(
          (x) => x.id === where.id && x.companyId === where.companyId && (!where.OR || where.OR.some((c: Row) => matchesScope(x, c)))
        );
        return m ? { ...m } : null;
      }),
      update: vi.fn(async ({ where, data }: Row) => Object.assign(state.messages.find((x) => x.id === where.id)!, data)),
      updateMany: vi.fn(async ({ where, data }: Row) => {
        const m = state.messages.find((x) => x.id === where.id);
        if (!m) return { count: 0 };
        if (where.companyId && m.companyId !== where.companyId) return { count: 0 };
        if ('orderId' in where && where.orderId === null && m.orderId != null) return { count: 0 };
        if (!statusMatches(m, where.processingStatus)) return { count: 0 };
        Object.assign(m, data);
        return { count: 1 };
      }),
      findMany: vi.fn(async ({ where }: Row) =>
        state.messages
          .filter((m) => m.companyId === where.companyId)
          .filter((m) => !where.id?.not || m.id !== where.id.not)
          .filter((m) => statusMatches(m, where.processingStatus))
          .filter((m) => !(where.orderId && 'not' in where.orderId) || m.orderId != null)
          .filter((m) => !where.createdAt?.gte || m.createdAt >= where.createdAt.gte)
          .filter((m) => !where.source || (sourceOf(m)?.storeId ?? null) === where.source.storeId)
          .filter((m) => !where.OR || where.OR.some((c: Row) => String(m.text ?? '').includes(c.text.contains)))
          .map((m) => {
            const order = state.orders.find((o) => o.id === m.orderId);
            return { text: m.text, order: order ? { id: order.id, orderNumber: order.orderNumber, productId: order.productId } : null };
          })
      ),
    },
    telegramSource: {
      findUnique: vi.fn(async ({ where }: Row) => {
        const s = state.sources.find((x) => x.id === where.id);
        if (!s) return null;
        return { storeId: s.storeId, store: s.storeId ? { country: { ...state.country } } : null };
      }),
    },
    product: {
      findMany: vi.fn(async ({ where }: Row) =>
        state.products.filter(
          (p) =>
            p.companyId === where.companyId &&
            (!('storeId' in where) || p.storeId === where.storeId) &&
            (where.status === undefined || p.status === where.status)
        )
      ),
      findFirst: vi.fn(async ({ where }: Row) => {
        const p = state.products.find((x) => x.id === where.id && x.companyId === where.companyId);
        return p ? { ...p, batches: [] } : null;
      }),
    },
    customerBlock: {
      findFirst: vi.fn(
        async ({ where }: Row) => state.blocks.find((b) => b.companyId === where.companyId && phoneMatches(b, where.phone)) ?? null
      ),
    },
    customer: {
      findFirst: vi.fn(
        async ({ where }: Row) =>
          state.customers.find((c) => c.companyId === where.companyId && c.storeId === where.storeId && phoneMatches(c, where.phone)) ??
          null
      ),
      create: vi.fn(async ({ data }: Row) => {
        // The unique index on (company, store, phone): the loser of a race reads the winner's row.
        if (state.customers.some((c) => c.companyId === data.companyId && c.storeId === data.storeId && c.phone === data.phone)) {
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        }
        const row = { id: `cu${++state.seq}`, firstOrderDate: null, totalOrders: 0, ...data };
        state.customers.push(row);
        return row;
      }),
      update: vi.fn(async () => ({})),
    },
    user: { findFirst: vi.fn(async () => ({ id: 'actor', role: 'COMPANY_ADMIN' })) },
    store: {
      findFirst: vi.fn(async ({ where, select }: Row) => {
        if (select?.priceIncludesDelivery) return { priceIncludesDelivery: state.storePolicy };
        if (where.id !== 'store-A' && where.id !== 'store-B') return null;
        const { currencyCode, orderPrefix, minorUnit } = state.country;
        return { id: where.id, countryId: state.country.id, country: { currencyCode, orderPrefix, minorUnit } };
      }),
      update: vi.fn(async () => {
        state.storeWrites++;
        return {};
      }),
    },
    region: { findMany: vi.fn(async () => state.regions) },
    // `activeOffersFor`'s own query, answered by the same predicate it sends: this product's, ACTIVE, not the post-order one,
    // and not finished. `evidencedWasPrices` asks the orders for delivered prices; none here.
    offer: {
      findMany: vi.fn(async ({ where }: Row) =>
        state.offers
          .filter((o) => o.companyId === where.companyId && o.productId === where.productId)
          .filter((o) => o.status === where.status && o.postOrderOffer === where.postOrderOffer)
          .filter((o) => o.endsAt === null || o.endsAt > new Date())
          .map((o) => ({ ...o }))
      ),
    },
    order: {
      groupBy: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => {
        throw new Error('an order is written inside a transaction or not at all');
      }),
    },
    orderItem: { create: vi.fn() },
    orderActivity: { create: vi.fn(async () => ({})) },
    orderStatusLog: { create: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (fn: (tx: Row) => Promise<unknown>) => {
      // What a transaction writes is kept only if it returns: a throw rolls its order and its line back.
      const orders: Row[] = [];
      const items: Row[] = [];
      const tx = {
        ...db,
        order: {
          ...db.order,
          create: async ({ data }: Row) => {
            const row = { id: `o${++state.seq}`, ...data };
            orders.push(row);
            return row;
          },
        },
        orderItem: {
          create: async ({ data }: Row) => {
            items.push(data);
            return data;
          },
        },
      };
      if (gate.waitFor > 1) {
        gate.inside++;
        if (gate.inside >= gate.waitFor) gate.open();
        await gate.opened;
      }
      const out = await fn(tx);
      state.orders.push(...orders);
      state.items.push(...items);
      return out;
    }),
  };
  return { db, state, gate };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/notify', () => ({ notify: vi.fn() }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
// The retry door's caller: a manager of store A.
vi.mock('@/lib/geo-context', () => ({
  requireContext: vi.fn(async () => ({ user: { id: 'u1' }, companyId: 'c1', storeId: 'store-A' })),
}));
vi.mock('@/lib/authorization', () => ({ requirePermission: vi.fn(async () => undefined), can: () => true }));


import { processStoredMessage } from './inbound';
import { createTelegramOrder } from './order-creation';
import { reviewReasonText } from './review-reasons';
import { codForOrder } from '../delivery-fees';
import { POST as RETRY } from '@/app/api/telegram/messages/[id]/retry/route';

/** HIS message, as he wrote it in the group on 28/10 — the nine labels, the values of the example he gave. */
const SAMPLE: Array<[string, string]> = [
  ['رقم الطلب', '26842'],
  ['تاريخ الطلب', '2026-10-28 17:45:32'],
  ['إسم العميل', 'محمد عيد أطليبي'],
  ['رقم الهاتف', '0933620102'],
  ['عنوان العميل', 'دمشق سوريا'],
  ['إسم المنتج', 'ماء الكمأ الأصلي'],
  ['إسم العرض', 'قطعتين + قطعة هدية ( عدد 3 ) =25 $ + توصيل مجاني'],
  ['السعر', '25'],
  ['الكمية', '1'],
];
/** The sample with some values changed (by label), or a label dropped (`null`). */
const sample = (over: Record<string, string | null> = {}) =>
  SAMPLE.filter(([label]) => over[label] !== null)
    .map(([label, value]) => `${label}: ${over[label] ?? value}`)
    .join('\n');
const ARRIVED = new Date('2026-10-28T14:45:40Z');

/** An offer row as the table holds it. Delivery is included unless said otherwise, as the form's own default has it. */
const offerRow = (over: Row): Row => ({
  companyId: 'c1',
  status: 'ACTIVE',
  postOrderOffer: false,
  endsAt: null,
  discount: 0,
  compareAtPrice: null,
  isDefault: false,
  deliveryIncluded: true,
  freeQuantity: 0,
  sortOrder: 0,
  ...over,
});
/** HIS offer: two paid pieces and one gift, 25 — «قطعتين + قطعة هدية ( عدد 3 )». */
const BUNDLE = 'قطعتين + قطعة هدية ( عدد 3 )';

let messageSeq = 0;
/** A stored message, as the webhook leaves it: PENDING, from store A's group unless said otherwise. */
const arrive = (text: string, over: Row = {}) => {
  const id = `m${++messageSeq}`;
  state.messages.push({
    id,
    companyId: 'c1',
    sourceId: 'src-A',
    chatId: '-100',
    messageId: String(messageSeq),
    threadId: null,
    threadName: null,
    text,
    processingStatus: 'PENDING',
    reviewReason: null,
    orderId: null,
    pageName: null,
    createdAt: ARRIVED,
    ...over,
  });
  return id;
};
const messageRow = (id: string) => state.messages.find((m) => m.id === id)!;

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state, {
    messages: [],
    sources: [
      { id: 'src-A', storeId: 'store-A' },
      { id: 'src-B', storeId: 'store-B' },
      { id: 'src-unplaced', storeId: null },
    ],
    products: [
      { id: 'prod-kamaa', companyId: 'c1', storeId: 'store-A', status: 'ACTIVE', name: 'ماء الكمأ الأصلي', nameEn: null, sku: 'KM-1', basePrice: 20, image: null },
      { id: 'prod-honey', companyId: 'c1', storeId: 'store-A', status: 'ACTIVE', name: 'عسل السدر الأصلي', nameEn: null, sku: 'HN-1', basePrice: 30, image: null },
    ],
    customers: [],
    blocks: [],
    orders: [],
    items: [],
    regions: [
      { id: 'region-hama', name: 'حماة' },
      { id: 'region-homs', name: 'حمص' },
      { id: 'region-damascus', name: 'دمشق' },
    ],
    // The catalogue of offers: his bundle on both products and on the other store's, a single piece at 15 that does NOT
    // include delivery, and three pieces for 10 (a price that does not divide).
    offers: [
      offerRow({ id: 'of-bundle', productId: 'prod-kamaa', name: BUNDLE, quantity: 2, freeQuantity: 1, sellingPrice: 25 }),
      offerRow({ id: 'of-single', productId: 'prod-kamaa', name: 'قطعة واحدة', quantity: 1, sellingPrice: 15, deliveryIncluded: false, sortOrder: 1 }),
      offerRow({ id: 'of-three', productId: 'prod-kamaa', name: 'ثلاث قطع', quantity: 3, sellingPrice: 10, sortOrder: 2 }),
      offerRow({ id: 'of-bundle-honey', productId: 'prod-honey', name: BUNDLE, quantity: 2, freeQuantity: 1, sellingPrice: 25 }),
      offerRow({ id: 'of-bundle-b', productId: 'prod-kamaa-b', name: BUNDLE, quantity: 2, freeQuantity: 1, sellingPrice: 25 }),
    ],
    storePolicy: false,
    country: { id: 'country-sy', code: 'SY', name: 'سوريا', currencyCode: 'USD', minorUnit: 2, orderPrefix: 'SY' },
    seq: 0,
    storeWrites: 0,
  });
  gate.waitFor = 1;
  gate.inside = 0;
});

/** Nothing written but the message's own status: no customer, no order, no line. */
const nothingWritten = () => {
  expect(state.customers, 'زبون انكتب').toEqual([]);
  expect(state.orders, 'طلب انكتب').toEqual([]);
  expect(state.items, 'سطر طلب انكتب').toEqual([]);
};

/** Forget every message, customer and order, keep the catalogue: for a test that sends several spellings one by one. */
const fresh = () => {
  state.messages = [];
  state.customers = [];
  state.orders = [];
  state.items = [];
};

describe('his sample becomes exactly one order — bound to his offer', () => {
  it('— the customer, the order, its line and its notes, field by field', async () => {
    const id = arrive(sample());
    const result = await processStoredMessage(id);

    expect(result.status).toBe('PROCESSED');
    expect(state.orders).toHaveLength(1);
    const [order] = state.orders;
    expect(result.orderId).toBe(order.id);

    // The trailing «سوريا» is the store's own country word: dropped, and the rest is the place.
    expect(state.customers).toEqual([
      expect.objectContaining({ storeId: 'store-A', phone: '933620102', rawPhone: '0933620102', fullName: 'محمد عيد أطليبي', address: 'دمشق', city: 'دمشق' }),
    ]);
    // «الكمية: 1» is ONE offer: two paid pieces and the gift, 25 for all of it, the delivery the offer promises.
    expect(order).toMatchObject({
      storeId: 'store-A',
      customerId: state.customers[0].id,
      productId: 'prod-kamaa',
      regionId: 'region-damascus',
      offerId: 'of-bundle',
      quantity: 2,
      freeQuantity: 1,
      sellingPrice: 25,
      totalAmount: 25,
      shippingCost: 0,
      priceIncludesDelivery: true,
      currency: 'USD',
      status: 'NEW',
      source: 'Telegram',
    });
    expect(order.internalNotes).toContain(`وقت الطلب بالمصدر: 2026-10-28 17:45:32 · العرض: ${BUNDLE}`);
    // The line carries the gift: 2 + 1 = 3 pieces leave the shelf, and only the 2 are in the money.
    expect(state.items).toEqual([
      expect.objectContaining({ productId: 'prod-kamaa', quantity: 2, freeQuantity: 1, unitPrice: 12.5, discountShare: 0, lineTotal: 25 }),
    ]);
    // Order.createdAt stays the database's: the date line is only kept as text.
    expect(order).not.toHaveProperty('createdAt');

    expect(messageRow(id)).toMatchObject({ processingStatus: 'PROCESSED', orderId: order.id, reviewReason: null });
  });

  it('— «رقم الطلب» is dropped: it reaches no field, no note, no customer and no key', async () => {
    await processStoredMessage(arrive(sample()));
    expect(JSON.stringify([state.orders, state.items, state.customers])).not.toContain('26842');
  });

  it('— the same message pressed again is the same order, not a second one', async () => {
    const id = arrive(sample());
    await processStoredMessage(id);
    const again = await processStoredMessage(id);
    expect(again).toMatchObject({ status: 'PROCESSED', orderId: state.orders[0].id });
    expect(state.orders).toHaveLength(1);
  });

  it('— without the order-number line it is the same order (the line is not required)', async () => {
    const id = arrive(sample({ 'رقم الطلب': null }));
    expect((await processStoredMessage(id)).status).toBe('PROCESSED');
    expect(state.orders).toHaveLength(1);
  });
});

describe('the money — the OFFER’s price, gift and delivery; «السعر» is checked against them and never moves them', () => {
  const FEE = 3;
  /** What the courier is asked for when the batch is made: the shipments route's own function, on the stored line. */
  const atShipment = (minorUnit = 2) => {
    const [order] = state.orders;
    const [line] = state.items;
    return codForOrder({
      lines: [{ quantity: line.quantity, unitPrice: line.unitPrice }],
      deliveryFee: FEE,
      priceIncludesDelivery: order.priceIncludesDelivery,
      minorUnit,
    }).cod;
  };
  /** The single piece at 15 whose delivery is NOT included — so the store's own policy is the one speaking. */
  const single = (over: Record<string, string>) => sample({ 'إسم العرض': 'قطعة واحدة', 'السعر': '15', ...over });

  it('quantity 1, price 25 → his bundle once: 2 paid + 1 gift, a total of 25, delivery included by the offer', async () => {
    await processStoredMessage(arrive(sample()));
    expect(state.orders[0]).toMatchObject({ quantity: 2, freeQuantity: 1, totalAmount: 25, sellingPrice: 25, priceIncludesDelivery: true });
    expect(state.items[0]).toMatchObject({ quantity: 2, freeQuantity: 1, unitPrice: 12.5, lineTotal: 25 });
    // The offer includes delivery, so the courier collects the 25 and not 25 + the fee.
    expect(atShipment()).toBe(25);
  });

  it('quantity 2 is the bundle’s own paid pieces: still ONE offer, not two pieces for 25', async () => {
    await processStoredMessage(arrive(sample({ 'الكمية': '2' })));
    expect(state.orders).toHaveLength(1);
    expect(state.orders[0]).toMatchObject({ quantity: 2, freeQuantity: 1, totalAmount: 25 });
  });

  it('quantity 4 is TWO offers: 4 paid + 2 gift pieces for 50 — the price must say 50', async () => {
    await processStoredMessage(arrive(sample({ 'الكمية': '4', 'السعر': '50' })));
    expect(state.orders[0]).toMatchObject({ offerId: 'of-bundle', quantity: 4, freeQuantity: 2, totalAmount: 50, sellingPrice: 50 });
    expect(state.items[0]).toMatchObject({ quantity: 4, freeQuantity: 2, unitPrice: 12.5, lineTotal: 50 });
  });

  it('quantity 4 with the price of ONE offer is a price that is not the offer’s — and nothing is written', async () => {
    const id = arrive(sample({ 'الكمية': '4', 'السعر': '25' }));
    expect(await processStoredMessage(id)).toEqual({ status: 'NEEDS_REVIEW', reason: 'PRICE_MISMATCH:50.00' });
    nothingWritten();
  });

  it.each([
    ['30 for the offer that costs 25', { 'السعر': '30' }, 'PRICE_MISMATCH:25.00'],
    ['20 for the offer that costs 25', { 'السعر': '20' }, 'PRICE_MISMATCH:25.00'],
    ['the figure in the offer’s own text (99) does not set the price', { 'إسم العرض': `${BUNDLE} = 99 $`, 'السعر': '99' }, 'PRICE_MISMATCH:25.00'],
  ])('%s → review, nothing written', async (_what, over, reason) => {
    const id = arrive(sample(over));
    expect(await processStoredMessage(id)).toEqual({ status: 'NEEDS_REVIEW', reason });
    nothingWritten();
    expect(messageRow(id).reviewReason).toBe(reason);
  });

  it.each(['3', '5', '7'])('quantity %s is not a whole number of offers → QUANTITY_NOT_OFFER, nothing written', async (quantity) => {
    const id = arrive(sample({ 'الكمية': quantity }));
    expect(await processStoredMessage(id)).toEqual({ status: 'NEEDS_REVIEW', reason: 'QUANTITY_NOT_OFFER' });
    nothingWritten();
  });

  it('a single piece at 15: quantity 3 is three offers → 3 pieces, 45, no gift', async () => {
    await processStoredMessage(arrive(single({ 'الكمية': '3', 'السعر': '45' })));
    expect(state.orders[0]).toMatchObject({ offerId: 'of-single', quantity: 3, freeQuantity: 0, totalAmount: 45 });
    expect(state.items[0]).toMatchObject({ quantity: 3, freeQuantity: 0, unitPrice: 15, lineTotal: 45 });
  });

  it('three pieces for 10: the unit price stays unrounded and the total is written back as exactly 10 (no fils lost)', async () => {
    await processStoredMessage(arrive(sample({ 'إسم العرض': 'ثلاث قطع', 'السعر': '10', 'الكمية': '3' })));
    expect(state.orders[0]).toMatchObject({ quantity: 3, totalAmount: 10 });
    expect(state.items[0]).toMatchObject({ quantity: 3, lineTotal: 10 });
    expect(state.items[0].unitPrice).toBeCloseTo(10 / 3, 12);
  });

  it('an offer’s own reduction is taken ONCE, as the storefront takes it: 25 with a discount of 3 is 22', async () => {
    state.offers.push(offerRow({ id: 'of-disc', productId: 'prod-kamaa', name: 'عرض الخصم', quantity: 2, sellingPrice: 25, discount: 3 }));
    const wrong = arrive(sample({ 'إسم العرض': 'عرض الخصم', 'السعر': '25' }));
    expect(await processStoredMessage(wrong)).toEqual({ status: 'NEEDS_REVIEW', reason: 'PRICE_MISMATCH:22.00' });
    nothingWritten();
    const id = arrive(sample({ 'إسم العرض': 'عرض الخصم', 'السعر': '22', 'تاريخ الطلب': '2026-10-28 18:00:00' }));
    expect(await processStoredMessage(id)).toMatchObject({ status: 'PROCESSED' });
    expect(state.orders[0]).toMatchObject({ offerId: 'of-disc', totalAmount: 22 });
    expect(state.items[0]).toMatchObject({ discountShare: 3, lineTotal: 22, unitPrice: 12.5 });
  });

  it.each([
    // [store policy, the order's price includes delivery, at creation, at the shipment] — for an offer that does NOT include it
    [false, false, 15, 18],
    [true, true, 15, 15],
  ])('an offer without delivery under a store policy of %s → %s · %s at creation · %s at the shipment', async (policy, includes, created, shipped) => {
    state.storePolicy = policy;
    await processStoredMessage(arrive(single({})));
    expect(state.orders[0].priceIncludesDelivery).toBe(includes);
    expect(state.orders[0].totalAmount).toBe(created);
    expect(atShipment()).toBe(shipped);
    // Nothing here ever writes the store's own setting.
    expect(state.storeWrites).toBe(0);
  });

  it('and an offer that includes delivery turns it on in a store that does not — never the other way', async () => {
    state.storePolicy = false;
    await processStoredMessage(arrive(sample()));
    expect(state.orders[0].priceIncludesDelivery).toBe(true);
    fresh();
    state.storePolicy = true;
    await processStoredMessage(arrive(single({})));
    expect(state.orders[0].priceIncludesDelivery).toBe(true);
  });

  it.each(['25 $', '$25', '25 دولار', '25.00', '25'])('the price «%s» is 25', async (price) => {
    fresh();
    await processStoredMessage(arrive(sample({ 'السعر': price })));
    expect(state.orders).toHaveLength(1);
    expect(state.orders[0].totalAmount).toBe(25);
  });

  it('a dinar keeps its three decimals: 14.255 for the offer of two pieces on a Jordanian store', async () => {
    state.country = { id: 'country-jo', code: 'JO', name: 'الأردن', currencyCode: 'JOD', minorUnit: 3, orderPrefix: 'JO' };
    state.regions = [{ id: 'region-amman', name: 'عمّان' }];
    state.offers.push(offerRow({ id: 'of-jod', productId: 'prod-kamaa', name: 'قطعتين بالدينار', quantity: 2, sellingPrice: 14.255, deliveryIncluded: false }));
    await processStoredMessage(
      arrive(sample({ 'رقم الهاتف': '0791234567', 'عنوان العميل': 'الأردن عمان', 'إسم العرض': 'قطعتين بالدينار', 'السعر': '14.255', 'الكمية': '2' }))
    );
    expect(state.orders[0]).toMatchObject({ offerId: 'of-jod', quantity: 2, totalAmount: 14.255, currency: 'JOD', regionId: 'region-amman' });
    expect(state.items[0]).toMatchObject({ unitPrice: 7.1275, lineTotal: 14.255 });
    expect(atShipment(3)).toBe(17.255);
  });

  it('and a fourth decimal on that store is refused, not rounded', async () => {
    state.country = { id: 'country-jo', code: 'JO', name: 'الأردن', currencyCode: 'JOD', minorUnit: 3, orderPrefix: 'JO' };
    const id = arrive(sample({ 'رقم الهاتف': '0791234567', 'عنوان العميل': 'الأردن عمان', 'السعر': '14.2555' }));
    expect(await processStoredMessage(id)).toEqual({ status: 'NEEDS_REVIEW', reason: 'MISSING_PRICE' });
    nothingWritten();
  });

  it('the gift is stock: 3 pieces for one bundle, 6 for two — paid + gift, as the storefront reserves them', async () => {
    await processStoredMessage(arrive(sample()));
    await processStoredMessage(arrive(sample({ 'الكمية': '4', 'السعر': '50', 'تاريخ الطلب': '2026-10-28 18:00:00' })));
    const pieces = state.items.map((i) => i.quantity + i.freeQuantity);
    expect(pieces).toEqual([3, 6]);
  });
});

describe('«إسم العرض» is tied to ONE real offer of this product', () => {
  const offerOf = (text: string, extra: Record<string, string> = {}) => sample({ 'إسم العرض': text, ...extra });

  it.each([
    ['the offer’s name exactly', BUNDLE],
    ['his full text, the name contained in it', 'قطعتين + قطعة هدية ( عدد 3 ) =25 $ + توصيل مجاني'],
    ['no brackets, no plus', 'قطعتين قطعة هدية عدد 3'],
    ['Arabic-Indic digits and another spelling', 'قطعتين + قطعه هديه ( عدد ٣ )'],
    ['the name inside a longer sentence', 'عرض اليوم: قطعتين + قطعة هدية ( عدد 3 ) فقط'],
  ])('found — %s', async (_what, text) => {
    fresh();
    expect((await processStoredMessage(arrive(offerOf(text)))).status).toBe('PROCESSED');
    expect(state.orders[0].offerId).toBe('of-bundle');
  });

  it('the name is matched word for word: «قطعة» alone is not inside «قطعتين»', async () => {
    state.offers.push(offerRow({ id: 'of-word', productId: 'prod-kamaa', name: 'قطعة', quantity: 1, sellingPrice: 9 }));
    const id = arrive(offerOf('قطعتين فقط'));
    expect(await processStoredMessage(id)).toEqual({ status: 'NEEDS_REVIEW', reason: 'OFFER_NOT_FOUND' });
  });

  it('of two offers that both stand inside the text, the longer name wins when it holds the shorter', async () => {
    state.offers.push(offerRow({ id: 'of-short', productId: 'prod-kamaa', name: 'قطعتين', quantity: 2, sellingPrice: 18 }));
    expect((await processStoredMessage(arrive(sample()))).status).toBe('PROCESSED');
    expect(state.orders[0].offerId).toBe('of-bundle');
  });

  it('two offers with the same name are ambiguous — nothing is chosen and nothing is written', async () => {
    state.offers.push(offerRow({ id: 'of-twin', productId: 'prod-kamaa', name: BUNDLE, quantity: 2, freeQuantity: 1, sellingPrice: 30 }));
    const id = arrive(sample());
    expect(await processStoredMessage(id)).toEqual({ status: 'NEEDS_REVIEW', reason: 'OFFER_AMBIGUOUS' });
    nothingWritten();
    expect(messageRow(id)).toMatchObject({ processingStatus: 'NEEDS_REVIEW', reviewReason: 'OFFER_AMBIGUOUS' });
  });

  it('two different offers inside the text, neither holding the other, are ambiguous too', async () => {
    state.offers.push(offerRow({ id: 'of-a', productId: 'prod-kamaa', name: 'هدية مجانية', quantity: 1, sellingPrice: 5 }));
    expect(await processStoredMessage(arrive(offerOf(`${BUNDLE} هدية مجانية`)))).toEqual({ status: 'NEEDS_REVIEW', reason: 'OFFER_AMBIGUOUS' });
  });

  it('a name no offer of the product has → OFFER_NOT_FOUND, and the order is NOT created', async () => {
    const id = arrive(offerOf('أربع قطع مع علبة'));
    expect(await processStoredMessage(id)).toEqual({ status: 'NEEDS_REVIEW', reason: 'OFFER_NOT_FOUND' });
    nothingWritten();
  });

  it('a product with no offers at all → OFFER_NOT_FOUND (the text is tied to a real offer or there is no order)', async () => {
    state.offers = [];
    expect(await processStoredMessage(arrive(sample()))).toEqual({ status: 'NEEDS_REVIEW', reason: 'OFFER_NOT_FOUND' });
    nothingWritten();
  });

  it('another PRODUCT’s offer of the same name is not this product’s', async () => {
    state.offers = state.offers.filter((o) => o.id !== 'of-bundle');
    // `of-bundle-honey` carries the same name but belongs to the honey.
    expect(await processStoredMessage(arrive(sample()))).toMatchObject({ reason: 'OFFER_NOT_FOUND' });
  });

  it.each([
    ['inactive', { status: 'INACTIVE' }],
    ['finished', { endsAt: new Date('2026-10-01T00:00:00Z') }],
    ['the one shown after the order', { postOrderOffer: true }],
  ])('an offer that is %s is not for sale at any door → OFFER_NOT_FOUND', async (_what, over) => {
    Object.assign(state.offers.find((o) => o.id === 'of-bundle')!, over);
    expect(await processStoredMessage(arrive(sample()))).toMatchObject({ reason: 'OFFER_NOT_FOUND' });
    nothingWritten();
  });

  it('a currency in the offer’s text other than the store’s → CURRENCY_MISMATCH, never converted', async () => {
    const id = arrive(offerOf(`${BUNDLE} = 99 ل.س`));
    expect(await processStoredMessage(id)).toEqual({ status: 'NEEDS_REVIEW', reason: 'CURRENCY_MISMATCH' });
    nothingWritten();
  });

  it('and the store’s own currency in the offer’s text is fine, like no currency at all', async () => {
    expect((await processStoredMessage(arrive(offerOf(`${BUNDLE} = 25 دولار`)))).status).toBe('PROCESSED');
    expect((await processStoredMessage(arrive(offerOf(BUNDLE, { 'تاريخ الطلب': '2026-10-28 18:00:00' })))).status).toBe('PROCESSED');
  });

  it('creating the order directly with a price that is not the offer’s still writes the OFFER’s total', async () => {
    const line = {
      product: state.products[0] as never,
      offer: { id: 'of-bundle', name: BUNDLE, deliveryIncluded: true } as never,
      quantity: 2,
      freeQuantity: 1,
      unitPrice: 12.5,
      offerDiscount: 0,
    };
    const created = await createTelegramOrder({
      companyId: 'c1',
      storeId: 'store-A',
      customer: { id: 'cu-x', firstOrderDate: null, totalOrders: 0 },
      product: state.products[0] as never,
      line,
      address: 'دمشق',
      priceText: '99',
      telegram: { messageId: '1', chatId: '-100', threadId: null },
    });
    expect(created.ok).toBe(true);
    expect(state.orders[0]).toMatchObject({ totalAmount: 25, sellingPrice: 25, freeQuantity: 1 });
  });
});

describe('the same message in other shapes is still the same order', () => {
  const orderOf = async (text: string) => {
    fresh();
    const result = await processStoredMessage(arrive(text));
    return { result, order: state.orders[0] };
  };

  it('labels in another order', async () => {
    const reversed = [...SAMPLE].reverse().map(([l, v]) => `${l}: ${v}`).join('\n');
    const { result, order } = await orderOf(reversed);
    expect(result.status).toBe('PROCESSED');
    expect(order).toMatchObject({ quantity: 2, freeQuantity: 1, totalAmount: 25, productId: 'prod-kamaa' });
  });

  it('«اسم» for «إسم», «الكميه» for «الكمية», a colon with spaces or the wide colon, a tashkeel on a label', async () => {
    const text = [
      'تاريخ الطلب : 2026-10-28 17:45:32',
      'اسم العميل：محمد',
      'رَقْم الهاتف:0933620102',
      'عنوان العميل :دمشق',
      'اسم المنتج: ماء الكمأ الأصلي',
      'اسم العرض: قطعة واحدة',
      'السعر: 15',
      'الكميه: 1',
    ].join('\n');
    const { result, order } = await orderOf(text);
    expect(result.status).toBe('PROCESSED');
    expect(order).toMatchObject({ offerId: 'of-single', quantity: 1, freeQuantity: 0, totalAmount: 15 });
    expect(state.customers[0].fullName).toBe('محمد');
  });

  it('Arabic-Indic digits in the date, the phone, the price and the quantity', async () => {
    const { result, order } = await orderOf(
      sample({ 'تاريخ الطلب': '٢٠٢٦-١٠-٢٨ ١٧:٤٥:٣٢', 'رقم الهاتف': '٠٩٣٣٦٢٠١٠٢', 'السعر': '٢٥', 'الكمية': '٢' })
    );
    expect(result.status).toBe('PROCESSED');
    expect(order).toMatchObject({ quantity: 2, totalAmount: 25 });
    expect(state.customers[0]).toMatchObject({ phone: '933620102' });
    expect(order.internalNotes).toContain('2026-10-28 17:45:32');
  });

  it('a multi-line address is one address', async () => {
    const text = sample().replace('عنوان العميل: دمشق سوريا', 'عنوان العميل: دمشق\nالمزة - شارع الفارابي\nبناء 5');
    const { result } = await orderOf(text);
    expect(result.status).toBe('PROCESSED');
    expect(state.customers[0].address).toBe('دمشق المزة - شارع الفارابي بناء 5');
    expect(state.orders[0].regionId).toBe('region-damascus');
  });

  it('a +963 phone is the same customer as 0933620102', async () => {
    await processStoredMessage(arrive(sample()));
    await processStoredMessage(arrive(sample({ 'رقم الهاتف': '+963 933 620 102', 'تاريخ الطلب': '2026-10-28 18:00:00' })));
    expect(state.customers).toHaveLength(1);
    expect(state.orders).toHaveLength(2);
    expect(state.customers[0].rawPhone).toBe('0933620102');
  });

  it.each([
    ['«سوريا دمشق»', 'سوريا دمشق', 'region-damascus', 'دمشق'],
    ['«دمشق سوريا»', 'دمشق سوريا', 'region-damascus', 'دمشق'],
    ['«سورية - حماة»', 'سورية - حماة', 'region-hama', 'حماة'],
    ['no country word', 'حماة', 'region-hama', 'حماة'],
    ['a place the table does not know', 'سوريا مصياف', null, 'مصياف'],
    ['two words, the country at the end', 'حماه السقيلبية سوريا', 'region-hama', 'حماه السقيلبية'],
    ['the country and nothing else (29/10: «طلبات تنزل باسم سوريا بس»)', 'سوريا', null, 'سوريا'],
    ['the country twice', 'سوريا سوريا', null, 'سوريا'],
    ['another country: kept as written, no refusal', 'الأردن عمان', null, 'الأردن عمان'],
    ['another country at the end', 'عمان الأردن', null, 'عمان الأردن'],
    ['words that name no place', 'سلام اهلا', null, 'سلام اهلا'],
    ['a village the table does not know', 'الرقة الكرمة', null, 'الرقة الكرمة'],
  ])('the place — %s', async (_what, address, region, written) => {
    const { order } = await orderOf(sample({ 'عنوان العميل': address }));
    expect(order.regionId).toBe(region);
    expect(state.customers[0]).toMatchObject({ address: written, city: written });
  });
});

describe('the phone — every way of writing it is accepted; only a number that is no number waits for a person', () => {
  const phoneOf = (value: string, extra: Record<string, string> = {}) => sample({ 'رقم الهاتف': value, ...extra });

  it.each([
    ['the owner’s spaced +963', '+963 933 620 102'],
    ['00963', '00963933620102'],
    ['963 with no marker', '963933620102'],
    ['0963', '0963933620102'],
    ['the local 09', '0933620102'],
    ['the local 9 (nine digits)', '933620102'],
    ['Arabic-Indic digits', '٠٩٣٣٦٢٠١٠٢'],
    ['Persian digits', '۰۹۳۳۶۲۰۱۰۲'],
    ['dashes inside', '0933-620-102'],
    ['dots inside', '0933.620.102'],
    ['the code in brackets', '(+963) 933620102'],
    ['the trunk zero kept after the code', '+963 0933620102'],
    ['a word before it', 'واتساب: 0933 620 102'],
    ['a word after it', '0933620102 واتساب'],
    ['spaced dashes in one number', '0933 - 620 - 102'],
    ['the code with spaces and Arabic digits', '+٩٦٣ ٩٣٣ ٦٢٠ ١٠٢'],
  ])('%s → one customer, 933620102, and an order', async (_what, value) => {
    fresh();
    const id = arrive(phoneOf(value));
    expect(await processStoredMessage(id)).toMatchObject({ status: 'PROCESSED' });
    expect(state.customers).toHaveLength(1);
    expect(state.customers[0].phone).toBe('933620102');
    expect(state.orders).toHaveLength(1);
  });

  it('a landline (11 + 7 digits) is a phone too', async () => {
    await processStoredMessage(arrive(phoneOf('011 1234567')));
    expect(state.customers[0].phone).toBe('111234567');
    expect(state.orders).toHaveLength(1);
  });

  it('a foreign line keeps its own code, as a Syrian store has always taken it', async () => {
    await processStoredMessage(arrive(phoneOf('+90 532 123 45 67')));
    expect(state.customers[0].phone).toBe('905321234567');
    expect(state.orders).toHaveLength(1);
  });

  it.each([
    ['dash', '0933620102 - 0944123456'],
    ['slash', '0933620102 / 0944123456'],
    ['the Arabic comma', '0933620102، 0944123456'],
    ['«و»', '0933620102 و 0944123456'],
    ['a new line', ['0933620102', '0944123456'].join(String.fromCharCode(10))],
    ['a plus that opens the second', '0933620102 +963944123456'],
  ])('two numbers (%s) → the first is the phone, the second the customer’s other phone, and the notes say so', async (_what, value) => {
    fresh();
    await processStoredMessage(arrive(phoneOf(value)));
    expect(state.orders).toHaveLength(1);
    expect(state.customers[0]).toMatchObject({ phone: '933620102', altPhone: '944123456' });
    expect(state.orders[0].internalNotes).toContain('أرقام أخرى: 0944123456');
  });

  it('a stub before the real number is not the phone: the first VALID number is', async () => {
    await processStoredMessage(arrive(phoneOf('12 و 0933620102')));
    expect(state.customers[0].phone).toBe('933620102');
    expect(state.orders).toHaveLength(1);
  });

  it('the same number written twice is one number, not a second phone', async () => {
    await processStoredMessage(arrive(phoneOf('0933620102 / +963 933 620 102')));
    expect(state.customers[0].altPhone).toBeNull();
    expect(state.orders[0].internalNotes).not.toContain('أرقام أخرى');
  });

  it.each([
    ['12', '12'],
    ['123', '123'],
    ['five digits', '12345'],
    ['letters around digits', 'ab12'],
    ['a stub with the code', '+963 12'],
  ])('«%s» is no phone → review INVALID_PHONE with the number as written, and NOTHING is written', async (_what, value) => {
    const id = arrive(phoneOf(value));
    expect(await processStoredMessage(id)).toEqual({ status: 'NEEDS_REVIEW', reason: `INVALID_PHONE:${value}` });
    nothingWritten();
    expect(messageRow(id)).toMatchObject({ processingStatus: 'NEEDS_REVIEW', reviewReason: `INVALID_PHONE:${value}` });
    expect(reviewReasonText(messageRow(id).reviewReason)).toBe(`رقم الهاتف مش صالح: ${value}`);
  });

  it.each([
    ['his first real message: +963 and 8 digits', '+96398101968', '98101968'],
    ['his second: +963, a trunk zero and 8 digits', '+963096061306', '96061306'],
    ['a Syrian mobile one digit short', '09336201', '9336201'],
    ['six digits, the floor', '123456', '123456'],
  ])('«%s» is not Syrian-shaped but is a number: the order is made, and its notes say to check it', async (_what, value, stored) => {
    const id = arrive(phoneOf(value));
    expect((await processStoredMessage(id)).status).toBe('PROCESSED');
    expect(state.orders).toHaveLength(1);
    expect(state.customers[0].phone).toBe(stored);
    expect(state.orders[0].internalNotes).toContain('رقم الهاتف ما بيطابق شكل أرقام البلد');
    expect(state.orders[0].internalNotes).toContain(value);
  });

  it('a number that fits the country carries no such note', async () => {
    await processStoredMessage(arrive(phoneOf('0933620102')));
    expect(state.orders[0].internalNotes).not.toContain('ما بيطابق');
  });

  it('a blocked number is blocked in its short form too, before anything is written', async () => {
    state.blocks = [{ companyId: 'c1', phone: '98101968' }];
    const id = arrive(phoneOf('+96398101968'));
    expect(await processStoredMessage(id)).toEqual({ status: 'NEEDS_REVIEW', reason: 'CUSTOMER_BLOCKED' });
    nothingWritten();
  });

  it('a stub with a real number beside it is not refused — the real number is the phone', async () => {
    expect((await processStoredMessage(arrive(phoneOf('12 - 0933620102')))).status).toBe('PROCESSED');
  });

  it('no digit at all is a missing field, as ever', async () => {
    const id = arrive(phoneOf('واتساب فقط'));
    expect(await processStoredMessage(id)).toEqual({ status: 'NEEDS_REVIEW', reason: 'MISSING_PHONE' });
    nothingWritten();
  });

  it.each([
    ['+963 933 620 102'],
    ['00963933620102'],
    ['٠٩٣٣٦٢٠١٠٢'],
    ['(+963) 933620102'],
    ['0963933620102'],
    ['واتساب 0933-620-102'],
  ])('a blocked number is blocked however it is written (%s) — refused before any write', async (value) => {
    state.blocks = [{ companyId: 'c1', phone: '933620102' }];
    fresh();
    const id = arrive(phoneOf(value));
    expect(await processStoredMessage(id)).toEqual({ status: 'NEEDS_REVIEW', reason: 'CUSTOMER_BLOCKED' });
    nothingWritten();
    expect(db.customer.create).not.toHaveBeenCalled();
  });

  it('and a blocked number is blocked when it is the SECOND one in the line', async () => {
    state.blocks = [{ companyId: 'c1', phone: '933620102' }];
    const id = arrive(phoneOf('0944123456 - 0933620102'));
    expect(await processStoredMessage(id)).toEqual({ status: 'NEEDS_REVIEW', reason: 'CUSTOMER_BLOCKED' });
    nothingWritten();
  });

  it('the same customer written two ways is one customer and one duplicate', async () => {
    await processStoredMessage(arrive(phoneOf('0933620102')));
    expect(await processStoredMessage(arrive(phoneOf('00963 933 620 102')))).toEqual({ status: 'NEEDS_REVIEW', reason: 'DUPLICATE_ORDER' });
    expect(state.customers).toHaveLength(1);
  });
});

describe('a message that is not in the format is not an order', () => {
  it.each([
    ['one label only', 'رقم الهاتف: 0933620102'],
    ['chit-chat', 'السلام عليكم، وين طلبي؟'],
    ['his old seven lines', ['26818', '2026-10-28 15:40:01', 'محمد', '0932323642', 'سوريا حماه', 'ماء الكمأ الأصلي', 'القطعة ب 15 $ + توصيل مجاني'].join('\n')],
    ['the old labels (الاسم / الهاتف / المنتج)', ['الاسم: أحمد', 'الهاتف: 0933444555', 'العنوان: عرفات', 'المنتج: ماء الكمأ الأصلي'].join('\n')],
    ['a label in the middle of a sentence', 'اكتب رقم الطلب: 5 وبعدين السعر: 25'],
  ])('%s → IGNORED, NOT_IN_FORMAT, nothing written, nobody blocked', async (_what, text) => {
    const id = arrive(text);
    expect(await processStoredMessage(id)).toEqual({ status: 'IGNORED', reason: 'NOT_IN_FORMAT' });
    nothingWritten();
    expect(messageRow(id)).toMatchObject({ processingStatus: 'IGNORED', reviewReason: 'NOT_IN_FORMAT' });
    expect(state.blocks).toEqual([]);
  });

  it('is judged before the store: a group no store owns still just ignores chit-chat', async () => {
    const id = arrive('شكرا', { sourceId: 'src-unplaced' });
    expect((await processStoredMessage(id)).status).toBe('IGNORED');
  });
});

describe('a message that claims the format and is wrong goes to review — naming the field, writing nothing', () => {
  it.each([
    ['«رقم الهاتف» absent', 'MISSING_PHONE', sample({ 'رقم الهاتف': null })],
    ['«رقم الهاتف» empty', 'MISSING_PHONE', sample({ 'رقم الهاتف': '' })],
    ['«تاريخ الطلب» absent', 'MISSING_ORDERED_AT', sample({ 'تاريخ الطلب': null })],
    ['«إسم العميل» empty', 'MISSING_CUSTOMER_NAME', sample({ 'إسم العميل': '  ' })],
    ['«عنوان العميل» absent', 'MISSING_ADDRESS', sample({ 'عنوان العميل': null })],
    ['«إسم المنتج» absent', 'MISSING_PRODUCT', sample({ 'إسم المنتج': null })],
    ['«إسم العرض» absent', 'MISSING_OFFER_NAME', sample({ 'إسم العرض': null })],
    ['«السعر» absent', 'MISSING_PRICE', sample({ 'السعر': null })],
    ['«الكمية» absent', 'MISSING_QUANTITY', sample({ 'الكمية': null })],
    ['«رقم الهاتف» twice', 'REPEATED_PHONE', `${sample()}\nرقم الهاتف: 0933000000`],
    ['«السعر» twice', 'REPEATED_PRICE', `${sample()}\nالسعر: 30`],
    ['«رقم الطلب» twice', 'REPEATED_ORDER_NUMBER', `${sample()}\nرقم الطلب: 26843`],
    ['a line no label owns', 'STRAY_LINE', `${sample()}\nشكراً`],
    ['a line before the labels', 'STRAY_LINE', `طلب جديد\n${sample()}`],
    ['the name continued on another line', 'STRAY_LINE', sample().replace('محمد عيد أطليبي', 'محمد\nعيد')],
    ['a date that is no date', 'BAD_DATE', sample({ 'تاريخ الطلب': '2026-02-30 15:40:01' })],
    ['a date a month away', 'SOURCE_TIME_OFF', sample({ 'تاريخ الطلب': '2026-09-28 15:40:01' })],
    ['a name with a digit', 'INVALID_CUSTOMER_NAME', sample({ 'إسم العميل': 'محمد 7' })],
    ['a phone with letters and no digit at all', 'MISSING_PHONE', sample({ 'رقم الهاتف': 'سوريا حماه' })],
    ['a phone of nothing but zeros', 'MISSING_PHONE', sample({ 'رقم الهاتف': '0000' })],
    ['a product nobody sells', 'PRODUCT_NOT_FOUND', sample({ 'إسم المنتج': 'شي ما إله وجود' })],
    ['a product guessed from one shared word', 'PRODUCT_GUESSED', sample({ 'إسم المنتج': 'ماء الورد الأصلي' })],
    ['a price that is words', 'MISSING_PRICE', sample({ 'السعر': 'خمسة وعشرين' })],
    ['a price of zero', 'MISSING_PRICE', sample({ 'السعر': '0' })],
    ['a price above the ceiling', 'MISSING_PRICE', sample({ 'السعر': '150000' })],
    ['a thousands comma', 'MISSING_PRICE', sample({ 'السعر': '15,000' })],
    ['a figure and a word after the price', 'MISSING_PRICE', sample({ 'السعر': '25 للقطعة' })],
    ['another currency in the price', 'CURRENCY_MISMATCH', sample({ 'السعر': '25 د.أ' })],
    ['a quantity of zero', 'INVALID_QUANTITY', sample({ 'الكمية': '0' })],
    ['a quantity of 1001', 'INVALID_QUANTITY', sample({ 'الكمية': '1001' })],
    ['a quantity with a fraction', 'INVALID_QUANTITY', sample({ 'الكمية': '1.5' })],
    ['a quantity in words', 'INVALID_QUANTITY', sample({ 'الكمية': 'قطعتين' })],
  ])('%s → %s', async (_what, reason, text) => {
    const id = arrive(text);
    expect(await processStoredMessage(id)).toEqual({ status: 'NEEDS_REVIEW', reason });
    nothingWritten();
    expect(messageRow(id)).toMatchObject({ processingStatus: 'NEEDS_REVIEW', reviewReason: reason });
  });

  it('his old labels, and a message that opens with a line no label owns, are refused — never ignored, never created', async () => {
    const id = arrive(['الاسم: أحمد', 'الهاتف: 0933444555', 'المنتج: ماء الكمأ الأصلي', 'الكمية: 2', 'السعر: 30 $'].join('\n'));
    expect(await processStoredMessage(id)).toEqual({ status: 'NEEDS_REVIEW', reason: 'STRAY_LINE' });
    nothingWritten();
  });

  it('two of the nine labels are enough to claim it: the rest is named as missing', async () => {
    const id = arrive('السعر: 30 $\nالكمية: 2');
    expect(await processStoredMessage(id)).toEqual({ status: 'NEEDS_REVIEW', reason: 'MISSING_ORDERED_AT' });
    nothingWritten();
  });

  it('a blocked number goes to a person, and still nothing is written — the customer is never even looked up', async () => {
    state.blocks = [{ companyId: 'c1', phone: '933620102' }];
    const id = arrive(sample({ 'رقم الهاتف': '+963 933 620 102' }));
    expect(await processStoredMessage(id)).toEqual({ status: 'NEEDS_REVIEW', reason: 'CUSTOMER_BLOCKED' });
    nothingWritten();
    expect(db.customer.create).not.toHaveBeenCalled();
    expect(db.customer.findFirst).not.toHaveBeenCalled();
  });

  it('a group no store owns is refused before its fields are judged', async () => {
    const id = arrive(sample({ 'السعر': 'غلط' }), { sourceId: 'src-unplaced' });
    expect(await processStoredMessage(id)).toEqual({ status: 'NEEDS_REVIEW', reason: 'NO_STORE' });
    nothingWritten();
  });

  it('the fields are judged before the blacklist, in the design’s order', async () => {
    state.blocks = [{ companyId: 'c1', phone: '933620102' }];
    const id = arrive(sample({ 'السعر': '15,000' }));
    expect(await processStoredMessage(id)).toMatchObject({ reason: 'MISSING_PRICE' });
  });

  it('a claimed message is never IGNORED, even when it reads like chit-chat', async () => {
    const id = arrive(sample({ 'إسم العميل': 'شكرا', 'إسم المنتج': 'وين طلبي' }));
    expect((await processStoredMessage(id)).status).toBe('NEEDS_REVIEW');
  });
});

describe('one message, one order', () => {
  it('the same date, phone and product, posted again, is DUPLICATE_ORDER — and writes nothing', async () => {
    await processStoredMessage(arrive(sample()));
    const again = arrive(sample());
    expect(await processStoredMessage(again)).toEqual({ status: 'NEEDS_REVIEW', reason: 'DUPLICATE_ORDER' });
    expect(state.orders).toHaveLength(1);
    expect(state.customers).toHaveLength(1);
  });

  it('— even with another order number, another spelling of the phone and another spelling of the labels', async () => {
    await processStoredMessage(arrive(sample()));
    const again = arrive(sample({ 'رقم الطلب': '26999', 'رقم الهاتف': '+963 933 620 102' }).replace('إسم', 'اسم'));
    expect(await processStoredMessage(again)).toMatchObject({ reason: 'DUPLICATE_ORDER' });
    expect(state.orders).toHaveLength(1);
  });

  it('the key is THREE things: another time, another phone or another product is a new order', async () => {
    await processStoredMessage(arrive(sample()));
    await processStoredMessage(arrive(sample({ 'تاريخ الطلب': '2026-10-28 17:46:00' })));
    await processStoredMessage(arrive(sample({ 'رقم الهاتف': '0933620103' })));
    await processStoredMessage(arrive(sample({ 'إسم المنتج': 'عسل السدر الأصلي' })));
    expect(state.orders).toHaveLength(4);
  });

  it('a twin in ANOTHER store is not this store’s duplicate', async () => {
    state.products.push({ ...state.products[0], id: 'prod-kamaa-b', storeId: 'store-B' });
    await processStoredMessage(arrive(sample(), { sourceId: 'src-B' }));
    await processStoredMessage(arrive(sample()));
    expect(state.orders.map((o) => o.storeId)).toEqual(['store-B', 'store-A']);
  });

  it('a twin older than a week is not a duplicate', async () => {
    // Same text, the second arrives more than seven days after the first (still inside the date's own window).
    await processStoredMessage(arrive(sample(), { createdAt: new Date('2026-10-27T18:00:00Z') }));
    const later = arrive(sample(), { createdAt: new Date('2026-11-04T10:00:00Z') });
    expect(await processStoredMessage(later)).toMatchObject({ status: 'PROCESSED' });
    expect(state.orders).toHaveLength(2);
  });

  it('while one a day older IS', async () => {
    await processStoredMessage(arrive(sample(), { createdAt: new Date('2026-10-27T18:00:00Z') }));
    const later = arrive(sample(), { createdAt: new Date('2026-11-02T10:00:00Z') });
    expect(await processStoredMessage(later)).toMatchObject({ reason: 'DUPLICATE_ORDER' });
  });

  it('two presses of «إعادة المعالجة» at the same moment make ONE order', async () => {
    const id = arrive(sample(), { processingStatus: 'NEEDS_REVIEW', reviewReason: 'PRODUCT_NOT_FOUND' });
    gate.waitFor = 2;
    gate.opened = new Promise<void>((resolve) => {
      gate.open = resolve;
    });
    const [a, b] = await Promise.all([processStoredMessage(id), processStoredMessage(id)]);
    expect(gate.inside, 'the two did not meet inside the transaction').toBe(2);
    expect(state.orders).toHaveLength(1);
    expect(state.items).toHaveLength(1);
    expect(a).toEqual({ status: 'PROCESSED', orderId: state.orders[0].id });
    expect(b).toEqual({ status: 'PROCESSED', orderId: state.orders[0].id });
    expect(messageRow(id).orderId).toBe(state.orders[0].id);
  });
});

describe('the product line reads THIS store’s shelf only', () => {
  it('the product sold by the other store is not found here', async () => {
    state.products = [{ ...state.products[0], storeId: 'store-B' }];
    const id = arrive(sample());
    expect(await processStoredMessage(id)).toEqual({ status: 'NEEDS_REVIEW', reason: 'PRODUCT_NOT_FOUND' });
    nothingWritten();
  });

  it('nor is this store’s product that is not ACTIVE', async () => {
    state.products = [{ ...state.products[0], status: 'OUT_OF_STOCK' }];
    expect(await processStoredMessage(arrive(sample()))).toMatchObject({ reason: 'PRODUCT_NOT_FOUND' });
  });

  it('one product containing the written name is the answer; two are not', async () => {
    expect((await processStoredMessage(arrive(sample({ 'إسم المنتج': 'ماء الكمأ' })))).status).toBe('PROCESSED');
    state.products.push({ ...state.products[0], id: 'prod-kamaa-2', sku: 'KM-2', name: 'ماء الكمأ الذهبي' });
    expect(await processStoredMessage(arrive(sample({ 'إسم المنتج': 'ماء الكمأ', 'تاريخ الطلب': '2026-10-28 18:30:00' })))).toMatchObject({
      reason: 'AMBIGUOUS_PRODUCT',
    });
  });

  it('and when both stores sell it, the order carries this store’s product', async () => {
    state.products.push({ ...state.products[0], id: 'prod-kamaa-b', storeId: 'store-B' });
    await processStoredMessage(arrive(sample()));
    expect(state.orders[0].productId).toBe('prod-kamaa');
  });
});

describe('«تجاهل» is taken back by «إعادة المعالجة»', () => {
  const retry = (id: string) => RETRY(new Request('http://localhost', { method: 'POST' }), { params: Promise.resolve({ id }) });

  it('an IGNORED message is read again, through the retry door, and becomes the order it always was', async () => {
    const id = arrive(sample(), { processingStatus: 'IGNORED', processedAt: ARRIVED });
    const res = await retry(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, status: 'PROCESSED', orderId: state.orders[0].id });
    expect(state.orders).toHaveLength(1);
    expect(messageRow(id).processingStatus).toBe('PROCESSED');
    expect(messageRow(id).reviewReason).toBeNull();
  });

  it('and another store’s ignored message is not found by this store’s retry', async () => {
    const id = arrive(sample(), { sourceId: 'src-B', processingStatus: 'IGNORED' });
    expect((await retry(id)).status).toBe(404);
    expect(state.orders).toEqual([]);
  });
});
