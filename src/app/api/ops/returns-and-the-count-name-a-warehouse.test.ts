import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * RETURNS AND THE QUICK COUNT NAME A WAREHOUSE (the warehouse plan, W2b — the owner's decision 4, 20/11) — the doors.
 *
 *   · «استلام مرتجع» (`POST /api/ops/returns`) of a PLACED store receives into a warehouse: the one the desk names, or the
 *     one the parcel left from when it names none; checked under the parcel's stock locks — of the company, of the store's
 *     country, running, reached by the person — and handed to the two stock functions. A refusal writes nothing.
 *   · «استلام الكل» names ONE warehouse for the whole press, never a parcel's own; a refusal of it stops the press.
 *   · «جرد» (`POST /api/inventory`, recount) of a placed store counts ONE warehouse by what is physically there, and — one
 *     hand only — writes nothing to the stock: a match is recorded, a difference is recorded and waits for a second person.
 *   · A store that is NOT placed: none of it is asked; the stock functions get exactly today's arguments.
 *
 * People are built the way a session builds them (`computeEffectiveGrants` over role rows, personal overrides and a
 * roleId-null legacy account) and the REAL `can` and `reachesWarehouse` decide. The database is in memory, applies the
 * `where` it is handed (nested relations included) and logs every statement. The stock functions themselves are proven in
 * `src/lib/a-return-lands-where-it-was-received.test.ts`; here they are recorded, to see what the doors hand them.
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
  stock: [] as Row[],
  seq: 0,
}));

