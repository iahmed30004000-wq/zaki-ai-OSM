import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Partial delivery — the customer took some lines and refused others.
 *
 * The test that matters most is the fee one. The courier travelled to that
 * door whether one line was taken or all of them, so prorating the fee would
 * quietly make every partial cheaper than it was and leave the difference
 * unexplained in the settlement.
 */

const { db, consumeOrderStock } = vi.hoisted(() => ({
  consumeOrderStock: vi.fn(async (..._a: unknown[]) => ({ taken: 0, short: 0, alreadyDone: false })),
  db: {
    order: { findFirst: vi.fn(), update: vi.fn() },
    orderItem: { update: vi.fn() },
    orderActivity: { create: vi.fn() },
    // Every door that delivers a parcel now counts it on the customer.
    customer: { update: vi.fn() },
    // The knock at the door, appended in this same transaction. These 14
    // tests failed the moment it started being recorded, which is the right
    // way round: a delivery that writes no attempt is the defect.
    deliveryAttempt: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: 'attempt-1', attemptNumber: 1 })),
    },
  },
}));
vi.mock('./db', () => ({ db }));
vi.mock('./stock-consumption', () => ({ consumeOrderStock }));

import {
  PartialDeliveryRefused,
  completionOf,
  doorUnits,
  expectedBackTotal,
  extraAction,
  needsExtraAction,
  recordPartialDelivery,
  settledLines,
} from './partial-delivery';

const ORDER = 'o1';

/** Two lines: 2 × 10 and 1 × 30, no discount, 5 delivery fee. */
const order = (over: Record<string, unknown> = {}) => ({
  id: ORDER,
  orderNumber: 'SY-2026-0001',
  shippingStatus: 'OUT_FOR_DELIVERY',
  deliveryFee: 5,
  priceIncludesDelivery: false,
  collectedAmount: null,
  items: [
    { id: 'i1', productId: 'p1', productName: 'كريم', quantity: 2, freeQuantity: 0, unitPrice: 10, lineTotal: 20, discountShare: 0 },
    { id: 'i2', productId: 'p2', productName: 'قطرة', quantity: 1, freeQuantity: 0, unitPrice: 30, lineTotal: 30, discountShare: 0 },
  ],
  ...over,
});

const run = (lines: { itemId: string; deliveredQty: number }[]) =>
  recordPartialDelivery(db as never, {
    companyId: 'c1', orderId: ORDER, lines, minorUnit: 2, userId: 'u1',
  });

beforeEach(() => {
  vi.clearAllMocks();
  db.order.findFirst.mockResolvedValue(order());
  db.order.update.mockResolvedValue({});
  db.orderItem.update.mockResolvedValue({});
  db.orderActivity.create.mockResolvedValue({});
  db.customer.update.mockResolvedValue({});
});

describe('the delivery fee is charged in full', () => {
  it('charges the whole fee when only one line of two was taken', async () => {
    // Took both units of the 10 line, refused the 30 line.
    const result = await run([{ itemId: 'i1', deliveredQty: 2 }, { itemId: 'i2', deliveredQty: 0 }]);

    expect(result.status).toBe('PARTIALLY_DELIVERED');
    expect(result.deliveredValue).toBe(20);
    expect(result.deliveryFee).toBe(5); // NOT prorated to 2.5
    expect(result.collectedAmount).toBe(25);
  });

  it('charges the same whole fee when almost nothing was taken', async () => {
    const result = await run([{ itemId: 'i1', deliveredQty: 1 }, { itemId: 'i2', deliveredQty: 0 }]);
    expect(result.deliveredValue).toBe(10);
    expect(result.deliveryFee).toBe(5);
    expect(result.collectedAmount).toBe(15);
  });

  it('waives it only when nothing at all was taken — that trip is a return', async () => {
    const result = await run([{ itemId: 'i1', deliveredQty: 0 }, { itemId: 'i2', deliveredQty: 0 }]);
    expect(result.status).toBe('RETURNED');
    expect(result.deliveryFee).toBe(0);
    expect(result.collectedAmount).toBe(0);
  });

  it('does not add the fee twice when the price already includes it', async () => {
    db.order.findFirst.mockResolvedValue(order({ priceIncludesDelivery: true }));
    const result = await run([{ itemId: 'i1', deliveredQty: 2 }, { itemId: 'i2', deliveredQty: 0 }]);
    expect(result.collectedAmount).toBe(20); // the 5 is already inside the line prices
  });
});

