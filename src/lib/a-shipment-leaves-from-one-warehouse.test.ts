import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('./db', () => ({ db: {} }));

import { preparationGroups, shipmentBlocks, shipmentBlocksBulk, type BlockedOrder } from './operations';
import { freeInWarehouse, shipmentPlace, warehouseShelfFor, ShipmentPlaceRefused } from './shipment-warehouse';
import { freeStockOf } from './stock-transfers';
import { shipDb, type Row } from './shipment-warehouse.memory-db.test';

/**
 * A SHIPMENT IS MADE IN ONE WAREHOUSE — the stock half (the warehouse plan, request W4a).
 *
 * For a store placed in warehouses the stock blocks ask the FREE stock of the warehouse the shipment leaves from — the
 * one formula `stock-transfers.freeStockOf` (Σ remaining of its rows, none on the road − what orders already sourced
 * from it still hold) — with today's hard / soft rule, and a shortage names the warehouse of the store that does hold
 * the units. Every total below is written by hand from the seed, never computed with the function under test.
 */

const W_A = { id: 'wA', name: 'مخزن أ' };
const batch = (id: string, over: Row) => ({
  id, companyId: 'c1', storeId: 's1', productId: 'p1', quantityRemaining: 0, warehouseId: null, inTransitTransferId: null, ...over,
});
const order = (id: string, over: Row = {}) => ({
  id, companyId: 'c1', storeId: 's1', customerId: `cu-${id}`, regionId: 'r1', deliveryProviderId: 'dp1',
  confirmationStatus: 'CONFIRMED', shippingStatus: 'NOT_READY', sourceWarehouseId: null, orderNumber: `ORD-${id}`, ...over,
});
const item = (orderId: string, over: Row = {}) => ({
  id: `i-${orderId}-${over.productId ?? 'p1'}`, companyId: 'c1', orderId, productId: 'p1', productName: 'مقشر', quantity: 2, freeQuantity: 0, reservedQty: 2, ...over,
});

function seed(extra: Partial<Record<string, Row[]>> = {}) {
  return shipDb({
    store: [
      { id: 's1', companyId: 'c1', countryId: 'k1', isTest: false },
      { id: 's2', companyId: 'c1', countryId: 'k1', isTest: false },
    ],
    warehousePlacement: [{ id: 'pl1', storeId: 's1' }],
    warehouse: [
      { id: 'wA', companyId: 'c1', countryId: 'k1', name: 'مخزن أ', isActive: true },
      { id: 'wB', companyId: 'c1', countryId: 'k1', name: 'مخزن ب', isActive: true },
      // Stopped, with plenty: never named — nobody can ship from it.
      { id: 'wS', companyId: 'c1', countryId: 'k1', name: 'مخزن موقوف', isActive: false },
      { id: 'wX', companyId: 'c1', countryId: 'k2', name: 'مخزن برّا', isActive: true },
      { id: 'wO', companyId: 'c2', countryId: 'k9', name: 'مخزن شركة تانية', isActive: true },
    ],
    productionBatch: [
      batch('bA', { warehouseId: 'wA', quantityRemaining: 3 }),
      batch('bB', { warehouseId: 'wB', quantityRemaining: 10 }),
      batch('bS', { warehouseId: 'wS', quantityRemaining: 40 }),
      // Five units of wA on the road to wB: in no warehouse until received.
      batch('bRoad', { warehouseId: null, inTransitTransferId: 't1', quantityRemaining: 5 }),
      // Another store's goods in the same warehouse: never this store's.
      batch('bOther', { storeId: 's2', warehouseId: 'wA', quantityRemaining: 50 }),
    ],
    order: [
      order('o1'),
      order('o2'),
      // Left from wA with the courier, still holding one unit (not delivered): inside wA's free stock already.
      order('o3', { shippingStatus: 'SHIPPED', sourceWarehouseId: 'wA' }),
      // Another store's order holding units: never counted here.
      order('o9', { storeId: 's2' }),
      ...(extra.order ?? []),
    ],
    orderItem: [
      item('o1'),
      item('o2'),
      item('o3', { quantity: 1, reservedQty: 1 }),
      item('o9', { reservedQty: 30 }),
      ...(extra.orderItem ?? []),
    ],
    orderAddOn: extra.orderAddOn ?? [],
    deliveryFee: [{ id: 'f1', deliveryProviderId: 'dp1', regionId: 'r1', isActive: true }],
  });
}

const stock = (blocks: { code: string; message: string; hard: boolean }[]) => blocks.filter((b) => b.code === 'STOCK_SHORTAGE');
const one = (id: string) => ({ id, companyId: 'c1', storeId: 's1', customerId: `cu-${id}`, regionId: 'r1', deliveryProviderId: 'dp1' });

