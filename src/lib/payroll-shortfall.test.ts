import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «فرق تحصيل» AT PAYDAY — the deduction nobody decided, the salary's own decimals, and the rate for another currency.
 *
 * The example the work was specified with: a USD salary of 300.00 with an undecided shortfall of 2.00 pays 298.00.
 * A deduction nobody decided is applied by the PAYMENT, in the payer's name (the owner's default); one in another
 * currency is converted at a rate the payer typed, stored on the payslip. The rounding is the salary currency's
 * own: a dinar has three places, and the old code rounded every salary to two.
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

import { paySalary, previewPayslip } from './payroll';

const SCOPE = { companyId: 'c1', storeId: 's1', userId: 'u1' };
const PAY = {
  ...SCOPE,
  walletId: 'w1',
  periodStart: new Date('2026-10-01T00:00:00Z'),
  periodEnd: new Date('2026-10-31T00:00:00Z'),
  exchangeRate: 1,
  createdById: 'boss',
};

const row = (id: string, amount: number, day: string, currencyCode = 'USD', status = 'PROPOSED') => ({
  id, amount, currencyCode, status, kind: 'SHORTFALL', occurredOn: new Date(day),
});
const salaryOf = (amount: number, currency: string) => ({ salaryAmount: amount, salaryCurrency: currency, commissionCurrency: currency, name: 'سارة' });

beforeEach(() => {
  vi.resetAllMocks();
  db.user.findFirst.mockResolvedValue(salaryOf(300, 'USD'));
  db.penalty.findMany.mockResolvedValue([]);
  db.payslip.findFirst.mockResolvedValue(null);
  db.payslip.create.mockResolvedValue({ id: 'slip1' });
  // A stamping takes the rows it is asked for.
  db.penalty.updateMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => ({ count: where.id.in.length }));
  checkWallet.mockResolvedValue({ walletId: 'w1', currencyCode: 'USD', minorUnit: 2, paidAmount: 298 });
});

