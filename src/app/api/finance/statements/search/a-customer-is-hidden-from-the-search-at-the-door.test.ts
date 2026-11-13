import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «بحث بكل الكشوف» — THE DOOR, END TO END: the real route, the real library, and a database that really answers.
 *
 * `route.test.ts` pins what the route hands the search (the address-book key, the session's scope); `lib/statement-search.test.ts`
 * pins what the search does with it. This is the two together, through `GET`: who may type a customer's name or phone and who may
 * not, what never leaves the door, and the cut at fifty — so a wrong wire between the key and the query cannot pass with both of
 * those green.
 */

const { db, requireContext, requirePermission, can, contact, reads } = vi.hoisted(() => ({
  db: {} as Record<string, unknown>,
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  can: vi.fn(),
  contact: { value: false },
  reads: { count: 0 },
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: (...a: unknown[]) => requirePermission(...a),
  can: (...a: unknown[]) => can(...a),
}));

import { GET } from './route';

type Any = Record<string, any>;

/** The few shapes of `where` the search writes: equality, `contains` (with or without case), `is`, `some`, `in`, `AND`, `OR`. */
function matches(where: Any, row: Any): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as Any[]).every((w) => matches(w, row));
    if (key === 'OR') return (cond as Any[]).some((w) => matches(w, row));
    const value = row[key];
    if (cond === null) return value === null || value === undefined;
    if (cond instanceof Date || typeof cond !== 'object') return value === cond;
    if ('contains' in cond) {
      if (typeof value !== 'string') return false;
      const i = cond.mode === 'insensitive';
      return (i ? value.toLowerCase() : value).includes(i ? String(cond.contains).toLowerCase() : String(cond.contains));
    }
    if ('is' in cond) return cond.is === null ? value == null : value != null && matches(cond.is, value);
    if ('some' in cond) return Array.isArray(value) && value.some((v) => matches(cond.some, v));
    if ('in' in cond) return (cond.in as unknown[]).includes(value);
    // A relation that is not there (an order with no customer) answers no question.
    if (value === null || value === undefined) return false;
    if (typeof value === 'object') return matches(cond, value);
    throw new Error(`the evaluator does not know «${JSON.stringify(cond)}» for ${key}`);
  });
}
const keyOf = (row: Any, spec: Any): { value: any; dir: string } => {
  const [k, v] = Object.entries(spec)[0];
  return typeof v === 'string' ? { value: row[k] instanceof Date ? row[k].getTime() : row[k], dir: v } : keyOf(row[k], v as Any);
};
const sorted = (rows: Any[], orderBy: Any[]) =>
  [...rows].sort((a, b) => {
    for (const spec of orderBy) {
      const x = keyOf(a, spec);
      const y = keyOf(b, spec);
      if (x.value < y.value) return x.dir === 'asc' ? -1 : 1;
      if (x.value > y.value) return x.dir === 'asc' ? 1 : -1;
    }
    return 0;
  });

const NAME = 'سارة الأحمد';
const PHONE = '0933620102';

function load() {
  const at = (iso: string) => new Date(iso);
  const stmt = (id: string, over: Any = {}): Any => ({
    id, companyId: 'c1', storeId: 's1', reference: `ST-${id}`, createdAt: at('2026-11-01T10:00:00Z'), status: 'MATCHED', approvedAt: null,
    matchingClosedAt: null, fileHash: `sha-${id}`, currencyCode: 'JOD', deliveryProviderId: 'p1', ...over,
  });
  const a = stmt('A');
  const bulk = stmt('B', { createdAt: at('2026-12-01T10:00:00Z') });
  const other = stmt('X', { storeId: 's2' });
  const o1 = { id: 'o1', companyId: 'c1', storeId: 's1', orderNumber: 'ORD-1001', merchantRef: null, trackingNumber: null, customer: { fullName: NAME, phone: '933620102', rawPhone: PHONE } };
  const lines: Any[] = [];
  const rows: Any[] = [];
  const line = (s: Any, over: Any): Any => {
    const l = { id: `l${lines.length}`, statementId: s.id, barcode: null, merchantRef: null, receiverName: null, receiverPhone: null, rawRow: null, createdAt: at('2026-11-01T10:00:00Z'), statement: s, matches: [] as Any[], ...over };
    lines.push(l);
    return l;
  };
  const l1 = line(a, { barcode: 'BC-1', receiverName: 'سارة', receiverPhone: PHONE });
  const m1 = { id: 'm1', companyId: 'c1', statementId: 'A', statementLineId: l1.id, orderId: 'o1', result: 'MATCHED', resolution: null, expectedAmount: '20', statementAmount: '20', difference: '0', createdAt: at('2026-11-01T10:00:00Z'), order: o1, statement: a };
  l1.matches.push(m1);
  rows.push(m1);
  line(other, { barcode: 'BC-1', receiverName: 'سارة', receiverPhone: PHONE });
  for (let k = 0; k < 60; k++) line(bulk, { barcode: `MANY-${String(k).padStart(2, '0')}`, createdAt: at(`2026-12-01T10:${String(k).padStart(2, '0')}:00Z`) });
  // …and three of OUR orders that statement did not name, whose number also says «MANY»: the count is lines and unnamed orders together.
  const oMany = { id: 'oM', companyId: 'c1', storeId: 's1', orderNumber: 'MANY-ORDER', merchantRef: null, trackingNumber: null, customer: null };
  for (let k = 0; k < 3; k++) {
    rows.push({ id: `mu${k}`, companyId: 'c1', statementId: 'B', statementLineId: null, orderId: 'oM', result: 'MISSING_IN_STATEMENT', resolution: null, expectedAmount: '15', statementAmount: null, difference: null, createdAt: at('2026-12-01T11:00:00Z'), order: oMany, statement: bulk });
  }

  const providers = [{ id: 'p1', companyId: 'c1', name: 'أمان' }];
  db.statementLine = {
    count: async ({ where }: { where: Any }) => (reads.count++, lines.filter((r) => matches(where, r)).length),
    findMany: async ({ where, orderBy, take }: { where: Any; orderBy: Any[]; take: number }) =>
      (reads.count++, sorted(lines.filter((r) => matches(where, r)), orderBy).slice(0, take).map((r) => ({ ...r, matches: r.matches.slice(0, 1) }))),
  };
  db.settlementMatch = {
    count: async ({ where }: { where: Any }) => (reads.count++, rows.filter((r) => matches(where, r)).length),
    findMany: async ({ where, orderBy, take }: { where: Any; orderBy: Any[]; take: number }) =>
      (reads.count++, sorted(rows.filter((r) => matches(where, r)), orderBy).slice(0, take)),
  };
  db.deliveryProvider = {
    findMany: async ({ where }: { where: Any }) => (reads.count++, providers.filter((p) => matches(where, p)).map(({ id, name }) => ({ id, name }))),
  };
}

