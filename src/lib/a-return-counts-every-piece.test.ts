import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

/**
 * A RETURN COUNTS EVERY PIECE (27/11, «صلّح المرتجعات» — RV2666, RV2667, RV2671).
 *
 *   1. ADD-ONS. The receipt released and moved the LINES only: a returned add-on stayed reserved on the warehouse it left
 *      for ever, and never reached the one that received it.
 *   2. PARTIAL DELIVERY. The shelf walked the lines without `deliveredQty`, so it could put back the product the customer
 *      KEPT instead of the one he refused.
 *   3. COMBINATIONS (size, colour). A refused parcel's batches moved to the receiver while its combinations' counts stayed,
 *      and its broken and missing pieces were never taken off them.
 *
 * Nothing between the desk and the rows is mocked: the real `receiveReturn` (and, for the lost parcel, the real write-off
 * door) runs against a database in memory that applies the `where` it is handed and mutates its rows. Every total below is
 * summed here from those rows.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- an in-memory row; every field is read by name
type Row = Record<string, any>;
const S = vi.hoisted(() => ({
  data: {} as Record<string, Record<string, unknown>[]>,
  db: null as unknown,
  audit: [] as Record<string, unknown>[],
}));

vi.mock('@/lib/db', () => ({
  db: new Proxy(
    {},
    { get: (_t, prop) => (S.db as Record<string | symbol, unknown>)[prop] }
  ),
}));
vi.mock('@/lib/audit', () => ({ logAudit: async (e: Record<string, unknown>) => void S.audit.push(e) }));
vi.mock('@/lib/commission', () => ({ reverseForOrder: async () => 0 }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 2 } }),
}));
vi.mock('@/lib/authorization', () => ({ can: () => true, requirePermission: async () => ({}) }));

import { receiveReturn } from './return-receipt';
import { expectedBackTotal, settledLines } from './partial-delivery';
import { correctedLedger } from './old-stock-home';
import { POST as writeOff } from '@/app/api/ops/tracking/write-off/route';

/* ───────────── the database in memory ───────────── */

function scalar(v: unknown, c: unknown): boolean {
  if (c === null) return v === null || v === undefined;
  if (c && typeof c === 'object' && !Array.isArray(c) && !(c instanceof Date)) {
    const o = c as Row;
    if ('in' in o && !(o.in as unknown[]).includes(v)) return false;
    if ('notIn' in o && (o.notIn as unknown[]).includes(v)) return false;
    if ('not' in o && (o.not === null ? v === null || v === undefined : v === o.not)) return false;
    if ('gt' in o && !((v as number) > o.gt)) return false;
    if ('gte' in o && !((v as number) >= o.gte)) return false;
    return true;
  }
  return v === c;
}
const matches = (r: Row, w: Row = {}): boolean =>
  Object.entries(w).every(([k, c]) => (c === undefined ? true : k === 'OR' ? (c as Row[]).some((x) => matches(r, x)) : scalar(r[k], c)));

