import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE YOUCAN UPSELL AND THE OLD NAMES, AGAINST A DATABASE THAT REMEMBERS WHAT WAS WRITTEN (10/11).
 *
 * The owner: «YouCan upsell orders arrive as TWO Telegram messages with the SAME رقم الطلب. In BOTH messages السعر = the full
 * order total.» and «Order 30051: «عبوة واحدة: 20 دولار مع توصيل مجاني.» (40) + «كورس طنين: عبوتين إضافيات 🎁» (40) → ONE
 * order, 3 units, 40$.» — then the old product names of the orders received before the rename of 2026-11-10.
 *
 * The fake keeps rows, as `labeled-door.test.ts` does, and its transaction UNDOES what it wrote when it throws (a merged order
 * links two messages; when the second link fails the first must not stay). The partner query is answered by the predicate the
 * door sends (source, number in the text, window, status, no order), so a pair that is not found here would not be found there.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a fake row: every test reads its own fields
type Row = Record<string, any>;

const { db, state, gate } = vi.hoisted(() => {
  const state = {
    messages: [] as Row[],
    sources: [] as Row[],
    products: [] as Row[],
    aliases: [] as Row[],
    customers: [] as Row[],
    blocks: [] as Row[],
    orders: [] as Row[],
    items: [] as Row[],
    offers: [] as Row[],
    storePolicy: false,
    figures: {} as Record<string, number>,
    country: { id: 'country-sy', code: 'SY', name: 'سوريا', currencyCode: 'USD', minorUnit: 2, orderPrefix: 'SY' },
    seq: 0,
    writes: 0,
  };
  const gate = { waitFor: 1, inside: 0, open: () => {}, opened: Promise.resolve() };

  const sourceOf = (m: Row) => state.sources.find((s) => s.id === m.sourceId) ?? null;
  const statusMatches = (row: Row, want: unknown) =>
    want === undefined || (typeof want === 'string' ? row.processingStatus === want : (want as { in: string[] }).in.includes(row.processingStatus));
  const orderIdMatches = (row: Row, want: unknown) =>
    want === undefined || (want === null ? row.orderId == null : 'not' in (want as Row) ? row.orderId != null : row.orderId === want);
  const textMatches = (row: Row, cond: Row) => String(row.text ?? '').includes(cond.text.contains);
  const scopeMatches = (m: Row, cond: Row): boolean => {
    if ('sourceId' in cond) return m.sourceId === cond.sourceId;
    if (cond.source) return (sourceOf(m)?.storeId ?? null) === cond.source.storeId;
    if (cond.OR) return cond.OR.some((c: Row) => scopeMatches(m, c));
    return true;
  };
  const project = (m: Row, select?: Row) => {
    if (!select) return { ...m };
    const out: Row = {};
    for (const key of Object.keys(select)) {
      if (key === 'order') {
        const order = state.orders.find((o) => o.id === m.orderId);
        out.order = order ? { id: order.id, orderNumber: order.orderNumber, productId: order.productId } : null;
      } else out[key] = m[key];
    }
    return out;
  };

  const messageWhere = (m: Row, where: Row) =>
    m.companyId === where.companyId &&
    (!where.id?.not || m.id !== where.id.not) &&
    (!('sourceId' in where) || m.sourceId === where.sourceId) &&
    statusMatches(m, where.processingStatus) &&
    orderIdMatches(m, where.orderId) &&
    (!where.createdAt?.gte || m.createdAt >= where.createdAt.gte) &&
    (!where.createdAt?.lte || m.createdAt <= where.createdAt.lte) &&
    (!where.source || (sourceOf(m)?.storeId ?? null) === where.source.storeId) &&
    (!where.reviewReason?.startsWith || String(m.reviewReason ?? '').startsWith(where.reviewReason.startsWith)) &&
    (!where.OR || where.OR.some((c: Row) => (c.text ? textMatches(m, c) : scopeMatches(m, c)))) &&
    (!where.AND || where.AND.every((c: Row) => scopeMatches(m, c)));

  const db: Row = {
    telegramMessage: {
      findUnique: vi.fn(async ({ where }: Row) => {
        const m = state.messages.find((x) => x.id === where.id);
        return m ? { ...m } : null;
      }),
      update: vi.fn(async ({ where, data }: Row) => {
        state.writes++;
        return Object.assign(state.messages.find((x) => x.id === where.id)!, data);
      }),
      updateMany: vi.fn(async ({ where, data }: Row) => {
        const m = state.messages.find((x) => x.id === where.id);
        if (!m) return { count: 0 };
        if (where.companyId && m.companyId !== where.companyId) return { count: 0 };
        if (!orderIdMatches(m, where.orderId)) return { count: 0 };
        if (!statusMatches(m, where.processingStatus)) return { count: 0 };
        state.writes++;
        Object.assign(m, data);
        return { count: 1 };
      }),
      findMany: vi.fn(async ({ where, select, take }: Row) =>
        state.messages
          .filter((m) => messageWhere(m, where))
          .sort((a, b) => a.createdAt - b.createdAt)
          .slice(0, take ?? 1000)
          .map((m) => project(m, select))
      ),
    },
    telegramUpsellProduct: {
      findMany: vi.fn(async ({ where }: Row) =>
        state.aliases
          .filter((a) => a.companyId === where.companyId && a.storeId === where.storeId)
          .filter((a) => where.isActive === undefined || a.isActive === where.isActive)
          .map((a) => ({ ...a }))
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
          (p) => p.companyId === where.companyId && (!('storeId' in where) || p.storeId === where.storeId) && (where.status === undefined || p.status === where.status)
        )
      ),
      findFirst: vi.fn(async ({ where }: Row) => {
        const p = state.products.find((x) => x.id === where.id && x.companyId === where.companyId);
        return p ? { ...p } : null;
      }),
    },
    productFixedCost: {
      findMany: vi.fn(async ({ where }: Row) =>
        Object.entries(state.figures)
          .filter(([productId]) => where.productId.in.includes(productId))
          .map(([productId, amount]) => ({ productId, amount }))
      ),
    },
    productionBatch: { findMany: vi.fn(async () => []) },
    customerBlock: {
      findFirst: vi.fn(async ({ where }: Row) =>
        state.blocks.find((b) => b.companyId === where.companyId && (typeof where.phone === 'string' ? b.phone === where.phone : where.phone.in.includes(b.phone))) ?? null
      ),
    },
    customer: {
      findFirst: vi.fn(async ({ where }: Row) =>
        state.customers.find(
          (c) => c.companyId === where.companyId && c.storeId === where.storeId && (typeof where.phone === 'string' ? c.phone === where.phone : where.phone.in.includes(c.phone))
        ) ?? null
      ),
      create: vi.fn(async ({ data }: Row) => {
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
        if (where.id !== 'store-A') return null;
        const { currencyCode, orderPrefix, minorUnit } = state.country;
        return { id: where.id, countryId: state.country.id, country: { currencyCode, orderPrefix, minorUnit } };
      }),
      update: vi.fn(async () => ({})),
    },
    region: { findMany: vi.fn(async () => [{ id: 'region-damascus', name: 'دمشق' }]) },
    offer: {
      findMany: vi.fn(async ({ where }: Row) =>
        state.offers
          .filter((o) => o.companyId === where.companyId && o.productId === where.productId)
          .filter((o) => o.status === where.status && o.postOrderOffer === where.postOrderOffer)
          .map((o) => ({ ...o }))
      ),
    },
    order: {
      groupBy: vi.fn(async () => []),
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => {
        throw new Error('an order is written inside a transaction or not at all');
      }),
    },
    orderItem: { create: vi.fn() },
    orderActivity: { create: vi.fn(async () => ({})) },
    orderStatusLog: { create: vi.fn(async () => ({})) },
    $queryRaw: vi.fn(async () => [{ highest: null }]),
    $transaction: vi.fn(async (fn: (tx: Row) => Promise<unknown>) => {
      const orders: Row[] = [];
      const items: Row[] = [];
      // What this transaction wrote on a message, to put back if it throws (Postgres rolls the link back with the order).
      const mine: Array<() => void> = [];
      const tx = {
        ...db,
        telegramMessage: {
          ...db.telegramMessage,
          updateMany: async (args: Row) => {
            const m = state.messages.find((x) => x.id === args.where.id);
            const before = m ? { ...m } : null;
            const out = await db.telegramMessage.updateMany(args);
            if (out.count === 1 && m && before) mine.push(() => Object.assign(m, before));
            return out;
          },
        },
        order: {
          ...db.order,
          create: async ({ data }: Row) => {
            const row = { id: `o${++state.seq}`, orderNumber: `SY-${state.seq}`, ...data };
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
      try {
        const out = await fn(tx);
        state.orders.push(...orders);
        state.items.push(...items);
        return out;
      } catch (e) {
        for (const back of mine.reverse()) back();
        throw e;
      }
    }),
  };
  return { db, state, gate };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/notify', () => ({ notify: vi.fn() }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));

import { planStoredMessage, processStoredMessage } from './inbound';
import { createTelegramOrder } from './order-creation';
import { releaseExpiredHolds } from './holds';
import { judgePair, UPSELL_HOLD_MS } from './upsell-pair';
import { aliasFor, pickAliasedOffer, toAliasRow } from './aliases';
import { notify } from '@/lib/notify';
import { logAudit } from '@/lib/audit';

const ARRIVED = new Date('2026-11-10T09:00:00Z');
const MIN = 60 * 1000;
const TINNITUS_OFFER = 'عبوة واحدة: 20 دولار مع توصيل مجاني.';
const TINNITUS_UPSELL = 'كورس طنين: عبوتين إضافيات 🎁';

/** One message in the site's format: the order number first, then the eight labels. */
const message = (over: Record<string, string | null> = {}) =>
  (
    [
      ['رقم الطلب', '30051'],
      ['تاريخ الطلب', '2026-11-10 12:00:00'],
      ['إسم العميل', 'سامر الحلبي'],
      ['رقم الهاتف', '0933111222'],
      ['عنوان العميل', 'دمشق سوريا'],
      ['إسم المنتج', 'قطرة طنين الأذن'],
      ['إسم العرض', TINNITUS_OFFER],
      ['السعر', '40'],
      ['الكمية', '1'],
    ] as Array<[string, string]>
  )
    .filter(([label]) => over[label] !== null)
    .map(([label, value]) => `${label}: ${over[label] ?? value}`)
    .join('\n');
const upsellMessage = (over: Record<string, string | null> = {}) =>
  message({ 'إسم المنتج': TINNITUS_UPSELL, 'إسم العرض': 'default', ...over });

let messageSeq = 0;
const arrive = (text: string, over: Row = {}) => {
  const id = `m${++messageSeq}`;
  state.messages.push({
    id,
    companyId: 'c1',
    sourceId: 'src-A',
    chatId: '-100',
    messageId: String(1000 + messageSeq),
    threadId: null,
    threadName: null,
    text,
    processingStatus: 'PENDING',
    reviewReason: null,
    orderId: null,
    createdAt: ARRIVED,
    ...over,
  });
  return id;
};
const row = (id: string) => state.messages.find((m) => m.id === id)!;
const at = (minutes: number) => new Date(ARRIVED.getTime() + minutes * MIN);

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
const product = (id: string, name: string, over: Row = {}): Row => ({
  id,
  companyId: 'c1',
  storeId: 'store-A',
  status: 'ACTIVE',
  name,
  nameEn: null,
  sku: id.toUpperCase(),
  basePrice: 20,
  image: null,
  ...over,
});
const alias = (over: Row): Row => ({
  id: `al${++state.seq}`,
  companyId: 'c1',
  storeId: 'store-A',
  kind: 'UPSELL',
  extraUnits: null,
  linePrice: null,
  offerAliases: null,
  isActive: true,
  ...over,
  foldedName: over.foldedName ?? fold(over.incomingName),
});
import { foldOfferText as fold } from './offer-text';

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state, {
    messages: [],
    sources: [{ id: 'src-A', storeId: 'store-A' }, { id: 'src-A2', storeId: 'store-A' }],
    products: [
      product('prod-tinnitus', 'قطرة طنين الأذن'),
      product('prod-silk', 'كريم حرير'),
      product('prod-scar', 'كريم إزالة الندبات الألماني الأصلي'),
      product('prod-kamaa', 'ماء الكمأ'),
    ],
    aliases: [],
    customers: [],
    blocks: [],
    orders: [],
    items: [],
    offers: [
      offerRow({ id: 'of-tinnitus-1', productId: 'prod-tinnitus', name: TINNITUS_OFFER, quantity: 1, sellingPrice: 20 }),
      offerRow({ id: 'of-silk-1', productId: 'prod-silk', name: 'عبوة واحدة', quantity: 1, sellingPrice: 20 }),
      offerRow({ id: 'of-silk-2', productId: 'prod-silk', name: 'عبوتين', quantity: 2, sellingPrice: 35, sortOrder: 1 }),
      offerRow({ id: 'of-silk-3', productId: 'prod-silk', name: '3 عبوات', quantity: 3, sellingPrice: 45, sortOrder: 2 }),
      offerRow({ id: 'of-scar-1', productId: 'prod-scar', name: 'عبوة واحدة', quantity: 1, sellingPrice: 20 }),
      offerRow({ id: 'of-kamaa', productId: 'prod-kamaa', name: 'قطعتين + قطعة هدية', quantity: 2, freeQuantity: 1, sellingPrice: 25 }),
    ],
    storePolicy: false,
    figures: {},
    country: { id: 'country-sy', code: 'SY', name: 'سوريا', currencyCode: 'USD', minorUnit: 2, orderPrefix: 'SY' },
    seq: 0,
    writes: 0,
  });
  state.aliases = [
    alias({ incomingName: TINNITUS_UPSELL, productId: 'prod-tinnitus', extraUnits: 2, linePrice: 20 }),
    alias({ incomingName: 'كورس حرير: عبوتين إضافيات 🎁', productId: 'prod-silk', extraUnits: 2, linePrice: 20 }),
  ];
  gate.waitFor = 1;
  gate.inside = 0;
});

