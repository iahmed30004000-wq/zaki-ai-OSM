import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DEFINITION OF DONE — A1 (25/11): «الأرباح تقرأ الحالة الحقيقية، ومن يوم أول كشف».
 *
 * What must work:
 *   · THE SET. Delivered = `whereDelivered()` (`shippingStatus` DELIVERED or PARTIALLY_DELIVERED). An order the statement close promoted
 *     (it writes `shippingStatus` only) counts; a door delivery counts; the legacy `status: 'DELIVERED'` over a parcel that is NOT
 *     delivered by its shipping status does not. The commissions are asked over the SAME set.
 *   · THE FIGURE. One order brings in `collectedAmount` when the statement wrote it, else its `totalAmount`.
 *   · THE START LINE. `profitEpoch` = the first instant of the store-local DAY of the earliest courier statement that is not the open
 *     manual draft; null with no statement. It floors BOTH sides — orders by `deliveredAt`, expenses by `expenseDate` — with no window
 *     and inside one; a window wholly before it is zeros.
 * Every figure below is worked by hand from the rows written in the test, never by the function under test.
 */

type Row = Record<string, any>;

const { db, tables, commissionAsked } = vi.hoisted(() => {
  const tables = { order: [] as Row[], expense: [] as Row[], courierStatement: [] as Row[], commissionEntry: [] as Row[], store: [] as Row[] };
  const ok = (have: unknown, want: unknown): boolean => {
    if (want === null) return have === null || have === undefined;
    if (want && typeof want === 'object' && !(want instanceof Date)) {
      const w = want as Row;
      if (Array.isArray(w.in)) return w.in.includes(have);
      if ('not' in w) return w.not === null ? have !== null && have !== undefined : have !== w.not;
      const t = (have as Date | null)?.getTime?.();
      if (t === undefined || Number.isNaN(t)) return false;
      return (w.gte === undefined || t >= w.gte.getTime()) && (w.lt === undefined || t < w.lt.getTime()) && (w.lte === undefined || t <= w.lte.getTime());
    }
    return have === want;
  };
  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([key, want]) => (key === 'OR' ? (want as Row[]).some((w) => matches(row, w)) : ok(row[key], want)));
  const commissionAsked: Row[] = [];
  const byDate = (key: string, dir: 'asc' | 'desc') => (a: Row, b: Row) => (dir === 'asc' ? 1 : -1) * ((a[key]?.getTime?.() ?? 0) - (b[key]?.getTime?.() ?? 0));
  const db = {
    order: { findMany: vi.fn(async ({ where }: { where: Row }) => tables.order.filter((r) => matches(r, where)).sort(byDate('deliveredAt', 'desc'))) },
    expense: { findMany: vi.fn(async ({ where }: { where: Row }) => tables.expense.filter((r) => matches(r, where)).sort(byDate('expenseDate', 'desc'))) },
    courierStatement: {
      findMany: vi.fn(async ({ where }: { where: Row }) => tables.courierStatement.filter((r) => matches(r, where)).sort(byDate('createdAt', 'asc'))),
    },
    store: { findUnique: vi.fn(async ({ where }: { where: Row }) => tables.store.find((s) => s.id === where.id) ?? null) },
  };
  return { db, tables, commissionAsked };
});
vi.mock('./db', () => ({ db }));
// The ledger, evaluated: the entries of the orders the `where` names — so a wrong set shows up as a wrong commission.
vi.mock('./commission', () => ({
  commissionCostForOrders: async (where: Row) => {
    commissionAsked.push(where);
    const ids = new Set((await db.order.findMany({ where })).map((o: Row) => o.id));
    return tables.commissionEntry.filter((e) => ids.has(e.orderId)).reduce((s, e) => s + e.amount, 0);
  },
}));

import { profitEpoch, profitToDate, profitWindow } from './profit-to-date';

const SCOPE = { companyId: 'c1', storeId: 's1', timeZone: 'Asia/Damascus' };
const TZ = 'Asia/Damascus';
const at = (iso: string) => new Date(iso);

let n = 0;
const order = (over: Row): Row => ({
  id: `o${++n}`, orderNumber: `ORD-${n}`, companyId: 'c1', storeId: 's1', status: 'SHIPPED', shippingStatus: 'DELIVERED',
  totalAmount: 0, collectedAmount: null, shippingCost: 0, estimatedCostOfGoods: 0, deliveredAt: at('2026-11-05T10:00:00Z'), ...over,
});
const expense = (over: Row): Row => ({
  id: `e${++n}`, companyId: 'c1', storeId: 's1', amount: 0, voidedAt: null, expenseDate: at('2026-11-05T10:00:00Z'), ...over,
});
const statement = (createdAt: string, fileHash = `sha-${++n}`, storeId = 's1'): Row => ({ id: `cs${++n}`, companyId: 'c1', storeId, createdAt: at(createdAt), fileHash });

