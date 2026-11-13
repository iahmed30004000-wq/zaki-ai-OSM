import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ db: {} }));

import { shipmentBlocks, shipmentBlocksBulk, type BlockedOrder, type OrderBlock } from './operations';
import { availableStock, freeFromPools, onHand, reservedElsewhere, reservedForProducts, stockPoolsFor } from './reservation';
import { feePairKey, resolveDeliveryFee, resolveDeliveryFeesFor } from './delivery-fees';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE LIST OF ORDERS READY TO SHIP ASKS ITS QUESTIONS ONCE, AND GETS THE ANSWERS THE DOOR WOULD GIVE.
 *
 * `GET /api/ops/shipments` asked `shipmentBlocks` and `resolveDeliveryFee` of each of up to 300 orders in turn: about 2,700
 * statements to draw one screen, repeated after every pause in typing and every return to the tab. It asks the tables once
 * now (`shipmentBlocksBulk`, `resolveDeliveryFeesFor`, `stockPoolsFor`).
 *
 * THE PROOF IS A DIFFERENTIAL. The reference is the LIVE `shipmentBlocks` / `resolveDeliveryFee` / `availableStock` — the
 * very functions the shipment door still asks inside its transaction — run order by order over the same in-memory tables,
 * beside the bulk ones: deep-equal blocks, in the same order, with the same words. If either side is edited without the
 * other, this goes red; nothing here is a frozen copy of yesterday's code.
 *
 * Beside it, hand-built worlds say what the answer MUST be, in plain numbers, so that «both are wrong the same way» is not
 * a way to pass.
 *
 * The tables are a small model of the Prisma calls these functions make (equality, `in`, `notIn`, `not`, `gt`, `gte`, `OR`,
 * and the `order` relation of a line). It throws on anything else, so a new kind of filter can never be answered silently.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Row = Record<string, unknown>;
interface World {
  orders: Row[];
  items: Row[];
  addOns: Row[];
  batches: Row[];
  fees: Row[];
}

function condition(value: unknown, wanted: unknown): boolean {
  if (wanted !== null && typeof wanted === 'object' && !(wanted instanceof Date) && !Array.isArray(wanted)) {
    return Object.entries(wanted as Row).every(([op, arg]) => {
      switch (op) {
        case 'in':
          return (arg as unknown[]).includes(value);
        case 'notIn':
          return !(arg as unknown[]).includes(value);
        case 'not':
          return value !== arg;
        case 'gt':
          return value != null && (value as number) > (arg as number);
        case 'gte':
          return value != null && (value as number | Date) >= (arg as number | Date);
        default:
          throw new Error(`the model of the tables does not know the operator «${op}»`);
      }
    });
  }
  return value === wanted;
}

function matches(world: World, row: Row, where: Row | undefined): boolean {
  for (const [key, wanted] of Object.entries(where ?? {})) {
    if (key === 'OR') {
      if (!(wanted as Row[]).some((w) => matches(world, row, w))) return false;
    } else if (key === 'order') {
      const parent = world.orders.find((o) => o.id === row.orderId);
      if (!parent || !matches(world, parent, wanted as Row)) return false;
    } else if (key === 'AND' || key === 'NOT') {
      throw new Error(`the model of the tables does not know «${key}»`);
    } else if (!condition(row[key], wanted)) {
      return false;
    }
  }
  return true;
}