function makeDb(data: Record<string, Row[]>) {
  let seq = 0;
  const relation = (table: string, key: string, r: Row): Row | Row[] | null => {
    if (table === 'order' && key === 'items') return data.orderItem.filter((i) => i.orderId === r.id);
    if (table === 'order' && key === 'addOns') return data.orderAddOn.filter((i) => i.orderId === r.id);
    if (table === 'order' && key === 'store') return data.store.find((s) => s.id === r.storeId) ?? null;
    if (table === 'order' && key === 'returnReceipt') return data.returnReceipt.find((x) => x.orderId === r.id) ?? null;
    if (table === 'order' && key === 'deliveryProvider') return null;
    if (table === 'order' && key === 'replacedBy') return null;
    if (table === 'store' && key === 'country') return { minorUnit: 2 };
    if (table === 'store' && key === 'warehousePlacement') return data.warehousePlacement.find((p) => p.storeId === r.id) ?? null;
    throw new Error(`relation ${table}.${key}`);
  };
  const SUB: Record<string, string> = { items: 'orderItem', addOns: 'orderAddOn', store: 'store', country: 'country', returnReceipt: 'returnReceipt', warehousePlacement: 'warehousePlacement' };
  const project = (table: string, r: Row, select?: Row): Row => {
    if (!select) return { ...r };
    const out: Row = {};
    for (const [k, v] of Object.entries(select)) {
      if (v === true) out[k] = r[k];
      else if (v && typeof v === 'object') {
        const got = relation(table, k, r);
        out[k] = Array.isArray(got) ? got.map((g) => project(SUB[k], g, v.select)) : got ? project(SUB[k], got, v.select) : null;
      }
    }
    return out;
  };
  const sortBy = (rows: Row[], orderBy?: Row | Row[]) => {
    if (!orderBy) return rows;
    const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((o) => Object.entries(o));
    return [...rows].sort((a, b) => {
      for (const [k, dir] of keys) {
        const x = a[k] instanceof Date ? a[k].getTime() : a[k];
        const y = b[k] instanceof Date ? b[k].getTime() : b[k];
        if (x < y) return dir === 'desc' ? 1 : -1;
        if (x > y) return dir === 'desc' ? -1 : 1;
      }
      return 0;
    });
  };
  const apply = (r: Row, d: Row) => {
    for (const [k, v] of Object.entries(d)) {
      if (v && typeof v === 'object' && !(v instanceof Date) && 'increment' in v) r[k] = (r[k] ?? 0) + v.increment;
      else if (v && typeof v === 'object' && !(v instanceof Date) && 'decrement' in v) r[k] = (r[k] ?? 0) - v.decrement;
      else r[k] = v;
    }
  };
  // The database's own uniques the receipt can run into.
  const unique: Record<string, string> = { productionBatch: 'batchNumber', returnReceipt: 'orderId' };
  const table = (name: string) => {
    const rows = () => (data[name] ??= []);
    const found = (where: Row) => rows().find((x) => matches(x, where));
    return {
      findMany: async ({ where, select, orderBy }: Row = {}) => sortBy(rows().filter((r) => matches(r, where)), orderBy).map((r) => project(name, r, select)),
      findFirst: async ({ where, select, orderBy }: Row = {}) => {
        const r = sortBy(rows().filter((x) => matches(x, where)), orderBy)[0];
        return r ? project(name, r, select) : null;
      },
      findUnique: async ({ where, select }: Row) => {
        const r = found(where);
        return r ? project(name, r, select) : null;
      },
      findUniqueOrThrow: async ({ where }: Row) => ({ ...found(where)! }),
      create: async ({ data: d, select }: Row) => {
        const u = unique[name];
        if (u && rows().some((r) => r[u] === d[u])) {
          throw new Prisma.PrismaClientKnownRequestError(`Unique constraint failed on ${u}`, { code: 'P2002', clientVersion: 'test' });
        }
        const row: Row = { id: `${name}-${String(++seq).padStart(4, '0')}`, createdAt: new Date(Date.UTC(2026, 10, 27, 0, 0, seq)), ...d };
        rows().push(row);
        return project(name, row, select);
      },
      update: async ({ where, data: d }: Row) => {
        const r = found(where);
        if (!r) throw new Prisma.PrismaClientKnownRequestError('No record was found for an update.', { code: 'P2025', clientVersion: 'test' });
        apply(r, d);
        return { ...r };
      },
      updateMany: async ({ where, data: d }: Row) => {
        const hit = rows().filter((r) => matches(r, where));
        for (const r of hit) apply(r, d);
        return { count: hit.length };
      },
      aggregate: async ({ where, _sum }: Row) => {
        const hit = rows().filter((x) => matches(x, where));
        return { _sum: Object.fromEntries(Object.keys(_sum).map((k) => [k, hit.length ? hit.reduce((s, r) => s + r[k], 0) : null])) };
      },
    };
  };
  const tables: Row = {};
  const tx: Row = new Proxy(tables, {
    get(target, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      if (prop === '$executeRaw') return async () => 1;
      if (prop === '$queryRaw') {
        return async (_s: TemplateStringsArray, value: unknown) => (data.warehouse ?? []).filter((w) => w.id === value);
      }
      return (target[prop] ??= table(prop));
    },
  });
  const db = new Proxy(tables, {
    get(_t, prop) {
      if (prop === '$transaction') return async (fn: (t: Row) => unknown) => fn(tx);
      return (tx as Row)[prop as string];
    },
  });
  return db;
}

/* ───────────── a shop ───────────── */

const CREAM = 'pcream-000001';
const SOAP = 'psoap0-000001';
const SHIRT = 'pshirt-000001';
const WAREHOUSES = ['w1', 'w2', 'w3'];

const batch = (id: string, productId: string, warehouseId: string | null, qty: number, cost: number, extra: Row = {}): Row => ({
  id, companyId: 'c1', storeId: 's1', productId, batchNumber: `B-${id}`, warehouseId, inTransitTransferId: null, splitFromBatchId: null,
  quantityProduced: qty, quantityRemaining: qty, quantitySold: 0, quantityMovedIn: 0, quantityMovedOut: 0, costPerUnit: cost,
  productionDate: new Date(Date.UTC(2026, 9, 1)), createdAt: new Date(Date.UTC(2026, 9, 1)), status: 'COMPLETED', notes: null, ...extra,
});
const line = (id: string, productId: string, quantity: number, extra: Row = {}): Row => ({
  id, orderId: 'o1', companyId: 'c1', productId, productName: productId, quantity, freeQuantity: 0, reservedQty: quantity, deliveredQty: null,
  variantSummary: null, ...extra,
});
const addOn = (id: string, productId: string, quantity: number, extra: Row = {}): Row => ({
  id, orderId: 'o1', companyId: 'c1', productId, productName: productId, quantity, reservedQty: quantity, ...extra,
});