describe('a «فرق تحصيل» nobody decided is applied when the salary is paid', () => {
  it('the example: a USD salary of 300.00 with an undecided 2.00 pays 298.00', async () => {
    db.penalty.findMany.mockResolvedValue([row('s1', 2, '2026-10-18')]);
    const p = await previewPayslip(db as never, SCOPE);
    expect(p).toMatchObject({ salary: 300, penaltyTotal: 2, net: 298, carriedOver: 0, currencyCode: 'USD' });
    expect(p.penaltyIds).toEqual(['s1']);
  });

  it('and the slip LISTS it — «لم يُعتمد تفسيره — سيُخصم» — apart from the decided ones', async () => {
    db.penalty.findMany.mockResolvedValue([row('s1', 2, '2026-10-18'), row('s2', 5, '2026-10-19', 'USD', 'APPLIED')]);
    const p = await previewPayslip(db as never, SCOPE);
    expect(p.undecided).toEqual([{ id: 's1', amount: 2, currencyCode: 'USD' }]);
    expect(p.penaltyIds).toEqual(['s1', 's2']);
    expect(p.penaltyTotal).toBe(7);
  });

  it('asks the database for decided deductions and for NO other undecided kind — a late minute still waits for a person', async () => {
    await previewPayslip(db as never, SCOPE);
    const where = db.penalty.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ companyId: 'c1', userId: 'u1', payslipId: null });
    expect(where.OR).toEqual([{ status: 'APPLIED' }, { status: 'PROPOSED', kind: 'SHORTFALL' }]);
  });

  it('paying applies it IN THE PAYER’S NAME, stamps the payslip on it, and says why', async () => {
    db.penalty.findMany.mockResolvedValue([row('s1', 2, '2026-10-18')]);
    const result = await paySalary(db as never, PAY);

    const apply = db.penalty.updateMany.mock.calls[0][0];
    expect(apply.where).toEqual({ id: { in: ['s1'] }, status: 'PROPOSED', payslipId: null });
    expect(apply.data).toMatchObject({ status: 'APPLIED', decidedById: 'boss', payslipId: 'slip1' });
    expect(apply.data.decidedAt).toBeInstanceOf(Date);
    expect(apply.data.decisionNote).toContain('لم يُعتمد تفسيره — سيُخصم');
    expect(result).toMatchObject({ salary: 300, penaltyTotal: 2, net: 298, appliedUndecided: 1 });
    expect(recordSpend).toHaveBeenCalledTimes(1);
  });

  it('a decided deduction beside it is only stamped — its decision stays the decider’s', async () => {
    db.penalty.findMany.mockResolvedValue([row('s1', 2, '2026-10-18'), row('s2', 5, '2026-10-19', 'USD', 'APPLIED')]);
    await paySalary(db as never, PAY);

    expect(db.penalty.updateMany).toHaveBeenCalledTimes(2);
    expect(db.penalty.updateMany.mock.calls[1][0]).toEqual({
      where: { id: { in: ['s2'] }, status: 'APPLIED', payslipId: null },
      data: { payslipId: 'slip1' },
    });
  });

  it('one that does not fit inside the wage is not applied — it waits whole, still undecided', async () => {
    db.user.findFirst.mockResolvedValue(salaryOf(5, 'USD'));
    db.penalty.findMany.mockResolvedValue([row('s1', 4, '2026-10-01'), row('s2', 4, '2026-10-02')]);
    const p = await previewPayslip(db as never, SCOPE);
    expect(p.undecided.map((u) => u.id)).toEqual(['s1']);
    expect(p.carriedOver).toBe(4);
  });

  it('NEGATIVE: a payer who is the person charged cannot apply it to themselves', async () => {
    db.penalty.findMany.mockResolvedValue([row('s1', 2, '2026-10-18')]);
    await expect(paySalary(db as never, { ...PAY, createdById: 'u1' })).rejects.toMatchObject({ reason: 'SELF_DECISION' });
    expect(db.payslip.create).not.toHaveBeenCalled();
    expect(recordSpend).not.toHaveBeenCalled();
  });

  it('…but the same person may be paid when nothing is undecided', async () => {
    db.penalty.findMany.mockResolvedValue([row('s2', 5, '2026-10-19', 'USD', 'APPLIED')]);
    await expect(paySalary(db as never, { ...PAY, createdById: 'u1' })).resolves.toMatchObject({ net: 295 });
  });

  it('NEGATIVE: one waived (or moved) between the preview and the payment stops it — no money leaves', async () => {
    db.penalty.findMany.mockResolvedValue([row('s1', 2, '2026-10-18')]);
    db.penalty.updateMany.mockResolvedValue({ count: 0 });
    await expect(paySalary(db as never, PAY)).rejects.toMatchObject({ reason: 'DEDUCTIONS_CHANGED' });
    expect(recordSpend).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a decided deduction reversed in between is not taken either', async () => {
    db.penalty.findMany.mockResolvedValue([row('s2', 5, '2026-10-19', 'USD', 'APPLIED')]);
    db.penalty.updateMany.mockResolvedValue({ count: 0 });
    await expect(paySalary(db as never, PAY)).rejects.toMatchObject({ reason: 'DEDUCTIONS_CHANGED' });
    expect(recordSpend).not.toHaveBeenCalled();
  });

  it('with nothing undecided and nothing owed, nothing is written to the deductions — the old behaviour', async () => {
    const r = await paySalary(db as never, PAY);
    expect(db.penalty.updateMany).not.toHaveBeenCalled();
    expect(r.appliedUndecided).toBe(0);
  });
});