function fakeDb(world: World) {
  const counter = { statements: 0 };
  const table = (rows: () => Row[]) => ({
    findMany: async (args: { where?: Row }) => {
      counter.statements++;
      return rows().filter((r) => matches(world, r, args.where)).map((r) => ({ ...r }));
    },
    findFirst: async (args: { where?: Row }) => {
      counter.statements++;
      const hit = rows().find((r) => matches(world, r, args.where));
      return hit ? { ...hit } : null;
    },
    count: async (args: { where?: Row }) => {
      counter.statements++;
      return rows().filter((r) => matches(world, r, args.where)).length;
    },
    aggregate: async (args: { where?: Row; _sum: Record<string, true> }) => {
      counter.statements++;
      const hit = rows().filter((r) => matches(world, r, args.where));
      return {
        _sum: Object.fromEntries(
          Object.keys(args._sum).map((f) => [f, hit.length === 0 ? null : hit.reduce((s, r) => s + Number(r[f] ?? 0), 0)])
        ),
      };
    },
    groupBy: async (args: { by: string[]; where?: Row; _sum: Record<string, true> }) => {
      counter.statements++;
      const groups = new Map<string, Row[]>();
      for (const r of rows().filter((x) => matches(world, x, args.where))) {
        const key = args.by.map((f) => String(r[f])).join('|');
        groups.set(key, [...(groups.get(key) ?? []), r]);
      }
      return [...groups.values()].map((g) => ({
        ...Object.fromEntries(args.by.map((f) => [f, g[0][f]])),
        _sum: Object.fromEntries(Object.keys(args._sum).map((f) => [f, g.reduce((s, r) => s + Number(r[f] ?? 0), 0)])),
      }));
    },
  });
  return {
    counter,
    db: {
      order: table(() => world.orders),
      orderItem: table(() => world.items),
      orderAddOn: table(() => world.addOns),
      productionBatch: table(() => world.batches),
      deliveryFee: table(() => world.fees),
    } as never,
  };
}

const NOW = new Date('2026-11-13T12:00:00.000Z').getTime();
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => vi.useRealTimers());

/* ───────────────────────── a seeded world ───────────────────────── */

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

/** `size` orders to list and twice as many in the background: they hold stock, travel, and come back, but are not on the list. */
function seededWorld(seed: number, size: number): { world: World; listed: BlockedOrder[] } {
  const r = rng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const companies = ['c1', 'c1', 'c1', 'c2'];
  const stores = ['s1', 's1', 's2', null] as const;
  const customers = Array.from({ length: 150 }, (_, i) => `cu${i}`);
  const products = Array.from({ length: 16 }, (_, i) => ({ id: `p${i}`, name: `منتج ${i}` }));
  const couriers = ['k1', 'k2', 'k3'];
  const regions = ['r1', 'r2', 'r3', 'r4', 'r5'];
  const confirmations = ['CONFIRMED', 'CONFIRMED', 'CONFIRMED', 'PENDING', 'CANCELLED', 'REJECTED'];
  const shippings = ['NOT_READY', 'NOT_READY', 'NOT_READY', 'NOT_READY', 'PACKING', 'READY_TO_SHIP', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'DELIVERED', 'CANCELLED', 'RETURNED', 'RETURN_REQUESTED'];

  const world: World = { orders: [], items: [], addOns: [], batches: [], fees: [] };
  for (const courier of couriers) {
    for (const region of regions) {
      if (r() < 0.9) {
        world.fees.push({
          id: `f-${courier}-${region}`, deliveryProviderId: courier, regionId: region, isActive: r() < 0.92,
          fee: String(int(1, 9) + r()), lateThresholdDays: 3, returnFee: String(r() * 3),
        });
      }
    }
  }
  for (const company of ['c1', 'c2']) {
    for (const store of ['s1', 's2']) {
      for (const p of products) {
        for (let i = 0; i < int(1, 2); i++) {
          world.batches.push({ id: `b-${company}-${store}-${p.id}-${i}`, companyId: company, storeId: store, productId: p.id, quantityRemaining: int(2, 30) });
        }
      }
    }
  }

  const listed: BlockedOrder[] = [];
  for (let n = 0; n < size * 3; n++) {
    const company = pick(companies);
    const store = pick(stores);
    const id = `o${n}`;
    world.orders.push({
      id, companyId: company, storeId: store, customerId: pick(customers),
      confirmationStatus: pick(confirmations), shippingStatus: pick(shippings),
      returnedAt: r() < 0.4 ? null : new Date(NOW - int(0, 60) * DAY - int(0, 86_399_999)),
      updatedAt: new Date(NOW - int(0, 60) * DAY - int(0, 86_399_999)),
    });
    const lines = Array.from({ length: int(1, 3) }, (_, k) => {
      const p = pick(products);
      const quantity = int(0, 5);
      const freeQuantity = int(0, 2);
      const need = quantity + freeQuantity;
      return { id: `i-${id}-${k}`, orderId: id, companyId: company, productId: p.id, productName: p.name, quantity, freeQuantity, reservedQty: r() < 0.6 ? need : int(0, need) };
    });
    const extras = Array.from({ length: int(0, 2) }, (_, k) => {
      const p = pick(products);
      const quantity = int(1, 3);
      return { id: `a-${id}-${k}`, orderId: id, companyId: company, productId: p.id, productName: p.name, quantity, reservedQty: r() < 0.6 ? quantity : int(0, quantity) };
    });
    world.items.push(...lines);
    world.addOns.push(...extras);
    if (n < size) {
      listed.push({
        id, companyId: company, storeId: store, customerId: world.orders[n].customerId as string,
        regionId: r() < 0.08 ? null : pick(regions), deliveryProviderId: r() < 0.1 ? null : pick(couriers),
        items: lines.map((l) => ({ productId: l.productId, productName: l.productName, quantity: l.quantity, freeQuantity: l.freeQuantity })),
        addOns: extras.map((a) => ({ productId: a.productId, productName: a.productName, quantity: a.quantity })),
      });
    }
  }
  return { world, listed };
}

