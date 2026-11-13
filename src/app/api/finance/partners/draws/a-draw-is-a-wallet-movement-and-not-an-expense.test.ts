import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «سحب شريك» — THE DOOR THAT WRITES A PARTNER'S WITHDRAWAL (13/11), driven through the real POST.
 *
 * «السحوبات لازم تنضاف بند … اذا حد تجاوز نسبة سحبة نسبة الربح بينعد مكسور عليه» (the owner). The real `recordMovement` runs inside the
 * real transaction function over in-memory tables, so what is proved is what would be written. What it must do, and must not:
 *
 *   · two keys, asked BEFORE the body is read — `finance.partners`, then `finance.cashbox`;
 *   · a wallet movement OUT, category PARTNER_DRAW, naming its partner and what it is worth in the STORE's currency — and NOTHING ELSE:
 *     no `Expense` row, and the net profit is the same before and after;
 *   · the currency rule: a wallet in another currency than the store's needs «ما يعادله»; without it nothing is written;
 *   · a draw that passes the share is ALLOWED — this door never consults the statement;
 *   · the same press twice draws once.
 */

type Row = Record<string, any>;

const { db, tx, tables, calls, current, requireContext, logAudit, commission, statementCalled } = vi.hoisted(() => {
  const tables = {
    wallet: [] as Row[],
    partner: [] as Row[],
    walletMovement: [] as Row[],
    order: [] as Row[],
    expense: [] as Row[],
  };
  const calls: string[] = [];
  let seq = 0;
  const twin = (r: Row, w: Row) =>
    r.companyId === w.companyId && r.walletId === w.walletId && r.category === w.category && r.direction === w.direction &&
    r.partnerId === w.partnerId && Number(r.amount) === Number(w.amount) && r.createdById === w.createdById &&
    r.createdAt >= w.createdAt.gte && !r.reversed;
  const tx = {
    $queryRaw: vi.fn(async () => { calls.push('lock'); return []; }),
    wallet: { findFirst: vi.fn(async ({ where }: { where: Row }) => tables.wallet.find((w) => w.id === where.id && w.companyId === where.companyId && w.isActive) ?? null) },
    walletMovement: {
      findFirst: vi.fn(async ({ where }: { where: Row }) => { calls.push('twin'); return tables.walletMovement.find((r) => twin(r, where)) ?? null; }),
      create: vi.fn(async ({ data }: { data: Row }) => {
        calls.push('create');
        const row = { id: `m${++seq}`, createdAt: new Date(), ...data };
        tables.walletMovement.push(row);
        return row;
      }),
    },
    expense: { create: vi.fn(), update: vi.fn() },
  };
  // the mutex stands for the row lock: transactions on the same wallet run one after the other
  let chain: Promise<unknown> = Promise.resolve();
  const db = {
    wallet: {
      findFirst: vi.fn(async ({ where }: { where: Row }) => {
        const w = tables.wallet.find((x) => x.id === where.id && x.companyId === where.companyId && x.storeId === where.storeId);
        return w ? { ...w, country: { minorUnit: w.minor } } : null;
      }),
    },
    partner: { findFirst: vi.fn(async ({ where }: { where: Row }) => tables.partner.find((p) => p.id === where.id && p.companyId === where.companyId) ?? null) },
    order: { findMany: vi.fn(async () => tables.order) },
    expense: { findMany: vi.fn(async () => tables.expense), create: vi.fn() },
    $transaction: vi.fn((fn: (t: unknown) => Promise<unknown>) => {
      const run = chain.then(() => fn(tx));
      chain = run.catch(() => undefined);
      return run;
    }),
  };
  return { db, tx, tables, calls, current: { keys: [] as string[] }, requireContext: vi.fn(), logAudit: vi.fn(), commission: vi.fn(async () => 12.7), statementCalled: vi.fn() };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/commission', () => ({ commissionCostForOrders: (...a: unknown[]) => commission(...(a as [])) }));
vi.mock('@/lib/partner-statement', () => ({ partnerStatement: (...a: unknown[]) => statementCalled(...a) }));
vi.mock('@/lib/wallets', async (orig) => ({
  ...(await orig<typeof import('@/lib/wallets')>()),
  walletBalance: vi.fn(async () => ({ balance: 0 })),
}));
vi.mock('@/lib/authorization', () => ({
  can: (_u: unknown, k: string) => current.keys.includes(k),
  requirePermission: async (k: string) => {
    if (!current.keys.includes(k)) throw new Error(`Forbidden: missing required permission ${k}`);
  },
}));

import { POST } from './route';
import { profitToDate } from '@/lib/profit-to-date';

const W_USD = '11111111-1111-4111-8111-111111111111';
const W_JOD = '22222222-2222-4222-8222-222222222222';
const P_D = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const P_OFF = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const post = (body: unknown) => POST(new Request('http://localhost/api/finance/partners/draws', { method: 'POST', body: JSON.stringify(body) }));
const draw = (over: Record<string, unknown> = {}) => ({ walletId: W_USD, partnerId: P_D, amount: 100, ...over });
const written = () => tables.walletMovement;

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  for (const t of Object.values(tables)) t.length = 0;
  current.keys = ['finance.view', 'finance.partners', 'finance.cashbox'];
  requireContext.mockResolvedValue({ user: { id: 'u1', name: 'أحمد' }, companyId: 'c1', storeId: 's1', country: { currencyCode: 'USD', minorUnit: 2 } });
  commission.mockResolvedValue(12.7);
  tables.wallet.push(
    { id: W_USD, companyId: 'c1', storeId: 's1', name: 'الصندوق', currencyCode: 'USD', minor: 2, isActive: true },
    { id: W_JOD, companyId: 'c1', storeId: 's1', name: 'صندوق الدينار', currencyCode: 'JOD', minor: 3, isActive: true },
    { id: '33333333-3333-4333-8333-333333333333', companyId: 'c1', storeId: 's2', name: 'صندوق متجر آخر', currencyCode: 'USD', minor: 2, isActive: true },
  );
  tables.partner.push(
    { id: P_D, companyId: 'c1', name: 'شريك د', sharePercent: 55, isActive: true },
    { id: P_OFF, companyId: 'c1', name: 'شريك سابق', sharePercent: 10, isActive: false },
  );
  tables.order.push({ id: 'o1', orderNumber: 'o1', totalAmount: 400, shippingCost: 10, estimatedCostOfGoods: 50, deliveredAt: new Date() });
  tables.expense.push({ id: 'e1', amount: 40, voidedAt: null, storeId: 's1', companyId: 'c1' });
});

