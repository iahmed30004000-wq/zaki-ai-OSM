import { beforeEach, describe, expect, it, vi } from 'vitest';
import { customerHistory, customerRisk, customerRiskMany } from './customer-risk';
import { isSuperseded, notSuperseded, supersededWhere } from './superseded';

/**
 * ONE PHONE, ONE PERSON, ONE RISK HISTORY — behaviourally, not by reading the
 * source.
 *
 * This module had no test at all, and it was the module that both declared the
 * invariant in its own docstring and broke it: the risk was computed by
 * `customerId`, and `Customer` is unique per `[companyId, storeId, phone]`. So
 * a customer who returned six of ten parcels at one shop arrived SAFE at the
 * shop next door.
 *
 * These assert the WHERE that goes to the database, because that clause IS the
 * invariant. A source match would have been satisfied by the helper existing
 * and nobody calling it.
 */

const tx = {
  customer: { findFirst: vi.fn() },
  order: { findMany: vi.fn() },
};

const NOW = new Date('2026-10-02T12:00:00.000Z');
const ago = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

beforeEach(() => {
  vi.clearAllMocks();
  tx.customer.findFirst.mockResolvedValue({ phone: '0999123456' });
  tx.order.findMany.mockResolvedValue([]);
});

const risk = () => customerRisk(tx as never, 'c1', 'cust-of-store-a', NOW);

describe('the question is asked about the PERSON', () => {
  it('both windows are scoped by phone across the company, never by the row id', async () => {
    await risk();
    const wheres = tx.order.findMany.mock.calls.map((c) => c[0].where);
    expect(wheres).toHaveLength(2);
    for (const w of wheres) {
      expect(w.customer).toEqual({ phone: '0999123456' });
      expect(w.companyId).toBe('c1');
      // The store's row id must not narrow it, and no storeId may appear.
      expect(w.customerId).toBeUndefined();
      expect(w.storeId).toBeUndefined();
    }
  });

  it('and the six-month window is the only one with a date bound', async () => {
    await risk();
    const [first, second] = tx.order.findMany.mock.calls.map((c) => c[0]);
    expect(first.where.createdAt.gte.getTime()).toBe(NOW.getTime() - 182 * 24 * 60 * 60 * 1000);
    expect(second.where.createdAt).toBeUndefined();
    expect(second.take).toBe(10);
    expect(second.orderBy).toEqual({ createdAt: 'desc' });
  });

  it('and a customer row that cannot be read falls back to the id, not to nothing', async () => {
    // Narrowing the question is honest; throwing would take down a
    // confirmation screen because one row is missing.
    tx.customer.findFirst.mockResolvedValue(null);
    await risk();
    for (const c of tx.order.findMany.mock.calls) {
      expect(c[0].where.customerId).toBe('cust-of-store-a');
      expect(c[0].where.customer).toBeUndefined();
    }
  });
});

describe('the tier is read off the window that says more', () => {
  const order = (shippingStatus: string, days: number, returnedAt?: Date) => ({
    shippingStatus,
    createdAt: ago(days),
    returnedAt: returnedAt ?? null,
  });

  it('six of ten returned is HIGH, and it is the SAME person across two stores', async () => {
    // Four of these orders belong to the other store's customer row. Before
    // the fix this call saw none of them.
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => order('RETURNED', 200 + i, ago(190 + i))),
      ...Array.from({ length: 4 }, (_, i) => order('DELIVERED', 210 + i)),
    ];
    // Older than six months, so the LAST TEN window is the fuller one.
    tx.order.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce(rows);
    const r = await risk();
    expect(r.orders).toBe(10);
    expect(r.returns).toBe(6);
    expect(r.tier).toBe('HIGH');
    expect(r.requiresPrepaymentOrApproval).toBe(true);
    expect(r.excludedFromAutomatedConfirmation).toBe(true);
    // `windowDays` is 0 when the last-ten window won: it is not a six-month
    // figure and must not be reported as one.
    expect(r.windowDays).toBe(0);
  });

  it('and two returns inside sixty days is HIGH on an otherwise clean record', async () => {
    const rows = [
      order('RETURNED', 10, ago(5)),
      order('FAILED_DELIVERY', 20, ago(15)),
      ...Array.from({ length: 48 }, (_, i) => order('DELIVERED', 30 + i)),
    ];
    tx.order.findMany.mockResolvedValueOnce(rows).mockResolvedValueOnce(rows.slice(0, 10));
    const r = await risk();
    expect(r.recentReturns60d).toBe(2);
    expect(r.tier).toBe('HIGH');
    expect(r.windowDays).toBe(182);
  });

  it('and a return dated by when it CAME BACK, not when it was ordered', async () => {
    // Ordered eleven months ago, returned last week. It is a recent return.
    const rows = [
      order('RETURNED', 330, ago(7)),
      order('RETURNED', 320, ago(3)),
      ...Array.from({ length: 40 }, (_, i) => order('DELIVERED', 10 + i)),
    ];
    tx.order.findMany.mockResolvedValueOnce(rows).mockResolvedValueOnce(rows.slice(0, 10));
    expect((await risk()).recentReturns60d).toBe(2);
  });

  it('and a customer with no orders at all is SAFE, not a division by zero', async () => {
    const r = await risk();
    expect(r.orders).toBe(0);
    expect(r.returnRate).toBe(0);
    expect(r.tier).toBe('SAFE');
  });
});

