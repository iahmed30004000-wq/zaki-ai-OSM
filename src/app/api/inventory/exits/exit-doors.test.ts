import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';
import type { Row } from '@/lib/stock-transfers.memory-db.test';

/**
 * THE EXIT DOORS (W6a) — POST/GET /api/inventory/exits, and /:id/approve, /:id/reject.
 *
 * People are built the way a session builds them: `computeEffectiveGrants` over role rows, personal overrides (ALLOW
 * and DENY) and a roleId-null legacy account (the system template it inherits), and the REAL `can` decides every key.
 * Reach is the real `reachesWarehouse` over the country and keeper rows of the in-memory database
 * (`stock-transfers.memory-db.test.ts`), which judges every `where` itself and has no money table at all.
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
import * as approveDoor from './[id]/approve/route';
import * as rejectDoor from './[id]/reject/route';
import { PATCH as stopDoor } from '@/app/api/geo/warehouses/[id]/route';

const C1 = 'c1';
let seq = 0;
const uuid = () => `00000000-0000-4000-b000-${String(++seq).padStart(12, '0')}`;

async function as(id: string) {
  const u = S.m.data.user.find((x) => x.id === id)!;
  S.current = attachGrants({ ...u, permissions: [] } as unknown as SessionUser, await computeEffectiveGrants({ id: u.id, role: u.role, roleId: u.roleId ?? null }));
}
const json = async (res: Response) => ({ status: res.status, body: await res.json() });
const req = (body: unknown) => new Request('http://x/api', { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const ask = (body: Row) => list.POST(req({ warehouseId: 'wA', reason: 'DAMAGED', ...body })).then(json);
const approve = (id: string, body?: unknown) => approveDoor.POST(req(body), ctx(id)).then(json);
const reject = (id: string) => rejectDoor.POST(req({ reason: 'العدّ غلط' }), ctx(id)).then(json);

beforeEach(() => {
  S.audit = [];
  S.storeId = 's1';
  S.rolePerms = {
    'r-asker': ['inventory.view', 'inventory.exit'],
    'r-approver': ['inventory.view', 'inventory.exit_approve'],
    'r-approver-cost': ['inventory.view', 'inventory.exit_approve', 'costs.view'],
    'r-both': ['inventory.view', 'inventory.exit', 'inventory.exit_approve'],
    'r-viewer': ['inventory.view'],
    'r-adjust': ['inventory.view', 'inventory.adjust', 'inventory.transfer', 'inventory.difference_approve'],
    // The system template a roleId-null WAREHOUSE account inherits: today's keeper keys, none of the two new ones.
    'template:WAREHOUSE': ['inventory.view', 'inventory.adjust', 'ops.prepare'],
  };
  S.overrides = {
    'u-both-denied': [{ permission: 'inventory.exit_approve', effect: 'DENY' }],
    'u-plus': [{ permission: 'inventory.exit', effect: 'ALLOW' }],
  };
  const people = [
    ['u-owner', 'SUPER_ADMIN', null],
    ['u-asker', 'CUSTOM', 'r-asker'],
    ['u-approver', 'CUSTOM', 'r-approver'],
    ['u-approver-cost', 'CUSTOM', 'r-approver-cost'],
    ['u-approver-b', 'CUSTOM', 'r-approver'],
    ['u-both', 'CUSTOM', 'r-both'],
    ['u-both-2', 'CUSTOM', 'r-both'],
    ['u-both-denied', 'CUSTOM', 'r-both'],
    ['u-viewer', 'CUSTOM', 'r-viewer'],
    ['u-adjust', 'CUSTOM', 'r-adjust'],
    ['u-plus', 'CUSTOM', 'r-viewer'],
    ['u-legacy-wh', 'WAREHOUSE', null],
    ['u-other-co', 'CUSTOM', 'r-both'],
  ] as const;
  S.m = memoryDb({
    country: [{ id: 'k1', companyId: C1, isActive: true, minorUnit: 2 }],
    store: [
      { id: 's1', companyId: C1, countryId: 'k1', name: 'المتجر' },
      { id: 's2', companyId: C1, countryId: 'k1', name: 'متجر تاني' },
    ],
    user: people.map(([id, role, roleId]) => ({ id, name: id, role, roleId, status: 'ACTIVE', companyId: id === 'u-other-co' ? 'c2' : C1 })),
    userCountryAccess: people.filter(([id]) => id !== 'u-owner').map(([userId]) => ({ userId, countryId: 'k1' })),
    // A keeper of wB only: she does not reach wA.
    userWarehouseAccess: [{ userId: 'u-approver-b', warehouseId: 'wB' }],
    warehouse: [
      { id: 'wA', companyId: C1, countryId: 'k1', name: 'أ', isActive: true },
      { id: 'wB', companyId: C1, countryId: 'k1', name: 'ب', isActive: true },
    ],
    warehousePlacement: [
      { id: 'pl1', companyId: C1, storeId: 's1' },
      { id: 'pl2', companyId: C1, storeId: 's2' },
    ],
    product: [
      { id: 'p1', companyId: C1, storeId: 's1', name: 'منتج ١' },
      { id: 'p2', companyId: C1, storeId: 's2', name: 'منتج المتجر التاني' },
    ],
    productionBatch: [
      {
        id: 'b1', companyId: C1, storeId: 's1', productId: 'p1', batchNumber: 'RCV-1', quantityProduced: 10, quantitySold: 0, quantityRemaining: 10,
        quantityMovedIn: 0, quantityMovedOut: 0, costPerUnit: 2.5, productionDate: new Date('2026-10-01'), createdAt: new Date('2026-10-01'),
        status: 'COMPLETED', notes: null, warehouseId: 'wA', inTransitTransferId: null, splitFromBatchId: null,
      },
      {
        id: 'b2', companyId: C1, storeId: 's2', productId: 'p2', batchNumber: 'RCV-2', quantityProduced: 4, quantitySold: 0, quantityRemaining: 4,
        quantityMovedIn: 0, quantityMovedOut: 0, costPerUnit: 1, productionDate: new Date('2026-10-01'), createdAt: new Date('2026-10-01'),
        status: 'COMPLETED', notes: null, warehouseId: 'wA', inTransitTransferId: null, splitFromBatchId: null,
      },
    ],
  }) as never;
});

describe('who may press which door — persons built as a session builds them', () => {
  it('nobody holds the two keys by a migration: a legacy WAREHOUSE account, an «adjust + transfer» role and a viewer are refused', async () => {
    for (const who of ['u-legacy-wh', 'u-adjust', 'u-viewer']) {
      await as(who);
      expect((await ask({ lines: [{ productId: 'p1', quantity: 1 }] })).status, who).toBe(403);
    }
    expect(S.m.data.stockExit).toEqual([]);
  });

  it('a personal ALLOW gives the request key; the owner’s full access holds both', async () => {
    await as('u-plus');
    const a = await ask({ lines: [{ productId: 'p1', quantity: 1 }] });
    expect(a.status).toBe(201);
    await as('u-owner');
    expect((await ask({ lines: [{ productId: 'p1', quantity: 1 }] })).status).toBe(201);
    expect((await approve(a.body.exit.id)).status).toBe(200);
  });

  it('each press asks its own key: an asker cannot approve or reject by key, an approver cannot ask, a personal DENY wins', async () => {
    await as('u-asker');
    const { body } = await ask({ lines: [{ productId: 'p1', quantity: 3 }] });
    await as('u-viewer');
    expect((await approve(body.exit.id)).status).toBe(403);
    expect((await reject(body.exit.id)).status).toBe(403);
    await as('u-approver');
    expect((await ask({ lines: [{ productId: 'p1', quantity: 1 }] })).status).toBe(403);
    await as('u-both-denied');
    expect((await approve(body.exit.id)).status).toBe(403);
    expect((await reject(body.exit.id)).status).toBe(403);
    expect(S.m.data.stockExit[0].status).toBe('PENDING');
  });
});

describe('two hands — even for a person who holds both keys, by either door, replays included', () => {
  it('the requester may not approve or reject her own exit; somebody else with the key may', async () => {
    await as('u-both');
    const id = uuid();
    expect((await ask({ id, lines: [{ productId: 'p1', quantity: 3 }] })).status).toBe(201);
    const a = await approve(id);
    expect([a.status, a.body.code]).toEqual([403, 'REQUESTER_CANNOT_DECIDE']);
    expect(a.body.errorAr).toMatch(/حدا تاني/);
    expect((await reject(id)).body.code).toBe('REQUESTER_CANNOT_DECIDE');
    await as('u-both-2');
    const ok = await approve(id);
    expect([ok.status, ok.body.replay, ok.body.exit.status]).toEqual([200, false, 'APPROVED']);
    // Her «replay» after another approved it: still her refusal, not «done».
    await as('u-both');
    expect((await approve(id)).body.code).toBe('REQUESTER_CANNOT_DECIDE');
    // The approver's own replay: done, nothing written again, no second audit line.
    await as('u-both-2');
    const auditBefore = S.audit.length;
    const again = await approve(id);
    expect([again.status, again.body.replay]).toEqual([200, true]);
    expect(S.audit.length).toBe(auditBefore);
    expect(S.m.data.inventoryMovement).toHaveLength(1);
  });

  it('the request replay: the same id, request and person → 200 replay; another request → 409 and nothing written', async () => {
    await as('u-asker');
    const id = uuid();
    expect((await ask({ id, lines: [{ productId: 'p1', quantity: 3 }] })).status).toBe(201);
    const again = await ask({ id, lines: [{ productId: 'p1', quantity: 3 }] });
    expect([again.status, again.body.replay]).toEqual([200, true]);
    const other = await ask({ id, lines: [{ productId: 'p1', quantity: 4 }] });
    expect([other.status, other.body.code]).toEqual([409, 'EXIT_EXISTS']);
    expect(S.m.data.stockExit).toHaveLength(1);
    expect(S.audit.filter((a) => a.action === 'STOCK_EXIT_REQUESTED')).toHaveLength(1);
  });
});

describe('reach, tenancy and refusals at the doors', () => {
  it('NEGATIVE: a keeper of another warehouse cannot approve; another company finds nothing', async () => {
    await as('u-asker');
    const { body } = await ask({ lines: [{ productId: 'p1', quantity: 3 }] });
    await as('u-approver-b');
    const r = await approve(body.exit.id);
    expect([r.status, r.body.code]).toEqual([403, 'NOT_REACHED']);
    await as('u-other-co');
    expect((await approve(body.exit.id)).status).toBe(404);
    expect((await reject(body.exit.id)).status).toBe(404);
  });

  it('NEGATIVE: more than the free stock → 409 with the Arabic sentence and the short list', async () => {
    await as('u-asker');
    const r = await ask({ lines: [{ productId: 'p1', quantity: 11 }] });
    expect([r.status, r.body.code]).toEqual([409, 'NOT_ENOUGH_FREE']);
    expect(r.body.errorAr).toContain('منتج ١');
    expect(r.body.short).toEqual([{ productId: 'p1', name: 'منتج ١', asked: 11, free: 10 }]);
  });

  it('every refusal is an Arabic sentence with a stable code — a bad body too, and «أخرى» without a sentence', async () => {
    await as('u-asker');
    for (const body of [{ lines: [] }, { reason: 'OTHER', lines: [{ productId: 'p1', quantity: 1 }] }, { reason: 'NOPE', lines: [{ productId: 'p1', quantity: 1 }] }]) {
      const r = await ask(body);
      expect([r.status, r.body.code]).toEqual([400, 'INVALID']);
      expect(r.body.errorAr).toMatch(/[؀-ۿ]/);
    }
    await as('u-approver');
    const r = await rejectDoor.POST(req({}), ctx('x')).then(json);
    expect([r.status, r.body.code]).toEqual([400, 'INVALID']);
    expect(r.body.errorAr).toMatch(/[؀-ۿ]/);
  });

  it('approve takes an empty body or none', async () => {
    await as('u-asker');
    const a = (await ask({ lines: [{ productId: 'p1', quantity: 1 }] })).body.exit.id;
    const b = (await ask({ lines: [{ productId: 'p1', quantity: 1 }] })).body.exit.id;
    await as('u-approver');
    expect((await approve(a)).status).toBe(200);
    expect((await approve(b, {})).status).toBe(200);
  });
});

describe('the list: this store only, and the value at cost only for the cost key', () => {
  it('an exit of another store in the same warehouse is not listed; the value at cost is omitted without «costs.view»', async () => {
    await as('u-asker');
    const mine = (await ask({ lines: [{ productId: 'p1', quantity: 4 }], reason: 'EXPIRED' })).body.exit.id;
    S.storeId = 's2';
    await ask({ lines: [{ productId: 'p2', quantity: 1 }] });
    S.storeId = 's1';
    await as('u-approver');
    const done = await approve(mine);
    expect('valueAtCost' in done.body.exit.lines[0]).toBe(false);

    const plain = await list.GET().then(json);
    expect(plain.body.exits.map((e: Row) => e.id)).toEqual([mine]);
    expect(plain.body.exits[0]).toMatchObject({ statusAr: 'طلع', reasonAr: 'منتهي', warehouseName: 'أ', requestedByName: 'u-asker', decidedByName: 'u-approver' });
    expect(plain.body.exits[0].lines[0]).toEqual({ productId: 'p1', quantity: 4, productName: 'منتج ١' });
    expect(plain.body.reasons).toHaveLength(7);

    await as('u-approver-cost');
    const costed = await list.GET().then(json);
    expect(costed.body.exits[0].lines[0]).toEqual({ productId: 'p1', quantity: 4, valueAtCost: 10, productName: 'منتج ١' });
    // The audit trail carries quantities only, never the value at cost.
    expect(JSON.stringify(S.audit)).not.toContain('valueAtCost');
  });
});

describe('the stop door sees a pending exit (W0a left this line to W6a)', () => {
  it('NEGATIVE: a warehouse with a pending exit does not stop; after the rejection, emptied of its own goods, it would', async () => {
    await as('u-asker');
    const { body } = await ask({ lines: [{ productId: 'p1', quantity: 2 }] });
    await as('u-owner');
    const stop = (id: string) => stopDoor(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ isActive: false }) }), ctx(id)).then(json);
    const r = await stop('wA');
    expect([r.status, r.body.code]).toEqual([409, 'WAREHOUSE_NOT_EMPTY']);
    expect(r.body.blockers.map((b: Row) => b.code)).toEqual(['HOLDS_UNITS', 'PENDING_EXIT']);
    await as('u-approver');
    await reject(body.exit.id);
    await as('u-owner');
    expect((await stop('wA')).body.blockers.map((b: Row) => b.code)).toEqual(['HOLDS_UNITS']);
  });
});