describe('what happened to each line', () => {
  it('records delivered and returned units per line', async () => {
    await run([{ itemId: 'i1', deliveredQty: 1 }, { itemId: 'i2', deliveredQty: 1 }]);

    const writes = db.orderItem.update.mock.calls.map((c: any) => [c[0].where.id, c[0].data]);
    expect(writes).toContainEqual(['i1', { deliveredQty: 1, returnedQty: 1 }]);
    expect(writes).toContainEqual(['i2', { deliveredQty: 1, returnedQty: 0 }]);
  });

  it('treats a line nobody mentioned as not delivered', async () => {
    const result = await run([{ itemId: 'i1', deliveredQty: 2 }]);
    expect(result.linesReturned).toBe(1);
    expect(result.returnedUnits).toEqual([
      { itemId: 'i2', productId: 'p2', productName: 'قطرة', quantity: 1 },
    ]);
  });

  it('hands the refused units back rather than restocking them', async () => {
    const result = await run([{ itemId: 'i1', deliveredQty: 0 }, { itemId: 'i2', deliveredQty: 1 }]);
    // Returned to the caller for count-and-inspect; nothing re-entered stock here.
    expect(result.returnedUnits).toEqual([
      { itemId: 'i1', productId: 'p1', productName: 'كريم', quantity: 2 },
    ]);
  });

  it('closes as DELIVERED when every unit was taken', async () => {
    const result = await run([{ itemId: 'i1', deliveredQty: 2 }, { itemId: 'i2', deliveredQty: 1 }]);
    expect(result.status).toBe('DELIVERED');
    expect(result.collectedAmount).toBe(55); // 20 + 30 + 5
  });
});

describe('gift units', () => {
  it('counts a free unit as stock but never charges for it', async () => {
    db.order.findFirst.mockResolvedValue(
      order({
        items: [
          { id: 'i1', productId: 'p1', productName: 'كريم', quantity: 1, freeQuantity: 1, unitPrice: 10, lineTotal: 10, discountShare: 0 },
        ],
      })
    );

    const result = await run([{ itemId: 'i1', deliveredQty: 2 }]);
    expect(result.deliveredValue).toBe(10); // one paid unit, one gift
    expect(result.collectedAmount).toBe(15);
  });
});

describe('the discount follows the line', () => {
  it('charges the discounted unit price for what was taken', async () => {
    db.order.findFirst.mockResolvedValue(
      order({
        items: [
          { id: 'i1', productId: 'p1', productName: 'كريم', quantity: 2, freeQuantity: 0, unitPrice: 10, lineTotal: 16, discountShare: 4 },
        ],
      })
    );

    // One of two units, carrying half the line's 4 discount.
    const result = await run([{ itemId: 'i1', deliveredQty: 1 }]);
    expect(result.deliveredValue).toBe(8);
  });
});

