import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «كل محفظة لازم تكون مميزة» — A ROW OF THE TRANSFER HISTORY NAMES ITS TWO WALLETS BY THEIR FACES.
 *
 * `GET /api/finance/transfers` already answers each end as `{ id, name, currencyCode, store }`. The screen draws the
 * wallet's picture beside the name, so the answer carries the three fields of the look — and ONLY a read changed: the
 * transfer door's money (POST) is not in this file.
 */

const { db, requireContext, requirePermission } = vi.hoisted(() => ({
  // `walletMovement` and `user`: the list also reads which transfers were reversed (their legs) and who wrote it — none here.
  db: { walletTransfer: { findMany: vi.fn() }, wallet: { findMany: vi.fn() }, walletMovement: { findMany: vi.fn() }, user: { findMany: vi.fn() } },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/wallets', () => ({ recordMovement: vi.fn() }));

import { GET } from './route';

const KEY = 'companies/4f1c2a8e-7b3d-4e56-9a10-5c2d8e7f6a31/products/9d0e6b12-3c45-4f78-8a9b-0c1d2e3f4a5b/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d.webp';

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ companyId: 'co' });
  requirePermission.mockResolvedValue(undefined);
  db.walletMovement.findMany.mockResolvedValue([]);
  db.user.findMany.mockResolvedValue([]);
  db.walletTransfer.findMany.mockResolvedValue([
    {
      id: 't1', companyId: 'co', fromWalletId: 'w1', toWalletId: 'w2', amountOut: '100', amountIn: '100', exchangeRate: '1',
      kind: 'INTERNAL', note: 'تحويل', createdAt: new Date('2026-11-11T08:00:00Z'),
    },
  ]);
  db.wallet.findMany.mockResolvedValue([
    { id: 'w1', name: 'بينانس', currencyCode: 'USDT', store: { name: 'المتجر' }, imageKey: KEY, iconKey: 'crypto', colorKey: 'warning' },
    { id: 'w2', name: 'الصندوق', currencyCode: 'USDT', store: { name: 'المتجر' }, imageKey: null, iconKey: null, colorKey: null },
  ]);
});

describe('the history', () => {
  it('asks the two wallets for their look as well as their name, still under the cash box’s view key', async () => {
    await GET();
    expect(requirePermission).toHaveBeenCalledWith('finance.cashbox_view');
    const select = db.wallet.findMany.mock.calls[0][0].select;
    expect(select).toMatchObject({ id: true, name: true, currencyCode: true, imageKey: true, iconKey: true, colorKey: true });
  });

  it('answers each end with its look — the picture, the icon and the colour — null where nobody chose', async () => {
    const body = await (await GET()).json();
    expect(body.transfers[0].from).toMatchObject({ id: 'w1', name: 'بينانس', imageKey: KEY, iconKey: 'crypto', colorKey: 'warning' });
    expect(body.transfers[0].to).toMatchObject({ id: 'w2', imageKey: null, iconKey: null, colorKey: null });
    // The money of the row is as it was.
    expect(body.transfers[0]).toMatchObject({ amountOut: 100, amountIn: 100, exchangeRate: 1 });
  });
});