function shop(p: { placed?: boolean; batches?: Row[]; items?: Row[]; addOns?: Row[]; order?: Row; more?: Record<string, Row[]> }) {
  S.audit.length = 0;
  S.data = {
    store: [{ id: 's1', companyId: 'c1', countryId: 'k1' }],
    warehouse: WAREHOUSES.map((id) => ({ id, companyId: 'c1', countryId: 'k1', isActive: true, name: id })),
    warehousePlacement: p.placed ? [{ id: 'wp1', storeId: 's1', oldStockWarehouseId: null }] : [],
    stockCount: [],
    order: [
      {
        id: 'o1', companyId: 'c1', storeId: 's1', orderNumber: 'ORD-1', source: 'Manual', shippingStatus: 'RETURN_REQUESTED', status: 'SHIPPED',
        settlementStatus: 'PENDING_COLLECTION', regionId: null, deliveryProviderId: null, trackingNumber: null, totalAmount: 0, version: 1,
        sourceWarehouseId: p.placed ? 'w1' : null, ...p.order,
      },
    ],
    orderItem: p.items ?? [],
    orderAddOn: p.addOns ?? [],
    productionBatch: p.batches ?? [],
    inventoryMovement: [],
    orderActivity: [],
    returnReceipt: [],
    orderNote: [],
    orderItemVariant: [],
    productVariant: [],
    productVariantStock: [],
    variantStockMovement: [],
    productFixedCost: [],
    ...p.more,
  } as Record<string, Row[]>;
  S.db = makeDb(S.data as Record<string, Row[]>);
}

const t = (name: string) => S.data[name] as Row[];
const sum = (rows: Row[], key: string) => rows.reduce((s, r) => s + r[key], 0);
/** Units on a warehouse's shelf (null = «بلا مكان»). */
const shelf = (productId: string, warehouseId?: string | null) =>
  sum(t('productionBatch').filter((b) => b.productId === productId && (warehouseId === undefined || b.warehouseId === warehouseId)), 'quantityRemaining');
/** Units this order still holds of a product. */
const held = (productId: string) =>
  sum([...t('orderItem'), ...t('orderAddOn')].filter((r) => r.productId === productId), 'reservedQty');
const moves = () => t('inventoryMovement').map((m) => [m.type, m.productId, m.quantity]);
/** The delivery already wrote its SALE: the parcel was consumed. */
const consumed = () => ({ inventoryMovement: [{ id: 'sale', companyId: 'c1', referenceId: 'o1', type: 'SALE', quantity: -1, productId: CREAM }] });
const returned = () => moves().filter(([type]) => type === 'RETURN');

const receive = (receivedQty: number | 'WHOLE', damagedQty = 0, extra: Row = {}) =>
  receiveReturn(
    { user: { id: 'u1' }, companyId: 'c1', storeId: 's1', minorUnit: 2 },
    { orderId: 'o1', receivedQty, damagedQty, chargeCourierFee: false, ...extra },
    receivedQty === 'WHOLE' ? { bulk: true } : {}
  );

/** Everything a receipt can move, as one string — «nothing moved twice» is this not changing. */
const picture = () =>
  JSON.stringify([
    t('productionBatch'), t('inventoryMovement'), t('orderItem'), t('orderAddOn'), t('productVariant'), t('productVariantStock'),
    t('variantStockMovement'), t('returnReceipt'),
  ]);

beforeEach(() => {
  S.audit.length = 0;
});

/* ───────────── the count the desk expects ───────────── */

describe('what is expected back', () => {
  const items = [{ id: 'i1', quantity: 2, freeQuantity: 1, deliveredQty: null }];
  const addOns = [{ id: 'a1', productName: 'صابون', quantity: 2 }];

  it('a refused or announced return owes the lines AND the add-ons', () => {
    expect(expectedBackTotal(items, addOns)).toBe(5);
    expect(expectedBackTotal([{ ...items[0], deliveredQty: 0 }], addOns)).toBe(5);
    expect(settledLines(items, addOns)[1]).toEqual({ itemId: 'a1', productId: '', productName: 'صابون (إضافة)', shipped: 2, delivered: null, expectedBack: 2 });
  });

  it('anything taken keeps the add-ons: the customer paid for them', () => {
    const part = [{ ...items[0], deliveredQty: 1 }];
    expect(expectedBackTotal(part, addOns)).toBe(2);
    expect(settledLines(part, addOns)[1]).toMatchObject({ delivered: 2, expectedBack: 0 });
  });

  it('an order with no add-on is counted as it always was', () => {
    expect(expectedBackTotal(items)).toBe(3);
    expect(settledLines(items)).toHaveLength(1);
  });
});

