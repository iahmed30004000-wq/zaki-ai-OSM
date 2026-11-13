import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE DELIVERY TIMES ARE READ ONCE PER TEN MINUTES, NOT ONCE PER VISIT (13/11 — the site's slow-down, plan PR-6).
 *
 * `deliveryWindows` is every delivered order of the last 180 days with each customer's address, plus string work per row —
 * 283 ms and a 64–82 ms block of the whole server per call, measured. It ran on every landing-page view, every product-page
 * view, every public tracking lookup and every pause in typing in the new-order form's address box. The memory is now INSIDE
 * the library, so no caller changes; these tests hold down what makes that safe:
 *   · one read for the same scope, another read for any other scope (company, store, look-back) — no tenant ever gets another's;
 *   · a failed read is forgotten at once, and the askers who arrive while it is being worked out share one read;
 *   · ten minutes to the millisecond, and ZERO under test, so no other test is answered from the previous one's rows;
 *   · the memoized answer is the very answer a direct read gives (differential);
 *   · the Map is now shared between requests, so NOBODY may write to it — one scan of the source.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db } = vi.hoisted(() => ({ db: { order: { findMany: vi.fn() } } }));
vi.mock('./db', () => ({ db }));

const T0 = new Date('2026-11-13T09:00:00Z').getTime();
const SHIPPED = new Date('2026-09-01T00:00:00.000Z');

/** A delivery that took `days`, to `regionId`, to `address`. */
const took = (regionId: string, days: number, address = 'حي الجامعة، شارع 5') => ({
  regionId,
  shippedAt: SHIPPED,
  deliveredAt: new Date(SHIPPED.getTime() + days * 86_400_000),
  customer: { address },
  region: { name: `منطقة ${regionId}` },
});

const batch = (regionId: string, days: number, count = 6) => Array.from({ length: count }, () => took(regionId, days));

type DeliveryTime = typeof import('./delivery-time');

/** The module as production loads it: the memory is on (ten minutes). A new copy every time, so no test inherits a memory. */
async function productionModule(): Promise<DeliveryTime> {
  vi.stubEnv('NODE_ENV', 'production');
  vi.resetModules();
  return import('./delivery-time');
}

/** The module as every test loads it: no memory at all. */
async function testModule(): Promise<DeliveryTime> {
  vi.unstubAllEnvs();
  vi.resetModules();
  return import('./delivery-time');
}

