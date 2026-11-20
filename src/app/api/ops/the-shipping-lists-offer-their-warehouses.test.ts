import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionUser } from '@/types/auth';
import type { Row } from '@/lib/shipment-warehouse.memory-db.test';

/**
 * THE SHIPPING LISTS OFFER THE WAREHOUSES A PERSON MAY PICK (the warehouse plan, request W4c).
 *
 *   GET /api/ops/preparation · GET /api/ops/shipments · GET /api/shipping-batches
 *
 * For a store PLACED in warehouses each list carries `warehouses` — the running warehouses of the store's country this
 * person reaches, by name — so the screens can draw a picker that never offers a warehouse the door would refuse. The
 * batch list also narrows to one of them with `?warehouse=` and names each batch's warehouse.
 *
 * For a store that is NOT placed nothing of this exists: no field, no parameter read, no warehouse table read. That is
 * pinned twice — by the answers below, and by a frozen golden of the three answers taken from `osm/main` before this
 * request (`ops-lists.main-golden.json`): the same world, the same JSON, byte for byte.
 *
 * People are built the way a session builds them: `computeEffectiveGrants` over role rows, a personal override and a
 * roleId-null legacy account, with the REAL `can` and the REAL `warehousesReachedBy` over the in-memory database.
 */

const S = vi.hoisted(() => ({
  current: null as unknown as SessionUser,
  m: null as unknown as { db: Record<string, unknown>; data: Record<string, Row[]>; calls: { call: string; args: unknown }[] },
  rolePerms: {} as Record<string, string[]>,
  overrides: {} as Record<string, { permission: string; effect: 'ALLOW' | 'DENY' }[]>,
}));

vi.mock('@/lib/db', () => {
  const extra: Row = {
    rolePermission: {
      findMany: async ({ where }: Row) =>
        (where.roleId ? S.rolePerms[where.roleId] ?? [] : S.rolePerms[`template:${where.role?.name}`] ?? []).map((permission) => ({ permission, scope: 'ALL_COMPANY', scopeIds: null })),
    },
    userPermission: { findMany: async ({ where }: Row) => (S.overrides[where.userId] ?? []).map((o) => ({ ...o, scope: 'ALL_COMPANY', scopeIds: null })) },
  };
  const db = new Proxy({} as Row, { get: (_t, prop: string) => (prop in extra ? extra[prop] : (S.m.db as Row)[prop]) });
  return { db };
});
vi.mock('@/lib/geo-context', async (orig) => {
  const real = await orig<typeof import('@/lib/geo-context')>();
  return {
    ...real,
    requireContext: async () => ({
      user: S.current,
      companyId: (S.current as Row).companyId,
      storeId: 's1',
      country: { allowNegativeStock: false, minorUnit: 2 },
    }),
  };
});
vi.mock('@/lib/authorization', async (orig) => {
  const real = await orig<typeof import('@/lib/authorization')>();
  return {
    ...real,
    requirePermission: async (k: string) => {
      if (!real.can(S.current, k)) throw new Error(`Forbidden: missing required permission ${k}`);
      return S.current;
    },
  };
});
vi.mock('@/lib/audit', () => ({ logAudit: async () => undefined }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: async () => undefined }));
vi.mock('@/lib/couriers/city-gaps', () => ({ courierCityGaps: async () => new Map() }));

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { shipDb } from '@/lib/shipment-warehouse.memory-db.test';
import { GET as preparation } from '@/app/api/ops/preparation/route';
import { GET as shipments } from '@/app/api/ops/shipments/route';
import { GET as batchesList } from '@/app/api/shipping-batches/route';

const C1 = 'c1';
const DP = '00000000-0000-4000-9000-000000000900';
const O = ['00000000-0000-4000-9000-000000000001', '00000000-0000-4000-9000-000000000002'];

async function as(userId: string) {
  const u = S.m.data.user.find((x) => x.id === userId)!;
  S.current = attachGrants({ ...u, permissions: [] } as unknown as SessionUser, await computeEffectiveGrants({ id: u.id, role: u.role, roleId: u.roleId ?? null }));
}
const json = async (res: Response) => ({ status: res.status, body: await res.json() });

