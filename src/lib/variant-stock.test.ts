import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { drawDownVariants, restoreVariants } from './product-variants';
import { countPlan, countPlacedVariants, countReason, drawPlan, placesOfVariants, VARIANT_MOVE } from './variant-stock';

/**
 * A COMBINATION'S COUNT PER WAREHOUSE (the warehouse plan, W8a) — the lib.
 *
 *   1. Σ of a combination's places = its `onHand`, after EVERY change — and Σ of its ledger lines = its `onHand`.
 *   2. The total moves exactly as the store-level count always moved: a delivery takes `max(0, total − n)`, a return adds
 *      n, and a count changes the total only by what is beyond «بلا مكان» (going up) or by the shortage (going down).
 *      The expected total below is computed by a REFERENCE written here from those sentences — never by the code tested.
 *   3. A delivery takes the order's warehouse first, then «بلا مكان», then the fullest; a return lands where it is told,
 *      or «بلا مكان».
 *   4. `onHand` has ONE writer in a placed store: every write of it in this run is the sum the places held at that moment.
 *
 * The database is in memory. A store that is NOT placed is pinned separately, against main's own code
 * (`an-unplaced-store-counts-its-variants-as-before.test.ts`).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- an in-memory row; every field is read by name
type Row = Record<string, any>;

function scalar(v: unknown, c: unknown): boolean {
  if (c === null) return v === null || v === undefined;
  if (c && typeof c === 'object' && !Array.isArray(c)) {
    const o = c as Row;
    if ('in' in o && !(o.in as unknown[]).includes(v)) return false;
    if ('not' in o && (o.not === null ? v === null || v === undefined : v === o.not)) return false;
    return true;
  }
  return v === c;
}

function memoryDb(data: Record<string, Row[]>) {
  const writes: Row[] = [];
  let seq = 0;
  const matches = (r: Row, w: Row = {}) => Object.entries(w).every(([k, c]) => c === undefined || scalar(r[k], c));
  const pick = (r: Row, select?: Row) => (select ? Object.fromEntries(Object.keys(select).filter((k) => select[k] === true).map((k) => [k, r[k]])) : { ...r });
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
  const t = (name: string) => {
    const rows = () => (data[name] ??= []);
    return {
      findMany: async ({ where, select, orderBy }: Row = {}) => sortBy(rows().filter((r) => matches(r, where)), orderBy).map((r) => pick(r, select)),
      findFirst: async ({ where, select, orderBy }: Row = {}) => {
        const r = sortBy(rows().filter((x) => matches(x, where)), orderBy)[0];
        return r ? pick(r, select) : null;
      },
      findUnique: async ({ where, select }: Row) => {
        const r = rows().find((x) => matches(x, where));
        return r ? pick(r, select) : null;
      },
      aggregate: async ({ where, _sum }: Row) => {
        const hit = rows().filter((x) => matches(x, where));
        return { _sum: Object.fromEntries(Object.keys(_sum).map((k) => [k, hit.length ? hit.reduce((s, r) => s + r[k], 0) : null])) };
      },
      create: async ({ data: d, select }: Row) => {
        if (name === 'productVariantStock' && rows().some((r) => r.variantId === d.variantId && r.warehouseId === d.warehouseId)) {
          throw new Error('Unique constraint failed: one row per (combination, place)');
        }
        const row = { id: `${name}-${String(++seq).padStart(5, '0')}`, createdAt: new Date(seq), ...d };
        rows().push(row);
        writes.push({ table: name, op: 'create', data: { ...d } });
        return pick(row, select);
      },
      update: async ({ where, data: d }: Row) => {
        const r = rows().find((x) => matches(x, where));
        if (!r) throw new Error(`No ${name} for update`);
        const resolved: Row = {};
        for (const [k, v] of Object.entries(d)) resolved[k] = v && typeof v === 'object' && 'increment' in (v as Row) ? r[k] + (v as Row).increment : v;
        Object.assign(r, resolved);
        writes.push({ table: name, op: 'update', id: r.id, data: { ...d } });
        if (name === 'productVariant' && 'onHand' in d) {
          // THE ONE-WRITER WITNESS: what the places held for this combination at the very moment `onHand` was written.
          const places = (data.productVariantStock ?? []).filter((p) => p.variantId === r.id);
          writes.push({ table: 'witness', variantId: r.id, onHand: r.onHand, placesSum: places.length ? places.reduce((s, p) => s + p.onHand, 0) : null });
        }
        return { ...r };
      },
    };
  };
  const names = ['order', 'orderItemVariant', 'productVariant', 'productVariantStock', 'variantStockMovement', 'warehousePlacement', 'warehouse', 'store'];
  const db: Row = Object.fromEntries(names.map((n) => [n, t(n)]));
  const locks: string[][] = [];
  db.$queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    if (sql.includes('FROM "product_variants"') && sql.includes('FOR UPDATE')) locks.push(values[0] as string[]);
    if (sql.includes('FROM "warehouses"')) return (data.warehouse ?? []).filter((w) => w.id === values[0]);
    return [];
  };
  db.$executeRaw = async () => 1;
  return { db, writes, locks };
}

/* ───────────── a placed store ───────────── */