beforeEach(() => {
  for (const t of Object.values(tables)) t.length = 0;
  commissionAsked.length = 0;
  n = 0;
});

describe('THE SET — the shipping status, not the legacy column', () => {
  it('an order the statement close promoted (shippingStatus only, legacy still SHIPPED) counts', async () => {
    tables.order.push(order({ status: 'SHIPPED', shippingStatus: 'DELIVERED', totalAmount: 25, collectedAmount: 22 }));
    expect((await profitToDate(SCOPE)).summary.totalRevenue).toBe(22);
  });

  it('a delivery recorded at the door («استلم», legacy column untouched) counts', async () => {
    tables.order.push(order({ status: 'CONFIRMED', shippingStatus: 'DELIVERED', totalAmount: 40 }));
    expect((await profitToDate(SCOPE)).summary.totalRevenue).toBe(40);
  });

  it('NEGATIVE: the legacy column says DELIVERED but the parcel came back — it does NOT count, nor its commission', async () => {
    const back = order({ status: 'DELIVERED', shippingStatus: 'RETURNED', totalAmount: 999, shippingCost: 3, estimatedCostOfGoods: 100 });
    tables.order.push(back, order({ shippingStatus: 'DELIVERED', totalAmount: 10 }));
    tables.commissionEntry.push({ orderId: back.id, amount: 50 });
    const r = await profitToDate(SCOPE);
    expect(r.summary.totalRevenue).toBe(10);
    expect(r.summary.totalCOGS).toBe(0);
    expect(r.summary.totalShipping).toBe(0);
    expect(r.summary.totalCommissions).toBe(0);
    expect(r.deliveredOrders.map((o) => o.id)).not.toContain(back.id);
  });

  it.each(['NOT_SHIPPED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'RETURNED', 'RETURN_REQUESTED'])('NEGATIVE: shippingStatus %s does not count, whatever the legacy column says', async (s) => {
    tables.order.push(order({ status: 'DELIVERED', shippingStatus: s, totalAmount: 70 }));
    expect((await profitToDate(SCOPE)).summary.totalRevenue).toBe(0);
  });

  it('PARTIALLY_DELIVERED counts — at what was collected once the statement wrote it, at the order’s price before', async () => {
    tables.order.push(
      order({ shippingStatus: 'PARTIALLY_DELIVERED', totalAmount: 50, collectedAmount: 30 }),
      order({ shippingStatus: 'PARTIALLY_DELIVERED', totalAmount: 45, collectedAmount: null }),
    );
    expect((await profitToDate(SCOPE)).summary.totalRevenue).toBe(75); // 30 + 45
  });

  it('a collected ZERO is a figure, not a missing one (a statement that paid nothing for it)', async () => {
    tables.order.push(order({ totalAmount: 50, collectedAmount: 0 }));
    expect((await profitToDate(SCOPE)).summary.totalRevenue).toBe(0);
  });

  it('a Decimal-like collected amount (the column is Decimal) is read as its number', async () => {
    tables.order.push(order({ totalAmount: 50, collectedAmount: { toString: () => '12.345', valueOf: () => 12.345 } }));
    expect((await profitToDate(SCOPE)).summary.totalRevenue).toBe(12.35);
  });

  it('the commissions are asked over the SAME set: shippingStatus DELIVERED or PARTIALLY_DELIVERED, never the legacy column', async () => {
    const partial = order({ shippingStatus: 'PARTIALLY_DELIVERED', totalAmount: 50 });
    tables.order.push(partial);
    tables.commissionEntry.push({ orderId: partial.id, amount: 4 });
    const r = await profitToDate(SCOPE);
    expect(r.summary.totalCommissions).toBe(4);
    expect(commissionAsked[0]).toEqual({ companyId: 'c1', storeId: 's1', shippingStatus: { in: ['DELIVERED', 'PARTIALLY_DELIVERED'] } });
    expect(JSON.stringify(commissionAsked[0])).not.toContain('"status"');
  });

  it('cost of goods, shipping, expenses: the same arithmetic — a worked example', async () => {
    tables.order.push(
      order({ totalAmount: 100, collectedAmount: 90, shippingCost: 5, estimatedCostOfGoods: 30 }),
      order({ shippingStatus: 'PARTIALLY_DELIVERED', totalAmount: 60, shippingCost: 4, estimatedCostOfGoods: 10 }),
    );
    tables.expense.push(expense({ amount: 20 }), expense({ amount: 500, voidedAt: at('2026-11-06T00:00:00Z') }));
    const { summary } = await profitToDate(SCOPE);
    // revenue 90 + 60 = 150 · cost 40 · shipping 9 · commissions 0 · expenses 20 → net 81 · margin 54.0
    expect(summary).toEqual({
      totalRevenue: 150, totalCOGS: 40, totalShipping: 9, totalCommissions: 0, shippingAndCommissions: 9,
      totalOperationalExpenses: 20, netProfit: 81, profitMargin: 54,
    });
  });

  it('the rows go out in the shape they always had — `collectedAmount` is read, not added to the list', async () => {
    tables.order.push(order({ totalAmount: 100, collectedAmount: 90 }));
    const [row] = (await profitToDate(SCOPE)).deliveredOrders;
    expect(Object.keys(row)).not.toContain('collectedAmount');
    expect(row).toMatchObject({ orderNumber: 'ORD-1', totalAmount: 100 });
    // and the read asks for exactly the old columns plus the one the revenue needs
    const read = db.order.findMany.mock.calls.map((c) => c[0] as Row).find((q) => q.select);
    expect(read!.select).toEqual({
      id: true, orderNumber: true, totalAmount: true, collectedAmount: true, shippingCost: true, estimatedCostOfGoods: true, deliveredAt: true,
    });
  });
});

