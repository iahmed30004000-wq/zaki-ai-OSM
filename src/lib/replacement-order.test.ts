import { describe, expect, it, vi, beforeEach } from 'vitest';
import { repoFile, stripComments } from './guard-source';

vi.mock('./order-ref', () => ({
  orderRefFields: vi.fn(async (_tx: unknown, _c: string, prefix: string, attempt: number) => ({
    orderNumber: `${prefix}-${100 + attempt}`,
  })),
}));
const reserve = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('./reservation', () => ({ reserveOrderLines: (...a: unknown[]) => reserve(...a) }));

import { createReplacement, type ReplacementSource } from './replacement-order';

/**
 * A SECOND ORDER FOR THE SAME SALE.
 *
 * Two paths need one — a parcel taken back from a courier company, and a
 * change to the goods on a parcel they already hold — and they used to
 * have a builder each, except the second path had no builder at all: the
 * message told the courier «we will send you a new waybill» and nothing
 * anywhere made one.
 *
 * What these hold down is the part that cannot be seen by looking at the
 * screen: that an unchanged replacement carries the ORIGINAL's figures
 * untouched, and a changed one goes through `computeCod` — the one COD
 * function — rather than a second arithmetic written here.
 */

const ORDER: ReplacementSource = {
  id: 'o1',
  orderNumber: 'SY-0001',
  countryId: 'c1',
  storeId: 's1',
  regionId: 'r1',
  customerId: 'cust1',
  productId: 'p1',
  offerId: null,
  quantity: 2,
  freeQuantity: 0,
  sellingPrice: 200,
  discountAmount: 20,
  shippingCost: 15,
  totalAmount: 195,
  currency: 'SYP',
  priceIncludesDelivery: false,
  productNameSnapshot: 'قميص',
  productImageSnapshot: null,
  moderatorId: 'm1',
  estimatedCostOfGoods: 80,
  source: 'Manual',
  customerNotes: null,
};

/**
 * A REAL ROW'S SHAPE, COPIED OFF THE DATABASE.
 *
 * `unitPrice` is PER UNIT and `lineTotal` is the line after its discount
 * share — measured on SY-2026-0152: quantity 3, unitPrice 16.67,
 * lineTotal 50. The first version of this fixture put the LINE total in
 * `unitPrice`, because the order route divides by quantity when it writes
 * the column and that reads like the column holds a line total. It does
 * not; the route divides because its own input is one.
 *
 * So the fixture agreed with the arithmetic under test instead of with the
 * rows, every assertion passed, and a replacement of two units priced
 * itself at a third of what the customer owed.
 */
const ITEMS = [
  { productId: 'p1', productName: 'قميص', quantity: 2, freeQuantity: 0, unitPrice: 100, lineTotal: 180, discountShare: 20 },
];

function fakeTx(figures: Record<string, number> = {}) {
  const created: Record<string, unknown>[] = [];
  const lines: Record<string, unknown>[] = [];
  return {
    tx: {
      // The fixed cost an admin set for a product (`ProductFixedCost`): none, unless a test hands some in.
      productFixedCost: {
        findMany: vi.fn(async ({ where }: { where: { companyId: string; productId: { in: string[] } } }) =>
          Object.entries(figures)
            .filter(([productId]) => where.productId.in.includes(productId))
            .map(([productId, amount]) => ({ productId, amount }))
        ),
      },
      orderItem: {
        findMany: vi.fn(async () => ITEMS),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          lines.push(data);
          return data;
        }),
      },
      order: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { id: 'new1', orderNumber: data.orderNumber };
        }),
      },
    },
    created,
    lines,
  };
}

const plan = {
  companyId: 'co1',
  order: ORDER,
  orderPrefix: 'SY',
  attempt: 0,
  minorUnit: 2,
  allowNegativeStock: false,
  shippingStatus: 'READY_FOR_SHIPPING',
  internalNotes: 'بديل',
};

beforeEach(() => reserve.mockClear());