describe('the two keys are asked before the body is read', () => {
  it('every other finance key, and not «الشركاء والسحوبات»: 403, the body unread, nothing written', async () => {
    current.keys = ['finance.view', 'finance.create', 'finance.update', 'finance.cashbox_view', 'finance.cashbox', 'finance.wallets_manage', 'finance.closing_approve', 'settlement.approve'];
    const unread = { json: vi.fn() };
    const res = await POST(unread as unknown as Request);
    expect(res.status).toBe(403);
    expect(unread.json).not.toHaveBeenCalled();
    expect(written()).toHaveLength(0);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('the partners’ key and not the cash box’s: cash does not leave a wallet — 403, the body unread', async () => {
    current.keys = ['finance.view', 'finance.partners', 'finance.cashbox_view'];
    const unread = { json: vi.fn() };
    const res = await POST(unread as unknown as Request);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('finance.cashbox');
    expect(unread.json).not.toHaveBeenCalled();
    expect(written()).toHaveLength(0);
  });

  it('both keys: the draw is written', async () => {
    expect((await post(draw())).status).toBe(201);
    expect(written()).toHaveLength(1);
  });
});

describe('a draw from a wallet in the store’s own currency', () => {
  it('is one OUT movement of category PARTNER_DRAW, naming its partner and worth its amount, through `recordMovement`', async () => {
    const res = await post(draw({ amount: 100, note: 'مصروف شخصي' }));
    expect(res.status).toBe(201);
    expect(written()).toHaveLength(1);
    expect(written()[0]).toMatchObject({
      companyId: 'c1', walletId: W_USD, direction: 'OUT', amount: 100, currencyCode: 'USD', party: 'شريك د', category: 'PARTNER_DRAW',
      note: 'مصروف شخصي', referenceType: 'PARTNER_DRAW', referenceId: P_D, partnerId: P_D, valueInStoreCurrency: 100, createdById: 'u1',
    });
  });

  it('with no note, the movement still says what it is — `note` is NOT NULL in the ledger', async () => {
    await post(draw());
    expect(written()[0].note).toBe('سحب شريك د');
  });

  it('is written to the audit trail with the partner, the wallet and both figures', async () => {
    await post(draw());
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit.mock.calls[0][0]).toMatchObject({
      action: 'PARTNER_DRAW_RECORDED', companyId: 'c1', userId: 'u1', entity: 'WalletMovement',
      newData: { wallet: 'الصندوق', partner: 'شريك د', amount: 100, currencyCode: 'USD', valueInStoreCurrency: 100, storeCurrency: 'USD' },
    });
  });

  it('a value typed beside it must equal it — a different number is refused, an equal one is accepted', async () => {
    const bad = await post(draw({ valueInStoreCurrency: 90 }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe('VALUE_NOT_ALLOWED');
    expect(written()).toHaveLength(0);
    expect((await post(draw({ valueInStoreCurrency: 100 }))).status).toBe(201);
  });

  it('the amount may not have more decimals than the wallet’s currency: 12.345 dollars is refused, not rounded', async () => {
    const res = await post(draw({ amount: 12.345 }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('AMOUNT_DECIMALS');
    expect(written()).toHaveLength(0);
    expect((await post(draw({ amount: 12.34 }))).status).toBe(201);
  });
});

describe('THE CURRENCY: a wallet in another currency than the store’s', () => {
  it('without «ما يعادله بعملة المتجر» NOTHING is written — a silent 1:1 between dinars and dollars is not acceptable', async () => {
    const res = await post(draw({ walletId: W_JOD, amount: 70 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('STORE_VALUE_REQUIRED');
    expect(body.error).toContain('ما يعادله');
    expect(body.error).toContain('USD');
    expect(body.error).toContain('JOD');
    expect(written()).toHaveLength(0);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('with it, the movement keeps the wallet’s amount and carries the store’s worth: 70 JOD = 98.70 USD', async () => {
    const res = await post(draw({ walletId: W_JOD, amount: 70, valueInStoreCurrency: 98.7 }));
    expect(res.status).toBe(201);
    expect(written()[0]).toMatchObject({ walletId: W_JOD, amount: 70, currencyCode: 'JOD', valueInStoreCurrency: 98.7, partnerId: P_D });
    expect(logAudit.mock.calls[0][0].newData).toMatchObject({ amount: 70, currencyCode: 'JOD', valueInStoreCurrency: 98.7, storeCurrency: 'USD' });
  });

  it('the typed equivalent may not have more decimals than the STORE’s currency: 98.705 dollars is refused', async () => {
    const res = await post(draw({ walletId: W_JOD, amount: 70, valueInStoreCurrency: 98.705 }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALUE_DECIMALS');
    expect(written()).toHaveLength(0);
  });

  it('a three-decimal wallet keeps its fils: 12.345 JOD is accepted, 12.3456 is not', async () => {
    expect((await post(draw({ walletId: W_JOD, amount: 12.345, valueInStoreCurrency: 17.4 }))).status).toBe(201);
    expect((await post(draw({ walletId: W_JOD, amount: 12.3456, valueInStoreCurrency: 17.4 }))).status).toBe(400);
  });

  it('an equivalent of zero or less, or absurdly large, is refused by the strict reader', async () => {
    for (const bad of [0, -5, '2,5', '0x10', 1_000_000_001]) {
      expect((await post(draw({ walletId: W_JOD, amount: 70, valueInStoreCurrency: bad }))).status, String(bad)).toBe(400);
    }
    expect(written()).toHaveLength(0);
  });
});

describe('what the door refuses', () => {
  it('a partner who is switched off, an unknown partner, another company’s partner', async () => {
    const off = await post(draw({ partnerId: P_OFF }));
    expect(off.status).toBe(409);
    expect((await off.json()).code).toBe('PARTNER_STOPPED');
    const unknown = await post(draw({ partnerId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }));
    expect(unknown.status).toBe(404);
    tables.partner.push({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', companyId: 'c2', name: 'غريب', sharePercent: 100, isActive: true });
    expect((await post(draw({ partnerId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }))).status).toBe(404);
    expect(written()).toHaveLength(0);
  });

  it('a wallet of ANOTHER store (the movements door’s own rule), an unknown wallet, a wallet that is stopped', async () => {
    const other = await post(draw({ walletId: '33333333-3333-4333-8333-333333333333' }));
    expect(other.status).toBe(404);
    expect(db.wallet.findFirst.mock.calls[0][0].where).toMatchObject({ companyId: 'c1', storeId: 's1' });
    expect((await post(draw({ walletId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }))).status).toBe(404);
    tables.wallet[0].isActive = false;
    const stopped = await post(draw());
    expect(stopped.status).toBe(409);
    expect((await stopped.json()).code).toBe('WALLET_STOPPED');
    expect(written()).toHaveLength(0);
  });

  it('a body that is not a draw: no amount, zero, negative, text, huge, no partner, a bad id', async () => {
    const bad: unknown[] = [
      null, {}, draw({ amount: undefined }), draw({ amount: 0 }), draw({ amount: -1 }), draw({ amount: '2,5' }), draw({ amount: '0x10' }),
      draw({ amount: 1_000_000_001 }), draw({ partnerId: undefined }), draw({ partnerId: 'x' }), draw({ walletId: '' }), draw({ note: 'x'.repeat(301) }),
    ];
    for (const b of bad) expect((await post(b)).status, JSON.stringify(b)).toBe(400);
    expect(written()).toHaveLength(0);
  });
});

describe('«مكسور عليه» is counted, never refused', () => {
  it('a draw far beyond any share is written — the door never asks the statement, and never could block', async () => {
    const res = await post(draw({ amount: 900_000 }));
    expect(res.status).toBe(201);
    expect(written()).toHaveLength(1);
    expect(statementCalled).not.toHaveBeenCalled();
  });

  it('and nothing about the door’s source reads the statement or the profit', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), 'src/app/api/finance/partners/draws/route.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(src).not.toMatch(/partner-statement|partnerStatement|profit-to-date|profitToDate|partnerLines/);
  });
});

describe('A DRAW IS NOT AN EXPENSE: no expense row, and the net profit is the same before and after', () => {
  it('writes no Expense row — not through the transaction and not through the pool', async () => {
    await post(draw({ amount: 250 }));
    expect(tx.expense.create).not.toHaveBeenCalled();
    expect(tx.expense.update).not.toHaveBeenCalled();
    expect(db.expense.create).not.toHaveBeenCalled();
    expect(tables.expense).toHaveLength(1);
  });

  it('the profit screen’s figures — every one — are identical before and after, to the cent', async () => {
    const before = (await profitToDate({ companyId: 'c1', storeId: 's1' })).summary;
    expect((await post(draw({ amount: 250 }))).status).toBe(201);
    expect((await post(draw({ walletId: W_JOD, amount: 70, valueInStoreCurrency: 98.7 }))).status).toBe(201);
    const after = (await profitToDate({ companyId: 'c1', storeId: 's1' })).summary;
    expect(after).toEqual(before);
    expect(after.totalOperationalExpenses).toBe(40);
    expect(written()).toHaveLength(2);
  });
});

describe('THE SAME PRESS TWICE draws once', () => {
  it('inside the transaction the wallet is locked FIRST, then the twin is looked for, then the movement is written', async () => {
    await post(draw());
    expect(calls).toEqual(['lock', 'twin', 'create']);
    expect(tx.$queryRaw.mock.calls[0].join(' ')).toContain('FOR UPDATE');
  });

  it('a second identical request is refused as DUPLICATE_DRAW and writes nothing', async () => {
    expect((await post(draw())).status).toBe(201);
    const again = await post(draw());
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe('DUPLICATE_DRAW');
    expect(written()).toHaveLength(1);
    expect(logAudit).toHaveBeenCalledTimes(1);
  });

  it('two requests at the same instant: one wins and one is refused, never both', async () => {
    const [a, b] = await Promise.all([post(draw()), post(draw())]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(written()).toHaveLength(1);
  });

  it('a different amount, a different partner or a different person is NOT a twin', async () => {
    tables.partner.push({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', companyId: 'c1', name: 'شريك أ', sharePercent: 15, isActive: true });
    expect((await post(draw())).status).toBe(201);
    expect((await post(draw({ amount: 101 }))).status).toBe(201);
    expect((await post(draw({ partnerId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }))).status).toBe(201);
    requireContext.mockResolvedValue({ user: { id: 'u2', name: 'سارة' }, companyId: 'c1', storeId: 's1', country: { currencyCode: 'USD', minorUnit: 2 } });
    expect((await post(draw())).status).toBe(201);
    expect(written()).toHaveLength(4);
  });

  it('after half a minute the same figure is a new draw, and one that was reversed is not a twin', async () => {
    expect((await post(draw())).status).toBe(201);
    written()[0].createdAt = new Date(Date.now() - 31_000);
    expect((await post(draw())).status).toBe(201);
    written()[1].reversed = true;
    expect((await post(draw())).status).toBe(201);
    expect(written()).toHaveLength(3);
  });

  it('the twin is looked for inside the 30-second window, for the same wallet, partner, amount and person', async () => {
    await post(draw());
    const where = tx.walletMovement.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ companyId: 'c1', walletId: W_USD, category: 'PARTNER_DRAW', direction: 'OUT', partnerId: P_D, amount: 100, createdById: 'u1', reversedBy: null });
    const windowMs = Date.now() - where.createdAt.gte.getTime();
    expect(windowMs).toBeGreaterThanOrEqual(0);
    expect(windowMs).toBeLessThan(31_000);
  });
});