function world(placed: boolean) {
  const people = [
    ['u-owner', 'SUPER_ADMIN', null],
    ['u-shipper', 'CUSTOM', 'r-ship'],
    ['u-keeper-b', 'CUSTOM', 'r-ship'],
    ['u-legacy-wh', 'WAREHOUSE', null],
    ['u-abroad', 'CUSTOM', 'r-ship'],
  ] as const;
  const order = (id: string, over: Row = {}) => ({
    id, companyId: C1, storeId: 's1', customerId: `cu-${id.slice(-1)}`, regionId: 'r1', deliveryProviderId: null, orderNumber: `ORD-${id.slice(-2)}`,
    confirmationStatus: 'CONFIRMED', shippingStatus: 'NOT_READY', shippedAt: null, priceIncludesDelivery: false, version: 1, currency: 'SYP',
    createdAt: new Date('2026-11-01T08:00:00.000Z'), merchantRef: null, deliveryFee: 0, deliveryAddress: null,
    shippingBatchId: null, labelPrintedAt: null, shipHoldUntil: null, shipHoldReason: null, sourceWarehouseId: null,
    customer: { id: `cu-${id.slice(-1)}`, fullName: 'زبون', phone: '0790000000', city: 'مدينة', totalOrders: 1, address: null },
    region: { id: 'r1', name: 'محافظة' },
    changeRequests: [],
    ...over,
  });
  const item = (orderId: string, qty: number) => ({
    id: `i-${orderId}`, companyId: C1, orderId, productId: 'p1', productName: 'مقشر', quantity: qty, freeQuantity: 0, reservedQty: qty,
    unitPrice: 10, discountShare: 0, lineTotal: 10 * qty,
  });
  return shipDb({
    country: [
      { id: 'k1', companyId: C1, isActive: true },
      { id: 'k2', companyId: C1, isActive: true },
    ],
    store: [{ id: 's1', companyId: C1, countryId: 'k1', isTest: false }],
    user: people.map(([uid, role, roleId]) => ({ id: uid, name: uid, role, roleId, status: 'ACTIVE', companyId: C1 })),
    userCountryAccess: people.filter(([uid]) => uid !== 'u-owner').map(([userId]) => ({ userId, countryId: userId === 'u-abroad' ? 'k2' : 'k1' })),
    userWarehouseAccess: [{ userId: 'u-keeper-b', warehouseId: 'wB' }],
    warehousePlacement: placed ? [{ id: 'pl1', companyId: C1, storeId: 's1' }] : [],
    warehouse: [
      // Name order is «أ», «ب»; the stopped one is never offered.
      { id: 'wB', companyId: C1, countryId: 'k1', name: 'مخزن ب', isActive: true },
      { id: 'wA', companyId: C1, countryId: 'k1', name: 'مخزن أ', isActive: true },
      { id: 'wStopped', companyId: C1, countryId: 'k1', name: 'مخزن ج', isActive: false },
      { id: 'wAbroad', companyId: C1, countryId: 'k2', name: 'مخزن برّا', isActive: true },
    ],
    productionBatch: [
      { id: 'bA', companyId: C1, storeId: 's1', productId: 'p1', quantityRemaining: 3, warehouseId: placed ? 'wA' : null, inTransitTransferId: null },
      { id: 'bB', companyId: C1, storeId: 's1', productId: 'p1', quantityRemaining: 10, warehouseId: placed ? 'wB' : null, inTransitTransferId: null },
    ],
    deliveryProvider: [{ id: DP, companyId: C1, name: 'شركة', apiEnabled: false, isActive: true }],
    deliveryFee: [{ id: 'f1', deliveryProviderId: DP, regionId: 'r1', isActive: true, fee: 3, lateThresholdDays: 3, returnFee: 0 }],
    order: [order(O[0]), order(O[1])],
    orderItem: [item(O[0], 2), item(O[1], 1)],
    orderAddOn: [],
    shippingBatch: [
      { id: 'tA', companyId: C1, storeId: 's1', deliveryProviderId: DP, status: 'READY', warehouseId: placed ? 'wA' : null, batchNumber: 'SB-1', createdAt: new Date('2026-11-02T08:00:00.000Z'), shippedAt: null, notes: null, createdById: 'u-owner' },
      { id: 'tB', companyId: C1, storeId: 's1', deliveryProviderId: DP, status: 'SHIPPED', warehouseId: placed ? 'wB' : null, batchNumber: 'SB-2', createdAt: new Date('2026-11-01T08:00:00.000Z'), shippedAt: null, notes: null, createdById: 'u-owner' },
    ],
  }) as never;
}

beforeEach(() => {
  S.rolePerms = {
    'r-ship': ['ops.ship', 'ops.prepare', 'ops.batches', 'orders.change_status'],
    'template:WAREHOUSE': ['ops.ship', 'ops.prepare', 'ops.batches', 'orders.change_status'],
  };
  S.overrides = {};
  S.m = world(true);
});

const lists = async () => ({
  preparation: await json(await preparation(new Request('http://x/api/ops/preparation'))),
  shipments: await json(await shipments(new Request(`http://x/api/ops/shipments?courier=${DP}`))),
  batches: await json(await batchesList(new Request('http://x/api/shipping-batches?limit=100'))),
});
const warehouseReads = () => S.m.calls.filter((c) => c.call.startsWith('warehouse.') || c.call.startsWith('userWarehouseAccess.'));