const asked = (o: BlockedOrder) => ({
  id: o.id, companyId: o.companyId, storeId: o.storeId, customerId: o.customerId, regionId: o.regionId, deliveryProviderId: o.deliveryProviderId,
});

async function bothWays(world: World, listed: BlockedOrder[], opts: { allowNegativeStock: boolean; batchOrderIds?: string[] }) {
  const bulkSide = fakeDb(world);
  const bulk = await shipmentBlocksBulk(bulkSide.db, listed, opts);
  const oneSide = fakeDb(world);
  const one = new Map<string, OrderBlock[]>();
  for (const o of listed) one.set(o.id, await shipmentBlocks(oneSide.db, asked(o), opts));
  return { bulk, one, bulkStatements: bulkSide.counter.statements, oneStatements: oneSide.counter.statements };
}

/* ───────────────────────── the differential ───────────────────────── */

describe('the bulk blocks are the door’s blocks, order by order', () => {
  for (const [seed, allowNegativeStock] of [[7, false], [11, true], [2026, false], [4242, true]] as const) {
    it(`seed ${seed}, negative stock ${allowNegativeStock ? 'allowed' : 'refused'}: every order's blocks deep-equal`, async () => {
      const { world, listed } = seededWorld(seed, 70);
      // Two ids listed twice — the door's «duplicate in this batch» block.
      const batchOrderIds = [...listed.map((o) => o.id), listed[3].id, listed[9].id];
      const { bulk, one } = await bothWays(world, listed, { allowNegativeStock, batchOrderIds });
      expect(bulk.size).toBe(listed.length);
      for (const o of listed) expect(bulk.get(o.id), o.id).toEqual(one.get(o.id));
    });
  }

  it('and the fixtures are not vacuous: every kind of block, and plenty of clean orders, are among the answers', async () => {
    const seen = new Map<string, number>();
    let clean = 0;
    let hard = 0;
    let soft = 0;
    for (const seed of [7, 2026]) {
      const { world, listed } = seededWorld(seed, 70);
      const { one } = await bothWays(world, listed, { allowNegativeStock: false, batchOrderIds: [...listed.map((o) => o.id), listed[3].id] });
      for (const blocks of one.values()) {
        if (blocks.length === 0) clean++;
        for (const b of blocks) {
          seen.set(b.code, (seen.get(b.code) ?? 0) + 1);
          if (b.code === 'STOCK_SHORTAGE') {
            if (b.hard) hard++;
            else soft++;
          }
        }
      }
    }
    for (const code of ['DUPLICATE_IN_BATCH', 'PREVIOUS_SHIPMENT_IN_TRANSIT', 'RECENT_RETURN', 'NO_REGION', 'NO_FEE_ROW', 'STOCK_SHORTAGE']) {
      expect(seen.get(code) ?? 0, code).toBeGreaterThan(0);
    }
    expect(clean).toBeGreaterThan(10);
    expect(hard).toBeGreaterThan(0);
    // With negative stock refused there is no soft shortage; the allowed seeds above carry the soft ones.
    expect(soft).toBe(0);
    const { world, listed } = seededWorld(11, 70);
    const { one } = await bothWays(world, listed, { allowNegativeStock: true });
    expect([...one.values()].flat().filter((b) => b.code === 'STOCK_SHORTAGE' && !b.hard).length).toBeGreaterThan(0);
  });

  it('300 orders: a handful of statements instead of thousands, and the same answers', async () => {
    const { world, listed } = seededWorld(99, 300);
    const { bulk, one, bulkStatements, oneStatements } = await bothWays(world, listed, { allowNegativeStock: false });
    for (const o of listed) expect(bulk.get(o.id), o.id).toEqual(one.get(o.id));
    // Per store group: 2 reads of the customers' parcels per company, 1 of the fee rows, and 5 of the shelf per (company, store).
    expect(bulkStatements).toBeLessThanOrEqual(40);
    expect(oneStatements).toBeGreaterThan(1500);
    expect(oneStatements / bulkStatements).toBeGreaterThan(40);
  });

  it('an empty list asks nothing', async () => {
    const side = fakeDb({ orders: [], items: [], addOns: [], batches: [], fees: [] });
    expect((await shipmentBlocksBulk(side.db, [], { allowNegativeStock: false })).size).toBe(0);
    expect(side.counter.statements).toBe(0);
  });
});

