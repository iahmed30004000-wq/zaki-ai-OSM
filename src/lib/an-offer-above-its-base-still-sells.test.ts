import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «العرض ما بصير يكون اكثر من السعر الاساسي» — AND ORDER CREATION DID NOT CHANGE.
 *
 * The owner's rule is held at the doors that WRITE an offer: a new offer above its line is refused there. An offer
 * saved above it before the rule existed stays on sale exactly as it is, flagged on the offers screen for the owner
 * to decide one by one. Withholding it from the order doors, or charging it a different price, would be a change to
 * order creation — a fixed blocker, and not what was asked.
 *
 * So this pins both halves at the public door (the landing page and the storefront): a stored offer above its line
 * is still offered, still accepted, and charged its OWN price; and the query that decides which offers may be
 * bought asks nothing about price. `v1/a-bundle-above-its-base-is-still-honoured.test.ts` pins the same at v1.
 *
 * `offers.ts` is NOT mocked: the real `activeOffersFor` and the real `liveOfferWhere` run, over a mocked table.
 */

type Row = Record<string, unknown>;

const { db, tx } = vi.hoisted(() => {
  const tx = {
    order: { create: vi.fn(async ({ data }: { data: Row }) => ({ ...data, id: 'o-new' })) },
    orderItem: { createMany: vi.fn<(args: { data: Row[] }) => Promise<{ count: number }>>(async () => ({ count: 0 })) },
    customer: { update: vi.fn() },
    orderActivity: { create: vi.fn() },
    landingPage: { update: vi.fn() },
  };
  const db = {
    region: { findMany: vi.fn(async () => [{ id: 'r1', name: 'عمّان' }]) },
    offer: { findMany: vi.fn<(args: { where?: Row }) => Promise<Row[]>>(async () => []) },
    order: { groupBy: vi.fn(async () => []) },
    orderChannel: { findFirst: vi.fn(async () => null) },
    store: { findFirst: vi.fn(async () => ({ priceIncludesDelivery: false })) },
    productionBatch: { findMany: vi.fn(async () => []) },
    landingPageRecommendation: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
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
vi.mock('@/lib/order-ref', () => ({ orderRefFields: vi.fn(async () => ({ orderNumber: 'ORD-78' })) }));
vi.mock('@/lib/blacklist', () => ({ isBlocked: vi.fn(async () => false), NEUTRAL_REFUSAL: 'x' }));
vi.mock('@/lib/notify', () => ({
  notify: vi.fn(),
  afterResponse: (w: () => Promise<unknown>) => {
    void w();
  },
}));

import { createPublicOrder } from './public-order';
import { offerAboveBase } from './offer-ceiling';

/** A product priced at 25 a piece. */
const P = { id: 'p-a', name: 'منتج أ', image: null, basePrice: 25 };

/** One piece at 30: above its line of 1 × 25 — exactly the row the offer doors now refuse to write. */
const ABOVE = {
  id: 'off-above',
  name: 'قطعة',
  quantity: 1,
  freeQuantity: 0,
  sellingPrice: 30,
  discount: 0,
  compareAtPrice: null,
  isDefault: true,
  deliveryIncluded: false,
  endsAt: null,
};

let scope = 0;
const surface = () => ({
  companyId: 'c1',
  store: {
    id: 'store-a',
    countryId: 'jo',
    country: { code: 'JO', currencyCode: 'JOD', orderPrefix: 'ORD', minorUnit: 3 },
  },
  products: [P],
  landingPage: null,
  source: 'Landing',
  campaignId: null,
  dedupeScope: `above-${scope++}`,
  notice: { title: 'طلب', message: (n: string) => n },
});

const body = {
  full_name: 'زبون تجريبي',
  phone: '0790000000',
  address: 'شارع الاختبار، بناية 3',
  city: 'عمّان',
  items: [{ productId: P.id, offerId: ABOVE.id, quantity: 1 }],
};

const created = () => tx.order.create.mock.calls.at(-1)![0].data;
const items = () => tx.orderItem.createMany.mock.calls.at(-1)![0].data;

beforeEach(() => {
  vi.clearAllMocks();
  db.offer.findMany.mockImplementation(async ({ where }) => (where?.productId === P.id ? [ABOVE] : []));
});

describe('a stored offer above its line, at the public door', () => {
  it('is above its line — the fixture is the case the rule is about, not one it passes', () => {
    expect(offerAboveBase(ABOVE, P.basePrice, 3)).toBe(25);
  });

  it('is still accepted, and charged its OWN price — 30, not the 25 of its line', async () => {
    const r = await createPublicOrder(surface() as never, body);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(created().offerId).toBe(ABOVE.id);
    expect(items()[0].unitPrice).toBe(30);
    expect(created().totalAmount).toBe(30);
  });

  it('and the query that decides which offers may be bought asks nothing about price', async () => {
    await createPublicOrder(surface() as never, body);
    const catalogue = db.offer.findMany.mock.calls.find((c) => c[0]?.where?.productId === P.id);
    expect(catalogue, 'the door no longer reads the product’s offers').toBeTruthy();
    expect(catalogue![0].where).toEqual({
      companyId: 'c1',
      productId: P.id,
      status: 'ACTIVE',
      postOrderOffer: false,
      OR: [{ endsAt: null }, { endsAt: { gt: expect.any(Date) } }],
    });
  });
});
