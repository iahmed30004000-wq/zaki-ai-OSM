import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE STOCK SCREENS AND THEIR PLACES (the warehouse plan, W2c).
 *
 * 1. A STORE THAT WAS NEVER PLACED READS EXACTLY AS BEFORE. The frozen file beside this test holds what the MAIN branch's
 *    code answered — `git show osm/main:` of
 *      src/app/api/inventory/route.ts            GET (the balances)
 *      src/app/api/inventory/movements/route.ts  GET (the ledger), with and without `?warehouse=`
 *      src/app/api/production/route.ts           GET (the runs)
 *      src/lib/product-cost.ts                   productCosts (the product page's «موزّع على N دفعة», «الدفعة القادمة»)
 *    run against the in-memory database below, at a frozen clock, on random stores. Today's code runs the very same
 *    requests and every answer is compared, `toEqual`. The batches are stored oldest first, the order the database hands
 *    back rows inserted in that order and never moved — main asked for no order at all, so that is the one order in
 *    which «main's answer» is defined (the scrambled case is pinned separately below, as the fix it is).
 *
 * 2. A PLACED STORE: the very same store, its batches split into warehouses and onto the road by the real
 *    `batch-split.splitBatch`, answers the SAME store figures (on the shelf, reserved, available, in, out, the verdict,
 *    the counts of batches, the last cost) as before the split, to the last digit — and the places add up to the shelf,
 *    counted here from the rows themselves, not by the function under test.
 *
 * TO REGENERATE (only if main itself changes these doors): copy the four files of main next to their originals as
 * `*.w2c-main.ts`, run this file with `W2C_WRITE_GOLDEN=1`, delete the copies.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- an in-memory row; every field is read by name
type Row = Record<string, any>;

const S = vi.hoisted(() => ({
  data: {} as Record<string, Row[]>,
  seq: 0,
  ctx: { storeId: 's1' as string },
  user: { id: 'u-owner', name: 'المالك', role: 'SUPER_ADMIN', companyId: 'c1', permissions: [] as string[] } as Record<string, unknown>,
  reserved: new Map<string, number>(),
  courier: new Map<string, number>(),
  delivered: new Map<string, { units: number; lines: number; lastAt: Date }>(),
}));

vi.mock('@/lib/db', () => {
  const scalar = (v: unknown, c: unknown): boolean => {
    if (c === null) return v === null || v === undefined;
    if (c instanceof Date) return v instanceof Date && v.getTime() === c.getTime();
    if (c && typeof c === 'object' && !Array.isArray(c)) {
      const o = c as Row;
      if ('in' in o && !(o.in as unknown[]).includes(v)) return false;
      if ('not' in o && (o.not === null ? v === null || v === undefined : v === o.not)) return false;
      if ('gt' in o && !((v as number) > o.gt)) return false;
      if ('lt' in o && !((v instanceof Date ? v.getTime() : (v as number)) < (o.lt instanceof Date ? o.lt.getTime() : o.lt))) return false;
      return true;
    }
    return v === c;
  };
  const matches = (r: Row, w: Row = {}): boolean =>
    Object.entries(w).every(([k, c]) => {
      if (c === undefined) return true;
      if (k === 'OR') return (c as Row[]).some((x) => matches(r, x));
      return scalar(r[k], c);
    });
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
  const REL: Record<string, Record<string, { table: string; many: boolean; local: string; foreign: string }>> = {
    product: { batches: { table: 'productionBatch', many: true, local: 'id', foreign: 'productId' } },
    inventoryMovement: {
      product: { table: 'product', many: false, local: 'productId', foreign: 'id' },
      batch: { table: 'productionBatch', many: false, local: 'batchId', foreign: 'id' },
      warehouse: { table: 'warehouse', many: false, local: 'warehouseId', foreign: 'id' },
    },
    productionBatch: {
      product: { table: 'product', many: false, local: 'productId', foreign: 'id' },
      costLines: { table: 'productionBatchCost', many: true, local: 'id', foreign: 'batchId' },
    },
    userStoreAccess: { store: { table: 'store', many: false, local: 'storeId', foreign: 'id' } },
  };
  const rows = (name: string) => (S.data[name] ??= []);
  const shape = (table: string, r: Row, args: Row = {}): Row => {
    const rel = REL[table] ?? {};
    const out: Row = {};
    if (args.select) {
      for (const [k, v] of Object.entries(args.select as Row)) {
        if (!v) continue;
        out[k] = rel[k] ? related(rel[k], r, v === true ? {} : (v as Row)) : r[k];
      }
      return out;
    }
    Object.assign(out, r);
    for (const [k, v] of Object.entries((args.include ?? {}) as Row)) {
      if (v) out[k] = related(rel[k], r, v === true ? {} : (v as Row));
    }
    return out;
  };
  const related = (rel: { table: string; many: boolean; local: string; foreign: string }, r: Row, args: Row): unknown => {
    const hit = rows(rel.table).filter((x) => x[rel.foreign] === r[rel.local] && matches(x, args.where));
    if (!rel.many) return hit[0] ? shape(rel.table, hit[0], args) : null;
    const sorted = sortBy(hit, args.orderBy);
    return (args.take ? sorted.slice(0, args.take) : sorted).map((x) => shape(rel.table, x, args));
  };
  const step = (cur: unknown, d: unknown) => {
    if (d && typeof d === 'object' && !(d instanceof Date)) {
      const o = d as Row;
      if ('increment' in o) return (cur as number) + o.increment;
      if ('decrement' in o) return (cur as number) - o.decrement;
    }
    return d;
  };
  const t = (name: string) => ({
    findMany: async (args: Row = {}) => {
      const sorted = sortBy(rows(name).filter((r) => matches(r, args.where)), args.orderBy);
      return (args.take ? sorted.slice(0, args.take) : sorted).map((r) => shape(name, r, args));
    },
    findFirst: async (args: Row = {}) => {
      const r = sortBy(rows(name).filter((x) => matches(x, args.where)), args.orderBy)[0];
      return r ? shape(name, r, args) : null;
    },
    findUnique: async (args: Row) => {
      const r = rows(name).find((x) => matches(x, args.where));
      return r ? shape(name, r, args) : null;
    },
    count: async ({ where }: Row = {}) => rows(name).filter((r) => matches(r, where)).length,
    groupBy: async ({ by, where, _count, _sum }: Row) => {
      const groups = new Map<string, Row[]>();
      for (const r of rows(name).filter((x) => matches(x, where))) {
        const key = JSON.stringify((by as string[]).map((k) => r[k] ?? null));
        groups.set(key, [...(groups.get(key) ?? []), r]);
      }
      return [...groups.values()].map((g) => ({
        ...Object.fromEntries((by as string[]).map((k) => [k, g[0][k] ?? null])),
        ...(_count ? { _count: Object.fromEntries(Object.keys(_count).map((k) => [k, g.length])) } : {}),
        ...(_sum ? { _sum: Object.fromEntries(Object.keys(_sum).map((k) => [k, g.reduce((s, r) => s + r[k], 0)])) } : {}),
      }));
    },
    updateMany: async ({ where, data }: Row) => {
      const hit = rows(name).filter((x) => matches(x, where));
      for (const r of hit) for (const [k, v] of Object.entries(data as Row)) r[k] = step(r[k], v);
      return { count: hit.length };
    },
    create: async ({ data, select }: Row) => {
      const row = { id: `${name}-${++S.seq}`, ...data };
      rows(name).push(row);
      return shape(name, row, { select });
    },
  });
  const names = [
    'store', 'country', 'product', 'productionBatch', 'productionBatchCost', 'inventoryMovement', 'user', 'warehouse',
    'warehousePlacement', 'userCountryAccess', 'userStoreAccess', 'userWarehouseAccess',
    // 27/11: the balances of a placed store also read what each warehouse holds (`warehouse-figures.ts`) — none here.
    'orderItem', 'orderAddOn', 'stockExitLine', 'stockTransferLine',
  ];
  const db: Row = Object.fromEntries(names.map((n) => [n, t(n)]));
  db.$executeRaw = async () => 1;
  db.$queryRaw = async () => [];
  const tx = new Proxy(db, { has: (o, p) => p !== '$transaction' && p in o });
  db.$transaction = async (fn: (t: Row) => unknown) => fn(tx);
  return { db, default: db };
});
vi.mock('@/lib/geo-context', async (orig) => ({
  ...(await orig<typeof import('@/lib/geo-context')>()),
  requireContext: async () => ({ user: S.user, companyId: 'c1', storeId: S.ctx.storeId, country: { currencyCode: 'SYP' } }),
}));
vi.mock('@/lib/authorization', async (orig) => ({
  ...(await orig<typeof import('@/lib/authorization')>()),
  requirePermission: async () => undefined,
}));
vi.mock('@/lib/cost-visibility', () => ({ maySeeCost: () => true }));
vi.mock('@/lib/reservation', async (orig) => ({
  ...(await orig<typeof import('@/lib/reservation')>()),
  reservedForProducts: async (_db: unknown, p: { productIds: string[] }) =>
    new Map(p.productIds.filter((id) => S.reserved.has(id)).map((id) => [id, S.reserved.get(id)!])),
}));
vi.mock('@/lib/stock-ledger', async (orig) => ({
  ...(await orig<typeof import('@/lib/stock-ledger')>()),
  ledgerDepthDays: async () => 30,
  deliveredPerProduct: async () => S.delivered,
}));
vi.mock('@/lib/warehouse-placement', async (orig) => ({
  ...(await orig<typeof import('@/lib/warehouse-placement')>()),
  unitsWithCourier: async () => S.courier,
}));

import { GET as balancesGet } from './route';
import { GET as movementsGet } from './movements/route';
import { GET as productionGet } from '../production/route';
import { productCosts } from '@/lib/product-cost';
import { splitBatch } from '@/lib/batch-split';
import { db } from '@/lib/db';

const GOLDEN = join(__dirname, 'screens.main-golden.json');
const WRITE = process.env.W2C_WRITE_GOLDEN === '1';
const NOW = new Date('2026-11-01T12:00:00Z');

/* ───────────── a random store ───────────── */

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

const TYPES = ['PRODUCTION', 'SALE', 'RETURN', 'MANUAL_ADJUSTMENT', 'DAMAGE', 'LOSS'];

function freshStore(seed: number) {
  const r = rng(seed);
  const int = (n: number) => Math.floor(r() * n);
  S.seq = 0;
  S.ctx.storeId = 's1';
  S.reserved = new Map();
  S.courier = new Map();
  S.delivered = new Map();
  S.data = {
    country: [{ id: 'k1', companyId: 'c1', isActive: true }],
    store: [{ id: 's1', companyId: 'c1', countryId: 'k1' }, { id: 's2', companyId: 'c1', countryId: 'k1' }],
    warehouse: [
      { id: 'w-b', companyId: 'c1', countryId: 'k1', name: 'مخزن ب', isActive: true },
      { id: 'w-a', companyId: 'c1', countryId: 'k1', name: 'مخزن أ', isActive: true },
    ],
    // Another store being placed never places this one.
    warehousePlacement: r() < 0.3 ? [{ id: 'pl-s2', storeId: 's2', companyId: 'c1' }] : [],
    user: [{ id: 'u1', name: 'سارة' }, { id: 'u2', name: 'أمين' }],
    product: [],
    productionBatch: [],
    productionBatchCost: [],
    inventoryMovement: [],
    userCountryAccess: [],
    userStoreAccess: [],
    userWarehouseAccess: [],
  };
  const nProducts = 1 + int(5);
  const pending: Row[] = [];
  for (let i = 0; i < nProducts; i++) {
    const store = r() < 0.85 ? 's1' : 's2';
    const id = `p-${seed}-${i}`;
    S.data.product.push({
      id, companyId: 'c1', storeId: store, name: `منتج ${i}`, sku: `SKU-${i}`, status: 'ACTIVE',
      sourceType: r() < 0.5 ? 'PURCHASED' : 'MANUFACTURED', basePrice: int(50),
    });
    if (r() < 0.6) S.reserved.set(id, int(6));
    if (r() < 0.4) S.delivered.set(id, { units: 1 + int(40), lines: 1 + int(12), lastAt: new Date(NOW.getTime() - int(20) * 86_400_000) });
    for (let b = int(5); b > 0; b--) {
      const produced = 1 + int(30);
      const sold = int(produced + 1);
      const cost = r() < 0.25 ? 0 : Math.round(r() * 100000) / 10000;
      pending.push({
        companyId: 'c1', storeId: store, productId: id, batchNumber: `B-${seed}-${i}-${b}`,
        quantityProduced: produced, quantitySold: sold, quantityRemaining: produced - sold,
        quantityMovedIn: 0, quantityMovedOut: 0,
        manufacturingCost: cost * produced, packagingCost: 0, rawMaterialCost: 0, otherCosts: 0,
        totalProductionCost: cost * produced, costPerUnit: cost,
        productionDate: new Date(Date.UTC(2026, 8, 1 + int(40))), createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, int(3000))),
        status: 'COMPLETED', notes: null, openingCountId: null,
        warehouseId: null, inTransitTransferId: null, splitFromBatchId: null,
      });
    }
  }
  // Oldest first, as rows inserted in that order and never moved come back (see the header).
  pending.sort((a, b) => a.productionDate.getTime() - b.productionDate.getTime() || a.createdAt.getTime() - b.createdAt.getTime());
  for (const [i, b] of pending.entries()) S.data.productionBatch.push({ id: `b-${seed}-${String(i).padStart(3, '0')}`, ...b });
  for (const b of S.data.productionBatch) {
    if (r() < 0.3) S.data.productionBatchCost.push({ id: `cl-${b.id}`, batchId: b.id, companyId: 'c1', label: 'أجرة', amount: int(9), sortOrder: 0 });
  }
  const nMov = int(12);
  for (let m = 0; m < nMov; m++) {
    const p = S.data.product[int(S.data.product.length)];
    const batch = S.data.productionBatch.filter((b) => b.productId === p.id)[0];
    S.data.inventoryMovement.push({
      id: `m-${seed}-${m}`, companyId: 'c1', storeId: p.storeId, productId: p.id, batchId: r() < 0.6 ? batch?.id ?? null : null,
      type: TYPES[int(TYPES.length)], quantity: int(20) - 10, balanceAfter: int(100), reason: r() < 0.5 ? 'سبب' : null,
      referenceId: null, createdById: r() < 0.8 ? (r() < 0.5 ? 'u1' : 'u2') : null,
      createdAt: new Date(NOW.getTime() - (m + 1) * 3_600_000), warehouseId: null,
    });
  }
}

