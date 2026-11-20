import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';
import type { Row } from '@/lib/stock-transfers.memory-db.test';

/**
 * THE COUNT-SHEET DOORS (W5a) — GET/POST /api/inventory/counts, GET/PATCH /:id, POST /:id/submit, /:id/approve, /:id/void.
 *
 * People are built the way a session builds them: `computeEffectiveGrants` over role rows, personal overrides (ALLOW and
 * DENY) and a roleId-null legacy account (the system template it inherits), and the REAL `can` decides every key —
 * including the blind rule: a holder of `inventory.count` without `inventory.count_approve` is never answered a book
 * figure. Reach is the real `reachesWarehouse` over the country and keeper rows of the in-memory database.
 */

const S = vi.hoisted(() => ({
  current: null as unknown as SessionUser,
  storeId: 's1',
  m: null as unknown as { db: Record<string, unknown>; data: Record<string, Row[]> },
  rolePerms: {} as Record<string, string[]>,
  overrides: {} as Record<string, { permission: string; effect: 'ALLOW' | 'DENY' }[]>,
  audit: [] as Row[],
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
vi.mock('@/lib/audit', () => ({ logAudit: async (e: Row) => void S.audit.push(e) }));

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { memoryDb } from '@/lib/stock-transfers.memory-db.test';
import * as list from './route';
import * as one from './[id]/route';
import * as submitDoor from './[id]/submit/route';
import * as approveDoor from './[id]/approve/route';
import * as voidDoor from './[id]/void/route';
import { PATCH as stopDoor } from '@/app/api/geo/warehouses/[id]/route';
import { POST as receiveDoor } from '@/app/api/inventory/route';

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

/** The fields that say — or let one work out — what the book holds. */
const BOOK_KEYS = ['book', 'withCourier', 'expected', 'unsourcedWithCourier', 'applied', 'valueAtCost', 'difference', 'onShelf'];
/** Every key and every number anywhere in a JSON answer. */
function walk(v: unknown, keys: string[] = [], nums: number[] = []) {
  if (Array.isArray(v)) v.forEach((x) => walk(x, keys, nums));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x, keys, nums); }
  else if (typeof v === 'number') nums.push(v);
  return { keys, nums };
}

beforeEach(() => {
  S.audit = [];
  S.storeId = 's1';
  S.rolePerms = {
    'r-counter': ['inventory.view', 'inventory.count'],
    'r-approver': ['inventory.view', 'inventory.count_approve'],
    'r-approver-cost': ['inventory.view', 'inventory.count_approve', 'costs.view'],
    'r-both': ['inventory.view', 'inventory.count', 'inventory.count_approve'],
    'r-viewer': ['inventory.view'],
    'r-adjust': ['inventory.view', 'inventory.adjust', 'inventory.transfer', 'inventory.exit', 'inventory.exit_approve', 'inventory.difference_approve'],
    // The system template a roleId-null WAREHOUSE account inherits: today's keeper keys, none of the two new ones.
    'template:WAREHOUSE': ['inventory.view', 'inventory.adjust', 'ops.prepare'],
  };
  S.overrides = {
    'u-both-denied': [{ permission: 'inventory.count_approve', effect: 'DENY' }],
    'u-plus': [{ permission: 'inventory.count', effect: 'ALLOW' }],
  };
  const people = [
    ['u-owner', 'SUPER_ADMIN', null],
    ['u-counter', 'CUSTOM', 'r-counter'],
    ['u-counter-2', 'CUSTOM', 'r-counter'],
    ['u-approver', 'CUSTOM', 'r-approver'],
    ['u-approver-cost', 'CUSTOM', 'r-approver-cost'],
    ['u-approver-b', 'CUSTOM', 'r-approver'],
    ['u-both', 'CUSTOM', 'r-both'],
    ['u-both-denied', 'CUSTOM', 'r-both'],
    ['u-viewer', 'CUSTOM', 'r-viewer'],
    ['u-adjust', 'CUSTOM', 'r-adjust'],
    ['u-plus', 'CUSTOM', 'r-viewer'],
    ['u-legacy-wh', 'WAREHOUSE', null],
  ] as const;
  S.m = memoryDb({
    country: [{ id: 'k1', companyId: C1, isActive: true, minorUnit: 2 }],
    store: [{ id: 's1', companyId: C1, countryId: 'k1', name: 'المتجر' }],
    user: people.map(([id, role, roleId]) => ({ id, name: id, role, roleId, status: 'ACTIVE', companyId: C1 })),
    userCountryAccess: people.filter(([id]) => id !== 'u-owner').map(([userId]) => ({ userId, countryId: 'k1' })),
    // An approver who keeps wB only: she does not reach wA.
    userWarehouseAccess: [{ userId: 'u-approver-b', warehouseId: 'wB' }],
    warehouse: [
      { id: 'wA', companyId: C1, countryId: 'k1', name: 'أ', isActive: true },
      { id: 'wB', companyId: C1, countryId: 'k1', name: 'ب', isActive: true },
    ],
    warehousePlacement: [{ id: 'pl1', companyId: C1, storeId: 's1' }],
    product: [{ id: 'product-p1', companyId: C1, storeId: 's1', name: 'منتج ١', sku: 'SKU-1', sourceType: 'PURCHASED' }],
    productionBatch: [
      {
        id: 'b1', companyId: C1, storeId: 's1', productId: 'product-p1', batchNumber: 'RCV-1', quantityProduced: 40, quantitySold: 0, quantityRemaining: 40,
        quantityMovedIn: 0, quantityMovedOut: 0, costPerUnit: 2.5, productionDate: new Date('2026-10-01'), createdAt: new Date('2026-10-01'),
        status: 'COMPLETED', notes: null, warehouseId: 'wA', inTransitTransferId: null, splitFromBatchId: null,
      },
    ],
    // 3 units with the courier from wA: what a person in wA should find is 40 − 3 = 37.
    order: [{ id: 'o1', companyId: C1, storeId: 's1', confirmationStatus: 'CONFIRMED', labelPrintedAt: new Date('2026-11-20'), sourceWarehouseId: 'wA' }],
    orderItem: [{ id: 'i1', companyId: C1, orderId: 'o1', productId: 'product-p1', reservedQty: 3 }],
  }) as never;
});

/** The counter opens, counts 41 (the book says 37) and submits. */
async function countedAndSubmitted(by = 'u-counter') {
  await as(by);
  const o = await open();
  expect(o.status).toBe(201);
  const id = o.body.count.id as string;
  expect((await answer(id, [{ productId: 'product-p1', counted: 41 }])).status).toBe(200);
  const s = await submit(id);
  expect(s.status).toBe(200);
  return { id, submitAnswer: s };
}

describe('BLIND: the JSON a counter receives carries no expected number — by any door of the sheet', () => {
  it('open, answer, submit, read one, the list — and after the approval too', async () => {
    const answers: unknown[] = [];
    await as('u-counter');
    const o = await open();
    answers.push(o.body);
    const id = o.body.count.id;
    answers.push((await answer(id, [{ productId: 'product-p1', counted: 41 }])).body);
    answers.push((await submit(id)).body);
    answers.push((await read(id)).body);
    answers.push((await list.GET().then(json)).body);
    await as('u-approver-cost');
    const approved = await approve(id);
    expect(approved.status).toBe(200);
    // The approver IS told: expected 37, the difference +4 worth 10.00.
    expect(approved.body.count.lines[0]).toMatchObject({ counted: 41, expected: 37, book: 40, withCourier: 3, applied: 4, valueAtCost: 10 });
    await as('u-counter');
    answers.push((await read(id)).body);
    answers.push((await list.GET().then(json)).body);
    for (const a of answers) {
      const { keys, nums } = walk(a);
      for (const k of BOOK_KEYS) expect(keys, `«${k}» reached the counter`).not.toContain(k);
      // Nor any of those figures under another name: 37 (expected), 40 (book), 4 (difference), 10 (value).
      for (const n of [37, 40, 4, 10]) expect(nums, `${n} reached the counter`).not.toContain(n);
    }
    // What she did count does reach her.
    expect((await read(id)).body.count.lines[0]).toMatchObject({ productId: 'product-p1', counted: 41, productName: 'منتج ١' });
  });

  it('the same person with the approver’s key too sees the frozen figure; a personal DENY of it makes her blind again', async () => {
    await as('u-both');
    const o = await open();
    await answer(o.body.count.id, [{ productId: 'product-p1', counted: 41 }]);
    expect((await submit(o.body.count.id)).body.count.lines[0].expected).toBe(37);
    await as('u-both-denied');
    const r = await read(o.body.count.id);
    expect(walk(r.body).keys).not.toContain('expected');
  });
});

describe('who may press which door — persons built as a session builds them', () => {
  it('nobody holds the two keys by a migration: a legacy WAREHOUSE account, an «adjust + transfer + exit» role and a viewer cannot open', async () => {
    for (const who of ['u-legacy-wh', 'u-adjust', 'u-viewer']) {
      await as(who);
      expect((await open()).status, who).toBe(403);
    }
    expect(S.m.data.stockCount).toEqual([]);
  });

  it('a personal ALLOW gives the count key; the owner’s full access holds both', async () => {
    const { id } = await countedAndSubmitted('u-plus');
    await as('u-owner');
    expect((await approve(id)).status).toBe(200);
  });

  it('TWO HANDS by the door: the counter (even holding both keys) cannot approve her own sheet; a counter without the key is refused by key', async () => {
    const { id } = await countedAndSubmitted('u-both');
    expect((await approve(id)).body.code).toBe('COUNTER_CANNOT_APPROVE');
    await as('u-counter');
    expect((await approve(id)).status).toBe(403);
    await as('u-approver-b');
    // She holds the key but does not reach wA.
    expect((await approve(id)).body.code).toBe('NOT_REACHED');
    expect(S.m.data.inventoryMovement).toEqual([]);
    await as('u-approver');
    const ok = await approve(id);
    expect([ok.status, ok.body.count.status]).toEqual([200, 'APPROVED']);
    // Without the cost key the approver sees the difference but not its value.
    expect(ok.body.count.lines[0]).toMatchObject({ expected: 37, applied: 4 });
    expect('valueAtCost' in ok.body.count.lines[0]).toBe(false);
    // The ledger: one adjustment of +4 in wA carrying the sheet's id.
    expect(S.m.data.inventoryMovement.map((x) => [x.type, x.quantity, x.warehouseId, x.referenceId])).toEqual([['MANUAL_ADJUSTMENT', 4, 'wA', id]]);
  });

  it('a viewer reads the list and a sheet, blind; she cannot answer, submit or void', async () => {
    const { id } = await countedAndSubmitted();
    await as('u-viewer');
    expect((await list.GET().then(json)).body.counts[0]).toMatchObject({ id, status: 'SUBMITTED', statusAr: 'مستني اعتماد', warehouseName: 'أ', lineCount: 1 });
    expect(walk((await read(id)).body).keys).not.toContain('expected');
    expect((await answer(id, [{ productId: 'product-p1', counted: 1 }])).status).toBe(403);
    expect((await submit(id)).status).toBe(403);
    expect((await voidIt(id)).status).toBe(403);
  });

  it('void: the opener while counting; the approver once submitted; a voided sheet wrote nothing', async () => {
    await as('u-counter');
    const a = await open();
    await as('u-counter-2');
    expect((await voidIt(a.body.count.id)).body.code).toBe('VOID_NOT_YOURS');
    await as('u-counter');
    expect((await voidIt(a.body.count.id)).body.count.status).toBe('VOIDED');
    const { id } = await countedAndSubmitted();
    expect((await voidIt(id)).body.code).toBe('VOID_NOT_YOURS');
    await as('u-approver');
    expect((await voidIt(id)).body.count.status).toBe('VOIDED');
    expect(S.m.data.productionBatch.map((b) => b.quantityRemaining)).toEqual([40]);
    expect(S.m.data.inventoryMovement).toEqual([]);
  });
});

describe('the warehouse stands still while a sheet is open — by the doors', () => {
  it('the receive door answers 409 «في جرد مفتوح»; the stop door refuses with the open count named', async () => {
    await countedAndSubmitted();
    await as('u-owner');
    const r = await json(await receiveDoor(req({ action: 'receive', productId: 'product-p1', quantity: 2, unitCost: 2.5, warehouseId: 'wA' })));
    expect([r.status, r.body.code]).toEqual([409, 'WAREHOUSE_COUNTING']);
    expect(r.body.errorAr).toMatch(/جرد مفتوح/);
    const stop = await json(await stopDoor(req({ isActive: false }, 'PATCH'), ctx('wA')));
    expect(stop.status).toBe(409);
    expect(JSON.stringify(stop.body)).toMatch(/ورقة جرد مفتوحة/);
  });

  it('NEGATIVE: a second sheet on the same warehouse is refused while one is open', async () => {
    await countedAndSubmitted();
    await as('u-counter-2');
    const again = await open();
    expect([again.status, again.body.code]).toEqual([409, 'COUNT_ALREADY_OPEN']);
  });

  it('every refusal is Arabic with a stable code', async () => {
    await as('u-counter');
    const bad = await open({ warehouseId: '' });
    expect([bad.status, bad.body.code]).toEqual([400, 'INVALID']);
    expect(bad.body.errorAr).toMatch(/[؀-ۿ]/);
    const o = await open();
    const incomplete = await submit(o.body.count.id);
    expect([incomplete.status, incomplete.body.code]).toEqual([409, 'INCOMPLETE']);
    expect(incomplete.body.errorAr).toMatch(/[؀-ۿ]/);
  });
});
