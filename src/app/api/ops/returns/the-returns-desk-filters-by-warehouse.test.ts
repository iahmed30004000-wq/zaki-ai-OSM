import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { SessionUser } from '@/types/auth';

/**
 * «من أي مخزن طلع المرتجع» — THE RETURNS DESK NARROWS TO ONE WAREHOUSE (F10, the owner, 25/11) — THE DOOR.
 *
 *   GET /api/ops/returns?warehouse=<id>|none
 *
 * A PLACED store: the list, its pages, its total and every number beside the options (the tabs included) are those of the
 * parcels that LEFT FROM that warehouse (`Order.sourceWarehouseId`), or of the parcels with no stamp (`none`). The id must
 * be one the desk's picker offers — the running warehouses of the store's country that the person reaches, the
 * `/api/ops/returns/warehouses` door and the shipping screens' rule (`warehousesReachedBy`). Anything else is a 400 in
 * Arabic, the way the desk refuses every value it does not know.
 *
 * A store that is NOT placed: the parameter is not read. The body is byte for byte what `osm/main` answered — pinned by
 * a golden written by `osm/main`'s own door (`returns-warehouse-filter.main-golden.json`, regenerated only with
 * `F10_WRITE_GOLDEN=1` on a checkout of the door as it was), with the parameter in the URL and without it.
 *
 * People are built the way a session builds them: `computeEffectiveGrants` over role rows (a custom role, a roleId-null
 * legacy account) with the REAL `can` and the REAL `warehousesReachedBy` over the fake database below.
 */

// A Prisma-shaped fake and a JSON body: their shapes are the code under test's, not this file's.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const S = vi.hoisted(() => ({
  current: null as unknown as SessionUser,
  tables: {} as Record<string, Loose[]>,
  calls: [] as string[],
  rolePerms: {} as Record<string, string[]>,
}));

/* ───────────── a fake database that judges the question it is asked ───────────── */