describe('a replacement with nothing changed', () => {
  it('carries the original figures untouched', async () => {
    const { tx, created } = fakeTx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createReplacement(tx as any, plan);
    const row = created[0];
    // Recomputing an amount nobody asked to change is a way to move it by
    // a rounding rule that has shifted since.
    expect(row.totalAmount).toBe(ORDER.totalAmount);
    expect(row.sellingPrice).toBe(ORDER.sellingPrice);
    expect(row.quantity).toBe(ORDER.quantity);
    expect(row.discountAmount).toBe(ORDER.discountAmount);
    expect(row.estimatedCostOfGoods).toBe(ORDER.estimatedCostOfGoods);
  });

  it('and links back, and starts life where the caller said', async () => {
    const { tx, created } = fakeTx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createReplacement(tx as any, { ...plan, shippingStatus: 'PACKING' });
    expect(created[0].replacesOrderId).toBe('o1');
    expect(created[0].shippingStatus).toBe('PACKING');
    // The delivery fee for the leg already flown is owed against the
    // ORIGINAL; this one is priced when it joins a shipment.
    expect(created[0].shippingCost).toBe(0);
    // Confirmed once already — it re-enters at preparation, not intake.
    expect(created[0].confirmationStatus).toBe('CONFIRMED');
  });

  /** A replacement that cannot be picked is not a replacement. */
  it('and takes its goods off the shelf now', async () => {
    const { tx } = fakeTx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createReplacement(tx as any, plan);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(reserve.mock.calls[0][2]).toEqual({ allowNegativeStock: false });
  });
});

/**
 * THE REPLACEMENT KEEPS THE SALE'S NAME.
 *
 * The replacement used to copy the moderator and the source and nothing
 * else, so the campaign that paid for the click, the page the customer
 * ordered from, the person who confirmed the order and the one it was
 * assigned to all stayed on the old order — which ends as a return. The
 * order that finally delivered belonged to nobody.
 *
 * Only NAMES move. The money below is built exactly as before.
 */
const SOLD: ReplacementSource = {
  ...ORDER,
  channelId: 'ch1',
  campaignId: 'camp1',
  landingPageId: 'lp1',
  deviceClass: 'mobile',
  adId: 'ad9',
  adSourceType: 'CTWA',
  refCode: 'K7Q2',
  refCodeAt: new Date('2026-10-20T10:00:00Z'),
  touchAt: new Date('2026-10-20T09:00:00Z'),
  pageId: 'pg1',
  wabaId: 'wa1',
  conversationRef: 'conv-1',
  confirmedById: 'u-confirmer',
  assignedToId: 'u-assignee',
  assignedAt: new Date('2026-10-21T08:00:00Z'),
};