describe('the history is the same person’s, and it is the one resolver', () => {
  it('asks by phone, newest first, and can exclude the order in hand', async () => {
    await customerHistory(tx as never, 'c1', 'cust-of-store-a', { exceptOrderId: 'o-now' });
    const arg = tx.order.findMany.mock.calls[0][0];
    expect(arg.where.customer).toEqual({ phone: '0999123456' });
    expect(arg.where.id).toEqual({ not: 'o-now' });
    expect(arg.orderBy).toEqual({ createdAt: 'desc' });
    expect(arg.take).toBe(10);
  });

  it('and sends no phone, address or city back out', async () => {
    await customerHistory(tx as never, 'c1', 'cust-of-store-a');
    const select = tx.order.findMany.mock.calls[0][0].select;
    for (const leak of ['phone', 'address', 'city', 'customerNotes']) {
      expect(select[leak], leak).toBeUndefined();
    }
    expect(Object.keys(select).sort()).toEqual(
      ['confirmationStatus', 'createdAt', 'orderNumber', 'shippingStatus', 'totalAmount']
    );
  });

  it('and omits the exclusion entirely when there is nothing to exclude', async () => {
    await customerHistory(tx as never, 'c1', 'cust-of-store-a');
    expect(tx.order.findMany.mock.calls[0][0].where.id).toBeUndefined();
  });
});

/*
 * ─────────────────────────────────────────────────────────────────────────
 * THE DESK'S GROUPED LOOKUP GIVES EVERY ID THE FIGURE `customerRisk` GIVES.
 *
 * «طلباتي» used to run `customerRisk` once per customer in a `Promise.all`
 * (three queries each, up to ~750 at once into a pool of ten). The owner's
 * ruling 4/11: the agents' screens must not hang. `customerRiskMany` asks in a
 * fixed number of grouped queries — and the tier an agent sees must be the
 * very same, byte for byte.
 *
 * So both run against ONE in-memory database that answers the where clauses
 * the two of them send (and refuses any clause it does not know, so a new
 * filter cannot slip past as «matches everything»).
 * ─────────────────────────────────────────────────────────────────────────
 */
type FakeOrder = {
  id: string;
  companyId: string;
  customerId: string;
  shippingStatus: string;
  createdAt: Date;
  returnedAt: Date | null;
  superseded?: boolean;
};
type FakeCustomer = { id: string; companyId: string; phone: string };

