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
    settlementMatch: { findFirst: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
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
        updateMany: async () => ({ count: 1 }),
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

/**
 * THE ONE ANSWER A LINE NO ORDER CARRIES MAY HAVE (the lock).
 *
 * The approval waits for every line that is a question, and a line no order carries is one: it is tied to an order, or
 * it is not ours. Without «قيد المراجعة» the second ending did not exist, and a statement with one stray line (another
 * company’s, a misspelled reference) could never be approved. It is a record and nothing else — no figure to choose,
 * no order to write on, no money.
 */
describe('a line no order carries', () => {
  const spy = () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        settlementMatch: { updateMany, findMany: db.settlementMatch.findMany },
        orderNote: { create: db.orderNote.create },
        courierStatement: db.courierStatement,
        order: db.order,
        orderChangeRequest: db.orderChangeRequest,
        $queryRaw: db.$queryRaw,
      })
    );
    return updateMany;
  };

  it('may be parked with its reason: «قيد المراجعة» is written on the row, with the person — and nothing is written on any order', async () => {
    db.settlementMatch.findFirst.mockResolvedValue(row('MISSING_IN_SYSTEM'));
    const updateMany = spy();
    const res = await call('UNDER_REVIEW');
    expect(res.status).toBe(200);
    expect(updateMany).toHaveBeenCalledTimes(1);
    const w = updateMany.mock.calls[0] as unknown as [{ where: Record<string, unknown>; data: Record<string, unknown> }];
    expect(w[0].data).toMatchObject({ resolution: 'UNDER_REVIEW', resolutionNote: 'اتفقنا مع الزبون', resolvedById: 'u1' });
    // The write says what it was read as: still a line with no order, on a statement that is still open.
    expect(w[0].where).toMatchObject({ id: 'm1', result: 'MISSING_IN_SYSTEM', orderId: null, statement: { approvedAt: null } });
    expect(db.orderNote.create).not.toHaveBeenCalled();
    expect(db.order.findMany).not.toHaveBeenCalled();
    expect((await res.json()).message).toContain('ولا يعلّق الاعتماد');
  });

  it('takes no figure: «رقمنا» and «اعتُمد رقم الشركة» stay refused on it, parked or not', async () => {
    db.settlementMatch.findFirst.mockResolvedValue(row('MISSING_IN_SYSTEM'));
    const updateMany = spy();
    for (const saying of ['OURS_STANDS', 'ACCEPTED_COURIER']) {
      const res = await call(saying);
      expect(res.status, saying).toBe(409);
      expect((await res.json()).code, saying).toBe('NOT_A_DIFFERENCE');
    }
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('and a parcel no statement names (the other missing row) cannot be parked here — it is answered on the ORDER', async () => {
    db.settlementMatch.findFirst.mockResolvedValue(row('MISSING_IN_STATEMENT'));
    const updateMany = spy();
    const res = await call('UNDER_REVIEW');
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('NOT_A_DIFFERENCE');
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('on a closed statement even the parking is refused, with the one sentence', async () => {
    db.settlementMatch.findFirst.mockResolvedValue(row('MISSING_IN_SYSTEM'));
    db.courierStatement.findFirst.mockResolvedValue({ approvedAt: new Date('2026-10-28T00:00:00Z') });
    const updateMany = spy();
    const res = await call('UNDER_REVIEW');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'ALREADY_APPROVED', error: 'الكشف مغلق نهائياً — التصحيح بكشف تسوية' });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('the row changed between the read and the write (a link landed): the write finds nothing and the answer is refused', async () => {
    db.settlementMatch.findFirst.mockResolvedValue(row('MISSING_IN_SYSTEM'));
    const updateMany = spy();
    updateMany.mockResolvedValueOnce({ count: 0 });
    const res = await call('UNDER_REVIEW');
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CHANGED');
    expect(db.orderNote.create).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });
});
