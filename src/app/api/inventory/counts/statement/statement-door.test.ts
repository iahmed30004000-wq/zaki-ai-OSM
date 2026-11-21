import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';
import type { Row } from '@/lib/stock-transfers.memory-db.test';

/**
 * «كشف عهدة الأمين» (W5b) — GET /api/inventory/counts/statement, and what W5b added to GET /api/inventory/counts/:id.
 *
 * End to end on the in-memory database: sheets are opened, counted, submitted and approved through W5a's REAL doors, the book
 * is moved between two counts by a row of the warehouse (a receipt), then the statement is read through this door. People
 * are built the way a session builds them (`computeEffectiveGrants` over role rows and personal overrides, a roleId-null
 * legacy account) and the REAL `can` decides every key — the page key, the approver's key, the cost key.
 *
 * What it pins: opening (the previous count) + net (expected − opening, from the two frozen sheets) = expected, against the
 * count; the first count of a product has no opening; a voided or a still-submitted sheet is not on the statement; another
 * store's sheets are not read; the keeper who counts blind is refused by key (it is all book figures); a warehouse she does
 * not reach is refused; without `costs.view` no cost field at all — not a zero; a bad period is refused in Arabic. And the
 * sheet door: each line names its product's active combinations (words only), `youCounted` follows the two-hands rule.
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
  const db = new Proxy({} as Row, {
    get: (_t, prop: string) => (prop in extra ? extra[prop] : (S.m.db as Row)[prop]),
  });
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
      country: { id: 'k1', timezone: 'Asia/Amman', minorUnit: 2 },
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
vi.mock('@/lib/auth', async (orig) => {
  const real = await orig<typeof import('@/lib/auth')>();
  return { ...real, requireCompanyTenant: async () => ({ user: S.current, companyId: (S.current as Row).companyId }) };
});
vi.mock('@/lib/audit', () => ({ logAudit: async () => undefined }));

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { memoryDb } from '@/lib/stock-transfers.memory-db.test';
import * as list from '../route';
import * as one from '../[id]/route';
import * as submitDoor from '../[id]/submit/route';
import * as approveDoor from '../[id]/approve/route';
import * as voidDoor from '../[id]/void/route';
import { GET as statement } from './route';
import { NextRequest } from 'next/server';

const C1 = 'c1';

async function as(id: string) {
  const u = S.m.data.user.find((x) => x.id === id)!;
  S.current = attachGrants({ ...u, permissions: [] } as unknown as SessionUser, await computeEffectiveGrants({ id: u.id, role: u.role, roleId: u.roleId ?? null }));
}
const json = async (res: Response) => ({ status: res.status, body: await res.json() });
const req = (body: unknown, method = 'POST') => new Request('http://x/api', { method, body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const open = (body: Row = {}) => list.POST(req({ warehouseId: 'wA', ...body })).then(json);
const answer = (id: string, lines: Row[]) => one.PATCH(req({ lines }, 'PATCH'), ctx(id)).then(json);
const read = (id: string) => one.GET(req(undefined, 'GET'), ctx(id)).then(json);
const submit = (id: string) => submitDoor.POST(req(undefined), ctx(id)).then(json);
const approve = (id: string) => approveDoor.POST(req(undefined), ctx(id)).then(json);
const voidIt = (id: string) => voidDoor.POST(req({ reason: 'انفتحت بالغلط' }), ctx(id)).then(json);
const ask = (q: string) => statement(new NextRequest(`http://x/api/inventory/counts/statement?${q}`)).then(json);

const batch = (id: string, over: Row = {}): Row => ({
  id, companyId: C1, storeId: 's1', productId: 'product-p1', batchNumber: id, quantityProduced: 40, quantitySold: 0, quantityRemaining: 40,
  quantityMovedIn: 0, quantityMovedOut: 0, costPerUnit: 2.5, productionDate: new Date('2026-10-01'), createdAt: new Date('2026-10-01'),
  status: 'COMPLETED', notes: null, warehouseId: 'wA', inTransitTransferId: null, splitFromBatchId: null, ...over,
});

beforeEach(() => {
  S.storeId = 's1';
  S.rolePerms = {
    'r-counter': ['inventory.view', 'inventory.count'],
    'r-approver': ['inventory.view', 'inventory.count_approve'],
    'r-approver-cost': ['inventory.view', 'inventory.count_approve', 'costs.view'],
    'r-viewer': ['inventory.view'],
    'template:WAREHOUSE': ['inventory.view', 'inventory.adjust', 'ops.prepare'],
  };
  S.overrides = { 'u-approver-denied': [{ permission: 'inventory.count_approve', effect: 'DENY' }] };
  const people = [
    ['u-counter', 'CUSTOM', 'r-counter'],
    ['u-approver', 'CUSTOM', 'r-approver'],
    ['u-approver-cost', 'CUSTOM', 'r-approver-cost'],
    ['u-approver-b', 'CUSTOM', 'r-approver'],
    ['u-approver-denied', 'CUSTOM', 'r-approver-cost'],
    ['u-viewer', 'CUSTOM', 'r-viewer'],
    ['u-legacy-wh', 'WAREHOUSE', null],
  ] as const;
  S.m = memoryDb({
    country: [{ id: 'k1', companyId: C1, isActive: true, minorUnit: 2 }],
    store: [
      { id: 's1', companyId: C1, countryId: 'k1', name: 'المتجر' },
      { id: 's2', companyId: C1, countryId: 'k1', name: 'متجر تاني' },
    ],
    user: people.map(([id, role, roleId]) => ({ id, name: id, role, roleId, status: 'ACTIVE', companyId: C1 })),
    userCountryAccess: people.map(([userId]) => ({ userId, countryId: 'k1' })),
    // The keeper of wA is the counter; an approver who keeps wB only does not reach wA.
    userWarehouseAccess: [
      { userId: 'u-counter', warehouseId: 'wA' },
      { userId: 'u-approver-b', warehouseId: 'wB' },
    ],
    warehouse: [
      { id: 'wA', companyId: C1, countryId: 'k1', name: 'أ', isActive: true },
      { id: 'wB', companyId: C1, countryId: 'k1', name: 'ب', isActive: true },
    ],
    warehousePlacement: [
      { id: 'pl1', companyId: C1, storeId: 's1' },
      { id: 'pl2', companyId: C1, storeId: 's2' },
    ],
    product: [
      { id: 'product-p1', companyId: C1, storeId: 's1', name: 'منتج ١', sku: 'SKU-1', sourceType: 'PURCHASED' },
      { id: 'product-p2', companyId: C1, storeId: 's1', name: 'منتج ٢', sku: 'SKU-2', sourceType: 'PURCHASED' },
      { id: 'product-q', companyId: C1, storeId: 's2', name: 'منتج المتجر التاني', sku: 'Q', sourceType: 'PURCHASED' },
    ],
    productVariant: [
      { id: 'v-red', companyId: C1, productId: 'product-p2', label: 'أحمر', status: 'ACTIVE', onHand: 0, sortOrder: 0 },
      { id: 'v-old', companyId: C1, productId: 'product-p2', label: 'قديم', status: 'ARCHIVED', onHand: 0, sortOrder: 1 },
    ],
    productionBatch: [batch('b1'), batch('bq', { storeId: 's2', productId: 'product-q', quantityProduced: 9, quantityRemaining: 9 })],
    // 3 units with the courier from wA: the book's 40 − 3 = 37 is what a person in wA should find.
    order: [{ id: 'o1', companyId: C1, storeId: 's1', confirmationStatus: 'CONFIRMED', labelPrintedAt: new Date('2026-11-20'), sourceWarehouseId: 'wA' }],
    orderItem: [{ id: 'i1', companyId: C1, orderId: 'o1', productId: 'product-p1', reservedQty: 3 }],
  }) as never;
});

/** One full count of product-p1 in wA: the counter opens and counts, an approver approves. */
async function counted(n: number, approver = 'u-approver-cost') {
  await as('u-counter');
  const o = await open({ productIds: ['product-p1'] });
  expect(o.status).toBe(201);
  const id = o.body.count.id as string;
  expect((await answer(id, [{ productId: 'product-p1', counted: n }])).status).toBe(200);
  expect((await submit(id)).status).toBe(200);
  await as(approver);
  expect((await approve(id)).status).toBe(200);
  return id;
}

