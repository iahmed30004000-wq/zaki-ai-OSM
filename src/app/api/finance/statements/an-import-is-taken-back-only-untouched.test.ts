import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DELETE /api/finance/statements/:id — the door behind «إلغاء الاستيراد».
 * The statement goes at any step until approval, receipts and proofs with it; the act stays in the audit
 * log with what went; approval, another store and a missing permission each stop it.
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

const receipt = (proofKey: string | null) => ({
  amount: 100, currencyCode: 'USD', proofKey, proofName: proofKey ? 'slip.png' : null, wallet: { name: 'كاش دولار' },
});
const row = (over: Record<string, unknown> = {}, receipts: ReturnType<typeof receipt>[] = []) => ({
  id: 's1', reference: 'ST-2026-09', fileName: 'x.xlsx', status: 'IMPORTED', approvedAt: null,
  totalAmount: 2869.04, currencyCode: 'USD', deliveryProviderId: 'p1',
  _count: { lines: 292, receipts: receipts.length, matches: 0 }, receipts, ...over,
});
const del = () => DELETE(new Request('http://x', { method: 'DELETE' }), { params: Promise.resolve({ id: 's1' }) });

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'co', storeId: 'st' });
  requirePermission.mockResolvedValue(undefined);
  db.courierStatement.findFirst.mockResolvedValue(row());
  db.courierStatement.deleteMany.mockResolvedValue({ count: 1 });
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({ courierStatement: db.courierStatement, $queryRaw: vi.fn(async () => []) }));
});

describe('taking an import back', () => {
  it('deletes an untouched statement and records who undid which file', async () => {
    const res = await del();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, reference: 'ST-2026-09', lines: 292, receipts: 0 });
    expect(logAudit.mock.calls[0][0]).toMatchObject({
      action: 'STATEMENT_IMPORT_UNDONE', entity: 'CourierStatement', entityId: 's1', userId: 'u1',
      previousData: { reference: 'ST-2026-09', lines: 292, total: 2869.04 },
    });
  });

  it('still deletes after a receipt and a match — and the audit row remembers each receipt', async () => {
    db.courierStatement.findFirst.mockResolvedValue(
      row({ status: 'MATCHED', _count: { lines: 292, receipts: 1, matches: 292 } }, [receipt('companies/co/settlement/s1/receipts/r1.png')])
    );
    const res = await del();
    expect(res.status).toBe(200);
    expect(logAudit.mock.calls[0][0].previousData).toMatchObject({
      status: 'MATCHED', matches: 292,
      receipts: [{ amount: 100, currencyCode: 'USD', wallet: 'كاش دولار', proof: 'slip.png' }],
    });
  });

  it('removes the proof files of the receipts that went with it — and only those that have one', async () => {
    db.courierStatement.findFirst.mockResolvedValue(row({}, [receipt('k1.png'), receipt(null), receipt('k2.pdf')]));
    await del();
    expect(removeProofFile.mock.calls.map((c) => c[0])).toEqual(['k1.png', 'k2.pdf']);
  });

  it('the delete itself repeats the guard: unapproved, in THIS store', async () => {
    await del();
    expect(db.courierStatement.deleteMany.mock.calls[0][0].where).toMatchObject({
      id: 's1', companyId: 'co', storeId: 'st', approvedAt: null, status: { not: 'APPROVED' },
    });
  });

  it('NEGATIVE: an approved statement refuses with 409, deletes nothing, removes no file, audits nothing', async () => {
    for (const approved of [row({ approvedAt: new Date(), status: 'APPROVED' }), row({ status: 'APPROVED' })]) {
      db.courierStatement.findFirst.mockResolvedValue(approved);
      const res = await del();
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('ALREADY_APPROVED');
    }
    expect(db.courierStatement.deleteMany).not.toHaveBeenCalled();
    expect(removeProofFile).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('NEGATIVE: an approval that lands between the check and the delete still stops it (no file removed, nothing audited)', async () => {
    db.courierStatement.findFirst.mockResolvedValue(row({}, [receipt('k1.png')]));
    db.courierStatement.deleteMany.mockResolvedValue({ count: 0 });
    const res = await del();
    expect(res.status).toBe(409);
    expect(removeProofFile).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('NEGATIVE: another store’s statement is not found', async () => {
    db.courierStatement.findFirst.mockResolvedValue(null);
    expect((await del()).status).toBe(404);
    expect(db.courierStatement.findFirst.mock.calls[0][0].where).toMatchObject({ companyId: 'co', storeId: 'st' });
  });

  it('NEGATIVE: needs the permission to import', async () => {
    requirePermission.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    expect((await del()).status).toBe(403);
    expect(requirePermission).toHaveBeenCalledWith('settlement.upload');
    expect(db.courierStatement.deleteMany).not.toHaveBeenCalled();
  });
});