vi.mock('@/lib/db', () => {
  const scalar = (v: unknown, c: unknown): boolean => {
    if (c === null) return v === null || v === undefined;
    if (c instanceof Date) return v instanceof Date && v.getTime() === c.getTime();
    if (c && typeof c === 'object' && !Array.isArray(c)) {
      const o = c as Row;
      if ('in' in o && !(o.in as unknown[]).includes(v)) return false;
      if ('notIn' in o && (o.notIn as unknown[]).includes(v)) return false;
      if ('not' in o && (o.not === null ? v === null || v === undefined : v === o.not)) return false;
      if ('gt' in o && !((v as number) > o.gt)) return false;
      return true;
    }
    return v === c;
  };
  const rel = (table: string, key: string, r: Row): Row | Row[] | null => {
    const d = S.data;
    if (table === 'order' && key === 'items') return (d.orderItem ?? []).filter((i) => i.orderId === r.id);
    if (table === 'order' && key === 'store') return (d.store ?? []).find((s) => s.id === r.storeId) ?? null;
    if (table === 'order' && key === 'returnReceipt') return (d.returnReceipt ?? []).find((x) => x.orderId === r.id) ?? null;
    if (table === 'store' && key === 'warehousePlacement') return (d.warehousePlacement ?? []).find((p) => p.storeId === r.id) ?? null;
    if (key === 'order') return (d.order ?? []).find((o) => o.id === r.orderId) ?? null;
    throw new Error(`relation ${table}.${key}`);
  };
  const SUB: Record<string, string> = { items: 'orderItem', store: 'store', returnReceipt: 'returnReceipt', warehousePlacement: 'warehousePlacement', order: 'order' };
  const matches = (table: string, r: Row, w: Row = {}): boolean =>
    Object.entries(w).every(([k, c]) => {
      if (c === undefined) return true;
      if (k === 'OR') return (c as Row[]).some((x) => matches(table, r, x));
      if (k === 'AND') return (c as Row[]).every((x) => matches(table, r, x));
      if (k === 'order' && table !== 'order') {
        const o = rel(table, 'order', r) as Row | null;
        return !!o && matches('order', o, c as Row);
      }
      return scalar(r[k], c);
    });
  const project = (table: string, r: Row, select?: Row): Row => {
    if (!select) return { ...r };
    const out: Row = {};
    for (const [k, v] of Object.entries(select)) {
      if (v === true) out[k] = r[k];
      else if (v && typeof v === 'object') {
        const got = rel(table, k, r);
        out[k] = Array.isArray(got) ? got.map((g) => project(SUB[k], g, v.select)) : got ? project(SUB[k], got, v.select) : null;
      }
    }
    return out;
  };
  const make = (inTx: boolean) => {
    const t = (name: string) => {
      const rows = () => (S.data[name] ??= []);
      const note = (op: string, extra: Row = {}) => S.log.push({ t: name, op, inTx, ...extra });
      return {
        findMany: async ({ where, select, take, orderBy }: Row = {}) => {
          note('read');
          const key = orderBy && !Array.isArray(orderBy) ? Object.keys(orderBy)[0] : 'id';
          const hit = rows().filter((r) => matches(name, r, where)).sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0));
          return hit.slice(0, take ?? hit.length).map((r) => project(name, r, select));
        },
        findFirst: async ({ where, select }: Row = {}) => {
          note('read');
          const r = rows().find((x) => matches(name, x, where));
          return r ? project(name, r, select) : null;
        },
        findUnique: async ({ where, select }: Row) => {
          note('read');
          const r = rows().find((x) => matches(name, x, where));
          return r ? project(name, r, select) : null;
        },
        aggregate: async ({ where, _sum }: Row) => {
          note('read');
          const hit = rows().filter((x) => matches(name, x, where));
          return { _sum: Object.fromEntries(Object.keys(_sum).map((k) => [k, hit.length ? hit.reduce((s, r) => s + r[k], 0) : null])) };
        },
        create: async ({ data }: Row) => {
          note('write', { data });
          const row = { id: `${name}-${++S.seq}`, ...data };
          rows().push(row);
          return { ...row };
        },
        update: async ({ where, data }: Row) => {
          note('write', { data });
          const r = rows().find((x) => matches(name, x, where));
          if (r) Object.assign(r, Object.fromEntries(Object.entries(data).filter(([, v]) => !(v && typeof v === 'object' && !(v instanceof Date)))));
          return { ...r };
        },
        updateMany: async ({ where, data }: Row) => {
          note('write', { data });
          return { count: rows().filter((r) => matches(name, r, where)).length };
        },
      };
    };
    const names = [
      'country', 'store', 'user', 'product', 'productionBatch', 'inventoryMovement', 'warehouse', 'warehousePlacement', 'userCountryAccess',
      'userWarehouseAccess', 'order', 'orderItem', 'orderAddOn', 'returnReceipt', 'orderNote',
      // 21/11 (W5a): the receiving warehouse of a placed store is asked whether it is under count; no sheet here (today's answer).
      'stockCount',
    ];
    const c: Row = Object.fromEntries(names.map((n) => [n, t(n)]));
    c.userStoreAccess = {
      findMany: async ({ where }: Row) =>
        (S.data.userStoreAccess ?? []).filter((r) => r.userId === where.userId).map((r) => ({ store: { countryId: (S.data.store ?? []).find((s) => s.id === r.storeId)?.countryId } })),
    };
    c.rolePermission = {
      findMany: async ({ where }: Row) => (where.roleId ? S.rolePerms[where.roleId] ?? [] : S.rolePerms[`template:${where.role?.name}`] ?? []).map((permission) => ({ permission, scope: 'ALL_COMPANY', scopeIds: null })),
    };
    c.userPermission = { findMany: async ({ where }: Row) => (S.overrides[where.userId] ?? []).map((o) => ({ ...o, scope: 'ALL_COMPANY', scopeIds: null })) };
    c.$executeRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      S.log.push({ t: 'raw', op: /pg_advisory_xact_lock/.test(strings.join('?')) ? 'stock-lock' : 'raw', inTx, values });
      return 1;
    };
    c.$queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      S.log.push({ t: 'raw', op: /FOR SHARE/.test(strings.join('?')) ? 'warehouse-for-share' : 'raw', inTx, values });
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
  return {
    ...real,
    requireContext: async () => ({ user: S.current, companyId: (S.current as Row).companyId, storeId: S.storeId, country: { currencyCode: 'SYP', minorUnit: 2 } }),
  };
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
vi.mock('@/lib/commission', () => ({ reverseForOrder: async () => 1 }));
vi.mock('@/lib/stock-consumption', async (orig) => ({
  ...(await orig<typeof import('@/lib/stock-consumption')>()),
  restoreOrderStock: async (_tx: unknown, args: Row) => {
    S.stock.push({ fn: 'restore', ...args });
    return { restored: args.receivedQty, alreadyDone: false };
  },
  takeOffUnreturned: async (_tx: unknown, args: Row) => {
    S.stock.push({ fn: 'takeOff', ...args });
    return { damaged: 0, missing: 0, absorbed: 0, ...(args.warehouseId ? { moved: 2 } : {}) };
  },
}));

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { POST as receiveOne } from './returns/route';
import { POST as receiveAll } from './returns/receive-all/route';
import { GET as receivingWarehouses } from './returns/warehouses/route';
import { POST as inventoryPOST } from '@/app/api/inventory/route';

