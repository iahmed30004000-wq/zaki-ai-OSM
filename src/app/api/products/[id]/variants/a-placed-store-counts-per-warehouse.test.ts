import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE VARIANTS DOOR OF A PLACED STORE (the warehouse plan, W8a): a combination's count is a WAREHOUSE's, with a reason.
 *
 *   GET  says where each combination's pieces are (`places`, «بلا مكان» = warehouseId null).
 *   PUT  with `warehouseId` + `reason` is a count of that warehouse; a changed number without a warehouse is refused and
 *        nothing is written; options, labels and prices still save without one; the warehouse passes the receiving
 *        door's own checks (country, running, reached).
 * Whether a person reaches a warehouse is W0a's rule (`warehouses.reachesWarehouse`, tested there with persons built by
 * `computeEffectiveGrants`); here it is a switch, to prove the door ASKS it and obeys the answer.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- an in-memory row; every field is read by name
type Row = Record<string, any>;

const S = vi.hoisted(() => ({
  data: {} as Record<string, Row[]>,
  writes: [] as Row[],
  audit: [] as Row[],
  seq: 0,
  reaches: true,
  asked: [] as string[],
}));

vi.mock('@/lib/db', () => {
  const scalar = (v: unknown, c: unknown): boolean => {
    if (c === null) return v === null || v === undefined;
    if (c && typeof c === 'object' && !Array.isArray(c)) {
      const o = c as Row;
      if ('in' in o && !(o.in as unknown[]).includes(v)) return false;
      if ('not' in o && (o.not === null ? v === null || v === undefined : v === o.not)) return false;
      return true;
    }
    return v === c;
  };
  const matches = (r: Row, w: Row = {}): boolean => Object.entries(w).every(([k, c]) => c === undefined || scalar(r[k], c));
  const pick = (r: Row, select?: Row) => (select ? Object.fromEntries(Object.keys(select).filter((k) => select[k] === true).map((k) => [k, r[k]])) : { ...r });
  const t = (name: string) => {
    const rows = () => (S.data[name] ??= []);
    return {
      findMany: async ({ where, select }: Row = {}) => rows().filter((r) => matches(r, where)).map((r) => pick(r, select)),
      findFirst: async ({ where, select }: Row = {}) => {
        const r = rows().find((x) => matches(x, where));
        return r ? pick(r, select) : null;
      },
      findUnique: async ({ where, select }: Row) => {
        const r = rows().find((x) => matches(x, where));
        return r ? pick(r, select) : null;
      },
      groupBy: async () => [],
      aggregate: async ({ where, _sum }: Row) => {
        const hit = rows().filter((x) => matches(x, where));
        return { _sum: Object.fromEntries(Object.keys(_sum).map((k) => [k, hit.length ? hit.reduce((s, r) => s + r[k], 0) : null])) };
      },
      create: async ({ data, select }: Row) => {
        S.writes.push({ table: name, op: 'create', data });
        // The column's default, as the database applies it (`onHand Int @default(0)`).
        const row = { id: `${name}-${String(++S.seq).padStart(4, '0')}`, ...(name === 'productVariant' ? { onHand: 0 } : {}), ...data };
        rows().push(row);
        return pick(row, select);
      },
      update: async ({ where, data }: Row) => {
        const r = rows().find((x) => matches(x, where));
        if (!r) throw new Error('No record was found for an update.');
        S.writes.push({ table: name, op: 'update', id: r.id, data });
        Object.assign(r, data);
        return { ...r };
      },
      updateMany: async ({ where, data }: Row) => {
        const hit = rows().filter((x) => matches(x, where));
        S.writes.push({ table: name, op: 'updateMany', data });
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      },
    };
  };
  const names = ['product', 'productVariant', 'orderItemVariant', 'store', 'warehouse', 'warehousePlacement', 'productVariantStock', 'variantStockMovement'];
  const db: Row = Object.fromEntries(names.map((n) => [n, t(n)]));
  db.$executeRaw = async () => 1;
  db.$queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    if (sql.includes('FROM "warehouses"')) return (S.data.warehouse ?? []).filter((w) => w.id === values[0]);
    return [];
  };
  const tx = new Proxy(db, { has: (o, p) => p !== '$transaction' && p in o });
  db.$transaction = async (fn: (t: Row) => unknown) => fn(tx);
  return { db };
});
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({ user: { id: 'u-1', name: 'أمين', companyId: 'c-1' }, companyId: 'c-1', storeId: 's-1' }),
}));
vi.mock('@/lib/authorization', () => ({ authorize: () => ({ allowed: true }) }));
vi.mock('@/lib/audit', () => ({ logAudit: async (e: Row) => void S.audit.push(e) }));
vi.mock('@/lib/warehouses', () => ({
  reachesWarehouse: async (_u: unknown, _c: string, w: { id: string }) => {
    S.asked.push(w.id);
    return S.reaches;
  },
}));