const json = async (res: Response) => JSON.parse(JSON.stringify(await res.json()));

type Doors = {
  balances: () => Promise<Response>;
  movements: (req: Request) => Promise<Response>;
  production: (req: Request) => Promise<Response>;
  costs: typeof productCosts;
};

async function answersOf(doors: Doors, seed: number) {
  freshStore(seed);
  const ids = S.data.product.map((p) => p.id);
  return {
    balances: await json(await doors.balances()),
    movements: await json(await doors.movements(new Request('http://x/api/inventory/movements'))),
    movementsTyped: await json(await doors.movements(new Request('http://x/api/inventory/movements?type=SALE&warehouse=w-a'))),
    production: await json(await doors.production(new Request('http://x/api/production'))),
    costs: Object.fromEntries(await doors.costs(db, 'c1', ids)),
  };
}

const SEEDS = Array.from({ length: 40 }, (_, i) => 7001 + i * 13);

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterAll(() => vi.useRealTimers());
beforeEach(() => {
  S.user = { id: 'u-owner', name: 'المالك', role: 'SUPER_ADMIN', companyId: 'c1', permissions: [] };
});

describe('1 — a store that was never placed reads exactly as main did', () => {
  it('the balances, the ledger (with a warehouse asked for, ignored), the runs and the product costs: 40 random stores', async () => {
    const today: Doors = { balances: balancesGet, movements: movementsGet, production: productionGet, costs: productCosts };
    if (WRITE) {
      const main: Doors = {
        balances: (await import('./route.w2c-main' as string)).GET,
        movements: (await import('./movements/route.w2c-main' as string)).GET,
        production: (await import('../production/route.w2c-main' as string)).GET,
        costs: (await import('@/lib/product-cost.w2c-main' as string)).productCosts,
      };
      const frozen: Record<string, unknown> = {};
      for (const seed of SEEDS) frozen[seed] = await answersOf(main, seed);
      writeFileSync(GOLDEN, JSON.stringify(frozen) + '\n');
    }
    expect(existsSync(GOLDEN), 'the frozen answers of main are missing').toBe(true);
    const frozen = JSON.parse(readFileSync(GOLDEN, 'utf8'));
    let products = 0;
    for (const seed of SEEDS) {
      const now = await answersOf(today, seed);
      expect(now, `seed ${seed}`).toEqual(frozen[seed]);
      products += now.balances.stockSummary.length;
    }
    expect(products, 'the random stores held no product').toBeGreaterThan(40);
  });

  it('NEGATIVE: nothing about places is sent for a store that is not placed — not even an empty list', async () => {
    freshStore(99);
    const b = await json(await balancesGet());
    expect('warehouses' in b).toBe(false);
    for (const row of b.stockSummary) expect('places' in row).toBe(false);
    const m = await json(await movementsGet(new Request('http://x/api/inventory/movements')));
    expect('warehouses' in m).toBe(false);
    for (const row of m.movements) expect('warehouseName' in row).toBe(false);
  });
});