const nothingWritten = () => {
  expect(state.customers, 'زبون انكتب').toEqual([]);
  expect(state.orders, 'طلب انكتب').toEqual([]);
  expect(state.items, 'سطر طلب انكتب').toEqual([]);
};

/** The order the pair made: one order, both messages on it. */
const theMergedOrder = (a: string, b: string) => {
  expect(state.orders).toHaveLength(1);
  const [order] = state.orders;
  expect(row(a)).toMatchObject({ processingStatus: 'PROCESSED', orderId: order.id, reviewReason: null });
  expect(row(b)).toMatchObject({ processingStatus: 'PROCESSED', orderId: order.id, reviewReason: null });
  return order;
};

describe('QUALITY GATES (the owner’s three, as he wrote them)', () => {
  it('order 30051: «عبوة واحدة: 20 دولار مع توصيل مجاني.» (40) + «كورس طنين: عبوتين إضافيات 🎁» (40) → ONE order, 3 units, 40$', async () => {
    const base = arrive(message());
    const first = await processStoredMessage(base, { now: at(0) });
    // The base alone waits for its upsell, and nothing is written yet.
    expect(first).toMatchObject({ status: 'NEEDS_REVIEW', reason: expect.stringMatching(/^WAITING_FOR_UPSELL:/) });
    nothingWritten();

    const upsell = arrive(upsellMessage(), { createdAt: at(1) });
    const second = await processStoredMessage(upsell, { now: at(1) });
    expect(second.status).toBe('PROCESSED');

    const order = theMergedOrder(base, upsell);
    expect(second.orderId).toBe(order.id);
    expect(order).toMatchObject({ totalAmount: 40, productId: 'prod-tinnitus', offerId: 'of-tinnitus-1', quantity: 1, freeQuantity: 0, sellingPrice: 20, currency: 'USD', source: 'Telegram' });
    expect(state.items).toEqual([
      expect.objectContaining({ productId: 'prod-tinnitus', quantity: 1, freeQuantity: 0, unitPrice: 20, lineTotal: 20, addedStage: 'INTAKE' }),
      expect.objectContaining({ productId: 'prod-tinnitus', quantity: 2, freeQuantity: 0, unitPrice: 10, lineTotal: 20, addedStage: 'INTAKE' }),
    ]);
    const units = state.items.reduce((sum, i) => sum + i.quantity + i.freeQuantity, 0);
    expect(units).toBe(3);
    // The two written prices are never added: 40, not 80.
    expect(order.totalAmount).not.toBe(80);
    expect(order.internalNotes).toContain(`دمج أب سيل: ${TINNITUS_UPSELL} · +2 عبوات · 20.00`);
    expect(order.internalNotes).toContain(`رسائل تلجرام: ${row(base).messageId} + ${row(upsell).messageId}`);
    // The order number is a pairing key and nothing else: not on the order, not on the customer.
    expect(JSON.stringify([state.orders, state.items, state.customers])).not.toContain('30051');
  });

  it('upsell message first, then the base → the same order', async () => {
    const upsell = arrive(upsellMessage());
    expect(await processStoredMessage(upsell, { now: at(0) })).toMatchObject({
      status: 'NEEDS_REVIEW',
      reason: expect.stringMatching(/^WAITING_FOR_BASE:/),
    });
    nothingWritten();
    const base = arrive(message(), { createdAt: at(3) });
    expect((await processStoredMessage(base, { now: at(3) })).status).toBe('PROCESSED');
    const order = theMergedOrder(base, upsell);
    expect(order).toMatchObject({ totalAmount: 40, productId: 'prod-tinnitus', offerId: 'of-tinnitus-1' });
    expect(state.items.map((i) => [i.quantity, i.lineTotal])).toEqual([[1, 20], [2, 20]]);
  });

  it('a base price mismatch with no upsell → stays in review (waits, then PRICE_MISMATCH), nothing written', async () => {
    const base = arrive(message());
    await processStoredMessage(base, { now: at(0) });
    expect(row(base).reviewReason).toMatch(/^WAITING_FOR_UPSELL:/);
    await releaseExpiredHolds('c1', at(11));
    expect(row(base)).toMatchObject({ processingStatus: 'NEEDS_REVIEW', reviewReason: 'PRICE_MISMATCH:20.00', orderId: null });
    nothingWritten();
  });
});

