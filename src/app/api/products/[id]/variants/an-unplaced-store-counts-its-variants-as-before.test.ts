import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A STORE THAT WAS NEVER PLACED COUNTS ITS COMBINATIONS EXACTLY AS BEFORE (the warehouse plan, W8a).
 *
 * The draw-down at delivery, the restock of a counted return and the variants door (GET and PUT) now ask «is this store
 * placed in warehouses?». For every store that is not, nothing may change: the same answers, the same refusals, the same
 * rows written with the same values, the same audit lines. The frozen file beside this test holds what the MAIN branch's
 * code answered for the same random requests — `git show osm/main:` of
 *   src/lib/product-variants.ts                     (drawDownVariants, restoreVariants)
 *   src/app/api/products/[id]/variants/route.ts     (GET, PUT)
 * run against the in-memory database below. This test runs today's code on the very same requests and compares
 * everything, `toEqual`. The orders and bodies may name a warehouse (an order's `sourceWarehouseId`, a body's
 * `warehouseId` and `reason` — absent, real, junk): an unplaced store must not read them.
 *
 * TO REGENERATE (only if main itself changes these files): copy main's two files next to their originals as
 * `product-variants.w8a-main.ts` and `route.w8a-main.ts` (the route's import pointed at the lib copy), run this file with
 * `W8A_WRITE_GOLDEN=1`, delete the copies.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- an in-memory row; every field is read by name
type Row = Record<string, any>;

const S = vi.hoisted(() => ({
  data: {} as Record<string, Row[]>,
  writes: [] as Row[],
  audit: [] as Row[],
  seq: 0,
  allow: { view: true, edit: true, price: true } as Record<string, boolean>,
  storeId: 's-1' as string | null,
}));

vi.mock('@/lib/db', () => {
  const scalar = (v: unknown, c: unknown): boolean => {
    if (c === null) return v === null || v === undefined;
    if (c && typeof c === 'object' && !Array.isArray(c)) {
      const o = c as Row;
      if ('in' in o && !(o.in as unknown[]).includes(v)) return false;
      if ('not' in o && (o.not === null ? v === null || v === undefined : v === o.not)) return false;
      return true;
    }
    return v === c;
  };
  const matches = (r: Row, w: Row = {}): boolean => Object.entries(w).every(([k, c]) => c === undefined || scalar(r[k], c));
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
    const rows = () => (S.data[name] ??= []);
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
      // What open orders hold of a combination: nothing in these scenarios — the same answer for both codes.
      groupBy: async () => [],
      create: async ({ data, select }: Row) => {
        S.writes.push({ table: name, op: 'create', data: JSON.parse(JSON.stringify(data)) });
        const row = { id: `${name}-${++S.seq}`, ...data };
        rows().push(row);
        return pick(row, select);
      },
      update: async ({ where, data }: Row) => {
        const r = rows().find((x) => matches(x, where));
        if (!r) throw new Error('No record was found for an update.');
        S.writes.push({ table: name, op: 'update', where: JSON.parse(JSON.stringify(where)), data: JSON.parse(JSON.stringify(data)) });
        for (const [k, v] of Object.entries(data)) r[k] = v && typeof v === 'object' && 'increment' in (v as Row) ? r[k] + (v as Row).increment : v;
        return { ...r };
      },
      updateMany: async ({ where, data }: Row) => {
        const hit = rows().filter((x) => matches(x, where));
        S.writes.push({ table: name, op: 'updateMany', where: JSON.parse(JSON.stringify(where)), data: JSON.parse(JSON.stringify(data)) });
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      },
    };
  };
  const names = ['product', 'productVariant', 'orderItemVariant', 'order', 'warehouse', 'warehousePlacement', 'productVariantStock', 'variantStockMovement'];
  const db: Row = Object.fromEntries(names.map((n) => [n, t(n)]));
  db.$executeRaw = async () => 1;
  db.$queryRaw = async () => [];
  const tx = new Proxy(db, { has: (o, p) => p !== '$transaction' && p in o });
  db.$transaction = async (fn: (t: Row) => unknown) => fn(tx);
  return { db };
});
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({ user: { id: 'u-1', name: 'أمين', companyId: 'c-1' }, companyId: 'c-1', storeId: S.storeId }),
}));
vi.mock('@/lib/authorization', () => ({
  authorize: (_u: unknown, key: string) => ({ allowed: key === 'products.view' ? S.allow.view : key === 'products.edit' ? S.allow.edit : S.allow.price }),
}));
vi.mock('@/lib/audit', () => ({ logAudit: async (e: Row) => void S.audit.push(JSON.parse(JSON.stringify(e))) }));
vi.mock('@/lib/warehouses', () => ({ reachesWarehouse: async () => true }));

