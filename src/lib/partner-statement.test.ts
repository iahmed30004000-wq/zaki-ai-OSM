import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE PARTNERS' STATEMENT, OVER AN IN-MEMORY LEDGER (13/11).
 *
 * The real function runs over tables that evaluate the `where` they are handed (a missing condition shows up as a wrong total):
 * the partners, this store's and another store's wallets' movements, the delivered orders and the expenses of the profit. The net
 * profit is the profit screen's own worked example (277.91 — see `api/finance/the-profit-summary-is-pinned.test.ts`), so the numbers
 * below can be checked against the screen by hand.
 *
 *   net 277.91 → the four's shares, by largest remainder:  محمد كوري 41.69 · عبدالله كيوان 41.69 · محمد كيوان 41.68 · احمد كيوان 152.85
 */

type Row = Record<string, any>;

const { db, tables, commission } = vi.hoisted(() => {
  const tables = {
    partner: [] as Row[],
    walletMovement: [] as Row[],
    user: [] as Row[],
    order: [] as Row[],
    expense: [] as Row[],
  };
  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([key, want]) => {
      if (key === 'OR') return (want as Row[]).some((w) => matches(row, w));
      if (key === 'id' && want && typeof want === 'object' && 'in' in want) return (want.in as unknown[]).includes(row.id);
      if (want && typeof want === 'object' && !(want instanceof Date) && !Array.isArray(want) && key !== 'id') {
        return matches((row[key] ?? {}) as Row, want as Row);
      }
      return row[key] === want;
    });
  // Evaluates the `where`, and honours the one `orderBy` the statement asks for (newest first), as the database does.
  const finder = (name: keyof typeof tables) =>
    vi.fn(async ({ where = {}, orderBy }: { where?: Row; orderBy?: Row } = {}) => {
      const hit = tables[name].filter((r) => matches(r, where));
      const by = orderBy && !Array.isArray(orderBy) ? Object.entries(orderBy)[0] : undefined;
      if (by && by[1] === 'desc') hit.sort((a, b) => (b[by[0]] as Date).getTime() - (a[by[0]] as Date).getTime());
      return hit;
    });
  const db = {
    partner: { findMany: finder('partner') },
    walletMovement: { findMany: finder('walletMovement') },
    user: { findMany: finder('user') },
    order: { findMany: finder('order') },
    expense: { findMany: finder('expense') },
  };
  return { db, tables, commission: vi.fn(async () => 12.7) };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/commission', () => ({ commissionCostForOrders: (...a: unknown[]) => commission(...(a as [])) }));

import { partnerStatement } from './partner-statement';

const SCOPE = { companyId: 'c1', storeId: 's1', currency: 'USD', minorUnit: 2 };

const partner = (id: string, name: string, sharePercent: number, sortOrder: number, isActive = true): Row => ({
  id, companyId: 'c1', name, sharePercent, isActive, sortOrder, createdAt: new Date(2026, 10, 13, 0, sortOrder),
});
const order = (id: string, total: number, shipping: number, cost: number): Row => ({
  id, orderNumber: id, companyId: 'c1', storeId: 's1', status: 'DELIVERED', totalAmount: total, shippingCost: shipping, estimatedCostOfGoods: cost,
  deliveredAt: new Date('2026-11-05T10:00:00Z'),
});
const expense = (id: string, storeId: string | null, amount: number, voidedAt: Date | null = null): Row => ({
  id, companyId: 'c1', storeId, amount, voidedAt, category: 'OTHER', title: id, expenseDate: new Date('2026-11-10T10:00:00Z'), walletId: 'w1',
});
let clock = 0;
const draw = (id: string, partnerId: string | null, value: number | null, over: Row = {}): Row => ({
  id, companyId: 'c1', walletId: 'w1', category: 'PARTNER_DRAW', direction: 'OUT', amount: value ?? 0, currencyCode: 'USD',
  valueInStoreCurrency: value, partnerId, party: 'سحب', note: 'سحب', reversalOfId: null, createdById: 'u1',
  createdAt: new Date(Date.UTC(2026, 10, 12, 10, clock++)), wallet: { name: 'الصندوق', storeId: 's1' }, ...over,
});
const reversal = (id: string, of: Row): Row => ({
  ...of, id, direction: 'IN', reversalOfId: of.id, createdAt: new Date(Date.UTC(2026, 10, 12, 11, clock++)),
});

beforeEach(() => {
  vi.clearAllMocks();
  commission.mockResolvedValue(12.7);
  clock = 0;
  for (const t of Object.values(tables)) t.length = 0;
  tables.partner.push(
    partner('mk', 'محمد كوري', 15, 0), partner('ak', 'عبدالله كيوان', 15, 1), partner('mq', 'محمد كيوان', 15, 2), partner('ah', 'احمد كيوان', 55, 3),
  );
  tables.order.push(order('o1', 100.1, 5.05, 30.3), order('o2', 250.55, 8.1, 0), order('o3', 49.99, 4, 12.345));
  tables.expense.push(expense('e1', 's1', 40.25), expense('e2', null, 9.99), expense('e3', 's1', 100, new Date('2026-11-09T00:00:00Z')), expense('e4', 's2', 77));
  tables.user.push({ id: 'u1', name: 'أحمد' }, { id: 'u2', name: 'سارة' });
});

const lineOf = (s: Awaited<ReturnType<typeof partnerStatement>>, id: string) => s.lines.find((l) => l.id === id)!;

describe('the statement over the profit screen’s worked example', () => {
  it('cuts 277.91 — the number the profit screen prints — into the four shares, adding up to it exactly', async () => {
    const s = await partnerStatement(SCOPE);
    expect(s.netProfit).toBe(277.91);
    expect(s.state).toBe('OK');
    expect(s.lines.map((l) => [l.name, l.entitlement])).toEqual([
      ['محمد كوري', 41.69], ['عبدالله كيوان', 41.69], ['محمد كيوان', 41.68], ['احمد كيوان', 152.85],
    ]);
    expect(s.totals.entitlement).toBe(277.91);
    expect(s.currency).toBe('USD');
    expect(s.minorUnit).toBe(2);
  });

  it('with no draw anyone has the whole of his share and nobody is «مكسور عليه»', async () => {
    const s = await partnerStatement(SCOPE);
    expect(s.lines.every((l) => l.draws === 0 && l.balance === l.entitlement && l.broken === 0)).toBe(true);
    expect(s.draws).toEqual([]);
    expect(s.uncounted).toBe(0);
  });

  it('says how far the cost of goods behind the profit can be trusted — the same sentence the dashboard uses', async () => {
    const s = await partnerStatement(SCOPE);
    // two of the three delivered orders carry a cost, and three orders are below the floor of five: the figure is withheld
    expect(s.trust.level).toBe('WITHHELD');
    expect(s.trust.present).toBe(2);
    expect(s.trust.population).toBe(3);
    // the sentence is the dashboard's own (`trustOf`): under five orders it says how few there are
    expect(s.trust.ar).toMatch(/[؀-ۿ]/);
    expect(s.trust.ar).toContain('3');
  });

  it('a well-recorded cost is stated: 9 of 10 delivered orders with a cost (o2 is the one with none typed)', async () => {
    for (let i = 4; i <= 10; i++) tables.order.push(order(`o${i}`, 10, 1, 2));
    const s = await partnerStatement(SCOPE);
    expect(s.trust.population).toBe(10);
    expect(s.trust.present).toBe(9);
    expect(s.trust.level).toBe('STATED');
    expect(s.trust.ar).toContain('كلفة البضاعة');
  });
});

describe('the draws: the ledger, cumulative, in the store’s currency', () => {
  it('a draw counts against its partner’s share, and the balance and «مكسور عليه» follow', async () => {
    tables.walletMovement.push(draw('d1', 'mk', 30), draw('d2', 'mk', 20), draw('d3', 'ah', 100));
    const s = await partnerStatement(SCOPE);
    expect(lineOf(s, 'mk')).toMatchObject({ entitlement: 41.69, draws: 50, balance: -8.31, broken: 8.31 });
    expect(lineOf(s, 'ah')).toMatchObject({ entitlement: 152.85, draws: 100, balance: 52.85, broken: 0 });
    expect(s.totals.draws).toBe(150);
    expect(s.totals.broken).toBe(8.31);
  });

  it('EQUAL IS NOT BROKEN: a draw of exactly the share leaves a balance of zero', async () => {
    tables.walletMovement.push(draw('d1', 'ah', 152.85));
    const s = await partnerStatement(SCOPE);
    expect(lineOf(s, 'ah')).toMatchObject({ draws: 152.85, balance: 0, broken: 0 });
  });

  it('ONE CENT over is broken by one cent', async () => {
    tables.walletMovement.push(draw('d1', 'ah', 152.86));
    expect(lineOf(await partnerStatement(SCOPE), 'ah')).toMatchObject({ balance: -0.01, broken: 0.01 });
  });

  it('A DRAW REVERSED counts as nothing — the original and its reversing entry cancel, and the list marks it', async () => {
    const d1 = draw('d1', 'mk', 30);
    tables.walletMovement.push(d1, reversal('r1', d1), draw('d2', 'mk', 10));
    const s = await partnerStatement(SCOPE);
    expect(lineOf(s, 'mk').draws).toBe(10);
    expect(s.draws.map((d) => [d.id, d.reversed])).toEqual([['d2', false], ['d1', true]]);
    // the reversing entry itself is not a draw of its own: two rows listed, not three
    expect(s.draws).toHaveLength(2);
  });

  it('a draw by the same partner reversed and drawn again is one draw', async () => {
    const d1 = draw('d1', 'ah', 100);
    tables.walletMovement.push(d1, reversal('r1', d1), draw('d2', 'ah', 100));
    expect(lineOf(await partnerStatement(SCOPE), 'ah').draws).toBe(100);
  });

  it('only THIS store’s wallets: a draw from another store’s wallet is not here', async () => {
    tables.walletMovement.push(draw('d1', 'mk', 30), draw('d-other', 'mk', 500, { wallet: { name: 'صندوق متجر آخر', storeId: 's2' }, walletId: 'w2' }));
    const s = await partnerStatement(SCOPE);
    expect(lineOf(s, 'mk').draws).toBe(30);
    expect(s.draws.map((d) => d.id)).toEqual(['d1']);
    expect(db.walletMovement.findMany.mock.calls[0][0]?.where).toMatchObject({ companyId: 'c1', category: 'PARTNER_DRAW', wallet: { storeId: 's1' } });
  });

  it('only a PARTNER_DRAW: a movement of any other kind is not a draw', async () => {
    tables.walletMovement.push(draw('d1', 'mk', 30), draw('x1', 'mk', 999, { category: 'EXPENSE' }));
    expect(lineOf(await partnerStatement(SCOPE), 'mk').draws).toBe(30);
  });

  it('is in the STORE’s currency: the equivalent counts, not the wallet’s amount', async () => {
    // 70 dinars from a dinar wallet, typed as worth 98.7 dollars — the ledger adds the dollars
    tables.walletMovement.push(draw('d1', 'ah', 98.7, { amount: 70, currencyCode: 'JOD' }));
    const s = await partnerStatement(SCOPE);
    expect(lineOf(s, 'ah').draws).toBe(98.7);
    expect(s.draws[0]).toMatchObject({ amount: 70, currencyCode: 'JOD', valueInStoreCurrency: 98.7 });
  });

  it('a draw with no store value, or no partner, cannot be added to a ledger: it is counted aside and said', async () => {
    tables.walletMovement.push(draw('d1', 'mk', 30), draw('d2', 'mk', null), draw('d3', null, 40));
    const s = await partnerStatement(SCOPE);
    expect(s.uncounted).toBe(2);
    expect(lineOf(s, 'mk').draws).toBe(30);
    expect(s.totals.draws).toBe(30);
  });

  it('the list carries who recorded it, the wallet’s name and the partner’s CURRENT name', async () => {
    tables.partner[0].name = 'محمد كوري (الشريك)';
    tables.walletMovement.push(draw('d1', 'mk', 30, { createdById: 'u2', party: 'محمد كوري' }));
    const [row] = (await partnerStatement(SCOPE)).draws;
    expect(row).toMatchObject({ walletName: 'الصندوق', createdByName: 'سارة', partnerName: 'محمد كوري (الشريك)', note: 'سحب' });
  });

  it('a partner switched off who still has draws is listed, out of the split, with what he took', async () => {
    tables.partner[2].isActive = false;
    tables.partner[3].sharePercent = 70;
    tables.walletMovement.push(draw('d1', 'mq', 25));
    const s = await partnerStatement(SCOPE);
    expect(s.state).toBe('OK');
    expect(lineOf(s, 'mq')).toMatchObject({ isActive: false, entitlement: 0, draws: 25, broken: 25 });
    expect(lineOf(s, 'ah').entitlement).toBe(194.54);
  });
});

describe('the shares not being cut', () => {
  it('shares that do not total 100 split nothing, and the draws are still shown', async () => {
    tables.partner[3].sharePercent = 50;
    tables.walletMovement.push(draw('d1', 'mk', 30));
    const s = await partnerStatement(SCOPE);
    expect(s.state).toBe('SHARES_NOT_100');
    expect(s.lines.every((l) => l.entitlement === null && l.broken === null)).toBe(true);
    expect(lineOf(s, 'mk').draws).toBe(30);
  });

  it('no partner saved yet: the state says so', async () => {
    tables.partner.length = 0;
    const s = await partnerStatement(SCOPE);
    expect(s.state).toBe('NO_PARTNERS');
    expect(s.lines).toEqual([]);
    expect(s.netProfit).toBe(277.91);
  });
});

describe('a loss, and a store that has sold nothing', () => {
  it('a LOSS gives everyone an entitlement of zero — the profit is reported as it is, the floor is the split’s', async () => {
    tables.expense.push(expense('e-big', 's1', 1000));
    tables.walletMovement.push(draw('d1', 'ah', 10));
    const s = await partnerStatement(SCOPE);
    expect(s.netProfit).toBe(-722.1);
    expect(s.lines.map((l) => l.entitlement)).toEqual([0, 0, 0, 0]);
    expect(lineOf(s, 'ah')).toMatchObject({ draws: 10, balance: -10, broken: 10 });
    expect(s.totals.entitlement).toBe(0);
  });

  it('PROFIT ZERO: nothing delivered and nothing spent — every share is zero and nothing is NaN', async () => {
    tables.order.length = 0;
    tables.expense.length = 0;
    commission.mockResolvedValue(0);
    const s = await partnerStatement(SCOPE);
    expect(s.netProfit).toBe(0);
    expect(s.lines.map((l) => l.entitlement)).toEqual([0, 0, 0, 0]);
    expect(s.trust.level).toBe('WITHHELD');
  });
});