describe('the statement: opening + what the book did = expected, against what was counted', () => {
  it('two approved counts with a receipt between them', async () => {
    // Count 1: 41 counted against 37 expected → +4 at 2.50 = 10.00. The book becomes 44, expected 41.
    const first = await counted(41);
    // Between the two counts the warehouse receives 10 (a new row in wA): expected 51.
    S.m.data.productionBatch.push(batch('b2', { quantityProduced: 10, quantityRemaining: 10, productionDate: new Date('2026-11-01'), costPerUnit: 3 }));
    // Count 2: 50 counted against 51 → −1, drawn oldest first at 2.50.
    const second = await counted(50);

    await as('u-approver-cost');
    const r = await ask('warehouseId=wA&period=all');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ warehouseName: 'أ', keepers: ['u-counter'], period: 'all', seesCost: true, truncated: false });
    // Newest first.
    expect(r.body.sheets.map((s: Row) => [s.countId, s.countedByName, s.approvedByName, s.lines, s.surplus, s.shortfall, s.valueAtCost])).toEqual([
      [second, 'u-counter', 'u-approver-cost', 1, 0, 1, -2.5],
      [first, 'u-counter', 'u-approver-cost', 1, 4, 0, 10],
    ]);
    expect(r.body.rows.map((x: Row) => [x.countId, x.opening, x.net, x.expected, x.counted, x.difference, x.valueAtCost])).toEqual([
      [second, 41, 10, 51, 50, -1, -2.5],
      [first, null, null, 37, 41, 4, 10],
    ]);
    // opening + net = expected on every row that has an opening — figures the door wrote, not ones this test made.
    for (const x of r.body.rows as Row[]) if (x.opening !== null) expect(x.opening + x.net).toBe(x.expected);
    expect(r.body.total).toEqual({ sheets: 2, surplus: 4, shortfall: 1, valueAtCost: 7.5 });
    // Each sheet is dated by the store's day.
    expect(r.body.rows[0].day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('NEGATIVE: a voided sheet and a sheet still waiting are not on it; another store’s sheets are not read', async () => {
    await as('u-counter');
    const v = await open({ productIds: ['product-p1'] });
    await answer(v.body.count.id, [{ productId: 'product-p1', counted: 1 }]);
    expect((await voidIt(v.body.count.id)).status).toBe(200);
    const done = await counted(37);
    await as('u-counter');
    const w = await open({ productIds: ['product-p1'] });
    await answer(w.body.count.id, [{ productId: 'product-p1', counted: 99 }]);
    await submit(w.body.count.id);
    // An approved sheet of the OTHER store, in the same warehouse (a warehouse may hold several stores' goods).
    S.m.data.stockCount.push({
      id: 'k-other', companyId: C1, storeId: 's2', warehouseId: 'wA', status: 'APPROVED', scope: 'ALL', note: null, writerIds: [],
      openedById: 'u-counter', openedAt: new Date(), submittedById: 'u-counter', submittedAt: new Date(), decidedById: 'u-approver', decidedAt: new Date(), voidReason: null, createdAt: new Date(),
    });
    S.m.data.stockCountLine.push({
      id: 'kl-other', countId: 'k-other', productId: 'product-q', counted: 5, countedById: 'u-counter', countedAt: new Date(), book: 9, withCourier: 0, expected: 9, unsourcedWithCourier: 0, applied: -4, valueAtCost: -10,
    });

    await as('u-approver-cost');
    const r = await ask('warehouseId=wA&period=all');
    expect(r.body.sheets.map((s: Row) => s.countId)).toEqual([done]);
    expect(r.body.rows.map((x: Row) => [x.counted, x.difference])).toEqual([[37, 0]]);
  });

  it('the period: the store’s last 30 days leave out an older count, «الكل» keeps it, and the newer row still has its opening', async () => {
    const old = await counted(41);
    // Push the first sheet back 40 days.
    const row = S.m.data.stockCount.find((c) => c.id === old)!;
    row.submittedAt = new Date(Date.now() - 40 * 86_400_000);
    row.decidedAt = row.submittedAt;
    const recent = await counted(41);
    await as('u-approver');
    const last30 = await ask('warehouseId=wA&period=30');
    expect(last30.body.sheets.map((s: Row) => s.countId)).toEqual([recent]);
    expect(last30.body.rows[0]).toMatchObject({ opening: 41, net: 0, expected: 41, counted: 41, difference: 0 });
    expect(last30.body.fromDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await ask('warehouseId=wA&period=all')).body.sheets.map((s: Row) => s.countId)).toEqual([recent, old]);
    // No period at all is the last 90 days.
    expect((await ask('warehouseId=wA')).body.period).toBe('90');
  });
});