const GOLDEN = join(__dirname, 'variants.main-golden.json');
const WRITE = process.env.W8A_WRITE_GOLDEN === '1';

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

const OPTIONS = [
  { id: 'size', name: 'المقاس', values: [{ id: 's', label: 'S' }, { id: 'm', label: 'M' }, { id: 'l', label: 'L' }] },
  { id: 'colour', name: 'اللون', values: [{ id: 'blk', label: 'أسود', swatch: '#000000' }, { id: 'nvy', label: 'كحلي' }] },
];
const COMBOS = OPTIONS[0].values.flatMap((a) => OPTIONS[1].values.map((b) => [a.id, b.id]));

/** A random unplaced store: a product with combinations, warehouses that exist but were never used, one order. */
function seedStore(r: () => number) {
  const int = (n: number) => Math.floor(r() * n);
  S.seq = 0;
  S.writes = [];
  S.audit = [];
  S.storeId = r() < 0.9 ? 's-1' : null;
  S.allow = { view: r() < 0.95, edit: r() < 0.9, price: r() < 0.7 };
  const withOptions = r() < 0.85;
  const variants = (withOptions ? COMBOS.filter(() => r() < 0.6) : []).map((values, i) => ({
    id: `v-${i}`,
    companyId: 'c-1',
    productId: 'p-1',
    optionValues: JSON.stringify(values),
    label: values.join(' · '),
    sku: r() < 0.3 ? `SKU-${i}` : null,
    priceDelta: int(4),
    onHand: int(12),
    status: r() < 0.85 ? 'ACTIVE' : 'ARCHIVED',
    sortOrder: i,
  }));
  const placedElsewhere = r() < 0.5; // ANOTHER store is placed: this one is not
  S.data = {
    product: [{ id: 'p-1', companyId: 'c-1', storeId: 's-1', categoryId: null, name: 'قميص', basePrice: 10, variantOptions: withOptions ? JSON.stringify(OPTIONS) : null }],
    productVariant: variants,
    warehouse: [{ id: 'w-1', companyId: 'c-1', countryId: 'k-1', isActive: true }],
    warehousePlacement: placedElsewhere ? [{ id: 'pl-9', storeId: 's-9' }] : [],
    order: [{ id: 'o-1', companyId: 'c-1', storeId: r() < 0.9 ? 's-1' : null, sourceWarehouseId: r() < 0.3 ? 'w-1' : null }],
    orderItemVariant: variants
      .filter(() => r() < 0.5)
      .map((v, i) => ({ id: `oiv-${i}`, orderId: 'o-1', productId: r() < 0.9 ? 'p-1' : 'p-2', variantId: r() < 0.9 ? v.id : null, quantity: int(4), freeQuantity: int(2), createdAt: new Date(i) })),
    productVariantStock: [],
    variantStockMovement: [],
  };
  return { variants, int };
}

