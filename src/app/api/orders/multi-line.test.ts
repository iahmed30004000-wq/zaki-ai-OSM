import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * An order with more than one product.
 *
 * The items table was always per-line and preparation, partial delivery and
 * returns all read it that way — but every intake path wrote exactly one
 * line, so a second product could not be sold on one order at all.
 *
 * The danger in opening it is arithmetic: the order's own columns
 * (quantity, sellingPrice, totalAmount) are what commission, reporting and
 * statement matching read. If they stop agreeing with the sum of the lines,
 * money goes wrong quietly. These hold them together.
 */

const { db, requireContext, requirePermission, logAudit, activeBlock, createNotification } = vi.hoisted(() => ({
  db: {
    customer: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    product: { findMany: vi.fn(), findFirst: vi.fn() },
    /*
     * `findMany`, because the door now loads the offer every LINE
     * carries — which is what the order dialog actually sends. It read
     * only the top-level `offerId` before, and this file's own fixture
     * was the reason nobody noticed: it posted a top-level id BESIDE
     * `items[]`, a shape no screen produces.
     */
    offer: { findFirst: vi.fn(), findMany: vi.fn(async (): Promise<unknown[]> => []) },
    store: { findFirst: vi.fn() },
    region: { findFirst: vi.fn() },
    user: { findFirst: vi.fn() },
    order: { create: vi.fn(), count: vi.fn(), findFirst: vi.fn() },
    orderItem: { createMany: vi.fn(), create: vi.fn() },
    orderActivity: { create: vi.fn() },
    orderStatusLog: { create: vi.fn() },
    productionBatch: { findMany: vi.fn() },
    // The fixed cost an admin set for a product (`ProductFixedCost`): none unless a test says so — then `unitCostsOf` falls through to the batches above.
    productFixedCost: { findMany: vi.fn(async (): Promise<{ productId: string; amount: number }[]> => []) },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
  activeBlock: vi.fn(),
  createNotification: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/blacklist', () => ({ activeBlock: (...a: unknown[]) => activeBlock(...a) }));
vi.mock('@/lib/notification', () => ({ createNotification: (...a: unknown[]) => createNotification(...a) }));
vi.mock('@/lib/rbac', () => ({ applyQueueFilter: (_u: unknown, w: unknown) => w }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: (...a: unknown[]) => requirePermission(...a),
  getPermissionScope: () => ({ scope: 'ALL_COMPANY' }),
  can: () => true,
}));
vi.mock('@/lib/order-ref', () => ({
  orderRefFields: async () => ({ orderNumber: 'SY-2026-0200', merchantRef: 'SY-2026-0200' }),
}));

import { POST } from './route';

const CREAM = { id: 'prod-cream-0001', name: 'كريم حرير', image: null, basePrice: 20, batches: [{ costPerUnit: 5 }] };
const DROPS = { id: 'prod-drops-0001', name: 'قطرة طنين الأذن', image: null, basePrice: 20, batches: [{ costPerUnit: 7 }] };

const syria = {
  id: 'co-sy', code: 'SY', name: 'سوريا', currencyCode: 'USD', minorUnit: 2,
  timezone: 'Asia/Damascus', orderPrefix: 'SY', allowNegativeStock: false,
};

const body = (over: Record<string, unknown>) => ({
  customerName: 'محمد الحسن',
  customerPhone: '0944555666',
  customerAddress: 'دوما',
  source: 'Manual',
  ...over,
});

const post = (b: unknown) =>
  POST(new Request('http://localhost/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(b),
  }));

/** The order row and the lines the route wrote. */
function written() {
  return {
    order: db.order.create.mock.calls[0]?.[0]?.data,
    lines: db.orderItem.createMany.mock.calls[0]?.[0]?.data ?? [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'سارة', role: 'MODERATOR' },
    companyId: 'c1', storeId: 's1', countryId: 'co-sy', country: syria,
  });
  requirePermission.mockResolvedValue({ id: 'u1', companyId: 'c1' });
  activeBlock.mockResolvedValue(null);
  db.customer.findUnique.mockResolvedValue({ id: 'cu1', fullName: 'محمد الحسن', totalOrders: 0 });
  db.customer.findFirst.mockResolvedValue({ id: 'cu1', fullName: 'محمد الحسن', totalOrders: 0 });
  db.product.findMany.mockImplementation(async ({ where }: any) =>
    [CREAM, DROPS].filter((p) => where.id.in.includes(p.id))
  );
  db.offer.findFirst.mockResolvedValue(null);
  db.store.findFirst.mockResolvedValue({ priceIncludesDelivery: true });
  db.user.findFirst.mockResolvedValue({ id: 'u1', commissionRate: 0 });
  db.order.create.mockResolvedValue({ id: 'o-new', orderNumber: 'SY-2026-0200' });
  // Stock on hand, per product, at the cost it was bought or made at. The
  // order's cost of goods is the weighted average of what is actually there.
  db.productionBatch.findMany.mockResolvedValue([
    { productId: CREAM.id, quantityRemaining: 100, costPerUnit: 5 },
    { productId: DROPS.id, quantityRemaining: 100, costPerUnit: 7 },
  ]);
  db.$transaction.mockImplementation(async (fn: any) => fn(db));
  db.productFixedCost.findMany.mockImplementation(async () => []);
});

