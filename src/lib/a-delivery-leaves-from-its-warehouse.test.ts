import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import { consumeOrderStock, STOCK_PLACE_DIFFERENCE_ACTION, STOCK_SHORT_ACTION } from './stock-consumption';
import { drawDownStock, preferring } from './receiving';
import { repoFile, stripComments } from './guard-source';

/**
 * A DELIVERY LEAVES FROM ITS WAREHOUSE (the warehouse plan, W4b — the ONE disclosed money point, the owner's word 20/11).
 *
 * `consumeOrderStock` — the one function all six delivery doors share — takes an order's units from the warehouse the
 * order left from (`Order.sourceWarehouseId`), then the store's other warehouses, then the rows with no warehouse; every
 * unit taken elsewhere is said («فرق مكان») on the SALE line and in one order activity; the SALE line carries the
 * warehouse. An order with no source warehouse draws exactly as `osm/main` does.
 *
 *   1. MAIN'S ANSWERS, FROZEN (`stock-consumption.w4b-main-golden.json`): what `git show osm/main:src/lib/stock-consumption.ts`
 *      and `…/receiving.ts` wrote for 4,500 random stores, three kinds of 1,500:
 *        · UNSOURCED — orders without a source warehouse, in stores with placed, unplaced, split and on-the-road rows:
 *          every result, every write, every row, to the bit.
 *        · ONE WAREHOUSE — a store whose every shelf row is in its one warehouse; orders sourced from it (or not): the
 *          same, to the bit — the SALE line only gains its `warehouseId`.
 *        · FIXED COST — several warehouses, every product with a fixed figure, orders sourced anywhere: the order's cost,
 *          the units taken and short, the movements' units and balances, the short-shelf lines, the reservations and the
 *          per-product batch totals (Σ remaining, Σ sold, Σ produced) are main's.
 *      To record again (only when main's own behaviour changes): put main's two files, with their `./` imports pointed at
 *      this folder, in a directory and run this file with `W4B_MAIN_DIR=<that directory>`.
 *   2. THE NEW ORDER, AGAINST AN ORACLE WRITTEN HERE: which batch each unit leaves, conservation, the note, the activity,
 *      units on the road never taken, another store never touched.
 *   3. THE EDGE CASES of the row: partial delivery, parcel swap, lost-parcel write-off, a stopped warehouse, the replay.
 *   4. THE WORKED EXAMPLE of the PR body: a product without a fixed cost, one order, today vs now.
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
    if ('not' in c && (c.not === null ? v === null || v === undefined : v === c.not)) return false;
    if ('gt' in c && !((v as number) > c.gt)) return false;
    return true;
  }
  return v === cond;
}

const RELATIONS: Record<string, Record<string, (data: Data, row: Row) => Row[] | Row | null>> = {
  order: {
    items: (data, row) => data.orderItem.filter((i) => i.orderId === row.id),
    addOns: (data, row) => data.orderAddOn.filter((i) => i.orderId === row.id),
    store: (data, row) => data.store.find((s) => s.id === row.storeId) ?? null,
  },
  store: { country: (_data, row) => ({ minorUnit: row.minorUnit }) },
};

function makeDb(data: Data) {
  const writes: Row[] = [];
  let seq = 0;
  const matches = (row: Row, where: Row = {}) => Object.entries(where).every(([k, c]) => c === undefined || scalarMatches(row[k], c));
  const project = (table: string, r: Row, select?: Row): Row => {
    if (!select) return { ...r };
    const out: Row = {};
    for (const [k, v] of Object.entries(select)) {
      if (v === true) out[k] = r[k];
      else if (v && typeof v === 'object') {
        const rel = RELATIONS[table]?.[k];
        if (!rel) throw new Error(`relation ${table}.${k}`);
        const got = rel(data, r);
        const sub = k === 'store' ? 'store' : k === 'country' ? 'country' : k === 'items' ? 'orderItem' : 'orderAddOn';
        out[k] = Array.isArray(got) ? got.map((g) => project(sub, g, v.select)) : got ? project(sub, got, v.select) : null;
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
  const table = (name: string) => {
    const rows = () => (data[name] ??= []);
    return {
      findMany: async ({ where, select, orderBy }: Row = {}) => sortBy(rows().filter((r) => matches(r, where)), orderBy).map((r) => project(name, r, select)),
      findFirst: async ({ where, select }: Row = {}) => {
        const r = rows().find((x) => matches(x, where));
        return r ? project(name, r, select) : null;
      },
      create: async ({ data: d }: Row) => {
        const row: Row = { id: `${name}-${++seq}`, ...d };
        rows().push(row);
        writes.push({ t: name, op: 'create', data: { ...d } });
        return { ...row };
      },
      update: async ({ where, data: d }: Row) => {
        const r = rows().find((x) => matches(x, where));
        if (!r) throw new Prisma.PrismaClientKnownRequestError('No record was found for an update.', { code: 'P2025', clientVersion: 'test' });
        Object.assign(r, d);
        writes.push({ t: name, op: 'update', id: r.id, data: { ...d } });
        return { ...r };
      },
      updateMany: async ({ where, data: d }: Row) => {
        const hit = rows().filter((r) => matches(r, where));
        for (const r of hit) Object.assign(r, d);
        writes.push({ t: name, op: 'updateMany', where: JSON.stringify(where), count: hit.length, data: { ...d } });
        return { count: hit.length };
      },
      aggregate: async ({ where, _sum }: Row) => {
        const hit = rows().filter((x) => matches(x, where));
        return { _sum: Object.fromEntries(Object.keys(_sum).map((k) => [k, hit.reduce((s, r) => s + r[k], 0)])) };
      },
    };
  };
  const names = ['productionBatch', 'inventoryMovement', 'orderActivity', 'order', 'orderItem', 'orderAddOn', 'productFixedCost', 'warehouse', 'store'];
  const delegates: Row = Object.fromEntries(names.map((t) => [t, table(t)]));
  const tx = new Proxy(delegates, {
    get(target, prop) {
      if (typeof prop === 'string' && !(prop in target) && prop !== 'then') throw new Error(`the delivery touched «${prop}»`);
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
type Kind = 'UNSOURCED' | 'ONE_WAREHOUSE' | 'FIXED_COST' | 'MIXED';

function randomStore(seed: number, kind: Kind) {
  const r = rng(seed * 104729 + kind.length);
  const int = (n: number) => Math.floor(r() * n);
  const pick = <T,>(xs: readonly T[]) => xs[int(xs.length)];
  const days = [0, 1, 2, 5, 9].map((d) => new Date(Date.UTC(2026, 9, 1 + d)));
  const warehouses = kind === 'ONE_WAREHOUSE' ? ['w1'] : ['w1', 'w2', 'w3'].slice(0, 2 + int(2));
  const data: Data = {
    store: [{ id: S, companyId: C, minorUnit: pick([2, 2, 3, 0]) }, { id: 's2', companyId: C, minorUnit: 2 }],
    warehouse: [
      ...warehouses.map((id, i) => ({ id, companyId: C, name: `مخزن ${i + 1}`, isActive: !(i === 2 && r() < 0.5) })),
      { id: 'w9', companyId: C, name: 'مخزن متوقف فاضي', isActive: false },
    ],
    productionBatch: [],
    inventoryMovement: [],
    orderActivity: [],
    order: [],
    orderItem: [],
    orderAddOn: [],
    productFixedCost: [],
  };
  let created = 0;
  const nProducts = 1 + int(4);
  for (let p = 0; p < nProducts; p++) {
    const productId = `p${p}`;
    if (kind === 'FIXED_COST' || (kind !== 'ONE_WAREHOUSE' && r() < 0.3) || (kind === 'ONE_WAREHOUSE' && r() < 0.3)) {
      data.productFixedCost.push({ companyId: C, productId, amount: r() < 0.1 ? 0 : Math.round(r() * 90000) / 10000 });
    }
    const parents: Row[] = [];
    for (let b = int(6); b > 0; b--) {
      const remaining = int(14);
      const cost = r() < 0.12 ? 0 : Math.round(r() * 100000) / 10000;
      const onRoad = kind !== 'ONE_WAREHOUSE' && r() < 0.12;
      const place = onRoad ? null : kind === 'ONE_WAREHOUSE' ? 'w1' : r() < 0.25 ? null : pick(warehouses);
      const parent = parents.length > 0 && r() < 0.25 ? pick(parents) : null;
      const row: Row = {
        id: `b${p}-${b}`,
        companyId: C,
        storeId: r() < 0.08 ? 's2' : S,
        productId,
        quantityProduced: parent ? 0 : remaining + int(5),
        quantityMovedIn: parent ? remaining : 0,
        quantityMovedOut: 0,
        quantityRemaining: remaining,
        quantitySold: 0,
        costPerUnit: parent ? parent.costPerUnit : cost,
        productionDate: parent ? parent.productionDate : pick(days),
        createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, ++created)),
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
  const nOrders = 1 + int(6);
  for (let o = 0; o < nOrders; o++) {
    const id = `o${o}`;
    const legacy = r() < 0.06;
    const sources = kind === 'UNSOURCED' ? [null] : kind === 'ONE_WAREHOUSE' ? ['w1', 'w1', null] : [...warehouses, 'w9', null];
    data.order.push({
      id,
      companyId: C,
      orderNumber: `ORD-${seed}-${o}`,
      storeId: r() < 0.9 ? S : 's2',
      sourceWarehouseId: pick(sources),
      source: legacy ? 'Legacy import' : 'Manual',
      estimatedCostOfGoods: 11.11,
    });
    for (let i = 1 + int(3); i > 0; i--) {
      const quantity = int(7);
      data.orderItem.push({
        id: `oi${o}-${i}`, orderId: id, productId: `p${int(nProducts)}`, productName: `منتج`, quantity,
        freeQuantity: r() < 0.3 ? 1 + int(2) : 0, reservedQty: legacy ? 0 : quantity, variantSummary: null,
      });
    }
    if (r() < 0.3) data.orderAddOn.push({ id: `oa${o}`, orderId: id, productId: `p${int(nProducts)}`, productName: 'إضافة', quantity: 1 + int(3), reservedQty: 1 });
  }
  const calls = data.order.map((o) => o.id);
  for (let k = int(3); k > 0; k--) calls.push(pick(calls)); // a second door, the replay
  return { data, calls };
}

/* ───────────── what one store records ───────────── */

