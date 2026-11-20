import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * «طلع من مخزن كذا» IN THE ORDER WINDOW (the warehouse plan, request W4d) — THE DOOR `GET /api/orders/:id`.
 *
 *   • an order stamped with a source warehouse (W4a) carries `sourceWarehouseName`, read for THIS company only;
 *   • an order with none carries no new key and costs no new read;
 *   • «NOTHING CONFIGURED = TODAY, BYTE FOR BYTE»: for orders with no source warehouse the door answers exactly what
 *     `osm/main` answered and asks the database the same questions in the same order — pinned against a golden file
 *     written by `osm/main`'s own door (`the-window-says-where-it-left-from.main-golden.json`; regenerated only with
 *     `W4D_WRITE_GOLDEN=1` on a checkout of the door as it was).
 */

const { db, calls, requireContext, can, authorize, getPermissionScope, assertOrderReadable } = vi.hoisted(() => {
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
      order: { findUnique: fn('order.findUnique'), findFirst: fn('order.findFirst') },
      returnReceipt: { count: fn('returnReceipt.count') },
      warehouse: { findMany: fn('warehouse.findMany') },
    },
    requireContext: vi.fn(),
    can: vi.fn(),
    authorize: vi.fn(),
    getPermissionScope: vi.fn(),
    assertOrderReadable: vi.fn(),
  };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  can: (...a: unknown[]) => can(...a),
  authorize: (...a: unknown[]) => authorize(...a),
  getPermissionScope: (...a: unknown[]) => getPermissionScope(...a),
  requirePermission: vi.fn(),
}));
vi.mock('@/lib/rbac', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertOrderAccess: vi.fn(),
  assertOrderReadable: (...a: unknown[]) => assertOrderReadable(...a),
}));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/api-error', () => ({
  apiError: (e: unknown) => ({ body: { error: `UNEXPECTED: ${(e as Error)?.message}` }, status: 500 }),
}));

import { GET } from './route';

// A Prisma-shaped fake and a JSON body: their shapes are the code under test's, not this file's.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const NOW = new Date('2026-11-20T09:00:00.000Z');
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

const NORTH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ELSEWHERE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const WAREHOUSES = [
  { id: NORTH, companyId: 'c1', name: 'المخزن الشمالي' },
  { id: ELSEWHERE, companyId: 'c2', name: 'مخزن شركة تانية' },
];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const pick = <T,>(r: () => number, xs: readonly T[]) => xs[Math.floor(r() * xs.length)];

/** The order as the database answers the route's `include` — every scalar, the joins it asks for. */
function order(seed: number, stamp: string | null) {
  const r = rng(seed);
  const shippingStatus = pick(r, ['NOT_READY', 'READY_FOR_SHIPPING', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'RETURNED']);
  const qty = 1 + Math.floor(r() * 3);
  const batched = shippingStatus !== 'NOT_READY';
  return {
    id: 'o1',
    companyId: 'c1',
    storeId: 's1',
    orderNumber: `ORD-${seed}`,
    createdAt: ago(10),
    updatedAt: ago(1),
    version: 3,
    status: 'CONFIRMED',
    confirmationStatus: pick(r, ['NEW', 'CONFIRMED', 'CANCELLED']),
    shippingStatus,
    settlementStatus: pick(r, ['NOT_APPLICABLE', 'PENDING']),
    signatureStatus: 'UNSIGNED',
    claimedById: r() < 0.5 ? 'a1' : null,
    assignedToId: null,
    assignedAt: null,
    totalAmount: 20 * qty,
    deliveryFee: 3,
    shippingCost: null,
    discountAmount: r() < 0.3 ? 2 : 0,
    priceIncludesDelivery: r() < 0.2,
    quantity: qty,
    offerId: null,
    shippingBatchId: batched ? 'b1' : null,
    sourceWarehouseId: stamp,
    items: [],
    addOns: [],
    customer: { id: 'cu1', fullName: 'زبون', phone: '0790000000', city: 'عمّان' },
    product: null,
    offer: null,
    region: { id: 'r1', name: 'عمّان' },
    deliveryProvider: null,
    shippingBatch: batched ? { id: 'b1', batchNumber: `B-${seed}`, status: 'OPEN' } : null,
    store: { isTest: false },
    landingPage: null,
    moderator: null,
    commissions: [],
    claimer: null,
    confirmer: null,
    owner: null,
    assignee: null,
    lockHolder: null,
    signer: null,
    claimHistory: [],
    callLogs: [],
    activities: [],
    _count: { contactAttempts: 0, deliveryAttempts: 0 },
    telegramMessages: [],
  };
}