const W1 = 'w-1';
const W2 = 'w-2';
const W3 = 'w-3';

function placedStore(variants: { id: string; onHand: number }[], pieces: Row[] = [], sourceWarehouseId: string | null = null) {
  return memoryDb({
    warehousePlacement: [{ id: 'placing-1', storeId: 's-1' }],
    order: [{ id: 'o-1', companyId: 'c-1', storeId: 's-1', sourceWarehouseId }],
    productVariant: variants.map((v) => ({ id: v.id, companyId: 'c-1', productId: 'p-1', onHand: v.onHand })),
    orderItemVariant: pieces.map((x, i) => ({ id: `oiv-${i}`, orderId: 'o-1', productId: 'p-1', createdAt: new Date(i), ...x })),
  });
}

const sumPlaces = (data: Row[], variantId: string) => data.filter((p) => p.variantId === variantId).reduce((s, p) => s + p.onHand, 0);
const sumLedger = (data: Row[], variantId: string) => data.filter((p) => p.variantId === variantId).reduce((s, p) => s + p.quantity, 0);

function totals(db: Row) {
  const out: Row = {};
  return db.productVariant.findMany({}).then((vs: Row[]) =>
    Promise.all(
      vs.map(async (v) => {
        const places = await db.productVariantStock.findMany({ where: { variantId: v.id } });
        const lines = await db.variantStockMovement.findMany({ where: { variantId: v.id } });
        out[v.id] = { onHand: v.onHand, places: sumPlaces(places, v.id), ledger: sumLedger(lines, v.id), touched: places.length > 0, negative: places.some((p: Row) => p.onHand < 0) };
      })
    ).then(() => out)
  );
}

describe('the two plans, pure', () => {
  it('a delivery: the order’s warehouse first, then «بلا مكان», then the fullest (ties by id); never below zero', () => {
    const places = [
      { warehouseId: W1, onHand: 2 },
      { warehouseId: null, onHand: 3 },
      { warehouseId: W2, onHand: 5 },
      { warehouseId: W3, onHand: 5 },
    ];
    expect(drawPlan(places, 4, W1)).toEqual([{ warehouseId: W1, delta: -2 }, { warehouseId: null, delta: -2 }]);
    expect(drawPlan(places, 4, null)).toEqual([{ warehouseId: null, delta: -3 }, { warehouseId: W2, delta: -1 }]);
    expect(drawPlan(places, 9, null)).toEqual([{ warehouseId: null, delta: -3 }, { warehouseId: W2, delta: -5 }, { warehouseId: W3, delta: -1 }]);
    // More than every place holds: each place empties, none goes below zero, the rest is not taken.
    expect(drawPlan(places, 99, W3).reduce((s, m) => s + m.delta, 0)).toBe(-15);
    expect(drawPlan([{ warehouseId: W1, onHand: 0 }], 3, W1)).toEqual([]);
    expect(drawPlan(places, 0, null)).toEqual([]);
  });

  it('a count going up takes from «بلا مكان» first; beyond it is a surplus; going down is a shortage; equal is nothing', () => {
    const places = [{ warehouseId: null, onHand: 4 }, { warehouseId: W1, onHand: 2 }];
    expect(countPlan(places, W1, 5)).toEqual([{ warehouseId: W1, delta: 3 }, { warehouseId: null, delta: -3 }]);
    expect(countPlan(places, W1, 9)).toEqual([{ warehouseId: W1, delta: 7 }, { warehouseId: null, delta: -4 }]);
    expect(countPlan(places, W1, 1)).toEqual([{ warehouseId: W1, delta: -1 }]);
    expect(countPlan(places, W1, 2)).toEqual([]);
    expect(countPlan(places, W2, 3)).toEqual([{ warehouseId: W2, delta: 3 }, { warehouseId: null, delta: -3 }]);
    expect(countPlan([{ warehouseId: W1, onHand: 1 }], W2, 3)).toEqual([{ warehouseId: W2, delta: 3 }]);
  });

  it('a reason is three letters or more, trimmed; anything else is none', () => {
    expect(countReason('  جرد الرف  ')).toBe('جرد الرف');
    expect(countReason('ab')).toBeNull();
    expect(countReason(5)).toBeNull();
    expect(countReason(undefined)).toBeNull();
  });
});