describe('the ten-minute wait', () => {
  it('waits with its until-time, and the partner inside the window makes both PROCESSED on ONE order', async () => {
    const base = arrive(message());
    await processStoredMessage(base, { now: at(0) });
    expect(row(base).reviewReason).toBe(`WAITING_FOR_UPSELL:${new Date(ARRIVED.getTime() + UPSELL_HOLD_MS).toISOString()}`);
    // A release before the time changes nothing.
    expect(await releaseExpiredHolds('c1', at(9))).toBe(0);
    expect(row(base).reviewReason).toMatch(/^WAITING_FOR_UPSELL:/);
    const upsell = arrive(upsellMessage(), { createdAt: at(9) });
    await processStoredMessage(upsell, { now: at(9) });
    theMergedOrder(base, upsell);
  });

  it('after ten minutes the wait is released with its natural reason, and a late partner does not pair live', async () => {
    const upsell = arrive(upsellMessage());
    await processStoredMessage(upsell, { now: at(0) });
    expect(await releaseExpiredHolds('c1', at(10.5))).toBe(1);
    expect(row(upsell).reviewReason).toBe('UPSELL_WITHOUT_BASE');

    // The base comes at minute 11: outside the window, it waits on its own, and then gets its own reason.
    const base = arrive(message(), { createdAt: at(11) });
    expect(await processStoredMessage(base, { now: at(11) })).toMatchObject({ reason: expect.stringMatching(/^WAITING_FOR_UPSELL:/) });
    await releaseExpiredHolds('c1', at(30));
    expect(row(base).reviewReason).toBe('PRICE_MISMATCH:20.00');
    expect(row(upsell).reviewReason).toBe('UPSELL_WITHOUT_BASE');
    nothingWritten();
  });

  it('two messages arriving at the same moment make ONE order; the loser answers with the winner’s order', async () => {
    const base = arrive(message());
    const upsell = arrive(upsellMessage());
    gate.waitFor = 2;
    gate.opened = new Promise<void>((resolve) => {
      gate.open = resolve;
    });
    const [a, b] = await Promise.all([processStoredMessage(base, { now: at(0) }), processStoredMessage(upsell, { now: at(0) })]);
    expect(gate.inside, 'the two did not meet inside the transaction').toBe(2);
    const order = theMergedOrder(base, upsell);
    expect(state.items).toHaveLength(2);
    expect(a).toEqual({ status: 'PROCESSED', orderId: order.id });
    expect(b).toEqual({ status: 'PROCESSED', orderId: order.id });
  });

  it('a hold is never written over a message the other half has just linked', async () => {
    const base = arrive(message());
    const upsell = arrive(upsellMessage(), { createdAt: at(1) });
    await processStoredMessage(base, { now: at(0) });
    await processStoredMessage(upsell, { now: at(1) });
    // Pressed again later: already processed, nothing changes.
    expect(await processStoredMessage(base, { now: at(20) })).toMatchObject({ status: 'PROCESSED', reason: 'ALREADY_PROCESSED' });
    theMergedOrder(base, upsell);
  });

  it('a held message never creates anything by itself', async () => {
    arrive(upsellMessage());
    await processStoredMessage(state.messages[0].id, { now: at(0) });
    await releaseExpiredHolds('c1', at(60));
    nothingWritten();
  });
});