/* ───────────────── hand-built worlds: what the answer MUST be ───────────────── */

const world = (over: Partial<World> = {}): World => ({ orders: [], items: [], addOns: [], batches: [], fees: [], ...over });
const order = (id: string, over: Row = {}): Row => ({
  id, companyId: 'c1', storeId: 's1', customerId: 'cu1', confirmationStatus: 'CONFIRMED', shippingStatus: 'NOT_READY', returnedAt: null,
  updatedAt: new Date(NOW - 90 * DAY), ...over,
});
const item = (orderId: string, productId: string, quantity: number, reservedQty: number, over: Row = {}): Row => ({
  id: `i-${orderId}-${productId}`, orderId, companyId: 'c1', productId, productName: `اسم ${productId}`, quantity, freeQuantity: 0, reservedQty, ...over,
});
const batch = (productId: string, quantityRemaining: number, over: Row = {}): Row => ({
  id: `b-${productId}-${String(over.storeId ?? 's1')}`, companyId: 'c1', storeId: 's1', productId, quantityRemaining, ...over,
});
const fee = (over: Row = {}): Row => ({ id: 'f1', deliveryProviderId: 'k1', regionId: 'r1', isActive: true, fee: '3', lateThresholdDays: 3, returnFee: '1', ...over });
const listedOrder = (id: string, over: Partial<BlockedOrder> = {}): BlockedOrder => ({
  id, companyId: 'c1', storeId: 's1', customerId: 'cu1', regionId: 'r1', deliveryProviderId: 'k1', items: [], addOns: [], ...over,
});
const codes = (blocks: OrderBlock[] | undefined) => (blocks ?? []).map((b) => b.code);