describe('a store that is NOT placed: the three lists answer as before', () => {
  it('no `warehouses` field, no warehouse table read, no `warehouse` asked of a batch', async () => {
    S.m = world(false);
    await as('u-owner');
    const out = await lists();
    for (const [name, r] of Object.entries(out)) {
      expect(r.status, name).toBe(200);
      expect(r.body, name).not.toHaveProperty('warehouses');
    }
    expect(warehouseReads()).toEqual([]);
    const read = S.m.calls.find((c) => c.call === 'shippingBatch.findMany')!.args as Row;
    expect(read.include).not.toHaveProperty('warehouse');
  });

  it('NEGATIVE: `?warehouse=` is not read — the batch list is the whole store’s', async () => {
    S.m = world(false);
    await as('u-owner');
    const r = await json(await batchesList(new Request('http://x/api/shipping-batches?limit=100&warehouse=wA')));
    expect(r.body.batches.map((b: Row) => b.id)).toEqual(['tA', 'tB']);
    for (const c of S.m.calls.filter((x) => x.call.startsWith('shippingBatch.'))) expect((c.args as Row).where).not.toHaveProperty('warehouseId');
  });

  it('differential: the same answers, byte for byte, as `osm/main` before this request', async () => {
    S.m = world(false);
    await as('u-owner');
    const out = await lists();
    const golden = join(process.cwd(), 'src/app/api/ops/ops-lists.main-golden.json');
    const now = JSON.stringify(out, null, 2);
    if (process.env.W4C_WRITE_GOLDEN === '1') writeFileSync(golden, now + '\n');
    expect(now + '\n').toBe(readFileSync(golden, 'utf8').replace(/\r\n/g, '\n'));
  });
});

describe('a placed store: the warehouses this person may pick, by name', () => {
  it('the owner: every running warehouse of the store’s country — not the stopped one, not another country’s', async () => {
    await as('u-owner');
    const out = await lists();
    for (const [name, r] of Object.entries(out)) {
      expect(r.body.warehouses, name).toEqual([
        { id: 'wA', name: 'مخزن أ' },
        { id: 'wB', name: 'مخزن ب' },
      ]);
    }
  });

  it('a roleId-null WAREHOUSE account with no keeper rows: every warehouse of her country', async () => {
    await as('u-legacy-wh');
    expect((await lists()).shipments.body.warehouses.map((w: Row) => w.id)).toEqual(['wA', 'wB']);
  });

  it('NEGATIVE: a keeper of B is offered B only — never a warehouse the door would refuse her', async () => {
    await as('u-keeper-b');
    const out = await lists();
    for (const [name, r] of Object.entries(out)) expect(r.body.warehouses, name).toEqual([{ id: 'wB', name: 'مخزن ب' }]);
  });

  it('NEGATIVE: somebody of another country is offered none (the screen says so)', async () => {
    await as('u-abroad');
    expect((await lists()).preparation.body.warehouses).toEqual([]);
  });

  it('each batch names its warehouse', async () => {
    await as('u-owner');
    const r = await json(await batchesList(new Request('http://x/api/shipping-batches?limit=100')));
    expect(r.body.batches.map((b: Row) => [b.id, b.warehouse])).toEqual([
      ['tA', { id: 'wA', name: 'مخزن أ' }],
      ['tB', { id: 'wB', name: 'مخزن ب' }],
    ]);
  });

  it('`?warehouse=` narrows the batch list and its count to that warehouse', async () => {
    await as('u-owner');
    const r = await json(await batchesList(new Request('http://x/api/shipping-batches?limit=100&warehouse=wB')));
    expect(r.body.batches.map((b: Row) => b.id)).toEqual(['tB']);
    expect(r.body.pagination.total).toBe(1);
  });

  it('NEGATIVE: a warehouse that is not offered (stopped, unknown) does not narrow anything', async () => {
    await as('u-owner');
    for (const asked of ['wStopped', 'nope', 'wAbroad']) {
      const r = await json(await batchesList(new Request(`http://x/api/shipping-batches?limit=100&warehouse=${asked}`)));
      expect(r.body.batches.map((b: Row) => b.id), asked).toEqual(['tA', 'tB']);
    }
  });

  it('the shipments list asked for one warehouse names the other that holds the units (W4a’s sentence, unchanged)', async () => {
    await as('u-owner');
    // wA holds 3, wB holds 10: an order of 4 cannot leave from A.
    const line = S.m.data.orderItem.find((i) => i.orderId === O[0])!;
    Object.assign(line, { quantity: 4, reservedQty: 4 });
    const r = await json(await shipments(new Request(`http://x/api/ops/shipments?courier=${DP}&warehouse=wA`)));
    const blocks = r.body.orders.find((o: Row) => o.id === O[0]).blocks.filter((x: Row) => x.code === 'STOCK_SHORTAGE');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].message).toMatch(/«مخزن أ».*«مخزن ب»/);
  });
});

describe('the source', () => {
  it('the three doors ask the one helper, with the session’s reach rule', () => {
    for (const f of ['src/app/api/ops/preparation/route.ts', 'src/app/api/ops/shipments/route.ts', 'src/app/api/shipping-batches/route.ts']) {
      const src = readFileSync(join(process.cwd(), f), 'utf8');
      expect(src, f).toMatch(/shipmentWarehouseChoices\(db, \{ companyId, storeId, reached: \(ws\) => warehousesReachedBy\(user, companyId, ws\) \}\)/);
      expect(src, f).toMatch(/\.\.\.\(warehouses \? \{ warehouses \} : \{\}\)/);
    }
  });
});
