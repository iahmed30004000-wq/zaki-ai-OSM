import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AN EXPENSE IS CANCELLED, NEVER DELETED — THE DOOR ON THE EXPENSE LIST.
 *
 * `PATCH /api/finance` cancels one expense: its money returns to the wallet it left and it leaves the profit,
 * in ONE transaction. The cancelling itself (cancelExpense) is proved against an in-memory database in
 * `lib/expense-void.test.ts`; this file holds the door: who may press it, which store it acts for, that it is
 * one transaction, and what each refusal answers.
 */

const { db, TX, cancelExpense, requireContext, requirePermission, logAudit } = vi.hoisted(() => {
  const TX = { sentinel: 'transaction-client' };
  return {
    db: { $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(TX)) },
    TX,
    cancelExpense: vi.fn(),
    requireContext: vi.fn(),
    requirePermission: vi.fn(),
    logAudit: vi.fn(),
  };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/expense-void', () => ({ cancelExpense: (...a: unknown[]) => cancelExpense(...a) }));

import { PATCH } from './route';
import { ExpenseRefused } from '@/lib/wallets';

const patch = (body: unknown) =>
  PATCH(new Request('http://localhost/api/finance', { method: 'PATCH', body: JSON.stringify(body) }));
const valid = { expenseId: 'e1', reason: 'سُجِّل بالخطأ' };

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1' });
  requirePermission.mockResolvedValue({});
  cancelExpense.mockResolvedValue({ reversalId: 'r1', moneyReturned: true });
});

describe('cancelling an expense', () => {
  it('asks «تعديل المالية» — recording an expense is not enough to take one out of the profit', async () => {
    await patch(valid);
    expect(requirePermission).toHaveBeenCalledWith('finance.update');
  });

  it('NEGATIVE: without the permission nothing is cancelled', async () => {
    requirePermission.mockRejectedValue(new Error('Forbidden'));
    const res = await patch(valid);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(cancelExpense).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('acts for the store of the session, inside one transaction, and answers what came back', async () => {
    const res = await patch(valid);
    expect(res.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(cancelExpense.mock.calls[0][0]).toBe(TX);
    expect(cancelExpense.mock.calls[0][1]).toEqual({
      companyId: 'c1', storeId: 's1', expenseId: 'e1', reason: 'سُجِّل بالخطأ', userId: 'u1',
    });
    expect(await res.json()).toMatchObject({ success: true, moneyReturned: true, reversalId: 'r1' });
  });

  it('NEGATIVE: a store named in the body is never read', async () => {
    await patch({ ...valid, storeId: 's2' });
    expect(cancelExpense.mock.calls[0][1].storeId).toBe('s1');
  });

  it('writes «إلغاء مصروف» to the audit trail', async () => {
    await patch(valid);
    expect(logAudit.mock.calls[0][0]).toMatchObject({ action: 'EXPENSE_VOIDED', entity: 'Expense', entityId: 'e1' });
  });

  it('NEGATIVE: a reason that is empty or too short is refused before anything is touched', async () => {
    for (const reason of ['', '   ', 'قصير', undefined]) {
      const res = await patch({ expenseId: 'e1', reason });
      expect(res.status, String(reason)).toBe(400);
    }
    expect(cancelExpense).not.toHaveBeenCalled();
    expect((await patch({ reason: 'سُجِّل بالخطأ' })).status).toBe(400);
    expect((await PATCH(new Request('http://localhost/api/finance', { method: 'PATCH', body: 'not json' }))).status).toBe(400);
  });

  it.each([
    ['NOT_FOUND', 404],
    ['OTHER_STORE', 403],
    ['NOT_ALLOWED', 403],
    ['ALREADY_VOID', 409],
    ['NOT_PAID_BY_THIS', 409],
  ] as const)('a refusal %s answers %s with a sentence and its code, and writes no audit', async (code, status) => {
    cancelExpense.mockRejectedValue(new ExpenseRefused(code));
    const res = await patch(valid);
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body.code).toBe(code);
    expect(body.error).toMatch(/[؀-ۿ]/);
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('any other failure is not turned into a refusal', async () => {
    cancelExpense.mockRejectedValue(new Error('database down'));
    const res = await patch(valid);
    expect(res.status).toBe(500);
  });
});
