import { beforeEach, describe, expect, it, vi } from 'vitest';
import { repoFile, stripComments } from './guard-source';

vi.mock('./db', () => ({ db: {} }));

const drawDownStock = vi.fn();
const onHandTotal = vi.fn();
vi.mock('./receiving', () => ({
  drawDownStock: (...a: unknown[]) => drawDownStock(...a),
  onHandTotal: (...a: unknown[]) => onHandTotal(...a),
}));

import { consumeOrderStock, restoreOrderStock, absorbDamaged } from './stock-consumption';

/**
 * Delivering an order used to consume nothing: the reservation was released,
 * the batch kept its remainder, and the unit went back on sale. The measured
 * damage on the live database was 173 units handed to customers while every
 * batch still read 0 sold.
 *
 * So the failures that matter here are the two that let a unit be sold
 * twice, and the one that takes it twice.
 */

const ORDER = {
  orderNumber: 'SY-2026-0100',
  items: [
    { productId: 'p1', productName: 'أ', quantity: 2, freeQuantity: 1 },
    { productId: 'p2', productName: 'ب', quantity: 1, freeQuantity: 0 },
  ],
};

function makeTx(over: Record<string, unknown> = {}) {
  return {
    inventoryMovement: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
    // `update` because delivery now writes down what the goods actually
    // cost, from the batches they came out of.
    order: { findFirst: vi.fn().mockResolvedValue(ORDER), update: vi.fn() },
    // An order with no add-ons, unless a test says otherwise — plain functions, so a mock reset leaves them answering.
    orderAddOn: { aggregate: async () => ({ _sum: { reservedQty: 0 } }), findMany: async () => [], update: async () => ({}), updateMany: async () => ({ count: 0 }) },
    orderItem: { updateMany: vi.fn() },
    // The review line a short shelf leaves on the order (P0-13).
    orderActivity: { create: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
    productionBatch: { findFirst: vi.fn().mockResolvedValue({ costPerUnit: 4 }), create: vi.fn().mockResolvedValue({ id: 'b-new' }) },
    ...over,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  drawDownStock.mockResolvedValue({ taken: 0, short: 0, cost: 0 });
  onHandTotal.mockResolvedValue(0);
});

/**
 * The mock behind one of the transaction's models.
 *
 * `makeTx` is cast to `never` so it can be handed to a function that
 * wants a Prisma client; reaching back into it for an assertion needs
 * the shape spelled out once, here, rather than at every call.
 */
function on(tx: unknown, model: string, fn: string) {
  return (tx as Record<string, Record<string, ReturnType<typeof vi.fn>>>)[model][fn];
}

describe('delivering an order', () => {
  it('takes the gift units out too, not just the paid ones', async () => {
    // 2 paid + 1 free left the warehouse. Leaving the free one in stock is
    // how a shelf ends up holding goods that were given away.
    const tx = makeTx();
    drawDownStock.mockResolvedValue({ taken: 3, short: 0, cost: 15 });
    await consumeOrderStock(tx, { orderId: 'o1', companyId: 'c1' });
    expect(drawDownStock.mock.calls[0][1].quantity).toBe(3);
    expect(drawDownStock.mock.calls[1][1].quantity).toBe(1);
  });

  it('refuses to consume the same order twice', async () => {
    // Couriers retry and humans press the button again; consuming twice
    // would invent a shortage that never happened.
    const tx = makeTx({
      inventoryMovement: { findFirst: vi.fn().mockResolvedValue({ id: 'm1' }), create: vi.fn() },
    });
    const res = await consumeOrderStock(tx, { orderId: 'o1', companyId: 'c1' });
    expect(res.alreadyDone).toBe(true);
    expect(drawDownStock).not.toHaveBeenCalled();
  });

  it('keys that check to THIS order, not to any sale', async () => {
    const tx = makeTx();
    await consumeOrderStock(tx, { orderId: 'o1', companyId: 'c1' });
    expect((tx as any).inventoryMovement.findFirst.mock.calls[0][0].where).toEqual({
      referenceId: 'o1',
      type: 'SALE',
    });
  });

  it('writes the movement as a negative quantity, because stock went down', async () => {
    const tx = makeTx();
    drawDownStock.mockResolvedValue({ taken: 3, short: 0, cost: 15 });
    await consumeOrderStock(tx, { orderId: 'o1', companyId: 'c1' });
    expect((tx as any).inventoryMovement.create.mock.calls[0][0].data.quantity).toBe(-3);
  });

  it('records no movement for a line that supplied nothing', async () => {
    // A ledger line for zero units is noise that makes a real one harder to find.
    const tx = makeTx();
    drawDownStock.mockResolvedValue({ taken: 0, short: 3, cost: 0 });
    await consumeOrderStock(tx, { orderId: 'o1', companyId: 'c1' });
    expect((tx as any).inventoryMovement.create).not.toHaveBeenCalled();
  });

  it('reports the shortfall instead of hiding it', async () => {
    const tx = makeTx();
    drawDownStock.mockResolvedValue({ taken: 1, short: 2, cost: 5 });
    const res = await consumeOrderStock(tx, { orderId: 'o1', companyId: 'c1' });
    expect(res.short).toBe(4); // two lines, two short each way
  });

  it('clears the reservation, because the units are gone and not held', async () => {
    const tx = makeTx();
    await consumeOrderStock(tx, { orderId: 'o1', companyId: 'c1' });
    expect((tx as any).orderItem.updateMany).toHaveBeenCalledWith({
      where: { orderId: 'o1', reservedQty: { gt: 0 } },
      data: { reservedQty: 0 },
    });
  });

  it('does nothing for an order of another company', async () => {
    const tx = makeTx({ order: { findFirst: vi.fn().mockResolvedValue(null) } });
    const res = await consumeOrderStock(tx, { orderId: 'o1', companyId: 'someone-else' });
    expect(res).toMatchObject({ taken: 0, short: 0 });
    expect(drawDownStock).not.toHaveBeenCalled();
  });
});

describe('receiving a return', () => {
  /**
   * Every case here is a return of goods that WERE delivered — the ledger
   * holds a SALE for the order. That is the premise, not a detail: goods
   * that never left the shelf are a different case entirely, below.
   */
  const delivered = (over: Record<string, unknown> = {}) =>
    makeTx({
      inventoryMovement: {
        findFirst: vi.fn(async ({ where }: any) => (where?.type === 'SALE' ? { id: 'sale-1' } : null)),
        create: vi.fn(),
      },
      ...over,
    });

  it('puts the units into a real batch, not only into the ledger', async () => {
    // The whole bug: a ledger line moves nothing, and the shipment screen
    // keeps reporting a shortage for stock the ledger says is back.
    const tx = delivered();
    await restoreOrderStock(tx, { orderId: 'o1', companyId: 'c1', receivedQty: 3 });
    expect((tx as any).productionBatch.create).toHaveBeenCalled();
    const data = (tx as any).productionBatch.create.mock.calls[0][0].data;
    expect(data.quantityRemaining).toBe(3);
    expect(data.quantitySold).toBe(0);
  });

  it('returns them at the cost they left at', async () => {
    const tx = delivered();
    await restoreOrderStock(tx, { orderId: 'o1', companyId: 'c1', receivedQty: 2 });
    const data = (tx as any).productionBatch.create.mock.calls[0][0].data;
    expect(data.costPerUnit).toBe(4);
    expect(data.totalProductionCost).toBe(8);
  });

  it('restores only what was counted, never what was shipped', async () => {
    // Three went out, one came back sound. Two are gone.
    const tx = delivered();
    await restoreOrderStock(tx, { orderId: 'o1', companyId: 'c1', receivedQty: 1 });
    expect((tx as any).productionBatch.create.mock.calls[0][0].data.quantityRemaining).toBe(1);
    expect((tx as any).productionBatch.create).toHaveBeenCalledTimes(1);
  });

  it('does nothing when nothing came back sound', async () => {
    const tx = delivered();
    const res = await restoreOrderStock(tx, { orderId: 'o1', companyId: 'c1', receivedQty: 0 });
    expect(res.restored).toBe(0);
    expect((tx as any).productionBatch.create).not.toHaveBeenCalled();
  });

  it('refuses to restore the same return twice', async () => {
    const tx = makeTx({
      inventoryMovement: { findFirst: vi.fn().mockResolvedValue({ id: 'm1' }), create: vi.fn() },
    });
    const res = await restoreOrderStock(tx, { orderId: 'o1', companyId: 'c1', receivedQty: 3 });
    expect(res.alreadyDone).toBe(true);
    expect((tx as any).productionBatch.create).not.toHaveBeenCalled();
  });
});

describe('a return of goods that never left the shelf', () => {
  /**
   * Consumption happens at DELIVERY, not at dispatch. An order refused at
   * the door never took its units out of a batch, so "restoring" them
   * creates stock that was never removed — a fresh batch of units the shelf
   * already holds. The figure climbs by a whole parcel each time.
   */
  const neverDelivered = () =>
    makeTx({ inventoryMovement: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() } });

  it('restores nothing, and says why', async () => {
    const tx = neverDelivered();
    const res = await restoreOrderStock(tx, { orderId: 'o1', companyId: 'c1', receivedQty: 3 });
    expect(res).toMatchObject({ restored: 0, neverConsumed: true });
    expect((tx as any).productionBatch.create).not.toHaveBeenCalled();
    expect((tx as any).inventoryMovement.create).not.toHaveBeenCalled();
  });

  it('is not the same answer as "already returned"', async () => {
    // Both restore nothing, and a caller that cannot tell them apart cannot
    // report either one honestly.
    const tx = neverDelivered();
    const res = await restoreOrderStock(tx, { orderId: 'o1', companyId: 'c1', receivedQty: 3 });
    expect(res.alreadyDone).toBe(false);
  });

  it('asks the LEDGER whether it left, never the order’s status', async () => {
    // A status can be rewritten by a later path; a movement row cannot.
    const tx = neverDelivered();
    await restoreOrderStock(tx, { orderId: 'o1', companyId: 'c1', receivedQty: 3 });
    const asked = (tx as any).inventoryMovement.findFirst.mock.calls.map((c: any) => c[0].where.type);
    expect(asked).toContain('SALE');
  });
});

