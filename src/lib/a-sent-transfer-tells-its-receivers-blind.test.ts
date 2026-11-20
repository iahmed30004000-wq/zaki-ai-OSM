import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';
import type { Row } from '@/lib/stock-transfers.memory-db.test';

/**
 * A SENT TRANSFER TELLS ITS RECEIVERS — AND NEVER HOW MUCH (the warehouse plan, request W3c).
 *
 * The real send door (`POST /api/inventory/transfers`) over the in-memory database of the transfer tests. Who is told is
 * decided by the real chain — `resolveAudience` (every ACTIVE person of the company, their grants by
 * `computeEffectiveGrants` over role rows, personal ALLOW / DENY and a roleId-null legacy account, the real `can`, the
 * real store reach) and then the real `reachesWarehouse` for the destination — never by a hand-written list of keys.
 *
 * The receipt is blind: the notice carries the source and the NUMBER of products, and no unit figure anywhere.
 */

const S = vi.hoisted(() => ({
  current: null as unknown as SessionUser,
  m: null as unknown as { db: Record<string, unknown>; data: Record<string, Row[]> },
  rolePerms: {} as Record<string, string[]>,
  overrides: [] as { userId: string; permission: string; effect: 'ALLOW' | 'DENY' }[],
  told: [] as Row[],
  notifyFails: false,
}));

