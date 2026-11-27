import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import { restoreOrderStock, takeOffUnreturned } from './stock-consumption';
import { unplacedBeforePlaced } from './receiving';
import { repoFile, stripComments } from './guard-source';

/**
 * A RETURN LANDS WHERE IT WAS RECEIVED (the warehouse plan, W2b — the returns half).
 *
 * The two functions the returns desk calls inside its receipt (`restoreOrderStock`, then `takeOffUnreturned`) take one new
 * argument: the warehouse that RECEIVED the parcel, given only for a store placed in warehouses (already checked by the
 * desk — `warehouse-intake.returnPlace`).
 *
 *   1. MAIN'S ANSWERS, FROZEN (`stock-consumption.w2b-main-golden.json`): with no warehouse — every store that is not
 *      placed — 1,500 random stores of refused, delivered-then-returned, legacy, swapped and replayed parcels give what
 *      `git show osm/main:src/lib/stock-consumption.ts` (with main's `receiving.ts` and `product-variants.ts`) gave: every
 *      result, every write, every row, to the bit.
 *      To record again (only when main's own behaviour changes): put main's three files, their other `./` imports pointed
 *      at this folder, in a directory and run this file with `W2B_MAIN_DIR=<that directory>`.
 *   2. CONSERVATION, against the very same parcel received with no warehouse: per product Σ remaining, Σ produced, Σ sold
 *      and Σ (remaining × cost) are the same numbers — naming a warehouse changes WHERE, never how many or how much — and
 *      the units on the road and another store's rows are never touched.
 *   3. THE PLACES, by hand: a consumed parcel's `RET-` batch in the receiver; a refused parcel's broken and missing units
 *      from the warehouse it left first (then the others, then «بلا مكان»), said on the line when they came from elsewhere;
 *      its sound units moved by a split into the receiver; an order that left before the placement — «بلا مكان» first.
 * Totals are summed here from the rows directly, never through the functions under test.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- an in-memory row; every field is read by name
type Row = Record<string, any>;
type Data = Record<string, Row[]>;

/* ───────────── an in-memory database that applies `where` and mutates its rows ───────────── */

function scalarMatches(v: unknown, cond: unknown): boolean {
  if (cond === null) return v === null || v === undefined;
  if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
    const c = cond as Row;
    if ('in' in c && !(c.in as unknown[]).includes(v)) return false;
    if ('notIn' in c && (c.notIn as unknown[]).includes(v)) return false;
    if ('not' in c && (c.not === null ? v === null || v === undefined : v === c.not)) return false;
    if ('gt' in c && !((v as number) > c.gt)) return false;
    return true;
  }
  return v === cond;
}

const SUB: Record<string, string> = { items: 'orderItem', addOns: 'orderAddOn', store: 'store', country: 'country' };