let current: ReturnType<typeof order>;

const holding = (...keys: string[]) => {
  can.mockImplementation((_u: unknown, k: string) => keys.includes(k));
  authorize.mockImplementation((_u: unknown, k: string) => ({ allowed: keys.includes(k) }));
};

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterAll(() => vi.useRealTimers());

beforeEach(() => {
  calls.length = 0;
  for (const model of Object.values(db)) for (const f of Object.values(model)) (f as Loose).mock.mockReset();
  requireContext.mockResolvedValue({
    user: { id: 'a1', name: 'موظفة', role: 'ADMIN' },
    companyId: 'c1',
    storeId: 's1',
    country: { id: 'co', code: 'JO', currencyCode: 'JOD', minorUnit: 3, timezone: 'Asia/Amman' },
  });
  getPermissionScope.mockReturnValue({ scope: 'ALL' });
  assertOrderReadable.mockImplementation(async () => ({ allowed: true, order: current }));
  holding('orders.view');
  db.order.findUnique.mock.mockImplementation(async () => current);
  db.order.findFirst.mock.mockResolvedValue({ id: 'o-neighbour' });
  db.returnReceipt.count.mock.mockResolvedValue(0);
  db.warehouse.findMany.mock.mockImplementation(async (args: Loose) =>
    WAREHOUSES.filter((w) => w.companyId === args.where.companyId && args.where.id.in.includes(w.id)).map(({ id, name }) => ({ id, name })),
  );
});

const open = async () => {
  const res = await GET(new Request('http://localhost/api/orders/o1'), { params: Promise.resolve({ id: 'o1' }) });
  const body = (await res.json()) as Loose;
  expect(res.status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body;
};

describe('the order window says where it left from', () => {
  it('— an order stamped with a warehouse carries its name, read once for this company', async () => {
    current = order(1, NORTH);
    const body = await open();
    expect(body.order.sourceWarehouseName).toBe('المخزن الشمالي');
    expect(db.warehouse.findMany.mock).toHaveBeenCalledTimes(1);
    expect(db.warehouse.findMany.mock.mock.calls[0][0]).toEqual({ where: { companyId: 'c1', id: { in: [NORTH] } }, select: { id: true, name: true } });
  });

  it('NEGATIVE: an order with none carries no new key, and the warehouse table is never read', async () => {
    current = order(2, null);
    const body = await open();
    expect(body.order).not.toHaveProperty('sourceWarehouseName');
    expect(db.warehouse.findMany.mock).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a stamp naming another company’s warehouse finds no name', async () => {
    current = order(3, ELSEWHERE);
    const body = await open();
    expect(body.order).not.toHaveProperty('sourceWarehouseName');
  });
});

const GOLDEN = join(__dirname, 'the-window-says-where-it-left-from.main-golden.json');
const SEEDS = Array.from({ length: 24 }, (_, i) => i + 1);

describe('an order with no source warehouse — the window answers what it answered before, byte for byte', () => {
  it('— on every random order, with and without the arrows: the same body and the same database questions as osm/main', async () => {
    const now: Record<string, { body: string; asked: string[] }> = {};
    for (const seed of SEEDS) {
      for (const arrows of [false, true]) {
        current = order(seed, null);
        if (arrows) holding('orders.view', 'orders.navigate');
        else holding('orders.view');
        calls.length = 0;
        const body = await open();
        now[`${seed} ${arrows ? 'arrows' : 'plain'}`] = { body: createHash('sha256').update(JSON.stringify(body)).digest('base64url'), asked: [...calls] };
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
      expect(now[key].asked, key).toEqual(golden[key].asked);
    }
  });
});
