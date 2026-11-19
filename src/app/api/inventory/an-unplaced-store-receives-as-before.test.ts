import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A STORE THAT WAS NEVER PLACED RECEIVES, PRODUCES AND COUNTS EXACTLY AS BEFORE (the warehouse plan, W2a).
 *
 * The doors that put units into a store now ask «is this store placed in warehouses?» and, for a placed one, demand a
 * warehouse. For every other store nothing may change: the same answers, the same refusals, the same rows written with
 * the same values, the same audit lines. The frozen file beside this test holds what the MAIN branch's code answered for
 * the same random requests — `git show osm/main:` of
 *   src/app/api/inventory/route.ts   (receive and recount, with main's `receiving.ts` under it)
 *   src/app/api/production/route.ts  (a production run)
 *   src/lib/stock-opening-count.ts   (the opening count, with main's `receiving.ts` under it)
 * run against the in-memory database below, at a frozen clock. This test runs today's code on the very same requests and
 * compares everything, `toEqual`.
 *
 * Every body may carry a `warehouseId` — absent, a real one, another country's, a stopped one, junk of the wrong type —
 * because main's schemas stripped such a field: today's doors must ignore it for an unplaced store, not refuse it.
 *
 * The draws (every delivery door, the losses, the write-off, the recount's shortfall) all go through
 * `receiving.drawDownStock`; its unplaced answers are pinned by `src/lib/stock-money.main-golden.json`
 * (`a-placed-store-costs-what-it-did.test.ts`), which still passes with today's `inTransitTransferId: null` condition.
 *
 * TO REGENERATE (only if main itself changes these doors): copy the three files of main and main's `receiving.ts` next to
 * their originals as `*.w2a-main.ts` (pointing the routes' and the count's `receiving` import at the copy), run this file
 * with `W2A_WRITE_GOLDEN=1`, delete the copies.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- an in-memory row; every field is read by name
type Row = Record<string, any>;

const S = vi.hoisted(() => ({
  data: {} as Record<string, Row[]>,
  writes: [] as Row[],
  audit: [] as Row[],
  seq: 0,
  ctx: { storeId: 's1' as string },
  reserved: {} as Record<string, number>,
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
      if ('startsWith' in o && !(typeof v === 'string' && v.startsWith(o.startsWith))) return false;
      return true;
    }
    return v === c;
  };
  const matches = (r: Row, w: Row = {}): boolean =>
    Object.entries(w).every(([k, c]) => {
      if (c === undefined) return true;
      if (k === 'OR') return (c as Row[]).some((x) => matches(r, x));
      if (k === 'companyId_batchNumber') return matches(r, c as Row);
      return scalar(r[k], c);
    });
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
      count: async ({ where }: Row = {}) => rows().filter((r) => matches(r, where)).length,
      aggregate: async ({ where, _sum }: Row) => {
        const hit = rows().filter((x) => matches(x, where));
        return { _sum: Object.fromEntries(Object.keys(_sum).map((k) => [k, hit.length ? hit.reduce((s, r) => s + r[k], 0) : null])) };
      },
      create: async ({ data, select }: Row) => {
        if (name === 'productionBatch' && rows().some((r) => r.companyId === data.companyId && r.batchNumber === data.batchNumber)) {
          throw new Error('Unique constraint failed on the fields: (`companyId`,`batchNumber`)');
        }
        S.writes.push({ table: name, op: 'create', data: JSON.parse(JSON.stringify(data)) });
        const row = { id: `${name}-${++S.seq}`, createdAt: new Date(), ...data };
        rows().push(row);
        return pick(row, select);
      },
      update: async ({ where, data }: Row) => {
        const r = rows().find((x) => matches(x, where));
        if (!r) throw new Error('No record was found for an update.');
        S.writes.push({ table: name, op: 'update', where: JSON.parse(JSON.stringify(where)), data: JSON.parse(JSON.stringify(data)) });
        Object.assign(r, data);
        return { ...r };
      },
    };
  };
  const names = ['store', 'product', 'productionBatch', 'inventoryMovement', 'warehouse', 'warehousePlacement', 'stockOpeningCount'];
  const db: Row = Object.fromEntries(names.map((n) => [n, t(n)]));
  db.$executeRaw = async () => 1;
  db.$queryRaw = async () => [];
  const tx = new Proxy(db, { has: (o, p) => p !== '$transaction' && p in o });
  db.$transaction = async (fn: (t: Row) => unknown) => fn(tx);
  return { db };
});
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({ user: { id: 'u1', name: 'أمين', companyId: 'c1' }, companyId: 'c1', storeId: S.ctx.storeId, country: { currencyCode: 'SYP' } }),
}));
vi.mock('@/lib/authorization', () => ({ requirePermission: async () => undefined, can: () => true }));
vi.mock('@/lib/audit', () => ({ logAudit: async (e: Row) => void S.audit.push(JSON.parse(JSON.stringify(e))) }));
vi.mock('@/lib/reservation', async (orig) => ({
  ...(await orig<typeof import('@/lib/reservation')>()),
  reservedElsewhere: async (_db: unknown, _c: string, productId: string) => S.reserved[productId] ?? 0,
}));