function randomBody(r: () => number, variants: Row[]) {
  const int = (n: number) => Math.floor(r() * n);
  const options = r() < 0.1 ? [] : OPTIONS;
  const pool = r() < 0.1 ? [...COMBOS, COMBOS[0]] : COMBOS.filter(() => r() < 0.6);
  const combinations = (options.length ? pool : []).map((values) => {
    const old = variants.find((v) => v.optionValues === JSON.stringify(values));
    return {
      values: r() < 0.03 ? ['x'] : values,
      sku: r() < 0.2 ? `N-${int(9)}` : old?.sku ?? null,
      priceDelta: r() < 0.2 ? int(5) : old?.priceDelta ?? 0,
      onHand: r() < 0.5 ? int(15) : old?.onHand ?? 0,
      active: r() < 0.9,
    };
  });
  const body: Row = { options, combinations };
  const extra = int(5);
  if (extra === 1) body.warehouseId = 'w-1';
  if (extra === 2) body.warehouseId = 12;
  if (extra === 3) Object.assign(body, { warehouseId: 'w-1', reason: 'جرد الرف' });
  if (extra === 4) body.reason = 'x';
  return r() < 0.03 ? { options: 'junk' } : body;
}

type Mods = { route: Row; lib: Row };

async function runScenario(seed: number, mods: Mods) {
  const r = rng(seed);
  const { variants, int } = seedStore(r);
  const kind = int(4);
  const ctx = { params: Promise.resolve({ id: r() < 0.95 ? 'p-1' : 'p-x' }) };
  let answer: Row;
  if (kind === 0) {
    const res = await mods.route.GET(new Request('http://x/api/products/p-1/variants'), ctx);
    answer = { status: res.status, json: await res.json() };
  } else if (kind === 1) {
    const body = randomBody(r, variants);
    const res = await mods.route.PUT(new Request('http://x/api/products/p-1/variants', { method: 'PUT', body: JSON.stringify(body) }), ctx);
    answer = { status: res.status, json: await res.json() };
  } else if (kind === 2) {
    await mods.lib.drawDownVariants(await import('@/lib/db').then((m) => m.db), 'o-1');
    answer = { done: true };
  } else {
    const take = int(8);
    const warehouseId = r() < 0.5 ? 'w-1' : undefined;
    await mods.lib.restoreVariants(await import('@/lib/db').then((m) => m.db), { orderId: 'o-1', productId: r() < 0.9 ? 'p-1' : 'p-2', take, warehouseId });
    answer = { done: true };
  }
  return {
    seed,
    kind,
    answer,
    writes: S.writes,
    audit: S.audit,
    variants: S.data.productVariant.map((v) => ({ id: v.id, onHand: v.onHand, status: v.status, priceDelta: v.priceDelta, sku: v.sku, label: v.label, sortOrder: v.sortOrder })),
    newTables: (S.data.productVariantStock?.length ?? 0) + (S.data.variantStockMovement?.length ?? 0),
  };
}

const SEEDS = 600;

describe('an unplaced store: the variants door, the draw-down and the restock answer and write exactly as main', () => {
  it.runIf(WRITE)('writes the golden file from main’s code', async () => {
    const lib = await import('@/lib/product-variants.w8a-main' as string);
    const route = await import('./route.w8a-main' as string);
    const out = [];
    for (let seed = 1; seed <= SEEDS; seed++) out.push(await runScenario(seed, { route, lib }));
    writeFileSync(GOLDEN, JSON.stringify(out));
  });

  it.runIf(!WRITE)('today’s code, the same requests: everything equal', async () => {
    expect(existsSync(GOLDEN)).toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Row[];
    expect(golden).toHaveLength(SEEDS);
    const lib = await import('@/lib/product-variants');
    const route = await import('./route');
    const kinds = new Set<number>();
    let wrote = 0;
    for (const g of golden) {
      const now = await runScenario(g.seed, { route, lib });
      expect(now, `seed ${g.seed}`).toEqual(g);
      expect(now.newTables).toBe(0);
      kinds.add(g.kind);
      if (g.writes.length > 0) wrote += 1;
    }
    // The run is not empty: every door was asked, and most scenarios wrote something.
    expect([...kinds].sort()).toEqual([0, 1, 2, 3]);
    expect(wrote).toBeGreaterThan(SEEDS / 3);
  });
});