describe('a replacement carries who sold it and where it came from', () => {
  it('copies the campaign, the door, the page and the ad evidence', async () => {
    const { tx, created } = fakeTx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createReplacement(tx as any, { ...plan, order: SOLD });
    const row = created[0];
    expect(row).toMatchObject({
      channelId: 'ch1',
      campaignId: 'camp1',
      landingPageId: 'lp1',
      deviceClass: 'mobile',
      adId: 'ad9',
      adSourceType: 'CTWA',
      refCode: 'K7Q2',
      pageId: 'pg1',
      wabaId: 'wa1',
      conversationRef: 'conv-1',
    });
    expect(row.refCodeAt).toEqual(SOLD.refCodeAt);
    expect(row.touchAt).toEqual(SOLD.touchAt);
  });

  it('and the moderator, the confirmer and the assignee', async () => {
    const { tx, created } = fakeTx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createReplacement(tx as any, { ...plan, order: SOLD });
    const row = created[0];
    expect(row.moderatorId).toBe('m1');
    expect(row.confirmedById).toBe('u-confirmer');
    expect(row.assignedToId).toBe('u-assignee');
    expect(row.assignedAt).toEqual(SOLD.assignedAt);
  });

  it('an order that had none of it gets none — nothing is invented', async () => {
    const { tx, created } = fakeTx();
    // ORDER is the short fixture: no attribution fields at all.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createReplacement(tx as any, plan);
    const row = created[0];
    for (const key of [
      'channelId', 'campaignId', 'landingPageId', 'deviceClass', 'adId', 'adSourceType', 'refCode',
      'refCodeAt', 'touchAt', 'pageId', 'wabaId', 'conversationRef', 'confirmedById', 'assignedToId', 'assignedAt',
    ]) {
      expect(row[key], key).toBeNull();
    }
    // The moderator was always carried, null or not.
    expect(row.moderatorId).toBe('m1');
  });

  it('an explicit null on the original stays null', async () => {
    const { tx, created } = fakeTx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createReplacement(tx as any, { ...plan, order: { ...SOLD, campaignId: null, confirmedById: null, moderatorId: null } });
    expect(created[0].campaignId).toBeNull();
    expect(created[0].confirmedById).toBeNull();
    expect(created[0].moderatorId).toBeNull();
  });

  /** The sealed ones are written by the systems door alone. */
  it('and leaves behind what is not the replacement’s to carry', async () => {
    const { tx, created } = fakeTx();
    const fat = {
      ...SOLD,
      ctwaClidEnc: 'sealed-click',
      psidEnc: 'sealed-chat',
      externalRef: 'other-system-1',
      createdById: 'u-creator',
      claimedById: 'u-claimer',
      currentOwnerId: 'u-owner',
      confirmedAt: new Date('2026-10-20T11:00:00Z'),
      moderatorCommission: 7,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createReplacement(tx as any, { ...plan, order: fat as any });
    for (const key of [
      'ctwaClidEnc', 'psidEnc', 'externalRef', 'createdById', 'claimedById',
      'currentOwnerId', 'confirmedAt', 'moderatorCommission',
    ]) {
      expect(created[0], key).not.toHaveProperty(key);
    }
  });
});

describe('and not one amount moves', () => {
  /**
   * The same order with and without the sale's name on it must produce the
   * same money, field for field — in the currency with three decimals too,
   * where a fils is a real figure.
   */
  const MONEY = ['sellingPrice', 'discountAmount', 'shippingCost', 'totalAmount', 'estimatedCostOfGoods', 'quantity', 'freeQuantity'];

  it.each([
    { label: 'unchanged goods', overrides: undefined, minorUnit: 2 },
    { label: 'changed goods', overrides: { quantity: 3 }, minorUnit: 2 },
    { label: 'changed goods in dinars (3 places)', overrides: { quantity: 3, discountAmount: 2.5 }, minorUnit: 3 },
  ])('$label', async ({ overrides, minorUnit }) => {
    const bare = fakeTx();
    const sold = fakeTx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createReplacement(bare.tx as any, { ...plan, minorUnit, overrides });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createReplacement(sold.tx as any, { ...plan, order: SOLD, minorUnit, overrides });
    for (const key of MONEY) expect(sold.created[0][key], key).toBe(bare.created[0][key]);
    expect(sold.lines).toEqual(bare.lines);
  });

  it('three decimals: 3 × 12.345 less 1.111 is 35.924, not 35.92', async () => {
    const { tx, created } = fakeTx();
    const items = [{ productId: 'p1', productName: 'قميص', quantity: 1, freeQuantity: 0, unitPrice: 12.345, lineTotal: 12.345, discountShare: 0 }];
    tx.orderItem.findMany.mockResolvedValueOnce(items);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createReplacement(tx as any, {
      ...plan,
      order: { ...SOLD, quantity: 1, currency: 'JOD' },
      minorUnit: 3,
      overrides: { quantity: 3, discountAmount: 1.111 },
    });
    expect(created[0].sellingPrice).toBe(37.035);
    expect(created[0].totalAmount).toBe(35.924);
  });

  it('the carried columns are names — no price, fee, discount or commission among them', () => {
    const src = stripComments(repoFile('src/lib/replacement-order.ts'));
    const block = src.slice(src.indexOf('export function carriedSale'), src.indexOf('export interface ReplacementPlan'));
    expect(block).not.toMatch(/Amount|Price|Fee|Cost|Commission|discount|total|money/i);
    // And it is spread into the row, once, beside the figures — not written
    // a second time by hand next to them.
    expect(src.match(/\.\.\.carriedSale\(order\)/g)).toHaveLength(1);
  });
});

describe('a replacement carrying an approved change', () => {
  it('recomputes the money at the new count', async () => {
    const { tx, created, lines } = fakeTx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createReplacement(tx as any, { ...plan, overrides: { quantity: 3 } });
    const row = created[0];
    expect(row.quantity).toBe(3);
    // 3 × 100, the stored per-unit price = 300, less the 20 discount =
    // 280. Not the original's 195 carried across unchanged, which is what
    // an edit-free copy would have shipped — and not 3 × (100/2) = 150,
    // which is what dividing a per-unit price by its quantity produced.
    expect(row.sellingPrice).toBe(300);
    expect(row.totalAmount).toBe(280);
    // And the line follows, or preparation picks two while the order says
    // three. Its unit price is untouched: the count changed, not the price.
    expect(lines[0].quantity).toBe(3);
    expect(lines[0].unitPrice).toBe(100);
    expect(lines[0].lineTotal).toBe(280);
  });

  it('and moves the cost of goods with the count', async () => {
    const { tx, created } = fakeTx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createReplacement(tx as any, { ...plan, overrides: { quantity: 4 } });
    // 80 for two units is 160 for four. Left at 80 the reported profit on
    // the replacement is wrong by the cost of two shirts.
    expect(created[0].estimatedCostOfGoods).toBe(160);
  });

  it('and applies an approved discount through the same function', async () => {
    const { tx, created } = fakeTx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createReplacement(tx as any, { ...plan, overrides: { discountAmount: 50 } });
    expect(created[0].discountAmount).toBe(50);
    // 2 × 100 = 200, less 50 = 150.
    expect(created[0].totalAmount).toBe(150);
    expect(created[0].sellingPrice).toBe(200);
  });

  it('and keeps every line it was given', async () => {
    const { tx, lines } = fakeTx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createReplacement(tx as any, { ...plan, overrides: { quantity: 3 } });
    expect(lines).toHaveLength(ITEMS.length);
    expect(lines[0].productId).toBe('p1');
    expect(lines[0].addedStage).toBe('INTAKE');
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A REPLACEMENT IS A NEW ORDER, COSTED NOW — SO THE OWNER'S FIXED COST APPLIES TO IT (1/11)
 *
 * «سعر تكلفة المنتج يكون ثابت ولا يتغير ابدا… ثابت لكل الطلبات». A replacement does not read the shelf: it takes a share of the cost of
 * the order it stands for (80 for two shirts above). With a fixed figure on a line's product the line costs the FIGURE × the units it
 * really carries (the gift included), whatever the original was struck at; a line with no figure keeps its share of the carried cost;
 * and with no figure on any line the cost is exactly what it always was (the tests above).
 * ═══════════════════════════════════════════════════════════════════════
 */
describe('a replacement costs a fixed figure when its product has one', () => {
  it('unchanged goods: 2 shirts at a figure of 50 cost 100, not the 80 the original was struck at', async () => {
    const { tx, created } = fakeTx({ p1: 50 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createReplacement(tx as any, plan);
    expect(created[0].estimatedCostOfGoods).toBe(100);
  });

  it('changed goods: 4 shirts at 50 cost 200 (the scaled 160 is replaced, not added to)', async () => {
    const { tx, created } = fakeTx({ p1: 50 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createReplacement(tx as any, { ...plan, overrides: { quantity: 4 } });
    expect(created[0].estimatedCostOfGoods).toBe(200);
  });

  it('ZERO is a figure: a shirt that costs nothing makes a replacement that costs nothing', async () => {
    const { tx, created } = fakeTx({ p1: 0 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createReplacement(tx as any, plan);
    expect(created[0].estimatedCostOfGoods).toBe(0);
  });

  it('the gift counts: 2 paid + 1 free at 50 is 150 — the carried 80 would have said 80', async () => {
    const { tx, created } = fakeTx({ p1: 50 });
    tx.orderItem.findMany.mockResolvedValueOnce([{ productId: 'p1', productName: 'قميص', quantity: 2, freeQuantity: 1, unitPrice: 100, lineTotal: 180, discountShare: 20 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createReplacement(tx as any, { ...plan, order: { ...ORDER, freeQuantity: 1 } });
    expect(created[0].estimatedCostOfGoods).toBe(150);
  });

  it('…and a changed count moves the paid units and leaves the gift where it was: 3 paid + 1 free at 50 is 200, not the 4/3 of anything', async () => {
    const { tx, created } = fakeTx({ p1: 50 });
    tx.orderItem.findMany.mockResolvedValueOnce([{ productId: 'p1', productName: 'قميص', quantity: 2, freeQuantity: 1, unitPrice: 100, lineTotal: 180, discountShare: 20 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createReplacement(tx as any, { ...plan, order: { ...ORDER, freeQuantity: 1 }, overrides: { quantity: 3 } });
    // quantity 2 → 3 on the order, the one line scaled to 3 paid; the gift on the line is still its one
    expect(created[0].estimatedCostOfGoods).toBe(200);
  });

  it('a MIXED order: the shirts (2) at their figure of 50, the socks (3) keep their 3/5 of the carried 80 — 100 + 48', async () => {
    const { tx, created } = fakeTx({ p1: 50 });
    tx.orderItem.findMany.mockResolvedValueOnce([
      { productId: 'p1', productName: 'قميص', quantity: 2, freeQuantity: 0, unitPrice: 100, lineTotal: 180, discountShare: 20 },
      { productId: 'p2', productName: 'جوارب', quantity: 3, freeQuantity: 0, unitPrice: 10, lineTotal: 30, discountShare: 0 },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createReplacement(tx as any, { ...plan, order: { ...ORDER, quantity: 5 } });
    expect(created[0].estimatedCostOfGoods).toBe(148);
  });

  it('a figure for a product that is NOT among the lines moves nothing: the carried 80, untouched', async () => {
    const { tx, created } = fakeTx({ p9: 50 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createReplacement(tx as any, plan);
    expect(created[0].estimatedCostOfGoods).toBe(80);
  });

  it('rounded by the currency: 3 units at 1.1117 is 3.3351 — 3.34 at two places, 3.335 at three', async () => {
    const items = [{ productId: 'p1', productName: 'قميص', quantity: 3, freeQuantity: 0, unitPrice: 100, lineTotal: 300, discountShare: 0 }];
    for (const [minorUnit, expected] of [[2, 3.34], [3, 3.335]] as const) {
      const { tx, created } = fakeTx({ p1: 1.1117 });
      tx.orderItem.findMany.mockResolvedValueOnce(items);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await createReplacement(tx as any, { ...plan, order: { ...ORDER, quantity: 3 }, minorUnit });
      expect(created[0].estimatedCostOfGoods).toBe(expected);
    }
  });

  it('the figure is asked for the products of the LINES, once, in the plan’s company', async () => {
    const { tx } = fakeTx({ p1: 50 });
    tx.orderItem.findMany.mockResolvedValueOnce([
      { productId: 'p1', productName: 'قميص', quantity: 1, freeQuantity: 0, unitPrice: 100, lineTotal: 100, discountShare: 0 },
      { productId: 'p2', productName: 'جوارب', quantity: 1, freeQuantity: 0, unitPrice: 10, lineTotal: 10, discountShare: 0 },
      { productId: 'p1', productName: 'قميص', quantity: 1, freeQuantity: 0, unitPrice: 100, lineTotal: 100, discountShare: 0 },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createReplacement(tx as any, { ...plan, order: { ...ORDER, quantity: 3 } });
    expect(tx.productFixedCost.findMany).toHaveBeenCalledTimes(1);
    expect(tx.productFixedCost.findMany).toHaveBeenCalledWith({
      where: { companyId: 'co1', productId: { in: ['p1', 'p2'] } },
      select: { productId: true, amount: true },
    });
  });

  it('NEGATIVE: with no figure on any line nothing is rounded or recomputed — the very number the original had, even a fraction', async () => {
    const { tx, created } = fakeTx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createReplacement(tx as any, { ...plan, order: { ...ORDER, estimatedCostOfGoods: 80.123456 } });
    expect(created[0].estimatedCostOfGoods).toBe(80.123456);
  });
});

describe('the reorder door', () => {
  const route = () => stripComments(repoFile('src/app/api/orders/[id]/reorder/route.ts'));

  it('re-reads the seal and refuses anything that is not a reorder', () => {
    const src = route();
    // Not trusted from the screen: a parcel that came back while the
    // message was being written belongs on the ordinary apply path, and an
    // address change belongs there too — cancelling a waybill a dispatcher
    // could have fixed costs a delivery and a return for nothing.
    expect(src).toMatch(/if \(!seal\.sealed \|\| courierActionFor\(sealedAsked\) !== 'CANCEL_AND_REORDER'\)/);
  });

  it('and raises no second replacement for one order', () => {
    expect(route()).toMatch(/if \(order\.replacedBy\)/);
    // And once, under concurrency: the same guard the apply path uses.
    expect(route()).toMatch(/where: \{ id: request\.id, appliedAt: null \}/);
  });

  it('and ends the original as a return, never as stock back on the shelf', () => {
    const src = route();
    // The parcel is physically in a van. Releasing its units here would
    // count goods as available while they are out on a road.
    expect(src).toMatch(/shippingStatus: 'RETURN_REQUESTED'/);
    expect(src, 'يُحرِّر الحجزَ على طردٍ ما زال خارجاً').not.toMatch(/releaseOrderLines/);
    // Optimistic concurrency, like every other write to an order.
    expect(src).toMatch(/version: order\.version/);
  });

  it('and carries only the goods, naming what it will not carry', () => {
    const src = route();
    expect(src).toMatch(/const REORDERABLE = \['quantity', 'discountAmount'\] as const/);
    // THE REFUSAL, not merely the words for it. Naming the list and the
    // code passed while the `if` around them had been switched off — and
    // a request mixing an address in would then have had its address
    // silently dropped, which is the exact failure the list is for.
    expect(src).toMatch(
      /const stray = Object\.keys\(expanded\.fields\)\.filter\(\s*\(f\) => !\(REORDERABLE as readonly string\[\]\)\.includes\(f\)\s*\);\s*if \(stray\.length > 0\) \{/
    );
    expect(src).toMatch(/code: 'NOT_REORDERABLE'/);
  });

  it('and moves nothing until somebody says the courier was told', () => {
    // `z.literal(true)`, not an optional boolean: the whole reason this
    // door exists is that the courier has been told, and a default would
    // let a request through that said nothing about it.
    expect(route()).toMatch(/courierNotified: z\.literal\(true\)/);
  });
});

describe('one builder, two callers', () => {
  it('the transfer route no longer builds an order of its own', () => {
    const src = stripComments(repoFile('src/app/api/ops/tracking/transfer/route.ts'));
    expect(src).toMatch(/createReplacement\(tx, \{/);
    expect(src, 'ما زال يُنشئ الطلبَ بنفسه').not.toMatch(/tx\.order\.create\(/);
    // And the reservation moved with it, rather than being done twice.
    expect(src).not.toMatch(/reserveOrderLines/);
  });

  it('and the reorder route uses the same one', () => {
    expect(stripComments(repoFile('src/app/api/orders/[id]/reorder/route.ts'))).toMatch(
      /createReplacement\(tx, \{/
    );
  });
});

describe('the button under the courier message', () => {
  it('says what it will do, and does it', () => {
    const dialog = stripComments(repoFile('src/components/orders/CourierNotifyDialog.tsx'));
    // «طبّق التعديل» on a cancelled waybill was the label on a button that
    // wrote the change onto the parcel we had just asked them to stop.
    expect(dialog).toMatch(/ask\.action === 'CANCEL_AND_REORDER'\s*\?\s*'أبلغتُهم — ألغِ البوليصة وارفع الطلب البديل'/);

    const queue = stripComments(repoFile('src/components/screens/ChangeRequestsScreen.tsx'));
    expect(queue).toMatch(
      /if \(courierNotified && courierFor\?\.ask\.action === 'CANCEL_AND_REORDER'\)/
    );
    expect(queue).toMatch(/\/reorder`/);
  });
});

/**
 * RV8 — WHO ENTERED THE REPLACEMENT.
 *
 * `createdById` is "the staff account that ENTERED this order". A replacement used to carry the sale's people and
 * leave this empty, so a derived order had no creator. It is the person who pressed the button — said by the caller —
 * and NEVER the original's creator, which is a fact about the old order's work.
 */
describe('the replacement names who raised it', () => {
  it('createdById is what the caller says', async () => {
    const { tx, created } = fakeTx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createReplacement(tx as any, { ...plan, createdById: 'u-presser' });
    expect(created[0].createdById).toBe('u-presser');
  });

  it('and never the original’s creator, even when the original has one', async () => {
    const { tx, created } = fakeTx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const original = { ...ORDER, createdById: 'u-original' } as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createReplacement(tx as any, { ...plan, order: original, createdById: 'u-presser' });
    expect(created[0].createdById).toBe('u-presser');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createReplacement(tx as any, { ...plan, order: original });
    expect('createdById' in created[1], 'نُسخ مُنشئ الطلب الأصلي').toBe(false);
  });

  it('the caller that says nothing writes nothing — no invented creator', async () => {
    const { tx, created } = fakeTx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createReplacement(tx as any, plan);
    expect('createdById' in created[0]).toBe(false);
  });

  it('and every caller in the repository says who it is', () => {
    expect(stripComments(repoFile('src/app/api/orders/[id]/reorder/route.ts'))).toMatch(/createdById: user\.id/);
    expect(stripComments(repoFile('src/app/api/ops/tracking/transfer/route.ts'))).toMatch(/createdById: user\.id/);
    expect(stripComments(repoFile('src/lib/parcel-swap.ts'))).toMatch(/createdById: p\.user\.id/);
  });

  it('and the box path writes it too', () => {
    const src = stripComments(repoFile('src/lib/replacement-order.ts'));
    const box = src.slice(src.indexOf('async function createBoxReplacement'), src.indexOf('export async function reshapeToBox'));
    expect(box).toMatch(/\.\.\.\(plan\.createdById \? \{ createdById: plan\.createdById \} : \{\}\)/);
  });
});