describe('the free stock of a warehouse — the one formula, shared with the transfer door', () => {
  it('worked example: wA holds 3, the parcel with the courier holds 1 → 2 free; the road and the other store are not wA’s', async () => {
    const m = seed();
    const free = await freeStockOf(m.db, { companyId: 'c1', storeId: 's1', warehouseId: 'wA', productIds: ['p1'] });
    expect(free.get('p1')).toBe(2);
    const shelf = await warehouseShelfFor(m.db, { companyId: 'c1', storeId: 's1', warehouse: W_A, productIds: ['p1'], orderIds: ['o1'] });
    expect(shelf.base.get('p1')).toBe(2);
    // o1 alone: its own two units never compete with itself.
    expect(freeInWarehouse(shelf, 'o1', 'p1', ['o1'])).toBe(2);
  });

  it('two orders of one press compete: 2 free in wA cannot be promised to both', async () => {
    const m = seed();
    const shelf = await warehouseShelfFor(m.db, { companyId: 'c1', storeId: 's1', warehouse: W_A, productIds: ['p1'], orderIds: ['o1', 'o2'] });
    expect(freeInWarehouse(shelf, 'o1', 'p1', ['o1', 'o2'])).toBe(0);
    expect(freeInWarehouse(shelf, 'o2', 'p1', ['o1', 'o2'])).toBe(0);
    // A duplicate id in the press is counted once.
    expect(freeInWarehouse(shelf, 'o1', 'p1', ['o1', 'o2', 'o2'])).toBe(0);
  });

  it('an order already sourced from the warehouse is not charged its own hold twice', async () => {
    const m = seed();
    const shelf = await warehouseShelfFor(m.db, { companyId: 'c1', storeId: 's1', warehouse: W_A, productIds: ['p1'], orderIds: ['o3'] });
    // base 2 has o3's one unit taken off; o3 asking for itself gets it back.
    expect(freeInWarehouse(shelf, 'o3', 'p1', ['o3'])).toBe(3);
  });
});

describe('shipmentBlocks with a warehouse', () => {
  it('passes an order the warehouse can cover', async () => {
    const m = seed();
    const blocks = await shipmentBlocks(m.db, one('o1'), { allowNegativeStock: false, batchOrderIds: ['o1'], warehouse: W_A });
    expect(stock(blocks)).toEqual([]);
  });

  it('a shortage in A with stock in B is refused, in a sentence that names B (and never the stopped one)', async () => {
    const m = seed();
    const blocks = await shipmentBlocks(m.db, one('o1'), { allowNegativeStock: false, batchOrderIds: ['o1', 'o2'], warehouse: W_A });
    expect(stock(blocks)).toHaveLength(1);
    const [b] = stock(blocks);
    expect(b.hard).toBe(true);
    expect(b.message).toContain('«مخزن أ»');
    expect(b.message).toContain('ينقص 2');
    expect(b.message).toContain('«مخزن ب»');
    expect(b.message).not.toContain('مخزن موقوف');
    expect(b.message).not.toContain('برّا');
  });

  it('today’s hard / soft rule: where negative stock is allowed the same shortage is soft', async () => {
    const m = seed();
    const blocks = await shipmentBlocks(m.db, one('o1'), { allowNegativeStock: true, batchOrderIds: ['o1', 'o2'], warehouse: W_A });
    expect(stock(blocks)).toMatchObject([{ code: 'STOCK_SHORTAGE', hard: false }]);
  });

  it('NEGATIVE: the store has the units in total (13) — the store’s shelf would let the press through; the warehouse does not', async () => {
    const m = seed();
    const store = await shipmentBlocks(m.db, one('o1'), { allowNegativeStock: false, batchOrderIds: ['o1', 'o2'] });
    expect(stock(store)).toEqual([]);
  });

  it('units on the road are nobody’s: a product only on the road is short everywhere, and no warehouse is named', async () => {
    const m = seed({
      order: [order('o5')],
      orderItem: [item('o5', { productId: 'p2', productName: 'مرطب', quantity: 1, reservedQty: 1 })],
    });
    m.data.productionBatch.push(batch('bRoad2', { productId: 'p2', inTransitTransferId: 't1', quantityRemaining: 9 }));
    const blocks = await shipmentBlocks(m.db, one('o5'), { allowNegativeStock: false, batchOrderIds: ['o5'], warehouse: W_A });
    const [b] = stock(blocks);
    expect(b.message).toBe('نقص مخزون بمخزن «مخزن أ»: مرطب (ينقص 1)');
  });

  it('an add-on is asked the same question, and says it is an add-on', async () => {
    const m = seed({
      order: [order('o6')],
      orderItem: [item('o6', { quantity: 1, reservedQty: 1 })],
      orderAddOn: [{ id: 'a6', companyId: 'c1', orderId: 'o6', productId: 'p1', productName: 'مقشر', quantity: 2, reservedQty: 2 }],
    });
    // wA: 2 free. The line wants 1 (fits), the add-on 2 (fits alone). Asked line by line, as the store's version asks.
    const blocks = await shipmentBlocks(m.db, one('o6'), { allowNegativeStock: false, batchOrderIds: ['o6', 'o1'], warehouse: W_A });
    const msgs = (stock(blocks)).map((b) => b.message);
    expect(msgs.some((x) => x.includes('إضافة، '))).toBe(true);
  });

  it('a bench store’s order and another store’s goods never enter the answer (the store filter)', async () => {
    const m = seed();
    // s2 holds 50 units in wA and its order o9 holds 30: if either leaked in, o1 would read 52 or −28.
    const shelf = await warehouseShelfFor(m.db, { companyId: 'c1', storeId: 's1', warehouse: W_A, productIds: ['p1'], orderIds: ['o1', 'o9'] });
    expect(freeInWarehouse(shelf, 'o1', 'p1', ['o1', 'o9'])).toBe(2);
  });

  it('the list asks the same question, order by order (bulk ≡ single)', async () => {
    const m = seed({ order: [order('o7')], orderItem: [item('o7', { quantity: 1, reservedQty: 1 })] });
    const ids = ['o1', 'o2', 'o7'];
    const listed: BlockedOrder[] = ids.map((id) => ({
      ...one(id),
      items: m.data.orderItem.filter((i) => i.orderId === id).map((i) => ({ productId: i.productId, productName: i.productName, quantity: i.quantity, freeQuantity: i.freeQuantity })),
      addOns: [],
    }));
    for (const allowNegativeStock of [false, true]) {
      const bulk = await shipmentBlocksBulk(m.db, listed, { allowNegativeStock, batchOrderIds: ids, warehouse: W_A });
      for (const id of ids) {
        const single = await shipmentBlocks(m.db, one(id), { allowNegativeStock, batchOrderIds: ids, warehouse: W_A });
        expect(bulk.get(id), id).toEqual(single);
      }
    }
  });
});

