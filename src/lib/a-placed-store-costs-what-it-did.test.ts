import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import { placeStore, type PlacementCount } from './warehouse-placement';
import { drawDownStock } from './receiving';
import { productCost, productCosts } from './product-cost';
import { splitBatch } from './batch-split';

/**
 * A PLACED STORE COSTS WHAT IT DID — the money side of the opening placement (W1a, review blockers 1 and 3).
 *
 *   1. THE DRAW AND THE SPLIT, INTERLEAVED. The draw-down reads its batches, then writes each one's new figures; nothing
 *      locks the rows in between. A placement that split a row and committed in that gap was overwritten by the draw's
 *      write — the moved units counted twice. The draw now writes only a row that still holds what it read, and reads again
 *      when it does not. Reproduced here with the exact interleaving.
 *   2. FLOATING POINT. 15 units at 17.4047 is not 10 + 5 units at 17.4047 as doubles, and on an exact half the currency's
 *      rounding flips. Every reader that multiplies units by a unit cost now costs a run's units once, wherever they sit
 *      (`batch-family.ts`). Proven against a CONTROL: the same store never placed, the same draws, every figure ===.
 *   3. UNSPLIT DATA IS THE MAIN BRANCH'S TO THE BIT: the frozen golden file beside this test holds what
 *      `git show osm/main:src/lib/receiving.ts` and `…/product-cost.ts` answered for 600 random stores and 3600 operations.
 *
 * The database is the in-memory one of `warehouse-placement.test.ts` (copied — a test helper shared from a non-test file is
 * an export nothing in production reads), with one addition: an update whose row no longer matches its `where` answers as
 * Prisma does (P2025).
 */


// eslint-disable-next-line @typescript-eslint/no-explicit-any -- an in-memory row; every field is read by name
type Row = Record<string, any>;

const ALLOWED_TABLES = ['productionBatch', 'product', 'productVariant', 'orderItem', 'orderAddOn', 'order', 'store', 'warehouse', 'warehousePlacement'];

function scalarMatches(v: unknown, cond: unknown): boolean {
  if (cond === null) return v === null || v === undefined;
  if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
  if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
    const c = cond as Row;
    if ('in' in c && !(c.in as unknown[]).includes(v)) return false;
    if ('notIn' in c && (c.notIn as unknown[]).includes(v)) return false;
    if ('not' in c) {
      if (c.not === null ? v === null || v === undefined : v === c.not) return false;
    }
    if ('gt' in c && !((v as number) > c.gt)) return false;
    if ('gte' in c && !((v as number) >= c.gte)) return false;
    if ('lt' in c && !((v as number) < c.lt)) return false;
    return true;
  }
  return v === cond;
}

