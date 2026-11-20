import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';
import type { Row } from '@/lib/stock-transfers.memory-db.test';

/**
 * THE TRANSFER DOORS (W3a) — POST/GET /api/inventory/transfers, and /:id/receive, /:id/cancel, /:id/difference.
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
    // 20/11 (W3b review): the movements door reads the ledger with its relations and a grouped count; the in-memory
    // database judges the `where`, and this adds only the relation rows and the grouping it does not do itself.
    inventoryMovement: {
      findMany: async ({ where, orderBy, take }: Row) =>
        ((await (S.m.db.inventoryMovement as Row).findMany({ where, orderBy, take })) as Row[]).map((r) => ({
          ...r,
          product: S.m.data.product.find((p) => p.id === r.productId) ?? null,
          batch: null,
          warehouse: S.m.data.warehouse.find((w) => w.id === r.warehouseId) ?? null,
        })),
      groupBy: async ({ by, where }: Row) => {
        const rows = (await (S.m.db.inventoryMovement as Row).findMany({ where })) as Row[];
        const counts = new Map<unknown, number>();
        for (const r of rows) counts.set(r[by[0]], (counts.get(r[by[0]]) ?? 0) + 1);
        return [...counts].map(([v, n]) => ({ [by[0]]: v, _count: { type: n } }));
      },
    },
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
import * as receiveDoor from './[id]/receive/route';
import * as cancelDoor from './[id]/cancel/route';
import * as differenceDoor from './[id]/difference/route';
import { PATCH as stopDoor } from '@/app/api/geo/warehouses/[id]/route';
import { GET as movementsDoor } from '@/app/api/inventory/movements/route';
import { HIDDEN_ON_ROAD_AR } from '@/lib/stock-transfers';

/** Every number anywhere in an answer, top level and nested — the sent figure may hide in no field. */
const numbersIn = (v: unknown): number[] =>
  typeof v === 'number' ? [v] : v && typeof v === 'object' ? Object.values(v as Row).flatMap(numbersIn) : [];

const C1 = 'c1';
let seq = 0;
const uuid = () => `00000000-0000-4000-9000-${String(++seq).padStart(12, '0')}`;

