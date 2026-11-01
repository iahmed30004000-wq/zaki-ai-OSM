import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE SAME OFFER, THE SAME PRICE, WHICHEVER DOOR IT CAME THROUGH.
 *
 * An Offer carries `sellingPrice`, `discount` and `quantity`. Two doors
 * create orders and both call the same `computeCod`:
 *
 *   `/api/orders` — the confirmation agent on the phone — passed
 *     `computeCod({ ..., discount: offer?.discount ?? 0, ... })`
 *   `createPublicOrder` — the landing page and the storefront — passed
 *     **no discount at all**.
 *
 * So an offer with `sellingPrice: 25` and `discount: 3` cost 22 by phone
 * and 25 from the landing page. `totalAmount` is what the waybill carries
 * and what the courier is told to collect, so the customer handed over the
 * undiscounted figure, and the per-line `discountShare` was written as 0 —
 * which is also what a partial return would have refunded against.
 *
 * The owner's ruling: pass it, exactly as the manual door does.
 *
 * WHAT WAS CHECKED BEFORE CHANGING ANYTHING, because getting either
 * backwards makes this worse than it was:
 *
 *   `discount` is an ABSOLUTE amount, not a percentage. `allocateDiscount`
 *   clamps it with `Math.min(discount, subtotal)` and the admin form
 *   validates it as `money(1_000_000)`. A percentage would be clamped
 *   against a subtotal, which is meaningless.
 *
 *   The landing page does NOT already subtract it. The string `discount`
 *   does not occur anywhere under `src/components/landing/`, nor in
 *   `storefront.ts`, nor in any public route; `activeOffersFor` does not
 *   even select the column, so `OfferView` cannot carry it to a browser.
 *   What the page strikes through is `compareAtPrice`, which `offers.ts`
 *   keeps deliberately apart from this: «One is a marketing number and must
 *   never touch the money.» So there is no double discount to create.
 */