function makeDb(data: Record<string, Row[]>, hooks: { afterBatchRead?: () => Promise<void> } = {}) {
  const log: Row[] = [];
  let seq = 0;
  const matches = (table: string, row: Row, where: Row = {}): boolean => {
    for (const [k, cond] of Object.entries(where)) {
      if (cond === undefined) continue;
      if (k === 'OR') { if (!(cond as Row[]).some((w) => matches(table, row, w))) return false; continue; }
      if (k === 'AND') { if (!(cond as Row[]).every((w) => matches(table, row, w))) return false; continue; }
      if (k === 'order' && (table === 'orderItem' || table === 'orderAddOn')) {
        const o = data.order.find((x) => x.id === row.orderId);
        if (!o || !matches('order', o, cond as Row)) return false;
        continue;
      }
      if (!scalarMatches(row[k], cond)) return false;
    }
    return true;
  };
  const project = (r: Row, select?: Row) => {
    if (!select) return { ...r };
    const out: Row = {};
    for (const [k, v] of Object.entries(select)) if (v === true) out[k] = r[k];
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
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        if ('increment' in v) r[k] += v.increment;
        else if ('decrement' in v) r[k] -= v.decrement;
      } else r[k] = v;
    }
  };
  const table = (name: string) => {
    const rows = () => (data[name] ??= []);
    return {
      findMany: async ({ where, select, orderBy }: Row = {}) => {
        log.push({ t: name, op: 'read' });
        const out = sortBy(rows().filter((r) => matches(name, r, where)), orderBy).map((r) => project(r, select));
        if (name === 'productionBatch' && hooks.afterBatchRead) {
          const h = hooks.afterBatchRead;
          hooks.afterBatchRead = undefined;
          await h();
        }
        return out;
      },
      findFirst: async ({ where, select }: Row = {}) => {
        log.push({ t: name, op: 'read' });
        const r = rows().find((x) => matches(name, x, where));
        return r ? project(r, select) : null;
      },
      findUnique: async ({ where, select }: Row) => {
        log.push({ t: name, op: 'read' });
        const r = rows().find((x) => matches(name, x, where));
        return r ? project(r, select) : null;
      },
      create: async ({ data: d, select }: Row) => {
        log.push({ t: name, op: 'write' });
        if (name === 'warehousePlacement' && rows().some((r) => r.storeId === d.storeId)) throw new Error('unique storeId');
        if (name === 'productionBatch' && rows().some((r) => r.companyId === d.companyId && r.batchNumber === d.batchNumber)) throw new Error('unique batchNumber');
        const row: Row = { id: `${name}-${++seq}`, createdAt: new Date(), ...d };
        rows().push(row);
        return project(row, select);
      },
      updateMany: async ({ where, data: d }: Row) => {
        log.push({ t: name, op: 'write' });
        const hit = rows().filter((r) => matches(name, r, where));
        for (const r of hit) apply(r, d);
        return { count: hit.length };
      },
      update: async ({ where, data: d }: Row) => {
        log.push({ t: name, op: 'write' });
        const r = rows().find((x) => matches(name, x, where));
        // Prisma's answer to an update whose row no longer matches its `where`.
        if (!r) throw new Prisma.PrismaClientKnownRequestError('No record was found for an update.', { code: 'P2025', clientVersion: 'test' });
        apply(r, d);
        return { ...r };
      },
      groupBy: async ({ by, where, _sum }: Row) => {
        log.push({ t: name, op: 'read' });
        const groups = new Map<string, Row>();
        for (const r of rows().filter((x) => matches(name, x, where))) {
          const key = (by as string[]).map((b) => r[b]).join('|');
          const g = groups.get(key) ?? { ...Object.fromEntries((by as string[]).map((b) => [b, r[b]])), _sum: Object.fromEntries(Object.keys(_sum).map((k) => [k, 0])) };
          for (const k of Object.keys(_sum)) g._sum[k] += r[k];
          groups.set(key, g);
        }
        return [...groups.values()];
      },
      aggregate: async ({ where, _sum }: Row) => {
        log.push({ t: name, op: 'read' });
        const hit = rows().filter((x) => matches(name, x, where));
        return { _sum: Object.fromEntries(Object.keys(_sum).map((k) => [k, hit.reduce((s, r) => s + r[k], 0)])) };
      },
    };
  };
  const delegates: Row = Object.fromEntries(ALLOWED_TABLES.map((t) => [t, table(t)]));
  delegates.$executeRaw = async (_s: TemplateStringsArray, ...values: unknown[]) => (log.push({ t: 'lock', op: 'lock', values }), 1);
  const tx = new Proxy(delegates, {
    get(target, prop) {
      if (typeof prop === 'string' && !(prop in target) && prop !== 'then') throw new Error(`a placement touched «${prop}»`);
      return target[prop as string];
    },
  });
  const root = new Proxy(
    { ...delegates, $transaction: async (fn: (t: Row) => unknown) => fn(tx) },
    { get: (t, p) => (t as Row)[p as string] }
  );
  return { tx: tx as never, root: root as never, log, data };
}