const C1 = 'c1';
const SY = 'k-sy';
const JO = 'k-jo';
const P = 'p-oil-000000001';
const P_UNPLACED = 'p-soap-00000001';

async function as(id: string) {
  const u = S.data.user.find((x) => x.id === id)!;
  S.current = attachGrants({ ...u, permissions: [] } as unknown as SessionUser, await computeEffectiveGrants({ id: u.id, role: u.role, roleId: u.roleId ?? null }));
}
const call = async (res: Promise<Response>) => {
  const r = await res;
  return { status: r.status, body: await r.json() };
};
const post = (fn: (r: Request) => Promise<Response>, body: Row) => call(fn(new Request('http://x', { method: 'POST', body: JSON.stringify(body) })));
const one = (body: Row) => post(receiveOne, { receivedQty: 3, damagedQty: 0, countedAndInspected: true, ...body });
const all = (body: Row = {}) => post(receiveAll, { countedAndInspected: true, ...body });
const recount = (body: Row) => post(inventoryPOST, { action: 'recount', ...body });
const writes = () => S.log.filter((l) => l.op === 'write');
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function parcel(n: number, storeId: string, sourceWarehouseId: string | null, extra: Row = {}): Row[] {
  const id = uuid(n);
  S.data.orderItem.push({ id: `oi-${n}`, orderId: id, companyId: C1, productId: storeId === 's-sy' ? P : P_UNPLACED, productName: 'زيت', quantity: 3, freeQuantity: 0, deliveredQty: null, reservedQty: 3 });
  const o = {
    id, companyId: C1, storeId, orderNumber: `ORD-${n}`, shippingStatus: 'RETURNED', settlementStatus: 'PENDING_COLLECTION', regionId: 'r1',
    deliveryProviderId: null, sourceWarehouseId, status: 'RETURNED', confirmationStatus: 'CONFIRMED', ...extra,
  };
  S.data.order.push(o);
  return [o];
}

beforeEach(() => {
  S.seq = 0;
  S.audit = [];
  S.log = [];
  S.stock = [];
  S.storeId = 's-sy';
  S.rolePerms = {
    'r-desk': ['ops.returns', 'inventory.view', 'inventory.adjust'],
    'r-keeper': ['ops.returns', 'inventory.view', 'inventory.adjust'],
    // The system template a roleId-null WAREHOUSE account inherits (`dbGrantSource.roleRows`).
    'template:WAREHOUSE': ['ops.returns', 'inventory.view', 'inventory.adjust'],
  };
  S.overrides = {
    // «استلام الكل» is its own key, granted to nobody by a role: a personal ALLOW here.
    'u-desk': [{ permission: 'ops.returns_receive_all', effect: 'ALLOW' }],
    'u-keeper': [{ permission: 'ops.returns_receive_all', effect: 'ALLOW' }],
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
      { id: 'u-desk', name: 'مكتب', role: 'CUSTOM', roleId: 'r-desk', status: 'ACTIVE', companyId: C1 },
      { id: 'u-keeper', name: 'أمينة', role: 'CUSTOM', roleId: 'r-keeper', status: 'ACTIVE', companyId: C1 },
      { id: 'u-legacy-wh', name: 'مخزن قديم', role: 'WAREHOUSE', roleId: null, status: 'ACTIVE', companyId: C1 },
    ],
    userCountryAccess: ['u-desk', 'u-keeper', 'u-legacy-wh'].map((userId) => ({ userId, countryId: SY })),
    userStoreAccess: [],
    // She keeps the main warehouse — and only it.
    userWarehouseAccess: [{ userId: 'u-keeper', warehouseId: 'w-sy1' }],
    warehouse: [
      { id: 'w-sy1', companyId: C1, countryId: SY, name: 'الرئيسي', isActive: true },
      { id: 'w-sy2', companyId: C1, countryId: SY, name: 'الفرع', isActive: true },
      { id: 'w-sy-off', companyId: C1, countryId: SY, name: 'القديم', isActive: false },
      { id: 'w-jo1', companyId: C1, countryId: JO, name: 'عمّان', isActive: true },
      { id: 'w-c2', companyId: 'c2', countryId: SY, name: 'غريب', isActive: true },
    ],
    warehousePlacement: [{ id: 'pl1', companyId: C1, storeId: 's-sy' }],
    product: [
      { id: P, companyId: C1, storeId: 's-sy', name: 'زيت', sourceType: 'PURCHASED' },
      { id: P_UNPLACED, companyId: C1, storeId: 's-sy-unplaced', name: 'صابون', sourceType: 'PURCHASED' },
    ],
    productionBatch: [],
    inventoryMovement: [],
    order: [],
    orderItem: [],
    orderAddOn: [],
    returnReceipt: [],
    orderNote: [],
  };
});

