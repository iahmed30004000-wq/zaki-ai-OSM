import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * A PLACED STORE RECEIVES AND PRODUCES INTO A NAMED WAREHOUSE (the warehouse plan, W2a).
 *
 *   - «استلام بضاعة جاهزة» (`POST /api/inventory`, action receive) and «تشغيلة إنتاج» (`POST /api/production`) of a store
 *     with a placement REQUIRE a warehouse: of the store's company and country, running, and one the caller reaches. The
 *     batch AND the movement carry it.
 *   - The production run's two writes are ONE transaction.
 *   - Every draw leaves units on the road (`inTransitTransferId`) alone.
 *   - The recount and the opening count of a placed store are refused by name (the count by warehouse is W2b).
 *   - The stop of a warehouse and a receipt into it cannot cross; nor can the placement and a receipt.
 *
 * People are built the way a session builds them: `computeEffectiveGrants` over role rows, personal overrides and a
 * roleId-null legacy account, and the REAL `can` and `reachesWarehouse` decide. The database is in-memory and applies the
 * `where` it is handed; it logs every statement in order, so «the lock before the read» is a fact read off the log.
 * Totals asserted here are summed from the rows directly — never through the functions under test.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- an in-memory row; every field is read by name
type Row = Record<string, any>;
const S = vi.hoisted(() => ({
  current: null as unknown as SessionUser,
  storeId: 's-sy',
  data: {} as Record<string, Row[]>,
  rolePerms: {} as Record<string, string[]>,
  overrides: {} as Record<string, { permission: string; effect: 'ALLOW' | 'DENY' }[]>,
  audit: [] as Row[],
  log: [] as Row[],
  seq: 0,
  onLock: null as null | (() => void),
}));

