import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * «طلع من مخزن كذا» ON THE TRACKING ROW AND AT THE RETURNS DESK (the warehouse plan, request W4d) — THE DOORS.
 *
 * `Order.sourceWarehouseId` is stamped when an order joins a shipping batch in a PLACED store (W4a). The follow-up list
 * and the returns desk now carry the warehouse's NAME on each row that has one (`sourceWarehouseName`), read once for the
 * page. What is held here:
 *
 *   • a parcel stamped with a warehouse carries its name; the id it was read for never leaves;
 *   • a parcel with none carries no new key — and a page with none asks the database nothing new;
 *   • the name is read for THIS company only: a stamp naming another company's warehouse finds nothing;
 *   • «NOTHING CONFIGURED = TODAY, BYTE FOR BYTE»: for an unplaced store the two doors answer exactly what `osm/main`
 *     answered before this request, and ask the database exactly the same questions in the same order — pinned against
 *     a golden file written by `osm/main`'s own doors (`an-order-says-where-it-left-from.main-golden.json`; regenerated
 *     only with `W4D_WRITE_GOLDEN=1` on a checkout of the doors as they were).
 *
 * The database is a fake that answers the question it is asked (the `where` it can read, and the `select` — a column not
 * selected does not come back), so «the id never leaves» is the door's doing, not the fake's.
 */

const { db, requireContext, requirePermission, held, calls } = vi.hoisted(() => {
  const calls: string[] = [];
  const fn = (name: string) => {
    const f = vi.fn();
    return Object.assign((...a: unknown[]) => {
      calls.push(name);
      return f(...a);
    }, { mock: f });
  };
  return {
    calls,
    db: {
      order: { findMany: fn('order.findMany'), count: fn('order.count'), groupBy: fn('order.groupBy') },
      orderStatusLog: { findMany: fn('orderStatusLog.findMany') },
      orderChangeRequest: { findMany: fn('orderChangeRequest.findMany') },
      orderActivity: { findMany: fn('orderActivity.findMany') },
      deliveryFee: { findMany: fn('deliveryFee.findMany') },
      deliveryProvider: { findMany: fn('deliveryProvider.findMany') },
      region: { findMany: fn('region.findMany') },
      settlementMatch: { findMany: fn('settlementMatch.findMany') },
      user: { findMany: fn('user.findMany') },
      warehouse: { findMany: fn('warehouse.findMany') },
    },
    requireContext: vi.fn(),
    requirePermission: vi.fn(),
    held: new Set<string>(),
  };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: (...a: unknown[]) => requirePermission(...a),
  can: (_user: unknown, key: string) => held.has(key),
}));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/commission', () => ({ reverseForOrder: vi.fn() }));

import { GET as tracking } from './tracking/route';
import { GET as returns } from './returns/route';

// A Prisma-shaped fake and a JSON body: their shapes are the code under test's, not this file's.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const NOW = new Date('2026-11-20T09:00:00.000Z');
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const R1 = '33333333-3333-4333-8333-333333333333';
const R2 = '44444444-4444-4444-8444-444444444444';
const NORTH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SOUTH = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ELSEWHERE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const WAREHOUSES = [
  { id: NORTH, companyId: 'c1', name: 'المخزن الشمالي' },
  { id: SOUTH, companyId: 'c1', name: 'المخزن الجنوبي' },
  { id: ELSEWHERE, companyId: 'c2', name: 'مخزن شركة تانية' },
];

