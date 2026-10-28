import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE SEVEN-LINE DOOR, AGAINST A DATABASE THAT REMEMBERS WHAT WAS WRITTEN.
 *
 * In the style of `store-scope.test.ts`, but the fake keeps rows: a refusal is proved by what is NOT in the tables
 * afterwards (no customer, no order, no line), and the money by the rows that are — then carried to the shipment through
 * the same `codForOrder` the shipments route calls, with a delivery fee the order never saw.
 *
 * The owner, 28/10: «قم بتحسين واجهة طلبات تلجرام … وخلي تنسيق الطلبات اللي جاية من التلجرام يكون هيك».
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
            return { text: m.text, order: order ? { id: order.id, orderNumber: order.orderNumber } : null };
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
    order: {
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
import { codForOrder } from '../delivery-fees';
import { POST as RETRY } from '@/app/api/telegram/messages/[id]/retry/route';

const SAMPLE = ['26818', '2026-10-28 15:40:01', 'محمد', '0932323642', 'سوريا حماه', 'ماء الكمأ الأصلي', 'القطعة ب 15 $ + توصيل مجاني'];
const sample = (over: Partial<Record<number, string>> = {}) => SAMPLE.map((l, i) => over[i + 1] ?? l).join('\n');
const ARRIVED = new Date('2026-10-28T12:40:05Z');

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

describe('his sample becomes exactly one order', () => {
  it('— the customer, the order, its line and its notes, field by field', async () => {
    state.storePolicy = true;
    const id = arrive(sample());
    const result = await processStoredMessage(id);

    expect(result.status).toBe('PROCESSED');
    expect(state.orders).toHaveLength(1);
    const [order] = state.orders;
    expect(result.orderId).toBe(order.id);

    expect(state.customers).toEqual([
      expect.objectContaining({ storeId: 'store-A', phone: '932323642', rawPhone: '0932323642', fullName: 'محمد', address: 'حماه', city: 'حماه' }),
    ]);
    expect(order).toMatchObject({
      storeId: 'store-A',
      customerId: state.customers[0].id,
      productId: 'prod-kamaa',
      regionId: 'region-hama',
      quantity: 1,
      sellingPrice: 15,
      totalAmount: 15,
      shippingCost: 0,
      priceIncludesDelivery: true,
      currency: 'USD',
      status: 'NEW',
      source: 'Telegram',
    });
    expect(order.internalNotes).toContain('مرجع المصدر: 26818 · وقت الطلب بالمصدر: 2026-10-28 15:40:01 · العرض: القطعة ب 15 $ + توصيل مجاني');
    // Line 2 is kept as text only: the order's own time is the database's, the moment it arrived.
    expect(order).not.toHaveProperty('createdAt');
    // Line 1 reaches no order field but the notes.
    expect(Object.entries(order).filter(([k, v]) => k !== 'internalNotes' && String(v).includes('26818'))).toEqual([]);
    expect(state.items).toEqual([expect.objectContaining({ productId: 'prod-kamaa', quantity: 1, unitPrice: 15, lineTotal: 15 })]);

    expect(messageRow(id)).toMatchObject({ processingStatus: 'PROCESSED', orderId: order.id, reviewReason: null });
  });

  it('— the same message pressed again is the same order, not a second one', async () => {
    const id = arrive(sample());
    await processStoredMessage(id);
    const again = await processStoredMessage(id);
    expect(again).toMatchObject({ status: 'PROCESSED', orderId: state.orders[0].id });
    expect(state.orders).toHaveLength(1);
  });
});

describe('the money — at creation, and at the shipment that adds the fee', () => {
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

  it.each([
    // [store policy, line 7, the price includes delivery, at creation, at the shipment]
    [false, 'القطعة ب 15 $ + توصيل مجاني', true, 15, 15],
    [true, 'القطعة ب 15 $ + توصيل مجاني', true, 15, 15],
    [false, 'القطعة ب 15 $', false, 15, 18],
    [true, 'القطعة ب 15 $', true, 15, 15],
  ] as const)('store includes delivery: %s · «%s» → %s · %s at creation · %s at the shipment', async (policy, line7, includes, created, shipped) => {
    state.storePolicy = policy;
    await processStoredMessage(arrive(sample({ 7: line7 })));
    expect(state.orders).toHaveLength(1);
    expect(state.orders[0].priceIncludesDelivery).toBe(includes);
    expect(state.orders[0].totalAmount).toBe(created);
    expect(atShipment()).toBe(shipped);
    // The words set this order's flag; the store's own setting is never written.
    expect(state.storeWrites).toBe(0);
  });

  it('«القطعتين ب 25 $» — two pieces for 25: 12.5 a piece, unrounded, and 25 on the line', async () => {
    await processStoredMessage(arrive(sample({ 7: 'القطعتين ب 25 $' })));
    expect(state.orders[0]).toMatchObject({ quantity: 2, totalAmount: 25, sellingPrice: 12.5 });
    expect(state.items[0]).toMatchObject({ quantity: 2, unitPrice: 12.5, lineTotal: 25 });
    expect(atShipment()).toBe(28);
  });

  it('«3 قطع ب 40 $» — the total is 40, never 3 × 40 and never 3', async () => {
    await processStoredMessage(arrive(sample({ 7: '3 قطع ب 40 $' })));
    expect(state.orders[0]).toMatchObject({ quantity: 3, totalAmount: 40 });
    expect(state.items[0]).toMatchObject({ quantity: 3, lineTotal: 40 });
    expect(atShipment()).toBe(43);
  });

  it('a dinar keeps its three decimals: «القطعتين ب 14.255 د.أ» on a Jordanian store', async () => {
    state.country = { id: 'country-jo', code: 'JO', name: 'الأردن', currencyCode: 'JOD', minorUnit: 3, orderPrefix: 'JO' };
    state.regions = [{ id: 'region-amman', name: 'عمّان' }];
    await processStoredMessage(arrive(sample({ 4: '0791234567', 5: 'الأردن عمان', 7: 'القطعتين ب 14.255 د.أ' })));
    expect(state.orders[0]).toMatchObject({ quantity: 2, totalAmount: 14.255, currency: 'JOD', regionId: 'region-amman' });
    expect(state.items[0]).toMatchObject({ unitPrice: 7.1275, lineTotal: 14.255 });
    expect(atShipment(3)).toBe(17.255);
  });
});

describe('every refusal writes nothing — and says which line', () => {
  it.each([
    ['six lines', 'LINE_COUNT', sample().split('\n').slice(1).join('\n')],
    ['a date that is no date', 'BAD_DATE', sample({ 2: '2026-02-30 15:40:01' })],
    ['a date a month away', 'SOURCE_TIME_OFF', sample({ 2: '2026-09-28 15:40:01' })],
    ['a name with a digit', 'MISSING_CUSTOMER_NAME', sample({ 3: 'محمد 7' })],
    ['lines 4 and 5 swapped', 'INVALID_PHONE', sample({ 4: 'سوريا حماه', 5: '0932323642' })],
    ['another country', 'COUNTRY_MISMATCH', sample({ 5: 'الأردن عمان' })],
    ['the country and nothing else', 'MISSING_ADDRESS', sample({ 5: 'سوريا' })],
    ['a product nobody sells', 'PRODUCT_NOT_FOUND', sample({ 6: 'شي ما إله وجود' })],
    ['a product guessed from one shared word', 'PRODUCT_GUESSED', sample({ 6: 'ماء الورد الأصلي' })],
    ['no price', 'MISSING_PRICE', sample({ 7: 'القطعة' })],
    ['a price above the ceiling', 'MISSING_PRICE', sample({ 7: 'القطعة ب 150000 $' })],
    ['a thousands comma', 'OFFER_UNREADABLE', sample({ 7: 'القطعة ب 15,000 $' })],
    ['a fee in the message', 'DELIVERY_FEE_STATED', sample({ 7: 'القطعة ب 15 $ + 3 $ توصيل' })],
    ['another currency', 'CURRENCY_MISMATCH', sample({ 7: 'القطعة ب 150000 ل.س' })],
    ['a gift', 'GIFT_NEEDS_OFFER', sample({ 7: '3 قطع + 1 هدية ب 25 $' })],
  ])('%s → %s', async (_what, reason, text) => {
    const id = arrive(text);
    expect(await processStoredMessage(id)).toEqual({ status: 'NEEDS_REVIEW', reason });
    nothingWritten();
    expect(messageRow(id)).toMatchObject({ processingStatus: 'NEEDS_REVIEW', reviewReason: reason });
  });

  it('a blocked number goes to a person, and still nothing is written', async () => {
    state.blocks = [{ companyId: 'c1', phone: '932323642' }];
    const id = arrive(sample({ 4: '+963 932 323 642' }));
    expect(await processStoredMessage(id)).toEqual({ status: 'NEEDS_REVIEW', reason: 'CUSTOMER_BLOCKED' });
    nothingWritten();
  });

  it('a group no store owns is refused before its lines are judged', async () => {
    const id = arrive(sample({ 7: 'غلط' }), { sourceId: 'src-unplaced' });
    expect(await processStoredMessage(id)).toEqual({ status: 'NEEDS_REVIEW', reason: 'NO_STORE' });
    nothingWritten();
  });

  it('the lines are judged before the blacklist, in the design’s order', async () => {
    state.blocks = [{ companyId: 'c1', phone: '932323642' }];
    const id = arrive(sample({ 7: 'القطعة ب 15,000 $' }));
    expect(await processStoredMessage(id)).toMatchObject({ reason: 'OFFER_UNREADABLE' });
  });

  it('a claimed message is never IGNORED, even when it reads like chit-chat', async () => {
    const id = arrive(sample({ 3: 'شكرا', 6: 'وين طلبي' }));
    expect((await processStoredMessage(id)).status).toBe('NEEDS_REVIEW');
    expect(messageRow(id).processingStatus).toBe('NEEDS_REVIEW');
  });
});

describe('the place, as written — and the region it resolves to', () => {
  it.each([
    ['سوريا حماه', 'region-hama', 'حماه'],
    ['حماة', 'region-hama', 'حماة'],
    ['سوريا حماه السقيلبية', 'region-hama', 'حماه السقيلبية'],
    ['سوريا مصياف', null, 'مصياف'],
  ])('«%s» → %s', async (line5, region, written) => {
    await processStoredMessage(arrive(sample({ 5: line5 })));
    expect(state.orders[0].regionId).toBe(region);
    expect(state.customers[0]).toMatchObject({ address: written, city: written });
  });
});

describe('the same number, written two ways, is one customer', () => {
  it('«+963 932 323 642» after «0932323642»: one customer, and the + kept as typed', async () => {
    await processStoredMessage(arrive(sample()));
    await processStoredMessage(arrive(sample({ 1: '26819', 4: '+963 932 323 642' })));
    expect(state.orders).toHaveLength(2);
    expect(state.customers).toHaveLength(1);
    expect(state.orders[1].customerId).toBe(state.orders[0].customerId);
  });

  it('a new customer written with + keeps the + in what was typed', async () => {
    await processStoredMessage(arrive(sample({ 4: '+963 932 323 642' })));
    expect(state.customers[0]).toMatchObject({ phone: '932323642', rawPhone: '+963 932 323 642' });
  });
});

describe('one message, one order', () => {
  it('the same reference at the same time, posted again, is DUPLICATE_REF — and writes nothing', async () => {
    await processStoredMessage(arrive(sample()));
    const again = arrive(sample());
    expect(await processStoredMessage(again)).toEqual({ status: 'NEEDS_REVIEW', reason: 'DUPLICATE_REF' });
    expect(state.orders).toHaveLength(1);
    expect(state.customers).toHaveLength(1);
  });

  it('the key is BOTH lines: the same reference at another time, or another reference at the same time, is a new order', async () => {
    await processStoredMessage(arrive(sample()));
    await processStoredMessage(arrive(sample({ 2: '2026-10-28 15:41:30' })));
    await processStoredMessage(arrive(sample({ 1: '26819' })));
    expect(state.orders).toHaveLength(3);
  });

  it('a twin in ANOTHER store is not this store’s duplicate', async () => {
    state.products.push({ ...state.products[0], id: 'prod-kamaa-b', storeId: 'store-B' });
    await processStoredMessage(arrive(sample(), { sourceId: 'src-B' }));
    await processStoredMessage(arrive(sample()));
    expect(state.orders.map((o) => o.storeId)).toEqual(['store-B', 'store-A']);
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

  it('and the labeled path is held by the same link', async () => {
    const labeled = ['الاسم: سامر', 'الهاتف: 0933444555', 'المحافظة: حلب', 'المنتج: عسل السدر الأصلي', 'السعر: 30 $'].join('\n');
    const id = arrive(labeled);
    gate.waitFor = 2;
    gate.opened = new Promise<void>((resolve) => {
      gate.open = resolve;
    });
    await Promise.all([processStoredMessage(id), processStoredMessage(id)]);
    expect(state.orders).toHaveLength(1);
    expect(messageRow(id)).toMatchObject({ processingStatus: 'PROCESSED', orderId: state.orders[0].id });
  });
});

describe('line 6 reads THIS store’s shelf only', () => {
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

  it('and when both stores sell it, the order carries this store’s product', async () => {
    state.products.push({ ...state.products[0], id: 'prod-kamaa-b', storeId: 'store-B' });
    await processStoredMessage(arrive(sample()));
    expect(state.orders[0].productId).toBe('prod-kamaa');
  });
});

describe('a message with labels keeps the path it had', () => {
  it('the docs example still ends at MISSING_PRICE — it has no «السعر:», and basePrice is never used instead', async () => {
    const id = arrive(['طلب جديد', 'الاسم: أحمد', 'الهاتف: 0933444555', 'العنوان: عرفات', 'المنتج: ماء الكمأ الأصلي', 'الكمية: 2'].join('\n'));
    expect(await processStoredMessage(id)).toEqual({ status: 'NEEDS_REVIEW', reason: 'MISSING_PRICE' });
    expect(state.orders).toEqual([]);
  });

  it('and with «السعر:» it becomes an order, priced from the message and by the store’s policy alone', async () => {
    const id = arrive(['الاسم: أحمد', 'الهاتف: 0933444555', 'العنوان: عرفات', 'المنتج: ماء الكمأ الأصلي', 'الكمية: 2', 'السعر: 30 $ + توصيل مجاني'].join('\n'));
    expect((await processStoredMessage(id)).status).toBe('PROCESSED');
    expect(state.orders[0]).toMatchObject({ quantity: 2, totalAmount: 30, priceIncludesDelivery: false });
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
  });

  it('and another store’s ignored message is not found by this store’s retry', async () => {
    const id = arrive(sample(), { sourceId: 'src-B', processingStatus: 'IGNORED' });
    expect((await retry(id)).status).toBe(404);
    expect(state.orders).toEqual([]);
  });
});
