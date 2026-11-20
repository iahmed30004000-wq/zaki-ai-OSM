import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionUser } from '@/types/auth';
import type { Row } from '@/lib/shipment-warehouse.memory-db.test';

/**
 * A SHIPMENT IS MADE IN ONE WAREHOUSE — the doors (the warehouse plan, request W4a).
 *
 *   POST /api/ops/shipments          a placed store's press names the warehouse (one she reaches); every order that joins
 *                                    is stamped `sourceWarehouseId`; the trolley carries the warehouse and is never shared
 *                                    with another warehouse; the stock blocks are the warehouse's.
 *   POST /api/shipping-batches       the empty trolley of a placed store names its warehouse too.
 *   GET  /api/ops/preparation        «available» per warehouse with `?warehouse=`.
 *   the «off the trolley» columns    drop the stamp (hold, stand-down, cancel go through them).
 *
 * People are built the way a session builds them: `computeEffectiveGrants` over role rows, a personal override and a
 * roleId-null legacy account (the system template it inherits), with the REAL `can` and the REAL `reachesWarehouse` over
 * the country and keeper rows of the in-memory database (`shipment-warehouse.memory-db.test.ts`).
 */

const S = vi.hoisted(() => ({
  current: null as unknown as SessionUser,
  storeId: 's1',
  allowNegativeStock: false,
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
      storeId: S.storeId,
      country: { allowNegativeStock: S.allowNegativeStock, minorUnit: 2 },
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

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { shipDb } from '@/lib/shipment-warehouse.memory-db.test';
import { leavesTheShipment, leavesTheTrolley } from '@/lib/shipment-cancel';
import { POST as createShipment } from './route';
import { POST as openTrolley } from '@/app/api/shipping-batches/route';
import { GET as preparation } from '@/app/api/ops/preparation/route';

const C1 = 'c1';
const id = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`;
const DP = id(900);
const O = [id(1), id(2), id(3), id(4)];

async function as(userId: string) {
  const u = S.m.data.user.find((x) => x.id === userId)!;
  S.current = attachGrants({ ...u, permissions: [] } as unknown as SessionUser, await computeEffectiveGrants({ id: u.id, role: u.role, roleId: u.roleId ?? null }));
}
const json = async (res: Response) => ({ status: res.status, body: await res.json() });
const post = (body: Row) =>
  createShipment(new Request('http://x/api/ops/shipments', { method: 'POST', body: JSON.stringify({ deliveryProviderId: DP, ...body }) })).then(json);

const order = (oid: string, over: Row = {}) => ({
  id: oid, companyId: C1, storeId: 's1', customerId: `cu-${oid}`, regionId: 'r1', deliveryProviderId: null, orderNumber: `ORD-${oid.slice(-2)}`,
  confirmationStatus: 'CONFIRMED', shippingStatus: 'NOT_READY', shippedAt: null, priceIncludesDelivery: false, version: 1,
  shippingBatchId: null, labelPrintedAt: null, shipHoldUntil: null, shipHoldReason: null, sourceWarehouseId: null, ...over,
});
const item = (oid: string, qty = 2) => ({
  id: `i-${oid}`, companyId: C1, orderId: oid, productId: 'p1', productName: 'مقشر', quantity: qty, freeQuantity: 0, reservedQty: qty,
  unitPrice: 10, discountShare: 0, lineTotal: 10 * qty,
});

function world(placed: boolean) {
  const people = [
    ['u-owner', 'SUPER_ADMIN', null],
    ['u-shipper', 'CUSTOM', 'r-ship'],
    ['u-keeper-b', 'CUSTOM', 'r-ship'],
    ['u-denied', 'CUSTOM', 'r-ship'],
    ['u-plus', 'CUSTOM', 'r-viewer'],
    ['u-legacy-wh', 'WAREHOUSE', null],
    ['u-abroad', 'CUSTOM', 'r-ship'],
  ] as const;
  return shipDb({
    country: [
      { id: 'k1', companyId: C1, isActive: true },
      { id: 'k2', companyId: C1, isActive: true },
    ],
    store: [
      { id: 's1', companyId: C1, countryId: 'k1', isTest: false },
      { id: 's2', companyId: C1, countryId: 'k1', isTest: false },
    ],
    user: people.map(([uid, role, roleId]) => ({ id: uid, name: uid, role, roleId, status: 'ACTIVE', companyId: C1 })),
    userCountryAccess: people.filter(([uid]) => uid !== 'u-owner').map(([userId]) => ({ userId, countryId: userId === 'u-abroad' ? 'k2' : 'k1' })),
    // A keeper of wB only.
    userWarehouseAccess: [{ userId: 'u-keeper-b', warehouseId: 'wB' }],
    warehousePlacement: placed ? [{ id: 'pl1', companyId: C1, storeId: 's1' }] : [],
    warehouse: [
      { id: 'wA', companyId: C1, countryId: 'k1', name: 'مخزن أ', isActive: true },
      { id: 'wB', companyId: C1, countryId: 'k1', name: 'مخزن ب', isActive: true },
    ],
    productionBatch: [
      { id: 'bA', companyId: C1, storeId: 's1', productId: 'p1', quantityRemaining: 3, warehouseId: placed ? 'wA' : null, inTransitTransferId: null },
      { id: 'bB', companyId: C1, storeId: 's1', productId: 'p1', quantityRemaining: 10, warehouseId: placed ? 'wB' : null, inTransitTransferId: null },
    ],
    deliveryProvider: [{ id: DP, companyId: C1, name: 'شركة', apiEnabled: false, isActive: true }],
    deliveryFee: [{ id: 'f1', deliveryProviderId: DP, regionId: 'r1', isActive: true, fee: 3, lateThresholdDays: 3, returnFee: 0 }],
    order: [order(O[0]), order(O[1]), order(O[2])],
    orderItem: [item(O[0]), item(O[1]), item(O[2], 1)],
    orderAddOn: [],
    shippingBatch: [],
  }) as never;
}

beforeEach(() => {
  S.storeId = 's1';
  S.allowNegativeStock = false;
  S.rolePerms = {
    'r-ship': ['ops.ship', 'ops.prepare', 'orders.change_status'],
    'r-viewer': ['orders.view'],
    // The system template a roleId-null WAREHOUSE account inherits — packing keys, no keeper rows: every warehouse of
    // her country.
    'template:WAREHOUSE': ['ops.ship', 'ops.prepare', 'orders.change_status'],
  };
  S.overrides = {
    'u-denied': [{ permission: 'ops.ship', effect: 'DENY' }],
    'u-plus': [{ permission: 'ops.ship', effect: 'ALLOW' }],
  };
  S.m = world(true);
});

const written = (call: string) => S.m.calls.filter((c) => c.call === call).map((c) => c.args as Row);

describe('a store that is not placed: the press is today’s press', () => {
  it('no warehouse asked, none written — whatever the body carries', async () => {
    for (const warehouseId of [undefined, 'wA', 'nope', 42]) {
      S.m = world(false);
      await as('u-shipper');
      const r = await post({ orderIds: [O[0]], ...(warehouseId === undefined ? {} : { warehouseId }) });
      expect(r.status, String(warehouseId)).toBe(201);
      const [created] = written('shippingBatch.create');
      expect(created.data).not.toHaveProperty('warehouseId');
      for (const u of written('order.update')) expect(u.data).not.toHaveProperty('sourceWarehouseId');
      expect(written('shippingBatch.findFirst')[0].where).not.toHaveProperty('warehouseId');
      // The only new read: «is this store placed?», in the one store read.
      expect(S.m.calls.filter((c) => c.call.startsWith('warehouse')).length).toBe(0);
    }
  });
});

describe('a placed store: one shipment, one warehouse', () => {
  it('NEGATIVE: no warehouse → refused in Arabic, nothing written', async () => {
    await as('u-shipper');
    const r = await post({ orderIds: [O[0]] });
    expect([r.status, r.body.code]).toEqual([400, 'WAREHOUSE_REQUIRED']);
    expect(r.body.errorAr).toMatch(/اختار المخزن/);
    expect(S.m.data.shippingBatch).toEqual([]);
  });

  it('the trolley carries the warehouse and every order that joins is stamped with it', async () => {
    await as('u-shipper');
    const r = await post({ orderIds: [O[2]], warehouseId: 'wA' });
    expect(r.status).toBe(201);
    expect(S.m.data.shippingBatch).toMatchObject([{ warehouseId: 'wA', status: 'READY' }]);
    expect(S.m.data.order.find((o) => o.id === O[2])).toMatchObject({ sourceWarehouseId: 'wA', shippingBatchId: r.body.batch.id });
    // Orders that were not in the press are not touched.
    expect(S.m.data.order.find((o) => o.id === O[0])!.sourceWarehouseId).toBeNull();
  });

  it('one open trolley per courier AND warehouse: a press from B never joins A’s trolley, nor a trolley of before the placement', async () => {
    S.m.data.shippingBatch.push(
      { id: 'tLegacy', companyId: C1, storeId: 's1', deliveryProviderId: DP, status: 'READY', warehouseId: null, batchNumber: 'B-0', createdAt: new Date('2026-11-01') },
      { id: 'tA', companyId: C1, storeId: 's1', deliveryProviderId: DP, status: 'READY', warehouseId: 'wA', batchNumber: 'B-1', createdAt: new Date('2026-11-02') }
    );
    await as('u-shipper');
    const fromB = await post({ orderIds: [O[0]], warehouseId: 'wB' });
    expect(fromB.status).toBe(201);
    expect(fromB.body.batch.id).not.toBe('tA');
    expect(fromB.body.batch.id).not.toBe('tLegacy');
    expect(fromB.body.batch.warehouseId).toBe('wB');
    const fromA = await post({ orderIds: [O[2]], warehouseId: 'wA' });
    expect(fromA.body.batch.id).toBe('tA');
    // Every trolley holds orders of ONE warehouse.
    for (const t of S.m.data.shippingBatch) {
      const sources = new Set(S.m.data.order.filter((o) => o.shippingBatchId === t.id).map((o) => o.sourceWarehouseId));
      expect(sources.size, t.id).toBeLessThanOrEqual(1);
      if (sources.size) expect([...sources][0]).toBe(t.warehouseId);
    }
  });

  it('a shortage in A with stock in B is refused, and the sentence names B', async () => {
    await as('u-shipper');
    // wA holds 3; O1 and O2 want 2 each in one press.
    const r = await post({ orderIds: [O[0], O[1]], warehouseId: 'wA' });
    expect([r.status, r.body.code]).toEqual([409, 'ALL_BLOCKED']);
    for (const e of r.body.exceptions) expect(e.reasons.join(' ')).toMatch(/«مخزن أ».*«مخزن ب»/);
    expect(S.m.data.shippingBatch).toEqual([]);
    // The same press from B goes through.
    expect((await post({ orderIds: [O[0], O[1]], warehouseId: 'wB' })).status).toBe(201);
  });

  it('where negative stock is allowed the shortage is soft: shipped only with the order acknowledged by name', async () => {
    S.allowNegativeStock = true;
    await as('u-shipper');
    expect((await post({ orderIds: [O[0], O[1]], warehouseId: 'wA' })).status).toBe(409);
    expect((await post({ orderIds: [O[0], O[1]], warehouseId: 'wA', acknowledgedOrderIds: [O[0], O[1]] })).status).toBe(201);
  });
});

describe('who may ship from which warehouse — persons built as a session builds them', () => {
  it('NEGATIVE: a keeper of B cannot ship from A; she can from B', async () => {
    await as('u-keeper-b');
    const r = await post({ orderIds: [O[2]], warehouseId: 'wA' });
    expect([r.status, r.body.code]).toEqual([403, 'WAREHOUSE_NOT_REACHED']);
    expect(S.m.data.shippingBatch).toEqual([]);
    expect((await post({ orderIds: [O[2]], warehouseId: 'wB' })).status).toBe(201);
  });

  it('the owner and a roleId-null WAREHOUSE account (no keeper rows) reach every warehouse of the country', async () => {
    await as('u-legacy-wh');
    expect((await post({ orderIds: [O[2]], warehouseId: 'wA' })).status).toBe(201);
    await as('u-owner');
    expect((await post({ orderIds: [O[0]], warehouseId: 'wB' })).status).toBe(201);
  });

  it('NEGATIVE: somebody whose country is another one does not reach this one’s warehouse', async () => {
    await as('u-abroad');
    expect((await post({ orderIds: [O[2]], warehouseId: 'wA' })).body.code).toBe('WAREHOUSE_NOT_REACHED');
  });

  it('the key is still the packing key: a personal DENY wins, a personal ALLOW gives it', async () => {
    await as('u-denied');
    expect((await post({ orderIds: [O[2]], warehouseId: 'wA' })).status).toBe(403);
    expect(S.m.data.shippingBatch).toEqual([]);
    await as('u-plus');
    expect((await post({ orderIds: [O[2]], warehouseId: 'wA' })).status).toBe(201);
  });
});

describe('the empty trolley and the preparation list', () => {
  const open = (body: Row) => openTrolley(new Request('http://x/api/shipping-batches', { method: 'POST', body: JSON.stringify({ deliveryProviderId: DP, ...body }) })).then(json);

  it('a placed store’s empty trolley names its warehouse, and is reused only for that warehouse', async () => {
    await as('u-shipper');
    expect((await open({})).body.code).toBe('WAREHOUSE_REQUIRED');
    const a = await open({ warehouseId: 'wA' });
    expect(a.body.batch.warehouseId).toBe('wA');
    const b = await open({ warehouseId: 'wB' });
    expect(b.body.batch.id).not.toBe(a.body.batch.id);
    const again = await open({ warehouseId: 'wA' });
    expect([again.body.reused, again.body.batch.id]).toEqual([true, a.body.batch.id]);
  });

  it('NEGATIVE: an unplaced store’s empty trolley is today’s', async () => {
    S.m = world(false);
    await as('u-shipper');
    const a = await open({ warehouseId: 'wA' });
    expect(a.body.batch).not.toHaveProperty('warehouseId');
  });

  it('the preparation list per warehouse: «available» is what that warehouse can give', async () => {
    await as('u-shipper');
    S.m.data.order.forEach((o) => (o.customer = { fullName: 'زبون' }));
    const inA = await json(await preparation(new Request('http://x/api/ops/preparation?warehouse=wA')));
    expect(inA.body.groups[0]).toMatchObject({ productId: 'p1', required: 5, available: 3, shortage: 2 });
    const store = await json(await preparation(new Request('http://x/api/ops/preparation')));
    // The store's shelf: 13 on hand, the three orders' own five units added back — as before.
    expect(store.body.groups[0]).toMatchObject({ required: 5, shortage: 0 });
    await as('u-keeper-b');
    expect((await json(await preparation(new Request('http://x/api/ops/preparation?warehouse=wA')))).status).toBe(403);
  });
});

describe('off the trolley, the stamp goes; the doors that put an order on a trolley keep one warehouse', () => {
  it('hold, stand-down and cancel write the «off the trolley» columns: the source warehouse is among them', () => {
    expect(leavesTheTrolley()).toMatchObject({ shippingBatchId: null, sourceWarehouseId: null });
    expect(leavesTheShipment({ fromTrolley: true })).toMatchObject({ shippingBatchId: null, sourceWarehouseId: null });
    expect(leavesTheShipment({ fromTrolley: false })).toMatchObject({ shippingBatchId: null, sourceWarehouseId: null });
  });

  it('a move onto another trolley takes that trolley’s warehouse; a move to another courier looks for the same warehouse’s trolley', () => {
    const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
    expect(src('src/app/api/orders/[id]/shipping/route.ts')).toMatch(/updateData\.sourceWarehouseId = batch\.warehouseId \?\? null/);
    expect(src('src/app/api/ops/tracking/transfer/route.ts')).toMatch(/order\.sourceWarehouseId \? \{ warehouseId: order\.sourceWarehouseId \} : \{\}/);
  });
});
