import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE PARTNERS' SHARES ARE CUT FROM THE NUMBER THE PROFIT SCREEN PRINTS (13/11).
 *
 * «الربح لازم يتم توزيعه وفق هاي النسب — الربح الصافي انا بحكي». The statement route and `GET /api/finance` (the screen's
 * «صافي الربح») are run over the SAME in-memory data, and their net profit must be the same number — to the cent, on the worked
 * example, on a loss, on nothing, and on hundreds of random books. That it cannot be otherwise is the point of `profitToDate`;
 * that it IS otherwise on no input is what is checked here. And the statement route asks `finance.partners` FIRST.
 */

type Row = Record<string, any>;

const { db, tables, current, commission, requireContext } = vi.hoisted(() => {
  const tables = {
    partner: [] as Row[], walletMovement: [] as Row[], user: [] as Row[], order: [] as Row[], expense: [] as Row[],
  };
  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([key, want]) => {
      if (key === 'OR') return (want as Row[]).some((w) => matches(row, w));
      if (key === 'id' && want && typeof want === 'object' && 'in' in want) return (want.in as unknown[]).includes(row.id);
      if (want && typeof want === 'object' && !(want instanceof Date) && !Array.isArray(want) && key !== 'id') return matches((row[key] ?? {}) as Row, want as Row);
      return row[key] === want;
    });
  const finder = (name: keyof typeof tables) =>
    vi.fn(async ({ where = {} }: { where?: Row } = {}) => tables[name].filter((r) => matches(r, where)));
  const db = {
    partner: { findMany: finder('partner') },
    walletMovement: { findMany: finder('walletMovement') },
    user: { findMany: finder('user') },
    order: { findMany: finder('order') },
    expense: { findMany: finder('expense'), groupBy: vi.fn(async () => []) },
  };
  return { db, tables, current: { keys: [] as string[] }, commission: vi.fn(async () => 12.7), requireContext: vi.fn() };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/commission', () => ({ commissionCostForOrders: (...a: unknown[]) => commission(...(a as [])) }));
vi.mock('@/lib/analytics', () => ({
  getCompanyAnalytics: async () => ({ financials: { deliveredRevenue: 0 } }),
  getDateRange: () => ({ start: new Date('2026-11-01T00:00:00Z'), end: new Date('2026-11-30T23:59:59Z') }),
  previousRange: () => null,
}));
vi.mock('@/lib/authorization', () => ({
  can: (_u: unknown, k: string) => current.keys.includes(k),
  requirePermission: async (k: string) => {
    if (!current.keys.includes(k)) throw new Error(`Forbidden: missing required permission ${k}`);
  },
}));

import { GET as statement } from './route';
import { GET as profitScreen } from '../../route';

const order = (id: string, total: number, shipping: number, cost: number): Row => ({
  id, orderNumber: id, companyId: 'c1', storeId: 's1', status: 'DELIVERED', totalAmount: total, shippingCost: shipping, estimatedCostOfGoods: cost,
  deliveredAt: new Date('2026-11-05T10:00:00Z'),
});
const expense = (id: string, storeId: string | null, amount: number, voidedAt: Date | null = null): Row => ({
  id, companyId: 'c1', storeId, amount, voidedAt, category: 'OTHER', title: id, expenseDate: new Date('2026-11-10T10:00:00Z'), walletId: 'w1',
});

const both = async () => {
  const shown = await (await profitScreen(new Request('http://localhost/api/finance'))).json();
  const cut = await (await statement()).json();
  return { shown: shown.summary.netProfit as number, cut: cut.netProfit as number, statement: cut };
};

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const t of Object.values(tables)) t.length = 0;
  current.keys = ['finance.view', 'finance.partners'];
  commission.mockResolvedValue(12.7);
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1', country: { currencyCode: 'USD', minorUnit: 2 } });
  tables.partner.push(
    { id: 'pa', companyId: 'c1', name: 'شريك أ', sharePercent: 15, isActive: true, sortOrder: 0, createdAt: new Date(0) },
    { id: 'pb', companyId: 'c1', name: 'شريك ب', sharePercent: 15, isActive: true, sortOrder: 1, createdAt: new Date(1) },
    { id: 'pc', companyId: 'c1', name: 'شريك ج', sharePercent: 15, isActive: true, sortOrder: 2, createdAt: new Date(2) },
    { id: 'pd', companyId: 'c1', name: 'شريك د', sharePercent: 55, isActive: true, sortOrder: 3, createdAt: new Date(3) },
  );
});

