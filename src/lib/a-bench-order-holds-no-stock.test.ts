import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ db: {} }));

import { availableStock, onHand, releaseOrderLines, reserveOrderLines } from './reservation';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A BENCH ORDER HOLDS NO STOCK (B2, 18/11 — `test-store.ts`).
 *
 * Confirmed and then going nowhere, a bench order that held units would hide
 * them from a real customer. These run the REAL reservation functions over a
 * small in-memory database that reads a `where` the way Prisma does for the
 * shapes these functions send — including the relation `order → store`, so a
 * bench filter that Prisma would apply is applied here too, and one it would
 * not see (a missing key) is not invented.
 *
 * Each bench case has its real-store twin: the shelf moves for a real order
 * exactly as it did before 18/11.
 * ═══════════════════════════════════════════════════════════════════════════
 */

type Row = Record<string, unknown>;

interface World {
  stores: { id: string; isTest: boolean }[];
  orders: { id: string; storeId: string; confirmationStatus: string; shippingStatus: string }[];
  items: Row[];
  addOns: Row[];
  batches: { companyId: string; productId: string; quantityRemaining: number }[];
}

/** One value against one condition — the operators these functions use, and nothing else (an unknown one throws). */
function fits(have: unknown, want: unknown): boolean {
  if (want === null || typeof want !== 'object') return have === want;
  const w = want as Row;
  return Object.entries(w).every(([op, v]) => {
    if (op === 'not') return have !== v;
    if (op === 'gt') return (have as number) > (v as number);
    if (op === 'in') return (v as unknown[]).includes(have);
    if (op === 'notIn') return !(v as unknown[]).includes(have);
    throw new Error(`the fake cannot read «${op}»`);
  });
}

function fakeTx(world: World) {
  const storeOf = (id: string) => world.stores.find((s) => s.id === id)!;
  const orderOf = (id: string) => world.orders.find((o) => o.id === id)!;

  /** A row of a line table against a `where`: its own columns, and the `order` relation down to the `store`. */
  const keeps = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([key, want]) => {
      if (key !== 'order') return fits(row[key], want);
      const order = orderOf(row.orderId as string) as unknown as Row;
      return Object.entries(want as Row).every(([k, w]) => {
        if (k !== 'store') return fits(order[k], w);
        const store = storeOf(order.storeId as string) as unknown as Row;
        return Object.entries(w as Row).every(([sk, sw]) => fits(store[sk], sw));
      });
    });

  const table = (rows: Row[]) => ({
    findMany: vi.fn(async ({ where }: { where: Row }) => rows.filter((r) => keeps(r, where)).map((r) => ({ ...r }))),
    aggregate: vi.fn(async ({ where }: { where: Row }) => ({
      _sum: { reservedQty: rows.filter((r) => keeps(r, where)).reduce((s, r) => s + (r.reservedQty as number), 0) },
    })),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = rows.find((r) => r.id === where.id)!;
      Object.assign(row, data);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const hit = rows.filter((r) => keeps(r, where));
      for (const r of hit) Object.assign(r, data);
      return { count: hit.length };
    }),
  });

  return {
    orderItem: table(world.items),
    orderAddOn: table(world.addOns),
    productionBatch: {
      aggregate: vi.fn(async ({ where }: { where: Row }) => ({
        _sum: {
          quantityRemaining: world.batches
            .filter((b) => b.companyId === where.companyId && b.productId === where.productId)
            .reduce((s, b) => s + b.quantityRemaining, 0),
        },
      })),
    },
    // The advisory lock: a statement that changes no row.
    $executeRaw: vi.fn(async () => 0),
  };
}

/** Two stores in one company, one shelf: 10 units of P1 and 2 of P2. */
function world(): World {
  return {
    stores: [
      { id: 'real', isTest: false },
      { id: 'bench', isTest: true },
    ],
    orders: [
      { id: 'o-real', storeId: 'real', confirmationStatus: 'CONFIRMED', shippingStatus: 'NOT_READY' },
      { id: 'o-bench', storeId: 'bench', confirmationStatus: 'CONFIRMED', shippingStatus: 'NOT_READY' },
      { id: 'o-other', storeId: 'real', confirmationStatus: 'CONFIRMED', shippingStatus: 'NOT_READY' },
    ],
    items: [
      { id: 'i-real', orderId: 'o-real', companyId: 'c1', productId: 'P1', productName: 'أ', quantity: 3, freeQuantity: 1, reservedQty: 0 },
      { id: 'i-bench', orderId: 'o-bench', companyId: 'c1', productId: 'P1', productName: 'أ', quantity: 3, freeQuantity: 1, reservedQty: 0 },
      { id: 'i-bench2', orderId: 'o-bench', companyId: 'c1', productId: 'P2', productName: 'ب', quantity: 5, freeQuantity: 0, reservedQty: 0 },
    ],
    addOns: [
      { id: 'a-real', orderId: 'o-real', companyId: 'c1', productId: 'P1', productName: 'أ', quantity: 1, reservedQty: 0 },
      { id: 'a-bench', orderId: 'o-bench', companyId: 'c1', productId: 'P1', productName: 'أ', quantity: 1, reservedQty: 0 },
    ],
    batches: [
      { companyId: 'c1', productId: 'P1', quantityRemaining: 10 },
      { companyId: 'c1', productId: 'P2', quantityRemaining: 2 },
    ],
  };
}

