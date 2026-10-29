import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PAYDAY, AND WHAT COMES OUT OF IT.
 *
 * One rule matters more than the rest and every test here circles it: a
 * PAYMENT IS NEVER NEGATIVE. Deductions larger than the salary do not turn
 * payday into a bill. Somebody ill for three weeks gets a small wage, and
 * what did not fit waits — it does not arrive as an invoice.
 */

const { db, checkWallet, recordSpend } = vi.hoisted(() => ({
  db: {
    user: { findFirst: vi.fn() },
    penalty: { findMany: vi.fn(), updateMany: vi.fn() },
    payslip: { findFirst: vi.fn(), create: vi.fn() },
  },
  checkWallet: vi.fn(),
  recordSpend: vi.fn(),
}));

vi.mock('./db', () => ({ db }));
vi.mock('./pay-from-wallet', () => ({
  checkWallet: (...a: unknown[]) => checkWallet(...a),
  recordSpend: (...a: unknown[]) => recordSpend(...a),
}));

import { paySalary, previewPayslip, PayrollRefused } from './payroll';

const SCOPE = { companyId: 'c1', storeId: 's1', userId: 'u1' };
const PAY = {
  ...SCOPE,
  walletId: 'w1',
  periodStart: new Date('2026-09-01T00:00:00Z'),
  periodEnd: new Date('2026-09-30T00:00:00Z'),
  exchangeRate: 1,
  createdById: 'boss',
};

const penalty = (id: string, amount: number, day: string, currencyCode = 'EGP') => ({
  id,
  amount,
  currencyCode,
  occurredOn: new Date(day),
});

beforeEach(() => {
  vi.resetAllMocks();
  db.user.findFirst.mockResolvedValue({ salaryAmount: 5000, salaryCurrency: 'EGP', commissionCurrency: 'EGP', name: 'سارة' });
  db.penalty.findMany.mockResolvedValue([]);
  db.payslip.findFirst.mockResolvedValue(null);
  db.payslip.create.mockResolvedValue({ id: 'slip1' });
  // A stamping takes the rows it is asked for (the payment now refuses when it takes FEWER — see «a deduction
  // reversed between the preview and the payment» below). Was `{ count: 0 }`, which a count check cannot tell
  // from every deduction having been reversed.
  db.penalty.updateMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => ({ count: where.id.in.length }));
  checkWallet.mockResolvedValue({ walletId: 'w1', currencyCode: 'EGP', minorUnit: 2, paidAmount: 5000 });
});

describe('the plain case', () => {
  it('pays the salary when nothing was deducted', async () => {
    const p = await previewPayslip(db as never, SCOPE);
    expect(p).toMatchObject({ salary: 5000, penaltyTotal: 0, net: 5000, carriedOver: 0 });
  });

  it('and takes the deductions out of it', async () => {
    db.penalty.findMany.mockResolvedValue([penalty('a', 200, '2026-09-03'), penalty('b', 100, '2026-09-10')]);
    const p = await previewPayslip(db as never, SCOPE);
    expect(p).toMatchObject({ penaltyTotal: 300, net: 4700, carriedOver: 0 });
    expect(p.penaltyIds).toEqual(['a', 'b']);
  });
});

describe('deductions bigger than the wage', () => {
  it('never produce a negative payment', async () => {
    db.penalty.findMany.mockResolvedValue([penalty('a', 4000, '2026-09-03'), penalty('b', 4000, '2026-09-10')]);
    const p = await previewPayslip(db as never, SCOPE);
    expect(p.net).toBeGreaterThanOrEqual(0);
    expect(p.net).toBe(1000);
  });

  it('what did not fit stays owed, whole, for next time', async () => {
    db.penalty.findMany.mockResolvedValue([penalty('a', 4000, '2026-09-03'), penalty('b', 4000, '2026-09-10')]);
    const p = await previewPayslip(db as never, SCOPE);
    // Not split across two payslips: half a deduction settled is a row
    // nobody can explain.
    expect(p.penaltyIds).toEqual(['a']);
    expect(p.carriedOver).toBe(4000);
  });

  it('oldest first — the one nobody can still reconstruct is not the survivor', async () => {
    db.penalty.findMany.mockResolvedValue([penalty('old', 3000, '2026-09-01'), penalty('new', 3000, '2026-09-20')]);
    const p = await previewPayslip(db as never, SCOPE);
    expect(p.penaltyIds).toEqual(['old']);
    // And it asked the database for them in that order.
    expect(db.penalty.findMany.mock.calls[0][0].orderBy).toEqual({ occurredOn: 'asc' });
  });

  it('a wage eaten entirely pays nothing, rather than a movement of zero', async () => {
    db.penalty.findMany.mockResolvedValue([penalty('a', 5000, '2026-09-03')]);
    await expect(paySalary(db as never, PAY)).rejects.toMatchObject({ reason: 'NOTHING_OWED' });
    expect(recordSpend).not.toHaveBeenCalled();
    expect(db.payslip.create).not.toHaveBeenCalled();
  });
});