function makeDb(data: Data) {
  const writes: Row[] = [];
  let seq = 0;
  const matches = (row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([k, c]) => (c === undefined ? true : k === 'OR' ? (c as Row[]).some((x) => matches(row, x)) : scalarMatches(row[k], c)));
  const relation = (table: string, key: string, r: Row): Row[] | Row | null => {
    if (table === 'order' && key === 'items') return data.orderItem.filter((i) => i.orderId === r.id);
    if (table === 'order' && key === 'addOns') return data.orderAddOn.filter((i) => i.orderId === r.id);
    if (table === 'order' && key === 'store') return data.store.find((s) => s.id === r.storeId) ?? null;
    if (table === 'store' && key === 'country') return { minorUnit: r.minorUnit };
    // 27/11: the receipt also reads the store's old-stock warehouse (`old-stock-home.ts`); none here.
    if (table === 'store' && key === 'warehousePlacement') return null;
    throw new Error(`relation ${table}.${key}`);
  };
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
  const table = (name: string) => {
    const rows = () => (data[name] ??= []);
    return {
      findMany: async ({ where, select, orderBy }: Row = {}) => sortBy(rows().filter((r) => matches(r, where)), orderBy).map((r) => project(name, r, select)),
      findFirst: async ({ where, select, orderBy }: Row = {}) => {
        const r = sortBy(rows().filter((x) => matches(x, where)), orderBy)[0];
        return r ? project(name, r, select) : null;
      },
      create: async ({ data: d, select }: Row) => {
        const row: Row = { id: `${name}-${String(++seq).padStart(4, '0')}`, ...d };
        rows().push(row);
        writes.push({ t: name, op: 'create', data: { ...d } });
        return project(name, row, select);
      },
      update: async ({ where, data: d }: Row) => {
        const r = rows().find((x) => matches(x, where));
        if (!r) throw new Prisma.PrismaClientKnownRequestError('No record was found for an update.', { code: 'P2025', clientVersion: 'test' });
        apply(r, d);
        writes.push({ t: name, op: 'update', id: r.id, data: { ...d } });
        return { ...r };
      },
      updateMany: async ({ where, data: d }: Row) => {
        const hit = rows().filter((r) => matches(r, where));
        for (const r of hit) apply(r, d);
        writes.push({ t: name, op: 'updateMany', where: JSON.stringify(where), count: hit.length, data: { ...d } });
        return { count: hit.length };
      },
      aggregate: async ({ where, _sum }: Row) => {
        const hit = rows().filter((x) => matches(x, where));
        return { _sum: Object.fromEntries(Object.keys(_sum).map((k) => [k, hit.length ? hit.reduce((s, r) => s + r[k], 0) : null])) };
      },
    };
  };
  const names = ['productionBatch', 'inventoryMovement', 'orderActivity', 'order', 'orderItem', 'orderAddOn', 'warehouse', 'store'];
  const delegates: Row = Object.fromEntries(names.map((t) => [t, table(t)]));
  delegates.$executeRaw = async () => {
    writes.push({ t: 'lock' });
    return 1;
  };
  const tx = new Proxy(delegates, {
    get(target, prop) {
      if (typeof prop === 'string' && !(prop in target) && prop !== 'then') throw new Error(`the receipt touched «${prop}»`);
      return target[prop as string];
    },
  });
  return { tx: tx as never, writes };
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
const WAREHOUSES = ['w1', 'w2', 'w3'];

interface Call {
  orderId: string;
  received: number;
  damaged: number;
  missing: number;
  /** The warehouse that received it — used only by the placed runs. */
  receiver: string;
}

/**
 * `oneCost`: every batch of a product at one cost, and — on even seeds — no broken unit, so no batch is ever born at another
 * cost (a broken unit's cost rides on the sound ones): Σ (remaining × cost) is then comparable whichever batch a unit left.
 */
function randomStore(seed: number, oneCost = false) {
  const r = rng(seed * 7919 + (oneCost ? 1 : 0));
  const int = (n: number) => Math.floor(r() * n);
  const pick = <T,>(xs: readonly T[]) => xs[int(xs.length)];
  const days = [0, 1, 2, 5, 9].map((d) => new Date(Date.UTC(2026, 9, 1 + d)));
  const data: Data = {
    store: [{ id: S, companyId: C, minorUnit: pick([2, 2, 3, 0]) }, { id: 's2', companyId: C, minorUnit: 2 }],
    warehouse: WAREHOUSES.map((id, i) => ({ id, companyId: C, name: `مخزن ${i + 1}` })),
    productionBatch: [],
    inventoryMovement: [],
    orderActivity: [],
    order: [],
    orderItem: [],
    orderAddOn: [],
  };
  let created = 0;
  const nProducts = 1 + int(3);
  for (let p = 0; p < nProducts; p++) {
    const productId = `p${p}-000000`;
    // Whole: a return's batch is priced at the cost rounded to the currency, and a whole number survives every rounding.
    const productCost = 1 + int(9);
    const parents: Row[] = [];
    for (let b = int(7); b > 0; b--) {
      const remaining = int(9);
      const cost = oneCost ? productCost : r() < 0.12 ? 0 : Math.round(r() * 100000) / 10000;
      const onRoad = r() < 0.1;
      const place = onRoad ? null : r() < 0.3 ? null : pick(WAREHOUSES);
      const parent = parents.length > 0 && r() < 0.2 ? pick(parents) : null;
      const row: Row = {
        id: `b${p}-${b}`,
        companyId: C,
        storeId: r() < 0.08 ? 's2' : S,
        productId,
        batchNumber: `B-${p}-${b}`,
        quantityProduced: parent ? 0 : remaining + int(5),
        quantityMovedIn: parent ? remaining : 0,
        quantityMovedOut: 0,
        quantityRemaining: remaining,
        quantitySold: 0,
        costPerUnit: parent ? parent.costPerUnit : cost,
        productionDate: parent ? parent.productionDate : pick(days),
        createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, ++created)),
        status: 'COMPLETED',
        notes: null,
        warehouseId: place,
        inTransitTransferId: onRoad ? `t${int(3)}` : null,
        splitFromBatchId: parent ? parent.id : null,
      };
      row.quantitySold = row.quantityProduced + row.quantityMovedIn - row.quantityRemaining;
      if (row.quantitySold < 0) {
        row.quantityProduced -= row.quantitySold;
        row.quantitySold = 0;
      }
      if (!parent && row.storeId === S) parents.push(row);
      data.productionBatch.push(row);
    }
  }
  const calls: Call[] = [];
  const nOrders = 1 + int(5);
  for (let o = 0; o < nOrders; o++) {
    const id = `o${o}`;
    const legacy = r() < 0.08;
    data.order.push({
      id,
      companyId: C,
      orderNumber: `ORD-${seed}-${o}`,
      storeId: r() < 0.92 ? S : 's2',
      sourceWarehouseId: r() < 0.25 ? null : pick(WAREHOUSES),
      source: legacy ? 'Legacy import' : 'Manual',
    });
    let expected = 0;
    for (let i = 1 + int(3); i > 0; i--) {
      const quantity = int(5);
      const freeQuantity = r() < 0.25 ? 1 + int(2) : 0;
      const deliveredQty = r() < 0.15 ? int(quantity + freeQuantity + 1) : null;
      expected += Math.max(0, quantity + freeQuantity - (deliveredQty ?? 0));
      data.orderItem.push({
        id: `oi${o}-${i}`, orderId: id, productId: `p${int(nProducts)}-000000`, productName: 'منتج', quantity, freeQuantity,
        reservedQty: legacy ? 0 : quantity, deliveredQty, variantSummary: null,
      });
    }
    if (r() < 0.25) data.orderAddOn.push({ id: `oa${o}`, orderId: id, productId: `p${int(nProducts)}-000000`, productName: 'إضافة', quantity: 1 + int(2), reservedQty: 1 });
    // Delivered, then returned: the delivery already wrote its SALE line.
    if (r() < 0.3) data.inventoryMovement.push({ id: `sale-${o}`, companyId: C, referenceId: id, type: 'SALE', quantity: -1 });
    if (r() < 0.05) data.orderActivity.push({ id: `short-${o}`, companyId: C, orderId: id, action: 'STOCK_SHORT_AT_DELIVERY' });
    const received = int(expected + 1);
    const damaged = oneCost && seed % 2 === 0 ? 0 : int(expected - received + 1);
    calls.push({ orderId: id, received, damaged, missing: expected - received - damaged, receiver: pick(WAREHOUSES) });
  }
  // A second receipt of the same parcel — every guard of «once» is exercised.
  if (calls.length > 0 && r() < 0.3) calls.push({ ...pick(calls) });
  return { data, calls };
}