const get = (query: string) => GET(new Request(`http://x/api/finance/statements/search?${query}`));
const search = async (q: string) => {
  const res = await get(`q=${encodeURIComponent(q)}`);
  return { status: res.status, body: await res.json() };
};

beforeEach(() => {
  vi.clearAllMocks();
  reads.count = 0;
  contact.value = false;
  load();
  requireContext.mockResolvedValue({ user: { id: 'u1', status: 'ACTIVE' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 3 } });
  requirePermission.mockResolvedValue({ id: 'u1' });
  can.mockImplementation((_user: unknown, key: string) => key === 'customers.view' && contact.value);
});

describe('who may type a customer’s name or a phone — through the real door', () => {
  it('WITHOUT the address-book key: the name, the phone and the line’s own receiver find nothing — in any spelling', async () => {
    for (const q of [NAME, 'الأحمد', 'سارة', PHONE, '933620102', '+963 933 620 102']) {
      const { status, body } = await search(q);
      expect(status, q).toBe(200);
      expect(body, q).toMatchObject({ hits: [], total: 0 });
    }
  });

  it('WITHOUT the key the order number and the barcode still find the line — the box is not switched off, its customer clauses are', async () => {
    for (const q of ['ORD-1001', 'BC-1']) {
      const { body } = await search(q);
      expect(body.total, q).toBe(1);
      expect(body.hits[0].statement.reference, q).toBe('ST-A');
    }
  });

  it('WITH the key: the name and the phone find the line', async () => {
    contact.value = true;
    for (const q of [NAME, 'الأحمد', 'سارة', PHONE, '933620102', '+963 933 620 102']) {
      const { body } = await search(q);
      expect(body.total, q).toBe(1);
      expect(body.hits[0].statement.reference, q).toBe('ST-A');
    }
  });

  it('whoever asks, no name, no phone, no hash and no row is in what comes back', async () => {
    for (const may of [false, true]) {
      contact.value = may;
      const text = JSON.stringify((await search('ORD-1001')).body);
      for (const secret of [NAME, 'سارة', PHONE, '933620102', 'sha-', 'rawRow', 'receiver', 'fullName', 'fileHash']) {
        expect(text.includes(secret), `${secret} (${may})`).toBe(false);
      }
    }
  });
});

describe('the cut and the scope — through the real door', () => {
  it('sixty lines and three unnamed orders: fifty come back, the count says sixty-three, the limit says fifty', async () => {
    const { body } = await search('MANY-');
    expect(body.hits).toHaveLength(50);
    expect(body.total).toBe(63);
    expect(body.limit).toBe(50);
  });

  it('another store’s line that carries the same barcode is never in the answer', async () => {
    const { body } = await search('BC-1');
    expect(body.total).toBe(1);
    expect(body.hits.map((h: Any) => h.statement.reference)).toEqual(['ST-A']);
  });

  it('refused without the key, nothing is read — not a count, not a line', async () => {
    requirePermission.mockRejectedValue(new Error('Forbidden: missing required permission settlement.view'));
    expect((await get('q=ORD-1001')).status).toBe(403);
    expect(reads.count).toBe(0);
  });
});