describe('the rounding is the salary currency’s own', () => {
  it('a dinar salary keeps its fils: 300.000 − 0.125 is 299.875, not 299.88', async () => {
    db.user.findFirst.mockResolvedValue(salaryOf(300, 'JOD'));
    db.penalty.findMany.mockResolvedValue([row('s1', 0.125, '2026-10-18', 'JOD')]);
    const p = await previewPayslip(db as never, SCOPE);
    expect(p.penaltyTotal).toBe(0.125);
    expect(p.net).toBe(299.875);
  });

  it('half a dinar: 300.000 − 0.500 is 299.500', async () => {
    db.user.findFirst.mockResolvedValue(salaryOf(300, 'JOD'));
    db.penalty.findMany.mockResolvedValue([row('s1', 0.5, '2026-10-18', 'JOD')]);
    expect((await previewPayslip(db as never, SCOPE)).net).toBe(299.5);
  });

  it('a dinar salary of 300.125 is not cut to 300.13 on the way in', async () => {
    db.user.findFirst.mockResolvedValue(salaryOf(300.125, 'JOD'));
    expect((await previewPayslip(db as never, SCOPE)).salary).toBe(300.125);
  });

  it('three deductions of 0.1 dinar add up to 0.3 with no float dust', async () => {
    db.user.findFirst.mockResolvedValue(salaryOf(300, 'JOD'));
    db.penalty.findMany.mockResolvedValue([
      row('a', 0.1, '2026-10-01', 'JOD'), row('b', 0.1, '2026-10-02', 'JOD'), row('c', 0.1, '2026-10-03', 'JOD'),
    ]);
    const p = await previewPayslip(db as never, SCOPE);
    expect(p.penaltyTotal).toBe(0.3);
    expect(p.net).toBe(299.7);
  });

  it('a two-place currency rounds exactly as before: 200.005 is 200.01 and the net follows', async () => {
    db.user.findFirst.mockResolvedValue(salaryOf(5000, 'EGP'));
    db.penalty.findMany.mockResolvedValue([row('a', 200.005, '2026-09-03', 'EGP', 'APPLIED')]);
    const p = await previewPayslip(db as never, SCOPE);
    expect(p.penaltyTotal).toBe(200.01);
    expect(p.net).toBe(4799.99);
  });

  it('a currency the table does not know rounds by two places, as everything did', async () => {
    db.user.findFirst.mockResolvedValue(salaryOf(100.005, 'XYZ'));
    expect((await previewPayslip(db as never, SCOPE)).salary).toBe(100.01);
  });
});