/* ───────────── the receipt's two calls, in the receipt's order ───────────── */

type Restore = typeof restoreOrderStock;
type TakeOff = typeof takeOffUnreturned;

async function receive(fns: { restore: Restore; takeOff: TakeOff }, data: Data, calls: Call[], placed: boolean) {
  const { tx, writes } = makeDb(data);
  const results: Row[] = [];
  for (const c of calls) {
    const at = placed ? { warehouseId: c.receiver } : {};
    results.push(await fns.restore(tx, { orderId: c.orderId, companyId: C, receivedQty: c.received, damagedQty: c.damaged, userId: 'u1', ...at }));
    results.push(
      await fns.takeOff(tx, { orderId: c.orderId, companyId: C, receivedQty: c.received, damagedQty: c.damaged, missingQty: c.missing, userId: 'u1', ...at })
    );
  }
  return { results, writes };
}

function fullView(data: Data, out: { results: Row[]; writes: Row[] }) {
  return {
    results: out.results,
    writes: out.writes,
    batches: data.productionBatch.map((b) => [b.id, b.batchNumber, b.quantityRemaining, b.quantitySold, b.quantityProduced, b.costPerUnit, b.warehouseId ?? null]),
  };
}

const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 24);
const PER = 1500;
const NOW = new Date('2026-11-01T09:00:00Z');

beforeAll(() => {
  // The RET- and DMG- batches are dated «now»: one fixed now, so main's rows and these are the same rows.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterAll(() => {
  vi.useRealTimers();
});

const NEW = { restore: restoreOrderStock, takeOff: takeOffUnreturned };