/* ───────────── a placed store ───────────── */

/** Splits random batches of s1 into the two warehouses and onto the road, with the real primitive, then places the store. */
async function placeRandomly(seed: number) {
  const r = rng(seed * 7 + 1);
  const mine = S.data.productionBatch.filter((b) => b.storeId === 's1' && b.quantityRemaining > 0);
  const tx = new Proxy(db as Row, { has: (o, p) => p !== '$transaction' && p in o });
  for (const b of mine) {
    const x = r();
    if (x < 0.3) {
      b.warehouseId = 'w-a';
    } else if (x < 0.8) {
      const n = 1 + Math.floor(r() * b.quantityRemaining);
      await splitBatch(tx as never, { companyId: 'c1', batchId: b.id, quantity: n, to: { warehouseId: r() < 0.5 ? 'w-b' : 'w-a' }, hex: `${b.id.slice(-3)}a01` });
      if (b.quantityRemaining > 0 && r() < 0.5) {
        const m = 1 + Math.floor(r() * b.quantityRemaining);
        await splitBatch(tx as never, { companyId: 'c1', batchId: b.id, quantity: m, to: { inTransitTransferId: 'tr-1' }, hex: `${b.id.slice(-3)}b02` });
      }
      if (b.quantityRemaining > 0 && r() < 0.5) b.warehouseId = 'w-b';
    }
    // else: stays with no place (the courier's units at the placement)
  }
  S.data.warehousePlacement.push({ id: 'pl-s1', storeId: 's1', companyId: 'c1' });
  for (const p of S.data.product) if (r() < 0.5) S.courier.set(p.id, Math.floor(r() * 4));
}