function fakeDb(customers: FakeCustomer[], orders: FakeOrder[]) {
  const phoneOf = (customerId: string) => customers.find((c) => c.id === customerId)?.phone;
  const str = (v: unknown, actual: string | undefined) => {
    if (typeof v === 'string') return actual === v;
    if (v && typeof v === 'object' && 'in' in v) return (v as { in: string[] }).in.includes(actual as string);
    throw new Error(`unknown string filter ${JSON.stringify(v)}`);
  };
  const matches = (o: FakeOrder, w: Record<string, unknown>): boolean =>
    Object.entries(w).every(([k, v]) => {
      switch (k) {
        case 'companyId':
          return o.companyId === v;
        case 'customerId':
          return str(v, o.customerId);
        case 'customer':
          return str((v as { phone: unknown }).phone, phoneOf(o.customerId));
        case 'createdAt': {
          const f = v as { gte?: Date; lt?: Date };
          return (!f.gte || o.createdAt >= f.gte) && (!f.lt || o.createdAt < f.lt);
        }
        case 'NOT':
          // The one definition, recognised by identity: anything else is a clause this fake does not know.
          if (v !== supersededWhere) throw new Error('unknown NOT');
          return !(o.superseded ?? false);
        case 'AND':
          return (v as Record<string, unknown>[]).every((x) => matches(o, x));
        case 'OR':
          return (v as Record<string, unknown>[]).some((x) => matches(o, x));
        default:
          throw new Error(`unknown where key ${k}`);
      }
    });
  const project = (o: FakeOrder, select: Record<string, unknown>) =>
    Object.fromEntries(
      Object.keys(select).map((k) => [k, k === 'customer' ? { phone: phoneOf(o.customerId) } : o[k as keyof FakeOrder]])
    );
  const calls = { customer: 0, order: 0 };
  return {
    calls,
    db: {
      customer: {
        findFirst: vi.fn(async ({ where }: { where: { id: string; companyId: string } }) => {
          calls.customer++;
          const c = customers.find((x) => x.id === where.id && x.companyId === where.companyId);
          return c ? { phone: c.phone } : null;
        }),
        findMany: vi.fn(async ({ where }: { where: { id: { in: string[] }; companyId: string } }) => {
          calls.customer++;
          return customers
            .filter((x) => where.id.in.includes(x.id) && x.companyId === where.companyId)
            .map((c) => ({ id: c.id, phone: c.phone }));
        }),
      },
      order: {
        findMany: vi.fn(
          async (q: { where: Record<string, unknown>; select: Record<string, unknown>; orderBy?: unknown; take?: number }) => {
            calls.order++;
            let list = orders.filter((o) => matches(o, q.where));
            if (q.orderBy) list = [...list].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
            if (q.take !== undefined) list = list.slice(0, q.take);
            return list.map((o) => project(o, q.select));
          }
        ),
      },
    },
  };
}