describe('a deduction in ANOTHER currency is converted at a rate the payer typed', () => {
  beforeEach(() => {
    db.penalty.findMany.mockResolvedValue([row('j1', 0.5, '2026-10-18', 'JOD')]);
    checkWallet.mockResolvedValue({ walletId: 'w1', currencyCode: 'USD', minorUnit: 2, paidAmount: 299.29 });
  });

  it('without a rate it is left out and SAID — as it always was', async () => {
    const p = await previewPayslip(db as never, SCOPE);
    expect(p.penaltyTotal).toBe(0);
    expect(p.otherCurrency).toEqual([{ currencyCode: 'JOD', amount: 0.5 }]);
    expect(p.converted).toBeNull();
  });

  it('with a rate: 0.500 dinar at 1.41 is 0.71 dollars (0.705 by the salary’s two places), net 299.29', async () => {
    const p = await previewPayslip(db as never, { ...SCOPE, convert: { currencyCode: 'JOD', rate: 1.41 } });
    expect(p).toMatchObject({ penaltyTotal: 0.71, net: 299.29, otherCurrency: [] });
    expect(p.converted).toEqual({ currencyCode: 'JOD', rate: 1.41, amount: 0.5, inSalaryCurrency: 0.71 });
    expect(p.penaltyIds).toEqual(['j1']);
    // Undecided, so payday applies it like any other.
    expect(p.undecided).toEqual([{ id: 'j1', amount: 0.5, currencyCode: 'JOD' }]);
  });

  it('the rate, the original amount and its currency are STORED on the payslip', async () => {
    await paySalary(db as never, { ...PAY, convert: { currencyCode: 'JOD', rate: 1.41 } });
    expect(db.payslip.create.mock.calls[0][0].data).toMatchObject({
      salaryAmount: 300, penaltyTotal: 0.71, netAmount: 299.29,
      settledAmount: 0.5, settledCurrency: 'JOD', settledRate: 1.41,
    });
  });

  it('a payslip with nothing converted stores nothing in those columns', async () => {
    db.penalty.findMany.mockResolvedValue([]);
    await paySalary(db as never, PAY);
    expect(db.payslip.create.mock.calls[0][0].data).toMatchObject({ settledAmount: null, settledCurrency: null, settledRate: null });
  });

  it('a rate for a currency nobody owes changes nothing', async () => {
    const p = await previewPayslip(db as never, { ...SCOPE, convert: { currencyCode: 'EUR', rate: 1.1 } });
    expect(p.penaltyTotal).toBe(0);
    expect(p.converted).toBeNull();
    expect(p.otherCurrency).toEqual([{ currencyCode: 'JOD', amount: 0.5 }]);
  });

  it('only the currency the payer named is converted; another waits, said out loud', async () => {
    db.penalty.findMany.mockResolvedValue([row('j1', 0.5, '2026-10-18', 'JOD'), row('e1', 3, '2026-10-19', 'EGP')]);
    const p = await previewPayslip(db as never, { ...SCOPE, convert: { currencyCode: 'JOD', rate: 1.41 } });
    expect(p.penaltyIds).toEqual(['j1']);
    expect(p.otherCurrency).toEqual([{ currencyCode: 'EGP', amount: 3 }]);
  });

  it('NEGATIVE: a rate of zero (or less) is refused, not ignored', async () => {
    await expect(previewPayslip(db as never, { ...SCOPE, convert: { currencyCode: 'JOD', rate: 0 } })).rejects.toMatchObject({ reason: 'BAD_RATE' });
    await expect(previewPayslip(db as never, { ...SCOPE, convert: { currencyCode: 'JOD', rate: -1 } })).rejects.toMatchObject({ reason: 'BAD_RATE' });
  });

  it('a converted deduction that does not fit waits whole, in the salary’s currency', async () => {
    db.user.findFirst.mockResolvedValue(salaryOf(1, 'USD'));
    const p = await previewPayslip(db as never, { ...SCOPE, convert: { currencyCode: 'JOD', rate: 3 } });
    expect(p.penaltyIds).toEqual([]);
    expect(p.carriedOver).toBe(1.5);
    expect(p.converted).toBeNull();
  });

  describe('a rate too small to mean anything', () => {
    // A dinar salary (three places), a deduction of 5000 Egyptian pounds.
    beforeEach(() => {
      db.user.findFirst.mockResolvedValue(salaryOf(300, 'JOD'));
      db.penalty.findMany.mockResolvedValue([row('e1', 5000, '2026-10-18', 'EGP')]);
    });
    const convert = (rate: number) => previewPayslip(db as never, { ...SCOPE, convert: { currencyCode: 'EGP', rate } });

    it('NEGATIVE: 0.0000001 is refused — it is stored as 0.000000, so it explains nothing', async () => {
      await expect(convert(0.0000001)).rejects.toMatchObject({ reason: 'BAD_RATE' });
    });

    it('0.000001 passes, and converts to the dinar’s own three places: 5000 × 0.000001 = 0.005', async () => {
      const p = await convert(0.000001);
      expect(p.converted).toEqual({ currencyCode: 'EGP', rate: 0.000001, amount: 5000, inSalaryCurrency: 0.005 });
      expect(p.net).toBe(299.995);
    });

    it('a rate with more than six decimals is cut to the six the column holds — and the cut one is what is used and stored', async () => {
      const p = await convert(0.0000014);
      expect(p.converted!.rate).toBe(0.000001);
      expect(p.converted!.inSalaryCurrency).toBe(0.005);
    });

    it('NEGATIVE: a rate that turns a deduction into 0.000 (after roundMinor) is refused — it would be stamped as taken and take nothing', async () => {
      db.penalty.findMany.mockResolvedValue([row('e1', 2, '2026-10-18', 'EGP')]);
      // 2 × 0.000001 = 0.000002 → 0.000 dinars.
      await expect(convert(0.000001)).rejects.toMatchObject({ reason: 'RATE_TOO_SMALL' });
      await expect(convert(0.000001)).rejects.toThrow('السعر صغير جداً — الخصم بيطلع صفر');
    });

    it('and the payment refuses too, before any money moves', async () => {
      db.penalty.findMany.mockResolvedValue([row('e1', 2, '2026-10-18', 'EGP')]);
      await expect(paySalary(db as never, { ...PAY, convert: { currencyCode: 'EGP', rate: 0.000001 } })).rejects.toMatchObject({ reason: 'RATE_TOO_SMALL' });
      expect(db.payslip.create).not.toHaveBeenCalled();
      expect(recordSpend).not.toHaveBeenCalled();
    });

    it('a currency nobody owes does not trip it', async () => {
      await expect(previewPayslip(db as never, { ...SCOPE, convert: { currencyCode: 'EUR', rate: 0.000001 } })).resolves.toMatchObject({ converted: null });
    });
  });

  it('converting into a dinar salary keeps three places', async () => {
    db.user.findFirst.mockResolvedValue(salaryOf(300, 'JOD'));
    db.penalty.findMany.mockResolvedValue([row('u1', 2, '2026-10-18', 'USD')]);
    const p = await previewPayslip(db as never, { ...SCOPE, convert: { currencyCode: 'USD', rate: 0.709 } });
    expect(p.penaltyTotal).toBe(1.418);
    expect(p.net).toBe(298.582);
  });
});