import { GET, PUT } from './route';

const OPTIONS = [{ id: 'size', name: 'المقاس', values: [{ id: 's', label: 'S' }, { id: 'm', label: 'M' }] }];

beforeEach(() => {
  S.seq = 0;
  S.writes = [];
  S.audit = [];
  S.asked = [];
  S.reaches = true;
  S.data = {
    product: [{ id: 'p-1', companyId: 'c-1', storeId: 's-1', categoryId: null, name: 'قميص', basePrice: 10, variantOptions: JSON.stringify(OPTIONS) }],
    productVariant: [
      { id: 'v-s', companyId: 'c-1', productId: 'p-1', optionValues: '["s"]', label: 'S', sku: null, priceDelta: 0, onHand: 6, status: 'ACTIVE', sortOrder: 0 },
      { id: 'v-m', companyId: 'c-1', productId: 'p-1', optionValues: '["m"]', label: 'M', sku: null, priceDelta: 1, onHand: 3, status: 'ACTIVE', sortOrder: 1 },
    ],
    store: [{ id: 's-1', companyId: 'c-1', countryId: 'k-1' }],
    warehouse: [
      { id: 'w-1', companyId: 'c-1', countryId: 'k-1', isActive: true },
      { id: 'w-2', companyId: 'c-1', countryId: 'k-1', isActive: true },
      { id: 'w-off', companyId: 'c-1', countryId: 'k-1', isActive: false },
      { id: 'w-abroad', companyId: 'c-1', countryId: 'k-2', isActive: true },
      { id: 'w-other', companyId: 'c-2', countryId: 'k-1', isActive: true },
    ],
    warehousePlacement: [{ id: 'placing-1', storeId: 's-1' }],
    productVariantStock: [],
    variantStockMovement: [],
  };
});

const ctx = { params: Promise.resolve({ id: 'p-1' }) };
const put = (body: Row) => PUT(new Request('http://x/api/products/p-1/variants', { method: 'PUT', body: JSON.stringify(body) }), ctx);
const combos = (s: number, m: number, extra: Row = {}) => [
  { values: ['s'], priceDelta: 0, onHand: s, active: true, ...extra },
  { values: ['m'], priceDelta: 1, onHand: m, active: true },
];
const total = (id: string) => S.data.productVariant.find((v) => v.id === id)!.onHand;
const places = (id: string) =>
  S.data.productVariantStock.filter((p) => p.variantId === id).map((p) => [p.warehouseId, p.onHand]).sort((a, b) => (a[0] === null ? 1 : b[0] === null ? -1 : String(a[0]).localeCompare(String(b[0]))));

describe('GET: where each combination is', () => {
  it('a placed store says so, and a combination never counted is all «بلا مكان»', async () => {
    const res = await GET(new Request('http://x'), ctx);
    const json = await res.json();
    expect(json.placed).toBe(true);
    expect(json.combinations.map((c: Row) => [c.id, c.onHand, c.places])).toEqual([
      ['v-s', 6, [{ warehouseId: null, onHand: 6 }]],
      ['v-m', 3, [{ warehouseId: null, onHand: 3 }]],
    ]);
  });
});

describe('PUT without a warehouse', () => {
  it('a changed number is refused, with a code, and NOTHING is written', async () => {
    const res = await put({ options: OPTIONS, combinations: combos(7, 3) });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe('WAREHOUSE_REQUIRED');
    expect(json.errorAr).toMatch(/مخازن/);
    expect(S.writes).toEqual([]);
    expect(total('v-s')).toBe(6);
  });

  it('the old screen still saves a price, a sku and a label — the counts untouched, no ledger line', async () => {
    const res = await put({ options: OPTIONS, combinations: combos(6, 3, { sku: 'S-1' }) });
    expect(res.status).toBe(200);
    expect(S.data.productVariant.find((v) => v.id === 'v-s')!.sku).toBe('S-1');
    expect(S.writes.some((w) => w.table === 'productVariant' && 'onHand' in w.data)).toBe(false);
    expect(S.data.variantStockMovement).toEqual([]);
    expect([total('v-s'), total('v-m')]).toEqual([6, 3]);
  });

  it('a new combination may be added at 0; at anything else it is refused', async () => {
    const OPT2 = [{ ...OPTIONS[0], values: [...OPTIONS[0].values, { id: 'l', label: 'L' }] }];
    expect((await put({ options: OPT2, combinations: [...combos(6, 3), { values: ['l'], priceDelta: 0, onHand: 2, active: true }] })).status).toBe(400);
    const ok = await put({ options: OPT2, combinations: [...combos(6, 3), { values: ['l'], priceDelta: 0, onHand: 0, active: true }] });
    expect(ok.status).toBe(200);
    expect(S.data.productVariant.find((v) => v.optionValues === '["l"]')!.onHand).toBe(0);
  });
});

