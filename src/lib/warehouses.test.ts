import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * WAREHOUSES — the reach rule, the stop list, and the promise that this
 * request is INERT for stock.
 */

vi.mock('@/lib/db', () => ({ db: {} }));

import { reachesWarehouse, reachesWarehouseByFacts, stopRefusalAr, storeIsPlaced, warehousesReachedBy, warehouseStopBlockers, type WarehouseReachFacts } from './warehouses';

const base: WarehouseReachFacts = {
  seesAll: false,
  countryOpen: true,
  countryAssigned: true,
  hasStoreGrants: false,
  storesInCountry: 0,
  keeperOf: [],
};
const reach = (over: Partial<WarehouseReachFacts>, id = 'w1') => reachesWarehouseByFacts({ ...base, ...over }, id);

describe('who reaches a warehouse', () => {
  it('somebody assigned the country, with no keeper rows: every warehouse of it', () => {
    expect(reach({})).toBe(true);
  });

  it('NEGATIVE: the country not assigned', () => {
    expect(reach({ countryAssigned: false })).toBe(false);
  });

  it('NEGATIVE: the country stopped — even for the owner', () => {
    expect(reach({ countryOpen: false })).toBe(false);
    expect(reach({ countryOpen: false, seesAll: true })).toBe(false);
  });

  it('the owner / geo.manage: every warehouse of an open country, keeper rows or not, assigned or not', () => {
    expect(reach({ seesAll: true, countryAssigned: false, keeperOf: ['w9'] })).toBe(true);
  });

  it('a keeper reaches the warehouses she keeps, and NEGATIVE: not their siblings', () => {
    expect(reach({ keeperOf: ['w1'] }, 'w1')).toBe(true);
    expect(reach({ keeperOf: ['w1'] }, 'w2')).toBe(false);
  });

  it('NEGATIVE: a keeper row elsewhere confines her here too (no rows HERE is not «everything here»)', () => {
    expect(reach({ keeperOf: ['w-other-country'] }, 'w1')).toBe(false);
  });

  it('NEGATIVE: a keeper who lost her country loses the warehouse, though the row stays', () => {
    expect(reach({ keeperOf: ['w1'], countryAssigned: false }, 'w1')).toBe(false);
  });

  it('NEGATIVE: somebody confined to named stores reaches only countries one of them is in', () => {
    expect(reach({ hasStoreGrants: true, storesInCountry: 0 })).toBe(false);
    expect(reach({ hasStoreGrants: true, storesInCountry: 1 })).toBe(true);
  });
});

describe('another company’s warehouse is never reached — answered before anything is read', () => {
  const me = { id: 'u1', role: 'SUPER_ADMIN', status: 'ACTIVE', companyId: 'c1' } as never;
  const foreign = { id: 'w9', companyId: 'c2', countryId: 'k9' };

  it('one warehouse of another company: no — even for the owner', async () => {
    expect(await reachesWarehouse(me, 'c1', foreign)).toBe(false);
  });

  it('a list of another company’s warehouses: empty', async () => {
    expect(await warehousesReachedBy(me, 'c1', [foreign])).toEqual([]);
  });
});

describe('a store is not placed until its placement exists', () => {
  it('storeIsPlaced answers no — every store behaves as before', async () => {
    expect(await storeIsPlaced('any-store')).toBe(false);
  });
});

describe('why a warehouse may not stop', () => {
  const client = (n: number) => {
    const count = vi.fn().mockResolvedValue(n);
    return { client: { productionBatch: { count } } as never, count };
  };

  it('asks for batches of THIS company and THIS warehouse with any units, positive or owed', async () => {
    const { client: c, count } = client(0);
    expect(await warehouseStopBlockers(c, 'c1', 'w1')).toEqual([]);
    expect(count).toHaveBeenCalledWith({ where: { companyId: 'c1', warehouseId: 'w1', quantityRemaining: { not: 0 } } });
  });

  it('NEGATIVE: a batch with units is a blocker, said in Arabic', async () => {
    const blockers = await warehouseStopBlockers(client(3).client, 'c1', 'w1');
    expect(blockers).toEqual([{ code: 'HOLDS_UNITS', count: 3, ar: expect.stringContaining('3') }]);
    expect(stopRefusalAr(blockers)).toMatch(/^ما بينوقف هالمخزن/);
  });
});

/**
 * THIS REQUEST IS INERT FOR STOCK.
 *
 * The new columns (a batch's place, its move counters, a movement's place, a
 * shipment's warehouse, an order's source) exist but NO stock door reads or
 * writes them yet. This list is every production file allowed to name them;
 * each later request of the warehouse plan adds its own files here, in the
 * same pull request that makes them read — so a stock door can never start
 * reading a place without the change being visible in review.
 */
describe('nothing outside the warehouse doors names the new columns', () => {
  const ROOT = process.cwd();
  const ALLOWED = new Set([
    'src/lib/warehouses.ts',
    'src/app/api/geo/warehouses/route.ts',
    'src/app/api/geo/warehouses/[id]/route.ts',
    'src/app/api/geo/warehouses/[id]/keepers/route.ts',
  ]);
  const NEW_NAMES = /\b(warehouseId|sourceWarehouseId|quantityMovedIn|quantityMovedOut|splitFromBatchId|inTransitTransferId|userWarehouseAccess|warehouse_id|quantity_moved_in|quantity_moved_out|split_from_batch_id|in_transit_transfer_id)\b|\b(db|tx)\.warehouse\./;

  function files(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...files(p));
      else if (/\.(ts|tsx|mjs)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
    }
    return out;
  }

  it('the sweep finds the warehouse doors themselves (it is looking at a real tree)', () => {
    const named = files(join(ROOT, 'src')).map((p) => relative(ROOT, p).split(sep).join('/')).filter((r) => NEW_NAMES.test(readFileSync(join(ROOT, r), 'utf8')));
    expect(named).toContain('src/lib/warehouses.ts');
  });

  it('and no other file of src/ or scripts/ names them', () => {
    const offenders = [...files(join(ROOT, 'src')), ...files(join(ROOT, 'scripts'))]
      .map((p) => relative(ROOT, p).split(sep).join('/'))
      .filter((r) => !ALLOWED.has(r) && NEW_NAMES.test(readFileSync(join(ROOT, r), 'utf8')));
    expect(offenders, 'بابٌ يقرأ أعمدة المخازن قبل أن يُبنى طلبُه').toEqual([]);
  });

  it('and the warehouse module touches no money: no wallet, expense or profit import', () => {
    const src = readFileSync(join(ROOT, 'src/lib/warehouses.ts'), 'utf8');
    const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(imports.filter((i) => /wallet|expense|profit|financ|commission|settlement/i.test(i))).toEqual([]);
  });
});