/* ───────────── 1. add-ons ───────────── */

describe('1 · a refused parcel’s add-ons', () => {
  const parcel = (placed: boolean) =>
    shop({
      placed,
      batches: [batch('c', CREAM, placed ? 'w1' : null, 10, 4), batch('s', SOAP, placed ? 'w1' : null, 5, 3)],
      items: [line('i1', CREAM, 2)],
      addOns: [addOn('a1', SOAP, 1)],
    });

  it('unplaced store, whole and sound: the hold on the add-on is released, the shelf stays', async () => {
    parcel(false);
    const r = await receive(3);
    expect(r).toMatchObject({ ok: true, missingQty: 0 });
    expect(t('returnReceipt')[0]).toMatchObject({ expectedQty: 3, receivedQty: 3, missingQty: 0 });
    expect([held(CREAM), held(SOAP)]).toEqual([0, 0]);
    expect([shelf(CREAM), shelf(SOAP)]).toEqual([10, 5]);
    expect(moves()).toEqual([]);
  });

  it('placed store, received elsewhere: the add-on leaves the source and is available in the receiver', async () => {
    parcel(true);
    await receive(3, 0, { warehouseId: 'w2' });
    expect([shelf(SOAP, 'w1'), shelf(SOAP, 'w2'), held(SOAP)]).toEqual([4, 1, 0]);
    expect([shelf(CREAM, 'w1'), shelf(CREAM, 'w2'), held(CREAM)]).toEqual([8, 2, 0]);
    expect(S.audit[0]).toMatchObject({ newData: { expectedQty: 3, movedToWarehouse: 3 } });
  });

  it('received into the warehouse it left from: nothing moves, the hold goes', async () => {
    parcel(true);
    await receive(3, 0, { warehouseId: 'w1' });
    expect([shelf(SOAP, 'w1'), shelf(CREAM, 'w1'), held(SOAP)]).toEqual([5, 10, 0]);
    expect(t('productionBatch')).toHaveLength(2);
  });

  it('the add-on came back broken: it leaves the shelf, written «تالف»', async () => {
    parcel(true);
    await receive(2, 1, { warehouseId: 'w2' });
    expect([shelf(SOAP, 'w1'), shelf(SOAP, 'w2'), held(SOAP)]).toEqual([4, 0, 0]);
    expect(moves()).toEqual([['DAMAGE', SOAP, -1]]);
  });

  it('the add-on did not come back: it leaves the shelf, written «ناقص»', async () => {
    parcel(false);
    await receive(2);
    expect([shelf(SOAP), shelf(CREAM), held(SOAP)]).toEqual([4, 10, 0]);
    expect(moves()).toEqual([['LOSS', SOAP, -1]]);
  });

  it('a parcel that is an add-on alone', async () => {
    shop({ placed: true, batches: [batch('s', SOAP, 'w1', 5, 3)], addOns: [addOn('a1', SOAP, 2)] });
    const r = await receive(2, 0, { warehouseId: 'w3' });
    expect(r).toMatchObject({ ok: true, missingQty: 0 });
    expect([shelf(SOAP, 'w1'), shelf(SOAP, 'w3'), held(SOAP)]).toEqual([3, 2, 0]);
  });

  it('a second receipt moves nothing twice', async () => {
    parcel(true);
    await receive(2, 1, { warehouseId: 'w2' });
    const before = picture();
    expect(await receive(2, 1, { warehouseId: 'w2' })).toMatchObject({ ok: false, code: 'ALREADY_RECEIVED' });
    expect(picture()).toBe(before);
  });

  it('one more than the parcel held is still refused, and nothing is written', async () => {
    parcel(false);
    const before = picture();
    expect(await receive(4)).toMatchObject({ ok: false, code: 'OVER_RECEIVED' });
    expect(picture()).toBe(before);
  });

  it('a zero count moves no unit; the parcel found later is completed once', async () => {
    parcel(true);
    await receive(0, 0, { warehouseId: 'w2' });
    expect([shelf(SOAP, 'w1'), shelf(SOAP, 'w2'), held(SOAP), moves().length]).toEqual([5, 0, 0, 0]);
    await receive(3, 0, { warehouseId: 'w2' });
    expect([shelf(SOAP, 'w1'), shelf(SOAP, 'w2'), shelf(CREAM, 'w2')]).toEqual([4, 1, 2]);
    expect(await receive(3, 0, { warehouseId: 'w2' })).toMatchObject({ ok: false });
    expect(shelf(SOAP, 'w2')).toBe(1);
  });

  it('«استلام الكل» takes the add-ons with it', async () => {
    parcel(true);
    await receive('WHOLE', 0, { warehouseId: 'w2' });
    expect(t('returnReceipt')[0]).toMatchObject({ expectedQty: 3, receivedQty: 3 });
    expect([shelf(SOAP, 'w2'), held(SOAP)]).toEqual([1, 0]);
  });

  it('a partial delivery: the add-on stayed with the customer — not expected, not moved, not restored', async () => {
    shop({
      batches: [batch('c', CREAM, null, 8, 4), batch('s', SOAP, null, 4, 3)],
      items: [line('i1', CREAM, 2, { deliveredQty: 1, reservedQty: 0 })],
      addOns: [addOn('a1', SOAP, 1, { reservedQty: 0 })],
      order: { shippingStatus: 'PARTIALLY_DELIVERED' },
      more: consumed(),
    });
    expect(await receive(2)).toMatchObject({ ok: false, code: 'OVER_RECEIVED' });
    await receive(1);
    expect([shelf(CREAM), shelf(SOAP)]).toEqual([9, 4]);
    expect(returned()).toEqual([['RETURN', CREAM, 1]]);
  });

  it('delivered then returned, a line and an add-on of ONE product: two batches, two numbers, one price', async () => {
    shop({
      batches: [batch('c', CREAM, null, 5, 10)],
      items: [line('i1', CREAM, 1, { reservedQty: 0 })],
      addOns: [addOn('a1', CREAM, 1, { reservedQty: 0 })],
      more: consumed(),
    });
    await receive(2);
    const back = t('productionBatch').filter((b) => b.batchNumber.startsWith('RET-'));
    expect(back.map((b) => [b.batchNumber, b.quantityRemaining, b.costPerUnit])).toEqual([
      ['RET-ORD-1-pcream', 1, 10],
      ['RET-ORD-1-pcream+2', 1, 10],
    ]);
  });

  it('…and with one of the two broken, the add-on is priced at the cost BEFORE this receipt, not the line’s carried one', async () => {
    shop({
      batches: [batch('c', CREAM, null, 5, 10)],
      items: [line('i1', CREAM, 1, { reservedQty: 0 })],
      addOns: [addOn('a1', CREAM, 2, { reservedQty: 0 })],
      more: consumed(),
    });
    await receive(2, 1);
    const back = t('productionBatch').filter((b) => b.batchNumber.startsWith('RET-'));
    // The broken unit's 10 rides on the LINE's survivor (the damage is shared as it was, half rounding up).
    expect(back.map((b) => [b.quantityRemaining, b.costPerUnit])).toEqual([[1, 20], [1, 10]]);
    expect(sum(back.map((b) => ({ v: b.quantityRemaining * b.costPerUnit })), 'v')).toBe(30);
  });

  it('the parcel written off as lost expects the add-ons too', async () => {
    shop({ batches: [batch('c', CREAM, null, 10, 4), batch('s', SOAP, null, 5, 3)], items: [line('i1', CREAM, 2)], addOns: [addOn('a1', SOAP, 1)] });
    // The door takes a uuid: this order is named by one.
    const id = '77777777-7777-4777-8777-777777777777';
    for (const r of [...t('orderItem'), ...t('orderAddOn')]) r.orderId = id;
    t('order')[0].id = id;
    const res = await writeOff(
      new Request('http://localhost/x', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: id, reason: 'ضاع مع الشركة' }),
      })
    );
    expect(res.status).toBe(200);
    expect(t('returnReceipt')[0]).toMatchObject({ expectedQty: 3, receivedQty: 0, missingQty: 3 });
  });

  it('the old-stock ledger counts a moved add-on to its own product', () => {
    // `correctedLedger` lays the moved units over the lines it is handed — the add-ons after the order's lines.
    const out = correctedLedger(new Map(), [{ into: 'w2', from: 'w1', moved: 3, lines: [{ productId: CREAM, units: 2 }, { productId: SOAP, units: 1 }] }], []);
    expect([out.get(`w2|${CREAM}`), out.get(`w2|${SOAP}`), out.get(`w1|${SOAP}`)]).toEqual([2, 1, -1]);
  });
});