async function record(fns: { restore: Restore; takeOff: TakeOff }) {
  const out: string[] = [];
  for (let seed = 1; seed <= PER; seed++) {
    const { data, calls } = randomStore(seed);
    out.push(hash(fullView(data, await receive(fns, data, calls, false))));
  }
  return out;
}

const GOLDEN = join(__dirname, 'stock-consumption.w2b-main-golden.json');
const MAIN_DIR = process.env.W2B_MAIN_DIR;

describe.runIf(MAIN_DIR)('recording osm/main (only with W2B_MAIN_DIR)', () => {
  it('writes the golden file from main’s restoreOrderStock and takeOffUnreturned', async () => {
    const main = await import(/* @vite-ignore */ `${MAIN_DIR}/stock-consumption.ts`);
    writeFileSync(GOLDEN, JSON.stringify({ unplaced: await record({ restore: main.restoreOrderStock, takeOff: main.takeOffUnreturned }) }) + '\n');
  }, 600_000);
});

/* ───────────── 1. main's answers ───────────── */

/**
 * 27/11 (RV2667) — THE ONE ANSWER OF MAIN'S THIS FILE PINNED THAT WAS WRONG. A parcel that left the shelf (consumed, or
 * gone before the opening count) with units the customer KEPT: main laid the counted sound units over every line at its
 * FULL quantity, so they could land on kept units — the wrong product restored. Read off the random store itself, without
 * the functions under test: do the two walks of the count bring back different products or numbers? (Two lines of one
 * product trading units write the same rows.) Those seeds differ from the frozen answers, and no other seed may. The
 * golden file is not re-recorded.
 */
function mainRestoredAKeptUnit(seed: number): boolean {
  const { data, calls } = randomStore(seed);
  return calls.some((c) => {
    const order = data.order.find((o) => o.id === c.orderId)!;
    const items = data.orderItem.filter((i) => i.orderId === c.orderId);
    const left =
      data.inventoryMovement.some((m) => m.referenceId === c.orderId && m.type === 'SALE') ||
      (order.source === 'Legacy import' && items.every((i) => i.reservedQty === 0));
    if (!left) return false;
    const walk = (room: (i: Row) => number) => {
      let remaining = c.received;
      return items.flatMap((i) => {
        const take = Math.max(0, Math.min(remaining, room(i)));
        remaining -= take;
        return take > 0 ? [`${i.productId}:${take}`] : [];
      });
    };
    const main = walk((i) => i.quantity + i.freeQuantity);
    const now = walk((i) => i.quantity + i.freeQuantity - (i.deliveredQty ?? 0));
    return main.join() !== now.join();
  });
}

describe('a store that is not placed: osm/main’s answers, frozen — 1,500 random stores', () => {
  it.skipIf(MAIN_DIR)(`${PER} stores receive their returns exactly as main did — but the ones where main restored a kept unit (27/11)`, async () => {
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { unplaced: string[] };
    expect(golden.unplaced).toHaveLength(PER);
    const now = await record(NEW);
    const differ = now.map((h, i) => (h === golden.unplaced[i] ? 0 : i + 1)).filter(Boolean);
    const pinned = golden.unplaced.map((_, i) => (mainRestoredAKeptUnit(i + 1) ? i + 1 : 0)).filter(Boolean);
    expect(differ, `seeds that differ from main: ${differ.slice(0, 10).join(', ')}`).toEqual(pinned);
    expect(pinned).toHaveLength(64);
  }, 180_000);

  it('the stores are not trivial: restores, take-offs, legacy parcels, replays and short shelves all happen', async () => {
    const seen = { restored: 0, damaged: 0, missing: 0, absorbed: 0, outside: 0, consumed: 0, already: 0, never: 0 };
    for (let seed = 1; seed <= 300; seed++) {
      const { data, calls } = randomStore(seed);
      const { results } = await receive(NEW, data, calls, false);
      for (const x of results) {
        if (x.restored > 0) seen.restored++;
        if (x.damaged > 0) seen.damaged++;
        if (x.missing > 0) seen.missing++;
        if (x.absorbed > 0) seen.absorbed++;
        if (x.skipped === 'OUTSIDE_COUNT') seen.outside++;
        if (x.skipped === 'CONSUMED') seen.consumed++;
        if (x.alreadyDone || x.skipped === 'ALREADY_DONE') seen.already++;
        if (x.neverConsumed) seen.never++;
      }
    }
    expect(Math.min(...Object.values(seen)), JSON.stringify(seen)).toBeGreaterThan(5);
  });
});

