import { describe, expect, it } from 'vitest';
import { COUNT_MATCHES_AR, differenceWaitsAr, expectedInWarehouse, quickCountVerdict } from './warehouse-count';
import { repoFile, stripComments } from './guard-source';

/**
 * THE QUICK COUNT OF ONE WAREHOUSE — what a person standing in it should find (the warehouse plan, W2b; the owner's
 * decision 4, 20/11): the count is what is PHYSICALLY there.
 *
 *   expected = Σ remaining of the product's rows in that warehouse (never the road, never another store)
 *            − units of this store's orders that LEFT that warehouse with the courier (a waybill exists, or past it) and are
 *              still held (not delivered, not received back, not cancelled)
 *
 * A confirmed order still on the shelf (no waybill) is COUNTED: its units are in the rows and nothing takes them off.
 * The database below applies the `where` it is handed, nested relations included; the figures expected are written here
 * by hand from the rows, never through the function under test.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- an in-memory row; every field is read by name
type Row = Record<string, any>;

function scalar(v: unknown, c: unknown): boolean {
  if (c === null) return v === null || v === undefined;
  if (c && typeof c === 'object' && !Array.isArray(c) && !(c instanceof Date)) {
    const o = c as Row;
    if ('in' in o && !(o.in as unknown[]).includes(v)) return false;
    if ('notIn' in o && (o.notIn as unknown[]).includes(v)) return false;
    if ('not' in o && (o.not === null ? v === null || v === undefined : v === o.not)) return false;
    if ('gt' in o && !((v as number) > o.gt)) return false;
    return true;
  }
  return v === c;
}

function fakeDb(data: Record<string, Row[]>) {
  const matches = (r: Row, w: Row = {}): boolean =>
    Object.entries(w).every(([k, c]) => {
      if (c === undefined) return true;
      if (k === 'OR') return (c as Row[]).some((x) => matches(r, x));
      if (k === 'AND') return (c as Row[]).every((x) => matches(r, x));
      if (k === 'order') {
        const o = data.order.find((x) => x.id === r.orderId);
        return !!o && matches(o, c as Row);
      }
      return scalar(r[k], c);
    });
  const t = (name: string) => ({
    aggregate: async ({ where, _sum }: Row) => {
      const hit = (data[name] ?? []).filter((x) => matches(x, where));
      return { _sum: Object.fromEntries(Object.keys(_sum).map((k) => [k, hit.length ? hit.reduce((s, r) => s + r[k], 0) : null])) };
    },
  });
  return { productionBatch: t('productionBatch'), orderItem: t('orderItem'), orderAddOn: t('orderAddOn') } as never;
}

const C = 'c1';
const S = 's1';
const P = 'p1';
const W = 'w1';

const batch = (remaining: number, extra: Row = {}): Row => ({ companyId: C, storeId: S, productId: P, warehouseId: W, inTransitTransferId: null, quantityRemaining: remaining, ...extra });
let n = 0;
function order(state: Row, units: number, extra: { addOn?: number; productId?: string } = {}) {
  const id = `o${++n}`;
  const o = { id, companyId: C, storeId: S, sourceWarehouseId: W, confirmationStatus: 'CONFIRMED', shippingStatus: 'PENDING', shippedAt: null, labelPrintedAt: null, ...state };
  const items = [{ orderId: id, companyId: C, productId: extra.productId ?? P, reservedQty: units }];
  const addOns = extra.addOn ? [{ orderId: id, companyId: C, productId: P, reservedQty: extra.addOn }] : [];
  return { o, items, addOns };
}

function world(batches: Row[], orders: ReturnType<typeof order>[]) {
  return fakeDb({
    productionBatch: batches,
    order: orders.map((x) => x.o),
    orderItem: orders.flatMap((x) => x.items),
    orderAddOn: orders.flatMap((x) => x.addOns),
  });
}

const ask = (db: never) => expectedInWarehouse(db, { companyId: C, storeId: S, productId: P, warehouseId: W });

describe('what a person standing in the warehouse should find', () => {
  it('a confirmed order still on the shelf (no waybill) IS counted; a parcel that left with the courier is NOT', async () => {
    const onShelf = order({}, 3);
    const labelled = order({ labelPrintedAt: new Date('2026-11-01') }, 2);
    const pickup = order({ shippingStatus: 'READY_FOR_PICKUP' }, 1, { addOn: 1 });
    const shipped = order({ shippingStatus: 'SHIPPED', shippedAt: new Date('2026-11-02') }, 4);
    const back = order({ shippingStatus: 'RETURNED', shippedAt: new Date('2026-11-02') }, 5);
    const facts = await ask(world([batch(20), batch(7)], [onShelf, labelled, pickup, shipped, back]));
    // 27 on the book; with the courier: 2 (waybill) + 1 + 1 add-on (pickup shelf) + 4 (shipped) + 5 (returned, not yet received).
    expect(facts).toEqual({ book: 27, withCourier: 13, expected: 14 });
  });

  it('a delivered, cancelled, rejected or received-back order holds nothing any more — nothing is taken off for it', async () => {
    const delivered = order({ shippingStatus: 'DELIVERED', shippedAt: new Date() }, 4);
    const cancelled = order({ shippingStatus: 'CANCELLED', labelPrintedAt: new Date() }, 4);
    const rejected = order({ confirmationStatus: 'REJECTED', labelPrintedAt: new Date() }, 4);
    const received = order({ shippingStatus: 'RETURNED', shippedAt: new Date() }, 0); // the desk released it: reservedQty 0
    expect(await ask(world([batch(10)], [delivered, cancelled, rejected, received]))).toEqual({ book: 10, withCourier: 0, expected: 10 });
  });

  it('only THIS warehouse, THIS store, THIS product, and never the road', async () => {
    const elsewhere = order({ sourceWarehouseId: 'w2', shippedAt: new Date(), shippingStatus: 'SHIPPED' }, 6);
    const legacy = order({ sourceWarehouseId: null, shippedAt: new Date(), shippingStatus: 'SHIPPED' }, 6);
    const otherStore = order({ storeId: 's2', shippedAt: new Date(), shippingStatus: 'SHIPPED' }, 6);
    const otherProduct = order({ shippedAt: new Date(), shippingStatus: 'SHIPPED' }, 6, { productId: 'p2' });
    const facts = await ask(
      world(
        [
          batch(9),
          batch(5, { warehouseId: 'w2' }),
          batch(5, { warehouseId: null }),
          batch(5, { warehouseId: null, inTransitTransferId: 't1' }),
          batch(5, { storeId: 's2' }),
          batch(5, { productId: 'p2' }),
          batch(5, { companyId: 'c2' }),
        ],
        [elsewhere, legacy, otherStore, otherProduct]
      )
    );
    expect(facts).toEqual({ book: 9, withCourier: 0, expected: 9 });
  });

  it('an empty warehouse with parcels still out reads below zero — the shelf owes them; the number is not hidden', async () => {
    const shipped = order({ shippingStatus: 'OUT_FOR_DELIVERY', shippedAt: new Date() }, 3);
    expect(await ask(world([], [shipped]))).toEqual({ book: 0, withCourier: 3, expected: -3 });
  });
});

describe('the verdict and its sentences', () => {
  it('a match is a match; any difference is said with its sign', () => {
    const facts = { book: 10, withCourier: 2, expected: 8 };
    expect(quickCountVerdict(8, facts)).toEqual({ difference: 0, matches: true });
    expect(quickCountVerdict(5, facts)).toEqual({ difference: -3, matches: false });
    expect(quickCountVerdict(9, facts)).toEqual({ difference: 1, matches: false });
  });

  it('the sentences are Arabic, name the warehouse, and say that nothing was written', () => {
    expect(differenceWaitsAr('مخزن 1', 5, -3)).toMatch(/^بمخزن «مخزن 1» انعدّ 5 وطلع نقص 3 عن الدفتر\./);
    expect(differenceWaitsAr('مخزن 1', 9, 1)).toMatch(/زيادة 1/);
    expect(differenceWaitsAr('مخزن 1', 9, 1)).toMatch(/ما انكتب على المخزون شي/);
    expect(differenceWaitsAr('مخزن 1', 9, 1)).toMatch(/اعتماد شخص تاني/);
    expect(COUNT_MATCHES_AR('مخزن 1')).toBe('الجرد مطابق بمخزن «مخزن 1» — ما انكتب شي.');
    for (const s of [differenceWaitsAr('x', 1, 1), COUNT_MATCHES_AR('x')]) expect(s.replace(/«[^»]*»/g, '')).not.toMatch(/[A-Za-z]/);
  });
});

describe('the module writes nothing and touches no money', () => {
  const src = stripComments(repoFile('src/lib/warehouse-count.ts'));
  it('pure reads: no create, update, delete or raw write', () => {
    expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw/);
  });
  it('imports nothing from wallets, expenses, profit or money', () => {
    const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports.filter((i) => /wallet|expense|profit|money|finance|commission/i.test(i))).toEqual([]);
  });
});