describe('THE START LINE — the day of the first courier statement', () => {
  it('no statement → null, and nothing is floored: an order and an expense from long ago both count', async () => {
    tables.order.push(order({ totalAmount: 100, deliveredAt: at('2025-01-01T10:00:00Z') }));
    tables.expense.push(expense({ amount: 30, expenseDate: at('2025-01-01T10:00:00Z') }));
    expect(await profitEpoch(SCOPE, TZ)).toBeNull();
    const r = await profitToDate(SCOPE);
    expect(r.since).toBeNull();
    expect(r.summary.netProfit).toBe(70);
  });

  it('is the first instant of the store’s LOCAL day: a statement at 01:00 Damascus on the 28th (27th 22:00 UTC) starts the 28th', async () => {
    tables.courierStatement.push(statement('2026-10-27T22:00:00Z'));
    expect(await profitEpoch(SCOPE, TZ)).toEqual({ at: at('2026-10-27T21:00:00.000Z'), day: '2026-10-28' });
  });

  it('the EARLIEST statement — stored out of order, still the first by its date', async () => {
    tables.courierStatement.push(statement('2026-11-10T09:00:00Z'), statement('2026-10-28T09:00:00Z'), statement('2026-11-01T09:00:00Z'));
    expect((await profitEpoch(SCOPE, TZ))!.day).toBe('2026-10-28');
  });

  it('NEGATIVE: the open manual draft is not a statement — an older draft does not move the start', async () => {
    tables.courierStatement.push(statement('2026-10-01T09:00:00Z', 'manual:draft:abc'), statement('2026-10-28T09:00:00Z', 'manual:0123'));
    expect((await profitEpoch(SCOPE, TZ))!.day).toBe('2026-10-28');
  });

  it('NEGATIVE: a store whose only statement is the open draft has no start line', async () => {
    tables.courierStatement.push(statement('2026-10-01T09:00:00Z', 'manual:draft:abc'));
    expect(await profitEpoch(SCOPE, TZ)).toBeNull();
  });

  it('the epoch query names the company AND the store — never the store alone', async () => {
    db.courierStatement.findMany.mockClear();
    await profitEpoch(SCOPE, TZ);
    expect((db.courierStatement.findMany.mock.calls[0][0] as Row).where).toEqual({ companyId: 'c1', storeId: 's1' });
  });

  it('NEGATIVE: another company’s statement under the same store id is not this store’s start', async () => {
    tables.courierStatement.push({ ...statement('2026-09-01T09:00:00Z'), companyId: 'c2' }, statement('2026-10-28T09:00:00Z'));
    expect((await profitEpoch(SCOPE, TZ))!.day).toBe('2026-10-28');
  });

  it('NEGATIVE: another store’s statement is not this store’s start', async () => {
    tables.courierStatement.push(statement('2026-09-01T09:00:00Z', 'sha-x', 's2'), statement('2026-10-28T09:00:00Z'));
    expect((await profitEpoch(SCOPE, TZ))!.day).toBe('2026-10-28');
  });

  it('without a timezone it reads the store’s own country clock: 22:30 UTC on the 27th is the 27th in UTC and the 28th in Amman', async () => {
    tables.courierStatement.push(statement('2026-10-27T22:30:00Z'));
    tables.store.push({ id: 's1', country: { timezone: 'UTC' } });
    expect(await profitEpoch({ companyId: 'c1', storeId: 's1' })).toEqual({ at: at('2026-10-27T00:00:00.000Z'), day: '2026-10-27' });
    tables.store[0].country.timezone = 'Asia/Amman';
    expect(await profitEpoch({ companyId: 'c1', storeId: 's1' })).toEqual({ at: at('2026-10-27T21:00:00.000Z'), day: '2026-10-28' });
  });
});