describe('what the blocks say, in plain numbers', () => {
  it('the customer’s OTHER parcels on the road are counted, and the order itself is not one of them', async () => {
    const w = world({
      orders: [
        order('A', { shippingStatus: 'SHIPPED' }), // listed, itself on the road — leaves itself out
        order('B', { shippingStatus: 'OUT_FOR_DELIVERY' }),
        order('C', { shippingStatus: 'SHIPPED' }),
        order('D', { shippingStatus: 'DELIVERED' }), // not on the road
        order('E', { shippingStatus: 'SHIPPED', customerId: 'cu2' }), // someone else's
        order('F', { shippingStatus: 'SHIPPED', companyId: 'c2' }), // another company's
      ],
      fees: [fee()],
    });
    const out = await shipmentBlocksBulk(fakeDb(w).db, [listedOrder('A')], { allowNegativeStock: false });
    expect(out.get('A')).toEqual([{ code: 'PREVIOUS_SHIPMENT_IN_TRANSIT', message: 'للعميل 2 شحنة قيد التوصيل', hard: false }]);
  });

  it('a return counts for 30 days — by its return date, or by the last touch when it has none — and not before', async () => {
    const since = NOW - 30 * DAY;
    const w = world({
      orders: [
        order('A'),
        order('R1', { shippingStatus: 'RETURNED', returnedAt: new Date(since) }), // exactly 30 days: counts
        order('R2', { shippingStatus: 'RETURN_REQUESTED', returnedAt: null, updatedAt: new Date(since + 1) }), // by the last touch
        order('R3', { shippingStatus: 'RETURNED', returnedAt: new Date(since - 1), updatedAt: new Date(since - 1) }), // a millisecond too old
        order('R4', { shippingStatus: 'DELIVERED', returnedAt: new Date(NOW - DAY) }), // not a return
      ],
      fees: [fee()],
    });
    const out = await shipmentBlocksBulk(fakeDb(w).db, [listedOrder('A')], { allowNegativeStock: false });
    expect(out.get('A')).toEqual([{ code: 'RECENT_RETURN', message: 'للعميل 2 مرتجع خلال 30 يوماً', hard: false }]);
  });

  it('the fee: no governorate stops it; a courier with no active row for it stops it; no courier asks nothing', async () => {
    const w = world({
      orders: [order('A'), order('B'), order('C'), order('D')],
      fees: [fee(), fee({ id: 'f2', regionId: 'r2', isActive: false })],
    });
    const out = await shipmentBlocksBulk(
      fakeDb(w).db,
      [
        listedOrder('A', { regionId: null }), // no governorate
        listedOrder('B', { regionId: 'r2' }), // the row is switched off
        listedOrder('C', { regionId: 'r3' }), // no row at all
        listedOrder('D', { regionId: 'r3', deliveryProviderId: null }), // no courier: nothing to ask
      ],
      { allowNegativeStock: false }
    );
    expect(out.get('A')).toEqual([{ code: 'NO_REGION', message: 'لم تُحدَّد المحافظة — لا يمكن حساب أجرة التوصيل', hard: true }]);
    expect(codes(out.get('B'))).toEqual(['NO_FEE_ROW']);
    expect(codes(out.get('C'))).toEqual(['NO_FEE_ROW']);
    expect(out.get('D')).toEqual([]);
  });

  it('the shelf: what is on hand, less what OTHER open orders hold — never this order’s own hold', async () => {
    const w = world({
      orders: [order('A'), order('B'), order('X', { customerId: 'cu9' }), order('Y', { customerId: 'cu8', confirmationStatus: 'CANCELLED' })],
      items: [
        item('A', 'p1', 4, 4), // this order holds 4 of its own
        item('B', 'p1', 3, 3), // another open order holds 3
        item('X', 'p1', 1, 1), // and another 1
        item('Y', 'p1', 5, 5), // a cancelled order holds nothing, whatever its rows say
      ],
      batches: [batch('p1', 10)],
      fees: [fee()],
    });
    // 10 on the shelf − 3 − 1 held by others = 6 for A. A needs 4: fine. B: 10 − 4 − 1 = 5, needs 3: fine.
    const ok = await shipmentBlocksBulk(
      fakeDb(w).db,
      [listedOrder('A', { items: [{ productId: 'p1', productName: 'اسم p1', quantity: 4, freeQuantity: 0 }] }), listedOrder('B', { items: [{ productId: 'p1', productName: 'اسم p1', quantity: 3, freeQuantity: 0 }] })],
      { allowNegativeStock: false }
    );
    expect(ok.get('A')).toEqual([]);
    expect(ok.get('B')).toEqual([]);
    // Asking for 7 where 6 are free: short by exactly one.
    const short = await shipmentBlocksBulk(
      fakeDb(w).db,
      [listedOrder('A', { items: [{ productId: 'p1', productName: 'اسم p1', quantity: 7, freeQuantity: 0 }] })],
      { allowNegativeStock: false }
    );
    expect(short.get('A')).toEqual([{ code: 'STOCK_SHORTAGE', message: 'نقص مخزون: اسم p1 (ينقص 1)', hard: true }]);
  });

  it('the gift units and the add-ons are goods in the box: the add-on says «إضافة»; where negative stock is allowed the stop is soft', async () => {
    const w = world({ orders: [order('A')], batches: [batch('p1', 2), batch('p2', 0)], fees: [fee()] });
    const lines = listedOrder('A', {
      items: [{ productId: 'p1', productName: 'اسم p1', quantity: 2, freeQuantity: 1 }], // needs 3, 2 on the shelf
      addOns: [{ productId: 'p2', productName: 'اسم p2', quantity: 2 }], // needs 2, none on the shelf
    });
    const hard = await shipmentBlocksBulk(fakeDb(w).db, [lines], { allowNegativeStock: false });
    expect(hard.get('A')).toEqual([
      { code: 'STOCK_SHORTAGE', message: 'نقص مخزون: اسم p1 (ينقص 1)', hard: true },
      { code: 'STOCK_SHORTAGE', message: 'نقص مخزون: اسم p2 (إضافة، ينقص 2)', hard: true },
    ]);
    const soft = await shipmentBlocksBulk(fakeDb(w).db, [lines], { allowNegativeStock: true });
    expect(soft.get('A')!.map((b) => b.hard)).toEqual([false, false]);
  });

  it('a line that needs nothing is not asked about, and an order with no store draws on the whole company’s shelf', async () => {
    const w = world({
      orders: [order('A', { storeId: null })],
      batches: [batch('p1', 3, { storeId: 's1' }), batch('p1', 4, { storeId: 's2' })],
      fees: [fee()],
    });
    const out = await shipmentBlocksBulk(
      fakeDb(w).db,
      [
        listedOrder('A', {
          storeId: null,
          items: [
            { productId: 'p1', productName: 'اسم p1', quantity: 7, freeQuantity: 0 }, // 3 + 4 = 7: exactly covered
            { productId: 'p9', productName: 'اسم p9', quantity: 0, freeQuantity: 0 }, // nothing needed
          ],
        }),
      ],
      { allowNegativeStock: false }
    );
    expect(out.get('A')).toEqual([]);
  });

  it('a listed twice is said so, and only the first words of the door are the door’s: the order of the blocks is its order', async () => {
    const w = world({
      orders: [order('A', { shippingStatus: 'NOT_READY' }), order('B', { shippingStatus: 'SHIPPED' }), order('R', { shippingStatus: 'RETURNED', returnedAt: new Date(NOW - DAY) })],
    });
    const out = await shipmentBlocksBulk(
      fakeDb(w).db,
      [listedOrder('A', { regionId: null, items: [{ productId: 'p1', productName: 'اسم p1', quantity: 1, freeQuantity: 0 }] })],
      { allowNegativeStock: false, batchOrderIds: ['A', 'A'] }
    );
    expect(codes(out.get('A'))).toEqual(['DUPLICATE_IN_BATCH', 'PREVIOUS_SHIPMENT_IN_TRANSIT', 'RECENT_RETURN', 'NO_REGION', 'STOCK_SHORTAGE']);
  });
});

