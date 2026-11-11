import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «كل محفظة لازم تكون مميزة» — THE LIST CARRIES EACH WALLET'S LOOK, to everybody who is shown the list.
 *
 * A picture, an icon and a colour are not figures: whoever may pick a wallet (the transfer screen, the courier statement's
 * receipt) may recognise it, so the three fields ride in BOTH answers of `GET /api/finance/wallets` — the cash box's, with
 * the balances, and the narrower one for settlement, which has never carried a balance and still does not.
 */

const { db, requireContext, requirePermission, can, walletBalance } = vi.hoisted(() => ({
  db: { wallet: { findMany: vi.fn() } },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  can: vi.fn(),
  walletBalance: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: (...a: unknown[]) => requirePermission(...a),
  can: (...a: unknown[]) => can(...a),
}));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/wallets', () => ({ walletBalance: (...a: unknown[]) => walletBalance(...a) }));

import { GET } from './route';

const KEY = 'companies/4f1c2a8e-7b3d-4e56-9a10-5c2d8e7f6a31/products/9d0e6b12-3c45-4f78-8a9b-0c1d2e3f4a5b/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d.webp';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'w1', name: 'بينانس', currencyCode: 'USDT', isActive: true, countryId: 'c1', storeId: 's1',
  country: { id: 'c1', name: 'سوريا', code: 'SY', minorUnit: 2 }, store: { id: 's1', name: 'المتجر' }, openingCount: null,
  imageKey: null, iconKey: null, colorKey: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'co', country: { minorUnit: 2 }, storeId: 's1' });
  requirePermission.mockResolvedValue(undefined);
  can.mockReturnValue(true);
  walletBalance.mockImplementation(async (_db: unknown, id: string) => ({ walletId: id, opening: 0, in: 0, out: 0, balance: 100, movements: 0 }));
});

describe('the answer the cash box gets', () => {
  it('carries the picture, the icon and the colour of each wallet, null where nobody chose', async () => {
    db.wallet.findMany.mockResolvedValue([
      row({ id: 'w1', imageKey: KEY, iconKey: 'crypto', colorKey: 'warning' }),
      row({ id: 'w2', name: 'الصندوق' }),
    ]);
    const body = await (await GET(new Request('http://x/api/finance/wallets'))).json();
    expect(body.wallets[0]).toMatchObject({ id: 'w1', imageKey: KEY, iconKey: 'crypto', colorKey: 'warning', balance: 100 });
    expect(body.wallets[1]).toMatchObject({ id: 'w2', imageKey: null, iconKey: null, colorKey: null });
  });

  it('and the transfer screen’s wider list (every wallet of the company) carries them as well', async () => {
    db.wallet.findMany.mockResolvedValue([row({ iconKey: 'bank', colorKey: 'chart-3' })]);
    const body = await (await GET(new Request('http://x/api/finance/wallets?scope=transfer'))).json();
    expect(body.wallets[0]).toMatchObject({ iconKey: 'bank', colorKey: 'chart-3' });
  });
});

describe('the narrower answer, for who only uploads a statement', () => {
  it('carries the look and still no balance, no store and no count', async () => {
    can.mockReturnValue(false);
    db.wallet.findMany.mockResolvedValue([row({ imageKey: KEY, iconKey: 'card', colorKey: 'success' })]);
    const body = await (await GET(new Request('http://x/api/finance/wallets'))).json();
    expect(requirePermission).toHaveBeenCalledWith('settlement.upload');
    expect(body.wallets).toEqual([
      {
        id: 'w1', name: 'بينانس', currencyCode: 'USDT', isActive: true,
        country: { id: 'c1', name: 'سوريا', code: 'SY', minorUnit: 2 },
        imageKey: KEY, iconKey: 'card', colorKey: 'success',
      },
    ]);
    expect(walletBalance).not.toHaveBeenCalled();
  });
});
