import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ONE ORDER, SEVERAL LINES.
 *
 * `computeCod` has taken a list of lines since it was written, and this
 * path already wrote an `OrderItem`. What was single was the INPUT. So the
 * thing worth proving here is not that the arithmetic works — money.test.ts
 * does that — but that the basket reaches it whole: every line costed,
 * every line written, the head of the order a display choice and never the
 * money, and not one figure taken from the browser.
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
    // The fixed cost an admin set for a product: none here, so every product is costed by its batches.
    productFixedCost: { findMany: vi.fn(async () => []) },
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
import { STORE_TEMPLATES } from './store-templates';
import { skinToStoreTheme } from './store-skin';

const P = {
  big: { id: 'p-big', name: 'كبير', image: null, basePrice: 100 },
  small: { id: 'p-small', name: 'صغير', image: null, basePrice: 10 },
};

let scope = 0;
const surface = (products = [P.big, P.small]) => ({
  companyId: 'c1',
  store: {
    id: 'store-a',
    countryId: 'jo',
    country: { code: 'JO', currencyCode: 'JOD', orderPrefix: 'ORD', minorUnit: 3 },
  },
  products,
  landingPage: null,
  source: 'Store',
  campaignId: null,
  // A fresh scope per call: the one-order-per-phone guard is a real guard
  // and would refuse the second test otherwise.
  dedupeScope: `basket-${scope++}`,
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
  // clearAllMocks keeps implementations, and one describe below gives this
  // one a bundle. Put the default back so the tests do not depend on order.
  db.offer.findMany.mockImplementation(async () => []);
  // No fixed cost for any product, unless a test sets one (the same reason: an implementation outlives `clearAllMocks`).
  db.productFixedCost.findMany.mockImplementation(async () => []);
});

describe('a basket of several things', () => {
  const twoProducts = { items: [{ productId: 'p-big', quantity: 1 }, { productId: 'p-small', quantity: 2 }] };

  it('becomes ONE order', async () => {
    const r = await createPublicOrder(surface() as never, body(twoProducts));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(tx.order.create).toHaveBeenCalledTimes(1);
  });

  it('with a line for every thing in it', async () => {
    await createPublicOrder(surface() as never, body(twoProducts));
    expect(items()).toHaveLength(2);
    expect(items().map((i: any) => [i.productId, i.quantity])).toEqual([
      ['p-big', 1],
      ['p-small', 2],
    ]);
  });

  it('and a total that is the whole basket', async () => {
    await createPublicOrder(surface() as never, body(twoProducts));
    // 100 + 2 × 10, no delivery fee configured in this harness.
    expect(created().totalAmount).toBe(120);
  });

  /**
   * THE HEAD IS A DISPLAY CHOICE. An order row has one cell for a product
   * and cannot show two, so it shows the largest line — and `totalAmount`
   * stays the whole order, which is what makes that safe.
   */
  it('shows the largest line in the row, whatever order it arrived in', async () => {
    await createPublicOrder(
      surface() as never,
      body({ items: [{ productId: 'p-small', quantity: 2 }, { productId: 'p-big', quantity: 1 }] })
    );
    expect(created().productId).toBe('p-big');
    expect(created().productNameSnapshot).toBe('كبير');
    expect(created().totalAmount).toBe(120);
  });

  /**
   * Costing the head alone would understate the goods on every order with
   * more than one thing in it — which is every order the cart exists for.
   */
  it('costs every line, not the one the row shows', async () => {
    await createPublicOrder(surface() as never, body(twoProducts));
    // No costed stock on hand in this harness, so the honest answer is zero
    // — but it is a zero reached by summing three units, not by skipping two.
    expect(created().estimatedCostOfGoods).toBe(0);
    // ONE question for the whole basket (`unitCostsOf`), not one per product: it was two reads for these two products.
    expect(db.productionBatch.findMany).toHaveBeenCalledTimes(1);
    const asked = (db.productionBatch.findMany.mock.calls[0] as any[])[0].where.productId.in as string[];
    expect([...asked].sort()).toEqual(['p-big', 'p-small']);
  });

  it('asks each distinct product what it cost exactly once', async () => {
    await createPublicOrder(
      surface() as never,
      body({ items: [{ productId: 'p-big', quantity: 1 }, { productId: 'p-big', quantity: 3 }] })
    );
    expect(db.productionBatch.findMany).toHaveBeenCalledTimes(1);
    expect((db.productionBatch.findMany.mock.calls[0] as any[])[0].where.productId.in).toEqual(['p-big']);
  });
});