/* ───────────────────────── one parcel at the desk ───────────────────────── */

describe('«استلام مرتجع» of a placed store receives INTO a warehouse', () => {
  it('the warehouse the desk names goes to both stock functions, is checked under the parcel’s stock lock, and is said', async () => {
    parcel(1, 's-sy', 'w-sy1');
    await as('u-desk');
    const res = await one({ orderId: uuid(1), warehouseId: 'w-sy2' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(S.stock.map((x) => [x.fn, x.warehouseId])).toEqual([['restore', 'w-sy2'], ['takeOff', 'w-sy2']]);
    // The parcel's stock lock before «placed?», before the warehouse row — all inside the one transaction.
    const order = S.log.filter((l) => l.inTx && (l.op === 'stock-lock' || l.t === 'warehousePlacement' || l.op === 'warehouse-for-share')).map((l) => l.op === 'read' ? l.t : l.op);
    expect(order).toEqual(['stock-lock', 'warehousePlacement', 'warehouse-for-share']);
    const audit = S.audit.find((a) => a.action === 'RETURN_RECEIVED')!;
    expect(audit.newData).toMatchObject({ warehouseId: 'w-sy2', warehouseName: 'الفرع', movedToWarehouse: 2 });
    expect(S.data.orderNote.at(-1)!.body).toMatch(/استُلم بمخزن الفرع/);
  });

  it('no warehouse named: the one the parcel left from (the desk’s default)', async () => {
    parcel(1, 's-sy', 'w-sy1');
    await as('u-desk');
    expect((await one({ orderId: uuid(1) })).status).toBe(201);
    expect(S.stock.map((x) => x.warehouseId)).toEqual(['w-sy1', 'w-sy1']);
  });

  const refusals: [string, Row, string | null, number, string][] = [
    ['none named and none it left from', {}, null, 400, 'WAREHOUSE_REQUIRED'],
    ['of another company', { warehouseId: 'w-c2' }, 'w-sy1', 400, 'WAREHOUSE_NOT_FOUND'],
    ['of another country', { warehouseId: 'w-jo1' }, 'w-sy1', 400, 'WAREHOUSE_OTHER_COUNTRY'],
    ['stopped', { warehouseId: 'w-sy-off' }, 'w-sy1', 409, 'WAREHOUSE_STOPPED'],
    ['the one it left from, stopped since', {}, 'w-sy-off', 409, 'WAREHOUSE_STOPPED'],
  ];
  for (const [what, body, source, status, code] of refusals) {
    it(`NEGATIVE: ${what} — refused (${status} ${code}) in Arabic, and nothing is written`, async () => {
      parcel(1, 's-sy', source);
      await as('u-desk');
      const res = await one({ orderId: uuid(1), ...body });
      expect([res.status, res.body.code]).toEqual([status, code]);
      expect(res.body.errorAr).toMatch(/[؀-ۿ]/);
      expect(S.stock).toEqual([]);
      expect(S.data.returnReceipt).toEqual([]);
      expect(writes()).toEqual([]);
    });
  }

  it('NEGATIVE: a keeper confined to her warehouse cannot receive into another — role rows, a personal override, the real reach', async () => {
    parcel(1, 's-sy', 'w-sy1');
    await as('u-keeper');
    const res = await one({ orderId: uuid(1), warehouseId: 'w-sy2' });
    expect([res.status, res.body.code]).toEqual([403, 'WAREHOUSE_NOT_REACHED']);
    expect(writes()).toEqual([]);
    // …and into hers she can.
    expect((await one({ orderId: uuid(1), warehouseId: 'w-sy1' })).status).toBe(201);
  });

  it('a roleId-null legacy WAREHOUSE account and the owner receive like anybody who reaches the country', async () => {
    parcel(1, 's-sy', 'w-sy1');
    parcel(2, 's-sy', 'w-sy1');
    await as('u-legacy-wh');
    expect((await one({ orderId: uuid(1), warehouseId: 'w-sy2' })).status).toBe(201);
    await as('u-owner');
    expect((await one({ orderId: uuid(2), warehouseId: 'w-sy2' })).status).toBe(201);
  });
});

describe('«استلام مرتجع» of a store that is NOT placed: today’s receipt, exactly', () => {
  it('no warehouse is read, checked or handed on — even when the body names one', async () => {
    S.storeId = 's-sy-unplaced';
    parcel(1, 's-sy-unplaced', null);
    await as('u-desk');
    const res = await one({ orderId: uuid(1), warehouseId: 'w-jo1' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    for (const x of S.stock) expect('warehouseId' in x, x.fn).toBe(false);
    expect(S.log.some((l) => l.t === 'warehouse' || l.op === 'warehouse-for-share' || l.t === 'warehousePlacement' || l.op === 'stock-lock')).toBe(false);
    const audit = S.audit.find((a) => a.action === 'RETURN_RECEIVED')!;
    expect('warehouseId' in audit.newData).toBe(false);
    expect(S.data.orderNote.at(-1)!.body).not.toMatch(/بمخزن/);
  });
});

/* ───────────────────────── «استلام الكل» ───────────────────────── */

describe('«استلام الكل» of a placed store: ONE warehouse for the whole press', () => {
  it('every parcel goes into the warehouse the press names — never the one it left from', async () => {
    parcel(1, 's-sy', 'w-sy1');
    parcel(2, 's-sy', 'w-sy2');
    parcel(3, 's-sy', null);
    await as('u-desk');
    const res = await all({ warehouseId: 'w-sy2' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.received).toBe(3);
    expect(new Set(S.stock.map((x) => x.warehouseId))).toEqual(new Set(['w-sy2']));
    expect(S.stock).toHaveLength(6);
  });

  it('NEGATIVE: no warehouse named — refused at the first parcel, the press stops, nothing is received', async () => {
    parcel(1, 's-sy', 'w-sy1');
    parcel(2, 's-sy', 'w-sy1');
    await as('u-desk');
    const res = await all();
    expect([res.status, res.body.code]).toEqual([400, 'WAREHOUSE_REQUIRED']);
    expect(res.body).toMatchObject({ received: 0, nextCursor: null });
    expect(S.stock).toEqual([]);
    expect(S.data.returnReceipt).toEqual([]);
    expect(S.audit.find((a) => a.action === 'RETURNS_RECEIVED_ALL')?.newData).toMatchObject({ warehouseRefused: 'WAREHOUSE_REQUIRED' });
  });

  it('NEGATIVE: a warehouse she does not reach — 403 for the press, nothing received', async () => {
    parcel(1, 's-sy', 'w-sy1');
    await as('u-keeper');
    const res = await all({ warehouseId: 'w-sy2' });
    expect([res.status, res.body.code]).toEqual([403, 'WAREHOUSE_NOT_REACHED']);
    expect(S.data.returnReceipt).toEqual([]);
  });

  it('a store that is not placed: the field is not read, the walk is today’s', async () => {
    S.storeId = 's-sy-unplaced';
    parcel(1, 's-sy-unplaced', null);
    await as('u-desk');
    const res = await all({ warehouseId: 'w-jo1' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.received).toBe(1);
    for (const x of S.stock) expect('warehouseId' in x).toBe(false);
  });
});

describe('where a parcel may be received — the desk’s list', () => {
  it('a placed store: the running warehouses of its country this person reaches; a keeper sees hers only', async () => {
    await as('u-desk');
    expect((await call(receivingWarehouses())).body).toEqual({ placed: true, warehouses: [{ id: 'w-sy1', name: 'الرئيسي' }, { id: 'w-sy2', name: 'الفرع' }] });
    await as('u-keeper');
    expect((await call(receivingWarehouses())).body).toEqual({ placed: true, warehouses: [{ id: 'w-sy1', name: 'الرئيسي' }] });
  });
  it('a store that is not placed: nothing new to ask', async () => {
    S.storeId = 's-sy-unplaced';
    await as('u-desk');
    expect((await call(receivingWarehouses())).body).toEqual({ placed: false });
  });
});

/* ───────────────────────── the quick count ───────────────────────── */

describe('«جرد» of a placed store counts ONE warehouse, by what is physically there — and writes nothing', () => {
  function shelf() {
    S.data.productionBatch.push(
      { id: 'b1', companyId: C1, storeId: 's-sy', productId: P, warehouseId: 'w-sy1', inTransitTransferId: null, quantityRemaining: 10 },
      { id: 'b2', companyId: C1, storeId: 's-sy', productId: P, warehouseId: 'w-sy2', inTransitTransferId: null, quantityRemaining: 6 },
      { id: 'b-road', companyId: C1, storeId: 's-sy', productId: P, warehouseId: null, inTransitTransferId: 't1', quantityRemaining: 4 }
    );
    // Shipped from w-sy1 (3 with the courier); confirmed and still on its shelf (2 — counted).
    parcel(1, 's-sy', 'w-sy1', { shippingStatus: 'SHIPPED', shippedAt: new Date('2026-11-10') });
    parcel(2, 's-sy', 'w-sy1', { shippingStatus: 'PENDING', shippedAt: null, labelPrintedAt: null, status: 'CONFIRMED' });
    S.data.orderItem.find((i) => i.orderId === uuid(2))!.reservedQty = 2;
  }

  it('a match: 200, recorded with the warehouse, nothing written to the stock', async () => {
    shelf();
    await as('u-desk');
    const res = await recount({ productId: P, countedQuantity: 7, reason: 'جرد آخر الشهر', warehouseId: 'w-sy1' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ success: true, difference: 0, warehouseId: 'w-sy1' });
    expect(writes()).toEqual([]);
    const a = S.audit.find((x) => x.action === 'STOCK_RECOUNTED')!;
    expect(a.previousData).toEqual({ warehouseId: 'w-sy1', warehouseName: 'الرئيسي', book: 10, withCourier: 3, expected: 7 });
    expect(a.newData).toMatchObject({ counted: 7, basis: 'PHYSICAL', warehouseId: 'w-sy1', warehouseName: 'الرئيسي', difference: 0, written: false, reason: 'جرد آخر الشهر' });
  });

  for (const counted of [4, 12]) {
    it(`NEGATIVE: a difference (${counted} against 7) is recorded and waits for a second person — 409, nothing written`, async () => {
      shelf();
      await as('u-desk');
      const res = await recount({ productId: P, countedQuantity: counted, reason: 'جرد آخر الشهر', warehouseId: 'w-sy1' });
      expect([res.status, res.body.code]).toEqual([409, 'COUNT_DIFFERENCE_NEEDS_SECOND_HAND']);
      expect(res.body.difference).toBe(counted - 7);
      expect(res.body.errorAr).toMatch(/بمخزن «الرئيسي»/);
      expect(writes()).toEqual([]);
      expect(S.data.productionBatch.map((b) => b.quantityRemaining)).toEqual([10, 6, 4]);
      expect(S.audit.find((x) => x.action === 'STOCK_RECOUNTED')!.newData).toMatchObject({ difference: counted - 7, written: false, warehouseId: 'w-sy1' });
    });
  }

  it('NEGATIVE: the count names no warehouse, or one she does not reach — refused, nothing written, nothing recorded', async () => {
    shelf();
    await as('u-desk');
    expect((await recount({ productId: P, countedQuantity: 7, reason: 'جرد آخر الشهر' })).body.code).toBe('WAREHOUSE_REQUIRED');
    expect((await recount({ productId: P, countedQuantity: 7, reason: 'جرد آخر الشهر', warehouseId: 'w-jo1' })).body.code).toBe('WAREHOUSE_OTHER_COUNTRY');
    await as('u-keeper');
    expect((await recount({ productId: P, countedQuantity: 6, reason: 'جرد آخر الشهر', warehouseId: 'w-sy2' })).body.code).toBe('WAREHOUSE_NOT_REACHED');
    expect(writes()).toEqual([]);
    expect(S.audit).toEqual([]);
  });
});
