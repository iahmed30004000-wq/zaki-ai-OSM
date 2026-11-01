import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE SALES PAGE HEARS AN OFFER'S «NO» — THE ONLY DOOR THAT DOES (the owner, 1/11)
 *
 * «إذا كل طلباتك توصيلها مجاني، شغّله ليشمل تلجرام والشيتات وصفحات البيع … بس بدي اترك مجال لاضافة الطلب يدويا او من اللاندنج انو اقدر
 * احدد اذا شامل ولا لأ بظبط».
 *
 * `public-order.ts` is the landing page and the storefront. What it writes as the order's `priceIncludesDelivery`, for every shape a
 * basket can take, in a store whose policy includes delivery and in one whose policy does not:
 *
 *   · every line carries an offer and every offer is unticked → NOT included, whatever the store says (the exception he asked for);
 *   · any line carries a ticked offer → included (one parcel, one fee or none — the printed promise is never broken);
 *   · a line with no offer lets the store speak, so a basket with one such line follows the store;
 *   · a single product with no offer follows the store.
 *
 * The other doors keep "an offer only turns it on" — held in `delivery-inclusive-doors.test.ts` and the form-less cells of
 * `the-delivery-box-is-the-persons-word.test.ts`. The independent review (1/11) found this file's absence the gap: the door's cells were
 * pinned by a source regex only, so "ignore every offer" stayed green.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, tx } = vi.hoisted(() => {
  const tx: any = {
    order: { create: vi.fn(async ({ data }: any) => ({ ...data, id: 'o-new' })) },
    orderItem: { createMany: vi.fn(async () => ({ count: 0 })) },
    customer: { update: vi.fn() },
    orderActivity: { create: vi.fn() },
    orderStatusLog: { create: vi.fn() },
  };
  const db: any = {
    region: { findMany: vi.fn(async () => [{ id: 'r1', name: 'عمّان' }]) },
    offer: { findMany: vi.fn(async () => []) },
    order: { groupBy: vi.fn(async () => []) },
    orderChannel: { findFirst: vi.fn(async () => null) },
    store: { findFirst: vi.fn(async () => ({ priceIncludesDelivery: false })) },
    productionBatch: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (fn: any) => fn(tx)),
  };
  return { db, tx };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/notification', () => ({ createNotification: vi.fn() }));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: vi.fn() }));
vi.mock('@/lib/conversions/emit', () => ({ queueConversions: vi.fn() }));
vi.mock('@/lib/customer-identity', () => ({
  findOrCreateCustomer: vi.fn(async () => ({ id: 'cust-1', firstOrderDate: null })),
}));
vi.mock('@/lib/order-ref', () => ({ orderRefFields: vi.fn(async () => ({ orderNumber: 'ORD-77' })) }));
vi.mock('@/lib/blacklist', () => ({ isBlocked: vi.fn(async () => false), NEUTRAL_REFUSAL: 'x' }));
vi.mock('@/lib/notify', () => ({ notify: vi.fn(), afterResponse: (w: () => Promise<unknown>) => { void w(); } }));

import { createPublicOrder } from './public-order';

const P = {
  a: { id: 'p-a', name: 'أ', image: null, basePrice: 100 },
  b: { id: 'p-b', name: 'ب', image: null, basePrice: 100 },
  bare: { id: 'p-bare', name: 'بلا عرض', image: null, basePrice: 20 },
};

/** A bundle of one at the product's price — ticked («السعر شامل التوصيل») or not. */
const offerOf = (id: string, deliveryIncluded: boolean) => ({
  id, name: 'عبوة', quantity: 1, freeQuantity: 0, sellingPrice: 100, compareAtPrice: null, isDefault: true, deliveryIncluded, endsAt: null,
});
const OFFERS: Record<string, ReturnType<typeof offerOf>[]> = {
  'p-a': [offerOf('off-a-no', false)],
  'p-b': [offerOf('off-b-yes', true)],
  'p-bare': [],
};

let scope = 0;
const surface = (products: unknown[]) => ({
  companyId: 'c1',
  store: { id: 'store-a', countryId: 'jo', country: { code: 'JO', currencyCode: 'JOD', orderPrefix: 'ORD', minorUnit: 3 } },
  products,
  landingPage: null,
  source: 'Store',
  campaignId: null,
  dedupeScope: `delivery-${scope++}`,
  notice: { title: 'طلب', message: (n: string) => n },
});
const body = (items: unknown[]) => ({
  full_name: 'زبون تجريبي', phone: '0790000000', address: 'شارع الاختبار، بناية ٣', city: 'عمّان', items,
});
const line = (productId: string, offerId?: string) => ({ productId, ...(offerId ? { offerId } : {}), quantity: 1 });

/** Place the basket under a store whose policy is `storeIncludes`, and say what the order was written as. */
async function placed(products: unknown[], items: unknown[], storeIncludes: boolean) {
  vi.clearAllMocks();
  db.offer.findMany.mockImplementation(async ({ where }: any) => OFFERS[where.productId] ?? []);
  db.store.findFirst.mockResolvedValue({ priceIncludesDelivery: storeIncludes });
  const r = await createPublicOrder(surface(products) as never, body(items));
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return tx.order.create.mock.calls.at(-1)![0].data.priceIncludesDelivery as boolean;
}

describe('one product', () => {
  it('with an unticked offer: NOT included — even in a store whose policy includes delivery', async () => {
    expect(await placed([P.a], [line('p-a', 'off-a-no')], true)).toBe(false);
    expect(await placed([P.a], [line('p-a', 'off-a-no')], false)).toBe(false);
  });

  it('with a ticked offer: included, in both stores', async () => {
    expect(await placed([P.b], [line('p-b', 'off-b-yes')], true)).toBe(true);
    expect(await placed([P.b], [line('p-b', 'off-b-yes')], false)).toBe(true);
  });

  it('with no offer at all: the store speaks — silence is not a «no»', async () => {
    expect(await placed([P.bare], [line('p-bare')], true)).toBe(true);
    expect(await placed([P.bare], [line('p-bare')], false)).toBe(false);
  });
});

describe('a basket', () => {
  it('every line an unticked offer: NOT included, in a store that includes delivery and in one that does not', async () => {
    const two = [P.a, { ...P.a, id: 'p-a2', name: 'أ٢' }];
    OFFERS['p-a2'] = [offerOf('off-a2-no', false)];
    const items = [line('p-a', 'off-a-no'), line('p-a2', 'off-a2-no')];
    expect(await placed(two, items, true)).toBe(false);
    expect(await placed(two, items, false)).toBe(false);
    delete OFFERS['p-a2'];
  });

  it('an unticked offer beside a ticked one: included — one yes makes the parcel free', async () => {
    const items = [line('p-a', 'off-a-no'), line('p-b', 'off-b-yes')];
    expect(await placed([P.a, P.b], items, true)).toBe(true);
    expect(await placed([P.a, P.b], items, false)).toBe(true);
  });

  it('an unticked offer beside a product with no offer: the store speaks for the bare line, so the order follows the store', async () => {
    const items = [line('p-a', 'off-a-no'), line('p-bare')];
    expect(await placed([P.a, P.bare], items, true)).toBe(true);
    expect(await placed([P.a, P.bare], items, false)).toBe(false);
  });

  it('a ticked offer beside a product with no offer: included, even where the store does not include delivery', async () => {
    const items = [line('p-b', 'off-b-yes'), line('p-bare')];
    expect(await placed([P.b, P.bare], items, false)).toBe(true);
  });
});

describe('what does not move', () => {
  it('the goods and the total are the same whichever way the flag falls — only the flag is the offer’s word', async () => {
    await placed([P.a], [line('p-a', 'off-a-no')], true);
    const no = tx.order.create.mock.calls.at(-1)![0].data;
    await placed([P.b], [line('p-b', 'off-b-yes')], true);
    const yes = tx.order.create.mock.calls.at(-1)![0].data;
    expect(no.totalAmount).toBe(100);
    expect(yes.totalAmount).toBe(100);
    expect(no.shippingCost).toBe(yes.shippingCost);
  });
});