describe('what the browser may decide', () => {
  it('nothing about a price', async () => {
    await createPublicOrder(
      surface() as never,
      body({ items: [{ productId: 'p-big', quantity: 1, price: 1, unitPrice: 1, total: 1 }] })
    );
    // The product's own base price, read on the server.
    expect(created().totalAmount).toBe(100);
    expect(items()[0].unitPrice).toBe(100);
  });

  it('and nothing about a product this door does not sell', async () => {
    const r = await createPublicOrder(
      surface([P.big]) as never,
      body({ items: [{ productId: 'p-small', quantity: 1 }] })
    );
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toMatch(/لم يعد متاحاً/);
    expect(tx.order.create).not.toHaveBeenCalled();
  });

  /** A basket and a single choice both sent: the basket is the order. */
  it('a basket beats a lone offerId — two answers would be two orders', async () => {
    await createPublicOrder(
      surface() as never,
      body({ offerId: 'o-ignored', items: [{ productId: 'p-small', quantity: 1 }] })
    );
    expect(created().productId).toBe('p-small');
    expect(created().offerId).toBeNull();
  });
});

describe('a bundle asked for twice', () => {
  beforeEach(() => {
    db.offer.findMany.mockImplementation(async ({ where }: any) =>
      where.productId === 'p-big'
        ? [{
            id: 'off-3', name: 'ثلاث قطع', quantity: 3, freeQuantity: 1,
            sellingPrice: 240, compareAtPrice: null, isDefault: true,
            deliveryIncluded: false, endsAt: null,
          }]
        : []
    );
  });

  it('is pieces, not picks', async () => {
    await createPublicOrder(
      surface([P.big]) as never,
      body({ items: [{ productId: 'p-big', offerId: 'off-3', quantity: 2 }] })
    );
    // Two of a «٣ قطع + ١ مجاناً» bundle: six paid pieces and two gifts.
    expect(items()[0].quantity).toBe(6);
    expect(items()[0].freeQuantity).toBe(2);
    // And the unit price is the bundle's total divided once, on the server.
    expect(items()[0].unitPrice).toBe(80);
    expect(created().totalAmount).toBe(480);
  });
});