describe('who may read it — persons built as a session builds them', () => {
  it('NEGATIVE: the keeper who counts blind, a viewer and a legacy WAREHOUSE account are refused by key; a personal DENY too', async () => {
    await counted(41);
    for (const who of ['u-counter', 'u-viewer', 'u-legacy-wh', 'u-approver-denied']) {
      await as(who);
      await expect(ask('warehouseId=wA&period=all'), who).resolves.toMatchObject({ status: 403 });
    }
  });

  it('NEGATIVE: an approver who does not reach the warehouse is refused in Arabic; an unknown warehouse is 404', async () => {
    await as('u-approver-b');
    const r = await ask('warehouseId=wA');
    expect([r.status, r.body.code]).toEqual([403, 'NOT_REACHED']);
    expect(r.body.errorAr).toMatch(/[؀-ۿ]/);
    await as('u-approver');
    expect((await ask('warehouseId=nope')).body.code).toBe('WAREHOUSE_NOT_FOUND');
    expect((await ask('')).body.code).toBe('WAREHOUSE_NOT_FOUND');
  });

  it('NEGATIVE: without the cost key no cost field at all — not a zero — on any row, sheet or the total', async () => {
    await counted(41);
    await as('u-approver');
    const r = await ask('warehouseId=wA&period=all');
    expect(r.body.seesCost).toBe(false);
    expect(JSON.stringify(r.body)).not.toMatch(/valueAtCost/);
    expect(r.body.rows[0]).toMatchObject({ expected: 37, counted: 41, difference: 4 });
  });

  it('NEGATIVE: a bad period is refused in Arabic with a stable code', async () => {
    await as('u-approver');
    const r = await ask('warehouseId=wA&period=7');
    expect([r.status, r.body.code]).toEqual([400, 'INVALID_PERIOD']);
    expect(r.body.errorAr).toMatch(/[؀-ۿ]/);
  });
});