/* ───────────── a random store ───────────── */

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const C = 'c1';
const S = 's1';
const COUNTRY = 'k1';
const SHIPPING = ['PENDING', 'READY_TO_SHIP', 'READY_FOR_PICKUP', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'PARTIALLY_DELIVERED', 'FAILED_DELIVERY', 'RETURN_REQUESTED', 'RETURNED', 'CANCELLED'];
const CONFIRMATION = ['PENDING', 'CONFIRMED', 'CONFIRMED', 'CONFIRMED', 'REJECTED', 'CANCELLED'];

function randomStore(seed: number) {
  const r = rng(seed);
  const int = (n: number) => Math.floor(r() * n);
  const days = [0, 1, 2, 5].map((d) => new Date(Date.UTC(2026, 9, 1 + d)));
  const data: Record<string, Row[]> = {
    store: [{ id: S, companyId: C, countryId: COUNTRY }, { id: 's2', companyId: C, countryId: COUNTRY }],
    warehouse: [
      { id: 'w1', companyId: C, countryId: COUNTRY, isActive: true },
      { id: 'w2', companyId: C, countryId: COUNTRY, isActive: true },
      { id: 'w3', companyId: C, countryId: COUNTRY, isActive: true },
    ],
    warehousePlacement: [],
    product: [],
    productVariant: [],
    productionBatch: [],
    order: [],
    orderItem: [],
    orderAddOn: [],
  };
  let created = 0;
  const nProducts = 1 + int(6);
  for (let p = 0; p < nProducts; p++) {
    const id = `p${p}`;
    data.product.push({ id, companyId: C, storeId: S, name: `منتج ${p}`, sku: `SKU${p}` });
    if (r() < 0.2) data.productVariant.push({ id: `v${p}`, companyId: C, productId: id, status: 'ACTIVE' });
    for (let b = int(5); b > 0; b--) {
      const produced = int(40);
      const sold = int(produced + 1);
      // Now and then a row the shelf owes (a negative remaining) — it must net against the courier units, not be placed.
      const remaining = r() < 0.08 ? -int(3) - 1 : produced - sold;
      const cost = r() < 0.15 ? 0 : Math.round(r() * 100000) / 10000;
      data.productionBatch.push({
        id: `b${p}-${b}`,
        companyId: C,
        storeId: S,
        productId: id,
        batchNumber: `RCV-${p}-${b}`,
        quantityProduced: produced,
        // A row that owes units has sold more than it produced: the identity holds before the placement, so it can be held after.
        quantitySold: produced - remaining,
        quantityRemaining: remaining,
        quantityMovedIn: 0,
        quantityMovedOut: 0,
        costPerUnit: cost,
        totalProductionCost: cost * produced,
        manufacturingCost: 0,
        productionDate: days[int(days.length)],
        createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, ++created)),
        status: 'COMPLETED',
        notes: cost === 0 ? 'عيّنة مجانية' : null,
        warehouseId: null,
        inTransitTransferId: null,
        splitFromBatchId: null,
        openingCountId: null,
      });
    }
  }
  const nOrders = int(10);
  for (let o = 0; o < nOrders; o++) {
    const shipping = SHIPPING[int(SHIPPING.length)];
    data.order.push({
      id: `o${o}`,
      storeId: r() < 0.85 ? S : 's2',
      confirmationStatus: CONFIRMATION[int(CONFIRMATION.length)],
      shippingStatus: shipping,
      shippedAt: r() < 0.3 ? new Date() : null,
      labelPrintedAt: r() < 0.3 ? new Date() : null,
    });
    for (let i = int(3); i > 0; i--) {
      const productId = `p${int(nProducts)}`;
      data.orderItem.push({ id: `oi${o}-${i}`, orderId: `o${o}`, companyId: C, productId, reservedQty: int(4) });
    }
    if (r() < 0.3) data.orderAddOn.push({ id: `oa${o}`, orderId: `o${o}`, companyId: C, productId: `p${int(nProducts)}`, reservedQty: int(3) });
  }
  return { data, r };
}