describe('a placed store: the first touch, a delivery, a return', () => {
  it('the count a combination had becomes «بلا مكان» with an OPENING line — nothing invented, nothing lost', async () => {
    const { db } = placedStore([{ id: 'v-a', onHand: 7 }], [{ variantId: 'v-a', quantity: 2, freeQuantity: 0 }]);
    await drawDownVariants(db as never, 'o-1');
    const places = await db.productVariantStock.findMany({});
    expect(places.map((p: Row) => [p.warehouseId, p.onHand])).toEqual([[null, 5]]);
    const lines = await db.variantStockMovement.findMany({ orderBy: { createdAt: 'asc' } });
    expect(lines.map((l: Row) => [l.type, l.warehouseId, l.quantity, l.placeAfter, l.onHandAfter, l.orderId])).toEqual([
      [VARIANT_MOVE.OPENING, null, 7, 7, 7, null],
      [VARIANT_MOVE.SALE, null, -2, 5, 5, 'o-1'],
    ]);
    expect((await db.productVariant.findFirst({ where: { id: 'v-a' } })).onHand).toBe(5);
  });

  it('a delivery with no source warehouse (W4a not built): «بلا مكان», then the fullest warehouse', async () => {
    const { db } = placedStore([{ id: 'v-a', onHand: 0 }], [{ variantId: 'v-a', quantity: 3, freeQuantity: 1 }]);
    const data = db.productVariantStock;
    await data.create({ data: { companyId: 'c-1', variantId: 'v-a', warehouseId: null, onHand: 1 } });
    await data.create({ data: { companyId: 'c-1', variantId: 'v-a', warehouseId: W1, onHand: 2 } });
    await data.create({ data: { companyId: 'c-1', variantId: 'v-a', warehouseId: W2, onHand: 6 } });
    await db.productVariant.update({ where: { id: 'v-a' }, data: { onHand: 9 } });
    await drawDownVariants(db as never, 'o-1');
    const after = await db.productVariantStock.findMany({ orderBy: { id: 'asc' } });
    expect(after.map((p: Row) => [p.warehouseId, p.onHand])).toEqual([[null, 0], [W1, 2], [W2, 3]]);
    expect((await db.productVariant.findFirst({ where: { id: 'v-a' } })).onHand).toBe(5);
  });

  it('a delivery of an order that left from a warehouse takes from THAT warehouse first', async () => {
    const { db } = placedStore([{ id: 'v-a', onHand: 0 }], [{ variantId: 'v-a', quantity: 2, freeQuantity: 0 }], W1);
    await db.productVariantStock.create({ data: { companyId: 'c-1', variantId: 'v-a', warehouseId: null, onHand: 4 } });
    await db.productVariantStock.create({ data: { companyId: 'c-1', variantId: 'v-a', warehouseId: W1, onHand: 3 } });
    await db.productVariant.update({ where: { id: 'v-a' }, data: { onHand: 7 } });
    await drawDownVariants(db as never, 'o-1');
    const after = await db.productVariantStock.findMany({ orderBy: { id: 'asc' } });
    expect(after.map((p: Row) => [p.warehouseId, p.onHand])).toEqual([[null, 4], [W1, 1]]);
  });

  it('a return lands where the desk says (W2b) — or «بلا مكان», where the product’s own return batch lands today', async () => {
    const one = placedStore([{ id: 'v-a', onHand: 0 }], [{ variantId: 'v-a', quantity: 2, freeQuantity: 1 }]);
    await restoreVariants(one.db as never, { orderId: 'o-1', productId: 'p-1', take: 3 });
    expect((await one.db.productVariantStock.findMany({})).map((p: Row) => [p.warehouseId, p.onHand])).toEqual([[null, 3]]);
    const two = placedStore([{ id: 'v-a', onHand: 4 }], [{ variantId: 'v-a', quantity: 2, freeQuantity: 0 }]);
    await restoreVariants(two.db as never, { orderId: 'o-1', productId: 'p-1', take: 2, warehouseId: W2 });
    expect((await two.db.productVariantStock.findMany({ orderBy: { id: 'asc' } })).map((p: Row) => [p.warehouseId, p.onHand])).toEqual([[null, 4], [W2, 2]]);
    expect((await two.db.productVariant.findFirst({ where: { id: 'v-a' } })).onHand).toBe(6);
    const lines = await two.db.variantStockMovement.findMany({ where: { type: VARIANT_MOVE.RETURN } });
    expect(lines.map((l: Row) => [l.warehouseId, l.quantity, l.orderId])).toEqual([[W2, 2, 'o-1']]);
  });

  it('a partial return restores the first pieces of the line, as before — only the place is new', async () => {
    const { db } = placedStore(
      [{ id: 'v-a', onHand: 0 }, { id: 'v-b', onHand: 0 }],
      [{ variantId: 'v-a', quantity: 1, freeQuantity: 0 }, { variantId: 'v-b', quantity: 2, freeQuantity: 0 }]
    );
    await restoreVariants(db as never, { orderId: 'o-1', productId: 'p-1', take: 2 });
    expect((await db.productVariant.findFirst({ where: { id: 'v-a' } })).onHand).toBe(1);
    expect((await db.productVariant.findFirst({ where: { id: 'v-b' } })).onHand).toBe(1);
  });

  it('every change locks the combination rows, in id order, before it reads its places', async () => {
    const { db, locks } = placedStore(
      [{ id: 'v-b', onHand: 3 }, { id: 'v-a', onHand: 3 }],
      [{ variantId: 'v-b', quantity: 1, freeQuantity: 0 }, { variantId: 'v-a', quantity: 1, freeQuantity: 0 }]
    );
    await drawDownVariants(db as never, 'o-1');
    expect(locks).toEqual([['v-a', 'v-b']]);
  });
});