const OPS = ['in', 'notIn', 'not', 'gt', 'gte', 'lt', 'lte', 'contains', 'equals', 'mode'];
function cond(v: Loose, c: Loose): boolean {
  if (c === undefined) return true;
  if (c === null) return v === null || v === undefined;
  if (c instanceof Date) return v instanceof Date && v.getTime() === c.getTime();
  if (typeof c === 'object' && !Array.isArray(c)) {
    if ('isNot' in c) return c.isNot === null ? v !== null && v !== undefined : v != null && !matches(c.isNot, v);
    if ('is' in c) return c.is === null ? v === null || v === undefined : v != null && matches(c.is, v);
    if (Object.keys(c).some((k) => OPS.includes(k))) {
      const t = (x: Loose) => (x instanceof Date ? x.getTime() : x);
      if ('equals' in c && !cond(v, c.equals)) return false;
      if ('in' in c && !c.in.includes(v)) return false;
      if ('notIn' in c && c.notIn.includes(v)) return false;
      if ('not' in c && cond(v, c.not)) return false;
      if ('gt' in c && !(v != null && t(v) > t(c.gt))) return false;
      if ('gte' in c && !(v != null && t(v) >= t(c.gte))) return false;
      if ('lt' in c && !(v != null && t(v) < t(c.lt))) return false;
      if ('lte' in c && !(v != null && t(v) <= t(c.lte))) return false;
      if ('contains' in c && !(typeof v === 'string' && v.toLowerCase().includes(String(c.contains).toLowerCase()))) return false;
      return true;
    }
    // A relation: the row carries it embedded.
    return v != null && matches(c, v);
  }
  return (v ?? null) === c;
}
function matches(where: Loose, row: Loose): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, c]: [string, Loose]) => {
    if (k === 'AND') return (Array.isArray(c) ? c : [c]).every((w: Loose) => matches(w, row));
    if (k === 'OR') return c.some((w: Loose) => matches(w, row));
    if (k === 'NOT') return !(Array.isArray(c) ? c : [c]).some((w: Loose) => matches(w, row));
    return cond(row[k], c);
  });
}
/** A column not selected does not come back. */
function project(row: Loose, select: Loose): Loose {
  if (!select || row == null) return row;
  if (Array.isArray(row)) return row.map((r) => project(r, select));
  const out: Loose = {};
  for (const [k, v] of Object.entries(select) as [string, Loose][]) {
    if (!v || !(k in row)) continue;
    out[k] = v === true ? row[k] : project(row[k], v.select);
  }
  return out;
}
const table = (name: string) => ({
  findMany: async (a: Loose = {}) => {
    S.calls.push(`${name}.findMany`);
    const rows = (S.tables[name] ?? []).filter((r) => matches(a.where, r));
    const ordered = a.orderBy?.name ? [...rows].sort((x, y) => x.name.localeCompare(y.name, 'ar')) : rows;
    const from = a.skip ?? 0;
    return ordered.slice(from, from + (a.take ?? ordered.length)).map((r) => project(r, a.select));
  },
  findFirst: async (a: Loose = {}) => {
    S.calls.push(`${name}.findFirst`);
    const r = (S.tables[name] ?? []).find((x) => matches(a.where, x));
    return r ? project(r, a.select) : null;
  },
  findUnique: async (a: Loose = {}) => {
    S.calls.push(`${name}.findUnique`);
    const r = (S.tables[name] ?? []).find((x) => matches(a.where, x));
    return r ? project(r, a.select) : null;
  },
  count: async (a: Loose = {}) => {
    S.calls.push(`${name}.count`);
    return (S.tables[name] ?? []).filter((r) => matches(a.where, r)).length;
  },
  groupBy: async (a: Loose) => {
    S.calls.push(`${name}.groupBy`);
    const groups = new Map<string, Loose[]>();
    for (const r of (S.tables[name] ?? []).filter((x) => matches(a.where, x))) {
      const key = JSON.stringify(a.by.map((k: string) => r[k] ?? null));
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    return [...groups.values()].map((g) => ({ ...Object.fromEntries(a.by.map((k: string) => [k, g[0][k] ?? null])), _count: { _all: g.length } }));
  },
});

vi.mock('@/lib/db', () => {
  const rolePermission = {
    findMany: async ({ where }: Loose) =>
      (where.roleId ? S.rolePerms[where.roleId] ?? [] : S.rolePerms[`template:${where.role?.name}`] ?? []).map((permission) => ({ permission, scope: 'ALL_COMPANY', scopeIds: null })),
  };
  const userPermission = { findMany: async () => [] };
  const cache = new Map<string, Loose>();
  const db = new Proxy({} as Loose, {
    get: (_t, prop: string) => {
      if (prop === 'rolePermission') return rolePermission;
      if (prop === 'userPermission') return userPermission;
      if (!cache.has(prop)) cache.set(prop, table(prop));
      return cache.get(prop);
    },
  });
  return { db };
});
vi.mock('@/lib/geo-context', async (orig) => {
  const real = await orig<typeof import('@/lib/geo-context')>();
  return {
    ...real,
    requireContext: async () => ({ user: S.current, companyId: 'c1', storeId: 's1', country: { minorUnit: 2, currencyCode: 'USD', code: 'JO' } }),
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
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: async () => undefined }));
vi.mock('@/lib/audit', () => ({ logAudit: async () => undefined }));
vi.mock('@/lib/commission', () => ({ reverseForOrder: async () => undefined }));

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { GET as returns } from './route';
import { GET as offered } from './warehouses/route';

/* ───────────── the world ───────────── */

const NOW = new Date('2026-11-25T09:00:00.000Z');
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const WA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const W_STOPPED = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const W_ABROAD = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const W_OTHER_CO = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const NAMES: Record<string, string> = { [WA]: 'مخزن أ', [WB]: 'مخزن ب', [W_STOPPED]: 'مخزن ج' };

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const pick = <T,>(r: () => number, xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
const STATES = ['RETURN_REQUESTED', 'RETURNED', 'FAILED_DELIVERY', 'PARTIALLY_DELIVERED', 'SHIPPED', 'DELIVERED'];

function parcel(i: number, r: () => number, stamps: readonly (string | null)[]) {
  const state = pick(r, STATES);
  const courier = pick(r, [C1, C2, null]);
  const qty = 1 + Math.floor(r() * 3);
  const days = Math.floor(r() * 15);
  const counted = ['RETURNED', 'FAILED_DELIVERY'].includes(state) && r() < 0.35;
  return {
    id: `o${String(i).padStart(3, '0')}`,
    companyId: 'c1',
    storeId: 's1',
    orderNumber: `ORD-${1000 + i}`,
    merchantRef: r() < 0.3 ? `M-${i}` : null,
    trackingNumber: r() < 0.75 ? `TRK-${i}` : r() < 0.5 ? '' : null,
    shippingStatus: state,
    settlementStatus: pick(r, ['NOT_APPLICABLE', 'PENDING']),
    returnReason: state === 'RETURNED' ? 'CUSTOMER_REFUSED' : null,
    returnedAt: state === 'RETURNED' ? ago(days) : null,
    failedAt: state === 'FAILED_DELIVERY' ? ago(days) : null,
    deliveredAt: ['DELIVERED', 'PARTIALLY_DELIVERED'].includes(state) ? ago(days) : null,
    updatedAt: ago(Math.floor(r() * 12)),
    regionId: 'r1',
    deliveryProviderId: courier,
    sourceWarehouseId: pick(r, stamps),
    customer: { fullName: `زبون ${i}`, phone: `0790000${String(i).padStart(3, '0')}` },
    region: { id: 'r1', name: 'عمّان' },
    deliveryProvider: courier ? { id: courier, name: courier === C1 ? 'الأولى' : 'التانية' } : null,
    items: [{ id: `i${i}`, productName: 'منتج', quantity: qty, freeQuantity: 0, deliveredQty: state === 'PARTIALLY_DELIVERED' ? 1 : null, productId: 'p1' }],
    returnReceipt: counted
      ? { expectedQty: qty, receivedQty: qty, damagedQty: 0, missingQty: 0, courierFeeCharged: false, inspectedById: 'u-insp', inspectedAt: ago(1), note: null }
      : null,
  };
}

const PEOPLE = [
  // [id, role, roleId, countries, keeper of]
  ['u-owner', 'SUPER_ADMIN', null, [], []],
  ['u-clerk', 'CUSTOM', 'r-ret', ['k1'], []],
  ['u-keeper-b', 'CUSTOM', 'r-ret', ['k1'], [WB]],
  ['u-legacy', 'WAREHOUSE', null, ['k1'], []],
  ['u-abroad', 'CUSTOM', 'r-ret', ['k2'], []],
] as const;

function world(opts: { placed: boolean; seed: number; size: number; stamps?: readonly (string | null)[] }) {
  const r = rng(opts.seed);
  const stamps = opts.stamps ?? (opts.placed ? [WA, WB, W_STOPPED, null] : [null]);
  S.tables = {
    order: Array.from({ length: opts.size }, (_, i) => parcel(i, r, stamps)),
    warehousePlacement: opts.placed ? [{ id: 'pl1', companyId: 'c1', storeId: 's1' }] : [],
    store: [{ id: 's1', companyId: 'c1', countryId: 'k1' }],
    country: [
      { id: 'k1', companyId: 'c1', isActive: true },
      { id: 'k2', companyId: 'c1', isActive: true },
    ],
    warehouse: [
      { id: WB, companyId: 'c1', countryId: 'k1', name: 'مخزن ب', isActive: true },
      { id: WA, companyId: 'c1', countryId: 'k1', name: 'مخزن أ', isActive: true },
      { id: W_STOPPED, companyId: 'c1', countryId: 'k1', name: 'مخزن ج', isActive: false },
      { id: W_ABROAD, companyId: 'c1', countryId: 'k2', name: 'مخزن برّا', isActive: true },
      { id: W_OTHER_CO, companyId: 'c2', countryId: 'k9', name: 'مخزن شركة تانية', isActive: true },
    ],
    user: [
      ...PEOPLE.map(([id, role, roleId]) => ({ id, name: id, role, roleId, status: 'ACTIVE', companyId: 'c1' })),
      { id: 'u-insp', name: 'أمين', role: 'WAREHOUSE', roleId: null, status: 'ACTIVE', companyId: 'c1' },
    ],
    userCountryAccess: PEOPLE.flatMap(([userId, , , ks]) => ks.map((countryId) => ({ userId, countryId }))),
    userStoreAccess: [],
    userWarehouseAccess: PEOPLE.flatMap(([userId, , , , keeps]) => keeps.map((warehouseId) => ({ userId, warehouseId }))),
    deliveryProvider: [
      { id: C1, companyId: 'c1', name: 'الأولى' },
      { id: C2, companyId: 'c1', name: 'التانية' },
    ],
  };
}

async function as(userId: string) {
  const u = S.tables.user.find((x) => x.id === userId)!;
  S.current = attachGrants(
    { ...u, permissions: [] } as unknown as SessionUser,
    await computeEffectiveGrants({ id: u.id, role: u.role, roleId: u.roleId ?? null })
  );
}

const ask = async (query: string) => {
  S.calls.length = 0;
  const res = await returns(new Request(`http://localhost/api/ops/returns${query}`));
  return { status: res.status, body: (await res.json()) as Loose, asked: [...S.calls] };
};

/** What the list SHOULD hold, counted here from the world — never with the code under test. */
const pendingOf = (rows: Loose[]) =>
  rows.filter((o) => ['RETURN_REQUESTED', 'RETURNED', 'FAILED_DELIVERY', 'PARTIALLY_DELIVERED'].includes(o.shippingStatus) && !o.returnReceipt);
const receivedOf = (rows: Loose[]) => rows.filter((o) => !!o.returnReceipt);
const from = (stamp: string | null) => (o: Loose) => (o.sourceWarehouseId ?? null) === stamp;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterAll(() => vi.useRealTimers());

beforeEach(() => {
  S.rolePerms = {
    'r-ret': ['ops.returns', 'customers.view'],
    'template:WAREHOUSE': ['ops.returns'],
  };
  world({ placed: true, seed: 5, size: 90 });
});

describe('a placed store: the list narrows to the warehouse the parcel left from', () => {
  it('the waiting parcels of «مخزن أ» — every row names it, the total is theirs, the choice is echoed', async () => {
    await as('u-owner');
    const want = pendingOf(S.tables.order).filter(from(WA));
    expect(want.length).toBeGreaterThan(5);
    const { status, body } = await ask(`?warehouse=${WA}&limit=100`);
    expect(status).toBe(200);
    expect(body.pagination.total).toBe(want.length);
    expect(body.orders.map((o: Loose) => o.id).sort()).toEqual(want.map((o) => o.id).sort());
    for (const row of body.orders) expect(row.sourceWarehouseName, row.id).toBe('مخزن أ');
    expect(body.applied.warehouse).toBe(WA);
  });

  it('«بلا مخزن»: only the parcels with no stamp, and none of them carries a name', async () => {
    await as('u-owner');
    const want = pendingOf(S.tables.order).filter(from(null));
    expect(want.length).toBeGreaterThan(3);
    const { status, body } = await ask('?warehouse=none&limit=100');
    expect(status).toBe(200);
    expect(body.orders.map((o: Loose) => o.id).sort()).toEqual(want.map((o) => o.id).sort());
    for (const row of body.orders) expect(row, row.id).not.toHaveProperty('sourceWarehouseName');
    expect(body.applied.warehouse).toBe('none');
  });

  it('the counted ones too, in the record view', async () => {
    await as('u-owner');
    const want = receivedOf(S.tables.order).filter(from(WB));
    expect(want.length).toBeGreaterThan(0);
    const { body } = await ask(`?view=received&warehouse=${WB}&limit=100`);
    expect(body.orders.map((o: Loose) => o.id).sort()).toEqual(want.map((o) => o.id).sort());
    for (const row of body.orders) expect(row.sourceWarehouseName).toBe('مخزن ب');
  });

  it('with no warehouse chosen every parcel is listed, each with its name — a stopped warehouse’s too', async () => {
    await as('u-owner');
    const { body } = await ask('?limit=100');
    const want = pendingOf(S.tables.order);
    expect(body.pagination.total).toBe(want.length);
    for (const row of body.orders) {
      const stamp = want.find((o) => o.id === row.id)!.sourceWarehouseId;
      if (stamp) expect(row.sourceWarehouseName, row.id).toBe(NAMES[stamp]);
      else expect(row, row.id).not.toHaveProperty('sourceWarehouseName');
    }
    expect(body.applied).not.toHaveProperty('warehouse');
  });

  it('the tabs and every number beside the options count the chosen warehouse’s parcels only', async () => {
    await as('u-owner');
    const mine = S.tables.order.filter(from(WA));
    const pend = pendingOf(mine);
    const { body } = await ask(`?warehouse=${WA}`);
    const f = body.facts;
    expect(f.views).toEqual({ pending: pend.length, received: receivedOf(mine).length });
    for (const s of ['RETURN_REQUESTED', 'RETURNED', 'FAILED_DELIVERY', 'PARTIALLY_DELIVERED']) {
      expect(f.statuses[s], s).toBe(pend.filter((o) => o.shippingStatus === s).length);
    }
    expect(Object.values(f.ages as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(pend.length);
    expect(f.couriers.reduce((a: number, c: Loose) => a + c.count, 0)).toBe(pend.length);
    for (const c of f.couriers) {
      const id = c.id === 'none' ? null : c.id;
      expect(c.count, c.name).toBe(pend.filter((o) => (o.deliveryProviderId ?? null) === id).length);
    }
    expect(f.noBarcode).toBe(pend.filter((o) => !o.trackingNumber).length);
    // NEGATIVE: the whole store's numbers are bigger — the narrowing is real.
    const { body: all } = await ask('');
    expect(all.facts.views.pending).toBe(pendingOf(S.tables.order).length);
    expect(all.facts.views.pending).toBeGreaterThan(f.views.pending);
  });

  it('pages keep the warehouse: every page is of it, the pages together are all of it, the total stays', async () => {
    await as('u-owner');
    const want = pendingOf(S.tables.order).filter(from(WB));
    expect(want.length).toBeGreaterThan(6);
    const seen: string[] = [];
    const pages = Math.ceil(want.length / 3);
    for (let page = 1; page <= pages; page++) {
      const { body } = await ask(`?warehouse=${WB}&limit=3&page=${page}`);
      expect(body.pagination).toMatchObject({ total: want.length, page, limit: 3, totalPages: pages });
      for (const row of body.orders) expect(row.sourceWarehouseName).toBe('مخزن ب');
      seen.push(...body.orders.map((o: Loose) => o.id));
    }
    expect(seen.sort()).toEqual(want.map((o) => o.id).sort());
  });

  it('with the other filters and the search, ANDed — never widened', async () => {
    await as('u-owner');
    const want = pendingOf(S.tables.order).filter(from(WA)).filter((o) => o.deliveryProviderId === C1);
    const { body } = await ask(`?warehouse=${WA}&courier=${C1}&limit=100`);
    expect(body.orders.map((o: Loose) => o.id).sort()).toEqual(want.map((o) => o.id).sort());
    const one = want[0];
    const { body: found } = await ask(`?warehouse=${WA}&q=${one.orderNumber}`);
    expect(found.orders.map((o: Loose) => o.id)).toEqual([one.id]);
    // The same parcel is not found under another warehouse.
    const { body: elsewhere } = await ask(`?warehouse=${WB}&q=${one.orderNumber}`);
    expect(elsewhere.orders).toEqual([]);
  });
});

describe('only a warehouse the person reaches', () => {
  const ids = async () => ((await (await offered()).json()) as Loose).warehouses.map((w: Loose) => w.id) as string[];

  it('the picker offers exactly the warehouses the list accepts — person by person', async () => {
    const expected: Record<string, string[]> = {
      'u-owner': [WA, WB],
      'u-clerk': [WA, WB],
      'u-keeper-b': [WB],
      'u-legacy': [WA, WB],
      'u-abroad': [],
    };
    for (const [person, want] of Object.entries(expected)) {
      await as(person);
      expect(await ids(), person).toEqual(want);
      for (const w of [WA, WB, W_STOPPED, W_ABROAD, W_OTHER_CO]) {
        const { status } = await ask(`?warehouse=${w}`);
        expect(status, `${person} ${w}`).toBe(want.includes(w) ? 200 : 400);
      }
      // «بلا مخزن» is not a warehouse anybody is kept out of.
      expect((await ask('?warehouse=none')).status, person).toBe(200);
    }
  });

  it('NEGATIVE: forced through the URL, a warehouse she does not reach is refused in Arabic, and no row is read', async () => {
    await as('u-keeper-b');
    const { status, body, asked } = await ask(`?warehouse=${WA}`);
    expect(status).toBe(400);
    expect(body.code).toBe('RETURNS_WAREHOUSE_UNKNOWN');
    expect(body.errorAr).toMatch(/[؀-ۿ]/);
    expect(body.error).toBe(body.errorAr);
    expect(asked.filter((c) => c.startsWith('order.'))).toEqual([]);
  });

  it('NEGATIVE: a stopped warehouse, another country’s, another company’s and a word that is no id — all refused', async () => {
    await as('u-owner');
    for (const w of [W_STOPPED, W_ABROAD, W_OTHER_CO, 'xyz', '%27%3B']) {
      expect((await ask(`?warehouse=${w}`)).status, w).toBe(400);
    }
  });
});

/* ───────────── a store that is NOT placed ───────────── */

const GOLDEN = join(__dirname, 'returns-warehouse-filter.main-golden.json');
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const URLS = [
  '',
  '?limit=5&page=2',
  '?view=received&limit=100',
  `?warehouse=${WA}`,
  `?warehouse=${WA}&limit=5&page=2`,
  `?view=received&warehouse=${WB}&limit=100`,
  '?warehouse=none',
  '?warehouse=xyz',
  `?warehouse=${W_OTHER_CO}&courier=${C1}`,
  '?warehouse=all&barcode=none',
] as const;

describe('a store that is not placed — the door answers what osm/main answered, byte for byte', () => {
  it('— every random store, every URL (the parameter in it or not): the same body as osm/main', async () => {
    const now: Record<string, { body: string; rows: number; asked: string[] }> = {};
    for (const seed of SEEDS) {
      for (const url of URLS) {
        world({ placed: false, seed, size: 12 + seed * 4 });
        await as('u-owner');
        const { status, body, asked } = await ask(url);
        expect(status, `${seed} ${url}`).toBe(200);
        // The one question this request adds — whether the store is placed — is asked only when the URL names a
        // warehouse; it is taken off here and pinned on its own below, so `asked` is still held to osm/main's.
        const named = new URLSearchParams(url).get('warehouse');
        const placementReads = asked.filter((c) => c.startsWith('warehousePlacement.'));
        // (osm/main's door, which writes the golden, asks it never.)
        if (process.env.F10_WRITE_GOLDEN !== '1') expect(placementReads.length, `${seed} ${url}`).toBe(named && named !== 'all' ? 1 : 0);
        now[`${seed} ${url}`] = {
          body: createHash('sha256').update(JSON.stringify(body)).digest('base64url'),
          rows: body.orders.length,
          asked: asked.filter((c) => !c.startsWith('warehousePlacement.')),
        };
      }
    }
    if (process.env.F10_WRITE_GOLDEN === '1') {
      writeFileSync(GOLDEN, JSON.stringify(now, null, 1) + '\n');
      return;
    }
    expect(existsSync(GOLDEN), 'the golden file of osm/main is missing').toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
    expect(Object.keys(now).sort()).toEqual(Object.keys(golden).sort());
    for (const key of Object.keys(golden)) {
      expect(now[key].body, key).toBe(golden[key].body);
      expect(now[key].rows, key).toBe(golden[key].rows);
      expect(now[key].asked, key).toEqual(golden[key].asked);
    }
    // Real rows, or the differential proves nothing.
    const rows = Object.values(golden as Record<string, { rows: number }>).reduce((n, g) => n + g.rows, 0);
    expect(rows).toBeGreaterThan(150);
  });

  it('NEGATIVE: the parameter reads no warehouse table and narrows nothing — the body is the one without it', async () => {
    world({ placed: false, seed: 3, size: 40 });
    await as('u-owner');
    const plain = await ask('?limit=100');
    for (const url of [`?warehouse=${WA}&limit=100`, '?warehouse=none&limit=100', '?warehouse=xyz&limit=100']) {
      const forced = await ask(url);
      expect(JSON.stringify(forced.body), url).toBe(JSON.stringify(plain.body));
      expect(forced.asked.filter((c) => /^(warehouse|store|country|user\w*Access)\./.test(c)), url).toEqual([]);
    }
    // And without the parameter the placement is not even asked.
    expect(plain.asked.filter((c) => c.startsWith('warehousePlacement.'))).toEqual([]);
  });
});