/* ───────────────────────── the fees ───────────────────────── */

describe('the fees of a list come from one read, and each is resolveDeliveryFee’s own', () => {
  it('equal to the per-pair function over rounding cases, a switched-off row, a missing row, no governorate and no courier', async () => {
    const w = world({
      fees: [
        fee({ id: 'f1', deliveryProviderId: 'k1', regionId: 'r1', fee: '1.2345', returnFee: '2.675' }),
        fee({ id: 'f2', deliveryProviderId: 'k1', regionId: 'r2', fee: '0.005', returnFee: '0' }),
        fee({ id: 'f3', deliveryProviderId: 'k2', regionId: 'r1', fee: '9.999', returnFee: '4.5', lateThresholdDays: 7 }),
        fee({ id: 'f4', deliveryProviderId: 'k2', regionId: 'r2', isActive: false }),
      ],
    });
    const pairs = [
      { deliveryProviderId: 'k1', regionId: 'r1' },
      { deliveryProviderId: 'k1', regionId: 'r2' },
      { deliveryProviderId: 'k2', regionId: 'r1' },
      { deliveryProviderId: 'k2', regionId: 'r2' }, // switched off
      { deliveryProviderId: 'k2', regionId: 'r3' }, // no row
      { deliveryProviderId: 'k1', regionId: null }, // no governorate
      { deliveryProviderId: 'k1', regionId: 'r1' }, // asked twice
    ];
    for (const minorUnit of [0, 2, 3]) {
      const side = fakeDb(w);
      const map = await resolveDeliveryFeesFor(side.db, pairs, minorUnit);
      expect(side.counter.statements).toBe(1);
      for (const p of pairs) {
        expect(map.get(feePairKey(p.deliveryProviderId, p.regionId)), `${p.deliveryProviderId} ${p.regionId} ${minorUnit}`).toEqual(
          await resolveDeliveryFee(fakeDb(w).db, { ...p, minorUnit })
        );
      }
    }
  });

  it('with no governorate on any pair there is nothing to read', async () => {
    const side = fakeDb(world({ fees: [fee()] }));
    const map = await resolveDeliveryFeesFor(side.db, [{ deliveryProviderId: 'k1', regionId: null }], 2);
    expect(side.counter.statements).toBe(0);
    expect(map.get(feePairKey('k1', null))).toEqual({ fee: 0, lateThresholdDays: 0, returnFee: 0, source: 'NONE' });
  });
});