/* ───────────── 2. partial delivery ───────────── */

describe('2 · a return after a partial delivery puts back what was refused', () => {
  const partial = (items: Row[], more: Record<string, Row[]> = {}) =>
    shop({
      batches: [batch('c', CREAM, null, 10, 4), batch('s', SOAP, null, 10, 7)],
      items,
      order: { shippingStatus: 'PARTIALLY_DELIVERED' },
      more: { ...consumed(), ...more },
    });

  it('the first line kept, the second refused: the SECOND product comes back', async () => {
    partial([line('i1', CREAM, 1, { deliveredQty: 1, reservedQty: 0 }), line('i2', SOAP, 1, { deliveredQty: 0, reservedQty: 0 })]);
    await receive(1);
    expect([shelf(CREAM), shelf(SOAP)]).toEqual([10, 11]);
    expect(returned()).toEqual([['RETURN', SOAP, 1]]);
  });

  it('three of one kept two, two of another refused: one and two', async () => {
    partial([line('i1', CREAM, 3, { deliveredQty: 2, reservedQty: 0 }), line('i2', SOAP, 2, { deliveredQty: 0, reservedQty: 0 })]);
    await receive(3);
    expect(returned()).toEqual([['RETURN', CREAM, 1], ['RETURN', SOAP, 2]]);
  });

  it('refused one came back broken: no unit returns, nothing of the kept product either', async () => {
    partial([line('i1', CREAM, 1, { deliveredQty: 1, reservedQty: 0 }), line('i2', SOAP, 1, { deliveredQty: 0, reservedQty: 0 })]);
    await receive(0, 1);
    expect([shelf(CREAM), shelf(SOAP)]).toEqual([10, 10]);
    expect(returned()).toEqual([]);
  });

  it('a second receipt restores nothing twice', async () => {
    partial([line('i1', CREAM, 1, { deliveredQty: 1, reservedQty: 0 }), line('i2', SOAP, 1, { deliveredQty: 0, reservedQty: 0 })]);
    await receive(1);
    const before = picture();
    expect(await receive(1)).toMatchObject({ ok: false, code: 'ALREADY_RECEIVED' });
    expect(picture()).toBe(before);
  });

  it('two lines of one product in two sizes: the refused line’s size comes back, not the kept one’s', async () => {
    partial(
      [
        line('i1', SHIRT, 1, { deliveredQty: 1, reservedQty: 0, variantSummary: 'M' }),
        line('i2', SHIRT, 1, { deliveredQty: 0, reservedQty: 0, variantSummary: 'L' }),
      ],
      {
        productVariant: [{ id: 'vM', companyId: 'c1', productId: SHIRT, onHand: 3 }, { id: 'vL', companyId: 'c1', productId: SHIRT, onHand: 3 }],
        orderItemVariant: [
          { id: 'x1', orderId: 'o1', orderItemId: 'i1', productId: SHIRT, variantId: 'vM', quantity: 1, freeQuantity: 0, createdAt: new Date(1) },
          { id: 'x2', orderId: 'o1', orderItemId: 'i2', productId: SHIRT, variantId: 'vL', quantity: 1, freeQuantity: 0, createdAt: new Date(2) },
        ],
      }
    );
    await receive(1);
    expect(t('productVariant').map((v) => v.onHand)).toEqual([3, 4]);
  });
});

