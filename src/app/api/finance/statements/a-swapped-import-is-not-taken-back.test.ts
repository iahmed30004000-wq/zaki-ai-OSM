import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «إلغاء الاستيراد» AFTER A PARCEL SWAP.
 *
 * The undo is allowed until approval because nothing has been written from a statement before it: no wallet
 * movement, no order, no commission. A parcel swap is the one thing recorded on a line that DOES write an order and
 * draws stock before the approval — so a statement that carries one is no longer untouched, and the file cannot be
 * thrown away from under the sale it made.
 *
 * The refusal is also the filter of the delete itself, so it holds against a swap that lands a moment after the check.
 */
const { db, requireContext, requirePermission, logAudit, removeProofFile } = vi.hoisted(() => ({
  db: { courierStatement: { findFirst: vi.fn(), deleteMany: vi.fn() }, $transaction: vi.fn() },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
  removeProofFile: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/settlement-proof', () => ({ removeProofFile: (...a: unknown[]) => removeProofFile(...a) }));
vi.mock('@/lib/api-error', () => ({
  apiErrorResponse: (e: unknown) => new Response(String((e as Error).message), { status: (e as { status?: number }).status ?? 500 }),
}));
vi.mock('@/lib/stock-consumption', () => ({ consumeOrderStock: vi.fn() }));
vi.mock('@/lib/settlement', () => ({ receiptGap: vi.fn() }));
vi.mock('@/lib/wallets', () => ({ recordMovement: vi.fn() }));
vi.mock('@/lib/commission', () => ({ markPayableForOrders: vi.fn() }));

import { DELETE } from './[id]/route';
import { SWAP_ACTION, SWAP_BLOCKS_UNDO_AR, swapTiedToLine } from '@/lib/superseded';

const row = (over: Record<string, unknown> = {}) => ({
  id: 's1', reference: 'ST-2026-09', fileName: 'x.xlsx', status: 'MATCHED', approvedAt: null,
  totalAmount: 2869.04, currencyCode: 'USD', deliveryProviderId: 'p1',
  _count: { lines: 292, receipts: 0, matches: 292 }, receipts: [], matches: [], ...over,
});
const del = () => DELETE(new Request('http://x', { method: 'DELETE' }), { params: Promise.resolve({ id: 's1' }) });

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'co', storeId: 'st' });
  requirePermission.mockResolvedValue(undefined);
  db.courierStatement.findFirst.mockResolvedValue(row());
  db.courierStatement.deleteMany.mockResolvedValue({ count: 1 });
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({ courierStatement: db.courierStatement }));
});

describe('an import that carries a parcel swap', () => {
  it('asks the database for it in the same read — a swap line is a MANUAL row on an order that carries the swap word', async () => {
    await del();
    const select = db.courierStatement.findFirst.mock.calls[0][0].select;
    expect(select.matches).toEqual({ where: swapTiedToLine, select: { id: true }, take: 1 });
    expect(swapTiedToLine).toEqual({ matchedBy: 'MANUAL', order: { activities: { some: { action: SWAP_ACTION } } } });
  });

  it('is refused with 409 and in words, and nothing is deleted, removed or audited', async () => {
    db.courierStatement.findFirst.mockResolvedValue(row({ matches: [{ id: 'm1' }] }));
    const res = await del();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'SWAP_ON_STATEMENT', error: SWAP_BLOCKS_UNDO_AR });
    expect(db.courierStatement.deleteMany).not.toHaveBeenCalled();
    expect(removeProofFile).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
    expect(SWAP_BLOCKS_UNDO_AR).not.toMatch(/[A-Za-z]/);
  });

  it('the delete itself repeats it: no swap on the statement at the moment of the write', async () => {
    await del();
    expect(db.courierStatement.deleteMany.mock.calls[0][0].where).toMatchObject({
      approvedAt: null, status: { not: 'APPROVED' }, matches: { none: swapTiedToLine },
    });
  });

  it('a swap that landed between the check and the delete is told as a swap, not as an approval', async () => {
    db.courierStatement.deleteMany.mockResolvedValue({ count: 0 });
    db.courierStatement.findFirst.mockResolvedValueOnce(row()).mockResolvedValueOnce({ matches: [{ id: 'm1' }] });
    const res = await del();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('SWAP_ON_STATEMENT');
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('and a delete that finds nothing for another reason is still told as an approval', async () => {
    db.courierStatement.deleteMany.mockResolvedValue({ count: 0 });
    db.courierStatement.findFirst.mockResolvedValueOnce(row()).mockResolvedValueOnce({ matches: [] });
    const res = await del();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ALREADY_APPROVED');
  });

  it('a statement with no swap on it is taken back as ever', async () => {
    const res = await del();
    expect(res.status).toBe(200);
    expect(logAudit.mock.calls[0][0].action).toBe('STATEMENT_IMPORT_UNDONE');
  });
});
