import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE PAGE YOU PAY FROM, WITH A RATE FOR DEDUCTIONS IN ANOTHER CURRENCY.
 *
 * The payer types the currency and the rate; the preview draws the slip with them, and the payment stores them on
 * the payslip. A rate with no currency (or a currency with no rate) is refused before anything is computed.
 */

const { db, requireContext, requirePermission, previewPayslip, paySalary, owedTo, logAudit, PayrollRefused } = vi.hoisted(() => ({
  db: { payslip: { findFirst: vi.fn() }, wallet: { findMany: vi.fn() }, $transaction: vi.fn() },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  previewPayslip: vi.fn(),
  paySalary: vi.fn(),
  owedTo: vi.fn(),
  logAudit: vi.fn(),
  PayrollRefused: class PayrollRefused extends Error {
    constructor(public reason: string) {
      super(reason);
    }
  },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/commission-payout', () => ({ owedTo: (...a: unknown[]) => owedTo(...a) }));
vi.mock('@/lib/payroll', () => ({
  previewPayslip: (...a: unknown[]) => previewPayslip(...a),
  paySalary: (...a: unknown[]) => paySalary(...a),
  PayrollRefused,
}));

import { GET, POST } from './route';

const U = '11111111-1111-4111-8111-111111111111';
const W = '22222222-2222-4222-8222-222222222222';

const get = (qs: string) => GET(new Request(`http://localhost/api/payroll/payslip${qs}`));
const post = (body: unknown) =>
  POST(new Request('http://localhost/api/payroll/payslip', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  vi.resetAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'boss' }, companyId: 'c1', storeId: 's1' });
  requirePermission.mockResolvedValue(undefined);
  db.payslip.findFirst.mockResolvedValue(null);
  db.wallet.findMany.mockResolvedValue([]);
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  previewPayslip.mockResolvedValue({ salary: 300, currencyCode: 'USD', penaltyTotal: 0.71, net: 299.29, carriedOver: 0, penaltyIds: [], undecided: [], otherCurrency: [], converted: null });
  owedTo.mockResolvedValue([]);
  paySalary.mockResolvedValue({
    payslipId: 's1', salary: 300, penaltyTotal: 0.71, net: 299.29, carriedOver: 0, currencyCode: 'USD', paidAmount: 299.29, paidCurrency: 'USD', appliedUndecided: 1,
  });
});

describe('the preview', () => {
  it('draws the slip with the currency and the rate the payer typed', async () => {
    await get(`?userId=${U}&convertCurrency=jod&convertRate=1.41`);
    expect(previewPayslip.mock.calls[0][1]).toMatchObject({ userId: U, convert: { currencyCode: 'JOD', rate: 1.41 } });
  });

  it('without them it draws it as before', async () => {
    await get(`?userId=${U}`);
    expect(previewPayslip.mock.calls[0][1].convert).toBeNull();
  });

  it.each([
    ['a currency with no rate', '?convertCurrency=JOD'],
    ['a rate with no currency', '?convertRate=1.41'],
    ['a rate of zero', '?convertCurrency=JOD&convertRate=0'],
    ['a currency that is not a code', '?convertCurrency=DINAR&convertRate=1.41'],
  ])('NEGATIVE: %s is refused before anything is computed', async (_name, qs) => {
    const res = await get(`${qs}${qs.includes('?') ? '&' : '?'}userId=${U}`);
    expect(res.status).toBe(400);
    expect(previewPayslip).not.toHaveBeenCalled();
  });
});

describe('the payment', () => {
  it('passes the conversion to the payroll, and the audit row keeps it with how many undecided deductions it applied', async () => {
    const res = await post({ userId: U, walletId: W, exchangeRate: 1, convert: { currencyCode: 'jod', rate: 1.41 } });
    expect(res.status).toBe(200);
    expect(paySalary.mock.calls[0][1]).toMatchObject({ convert: { currencyCode: 'JOD', rate: 1.41 }, createdById: 'boss' });
    expect(logAudit.mock.calls[0][0].newData).toMatchObject({ appliedUndecided: 1, convertedFrom: 'JOD', convertRate: 1.41 });
  });

  it('with no conversion it passes none', async () => {
    await post({ userId: U, walletId: W, exchangeRate: 1 });
    expect(paySalary.mock.calls[0][1].convert).toBeNull();
    expect(logAudit.mock.calls[0][0].newData.convertedFrom).toBeUndefined();
  });

  it('NEGATIVE: a rate that is not a rate is refused', async () => {
    expect((await post({ userId: U, walletId: W, exchangeRate: 1, convert: { currencyCode: 'JOD', rate: 0 } })).status).toBe(400);
    expect((await post({ userId: U, walletId: W, exchangeRate: 1, convert: { currencyCode: 'JOD', rate: -2 } })).status).toBe(400);
    expect(paySalary).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a rate under 0.000001 is refused by the server — the column cannot hold it', async () => {
    const res = await post({ userId: U, walletId: W, exchangeRate: 1, convert: { currencyCode: 'JOD', rate: 0.0000001 } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('السعر صغير جداً');
    expect(paySalary).not.toHaveBeenCalled();
  });

  it('0.000001 passes', async () => {
    expect((await post({ userId: U, walletId: W, exchangeRate: 1, convert: { currencyCode: 'JOD', rate: 0.000001 } })).status).toBe(200);
    expect(paySalary.mock.calls[0][1].convert).toEqual({ currencyCode: 'JOD', rate: 0.000001 });
  });

  it('the preview refuses the same small rate', async () => {
    expect((await get(`?userId=${U}&convertCurrency=JOD&convertRate=0.0000001`)).status).toBe(400);
    expect(previewPayslip).not.toHaveBeenCalled();
  });

  it.each(['abc', '1,41', '1e999', ' '])('NEGATIVE: a rate written «%s» is refused by the shared reader, not turned into NaN or zero', async (typed) => {
    const res = await get(`?userId=${U}&convertCurrency=JOD&convertRate=${encodeURIComponent(typed)}`);
    expect(res.status).toBe(400);
    expect(previewPayslip).not.toHaveBeenCalled();
  });

  it('a payment the rate would turn into nothing is answered in Arabic as a conflict', async () => {
    paySalary.mockRejectedValue(new PayrollRefused('RATE_TOO_SMALL'));
    const res = await post({ userId: U, walletId: W, exchangeRate: 1, convert: { currencyCode: 'JOD', rate: 0.000001 } });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('RATE_TOO_SMALL');
  });

  it('a payment that stops because the deductions changed is answered as a conflict', async () => {
    paySalary.mockRejectedValue(new PayrollRefused('DEDUCTIONS_CHANGED'));
    const res = await post({ userId: U, walletId: W, exchangeRate: 1 });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('DEDUCTIONS_CHANGED');
  });
});