async function as(id: string) {
  const u = S.m.data.user.find((x) => x.id === id)!;
  S.current = attachGrants({ ...u, permissions: [] } as unknown as SessionUser, await computeEffectiveGrants({ id: u.id, role: u.role, roleId: u.roleId ?? null }));
}
const json = async (res: Response) => ({ status: res.status, body: await res.json() });
const req = (body: unknown) => new Request('http://x/api', { method: 'POST', body: JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const send = (body: Row) => list.POST(req({ fromWarehouseId: 'wA', toWarehouseId: 'wB', ...body })).then(json);
const receive = (id: string, lines: Row[]) => receiveDoor.POST(req({ lines }), ctx(id)).then(json);
const cancel = (id: string) => cancelDoor.POST(req({ reason: 'غلطنا بالكمية' }), ctx(id)).then(json);
const difference = (id: string, type = 'LOSS') => differenceDoor.POST(req({ type, reason: 'انكسرت بالطريق' }), ctx(id)).then(json);

beforeEach(() => {
  S.audit = [];
  S.storeId = 's1';
  S.rolePerms = {
    'r-sender': ['inventory.view', 'inventory.transfer'],
    'r-receiver': ['inventory.view', 'inventory.transfer_receive'],
    'r-approver': ['inventory.view', 'inventory.difference_approve'],
    'r-all': ['inventory.view', 'inventory.transfer', 'inventory.transfer_receive', 'inventory.difference_approve'],
    'r-viewer': ['inventory.view'],
    'r-adjust': ['inventory.view', 'inventory.adjust'],
    // The system template a roleId-null WAREHOUSE account inherits: today's keeper keys, none of the three new ones.
    'template:WAREHOUSE': ['inventory.view', 'inventory.adjust', 'ops.prepare'],
  };
  S.overrides = {
    'u-all-denied': [{ permission: 'inventory.transfer_receive', effect: 'DENY' }],
    'u-plus': [{ permission: 'inventory.transfer', effect: 'ALLOW' }],
  };
  const people = [
    ['u-owner', 'SUPER_ADMIN', null],
    ['u-sender', 'CUSTOM', 'r-sender'],
    ['u-receiver', 'CUSTOM', 'r-receiver'],
    ['u-receiver-a', 'CUSTOM', 'r-receiver'],
    ['u-approver', 'CUSTOM', 'r-approver'],
    ['u-all', 'CUSTOM', 'r-all'],
    ['u-all-2', 'CUSTOM', 'r-all'],
    ['u-all-3', 'CUSTOM', 'r-all'],
    ['u-all-denied', 'CUSTOM', 'r-all'],
    ['u-viewer', 'CUSTOM', 'r-viewer'],
    ['u-adjust', 'CUSTOM', 'r-adjust'],
    ['u-plus', 'CUSTOM', 'r-viewer'],
    ['u-legacy-wh', 'WAREHOUSE', null],
    ['u-other-co', 'CUSTOM', 'r-all'],
  ] as const;
  S.m = memoryDb({
    country: [
      { id: 'k1', companyId: C1, isActive: true },
      { id: 'k2', companyId: C1, isActive: true },
    ],
    store: [
      { id: 's1', companyId: C1, countryId: 'k1', name: 'المتجر' },
      { id: 's2', companyId: C1, countryId: 'k1', name: 'متجر تاني' },
    ],
    user: people.map(([id, role, roleId]) => ({ id, name: id, role, roleId, status: 'ACTIVE', companyId: id === 'u-other-co' ? 'c2' : C1 })),
    userCountryAccess: people.filter(([id]) => id !== 'u-owner').map(([userId]) => ({ userId, countryId: 'k1' })),
    // A keeper of wA only: she reaches the source, not the destination.
    userWarehouseAccess: [{ userId: 'u-receiver-a', warehouseId: 'wA' }],
    warehouse: [
      { id: 'wA', companyId: C1, countryId: 'k1', name: 'أ', isActive: true },
      { id: 'wB', companyId: C1, countryId: 'k1', name: 'ب', isActive: true },
      { id: 'wJ', companyId: C1, countryId: 'k2', name: 'عمّان', isActive: true },
    ],
    warehousePlacement: [{ id: 'pl1', companyId: C1, storeId: 's1' }],
    product: [{ id: 'p1', companyId: C1, storeId: 's1', name: 'منتج ١' }],
    productionBatch: [
      {
        id: 'b1', companyId: C1, storeId: 's1', productId: 'p1', batchNumber: 'RCV-1', quantityProduced: 10, quantitySold: 0, quantityRemaining: 10,
        quantityMovedIn: 0, quantityMovedOut: 0, costPerUnit: 2, productionDate: new Date('2026-10-01'), createdAt: new Date('2026-10-01'),
        status: 'COMPLETED', notes: null, warehouseId: 'wA', inTransitTransferId: null, splitFromBatchId: null,
      },
    ],
  }) as never;
});

describe('who may press which door — persons built as a session builds them', () => {
  it('nobody holds the three keys by a migration: a legacy WAREHOUSE account, an «adjust» role and a viewer are refused', async () => {
    for (const who of ['u-legacy-wh', 'u-adjust', 'u-viewer']) {
      await as(who);
      expect((await send({ lines: [{ productId: 'p1', quantity: 1 }] })).status, who).toBe(403);
    }
    expect(S.m.data.stockTransfer).toEqual([]);
  });

  it('a personal ALLOW gives the send key; the owner’s full access holds all three', async () => {
    await as('u-plus');
    expect((await send({ lines: [{ productId: 'p1', quantity: 1 }] })).status).toBe(201);
    await as('u-owner');
    expect((await send({ lines: [{ productId: 'p1', quantity: 1 }] })).status).toBe(201);
  });

  it('each press asks its own key: a sender cannot receive by key, a receiver cannot send, a personal DENY wins', async () => {
    await as('u-sender');
    const { body } = await send({ lines: [{ productId: 'p1', quantity: 3 }] });
    await as('u-receiver');
    expect((await send({ lines: [{ productId: 'p1', quantity: 1 }] })).status).toBe(403);
    expect((await difference(body.transfer.id)).status).toBe(403);
    await as('u-approver');
    expect((await receive(body.transfer.id, [{ productId: 'p1', quantity: 3 }])).status).toBe(403);
    await as('u-all-denied');
    expect((await receive(body.transfer.id, [{ productId: 'p1', quantity: 3 }])).status).toBe(403);
  });
});

describe('two hands — even for a person who holds all three keys, and by any door, replays included', () => {
  it('the sender may not receive her own transfer, though she holds the receive key', async () => {
    await as('u-all');
    const id = uuid();
    expect((await send({ id, lines: [{ productId: 'p1', quantity: 3 }] })).status).toBe(201);
    const r = await receive(id, [{ productId: 'p1', quantity: 3 }]);
    expect([r.status, r.body.code]).toEqual([403, 'SENDER_CANNOT_RECEIVE']);
    expect(r.body.errorAr).toMatch(/حدا تاني/);
    // And after somebody else received it, her «replay» of the receipt is still refused — not answered as done.
    await as('u-all-2');
    expect((await receive(id, [{ productId: 'p1', quantity: 2 }])).status).toBe(200);
    await as('u-all');
    expect((await receive(id, [{ productId: 'p1', quantity: 2 }])).body.code).toBe('SENDER_CANNOT_RECEIVE');
  });

  it('the receiver may not approve the difference — nor the sender — though both hold the key; a third person may', async () => {
    await as('u-all');
    const id = uuid();
    await send({ id, lines: [{ productId: 'p1', quantity: 3 }] });
    await as('u-all-2');
    await receive(id, [{ productId: 'p1', quantity: 1 }]);
    expect((await difference(id)).body.code).toBe('RECEIVER_CANNOT_APPROVE');
    await as('u-all');
    expect((await difference(id)).body.code).toBe('SENDER_CANNOT_APPROVE');
    await as('u-all-3');
    const ok = await difference(id);
    expect([ok.status, ok.body.replay]).toEqual([200, false]);
    // A replay by the receiver after the approval: still her refusal, not «done».
    await as('u-all-2');
    expect((await difference(id)).body.code).toBe('RECEIVER_CANNOT_APPROVE');
    // The third person's own replay: done, nothing written again, no second audit line.
    await as('u-all-3');
    const auditBefore = S.audit.length;
    const again = await difference(id);
    expect([again.status, again.body.replay]).toEqual([200, true]);
    expect(S.audit.length).toBe(auditBefore);
  });

  it('the send replay: the same id, deal and person → 200 replay; another deal → 409 and nothing written', async () => {
    await as('u-sender');
    const id = uuid();
    expect((await send({ id, lines: [{ productId: 'p1', quantity: 3 }] })).status).toBe(201);
    const again = await send({ id, lines: [{ productId: 'p1', quantity: 3 }] });
    expect([again.status, again.body.replay]).toEqual([200, true]);
    const other = await send({ id, lines: [{ productId: 'p1', quantity: 4 }] });
    expect([other.status, other.body.code]).toEqual([409, 'TRANSFER_EXISTS']);
    expect(S.m.data.stockTransfer).toHaveLength(1);
    expect(S.m.data.inventoryMovement).toHaveLength(1);
  });
});

describe('reach and tenancy at the doors', () => {
  it('NEGATIVE: a keeper of the source only cannot receive at the destination', async () => {
    await as('u-sender');
    const { body } = await send({ lines: [{ productId: 'p1', quantity: 3 }] });
    await as('u-receiver-a');
    const r = await receive(body.transfer.id, [{ productId: 'p1', quantity: 3 }]);
    expect([r.status, r.body.code]).toEqual([403, 'NOT_REACHED']);
    await as('u-receiver');
    expect((await receive(body.transfer.id, [{ productId: 'p1', quantity: 3 }])).status).toBe(200);
  });

  it('NEGATIVE: another company’s person finds no transfer of this one', async () => {
    await as('u-sender');
    const { body } = await send({ lines: [{ productId: 'p1', quantity: 3 }] });
    await as('u-other-co');
    expect((await receive(body.transfer.id, [{ productId: 'p1', quantity: 3 }])).status).toBe(404);
    expect((await cancel(body.transfer.id)).status).toBe(404);
  });

  it('another country: «لسا مش مبني», with the kind it read', async () => {
    await as('u-owner');
    const r = await send({ toWarehouseId: 'wJ', lines: [{ productId: 'p1', quantity: 1 }] });
    expect([r.status, r.body.code, r.body.kind]).toEqual([400, 'KIND_NOT_BUILT', 'BETWEEN_COUNTRIES']);
    expect(r.body.errorAr).toContain('لسا مش مبني');
  });

  it('every refusal is an Arabic sentence with a stable code — a bad body too', async () => {
    await as('u-sender');
    const r = await send({ lines: [] });
    expect([r.status, r.body.code]).toEqual([400, 'INVALID']);
    expect(r.body.errorAr).toMatch(/[؀-ۿ]/);
  });
});

describe('20/11 (W3b): every bad body is refused in Arabic — the screen prints the door’s sentence as it is', () => {
  const arabic = /[؀-ۿ]/;
  const latin = /[A-Za-z]/;
  const raw = (body: string) => new Request('http://x/api', { method: 'POST', body });

  it('send: a missing product, an empty store, a long note, an unknown kind, a body that is not an object', async () => {
    await as('u-sender');
    const bodies: unknown[] = [
      { fromWarehouseId: 'wA', toWarehouseId: 'wB', lines: [{ productId: '', quantity: 1 }] },
      { fromWarehouseId: 'wA', toWarehouseId: 'wB', lines: [{ quantity: 1 }] },
      { fromWarehouseId: 'wA', toWarehouseId: 'wB', toStoreId: '', lines: [{ productId: 'p1', quantity: 1 }] },
      { fromWarehouseId: 'wA', toWarehouseId: 'wB', note: 'م'.repeat(501), lines: [{ productId: 'p1', quantity: 1 }] },
      { fromWarehouseId: 'wA', toWarehouseId: 'wB', expectKind: 'SIDEWAYS', lines: [{ productId: 'p1', quantity: 1 }] },
      { fromWarehouseId: 'wA', toWarehouseId: 'wB', lines: 'p1' },
      { fromWarehouseId: 'wA', toWarehouseId: 'wB', lines: ['p1'] },
      { fromWarehouseId: 7, toWarehouseId: 'wB', lines: [{ productId: 'p1', quantity: 1 }] },
      null,
      'نص',
      [],
    ];
    for (const b of bodies) {
      const r = await list.POST(raw(JSON.stringify(b))).then(json);
      expect([r.status, r.body.code], JSON.stringify(b)).toEqual([400, 'INVALID']);
      expect(r.body.errorAr, JSON.stringify(b)).toMatch(arabic);
      expect(r.body.errorAr, JSON.stringify(b)).not.toMatch(latin);
    }
    // Not JSON at all.
    const broken = await list.POST(raw('{')).then(json);
    expect([broken.status, broken.body.code]).toEqual([400, 'INVALID']);
    expect(broken.body.errorAr).not.toMatch(latin);
    expect(S.m.data.stockTransfer).toEqual([]);
  });

  it('NEGATIVE: a rule written later without its sentence still answers in Arabic — zod’s English never passes the door', async () => {
    const { z } = await import('zod');
    const { arabicIssue, BAD_BODY_AR } = await import('@/lib/stock-transfer-door');
    const bare = z.object({ a: z.string().min(2) });
    for (const v of [null, {}, { a: 'x' }, { a: 3 }]) {
      const r = bare.safeParse(v);
      expect(r.success).toBe(false);
      expect(arabicIssue(r.error!)).toBe(BAD_BODY_AR);
    }
    // An Arabic sentence of the schema is passed as it is.
    expect(arabicIssue(z.string().min(3, 'اكتب سبب').safeParse('').error!)).toBe('اكتب سبب');
  });

  it('receive, cancel, difference: an empty product, a long reason, a wrong type, a body that is not an object', async () => {
    await as('u-sender');
    const { body } = await send({ lines: [{ productId: 'p1', quantity: 3 }] });
    const id = body.transfer.id;
    const cases: [typeof receiveDoor.POST, unknown][] = [
      [receiveDoor.POST, { lines: [{ productId: '', quantity: 1 }] }],
      [receiveDoor.POST, { lines: [{ productId: 'p1', quantity: 'ثلاثة' }] }],
      [receiveDoor.POST, null],
      [cancelDoor.POST, { reason: 'م'.repeat(501) }],
      [cancelDoor.POST, { reason: 4 }],
      [cancelDoor.POST, 'نص'],
      [differenceDoor.POST, { type: 'STOLEN', reason: 'سبب' }],
      [differenceDoor.POST, { type: 'LOSS', reason: 'م'.repeat(501) }],
      [differenceDoor.POST, []],
    ];
    await as('u-owner');
    for (const [door, b] of cases) {
      const r = await door(raw(JSON.stringify(b)), ctx(id)).then(json);
      expect([r.status, r.body.code], JSON.stringify(b)).toEqual([400, 'INVALID']);
      expect(r.body.errorAr, JSON.stringify(b)).toMatch(arabic);
      expect(r.body.errorAr, JSON.stringify(b)).not.toMatch(latin);
    }
  });
});

describe('the list: the receiver counts blind', () => {
  it('20/11 (W3b): NEGATIVE — no field of the receiver’s list carries the sent figure; the warehouses carry their country', async () => {
    await as('u-sender');
    await send({ lines: [{ productId: 'p1', quantity: 7 }] });
    await as('u-receiver');
    const hers = (await list.GET().then(json)).body;
    expect(hers.transfers[0].lines).toEqual([{ productId: 'p1', productName: 'منتج ١', quantitySent: null, quantityReceived: null, difference: null }]);
    // The WHOLE answer, walked: no number 7 at any depth (the stock on the shelf is 10, so a 3 or a 10 may stand; 7 may not).
    expect(numbersIn(hers)).not.toContain(7);
    expect(hers.warehouses.map((w: Row) => [w.id, w.countryId])).toEqual([
      ['wA', 'k1'],
      ['wB', 'k1'],
    ]);
    // Once she has counted, the sent figure and the difference are told — after, never before.
    await receive(hers.transfers[0].id, [{ productId: 'p1', quantity: 5 }]);
    const after = (await list.GET().then(json)).body;
    expect(after.transfers[0].lines[0]).toMatchObject({ quantitySent: 7, quantityReceived: 5, difference: 2 });
    expect(after.transfers[0]).toMatchObject({ blind: false, statusAr: 'مستلم بفرق' });
  });

  it('while on the road the sent quantity is told only to the sender', async () => {
    await as('u-sender');
    await send({ lines: [{ productId: 'p1', quantity: 7 }] });
    const mine = await list.GET().then(json);
    expect(mine.body.transfers[0].lines[0]).toMatchObject({ productName: 'منتج ١', quantitySent: 7 });
    await as('u-receiver');
    const hers = await list.GET().then(json);
    expect(hers.body.transfers[0].lines[0].quantitySent).toBeNull();
    expect(hers.body.transfers[0]).toMatchObject({ statusAr: 'بالطريق', kindAr: 'نقل داخل المتجر', fromName: 'أ', toName: 'ب', sentByName: 'u-sender', blind: true });
  });
});

describe('20/11 (W3b review): the movements tab is blind too — the TRANSFER_OUT line of a transfer on the road', () => {
  const ledger = async () => (await movementsDoor(new Request('http://x/api/inventory/movements')).then(json)).body;
  const outLine = (b: Row) => b.movements.find((m: Row) => m.type === 'TRANSFER_OUT');

  it('NEGATIVE: the receiver (view + receive) and the owner see the line with no figure; the sender sees −7', async () => {
    await as('u-sender');
    await send({ lines: [{ productId: 'p1', quantity: 7 }] });
    expect(outLine(await ledger())).toMatchObject({ quantity: -7, reason: 'نقل إلى ب' });
    for (const who of ['u-receiver', 'u-owner', 'u-viewer']) {
      await as(who);
      const b = await ledger();
      expect(outLine(b), who).toMatchObject({ quantity: null, reason: HIDDEN_ON_ROAD_AR, hiddenOnRoad: true, balanceAfter: 10 });
      expect(numbersIn(b), who).not.toContain(7);
      expect(numbersIn(b), who).not.toContain(-7);
      expect(JSON.stringify(b), who).not.toContain('نقل إلى');
    }
  });

  it('after the receipt — or a cancel — everyone reads the figure', async () => {
    await as('u-sender');
    const a = (await send({ lines: [{ productId: 'p1', quantity: 7 }] })).body.transfer.id;
    await as('u-receiver');
    await receive(a, [{ productId: 'p1', quantity: 7 }]);
    for (const who of ['u-receiver', 'u-owner']) {
      await as(who);
      expect(outLine(await ledger()), who).toMatchObject({ quantity: -7, reason: 'نقل إلى ب' });
    }
    await as('u-sender');
    const c = (await send({ lines: [{ productId: 'p1', quantity: 2 }] })).body.transfer.id;
    await as('u-receiver');
    expect((await ledger()).movements.filter((m: Row) => m.type === 'TRANSFER_OUT').map((m: Row) => m.quantity)).toEqual(
      expect.arrayContaining([null, -7])
    );
    await as('u-sender');
    await cancel(c);
    await as('u-receiver');
    expect(
      (await ledger()).movements
        .filter((m: Row) => m.type === 'TRANSFER_OUT')
        .map((m: Row) => m.quantity)
        .sort()
    ).toEqual([-2, -7].sort());
  });

  it('a page with no transfer line asks nothing more of the database', async () => {
    await as('u-receiver');
    const spy = vi.spyOn(S.m.db.stockTransfer as Row, 'findMany');
    const b = await ledger();
    expect(b.movements).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('the stop door sees an open transfer (W0a left this line to W3a)', () => {
  it('NEGATIVE: a destination with goods on their way to it does not stop, nor the source it left; after a cancel the destination stops', async () => {
    await as('u-sender');
    const { body } = await send({ lines: [{ productId: 'p1', quantity: 10 }] });
    await as('u-owner');
    const stop = (id: string) => stopDoor(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ isActive: false }) }), ctx(id)).then(json);
    // wA is empty (all 10 on the road) and wB holds nothing yet: only the open transfer keeps them running.
    for (const w of ['wA', 'wB']) {
      const r = await stop(w);
      expect([r.status, r.body.code, r.body.blockers.map((b: Row) => b.code)]).toEqual([409, 'WAREHOUSE_NOT_EMPTY', ['OPEN_TRANSFER']]);
    }
    await as('u-sender');
    await cancel(body.transfer.id);
    await as('u-owner');
    expect((await stop('wB')).status).toBe(200);
  });
});