describe('a keeper’s count of one warehouse', () => {
  it('counting a combination into its warehouses for the first time leaves its total where it was', async () => {
    const { db } = placedStore([{ id: 'v-a', onHand: 10 }]);
    const who = { companyId: 'c-1', storeId: 's-1', userId: 'u-1' };
    await countPlacedVariants(db as never, who, { warehouseId: W1, reason: 'عدّ أول', counts: new Map([['v-a', 6]]) });
    await countPlacedVariants(db as never, who, { warehouseId: W2, reason: 'عدّ أول', counts: new Map([['v-a', 4]]) });
    const places = await db.productVariantStock.findMany({ orderBy: { id: 'asc' } });
    expect(places.map((p: Row) => [p.warehouseId, p.onHand])).toEqual([[null, 0], [W1, 6], [W2, 4]]);
    expect((await db.productVariant.findFirst({ where: { id: 'v-a' } })).onHand).toBe(10);
    const counts = await db.variantStockMovement.findMany({ where: { type: VARIANT_MOVE.COUNT } });
    expect(counts.every((l: Row) => l.reason === 'عدّ أول' && l.createdById === 'u-1')).toBe(true);
  });

  it('a count beyond everything known raises the total; a lower one lowers it; an equal one writes nothing', async () => {
    const { db, writes } = placedStore([{ id: 'v-a', onHand: 2 }]);
    const who = { companyId: 'c-1', storeId: 's-1', userId: 'u-1' };
    expect(await countPlacedVariants(db as never, who, { warehouseId: W1, reason: 'فائض', counts: new Map([['v-a', 5]]) })).toBe(1);
    expect((await db.productVariant.findFirst({ where: { id: 'v-a' } })).onHand).toBe(5);
    expect(await countPlacedVariants(db as never, who, { warehouseId: W1, reason: 'نقص', counts: new Map([['v-a', 1]]) })).toBe(1);
    expect((await db.productVariant.findFirst({ where: { id: 'v-a' } })).onHand).toBe(1);
    const before = writes.length;
    expect(await countPlacedVariants(db as never, who, { warehouseId: W1, reason: 'نفس', counts: new Map([['v-a', 1]]) })).toBe(0);
    expect(writes.length).toBe(before);
  });

  it('what a warehouse holds reads «بلا مكان» for a combination never touched', async () => {
    const { db } = placedStore([{ id: 'v-a', onHand: 4 }, { id: 'v-b', onHand: 0 }]);
    const m = await placesOfVariants(db as never, [{ id: 'v-a', onHand: 4 }, { id: 'v-b', onHand: 0 }]);
    expect(m.get('v-a')).toEqual([{ warehouseId: null, onHand: 4 }]);
    expect(m.get('v-b')).toEqual([]);
  });
});

