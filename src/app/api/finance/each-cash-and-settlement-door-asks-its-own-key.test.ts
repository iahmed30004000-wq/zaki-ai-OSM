import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE CASH BOX AND THE STATEMENT APPROVAL: EACH DOOR ASKS ITS OWN KEY (perm-plan PR-9) — the doors, one by one, with their
 * negatives.
 *
 * The owner's rule for this change, in his words: «اي قرار بعد الان اتخذو دون الرجوع الي».
 *
 *   approving a courier statement             settlement.approve     (was settlement.review)   PATCH /api/finance/statements/[id]
 *   explaining a gap on it                    settlement.review      (unchanged)               PATCH /api/finance/statements/[id]
 *   an order's settlement status              settlement.approve     (was settlement.review)   PATCH /api/orders/[id]/finance
 *   seeing the wallets, the movements,        finance.cashbox_view   (was finance.cashbox)     GET   wallets · wallets/[id]/movements · transfers · closing
 *   the transfers and the closings
 *   creating / renaming / stopping / deleting finance.wallets_manage  (was finance.cashbox)     POST wallets · PATCH, DELETE wallets/[id]
 *   approving a daily closing                 finance.closing_approve (was finance.cashbox)     PATCH /api/finance/closing
 *   recording a movement, a transfer, a count finance.cashbox        (unchanged)               POST/PATCH movements · POST transfers · POST closing
 *
 * The migration gave every box to exactly the people who held the old key, so on the day nobody loses a door. THIS file is
 * the other half: after the day, a person who has the OLD key and not the new one is refused — and a person who has the new
 * one is not. Each door has a case in both directions; the people are keys, not roles.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, current, walletBalance } = vi.hoisted(() => ({
  db: {
    courierStatement: { findFirst: vi.fn(), updateMany: vi.fn() },
    wallet: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    dailyClosing: { findFirst: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
    walletTransfer: { findMany: vi.fn() },
    walletMovement: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
    country: { findFirst: vi.fn() },
    order: { findFirst: vi.fn(), findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  current: { keys: [] as string[] },
  walletBalance: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/wallets', async (orig) => ({
  ...(await orig<typeof import('@/lib/wallets')>()),
  walletBalance: (...a: unknown[]) => walletBalance(...a),
  blockingClosing: vi.fn(async () => null),
}));
// THE KEYED ENGINE: a person is a list of keys, and every question is answered from it.
vi.mock('@/lib/authorization', () => ({
  can: (_u: unknown, k: string) => current.keys.includes(k),
  getPermissionScope: (_u: unknown, k: string) => (current.keys.includes(k) ? { scope: 'ALL_COMPANY' } : null),
  requirePermission: async (k: string) => {
    if (!current.keys.includes(k)) throw new Error(`Forbidden: missing required permission ${k}`);
  },
}));
vi.mock('@/lib/rbac', () => ({
  assertOrderAccess: vi.fn(async () => ({ allowed: true, order: { id: 'o', version: 1, totalAmount: 100, settlementStatus: 'PENDING', refundAmount: 0, currency: 'USD', sellingPrice: 100, discount: 0, shippingRevenue: 0, estimatedCostOfGoods: 0, shippingCost: 0, productCost: 0, packagingCost: 0, advertisingCost: 0, otherCost: 0 } })),
  ORDER_ACCESS_STATUS: { NOT_FOUND: 404, WRONG_COMPANY: 404, NOT_ASSIGNED: 404 },
}));
vi.mock('@/lib/commission', () => ({ commissionCostForOrders: vi.fn(async () => 0), markPayableForOrders: vi.fn() }));

import { PATCH as approveStatement } from './statements/[id]/route';
import { GET as listWallets, POST as createWallet } from './wallets/route';
import { PATCH as editWallet, DELETE as deleteWallet } from './wallets/[id]/route';
import { GET as readMovements, POST as recordMovement, PATCH as reverseMovement } from './wallets/[id]/movements/route';
import { GET as listTransfers, POST as makeTransfer } from './transfers/route';
import { GET as readClosings, POST as recordClosing, PATCH as approveClosing } from './closing/route';
import { GET as readOrderFinance, PATCH as editOrderFinance } from '../orders/[id]/finance/route';

const ID = '11111111-2222-4333-8444-555555555555';
const params = { params: Promise.resolve({ id: ID }) };
const as = (...keys: string[]) => { current.keys = keys; };
const json = (body: unknown, method: string) =>
  new Request('http://x/api', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const get = () => new Request('http://x/api', { method: 'GET' });

/** The door answered 403 BEFORE it read or wrote anything. */
const refused = (res: Response) => expect(res.status).toBe(403);
/** The door let the person through (whatever it then said about the body or the row). */
const passed = (res: Response) => expect(res.status).not.toBe(403);

beforeEach(() => {
  vi.clearAllMocks();
  as();
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'سارة', role: 'CUSTOM', status: 'ACTIVE', companyId: 'c1' },
    companyId: 'c1', storeId: 's1',
    country: { minorUnit: 2, currencyCode: 'USD' },
  });
  db.courierStatement.findFirst.mockResolvedValue(null);
  db.wallet.findFirst.mockResolvedValue(null);
  db.wallet.findMany.mockResolvedValue([]);
  db.dailyClosing.findFirst.mockResolvedValue(null);
  db.walletTransfer.findMany.mockResolvedValue([]);
  db.walletMovement.findMany.mockResolvedValue([]);
  walletBalance.mockResolvedValue({ balance: 5, opening: 1, in: 4, out: 0, movements: 2 });
});

describe('THE STATEMENT APPROVAL — settlement.approve', () => {
  it('NEGATIVE: who only reviews the matches is refused the approval — and nothing is read', async () => {
    as('settlement.review', 'settlement.view', 'settlement.upload');
    refused(await approveStatement(json({ approve: true }, 'PATCH'), params));
    expect(db.courierStatement.findFirst).not.toHaveBeenCalled();
    expect(db.courierStatement.updateMany).not.toHaveBeenCalled();
  });

  it('who holds the approval is let through to the statement (404 here: the row is not there)', async () => {
    as('settlement.approve');
    const res = await approveStatement(json({ approve: true }, 'PATCH'), params);
    passed(res);
    expect(res.status).toBe(404);
    expect(db.courierStatement.findFirst).toHaveBeenCalled();
  });

  it('NEGATIVE: the cash-box key is not the approval either', async () => {
    as('finance.cashbox', 'finance.cashbox_view', 'finance.closing_approve');
    refused(await approveStatement(json({ approve: true }, 'PATCH'), params));
  });

  it('the explanation of a gap stays the reviewer’s: review passes, the approval alone does NOT', async () => {
    as('settlement.review');
    passed(await approveStatement(json({ gapExplanation: 'فرق بسبب أجرة التوصيل' }, 'PATCH'), params));
    as('settlement.approve');
    refused(await approveStatement(json({ gapExplanation: 'فرق بسبب أجرة التوصيل' }, 'PATCH'), params));
  });

  it('a press that does not say approve is the reviewer’s door as it always was — a body that is not JSON, or approve:false', async () => {
    as('settlement.review');
    passed(await approveStatement(new Request('http://x/api', { method: 'PATCH', body: 'not json' }), params));
    passed(await approveStatement(json({ approve: false, gapExplanation: 'فرق بسبب أجرة التوصيل' }, 'PATCH'), params));
    as('settlement.approve');
    refused(await approveStatement(new Request('http://x/api', { method: 'PATCH', body: 'not json' }), params));
  });

  it('NEGATIVE: «approve» as a word is not the act — only the boolean is (a string asks the reviewer’s door, and the schema refuses it)', async () => {
    as('settlement.approve');
    refused(await approveStatement(json({ approve: 'true' }, 'PATCH'), params));
    as('settlement.review');
    expect((await approveStatement(json({ approve: 'true' }, 'PATCH'), params)).status).toBe(400);
  });
});

describe('AN ORDER’S SETTLEMENT STATUS — settlement.approve (the order’s money door)', () => {
  const patch = (body: Record<string, unknown>) => editOrderFinance(json({ expectedVersion: 1, ...body }, 'PATCH'), params);

  it('NEGATIVE: who only reviews can no longer move an order’s settlement status', async () => {
    as('settlement.review', 'orders.view');
    refused(await patch({ settlementStatus: 'REFUNDED' }));
  });

  it('who holds the approval passes the settlement gate (it then judges the transition, not the person)', async () => {
    as('settlement.approve', 'orders.view');
    const res = await patch({ settlementStatus: 'SETTLED' });
    passed(res);
    // «SETTLED» is refused by its own rule (collect where the money lands) — that is a 409 about the act, not about who.
    expect(res.status).toBe(409);
  });

  it('finance.update still passes the settlement gate — nobody lost the door the old way', async () => {
    as('finance.update', 'orders.view');
    passed(await patch({ settlementStatus: 'SETTLED' }));
  });

  it('NEGATIVE: the costs door is NOT the approval’s — a finance.create holder without it cannot move a settlement status', async () => {
    as('finance.create', 'orders.view');
    refused(await patch({ settlementStatus: 'REFUNDED' }));
  });
});

describe('WHO SEES AN ORDER’S MONEY SNAPSHOT — finance.view sees the margin, settlement.view the settlement', () => {
  const SNAPSHOT = {
    id: ID, companyId: 'c1', currency: 'USD', sellingPrice: 100, quantity: 2, totalAmount: 110,
    estimatedCostOfGoods: 40, shippingCost: 5, subtotal: 100, discount: 0, shippingRevenue: 10, totalRevenue: 110,
    productCost: 40, packagingCost: 2, advertisingCost: 3, otherCost: 1, refundAmount: 0, grossProfit: 70, netProfit: 60,
    settlementStatus: 'PENDING', financeFinalizedAt: null,
    financialTransactions: [
      { id: 't1', type: 'SETTLEMENT', amount: 110, actor: { id: 'u9', name: 'ليلى' } },
      { id: 't2', type: 'EXPENSE', amount: 3, actor: { id: 'u9', name: 'ليلى' } },
      { id: 't3', type: 'COMMISSION', amount: 4, actor: { id: 'u9', name: 'ليلى' } },
      { id: 't4', type: 'REFUND', amount: 10, actor: { id: 'u9', name: 'ليلى' } },
      { id: 't5', type: 'ADJUSTMENT', amount: 1, actor: { id: 'u9', name: 'ليلى' } },
    ],
  };
  beforeEach(() => {
    db.order.findFirst.mockResolvedValue({ id: ID });
    db.order.findUnique.mockResolvedValue({ ...SNAPSHOT });
  });
  const read = async () => (await (await readOrderFinance(get(), params)).json()).finance as Record<string, unknown>;

  it('NEGATIVE: who has neither key is refused', async () => {
    as('orders.view', 'settlement.review');
    refused(await readOrderFinance(get(), params));
  });

  it('settlement.view alone: the door stays open, and the cost, the profit and the courier’s fee are NOT in what comes back', async () => {
    as('settlement.view');
    const f = await read();
    for (const field of ['estimatedCostOfGoods', 'productCost', 'packagingCost', 'advertisingCost', 'otherCost', 'grossProfit', 'netProfit', 'shippingCost']) {
      expect(f, field).not.toHaveProperty(field);
    }
    // what a settlement reader is for: the customer’s bill and the cash side
    for (const field of ['totalAmount', 'currency', 'subtotal', 'discount', 'shippingRevenue', 'totalRevenue', 'refundAmount', 'settlementStatus']) {
      expect(f, field).toHaveProperty(field);
    }
  });

  it('settlement.view alone: the ledger shows the settlement and the refund — never an expense, a commission or an adjustment', async () => {
    as('settlement.view');
    const types = ((await read()).financialTransactions as Array<{ type: string }>).map((t) => t.type).sort();
    expect(types).toEqual(['REFUND', 'SETTLEMENT']);
  });

  it('finance.view: the whole snapshot, as before — nobody with the finance key lost anything', async () => {
    // PR-10: the margin needs the cost key beside the finance key; the migration gave it to every holder of finance.view.
    as('finance.view', 'costs.view');
    const f = await read();
    expect(f.netProfit).toBe(60);
    expect(f.shippingCost).toBe(5);
    expect(f.productCost).toBe(40);
    expect((f.financialTransactions as unknown[]).length).toBe(5);
  });

  it('NEGATIVE (PR-10): the finance key WITHOUT the cost key — the owner took the cost away — gets the settlement’s view of it, no margin', async () => {
    as('finance.view');
    const f = await read();
    for (const field of ['estimatedCostOfGoods', 'productCost', 'packagingCost', 'advertisingCost', 'otherCost', 'grossProfit', 'netProfit', 'shippingCost']) {
      expect(f, field).not.toHaveProperty(field);
    }
  });

  it('both keys: the finance key wins — the whole snapshot', async () => {
    as('finance.view', 'costs.view', 'settlement.view');
    expect((await read()).grossProfit).toBe(70);
  });

  it('a missing order is still 404 for both', async () => {
    db.order.findFirst.mockResolvedValue(null);
    as('settlement.view');
    expect((await readOrderFinance(get(), params)).status).toBe(404);
  });
});

describe('SEEING THE CASH BOX — finance.cashbox_view', () => {
  const WALLET = { id: ID, name: 'الصندوق', currencyCode: 'USD', isActive: true, countryId: 'k1', storeId: 's1', store: { id: 's1', name: 'م' }, country: { id: 'k1', name: 'الأردن', code: 'JO', minorUnit: 2 }, openingCount: null };

  it('wallets GET: the view key sees the balances', async () => {
    as('finance.cashbox_view');
    db.wallet.findMany.mockResolvedValue([WALLET]);
    const body = await (await listWallets(get())).json();
    expect(body.wallets[0].balance).toBe(5);
  });

  it('NEGATIVE: wallets GET — the ACTION key alone no longer shows the balances (it has no list for the cash box)', async () => {
    as('finance.cashbox');
    refused(await listWallets(get()));
  });

  it('wallets GET — the receipt dialog’s names stay open to settlement.upload, without a balance (nobody lost it)', async () => {
    as('settlement.upload');
    db.wallet.findMany.mockResolvedValue([WALLET]);
    const res = await listWallets(get());
    passed(res);
    const body = await res.json();
    expect(body.wallets[0].name).toBe('الصندوق');
    expect(body.wallets[0]).not.toHaveProperty('balance');
  });

  it('movements GET: the view key reads the ledger; the action key alone does NOT', async () => {
    as('finance.cashbox_view');
    passed(await readMovements(get(), params));
    as('finance.cashbox');
    refused(await readMovements(get(), params));
  });

  it('transfers GET: the view key lists; the action key alone does NOT', async () => {
    as('finance.cashbox_view');
    passed(await listTransfers());
    as('finance.cashbox', 'finance.wallets_manage', 'finance.closing_approve');
    refused(await listTransfers());
  });

  it('closing GET: the view key reads the day; the action key alone does NOT', async () => {
    as('finance.cashbox_view');
    passed(await readClosings(get()));
    as('finance.cashbox');
    refused(await readClosings(get()));
  });

  it('NEGATIVE: settlement keys do not open the cash box', async () => {
    as('settlement.view', 'settlement.review', 'settlement.approve');
    refused(await readMovements(get(), params));
    refused(await listTransfers());
    refused(await readClosings(get()));
  });
});

describe('THE WALLETS — finance.wallets_manage', () => {
  it('NEGATIVE: who records the cash cannot create a wallet — and nothing is looked up', async () => {
    as('finance.cashbox', 'finance.cashbox_view', 'finance.closing_approve');
    refused(await createWallet(json({}, 'POST')));
    expect(db.country.findFirst).not.toHaveBeenCalled();
    expect(db.wallet.create).not.toHaveBeenCalled();
  });

  it('who manages the wallets passes (400 here: the body is empty)', async () => {
    as('finance.wallets_manage');
    expect((await createWallet(json({}, 'POST'))).status).toBe(400);
  });

  it('NEGATIVE: renaming and stopping a wallet — the cash key is refused, the wallets’ key passes', async () => {
    as('finance.cashbox');
    refused(await editWallet(json({ name: 'اسم جديد' }, 'PATCH'), params));
    expect(db.wallet.findFirst).not.toHaveBeenCalled();
    as('finance.wallets_manage');
    expect((await editWallet(json({ name: 'اسم جديد' }, 'PATCH'), params)).status).toBe(404);
    expect(db.wallet.findFirst).toHaveBeenCalled();
  });

  it('NEGATIVE: deleting a wallet — the cash key is refused, the wallets’ key passes', async () => {
    as('finance.cashbox', 'finance.cashbox_view');
    refused(await deleteWallet(get(), params));
    expect(db.wallet.findFirst).not.toHaveBeenCalled();
    as('finance.wallets_manage');
    expect((await deleteWallet(get(), params)).status).toBe(404);
  });
});

describe('THE CASH ACTIONS STAY ON finance.cashbox — recording a movement, a transfer, a closing’s count', () => {
  it('NEGATIVE: the view, the wallets’ and the closing’s approval keys do not record a movement, reverse one, transfer, or count', async () => {
    as('finance.cashbox_view', 'finance.wallets_manage', 'finance.closing_approve');
    refused(await recordMovement(json({}, 'POST'), params));
    refused(await reverseMovement(json({}, 'PATCH'), params));
    refused(await makeTransfer(json({}, 'POST')));
    refused(await recordClosing(json({}, 'POST')));
  });

  it('who holds the cash key passes all four (400 or 404 here: the bodies are empty)', async () => {
    as('finance.cashbox');
    passed(await recordMovement(json({}, 'POST'), params));
    passed(await reverseMovement(json({}, 'PATCH'), params));
    passed(await makeTransfer(json({}, 'POST')));
    passed(await recordClosing(json({}, 'POST')));
  });
});

describe('APPROVING A DAILY CLOSING — finance.closing_approve', () => {
  it('NEGATIVE: who counts the cash cannot approve the closing — and nothing is read', async () => {
    as('finance.cashbox', 'finance.cashbox_view', 'finance.wallets_manage');
    refused(await approveClosing(json({ closingId: ID }, 'PATCH')));
    expect(db.dailyClosing.findFirst).not.toHaveBeenCalled();
    expect(db.dailyClosing.update).not.toHaveBeenCalled();
  });

  it('who holds the approval is let through to the closing (404 here: the row is not there)', async () => {
    as('finance.closing_approve');
    const res = await approveClosing(json({ closingId: ID }, 'PATCH'));
    passed(res);
    expect(res.status).toBe(404);
    expect(db.dailyClosing.findFirst).toHaveBeenCalled();
  });

  it('NEGATIVE: the statement approval is not the closing’s', async () => {
    as('settlement.approve', 'settlement.review');
    refused(await approveClosing(json({ closingId: ID }, 'PATCH')));
  });
});