describe('the sheet door, as the screen reads it', () => {
  it('each line names its product’s ACTIVE combinations — a word and an id, no figure; an answered one carries its label', async () => {
    await as('u-counter');
    const o = await open();
    const id = o.body.count.id;
    const r = await read(id);
    const p2 = r.body.count.lines.find((l: Row) => l.productId === 'product-p2');
    expect(p2.combinations).toEqual([{ variantId: 'v-red', label: 'أحمر' }]);
    expect(r.body.count.lines.find((l: Row) => l.productId === 'product-p1').combinations).toEqual([]);
    await answer(id, [{ productId: 'product-p2', counted: 2, variants: [{ variantId: 'v-red', quantity: 2 }] }]);
    const again = (await read(id)).body.count.lines.find((l: Row) => l.productId === 'product-p2');
    expect(again.variants).toEqual([{ variantId: 'v-red', counted: 2, label: 'أحمر' }]);
  });

  it('youCounted: true for whoever opened, counted or submitted; false for the approver — the screen hides «اعتمد» by it', async () => {
    await as('u-counter');
    const o = await open({ productIds: ['product-p1'] });
    const id = o.body.count.id;
    expect((await read(id)).body.count.youCounted).toBe(true);
    await answer(id, [{ productId: 'product-p1', counted: 41 }]);
    await submit(id);
    await as('u-approver');
    const a = await read(id);
    expect(a.body.count.youCounted).toBe(false);
    // The approver is told the difference by the server (41 − 37); the keeper is not.
    expect(a.body.count.lines[0]).toMatchObject({ expected: 37, counted: 41, difference: 4 });
    await as('u-counter');
    const k = await read(id);
    expect(JSON.stringify(k.body)).not.toMatch(/difference|expected/);
  });
});
