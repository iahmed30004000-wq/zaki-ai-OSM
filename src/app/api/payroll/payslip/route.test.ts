import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE PAGE YOU PAY FROM.
 *
 * Reading somebody's salary is `payroll.view`. This is not reading — both
 * the preview and the payment need `payroll.pay`, because the preview is
 * the screen a payment is made from and the figures on it are the ones
 * somebody is about to act on.
 *
 * The default period is the month that CLOSED. A month still being worked
 * has days nobody has been paid for and days nobody has been late on yet.
 */

const { db, requireContext, requirePermission, previewPayslip, paySalary, owedTo, logAudit, PayrollRefused } =
  vi.hoisted(() => ({
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
  db.wallet.findMany.mockResolvedValue([{ id: W, name: 'الدرج', currencyCode: 'EGP' }]);
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  previewPayslip.mockResolvedValue({
    salary: 5000, currencyCode: 'EGP', penaltyTotal: 200, net: 4800,
    carriedOver: 0, penaltyIds: ['p1'], otherCurrency: [],
  });
  owedTo.mockResolvedValue([]);
  paySalary.mockResolvedValue({
    payslipId: 'slip1', salary: 5000, penaltyTotal: 200, net: 4800, carriedOver: 0,
    currencyCode: 'EGP', paidAmount: 4800, paidCurrency: 'EGP',
  });
});

describe('who may open it', () => {
  it('the preview needs payroll.pay — it is the page you pay from', async () => {
    await get(`?userId=${U}`);
    expect(requirePermission).toHaveBeenCalledWith('payroll.pay');
  });

  it('and is refused without it, before anything is computed', async () => {
    requirePermission.mockRejectedValue(new Error('Forbidden: missing required permission payroll.pay'));
    expect((await get(`?userId=${U}`)).status).toBe(403);
    expect(previewPayslip).not.toHaveBeenCalled();
  });

  it('paying needs it too, and computes nothing without it', async () => {
    requirePermission.mockRejectedValue(new Error('Forbidden: missing required permission payroll.pay'));
    expect((await post({ userId: U, walletId: W, exchangeRate: 1 })).status).toBe(403);
    expect(paySalary).not.toHaveBeenCalled();
  });
});

describe('the preview', () => {
  it('shows the salary, the deductions and what is actually left', async () => {
    const body = await (await get(`?userId=${U}`)).json();
    expect(body.preview).toMatchObject({ salary: 5000, penaltyTotal: 200, net: 4800 });
  });

  it('says plainly when the month was already paid', async () => {
    db.payslip.findFirst.mockResolvedValue({ id: 'old', netAmount: 4800, createdAt: new Date() });
    const body = await (await get(`?userId=${U}`)).json();
    expect(body.period.paid).not.toBeNull();
  });

  it('defaults to the month that CLOSED, not the one being worked', async () => {
    const body = await (await get(`?userId=${U}`)).json();
    const start = new Date(body.period.start);
    const now = new Date();
    const expected = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    expect(start.toISOString().slice(0, 10)).toBe(expected.toISOString().slice(0, 10));
  });

  it('carries the wallets, so the money and the figure are one question', async () => {
    const body = await (await get(`?userId=${U}`)).json();
    expect(body.wallets).toHaveLength(1);
  });

  it('and shows commission owed beside the wage without paying it', async () => {
    owedTo.mockResolvedValue([{ currencyCode: 'EGP', amount: 700, entries: ['e1'] }]);
    const body = await (await get(`?userId=${U}`)).json();
    expect(body.commission[0].amount).toBe(700);
    // A commission not yet payable must never hold up a salary due today.
    expect(body.preview.net).toBe(4800);
  });

  it('refuses without an employee', async () => {
    expect((await get('')).status).toBe(400);
    expect(previewPayslip).not.toHaveBeenCalled();
  });

  it('and passes a refusal through in Arabic rather than a 500', async () => {
    previewPayslip.mockRejectedValue(new PayrollRefused('NO_SALARY'));
    const res = await get(`?userId=${U}`);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('NO_SALARY');
  });
});

describe('paying', () => {
  it('runs the payslip, the deductions and the money in ONE transaction', async () => {
    await post({ userId: U, walletId: W, exchangeRate: 1 });
    expect(db.$transaction).toHaveBeenCalled();
    expect(paySalary).toHaveBeenCalled();
  });

  it('writes the whole arithmetic to the audit — salary, deductions, net, rate', async () => {
    await post({ userId: U, walletId: W, exchangeRate: 1.5 });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'SALARY_PAID',
        newData: expect.objectContaining({ salary: 5000, penalties: 200, net: 4800, rate: 1.5 }),
      })
    );
  });

  it('refuses a rate that is not a rate, and never reaches the service', async () => {
    expect((await post({ userId: U, walletId: W, exchangeRate: 0 })).status).toBe(400);
    expect((await post({ userId: U, walletId: W, exchangeRate: -1 })).status).toBe(400);
    expect(paySalary).not.toHaveBeenCalled();
  });

  it('and a refusal from the service is a 409 with its reason, and no audit', async () => {
    paySalary.mockRejectedValue(new PayrollRefused('ALREADY_PAID'));
    const res = await post({ userId: U, walletId: W, exchangeRate: 1 });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ALREADY_PAID');
    expect(logAudit).not.toHaveBeenCalled();
  });
});

/* ── 29/10: a month that has not begun, and the wallets of this store ───────────── */

describe('a month that has not begun pays nothing', () => {
  const nextMonth = () => {
    const now = new Date();
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  };
  const thisMonth = () => {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  };

  it('POST for a later month is a 400 FUTURE_PERIOD and writes nothing', async () => {
    for (const period of [nextMonth(), '2031-01', '2099-12']) {
      const res = await post({ userId: U, walletId: W, exchangeRate: 1, period });
      expect(res.status, period).toBe(400);
      expect((await res.json()).code).toBe('FUTURE_PERIOD');
    }
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(paySalary).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('and so does the preview — nobody is shown a payslip they are not allowed to pay', async () => {
    const res = await get(`?userId=${U}&period=${nextMonth()}`);
    expect(res.status).toBe(400);
    expect(previewPayslip).not.toHaveBeenCalled();
  });

  it('the running month and the last closed one are still payable', async () => {
    const now = new Date();
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const last = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
    for (const period of [thisMonth(), last, undefined]) {
      vi.clearAllMocks();
      const res = await post({ userId: U, walletId: W, exchangeRate: 1, ...(period ? { period } : {}) });
      expect(res.status, String(period)).toBe(200);
      expect(paySalary).toHaveBeenCalledTimes(1);
    }
  });
});

describe('the wallets offered are this store’s and the unplaced ones', () => {
  it('the preview lists wallets of the store in the session, or none placed', async () => {
    await get(`?userId=${U}`);
    expect(db.wallet.findMany.mock.calls[0][0].where).toEqual({
      companyId: 'c1', isActive: true, OR: [{ storeId: 's1' }, { storeId: null }],
    });
  });

  it('the payment hands the same store to the wallet check', async () => {
    await post({ userId: U, walletId: W, exchangeRate: 1 });
    expect(paySalary.mock.calls[0][1]).toMatchObject({ companyId: 'c1', storeId: 's1', walletId: W });
  });
});
