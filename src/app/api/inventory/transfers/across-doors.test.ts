import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';
import type { Row } from '@/lib/stock-transfers.memory-db.test';

/**
 * THE TRANSFER DOORS ACROSS STORES AND COUNTRIES (W7b) — POST/GET /api/inventory/transfers, /:id/approve, /:id/receive.
 *
 * People are built the way a session builds them: `computeEffectiveGrants` over role rows, personal overrides and a
 * roleId-null legacy account (the system template it inherits), and the REAL `can` / `hasFullAccess` decide every key
 * and the owner's press. Reach is the real `reachesWarehouse` and the real store-entry rule (`storesReachedBy`) over the
 * rows of the in-memory database, which has no money table at all.
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
// The notice after the owner's press runs after the answer; here it is not the subject.
vi.mock('@/lib/notify', () => ({ afterResponse: () => undefined }));

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { memoryDb } from '@/lib/stock-transfers.memory-db.test';
import * as list from './route';
import * as approveDoor from './[id]/approve/route';
import * as receiveDoor from './[id]/receive/route';

const C1 = 'c1';
let seq = 0;
const uuid = () => `00000000-0000-4000-9100-${String(++seq).padStart(12, '0')}`;

async function as(id: string, storeId = 's1') {
  const u = S.m.data.user.find((x) => x.id === id)!;
  S.current = attachGrants({ ...u, permissions: [] } as unknown as SessionUser, await computeEffectiveGrants({ id: u.id, role: u.role, roleId: u.roleId ?? null }));
  S.storeId = storeId;
}
const json = async (res: Response) => ({ status: res.status, body: await res.json() });
const req = (body: unknown) => new Request('http://x/api', { method: 'POST', body: JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const send = (body: Row) => list.POST(req({ fromWarehouseId: 'wA', toWarehouseId: 'wB', toStoreId: 's2', ...body })).then(json);
const abroad = (body: Row) => send({ toWarehouseId: 'wJ', toStoreId: 's3', ...body });
const approve = (id: string) => approveDoor.POST(req({}), ctx(id)).then(json);
const receive = (id: string, lines: Row[]) => receiveDoor.POST(req({ lines }), ctx(id)).then(json);
const listOf = () => list.GET().then(json);

beforeEach(() => {
  S.audit = [];
  S.storeId = 's1';
  S.rolePerms = {
    'r-sender': ['inventory.view', 'inventory.transfer'],
    'r-abroad': ['inventory.view', 'inventory.transfer', 'inventory.transfer_abroad'],
    // Every inventory key there is, the abroad key and the cost key included — still not the owner.
    'r-everything': [
      'inventory.view',
      'inventory.adjust',
      'inventory.transfer',
      'inventory.transfer_receive',
      'inventory.difference_approve',
      'inventory.transfer_abroad',
      'costs.view',
    ],
    'r-receiver': ['inventory.view', 'inventory.transfer_receive'],
    'r-receiver-cost': ['inventory.view', 'inventory.transfer_receive', 'costs.view'],
    // The system template a roleId-null WAREHOUSE account inherits: today's keeper keys, not the abroad key.
    'template:WAREHOUSE': ['inventory.view', 'inventory.adjust', 'ops.prepare'],
  };
  S.overrides = { 'u-plus-abroad': [{ permission: 'inventory.transfer_abroad', effect: 'ALLOW' }] };
  const people = [
    ['u-owner', 'SUPER_ADMIN', null],
    ['u-sender', 'CUSTOM', 'r-sender'],
    ['u-abroad', 'CUSTOM', 'r-abroad'],
    ['u-everything', 'CUSTOM', 'r-everything'],
    ['u-receiver', 'CUSTOM', 'r-receiver'],
    ['u-receiver-cost', 'CUSTOM', 'r-receiver-cost'],
    ['u-plus-abroad', 'CUSTOM', 'r-sender'],
    ['u-legacy-wh', 'WAREHOUSE', null],
  ] as const;
  S.m = memoryDb({
    country: [
      { id: 'k1', companyId: C1, isActive: true, minorUnit: 3 },
      { id: 'k2', companyId: C1, isActive: true, minorUnit: 2 },
    ],
    store: [
      { id: 's1', companyId: C1, countryId: 'k1', name: 'المتجر' },
      { id: 's2', companyId: C1, countryId: 'k1', name: 'متجر تاني' },
      { id: 's3', companyId: C1, countryId: 'k2', name: 'متجر البلد التاني' },
    ],
    user: people.map(([id, role, roleId]) => ({ id, name: id, role, roleId, status: 'ACTIVE', companyId: C1 })),
    userCountryAccess: people.filter(([id]) => id !== 'u-owner').flatMap(([userId]) => [{ userId, countryId: 'k1' }, { userId, countryId: 'k2' }]),
    warehouse: [
      { id: 'wA', companyId: C1, countryId: 'k1', name: 'أ', isActive: true },
      { id: 'wB', companyId: C1, countryId: 'k1', name: 'ب', isActive: true },
      { id: 'wJ', companyId: C1, countryId: 'k2', name: 'ج', isActive: true },
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

describe('the abroad key — persons built as a session builds them', () => {
  it('NEGATIVE: the send key alone does not send abroad; a legacy keeper does not even send (no migration grants either)', async () => {
    await as('u-sender');
    const r = await abroad({ lines: [{ productId: 'p1', quantity: 1 }] });
    expect([r.status, r.body.code]).toEqual([403, 'ABROAD_KEY_MISSING']);
    expect(r.body.errorAr).toMatch(/[؀-ۿ]/);
    await as('u-legacy-wh');
    expect((await abroad({ lines: [{ productId: 'p1', quantity: 1 }] })).status).toBe(403);
    expect(S.m.data.stockTransfer).toEqual([]);
  });

  it('a role with the key, or a personal ALLOW, writes the request AWAITING the owner — nothing moves', async () => {
    for (const who of ['u-abroad', 'u-plus-abroad']) {
      await as(who);
      const r = await abroad({ lines: [{ productId: 'p1', quantity: 1 }] });
      expect([r.status, r.body.transfer.status, r.body.transfer.statusAr], who).toEqual([201, 'AWAITING_APPROVAL', 'مستني اعتماد المالك']);
    }
    expect(S.m.data.inventoryMovement).toEqual([]);
    expect(S.m.data.productionBatch[0].quantityRemaining).toBe(10);
  });

  it('another store of ONE country needs no abroad key and no press: it leaves at once', async () => {
    await as('u-sender');
    const r = await send({ lines: [{ productId: 'p1', quantity: 3 }] });
    expect([r.status, r.body.transfer.status, r.body.transfer.kind]).toEqual([201, 'SENT', 'BETWEEN_STORES']);
    expect(S.m.data.productionBatch[0].quantityRemaining).toBe(7);
  });
});

describe('the owner’s press', () => {
  it('NEGATIVE: a person holding EVERY inventory key, the abroad key included, is not the owner — 403 OWNER_ONLY', async () => {
    await as('u-abroad');
    const { body } = await abroad({ lines: [{ productId: 'p1', quantity: 4 }] });
    await as('u-everything');
    const r = await approve(body.transfer.id);
    expect([r.status, r.body.code]).toEqual([403, 'OWNER_ONLY']);
    expect(S.m.data.stockTransfer[0].status).toBe('AWAITING_APPROVAL');
  });

  it('NEGATIVE: without the abroad key the door is not opened at all', async () => {
    await as('u-abroad');
    const { body } = await abroad({ lines: [{ productId: 'p1', quantity: 4 }] });
    await as('u-receiver');
    expect((await approve(body.transfer.id)).status).toBe(403);
  });

  it('the owner presses: SENT, the units leave, one audit line; his second press is a replay with no second line', async () => {
    await as('u-abroad');
    const { body } = await abroad({ lines: [{ productId: 'p1', quantity: 4 }] });
    await as('u-owner');
    const r = await approve(body.transfer.id);
    expect([r.status, r.body.transfer.status, r.body.replay]).toEqual([200, 'SENT', false]);
    expect(S.m.data.productionBatch[0].quantityRemaining).toBe(6);
    expect(S.audit.filter((a) => a.action === 'STOCK_TRANSFER_APPROVED')).toHaveLength(1);
    const again = await approve(body.transfer.id);
    expect([again.status, again.body.replay]).toEqual([200, true]);
    expect(S.audit.filter((a) => a.action === 'STOCK_TRANSFER_APPROVED')).toHaveLength(1);
  });
});

describe('the receipt in the other store, and what each person is told', () => {
  it('the destination store lists the incoming transfer; the receiver standing there receives it with landed costs', async () => {
    await as('u-abroad');
    const { body } = await abroad({ id: uuid(), lines: [{ productId: 'p1', quantity: 4 }] });
    await as('u-owner');
    await approve(body.transfer.id);

    await as('u-receiver', 's3');
    const l = await listOf();
    const row = l.body.transfers.find((t: Row) => t.id === body.transfer.id);
    expect([row.kind, row.toStoreName, row.fromStoreName, row.blind]).toEqual(['BETWEEN_COUNTRIES', 'متجر البلد التاني', 'المتجر', true]);
    expect(row.lines[0].quantitySent).toBeNull();
    expect(row.lines[0]).not.toHaveProperty('costOut');

    const r = await receive(body.transfer.id, [{ productId: 'p1', quantity: 4, costs: [{ kind: 'CUSTOMS', amount: 2 }] }]);
    expect([r.status, r.body.transfer.status]).toEqual([200, 'RECEIVED']);
    // (4 × 2 + 2) ÷ 4 = 2.5 — but the receiver has no cost key: the answer omits it.
    expect(r.body.transfer.lines[0]).not.toHaveProperty('unitCostIn');
    expect(S.m.data.productionBatch.find((b) => b.productId === 'r1')!.costPerUnit).toBe(2.5);
    // The audit line keeps quantities and the twin, never a cost figure.
    const audited = S.audit.find((a) => a.action === 'STOCK_TRANSFER_RECEIVED')!;
    expect(JSON.stringify(audited.newData)).not.toMatch(/costOut|unitCostIn|landed/);
  });

  it('a receiver with the cost key is told the cost once the count is no longer blind', async () => {
    await as('u-sender');
    const { body } = await send({ lines: [{ productId: 'p1', quantity: 4 }] });
    await as('u-receiver-cost', 's2');
    const r = await receive(body.transfer.id, [{ productId: 'p1', quantity: 4 }]);
    expect(r.body.transfer.lines[0]).toMatchObject({ toProductId: 'q1', costOut: 8, unitCostIn: 2 });
  });

  it('NEGATIVE: a store that is neither end finds no such transfer', async () => {
    await as('u-sender');
    const { body } = await send({ lines: [{ productId: 'p1', quantity: 4 }] });
    await as('u-receiver', 's3');
    expect((await receive(body.transfer.id, [{ productId: 'p1', quantity: 4 }])).status).toBe(404);
  });
});