/* ───────────── 2. conservation: naming a warehouse changes where, never how many or how much ───────────── */

function clone(data: Data): Data {
  return Object.fromEntries(Object.entries(data).map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]));
}

function totalsOf(data: Data) {
  const t = new Map<string, { remaining: number; produced: number; sold: number; value: number }>();
  for (const b of data.productionBatch) {
    const x = t.get(b.productId) ?? { remaining: 0, produced: 0, sold: 0, value: 0 };
    x.remaining += b.quantityRemaining;
    x.produced += b.quantityProduced;
    x.sold += b.quantitySold;
    x.value += b.quantityRemaining * b.costPerUnit;
    t.set(b.productId, x);
  }
  return t;
}

describe('a placed store: the same parcels, received into a warehouse, conserve every figure', () => {
  it('1,000 random stores: per product Σ remaining, Σ produced, Σ sold and Σ value equal the same receipt with no warehouse', async () => {
    let moved = 0;
    let twins = 0;
    let valued = 0;
    for (let seed = 1; seed <= 1000; seed++) {
      const { data, calls } = randomStore(seed, true);
      const plain = clone(data);
      const placed = clone(data);
      const before = clone(data);
      const a = await receive(NEW, plain, calls, false);
      const b = await receive(NEW, placed, calls, true);

      // The same units taken off, restored and absorbed — the same answers but for the units moved.
      // Units are units whichever batch they left; money is comparable only while every batch keeps the product's one cost.
      const sameCost = calls.every((c) => c.damaged === 0);
      const answer = (x: Row) => {
        const { moved: _m, absorbed, ...rest } = x;
        void _m;
        return sameCost ? { ...rest, absorbed } : rest;
      };
      expect(b.results.map(answer)).toEqual(a.results.map(answer));
      moved += b.results.reduce((s, x) => s + (x.moved ?? 0), 0);

      const ta = totalsOf(plain);
      const tb = totalsOf(placed);
      for (const [productId, x] of ta) {
        const y = tb.get(productId)!;
        expect([y.remaining, y.produced, y.sold], `seed ${seed} ${productId}`).toEqual([x.remaining, x.produced, x.sold]);
        // A return of an order whose store holds no batch of the product comes back at 0: compare money only where every
        // row of the product, in both runs, is still at one cost.
        const costs = new Set([...plain.productionBatch, ...placed.productionBatch].filter((b) => b.productId === productId).map((b) => b.costPerUnit));
        if (sameCost && costs.size === 1) {
          expect(y.value).toBeCloseTo(x.value, 6);
          valued++;
        }
      }

      // The same ledger lines — type, product, units, balance — only their place and words may differ.
      const lines = (w: Row[]) => w.filter((x) => x.t === 'inventoryMovement').map((x) => [x.data.type, x.data.productId, x.data.quantity, x.data.balanceAfter]);
      expect(lines(b.writes)).toEqual(lines(a.writes));

      // Never the road: those rows are exactly as they were. (Another store's shelf: by hand, below.)
      for (const old of before.productionBatch.filter((x) => x.inTransitTransferId)) {
        const now = placed.productionBatch.find((x) => x.id === old.id)!;
        expect([now.quantityRemaining, now.quantitySold, now.warehouseId], `seed ${seed} ${old.id}`).toEqual([old.quantityRemaining, old.quantitySold, old.warehouseId]);
      }

      // Every row keeps the row's arithmetic: remaining = produced + moved in − sold − moved out.
      for (const row of placed.productionBatch) {
        const n = (k: string) => row[k] ?? 0;
        expect(n('quantityRemaining'), `seed ${seed} ${row.id}`).toBe(n('quantityProduced') + n('quantityMovedIn') - n('quantitySold') - n('quantityMovedOut'));
      }

      // Every row this receipt created sits in the warehouse that received its parcel.
      const receiverOf = new Map(calls.map((c) => [c.orderId, c.receiver]));
      for (const row of placed.productionBatch.slice(before.productionBatch.length)) {
        if (row.splitFromBatchId) {
          twins++;
          const parent = placed.productionBatch.find((x) => x.id === row.splitFromBatchId)!;
          expect(row.quantityProduced).toBe(0);
          expect(row.costPerUnit).toBe(parent.costPerUnit);
          expect(WAREHOUSES).toContain(row.warehouseId);
        } else {
          const orderNumber = String(row.batchNumber).split('-').slice(1, 4).join('-');
          const order = placed.order.find((o) => o.orderNumber === orderNumber)!;
          expect(row.warehouseId, row.batchNumber).toBe(receiverOf.get(order.id));
        }
      }
    }
    expect(moved).toBeGreaterThan(100);
    expect(valued).toBeGreaterThan(300);
    expect(twins).toBeGreaterThan(100);
  }, 120_000);
});