describe('two messages that share a number but are not one order', () => {
  const pairOf = async (baseOver: Record<string, string | null>, upsellOver: Record<string, string | null>) => {
    const base = arrive(message(baseOver));
    await processStoredMessage(base, { now: at(0) });
    const upsell = arrive(upsellMessage(upsellOver), { createdAt: at(1) });
    const result = await processStoredMessage(upsell, { now: at(1) });
    return { base, upsell, result };
  };

  it('different phones → UPSELL_PAIR_MISMATCH, nothing written', async () => {
    const { result } = await pairOf({}, { 'رقم الهاتف': '0944999888' });
    expect(result).toEqual({ status: 'NEEDS_REVIEW', reason: 'UPSELL_PAIR_MISMATCH' });
    nothingWritten();
  });

  it('different written prices → UPSELL_PAIR_MISMATCH', async () => {
    const { result } = await pairOf({}, { 'السعر': '45' });
    expect(result).toEqual({ status: 'NEEDS_REVIEW', reason: 'UPSELL_PAIR_MISMATCH' });
    nothingWritten();
  });

  it('offer + upsell ≠ السعر → UPSELL_PRICE_MISMATCH with what they really come to', async () => {
    const { result } = await pairOf({ 'السعر': '50' }, { 'السعر': '50' });
    expect(result).toEqual({ status: 'NEEDS_REVIEW', reason: 'UPSELL_PRICE_MISMATCH:40.00' });
    nothingWritten();
  });

  it('an upsell «الكمية» of 0 is the reader’s refusal, 21 is the upsell’s', async () => {
    expect(await processStoredMessage(arrive(upsellMessage({ 'الكمية': '0' })), { now: at(0) })).toEqual({ status: 'NEEDS_REVIEW', reason: 'INVALID_QUANTITY' });
    expect(await processStoredMessage(arrive(upsellMessage({ 'الكمية': '21' })), { now: at(0) })).toEqual({
      status: 'NEEDS_REVIEW',
      reason: 'UPSELL_QUANTITY_INVALID',
    });
    nothingWritten();
  });

  it('«الكمية: 2» on the upsell is two of it: 4 units for 40 — the price must say so', async () => {
    const base = arrive(message({ 'السعر': '60' }));
    await processStoredMessage(base, { now: at(0) });
    const upsell = arrive(upsellMessage({ 'السعر': '60', 'الكمية': '2' }), { createdAt: at(1) });
    await processStoredMessage(upsell, { now: at(1) });
    const order = theMergedOrder(base, upsell);
    // The upsell line is worth 40 against the base's 20: it heads the order.
    expect(order).toMatchObject({ totalAmount: 60, productId: 'prod-tinnitus', offerId: null, quantity: 4, sellingPrice: 40 });
    expect(state.items.map((i) => [i.quantity, i.lineTotal])).toEqual([[1, 20], [4, 40]]);
  });

  it('a switched-off upsell name is not an upsell: the message is an unknown product, as before', async () => {
    state.aliases[0].isActive = false;
    const result = await processStoredMessage(arrive(upsellMessage()), { now: at(0) });
    expect(result.status).toBe('NEEDS_REVIEW');
    expect(['PRODUCT_NOT_FOUND', 'PRODUCT_GUESSED']).toContain(result.reason);
    nothingWritten();
  });

  it('an unknown upsell-looking name stays PRODUCT_NOT_FOUND', async () => {
    const result = await processStoredMessage(arrive(upsellMessage({ 'إسم المنتج': 'كورس زعفران: عبوتين إضافيات 🎁' })), { now: at(0) });
    expect(result).toEqual({ status: 'NEEDS_REVIEW', reason: 'PRODUCT_NOT_FOUND' });
  });

  it('an upsell whose product is not active in the store → UPSELL_PRODUCT_UNAVAILABLE', async () => {
    state.products[0].status = 'OUT_OF_STOCK';
    expect(await processStoredMessage(arrive(upsellMessage()), { now: at(0) })).toEqual({
      status: 'NEEDS_REVIEW',
      reason: 'UPSELL_PRODUCT_UNAVAILABLE',
    });
  });

  it('two candidate partners → UPSELL_PAIR_AMBIGUOUS, nothing written', async () => {
    arrive(upsellMessage(), { processingStatus: 'NEEDS_REVIEW', reviewReason: 'WAITING_FOR_BASE:x' });
    arrive(upsellMessage(), { processingStatus: 'NEEDS_REVIEW', reviewReason: 'WAITING_FOR_BASE:x', messageId: '7777' });
    const base = arrive(message(), { createdAt: at(2) });
    expect(await processStoredMessage(base, { now: at(2) })).toEqual({ status: 'NEEDS_REVIEW', reason: 'UPSELL_PAIR_AMBIGUOUS' });
    nothingWritten();
  });

  it('a base priced BELOW its offer never waits: PRICE_MISMATCH at once', async () => {
    expect(await processStoredMessage(arrive(message({ 'السعر': '15' })), { now: at(0) })).toEqual({
      status: 'NEEDS_REVIEW',
      reason: 'PRICE_MISMATCH:20.00',
    });
  });

  it('the same number from ANOTHER source is not a partner', async () => {
    arrive(upsellMessage(), { sourceId: 'src-A2', processingStatus: 'NEEDS_REVIEW', reviewReason: 'WAITING_FOR_BASE:x' });
    const base = arrive(message(), { createdAt: at(1) });
    expect(await processStoredMessage(base, { now: at(1) })).toMatchObject({ reason: expect.stringMatching(/^WAITING_FOR_UPSELL:/) });
    nothingWritten();
  });

  it('a message without a number cannot pair: the base gets PRICE_MISMATCH, the upsell UPSELL_WITHOUT_BASE — no wait', async () => {
    expect(await processStoredMessage(arrive(message({ 'رقم الطلب': null })), { now: at(0) })).toMatchObject({ reason: 'PRICE_MISMATCH:20.00' });
    expect(await processStoredMessage(arrive(upsellMessage({ 'رقم الطلب': null })), { now: at(0) })).toMatchObject({ reason: 'UPSELL_WITHOUT_BASE' });
  });
});