/** A small seeded generator, so the «many random scenarios» are the same scenarios on every machine. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const pick = <T,>(r: () => number, xs: readonly T[]) => xs[Math.floor(r() * xs.length)];

const SHIP_STATES = ['SHIPPED', 'OUT_FOR_DELIVERY', 'READY_FOR_PICKUP', 'FAILED_DELIVERY', 'RETURN_REQUESTED', 'DELIVERED', 'PARTIALLY_DELIVERED', 'RETURNED'];

/** One parcel as the DATABASE has it — every column the two doors may select, and the stamp. */
function parcel(i: number, r: () => number, stamp: string | null) {
  const state = pick(r, SHIP_STATES);
  const courier = pick(r, [C1, C2]);
  const region = pick(r, [R1, R2]);
  const qty = 1 + Math.floor(r() * 3);
  const days = Math.floor(r() * 15);
  return {
    id: `o${String(i).padStart(3, '0')}`,
    companyId: 'c1',
    storeId: 's1',
    orderNumber: `ORD-${1000 + i}`,
    merchantRef: r() < 0.3 ? `M-${i}` : null,
    trackingNumber: r() < 0.8 ? `TRK-${i}` : null,
    confirmationStatus: r() < 0.9 ? 'CONFIRMED' : 'CANCELLED',
    updatedAt: ago(Math.floor(r() * 3)),
    createdAt: ago(days + 2),
    shippingStatus: state,
    settlementStatus: pick(r, ['NOT_APPLICABLE', 'PENDING', 'SETTLED']),
    shippedAt: ago(days),
    outForDeliveryAt: null,
    deliveredAt: ['DELIVERED', 'PARTIALLY_DELIVERED'].includes(state) ? ago(Math.max(0, days - 1)) : null,
    returnedAt: state === 'RETURNED' ? ago(Math.max(0, days - 1)) : null,
    failedAt: state === 'FAILED_DELIVERY' ? ago(Math.max(0, days - 1)) : null,
    returnReason: state === 'RETURNED' ? 'CUSTOMER_REFUSED' : null,
    deliveryFailureReason: null,
    totalAmount: 20 * qty,
    deliveryFee: 3,
    priceIncludesDelivery: false,
    collectedAmount: null,
    currency: 'USD',
    regionId: region,
    deliveryProviderId: courier,
    sourceWarehouseId: stamp,
    items: [{ id: `i${i}`, productId: 'p1', productName: 'منتج', quantity: qty, freeQuantity: 0, unitPrice: 20, discountShare: 0, lineTotal: 20 * qty, deliveredQty: state === 'PARTIALLY_DELIVERED' ? 1 : null }],
    addOns: [],
    returnReceipt: null as Loose,
    customer: { fullName: `زبون ${i}`, phone: `0790000${String(i).padStart(3, '0')}`, city: 'عمّان' },
    region: { id: region, name: region === R1 ? 'عمّان' : 'إربد' },
    deliveryProvider: { id: courier, name: courier === C1 ? 'الأولى' : 'التانية', kind: 'COMPANY', apiEnabled: false, adapterCode: null },
    _count: { deliveryAttempts: 0, notes: 0 },
  };
}

/** Just enough of Prisma's `where`: `AND`, `OR`, equality, `in`, `notIn`, `not`; a relation filter reads as «matches». */
function matches(where: Loose, row: Loose): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]: [string, Loose]) => {
    if (key === 'AND') return cond.every((w: Loose) => matches(w, row));
    if (key === 'OR') return cond.some((w: Loose) => matches(w, row));
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond) return cond.in.includes(row[key]);
      if ('notIn' in cond) return !cond.notIn.includes(row[key]);
      if ('not' in cond) return row[key] !== cond.not;
      return true;
    }
    return row[key] === cond;
  });
}

/** A column not selected does not come back. */
function project(row: Loose, select: Loose) {
  if (!select) return row;
  const out: Loose = {};
  for (const [k, v] of Object.entries(select)) if (v && k in row) out[k] = row[k];
  return out;
}

let world: ReturnType<typeof parcel>[];