const GOLDEN = join(__dirname, 'receive.main-golden.json');
const WRITE = process.env.W2A_WRITE_GOLDEN === '1';

/* ───────────── a random unplaced store and random requests ───────────── */

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

const PRODUCT_IDS = ['p-buy-0000001', 'p-buy-0000002', 'p-made-000001', 'p-made-000002', 'p-other-store1'];

function freshStore(r: () => number) {
  const int = (n: number) => Math.floor(r() * n);
  S.seq = 0;
  S.writes = [];
  S.audit = [];
  S.ctx.storeId = 's1';
  S.reserved = Object.fromEntries(PRODUCT_IDS.map((p) => [p, r() < 0.4 ? int(8) : 0]));
  S.data = {
    store: [{ id: 's1', companyId: 'c1', countryId: 'k1' }, { id: 's2', companyId: 'c1', countryId: 'k1' }],
    warehouse: [
      { id: 'w1', companyId: 'c1', countryId: 'k1', isActive: true },
      { id: 'w-off', companyId: 'c1', countryId: 'k1', isActive: false },
      { id: 'w-jo', companyId: 'c1', countryId: 'k2', isActive: true },
    ],
    // A store that was never placed: NO row here, ever, in this file. (Another store's placement does not place this one.)
    warehousePlacement: r() < 0.3 ? [{ id: 'pl-s2', storeId: 's2', companyId: 'c1' }] : [],
    product: [
      { id: PRODUCT_IDS[0], companyId: 'c1', storeId: 's1', name: 'زيت', sourceType: 'PURCHASED' },
      { id: PRODUCT_IDS[1], companyId: 'c1', storeId: 's1', name: 'صابون', sourceType: 'PURCHASED' },
      { id: PRODUCT_IDS[2], companyId: 'c1', storeId: 's1', name: 'كريم', sourceType: 'MANUFACTURED' },
      { id: PRODUCT_IDS[3], companyId: 'c1', storeId: 's1', name: 'مرهم', sourceType: 'MANUFACTURED' },
      { id: PRODUCT_IDS[4], companyId: 'c1', storeId: 's2', name: 'غريب', sourceType: 'PURCHASED' },
    ],
    productionBatch: [],
    inventoryMovement: [],
    stockOpeningCount: r() < 0.1 ? [{ id: 'oc', storeId: 's1', countedByName: 'سابق', countedAt: new Date('2026-09-01T00:00:00Z') }] : [],
  };
  let n = 0;
  for (const p of PRODUCT_IDS.slice(0, 4)) {
    for (let b = int(4); b > 0; b--) {
      const produced = 1 + int(30);
      const sold = int(produced + 1);
      const cost = r() < 0.2 ? 0 : Math.round(r() * 100000) / 10000;
      S.data.productionBatch.push({
        id: `b-${p}-${b}`, companyId: 'c1', storeId: 's1', productId: p, batchNumber: `OLD-${p}-${b}`,
        quantityProduced: produced, quantitySold: sold, quantityRemaining: produced - sold, quantityMovedIn: 0, quantityMovedOut: 0,
        costPerUnit: cost, totalProductionCost: cost * produced, productionDate: new Date(Date.UTC(2026, 8, 1 + int(20))),
        createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, ++n)), status: 'COMPLETED', notes: null,
        warehouseId: null, inTransitTransferId: null, splitFromBatchId: null,
      });
    }
  }
  if (r() < 0.3) S.data.inventoryMovement.push({ id: 'm-old', companyId: 'c1', storeId: 's1', productId: PRODUCT_IDS[0], type: 'PRODUCTION', quantity: 1 });
}