describe('an order can hold more than one product', () => {
  it('writes a line per product', async () => {
    await post(body({
      items: [
        { productId: CREAM.id, quantity: 2, unitPrice: 40 },
        { productId: DROPS.id, quantity: 1, unitPrice: 20 },
      ],
    }));

    const { lines } = written();
    expect(lines).toHaveLength(2);
    expect(lines.map((l: any) => l.productName)).toEqual(['كريم حرير', 'قطرة طنين الأذن']);
    // unitPrice is stored per unit; the request sends the line's total.
    expect(lines[0].unitPrice).toBe(20);
    expect(lines[1].unitPrice).toBe(20);
  });

  it('keeps the order’s own columns agreeing with the sum of its lines', async () => {
    await post(body({
      items: [
        { productId: CREAM.id, quantity: 2, unitPrice: 40 },
        { productId: DROPS.id, quantity: 1, unitPrice: 20 },
      ],
    }));

    const { order, lines } = written();
    const lineSum = lines.reduce((s: number, l: any) => s + l.lineTotal, 0);

    expect(order.quantity).toBe(3);          // every unit on the order
    expect(order.sellingPrice).toBe(60);     // what the goods are worth
    expect(order.sellingPrice).toBe(lineSum);
    // Delivery is inside the price on this store, so the door total is the goods.
    expect(order.totalAmount).toBe(60);
  });

  it('costs the goods at each product’s own weighted stock cost', async () => {
    await post(body({
      items: [
        { productId: CREAM.id, quantity: 2, unitPrice: 40 },  // 2 × 5
        { productId: DROPS.id, quantity: 1, unitPrice: 20 },  // 1 × 7
      ],
    }));

    expect(written().order.estimatedCostOfGoods).toBe(17);
  });

  it('names the order after its first line', async () => {
    await post(body({
      items: [
        { productId: DROPS.id, quantity: 1, unitPrice: 20 },
        { productId: CREAM.id, quantity: 1, unitPrice: 20 },
      ],
    }));

    const { order } = written();
    expect(order.productId).toBe(DROPS.id);
    expect(order.productNameSnapshot).toBe('قطرة طنين الأذن');
  });

  it('still takes the old single-product shape unchanged', async () => {
    // Landing pages, Telegram and the AI intake all send this.
    await post(body({ productId: CREAM.id, quantity: 2, sellingPrice: 40 }));

    const { order, lines } = written();
    expect(lines).toHaveLength(1);
    expect(order.quantity).toBe(2);
    expect(order.sellingPrice).toBe(40);
  });

  it('refuses a product from another company without creating anything', async () => {
    db.product.findMany.mockResolvedValue([CREAM]); // DROPS is not ours
    const res = await post(body({
      items: [
        { productId: CREAM.id, quantity: 1, unitPrice: 20 },
        { productId: DROPS.id, quantity: 1, unitPrice: 20 },
      ],
    }));

    expect(res.status).toBe(404);
    expect(db.order.create).not.toHaveBeenCalled();
  });

  it('refuses an order with no product at all', async () => {
    const res = await post(body({}));
    expect(res.status).toBe(400);
    expect(db.order.create).not.toHaveBeenCalled();
  });

  it('spreads a discount across the lines so the parts add back to the whole', async () => {
    const bundle = { id: 'offer-bundle-0001', deliveryIncluded: false, discount: 10, freeQuantity: 0 };
    db.offer.findFirst.mockResolvedValue(bundle);
    db.offer.findMany.mockResolvedValue([bundle]);

    await post(body({
      offerId: 'offer-bundle-0001',
      items: [
        { productId: CREAM.id, quantity: 2, unitPrice: 40 },
        { productId: DROPS.id, quantity: 1, unitPrice: 20 },
      ],
    }));

    const { order, lines } = written();
    const shares = lines.reduce((s: number, l: any) => s + l.discountShare, 0);
    const totals = lines.reduce((s: number, l: any) => s + l.lineTotal, 0);

    expect(shares).toBe(10);
    expect(totals).toBe(50);
    expect(order.totalAmount).toBe(50);
  });

  it('and reads the offer each LINE carries — the shape the screen sends', async () => {
    /*
     * ⚠️ THE TEST ABOVE POSTS A TOP-LEVEL `offerId` BESIDE `items[]`.
     *
     * No screen does that. `CreateOrderModal` sends an offer on every
     * line and nothing at the top, and the door read only the top — so
     * the gift and «شامل سعر التوصيل» were dropped on every order a
     * moderator typed, while this file stayed green.
     *
     * This one sends what the dialog sends: no top-level id, an offer on
     * the line. The gift must reach the line and the delivery flag must
     * reach the order.
     */
    // «3 + 1»: `quantity` 3, `freeQuantity` 1 — the shape the offers table really holds (this fixture had no `quantity`).
    const bundle = { id: 'offer-bundle-0002', quantity: 3, deliveryIncluded: true, discount: 0, freeQuantity: 1 };
    db.offer.findMany.mockResolvedValue([bundle]);

    await post(body({
      items: [{ productId: CREAM.id, offerId: bundle.id, quantity: 3, unitPrice: 60 }],
    }));

    const { order, lines } = written();
    // 22/10: this expected 3 — «per unit of the line» — and pinned a typed «3 + 1» as 3 + 3. The gift is one per bundle.
    expect(lines[0].freeQuantity, 'الهديّة ما وصلت السطر — أو وصلت ثلاثاً بدل واحدة').toBe(1);
    expect(order.priceIncludesDelivery, 'العرض شامل التوصيل والطلب ما بيعرف').toBe(true);
    expect(order.offerId, 'الطلب ما بيعرف أيّ عرض باعه').toBe(bundle.id);
  });
});

