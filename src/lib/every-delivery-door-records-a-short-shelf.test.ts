import { describe, expect, it } from 'vitest';
import { dashboardFiles, repoFile, stripComments } from './guard-source';

import { recordPartialDelivery } from './partial-delivery';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * P0-13 — A DELIVERY IS A FACT; EVERY DOOR RECORDS IT THE SAME WAY.
 *
 * The finding (LAUNCH_LINE P0-13): `drawDownStock` threw «المخزون غير كافٍ»
 * on an empty shelf, so marking an order DELIVERED failed — the order stayed
 * open though the parcel was in the customer's hands — and the doors that
 * mark it gave the rule three different values:
 *
 *   | the door                                  | before                         | now |
 *   |-------------------------------------------|--------------------------------|-----|
 *   | PATCH  /api/orders/[id]   (status DELIVERED) | the country's flag → throws   | records, says the shortage |
 *   | PATCH  /api/orders/[id]/shipping            | the country's flag → throws   | records, says the shortage |
 *   | POST   /api/ops/tracking/write-off          | the country's flag → throws   | records, says the shortage |
 *   | POST   /api/ops/tracking/deliver (door)     | `?? false` → throws           | records, says the shortage |
 *   | POST   /api/finance/statements/[id]         | `true` typed by hand → silent | records, says the shortage |
 *   | the parcel swap (parcel-swap.ts)            | `true` typed by hand → silent | records, says the shortage |
 *
 * The first four could REFUSE a delivery that had happened; the last two
 * recorded it and told nobody. They now do one thing: take what the shelf
 * holds (never below zero), write ONE review line on the order, write no
 * money. This file is the NEGATIVE test for each door — it goes red the day
 * a door passes its own rule again — and a run through the real chain.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const DOORS = [
  { door: 'PATCH /api/orders/[id]', file: 'src/app/api/orders/[id]/route.ts', calls: 'consumeOrderStock' },
  { door: 'PATCH /api/orders/[id]/shipping', file: 'src/app/api/orders/[id]/shipping/route.ts', calls: 'consumeOrderStock' },
  { door: 'POST /api/ops/tracking/write-off', file: 'src/app/api/ops/tracking/write-off/route.ts', calls: 'consumeOrderStock' },
  { door: 'POST /api/ops/tracking/deliver', file: 'src/app/api/ops/tracking/deliver/route.ts', calls: 'recordPartialDelivery' },
  { door: 'POST /api/finance/statements/[id]', file: 'src/app/api/finance/statements/[id]/route.ts', calls: 'consumeOrderStock' },
  { door: 'the parcel swap', file: 'src/lib/parcel-swap.ts', calls: 'consumeOrderStock' },
  { door: 'recordPartialDelivery (lib)', file: 'src/lib/partial-delivery.ts', calls: 'consumeOrderStock' },
];

/** The argument object of the first `name(` call in the source — balanced braces, comments already gone. */
function argumentOf(src: string, name: string): string {
  const at = src.search(new RegExp(`\\b${name}\\(`));
  if (at < 0) return '';
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  return '';
}