function scenario(seed: number, size: number, stamps: readonly (string | null)[] = [null]) {
  const r = rng(seed);
  return Array.from({ length: size }, (_, i) => {
    const p = parcel(i, r, pick(r, stamps));
    // About a third of the returns are already counted, so the desk's record view has rows too.
    if (['RETURNED', 'FAILED_DELIVERY'].includes(p.shippingStatus) && r() < 0.35) {
      p.returnReceipt = {
        expectedQty: p.items[0].quantity, receivedQty: p.items[0].quantity, damagedQty: 0, missingQty: 0,
        courierFeeCharged: false, inspectedById: 'u-insp', inspectedAt: ago(1), note: null,
      };
    }
    return p;
  });
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterAll(() => vi.useRealTimers());

beforeEach(() => {
  calls.length = 0;
  for (const model of Object.values(db)) for (const f of Object.values(model)) (f as Loose).mock.mockReset();
  held.clear();
  for (const k of ['ops.track', 'ops.returns', 'ops.returns_view', 'settlement.view', 'customers.view']) held.add(k);
  world = [];
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'موظفة', role: 'WAREHOUSE', status: 'ACTIVE' },
    companyId: 'c1',
    storeId: 's1',
    country: { minorUnit: 2, currencyCode: 'USD', code: 'JO' },
  });
  requirePermission.mockResolvedValue({});
  db.order.findMany.mock.mockImplementation(async (args: Loose) => {
    const rows = world.filter((p) => matches(args.where, p));
    const from = args.skip ?? 0;
    return rows.slice(from, from + (args.take ?? rows.length)).map((p) => project(p, args.select));
  });
  db.order.count.mock.mockImplementation(async (args: Loose) => world.filter((p) => matches(args.where, p)).length);
  db.order.groupBy.mock.mockResolvedValue([]);
  db.orderStatusLog.findMany.mock.mockResolvedValue([]);
  db.orderChangeRequest.findMany.mock.mockResolvedValue([]);
  db.orderActivity.findMany.mock.mockResolvedValue([]);
  db.deliveryFee.findMany.mock.mockResolvedValue([
    { deliveryProviderId: C1, regionId: R1, lateThresholdDays: 3 },
    { deliveryProviderId: C2, regionId: R2, lateThresholdDays: 0 },
  ]);
  db.deliveryProvider.findMany.mock.mockResolvedValue([
    { id: C1, name: 'الأولى', apiEnabled: false, adapterCode: null },
    { id: C2, name: 'التانية', apiEnabled: false, adapterCode: null },
  ]);
  db.region.findMany.mock.mockResolvedValue([{ id: R1, name: 'عمّان' }, { id: R2, name: 'إربد' }]);
  db.settlementMatch.findMany.mock.mockResolvedValue([]);
  db.user.findMany.mock.mockResolvedValue([{ id: 'u-insp', name: 'أمين' }]);
  // The warehouse table answers the question it is asked: the company and the ids are enforced.
  db.warehouse.findMany.mock.mockImplementation(async (args: Loose) =>
    WAREHOUSES.filter((w) => w.companyId === args.where.companyId && args.where.id.in.includes(w.id)).map((w) => project(w, args.select)),
  );
});

const QUESTIONS = {
  'tracking ·': () => tracking(new Request('http://localhost/api/ops/tracking')),
  'tracking · every': () => tracking(new Request('http://localhost/api/ops/tracking?status=every&limit=100')),
  'returns · pending': () => returns(new Request('http://localhost/api/ops/returns?limit=100')),
  'returns · received': () => returns(new Request('http://localhost/api/ops/returns?view=received&limit=100')),
} as const;

type Ask = keyof typeof QUESTIONS;
const ask = async (q: Ask) => {
  const res = await QUESTIONS[q]();
  expect(res.status, q).toBe(200);
  return (await res.json()) as Loose;
};