/**
 * THE DAMAGED UNITS LEAVE THE SHELF; THEIR MONEY DOES NOT LEAVE THE PRODUCT.
 *
 * The owner ruled it: «إذا في توالف لازم تنقص من المخزون بس داخلة ضمن
 * التكلفة تبع المخزون للمنتج». Writing them off would be the ordinary
 * treatment and it is not what was asked — the cost stays on the product,
 * carried by whatever survived, so the price set from that cost is the one
 * that earns the money back.
 */
describe('absorbDamaged — the cost of what broke', () => {
  it('puts the whole parcel’s money onto the units that survived', () => {
    // Sixteen units at 2.00 went out; twelve came back sound, four broken.
    const r = absorbDamaged({ sound: 12, damaged: 4, costPerUnit: 2 });
    expect(r.quantity).toBe(12);
    expect(r.totalCost).toBe(32);
    expect(r.costPerUnit).toBe(2.67);
    expect(r.absorbed).toBe(8);
  });

  /**
   * THE INVARIANT. Absorption moves money between units; it never creates
   * or destroys any. A mutation that "spreads" the cost by inventing some
   * of it would pass every rate check and fail this.
   */
  it('and not one piastre more or less than went out', () => {
    for (const [sound, damaged, cost] of [[12, 4, 2], [1, 9, 3.5], [7, 0, 1.25], [100, 3, 0.99]] as const) {
      const r = absorbDamaged({ sound, damaged, costPerUnit: cost });
      expect(r.totalCost).toBeCloseTo(cost * (sound + damaged), 1);
    }
  });

  it('changes nothing at all when nothing broke', () => {
    const r = absorbDamaged({ sound: 12, damaged: 0, costPerUnit: 2 });
    expect(r.costPerUnit).toBe(2);
    expect(r.totalCost).toBe(24);
    expect(r.absorbed).toBe(0);
  });

  /**
   * AND WHEN EVERY UNIT BROKE THERE IS NOBODY TO CARRY IT.
   *
   * Returning a cost with no units to hold it would put money into a batch
   * of nothing, and the average cost of the product would divide by zero or
   * — worse — quietly land on a different batch. The loss is real here, and
   * the function says so by returning nothing rather than pretending.
   */
  it('carries nothing when no unit came back sound', () => {
    expect(absorbDamaged({ sound: 0, damaged: 6, costPerUnit: 2 })).toEqual({
      quantity: 0,
      totalCost: 0,
      costPerUnit: 0,
      absorbed: 0,
    });
  });

  it('returns the units even when what they cost was never recorded', () => {
    // Cost of goods is unrecorded on almost every order in this shop, so
    // this is the common case, not the edge: the units still go back.
    const r = absorbDamaged({ sound: 5, damaged: 2, costPerUnit: 0 });
    expect(r.quantity).toBe(5);
    expect(r.totalCost).toBe(0);
    expect(r.absorbed).toBe(0);
  });

  it('refuses nonsense instead of writing it into a batch', () => {
    expect(absorbDamaged({ sound: -3, damaged: 2, costPerUnit: 2 }).quantity).toBe(0);
    expect(absorbDamaged({ sound: 4, damaged: -2, costPerUnit: 2 }).totalCost).toBe(8);
    expect(absorbDamaged({ sound: 4, damaged: 1, costPerUnit: Number.NaN }).totalCost).toBe(0);
    expect(absorbDamaged({ sound: 4.9, damaged: 1.9, costPerUnit: 2 }).quantity).toBe(4);
  });
});

