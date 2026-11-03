import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE COUNTS ABOVE THE ORDERS LIST ARE THE ROWS UNDER IT — FOR WHOEVER IS READING.
 *
 * `orderVisibilityWhere` is the list filter AND the read permission, so a count asked in any other words is a window onto
 * orders the reader cannot open. These run the REAL list door, the REAL summary door, the REAL `rbac.ts` and the REAL
 * `authorization.ts` against a small table that answers each query by its WHERE — a door that asks the wrong question gets
 * the wrong number back, not whatever a mock was told.
 *
 *   · an agent's chip for each state equals the number of rows the list gives her for that state, and the chips add up to
 *     her whole list — her colleague's order, the pool and another store's order are in none of them;
 *   · the cards are her list as filtered: how many, their total, the average;
 *   · profit: absent from her summary AND her rows; present, and the database's own sum, for the owner.
 *
 * Mutation-checked: with the summary's `groupBy` asked on `{ companyId, storeId }` instead of the list's question, the
 * agent's chips count the colleague's and the pool's orders and the first test fails.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Row = Record<string, any>;

const { tables, state } = vi.hoisted(() => ({
  tables: { orders: [] as Row[] },
  state: { user: null as unknown as SessionUser },
}));

vi.mock('@/lib/db', () => {
  const same = (a: unknown, b: unknown) =>
    a instanceof Date || b instanceof Date ? +new Date(a as Date) === +new Date(b as Date) : a === b;
  function holds(value: unknown, filter: unknown): boolean {
    if (filter === null) return value === null || value === undefined;
    if (typeof filter !== 'object' || filter instanceof Date) return same(value ?? null, filter);
    return Object.entries(filter as Row).every(([op, arg]) => {
      switch (op) {
        case 'in': return (arg as unknown[]).some((x) => same(value, x));
        case 'notIn': return !(arg as unknown[]).some((x) => same(value, x));
        case 'not': return !holds(value, arg);
        case 'lte': return value != null && +(value as number) <= +(arg as number);
        case 'gte': return value != null && +(value as number) >= +(arg as number);
        default: throw new Error(`the fake table does not know «${op}» — teach it before trusting it`);
      }
    });
  }
  function matches(row: Row, where: unknown): boolean {
    if (!where) return true;
    return Object.entries(where as Row).every(([key, value]) => {
      if (key === 'AND') return (Array.isArray(value) ? value : [value]).every((w) => matches(row, w));
      if (key === 'OR') return (value as unknown[]).some((w) => matches(row, w));
      if (key === 'NOT') return !(Array.isArray(value) ? value : [value]).some((w) => matches(row, w));
      return holds(row[key], value);
    });
  }
  const hits = (where: unknown) => tables.orders.filter((r) => matches(r, where));
  const db = {
    order: {
      count: async ({ where }: Row) => hits(where).length,
      findMany: async ({ where, skip = 0, take }: Row) =>
        hits(where).slice(skip, take ? skip + take : undefined).map((r) => ({ ...r })),
      groupBy: async ({ by, where }: Row) => {
        const groups = new Map<string, Row>();
        for (const r of hits(where)) {
          const key = JSON.stringify((by as string[]).map((k) => r[k] ?? null));
          const g = groups.get(key) ?? { ...Object.fromEntries((by as string[]).map((k) => [k, r[k] ?? null])), _count: { _all: 0 } };
          g._count._all += 1;
          groups.set(key, g);
        }
        return [...groups.values()];
      },
      aggregate: async ({ where, _count, _sum }: Row) => {
        const rows = hits(where);
        const count: Row = { _all: rows.length };
        for (const k of Object.keys(_count ?? {})) if (k !== '_all') count[k] = rows.filter((r) => r[k] != null).length;
        const sum: Row = {};
        for (const k of Object.keys(_sum ?? {})) sum[k] = rows.reduce((t, r) => t + Number(r[k] ?? 0), 0);
        return { _count: count, _sum: sum };
      },
    },
  };
  return { db, default: db };
});
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({
    user: state.user,
    companyId: 'c1',
    storeId: 's1',
    countryId: 'co1',
    country: { id: 'co1', code: 'JO', currencyCode: 'JOD', minorUnit: 3, timezone: 'Asia/Amman' },
  }),
}));
vi.mock('@/lib/auth', () => ({ requireAuth: async () => state.user }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: vi.fn() }));