type Consume = typeof consumeOrderStock;

async function run(consume: Consume, data: Data, calls: string[]) {
  const { tx, writes } = makeDb(data);
  const results: Row[] = [];
  for (const orderId of calls) results.push(await consume(tx, { orderId, companyId: C, userId: 'u1' }));
  return { results, writes };
}

const strip = (w: Row): Row => {
  if (w.t !== 'inventoryMovement') return w;
  const { warehouseId: _drop, ...rest } = w.data;
  void _drop;
  return { ...w, data: rest };
};

/** Every result, write and row — the whole of what main did. (For one warehouse the SALE line's new `warehouseId` is taken off.) */
function fullView(data: Data, out: { results: Row[]; writes: Row[] }) {
  return {
    results: out.results,
    writes: out.writes.map(strip),
    batches: data.productionBatch.map((b) => [b.id, b.quantityRemaining, b.quantitySold]),
    orders: data.order.map((o) => [o.id, o.estimatedCostOfGoods]),
    items: [...data.orderItem, ...data.orderAddOn].map((i) => [i.id, i.reservedQty]),
  };
}

/** What a FIXED-cost product must keep: the order's cost, the units, the movements' figures, the short lines, the totals. */
function fixedView(data: Data, out: { results: Row[]; writes: Row[] }) {
  const totals = new Map<string, number[]>();
  for (const b of data.productionBatch) {
    const t = totals.get(b.productId) ?? [0, 0, 0];
    t[0] += b.quantityRemaining;
    t[1] += b.quantitySold;
    t[2] += b.quantityProduced;
    totals.set(b.productId, t);
  }
  return {
    results: out.results.map(({ cost: _c, ...rest }) => (void _c, rest)),
    movements: out.writes
      .filter((w) => w.t === 'inventoryMovement')
      .map((w) => [w.data.type, w.data.productId, w.data.quantity, w.data.balanceAfter, w.data.referenceId, w.data.storeId]),
    shortLines: out.writes.filter((w) => w.t === 'orderActivity' && w.data.action === STOCK_SHORT_ACTION).map((w) => w.data.metadata),
    costs: out.writes.filter((w) => w.t === 'order').map((w) => [w.id, w.data]),
    orders: data.order.map((o) => [o.id, o.estimatedCostOfGoods]),
    items: [...data.orderItem, ...data.orderAddOn].map((i) => [i.id, i.reservedQty]),
    totals: [...totals].sort(([a], [b]) => (a < b ? -1 : 1)),
  };
}