/** What a third order of the real store could still take, and what is physically there — the shelf as anyone sees it. */
async function shelf(tx: ReturnType<typeof fakeTx>) {
  const t = tx as never;
  return {
    P1: { free: await availableStock(t, 'c1', 'P1', 'o-other'), onHand: await onHand(t, 'c1', 'P1') },
    P2: { free: await availableStock(t, 'c1', 'P2', 'o-other'), onHand: await onHand(t, 'c1', 'P2') },
  };
}

const reservedOf = (w: World, orderId: string) =>
  [...w.items, ...w.addOns].filter((r) => r.orderId === orderId).map((r) => r.reservedQty);

describe('confirming a bench order', () => {
  it('reserves nothing: the shelf and every reserved count are the same before and after', async () => {
    const w = world();
    const tx = fakeTx(w);
    const before = await shelf(tx);

    const outcome = await reserveOrderLines(tx as never, 'o-bench', { allowNegativeStock: false });

    expect(outcome).toEqual({ reserved: 0, shortages: [] });
    expect(reservedOf(w, 'o-bench')).toEqual([0, 0, 0]);
    expect(await shelf(tx)).toEqual(before);
    expect(tx.orderItem.update).not.toHaveBeenCalled();
    expect(tx.orderAddOn.update).not.toHaveBeenCalled();
  });

  it('takes no stock lock and reports no shortage, even for a product the shelf cannot cover', async () => {
    const w = world();
    const tx = fakeTx(w);
    // P2: 5 wanted, 2 on the shelf — a real order would be told it is short.
    const outcome = await reserveOrderLines(tx as never, 'o-bench', { allowNegativeStock: true });
    expect(outcome.shortages).toEqual([]);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('asks the lines through the order’s store, never by the order id alone', async () => {
    const tx = fakeTx(world());
    await reserveOrderLines(tx as never, 'o-bench', { allowNegativeStock: false });
    expect(tx.orderItem.findMany.mock.calls[0][0].where).toEqual({ orderId: 'o-bench', order: { store: { isTest: false } } });
    expect(tx.orderAddOn.findMany.mock.calls[0][0].where).toEqual({ orderId: 'o-bench', order: { store: { isTest: false } } });
  });

  it('an edit that asks again (a line added, a quantity raised) still reserves nothing', async () => {
    const w = world();
    const tx = fakeTx(w);
    await reserveOrderLines(tx as never, 'o-bench', { allowNegativeStock: false });
    (w.items.find((i) => i.id === 'i-bench')!).quantity = 6;
    const again = await reserveOrderLines(tx as never, 'o-bench', { allowNegativeStock: false });
    expect(again).toEqual({ reserved: 0, shortages: [] });
    expect(reservedOf(w, 'o-bench')).toEqual([0, 0, 0]);
  });
});

describe('cancelling or postponing a bench order', () => {
  it('releases nothing it never took', async () => {
    const w = world();
    const tx = fakeTx(w);
    await reserveOrderLines(tx as never, 'o-bench', { allowNegativeStock: false });
    const before = await shelf(tx);
    expect(await releaseOrderLines(tx as never, 'o-bench')).toBe(0);
    expect(await shelf(tx)).toEqual(before);
  });

  it('HISTORY: one confirmed before its store became a bench gives back exactly what it held', async () => {
    const w = world();
    (w.items.find((i) => i.id === 'i-bench')!).reservedQty = 4;
    const tx = fakeTx(w);
    const held = await shelf(tx);
    expect(await releaseOrderLines(tx as never, 'o-bench')).toBe(1);
    expect((await shelf(tx)).P1.free).toBe(held.P1.free + 4);
  });
});

describe('NEGATIVE: a real store’s order, exactly as before 18/11', () => {
  it('reserves every line and add-on in full, gift units included, and the shelf drops by them', async () => {
    const w = world();
    const tx = fakeTx(w);
    const before = await shelf(tx);

    const outcome = await reserveOrderLines(tx as never, 'o-real', { allowNegativeStock: false });

    expect(outcome).toEqual({ reserved: 2, shortages: [] });
    expect(reservedOf(w, 'o-real')).toEqual([4, 1]);
    expect((await shelf(tx)).P1.free).toBe(before.P1.free - 5);
    expect((await shelf(tx)).P1.onHand).toBe(before.P1.onHand);
  });

  it('a short line stays unreserved and is reported, as before', async () => {
    const w = world();
    w.batches[0].quantityRemaining = 3;
    const tx = fakeTx(w);
    const outcome = await reserveOrderLines(tx as never, 'o-real', { allowNegativeStock: false });
    // 3 on the shelf: the line wants 4 and stays unreserved; the add-on wants 1 and takes it.
    expect(outcome.shortages.map((s) => [s.orderItemId, s.missing])).toEqual([['i-real', 1]]);
    expect(reservedOf(w, 'o-real')).toEqual([0, 1]);
  });

  it('and its release gives the units back', async () => {
    const w = world();
    const tx = fakeTx(w);
    const before = await shelf(tx);
    await reserveOrderLines(tx as never, 'o-real', { allowNegativeStock: false });
    expect(await releaseOrderLines(tx as never, 'o-real')).toBe(2);
    expect(await shelf(tx)).toEqual(before);
  });

  it('a bench order beside it never takes what the real one needs', async () => {
    const w = world();
    w.batches[0].quantityRemaining = 5;
    const tx = fakeTx(w);
    await reserveOrderLines(tx as never, 'o-bench', { allowNegativeStock: false });
    const outcome = await reserveOrderLines(tx as never, 'o-real', { allowNegativeStock: false });
    expect(outcome.shortages, 'طلب المنصّة أخذ من رف الطلب الحقيقي').toEqual([]);
    expect(reservedOf(w, 'o-real')).toEqual([4, 1]);
  });
});