vi.mock('@/lib/db', () => {
  const scalar = (v: unknown, c: unknown): boolean => {
    if (c === null) return v === null || v === undefined;
    if (c instanceof Date) return v instanceof Date && v.getTime() === c.getTime();
    if (c && typeof c === 'object' && !Array.isArray(c)) {
      const o = c as Row;
      if ('in' in o && !(o.in as unknown[]).includes(v)) return false;
      if ('not' in o && (o.not === null ? v === null || v === undefined : v === o.not)) return false;
      if ('gt' in o && !((v as number) > o.gt)) return false;
      if ('startsWith' in o && !(typeof v === 'string' && v.startsWith(o.startsWith))) return false;
      return true;
    }
    return v === c;
  };
  const matches = (r: Row, w: Row = {}): boolean =>
    Object.entries(w).every(([k, c]) => {
      if (c === undefined) return true;
      if (k === 'OR') return (c as Row[]).some((x) => matches(r, x));
      if (k === 'companyId_batchNumber') return matches(r, c as Row);
      return scalar(r[k], c);
    });
  const pick = (r: Row, select?: Row) => (select ? Object.fromEntries(Object.keys(select).filter((k) => select[k] === true).map((k) => [k, r[k]])) : { ...r });
  const sortBy = (rows: Row[], orderBy?: Row | Row[]) => {
    if (!orderBy) return rows;
    const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((o) => Object.entries(o));
    return [...rows].sort((a, b) => {
      for (const [k, dir] of keys) {
        const x = a[k] instanceof Date ? a[k].getTime() : a[k];
        const y = b[k] instanceof Date ? b[k].getTime() : b[k];
        if (x < y) return dir === 'desc' ? 1 : -1;
        if (x > y) return dir === 'desc' ? -1 : 1;
      }
      return 0;
    });
  };
  const make = (inTx: boolean) => {
    const t = (name: string) => {
      const rows = () => (S.data[name] ??= []);
      const note = (op: string, extra: Row = {}) => S.log.push({ t: name, op, inTx, ...extra });
      return {
        findMany: async ({ where, select, orderBy }: Row = {}) => {
          note('read');
          return sortBy(rows().filter((r) => matches(r, where)), orderBy).map((r) => pick(r, select));
        },
        findFirst: async ({ where, select, orderBy }: Row = {}) => {
          note('read');
          const r = sortBy(rows().filter((x) => matches(x, where)), orderBy)[0];
          return r ? pick(r, select) : null;
        },
        findUnique: async ({ where, select }: Row) => {
          note('read');
          const r = rows().find((x) => matches(x, where));
          return r ? pick(r, select) : null;
        },
        count: async ({ where }: Row = {}) => {
          note('count');
          return rows().filter((r) => matches(r, where)).length;
        },
        aggregate: async ({ where, _sum }: Row) => {
          note('read');
          const hit = rows().filter((x) => matches(x, where));
          return { _sum: Object.fromEntries(Object.keys(_sum).map((k) => [k, hit.length ? hit.reduce((s, r) => s + r[k], 0) : null])) };
        },
        create: async ({ data, select }: Row) => {
          note('write', { data });
          const row = { id: `${name}-${++S.seq}`, createdAt: new Date(), ...data };
          rows().push(row);
          return pick(row, select);
        },
        update: async ({ where, data }: Row) => {
          note('write', { data });
          const r = rows().find((x) => matches(x, where));
          if (!r) {
            const { Prisma } = await import('@prisma/client');
            throw new Prisma.PrismaClientKnownRequestError('No record was found for an update.', { code: 'P2025', clientVersion: 'test' });
          }
          Object.assign(r, data);
          return { ...r };
        },
        updateMany: async ({ where, data }: Row) => {
          note('write', { data });
          const hit = rows().filter((r) => matches(r, where));
          for (const r of hit) Object.assign(r, data);
          return { count: hit.length };
        },
      };
    };
    const names = ['country', 'store', 'user', 'product', 'productionBatch', 'inventoryMovement', 'warehouse', 'warehousePlacement', 'userCountryAccess', 'userWarehouseAccess', 'stockOpeningCount', 'stockTransfer', 'stockExit'];
    // 20/11 (W6a): 'stockExit' — the stop door also counts PENDING exits from the warehouse; none exist here (0, today's answer).
    // 20/11 (W3a): 'stockTransfer' — the stop door also counts OPEN transfers from or to the warehouse; none exist here (0, today's answer).
    const c: Row = Object.fromEntries(names.map((n) => [n, t(n)]));
    c.userStoreAccess = {
      findMany: async ({ where }: Row) =>
        (S.data.userStoreAccess ?? []).filter((r) => matches(r, where)).map((r) => ({ store: { countryId: (S.data.store ?? []).find((s) => s.id === r.storeId)?.countryId } })),
    };
    c.rolePermission = {
      findMany: async ({ where }: Row) => (where.roleId ? S.rolePerms[where.roleId] ?? [] : S.rolePerms[`template:${where.role?.name}`] ?? []).map((permission) => ({ permission, scope: 'ALL_COMPANY', scopeIds: null })),
    };
    c.userPermission = { findMany: async ({ where }: Row) => (S.overrides[where.userId] ?? []).map((o) => ({ ...o, scope: 'ALL_COMPANY', scopeIds: null })) };
    c.$executeRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      S.log.push({ t: 'raw', op: /pg_advisory_xact_lock/.test(sql) ? 'stock-lock' : /FOR UPDATE/.test(sql) ? 'warehouse-for-update' : 'raw', inTx, values });
      if (S.onLock && /pg_advisory_xact_lock/.test(sql)) {
        const h = S.onLock;
        S.onLock = null;
        h();
      }
      return 1;
    };
    c.$queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      S.log.push({ t: 'raw', op: /FOR SHARE/.test(sql) ? 'warehouse-for-share' : 'raw', inTx, values });
      return (S.data.warehouse ?? []).filter((w) => w.id === values[0]).map((w) => ({ id: w.id, companyId: w.companyId, countryId: w.countryId, isActive: w.isActive }));
    };
    return c;
  };
  const db = make(false);
  const tx = make(true);
  db.$transaction = async (fn: (t: Row) => unknown) => fn(tx);
  return { db };
});