/** The figures a store total is made of — every one of them, as the screen prints them. */
const storeFigures = (row: Row) => {
  const { places: _places, ...rest } = row;
  void _places;
  return rest;
};

describe('2 — a placed store: the same store figures, and places that add up to the shelf', () => {
  it('on 40 random stores: every store figure is the one it was before the split, to the last digit', async () => {
    let split = 0;
    for (const seed of SEEDS) {
      freshStore(seed);
      const before = await json(await balancesGet());
      const rowsBefore = JSON.parse(JSON.stringify(S.data.productionBatch));
      await placeRandomly(seed);
      split += S.data.productionBatch.length - rowsBefore.length;
      const after = await json(await balancesGet());

      // Conservation, counted from the rows themselves: Σ remaining, Σ produced, Σ sold, Σ remaining × cost per product.
      for (const p of S.data.product) {
        const sum = (rows: Row[], f: (b: Row) => number) => rows.filter((b) => b.productId === p.id).reduce((s, b) => s + f(b), 0);
        const now = S.data.productionBatch;
        expect(sum(now, (b) => b.quantityRemaining)).toBe(sum(rowsBefore, (b) => b.quantityRemaining));
        expect(sum(now, (b) => b.quantityProduced)).toBe(sum(rowsBefore, (b) => b.quantityProduced));
        expect(sum(now, (b) => b.quantitySold)).toBe(sum(rowsBefore, (b) => b.quantitySold));
        expect(sum(now, (b) => b.quantityRemaining * b.costPerUnit)).toBeCloseTo(sum(rowsBefore, (b) => b.quantityRemaining * b.costPerUnit), 9);
      }

      expect(after.stockSummary.map(storeFigures), `seed ${seed}`).toEqual(before.stockSummary);
      expect(after.alerts).toEqual(before.alerts);

      for (const row of after.stockSummary) {
        const mine = S.data.productionBatch.filter((b) => b.productId === row.id);
        const inW = (w: string) => mine.filter((b) => b.warehouseId === w).reduce((s, b) => s + b.quantityRemaining, 0);
        const road = mine.filter((b) => !b.warehouseId && b.inTransitTransferId).reduce((s, b) => s + b.quantityRemaining, 0);
        const none = mine.filter((b) => !b.warehouseId && !b.inTransitTransferId).reduce((s, b) => s + b.quantityRemaining, 0);
        const sent = Object.fromEntries(row.places.warehouses.map((w: Row) => [w.id, w.onHand]));
        for (const w of ['w-a', 'w-b']) expect(sent[w] ?? 0, `${row.id} ${w}`).toBe(inW(w));
        expect(row.places.inTransit).toBe(road);
        expect(row.places.withCourier).toBe(S.courier.get(row.id) ?? 0);
        // «بلا مكان» comes only when it is not the courier's figure; either way it is the rows with no place.
        expect(row.places.unplaced ?? row.places.withCourier).toBe(none);
        expect(inW('w-a') + inW('w-b') + road + none).toBe(row.remaining);
      }
      expect(after.warehouses.map((w: Row) => w.name)).toEqual(['مخزن أ', 'مخزن ب']);
    }
    expect(split, 'no batch was ever split — the test proved nothing').toBeGreaterThan(20);
  });

  it('the runs list shows each run once, carrying its twins’ units; the twins are never listed', async () => {
    for (const seed of SEEDS.slice(0, 10)) {
      freshStore(seed);
      const before = await json(await productionGet(new Request('http://x/api/production')));
      await placeRandomly(seed);
      const after = await json(await productionGet(new Request('http://x/api/production')));
      const pick = (b: Row) => ({ id: b.id, quantityProduced: b.quantityProduced, quantitySold: b.quantitySold, quantityRemaining: b.quantityRemaining });
      expect(after.batches.map(pick), `seed ${seed}`).toEqual(before.batches.map(pick));
      expect(after.batches.some((b: Row) => b.splitFromBatchId)).toBe(false);
    }
  });

  it('the batch counts count runs, not rows; the product costs keep their value', async () => {
    for (const seed of SEEDS.slice(0, 10)) {
      freshStore(seed);
      const ids = S.data.product.map((p) => p.id);
      const before = await productCosts(db as never, 'c1', ids);
      await placeRandomly(seed);
      const after = await productCosts(db as never, 'c1', ids);
      for (const id of ids) {
        const a = after.get(id)!;
        const b = before.get(id)!;
        expect(a.batchCount, id).toBe(b.batchCount);
        expect(a.onHand).toBe(b.onHand);
        expect(a.stockValue).toBe(b.stockValue);
        expect(a.average).toBe(b.average);
      }
    }
  });

  it('«الدفعة القادمة» skips a row on the road — a draw never takes one', async () => {
    freshStore(1);
    S.data.product = [{ id: 'p1', companyId: 'c1', storeId: 's1', name: 'زيت', sku: 'S', status: 'ACTIVE', sourceType: 'PURCHASED', basePrice: 9 }];
    const base = { companyId: 'c1', storeId: 's1', productId: 'p1', quantityProduced: 0, quantitySold: 0, quantityMovedIn: 0, quantityMovedOut: 0 };
    S.data.productionBatch = [
      { ...base, id: 'old', batchNumber: 'A~1', quantityRemaining: 4, costPerUnit: 2, productionDate: new Date('2026-01-01'), splitFromBatchId: 'gone', inTransitTransferId: 'tr', warehouseId: null },
      { ...base, id: 'new', batchNumber: 'B', quantityRemaining: 3, costPerUnit: 5, productionDate: new Date('2026-02-01'), splitFromBatchId: null, inTransitTransferId: null, warehouseId: 'w-a' },
    ];
    expect((await productCosts(db as never, 'c1', ['p1'])).get('p1')!.nextOut).toBe(5);
    // NEGATIVE: off the road, the oldest row is the next out again.
    S.data.productionBatch[0].inTransitTransferId = null;
    expect((await productCosts(db as never, 'c1', ['p1'])).get('p1')!.nextOut).toBe(2);
  });

  it('the ledger names the warehouse of each line and keeps one warehouse’s lines when asked', async () => {
    freshStore(5);
    await placeRandomly(5);
    const line = (id: string, warehouseId: string | null, h: number) => ({
      id, companyId: 'c1', storeId: 's1', productId: S.data.product[0].id, batchId: null, type: 'SALE', quantity: -1,
      balanceAfter: 0, reason: null, referenceId: null, createdById: null, createdAt: new Date(NOW.getTime() - h * 3_600_000), warehouseId,
    });
    S.data.inventoryMovement = [line('m-a', 'w-a', 1), line('m-b', 'w-b', 2), line('m-store', null, 3), { ...line('m-other', 'w-a', 4), storeId: 's2' }];
    const all = await json(await movementsGet(new Request('http://x/api/inventory/movements')));
    expect(all.warehouses.map((w: Row) => w.name)).toEqual(['مخزن أ', 'مخزن ب']);
    expect(all.movements.map((m: Row) => [m.id, m.warehouseName])).toEqual([['m-a', 'مخزن أ'], ['m-b', 'مخزن ب'], ['m-store', null]]);
    const onlyA = await json(await movementsGet(new Request('http://x/api/inventory/movements?warehouse=w-a')));
    // One warehouse's lines, of THIS store only (the other store's line in the same warehouse is not shown).
    expect(onlyA.movements.map((m: Row) => m.id)).toEqual(['m-a']);
  });

  it('the receive picker is offered only the warehouses this person reaches', async () => {
    freshStore(11);
    await placeRandomly(11);
    const owner = await json(await balancesGet());
    expect(owner.warehouses.map((w: Row) => [w.name, w.mayReceive])).toEqual([['مخزن أ', true], ['مخزن ب', true]]);
    // A keeper of «مخزن ب» only: her country assigned, her keeper row naming one warehouse.
    S.user = { id: 'u-keeper', name: 'أمينة', role: 'WAREHOUSE', companyId: 'c1', permissions: [] };
    S.data.userCountryAccess.push({ userId: 'u-keeper', countryId: 'k1' });
    S.data.userWarehouseAccess.push({ userId: 'u-keeper', warehouseId: 'w-b' });
    const keeper = await json(await balancesGet());
    expect(keeper.warehouses.map((w: Row) => [w.name, w.mayReceive])).toEqual([['مخزن أ', false], ['مخزن ب', true]]);
    // NEGATIVE: no country at all — she may receive into none.
    S.data.userCountryAccess = [];
    const none = await json(await balancesGet());
    expect(none.warehouses.every((w: Row) => w.mayReceive === false)).toBe(true);
  });
});