const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 24);
const KINDS: Exclude<Kind, 'MIXED'>[] = ['UNSOURCED', 'ONE_WAREHOUSE', 'FIXED_COST'];
const PER_KIND = 1500;

async function record(consume: Consume) {
  const out: Record<string, string[]> = {};
  for (const kind of KINDS) {
    out[kind] = [];
    for (let seed = 1; seed <= PER_KIND; seed++) {
      const { data, calls } = randomStore(seed, kind);
      const done = await run(consume, data, calls);
      out[kind].push(kind === 'FIXED_COST' ? hash(fixedView(data, done)) : hash(fullView(data, done)));
    }
  }
  return out;
}

const GOLDEN = join(__dirname, 'stock-consumption.w4b-main-golden.json');
const MAIN_DIR = process.env.W4B_MAIN_DIR;

describe.runIf(MAIN_DIR)('recording osm/main (only with W4B_MAIN_DIR)', () => {
  it('writes the golden file from main’s consumeOrderStock', async () => {
    const main = await import(/* @vite-ignore */ `${MAIN_DIR}/stock-consumption.ts`);
    writeFileSync(GOLDEN, JSON.stringify(await record(main.consumeOrderStock)) + '\n');
  }, 600_000);
});

/* ───────────── 1. main's answers ───────────── */