/* ───────────────────────── the shelf ───────────────────────── */

describe('the pools of a list answer what availableStock answers, order by order', () => {
  for (const seed of [3, 31, 314]) {
    it(`seed ${seed}: freeFromPools equals availableStock for every (listed order, product) of its store`, async () => {
      const { world: w, listed } = seededWorld(seed, 60);
      const products = [...new Set(w.items.map((i) => i.productId as string))];
      const groups = new Map<string, BlockedOrder[]>();
      for (const o of listed) groups.set(`${o.companyId}|${o.storeId ?? '*'}`, [...(groups.get(`${o.companyId}|${o.storeId ?? '*'}`) ?? []), o]);
      let compared = 0;
      for (const group of groups.values()) {
        const pools = await stockPoolsFor(fakeDb(w).db, {
          companyId: group[0].companyId, storeId: group[0].storeId, productIds: products, orderIds: group.map((o) => o.id),
        });
        for (const o of group) {
          for (const productId of products) {
            const expected = await availableStock(fakeDb(w).db, o.companyId, productId, o.id, o.storeId);
            expect(freeFromPools(pools, o.id, productId), `${o.id} ${productId}`).toBe(expected);
            compared++;
          }
        }
      }
      expect(compared).toBeGreaterThan(500);
    });
  }

  it('with no products there is nothing to read', async () => {
    const side = fakeDb(world());
    await stockPoolsFor(side.db, { companyId: 'c1', storeId: 's1', productIds: [], orderIds: ['A'] });
    expect(side.counter.statements).toBe(0);
  });
});