vi.mock('@/lib/geo-context', async (orig) => {
  const real = await orig<typeof import('@/lib/geo-context')>();
  return { ...real, requireContext: async () => ({ user: S.current, companyId: (S.current as Row).companyId, storeId: S.storeId, country: { currencyCode: 'SYP' } }) };
});
vi.mock('@/lib/auth', () => ({ requireCompanyTenant: async () => ({ user: S.current, companyId: (S.current as Row).companyId }) }));
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
vi.mock('@/lib/reservation', async (orig) => ({ ...(await orig<typeof import('@/lib/reservation')>()), reservedElsewhere: async () => 0 }));

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { db } from '@/lib/db';
import { POST as inventoryPOST } from './route';
import { POST as productionPOST } from '@/app/api/production/route';
import { PATCH as warehousePATCH } from '@/app/api/geo/warehouses/[id]/route';
import { drawDownStock, receiveStock } from '@/lib/receiving';
import { OpeningStockRefused, recordOpeningStockCount } from '@/lib/stock-opening-count';

const C1 = 'c1';
const SY = 'k-sy';
const JO = 'k-jo';
const BUY = 'p-buy-000000001';
const MADE = 'p-made-00000001';
const BUY_UNPLACED = 'p-buy-unplaced1';

async function as(id: string) {
  const u = S.data.user.find((x) => x.id === id)!;
  S.current = attachGrants({ ...u, permissions: [] } as unknown as SessionUser, await computeEffectiveGrants({ id: u.id, role: u.role, roleId: u.roleId ?? null }));
}
const call = async (res: Promise<Response>) => {
  const r = await res;
  return { status: r.status, body: await r.json() };
};
const receive = (body: Row) => call(inventoryPOST(new Request('http://x/api/inventory', { method: 'POST', body: JSON.stringify({ action: 'receive', ...body }) })));
const recount = (body: Row) => call(inventoryPOST(new Request('http://x/api/inventory', { method: 'POST', body: JSON.stringify({ action: 'recount', ...body }) })));
const produce = (body: Row) => call(productionPOST(new Request('http://x/api/production', { method: 'POST', body: JSON.stringify(body) })));
const stop = (id: string) =>
  call(warehousePATCH(new Request(`http://x/api/geo/warehouses/${id}`, { method: 'PATCH', body: JSON.stringify({ isActive: false }) }), { params: Promise.resolve({ id }) }));

function batch(id: string, productId: string, storeId: string, remaining: number, cost: number, place: Row, day: number): Row {
  return {
    id, companyId: C1, storeId, productId, batchNumber: `R-${id}`, quantityProduced: remaining, quantitySold: 0, quantityRemaining: remaining,
    quantityMovedIn: 0, quantityMovedOut: 0, costPerUnit: cost, totalProductionCost: cost * remaining,
    productionDate: new Date(Date.UTC(2026, 9, day)), createdAt: new Date(Date.UTC(2026, 9, day)), status: 'COMPLETED', notes: null,
    warehouseId: null, inTransitTransferId: null, splitFromBatchId: null, ...place,
  };
}

/** Per product, straight from the rows: Σ remaining, Σ produced, Σ sold, Σ remaining × cost. */
function book(productId: string) {
  const rows = S.data.productionBatch.filter((b) => b.productId === productId);
  return {
    remaining: rows.reduce((s, b) => s + b.quantityRemaining, 0),
    produced: rows.reduce((s, b) => s + b.quantityProduced, 0),
    sold: rows.reduce((s, b) => s + b.quantitySold, 0),
    value: rows.reduce((s, b) => s + b.quantityRemaining * b.costPerUnit, 0),
  };
}
const writes = () => S.log.filter((l) => l.op === 'write');

