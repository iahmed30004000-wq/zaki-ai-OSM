import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «الأب سيل والكروس سيل بينحفظوا بالطلب وبالسعر، والمخزون ح يتأثر، والقيمة المطلوبة».
 *
 * An add-on (the offer accepted after the order, a recommended product) was money on the order — the collected amount,
 * the waybill and the settlement all carried it — and nothing on the shelf: never reserved, never drawn down, never
 * counted back. Here it moves stock exactly like a line, through the same three doors.
 */

const drawDownStock = vi.fn();
vi.mock('./db', () => ({ db: {} }));
vi.mock('./receiving', () => ({
  drawDownStock: (...a: unknown[]) => drawDownStock(...a),
  onHandTotal: async () => 0,
}));

import { orderLinesForGuard, releaseOrderLines, reservedElsewhere, reserveOrderLines } from './reservation';
import { consumeOrderStock, restoreOrderStock } from './stock-consumption';

/** A mock's calls, readable without a typed signature. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const callsOf = (m: { mock: { calls: unknown[] } }) => m.mock.calls as any[][];

beforeEach(() => {
  vi.clearAllMocks();
  drawDownStock.mockResolvedValue({ taken: 0, short: 0, cost: 0 });
});

/** A transaction client holding one order with `items` and `addOns`, and a shelf of `onHand`. */
function reservingTx(input: {
  items?: Record<string, unknown>[];
  addOns?: Record<string, unknown>[];
  onHand: number;
  elsewhereLines?: number;
  elsewhereAddOns?: number;
}) {
  return {
    $executeRaw: vi.fn(async () => 1),
    productionBatch: { aggregate: vi.fn(async () => ({ _sum: { quantityRemaining: input.onHand } })) },
    orderItem: {
      findMany: vi.fn(async () => input.items ?? []),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: (input.items ?? []).length })),
      aggregate: vi.fn(async () => ({ _sum: { reservedQty: input.elsewhereLines ?? 0 } })),
    },
    orderAddOn: {
      findMany: vi.fn(async () => input.addOns ?? []),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: (input.addOns ?? []).length })),
      aggregate: vi.fn(async () => ({ _sum: { reservedQty: input.elsewhereAddOns ?? 0 } })),
    },
  };
}
const line = (over: Record<string, unknown> = {}) => ({
  id: 'i1', companyId: 'c1', productId: 'p1', productName: 'كريم', quantity: 1, freeQuantity: 0, reservedQty: 0, ...over,
});
const addOn = (over: Record<string, unknown> = {}) => ({
  id: 'a1', companyId: 'c1', productId: 'p1', productName: 'كريم', quantity: 1, reservedQty: 0, ...over,
});

describe('what other orders hold', () => {
  it('counts another order’s add-on reservation, beside its lines', async () => {
    const tx = reservingTx({ onHand: 10, elsewhereLines: 3, elsewhereAddOns: 2 });
    expect(await reservedElsewhere(tx as never, 'c1', 'p1', 'o1')).toBe(5);
    // The same filter on both: the same orders are «still holding stock» for a line and for an add-on.
    expect(callsOf(tx.orderAddOn.aggregate)[0][0].where).toEqual(callsOf(tx.orderItem.aggregate)[0][0].where);
  });
});

describe('reserving the order at confirmation', () => {
  it('reserves the accepted add-on with the lines', async () => {
    const tx = reservingTx({ items: [line()], addOns: [addOn({ productId: 'p2', productName: 'شامبو' })], onHand: 10 });
    const out = await reserveOrderLines(tx as never, 'o1', { allowNegativeStock: false });
    expect(out.shortages).toEqual([]);
    expect(tx.orderAddOn.update).toHaveBeenCalledWith({ where: { id: 'a1' }, data: { reservedQty: 1 } });
  });

  it('NEGATIVE: an add-on of the product the order ALSO buys does not take the units its own line just took', async () => {
    // 2 on the shelf; the line takes 2; the add-on of the same product finds none left.
    const tx = reservingTx({ items: [line({ quantity: 2 })], addOns: [addOn()], onHand: 2 });
    const out = await reserveOrderLines(tx as never, 'o1', { allowNegativeStock: false });
    expect(out.shortages).toEqual([{ orderItemId: 'a1', productId: 'p1', productName: 'كريم', missing: 1, addOn: true }]);
    expect(tx.orderAddOn.update).not.toHaveBeenCalled();
  });

  it('with negative stock allowed, reserves it anyway and still flags the shortage', async () => {
    const tx = reservingTx({ items: [], addOns: [addOn({ quantity: 3 })], onHand: 1 });
    const out = await reserveOrderLines(tx as never, 'o1', { allowNegativeStock: true });
    expect(out.shortages[0]).toMatchObject({ missing: 2, addOn: true });
    expect(tx.orderAddOn.update).toHaveBeenCalledWith({ where: { id: 'a1' }, data: { reservedQty: 3 } });
  });

  it('NEGATIVE: an add-on already covered is not reserved twice', async () => {
    const tx = reservingTx({ addOns: [addOn({ reservedQty: 1 })], onHand: 0 });
    await reserveOrderLines(tx as never, 'o1', { allowNegativeStock: false });
    expect(tx.orderAddOn.update).not.toHaveBeenCalled();
  });

  it('a cancelled order lets go of its add-ons too', async () => {
    const tx = reservingTx({ items: [line({ reservedQty: 1 })], addOns: [addOn({ reservedQty: 1 })], onHand: 5 });
    expect(await releaseOrderLines(tx as never, 'o1')).toBe(2);
    expect(tx.orderAddOn.updateMany).toHaveBeenCalledWith({ where: { orderId: 'o1', reservedQty: { gt: 0 } }, data: { reservedQty: 0 } });
  });

  it('an unreserved add-on holds the parcel back exactly like a line', async () => {
    const tx = reservingTx({ items: [line({ reservedQty: 1 })], addOns: [addOn({ quantity: 2, reservedQty: 0 })], onHand: 0 });
    tx.orderItem.findMany.mockResolvedValue([{ quantity: 1, freeQuantity: 0, reservedQty: 1 }] as never);
    tx.orderAddOn.findMany.mockResolvedValue([{ quantity: 2, reservedQty: 0 }] as never);
    expect(await orderLinesForGuard(tx as never, 'o1')).toEqual([
      { quantity: 1, freeQuantity: 0, reservedQty: 1 },
      { quantity: 2, freeQuantity: 0, reservedQty: 0, addOn: true },
    ]);
  });
});

