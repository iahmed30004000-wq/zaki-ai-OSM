import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkWallet } from './pay-from-wallet';

/**
 * THE WALLET A PERSON IS PAID FROM IS FOUND AMONG THIS STORE'S.
 *
 * `checkWallet` looked the wallet up by company alone, so a salary paid in store A could leave a wallet that
 * belongs to store B of the same company: the money moved out of another store's drawer. The expense door and the
 * wallets screen already offer «this store's and the unplaced ones»; this is the same rule where the payment is
 * made. A caller with no store to stand in (the company-level commission payout) passes none and is unchanged.
 */

const { db } = vi.hoisted(() => ({ db: { wallet: { findFirst: vi.fn() } } }));

beforeEach(() => {
  vi.clearAllMocks();
  db.wallet.findFirst.mockImplementation(async () => ({ id: 'w1', currencyCode: 'USD', country: { minorUnit: 2 } }));
});

const check = (over: Record<string, unknown> = {}) =>
  checkWallet(db as never, { companyId: 'c1', walletId: 'w1', amount: 100, exchangeRate: 1, ...over });

describe('the wallet is looked up in the store that pays', () => {
  it('with a store: this store’s wallets or the unplaced ones — never another store’s', async () => {
    await check({ storeId: 's1' });
    expect(db.wallet.findFirst.mock.calls[0][0].where).toEqual({
      id: 'w1', companyId: 'c1', isActive: true, OR: [{ storeId: 's1' }, { storeId: null }],
    });
  });

  it('a wallet of another store is not found, so the payment is refused before any money moves', async () => {
    db.wallet.findFirst.mockResolvedValue(null);
    expect(await check({ storeId: 's1' })).toBe('WALLET_NOT_FOUND');
  });

  it('with no store (the company-level commission payout) the lookup is unchanged', async () => {
    await check();
    expect(db.wallet.findFirst.mock.calls[0][0].where).toEqual({ id: 'w1', companyId: 'c1', isActive: true });
    await check({ storeId: null });
    expect(db.wallet.findFirst.mock.calls[1][0].where).toEqual({ id: 'w1', companyId: 'c1', isActive: true });
  });

  it('and the old refusals still come first: a bad rate or nothing owed never reaches the lookup', async () => {
    expect(await check({ exchangeRate: 0, storeId: 's1' })).toBe('BAD_RATE');
    expect(await check({ amount: 0, storeId: 's1' })).toBe('NOTHING_OWED');
    expect(db.wallet.findFirst).not.toHaveBeenCalled();
  });
});