import { GET as listGET } from '@/app/api/orders/route';
import { GET as summaryGET } from '@/app/api/orders/summary/route';
import { FILTERABLE_STATES } from '@/lib/order-state';

type Scope = 'ALL_COMPANY' | 'ASSIGNED' | 'OWN';
function person(id: string, role: string, grants: Record<string, Scope>): SessionUser {
  return {
    id, email: `${id}@x.test`, name: id, role: role as SessionUser['role'], status: 'ACTIVE',
    companyId: 'c1', permissions: Object.keys(grants),
    effectiveGrants: {
      fullAccess: false,
      grants: Object.fromEntries(Object.entries(grants).map(([k, scope]) => [k, { scope, scopeIds: null }])),
    },
  } as SessionUser;
}

/** The agent who sees what she holds, what is held for her and what she typed — not the pool, not a colleague's. */
const AGENT = person('u1', 'CONFIRMATION_AGENT', { 'orders.view': 'ASSIGNED', 'confirmation.pull': 'ALL_COMPANY' });
/** The owner's money keys: the finance key AND the cost key, as `maySeeOrderCost` asks. */
const OWNER = person('own', 'COMPANY_ADMIN', { 'orders.view': 'ALL_COMPANY', 'finance.view': 'ALL_COMPANY', 'costs.view': 'ALL_COMPANY' });
/** Finance without the cost key — a margin is not his. */
const FINANCE_ONLY = person('fin', 'ACCOUNTANT', { 'orders.view': 'ALL_COMPANY', 'finance.view': 'ALL_COMPANY' });

function order(id: string, over: Row = {}): Row {
  return {
    id, orderNumber: `JO-${id}`, companyId: 'c1', storeId: 's1', customerId: `cu-${id}`,
    claimedById: null, currentOwnerId: null, assignedToId: null, assignedAt: null, createdById: null, moderatorId: null,
    confirmationStatus: 'NEW', shippingStatus: 'NOT_READY', settlementStatus: 'NOT_APPLICABLE', status: 'NEW',
    signatureStatus: 'UNSIGNED', lockedById: null, lockExpiresAt: null, shippedAt: null, labelPrintedAt: null,
    totalAmount: 10, sellingPrice: 10, quantity: 1, estimatedCostOfGoods: 4, netProfit: null, grossProfit: null,
    productCost: null, source: 'Manual', createdAt: new Date('2026-11-02T08:00:00.000Z'),
    customer: { id: `cu-${id}`, fullName: 'زبون', phone: '0790000000', rawPhone: '0790000000', city: 'عمّان', address: 'عمّان', totalOrders: 1 },
    product: null, offer: null, moderator: null, region: null, deliveryProvider: null, assignee: null,
    _count: { claimHistory: 0 }, returnReceipt: null,
    ...over,
  };
}

const ask = async (door: (r: Request) => Promise<Response>, path: string, qs = '') => {
  const res = await door(new Request(`http://localhost${path}${qs ? `?${qs}` : ''}`));
  return { status: res.status, body: await res.json() };
};
const listTotal = async (qs = '') => (await ask(listGET, '/api/orders', qs)).body.pagination.total as number;
const summary = async (qs = '') => (await ask(summaryGET, '/api/orders/summary', qs)).body;

beforeEach(() => {
  tables.orders = [
    order('mine-claimed', { claimedById: 'u1', currentOwnerId: 'u1', confirmationStatus: 'IN_PROGRESS', totalAmount: 20 }),
    order('mine-confirmed', { claimedById: 'u1', confirmationStatus: 'CONFIRMED', totalAmount: 30, estimatedCostOfGoods: 12, netProfit: 9.5 }),
    order('mine-shipped', { currentOwnerId: 'u1', confirmationStatus: 'CONFIRMED', shippingStatus: 'SHIPPED', totalAmount: 40 }),
    order('mine-typed-cancelled', { createdById: 'u1', confirmationStatus: 'CANCELLED', totalAmount: 15 }),
    order('held-for-her', { assignedToId: 'u1', assignedAt: new Date(), totalAmount: 25 }),
    // Not hers: a colleague's, the pool, and her own order in another store.
    order('colleague-confirmed', { claimedById: 'u2', confirmationStatus: 'CONFIRMED', totalAmount: 500, estimatedCostOfGoods: 200, netProfit: 100 }),
    order('pool-new', { totalAmount: 700 }),
    order('mine-other-store', { storeId: 's2', claimedById: 'u1', confirmationStatus: 'CONFIRMED', totalAmount: 900 }),
  ];
});