beforeEach(() => {
  S.seq = 0;
  S.audit = [];
  S.log = [];
  S.onLock = null;
  S.storeId = 's-sy';
  S.rolePerms = {
    'r-admin': ['inventory.view', 'inventory.adjust', 'production.view', 'production.manage'],
    'r-keeper': ['inventory.view', 'inventory.adjust', 'production.manage'],
    'r-viewer': ['inventory.view'],
    // The system template a roleId-null WAREHOUSE account inherits (`dbGrantSource.roleRows`).
    'template:WAREHOUSE': ['inventory.view', 'inventory.adjust', 'production.manage'],
  };
  S.overrides = {
    // geo.manage given by a personal ALLOW: «sees every country», so every warehouse of an open one.
    'u-geo': [{ permission: 'geo.manage', effect: 'ALLOW' }],
    // inventory.adjust taken away from somebody whose role has it.
    'u-denied': [{ permission: 'inventory.adjust', effect: 'DENY' }],
  };
  S.data = {
    country: [
      { id: SY, companyId: C1, isActive: true },
      { id: JO, companyId: C1, isActive: true },
    ],
    store: [
      { id: 's-sy', companyId: C1, countryId: SY },
      { id: 's-sy-unplaced', companyId: C1, countryId: SY },
    ],
    user: [
      { id: 'u-owner', name: 'المالك', role: 'SUPER_ADMIN', roleId: null, status: 'ACTIVE', companyId: C1 },
      { id: 'u-admin', name: 'مدير', role: 'CUSTOM', roleId: 'r-admin', status: 'ACTIVE', companyId: C1 },
      { id: 'u-keeper', name: 'أمينة', role: 'CUSTOM', roleId: 'r-keeper', status: 'ACTIVE', companyId: C1 },
      { id: 'u-legacy-wh', name: 'مخزن قديم', role: 'WAREHOUSE', roleId: null, status: 'ACTIVE', companyId: C1 },
      { id: 'u-geo', name: 'جغرافيا', role: 'CUSTOM', roleId: 'r-keeper', status: 'ACTIVE', companyId: C1 },
      { id: 'u-jo', name: 'عمّان', role: 'CUSTOM', roleId: 'r-admin', status: 'ACTIVE', companyId: C1 },
      { id: 'u-denied', name: 'ممنوع', role: 'CUSTOM', roleId: 'r-admin', status: 'ACTIVE', companyId: C1 },
    ],
    userCountryAccess: [
      ...['u-admin', 'u-keeper', 'u-legacy-wh', 'u-denied'].map((userId) => ({ userId, countryId: SY })),
      { userId: 'u-jo', countryId: JO },
    ],
    userStoreAccess: [],
    // She keeps the main warehouse — and only it. So does u-geo, whose geo.manage makes the row irrelevant.
    userWarehouseAccess: [
      { userId: 'u-keeper', warehouseId: 'w-sy1' },
      { userId: 'u-geo', warehouseId: 'w-sy1' },
    ],
    warehouse: [
      { id: 'w-sy1', companyId: C1, countryId: SY, name: 'الرئيسي', isActive: true },
      { id: 'w-sy2', companyId: C1, countryId: SY, name: 'الفرع', isActive: true },
      { id: 'w-sy-off', companyId: C1, countryId: SY, name: 'القديم', isActive: false },
      { id: 'w-jo1', companyId: C1, countryId: JO, name: 'عمّان', isActive: true },
      { id: 'w-c2', companyId: 'c2', countryId: SY, name: 'غريب', isActive: true },
    ],
    warehousePlacement: [{ id: 'pl1', companyId: C1, storeId: 's-sy', countedByName: 'أمين', countedAt: new Date('2026-11-01') }],
    product: [
      { id: BUY, companyId: C1, storeId: 's-sy', name: 'زيت', sourceType: 'PURCHASED' },
      { id: MADE, companyId: C1, storeId: 's-sy', name: 'كريم', sourceType: 'MANUFACTURED' },
      { id: BUY_UNPLACED, companyId: C1, storeId: 's-sy-unplaced', name: 'صابون', sourceType: 'PURCHASED' },
    ],
    productionBatch: [
      batch('b-w1', BUY, 's-sy', 5, 2.5, { warehouseId: 'w-sy1' }, 3),
      // Units on the road between two warehouses: the OLDEST row of the product, so a draw that forgot them would take them first.
      batch('b-road', BUY, 's-sy', 4, 2.5, { inTransitTransferId: 'tr-1', quantityProduced: 0, quantityMovedIn: 4, splitFromBatchId: 'b-w1' }, 1),
      batch('b-w2', BUY, 's-sy', 3, 3.1, { warehouseId: 'w-sy2' }, 5),
      batch('b-made', MADE, 's-sy', 2, 7, { warehouseId: 'w-sy1' }, 2),
      batch('b-un', BUY_UNPLACED, 's-sy-unplaced', 6, 1.2, {}, 2),
    ],
    inventoryMovement: [],
    stockOpeningCount: [],
  };
});