describe('what it refuses', () => {
  it('refuses a parcel that never left for delivery', async () => {
    db.order.findFirst.mockResolvedValue(order({ shippingStatus: 'READY_FOR_PICKUP' }));
    await expect(run([{ itemId: 'i1', deliveredQty: 1 }])).rejects.toThrow(/قبل خروج الشحنة/);
  });

  /**
   * The signal is the door's own marks now, not `collectedAmount`: the door
   * stopped writing money, so an amount on the order says the courier's
   * statement arrived, not that somebody already stood at this door.
   */
  it('refuses to settle the same order twice, on either of its two dates', async () => {
    db.order.findFirst.mockResolvedValue(order({ deliveredAt: new Date('2026-09-20') }));
    await expect(run([{ itemId: 'i1', deliveredQty: 1 }])).rejects.toThrow(/مسبقاً/);

    db.order.findFirst.mockResolvedValue(order({ returnedAt: new Date('2026-09-20') }));
    await expect(run([{ itemId: 'i1', deliveredQty: 1 }])).rejects.toThrow(/مسبقاً/);
  });

  /** And an amount alone no longer blocks it — that is the statement's mark. */
  it('but an amount from the statement is not a second delivery', async () => {
    db.order.findFirst.mockResolvedValue(order({ collectedAmount: 25 }));
    await expect(run([{ itemId: 'i1', deliveredQty: 1 }])).resolves.toBeTruthy();
  });

  it('refuses more units than were shipped', async () => {
    await expect(run([{ itemId: 'i1', deliveredQty: 3 }])).rejects.toThrow(PartialDeliveryRefused);
  });

  it('refuses a line from another order', async () => {
    await expect(run([{ itemId: 'not-ours', deliveredQty: 1 }])).rejects.toThrow(/لا ينتمي/);
  });
});

/**
 * THE GOODS LEAVE THE SHELF AT THE DOOR.
 *
 * This path wrote the order, the lines and the money and touched no batch,
 * so a parcel handed over stayed in stock for ever. Nothing caught it later:
 * the courier-statement sweep only promotes orders still in flight, and an
 * order settled here is past all of those states.
 */
describe('stock leaves when the parcel does', () => {
  it('consumes on a full delivery', async () => {
    await recordPartialDelivery(db as never, {
      companyId: 'c1', orderId: ORDER, minorUnit: 2, userId: 'u1',
      lines: [{ itemId: 'i1', deliveredQty: 2 }, { itemId: 'i2', deliveredQty: 1 }],
    });
    expect(consumeOrderStock).toHaveBeenCalledTimes(1);
    expect(consumeOrderStock.mock.calls[0][1]).toMatchObject({ orderId: ORDER, companyId: 'c1' });
  });

  it('consumes on a PARTIAL delivery too — the refused units also left the warehouse', async () => {
    // They are in the courier's van, not on the shelf. They come back when
    // the returns desk counts them in, which is what restores them.
    await recordPartialDelivery(db as never, {
      companyId: 'c1', orderId: ORDER, minorUnit: 2, userId: 'u1',
      lines: [{ itemId: 'i1', deliveredQty: 2 }, { itemId: 'i2', deliveredQty: 0 }],
    });
    expect(consumeOrderStock).toHaveBeenCalledTimes(1);
  });

  it('consumes NOTHING when the customer took nothing', async () => {
    // The parcel is coming back whole and was never consumed, so there is
    // nothing to take off — and nothing for the returns desk to put back.
    await recordPartialDelivery(db as never, {
      companyId: 'c1', orderId: ORDER, minorUnit: 2, userId: 'u1',
      lines: [{ itemId: 'i1', deliveredQty: 0 }, { itemId: 'i2', deliveredQty: 0 }],
    });
    expect(consumeOrderStock).not.toHaveBeenCalled();
  });

  /*
   * CHANGED 30/10 (P0-13, OLD → NEW). Old: «carries the country's negative-stock rule through rather than deciding
   * it here» — this door passed `input.allowNegativeStock ?? false`, a default that refused a short shelf the moment
   * a second caller forgot the flag (LAUNCH_LINE: «السطرُ الذي يصير عطلاً عند أوّلِ مُستدعٍ ثانٍ»). New: no door
   * passes a stock rule at all; a delivery is recorded whatever the shelf says (`consumeOrderStock`).
   */
  it('passes NO stock rule: a delivery is recorded whatever the shelf says', async () => {
    await recordPartialDelivery(db as never, {
      companyId: 'c1', orderId: ORDER, minorUnit: 2, userId: 'u1',
      lines: [{ itemId: 'i1', deliveredQty: 2 }, { itemId: 'i2', deliveredQty: 1 }],
    });
    expect(Object.keys(consumeOrderStock.mock.calls[0][1]).sort()).toEqual(['companyId', 'orderId', 'userId']);
  });
});