describe('the preparation list per warehouse', () => {
  it('«available» is the warehouse’s free stock; without a warehouse it is the store’s, as before', async () => {
    const m = seed();
    m.data.order.forEach((o) => {
      o.customer = { fullName: 'زبون' };
    });
    const [inA] = await preparationGroups(m.db, { companyId: 'c1', storeId: 's1' }, { warehouse: W_A });
    // wA free: 2. o1 and o2 want 4 → short 2.
    expect(inA.available).toBe(2);
    expect(inA.shortage).toBe(2);
  });
});

describe('where the shipment leaves from', () => {
  const ask = (m: ReturnType<typeof seed>, warehouseId: unknown, storeId = 's1', mayUse = async () => true) =>
    shipmentPlace(m.db, { companyId: 'c1', storeId, warehouseId, mayUse });

  it('a store that is not placed: nothing, whatever the body carries — not read, not checked', async () => {
    const m = seed();
    for (const junk of [undefined, null, '', 'wA', 'wX', 'wS', 'nope', 42, { id: 'wA' }]) {
      await expect(ask(m, junk, 's2', async () => false)).resolves.toBeNull();
    }
    expect(m.calls.map((c) => c.call)).toEqual(Array(9).fill('store.findFirst'));
  });

  it('a placed store: the named warehouse, when it is usable', async () => {
    await expect(ask(seed(), 'wA')).resolves.toEqual({ id: 'wA', name: 'مخزن أ' });
  });

  it.each([
    [undefined, 'WAREHOUSE_REQUIRED', 400],
    ['  ', 'WAREHOUSE_REQUIRED', 400],
    ['nope', 'WAREHOUSE_NOT_FOUND', 400],
    ['wO', 'WAREHOUSE_NOT_FOUND', 400],
    ['wX', 'WAREHOUSE_OTHER_COUNTRY', 400],
    ['wS', 'WAREHOUSE_STOPPED', 409],
  ])('NEGATIVE: %s → %s', async (warehouseId, code, status) => {
    const e = await ask(seed(), warehouseId).catch((x) => x);
    expect(e).toBeInstanceOf(ShipmentPlaceRefused);
    expect(e).toMatchObject({ code, status });
    expect(e.errorAr).toMatch(/[؀-ۿ]/);
  });

  it('NEGATIVE: a warehouse she does not reach', async () => {
    await expect(ask(seed(), 'wA', 's1', async () => false)).rejects.toMatchObject({ code: 'WAREHOUSE_NOT_REACHED', status: 403 });
  });
});

describe('the module touches no money and changes no reservation', () => {
  const src = readFileSync(join(process.cwd(), 'src/lib/shipment-warehouse.ts'), 'utf8');

  it('imports nothing from wallets, expenses, profit or cost', () => {
    const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((x) => x[1]);
    expect(imports.filter((i) => /wallet|expense|profit|financ|commission|settlement|cost/i.test(i))).toEqual([]);
  });

  it('writes nothing at all: no create, update, delete or raw statement', () => {
    expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|\$queryRaw/);
  });

  it('reads the reservation through its own rule (holdingWhere), never a second copy of it', () => {
    expect(src).toMatch(/holdingWhere\(/);
    expect(src).not.toMatch(/confirmationStatus|shippingStatus/);
  });
});

beforeEach(() => {
  vi.useRealTimers();
});
