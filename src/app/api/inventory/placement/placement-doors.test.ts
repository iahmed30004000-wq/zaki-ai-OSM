import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * THE PLACEMENT DOORS — GET/POST /api/inventory/placement and POST /api/inventory/placement/preview.
 *
 * People are built the way a session builds them: `computeEffectiveGrants` over role rows, personal overrides (ALLOW and
 * DENY) and roleId-null legacy accounts, and the REAL `can` decides every door. The database is a small in-memory one
 * with its own `where`, so which rows count — the company, the country, the keeper's warehouses — is judged by the code
 * under test. Only the tables a placement may touch exist in it: a movement or a wallet asked for throws.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- an in-memory table row; every field is read by name
type Row = Record<string, any>;
const S = vi.hoisted(() => ({
  current: null as unknown as SessionUser,
  storeId: 's-sy',
  data: {} as Record<string, Row[]>,
  rolePerms: {} as Record<string, string[]>,
  overrides: {} as Record<string, { permission: string; effect: 'ALLOW' | 'DENY' }[]>,
  audit: [] as Row[],
  seq: 0,
}));

vi.mock('@/lib/db', () => {
  const scalar = (v: unknown, c: unknown): boolean => {
    if (c === null) return v === null || v === undefined;
    if (c && typeof c === 'object' && !Array.isArray(c) && !(c instanceof Date)) {
      const o = c as Row;
      if ('in' in o && !(o.in as unknown[]).includes(v)) return false;
      if ('notIn' in o && (o.notIn as unknown[]).includes(v)) return false;
      if ('not' in o && (o.not === null ? v === null || v === undefined : v === o.not)) return false;
      if ('gt' in o && !((v as number) > o.gt)) return false;
      return true;
    }
    return v === c;
  };
  const matches = (t: string, r: Row, w: Row = {}): boolean =>
    Object.entries(w).every(([k, c]) => {
      if (c === undefined) return true;
      if (k === 'OR') return (c as Row[]).some((x) => matches(t, r, x));
      if (k === 'order') {
        const o = (S.data.order ?? []).find((x) => x.id === r.orderId);
        return !!o && matches('order', o, c as Row);
      }
      return scalar(r[k], c);
    });
  const pick = (r: Row, select?: Row) => (select ? Object.fromEntries(Object.keys(select).filter((k) => select[k] === true).map((k) => [k, r[k]])) : { ...r });
  const t = (name: string) => {
    const rows = () => (S.data[name] ??= []);
    return {
      findMany: async ({ where, select }: Row = {}) => rows().filter((r) => matches(name, r, where)).map((r) => pick(r, select)),
      findFirst: async ({ where, select }: Row = {}) => {
        const r = rows().find((x) => matches(name, x, where));
        return r ? pick(r, select) : null;
      },
      findUnique: async ({ where, select }: Row) => {
        const r = rows().find((x) => matches(name, x, where));
        return r ? pick(r, select) : null;
      },
      create: async ({ data }: Row) => {
        if (name === 'warehousePlacement' && rows().some((r) => r.storeId === data.storeId)) throw new Error('unique');
        const row = { id: `${name}${++S.seq}`, createdAt: new Date(), ...data };
        rows().push(row);
        return { ...row };
      },
      updateMany: async ({ where, data }: Row) => {
        const hit = rows().filter((r) => matches(name, r, where));
        for (const r of hit) {
          for (const [k, v] of Object.entries(data)) {
            if (v && typeof v === 'object' && 'increment' in (v as Row)) r[k] += (v as Row).increment;
            else if (v && typeof v === 'object' && 'decrement' in (v as Row)) r[k] -= (v as Row).decrement;
            else r[k] = v;
          }
        }
        return { count: hit.length };
      },
      groupBy: async ({ by, where, _sum }: Row) => {
        const g = new Map<string, Row>();
        for (const r of rows().filter((x) => matches(name, x, where))) {
          const key = r[by[0]];
          const e = g.get(key) ?? { [by[0]]: key, _sum: { reservedQty: 0 } };
          e._sum.reservedQty += r.reservedQty;
          g.set(key, e);
          void _sum;
        }
        return [...g.values()];
      },
    };
  };
  const names = ['country', 'store', 'user', 'product', 'productVariant', 'productionBatch', 'order', 'orderItem', 'orderAddOn', 'warehouse', 'warehousePlacement', 'userCountryAccess', 'userWarehouseAccess'];
  const db: Row = Object.fromEntries(names.map((n) => [n, t(n)]));
  db.userStoreAccess = {
    findMany: async ({ where }: Row) =>
      (S.data.userStoreAccess ?? []).filter((r) => matches('userStoreAccess', r, where)).map((r) => ({ store: { countryId: (S.data.store ?? []).find((s) => s.id === r.storeId)?.countryId } })),
  };
  db.rolePermission = {
    findMany: async ({ where }: Row) => (where.roleId ? S.rolePerms[where.roleId] ?? [] : S.rolePerms[`template:${where.role?.name}`] ?? []).map((permission) => ({ permission, scope: 'ALL_COMPANY', scopeIds: null })),
  };
  db.userPermission = { findMany: async ({ where }: Row) => (S.overrides[where.userId] ?? []).map((o) => ({ ...o, scope: 'ALL_COMPANY', scopeIds: null })) };
  db.$executeRaw = async () => 1;
  const tx = new Proxy(db, {
    get(target, prop) {
      if (typeof prop === 'string' && !(prop in target) && prop !== 'then') throw new Error(`the placement touched «${prop}»`);
      return target[prop as string];
    },
  });
  db.$transaction = async (fn: (t: Row) => unknown) => fn(new Proxy(tx, { has: (o, p) => p !== '$transaction' && p in o }));
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
vi.mock('@/lib/audit', () => ({ logAudit: async (e: Row) => void S.audit.push(e) }));

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import * as door from './route';
import * as preview from './preview/route';

const C1 = 'c1';
const SY = 'k-sy';
const JO = 'k-jo';

async function as(id: string) {
  const u = S.data.user.find((x) => x.id === id)!;
  S.current = attachGrants({ ...u, permissions: [] } as unknown as SessionUser, await computeEffectiveGrants({ id: u.id, role: u.role, roleId: u.roleId ?? null }));
}

const post = async (body: unknown) => {
  const res = await door.POST(new Request('http://x/api/inventory/placement', { method: 'POST', body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};
const ask = async (counts: unknown) => {
  const res = await preview.POST(new Request('http://x/api/inventory/placement/preview', { method: 'POST', body: JSON.stringify({ counts }) }));
  return { status: res.status, body: await res.json() };
};
const get = async () => {
  const res = await door.GET();
  return { status: res.status, body: await res.json() };
};
const place = (counts: unknown) => ({ countedByName: 'أمين المخزن', countedAt: '2026-11-01T10:00:00.000Z', counts });
const EXACT = [
  { warehouseId: 'w-sy1', lines: [{ productId: 'p1', quantity: 6 }] },
  { warehouseId: 'w-sy2', lines: [{ productId: 'p1', quantity: 4 }, { productId: 'p2', quantity: 3 }] },
];

beforeEach(() => {
  S.seq = 0;
  S.audit = [];
  S.storeId = 's-sy';
  S.rolePerms = {
    'r-admin': ['geo.view', 'inventory.view', 'inventory.adjust'],
    'r-viewer': ['inventory.view'],
    'r-keeper': ['inventory.view', 'inventory.adjust', 'ops.prepare'],
    'r-finance': ['finance.view', 'wallets.manage'],
    // The system template a roleId-null WAREHOUSE account inherits (`dbGrantSource.roleRows`).
    'template:WAREHOUSE': ['inventory.view', 'inventory.adjust', 'ops.prepare'],
  };
  S.overrides = { 'u-denied': [{ permission: 'inventory.adjust', effect: 'DENY' }], 'u-plus': [{ permission: 'inventory.adjust', effect: 'ALLOW' }] };
  S.data = {
    country: [
      { id: SY, companyId: C1, isActive: true },
      { id: JO, companyId: C1, isActive: true },
    ],
    store: [
      { id: 's-sy', companyId: C1, countryId: SY },
      { id: 's-jo', companyId: C1, countryId: JO },
    ],
    user: [
      { id: 'u-owner', name: 'المالك', role: 'SUPER_ADMIN', roleId: null, status: 'ACTIVE', companyId: C1 },
      { id: 'u-admin', name: 'مدير', role: 'CUSTOM', roleId: 'r-admin', status: 'ACTIVE', companyId: C1 },
      { id: 'u-legacy-wh', name: 'مخزن قديم', role: 'WAREHOUSE', roleId: null, status: 'ACTIVE', companyId: C1 },
      { id: 'u-viewer', name: 'مشاهد', role: 'CUSTOM', roleId: 'r-viewer', status: 'ACTIVE', companyId: C1 },
      { id: 'u-keeper', name: 'أمينة', role: 'CUSTOM', roleId: 'r-keeper', status: 'ACTIVE', companyId: C1 },
      { id: 'u-denied', name: 'ممنوع', role: 'CUSTOM', roleId: 'r-admin', status: 'ACTIVE', companyId: C1 },
      { id: 'u-plus', name: 'زيادة', role: 'CUSTOM', roleId: 'r-viewer', status: 'ACTIVE', companyId: C1 },
      { id: 'u-finance', name: 'مالية', role: 'CUSTOM', roleId: 'r-finance', status: 'ACTIVE', companyId: C1 },
    ],
    userCountryAccess: ['u-admin', 'u-legacy-wh', 'u-viewer', 'u-keeper', 'u-denied', 'u-plus', 'u-finance'].map((userId) => ({ userId, countryId: SY })),
    userStoreAccess: [],
    userWarehouseAccess: [{ userId: 'u-keeper', warehouseId: 'w-sy1' }],
    warehouse: [
      { id: 'w-sy1', companyId: C1, countryId: SY, name: 'الرئيسي', isActive: true },
      { id: 'w-sy2', companyId: C1, countryId: SY, name: 'الفرع', isActive: true },
      { id: 'w-sy-off', companyId: C1, countryId: SY, name: 'القديم', isActive: false },
      { id: 'w-jo1', companyId: C1, countryId: JO, name: 'عمّان', isActive: true },
      { id: 'w-c2', companyId: 'c2', countryId: SY, name: 'غريب', isActive: true },
    ],
    warehousePlacement: [],
    product: [
      { id: 'p1', companyId: C1, storeId: 's-sy', name: 'زيت', sku: 'A1' },
      { id: 'p2', companyId: C1, storeId: 's-sy', name: 'كريم', sku: 'A2' },
      { id: 'p-jo', companyId: C1, storeId: 's-jo', name: 'غريب', sku: 'J1' },
    ],
    productVariant: [],
    productionBatch: [
      { id: 'b1', companyId: C1, storeId: 's-sy', productId: 'p1', batchNumber: 'R1', quantityProduced: 10, quantitySold: 0, quantityRemaining: 10, quantityMovedIn: 0, quantityMovedOut: 0, costPerUnit: 2, productionDate: new Date('2026-10-01'), createdAt: new Date('2026-10-01'), status: 'COMPLETED', notes: null, warehouseId: null, inTransitTransferId: null, splitFromBatchId: null },
      { id: 'b2', companyId: C1, storeId: 's-sy', productId: 'p2', batchNumber: 'R2', quantityProduced: 5, quantitySold: 0, quantityRemaining: 5, quantityMovedIn: 0, quantityMovedOut: 0, costPerUnit: 3, productionDate: new Date('2026-10-02'), createdAt: new Date('2026-10-02'), status: 'COMPLETED', notes: null, warehouseId: null, inTransitTransferId: null, splitFromBatchId: null },
    ],
    // Two units of p2 are in a courier's van.
    order: [{ id: 'o1', storeId: 's-sy', confirmationStatus: 'CONFIRMED', shippingStatus: 'SHIPPED', shippedAt: new Date(), labelPrintedAt: new Date() }],
    orderItem: [{ id: 'i1', orderId: 'o1', companyId: C1, productId: 'p2', reservedQty: 2 }],
    orderAddOn: [],
  };
});

describe('who may open the doors — persons built as a session builds them', () => {
  it('the owner, a role with inventory.adjust, and a legacy WAREHOUSE account (roleId null, read through the system template of its name) may place', async () => {
    for (const who of ['u-owner', 'u-admin', 'u-legacy-wh']) {
      S.data.warehousePlacement = [];
      for (const b of S.data.productionBatch) Object.assign(b, { warehouseId: null, quantityMovedOut: 0, quantityRemaining: b.quantityProduced });
      S.data.productionBatch = S.data.productionBatch.filter((b) => !b.splitFromBatchId);
      await as(who);
      const { status, body } = await post(place(EXACT));
      expect(status, `${who} ${JSON.stringify(body)}`).toBe(201);
      expect(body.totals).toEqual({ 'w-sy1': 6, 'w-sy2': 7 });
    }
  });

  it('NEGATIVE: inventory.view alone, a personal DENY of inventory.adjust, and a finance role are refused the press', async () => {
    for (const who of ['u-viewer', 'u-denied', 'u-finance']) {
      await as(who);
      const { status } = await post(place(EXACT));
      expect(status, who).toBe(403);
    }
    expect(S.data.warehousePlacement).toEqual([]);
  });

  it('a personal ALLOW of inventory.adjust on a view-only role opens the press', async () => {
    await as('u-plus');
    expect((await post(place(EXACT))).status).toBe(201);
  });

  it('NEGATIVE: the finance role may not even look (no inventory.view)', async () => {
    await as('u-finance');
    expect((await get()).status).toBe(403);
    expect((await ask([])).status).toBe(403);
  });
});

describe('GET — the table to count against, and then «placed»', () => {
  it('before: the store’s running warehouses she reaches and, per product, on hand · with the courier · to place', async () => {
    await as('u-admin');
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.placed).toBe(false);
    expect(body.warehouses.map((w: Row) => w.id).sort()).toEqual(['w-sy1', 'w-sy2']);
    expect(body.rows.map((r: Row) => [r.productId, r.onHand, r.withCourier, r.toPlace])).toEqual([
      ['p1', 10, 0, 10],
      ['p2', 5, 2, 3],
    ]);
    expect(body.variantsNote).toMatch(/الخيارات/);
  });

  it('a keeper sees only the warehouse she keeps', async () => {
    await as('u-keeper');
    expect((await get()).body.warehouses.map((w: Row) => w.id)).toEqual(['w-sy1']);
  });

  it('after: placed, with who counted — and no table', async () => {
    await as('u-admin');
    await post(place(EXACT));
    const { body } = await get();
    expect(body).toMatchObject({ placed: true, placement: { countedByName: 'أمين المخزن' } });
    expect(body.rows).toBeUndefined();
  });
});

describe('POST — the press', () => {
  it('places every unit not with the courier, writes the placement and an audit line, and nothing else', async () => {
    await as('u-admin');
    const { status, body } = await post(place(EXACT));
    expect(status).toBe(201);
    expect(S.data.warehousePlacement).toHaveLength(1);
    expect(S.data.warehousePlacement[0]).toMatchObject({ companyId: C1, storeId: 's-sy', countedByName: 'أمين المخزن', recordedById: 'u-admin' });
    const at = (w: string | null) => S.data.productionBatch.filter((b) => b.warehouseId === w).reduce((s, b) => s + b.quantityRemaining, 0);
    expect([at('w-sy1'), at('w-sy2'), at(null)]).toEqual([6, 7, 2]);
    expect(S.audit.map((a) => [a.action, a.newData.perWarehouse])).toEqual([['STOCK_PLACED_IN_WAREHOUSES', { 'w-sy1': 6, 'w-sy2': 7 }]]);
    expect(body.rows.every((r: Row) => r.difference === 0)).toBe(true);
  });

  it('NEGATIVE: a count off by one — 409 with the products and the recount sentence; nothing written', async () => {
    await as('u-admin');
    const { status, body } = await post(place([{ warehouseId: 'w-sy1', lines: [{ productId: 'p1', quantity: 10 }, { productId: 'p2', quantity: 4 }] }]));
    expect(status).toBe(409);
    expect(body.code).toBe('NOT_EXACT');
    expect(body.errorAr).toContain('اجرد هالمنتجات من «جرد المتاح» أول، وبعدين وزّع');
    expect(body.differing.map((d: Row) => [d.productId, d.toPlace, d.counted])).toEqual([['p2', 3, 4]]);
    expect(S.data.warehousePlacement).toEqual([]);
    expect(S.data.productionBatch.every((b) => b.warehouseId === null)).toBe(true);
    expect(S.audit).toEqual([]);
  });

  it('NEGATIVE: a second press — 409, and the first placement stands alone', async () => {
    await as('u-admin');
    await post(place(EXACT));
    const again = await post(place(EXACT));
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_PLACED');
    expect(S.data.warehousePlacement).toHaveLength(1);
  });

  it('NEGATIVE: a keeper naming a warehouse she does not keep — 403 before anything is read', async () => {
    await as('u-keeper');
    const { status, body } = await post(place(EXACT));
    expect(status).toBe(403);
    expect(body.code).toBe('WAREHOUSE_NOT_REACHED');
    expect(body.errorAr).toMatch(/[؀-ۿ]/);
  });

  it('NEGATIVE: a warehouse of another company — not found; of another country — refused by name; a stopped one — refused', async () => {
    await as('u-owner');
    expect((await post(place([{ warehouseId: 'w-c2', lines: [] }]))).body.code).toBe('WAREHOUSE_NOT_FOUND');
    expect((await post(place([{ warehouseId: 'w-jo1', lines: [] }]))).body.code).toBe('WAREHOUSE_OTHER_COUNTRY');
    expect((await post(place([{ warehouseId: 'w-sy-off', lines: [] }]))).body.code).toBe('WAREHOUSE_STOPPED');
  });

  it('NEGATIVE: another store’s product — refused; a body with no counter — refused in Arabic', async () => {
    await as('u-admin');
    expect((await post(place([{ warehouseId: 'w-sy1', lines: [{ productId: 'p-jo', quantity: 1 }] }]))).body.code).toBe('PRODUCT_NOT_IN_STORE');
    const bad = await post({ countedByName: '', countedAt: '2026-11-01T10:00:00.000Z', counts: EXACT });
    expect(bad.status).toBe(400);
    expect(bad.body.errorAr).toMatch(/[؀-ۿ]/);
  });
});

describe('POST preview — the same table, nothing written', () => {
  it('exact counts: exact, the per-warehouse totals, no write', async () => {
    await as('u-viewer');
    const { status, body } = await ask(EXACT);
    expect(status).toBe(200);
    expect(body).toMatchObject({ exact: true, totals: { 'w-sy1': 6, 'w-sy2': 7 }, differing: [] });
    expect(body.messageAr).toBeUndefined();
    expect(S.data.warehousePlacement).toEqual([]);
    expect(S.data.productionBatch.every((b) => b.warehouseId === null)).toBe(true);
  });

  it('counts that disagree: the differing rows and the sentence the press would answer with', async () => {
    await as('u-viewer');
    const { body } = await ask([{ warehouseId: 'w-sy1', lines: [{ productId: 'p1', quantity: 9 }] }]);
    expect(body.exact).toBe(false);
    expect(body.differing.map((d: Row) => d.productId)).toEqual(['p1', 'p2']);
    expect(body.messageAr).toContain('«جرد المتاح»');
  });

  it('NEGATIVE: a keeper previewing a warehouse she does not keep — 403', async () => {
    await as('u-keeper');
    expect((await ask(EXACT)).status).toBe(403);
  });
});