describe('THE FLOOR — on both sides, with no window and inside one', () => {
  beforeEach(() => {
    tables.courierStatement.push(statement('2026-10-28T09:00:00Z')); // epoch = 2026-10-27T21:00Z (Damascus)
    tables.order.push(
      order({ id: 'old', totalAmount: 1000, deliveredAt: at('2026-10-27T20:59:59Z') }), // the 27th, local — before
      order({ id: 'edge', totalAmount: 10, deliveredAt: at('2026-10-27T21:00:00Z') }), // the first instant of the 28th — counts
      order({ id: 'new', totalAmount: 100, deliveredAt: at('2026-11-10T10:00:00Z') }),
    );
    tables.expense.push(
      expense({ id: 'x-old', amount: 500, expenseDate: at('2026-10-20T10:00:00Z') }),
      expense({ id: 'x-new', amount: 30, expenseDate: at('2026-11-10T10:00:00Z') }),
    );
    tables.commissionEntry.push({ orderId: 'old', amount: 77 }, { orderId: 'new', amount: 5 });
  });

  it('no window: orders delivered and expenses spent from the epoch on — the old ones are not counted, on EITHER side', async () => {
    const r = await profitToDate(SCOPE);
    expect(r.deliveredOrders.map((o) => o.id).sort()).toEqual(['edge', 'new']);
    expect(r.expenses.map((e) => e.id)).toEqual(['x-new']);
    // revenue 110 · commissions 5 · expenses 30 → net 75
    expect(r.summary.totalRevenue).toBe(110);
    expect(r.summary.totalCommissions).toBe(5);
    expect(r.summary.totalOperationalExpenses).toBe(30);
    expect(r.summary.netProfit).toBe(75);
    expect(r.since).toEqual({ at: at('2026-10-27T21:00:00.000Z'), day: '2026-10-28' });
  });

  it('the commissions are floored with the orders: asked with the same `deliveredAt` from the epoch', async () => {
    await profitToDate(SCOPE);
    expect(commissionAsked[0]).toEqual({
      companyId: 'c1', storeId: 's1', shippingStatus: { in: ['DELIVERED', 'PARTIALLY_DELIVERED'] }, deliveredAt: { gte: at('2026-10-27T21:00:00.000Z') },
    });
  });

  it('a window that starts before the epoch is cut at it: 20/10 → 10/11 counts only from the 28th', async () => {
    const r = await profitToDate(SCOPE, profitWindow('2026-10-20', '2026-11-10', TZ));
    expect(r.summary.totalRevenue).toBe(110);
    expect(r.summary.totalOperationalExpenses).toBe(30);
  });

  it('a window wholly after the epoch is the window as asked', async () => {
    const r = await profitToDate(SCOPE, profitWindow('2026-11-10', '2026-11-10', TZ));
    expect(r.deliveredOrders.map((o) => o.id)).toEqual(['new']);
    expect(r.summary.netProfit).toBe(65); // 100 − 5 − 30
  });

  it('a window wholly BEFORE the epoch is zeros — and still says where the profit starts', async () => {
    const r = await profitToDate(SCOPE, profitWindow('2026-10-01', '2026-10-27', TZ));
    expect(r.summary).toEqual({
      totalRevenue: 0, totalCOGS: 0, totalShipping: 0, totalCommissions: 0, shippingAndCommissions: 0,
      totalOperationalExpenses: 0, netProfit: 0, profitMargin: 0,
    });
    expect(r.deliveredOrders).toEqual([]);
    expect(r.expenses).toEqual([]);
    expect(r.since!.day).toBe('2026-10-28');
  });

  it('a known epoch handed in is used, not read again', async () => {
    db.courierStatement.findMany.mockClear();
    const r = await profitToDate(SCOPE, null, { epoch: null });
    expect(db.courierStatement.findMany).not.toHaveBeenCalled();
    expect(r.summary.totalRevenue).toBe(1110); // no floor: old + edge + new
  });
});