/* ───────────── 3. the places, by hand ───────────── */

function batch(id: string, warehouseId: string | null, remaining: number, day: number, extra: Row = {}): Row {
  return {
    id, companyId: C, storeId: S, productId: 'pA-000000', batchNumber: `B-${id}`, quantityProduced: remaining + 10, quantityMovedIn: 0,
    quantityMovedOut: 0, quantityRemaining: remaining, quantitySold: 10, costPerUnit: 2, productionDate: new Date(Date.UTC(2026, 9, 1 + day)),
    createdAt: new Date(Date.UTC(2026, 9, 1 + day)), status: 'COMPLETED', notes: null, warehouseId, inTransitTransferId: null, splitFromBatchId: null, ...extra,
  };
}

function shop(batches: Row[], order: Row, items: Row[], extra: Partial<Data> = {}): Data {
  return {
    store: [{ id: S, companyId: C, minorUnit: 2 }],
    warehouse: WAREHOUSES.map((id, i) => ({ id, companyId: C, name: `مخزن ${i + 1}` })),
    productionBatch: batches,
    inventoryMovement: [],
    orderActivity: [],
    order: [{ id: 'o1', companyId: C, orderNumber: 'ORD-1', storeId: S, source: 'Manual', ...order }],
    orderItem: items.map((i, k) => ({ id: `oi${k}`, orderId: 'o1', productId: 'pA-000000', productName: 'منتج', freeQuantity: 0, deliveredQty: null, variantSummary: null, ...i })),
    orderAddOn: [],
    ...extra,
  };
}

const placeOf = (data: Data, warehouseId: string | null, productId = 'pA-000000') =>
  data.productionBatch.filter((b) => b.productId === productId && (b.warehouseId ?? null) === warehouseId && !b.inTransitTransferId).reduce((s, b) => s + b.quantityRemaining, 0);

async function takeOff(data: Data, p: { received: number; damaged: number; missing: number; receiver?: string }) {
  const { tx, writes } = makeDb(data);
  const out = await takeOffUnreturned(tx, {
    orderId: 'o1', companyId: C, receivedQty: p.received, damagedQty: p.damaged, missingQty: p.missing, userId: 'u1',
    ...(p.receiver ? { warehouseId: p.receiver } : {}),
  });
  return { out, writes, lines: writes.filter((w) => w.t === 'inventoryMovement').map((w) => w.data) };
}