/* ───────────── the figures, computed here and only here ───────────── */

const GONE = ['SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'PARTIALLY_DELIVERED', 'FAILED_DELIVERY', 'RETURN_REQUESTED', 'RETURNED'];
const holds = (o: Row) => o.storeId === S && !['REJECTED', 'CANCELLED'].includes(o.confirmationStatus) && !['DELIVERED', 'CANCELLED'].includes(o.shippingStatus);
const left = (o: Row) => !!o.shippedAt || GONE.includes(o.shippingStatus) || !!o.labelPrintedAt || o.shippingStatus === 'READY_FOR_PICKUP';

function heldBy(data: Record<string, Row[]>, productId: string, also: (o: Row) => boolean = () => true) {
  let n = 0;
  for (const line of [...data.orderItem, ...data.orderAddOn]) {
    if (line.productId !== productId || line.reservedQty <= 0) continue;
    const o = data.order.find((x) => x.id === line.orderId)!;
    if (holds(o) && also(o)) n += line.reservedQty;
  }
  return n;
}

/** Counts that agree with the book: each product's to-place split at random across the warehouses given. */
function exactCounts(data: Record<string, Row[]>, r: () => number, warehouses: string[]): PlacementCount[] | null {
  const counts: PlacementCount[] = warehouses.map((w) => ({ warehouseId: w, lines: [] }));
  for (const p of data.product) {
    const onHand = data.productionBatch.filter((b) => b.productId === p.id).reduce((s, b) => s + b.quantityRemaining, 0);
    const toPlace = onHand - heldBy(data, p.id, left);
    if (toPlace < 0) return null;
    let rest = toPlace;
    warehouses.forEach((w, i) => {
      const n = i === warehouses.length - 1 ? rest : Math.floor(r() * (rest + 1));
      rest -= n;
      if (n > 0 || r() < 0.5) counts[i].lines.push({ productId: p.id, quantity: n });
    });
  }
  return counts;
}

const press = (tx: never, counts: PlacementCount[]) =>
  placeStore(tx, { companyId: C, storeId: S, countedByName: 'أمين المخزن', countedAt: new Date('2026-11-01T10:00:00Z'), recordedById: 'u1', counts, now: new Date('2026-11-02T10:00:00Z') });

/* ───────────── the operations both sides run ───────────── */

type Fns = { drawDownStock: typeof drawDownStock; productCost: typeof productCost; productCosts: typeof productCosts };

/** A seeded sequence of draws and cost reads on one store; every answer (or refusal) recorded. */
async function operate(fns: Fns, data: Record<string, Row[]>, seed: number, n: number, figuresOnly = false) {
  const r = rng(seed * 7919 + 17);
  const { tx } = makeDb(data);
  const ids = data.product.map((p) => p.id);
  const out: Row[] = [];
  for (let i = 0; i < n; i++) {
    const productId = ids[Math.floor(r() * ids.length)];
    const quantity = 1 + Math.floor(r() * 20);
    const allowNegative = r() < 0.5;
    const storeId = r() < 0.7 ? S : undefined;
    const drawn = await fns.drawDownStock(tx, { companyId: C, productId, quantity, allowNegative, storeId }).catch((e: Error) => ({ refused: e.message }));
    const one = await fns.productCost(tx, C, productId);
    const many = await fns.productCosts(tx, C, ids);
    // `nextOut` is left out of the placed-vs-control comparison: it is the first row by production date ONLY, and rows of one
    // date come back in no promised order — a twin sorts among them by chance (a known fragility, filed, not this request's).
    const strip = (c: Row) => (figuresOnly ? { onHand: c.onHand, stockValue: c.stockValue, average: c.average } : c);
    out.push({ drawn, one: strip(one), many: Object.fromEntries([...many].map(([k, v]) => [k, strip(v)])) });
  }
  return out;
}

/* ───────────── 3. unsplit data: the main branch's answers ───────────── */

async function record(fns: Fns) {
  const all: Row[] = [];
  for (let seed = 1; seed <= 600; seed++) {
    const { data } = randomStore(seed);
    const ops = await operate(fns, data, seed, 6);
    // Every draw and its product's figures; the whole catalogue's figures once, after the last draw (they are the same function).
    all.push({ ops: ops.map((o) => [o.drawn, o.one]), many: ops[ops.length - 1].many, rows: data.productionBatch.map((b) => [b.id, b.quantityRemaining, b.quantitySold]) });
  }
  return JSON.parse(JSON.stringify(all));
}

describe('a store never placed: the draw and the cost figures are osm/main’s, to the bit (frozen golden)', () => {
  it('600 random stores, 3600 draws with their cost reads: the same costs, refusals, figures and rows', async () => {
    const golden = JSON.parse(readFileSync(join(__dirname, 'stock-money.main-golden.json'), 'utf8'));
    expect(golden).toHaveLength(600);
    expect(await record({ drawDownStock, productCost, productCosts })).toEqual(golden);
  });
});

/* ───────────── 2. a placed store against its never-placed control ───────────── */

describe('a placed store against the same store never placed — the same money, ===', () => {
  it('2000 random stores: every draw’s cost, every stock value and average are identical to the control', async () => {
    let compared = 0;
    for (let seed = 5000; seed < 7000; seed++) {
      const { data, r } = randomStore(seed);
      const counts = exactCounts(data, r, ['w1', 'w2', 'w3'].slice(0, 1 + Math.floor(r() * 3)));
      if (!counts) continue;
      const control = structuredClone(data);
      await press(makeDb(data).tx, counts);
      const placed = await operate({ drawDownStock, productCost, productCosts }, data, seed, 8, true);
      const never = await operate({ drawDownStock, productCost, productCosts }, control, seed, 8, true);
      expect(placed, `seed ${seed}`).toEqual(never);
      compared++;
    }
    expect(compared).toBeGreaterThan(1000);
  });

  it('the review’s case: 15 units at 17.4047 split 10 / 5 — one order of 15 costs 15 × 17.4047, as unplaced', async () => {
    const placedData = oneStore([batchOf('RA', 15, 17.4047)]);
    const control = structuredClone(placedData);
    await press(makeDb(placedData).tx, [
      { warehouseId: 'w1', lines: [{ productId: 'p0', quantity: 10 }] },
      { warehouseId: 'w2', lines: [{ productId: 'p0', quantity: 5 }] },
    ]);
    expect(placedData.productionBatch).toHaveLength(2);
    const a = await drawDownStock(makeDb(placedData).tx, { companyId: C, productId: 'p0', quantity: 15, allowNegative: false, storeId: S });
    const b = await drawDownStock(makeDb(control).tx, { companyId: C, productId: 'p0', quantity: 15, allowNegative: false, storeId: S });
    expect(a.cost).toBe(15 * 17.4047);
    expect(a).toEqual(b);
    // 10 + 5 costed apart gives another double — the very difference the review measured.
    expect(10 * 17.4047 + 5 * 17.4047).not.toBe(15 * 17.4047);
  });

  it('a split of a split whose middle row was emptied is still costed as its run', async () => {
    const data = oneStore([batchOf('RA', 15, 17.4047)]);
    const { tx } = makeDb(data);
    const first = await splitBatch(tx, { companyId: C, batchId: 'RA', quantity: 5, to: { warehouseId: 'w1' } });
    await splitBatch(tx, { companyId: C, batchId: first.twin.id, quantity: 5, to: { warehouseId: 'w2' } }); // the middle row now holds 0; RA 10 + its grandchild 5
    const cost = await productCost(tx, C, 'p0');
    expect(cost.stockValue).toBe(Number((15 * 17.4047).toFixed(4)));
    const drawn = await drawDownStock(tx, { companyId: C, productId: 'p0', quantity: 15, allowNegative: false });
    expect(drawn.cost).toBe(15 * 17.4047);
  });
});

/* ───────────── 1. the interleaving of the review ───────────── */

describe('a draw that read before a placement split its batch, and writes after — stays conserved', () => {
  it('the draw reads RA (10); the placement splits it 6 / 4 and commits; the draw writes — 8 on hand, not 12', async () => {
    const data = oneStore([batchOf('RA', 10, 2.5)]);
    const counts: PlacementCount[] = [
      { warehouseId: 'w1', lines: [{ productId: 'p0', quantity: 6 }] },
      { warehouseId: 'w2', lines: [{ productId: 'p0', quantity: 4 }] },
    ];
    let placedInBetween = false;
    const { tx } = makeDb(data, {
      afterBatchRead: async () => {
        await press(makeDb(data).tx, counts);
        placedInBetween = true;
      },
    });
    const drawn = await drawDownStock(tx, { companyId: C, productId: 'p0', quantity: 2, allowNegative: false, storeId: S });
    expect(placedInBetween).toBe(true);
    expect(drawn).toEqual({ taken: 2, short: 0, cost: 2 * 2.5 });
    const onHand = data.productionBatch.reduce((s, b) => s + b.quantityRemaining, 0);
    const sold = data.productionBatch.reduce((s, b) => s + b.quantitySold, 0);
    const value = data.productionBatch.reduce((s, b) => s + b.quantityRemaining * b.costPerUnit, 0);
    expect([onHand, sold, value]).toEqual([8, 2, 8 * 2.5]);
    for (const b of data.productionBatch) expect(b.quantityRemaining).toBe(b.quantityProduced + b.quantityMovedIn - b.quantitySold - b.quantityMovedOut);
  });

  it('and when the re-read finds too little for a draw that may not go negative, it refuses as before', async () => {
    const data = oneStore([batchOf('RA', 10, 2.5)]);
    const { tx } = makeDb(data, {
      afterBatchRead: async () => {
        // Another delivery took 7 in between.
        data.productionBatch[0].quantityRemaining = 3;
        data.productionBatch[0].quantitySold = 7;
      },
    });
    const err = await drawDownStock(tx, { companyId: C, productId: 'p0', quantity: 5, allowNegative: false, storeId: S }).catch((e) => e);
    expect(String(err.message)).toContain('المخزون غير كافٍ');
    expect(data.productionBatch[0].quantityRemaining).toBe(3);
  });
});

function oneStore(batches: Row[]): Record<string, Row[]> {
  return {
    store: [{ id: S, companyId: C, countryId: COUNTRY }],
    warehouse: [
      { id: 'w1', companyId: C, countryId: COUNTRY, isActive: true },
      { id: 'w2', companyId: C, countryId: COUNTRY, isActive: true },
    ],
    warehousePlacement: [],
    product: [{ id: 'p0', companyId: C, storeId: S, name: 'منتج', sku: null }],
    productVariant: [],
    productionBatch: batches,
    order: [],
    orderItem: [],
    orderAddOn: [],
  };
}

function batchOf(id: string, remaining: number, cost: number): Row {
  return {
    id, companyId: C, storeId: S, productId: 'p0', batchNumber: `RCV-${id}`,
    quantityProduced: remaining, quantitySold: 0, quantityRemaining: remaining, quantityMovedIn: 0, quantityMovedOut: 0,
    costPerUnit: cost, totalProductionCost: cost * remaining,
    productionDate: new Date('2026-10-01'), createdAt: new Date('2026-10-01T00:00:00Z'),
    status: 'COMPLETED', notes: null, warehouseId: null, inTransitTransferId: null, splitFromBatchId: null, openingCountId: null,
  };
}