describe('customerRiskMany — the same answer for a whole desk, in a fixed number of queries', () => {
  // Distinct timestamps: the last-ten cut is «newest first», and a tie would be the database's to break either way.
  let seq = 0;
  const o = (customerId: string, shippingStatus: string, days: number, extra: Partial<FakeOrder> = {}): FakeOrder => {
    seq += 1;
    return {
      id: `o${seq}`,
      companyId: 'c1',
      customerId,
      shippingStatus,
      createdAt: new Date(ago(days).getTime() - seq * 1000),
      returnedAt: null,
      ...extra,
    };
  };

  const customers: FakeCustomer[] = [
    { id: 'a1', companyId: 'c1', phone: '0911000001' }, // the same person as a2, at another store
    { id: 'a2', companyId: 'c1', phone: '0911000001' },
    { id: 'b', companyId: 'c1', phone: '0911000002' }, // twelve recent orders: the six-month window wins outright
    { id: 'd', companyId: 'c1', phone: '0911000004' }, // only old orders: the last ten win, windowDays 0
    { id: 'e', companyId: 'c1', phone: '0911000005' }, // no orders at all
    { id: 'f', companyId: 'c1', phone: '' }, // no phone: read by the row id
    { id: 'g', companyId: 'c2', phone: '0911000001' }, // another company, same phone — never counted
    { id: 'h', companyId: 'c1', phone: '0911000008' }, // two recent returns inside sixty days
  ];
  const orders: FakeOrder[] = [
    // a1 + a2: mixed, with a superseded return that must not count, and old history that fills the last ten.
    o('a1', 'RETURNED', 20, { returnedAt: ago(10) }),
    o('a2', 'DELIVERED', 30),
    o('a2', 'RETURNED', 40, { superseded: true }),
    o('a1', 'FAILED_DELIVERY', 300, { returnedAt: ago(290) }),
    ...Array.from({ length: 9 }, (_, i) => o(i % 2 ? 'a1' : 'a2', i % 3 ? 'DELIVERED' : 'RETURNED', 200 + i * 5)),
    // b: twelve recent, three returned, and one old return the six-month window leaves out.
    ...Array.from({ length: 12 }, (_, i) => o('b', i < 3 ? 'RETURN_REQUESTED' : 'DELIVERED', 5 + i * 10)),
    o('b', 'RETURNED', 400),
    // d: seven old orders, five of them returned — and an old superseded return the last ten must leave out too.
    ...Array.from({ length: 7 }, (_, i) => o('d', i < 5 ? 'RETURNED' : 'DELIVERED', 190 + i * 30)),
    o('d', 'RETURNED', 450, { superseded: true }),
    // f: read by id.
    o('f', 'RETURNED', 3),
    o('f', 'DELIVERED', 50),
    // g: the same phone in another company.
    { ...o('g', 'RETURNED', 2), companyId: 'c2' },
    { ...o('g', 'RETURNED', 4), companyId: 'c2' },
    // h: two returns that came back last month on otherwise clean recent orders.
    o('h', 'RETURNED', 90, { returnedAt: ago(20) }),
    o('h', 'RETURNED', 100, { returnedAt: ago(25) }),
    ...Array.from({ length: 14 }, (_, i) => o('h', 'DELIVERED', 10 + i)),
  ];
  // `missing` is an id the company does not have at all: narrowed to itself, as `samePerson` does.
  const ids = ['a1', 'a2', 'b', 'd', 'e', 'f', 'h', 'missing'];

  it('equals customerRisk for every id, deep-equal', async () => {
    const one = fakeDb(customers, orders);
    const expected: Record<string, Awaited<ReturnType<typeof customerRisk>>> = {};
    for (const id of ids) expected[id] = await customerRisk(one.db as never, 'c1', id, NOW);
    const many = fakeDb(customers, orders);
    const got = await customerRiskMany(many.db as never, 'c1', ids, NOW);
    expect(Object.fromEntries(ids.map((id) => [id, got.get(id)]))).toEqual(expected);
    // And the fixture is not vacuous: it holds every tier and both windows.
    expect(new Set(Object.values(expected).map((r) => r.tier))).toEqual(new Set(['SAFE', 'WATCH', 'HIGH']));
    expect(new Set(Object.values(expected).map((r) => r.windowDays))).toEqual(new Set([0, 182]));
    expect(expected.a1).toEqual(expected.a2);
    expect(expected.a1.orders).toBe(10);
    expect(expected.b.orders).toBe(12);
    expect(expected.e.orders).toBe(0);
    expect(expected.f.orders).toBe(2);
    expect(expected.d).toMatchObject({ orders: 7, returns: 5, windowDays: 0 });
    expect(expected.h.recentReturns60d).toBe(2);
  });

  it('the superseded flag in the fixture stands for the shared definition', () => {
    // `notSuperseded` is the NOT the fake recognises by identity; `isSuperseded` is its in-memory twin.
    expect(notSuperseded).toEqual({ NOT: supersededWhere });
    expect(isSuperseded({ replacedBy: null, activities: [] })).toBe(false);
  });

  it('and the number of queries does not grow with the number of customers', async () => {
    const counts: number[] = [];
    for (const n of [1, 5, 50]) {
      const cs: FakeCustomer[] = Array.from({ length: n }, (_, i) => ({ id: `x${i}`, companyId: 'c1', phone: `09${i}` }));
      const os = cs.flatMap((c, i) => [o(c.id, 'DELIVERED', 10 + i), o(c.id, 'RETURNED', 250 + i)]);
      const f = fakeDb(cs, os);
      const got = await customerRiskMany(f.db as never, 'c1', cs.map((c) => c.id), NOW);
      expect(got.size).toBe(n);
      counts.push(f.calls.customer + f.calls.order);
    }
    expect(counts[0]).toBeLessThanOrEqual(3);
    expect(new Set(counts).size).toBe(1);
  });

  it('and «طلباتي» asks it once for the desk, never one customer at a time', async () => {
    const { readFileSync } = await import('node:fs');
    const route = readFileSync('src/app/api/confirmation/mine/route.ts', 'utf8');
    expect(route).toMatch(/await customerRiskMany\(db, companyId, customerIds\)/);
    expect(route).not.toMatch(/customerRisk\(/);
  });

  it('and an empty desk asks nothing', async () => {
    const f = fakeDb([], []);
    expect((await customerRiskMany(f.db as never, 'c1', [], NOW)).size).toBe(0);
    expect(f.calls.customer + f.calls.order).toBe(0);
  });
});