describe('the number the shares are cut from IS the number the screen prints', () => {
  it('on the worked example: 277.91 on the screen and in the statement', async () => {
    tables.order.push(order('o1', 100.1, 5.05, 30.3), order('o2', 250.55, 8.1, 0), order('o3', 49.99, 4, 12.345));
    tables.expense.push(expense('e1', 's1', 40.25), expense('e2', null, 9.99), expense('e3', 's1', 100, new Date('2026-11-09')), expense('e4', 's2', 77));
    const r = await both();
    expect(r.shown).toBe(277.91);
    expect(r.cut).toBe(277.91);
    expect(r.statement.totals.entitlement).toBe(277.91);
  });

  it('on a loss: the same negative number, and no entitlement', async () => {
    tables.order.push(order('o1', 100, 5, 30));
    tables.expense.push(expense('e1', 's1', 1000));
    const r = await both();
    expect(r.shown).toBe(-947.7);
    expect(r.cut).toBe(r.shown);
    expect(r.statement.totals.entitlement).toBe(0);
  });

  it('on nothing at all', async () => {
    commission.mockResolvedValue(0);
    const r = await both();
    expect(r.shown).toBe(0);
    expect(r.cut).toBe(0);
  });

  it('PROPERTY: on three hundred random books the two are the same number, and the entitlements add up to it', async () => {
    const next = rng(13112026);
    for (let i = 0; i < 300; i++) {
      tables.order.length = 0;
      tables.expense.length = 0;
      const orders = Math.floor(next() * 9);
      for (let k = 0; k < orders; k++) {
        tables.order.push(order(`o${k}`, Math.round(next() * 90000) / 100, Math.round(next() * 900) / 100, next() < 0.4 ? 0 : Math.round(next() * 40000) / 100));
      }
      const spends = Math.floor(next() * 5);
      for (let k = 0; k < spends; k++) {
        tables.expense.push(expense(`e${k}`, next() < 0.3 ? null : 's1', Math.round(next() * 50000) / 100, next() < 0.2 ? new Date('2026-11-09') : null));
      }
      commission.mockResolvedValue(Math.round(next() * 5000) / 100);
      const { shown, cut, statement: st } = await both();
      expect(cut, `book ${i}`).toBe(shown);
      const floor = Math.max(0, shown);
      const entitled = (st.lines as Row[]).reduce((s, l) => s + Math.round((l.entitlement as number) * 100), 0);
      expect(entitled, `book ${i}`).toBe(Math.round(floor * 100));
    }
  });

  it('it is the very function: the route holds no arithmetic of its own, only the call', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const lib = strip(readFileSync(join(process.cwd(), 'src/lib/partner-statement.ts'), 'utf8'));
    expect(lib).toMatch(/profitToDate\(\{ companyId, storeId \}\)/);
    expect(lib).toMatch(/profit\.summary\.netProfit/);
    for (const f of ['src/lib/partner-statement.ts', 'src/app/api/finance/partners/statement/route.ts', 'src/app/api/finance/partners/route.ts', 'src/app/api/finance/partners/draws/route.ts']) {
      const src = strip(readFileSync(join(process.cwd(), f), 'utf8'));
      // no subtraction of the profit's terms, no commission read, no expense read — and a `netProfit` is only ever TAKEN from the one function
      expect(src, f).not.toMatch(/totalRevenue\s*-|totalCOGS|totalShipping|totalOperationalExpenses|commissionCostForOrders|expense\.(findMany|aggregate|groupBy)/);
      for (const m of src.matchAll(/\bnetProfit\s*=\s*([^;\n]+)/g)) expect(m[1].trim(), f).toBe('profit.summary.netProfit');
    }
  });
});

describe('the statement route asks its key FIRST', () => {
  it('every other finance key and not «الشركاء والسحوبات»: 403, and not a table is read', async () => {
    current.keys = ['finance.view', 'finance.create', 'finance.update', 'finance.cashbox_view', 'finance.cashbox', 'finance.wallets_manage', 'finance.closing_approve', 'costs.view'];
    const res = await statement();
    expect(res.status).toBe(403);
    expect((await res.json()).errorAr).toContain('الشركاء والسحوبات');
    for (const t of [db.partner.findMany, db.walletMovement.findMany, db.order.findMany, db.expense.findMany]) expect(t).not.toHaveBeenCalled();
  });

  it('with the key it answers for the CURRENT store, in the store’s currency', async () => {
    requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1', country: { currencyCode: 'JOD', minorUnit: 3 } });
    const body = await (await statement()).json();
    expect(body.currency).toBe('JOD');
    expect(body.minorUnit).toBe(3);
    expect(db.order.findMany.mock.calls[0][0]?.where).toMatchObject({ companyId: 'c1', storeId: 's1' });
    expect(db.walletMovement.findMany.mock.calls[0][0]?.where).toMatchObject({ wallet: { storeId: 's1' } });
  });
});