/* ───────────── random runs against a reference written from the sentences ───────────── */

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

describe('random runs: Σ places = onHand = Σ ledger after every step, and the total moves as it always did', () => {
  it('400 stores × 12 steps', async () => {
    const WAREHOUSES = [W1, W2, W3];
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed);
      const int = (n: number) => Math.floor(r() * n);
      const ids = ['v-a', 'v-b', 'v-c'].slice(0, 1 + int(3));
      const start = Object.fromEntries(ids.map((id) => [id, int(12)]));
      const { db, writes } = placedStore(ids.map((id) => ({ id, onHand: start[id] })));
      // THE REFERENCE: a total and an unplaced figure per combination, moved by the sentences of the file's header.
      const ref = Object.fromEntries(ids.map((id) => [id, { total: start[id], unplaced: start[id], at: Object.fromEntries(WAREHOUSES.map((w) => [w, 0])) as Record<string, number> }]));
      for (let step = 0; step < 12; step++) {
        const kind = int(3);
        const id = ids[int(ids.length)];
        const x = ref[id];
        if (kind === 0) {
          const w = WAREHOUSES[int(3)];
          const n = int(15);
          const d = n - x.at[w];
          if (d > 0) {
            const fromUnplaced = Math.min(d, x.unplaced);
            x.unplaced -= fromUnplaced;
            x.total += d - fromUnplaced;
          } else x.total += d;
          x.at[w] = n;
          await countPlacedVariants(db as never, { companyId: 'c-1', storeId: 's-1', userId: 'u-1' }, { warehouseId: w, reason: 'جرد', counts: new Map([[id, n]]) });
        } else if (kind === 1) {
          const n = 1 + int(8);
          const source = r() < 0.3 ? WAREHOUSES[int(3)] : null;
          x.total = Math.max(0, x.total - n);
          // The places, by the header's sentence: the order's warehouse, «بلا مكان», then the fullest (ties by id).
          let need = n;
          const take = (have: number) => {
            const t = Math.min(need, Math.max(0, have));
            need -= t;
            return t;
          };
          if (source) x.at[source] -= take(x.at[source]);
          x.unplaced -= take(x.unplaced);
          for (const w of WAREHOUSES.filter((w) => w !== source).sort((a, b) => x.at[b] - x.at[a] || (a < b ? -1 : 1))) x.at[w] -= take(x.at[w]);
          await drawWith(db, id, n, source);
        } else {
          const n = 1 + int(5);
          const to = r() < 0.5 ? WAREHOUSES[int(3)] : null;
          x.total += n;
          if (to) x.at[to] += n;
          else x.unplaced += n;
          await restoreWith(db, id, n, to);
        }
        const t = await totals(db);
        for (const v of ids) {
          expect(t[v].onHand, `seed ${seed} step ${step} ${v}`).toBe(ref[v].total);
          if (t[v].touched) {
            expect(t[v].places, `seed ${seed} step ${step} ${v} Σ places`).toBe(t[v].onHand);
            expect(t[v].ledger, `seed ${seed} step ${step} ${v} Σ ledger`).toBe(t[v].onHand);
          }
          expect(t[v].negative, `seed ${seed} step ${step} ${v} a place below zero`).toBe(false);
          if (t[v].touched) {
            const rows = await db.productVariantStock.findMany({ where: { variantId: v } });
            const at = (w: string | null) => rows.find((p: Row) => p.warehouseId === w)?.onHand ?? 0;
            expect([at(null), ...WAREHOUSES.map(at)], `seed ${seed} step ${step} ${v} each place`).toEqual([ref[v].unplaced, ...WAREHOUSES.map((w) => ref[v].at[w])]);
          }
          if (t[v].touched) {
            const rows = await db.productVariantStock.findMany({ where: { variantId: v } });
            const at = (w: string | null) => rows.find((p: Row) => p.warehouseId === w)?.onHand ?? 0;
            expect([at(null), ...WAREHOUSES.map(at)], ).toEqual([ref[v].unplaced, ...WAREHOUSES.map((w) => ref[v].at[w])]);
          }
        }
      }
      // ONE WRITER: every write of `onHand` in a placed store was the sum of the places at that moment.
      for (const w of writes.filter((x) => x.table === 'witness')) expect(w.onHand).toBe(w.placesSum);
    }
  });
});