/**
 * THE ORDER IS SETTLED TWICE.
 *
 *   «بصير الطلب بيتمم مرتين — مرة بيتمم للمستلم ومرة للطلب الراجع. واذا اتمم
 *    واحد فهو اتمم جزءي، ما بنغلق غير كامل»
 *
 * These guard a rule that has no column: completion is derived from the
 * delivered units, the settlement status and whether a return receipt
 * exists. Get it wrong and a half-settled order reads as finished, which is
 * exactly what `order-state.ts` does today by mapping PARTIALLY_DELIVERED
 * straight into the CLOSED zone.
 */
describe('which product came back, and how many', () => {
  const line = (over: Record<string, unknown> = {}) => ({
    id: 'i1', productId: 'p1', productName: 'ماء الكمأ',
    quantity: 3, freeQuantity: 0, deliveredQty: null as number | null, ...over,
  });

  it('reports the units still owed to the shelf, not the units shipped', () => {
    // Three went out, the customer kept two. The desk expects ONE.
    const [l] = settledLines([line({ deliveredQty: 2 })]);
    expect(l.shipped).toBe(3);
    expect(l.delivered).toBe(2);
    expect(l.expectedBack).toBe(1);
  });

  it('counts gift units as units — they are real stock at zero price', () => {
    const [l] = settledLines([line({ quantity: 2, freeQuantity: 1, deliveredQty: 2 })]);
    expect(l.shipped).toBe(3);
    expect(l.expectedBack).toBe(1);
  });

  it('keeps «the door never spoke» apart from «the customer refused it»', () => {
    // Null is an announced return with nothing handed over; the whole parcel
    // is due back. Rendering it as 0 delivered would be a claim about the
    // customer that nobody made.
    const [l] = settledLines([line()]);
    expect(l.delivered).toBeNull();
    expect(l.expectedBack).toBe(3);
    expect(doorUnits([line()]).recorded).toBe(false);
    expect(doorUnits([line({ deliveredQty: 0 })]).recorded).toBe(true);
  });

  it('totals the lines rather than the order', () => {
    expect(
      expectedBackTotal([
        line({ deliveredQty: 2 }),
        line({ id: 'i2', quantity: 1, deliveredQty: 0 }),
      ])
    ).toBe(2);
  });

  it('never returns a negative expectation', () => {
    // A delivered quantity above the shipped one is corrupt data, not a
    // credit note: it must not subtract from what another line owes back.
    expect(expectedBackTotal([line({ deliveredQty: 9 })])).toBe(0);
  });
});

