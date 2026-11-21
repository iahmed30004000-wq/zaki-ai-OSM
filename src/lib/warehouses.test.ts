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

/*
 * 19/11, W1a: this answered «no» for every store by construction (old: `storeIsPlaced('any-store') === false` with no
 * read). The placement table exists now, so the answer is the row's: still «no» for every store without one — which is
 * every store until somebody places it — and «yes» only for the store whose row it is.
 */
describe('a store is not placed until its placement exists', () => {
  const client = (rows: { storeId: string }[]) => {
    const findUnique = vi.fn(async ({ where }: { where: { storeId: string } }) => (rows.some((r) => r.storeId === where.storeId) ? { id: 'p1' } : null));
    return { client: { warehousePlacement: { findUnique } } as never, findUnique };
  };

  it('storeIsPlaced answers no for a store with no placement row — every store behaves as before', async () => {
    expect(await storeIsPlaced('any-store', client([]).client)).toBe(false);
  });

  it('NEGATIVE: another store’s placement does not place this one', async () => {
    expect(await storeIsPlaced('s1', client([{ storeId: 's2' }]).client)).toBe(false);
  });

  it('yes once its own row exists — asked by the store, nothing else', async () => {
    const { client: c, findUnique } = client([{ storeId: 's1' }]);
    expect(await storeIsPlaced('s1', c)).toBe(true);
    expect(findUnique).toHaveBeenCalledWith({ where: { storeId: 's1' }, select: { id: true } });
  });
});

/*
 * warehousesOfStore — its first caller is the placement door (W1a). W0a's review noted two things untested: the company
 * scope, and whether a stopped warehouse is offered. Both pinned here against the query it really sends.
 */
describe('the warehouses a store may place its goods in', () => {
  it('NEGATIVE: a store of another company finds none — and no warehouse is asked for', async () => {
    const { db } = await import('./db');
    const findFirst = vi.fn(async () => null);
    const findMany = vi.fn(async () => [{ id: 'w1' }]);
    Object.assign(db as object, { store: { findFirst }, warehouse: { findMany } });
    const { warehousesOfStore } = await import('./warehouses');
    expect(await warehousesOfStore('c1', 'store-of-c2')).toEqual([]);
    expect(findFirst).toHaveBeenCalledWith({ where: { id: 'store-of-c2', companyId: 'c1' }, select: { countryId: true } });
    expect(findMany).not.toHaveBeenCalled();
  });

  it('only the RUNNING warehouses of the store’s own country and company (NEGATIVE: a stopped one is not offered)', async () => {
    const { db } = await import('./db');
    const findMany = vi.fn(async () => []);
    Object.assign(db as object, { store: { findFirst: async () => ({ countryId: 'k1' }) }, warehouse: { findMany } });
    const { warehousesOfStore } = await import('./warehouses');
    await warehousesOfStore('c1', 's1');
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { companyId: 'c1', countryId: 'k1', isActive: true } }));
  });
});