/* ───────────── 2b. one product on two lines ───────────── */

describe('2 · one product on two lines of a consumed parcel', () => {
  /** Two cream lines, optionally behind a soap line; every one consumed. */
  const twice = (a: Row, b: Row, soapFirst = false) =>
    shop({
      batches: [batch('c', CREAM, null, 10, 10), batch('s', SOAP, null, 10, 7)],
      items: [
        ...(soapFirst ? [line('i0', SOAP, 1, { deliveredQty: 0, reservedQty: 0 })] : []),
        line('i1', CREAM, a.quantity, { deliveredQty: a.deliveredQty, reservedQty: 0 }),
        line('i2', CREAM, b.quantity, { deliveredQty: b.deliveredQty, reservedQty: 0 }),
      ],
      order: { shippingStatus: 'PARTIALLY_DELIVERED' },
      more: consumed(),
    });
  const back = () =>
    t('productionBatch')
      .filter((x) => x.batchNumber.startsWith('RET-'))
      .map((x) => [x.batchNumber, x.quantityRemaining, x.costPerUnit]);

  it('both lines partly refused: the receipt is saved, in two batches with two numbers', async () => {
    twice({ quantity: 3, deliveredQty: 2 }, { quantity: 2, deliveredQty: 1 });
    expect(await receive(2)).toMatchObject({ ok: true, missingQty: 0 });
    expect(back()).toEqual([['RET-ORD-1-pcream', 1, 10], ['RET-ORD-1-pcream+2', 1, 10]]);
    expect(shelf(CREAM)).toBe(12);
  });

  it('…and behind another product', async () => {
    twice({ quantity: 3, deliveredQty: 2 }, { quantity: 2, deliveredQty: 1 }, true);
    expect(await receive(3)).toMatchObject({ ok: true, missingQty: 0 });
    expect(back()).toEqual([['RET-ORD-1-psoap0', 1, 7], ['RET-ORD-1-pcream', 1, 10], ['RET-ORD-1-pcream+2', 1, 10]]);
    expect([shelf(CREAM), shelf(SOAP)]).toEqual([12, 11]);
  });

  it('a broken unit’s money stays on the first line’s batch; the second is priced at the cost before this receipt', async () => {
    twice({ quantity: 2, deliveredQty: 1 }, { quantity: 3, deliveredQty: 1 });
    expect(await receive(2, 1)).toMatchObject({ ok: true, missingQty: 0 });
    expect(back()).toEqual([['RET-ORD-1-pcream', 1, 20], ['RET-ORD-1-pcream+2', 1, 10]]);
  });

  it('delivered then returned whole, two lines of one product (RV2710)', async () => {
    twice({ quantity: 1, deliveredQty: null }, { quantity: 1, deliveredQty: null });
    expect(await receive('WHOLE')).toMatchObject({ ok: true });
    expect(back()).toEqual([['RET-ORD-1-pcream', 1, 10], ['RET-ORD-1-pcream+2', 1, 10]]);
  });

  it('a line and two add-ons of one product: «+2» then «+3»', async () => {
    shop({
      batches: [batch('c', CREAM, null, 10, 10)],
      items: [line('i1', CREAM, 1, { reservedQty: 0 })],
      addOns: [addOn('a1', CREAM, 1, { reservedQty: 0 }), addOn('a2', CREAM, 1, { reservedQty: 0 })],
      more: consumed(),
    });
    expect(await receive(3)).toMatchObject({ ok: true });
    expect(back().map((x) => x[0])).toEqual(['RET-ORD-1-pcream', 'RET-ORD-1-pcream+2', 'RET-ORD-1-pcream+3']);
  });

  it('a second receipt of it writes nothing', async () => {
    twice({ quantity: 3, deliveredQty: 2 }, { quantity: 2, deliveredQty: 1 });
    await receive(2);
    const before = picture();
    expect(await receive(2)).toMatchObject({ ok: false, code: 'ALREADY_RECEIVED' });
    expect(picture()).toBe(before);
  });
});