/** A delivery of `n` pieces of one combination, through the real `drawDownVariants`. */
async function drawWith(db: Row, variantId: string, n: number, source: string | null) {
  const id = `o-${Math.random().toString(16).slice(2)}`;
  await db.order.create({ data: { id, companyId: 'c-1', storeId: 's-1', sourceWarehouseId: source } });
  await db.orderItemVariant.create({ data: { orderId: id, productId: 'p-1', variantId, quantity: n, freeQuantity: 0 } });
  await drawDownVariants(db as never, id);
}

/** A counted return of `n` pieces of one combination, through the real `restoreVariants`. */
async function restoreWith(db: Row, variantId: string, n: number, to: string | null) {
  const id = `o-${Math.random().toString(16).slice(2)}`;
  await db.order.create({ data: { id, companyId: 'c-1', storeId: 's-1', sourceWarehouseId: null } });
  await db.orderItemVariant.create({ data: { orderId: id, productId: 'p-1', variantId, quantity: n, freeQuantity: 0 } });
  await restoreVariants(db as never, { orderId: id, productId: 'p-1', take: n, warehouseId: to });
}

describe('the worked example of the pull request, step by step', () => {
  it('10 pieces, two warehouses: count, count, deliver 2, a return, a surplus, a shortage', async () => {
    const { db } = placedStore([{ id: 'v-a', onHand: 10 }]);
    const who = { companyId: 'c-1', storeId: 's-1', userId: 'u-1' };
    const row = async () => {
      const ps = await db.productVariantStock.findMany({ where: { variantId: 'v-a' } });
      const at = (w: string | null) => ps.find((p: Row) => p.warehouseId === w)?.onHand ?? 0;
      return [at(null), at(W1), at(W2), (await db.productVariant.findFirst({ where: { id: 'v-a' } })).onHand];
    };
    await countPlacedVariants(db as never, who, { warehouseId: W1, reason: 'جرد أول', counts: new Map([['v-a', 6]]) });
    expect(await row()).toEqual([4, 6, 0, 10]);
    await countPlacedVariants(db as never, who, { warehouseId: W2, reason: 'جرد أول', counts: new Map([['v-a', 3]]) });
    expect(await row()).toEqual([1, 6, 3, 10]);
    await drawWith(db, 'v-a', 2, null);
    expect(await row()).toEqual([0, 5, 3, 8]);
    await restoreWith(db, 'v-a', 1, null);
    expect(await row()).toEqual([1, 5, 3, 9]);
    await countPlacedVariants(db as never, who, { warehouseId: W1, reason: 'لقينا زيادة', counts: new Map([['v-a', 8]]) });
    expect(await row()).toEqual([0, 8, 3, 11]);
    await countPlacedVariants(db as never, who, { warehouseId: W2, reason: 'نقص', counts: new Map([['v-a', 1]]) });
    expect(await row()).toEqual([0, 8, 1, 9]);
  });
});

describe('nothing here touches money', () => {
  it('the module imports no wallet, expense, profit, cost or price code', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/variant-stock.ts'), 'utf8');
    const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(imports.filter((i) => /wallet|expense|profit|financ|commission|settlement|cost|price|cod/i.test(i))).toEqual([]);
  });
});