describe('a deduction in another currency', () => {
  it('is never netted off a salary it does not belong to', async () => {
    db.penalty.findMany.mockResolvedValue([penalty('a', 200, '2026-09-03', 'SYP')]);
    const p = await previewPayslip(db as never, SCOPE);
    expect(p.penaltyTotal).toBe(0);
    expect(p.net).toBe(5000);
    // Said out loud rather than silently dropped.
    expect(p.otherCurrency).toEqual([{ currencyCode: 'SYP', amount: 200 }]);
  });
});

describe('which currency the wage is in', () => {
  it('the salary’s own', async () => {
    db.user.findFirst.mockResolvedValue({ salaryAmount: 100, salaryCurrency: 'EGP', commissionCurrency: 'SYP' });
    expect((await previewPayslip(db as never, SCOPE)).currencyCode).toBe('EGP');
  });

  it('falling back to the one their commission is counted in — never the store’s', async () => {
    // That fallback is how an Egyptian employee ends up told a figure in
    // Syrian pounds.
    db.user.findFirst.mockResolvedValue({ salaryAmount: 100, salaryCurrency: null, commissionCurrency: 'EGP' });
    expect((await previewPayslip(db as never, SCOPE)).currencyCode).toBe('EGP');
  });

  it('and with neither, it refuses rather than guessing', async () => {
    db.user.findFirst.mockResolvedValue({ salaryAmount: 100, salaryCurrency: null, commissionCurrency: null });
    await expect(previewPayslip(db as never, SCOPE)).rejects.toMatchObject({ reason: 'NO_SALARY' });
  });
});

describe('what it refuses', () => {
  it('somebody with no salary on file', async () => {
    db.user.findFirst.mockResolvedValue({ salaryAmount: null, salaryCurrency: null, commissionCurrency: 'EGP' });
    await expect(previewPayslip(db as never, SCOPE)).rejects.toBeInstanceOf(PayrollRefused);
  });

  it('a period already paid — a month paid twice is a month paid twice', async () => {
    db.payslip.findFirst.mockResolvedValue({ id: 'slip0' });
    await expect(paySalary(db as never, PAY)).rejects.toMatchObject({ reason: 'ALREADY_PAID' });
    expect(recordSpend).not.toHaveBeenCalled();
  });

  it('a wallet that does not exist, and a rate that is not a rate', async () => {
    checkWallet.mockResolvedValue('WALLET_NOT_FOUND');
    await expect(paySalary(db as never, PAY)).rejects.toMatchObject({ reason: 'WALLET_NOT_FOUND' });
    checkWallet.mockResolvedValue('BAD_RATE');
    await expect(paySalary(db as never, PAY)).rejects.toMatchObject({ reason: 'BAD_RATE' });
    expect(db.payslip.create).not.toHaveBeenCalled();
  });
});

describe('paying', () => {
  beforeEach(() => {
    db.penalty.findMany.mockResolvedValue([penalty('a', 200, '2026-09-03')]);
    checkWallet.mockResolvedValue({ walletId: 'w1', currencyCode: 'EGP', minorUnit: 2, paidAmount: 4800 });
  });

  it('writes the salary as a SNAPSHOT, so a rise never rewrites last March', async () => {
    await paySalary(db as never, PAY);
    expect(db.payslip.create.mock.calls[0][0].data).toMatchObject({
      salaryAmount: 5000,
      penaltyTotal: 200,
      netAmount: 4800,
      currencyCode: 'EGP',
    });
  });

  it('stamps the deductions with the payslip that took them — never deletes them', async () => {
    await paySalary(db as never, PAY);
    expect(db.penalty.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: { in: ['a'] }, payslipId: null },
      data: { payslipId: 'slip1' },
    });
  });

  it('and records the money leaving through the one function that knows how', async () => {
    await paySalary(db as never, PAY);
    expect(recordSpend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ category: 'EXPENSE', referenceType: 'PAYSLIP', referenceId: 'slip1', amount: 4800 }),
      expect.anything()
    );
  });

  it('asking the wallet for the NET, not the salary', async () => {
    await paySalary(db as never, PAY);
    expect(checkWallet.mock.calls[0][1].amount).toBe(4800);
  });
});

describe('the wallet is checked in the store that pays (63)', () => {
  it('hands the payslip’s store to the wallet check, so another store’s drawer cannot pay a salary', async () => {
    await paySalary(db as never, PAY);
    expect(checkWallet.mock.calls[0][1]).toMatchObject({ companyId: 'c1', walletId: 'w1', storeId: 's1' });
  });
});