describe('a parcel that left from a warehouse says which', () => {
  it('— on the tracking row: the name, and never the id it was read for; a parcel with none carries no new key', async () => {
    world = scenario(7, 30, [NORTH, SOUTH, null]);
    const body = await ask('tracking · every');
    expect(body.orders.length).toBe(30);
    for (const row of body.orders) {
      const stamp = world.find((p) => p.id === row.id)!.sourceWarehouseId;
      expect(row, row.id).not.toHaveProperty('sourceWarehouseId');
      if (stamp === NORTH) expect(row.sourceWarehouseName, row.id).toBe('المخزن الشمالي');
      else if (stamp === SOUTH) expect(row.sourceWarehouseName, row.id).toBe('المخزن الجنوبي');
      else expect(row, row.id).not.toHaveProperty('sourceWarehouseName');
    }
    // One read of the warehouse table for the page, naming the company.
    expect(db.warehouse.findMany.mock).toHaveBeenCalledTimes(1);
    expect(db.warehouse.findMany.mock.mock.calls[0][0].where.companyId).toBe('c1');
  });

  it('and at the returns desk — the waiting parcels and the counted ones alike', async () => {
    world = scenario(11, 40, [NORTH, null]);
    for (const q of ['returns · pending', 'returns · received'] as const) {
      const body = await ask(q);
      expect(body.orders.length, q).toBeGreaterThan(0);
      for (const row of body.orders) {
        const stamp = world.find((p) => p.id === row.id)!.sourceWarehouseId;
        expect(row, `${q} ${row.id}`).not.toHaveProperty('sourceWarehouseId');
        if (stamp) expect(row.sourceWarehouseName, `${q} ${row.id}`).toBe('المخزن الشمالي');
        else expect(row, `${q} ${row.id}`).not.toHaveProperty('sourceWarehouseName');
      }
    }
  });

  it('NEGATIVE: a stamp that names another company’s warehouse finds no name, on either door', async () => {
    world = scenario(3, 12, [ELSEWHERE]);
    for (const q of Object.keys(QUESTIONS) as Ask[]) {
      const body = await ask(q);
      for (const row of body.orders) expect(row, `${q} ${row.id}`).not.toHaveProperty('sourceWarehouseName');
    }
  });

  it('NEGATIVE: a page where no parcel left from a warehouse never reads the warehouse table', async () => {
    world = scenario(5, 25);
    for (const q of Object.keys(QUESTIONS) as Ask[]) await ask(q);
    expect(db.warehouse.findMany.mock).not.toHaveBeenCalled();
  });
});

/*
 * THE DIFFERENTIAL. Many random unplaced stores: every body the two doors answer, and every question they put to the
 * database, are those of `osm/main` before this request. The golden file was written by `osm/main`'s doors.
 */
const GOLDEN = join(__dirname, 'an-order-says-where-it-left-from.main-golden.json');
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

describe('an unplaced store — the doors answer what they answered before, byte for byte', () => {
  it('— on every random store, every question: the same body and the same database questions as osm/main', async () => {
    // Each body is kept as its SHA-256 (byte for byte, without a megabyte of fake rows in the repository) beside its row count.
    const now: Record<string, { body: string; rows: number; asked: string[] }> = {};
    for (const seed of SEEDS) {
      for (const q of Object.keys(QUESTIONS) as Ask[]) {
        world = scenario(seed, 10 + seed * 3);
        calls.length = 0;
        const body = await ask(q);
        now[`${seed} ${q}`] = { body: createHash('sha256').update(JSON.stringify(body)).digest('base64url'), rows: body.orders.length, asked: [...calls] };
      }
    }
    if (process.env.W4D_WRITE_GOLDEN === '1') {
      writeFileSync(GOLDEN, JSON.stringify(now, null, 1) + '\n');
      return;
    }
    expect(existsSync(GOLDEN), 'the golden file of osm/main is missing').toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
    expect(Object.keys(now).sort()).toEqual(Object.keys(golden).sort());
    for (const key of Object.keys(golden)) {
      expect(now[key].body, key).toBe(golden[key].body);
      expect(now[key].rows, key).toBe(golden[key].rows);
      expect(now[key].asked, key).toEqual(golden[key].asked);
    }
    // The golden has real rows in it — a differential of empty lists would prove nothing.
    const rows = Object.values(golden as Record<string, { rows: number }>).reduce((n, g) => n + g.rows, 0);
    expect(rows).toBeGreaterThan(200);
  });
});