describe('everything that is not a pair is exactly what it was', () => {
  it('a base whose price IS its offer’s becomes its order at once, and no partner is looked for', async () => {
    const id = arrive(message({ 'السعر': '20' }));
    expect((await processStoredMessage(id, { now: at(0) })).status).toBe('PROCESSED');
    expect(state.orders[0]).toMatchObject({ totalAmount: 20, quantity: 1 });
    expect(state.items).toHaveLength(1);
    const partnerQueries = db.telegramMessage.findMany.mock.calls.filter(([args]: [Row]) => args.where.orderId === null);
    expect(partnerQueries).toEqual([]);
  });

  it('in a store with NO upsell names an over-priced base is PRICE_MISMATCH at once, as before', async () => {
    state.aliases = [];
    expect(await processStoredMessage(arrive(message()), { now: at(0) })).toEqual({ status: 'NEEDS_REVIEW', reason: 'PRICE_MISMATCH:20.00' });
  });
});

describe('the money of a merged order', () => {
  it('3 units for 20 (unit price 6.667): the line total stays 20.00 and the order total is exact', async () => {
    state.aliases[0] = { ...state.aliases[0], extraUnits: 3, linePrice: 20 };
    const base = arrive(message());
    await processStoredMessage(base, { now: at(0) });
    const upsell = arrive(upsellMessage(), { createdAt: at(1) });
    await processStoredMessage(upsell, { now: at(1) });
    const order = theMergedOrder(base, upsell);
    expect(order.totalAmount).toBe(40);
    expect(state.items[1]).toMatchObject({ quantity: 3, lineTotal: 20 });
    expect(state.items[1].unitPrice).toBeCloseTo(20 / 3, 12);
  });

  it('delivery-included comes from the base offer, and is never forced off', async () => {
    const run = async () => {
      state.messages = [];
      state.orders = [];
      state.items = [];
      state.customers = [];
      const base = arrive(message());
      await processStoredMessage(base, { now: at(0) });
      const upsell = arrive(upsellMessage(), { createdAt: at(1) });
      await processStoredMessage(upsell, { now: at(1) });
      return state.orders[0];
    };
    expect((await run()).priceIncludesDelivery).toBe(true);
    state.offers[0].deliveryIncluded = false;
    expect((await run()).priceIncludesDelivery).toBe(false);
    state.storePolicy = true;
    expect((await run()).priceIncludesDelivery).toBe(true);
  });

  it('the base offer’s gift units count in the stock and the cost of goods: the cost is the sum over every line', async () => {
    // A base with a gift: «قطعتين + قطعة هدية» of ماء الكمأ (25), and a kamaa upsell (+3 for 20) → 45.
    state.aliases.push(alias({ incomingName: 'كورس كمأة كامل: 3 عبوات زيادة 🎁', productId: 'prod-kamaa', extraUnits: 3, linePrice: 20 }));
    state.figures = { 'prod-kamaa': 4 };
    const base = arrive(message({ 'إسم المنتج': 'ماء الكمأ', 'إسم العرض': 'قطعتين + قطعة هدية', 'السعر': '45' }));
    await processStoredMessage(base, { now: at(0) });
    const upsell = arrive(upsellMessage({ 'إسم المنتج': 'كورس كمأة كامل: 3 عبوات زيادة 🎁', 'السعر': '45' }), { createdAt: at(1) });
    await processStoredMessage(upsell, { now: at(1) });
    const order = theMergedOrder(base, upsell);
    expect(order.totalAmount).toBe(45);
    expect(state.items.map((i) => [i.quantity, i.freeQuantity])).toEqual([[2, 1], [3, 0]]);
    // (2 + 1 + 3) units × 4 = 24.
    expect(order.estimatedCostOfGoods).toBe(24);
  });
});