const WAREHOUSE_FIELD = (r: () => number): Row => {
  const x = r();
  if (x < 0.4) return {};
  if (x < 0.55) return { warehouseId: 'w1' };
  if (x < 0.65) return { warehouseId: 'w-jo' };
  if (x < 0.75) return { warehouseId: 'w-off' };
  if (x < 0.85) return { warehouseId: 12345 };
  if (x < 0.92) return { warehouseId: null };
  return { warehouseId: '' };
};
const QTY = (r: () => number) => {
  const x = r();
  return x < 0.08 ? 0 : x < 0.12 ? -3 : x < 0.16 ? '1e3' : x < 0.2 ? 'abc' : x < 0.24 ? 2.5 : 1 + Math.floor(r() * 40);
};
const COST = (r: () => number) => {
  const x = r();
  return x < 0.3 ? undefined : x < 0.4 ? 0 : x < 0.45 ? -1 : x < 0.5 ? '3,5' : Math.round(r() * 100000) / 1000;
};
const PRODUCT = (r: () => number) => (r() < 0.06 ? 'missing-product-x' : PRODUCT_IDS[Math.floor(r() * PRODUCT_IDS.length)]);

function inventoryBody(r: () => number): Row {
  if (r() < 0.6) {
    return {
      action: 'receive', productId: PRODUCT(r), quantity: QTY(r), unitCost: COST(r),
      ...(r() < 0.3 ? { zeroCostReason: r() < 0.5 ? 'عيّنة مجانية' : 'x' } : {}),
      ...(r() < 0.4 ? { note: 'دفعة المورّد' } : {}), ...WAREHOUSE_FIELD(r),
    };
  }
  return {
    action: 'recount', productId: PRODUCT(r), countedQuantity: r() < 0.1 ? -1 : Math.floor(r() * 40),
    reason: r() < 0.1 ? 'x' : 'جرد آخر الشهر', ...WAREHOUSE_FIELD(r),
  };
}

function productionBody(r: () => number): Row {
  const lines = r() < 0.4 ? Array.from({ length: 1 + Math.floor(r() * 3) }, (_, i) => ({ label: r() < 0.1 ? ' ' : `بند ${i}`, amount: COST(r) ?? 1 })) : undefined;
  return {
    productId: PRODUCT(r),
    batchNumber: r() < 0.08 ? `OLD-${PRODUCT_IDS[2]}-1` : r() < 0.05 ? '' : `run-${Math.floor(r() * 1e6)}`,
    quantityProduced: QTY(r),
    ...(r() < 0.7 ? { manufacturingCost: COST(r) } : {}),
    ...(r() < 0.4 ? { packagingCost: COST(r) } : {}),
    ...(lines ? { costLines: lines } : {}),
    ...(r() < 0.3 ? { productionDate: r() < 0.2 ? 'abc' : '2026-10-05' } : {}),
    ...(r() < 0.3 ? { notes: 'تشغيلة الصبح' } : {}),
    ...WAREHOUSE_FIELD(r),
  };
}

function countInput(r: () => number): Row {
  const lines = Array.from({ length: Math.floor(r() * 4) }, () => ({
    productId: PRODUCT(r),
    countedQty: r() < 0.1 ? -1 : r() < 0.2 ? 0 : Math.floor(r() * 30),
    unitCost: r() < 0.2 ? 0 : Math.round(r() * 10000) / 1000,
    ...(r() < 0.3 ? { zeroCostReason: 'هدية من المورّد' } : {}),
  }));
  return {
    companyId: 'c1', storeId: 's1', countedByName: r() < 0.1 ? 'ab' : 'أبو محمّد', countedAt: new Date('2026-10-01T06:00:00Z'),
    lines, note: r() < 0.3 ? 'عدّ أول' : null, recordedById: 'u1', now: new Date('2026-10-01T09:00:00Z'),
    ...WAREHOUSE_FIELD(r),
  };
}

