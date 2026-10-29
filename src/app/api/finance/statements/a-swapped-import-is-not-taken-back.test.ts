import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «إلغاء الاستيراد» AFTER A PARCEL SWAP.
 *
 * The undo is allowed until approval because nothing has been written from a statement before it: no wallet
 * movement, no order, no commission. A parcel swap is the one thing recorded on a line that DOES write an order and
 * draws stock before the approval — so a statement that carries one is no longer untouched, and the file cannot be
 * thrown away from under the sale it made.
 *
 * The statement's row is locked (FOR UPDATE, as a swap locks it) before the swap rows are read, so a swap and a delete that meet are put in a line: the second one reads what the first left.
 */
const { db, requireContext, requirePermission, logAudit, removeProofFile, calls } = vi.hoisted(() => ({
  db: { courierStatement: { findFirst: vi.fn(), deleteMany: vi.fn() }, $transaction: vi.fn() },
  calls: [] as string[],
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
  calls.length = 0;
  db.courierStatement.findFirst.mockImplementation(async () => { calls.push('read'); return row(); });
  db.courierStatement.deleteMany.mockImplementation(async () => { calls.push('delete'); return { count: 1 }; });
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
    calls.push('begin');
    return fn({ courierStatement: db.courierStatement, $queryRaw: vi.fn(async (...a: unknown[]) => { calls.push('lock:' + String((a[0] as string[]).join('?'))); return []; }) });
  });
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

  it('the statement row is locked BEFORE the swap rows are read and before anything is deleted', async () => {
    await del();
    // [outer read, begin, lock, read of the swap rows, delete]
    const lock = calls.findIndex((c) => c.startsWith('lock:'));
    const inside = calls.indexOf('read', calls.indexOf('begin'));
    expect(lock).toBeGreaterThan(calls.indexOf('begin'));
    expect(inside).toBeGreaterThan(lock);
    expect(calls.indexOf('delete')).toBeGreaterThan(inside);
    // the same lock a swap takes: FOR UPDATE on the statement row
    expect(calls[lock]).toContain('courier_statements');
    expect(calls[lock]).toContain('FOR UPDATE');
  });

  it('a swap that committed after the first read but before the lock is granted is seen, and nothing is deleted', async () => {
    db.courierStatement.findFirst
      .mockImplementationOnce(async () => { calls.push('read'); return row(); })
      .mockImplementationOnce(async () => { calls.push('read'); return { matches: [{ id: 'm1' }] }; });
    const res = await del();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('SWAP_ON_STATEMENT');
    expect(db.courierStatement.deleteMany).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
    expect(removeProofFile).not.toHaveBeenCalled();
  });

  it('a delete that finds nothing for another reason is still told as an approval', async () => {
    db.courierStatement.deleteMany.mockImplementation(async () => { calls.push('delete'); return { count: 0 }; });
    const res = await del();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ALREADY_APPROVED');
  });

  it('the delete keeps its own guard: unapproved, in THIS store', async () => {
    await del();
    expect(db.courierStatement.deleteMany.mock.calls[0][0].where).toMatchObject({
      id: 's1', companyId: 'co', storeId: 'st', approvedAt: null, status: { not: 'APPROVED' },
    });
  });

  it('a statement with no swap on it is taken back as ever', async () => {
    const res = await del();
    expect(res.status).toBe(200);
    expect(logAudit.mock.calls[0][0].action).toBe('STATEMENT_IMPORT_UNDONE');
  });
});