describe('the order a merge writes', () => {
  it('notifies once and audits once, with both messages named', async () => {
    const base = arrive(message());
    await processStoredMessage(base, { now: at(0) });
    const upsell = arrive(upsellMessage(), { createdAt: at(1) });
    await processStoredMessage(upsell, { now: at(1) });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logAudit).mock.calls[0][0]).toMatchObject({ action: 'ORDER_CREATED_TELEGRAM', newData: { telegramMessageRowIds: [base, upsell] } });
    const activity = db.orderActivity.create.mock.calls[0][0].data;
    expect(JSON.parse(activity.metadata)).toMatchObject({ telegramMessageRowIds: [base, upsell] });
  });

  it('rolls the whole order back when either message is already linked — the first link included', async () => {
    const a = arrive(message());
    const b = arrive(upsellMessage(), { orderId: 'o-elsewhere' });
    const line = { product: { id: 'prod-tinnitus', name: 'قطرة طنين الأذن', image: null, basePrice: 20 }, offer: null, quantity: 1, freeQuantity: 0, unitPrice: 20, offerDiscount: 0 };
    const result = await createTelegramOrder({
      companyId: 'c1',
      storeId: 'store-A',
      customer: { id: 'cu-x', firstOrderDate: null, totalOrders: 0 },
      product: line.product,
      line,
      extraLines: [{ ...line, quantity: 2, unitPrice: 10 }],
      address: 'دمشق',
      linkMessageIds: [a, b],
      telegram: { messageId: '1', chatId: '-100', threadId: null },
    });
    expect(result).toEqual({ ok: false, reason: 'ALREADY_LINKED' });
    expect(state.orders).toEqual([]);
    expect(state.items).toEqual([]);
    expect(row(a).orderId).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('the pure verdict', () => {
  const baseLine = { product: { id: 'p', name: 'p', image: null, basePrice: 20 }, offer: null, quantity: 1, freeQuantity: 0, unitPrice: 20, offerDiscount: 0 };
  const pair = (over: Row = {}) =>
    judgePair({
      base: { written: 40, phoneKey: '933111222', line: baseLine },
      upsell: { written: 40, phoneKey: '933111222', count: 1, alias: { extraUnits: 2, linePrice: 20 }, product: baseLine.product },
      minorUnit: 2,
      ...over,
    });
  it('is the gate: 20 + 20 = 40, three units', () => {
    expect(pair()).toMatchObject({ ok: true, total: 40, units: 3 });
  });
  it('refuses a JOD figure with a fils too many', () => {
    expect(
      judgePair({
        base: { written: 40.001, phoneKey: 'x', line: baseLine },
        upsell: { written: 40.001, phoneKey: 'x', count: 1, alias: { extraUnits: 2, linePrice: 20 }, product: baseLine.product },
        minorUnit: 3,
      })
    ).toEqual({ ok: false, reason: 'UPSELL_PRICE_MISMATCH:40.000' });
  });
});

describe('THE OLD NAMES (orders received before the rename of 2026-11-10)', () => {
  beforeEach(() => {
    state.aliases.push(
      alias({
        kind: 'RENAMED',
        incomingName: '✨ بديل الليزر... الآن بين يديك! ✨',
        productId: 'prod-silk',
        offerAliases: [
          { name: 'عبوة عدد 1 = 20 دولار + توصيل مجاني', foldedName: fold('عبوة عدد 1 = 20 دولار + توصيل مجاني'), quantity: 1, price: 20 },
          { name: 'عبوة عدد 2 = 35 دولار + توصيل مجاني', foldedName: fold('عبوة عدد 2 = 35 دولار + توصيل مجاني'), quantity: 2, price: 35 },
          { name: 'عبوة عدد 3= 45 دولار + توصيل مجاني', foldedName: fold('عبوة عدد 3= 45 دولار + توصيل مجاني'), quantity: 3, price: 45 },
        ],
      }),
      alias({ kind: 'RENAMED', incomingName: 'ALBETCHU لإخفاء مظهر الندبات', productId: 'prod-scar' }),
      alias({ kind: 'RENAMED', incomingName: 'ماء الكمأ الأصلي', productId: 'prod-kamaa' }),
      alias({ kind: 'RENAMED', incomingName: 'قطرة  طنين الأذن', productId: 'prod-tinnitus' })
    );
  });
  const old = (over: Record<string, string | null>) => message({ 'رقم الطلب': null, ...over });

  it.each([
    ['the emoji one', '✨ بديل الليزر... الآن بين يديك! ✨', 'عبوة واحدة', '20', 'prod-silk', 20],
    ['«ALBETCHU …»', 'ALBETCHU لإخفاء مظهر الندبات', 'عبوة واحدة', '20', 'prod-scar', 20],
    ['«ماء الكمأ الأصلي»', 'ماء الكمأ الأصلي', 'قطعتين + قطعة هدية', '25', 'prod-kamaa', 25],
    ['the double-space one', 'قطرة  طنين الأذن', TINNITUS_OFFER, '20', 'prod-tinnitus', 20],
  ])('%s becomes an order of the catalogue product', async (_what, name, offer, price, productId, total) => {
    const id = arrive(old({ 'إسم المنتج': name, 'إسم العرض': offer, 'السعر': price }));
    expect((await processStoredMessage(id, { now: at(0) })).status).toBe('PROCESSED');
    expect(state.orders[0]).toMatchObject({ productId, totalAmount: total });
    expect(state.orders[0].internalNotes).toContain(`الاسم القديم: ${name}`.slice(0, 60));
  });

  it.each([
    ['عبوة عدد 1 = 20 دولار + توصيل مجاني', '20', 'of-silk-1', 1],
    ['عبوة عدد 2 = 35 دولار + توصيل مجاني', '35', 'of-silk-2', 2],
    ['عبوة عدد 3= 45 دولار + توصيل مجاني', '45', 'of-silk-3', 3],
  ])('the old offer «%s» is the real offer with the same quantity and price', async (offer, price, offerId, quantity) => {
    const id = arrive(old({ 'إسم المنتج': '✨ بديل الليزر... الآن بين يديك! ✨', 'إسم العرض': offer, 'السعر': price, 'الكمية': String(quantity) }));
    expect((await processStoredMessage(id, { now: at(0) })).status).toBe('PROCESSED');
    expect(state.orders[0]).toMatchObject({ offerId, quantity, totalAmount: Number(price) });
  });

  it('the price check still binds: an old offer with a wrong written price → PRICE_MISMATCH, nothing written', async () => {
    const id = arrive(old({ 'إسم المنتج': '✨ بديل الليزر... الآن بين يديك! ✨', 'إسم العرض': 'عبوة عدد 2 = 35 دولار + توصيل مجاني', 'السعر': '40', 'الكمية': '2' }));
    expect(await processStoredMessage(id, { now: at(0) })).toEqual({ status: 'NEEDS_REVIEW', reason: 'PRICE_MISMATCH:35.00' });
    nothingWritten();
  });

  it('an old offer no real offer matches → OFFER_NOT_FOUND; two that match → OFFER_AMBIGUOUS', async () => {
    state.offers = state.offers.filter((o) => o.id !== 'of-silk-2');
    const none = arrive(old({ 'إسم المنتج': '✨ بديل الليزر... الآن بين يديك! ✨', 'إسم العرض': 'عبوة عدد 2 = 35 دولار + توصيل مجاني', 'السعر': '35', 'الكمية': '2' }));
    expect(await processStoredMessage(none, { now: at(0) })).toEqual({ status: 'NEEDS_REVIEW', reason: 'OFFER_NOT_FOUND' });
    state.offers.push(
      offerRow({ id: 'of-silk-2a', productId: 'prod-silk', name: 'عرض أ', quantity: 2, sellingPrice: 35 }),
      offerRow({ id: 'of-silk-2b', productId: 'prod-silk', name: 'عرض ب', quantity: 2, sellingPrice: 35 })
    );
    const two = arrive(old({ 'إسم المنتج': '✨ بديل الليزر... الآن بين يديك! ✨', 'إسم العرض': 'عبوة عدد 2 = 35 دولار + توصيل مجاني', 'السعر': '35', 'الكمية': '2' }));
    expect(await processStoredMessage(two, { now: at(0) })).toEqual({ status: 'NEEDS_REVIEW', reason: 'OFFER_AMBIGUOUS' });
    nothingWritten();
  });

  it('an old name pointing at a product that is not active → ALIAS_PRODUCT_UNAVAILABLE', async () => {
    state.products.find((p) => p.id === 'prod-scar')!.status = 'DRAFT';
    const id = arrive(old({ 'إسم المنتج': 'ALBETCHU لإخفاء مظهر الندبات', 'إسم العرض': 'عبوة واحدة', 'السعر': '20' }));
    expect(await processStoredMessage(id, { now: at(0) })).toEqual({ status: 'NEEDS_REVIEW', reason: 'ALIAS_PRODUCT_UNAVAILABLE' });
  });

  it('an alias beats the generic matcher (which would have called «ماء الكمأ الأصلي» ambiguous here)', async () => {
    state.products.push(product('prod-kamaa-deluxe', 'ماء الكمأ الأصلي الفاخر'));
    const id = arrive(old({ 'إسم المنتج': 'ماء الكمأ الأصلي', 'إسم العرض': 'قطعتين + قطعة هدية', 'السعر': '25' }));
    expect((await processStoredMessage(id, { now: at(0) })).status).toBe('PROCESSED');
    expect(state.orders[0].productId).toBe('prod-kamaa');
    // Without the alias the same message is what it was before.
    state.aliases = state.aliases.filter((a) => a.incomingName !== 'ماء الكمأ الأصلي');
    expect(await processStoredMessage(arrive(old({ 'إسم المنتج': 'ماء الكمأ الأصلي', 'إسم العرض': 'قطعتين + قطعة هدية', 'السعر': '25', 'تاريخ الطلب': '2026-11-10 12:05:00' })), { now: at(0) })).toEqual({
      status: 'NEEDS_REVIEW',
      reason: 'AMBIGUOUS_PRODUCT',
    });
  });

  it('a message that matches nothing keeps today’s answer', async () => {
    expect(await processStoredMessage(arrive(old({ 'إسم المنتج': 'شي ما إله وجود' })), { now: at(0) })).toEqual({
      status: 'NEEDS_REVIEW',
      reason: 'PRODUCT_NOT_FOUND',
    });
  });

  it('the pure helpers: folded equality and the quantity-and-price pick', () => {
    const rows = state.aliases.map((a) => toAliasRow(a as Parameters<typeof toAliasRow>[0]));
    expect(aliasFor('قطرة طنين الأذن', rows)?.productId).toBe('prod-tinnitus');
    expect(aliasFor('✨بديل الليزر الآن بين يديك✨', rows)?.productId).toBe('prod-silk');
    expect(pickAliasedOffer([{ quantity: 2, price: 35 }, { quantity: 2, price: 35.001 }], { quantity: 2, price: 35 }, 2)).toEqual({ kind: 'ambiguous' });
    expect(pickAliasedOffer([{ quantity: 2, price: 35 }], { quantity: 3, price: 35 }, 2)).toEqual({ kind: 'none' });
  });
});

describe('the write-free plan', () => {
  it('plans a pair and an old name, and writes nothing at all', async () => {
    state.aliases.push(alias({ kind: 'RENAMED', incomingName: 'قطرة  طنين الأذن', productId: 'prod-tinnitus' }));
    const base = arrive(message(), { processingStatus: 'NEEDS_REVIEW', reviewReason: 'PRICE_MISMATCH:20.00' });
    const upsell = arrive(upsellMessage(), { processingStatus: 'NEEDS_REVIEW', reviewReason: 'PRODUCT_NOT_FOUND', createdAt: at(40) });
    const single = arrive(message({ 'رقم الطلب': null, 'إسم المنتج': 'قطرة  طنين الأذن', 'السعر': '20' }), { processingStatus: 'NEEDS_REVIEW', reviewReason: 'PRODUCT_NOT_FOUND' });
    const snapshot = JSON.stringify(state);
    const writesBefore = state.writes;

    // Live, 40 minutes apart is no pair; after the fact (60 minutes) it is.
    const pair = await planStoredMessage(base, { pairWindowMs: 60 * MIN });
    expect(pair).toMatchObject({ kind: 'order', info: { via: 'pair', partnerId: upsell, orderNumber: '30051' }, draft: { total: 40, units: 3, linkIds: [base, upsell] } });
    const one = await planStoredMessage(single);
    expect(one).toMatchObject({ kind: 'order', info: { via: 'alias' }, draft: { total: 20, units: 1, linkIds: [single] } });

    expect(JSON.stringify(state)).toBe(snapshot);
    expect(state.writes).toBe(writesBefore);
    expect(db.customer.create).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe('«دمج الأب سيل — تجربة»: the plan over the waiting messages, then «نعم»', () => {
  const scope = { OR: [{ source: { storeId: 'store-A' } }, { sourceId: null }, { source: { storeId: null } }] };
  const seedWaiting = () => {
    state.aliases.push(alias({ kind: 'RENAMED', incomingName: 'قطرة  طنين الأذن', productId: 'prod-tinnitus' }));
    const base = arrive(message(), { processingStatus: 'NEEDS_REVIEW', reviewReason: 'PRICE_MISMATCH:20.00' });
    const upsell = arrive(upsellMessage(), { processingStatus: 'NEEDS_REVIEW', reviewReason: 'PRODUCT_NOT_FOUND', createdAt: at(5) });
    const single = arrive(message({ 'رقم الطلب': null, 'إسم المنتج': 'قطرة  طنين الأذن', 'السعر': '20', 'تاريخ الطلب': '2026-11-10 12:30:00' }), {
      processingStatus: 'NEEDS_REVIEW',
      reviewReason: 'PRODUCT_NOT_FOUND',
    });
    const lonely = arrive(upsellMessage({ 'رقم الطلب': '40000', 'رقم الهاتف': '0955000111' }), { processingStatus: 'NEEDS_REVIEW', reviewReason: 'PRODUCT_NOT_FOUND' });
    // Untouched by the new rules: an ordinary message held for its own reason is not in the plan.
    arrive(message({ 'رقم الطلب': null, 'إسم المنتج': 'شي ما إله وجود' }), { processingStatus: 'NEEDS_REVIEW', reviewReason: 'PRODUCT_NOT_FOUND' });
    return { base, upsell, single, lonely };
  };

  it('lists pairs and singles with the five columns’ facts, and writes nothing', async () => {
    const { planWaitingMessages } = await import('./upsell-plan');
    const { base, upsell, single, lonely } = seedWaiting();
    const snapshot = JSON.stringify(state);
    const rows = await planWaitingMessages('c1', scope);
    expect(rows).toEqual([
      expect.objectContaining({ key: `pair:${base}:${upsell}`, orderNumber: '30051', product: 'قطرة طنين الأذن', units: 3, amount: 40, action: 'يندمج في طلب واحد' }),
      expect.objectContaining({ key: `msg:${single}`, orderNumber: null, product: 'قطرة طنين الأذن', units: 1, amount: 20, action: 'يصير طلب' }),
      expect.objectContaining({ key: `msg:${lonely}`, orderNumber: '40000', units: null, amount: 40, reason: 'UPSELL_WITHOUT_BASE', action: 'يبقى بالمراجعة — رسالة أب سيل بلا طلب أساسي بنفس رقم الطلب' }),
    ]);
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it('apply makes the orders the plan promised, skips what stays, and pressing again makes nothing twice', async () => {
    const { applyWaitingMessages } = await import('./upsell-plan');
    const { base, upsell, single, lonely } = seedWaiting();
    const first = await applyWaitingMessages('c1', scope);
    expect(first).toEqual([
      expect.objectContaining({ key: `pair:${base}:${upsell}`, status: 'PROCESSED' }),
      expect.objectContaining({ key: `msg:${single}`, status: 'PROCESSED' }),
      expect.objectContaining({ key: `msg:${lonely}`, status: 'SKIPPED', reason: 'UPSELL_WITHOUT_BASE' }),
    ]);
    expect(state.orders).toHaveLength(2);
    expect(row(base).orderId).toBe(row(upsell).orderId);
    expect(state.orders.find((o) => o.id === row(base).orderId)).toMatchObject({ totalAmount: 40 });
    expect(row(lonely)).toMatchObject({ processingStatus: 'NEEDS_REVIEW', orderId: null });
    const again = await applyWaitingMessages('c1', scope);
    expect(again.filter((r) => r.status !== 'SKIPPED')).toEqual([]);
    expect(state.orders).toHaveLength(2);
  });

  it('apply narrowed to the keys the person saw touches nothing else', async () => {
    const { applyWaitingMessages } = await import('./upsell-plan');
    const { single } = seedWaiting();
    const results = await applyWaitingMessages('c1', scope, [`msg:${single}`]);
    expect(results).toEqual([expect.objectContaining({ key: `msg:${single}`, status: 'PROCESSED' })]);
    expect(state.orders).toHaveLength(1);
  });
});