describe('a refused parcel of a placed store', () => {
  it('broken and missing units leave the warehouse it left from first; its sound units come back in the receiver; the lines say where', async () => {
    // Source w1 holds 2; w2 (older) holds 10; «بلا مكان» 4 (oldest of all). 5 units: 3 sound, 1 broken, 1 missing; received in w2.
    const data = shop([batch('u', null, 4, 0), batch('b2', 'w2', 10, 1), batch('b1', 'w1', 2, 3)], { sourceWarehouseId: 'w1' }, [{ quantity: 5, reservedQty: 5 }]);
    const { out, lines } = await takeOff(data, { received: 3, damaged: 1, missing: 1, receiver: 'w2' });
    expect(out).toMatchObject({ damaged: 1, missing: 1, moved: 0 });
    // Sound + broken (4) left together, w1 first (2), then w2 (2); the 3 sound came back in w2 in their DMG- batch; the
    // missing one: w1 is empty, so w2.
    expect([placeOf(data, 'w1'), placeOf(data, 'w2'), placeOf(data, null)]).toEqual([0, 10 - 2 - 1 + 3, 4]);
    const dmg = data.productionBatch.find((b) => String(b.batchNumber).startsWith('DMG-'))!;
    expect([dmg.warehouseId, dmg.quantityRemaining]).toEqual(['w2', 3]);
    expect(lines.map((l) => [l.type, l.quantity, l.warehouseId])).toEqual([['DAMAGE', -1, 'w1'], ['LOSS', -1, 'w1']]);
    expect(lines[0].reason).toBe('تالف من مرتجع ORD-1 — رُفض عند الباب — فرق مكان: 2 من «مخزن 2» — مش من «مخزن 1»');
    expect(lines[1].reason).toBe('ناقص من مرتجع ORD-1 — ما رجع مع الطرد — فرق مكان: 1 من «مخزن 2» — مش من «مخزن 1»');
  });

  it('a whole, sound parcel received in another warehouse moves there by a split — oldest first, nothing written to the ledger', async () => {
    const data = shop([batch('b1', 'w1', 2, 0), batch('b2', 'w1', 5, 1), batch('far', 'w3', 9, 0)], { sourceWarehouseId: 'w1' }, [{ quantity: 4, reservedQty: 4 }]);
    const before = totalsOf(clone(data)).get('pA-000000');
    const { out, lines } = await takeOff(data, { received: 4, damaged: 0, missing: 0, receiver: 'w2' });
    expect(out).toEqual({ damaged: 0, missing: 0, absorbed: 0, moved: 4, skipped: 'NOTHING_MISSING' });
    expect(lines).toEqual([]);
    expect([placeOf(data, 'w1'), placeOf(data, 'w2'), placeOf(data, 'w3')]).toEqual([3, 4, 9]);
    const twins = data.productionBatch.filter((b) => b.splitFromBatchId);
    expect(twins.map((t) => [t.splitFromBatchId, t.quantityRemaining, t.warehouseId, t.quantityProduced, t.quantityMovedIn])).toEqual([
      ['b1', 2, 'w2', 0, 2],
      ['b2', 2, 'w2', 0, 2],
    ]);
    expect(totalsOf(data).get('pA-000000')).toEqual(before);
  });

  it('received in the warehouse it left from: nothing moves and nothing is written', async () => {
    const data = shop([batch('b1', 'w1', 6, 0)], { sourceWarehouseId: 'w1' }, [{ quantity: 4, reservedQty: 4 }]);
    const { out, writes } = await takeOff(data, { received: 4, damaged: 0, missing: 0, receiver: 'w1' });
    expect(out).toEqual({ damaged: 0, missing: 0, absorbed: 0, moved: 0, skipped: 'NOTHING_MISSING' });
    expect(writes.filter((w) => w.op !== undefined && w.t !== 'lock')).toEqual([]);
  });

  it('an order that left BEFORE the placement: «بلا مكان» first — for the broken units and for the sound ones', async () => {
    const data = shop([batch('old', 'w1', 5, 0), batch('u', null, 3, 4)], { sourceWarehouseId: null }, [{ quantity: 3, reservedQty: 3 }, { quantity: 2, reservedQty: 2 }]);
    const { out, lines } = await takeOff(data, { received: 3, damaged: 0, missing: 2, receiver: 'w2' });
    // Line 1: 3 sound → moved from «بلا مكان» (3) into w2. Line 2: 2 missing → «بلا مكان» is empty now, so w1.
    expect(out).toMatchObject({ missing: 2, moved: 3 });
    expect([placeOf(data, null), placeOf(data, 'w1'), placeOf(data, 'w2')]).toEqual([0, 3, 3]);
    expect(lines.map((l) => [l.type, l.quantity, 'warehouseId' in l])).toEqual([['LOSS', -2, false]]);
  });

  it('…and its missing units leave «بلا مكان» before an OLDER warehouse row (they never had a place)', async () => {
    const data = shop([batch('old', 'w1', 5, 0), batch('u', null, 3, 4)], { sourceWarehouseId: null }, [{ quantity: 2, reservedQty: 2 }]);
    // 1 sound, 1 missing: the missing one leaves «بلا مكان» (not the older w1); the sound one moves from there into w2.
    const { out } = await takeOff(data, { received: 1, damaged: 0, missing: 1, receiver: 'w2' });
    expect(out).toMatchObject({ missing: 1, moved: 1 });
    expect([placeOf(data, null), placeOf(data, 'w1'), placeOf(data, 'w2')]).toEqual([1, 5, 1]);
  });

  it('the road is never touched: units in transit stay; only what a shelf holds is moved', async () => {
    const data = shop(
      [batch('road', null, 5, 0, { inTransitTransferId: 't1' }), batch('u', null, 1, 1), batch('other-store', 'w1', 7, 0, { storeId: 's2' })],
      { sourceWarehouseId: 'w1' },
      [{ quantity: 3, reservedQty: 3 }]
    );
    const { out } = await takeOff(data, { received: 3, damaged: 0, missing: 0, receiver: 'w2' });
    expect(out.moved).toBe(1);
    expect(data.productionBatch.find((b) => b.id === 'road')!.quantityRemaining).toBe(5);
    expect(data.productionBatch.find((b) => b.id === 'other-store')!.quantityRemaining).toBe(7);
  });

  it('the same parcel with no warehouse (a store that is not placed): no split, no moved, the lines name no warehouse', async () => {
    const data = shop([batch('b1', 'w1', 2, 0), batch('b2', 'w2', 10, 1)], { sourceWarehouseId: 'w1' }, [{ quantity: 5, reservedQty: 5 }]);
    const { out, lines } = await takeOff(data, { received: 3, damaged: 1, missing: 1 });
    expect(out).toEqual({ damaged: 1, missing: 1, absorbed: 2 });
    expect(data.productionBatch.some((b) => b.splitFromBatchId)).toBe(false);
    expect(lines.every((l) => !('warehouseId' in l))).toBe(true);
    expect(lines.map((l) => l.reason)).toEqual(['تالف من مرتجع ORD-1 — رُفض عند الباب', 'ناقص من مرتجع ORD-1 — ما رجع مع الطرد']);
  });
});

