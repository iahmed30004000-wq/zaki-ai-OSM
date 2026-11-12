import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PAYING COMMISSION, WHEN THE PERSON AND THE WALLET SPEAK DIFFERENT MONEY.
 *
 * An entry used to reach PAYABLE and stop — nothing turned it into money,
 * so the cash left the drawer by hand and the balance stayed owed for ever.
 *
 * And the two currencies are not one question. An Egyptian moderator earns
 * in pounds; there may be no pound wallet at all, so the money leaves the
 * dollar one at a rate the owner writes AT PAYOUT — which is the only
 * moment the paying wallet is known.
 */

const { db } = vi.hoisted(() => ({
  db: {
    wallet: { findFirst: vi.fn() },
    commissionEntry: { findMany: vi.fn(), updateMany: vi.fn() },
    commissionPayout: { create: vi.fn() },
    walletMovement: { create: vi.fn() },
    user: { findFirst: vi.fn() },
  },
}));
vi.mock('./db', () => ({ db }));

import { PayoutRefused, owedTo, payCommission } from './commission-payout';

const EGP = (id: string, amount: number, over: Record<string, unknown> = {}) => ({
  id, userId: 'u1', status: 'PAYABLE', amount, currencyCode: 'EGP', payoutId: null, ...over,
});

const pay = (over: Record<string, unknown> = {}) =>
  payCommission(db as never, {
    companyId: 'c1', userId: 'u1', walletId: 'w-usd',
    entryIds: ['e1', 'e2'], exchangeRate: 48.5,
    createdById: 'owner', ...over,
  });

beforeEach(() => {
  vi.resetAllMocks();
  // A dollar wallet: the only one with money in it.
  db.wallet.findFirst.mockResolvedValue({
    id: 'w-usd', currencyCode: 'USD', name: 'الصندوق الرئيسي', country: { minorUnit: 2 },
  });
  db.commissionEntry.findMany.mockResolvedValue([EGP('e1', 300), EGP('e2', 200)]);
  db.commissionPayout.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'p1', ...data }));
  db.commissionEntry.updateMany.mockResolvedValue({ count: 2 });
  db.walletMovement.create.mockResolvedValue({});
  db.user.findFirst.mockResolvedValue({ name: 'سارة' });
});

describe('paying a person in a currency no wallet holds', () => {
  it('records what they earned AND what actually left the wallet', async () => {
    // 500 EGP owed; the owner pays from the dollar wallet at 48.5 EGP/USD…
    const r = await pay({ exchangeRate: 1 / 48.5 });
    expect(r.amount).toBe(500);
    expect(r.currencyCode).toBe('EGP');
    expect(r.paidAmount).toBe(10.31); // 500 ÷ 48.5, to the wallet's two decimals
    expect(r.paidCurrency).toBe('USD');
  });

  it('takes the money out of the wallet, in the WALLET\'s currency', async () => {
    await pay({ exchangeRate: 1 / 48.5 });
    const movement = db.walletMovement.create.mock.calls[0][0].data;
    expect(movement).toMatchObject({
      walletId: 'w-usd', direction: 'OUT', amount: 10.31, currencyCode: 'USD',
      category: 'COMMISSION', referenceType: 'COMMISSION_PERIOD', referenceId: 'p1',
      party: 'سارة',
    });
    // The note carries both sides, so the movement explains itself later.
    expect(movement.note).toContain('EGP');
  });

  it('rounds to the WALLET\'s currency, not the person\'s', async () => {
    // A three-decimal wallet keeps its fils.
    db.wallet.findFirst.mockResolvedValue({ id: 'w-jod', currencyCode: 'JOD', name: 'الأردن', country: { minorUnit: 3 } });
    const r = await pay({ walletId: 'w-jod', exchangeRate: 0.0145 });
    expect(r.paidAmount).toBe(7.25);
  });

  it('marks the entries paid and points them at the payment', async () => {
    await pay();
    // The condition rides in the WHERE and not only in the read above: two
    // payouts can photograph the same PAYABLE row, and an unconditional
    // update by id lets the second overwrite the first one's payoutId.
    // Behaviour under a real concurrent claim is in
    // commission-settled-promotion.test.ts.
    expect(db.commissionEntry.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['e1', 'e2'] }, companyId: 'c1', status: 'PAYABLE', payoutId: null },
      data: { status: 'PAID', payoutId: 'p1' },
    });
  });

  it('stores the rate as written — a paid month must read the same next year', async () => {
    await pay({ exchangeRate: 0.0206 });
    expect(db.commissionPayout.create.mock.calls[0][0].data.exchangeRate).toBe(0.0206);
  });
});