describe('no door hands the shelf a rule of its own', () => {
  for (const d of DOORS) {
    it(`${d.door} passes no negative-stock rule`, () => {
      const src = stripComments(repoFile(d.file));
      const arg = argumentOf(src, d.calls);
      expect(arg, `${d.door}: لم أجد نداء ${d.calls}`).not.toBe('');
      expect(arg, `${d.door} يُمرّر قاعدةَ مخزونٍ خاصّةً به من جديد`).not.toMatch(/allowNegative/i);
    });
  }

  it('and the sweep sees EVERY caller of consumeOrderStock — a seventh door must be classified, not missed', () => {
    const callers = dashboardFiles('both')
      .filter((f) => /\bconsumeOrderStock\(/.test(stripComments(f.src)))
      .map((f) => f.rel.replace(/^\//, ''))
      .filter((rel) => rel !== 'src/lib/stock-consumption.ts')
      .sort();
    const known = DOORS.filter((d) => d.calls === 'consumeOrderStock').map((d) => d.file).sort();
    expect(callers).toEqual(known);
  });

  it('and the door-side delivery no longer defaults a missing rule to «refuse»', () => {
    const src = stripComments(repoFile('src/lib/partial-delivery.ts'));
    expect(src).not.toMatch(/allowNegativeStock/);
  });

  it('and the consumer’s own signature has no such field to receive', () => {
    const src = stripComments(repoFile('src/lib/stock-consumption.ts'));
    const sig = src.slice(src.indexOf('export async function consumeOrderStock('), src.indexOf('): Promise<ConsumptionResult>'));
    expect(sig).not.toMatch(/allowNegative/i);
  });

  it('and the shelf draw is told to take what it has, in the one place that decides it', () => {
    const src = stripComments(repoFile('src/lib/stock-consumption.ts'));
    expect(src).toMatch(/allowNegative: true,/);
  });
});

/**
 * THE REAL CHAIN, FOR THE DOOR-SIDE DELIVERY: recordPartialDelivery → consumeOrderStock → drawDownStock, none
 * mocked, against a transaction that applies the `where` and mutates the rows. Ten ordered, four on the shelf.
 */
describe('the door-side delivery on a shelf that holds 4 of 10', () => {
  type Row = Record<string, any>;
  function world(shelfQty: number) {
    const batches: Row[] = shelfQty > 0 ? [{ id: 'b1', companyId: 'c1', storeId: 's1', productId: 'p1', quantityRemaining: shelfQty, quantitySold: 0, costPerUnit: 5, productionDate: new Date('2026-01-01'), createdAt: new Date('2026-01-01') }] : [];
    const movements: Row[] = [];
    const activities: Row[] = [];
    const orderWrites: Row[] = [];
    const orderRow = {
      id: 'o1', orderNumber: 'ORD-1', shippingStatus: 'OUT_FOR_DELIVERY', deliveryFee: 0, priceIncludesDelivery: false,
      deliveredAt: null, returnedAt: null, customerId: 'cu1', deliveryProviderId: 'dp1',
      items: [{ id: 'i1', productId: 'p1', productName: 'كريم', quantity: 10, freeQuantity: 0, unitPrice: 10, discountShare: 0 }],
    };
    const consumeRow = {
      orderNumber: 'ORD-1', storeId: 's1', source: 'Manual',
      items: [{ productId: 'p1', productName: 'كريم', quantity: 10, freeQuantity: 0, reservedQty: 10 }],
      addOns: [], store: { country: { minorUnit: 2 } },
    };
    const tx = {
      order: {
        // the door reads the order with `deliveryFee`; the consumer reads it with `storeId` — one fake answers both.
        findFirst: async (args: Row) => (args?.select?.deliveryFee ? orderRow : consumeRow),
        update: async ({ data }: Row) => (orderWrites.push(data), {}),
      },
      orderItem: { update: async () => ({}), updateMany: async () => ({ count: 0 }) },
      orderAddOn: { aggregate: async () => ({ _sum: { reservedQty: 0 } }), findMany: async () => [], update: async () => ({}), updateMany: async () => ({ count: 0 }) },
      orderActivity: {
        create: async ({ data }: Row) => (activities.push(data), data),
        findFirst: async ({ where }: Row) => activities.find((a) => a.orderId === where.orderId && a.action === where.action) ?? null,
      },
      orderNote: { create: async () => ({}) },
      customer: { update: async () => ({}) },
      deliveryAttempt: { create: async () => ({ id: 'a1' }), count: async () => 0, findFirst: async () => null, aggregate: async () => ({ _max: { attemptNumber: 0 } }) },
      inventoryMovement: {
        findFirst: async ({ where }: Row) => movements.find((m) => m.referenceId === where.referenceId && m.type === where.type) ?? null,
        create: async ({ data }: Row) => (movements.push(data), data),
      },
      productionBatch: {
        findMany: async ({ where }: Row) => batches.filter((b) => b.companyId === where.companyId && b.productId === where.productId && b.quantityRemaining > 0 && (!where.storeId || b.storeId === where.storeId)).map((b) => ({ ...b })),
        update: async ({ where, data }: Row) => Object.assign(batches.find((b) => b.id === where.id)!, data),
        aggregate: async () => ({ _sum: { quantityRemaining: batches.reduce((s, b) => s + b.quantityRemaining, 0) } }),
      },
    };
    return { tx, batches, movements, activities, orderWrites };
  }

  const door = (w: ReturnType<typeof world>) =>
    recordPartialDelivery(w.tx as never, {
      companyId: 'c1', storeId: 's1', orderId: 'o1', minorUnit: 2, userId: 'u1',
      lines: [{ itemId: 'i1', deliveredQty: 10 }],
    });

  it('is RECORDED — it used to throw «المخزون غير كافٍ» and leave the parcel open', async () => {
    const w = world(4);
    const out = await door(w);
    expect(out.status).toBe('DELIVERED');
    expect(w.orderWrites.some((d) => d.shippingStatus === 'DELIVERED')).toBe(true);
  });

  it('takes the 4 it HAS, never below zero, with one ledger line for 4', async () => {
    const w = world(4);
    await door(w);
    expect(w.batches[0].quantityRemaining).toBe(0);
    expect(w.batches[0].quantitySold).toBe(4);
    expect(w.movements).toHaveLength(1);
    expect(w.movements[0]).toMatchObject({ type: 'SALE', quantity: -4, balanceAfter: 0, storeId: 's1' });
  });

  it('says the other 6 on the order, once — and writes no money for them', async () => {
    const w = world(4);
    await door(w);
    const said = w.activities.filter((a) => a.action === 'STOCK_SHORT_AT_DELIVERY');
    expect(said).toHaveLength(1);
    expect(JSON.parse(said[0].metadata)).toMatchObject({ short: 6, lines: [{ productId: 'p1', need: 10, taken: 4, short: 6 }] });
    // a short order keeps its ESTIMATE: 4 × 5 = 20 written over an estimate for all 10 would raise the profit
    expect(w.orderWrites.filter((d) => d.estimatedCostOfGoods !== undefined)).toEqual([]);
  });

  it('and a second press AFTER new stock arrived takes none of it — an empty-shelf delivery wrote no SALE, its review line is the key', async () => {
    const w = world(0);
    await door(w);
    w.batches.push({ id: 'b-new', companyId: 'c1', storeId: 's1', productId: 'p1', quantityRemaining: 10, quantitySold: 0, costPerUnit: 5, productionDate: new Date('2026-02-01'), createdAt: new Date('2026-02-01') });
    const { consumeOrderStock } = await import('./stock-consumption');
    const again = await consumeOrderStock(w.tx as never, { orderId: 'o1', companyId: 'c1', userId: 'u1' });
    expect(again.alreadyDone).toBe(true);
    expect(w.batches.find((b) => b.id === 'b-new')!.quantityRemaining).toBe(10);
    expect(w.movements).toHaveLength(0);
  });

  it('an EMPTY shelf is recorded too: no ledger line, no cost, one review line', async () => {
    const w = world(0);
    const out = await door(w);
    expect(out.status).toBe('DELIVERED');
    expect(w.movements).toHaveLength(0);
    expect(w.orderWrites.some((d) => d.estimatedCostOfGoods !== undefined)).toBe(false);
    expect(w.activities.filter((a) => a.action === 'STOCK_SHORT_AT_DELIVERY')).toHaveLength(1);
  });

  it('and a shelf that covers it leaves no review line', async () => {
    const w = world(10);
    await door(w);
    expect(w.activities.filter((a) => a.action === 'STOCK_SHORT_AT_DELIVERY')).toHaveLength(0);
    expect(w.batches[0].quantityRemaining).toBe(0);
  });
});