/* ───────────── run one implementation over the seeded requests ───────────── */

type Impl = {
  inventoryPOST: (req: Request) => Promise<Response>;
  productionPOST: (req: Request) => Promise<Response>;
  recordOpeningStockCount: (tx: never, input: never) => Promise<unknown>;
};

const snapshot = () => ({
  writes: S.writes,
  audit: S.audit,
  batches: S.data.productionBatch.map((b) => [b.id, b.quantityRemaining, b.quantitySold, b.warehouseId ?? null]),
});

async function answer(res: Response) {
  return { status: res.status, body: await res.json() };
}

async function runAll(impl: Impl) {
  const out: Row[] = [];
  const { db } = await import('@/lib/db');
  for (let seed = 1; seed <= 300; seed++) {
    const r = rng(seed);
    freshStore(r);
    const body = inventoryBody(r);
    const res = await answer(await impl.inventoryPOST(new Request('http://x/api/inventory', { method: 'POST', body: JSON.stringify(body) })));
    out.push({ door: 'inventory', seed, res, ...snapshot() });
  }
  for (let seed = 1001; seed <= 1250; seed++) {
    const r = rng(seed);
    freshStore(r);
    const body = productionBody(r);
    const res = await answer(await impl.productionPOST(new Request('http://x/api/production', { method: 'POST', body: JSON.stringify(body) })));
    out.push({ door: 'production', seed, res, ...snapshot() });
  }
  for (let seed = 2001; seed <= 2200; seed++) {
    const r = rng(seed);
    freshStore(r);
    const input = countInput(r);
    let res: Row;
    try {
      res = { ok: await db.$transaction((tx) => impl.recordOpeningStockCount(tx as never, input as never)) };
    } catch (e) {
      res = { refused: (e as Error).message, code: (e as Row).code ?? null };
    }
    out.push({ door: 'opening-count', seed, res, ...snapshot() });
  }
  return JSON.parse(JSON.stringify(out));
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-19T08:30:00.000Z'));
});
afterAll(() => vi.useRealTimers());

describe('an unplaced store: receive, recount, production and the opening count answer as osm/main did (frozen golden)', () => {
  it('750 random requests — the same answers, refusals, rows and audit lines', async () => {
    if (WRITE) {
      // Paths built at run time: the copies exist only while the golden is being written.
      const at = (p: string) => join(process.cwd(), p);
      const impl: Impl = {
        inventoryPOST: (await import(/* @vite-ignore */ at('src/app/api/inventory/route.w2a-main.ts'))).POST,
        productionPOST: (await import(/* @vite-ignore */ at('src/app/api/production/route.w2a-main.ts'))).POST,
        recordOpeningStockCount: (await import(/* @vite-ignore */ at('src/lib/stock-opening-count.w2a-main.ts'))).recordOpeningStockCount,
      };
      writeFileSync(GOLDEN, JSON.stringify(await runAll(impl)));
    }
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
    expect(golden).toHaveLength(750);
    // The golden is not vacuous: it holds successes that wrote rows AND refusals, at every door.
    for (const door of ['inventory', 'production', 'opening-count']) {
      const mine = golden.filter((g: Row) => g.door === door);
      expect(mine.some((g: Row) => g.writes.length > 0), door).toBe(true);
      expect(mine.some((g: Row) => g.writes.length === 0), door).toBe(true);
    }
    const today: Impl = {
      inventoryPOST: (await import('./route')).POST,
      productionPOST: (await import('@/app/api/production/route')).POST,
      recordOpeningStockCount: (await import('@/lib/stock-opening-count')).recordOpeningStockCount as never,
    };
    const now = await runAll(today);
    for (let i = 0; i < golden.length; i++) expect(now[i], `${golden[i].door} seed ${golden[i].seed}`).toEqual(golden[i]);
  });
});