/* ───────────────────────── receiving ───────────────────────── */

describe('«استلام بضاعة جاهزة» of a placed store names its warehouse', () => {
  it('the batch and the movement carry the warehouse; the book moves by exactly what arrived', async () => {
    await as('u-admin');
    const before = book(BUY);
    const res = await receive({ productId: BUY, quantity: 7, unitCost: 2.75, warehouseId: 'w-sy2' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const created = writes().filter((w) => w.t === 'productionBatch' || w.t === 'inventoryMovement');
    expect(created.map((w) => [w.t, w.data.warehouseId, w.data.storeId, w.inTx])).toEqual([
      ['productionBatch', 'w-sy2', 's-sy', true],
      ['inventoryMovement', 'w-sy2', 's-sy', true],
    ]);
    const after = book(BUY);
    expect(after).toEqual({ remaining: before.remaining + 7, produced: before.produced + 7, sold: before.sold, value: before.value + 7 * 2.75 });
    // Nothing else moved: the other products' books are as they were.
    expect(book(MADE)).toEqual({ remaining: 2, produced: 2, sold: 0, value: 14 });
  });

  it('NEGATIVE: no warehouse — 400 in Arabic, nothing written', async () => {
    await as('u-admin');
    for (const body of [{}, { warehouseId: '' }, { warehouseId: null }, { warehouseId: 42 }]) {
      S.log = [];
      const res = await receive({ productId: BUY, quantity: 2, unitCost: 1, ...body });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'WAREHOUSE_REQUIRED', errorAr: expect.stringMatching(/اختار المخزن/) });
      expect(writes()).toEqual([]);
    }
  });

  it('NEGATIVE: a warehouse of another country, of another company, a stopped one, one that does not exist', async () => {
    await as('u-owner');
    const cases: [string, number, string][] = [
      ['w-jo1', 400, 'WAREHOUSE_OTHER_COUNTRY'],
      ['w-c2', 400, 'WAREHOUSE_NOT_FOUND'],
      ['w-nowhere', 400, 'WAREHOUSE_NOT_FOUND'],
      ['w-sy-off', 409, 'WAREHOUSE_STOPPED'],
    ];
    for (const [warehouseId, status, code] of cases) {
      S.log = [];
      const res = await receive({ productId: BUY, quantity: 2, unitCost: 1, warehouseId });
      expect([res.status, res.body.code], warehouseId).toEqual([status, code]);
      expect(typeof res.body.errorAr).toBe('string');
      expect(writes(), warehouseId).toEqual([]);
    }
  });

  it('NEGATIVE: a keeper outside her warehouses is refused (403); inside them she receives', async () => {
    await as('u-keeper');
    const out = await receive({ productId: BUY, quantity: 2, unitCost: 1, warehouseId: 'w-sy2' });
    expect([out.status, out.body.code]).toEqual([403, 'WAREHOUSE_NOT_REACHED']);
    expect(writes()).toEqual([]);
    const ok = await receive({ productId: BUY, quantity: 2, unitCost: 1, warehouseId: 'w-sy1' });
    expect(ok.status).toBe(200);
  });

  it('who reaches what, by the real grants: the owner, a role row, a legacy WAREHOUSE account, geo.manage by personal override', async () => {
    for (const [who, warehouseId] of [
      ['u-owner', 'w-sy2'],
      ['u-admin', 'w-sy2'],
      ['u-legacy-wh', 'w-sy2'],
      // A keeper row confines — unless the person sees every country (geo.manage, here a personal ALLOW).
      ['u-geo', 'w-sy2'],
    ]) {
      await as(who);
      const res = await receive({ productId: BUY, quantity: 1, unitCost: 1, warehouseId });
      expect(res.status, `${who} ${JSON.stringify(res.body)}`).toBe(200);
    }
  });

  it('NEGATIVE: somebody whose country is not the warehouse’s is refused; somebody whose key was denied never reaches the warehouse question', async () => {
    await as('u-jo');
    const jo = await receive({ productId: BUY, quantity: 1, unitCost: 1, warehouseId: 'w-sy1' });
    expect([jo.status, jo.body.code]).toEqual([403, 'WAREHOUSE_NOT_REACHED']);
    await as('u-denied');
    const denied = await receive({ productId: BUY, quantity: 1, unitCost: 1, warehouseId: 'w-sy1' });
    expect(denied.status).not.toBe(200);
    expect(writes()).toEqual([]);
  });

  it('a store that is NOT placed: the warehouse is not read, not checked, not written — and the reach is never asked', async () => {
    S.storeId = 's-sy-unplaced';
    await as('u-jo'); // reaches no warehouse of this country — and is not asked
    const res = await receive({ productId: BUY_UNPLACED, quantity: 3, unitCost: 1.2, warehouseId: 'w-sy-off' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const created = writes().filter((w) => w.t === 'productionBatch' || w.t === 'inventoryMovement');
    expect(created).toHaveLength(2);
    for (const w of created) expect('warehouseId' in w.data).toBe(false);
    expect(S.log.some((l) => l.op === 'warehouse-for-share')).toBe(false);
    expect(S.log.some((l) => l.t === 'userWarehouseAccess')).toBe(false);
  });

  it('THE PLACEMENT RACE: the product’s stock lock is taken BEFORE «placed?» is asked — a placement that commits while the receipt waits is seen', async () => {
    S.storeId = 's-sy-unplaced';
    await as('u-admin');
    // The placement commits while this receipt waits on the product's lock.
    S.onLock = () => S.data.warehousePlacement.push({ id: 'pl2', companyId: C1, storeId: 's-sy-unplaced' });
    const res = await receive({ productId: BUY_UNPLACED, quantity: 3, unitCost: 1.2 });
    expect([res.status, res.body.code]).toEqual([400, 'WAREHOUSE_REQUIRED']);
    expect(writes()).toEqual([]);
    const lock = S.log.findIndex((l) => l.op === 'stock-lock');
    const asked = S.log.findIndex((l) => l.t === 'warehousePlacement');
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(asked);
    expect(S.log[lock].inTx && S.log[asked].inTx).toBe(true);
  });

  it('THE STOP RACE: the receipt reads the warehouse FOR SHARE inside its transaction, before it writes', async () => {
    await as('u-admin');
    await receive({ productId: BUY, quantity: 1, unitCost: 1, warehouseId: 'w-sy1' });
    const share = S.log.findIndex((l) => l.op === 'warehouse-for-share');
    const firstWrite = S.log.findIndex((l) => l.op === 'write');
    expect(share).toBeGreaterThanOrEqual(0);
    expect(S.log[share].inTx).toBe(true);
    expect(S.log[share].values).toEqual(['w-sy1']);
    expect(share).toBeLessThan(firstWrite);
  });
});

/* ───────────────────────── the stop door ───────────────────────── */

describe('the stop of a warehouse and a receipt into it cannot cross', () => {
  it('the stop locks the row FOR UPDATE before it counts what the warehouse holds', async () => {
    await as('u-owner');
    S.data.productionBatch = S.data.productionBatch.filter((b) => b.warehouseId !== 'w-sy2');
    const res = await stop('w-sy2');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const lock = S.log.findIndex((l) => l.op === 'warehouse-for-update');
    const counted = S.log.findIndex((l) => l.t === 'productionBatch' && l.op === 'count');
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(S.log[lock].values).toEqual(['w-sy2']);
    expect(lock).toBeLessThan(counted);
  });

  it('a receipt that went first is units the stop counts: refused (409); a stop that went first is seen by the receipt: refused (409)', async () => {
    await as('u-owner');
    S.data.productionBatch = S.data.productionBatch.filter((b) => b.warehouseId !== 'w-sy2');
    expect((await receive({ productId: BUY, quantity: 2, unitCost: 1, warehouseId: 'w-sy2' })).status).toBe(200);
    expect((await stop('w-sy2')).status).toBe(409);
    S.data.warehouse.find((w) => w.id === 'w-sy2')!.isActive = false;
    const late = await receive({ productId: BUY, quantity: 2, unitCost: 1, warehouseId: 'w-sy2' });
    expect([late.status, late.body.code]).toEqual([409, 'WAREHOUSE_STOPPED']);
  });
});

/* ───────────────────────── production ───────────────────────── */

describe('«تشغيلة إنتاج» of a placed store names its warehouse, in ONE transaction', () => {
  const run = (extra: Row = {}) => ({ productId: MADE, batchNumber: `run-${++S.seq}`, quantityProduced: 10, manufacturingCost: 30, ...extra });

  it('the run and its ledger line are written through ONE transaction, both carrying the warehouse; the book moves by the run', async () => {
    await as('u-admin');
    const before = book(MADE);
    const res = await produce(run({ warehouseId: 'w-sy2' }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const w = writes();
    expect(w.map((x) => [x.t, x.inTx, x.data.warehouseId])).toEqual([
      ['productionBatch', true, 'w-sy2'],
      ['inventoryMovement', true, 'w-sy2'],
    ]);
    expect(book(MADE)).toEqual({ remaining: before.remaining + 10, produced: before.produced + 10, sold: before.sold, value: before.value + 10 * 3 });
  });

  it('NEGATIVE: no warehouse, another country, a stopped one — refused, nothing written', async () => {
    await as('u-admin');
    for (const [extra, status, code] of [
      [{}, 400, 'WAREHOUSE_REQUIRED'],
      [{ warehouseId: 'w-jo1' }, 400, 'WAREHOUSE_OTHER_COUNTRY'],
      [{ warehouseId: 'w-sy-off' }, 409, 'WAREHOUSE_STOPPED'],
    ] as [Row, number, string][]) {
      S.log = [];
      const res = await produce(run(extra));
      expect([res.status, res.body.code], JSON.stringify(extra)).toEqual([status, code]);
      expect(res.body.errorAr).toEqual(expect.any(String));
      expect(writes()).toEqual([]);
    }
  });

  it('NEGATIVE: a keeper outside her warehouses is refused; inside them she runs', async () => {
    await as('u-keeper');
    expect((await produce(run({ warehouseId: 'w-sy2' }))).body.code).toBe('WAREHOUSE_NOT_REACHED');
    expect(writes()).toEqual([]);
    expect((await produce(run({ warehouseId: 'w-sy1' }))).status).toBe(200);
  });

  it('a store that is not placed: the run is written as before, with no warehouse, still in one transaction', async () => {
    S.storeId = 's-sy-unplaced';
    S.data.product.push({ id: 'p-made-unplaced', companyId: C1, storeId: 's-sy-unplaced', name: 'مرهم', sourceType: 'MANUFACTURED' });
    await as('u-jo');
    const res = await produce(run({ productId: 'p-made-unplaced', warehouseId: 'w-jo1' }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    for (const w of writes()) {
      expect('warehouseId' in w.data).toBe(false);
      expect(w.inTx).toBe(true);
    }
  });
});

/* ───────────────────────── the counts of a placed store ───────────────────────── */

describe('the counts of a placed store wait for the count by warehouse (marked, not removed)', () => {
  it('NEGATIVE: the recount of a placed store is refused by name (409) and writes nothing — surplus or shortfall', async () => {
    await as('u-admin');
    for (const countedQuantity of [100, 0]) {
      S.log = [];
      const res = await recount({ productId: BUY, countedQuantity, reason: 'جرد آخر الشهر' });
      expect([res.status, res.body.code]).toEqual([409, 'PLACED_STORE_COUNT_WAITS']);
      expect(res.body.errorAr).toMatch(/موزّع على مخازن/);
      expect(writes()).toEqual([]);
    }
  });

  it('the recount of a store that is not placed still counts', async () => {
    S.storeId = 's-sy-unplaced';
    await as('u-admin');
    const res = await recount({ productId: BUY_UNPLACED, countedQuantity: 4, reason: 'جرد آخر الشهر' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.difference).toBe(-2);
  });

  it('NEGATIVE: the opening count of a placed store is refused, after every line’s lock is taken SORTED; nothing written', async () => {
    S.data.inventoryMovement = [];
    const err = await db
      .$transaction((tx) =>
        recordOpeningStockCount(tx, {
          companyId: C1, storeId: 's-sy', countedByName: 'أبو محمّد', countedAt: new Date('2026-10-01'), recordedById: 'u1',
          now: new Date('2026-10-02'), lines: [{ productId: MADE, countedQty: 3, unitCost: 1 }, { productId: BUY, countedQty: 2, unitCost: 1 }],
        })
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpeningStockRefused);
    expect((err as OpeningStockRefused).code).toBe('STORE_PLACED');
    expect(writes()).toEqual([]);
    const locks = S.log.filter((l) => l.op === 'stock-lock').map((l) => String(l.values[1]));
    expect(locks).toEqual([...locks].sort());
    expect(locks).toHaveLength(2);
  });
});

/* ───────────────────────── every draw leaves the road alone ───────────────────────── */

describe('a draw never takes units on the road', () => {
  const draw = (quantity: number, allowNegative: boolean) =>
    db.$transaction((tx) => drawDownStock(tx, { companyId: C1, productId: BUY, quantity, allowNegative, storeId: 's-sy' }));
  const road = () => S.data.productionBatch.find((b) => b.id === 'b-road')!;

  it('the oldest row is on the road: the draw skips it and takes the shelves, oldest first', async () => {
    const out = await draw(6, false);
    expect(out).toEqual({ taken: 6, short: 0, cost: 5 * 2.5 + 1 * 3.1 });
    expect(road().quantityRemaining).toBe(4);
    expect(S.data.productionBatch.find((b) => b.id === 'b-w1')!.quantityRemaining).toBe(0);
  });

  it('NEGATIVE: more than the shelves hold is refused, though shelves + road would cover it', async () => {
    const err = await draw(9, false).catch((e: Error) => e);
    expect(String((err as Error).message)).toContain('المتاح 8');
    expect(road().quantityRemaining).toBe(4);
  });

  it('with negative stock allowed the shortfall is reported, and the road is still untouched; the book is conserved', async () => {
    const before = book(BUY);
    const out = await draw(10, true);
    expect(out).toMatchObject({ taken: 8, short: 2 });
    expect(road().quantityRemaining).toBe(4);
    const after = book(BUY);
    expect([after.remaining, after.sold, after.produced]).toEqual([before.remaining - 8, before.sold + 8, before.produced]);
    for (const b of S.data.productionBatch) expect(b.quantityRemaining).toBe(b.quantityProduced + b.quantityMovedIn - b.quantitySold - b.quantityMovedOut);
  });
});

/* ───────────────────────── the lib, without a door ───────────────────────── */

describe('receiveStock, called by a lib with no session', () => {
  it('a placed store without a warehouse is refused there too — the rule lives in the lib, not only in the doors', async () => {
    const err = await db
      .$transaction((tx) => receiveStock(tx, { companyId: C1, storeId: 's-sy', productId: BUY, quantity: 1, unitCost: 1, createdById: 'u1' }))
      .catch((e: { code?: string }) => e);
    expect((err as { code: string }).code).toBe('WAREHOUSE_REQUIRED');
    expect(writes()).toEqual([]);
  });
});