describe('why a warehouse may not stop', () => {
  // 20/11 (W3a): the client answers the open-transfer question too (old: only `productionBatch.count`); 0 open = today.
  // 20/11 (W6a): …and the pending-exit question (old: batches + transfers); 0 pending = the answer before W6a.
  // 21/11 (W5a): …and the open-count question (old: batches + transfers + exits); 0 open sheets = the answer before W5a.
  const client = (n: number, open = 0, pending = 0, counting = 0) => {
    const count = vi.fn().mockResolvedValue(n);
    const transfers = vi.fn().mockResolvedValue(open);
    const exits = vi.fn().mockResolvedValue(pending);
    const sheets = vi.fn().mockResolvedValue(counting);
    return {
      client: { productionBatch: { count }, stockTransfer: { count: transfers }, stockExit: { count: exits }, stockCount: { count: sheets } } as never,
      count,
      transfers,
      exits,
      sheets,
    };
  };

  it('NEGATIVE (W5a): an open count sheet on it is a blocker — being counted or waiting for its second hand', async () => {
    const { client: c, sheets } = client(0, 0, 0, 1);
    expect(await warehouseStopBlockers(c, 'c1', 'w1')).toEqual([{ code: 'OPEN_COUNT', count: 1, ar: expect.stringContaining('جرد') }]);
    // THIS company, THIS warehouse, only a sheet OPEN or SUBMITTED (an approved or voided one holds nothing).
    expect(sheets).toHaveBeenCalledWith({ where: { companyId: 'c1', warehouseId: 'w1', status: { in: ['OPEN', 'SUBMITTED'] } } });
  });

  it('NEGATIVE (W6a): a pending exit from it is a blocker — its units are held for an approval in this warehouse', async () => {
    const { client: c, exits } = client(0, 0, 1);
    expect(await warehouseStopBlockers(c, 'c1', 'w1')).toEqual([{ code: 'PENDING_EXIT', count: 1, ar: expect.stringContaining('إخراج') }]);
    // THIS company, THIS warehouse, only the PENDING ones (an approved or rejected exit holds nothing).
    expect(exits).toHaveBeenCalledWith({ where: { companyId: 'c1', warehouseId: 'w1', status: 'PENDING' } });
  });

  it('NEGATIVE (W3a): an open transfer from or to it is a blocker — units on the road have no warehouse', async () => {
    const { client: c, transfers } = client(0, 2);
    expect(await warehouseStopBlockers(c, 'c1', 'w1')).toEqual([{ code: 'OPEN_TRANSFER', count: 2, ar: expect.stringContaining('نقل مفتوح') }]);
    expect(transfers).toHaveBeenCalledWith({
      where: {
        companyId: 'c1',
        OR: [{ fromWarehouseId: 'w1' }, { toWarehouseId: 'w1' }],
        // 20/11 (W7b): a transfer to another country AWAITING the owner holds its units too, so it keeps the warehouse
        // running (was: SENT and the unapproved difference only).
        AND: [{ OR: [{ status: 'AWAITING_APPROVAL' }, { status: 'SENT' }, { status: 'RECEIVED_WITH_DIFFERENCE', differenceApprovedAt: null }] }],
      },
    });
  });

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
    // 19/11, W1a (the opening placement): the split primitive, the placement, its two doors and their shared helper; the
    // cost fix that carries a run's corrected cost to the rows split from it; the store-removal list that counts the
    // placement row.
    'src/lib/batch-split.ts',
    'src/lib/warehouse-placement.ts',
    'src/lib/placement-door.ts',
    'src/app/api/inventory/placement/route.ts',
    'src/app/api/inventory/placement/preview/route.ts',
    'src/app/api/production/[id]/route.ts',
    'src/lib/geo-removal.ts',
    // 19/11, W1a review: the money readers cost a run and the rows split from it as one layer (`batch-family.ts`), and the
    // draw-down writes a row only while it still holds what was read.
    'src/lib/batch-family.ts',
    'src/lib/receiving.ts',
    'src/lib/product-cost.ts',
    // 19/11, W2a (receiving and production name a warehouse): the intake rule, the two doors that put units in, the
    // opening count that refuses a placed store, and the stop door's lock against a receipt.
    'src/lib/warehouse-intake.ts',
    'src/app/api/inventory/route.ts',
    'src/app/api/production/route.ts',
    // 19/11, W1b (the placement sheet): the screen of the placement doors above. It reads no column; it writes the door's
    // own body field `counts[].warehouseId` (W1a's `countsSchema`), which this sweep cannot tell from a column by its name.
    'src/components/inventory/PlacementSheet.tsx',
    // 20/11, W8a (a combination's count per warehouse): the one writer and its ledger, the draw-down and the restock that
    // hand a placed store's pieces to it (the draw reads the order's source warehouse), and the variants door's count.
    'src/lib/variant-stock.ts',
    'src/lib/product-variants.ts',
    'src/app/api/products/[id]/variants/route.ts',
    // 19/11, W2c (the stock screens show places): the balances and the ledger read where units are; the runs list and the
    // product page fold a split row into its run; the receive dialog sends the receive door's own `warehouseId` field.
    'src/app/api/inventory/movements/route.ts',
    'src/app/api/products/[id]/route.ts',
    'src/components/inventory/ReceiveDialog.tsx',
    'src/components/screens/InventoryBalancesScreen.tsx',
    'src/lib/batch-grade.ts',
    'src/lib/stock-places.ts',
    // 20/11, W3a (the transfer inside one store): the transfer lib and its door helper, the four doors (send + list,
    // receive, cancel, difference), and the kind file that holds the stop door's «open transfer» question.
    'src/lib/stock-transfers.ts',
    'src/lib/stock-transfer-door.ts',
    'src/lib/stock-transfer-kind.ts',
    'src/app/api/inventory/transfers/route.ts',
    'src/app/api/inventory/transfers/[id]/receive/route.ts',
    'src/app/api/inventory/transfers/[id]/cancel/route.ts',
    'src/app/api/inventory/transfers/[id]/difference/route.ts',
    // 20/11, W6a (goods out of a warehouse for good): the exit lib, its door helper and its three doors (request + list,
    // approve, reject). They name the exit's own `warehouseId` and draw from it (`receiving.drawDownStock`).
    'src/lib/stock-exits.ts',
    'src/lib/stock-exit-door.ts',
    'src/app/api/inventory/exits/route.ts',
    'src/app/api/inventory/exits/[id]/approve/route.ts',
    'src/app/api/inventory/exits/[id]/reject/route.ts',
    // 20/11, W3b (the «نقل البضاعة» screen): the screen of the four transfer doors above. It reads no column; it hands
    // `stock-transfer-kind.readStockTransfer` the end's own field `warehouseId` (`StockTransferEnd`) to say the kind before
    // the press, which this sweep cannot tell from a column by its name.
    'src/components/screens/StockTransfersScreen.tsx',
    // 20/11, W6b (the «إخراج بضاعة» screen and its month): the screen sends the request door's own body field `warehouseId`
    // (W6a's `requestSchema`); the month's report reads each approved exit's `warehouseId` and its warehouse's NAME only
    // (`db.warehouse.findMany` — id and name), to say where the units left from. Neither reads a stock column.
    'src/components/screens/StockExitsScreen.tsx',
    'src/lib/stock-exit-report.ts',
    // 20/11, W4a (a shipment is made in ONE warehouse): the shipment's place and the warehouse's shelf for the blocks; the
    // two doors that open a trolley and the preparation list that may be asked per warehouse; the two «off the trolley»
    // column lists that drop the order's source; the doors that put an order on an existing trolley (assign to a batch,
    // move to another courier's trolley before the handover) so a trolley never mixes warehouses.
    'src/lib/shipment-warehouse.ts',
    'src/lib/shipment-cancel.ts',
    'src/app/api/ops/shipments/route.ts',
    'src/app/api/shipping-batches/route.ts',
    'src/app/api/ops/preparation/route.ts',
    'src/app/api/orders/[id]/shipping/route.ts',
    'src/app/api/ops/tracking/transfer/route.ts',
    // 20/11, W4c (the shipping screens by warehouse): «إنشاء شحنة» sends the warehouse the press leaves from (`warehouseId`),
    // for a placed store only — the body W4a's door asks for.
    'src/components/screens/ShipmentsNewScreen.tsx',
    // 20/11, W4d (the order says where it left from): READ ONLY — the name lookup, and the three doors that read the
    // order's `sourceWarehouseId` to send the warehouse's name (order window, tracking row, returns desk). None writes it.
    'src/lib/order-source-warehouse.ts',
    'src/app/api/orders/[id]/route.ts',
    'src/app/api/ops/tracking/route.ts',
    'src/app/api/ops/returns/route.ts',
    // 20/11, W3c («بالطريق» where it matters): the notice of a sent transfer reads the two ends' names and the
    // destination's keeper rows (`userWarehouseAccess`) to tell the keepers who may receive — no stock column, no unit.
    'src/lib/stock-transfer-alerts.ts',
    // 20/11, W8b (combinations in the stock documents): the module that moves a combination's pieces with a transfer, an
    // exit and the opening placement — it reads a combination's place in a warehouse (`warehouseId`) and on a road.
    'src/lib/variant-lines.ts',
    // 20/11, W8c (the combination grid in the stock screens): READ ONLY — it reads the variants door's own answer
    // (`places[].warehouseId`, W8a) to print one combination's shelf figure in the form's source warehouse. No column, no write.
    'src/components/inventory/CombinationBoxes.tsx',
    // 20/11, W4b (the delivery takes the units from the order's warehouse — the owner's word on the cost point): the one
    // function every delivery door shares reads the order's `sourceWarehouseId`, hands it to the draw as `prefer` and
    // writes it on the SALE line; the warehouse names of a «فرق مكان» come from `order-source-warehouse.ts`.
    'src/lib/stock-consumption.ts',
    // 20/11, W2b (returns and the quick count name a warehouse — the owner's decision 4): the receipt reads the order's
    // `sourceWarehouseId` (the desk's default receiver) and whether its store has a `warehousePlacement`; the receive-all
    // door sends one `warehouseId` for the press; the quick count of one warehouse reads its rows and the orders that
    // left it (`warehouse-count.ts`); the two screens send the warehouse the person picked.
    'src/lib/return-receipt.ts',
    'src/app/api/ops/returns/receive-all/route.ts',
    'src/lib/warehouse-count.ts',
    'src/components/screens/ReturnsScreen.tsx',
    // 21/11, W5a (the count against the keeper): the count lib (a sheet names its warehouse; the expected figure is
    // `warehouse-count.expectedInWarehouse`; a combination's expected reads its place in the warehouse and the orders that
    // left it), its door helper, its five doors, and the freeze (a sheet's `warehouseId` that every stock door asks about).
    'src/lib/stock-counts.ts',
    'src/lib/stock-count-freeze.ts',
    'src/lib/stock-count-door.ts',
    'src/app/api/inventory/counts/route.ts',
    'src/app/api/inventory/counts/[id]/route.ts',
    'src/app/api/inventory/counts/[id]/submit/route.ts',
    'src/app/api/inventory/counts/[id]/approve/route.ts',
    'src/app/api/inventory/counts/[id]/void/route.ts',
    // 21/11, W5b (the «الجرد» screen and «كشف عهدة الأمين»): the screen sends the open door's own body field `warehouseId`
    // (W5a's `openSchema`) and the statement's `?warehouseId=`; the statement door reads that one warehouse (id, country,
    // name) to ask the count doors' reach rule; the statement reads the approved sheets OF that warehouse (their
    // `warehouseId` filter) and its keepers' names (`userWarehouseAccess`). None reads or writes a stock column.
    'src/components/screens/StockCountsScreen.tsx',
    'src/app/api/inventory/counts/statement/route.ts',
    'src/lib/keeper-statement.ts',
  ]);
  // 19/11, W1a: WIDENED, never loosened — to the RELATION names as well (a door could read a batch's place through
  // `include: { warehouse: true }` or walk `splits` without naming one column) and to the placement table.
  const NEW_NAMES =
    /\b(warehouseId|sourceWarehouseId|quantityMovedIn|quantityMovedOut|splitFromBatchId|inTransitTransferId|userWarehouseAccess|warehousePlacement|warehouse_id|quantity_moved_in|quantity_moved_out|split_from_batch_id|in_transit_transfer_id|warehouse_placements|splitFrom|sourcedOrders)\b|\b(db|tx)\.warehouse\.|\b(warehouse|warehouses|splits|keepers)\s*:\s*(\{|true)/;

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