/* ───────────── 3. combinations ───────────── */

describe('3 · a refused parcel of a product with sizes', () => {
  /** Two M and one L of one line; `places` are the combinations' rows of a placed store. */
  const shirts = (placed: boolean, places: Row[] = [], order: Row = {}) =>
    shop({
      placed,
      order,
      batches: [batch('t', SHIRT, placed ? 'w1' : null, 10, 5)],
      items: [line('i1', SHIRT, 3, { variantSummary: 'M ×2، L' })],
      more: {
        productVariant: [{ id: 'vM', companyId: 'c1', productId: SHIRT, onHand: 6 }, { id: 'vL', companyId: 'c1', productId: SHIRT, onHand: 4 }],
        productVariantStock: places,
        orderItemVariant: [
          { id: 'x1', orderId: 'o1', orderItemId: 'i1', productId: SHIRT, variantId: 'vM', quantity: 2, freeQuantity: 0, createdAt: new Date(1) },
          { id: 'x2', orderId: 'o1', orderItemId: 'i1', productId: SHIRT, variantId: 'vL', quantity: 1, freeQuantity: 0, createdAt: new Date(2) },
        ],
      },
    });
  const place = (id: string, variantId: string, warehouseId: string | null, onHand: number): Row => ({
    id, companyId: 'c1', variantId, warehouseId, onHand, inTransitTransferId: null,
  });
  const counted = () => [place('m1', 'vM', 'w1', 6), place('l1', 'vL', 'w1', 4)];
  const count = (id: string) => t('productVariant').find((v) => v.id === id)!.onHand;
  const at = (variantId: string, warehouseId: string | null) =>
    sum(t('productVariantStock').filter((r) => r.variantId === variantId && r.warehouseId === warehouseId), 'onHand');

  it('unplaced, whole and sound: the counts do not move', async () => {
    shirts(false);
    await receive(3);
    expect([count('vM'), count('vL'), held(SHIRT)]).toEqual([6, 4, 0]);
    expect(t('variantStockMovement')).toEqual([]);
  });

  it('unplaced, 2 sound + 1 broken: the broken piece (the L) leaves its count', async () => {
    shirts(false);
    await receive(2, 1);
    expect([count('vM'), count('vL'), shelf(SHIRT)]).toEqual([6, 3, 9]);
    expect(t('variantStockMovement')).toEqual([]);
  });

  it('unplaced, 1 sound + 1 broken + 1 missing: an M broke, the L is missing', async () => {
    shirts(false);
    await receive(1, 1);
    expect([count('vM'), count('vL'), shelf(SHIRT)]).toEqual([5, 3, 8]);
  });

  it('unplaced: a count never goes below zero', async () => {
    shirts(false);
    t('productVariant')[1].onHand = 0;
    await receive(2);
    expect([count('vM'), count('vL')]).toEqual([6, 0]);
  });

  it('placed, received elsewhere: sound pieces move with the units, the broken one leaves, and every sum holds', async () => {
    shirts(true, counted());
    await receive(2, 1, { warehouseId: 'w2' });
    expect([at('vM', 'w1'), at('vM', 'w2'), count('vM')]).toEqual([4, 2, 6]);
    expect([at('vL', 'w1'), at('vL', 'w2'), count('vL')]).toEqual([3, 0, 3]);
    expect([shelf(SHIRT, 'w1'), shelf(SHIRT, 'w2')]).toEqual([7, 2]);
    // The ledger: the move adds to nothing, the broken piece is the one line that lowers a total.
    expect(t('variantStockMovement').map((m) => [m.variantId, m.type, m.warehouseId, m.quantity])).toEqual([
      ['vL', 'DAMAGE', 'w1', -1],
      ['vM', 'RETURN', 'w1', -2],
      ['vM', 'RETURN', 'w2', 2],
    ]);
  });

  it('placed, a missing piece: written «ناقص» on its combination', async () => {
    shirts(true, counted());
    await receive(2, 0, { warehouseId: 'w2' });
    expect([at('vL', 'w1'), count('vL'), at('vM', 'w2')]).toEqual([3, 3, 2]);
    expect(t('variantStockMovement').filter((m) => m.variantId === 'vL').map((m) => [m.type, m.quantity])).toEqual([['LOSS', -1]]);
  });

  it('placed, combinations never counted into a warehouse: from «بلا مكان», with the opening line', async () => {
    shirts(true);
    await receive(3, 0, { warehouseId: 'w2' });
    expect([at('vM', null), at('vM', 'w2'), count('vM')]).toEqual([4, 2, 6]);
    expect([at('vL', null), at('vL', 'w2'), count('vL')]).toEqual([3, 1, 4]);
    expect(t('variantStockMovement').filter((m) => m.type === 'OPENING')).toHaveLength(2);
  });

  it('placed: the source first, then «بلا مكان», never a third warehouse', async () => {
    shirts(true, [place('m1', 'vM', 'w1', 1), place('m0', 'vM', null, 0), place('m3', 'vM', 'w3', 5), place('l1', 'vL', 'w1', 4)]);
    await receive(3, 0, { warehouseId: 'w2' });
    expect([at('vM', 'w1'), at('vM', 'w2'), at('vM', 'w3'), count('vM')]).toEqual([0, 1, 5, 6]);
  });

  it('placed, received where it left from: only the broken piece is written', async () => {
    shirts(true, counted());
    await receive(2, 1, { warehouseId: 'w1' });
    expect([at('vM', 'w1'), at('vL', 'w1')]).toEqual([6, 3]);
    expect(t('variantStockMovement').map((m) => m.type)).toEqual(['DAMAGE']);
  });

  it('a zero count moves no piece', async () => {
    shirts(true, counted());
    await receive(0, 0, { warehouseId: 'w2' });
    expect(t('variantStockMovement')).toEqual([]);
    expect([count('vM'), count('vL')]).toEqual([6, 4]);
  });

  it('a second receipt moves no piece twice', async () => {
    shirts(true, counted());
    await receive(2, 1, { warehouseId: 'w2' });
    const before = picture();
    expect(await receive(2, 1, { warehouseId: 'w2' })).toMatchObject({ ok: false, code: 'ALREADY_RECEIVED' });
    expect(picture()).toBe(before);
  });

  it('a delivered-then-returned parcel is restored once, by the restore alone', async () => {
    shirts(false);
    t('inventoryMovement').push({ id: 'sale', companyId: 'c1', referenceId: 'o1', type: 'SALE', quantity: -3, productId: SHIRT });
    await receive(2, 1);
    expect([count('vM'), count('vL')]).toEqual([8, 4]);
  });
});