describe('the whole shelf’s reserved column is reservedElsewhere’s answer for every product, from two reads', () => {
  for (const seed of [5, 50, 500]) {
    it(`seed ${seed}: equal for every product of every (company, store) — a store, no store, and the other company`, async () => {
      const { world: w } = seededWorld(seed, 80);
      const products = [...new Set(w.items.map((i) => i.productId as string))];
      let compared = 0;
      for (const [companyId, storeId] of [['c1', 's1'], ['c1', 's2'], ['c1', null], ['c2', 's1'], ['c2', null]] as const) {
        const side = fakeDb(w);
        const held = await reservedForProducts(side.db, { companyId, storeId, productIds: products });
        expect(side.counter.statements).toBe(2);
        for (const productId of products) {
          expect(held.get(productId) ?? 0, `${companyId} ${String(storeId)} ${productId}`).toBe(
            await reservedElsewhere(fakeDb(w).db, companyId, productId, undefined, storeId)
          );
          compared++;
        }
      }
      expect(compared).toBeGreaterThan(60);
    });
  }

  it('a product nothing holds is absent (read it as zero), and no products means no reads', async () => {
    const w = world({ orders: [order('A')], items: [item('A', 'p1', 2, 2)] });
    const side = fakeDb(w);
    const held = await reservedForProducts(side.db, { companyId: 'c1', storeId: 's1', productIds: ['p1', 'p2', 'p1'] });
    expect([...held]).toEqual([['p1', 2]]);
    const none = fakeDb(w);
    expect((await reservedForProducts(none.db, { companyId: 'c1', storeId: 's1', productIds: [] })).size).toBe(0);
    expect(none.counter.statements).toBe(0);
  });
});

/* ───────── and the per-product reads did not change when they began sharing their question ───────── */

/** The two filters as they were written before `holdingWhere` / `onHandWhere` existed — frozen here on purpose. */
const heldBefore = (companyId: string, productId: string, exceptOrderId?: string, storeId?: string | null) => ({
  companyId,
  productId,
  ...(exceptOrderId ? { orderId: { not: exceptOrderId } } : {}),
  reservedQty: { gt: 0 },
  order: {
    ...(storeId ? { storeId } : {}),
    confirmationStatus: { notIn: ['REJECTED', 'CANCELLED'] },
    shippingStatus: { notIn: ['DELIVERED', 'CANCELLED'] },
  },
});

describe('reservedElsewhere and onHand ask the tables exactly what they always asked', () => {
  const spy = () => {
    const seen: { table: string; where: unknown }[] = [];
    const aggregate = (table: string) => async (args: { where: unknown }) => {
      seen.push({ table, where: args.where });
      return { _sum: { reservedQty: 2, quantityRemaining: 9 } };
    };
    return {
      seen,
      db: {
        orderItem: { aggregate: aggregate('orderItem') },
        orderAddOn: { aggregate: aggregate('orderAddOn') },
        productionBatch: { aggregate: aggregate('productionBatch') },
      } as never,
    };
  };

  for (const [except, store] of [[undefined, undefined], ['o1', undefined], [undefined, 's1'], ['o1', 's1'], ['o1', null]] as const) {
    it(`except ${String(except)}, store ${String(store)}: the same filter on the lines and on the add-ons`, async () => {
      const s = spy();
      expect(await reservedElsewhere(s.db, 'c1', 'p1', except, store)).toBe(4);
      expect(s.seen.map((x) => x.table).sort()).toEqual(['orderAddOn', 'orderItem']);
      for (const call of s.seen) expect(call.where).toEqual(heldBefore('c1', 'p1', except, store));
    });
  }

  it('the shelf read is the company’s, narrowed to the store when there is one', async () => {
    const a = spy();
    expect(await onHand(a.db, 'c1', 'p1')).toBe(9);
    expect(a.seen[0].where).toEqual({ companyId: 'c1', productId: 'p1' });
    const b = spy();
    await onHand(b.db, 'c1', 'p1', 's1');
    expect(b.seen[0].where).toEqual({ companyId: 'c1', productId: 'p1', storeId: 's1' });
  });
});
