import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «القيد العكسي ما بيسمع بالتحويلات» — THE HISTORY OF TRANSFERS SAYS WHAT WAS TAKEN BACK.
 *
 * `GET /api/finance/transfers` reads the legs of the transfers it lists (one query, on the company's `TRANSFER`
 * movements) and answers each row with its state, the wallets whose leg is reversed, and the latest reversal's reason,
 * time and writer. Only the READ changed: the key is still the cash box's view key, and no figure of the row moved.
 */

const { db, requireContext, requirePermission } = vi.hoisted(() => ({
  db: {
    walletTransfer: { findMany: vi.fn() },
    wallet: { findMany: vi.fn() },
    walletMovement: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/wallets', () => ({ recordMovement: vi.fn() }));

import { GET } from './route';

const transfer = (id: string) => ({
  id, companyId: 'co', fromWalletId: 'sham', toWalletId: 'binance', amountOut: '663958', amountIn: '4501.41', exchangeRate: '0.00678',
  kind: 'EXCHANGE', note: 'تصريف من ليرة لدولار', createdById: 'u1', createdAt: new Date('2026-11-14T18:27:00Z'),
});
const leg = (id: string, referenceId: string, walletId: string) => ({
  id, referenceId, walletId, reversalOfId: null, reversalReason: null, createdAt: new Date('2026-11-14T18:27:00Z'), createdById: 'u1',
});
const undo = (id: string, of: string, referenceId: string, walletId: string, reason: string, createdById = 'u2') => ({
  id, referenceId, walletId, reversalOfId: of, reversalReason: reason, createdAt: new Date('2026-11-14T18:28:00Z'), createdById,
});

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ companyId: 'co' });
  requirePermission.mockResolvedValue(undefined);
  db.wallet.findMany.mockResolvedValue([]);
  db.user.findMany.mockResolvedValue([{ id: 'u2', name: 'احمد' }]);
  db.walletTransfer.findMany.mockResolvedValue([transfer('t-live'), transfer('t-half'), transfer('t-done')]);
  db.walletMovement.findMany.mockResolvedValue([
    leg('a-out', 't-live', 'sham'), leg('a-in', 't-live', 'binance'),
    leg('b-out', 't-half', 'sham'), leg('b-in', 't-half', 'binance'), undo('b-r-in', 'b-in', 't-half', 'binance', 'خطأ من البنت'),
    leg('c-out', 't-done', 'sham'), leg('c-in', 't-done', 'binance'),
    undo('c-r-in', 'c-in', 't-done', 'binance', 'خطأ من البنت'), undo('c-r-out', 'c-out', 't-done', 'sham', 'خطأ من البنت'),
  ]);
});

const rows = async () => {
  const { transfers } = await (await GET()).json();
  return new Map<string, Record<string, unknown>>(transfers.map((t: { id: string }) => [t.id, t]));
};

describe('each row says what was taken back of it', () => {
  it('a transfer nobody touched is «ساري», with nothing reversed', async () => {
    expect((await rows()).get('t-live')).toMatchObject({ state: 'ACTIVE', reversedWalletIds: [], reversal: null });
  });

  it('a transfer with ONE leg reversed is «partly», names the wallet that was reversed, and carries the reason and the writer', async () => {
    const half = (await rows()).get('t-half');
    expect(half).toMatchObject({
      state: 'PARTLY_REVERSED', reversedWalletIds: ['binance'],
      reversal: { reason: 'خطأ من البنت', byName: 'احمد' },
    });
  });

  it('a transfer with BOTH legs reversed is «reversed»', async () => {
    const done = (await rows()).get('t-done');
    expect(done?.state).toBe('REVERSED');
    expect([...((done?.reversedWalletIds as string[]) ?? [])].sort()).toEqual(['binance', 'sham']);
  });

  it('the money of the row is as it was — the amounts and the rate still come out as numbers', async () => {
    expect((await rows()).get('t-live')).toMatchObject({ amountOut: 663958, amountIn: 4501.41, exchangeRate: 0.00678 });
  });
});

describe('what the read asks', () => {
  it('reads the legs ONCE, inside the company, for exactly the transfers it lists', async () => {
    await GET();
    expect(db.walletMovement.findMany).toHaveBeenCalledTimes(1);
    const { where } = db.walletMovement.findMany.mock.calls[0][0];
    expect(where).toMatchObject({ companyId: 'co', referenceType: 'TRANSFER' });
    expect([...where.referenceId.in].sort()).toEqual(['t-done', 't-half', 't-live']);
  });

  it('asks for the writers’ names only when something was reversed', async () => {
    await GET();
    expect(db.user.findMany).toHaveBeenCalledTimes(1);
    expect(db.user.findMany.mock.calls[0][0].where).toEqual({ id: { in: ['u2'] } });

    vi.clearAllMocks();
    requireContext.mockResolvedValue({ companyId: 'co' });
    requirePermission.mockResolvedValue(undefined);
    db.wallet.findMany.mockResolvedValue([]);
    db.walletTransfer.findMany.mockResolvedValue([transfer('t-live')]);
    db.walletMovement.findMany.mockResolvedValue([leg('a-out', 't-live', 'sham'), leg('a-in', 't-live', 'binance')]);
    await GET();
    expect(db.user.findMany).not.toHaveBeenCalled();
  });

  it('asks no movement at all when there is no transfer to read', async () => {
    db.walletTransfer.findMany.mockResolvedValue([]);
    const { transfers } = await (await GET()).json();
    expect(transfers).toEqual([]);
    expect(db.walletMovement.findMany).not.toHaveBeenCalled();
  });

  it('is still under the cash box’s VIEW key, and nothing else is written', async () => {
    await GET();
    expect(requirePermission).toHaveBeenCalledWith('finance.cashbox_view');
  });
});