/**
 * AND THE COUNTING DESK ACTUALLY HANDS THE DAMAGE OVER.
 *
 * The rule can be perfect and reach nothing: `restoreOrderStock` takes the
 * damaged count as an OPTIONAL argument, so a caller that forgets it gets
 * the old write-off behaviour silently, with every test above still green.
 * This is the wire.
 */
describe('the returns desk passes the damaged count to the shelf', () => {
  it('hands both counts to restoreOrderStock', () => {
    const src = stripComments(repoFile('src/app/api/ops/returns/route.ts'));
    expect(src.length).toBeGreaterThan(200);
    expect(src).toMatch(/restoreOrderStock\(tx, \{[\s\S]{0,200}?damagedQty: input\.damagedQty/);
  });
});

/**
 * WHAT THE GOODS ACTUALLY COST, WRITTEN DOWN WHEN THEY LEAVE.
 *
 * `estimatedCostOfGoods` is stamped when the order is WRITTEN, from a
 * weighted average of whatever is on the shelf at that moment — and it is
 * ZERO whenever the product had no costed batch then, which is every
 * product imported before its first production run. Every margin in the
 * product is built on that figure.
 *
 * `product-cost.ts` already described the right one and nothing recorded
 * it: «the CONSUMED cost, recorded when the goods actually leave, taken
 * from the batches the draw-down emptied — oldest first. That is the
 * figure that belongs in a closed order's profit, because it is the money
 * that actually left.»
 */
describe('the cost of the goods that actually left', () => {
  it('is written on the order at delivery', async () => {
    const tx = makeTx();
    drawDownStock.mockResolvedValue({ taken: 3, short: 0, cost: 12.75 });
    const res = await consumeOrderStock(tx, { orderId: 'o1', companyId: 'c1' });

    // Two lines in the fixture, so two draw-downs.
    expect(res.cost).toBe(25.5);
    expect(on(tx, 'order', 'update')).toHaveBeenCalledWith({
      where: { id: 'o1' },
      data: { estimatedCostOfGoods: 25.5 },
    });
  });

  it('and is not written when nothing came out of a batch', async () => {
    // Negative stock allowed: the parcel went out, no batch was touched,
    // and no money left. Writing zero over the estimate would replace a
    // guess with a falsehood.
    const tx = makeTx();
    drawDownStock.mockResolvedValue({ taken: 0, short: 3, cost: 0 });
    const res = await consumeOrderStock(tx, { orderId: 'o1', companyId: 'c1' });

    expect(res.cost).toBe(0);
    expect(on(tx, 'order', 'update'), 'كتب صفراً فوق التقدير').not.toHaveBeenCalled();
  });

  it('and a second delivery of the same order writes nothing again', async () => {
    // Couriers retry and humans press twice. The ledger already says the
    // goods left, so there is no second cost to record.
    const tx = makeTx({ inventoryMovement: { findFirst: vi.fn().mockResolvedValue({ id: 'm1' }), create: vi.fn() } });
    const res = await consumeOrderStock(tx, { orderId: 'o1', companyId: 'c1' });

    expect(res.alreadyDone).toBe(true);
    expect(res.cost).toBe(0);
    expect(on(tx, 'order', 'update')).not.toHaveBeenCalled();
  });
});

describe('goods that left before the opening count', () => {
  /**
   * 143 imported orders were with the courier when the owner counted the
   * shelf («طلعت قبل الجرد»). Their units are not in the count: delivering
   * one takes nothing, and one that comes back is new to the shelf.
   */
  const imported = (reservedQty: number) => ({
    ...ORDER,
    source: 'Legacy import',
    items: ORDER.items.map((i) => ({ ...i, reservedQty })),
  });

  it('an imported order that never reserved takes nothing at delivery', async () => {
    const tx = makeTx({ order: { findFirst: vi.fn().mockResolvedValue(imported(0)), update: vi.fn() } });
    const res = await consumeOrderStock(tx, { orderId: 'o1', companyId: 'c1' });
    expect(res).toMatchObject({ taken: 0, short: 0, outsideTheCount: true });
    expect(drawDownStock).not.toHaveBeenCalled();
    expect(on(tx, 'inventoryMovement', 'create')).not.toHaveBeenCalled();
  });

  it('an imported order that IS reserved is an ordinary delivery — it consumes', async () => {
    // the 39 postponed imports, confirmed later, and the orders imported
    // after the count holding their reservation
    const tx = makeTx({ order: { findFirst: vi.fn().mockResolvedValue(imported(1)), update: vi.fn() } });
    drawDownStock.mockResolvedValue({ taken: 1, short: 0, cost: 4 });
    const res = await consumeOrderStock(tx, { orderId: 'o1', companyId: 'c1' });
    expect(res.outsideTheCount).toBeUndefined();
    expect(drawDownStock).toHaveBeenCalled();
  });

  it('an unreserved order that was NOT imported still consumes — the exception is the import only', async () => {
    const plain = { ...ORDER, source: 'Manual', items: ORDER.items.map((i) => ({ ...i, reservedQty: 0 })) };
    const tx = makeTx({ order: { findFirst: vi.fn().mockResolvedValue(plain), update: vi.fn() } });
    drawDownStock.mockResolvedValue({ taken: 1, short: 0, cost: 4 });
    await consumeOrderStock(tx, { orderId: 'o1', companyId: 'c1' });
    expect(drawDownStock).toHaveBeenCalled();
  });

  it('when one comes back, its units go onto the shelf although no SALE was written', async () => {
    const tx = makeTx({ order: { findFirst: vi.fn().mockResolvedValue(imported(0)), update: vi.fn() } });
    const res = await restoreOrderStock(tx, { orderId: 'o1', companyId: 'c1', receivedQty: 3 });
    expect(res.neverConsumed).toBeUndefined();
    expect(res.restored).toBeGreaterThan(0);
    expect(on(tx, 'productionBatch', 'create')).toHaveBeenCalled();
  });

  it('a reserved import that comes back undelivered restores NOTHING — its units never left the count', async () => {
    const tx = makeTx({ order: { findFirst: vi.fn().mockResolvedValue(imported(1)), update: vi.fn() } });
    const res = await restoreOrderStock(tx, { orderId: 'o1', companyId: 'c1', receivedQty: 3 });
    expect(res).toMatchObject({ restored: 0, neverConsumed: true });
    expect(on(tx, 'productionBatch', 'create')).not.toHaveBeenCalled();
  });
});

/**
 * P0-13 (30/10) — A DELIVERY IS A FACT, AND THE SHELF FOLLOWS IT.
 *
 * `consumeOrderStock` used to take the country's flag and throw «المخزون غير
 * كافٍ» on a short shelf; four doors passed it three different values. It
 * takes no flag now, so no door can pass a different one, and a short shelf
 * is reported and written as one review line — never a refusal, never money.
 */
describe('a delivery on a shelf that cannot cover it (P0-13)', () => {
  it('draws with the refusal OFF, whatever any door might have wanted', async () => {
    const tx = makeTx();
    await consumeOrderStock(tx, { orderId: 'o1', companyId: 'c1' });
    for (const call of drawDownStock.mock.calls) expect(call[1].allowNegative).toBe(true);
  });

  it('and no door can hand it a rule: the input has no such field', () => {
    const src = stripComments(repoFile('src/lib/stock-consumption.ts'));
    const sig = src.slice(src.indexOf('export async function consumeOrderStock('), src.indexOf('): Promise<ConsumptionResult>'));
    expect(sig).not.toMatch(/allowNegative/i);
  });

  it('says WHICH lines were short, with how many of each', async () => {
    const tx = makeTx();
    drawDownStock
      .mockResolvedValueOnce({ taken: 1, short: 2, cost: 4 }) // p1 needs 3 (2 paid + 1 gift)
      .mockResolvedValueOnce({ taken: 1, short: 0, cost: 4 }); // p2 needs 1, covered
    const res = await consumeOrderStock(tx, { orderId: 'o1', companyId: 'c1' });
    expect(res.shortLines).toEqual([{ productId: 'p1', productName: 'أ', need: 3, taken: 1, short: 2 }]);
    expect(res.short).toBe(2);
  });

  it('writes ONE review line on the order, in the same transaction, naming the units', async () => {
    const tx = makeTx();
    drawDownStock.mockResolvedValue({ taken: 0, short: 3, cost: 0 });
    await consumeOrderStock(tx, { orderId: 'o1', companyId: 'c1', userId: 'u9' });
    const create = on(tx, 'orderActivity', 'create');
    expect(create).toHaveBeenCalledTimes(1);
    const data = create.mock.calls[0][0].data;
    expect(data).toMatchObject({ companyId: 'c1', orderId: 'o1', userId: 'u9', action: 'STOCK_SHORT_AT_DELIVERY' });
    expect(JSON.parse(data.metadata)).toMatchObject({ order: 'SY-2026-0100', short: 6 });
  });

  /*
   * P0-13 REVIEW (money): a short order keeps its ESTIMATE. The cost of the units that did leave is a cost of PART of
   * the parcel; written over the estimate for the whole order it raised the profit by the missing units' cost on
   * goods that were all handed over (4 of 10 at 5 = 20 over an estimate of 50 → profit +30).
   */
  it('NEGATIVE: a PARTLY short order does not overwrite its estimated cost', async () => {
    const tx = makeTx();
    drawDownStock.mockResolvedValueOnce({ taken: 1, short: 2, cost: 4 }).mockResolvedValueOnce({ taken: 1, short: 0, cost: 4 });
    const res = await consumeOrderStock(tx, { orderId: 'o1', companyId: 'c1' });
    expect(res.taken).toBe(2);
    expect(on(tx, 'order', 'update'), 'كتب كلفةَ جزءٍ من الطرد فوق تقدير الطلب كلّه').not.toHaveBeenCalled();
  });

  it('NEGATIVE: a two-line order with one line EMPTY keeps its estimate too', async () => {
    const tx = makeTx();
    drawDownStock.mockResolvedValueOnce({ taken: 3, short: 0, cost: 12 }).mockResolvedValueOnce({ taken: 0, short: 1, cost: 0 });
    await consumeOrderStock(tx, { orderId: 'o1', companyId: 'c1' });
    expect(on(tx, 'order', 'update')).not.toHaveBeenCalled();
  });

  it('and with NOTHING short the cost is written as it always was (no change of behaviour)', async () => {
    const tx = makeTx();
    drawDownStock.mockResolvedValue({ taken: 3, short: 0, cost: 12.75 });
    const res = await consumeOrderStock(tx, { orderId: 'o1', companyId: 'c1' });
    expect(res.cost).toBe(25.5);
    expect(on(tx, 'order', 'update')).toHaveBeenCalledWith({ where: { id: 'o1' }, data: { estimatedCostOfGoods: 25.5 } });
  });

  it('a review line already on the order means it was consumed: no draw, no write', async () => {
    const tx = makeTx({ orderActivity: { create: vi.fn(), findFirst: vi.fn().mockResolvedValue({ id: 'a1' }) } });
    const res = await consumeOrderStock(tx, { orderId: 'o1', companyId: 'c1' });
    expect(res.alreadyDone).toBe(true);
    expect(drawDownStock).not.toHaveBeenCalled();
    expect(on(tx, 'order', 'update')).not.toHaveBeenCalled();
    expect((tx as any).orderActivity.findFirst.mock.calls[0][0].where).toEqual({ orderId: 'o1', companyId: 'c1', action: 'STOCK_SHORT_AT_DELIVERY' });
  });

  it('and NO money anywhere: no ledger line, no cost over the estimate, no wallet', async () => {
    const tx = makeTx();
    drawDownStock.mockResolvedValue({ taken: 0, short: 3, cost: 0 });
    await consumeOrderStock(tx, { orderId: 'o1', companyId: 'c1' });
    expect(on(tx, 'inventoryMovement', 'create')).not.toHaveBeenCalled();
    expect(on(tx, 'order', 'update')).not.toHaveBeenCalled();
  });

  it('and a shelf that covered everything leaves no review line and no shortLines key', async () => {
    const tx = makeTx();
    drawDownStock.mockResolvedValue({ taken: 3, short: 0, cost: 12 });
    const res = await consumeOrderStock(tx, { orderId: 'o1', companyId: 'c1' });
    expect(on(tx, 'orderActivity', 'create')).not.toHaveBeenCalled();
    expect(res).not.toHaveProperty('shortLines');
  });

  it('and an order that left before the opening count leaves no review line either', async () => {
    const imported = { ...ORDER, source: 'Legacy import', items: ORDER.items.map((i) => ({ ...i, reservedQty: 0 })) };
    const tx = makeTx({ order: { findFirst: vi.fn().mockResolvedValue(imported), update: vi.fn() } });
    await consumeOrderStock(tx, { orderId: 'o1', companyId: 'c1' });
    expect(on(tx, 'orderActivity', 'create')).not.toHaveBeenCalled();
  });
});