describe('osm/main’s answers, frozen: 4,500 random stores', () => {
  const golden = (() => {
    try {
      return JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, string[]>;
    } catch {
      return null;
    }
  })();

  for (const kind of KINDS) {
    it.skipIf(MAIN_DIR)(`${kind}: ${PER_KIND} stores give main’s answer`, async () => {
      expect(golden?.[kind]).toHaveLength(PER_KIND);
      const differ: number[] = [];
      for (let seed = 1; seed <= PER_KIND; seed++) {
        const { data, calls } = randomStore(seed, kind);
        const done = await run(consumeOrderStock, data, calls);
        const view = kind === 'FIXED_COST' ? fixedView(data, done) : fullView(data, done);
        if (hash(view) !== golden![kind][seed - 1]) differ.push(seed);
        if (kind === 'ONE_WAREHOUSE') {
          // …and its SALE lines carry the warehouse the order left from — the only thing added.
          for (const w of done.writes.filter((x) => x.t === 'inventoryMovement')) {
            const order = data.order.find((o) => o.id === w.data.referenceId)!;
            expect(w.data.warehouseId).toBe(order.sourceWarehouseId ?? undefined);
            expect(w.data.reason).toBe(`تسليم الطلب ${order.orderNumber}`);
          }
        }
      }
      expect(differ, `seeds that differ from main: ${differ.slice(0, 10).join(', ')}`).toEqual([]);
    }, 120_000);
  }

  it('the stores are not trivial: they draw, run short, replay, split and keep units on the road', async () => {
    let sourcedDraws = 0;
    let differences = 0;
    let shorts = 0;
    let replays = 0;
    let roads = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const { data, calls } = randomStore(seed, 'FIXED_COST');
      roads += data.productionBatch.filter((b) => b.inTransitTransferId).length;
      const done = await run(consumeOrderStock, data, calls);
      replays += done.results.filter((x) => x.alreadyDone).length;
      shorts += done.results.filter((x) => x.short > 0).length;
      sourcedDraws += done.writes.filter((w) => w.t === 'inventoryMovement' && w.data.warehouseId).length;
      differences += done.writes.filter((w) => w.t === 'orderActivity' && w.data.action === STOCK_PLACE_DIFFERENCE_ACTION).length;
    }
    expect(Math.min(sourcedDraws, differences, shorts, replays, roads)).toBeGreaterThan(20);
  });
});

/* ───────────── 2. the new order, against an oracle written here ───────────── */

/** Which units each batch gives, computed here from the rows alone: source → other warehouses → no warehouse, oldest first. */
function oracle(data: Data, order: Row, productId: string, need: number) {
  const tier = (b: Row) => (order.sourceWarehouseId && b.warehouseId === order.sourceWarehouseId ? 0 : b.warehouseId ? 1 : 2);
  const rows = data.productionBatch
    .filter((b) => b.companyId === C && b.productId === productId && b.quantityRemaining > 0 && b.inTransitTransferId === null && (!order.storeId || b.storeId === order.storeId))
    .sort((a, b) => (order.sourceWarehouseId ? tier(a) - tier(b) : 0) || a.productionDate - b.productionDate || a.createdAt - b.createdAt);
  const takes: { id: string; take: number; warehouseId: string | null; cost: number }[] = [];
  let left = need;
  for (const b of rows) {
    if (left <= 0) break;
    const take = Math.min(left, b.quantityRemaining);
    takes.push({ id: b.id, take, warehouseId: b.warehouseId, cost: b.costPerUnit });
    left -= take;
  }
  return takes;
}