vi.mock('@/lib/db', () => {
  const extra: Row = {
    rolePermission: {
      findMany: async ({ where }: Row) =>
        (where.roleId ? S.rolePerms[where.roleId] ?? [] : S.rolePerms[`template:${where.role?.name}`] ?? []).map((permission) => ({
          permission,
          scope: 'ALL_COMPANY',
          scopeIds: null,
        })),
    },
    // Asked two ways: one person (`dbGrantSource`) and many at once (`resolveAudience`).
    userPermission: {
      findMany: async ({ where }: Row) =>
        S.overrides
          .filter((o) => (typeof where.userId === 'string' ? o.userId === where.userId : (where.userId.in as string[]).includes(o.userId)))
          .map((o) => ({ ...o, scope: 'ALL_COMPANY', scopeIds: null })),
    },
    // `usersReachingStore` reads the store with its country; the in-memory database does not follow that relation itself.
    store: {
      findFirst: async ({ where }: Row) => {
        const s = S.m.data.store.find((x) => x.id === where.id && x.companyId === where.companyId);
        if (!s) return null;
        const c = S.m.data.country.find((x) => x.id === s.countryId);
        return { id: s.id, countryId: s.countryId, country: c ? { isActive: c.isActive, companyId: c.companyId } : null };
      },
      findMany: (...a: unknown[]) => ((S.m.db as Row).store as Row).findMany(...a),
    },
    notification: {
      createMany: async ({ data }: Row) => {
        if (S.notifyFails) throw new Error('notifications table down');
        S.told.push(...(data as Row[]));
        return { count: (data as Row[]).length };
      },
    },
  };
  const db = new Proxy({} as Row, { get: (_t, prop: string) => (prop in extra ? extra[prop] : (S.m.db as Row)[prop]) });
  return { db };
});
vi.mock('@/lib/geo-context', async (orig) => {
  const real = await orig<typeof import('@/lib/geo-context')>();
  return { ...real, requireContext: async () => ({ user: S.current, companyId: (S.current as Row).companyId, storeId: 's1' }) };
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

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { memoryDb } from '@/lib/stock-transfers.memory-db.test';
import * as door from '@/app/api/inventory/transfers/route';
import { announceTransferSent } from './stock-transfer-alerts';
import { productsAr, transferSentWords } from './stock-transfer-watch';

const C1 = 'c1';
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

async function as(id: string) {
  const u = S.m.data.user.find((x) => x.id === id)!;
  S.current = attachGrants({ ...u, permissions: [] } as unknown as SessionUser, await computeEffectiveGrants({ id: u.id, role: u.role, roleId: u.roleId ?? null }));
}
const send = async (lines: Row[], id = uuid()) => {
  const res = await door.POST(new Request('http://x/api', { method: 'POST', body: JSON.stringify({ id, fromWarehouseId: 'wA', toWarehouseId: 'wB', lines }) }));
  return { status: res.status, id };
};
/** The notice runs after the answer; wait for it to land (or for nothing to land). */
const settle = async () => {
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
};
const toldIds = () => [...new Set(S.told.map((n) => n.userId))].sort();

beforeEach(() => {
  S.told = [];
  S.notifyFails = false;
  S.rolePerms = {
    'r-sender': ['inventory.view', 'inventory.transfer'],
    'r-receiver': ['inventory.view', 'inventory.transfer_receive'],
    'r-approver': ['inventory.view', 'inventory.difference_approve'],
    'r-all': ['inventory.view', 'inventory.transfer', 'inventory.transfer_receive', 'inventory.difference_approve'],
    // The system template a roleId-null WAREHOUSE account inherits: today's keeper keys, not the receive key.
    'template:WAREHOUSE': ['inventory.view', 'inventory.adjust', 'ops.prepare'],
  };
  S.overrides = [
    { userId: 'u-denied', permission: 'inventory.transfer_receive', effect: 'DENY' },
    { userId: 'u-plus', permission: 'inventory.transfer_receive', effect: 'ALLOW' },
  ];
  const people = [
    ['u-owner', 'SUPER_ADMIN', null],
    ['u-sender', 'CUSTOM', 'r-all'],
    ['u-receiver', 'CUSTOM', 'r-receiver'],
    ['u-keeper-a', 'CUSTOM', 'r-receiver'],
    ['u-approver', 'CUSTOM', 'r-approver'],
    ['u-denied', 'CUSTOM', 'r-all'],
    ['u-plus', 'CUSTOM', 'r-sender'],
    ['u-legacy-wh', 'WAREHOUSE', null],
    ['u-other-store', 'CUSTOM', 'r-receiver'],
    ['u-other-country', 'CUSTOM', 'r-receiver'],
    ['u-gone', 'CUSTOM', 'r-receiver'],
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
    user: people.map(([id, role, roleId]) => ({
      id,
      name: id,
      email: `${id}@test.local`,
      role,
      roleId,
      status: id === 'u-gone' ? 'SUSPENDED' : 'ACTIVE',
      companyId: id === 'u-other-co' ? 'c2' : C1,
    })),
    userCountryAccess: people
      .filter(([id]) => id !== 'u-owner')
      .map(([userId]) => ({ userId, countryId: userId === 'u-other-country' ? 'k2' : 'k1' })),
    // Named to the other store only: she does not stand in this one.
    userStoreAccess: [{ userId: 'u-other-store', storeId: 's2' }],
    // A keeper of the SOURCE only: she reaches wA, not the destination.
    userWarehouseAccess: [{ userId: 'u-keeper-a', warehouseId: 'wA' }],
    warehouse: [
      { id: 'wA', companyId: C1, countryId: 'k1', name: 'الشمال', isActive: true },
      { id: 'wB', companyId: C1, countryId: 'k1', name: 'مخزن الجنوب', isActive: true },
    ],
    warehousePlacement: [{ id: 'pl1', companyId: C1, storeId: 's1' }],
    product: [
      { id: 'p1', companyId: C1, storeId: 's1', name: 'منتج ١' },
      { id: 'p2', companyId: C1, storeId: 's1', name: 'منتج ٢' },
      { id: 'p3', companyId: C1, storeId: 's1', name: 'منتج ٣' },
    ],
    productionBatch: ['p1', 'p2', 'p3'].map((productId, i) => ({
      id: `b${i}`, companyId: C1, storeId: 's1', productId, batchNumber: `RCV-${i}`, quantityProduced: 50, quantitySold: 0, quantityRemaining: 50,
      quantityMovedIn: 0, quantityMovedOut: 0, costPerUnit: 2, productionDate: new Date('2026-10-01'), createdAt: new Date('2026-10-01'),
      status: 'COMPLETED', notes: null, warehouseId: 'wA', inTransitTransferId: null, splitFromBatchId: null,
    })),
  }) as never;
});

describe('who hears that a transfer is coming — persons built as a session builds them', () => {
  it('every holder of the receive key who stands in the store and reaches the destination; nobody else', async () => {
    await as('u-sender');
    expect((await send([{ productId: 'p1', quantity: 7 }])).status).toBe(201);
    await settle();
    // the owner (full access) · a receive role · a personal ALLOW on a send role
    expect(toldIds()).toEqual(['u-owner', 'u-plus', 'u-receiver']);
  });

  it('NEGATIVE: the sender herself, a personal DENY, a key next door, a legacy keeper, another store, another country, a suspended account, another company', async () => {
    await as('u-sender');
    await send([{ productId: 'p1', quantity: 7 }]);
    await settle();
    for (const who of ['u-sender', 'u-denied', 'u-approver', 'u-legacy-wh', 'u-other-store', 'u-other-country', 'u-gone', 'u-other-co']) {
      expect(toldIds(), who).not.toContain(who);
    }
  });

  it('NEGATIVE: a keeper confined to the SOURCE warehouse is not told — she cannot receive at the destination', async () => {
    await as('u-sender');
    await send([{ productId: 'p1', quantity: 7 }]);
    await settle();
    expect(toldIds()).not.toContain('u-keeper-a');
  });

  it('when the destination has named keepers who may receive, only they are told — not the owner, not a company-wide receiver', async () => {
    S.m.data.userWarehouseAccess.push({ userId: 'u-receiver', warehouseId: 'wB' });
    await as('u-sender');
    await send([{ productId: 'p1', quantity: 7 }]);
    await settle();
    expect(toldIds()).toEqual(['u-receiver']);
  });

  it('a keeper of the destination WITHOUT the receive key does not narrow it to nobody', async () => {
    S.m.data.userWarehouseAccess.push({ userId: 'u-approver', warehouseId: 'wB' });
    await as('u-sender');
    await send([{ productId: 'p1', quantity: 7 }]);
    await settle();
    expect(toldIds()).toEqual(['u-owner', 'u-plus', 'u-receiver']);
  });

  it('each is told once, with a link to the transfers screen', async () => {
    await as('u-sender');
    await send([{ productId: 'p1', quantity: 7 }]);
    await settle();
    expect(S.told).toHaveLength(3);
    for (const n of S.told) {
      expect(n.link).toBe('/inventory/transfers');
      expect(n.storeId).toBe('s1');
      expect(n.companyId).toBe(C1);
    }
  });
});

describe('the receipt stays blind', () => {
  it('one product of 7 units: «صنف واحد», the source by name, and no figure at all', async () => {
    await as('u-sender');
    await send([{ productId: 'p1', quantity: 7 }]);
    await settle();
    const n = S.told[0];
    expect(n.message).toContain('من مخزن الشمال');
    expect(n.message).toContain('صنف واحد');
    expect(`${n.title} ${n.message}`).not.toMatch(/\d/);
  });

  it('three products of 13, 9 and 21 units: «3 أصناف» — the line count is the only number, never a sent quantity nor their sum', async () => {
    await as('u-sender');
    await send([
      { productId: 'p1', quantity: 13 },
      { productId: 'p2', quantity: 9 },
      { productId: 'p3', quantity: 21 },
    ]);
    await settle();
    for (const n of S.told) {
      const text = `${n.title} ${n.message}`;
      expect(text.match(/\d+/g)).toEqual(['3']);
      expect(text).toContain('3 أصناف');
    }
  });

  it('the words take a count of lines only; Arabic agrees with the number', () => {
    expect([1, 2, 3, 10, 11].map(productsAr)).toEqual(['صنف واحد', 'صنفين', '3 أصناف', '10 أصناف', '11 صنفاً']);
    expect(transferSentWords('مخزن الشمال', 2).message).toContain('من مخزن الشمال فيه صنفين');
    expect(transferSentWords('الشمال', 2).message).toContain('من مخزن الشمال فيه صنفين');
    expect(transferSentWords(null, 1).message).toContain('من مخزن تاني');
    expect(transferSentWords('الشمال', 1).title).not.toMatch(/[A-Za-z]/);
  });
});

describe('a notice never changes what the send did', () => {
  it('NEGATIVE: a replay of the same send tells nobody again', async () => {
    await as('u-sender');
    const id = uuid();
    expect((await send([{ productId: 'p1', quantity: 7 }], id)).status).toBe(201);
    await settle();
    const first = S.told.length;
    expect((await send([{ productId: 'p1', quantity: 7 }], id)).status).toBe(200);
    await settle();
    expect(S.told).toHaveLength(first);
  });

  it('NEGATIVE: a refused send (no key) tells nobody', async () => {
    await as('u-receiver');
    expect((await send([{ productId: 'p1', quantity: 7 }])).status).toBe(403);
    await settle();
    expect(S.told).toEqual([]);
  });

  it('NEGATIVE: a refused send (more than the source holds) tells nobody', async () => {
    await as('u-sender');
    expect((await send([{ productId: 'p1', quantity: 500 }])).status).toBeGreaterThanOrEqual(400);
    await settle();
    expect(S.told).toEqual([]);
  });

  it('a notifications table that fails does not fail the send — the transfer is on the road all the same', async () => {
    S.notifyFails = true;
    await as('u-sender');
    expect((await send([{ productId: 'p1', quantity: 7 }])).status).toBe(201);
    await settle();
    expect(S.m.data.stockTransfer).toHaveLength(1);
    expect(S.m.data.stockTransfer[0].status).toBe('SENT');
  });

  it('the lib answers 0, not an error, for a destination it cannot find', async () => {
    const n = await announceTransferSent(C1, { id: 't', storeId: 's1', fromWarehouseId: 'wA', toWarehouseId: 'nowhere', sentById: 'u-sender', lines: [{}] });
    expect(n).toBe(0);
    expect(S.told).toEqual([]);
  });
});
