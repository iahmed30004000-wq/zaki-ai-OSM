import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';
import type { Row } from '@/lib/stock-transfers.memory-db.test';

/**
 * WHAT THE LIST DOOR TELLS THE SCREEN «نقل البضاعة» SO IT CAN SEND ACROSS STORES (W7c) — GET /api/inventory/transfers.
 *
 * The screen decides nothing of its own: the stores she may send to and their warehouses, whether she holds the abroad
 * key, whether the owner's press is hers to see, the currencies of the costs, and «بضاعة بالطريق» are all this answer.
 * People are built the way a session builds them (`computeEffectiveGrants` over role rows, a personal override and a
 * roleId-null legacy account), and the REAL `can` / `hasFullAccess` / store-entry rule decide.
 */

const S = vi.hoisted(() => ({
  current: null as unknown as SessionUser,
  storeId: 's1',
  m: null as unknown as { db: Record<string, unknown>; data: Record<string, Row[]> },
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
  return { ...real, requireContext: async () => ({ user: S.current, companyId: (S.current as Row).companyId, storeId: S.storeId }) };
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
vi.mock('@/lib/auth', async (orig) => {
  const real = await orig<typeof import('@/lib/auth')>();
  return { ...real, requireCompanyTenant: async () => ({ user: S.current, companyId: (S.current as Row).companyId }) };
});
vi.mock('@/lib/audit', () => ({ logAudit: async () => undefined }));
vi.mock('@/lib/notify', () => ({ afterResponse: () => undefined }));

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { memoryDb } from '@/lib/stock-transfers.memory-db.test';
import * as list from './route';
import * as approveDoor from './[id]/approve/route';
import * as receiveDoor from './[id]/receive/route';

const C1 = 'c1';

async function as(id: string, storeId = 's1') {
  const u = S.m.data.user.find((x) => x.id === id)!;
  S.current = attachGrants({ ...u, permissions: [] } as unknown as SessionUser, await computeEffectiveGrants({ id: u.id, role: u.role, roleId: u.roleId ?? null }));
  S.storeId = storeId;
}
const json = async (res: Response) => ({ status: res.status, body: await res.json() });
const req = (body: unknown) => new Request('http://x/api', { method: 'POST', body: JSON.stringify(body) });
const send = (body: Row) => list.POST(req({ fromWarehouseId: 'wA', toWarehouseId: 'wB', toStoreId: 's2', ...body })).then(json);
/*
 * 22/11 (F2): k1 keeps JOD and k2 USD, so a send to s3 is between two currencies and now needs «سعر الصرف» (the owner's
 * word of 22/11). Before: the body carried no rate. Now: it carries 1.41 — the deal under test is unchanged.
 */
const abroad = (body: Row) => send({ toWarehouseId: 'wJ', toStoreId: 's3', exchangeRate: 1.41, ...body });
const internal = (body: Row) => list.POST(req({ fromWarehouseId: 'wA', toWarehouseId: 'wB', ...body })).then(json);
const listOf = () => list.GET().then(json).then((r) => r.body);

beforeEach(() => {
  S.storeId = 's1';
  S.rolePerms = {
    'r-sender': ['inventory.view', 'inventory.transfer'],
    'r-abroad': ['inventory.view', 'inventory.transfer', 'inventory.transfer_abroad'],
    'r-everything': [
      'inventory.view',
      'inventory.adjust',
      'inventory.transfer',
      'inventory.transfer_receive',
      'inventory.difference_approve',
      'inventory.transfer_abroad',
      'costs.view',
    ],
    'r-viewer': ['inventory.view'],
    'r-books': ['inventory.view', 'costs.view'],
    'r-receiver-cost': ['inventory.view', 'inventory.transfer_receive', 'costs.view'],
    'template:WAREHOUSE': ['inventory.view', 'inventory.adjust', 'ops.prepare'],
  };
  S.overrides = { 'u-plus-abroad': [{ permission: 'inventory.transfer_abroad', effect: 'ALLOW' }] };
  const people = [
    ['u-owner', 'SUPER_ADMIN', null],
    ['u-sender', 'CUSTOM', 'r-sender'],
    ['u-abroad', 'CUSTOM', 'r-abroad'],
    ['u-plus-abroad', 'CUSTOM', 'r-sender'],
    ['u-everything', 'CUSTOM', 'r-everything'],
    ['u-viewer', 'CUSTOM', 'r-viewer'],
    ['u-books', 'CUSTOM', 'r-books'],
    ['u-receiver-cost', 'CUSTOM', 'r-receiver-cost'],
    ['u-legacy-wh', 'WAREHOUSE', null],
    ['u-confined', 'CUSTOM', 'r-sender'],
  ] as const;
  S.m = memoryDb({
    country: [
      { id: 'k1', companyId: C1, isActive: true, minorUnit: 3, name: 'البلد الأول', currencyCode: 'JOD' },
      { id: 'k2', companyId: C1, isActive: true, minorUnit: 2, name: 'البلد التاني', currencyCode: 'USD' },
    ],
    store: [
      { id: 's1', companyId: C1, countryId: 'k1', name: 'المتجر' },
      { id: 's2', companyId: C1, countryId: 'k1', name: 'متجر تاني' },
      { id: 's3', companyId: C1, countryId: 'k2', name: 'متجر البلد التاني' },
    ],
    user: people.map(([id, role, roleId]) => ({ id, name: id, role, roleId, status: 'ACTIVE', companyId: C1 })),
    userCountryAccess: people.filter(([id]) => id !== 'u-owner').flatMap(([userId]) => [{ userId, countryId: 'k1' }, { userId, countryId: 'k2' }]),
    // Confined to the one store she stands in: she reaches no other.
    userStoreAccess: [{ userId: 'u-confined', storeId: 's1' }],
    warehouse: [
      { id: 'wA', companyId: C1, countryId: 'k1', name: 'أ', isActive: true },
      { id: 'wB', companyId: C1, countryId: 'k1', name: 'ب', isActive: true },
      { id: 'wJ', companyId: C1, countryId: 'k2', name: 'ج', isActive: true },
      { id: 'wStopped', companyId: C1, countryId: 'k2', name: 'موقوف', isActive: false },
    ],
    warehousePlacement: [
      { id: 'pl1', companyId: C1, storeId: 's1' },
      { id: 'pl2', companyId: C1, storeId: 's2' },
      { id: 'pl3', companyId: C1, storeId: 's3' },
    ],
    product: [
      { id: 'p1', companyId: C1, storeId: 's1', name: 'منتج ١' },
      { id: 'q1', companyId: C1, storeId: 's2', name: 'توأم ٢' },
      { id: 'r1', companyId: C1, storeId: 's3', name: 'توأم ٣' },
    ],
    productPair: [
      { id: 'pr1', companyId: C1, productAId: 'p1', storeAId: 's1', productBId: 'q1', storeBId: 's2', hint: 'SKU', createdById: 'u-sender' },
      { id: 'pr2', companyId: C1, productAId: 'p1', storeAId: 's1', productBId: 'r1', storeBId: 's3', hint: null, createdById: 'u-sender' },
    ],
    productionBatch: [
      {
        id: 'b1', companyId: C1, storeId: 's1', productId: 'p1', batchNumber: 'RCV-1', quantityProduced: 10, quantitySold: 0, quantityRemaining: 10,
        quantityMovedIn: 0, quantityMovedOut: 0, costPerUnit: 2, totalProductionCost: 20, productionDate: new Date('2026-10-01'), createdAt: new Date('2026-10-01'),
        status: 'COMPLETED', notes: null, warehouseId: 'wA', inTransitTransferId: null, splitFromBatchId: null,
      },
    ],
  }) as never;
});

describe('the destination picker', () => {
  it('a sender is told where she stands, the other stores she reaches, and each with its country’s RUNNING warehouses', async () => {
    await as('u-sender');
    const b = await listOf();
    expect(b.here).toEqual({ id: 's1', name: 'المتجر', countryId: 'k1', countryName: 'البلد الأول' });
    // In the order of their names (the store-entry rule's own order); the stopped warehouse is not offered.
    // 22/11 (F2): s3 keeps USD and this store JOD — its entry now names the two currencies (`rate`), so the form asks the
    // rate; s2 keeps JOD like this store and answers exactly what it answered. Before: no `rate` key on s3.
    expect(b.destinations).toEqual([
      {
        storeId: 's3',
        storeName: 'متجر البلد التاني',
        countryId: 'k2',
        countryName: 'البلد التاني',
        warehouses: [{ id: 'wJ', name: 'ج', countryId: 'k2' }],
        rate: { fromCode: 'JOD', toCode: 'USD' },
      },
      { storeId: 's2', storeName: 'متجر تاني', countryId: 'k1', countryName: 'البلد الأول', warehouses: [{ id: 'wA', name: 'أ', countryId: 'k1' }, { id: 'wB', name: 'ب', countryId: 'k1' }] },
    ]);
  });

  it('NEGATIVE: a viewer without the send key, a legacy keeper, and a person confined to this store get no destinations', async () => {
    for (const who of ['u-viewer', 'u-legacy-wh', 'u-confined']) {
      await as(who);
      expect((await listOf()).destinations, who).toEqual([]);
    }
  });

  it('the abroad key as a session computes it: a role, a personal ALLOW, the owner — and NEGATIVE: the send key alone', async () => {
    for (const [who, yes] of [['u-abroad', true], ['u-plus-abroad', true], ['u-owner', true], ['u-sender', false], ['u-legacy-wh', false]] as const) {
      await as(who);
      expect((await listOf()).mayAbroad, who).toBe(yes);
    }
  });
});

describe('the owner’s press is offered by the door', () => {
  it('only to the owner, only on a request waiting for him — NEGATIVE: a person holding every key, the abroad key included, is not offered it', async () => {
    await as('u-abroad');
    await abroad({ lines: [{ productId: 'p1', quantity: 2 }] });
    for (const [who, yes] of [['u-owner', true], ['u-everything', false], ['u-abroad', false]] as const) {
      await as(who);
      const row = (await listOf()).transfers[0];
      expect([row.status, row.mayApprove], who).toEqual(['AWAITING_APPROVAL', yes]);
    }
    await as('u-owner');
    const id = (await listOf()).transfers[0].id;
    await approveDoor.POST(req({}), { params: Promise.resolve({ id }) });
    // Pressed: SENT, and nobody is offered it again.
    expect((await listOf()).transfers[0]).toMatchObject({ status: 'SENT', mayApprove: false });
  });

  it('NEGATIVE: an INTERNAL row carries no press and no currency — it answers what it always answered', async () => {
    await as('u-sender');
    await internal({ lines: [{ productId: 'p1', quantity: 1 }] });
    await as('u-owner');
    const row = (await listOf()).transfers[0];
    expect(row.kind).toBe('INTERNAL');
    for (const k of ['mayApprove', 'fromCurrency', 'toCurrency', 'fromStoreName', 'toStoreName']) expect(row, k).not.toHaveProperty(k);
  });

  it('the currencies of an across row go only to the cost key: NEGATIVE without it', async () => {
    await as('u-sender');
    await send({ lines: [{ productId: 'p1', quantity: 1 }] });
    await as('u-books');
    const row = (await listOf()).transfers.find((t: Row) => t.kind === 'BETWEEN_STORES');
    expect([row.fromCurrency, row.toCurrency]).toEqual([{ code: 'JOD', minorUnit: 3 }, { code: 'JOD', minorUnit: 3 }]);
    await as('u-viewer');
    const plain = (await listOf()).transfers.find((t: Row) => t.kind === 'BETWEEN_STORES');
    expect(plain).not.toHaveProperty('fromCurrency');
    expect(plain).not.toHaveProperty('toCurrency');
  });
});

describe('«بضاعة بالطريق»', () => {
  it('counts what is on the road; the value of what left across stores goes to the cost key in the source’s currency', async () => {
    await as('u-sender');
    await send({ lines: [{ productId: 'p1', quantity: 3 }] }); // 3 units at 2 = 6 left s1
    await internal({ lines: [{ productId: 'p1', quantity: 1 }] });
    await as('u-books');
    expect((await listOf()).road).toEqual({
      onTheRoad: 2,
      internal: 1,
      across: 1,
      totals: [{ storeId: 's1', storeName: 'المتجر', currency: { code: 'JOD', minorUnit: 3 }, transfers: 1, cost: 6 }],
      heldBack: 0,
    });
  });

  it('the destination store sees what is coming to it too', async () => {
    await as('u-sender');
    await send({ lines: [{ productId: 'p1', quantity: 3 }] });
    await as('u-books', 's2');
    expect((await listOf()).road).toMatchObject({ onTheRoad: 1, across: 1, totals: [{ storeId: 's1', cost: 6 }] });
  });

  it('NEGATIVE: no cost key — counts only (totals null); a cost holder who may receive it — held back, never its value', async () => {
    await as('u-sender');
    await send({ lines: [{ productId: 'p1', quantity: 3 }] });
    await as('u-viewer');
    expect((await listOf()).road).toEqual({ onTheRoad: 1, internal: 0, across: 1, totals: null, heldBack: 0 });
    for (const who of ['u-receiver-cost', 'u-everything']) {
      await as(who, 's2');
      const road = (await listOf()).road;
      expect([road.totals, road.heldBack], who).toEqual([[], 1]);
    }
  });

  it('NEGATIVE: a request waiting for the owner is not on the road — nothing has left', async () => {
    await as('u-abroad');
    await abroad({ lines: [{ productId: 'p1', quantity: 2 }] });
    await as('u-books');
    expect((await listOf()).road).toMatchObject({ onTheRoad: 0, across: 0, totals: [] });
  });
});

/* ═════════════════════ 22/11 (F2): «سعر الصرف» through the doors (k1 = JOD, k2 = USD) ═════════════════════ */

describe('F2 — the exchange rate at the doors', () => {
  const noRate = (body: Row) => send({ toWarehouseId: 'wJ', toStoreId: 's3', ...body });
  const receiveAt = (id: string, lines: Row[]) =>
    receiveDoor.POST(new Request('http://x/api', { method: 'POST', body: JSON.stringify({ lines }) }), { params: Promise.resolve({ id }) }).then(json);

  it('NEGATIVE: between two currencies the send is refused without a rate, at zero, below zero, above the bound — each in Arabic with its code', async () => {
    await as('u-abroad');
    for (const [rate, code] of [
      [undefined, 'RATE_MISSING'],
      [null, 'RATE_MISSING'],
      [0, 'RATE_INVALID'],
      [-1.41, 'RATE_INVALID'],
      [1_000_001, 'RATE_TOO_BIG'],
    ] as const) {
      const r = await noRate({ lines: [{ productId: 'p1', quantity: 2 }], ...(rate !== undefined ? { exchangeRate: rate } : {}) });
      expect([r.status, r.body.code], String(rate)).toEqual([400, code]);
      expect(r.body.errorAr).toMatch(/سعر الصرف/);
    }
    // A rate that is not a number is refused by the schema, in Arabic too.
    const text = await noRate({ lines: [{ productId: 'p1', quantity: 2 }], exchangeRate: '1.41' });
    expect([text.status, text.body.code]).toEqual([400, 'INVALID']);
    expect(text.body.errorAr).toMatch(/سعر الصرف/);
    expect(S.m.data.stockTransfer).toEqual([]);
  });

  it('NEGATIVE: one currency (s1 → s2, both JOD) refuses a rate; without one it is written with no rate key at all', async () => {
    await as('u-sender');
    expect((await send({ lines: [{ productId: 'p1', quantity: 1 }], exchangeRate: 1 })).body.code).toBe('RATE_NOT_HERE');
    expect((await internal({ lines: [{ productId: 'p1', quantity: 1 }], exchangeRate: 1 })).body.code).toBe('RATE_NOT_HERE');
    const ok = await send({ lines: [{ productId: 'p1', quantity: 1 }] });
    expect(ok.status).toBe(201);
    expect(ok.body.transfer).not.toHaveProperty('exchangeRate');
    expect(S.m.data.stockTransfer[0]).not.toHaveProperty('exchangeRate');
    await as('u-books');
    const row = (await listOf()).transfers[0];
    expect(row).not.toHaveProperty('exchange');
    expect(row).not.toHaveProperty('exchangeRate');
  });

  it('send → owner → receipt: the rate is stored, shown to every viewer, converted ONCE at the receipt; the ledger says the rate and no cost figure', async () => {
    await as('u-abroad');
    const sent = await abroad({ lines: [{ productId: 'p1', quantity: 2 }] });
    expect([sent.status, sent.body.transfer.exchangeRate]).toEqual([201, 1.41]);
    await as('u-owner');
    const id = (await listOf()).transfers[0].id;
    await approveDoor.POST(req({}), { params: Promise.resolve({ id }) });
    // Every viewer sees the rate and the two currencies (a viewer without the cost key included) — never a cost.
    await as('u-viewer', 's3');
    const seen = (await listOf()).transfers[0];
    expect(seen.exchange).toEqual({ rate: 1.41, from: { code: 'JOD', minorUnit: 3 }, to: { code: 'USD', minorUnit: 2 } });
    expect(seen.lines[0]).not.toHaveProperty('costOut');
    // Received by a cost holder standing in s3: 2 units that left at 2 JOD (costOut 4 JOD) + 0.5 JOD landed.
    await as('u-receiver-cost', 's3');
    const got = await receiveAt(id, [{ productId: 'p1', quantity: 2, costs: [{ kind: 'TRANSPORT', amount: 0.5 }] }]);
    expect(got.status).toBe(200);
    // By hand: (4 + 0.5) JOD × 1.41 = 6.345 USD; ÷ 2 = 3.1725 → 3.17 (USD, two decimals); remainder 6.345 − 6.34 = 0.005.
    const line = got.body.transfer.lines[0];
    expect(line.unitCostIn).toBe(3.17);
    expect(line.costRemainder).toBeCloseTo(0.005, 12);
    expect(line.converted.rate).toBe(1.41);
    expect(line.converted.sourceTotal).toBeCloseTo(4.5, 12);
    expect(line.converted.total).toBeCloseTo(6.345, 12);
    const batch = S.m.data.productionBatch.find((b) => b.productId === 'r1')!;
    expect([batch.quantityRemaining, batch.costPerUnit, batch.warehouseId]).toEqual([2, 3.17, 'wJ']);
    const into = S.m.data.inventoryMovement.find((x) => x.type === 'TRANSFER_IN' && x.productId === 'r1')!;
    expect(into.reason).toContain('بسعر صرف 1.41: 1 JOD = 1.41 USD');
    for (const figure of ['4.5', '6.345', '3.17', '0.5 ']) expect(into.reason, figure).not.toContain(figure);
    // NEGATIVE: the converted figures go only to the cost key.
    await as('u-viewer', 's3');
    expect((await listOf()).transfers[0].lines[0]).not.toHaveProperty('converted');
  });
});