describe('what a payout refuses', () => {
  const refuses = async (reason: string, over: Record<string, unknown> = {}) => {
    await expect(pay(over)).rejects.toThrow(PayoutRefused);
    await expect(pay(over)).rejects.toMatchObject({ reason });
    expect(db.walletMovement.create).not.toHaveBeenCalled();
  };

  it('an entry that a settlement has not made payable yet', async () => {
    db.commissionEntry.findMany.mockResolvedValue([EGP('e1', 300), EGP('e2', 200, { status: 'ACCRUED' })]);
    await refuses('NOT_PAYABLE');
  });

  it('an entry already paid — nobody is paid twice', async () => {
    db.commissionEntry.findMany.mockResolvedValue([EGP('e1', 300), EGP('e2', 200, { payoutId: 'earlier' })]);
    await refuses('NOT_PAYABLE');
  });

  it('somebody else\'s commission slipped into the list', async () => {
    db.commissionEntry.findMany.mockResolvedValue([EGP('e1', 300), EGP('e2', 200, { userId: 'u2' })]);
    await refuses('WRONG_PERSON');
  });

  it('two currencies in one payment — one rate cannot serve both', async () => {
    db.commissionEntry.findMany.mockResolvedValue([EGP('e1', 300), EGP('e2', 200, { currencyCode: 'SYP' })]);
    await refuses('MIXED_CURRENCY');
  });

  it('a rate of zero or less', async () => {
    await refuses('BAD_RATE', { exchangeRate: 0 });
    await refuses('BAD_RATE', { exchangeRate: -1 });
  });

  it('a wallet that is not this company\'s, or is switched off', async () => {
    db.wallet.findFirst.mockResolvedValue(null);
    await refuses('WALLET_NOT_FOUND');
    expect(db.wallet.findFirst.mock.calls[0][0].where).toMatchObject({ companyId: 'c1', isActive: true });
  });

  it('an empty list, or an entry of another company that was not found', async () => {
    await expect(pay({ entryIds: [] })).rejects.toMatchObject({ reason: 'NO_ENTRIES' });
    db.commissionEntry.findMany.mockResolvedValue([EGP('e1', 300)]); // one of two
    await refuses('NO_ENTRIES');
  });

  it('nothing actually owed', async () => {
    db.commissionEntry.findMany.mockResolvedValue([EGP('e1', 0), EGP('e2', 0)]);
    await refuses('NOTHING_OWED');
  });
});

describe('what a person is owed', () => {
  it('is grouped by currency — two balances are never added into one', async () => {
    db.commissionEntry.findMany.mockResolvedValue([
      { id: 'a', amount: 300, currencyCode: 'EGP' },
      { id: 'b', amount: 200, currencyCode: 'EGP' },
      { id: 'c', amount: 50, currencyCode: 'SYP' },
    ]);
    const rows = await owedTo(db as never, { companyId: 'c1', userId: 'u1' });
    expect(rows).toEqual([
      { currencyCode: 'EGP', amount: 500, entries: ['a', 'b'] },
      { currencyCode: 'SYP', amount: 50, entries: ['c'] },
    ]);
  });

  it('counts only what is payable and unpaid', async () => {
    db.commissionEntry.findMany.mockResolvedValue([]);
    await owedTo(db as never, { companyId: 'c1', userId: 'u1' });
    // Unpaid, this person's — and PAYABLE *or* what the payout door would
    // promote on the spot, because an order the statement delivered is
    // settled with its entry still ACCRUED. A balance the door would not
    // accept is a balance nobody can collect; the two arms are asserted
    // against real rows in commission-settled-promotion.test.ts.
    expect(db.commissionEntry.findMany.mock.calls[0][0].where).toMatchObject({
      payoutId: null, userId: 'u1', companyId: 'c1',
    });
    expect(db.commissionEntry.findMany.mock.calls[0][0].where.OR).toEqual([
      { status: 'PAYABLE' },
      {
        status: 'ACCRUED',
        payoutId: null,
        reversedBy: { is: null },
        // ...and never an order the owner closed as collected before the system («أقفل القديمة بلا باركود», 12/11).
        order: { settlementStatus: 'SETTLED', activities: { none: { action: 'LEGACY_CLOSED_NO_MONEY' } } },
      },
    ]);
  });
});