describe('the new order: the source warehouse, then the others, then no warehouse — against an oracle', () => {
  it('3,000 random stores of mixed products: every batch gives what the oracle says; units, value and the identity conserved', async () => {
    let elsewhereSeen = 0;
    for (let seed = 1; seed <= 3000; seed++) {
      const { data, calls } = randomStore(seed, 'MIXED');
      const { tx, writes } = makeDb(data);
      const seen = new Set<string>();
      for (const orderId of calls) {
        const order = data.order.find((o) => o.id === orderId)!;
        const before = structuredClone(data.productionBatch);
        const expected = new Map<string, number>();
        // Per line of the parcel, in its order: the units it takes, and how many of them are not from the source.
        const perLine: { taken: number; away: number }[] = [];
        const replay = seen.has(orderId);
        seen.add(orderId);
        const legacy = order.source === 'Legacy import' && data.orderItem.filter((i) => i.orderId === orderId).every((i) => (i.reservedQty ?? 0) === 0);
        let valueOut = 0;
        if (!replay && !legacy) {
          // The oracle runs line by line on a copy, the same lines the delivery takes.
          const shadow: Data = { ...data, productionBatch: structuredClone(data.productionBatch) };
          const lines = [...data.orderItem.filter((i) => i.orderId === orderId), ...data.orderAddOn.filter((a) => a.orderId === orderId).map((a): Row => ({ ...a, freeQuantity: 0 }))];
          for (const line of lines) {
            const one = { taken: 0, away: 0 };
            perLine.push(one);
            for (const t of oracle(shadow, order, line.productId, line.quantity + line.freeQuantity)) {
              expected.set(t.id, (expected.get(t.id) ?? 0) + t.take);
              valueOut += t.take * t.cost;
              shadow.productionBatch.find((b) => b.id === t.id)!.quantityRemaining -= t.take;
              one.taken += t.take;
              if (order.sourceWarehouseId && t.warehouseId !== order.sourceWarehouseId) one.away += t.take;
            }
          }
        }
        const mark = writes.length;
        await consumeOrderStock(tx, { orderId, companyId: C, userId: 'u1' });
        const mine = writes.slice(mark);
        for (const b of data.productionBatch) {
          const was = before.find((x) => x.id === b.id)!;
          const took = was.quantityRemaining - b.quantityRemaining;
          expect(took, `seed ${seed} ${orderId} ${b.id}`).toBe(expected.get(b.id) ?? 0);
          expect(b.quantitySold - was.quantitySold).toBe(took);
          expect([b.quantityProduced, b.quantityMovedIn, b.quantityMovedOut]).toEqual([was.quantityProduced, was.quantityMovedIn, was.quantityMovedOut]);
          expect(b.quantityRemaining).toBe(b.quantityProduced + b.quantityMovedIn - b.quantitySold - b.quantityMovedOut);
          if (b.inTransitTransferId || b.storeId !== (order.storeId ?? b.storeId)) expect(took).toBe(0);
        }
        const valueBefore = before.reduce((s, b) => s + b.quantityRemaining * b.costPerUnit, 0);
        const valueAfter = data.productionBatch.reduce((s, b) => s + b.quantityRemaining * b.costPerUnit, 0);
        expect(valueBefore - valueAfter).toBeCloseTo(valueOut, 6);
        // «فرق مكان»: on the SALE line of each product that had units elsewhere, and one activity when any did.
        const activity = mine.filter((w) => w.t === 'orderActivity' && w.data.action === STOCK_PLACE_DIFFERENCE_ACTION);
        const awayUnits = perLine.reduce((s, l) => s + l.away, 0);
        expect(activity, `seed ${seed} ${orderId}`).toHaveLength(awayUnits > 0 ? 1 : 0);
        if (awayUnits > 0) {
          elsewhereSeen++;
          const meta = JSON.parse(activity[0].data.metadata);
          expect(meta.units).toBe(awayUnits);
          expect(meta.lines).toHaveLength(perLine.filter((l) => l.away > 0).length);
          expect(meta.sourceWarehouseId).toBe(order.sourceWarehouseId);
        }
        // One SALE line per line of the parcel that took anything, in the parcel's order.
        const sales = mine.filter((x) => x.t === 'inventoryMovement');
        const moved = perLine.filter((l) => l.taken > 0);
        expect(sales).toHaveLength(moved.length);
        sales.forEach((w, k) => {
          expect(w.data.type).toBe('SALE');
          expect(w.data.quantity).toBe(-moved[k].taken);
          expect(w.data.warehouseId).toBe(order.sourceWarehouseId ?? undefined);
          expect(w.data.reason.includes('فرق مكان')).toBe(moved[k].away > 0);
        });
        if (replay) {
          expect(mine.filter((w) => w.t === 'productionBatch' || w.t === 'inventoryMovement')).toEqual([]);
        }
      }
    }
    expect(elsewhereSeen).toBeGreaterThan(300);
  }, 180_000);

  it('the sort inside the draw is stable: inside each place the read’s own order — oldest first — stands', () => {
    const rows = [
      { id: 'a', warehouseId: null },
      { id: 'b', warehouseId: 'w2' },
      { id: 'c', warehouseId: 'w1' },
      { id: 'd', warehouseId: 'w2' },
      { id: 'e', warehouseId: 'w1' },
      { id: 'f', warehouseId: null },
    ];
    expect(preferring(rows, 'w1').map((r) => r.id)).toEqual(['c', 'e', 'b', 'd', 'a', 'f']);
    expect(preferring(rows, 'w2').map((r) => r.id)).toEqual(['b', 'd', 'c', 'e', 'a', 'f']);
  });

  it('a draw without `prefer` answers exactly as before — no `places`, and `warehouseId` is not even read', async () => {
    const data: Data = { productionBatch: [batch('A', 'w2', 5, 3, 1), batch('B', 'w1', 5, 4.5, 2)] };
    const asked: Row[] = [];
    const db = makeDb(data);
    const tx = { productionBatch: { ...(db.tx as Row).productionBatch, findMany: async (a: Row) => (asked.push(a), (db.tx as Row).productionBatch.findMany(a)) } } as never;
    const out = await drawDownStock(tx, { companyId: C, storeId: S, productId: 'p0', quantity: 2, allowNegative: true });
    expect(out).toEqual({ taken: 2, short: 0, cost: 6 });
    expect(asked[0].select.warehouseId).toBeUndefined();
  });
});

/* ───────────── 3. the edge cases ───────────── */

function batch(id: string, warehouseId: string | null, remaining: number, cost: number, day: number, extra: Row = {}): Row {
  return {
    id, companyId: C, storeId: S, productId: 'p0', quantityProduced: remaining, quantityMovedIn: 0, quantityMovedOut: 0,
    quantityRemaining: remaining, quantitySold: 0, costPerUnit: cost, productionDate: new Date(Date.UTC(2026, 9, day)),
    createdAt: new Date(Date.UTC(2026, 9, day)), warehouseId, inTransitTransferId: null, splitFromBatchId: null, ...extra,
  };
}

function shop(batches: Row[], order: Row = {}, figures: Row[] = []): Data {
  return {
    store: [{ id: S, companyId: C, minorUnit: 2 }],
    warehouse: [
      { id: 'w1', companyId: C, name: 'مخزن الشمال', isActive: true },
      { id: 'w2', companyId: C, name: 'مخزن الجنوب', isActive: true },
      { id: 'w3', companyId: C, name: 'مخزن موقوف', isActive: false },
    ],
    productionBatch: batches,
    inventoryMovement: [],
    orderActivity: [],
    order: [{ id: 'o1', companyId: C, orderNumber: 'ORD-1', storeId: S, sourceWarehouseId: 'w1', source: 'Manual', estimatedCostOfGoods: 99, ...order }],
    orderItem: [{ id: 'i1', orderId: 'o1', productId: 'p0', productName: 'كريم', quantity: 2, freeQuantity: 0, reservedQty: 2, variantSummary: null }],
    orderAddOn: [],
    productFixedCost: figures,
  };
}