describe('the two settlements', () => {
  const partial = { deliveredUnits: 2, refusedUnits: 1 };

  it('a partial delivery has TWO halves, and one of them is not this desk’s', () => {
    const c = completionOf({ ...partial, settlementStatus: 'PENDING_COLLECTION', hasReturnReceipt: false });
    expect(c.halves.map((h) => h.key)).toEqual(['MONEY', 'GOODS']);
    expect(c.complete).toBe(false);
    expect(c.degree).toBe('NONE');
  });

  it('one settled of two is «اتمم جزءي» — and still not closed', () => {
    const c = completionOf({ ...partial, settlementStatus: 'PENDING_COLLECTION', hasReturnReceipt: true });
    expect(c.settledCount).toBe(1);
    expect(c.degree).toBe('PARTIAL');
    expect(c.complete).toBe(false);
    expect(c.awaiting).toEqual(['MONEY']);
  });

  it('«ما بنغلق غير كامل» — both halves, or it stays open', () => {
    const c = completionOf({ ...partial, settlementStatus: 'SETTLED', hasReturnReceipt: true });
    expect(c.degree).toBe('FULL');
    expect(c.complete).toBe(true);
    expect(c.awaiting).toEqual([]);
  });

  it('the goods half alone does not close it, and neither does the money half alone', () => {
    expect(completionOf({ ...partial, settlementStatus: 'SETTLED', hasReturnReceipt: false }).complete).toBe(false);
    expect(completionOf({ ...partial, settlementStatus: 'PENDING', hasReturnReceipt: true }).complete).toBe(false);
  });

  it('a partly-paid half is not a settled one', () => {
    // PARTIALLY_SETTLED is «اتمم جزءي» inside the money half itself. Calling
    // it resolved would close an order the courier still owes money on.
    const c = completionOf({ ...partial, settlementStatus: 'PARTIALLY_SETTLED', hasReturnReceipt: true });
    expect(c.complete).toBe(false);
  });

  it('PENDING_COLLECTION is not settled — every live order in this database sits there', () => {
    const c = completionOf({ deliveredUnits: 3, refusedUnits: 0, settlementStatus: 'PENDING_COLLECTION', hasReturnReceipt: false });
    expect(c.complete).toBe(false);
  });

  it('a full delivery has one half, and closes on the money', () => {
    const one = { deliveredUnits: 3, refusedUnits: 0 };
    expect(completionOf({ ...one, settlementStatus: 'PENDING', hasReturnReceipt: false }).complete).toBe(false);
    const done = completionOf({ ...one, settlementStatus: 'SETTLED', hasReturnReceipt: false });
    expect(done.halves).toHaveLength(1);
    expect(done.complete).toBe(true);
  });

  it('a full refusal has one half, and closes on the count', () => {
    const one = { deliveredUnits: 0, refusedUnits: 3 };
    expect(completionOf({ ...one, settlementStatus: 'NOT_APPLICABLE', hasReturnReceipt: false }).complete).toBe(false);
    const done = completionOf({ ...one, settlementStatus: 'NOT_APPLICABLE', hasReturnReceipt: true });
    expect(done.halves.map((h) => h.key)).toEqual(['GOODS']);
    expect(done.complete).toBe(true);
  });

  it('the money half exists because UNITS moved, not because a value did', () => {
    // A parcel of gift units is worth nothing and still owes the delivery
    // fee, which the courier is holding.
    const c = completionOf({ deliveredUnits: 1, refusedUnits: 0, settlementStatus: 'PENDING', hasReturnReceipt: false });
    expect(c.halves.map((h) => h.key)).toEqual(['MONEY']);
  });

  it('a parcel the door has not settled has no halves and cannot be complete', () => {
    const c = completionOf({ deliveredUnits: 0, refusedUnits: 0, settlementStatus: 'PENDING', hasReturnReceipt: false });
    expect(c.halves).toEqual([]);
    expect(c.complete).toBe(false);
    expect(c.degree).toBe('NONE');
  });

  it('says so in words, in Western digits', () => {
    const c = completionOf({ ...partial, settlementStatus: 'PENDING', hasReturnReceipt: true });
    expect(c.label).toContain('1');
    expect(c.label).toContain('2');
    expect(c.label).not.toMatch(/[٠-٩]/);
  });
});