const { db, tx } = vi.hoisted(() => {
  const tx: any = {
    order: { create: vi.fn(async ({ data }: any) => ({ ...data, id: 'o-new' })) },
    orderItem: { createMany: vi.fn(async () => ({ count: 0 })) },
    customer: { update: vi.fn() },
    orderActivity: { create: vi.fn() },
    landingPage: { update: vi.fn() },
  };
  const db: any = {
    region: { findMany: vi.fn(async () => [{ id: 'r1', name: 'عمّان' }]) },
    offer: { findMany: vi.fn(async () => []) },
    order: { groupBy: vi.fn(async () => []) },
    orderChannel: { findFirst: vi.fn(async () => null) },
    store: { findFirst: vi.fn(async () => ({ priceIncludesDelivery: false })) },
    productionBatch: { findMany: vi.fn(async () => []) },
    // No fixed cost for any product here: the order's cost is what the batches say.
    productFixedCost: { findMany: async () => [] },
    landingPageRecommendation: { findMany: vi.fn(async () => []) },
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
vi.mock('@/lib/notify', () => ({
  notify: vi.fn(),
  afterResponse: (w: () => Promise<unknown>) => {
    void w();
  },
}));

import { basketDiscount, createPublicOrder, type ResolvedLine } from './public-order';
import { computeCod } from './money';
import { repoFile, stripComments } from './guard-source';

/** The product the offers below are bundles of. Its base price is never the one charged. */
const P = {
  a: { id: 'p-a', name: 'منتج أ', image: null, basePrice: 99 },
  b: { id: 'p-b', name: 'منتج ب', image: null, basePrice: 99 },
};

/**
 * THE OFFER THE BRIEF NAMES: 25 for a bundle of 2, reduced by 3.
 *
 * `quantity: 2` is PIECES PER PICK, so one pick is two pieces at a unit
 * price of 12.5 and a line value of 25 — the bundle's total, divided once,
 * on the server.
 */
const OFF = {
  id: 'off-25',
  name: 'قطعتان',
  quantity: 2,
  freeQuantity: 0,
  sellingPrice: 25,
  discount: 3,
  compareAtPrice: null,
  isDefault: true,
  deliveryIncluded: false,
  endsAt: null,
};

/** A second bundle on another product, with a reduction of its own. */
const OFF_B = { ...OFF, id: 'off-10', name: 'واحدة', quantity: 1, sellingPrice: 10, discount: 1 };

/**
 * One mock serves both reads of the offer table: the catalogue read
 * (`activeOffersFor`, which filters by `productId`) and the discount read
 * (which asks for the chosen ids). Dispatching on the `where` is what keeps
 * the two honest — a mock that answered both the same way would hide a
 * missing filter.
 */
function sellingOffers(...offers: (typeof OFF)[]) {
  const byProduct: Record<string, (typeof OFF)[]> = { 'p-a': [], 'p-b': [] };
  for (const o of offers) byProduct[o.id === OFF_B.id ? 'p-b' : 'p-a'].push(o);
  db.offer.findMany.mockImplementation(async ({ where, select }: any) => {
    // The discount read: by id, for the whole basket at once.
    if (where?.id?.in) {
      expect(select).toEqual({ id: true, discount: true });
      expect(where.companyId).toBe('c1');
      return offers
        .filter((o) => where.id.in.includes(o.id))
        .map((o) => ({ id: o.id, discount: o.discount }));
    }
    // The catalogue read: by product, and it must not be handed the column.
    return byProduct[where?.productId] ?? [];
  });
}

let scope = 0;
const surface = (products = [P.a]) => ({
  companyId: 'c1',
  store: {
    id: 'store-a',
    countryId: 'jo',
    // minorUnit 3: this is a JOD store, like the real one.
    country: { code: 'JO', currencyCode: 'JOD', orderPrefix: 'ORD', minorUnit: 3 },
  },
  products,
  landingPage: null,
  source: 'Landing',
  campaignId: null,
  // A fresh scope per call: the one-order-per-phone guard is real.
  dedupeScope: `disc-${scope++}`,
  notice: { title: 'طلب', message: (n: string) => n },
});

const body = (over: Record<string, unknown> = {}) => ({
  full_name: 'زبون تجريبي',
  phone: '0790000000',
  address: 'شارع الاختبار، بناية ٣',
  city: 'عمّان',
  ...over,
});

const created = () => tx.order.create.mock.calls.at(-1)![0].data;
const items = () => tx.orderItem.createMany.mock.calls.at(-1)![0].data;

beforeEach(() => {
  vi.clearAllMocks();
  db.offer.findMany.mockImplementation(async () => []);
});

describe('the offer the brief names: 25, reduced by 3, a bundle of 2', () => {
  beforeEach(() => sellingOffers(OFF));

  it('is collected at 22, and the 3 is written onto the line', async () => {
    sellingOffers(OFF);
    const r = await createPublicOrder(
      surface() as never,
      body({ items: [{ productId: 'p-a', offerId: OFF.id, quantity: 1 }] })
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);

    /*
     * WHY THESE NUMBERS.
     *
     * One pick of a bundle of 2 is two pieces at 12.5 — the bundle's total
     * divided once, on the server. So the subtotal is 25, the offer's
     * reduction of 3 is allocated over the one line there is, and
     * `totalAmount` is 25 − 3 = 22. That is the figure the waybill carries
     * and the figure the courier collects. It read 25 before this fix.
     */
    expect(items()).toHaveLength(1);
    expect(items()[0].quantity).toBe(2);
    expect(items()[0].unitPrice).toBe(12.5);
    expect(items()[0].discountShare).toBe(3);
    expect(items()[0].lineTotal).toBe(22);
    expect(created().totalAmount).toBe(22);
    // And the head's `sellingPrice` is the line AFTER the reduction, so the
    // order row and the order's lines cannot disagree.
    expect(created().sellingPrice).toBe(22);
  });

  it('and the line’s share plus the total add back up to the subtotal', async () => {
    sellingOffers(OFF);
    await createPublicOrder(
      surface() as never,
      body({ items: [{ productId: 'p-a', offerId: OFF.id, quantity: 1 }] })
    );
    // The invariant `allocateDiscount` exists to keep: the shares sum to the
    // discount exactly, so a partial return refunds the right amount.
    const subtotal = items().reduce((s: number, l: any) => s + l.quantity * l.unitPrice, 0);
    const shares = items().reduce((s: number, l: any) => s + l.discountShare, 0);
    expect(subtotal).toBe(25);
    expect(shares).toBe(3);
    expect(created().totalAmount).toBe(subtotal - shares);
  });
});

describe('the two doors agree', () => {
  /**
   * THE MANUAL DOOR'S OWN CALL, with the manual door's own inputs.
   *
   * `/api/orders/route.ts` builds `codLines` and then calls
   * `computeCod({ lines, discount: offer?.discount ?? 0, deliveryFee,
   * priceIncludesDelivery, minorUnit })`. Reproducing that expression here
   * — rather than driving the route through its auth and its permissions —
   * is what makes this a comparison of the two doors' ARITHMETIC, which is
   * where they disagreed. The guard below holds the expression itself.
   */
  const byPhone = (offer: { sellingPrice: number; discount: number; quantity: number }, picks = 1) =>
    computeCod({
      lines: [{ quantity: offer.quantity * picks, unitPrice: offer.sellingPrice / offer.quantity }],
      discount: offer.discount ?? 0,
      minorUnit: 3,
    });

  it('on the offer the brief names', async () => {
    sellingOffers(OFF);
    await createPublicOrder(
      surface() as never,
      body({ items: [{ productId: 'p-a', offerId: OFF.id, quantity: 1 }] })
    );
    const phone = byPhone(OFF);
    expect(phone.cod).toBe(22);
    expect(created().totalAmount).toBe(phone.cod);
    expect(items()[0].discountShare).toBe(phone.discountShares[0]);
  });

  it('and on the same bundle asked for twice — once per offer, not once per pick', async () => {
    sellingOffers(OFF);
    await createPublicOrder(
      surface() as never,
      body({ items: [{ productId: 'p-a', offerId: OFF.id, quantity: 2 }] })
    );
    /*
     * Two picks: four pieces, a subtotal of 50, and the reduction applied
     * ONCE — 47. Flat is what the manual door does: one order, one offer,
     * one reduction, whatever the quantity. Scaling it per pick would be a
     * new pricing rule and the owner's to make, not this door's.
     */
    const phone = byPhone(OFF, 2);
    expect(phone.cod).toBe(47);
    expect(created().totalAmount).toBe(47);
    expect(created().totalAmount).toBe(phone.cod);
  });

  it('and neither door may quietly stop passing it', () => {
    /*
     * THE RULE, HELD IN THE SOURCE.
     *
     * This is the defect's actual shape: not wrong arithmetic but an
     * argument left off one of two call sites, which no amount of testing
     * the other door would ever catch. A numeric test over one door passes
     * happily while the other drifts, so the expression is guarded at both.
     */
    const manual = stripComments(repoFile('src/app/api/orders/route.ts'));
    expect(manual).toContain('discount: offer?.discount ?? 0');

    const publicDoor = stripComments(repoFile('src/lib/public-order.ts'));
    expect(publicDoor).toContain('discount: basketDiscount(lines)');
    // And it is the ONE cod function that is given it, in the one place.
    expect(publicDoor.match(/computeCod\(/g) ?? []).toHaveLength(1);
  });
});

describe('a line with no offer has nothing to reduce', () => {
  it('is charged the product’s base price, whole', async () => {
    const r = await createPublicOrder(surface() as never, body());
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(created().totalAmount).toBe(99);
    expect(items()[0].discountShare).toBe(0);
    // No offer in the basket, so the discount read is never even made.
    expect(db.offer.findMany.mock.calls.filter((c: any[]) => c[0]?.where?.id?.in)).toHaveLength(0);
  });
});

describe('a basket of two bundles', () => {
  const twoBundles = {
    items: [
      { productId: 'p-a', offerId: OFF.id, quantity: 1 },
      { productId: 'p-b', offerId: OFF_B.id, quantity: 1 },
    ],
  };

  it('honours both reductions — a promise printed on one offer is not voided by the other', async () => {
    sellingOffers(OFF, OFF_B);
    const r = await createPublicOrder(surface([P.a, P.b]) as never, body(twoBundles));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    // Subtotal 25 + 10 = 35, reductions 3 + 1 = 4, collected 31.
    expect(created().totalAmount).toBe(31);
    // Allocated by line value, and the parts add back up to the whole.
    const shares = items().map((l: any) => l.discountShare);
    expect(shares.reduce((a: number, b: number) => a + b, 0)).toBe(4);
    expect(items().reduce((s: number, l: any) => s + l.lineTotal, 0)).toBe(31);
  });

  it('and asks for the discounts in NO query at all — the view already carried them', async () => {
    /*
     * THE QUERY THAT WENT. A basket-wide second read of `Offer.discount`
     * stood here and this test demanded it be exactly one, not one per
     * product. It is now none: `activeOffersFor` returns the charged price
     * and the pre-discount one, and the difference IS the reduction.
     *
     * Asserted as ABSENCE, not merely as a smaller number — a second read
     * that comes back for any reason is a second place the figure can
     * disagree with the card the customer pressed.
     */
    sellingOffers(OFF, OFF_B);
    await createPublicOrder(surface([P.a, P.b]) as never, body(twoBundles));
    const discountReads = db.offer.findMany.mock.calls.filter((c: any[]) => c[0]?.where?.id?.in);
    expect(discountReads).toHaveLength(0);
    // And the reduction still reached the order, from the view instead.
    expect(created().totalAmount).toBe(31);
  });
});

describe('basketDiscount, on its own', () => {
  const line = (offerId: string | null, offerDiscount: number): ResolvedLine => ({
    product: P.a,
    offer: offerId ? ({ id: offerId } as never) : null,
    quantity: 1,
    freeQuantity: 0,
    unitPrice: 10,
    offerDiscount,
  });

  it('sums distinct offers', () => {
    expect(basketDiscount([line('x', 3), line('y', 1)])).toBe(4);
  });

  it('counts one offer once, however many lines carry it', () => {
    // A browser may split one bundle across two cart lines; splitting it
    // must not buy the reduction twice.
    expect(basketDiscount([line('x', 3), line('x', 3)])).toBe(3);
  });

  it('ignores a line sold at the base price', () => {
    expect(basketDiscount([line(null, 0), line('x', 2)])).toBe(2);
  });

  it('never returns a negative, whatever is in the column', () => {
    expect(basketDiscount([line('x', -5)])).toBe(0);
  });

  it('and an empty basket has no discount', () => {
    expect(basketDiscount([])).toBe(0);
  });
});

describe('a discount larger than the basket cannot invert the total', () => {
  it('is clamped to the subtotal, so the courier is never told to pay the customer', async () => {
    sellingOffers({ ...OFF, discount: 500 });
    const r = await createPublicOrder(
      surface() as never,
      body({ items: [{ productId: 'p-a', offerId: OFF.id, quantity: 1 }] })
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    // `allocateDiscount` clamps with Math.min(discount, subtotal).
    expect(created().totalAmount).toBe(0);
    expect(items()[0].discountShare).toBe(25);
  });
});