beforeEach(() => {
  db.order.findMany.mockReset();
  db.order.findMany.mockResolvedValue(batch('r1', 2));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('under test there is no memory at all', () => {
  it('two calls for the same scope are two reads — so a test that changes its rows is never answered from the last one', async () => {
    const { deliveryWindows } = await testModule();
    await deliveryWindows({ companyId: 'c1', storeId: 's1' });
    await deliveryWindows({ companyId: 'c1', storeId: 's1' });
    expect(db.order.findMany).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('as production loads it', () => {
  it('two calls for the same scope are ONE read, and the same answer', async () => {
    const { deliveryWindows } = await productionModule();
    const a = await deliveryWindows({ companyId: 'c1', storeId: 's1' });
    const b = await deliveryWindows({ companyId: 'c1', storeId: 's1' });
    expect(db.order.findMany).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
  });

  it('a store that is not named and a store that is null are the same scope (the read treats them alike)', async () => {
    const { deliveryWindows } = await productionModule();
    await deliveryWindows({ companyId: 'c1' });
    await deliveryWindows({ companyId: 'c1', storeId: null });
    await deliveryWindows({ companyId: 'c1', storeId: undefined, lookbackDays: 180 });
    expect(db.order.findMany).toHaveBeenCalledTimes(1);
  });

  it('another company, another store or another look-back is ANOTHER read — and each gets its own answer, never a neighbour’s', async () => {
    // The database answers by company: c1's deliveries took 2 days, c2's took 9.
    db.order.findMany.mockImplementation(async ({ where }: { where: { companyId: string; storeId?: string } }) =>
      where.companyId === 'c1' ? batch('r1', 2) : batch('r1', 9)
    );
    const { deliveryWindows, windowFor } = await productionModule();

    const c1 = await deliveryWindows({ companyId: 'c1', storeId: 's1' });
    const c2 = await deliveryWindows({ companyId: 'c2', storeId: 's1' });
    expect(windowFor(c1, 'r1')?.medianDays, 'أوقات الشركة الأولى').toBe(2);
    expect(windowFor(c2, 'r1')?.medianDays, 'أوقات الشركة التانية — لا تتسرّب من الأولى').toBe(9);

    await deliveryWindows({ companyId: 'c1', storeId: 's2' });
    await deliveryWindows({ companyId: 'c1', storeId: 's1', lookbackDays: 30 });
    expect(db.order.findMany).toHaveBeenCalledTimes(4);

    // …and each of those four is now remembered.
    await deliveryWindows({ companyId: 'c1', storeId: 's1' });
    await deliveryWindows({ companyId: 'c2', storeId: 's1' });
    await deliveryWindows({ companyId: 'c1', storeId: 's2' });
    await deliveryWindows({ companyId: 'c1', storeId: 's1', lookbackDays: 30 });
    expect(db.order.findMany).toHaveBeenCalledTimes(4);
  });

  it('askers who arrive while the read is being worked out share it', async () => {
    const { deliveryWindows } = await productionModule();
    const scope = { companyId: 'c1', storeId: 's1' };
    const all = await Promise.all([deliveryWindows(scope), deliveryWindows(scope), deliveryWindows(scope), deliveryWindows(scope), deliveryWindows(scope)]);
    expect(db.order.findMany).toHaveBeenCalledTimes(1);
    for (const w of all) expect(w).toBe(all[0]);
  });

  it('a failed read is forgotten at once: the next call reads again, and the failure is not served to anyone later', async () => {
    db.order.findMany.mockRejectedValueOnce(new Error('connection pool timeout'));
    const { deliveryWindows, windowFor } = await productionModule();
    const scope = { companyId: 'c1', storeId: 's1' };
    await expect(deliveryWindows(scope)).rejects.toThrow('connection pool timeout');
    const next = await deliveryWindows(scope);
    expect(windowFor(next, 'r1')?.medianDays).toBe(2);
    expect(db.order.findMany).toHaveBeenCalledTimes(2);
  });

  it('TEN MINUTES TO THE MILLISECOND: at 9:59.999 the answer is the same one; at 10:00 it is read again', async () => {
    const { deliveryWindows } = await productionModule();
    const scope = { companyId: 'c1', storeId: 's1' };
    await deliveryWindows(scope);
    vi.setSystemTime(T0 + 10 * 60_000 - 1);
    await deliveryWindows(scope);
    expect(db.order.findMany, 'قبل عشر دقايق').toHaveBeenCalledTimes(1);
    vi.setSystemTime(T0 + 10 * 60_000);
    await deliveryWindows(scope);
    expect(db.order.findMany, 'عند عشر دقايق').toHaveBeenCalledTimes(2);
  });

  it('what a visitor reads after the ten minutes is the NEW answer — a delivery recorded meanwhile shows up', async () => {
    const { deliveryWindows, windowFor } = await productionModule();
    const scope = { companyId: 'c1', storeId: 's1' };
    expect(windowFor(await deliveryWindows(scope), 'r1')?.medianDays).toBe(2);
    db.order.findMany.mockResolvedValue(batch('r1', 8));
    expect(windowFor(await deliveryWindows(scope), 'r1')?.medianDays, 'جوّا العشر دقايق نفس الجواب').toBe(2);
    vi.setSystemTime(T0 + 10 * 60_000);
    expect(windowFor(await deliveryWindows(scope), 'r1')?.medianDays, 'بعد العشر دقايق الجواب الجديد').toBe(8);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('the memoized answer is the answer a direct read gives', () => {
  /** A fixture with every branch of the read in it: streets, governorates below the floor, a negative span, a row with no region. */
  function fixture() {
    let seed = 20261113;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const rows: ReturnType<typeof took>[] = [];
    const streets = ['حي الجامعة، شارع 5', 'الدوار السابع', 'ضاحية الرشيد', 'طلوع الفرن'];
    for (let i = 0; i < 90; i++) {
      const region = `r${1 + Math.floor(rnd() * 5)}`; // five regions, some with fewer than the floor
      rows.push(took(region, Math.round(rnd() * 70) / 10, streets[Math.floor(rnd() * streets.length)]));
    }
    rows.push(took('r1', -3)); // a clock or a correction, not a delivery
    rows.push({ ...took('r2', 2), regionId: null as unknown as string }); // no region
    rows.push({ ...took('r3', 2), shippedAt: null as unknown as Date }); // not shipped
    rows.push(...batch('r9', 1, 3)); // a governorate under the floor
    return rows;
  }

  it('same Map, entry for entry, as the module that has no memory', async () => {
    db.order.findMany.mockResolvedValue(fixture());
    const direct = await (await testModule()).deliveryWindows({ companyId: 'c1', storeId: 's1' });
    const kept = await (await productionModule()).deliveryWindows({ companyId: 'c1', storeId: 's1' });
    expect(direct.size, 'الخريطة فاضية — الفحص ما بيثبت شي').toBeGreaterThan(5);
    expect([...kept.entries()].sort(([a], [b]) => a.localeCompare(b))).toEqual([...direct.entries()].sort(([a], [b]) => a.localeCompare(b)));
  });

  it('the query it asks is the same one: the scope in `where`, the look-back in `since`', async () => {
    const { deliveryWindows } = await productionModule();
    await deliveryWindows({ companyId: 'c7', storeId: 's3', lookbackDays: 30 });
    const where = db.order.findMany.mock.calls[0][0].where;
    expect(where.companyId).toBe('c7');
    expect(where.storeId).toBe('s3');
    expect(where.shippedAt.gte.getTime()).toBe(T0 - 30 * 86_400_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('the answer is shared between requests, so nobody may write to it', () => {
  function sources(dir: string, into: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) sources(p, into);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) into.push(p);
    }
    return into;
  }

  it('every caller of deliveryWindows only reads the Map it is given', () => {
    const root = path.join(process.cwd(), 'src');
    const callers: string[] = [];
    const writers: string[] = [];
    for (const file of sources(root)) {
      const rel = path.relative(root, file).split(path.sep).join('/');
      if (rel === 'lib/delivery-time.ts') continue;
      const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
      if (!/\bdeliveryWindows\(/.test(text)) continue;
      callers.push(rel);
      // The names this file gives the Map it got back: `const windows = await deliveryWindows(` or `… = await MEMO.get(key, () => deliveryWindows(`.
      for (const m of text.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?[^;]*?\bdeliveryWindows\(/g)) {
        if (new RegExp(`\\b${m[1]}\\.(?:set|delete|clear)\\(`).test(text)) writers.push(`${rel}:${m[1]}`);
      }
    }
    expect(callers.length, 'ما لقينا المستدعين — الفحص ما بيحرس شي').toBeGreaterThanOrEqual(5);
    expect(writers, 'مستدعي كتب على الخريطة المشتركة').toEqual([]);
  });
});