/**
 * THE GIFT IS A REAL UNIT, AND IT IS ONE PER BUNDLE — WHICHEVER DOOR WROTE THE LINE.
 *
 * The owner, 22/10: «الهدية مش وهمي… لازم ينحسب سعرو على التكلفة وينخصم من الستوك… هي من نفس صنف المنتج قطعة زيادة».
 * Everything downstream already read `quantity + freeQuantity` (the reservation, the deduction at delivery, the return, the
 * ready-to-ship guard) and the cost of goods already counted the gift — but this door wrote the gift as
 * `freeQuantity × line.quantity`, per PIECE, and the order dialog sets a picked offer's line to the offer's own quantity: a
 * moderator who typed «3 + 1» stored 3 + 3, and the landing page's «3 + 1» stored 3 + 1. Six units off the shelf and in the
 * cost for a bundle called four.
 */
describe('the gift is one per bundle', () => {
  const offer = (over: Record<string, unknown> = {}) => ({
    id: 'offer-three-plus-one', quantity: 3, freeQuantity: 1, deliveryIncluded: false, discount: 0, ...over,
  });
  const line = (o: { id: string }, quantity: number) => ({ productId: CREAM.id, offerId: o.id, quantity, unitPrice: 20 * quantity });

  it('— «3 + 1» typed by a moderator is 3 + 1: four units on the line, and the cost counts four', async () => {
    const o = offer();
    db.offer.findMany.mockResolvedValue([o]);
    await post(body({ items: [line(o, 3)] }));
    const { order, lines } = written();
    expect([lines[0].quantity, lines[0].freeQuantity]).toEqual([3, 1]);
    // CREAM is on the shelf at 5 a unit: the estimate is the cost of FOUR units — the gift is bought with money.
    expect(order.estimatedCostOfGoods).toBe(20);
  });

  it('and two bundles are 6 + 2, costed as eight', async () => {
    const o = offer();
    db.offer.findMany.mockResolvedValue([o]);
    await post(body({ items: [line(o, 6)] }));
    const { order, lines } = written();
    expect([lines[0].quantity, lines[0].freeQuantity]).toEqual([6, 2]);
    expect(order.estimatedCostOfGoods).toBe(40);
  });

  it('and a line that is not a whole number of bundles earns the gifts of the whole bundles in it', async () => {
    const o = offer();
    db.offer.findMany.mockResolvedValue([o]);
    await post(body({ items: [line(o, 7)] }));
    expect(written().lines[0].freeQuantity).toBe(2);
  });

  it('and a line shorter than one bundle earns none — the customer did not buy the offer', async () => {
    const o = offer();
    db.offer.findMany.mockResolvedValue([o]);
    await post(body({ items: [line(o, 2)] }));
    expect(written().lines[0].freeQuantity).toBe(0);
  });

  it('and «1 + 1» is a gift per piece only because a bundle IS one piece: two pieces, two gifts', async () => {
    const o = offer({ id: 'offer-one-plus-one', quantity: 1, freeQuantity: 1 });
    db.offer.findMany.mockResolvedValue([o]);
    await post(body({ items: [line(o, 2)] }));
    const { order, lines } = written();
    expect([lines[0].quantity, lines[0].freeQuantity]).toEqual([2, 2]);
    expect(order.estimatedCostOfGoods).toBe(20);
  });

  it('and two lines carry the gift of their OWN offers — never the first offer of the order', async () => {
    const a = offer();
    const b = offer({ id: 'offer-two-plus-two', quantity: 2, freeQuantity: 2 });
    db.offer.findMany.mockResolvedValue([a, b]);
    await post(body({ items: [line(a, 3), { productId: DROPS.id, offerId: b.id, quantity: 4, unitPrice: 80 }] }));
    const { order, lines } = written();
    expect(lines.map((l: { quantity: number; freeQuantity: number }) => [l.quantity, l.freeQuantity])).toEqual([[3, 1], [4, 4]]);
    // CREAM at 5 a unit, four of them; DROPS at 7 a unit, eight of them.
    expect(order.estimatedCostOfGoods).toBe(76);
  });

  it('and the gift costs the customer nothing — the order is worth the same with the gift as without it', async () => {
    const withGift = offer();
    db.offer.findMany.mockResolvedValue([withGift]);
    await post(body({ items: [line(withGift, 3)] }));
    const total = written().order.totalAmount;
    db.order.create.mockClear();
    db.orderItem.createMany.mockClear();
    const noGift = offer({ id: 'offer-three-no-gift', freeQuantity: 0 });
    db.offer.findMany.mockResolvedValue([noGift]);
    await post(body({ items: [line(noGift, 3)] }));
    expect(total).toBeGreaterThan(0);
    expect(written().order.totalAmount, 'الهديّةُ دخلت ثمنَ الطلب').toBe(total);
  });

  it('and a line with no offer, or with an offer that is not in this company, carries no gift at all', async () => {
    db.offer.findMany.mockResolvedValue([]);
    await post(body({ items: [{ productId: CREAM.id, offerId: 'somebody-elses', quantity: 3, unitPrice: 60 }, { productId: DROPS.id, quantity: 1, unitPrice: 20 }] }));
    expect(written().lines.map((l: { freeQuantity: number }) => l.freeQuantity)).toEqual([0, 0]);
  });

  it('and the offers are asked for with their `quantity` — a bundle is as many units as the offer says', async () => {
    const o = offer();
    db.offer.findMany.mockResolvedValue([o]);
    await post(body({ items: [line(o, 3)] }));
    const [asked] = db.offer.findMany.mock.calls[0] as unknown as [{ select: Record<string, boolean> }];
    expect(asked.select).toMatchObject({ quantity: true, freeQuantity: true });
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE MANUAL DOOR COSTS A PRODUCT AT ITS FIXED COST WHEN IT HAS ONE (the owner, 1/11)
 *
 * «سعر تكلفة المنتج يكون ثابت ولا يتغير ابدا… ثابت لكل الطلبات». The shelf above holds the cream at 5 and the drops at 7 a unit.
 * A fixed figure an admin set for a product wins over that, per line; a product with none is costed exactly as the tests above say.
 * ═══════════════════════════════════════════════════════════════════════
 */
describe('a fixed cost is what the manual door costs a product at', () => {
  const figures = (...rows: [string, number][]) =>
    db.productFixedCost.findMany.mockImplementation(async () => rows.map(([productId, amount]) => ({ productId, amount })));

  it('the cream (2) at its figure of 8 and the drops (1) at their batches: 16 + 7 — not 2 × 5 + 7', async () => {
    figures([CREAM.id, 8]);
    await post(body({ items: [{ productId: CREAM.id, quantity: 2, unitPrice: 40 }, { productId: DROPS.id, quantity: 1, unitPrice: 20 }] }));
    expect(written().order.estimatedCostOfGoods).toBe(23);
  });

  it('a figure on both products costs each line its own figure: 2 × 8 + 1 × 3 = 19', async () => {
    figures([CREAM.id, 8], [DROPS.id, 3]);
    await post(body({ items: [{ productId: CREAM.id, quantity: 2, unitPrice: 40 }, { productId: DROPS.id, quantity: 1, unitPrice: 20 }] }));
    expect(written().order.estimatedCostOfGoods).toBe(19);
  });

  it('ZERO is a figure: an item that costs nothing costs the order nothing — the 5 on the shelf is not used', async () => {
    figures([CREAM.id, 0]);
    await post(body({ items: [{ productId: CREAM.id, quantity: 3, unitPrice: 60 }] }));
    expect(written().order.estimatedCostOfGoods).toBe(0);
  });

  it('a figure wins even where the shelf holds nothing costed (no batch): 3 × 8, not the 0 the empty shelf would say', async () => {
    db.productionBatch.findMany.mockResolvedValue([]);
    figures([CREAM.id, 8]);
    await post(body({ items: [{ productId: CREAM.id, quantity: 3, unitPrice: 60 }] }));
    expect(written().order.estimatedCostOfGoods).toBe(24);
  });

  it('THE GIFT COSTS THE FIGURE TOO: «3 + 1» at 8 is four units — 32', async () => {
    const o = { id: 'offer-three-plus-one', quantity: 3, freeQuantity: 1, deliveryIncluded: false, discount: 0 };
    db.offer.findMany.mockResolvedValue([o]);
    figures([CREAM.id, 8]);
    await post(body({ items: [{ productId: CREAM.id, offerId: o.id, quantity: 3, unitPrice: 60 }] }));
    const { order, lines } = written();
    expect([lines[0].quantity, lines[0].freeQuantity]).toEqual([3, 1]);
    expect(order.estimatedCostOfGoods).toBe(32);
  });

  it('and what the customer pays does not move with the figure: the price is the price', async () => {
    await post(body({ items: [{ productId: CREAM.id, quantity: 2, unitPrice: 40 }] }));
    const without = written().order.totalAmount;
    db.order.create.mockClear();
    db.orderItem.createMany.mockClear();
    figures([CREAM.id, 8]);
    await post(body({ items: [{ productId: CREAM.id, quantity: 2, unitPrice: 40 }] }));
    expect(without).toBeGreaterThan(0);
    expect(written().order.totalAmount).toBe(without);
  });

  it('the figures are asked ONCE for the distinct products of the lines, in this company', async () => {
    figures([CREAM.id, 8]);
    await post(body({ items: [
      { productId: CREAM.id, quantity: 1, unitPrice: 20 },
      { productId: DROPS.id, quantity: 1, unitPrice: 20 },
      { productId: CREAM.id, quantity: 2, unitPrice: 40 },
    ] }));
    expect(db.productFixedCost.findMany).toHaveBeenCalledTimes(1);
    expect(db.productFixedCost.findMany).toHaveBeenCalledWith({
      where: { companyId: 'c1', productId: { in: [CREAM.id, DROPS.id] } },
      select: { productId: true, amount: true },
    });
  });

  it('the cost is rounded as this door always rounded it — to two decimals: 3 × 1.1117 = 3.3351 is 3.34', async () => {
    figures([CREAM.id, 1.1117]);
    await post(body({ items: [{ productId: CREAM.id, quantity: 3, unitPrice: 60 }] }));
    expect(written().order.estimatedCostOfGoods).toBe(3.34);
  });
});

/**
 * Editing an order's lines.
 *
 * Two dangers, and the second is worse. The money: the formula that used to
 * live in the edit read `sellingPrice * quantity`, multiplying a price that
 * is already the line's total by the quantity again, and added the delivery
 * fee even on a store whose prices contain it — so saving an edit changed
 * what the customer owed. And the records: replacing the set deletes the
 * lines it drops, and those lines carry the stock reservation and what was
 * actually delivered or returned.
 */


describe('editing what is on an order', () => {
  it('recomputes the total through the one COD function, not a second formula', async () => {
    const { computeCod } = await import('@/lib/money');

    // The old formula on a delivery-inclusive store: 60 × 3 + 4 − 0 = 184.
    const wrong = 60 * 3 + 4 - 0;

    const right = computeCod({
      lines: [{ quantity: 3, unitPrice: 20 }],
      discount: 0,
      deliveryFee: 4,
      priceIncludesDelivery: true,
      minorUnit: 2,
    });

    expect(right.cod).toBe(60);
    expect(wrong).not.toBe(right.cod);
  });

  it('charges the fee on a store whose prices exclude it, once', async () => {
    const { computeCod } = await import('@/lib/money');
    const money = computeCod({
      lines: [{ quantity: 2, unitPrice: 20 }],
      discount: 0,
      deliveryFee: 2.5,
      priceIncludesDelivery: false,
      minorUnit: 2,
    });
    expect(money.cod).toBe(42.5);
  });
});