/** A transaction client for delivery and return, holding one order. */
function shelfTx(order: Record<string, unknown>) {
  return {
    inventoryMovement: { findFirst: vi.fn(async (a: { where: { type: string } }) => (a.where.type === 'SALE' ? { id: 'sold' } : null)), create: vi.fn() },
    order: { findFirst: vi.fn(async () => order), update: vi.fn() },
    orderItem: { updateMany: vi.fn() },
    orderAddOn: { updateMany: vi.fn() },
    productionBatch: { findFirst: vi.fn(async () => ({ costPerUnit: 4 })), create: vi.fn(async () => ({ id: 'b-new' })) },
  };
}
const ORDER = {
  orderNumber: 'SY-0612',
  storeId: 's1',
  source: 'Landing Page',
  items: [{ productId: 'p1', productName: 'كريم', quantity: 1, freeQuantity: 0, reservedQty: 1 }],
  addOns: [{ productId: 'p2', productName: 'شامبو', quantity: 2 }],
  store: { country: { minorUnit: 2 } },
};

describe('delivering the order', () => {
  it('draws the add-on off the shelf with the lines, and its cost joins the order’s', async () => {
    const tx = shelfTx(ORDER);
    tx.inventoryMovement.findFirst.mockResolvedValue(null as never); // not consumed yet
    drawDownStock.mockImplementation(async (_tx: unknown, a: { productId: string; quantity: number }) => ({
      taken: a.quantity, short: 0, cost: a.productId === 'p2' ? 6 : 5,
    }));
    const out = await consumeOrderStock(tx as never, { orderId: 'o1', companyId: 'c1', allowNegativeStock: false });
    expect(drawDownStock.mock.calls.map((c) => [c[1].productId, c[1].quantity])).toEqual([['p1', 1], ['p2', 2]]);
    expect(out).toMatchObject({ taken: 3, cost: 11 });
    // The reservation has served its purpose — for the add-on too.
    expect(tx.orderAddOn.updateMany).toHaveBeenCalledWith({ where: { orderId: 'o1', reservedQty: { gt: 0 } }, data: { reservedQty: 0 } });
  });

  it('NEGATIVE: an order with no add-ons draws exactly its lines, as before', async () => {
    const tx = shelfTx({ ...ORDER, addOns: [] });
    tx.inventoryMovement.findFirst.mockResolvedValue(null as never);
    drawDownStock.mockResolvedValue({ taken: 1, short: 0, cost: 5 });
    await consumeOrderStock(tx as never, { orderId: 'o1', companyId: 'c1', allowNegativeStock: false });
    expect(drawDownStock).toHaveBeenCalledTimes(1);
  });
});

describe('a return counted back in', () => {
  it('puts the add-on’s units back on the shelf after the lines', async () => {
    const tx = shelfTx(ORDER);
    const out = await restoreOrderStock(tx as never, { orderId: 'o1', companyId: 'c1', receivedQty: 3 });
    expect(out.restored).toBe(3);
    expect(callsOf(tx.productionBatch.create).map((c) => [c[0].data.productId, c[0].data.quantityRemaining])).toEqual([['p1', 1], ['p2', 2]]);
  });

  it('NEGATIVE: never more back than was counted — 2 counted, the line gets 1 and the add-on 1', async () => {
    const tx = shelfTx(ORDER);
    await restoreOrderStock(tx as never, { orderId: 'o1', companyId: 'c1', receivedQty: 2 });
    expect(callsOf(tx.productionBatch.create).map((c) => [c[0].data.productId, c[0].data.quantityRemaining])).toEqual([['p1', 1], ['p2', 1]]);
  });
});
