import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «رقمنا / رقمهم» IS AN ANSWER ABOUT TWO FIGURES, SO IT IS TAKEN ONLY ON «فرق في المبلغ».
 *
 * A parcel we delivered that no statement names has one figure (ours); a line with no order has the other.
 * The door used to accept the choice on both, wrote an order note saying «اعتُمد رقم الشركة» about a
 * company figure that does not exist, and counted the row in the per-person tally as a discount.
 */

const { db, requireContext, requirePermission, logAudit } = vi.hoisted(() => ({
  db: {
    settlementMatch: { findFirst: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    orderNote: { create: vi.fn() },
    // The door now locks the statement's row, reads its approval stamp and asks the matrix about the order's state.
    courierStatement: { findFirst: vi.fn() },
    order: { findMany: vi.fn() },
    orderChangeRequest: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/api-error', () => ({ apiErrorResponse: (e: unknown) => new Response(String(e), { status: 500 }) }));

import { POST } from './route';

// The answer carries its explanation now (five characters at least); the rows below are asked about the refusal, not the note.
const call = (resolution = 'OURS_STANDS') =>
  POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ resolution, note: 'اتفقنا مع الزبون' }) }), {
    params: Promise.resolve({ id: 'st1', matchId: 'm1' }),
  });

const row = (result: string) => ({
  id: 'm1', result, resolution: null, orderId: result === 'MISSING_IN_SYSTEM' ? null : 'o1',
  expectedAmount: 20, statementAmount: result === 'MISMATCHED' ? 18 : null, difference: result === 'MISMATCHED' ? -2 : null,
  statement: { reference: 'ST-1' }, order: result === 'MISSING_IN_SYSTEM' ? null : { orderNumber: 'ORD-1' },
});

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 2 } });
  db.courierStatement.findFirst.mockResolvedValue({ approvedAt: null });
  db.order.findMany.mockResolvedValue([{ id: 'o1', shippingStatus: 'DELIVERED', settlementStatus: 'PENDING_COLLECTION' }]);
  db.orderChangeRequest.findMany.mockResolvedValue([]);
  db.settlementMatch.findMany.mockResolvedValue([]);
  requirePermission.mockResolvedValue({ id: 'u1' });
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({
      settlementMatch: {
        update: async () => ({ id: 'm1', resolution: 'OURS_STANDS', resolutionNote: null, resolvedAt: new Date() }),
        findMany: db.settlementMatch.findMany,
      },
      orderNote: { create: db.orderNote.create },
      courierStatement: db.courierStatement,
      order: db.order,
      orderChangeRequest: db.orderChangeRequest,
      $queryRaw: db.$queryRaw,
    })
  );
});

describe('the resolve door', () => {
  it.each(['MISSING_IN_STATEMENT', 'MISSING_IN_SYSTEM', 'MATCHED'])('refuses a %s row and records nothing', async (result) => {
    db.settlementMatch.findFirst.mockResolvedValue(row(result));
    const res = await call();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('NOT_A_DIFFERENCE');
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.orderNote.create).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('says WHY for a missing row — one figure only — and not that it matched', async () => {
    db.settlementMatch.findFirst.mockResolvedValue(row('MISSING_IN_STATEMENT'));
    const body = await (await call()).json();
    expect(body.error).toContain('فرق في المبلغ');
    expect(body.error).not.toContain('مطابق');
  });

  it('still takes the answer on a real difference in money (the ordinary case is untouched)', async () => {
    db.settlementMatch.findFirst.mockResolvedValue(row('MISMATCHED'));
    const res = await call('ACCEPTED_COURIER');
    expect(res.status).toBe(200);
    expect(db.orderNote.create).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'SETTLEMENT_DIFFERENCE_RESOLVED' }));
  });
});