describe('PUT with a warehouse: a count, with a reason', () => {
  it('counted into two warehouses for the first time, the totals do not move; every change is a ledger line with the reason', async () => {
    expect((await put({ options: OPTIONS, combinations: combos(4, 3), warehouseId: 'w-1', reason: 'جرد أول' })).status).toBe(200);
    expect((await put({ options: OPTIONS, combinations: combos(2, 0), warehouseId: 'w-2', reason: 'جرد أول' })).status).toBe(200);
    expect(places('v-s')).toEqual([['w-1', 4], ['w-2', 2], [null, 0]]);
    expect(places('v-m')).toEqual([['w-1', 3], [null, 0]]);
    expect([total('v-s'), total('v-m')]).toEqual([6, 3]);
    const counts = S.data.variantStockMovement.filter((l) => l.type === 'COUNT');
    expect(counts.length).toBeGreaterThan(0);
    expect(counts.every((l) => l.reason === 'جرد أول' && l.createdById === 'u-1' && l.storeId === 's-1')).toBe(true);
    // Σ of the ledger = the total, per combination
    for (const id of ['v-s', 'v-m']) {
      expect(S.data.variantStockMovement.filter((l) => l.variantId === id).reduce((s, l) => s + l.quantity, 0)).toBe(total(id));
    }
    expect(S.audit.at(-1)!.newData.count).toEqual({ warehouseId: 'w-2', reason: 'جرد أول', changed: 1 });
    expect(S.asked).toEqual(['w-1', 'w-2']);
  });

  it('a count beyond what is known raises the total — a real surplus, written as one', async () => {
    await put({ options: OPTIONS, combinations: combos(9, 3), warehouseId: 'w-1', reason: 'لقينا زيادة' });
    expect(places('v-s')).toEqual([['w-1', 9], [null, 0]]);
    expect(total('v-s')).toBe(9);
  });

  it('a changed count with no reason is refused before anything is written', async () => {
    const res = await put({ options: OPTIONS, combinations: combos(5, 3), warehouseId: 'w-1', reason: ' ' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('REASON_REQUIRED');
    expect(S.writes).toEqual([]);
  });

  it('a count that matches what the warehouse holds needs no reason and moves nothing', async () => {
    await put({ options: OPTIONS, combinations: combos(4, 0), warehouseId: 'w-1', reason: 'جرد' });
    const lines = S.data.variantStockMovement.length;
    const res = await put({ options: OPTIONS, combinations: combos(4, 0), warehouseId: 'w-1' });
    expect(res.status).toBe(200);
    expect(S.data.variantStockMovement.length).toBe(lines);
  });

  it.each([
    ['w-nope', 400, 'WAREHOUSE_NOT_FOUND'],
    ['w-other', 400, 'WAREHOUSE_NOT_FOUND'],
    ['w-abroad', 400, 'WAREHOUSE_OTHER_COUNTRY'],
    ['w-off', 409, 'WAREHOUSE_STOPPED'],
  ])('warehouse %s is refused (%i %s) and nothing is written', async (warehouseId, status, code) => {
    const res = await put({ options: OPTIONS, combinations: combos(5, 3), warehouseId, reason: 'جرد' });
    expect(res.status).toBe(status);
    const json = await res.json();
    expect(json.code).toBe(code);
    expect(json.errorAr).toBe(json.error);
    expect(S.writes).toEqual([]);
  });

  it('a warehouse the person does not reach is refused — the door asks the reach rule and obeys it', async () => {
    S.reaches = false;
    const res = await put({ options: OPTIONS, combinations: combos(5, 3), warehouseId: 'w-1', reason: 'جرد' });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('WAREHOUSE_NOT_REACHED');
    expect(S.asked).toEqual(['w-1']);
    expect(S.writes).toEqual([]);
  });

  it('a combination dropped from the list is archived and keeps its pieces where they are', async () => {
    await put({ options: OPTIONS, combinations: combos(4, 3), warehouseId: 'w-1', reason: 'جرد' });
    await put({ options: OPTIONS, combinations: combos(4, 3).slice(0, 1), warehouseId: 'w-1', reason: 'جرد' });
    expect(S.data.productVariant.find((v) => v.id === 'v-m')!.status).toBe('ARCHIVED');
    expect(places('v-m')).toEqual([['w-1', 3], [null, 0]]);
    expect(total('v-m')).toBe(3);
  });
});