describe('the extra action', () => {
  const line = (over: Record<string, unknown> = {}) => ({
    id: 'i1', productId: 'p1', productName: 'X',
    quantity: 3, freeQuantity: 0, deliveredQty: null as number | null, ...over,
  });

  it('is asked when the parcel had more than one unit and the door split it', () => {
    //   «إذا الأوردر فيه أكثر من كمية واستلم أو رفض قطعة»
    expect(needsExtraAction([line({ deliveredQty: 2 })])).toBe(true);
  });

  it('is not asked of a single-unit parcel — there is nothing to split', () => {
    expect(needsExtraAction([line({ quantity: 1, deliveredQty: 0 })])).toBe(false);
    expect(needsExtraAction([line({ quantity: 1, deliveredQty: 1 })])).toBe(false);
  });

  it('two units, one kept and one refused, is the smallest parcel that asks', () => {
    // «أكثر من كمية» falls out of «استلم أو رفض قطعة» rather than needing its
    // own check: a split parcel held at least two units by definition.
    expect(needsExtraAction([line({ quantity: 2, deliveredQty: 1 })])).toBe(true);
  });

  it('is not asked of a whole delivery or a whole refusal', () => {
    expect(needsExtraAction([line({ deliveredQty: 3 })])).toBe(false);
    expect(needsExtraAction([line({ deliveredQty: 0 })])).toBe(false);
  });

  it('is not asked before the door has spoken at all', () => {
    expect(needsExtraAction([line()])).toBe(false);
  });

  it('asks about the half the caller is standing at, not the first open one', () => {
    // Both halves open. The returns desk must be handed the GOODS question;
    // asking the clerk with a parcel in hand whether the money has arrived
    // is the wrong question to the wrong person, and it is what «the first
    // open half» produced — MONEY is pushed first.
    const bothOpen = completionOf({ deliveredUnits: 2, refusedUnits: 1, settlementStatus: 'PENDING', hasReturnReceipt: false });
    expect(extraAction(bothOpen, 'GOODS')?.key).toBe('GOODS');
    expect(extraAction(bothOpen, 'MONEY')?.key).toBe('MONEY');
  });

  it('offers nothing for a half that is already settled', () => {
    const goodsDone = completionOf({ deliveredUnits: 2, refusedUnits: 1, settlementStatus: 'PENDING', hasReturnReceipt: true });
    expect(extraAction(goodsDone, 'GOODS')).toBeNull();
    expect(extraAction(goodsDone, 'MONEY')?.key).toBe('MONEY');
  });

  it('offers nothing for a half the order does not have', () => {
    // A whole refusal owes no money, so there is no money question to ask.
    const refusal = completionOf({ deliveredUnits: 0, refusedUnits: 3, settlementStatus: 'NOT_APPLICABLE', hasReturnReceipt: false });
    expect(extraAction(refusal, 'MONEY')).toBeNull();
    expect(extraAction(refusal, 'GOODS')?.key).toBe('GOODS');
  });

  it('offers nothing once both halves are settled', () => {
    const done = completionOf({ deliveredUnits: 2, refusedUnits: 1, settlementStatus: 'SETTLED', hasReturnReceipt: true });
    expect(extraAction(done, 'GOODS')).toBeNull();
    expect(extraAction(done, 'MONEY')).toBeNull();
  });

  it('is a yes and a no, not a free-text field', () => {
    const open = completionOf({ deliveredUnits: 2, refusedUnits: 1, settlementStatus: 'PENDING', hasReturnReceipt: false });
    for (const half of ['GOODS', 'MONEY'] as const) {
      const action = extraAction(open, half);
      expect(action?.question).toContain('؟');
      expect(action?.yes).toContain('نعم');
      expect(action?.no).toContain('لا');
    }
  });
});

describe('the door announces the second half as it creates it', () => {
  it('a partial delivery comes back reporting two halves, neither settled', async () => {
    const out = await run([{ itemId: 'i1', deliveredQty: 2 }, { itemId: 'i2', deliveredQty: 0 }]);
    expect(out.deliveredUnits).toBe(2);
    expect(out.refusedUnits).toBe(1);
    expect(out.completion.halves.map((h) => h.key)).toEqual(['MONEY', 'GOODS']);
    expect(out.completion.complete).toBe(false);
  });

  it('and never claims the refused units are already back', async () => {
    // No receipt can exist at the door: the units are in the van.
    const out = await run([{ itemId: 'i1', deliveredQty: 2 }, { itemId: 'i2', deliveredQty: 0 }]);
    expect(out.completion.halves.find((h) => h.key === 'GOODS')?.settled).toBe(false);
  });

  it('a whole delivery reports one half — there is nothing coming back', async () => {
    const out = await run([{ itemId: 'i1', deliveredQty: 2 }, { itemId: 'i2', deliveredQty: 1 }]);
    expect(out.refusedUnits).toBe(0);
    expect(out.completion.halves.map((h) => h.key)).toEqual(['MONEY']);
  });

  it('a whole refusal reports one half — and it is the goods, not the money', async () => {
    const out = await run([{ itemId: 'i1', deliveredQty: 0 }, { itemId: 'i2', deliveredQty: 0 }]);
    expect(out.deliveredUnits).toBe(0);
    expect(out.completion.halves.map((h) => h.key)).toEqual(['GOODS']);
  });
});
