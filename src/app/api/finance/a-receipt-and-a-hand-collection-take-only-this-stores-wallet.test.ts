import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A RECEIPT AND A HAND COLLECTION PUT THE MONEY IN THIS STORE’S DRAWER — OR AN UNPLACED ONE — NEVER ANOTHER STORE’S
 * (perm-plan PR-9, the leftover of PR-2d).
 *
 * The two doors that take a wallet id from the body — `POST /api/finance/statements/:id/receipts` and
 * `POST /api/ops/tracking/collect` — look the wallet up with the ONE rule the rest of the stores’ code uses
 * (`inStoreOrShared`, lib/store-filter): the caller’s store, plus the wallets that belong to no store yet. A wallet of
 * another store of the same company is a 404 and nothing is written; and with NO store selected the answer is «only the
 * unplaced ones», never «any wallet of the company».
 *
 * The owner’s rule for this change, in his words: «اي قرار بعد الان اتخذو دون الرجوع الي».
 *
 * Both doors were already narrowed to the store by hand (`OR: [{ storeId }, { storeId: null }]`); this file pins the rule
 * for them at the door, with the negative case, so a later edit that drops it is caught.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, current } = vi.hoisted(() => ({
  db: {
    courierStatement: { findFirst: vi.fn(), updateMany: vi.fn() },
    statementReceipt: { findFirst: vi.fn(), create: vi.fn() },
    wallet: { findFirst: vi.fn() },
    order: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  current: { keys: ['settlement.upload', 'finance.cashbox'] as string[] },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/authorization', () => ({
  can: (_u: unknown, k: string) => current.keys.includes(k),
  requirePermission: async (k: string) => {
    if (!current.keys.includes(k)) throw new Error(`Forbidden: missing required permission ${k}`);
  },
}));

import { POST as addReceipt } from './statements/[id]/receipts/route';
import { POST as collectByHand } from '../ops/tracking/collect/route';

const STATEMENT = '88888888-8888-4888-8888-888888888888';
const WALLET = '11111111-1111-4111-8111-111111111111';
const ORDER = '22222222-2222-4222-8222-222222222222';
const post = (body: unknown) => new Request('http://x/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const receipt = () => addReceipt(post({ walletId: WALLET, amount: 90 }), { params: Promise.resolve({ id: STATEMENT }) });
const collect = () => collectByHand(post({ orderIds: [ORDER], walletId: WALLET, note: 'استلمت منه' }));

const context = (storeId: string | null) =>
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'سارة', role: 'CUSTOM', status: 'ACTIVE', companyId: 'c1' },
    companyId: 'c1', storeId, country: { minorUnit: 2, currencyCode: 'USD' },
  });

beforeEach(() => {
  vi.clearAllMocks();
  context('s1');
  db.courierStatement.findFirst.mockResolvedValue({ id: STATEMENT, status: 'MATCHED', approvedAt: null, currencyCode: 'USD', reference: 'ST-1', fileHash: 'abc' });
  db.wallet.findFirst.mockResolvedValue(null);
});

describe('the receipt’s wallet', () => {
  it('is asked for inside this store and the unplaced ones — in this company, and active', async () => {
    await receipt();
    expect(db.wallet.findFirst.mock.calls[0][0].where).toEqual({
      id: WALLET, isActive: true, companyId: 'c1', OR: [{ storeId: 's1' }, { storeId: null }],
    });
  });

  it('NEGATIVE: a wallet of another store is a 404 — nothing is claimed, nothing is written', async () => {
    const res = await receipt();
    expect(res.status).toBe(404);
    expect(db.courierStatement.updateMany).not.toHaveBeenCalled();
    expect(db.statementReceipt.create).not.toHaveBeenCalled();
  });
});

describe('the hand collection’s wallet', () => {
  it('is asked for inside this store and the unplaced ones — in this company, and active', async () => {
    await collect();
    expect(db.wallet.findFirst.mock.calls[0][0].where).toEqual({
      id: WALLET, isActive: true, companyId: 'c1', OR: [{ storeId: 's1' }, { storeId: null }],
    });
  });

  it('NEGATIVE: a wallet of another store is a 404 — the orders are not even read', async () => {
    const res = await collect();
    expect(res.status).toBe(404);
    expect(db.order.findMany).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('NEGATIVE: with no store selected the rule is «only the unplaced ones» — never «any wallet of the company»', async () => {
    context(null);
    await collect();
    const where = db.wallet.findFirst.mock.calls[0][0].where;
    expect(where).toEqual({ id: WALLET, isActive: true, companyId: 'c1', storeId: null });
    // …and in particular no clause that could match another store’s wallet
    expect(where).not.toHaveProperty('OR');
  });
});

describe('the receipt’s wallet, with no store selected', () => {
  it('NEGATIVE: the same — only the unplaced ones', async () => {
    context(null);
    await receipt();
    await Promise.resolve();
    expect(db.wallet.findFirst).toHaveBeenCalledTimes(1);
    const where = db.wallet.findFirst.mock.calls[0][0].where;
    expect(where).toEqual({ id: WALLET, isActive: true, companyId: 'c1', storeId: null });
    expect(where).not.toHaveProperty('OR');
  });
});