const deliver = async (data: Data) => {
  const db = makeDb(data);
  const res = await consumeOrderStock(db.tx, { orderId: 'o1', companyId: C, userId: 'u1' });
  return { res, writes: db.writes, sale: data.inventoryMovement[0], activity: data.orderActivity.find((a) => a.action === STOCK_PLACE_DIFFERENCE_ACTION) };
};

describe('the worked example of the PR body — a product WITHOUT a fixed cost', () => {
  // On the shelf: 10 units in «مخزن الجنوب» bought on 1/10 at 3.00, 10 units in «مخزن الشمال» bought on 5/10 at 4.50.
  // The order left from «مخزن الشمال» with 2 units.
  const rows = () => [batch('A', 'w2', 10, 3, 1), batch('B', 'w1', 10, 4.5, 5)];

  it('today (no source warehouse): the store’s oldest — 2 × 3.00 = 6.00, out of «مخزن الجنوب»', async () => {
    const data = shop(rows(), { sourceWarehouseId: null });
    const { res } = await deliver(data);
    expect(data.order[0].estimatedCostOfGoods).toBe(6);
    expect(res.cost).toBe(6);
    expect(data.productionBatch.map((b) => b.quantityRemaining)).toEqual([8, 10]);
  });

  it('now (it left from «مخزن الشمال»): 2 × 4.50 = 9.00, out of «مخزن الشمال» — the order’s cost is 3.00 higher', async () => {
    const data = shop(rows());
    const { res, sale, activity } = await deliver(data);
    expect(data.order[0].estimatedCostOfGoods).toBe(9);
    expect(res.cost).toBe(9);
    expect(data.productionBatch.map((b) => b.quantityRemaining)).toEqual([10, 8]);
    expect(sale).toMatchObject({ type: 'SALE', quantity: -2, warehouseId: 'w1', reason: 'تسليم الطلب ORD-1', balanceAfter: 18 });
    expect(activity).toBeUndefined();
  });

  it('the stock value moves by the same 3.00 the other way, and over the twenty units the money is the same: 75.00', async () => {
    const today = shop(rows(), { sourceWarehouseId: null });
    const now = shop(rows());
    await deliver(today);
    await deliver(now);
    const value = (d: Data) => d.productionBatch.reduce((s, b) => s + b.quantityRemaining * b.costPerUnit, 0);
    expect(value(today)).toBe(69); // 8 × 3 + 10 × 4.5
    expect(value(now)).toBe(66); // 10 × 3 + 8 × 4.5
    expect(6 + value(today)).toBe(9 + value(now));
  });

  it('WITH a fixed figure of 4.00 the order costs 8.00 either way', async () => {
    const fig = [{ companyId: C, productId: 'p0', amount: 4 }];
    const today = shop(rows(), { sourceWarehouseId: null }, fig);
    const now = shop(rows(), {}, fig);
    await deliver(today);
    await deliver(now);
    expect([today.order[0].estimatedCostOfGoods, now.order[0].estimatedCostOfGoods]).toEqual([8, 8]);
  });
});