describe('an agent’s counts are the rows she can open', () => {
  it('each chip equals her list filtered to that state, and the chips add up to her whole list', async () => {
    state.user = AGENT;
    const s = await summary();
    const total = await listTotal();
    expect(total).toBe(5);
    expect(s.countsTotal).toBe(total);

    let sum = 0;
    for (const { state: st, count } of s.counts as { state: string; count: number }[]) {
      expect(count, st).toBe(await listTotal(`status=${st}`));
      sum += count;
    }
    expect(sum).toBe(total);
    // Not vacuous: the states she has are really counted, and the colleague's CONFIRMED is not among hers.
    const of = (st: string) => (s.counts as { state: string; count: number }[]).find((c) => c.state === st)?.count;
    expect(of('CONFIRMED')).toBe(1);
    expect(of('CLAIMED')).toBe(1);
    expect(of('NEW')).toBe(1);
    expect(of('SHIPPED')).toBe(1);
    expect(of('CANCELLED')).toBe(1);
  });

  it('the chips ignore the state filter — a chip says what pressing it would show — and the cards do not', async () => {
    state.user = AGENT;
    const s = await summary('status=CONFIRMED');
    expect(s.countsTotal).toBe(await listTotal());
    expect(s.cards.orders).toBe(await listTotal('status=CONFIRMED'));
    expect(s.cards).toMatchObject({ orders: 1, value: 30, average: 30 });
  });

  it('the other filters narrow the chips as they narrow the list', async () => {
    state.user = AGENT;
    const s = await summary('holderId=u1');
    expect(s.countsTotal).toBe(await listTotal('holderId=u1'));
    expect(s.countsTotal).toBe(2);
  });

  it('her cards carry no profit — and her rows no cost or profit', async () => {
    state.user = AGENT;
    const s = await summary();
    expect(s.cards).toEqual({ orders: 5, value: 130, average: 26 });
    expect('profit' in s.cards).toBe(false);
    const rows = (await ask(listGET, '/api/orders')).body.orders as Row[];
    expect(rows.length).toBe(5);
    for (const r of rows) {
      expect('estimatedCostOfGoods' in r).toBe(false);
      expect('netProfit' in r).toBe(false);
    }
  });

  it('a state filter she cannot use is refused here as it is on the list', async () => {
    state.user = AGENT;
    expect((await ask(summaryGET, '/api/orders/summary', 'status=NOT_A_STATE')).status).toBe(400);
  });

  it('nobody without «عرض الطلبات» gets a figure', async () => {
    state.user = person('x', 'WAREHOUSE', { 'products.view': 'ALL_COMPANY' });
    const r = await ask(summaryGET, '/api/orders/summary');
    expect(r.status).toBe(403);
    expect(r.body.counts).toBeUndefined();
  });
});

describe('the owner’s cards carry the money', () => {
  it('profit is the finalised net profit and how many orders carry one — and there is no cost card', async () => {
    state.user = OWNER;
    const s = await summary();
    expect(s.countsTotal).toBe(await listTotal());
    expect(s.countsTotal).toBe(7);
    expect(s.cards.orders).toBe(7);
    expect(s.cards.value).toBe(20 + 30 + 40 + 15 + 25 + 500 + 700);
    expect(s.cards.profit).toEqual({ value: 109.5, orders: 2 });
    expect('cost' in s.cards).toBe(false);
  });

  it('the finance key alone opens no margin (both keys, as on the rows)', async () => {
    state.user = FINANCE_ONLY;
    const s = await summary();
    expect('profit' in s.cards).toBe(false);
  });

  it('every chip is a filterable state, in the dropdown’s order', async () => {
    state.user = OWNER;
    const s = await summary();
    expect((s.counts as { state: string }[]).map((c) => c.state)).toEqual(FILTERABLE_STATES);
  });
});