describe('a delivered-then-returned parcel of a placed store', () => {
  it('its RET- batch and its RETURN line are in the warehouse that received it; the take-off is skipped as consumed', async () => {
    const data = shop([batch('b1', 'w1', 1, 0)], { sourceWarehouseId: 'w1' }, [{ quantity: 3, reservedQty: 0 }], {
      inventoryMovement: [{ id: 'sale', companyId: C, referenceId: 'o1', type: 'SALE', quantity: -3 }],
    });
    const { tx, writes } = makeDb(data);
    const restored = await restoreOrderStock(tx, { orderId: 'o1', companyId: C, receivedQty: 2, damagedQty: 1, userId: 'u1', warehouseId: 'w3' });
    const off = await takeOffUnreturned(tx, { orderId: 'o1', companyId: C, receivedQty: 2, damagedQty: 1, missingQty: 0, userId: 'u1', warehouseId: 'w3' });
    expect(restored).toMatchObject({ restored: 2, alreadyDone: false });
    expect(off.skipped).toBe('CONSUMED');
    const ret = data.productionBatch.find((b) => String(b.batchNumber).startsWith('RET-'))!;
    expect([ret.warehouseId, ret.quantityRemaining, ret.storeId]).toEqual(['w3', 2, S]);
    const line = writes.find((w) => w.t === 'inventoryMovement')!.data;
    expect([line.type, line.quantity, line.warehouseId, line.batchId]).toEqual(['RETURN', 2, 'w3', ret.id]);
  });
});

/* ───────────── the helpers and the wiring ───────────── */

describe('the order of a draw that starts with «بلا مكان»', () => {
  it('is stable: the rows with no warehouse first, oldest first inside each', () => {
    const rows = [{ id: 'a', warehouseId: 'w1' }, { id: 'b', warehouseId: null }, { id: 'c', warehouseId: 'w2' }, { id: 'd', warehouseId: null }];
    expect(unplacedBeforePlaced(rows).map((x) => x.id)).toEqual(['b', 'd', 'a', 'c']);
  });
});

describe('what the stock function asks only when a warehouse is named', () => {
  const src = stripComments(repoFile('src/lib/stock-consumption.ts'));
  const takeOffSrc = src.slice(src.indexOf('export async function takeOffUnreturned('), src.indexOf('async function moveReturnedUnits('));
  it('every new read, place and split stands behind the receiving warehouse', () => {
    expect(takeOffSrc).toMatch(/\.\.\.\(receiver \? \{ sourceWarehouseId: true \} : \{\}\)/);
    expect(takeOffSrc).toMatch(/const from[^=]*= receiver \?/);
    expect(takeOffSrc).toMatch(/if \(receiver && s > 0 && d === 0 && receiver !== source\)/);
  });
  it('the sound units move by `splitBatch` only — never by a draw and a new batch', () => {
    const move = src.slice(src.indexOf('async function moveReturnedUnits('));
    expect(move).toMatch(/splitBatch\(tx,/);
    expect(move).not.toMatch(/drawDownStock|productionBatch\.create|inventoryMovement\.create/);
    expect(move).toMatch(/inTransitTransferId: null/);
  });
});