describe('«فرق مكان» — units taken elsewhere are said, on the line and once on the order', () => {
  it('a short source: 1 from «مخزن الشمال», 3 from «مخزن الجنوب», 1 with no warehouse — one SALE line of 5 with the note', async () => {
    const data = shop([batch('U', null, 4, 2, 1), batch('S2', 'w2', 3, 3, 2), batch('S1', 'w1', 1, 5, 9)]);
    data.orderItem[0].quantity = 5;
    const { res, sale, activity } = await deliver(data);
    expect(res).toMatchObject({ taken: 5, short: 0 });
    expect(data.productionBatch.map((b) => b.quantityRemaining)).toEqual([3, 0, 0]);
    expect(data.inventoryMovement).toHaveLength(1);
    expect(sale).toMatchObject({ quantity: -5, warehouseId: 'w1', reason: 'تسليم الطلب ORD-1 — فرق مكان: 3 من «مخزن الجنوب» · 1 بلا مكان — مش من «مخزن الشمال»' });
    const meta = JSON.parse(activity!.metadata);
    expect(meta).toMatchObject({ order: 'ORD-1', sourceWarehouseId: 'w1', sourceWarehouseName: 'مخزن الشمال', units: 4 });
    expect(meta.lines).toEqual([
      { productId: 'p0', productName: 'كريم', fromSource: 1, elsewhere: [{ warehouseId: 'w2', units: 3, warehouseName: 'مخزن الجنوب' }, { warehouseId: null, units: 1, warehouseName: null }] },
    ]);
    // 1 × 5 + 3 × 3 + 1 × 2 = 16
    expect(data.order[0].estimatedCostOfGoods).toBe(16);
  });

  it('AN ORDER WHOSE WAREHOUSE WAS STOPPED: nothing is there, so all of it is a place difference — and it is still delivered', async () => {
    const data = shop([batch('A', 'w2', 5, 3, 1)], { sourceWarehouseId: 'w3' });
    const { res, sale, activity } = await deliver(data);
    expect(res).toMatchObject({ taken: 2, short: 0 });
    expect(sale.reason).toBe('تسليم الطلب ORD-1 — فرق مكان: 2 من «مخزن الجنوب» — مش من «مخزن موقوف»');
    expect(JSON.parse(activity!.metadata).units).toBe(2);
  });

  it('UNITS ON THE ROAD ARE NEVER TAKEN, even the oldest, even for an order of the destination: short instead', async () => {
    const data = shop([batch('T', null, 9, 1, 1, { inTransitTransferId: 't1' }), batch('A', 'w1', 1, 3, 2)]);
    const { res, activity } = await deliver(data);
    expect(res).toMatchObject({ taken: 1, short: 1 });
    expect(data.productionBatch[0].quantityRemaining).toBe(9);
    expect(activity).toBeUndefined();
    expect(data.orderActivity.filter((a) => a.action === STOCK_SHORT_ACTION)).toHaveLength(1);
  });

  it('ANOTHER STORE’S warehouse rows are never taken', async () => {
    const data = shop([batch('X', 'w1', 9, 1, 1, { storeId: 's2' }), batch('A', 'w2', 9, 3, 2)]);
    await deliver(data);
    expect(data.productionBatch.map((b) => b.quantityRemaining)).toEqual([9, 7]);
  });

  it('THE REPLAY: a second door finds the SALE line and takes nothing — no second note, no second activity', async () => {
    const data = shop([batch('A', 'w2', 9, 3, 1)]);
    const db = makeDb(data);
    await consumeOrderStock(db.tx, { orderId: 'o1', companyId: C });
    const again = await consumeOrderStock(db.tx, { orderId: 'o1', companyId: C });
    expect(again.alreadyDone).toBe(true);
    expect(data.productionBatch[0].quantityRemaining).toBe(7);
    expect(data.inventoryMovement).toHaveLength(1);
    expect(data.orderActivity.filter((a) => a.action === STOCK_PLACE_DIFFERENCE_ACTION)).toHaveLength(1);
  });

  it('AN EMPTY SHELF with a source: short, no SALE line, no place difference — and the review line still blocks a second take', async () => {
    const data = shop([]);
    const db = makeDb(data);
    await consumeOrderStock(db.tx, { orderId: 'o1', companyId: C });
    data.productionBatch.push(batch('NEW', 'w2', 5, 3, 3));
    const again = await consumeOrderStock(db.tx, { orderId: 'o1', companyId: C });
    expect(again.alreadyDone).toBe(true);
    expect(data.productionBatch[0].quantityRemaining).toBe(5);
    expect(data.orderActivity.map((a) => a.action)).toEqual([STOCK_SHORT_ACTION]);
  });

  it('ANOTHER DOOR TOOK UNITS between the read and the write: the draw reads again, and the places count only what landed', async () => {
    const data = shop([batch('A', 'w1', 5, 3, 1), batch('B', 'w2', 5, 4, 2)]);
    const db = makeDb(data);
    const base = (db.tx as Row).productionBatch;
    let raced = false;
    const tx = new Proxy(db.tx as Row, {
      get(target, prop) {
        if (prop !== 'productionBatch') return target[prop as string];
        return {
          ...base,
          update: async (a: Row) => {
            if (!raced) {
              raced = true;
              // A delivery of another order took 4 of A's 5 and committed.
              Object.assign(data.productionBatch[0], { quantityRemaining: 1, quantitySold: 4 });
            }
            return base.update(a);
          },
        };
      },
    });
    const res = await consumeOrderStock(tx as never, { orderId: 'o1', companyId: C });
    expect(res).toMatchObject({ taken: 2, short: 0 });
    expect(data.productionBatch.map((b) => [b.quantityRemaining, b.quantitySold])).toEqual([[0, 5], [4, 1]]);
    expect(data.inventoryMovement[0].reason).toBe('تسليم الطلب ORD-1 — فرق مكان: 1 من «مخزن الجنوب» — مش من «مخزن الشمال»');
    expect(data.order[0].estimatedCostOfGoods).toBe(7); // 1 × 3 + 1 × 4
  });

  it('THE PARCEL SWAP’s new order carries no source warehouse, so it draws as today — the store’s oldest', async () => {
    const data = shop([batch('A', 'w2', 5, 3, 1), batch('B', 'w1', 5, 4.5, 5)], { sourceWarehouseId: null });
    const { sale, activity } = await deliver(data);
    expect(data.productionBatch.map((b) => b.quantityRemaining)).toEqual([3, 5]);
    expect(sale.warehouseId).toBeUndefined();
    expect(activity).toBeUndefined();
  });
});

