import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AN EXPENSE BELONGS TO A STORE — AND A STORE'S PROFIT SUBTRACTS ITS OWN.
 *
 * `GET /api/finance` read `where: { companyId }`, so every store's profit subtracted every store's expenses. A
 * new expense now carries the store it was recorded in; one recorded before the column existed (store null) is
 * read exactly as it was; a cancelled one costs nothing. This runs the real route over an in-memory expenses
 * table that evaluates the `where` it is handed, so a missing condition shows up as a wrong total.
 *
 * WORKED EXAMPLE (the one in the pull request):
 *   e1  store 1   100        e2  store 2   70        e3  no store   40        e4  store 1   25 — cancelled
 *   store 1 subtracts  e1 + e3          = 140   (before: 100 + 70 + 40 + 25 = 235)
 *   store 2 subtracts  e2 + e3          = 110
 *   the company        e1 + e2 + e3     = 210
 */

type Row = Record<string, any>;

const { db, rows, requireContext, requirePermission, logAudit } = vi.hoisted(() => {
  const rows: Row[] = [];
  const inRange = (v: Date, r: { gte?: Date; lte?: Date }) => (!r.gte || v >= r.gte) && (!r.lte || v <= r.lte);
  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([key, want]) => {
      if (key === 'OR') return (want as Row[]).some((w) => matches(row, w));
      if (key === 'expenseDate') return inRange(row.expenseDate, want as { gte?: Date; lte?: Date });
      return row[key] === want;
    });
  const db: Record<string, any> = {
    expense: {
      findMany: vi.fn(async ({ where }: { where: Row }) => rows.filter((r) => matches(r, where))),
      groupBy: vi.fn(async ({ where }: { where: Row }) => {
        const hit = rows.filter((r) => matches(r, where));
        const byCategory = new Map<string, Row[]>();
        for (const r of hit) byCategory.set(r.category, [...(byCategory.get(r.category) ?? []), r]);
        return [...byCategory].map(([category, list]) => ({
          category, _count: { _all: list.length }, _sum: { amount: list.reduce((s, r) => s + r.amount, 0) },
        }));
      }),
      create: vi.fn(),
      update: vi.fn(),
    },
    order: { findMany: vi.fn(async () => []) },
    wallet: { findFirst: vi.fn() },
    walletMovement: { create: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return { db, rows, requireContext: vi.fn(), requirePermission: vi.fn(), logAudit: vi.fn() };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/commission', () => ({ commissionCostForOrders: async () => 0 }));
vi.mock('@/lib/analytics', () => ({
  getCompanyAnalytics: async () => ({ financials: { deliveredRevenue: 0 } }),
  getDateRange: () => ({ start: new Date('2026-10-01T00:00:00Z'), end: new Date('2026-10-31T23:59:59Z') }),
  previousRange: () => null,
}));

import { GET, POST } from './route';

const NOW = new Date('2026-10-15T12:00:00Z');
const expense = (id: string, storeId: string | null, amount: number, voidedAt: Date | null = null): Row => ({
  id, companyId: 'c1', storeId, amount, voidedAt, category: 'OTHER', title: id, expenseDate: NOW, walletId: 'w1',
  voidReason: voidedAt ? 'سبب' : null,
});

const get = () => GET(new Request('http://localhost/api/finance'));
const post = (body: Record<string, unknown>) =>
  POST(new Request('http://localhost/api/finance', { method: 'POST', body: JSON.stringify(body) }));
const asStore = (storeId: string) =>
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId, country: { currencyCode: 'JOD' } });

beforeEach(() => {
  vi.clearAllMocks();
  rows.length = 0;
  rows.push(
    expense('e1', 's1', 100),
    expense('e2', 's2', 70),
    expense('e3', null, 40),
    expense('e4', 's1', 25, new Date('2026-10-14T00:00:00Z')),
    { ...expense('other-company', null, 9999), companyId: 'c2' },
  );
  asStore('s1');
  requirePermission.mockResolvedValue({});
});

describe('a store’s profit subtracts its own expenses', () => {
  it('store 1 subtracts e1 + e3 — not store 2’s, and not the cancelled one', async () => {
    const body = await (await get()).json();
    expect(body.summary.totalOperationalExpenses).toBe(140);
    expect(body.summary.netProfit).toBe(-140);
  });

  it('store 2 subtracts e2 + e3', async () => {
    asStore('s2');
    const body = await (await get()).json();
    expect(body.summary.totalOperationalExpenses).toBe(110);
  });

  it('NEGATIVE: neither store ever pays the other’s expense', async () => {
    const one = (await (await get()).json()).expenses.map((e: Row) => e.id);
    asStore('s2');
    const two = (await (await get()).json()).expenses.map((e: Row) => e.id);
    expect(one).not.toContain('e2');
    expect(two).not.toContain('e1');
    expect(two).not.toContain('e4');
  });

  it('NEGATIVE: another company’s expense never counts', async () => {
    const ids = (await (await get()).json()).expenses.map((e: Row) => e.id);
    expect(ids).not.toContain('other-company');
  });

  it('an expense with no store (from before the column) still counts against every store, as it always did', async () => {
    for (const s of ['s1', 's2', 's-new']) {
      asStore(s);
      const ids = (await (await get()).json()).expenses.map((e: Row) => e.id);
      expect(ids, s).toContain('e3');
    }
  });

  it('the list shows the cancelled expense, marked — the total does not count it', async () => {
    const body = await (await get()).json();
    const cancelled = body.expenses.find((e: Row) => e.id === 'e4');
    expect(cancelled.voidedAt).toBeTruthy();
    expect(body.summary.totalOperationalExpenses).toBe(140);
  });

  it('the spend-by-type card and the ledger trust count the same rows as the total', async () => {
    const body = await (await get()).json();
    // e1 + e3 are the month’s live rows for store 1; e4 (cancelled) and e2 (store 2) are not.
    expect(body.spend.rows).toBe(2);
    expect(body.spend.totalSpend).toBe(140);
    for (const call of db.expense.groupBy.mock.calls) {
      expect(call[0].where.voidedAt).toBeNull();
      expect(call[0].where.OR).toEqual([{ storeId: 's1' }, { storeId: null }]);
    }
  });
});

describe('a new expense carries the store it was recorded in', () => {
  beforeEach(() => {
    db.wallet.findFirst.mockResolvedValue({ id: 'w1', name: 'الصندوق', currencyCode: 'JOD' });
    db.expense.create.mockResolvedValue({ id: 'new' });
    db.walletMovement.create.mockResolvedValue({ id: 'm1' });
    db.expense.update.mockResolvedValue({ id: 'new', movementId: 'm1' });
  });

  it('writes the store of the session', async () => {
    await post({ title: 'إيجار', category: 'OFFICE', amount: 50, walletId: 'w1' });
    expect(db.expense.create.mock.calls[0][0].data.storeId).toBe('s1');
  });

  it('NEGATIVE: a store named in the body is never read', async () => {
    await post({ title: 'إيجار', category: 'OFFICE', amount: 50, walletId: 'w1', storeId: 's2' });
    expect(db.expense.create.mock.calls[0][0].data.storeId).toBe('s1');
  });
});