describe('the last cost no longer depends on the order the database happens to return', () => {
  it('rows scrambled in storage: «آخر كلفة» is still the newest costed run by production date', async () => {
    freshStore(3);
    S.data.product = [{ id: 'p1', companyId: 'c1', storeId: 's1', name: 'زيت', sku: 'S', status: 'ACTIVE', sourceType: 'PURCHASED', basePrice: 9 }];
    const base = { companyId: 'c1', storeId: 's1', productId: 'p1', quantityProduced: 5, quantitySold: 0, quantityRemaining: 5, createdAt: new Date('2026-01-01'), splitFromBatchId: null, warehouseId: null, inTransitTransferId: null };
    // The newest by date was stored FIRST (an update can move a row to the end of the table, so storage order is no clock).
    S.data.productionBatch = [
      { ...base, id: 'b-new', batchNumber: 'N', costPerUnit: 7, productionDate: new Date('2026-03-01') },
      { ...base, id: 'b-old', batchNumber: 'O', costPerUnit: 3, productionDate: new Date('2026-01-01') },
      { ...base, id: 'b-free', batchNumber: 'F', costPerUnit: 0, productionDate: new Date('2026-04-01') },
    ];
    const res = await json(await balancesGet());
    expect(res.stockSummary[0].lastUnitCost).toBe(7);
  });
});