describe('all six delivery doors take this one path', () => {
  const DOORS = [
    'src/app/api/orders/[id]/route.ts',
    'src/app/api/orders/[id]/shipping/route.ts',
    'src/app/api/ops/tracking/write-off/route.ts',
    'src/lib/statement-close.ts',
    'src/lib/parcel-swap.ts',
    'src/lib/partial-delivery.ts',
  ];
  for (const file of DOORS) {
    it(`${file} delivers through consumeOrderStock and draws nothing itself`, () => {
      const src = stripComments(repoFile(file));
      expect(src).toMatch(/\bconsumeOrderStock\(/);
      expect(src).not.toMatch(/\bprefer\s*:/);
    });
  }

  /*
   * 20/11 (W2b — returns name a warehouse): old «no other caller of drawDownStock passes `prefer`»; new «only the delivery,
   * and the returns desk's broken and missing units of a PLACED store's refused parcel». The row W2b says those units are
   * «taken from the source warehouse first», which is exactly `prefer: source`; it is reached only when the desk named a
   * receiving warehouse (a placed store), so every other draw still prefers nothing. Still asserted: the delivery prefers
   * its source; the returns half prefers only behind `receiver`; nothing else in the file prefers.
   */
  it('and only the delivery — and a placed store’s returns desk — prefers a warehouse', () => {
    const src = stripComments(repoFile('src/lib/stock-consumption.ts'));
    const consume = src.slice(src.indexOf('export async function consumeOrderStock('), src.indexOf('export function absorbDamaged('));
    const takeOff = src.slice(src.indexOf('export async function takeOffUnreturned('), src.indexOf('async function moveReturnedUnits('));
    const rest = src.replace(consume, '').replace(takeOff, '');
    expect(consume).toMatch(/prefer: source/);
    expect(takeOff).toMatch(/receiver \? \(source \? \{ prefer: source \}/);
    expect(rest).not.toMatch(/prefer:/);
  });

  it('and the money it may write is the order’s cost only: no wallet, expense or profit is reached from these two files', () => {
    for (const f of ['src/lib/stock-consumption.ts', 'src/lib/receiving.ts']) {
      const src = repoFile(f);
      expect(src).not.toMatch(/from '\.\/(wallets|expenses|profit[^']*|finance[^']*)'/);
      expect(stripComments(src)).not.toMatch(/\b(walletMovement|wallet|expense)\.(create|update|upsert)/);
    }
  });
});

/* ───────────── the door-side delivery (partial delivery) and the lost-parcel write-off share the same rows ───────────── */

describe('a partial delivery and a written-off parcel take from the order’s warehouse too', () => {
  it('a PARTIAL delivery consumes the whole parcel (the refused units come back by the returns desk) — from the source first', async () => {
    const { recordPartialDelivery } = await import('./partial-delivery');
    const data = shop([batch('A', 'w2', 10, 3, 1), batch('B', 'w1', 3, 4.5, 5)]);
    data.orderItem[0].quantity = 4;
    data.orderItem[0].reservedQty = 4;
    const db = makeDb(data);
    const orderRow = {
      id: 'o1', orderNumber: 'ORD-1', shippingStatus: 'OUT_FOR_DELIVERY', deliveryFee: 0, priceIncludesDelivery: false,
      deliveredAt: null, returnedAt: null, customerId: 'cu1', deliveryProviderId: 'dp1',
      items: [{ id: 'i1', productId: 'p0', productName: 'كريم', quantity: 4, freeQuantity: 0, unitPrice: 10, discountShare: 0 }],
    };
    const base = db.tx as Row;
    const tx = {
      ...base,
      order: { ...base.order, findFirst: async (args: Row) => (args?.select?.deliveryFee ? orderRow : base.order.findFirst(args)), update: async (a: Row) => (a.data.estimatedCostOfGoods !== undefined ? base.order.update(a) : {}) },
      orderItem: { ...base.orderItem, update: async () => ({}) },
      orderNote: { create: async () => ({}) },
      customer: { update: async () => ({}) },
      deliveryAttempt: { create: async () => ({ id: 'a1' }), count: async () => 0, findFirst: async () => null, aggregate: async () => ({ _max: { attemptNumber: 0 } }) },
    };
    const out = await recordPartialDelivery(tx as never, { companyId: C, storeId: S, orderId: 'o1', minorUnit: 2, userId: 'u1', lines: [{ itemId: 'i1', deliveredQty: 2 }] });
    expect(out.status).toBe('PARTIALLY_DELIVERED');
    expect(data.productionBatch.map((b) => b.quantityRemaining)).toEqual([9, 0]);
    expect(data.inventoryMovement[0]).toMatchObject({ quantity: -4, warehouseId: 'w1' });
    expect(data.inventoryMovement[0].reason).toContain('فرق مكان: 1 من «مخزن الجنوب»');
  });

  it('the WRITE-OFF door hands the order to the same function with nothing of its own', () => {
    const src = stripComments(repoFile('src/app/api/ops/tracking/write-off/route.ts'));
    const at = src.indexOf('consumeOrderStock(');
    const arg = src.slice(src.indexOf('{', at), src.indexOf('}', at) + 1);
    expect(arg).not.toMatch(/warehouse|prefer|allowNegative/i);
  });
});