describe('the gift costs what it costs', () => {
  /**
   * «عبوتان + الثالثة مجاناً»: the customer pays for two and three leave the shelf. The stock already counted three;
   * the cost of goods counted two, so the profit on every bundle with a gift was too large by the gift. The internal
   * door costs `quantity + gift`; this door now does too — and what the customer pays does not move.
   */
  beforeEach(() => {
    db.offer.findMany.mockImplementation(async ({ where }: any) =>
      where.productId === 'p-big'
        ? [{
            id: 'off-2-1', name: 'عبوتان + الثالثة مجاناً', quantity: 2, freeQuantity: 1,
            sellingPrice: 20, compareAtPrice: null, isDefault: true, deliveryIncluded: true, endsAt: null,
          }]
        : []
    );
    // 100 units on hand at 4 each: the average a unit costs is 4.
    db.productionBatch.findMany.mockImplementation(async () => [{ productId: 'p-big', quantityRemaining: 100, costPerUnit: 4 }]);
  });

  it('costs the free unit too: two paid + one gift at 4 each is 12, not 8', async () => {
    await createPublicOrder(surface([P.big]) as never, body({ items: [{ productId: 'p-big', offerId: 'off-2-1', quantity: 1 }] }));
    expect(items()[0].quantity).toBe(2);
    expect(items()[0].freeQuantity).toBe(1);
    expect(created().estimatedCostOfGoods).toBe(12);
  });

  it('and twice the bundle is six units of cost (four paid, two gifts)', async () => {
    await createPublicOrder(surface([P.big]) as never, body({ items: [{ productId: 'p-big', offerId: 'off-2-1', quantity: 2 }] }));
    expect(created().estimatedCostOfGoods).toBe(24);
  });

  it('NEGATIVE: what the customer pays does not move — the bundle price, the gift at zero', async () => {
    await createPublicOrder(surface([P.big]) as never, body({ items: [{ productId: 'p-big', offerId: 'off-2-1', quantity: 1 }] }));
    expect(created().totalAmount).toBe(20);
  });

  it('NEGATIVE: a bundle with no gift is costed exactly as before', async () => {
    db.offer.findMany.mockImplementation(async ({ where }: any) =>
      where.productId === 'p-big'
        ? [{ id: 'off-2', name: 'عبوتان', quantity: 2, freeQuantity: 0, sellingPrice: 35, compareAtPrice: null, isDefault: true, deliveryIncluded: true, endsAt: null }]
        : []
    );
    await createPublicOrder(surface([P.big]) as never, body({ items: [{ productId: 'p-big', offerId: 'off-2', quantity: 1 }] }));
    expect(created().estimatedCostOfGoods).toBe(8);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE STOREFRONT AND THE SALES PAGE COST A PRODUCT AT ITS FIXED COST WHEN IT HAS ONE (the owner, 1/11)
 *
 * «سعر تكلفة المنتج يكون ثابت ولا يتغير ابدا… ثابت لكل الطلبات وما يتغير تحت اي ظرف». The shelf says a unit of the big one costs 4
 * and the small one 2 (100 units each); a figure an admin set wins over it, per product, the gift included — and what the customer
 * pays never moves with it. The store here counts in dinars: three places.
 * ═══════════════════════════════════════════════════════════════════════
 */
describe('a fixed cost is what the storefront costs a product at', () => {
  const shelf = () =>
    db.productionBatch.findMany.mockImplementation(async () => [
      { productId: 'p-big', quantityRemaining: 100, costPerUnit: 4 },
      { productId: 'p-small', quantityRemaining: 100, costPerUnit: 2 },
    ]);
  const figures = (...rows: [string, number][]) =>
    db.productFixedCost.findMany.mockImplementation(async () => rows.map(([productId, amount]) => ({ productId, amount })));
  const bundle = () =>
    db.offer.findMany.mockImplementation(async ({ where }: any) =>
      where.productId === 'p-big'
        ? [{ id: 'off-2-1', name: 'عبوتان + الثالثة مجاناً', quantity: 2, freeQuantity: 1, sellingPrice: 20, compareAtPrice: null, isDefault: true, deliveryIncluded: true, endsAt: null }]
        : []
    );
  const twoProducts = { items: [{ productId: 'p-big', quantity: 1 }, { productId: 'p-small', quantity: 2 }] };

  it('NO FIGURE: exactly as before — 1 × 4 + 2 × 2 = 8', async () => {
    shelf();
    await createPublicOrder(surface() as never, body(twoProducts));
    expect(created().estimatedCostOfGoods).toBe(8);
  });

  it('A FIGURE FOR THE BIG ONE: 1 × 6 + 2 × 2 = 10 — each line its own way, the small one still at its shelf', async () => {
    shelf();
    figures(['p-big', 6]);
    await createPublicOrder(surface() as never, body(twoProducts));
    expect(created().estimatedCostOfGoods).toBe(10);
  });

  it('A FIGURE FOR BOTH: 1 × 6 + 2 × 3 = 12', async () => {
    shelf();
    figures(['p-big', 6], ['p-small', 3]);
    await createPublicOrder(surface() as never, body(twoProducts));
    expect(created().estimatedCostOfGoods).toBe(12);
  });

  it('ZERO IS A FIGURE: the big one costs nothing, so the order is 2 × 2 = 4 — not 8', async () => {
    shelf();
    figures(['p-big', 0]);
    await createPublicOrder(surface() as never, body(twoProducts));
    expect(created().estimatedCostOfGoods).toBe(4);
  });

  it('A FIGURE WINS WHERE THE SHELF HOLDS NOTHING COSTED: 1 × 6, not the 0 of an empty shelf', async () => {
    db.productionBatch.findMany.mockImplementation(async () => []);
    figures(['p-big', 6]);
    await createPublicOrder(surface([P.big]) as never, body({ items: [{ productId: 'p-big', quantity: 1 }] }));
    expect(created().estimatedCostOfGoods).toBe(6);
  });

  it('THE GIFT COSTS THE FIGURE: «عبوتان + الثالثة مجاناً» at 6 is three units — 18, where the shelf said 12', async () => {
    shelf();
    bundle();
    figures(['p-big', 6]);
    await createPublicOrder(surface([P.big]) as never, body({ items: [{ productId: 'p-big', offerId: 'off-2-1', quantity: 1 }] }));
    expect([items()[0].quantity, items()[0].freeQuantity]).toEqual([2, 1]);
    expect(created().estimatedCostOfGoods).toBe(18);
  });

  it('…and what the customer pays is the bundle’s 20, whatever the figure', async () => {
    shelf();
    bundle();
    figures(['p-big', 6]);
    await createPublicOrder(surface([P.big]) as never, body({ items: [{ productId: 'p-big', offerId: 'off-2-1', quantity: 1 }] }));
    expect(created().totalAmount).toBe(20);
  });

  it('ROUNDED BY THE STORE’S CURRENCY (dinars, three places): 3 × 1.11117 = 3.33351 is 3.334', async () => {
    figures(['p-big', 1.11117]);
    await createPublicOrder(surface([P.big]) as never, body({ items: [{ productId: 'p-big', quantity: 3 }] }));
    expect(created().estimatedCostOfGoods).toBe(3.334);
  });

  it('THE FIGURES ARE ASKED ONCE for the distinct products of the basket, in the store’s company — a product twice is one question', async () => {
    shelf();
    figures(['p-big', 6]);
    await createPublicOrder(
      surface() as never,
      body({ items: [{ productId: 'p-big', quantity: 1 }, { productId: 'p-small', quantity: 1 }, { productId: 'p-big', quantity: 2 }] })
    );
    expect(db.productFixedCost.findMany).toHaveBeenCalledTimes(1);
    expect(db.productFixedCost.findMany).toHaveBeenCalledWith({
      where: { companyId: 'c1', productId: { in: ['p-big', 'p-small'] } },
      select: { productId: true, amount: true },
    });
  });
});

describe('the door that sells one thing is untouched', () => {
  it('still writes one line, and the order is that line', async () => {
    const r = await createPublicOrder(surface([P.big]) as never, body());
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(items()).toHaveLength(1);
    expect(created().productId).toBe('p-big');
    expect(created().quantity).toBe(1);
    expect(created().sellingPrice).toBe(100);
    expect(created().totalAmount).toBe(100);
  });
});

/**
 * THE SAME ORDER, UNDER EVERY ONE OF THE TEN TEMPLATES.
 *
 * «يثبت إن السلة والـCOD والطلب المخزّن والأحداث متطابقة مهما كان القالب».
 *
 * The architectural half of this claim is held elsewhere: no module that
 * decides money imports anything that knows what the shop looks like (see
 * every-template.test.ts). That guard reads imports, and an import list is
 * not the same thing as behaviour — the STORE ROW is shared between the
 * look and the order path, so «the pricer does not import the theme» does
 * not prove «the order path does not read `store.theme`».
 *
 * So this runs the real order, ten times, with a real template on the row
 * each time, and compares what was stored. A byte-identical order under
 * ten different looks is the claim the brief actually makes.
 */
describe('a basket priced under every one of the templates', () => {
  const twoProducts = { items: [{ productId: 'p-big', quantity: 1 }, { productId: 'p-small', quantity: 2 }] };

  /** The same surface, wearing one template. */
  const wearing = (skinId: string) => {
    const skin = STORE_TEMPLATES.find((t) => t.id === skinId)!;
    const s = surface();
    return {
      ...s,
      store: {
        ...s.store,
        // Exactly what installing that template writes onto the row.
        theme: JSON.stringify({ ...skinToStoreTheme(skin), template: skin.id }),
      },
    };
  };

  /** Everything the order path decided, with the fields that must vary removed. */
  const decided = () => {
    const order = { ...created() };
    // These differ by design between runs: a new order number and a new
    // customer dedupe scope are not what «متطابقة» is about.
    delete order.orderNumber;
    return { order, items: items() };
  };

  it('stores the same order, whichever template the shop wears', async () => {
    const results: string[] = [];
    for (const skin of STORE_TEMPLATES) {
      await createPublicOrder(wearing(skin.id) as never, body(twoProducts));
      results.push(JSON.stringify(decided()));
    }
    // Eleven since «علامة» joined them. Read off the list rather than
    // written out: what this test is about is that they all agree, and a
    // number here would make adding a template look like a failure.
    expect(results).toHaveLength(STORE_TEMPLATES.length);
    // Every one identical to the first — the comparison the brief asks for.
    for (let i = 1; i < results.length; i++) {
      expect(results[i], STORE_TEMPLATES[i].id).toBe(results[0]);
    }
  });

  it('and the comparison is of something, not of two empty objects', async () => {
    await createPublicOrder(wearing('lab') as never, body(twoProducts));
    const { order, items: lines } = decided();
    // The figures the claim is about: a line for every thing in the basket,
    // and the cash the courier collects. There is no separate `codAmount`
    // — `totalAmount` IS `computeCod`'s answer, which is the point of there
    // being one COD function.
    expect(lines).toHaveLength(2);
    expect(Number(order.totalAmount)).toBeGreaterThan(0);
    expect(Number(order.totalAmount)).toBe(
      lines.reduce((sum: number, l: { quantity: number; unitPrice: number; freeQuantity?: number }) =>
        sum + (l.quantity - (l.freeQuantity ?? 0)) * l.unitPrice, 0)
    );
  });

  it('and no template leaked a field of its own into the order', async () => {
    await createPublicOrder(wearing('souq') as never, body(twoProducts));
    const keys = Object.keys(created());
    for (const look of ['theme', 'template', 'accent', 'layout', 'colors', 'mood']) {
      expect(keys, look).not.toContain(look);
    }
  });
});
