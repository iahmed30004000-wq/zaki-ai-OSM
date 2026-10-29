import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A DECISION NEEDS A REASON AND AN ORDER THAT CAN TAKE IT.
 *
 * The door that records «اعتُمد رقم الشركة» / «رقمنا هو المعتمد» / «قيد المراجعة»:
 *
 *   · the explanation is five characters at least — four is refused and nothing is written;
 *   · the matrix of settlement-decisions is asked of the order AS IT IS NOW, and its sentence is the answer;
 *   · the statement's row is locked first, so an approval is either finished (and seen) or waits;
 *   · after the approval their figure can no longer be accepted (the approval is what carries it out);
 *   · it moves no money and settles nothing, and its answer carries the difference to the currency's own places.
 */

const { db, requireContext, requirePermission, logAudit, state } = vi.hoisted(() => {
  const state = {
    approvedAt: null as Date | null,
    order: { id: 'o1', shippingStatus: 'DELIVERED', settlementStatus: 'PENDING_COLLECTION' } as Record<string, unknown> | null,
    requests: [] as { orderId: string; intent: string }[],
    holders: [] as { orderId: string }[],
    order_: [] as string[],
  };
  const db = {
    settlementMatch: { findFirst: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    orderNote: { create: vi.fn() },
    courierStatement: { findFirst: vi.fn() },
    order: { findMany: vi.fn() },
    orderChangeRequest: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  return { db, state, requireContext: vi.fn(), requirePermission: vi.fn(), logAudit: vi.fn() };
});
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/api-error', () => ({ apiErrorResponse: (e: unknown) => new Response(String(e), { status: 500 }) }));

import { POST } from './route';

const callWith = (body: Record<string, unknown>) =>
  POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: 'st1', matchId: 'm1' }),
  });
const call = (resolution: string, note: string = 'اتفقنا مع الزبون') => callWith({ resolution, note });

const row = (over: Record<string, unknown> = {}) => ({
  id: 'm1', result: 'MISMATCHED', resolution: null, orderId: 'o1',
  expectedAmount: 20, statementAmount: 18, difference: -2,
  statement: { reference: 'ST-1' }, order: { orderNumber: 'ORD-1' }, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  state.approvedAt = null;
  state.order = { id: 'o1', shippingStatus: 'DELIVERED', settlementStatus: 'PENDING_COLLECTION' };
  state.requests = [];
  state.holders = [];
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 3 } });
  requirePermission.mockResolvedValue({ id: 'u1' });
  db.settlementMatch.findFirst.mockResolvedValue(row());
  db.settlementMatch.findMany.mockImplementation(async () => state.holders);
  db.settlementMatch.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'm1', ...data }));
  db.courierStatement.findFirst.mockImplementation(async () => ({ approvedAt: state.approvedAt }));
  db.order.findMany.mockImplementation(async () => (state.order ? [state.order] : []));
  db.orderChangeRequest.findMany.mockImplementation(async () => state.requests);
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
});

describe('the explanation is five characters at least', () => {
  it('four characters are refused, and nothing is recorded, noted or audited', async () => {
    const res = await call('ACCEPTED_COURIER', 'خصم');
    expect(res.status).toBe(400);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.settlementMatch.update).not.toHaveBeenCalled();
    expect(db.orderNote.create).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('spaces around it do not count; no explanation at all is refused too', async () => {
    expect((await call('OURS_STANDS', '    خصم    ')).status).toBe(400);
    expect((await call('OURS_STANDS', '')).status).toBe(400);
    expect((await callWith({ resolution: 'OURS_STANDS' })).status).toBe(400);
    expect((await callWith({ resolution: 'OURS_STANDS', note: null })).status).toBe(400);
    expect(db.settlementMatch.update).not.toHaveBeenCalled();
  });

  it('five characters that carry no reason are refused too: dots, stretch marks, zero-width and direction marks', async () => {
    for (const note of ['.....', '\u0640\u0640\u0640\u0640\u0640', '\u200B\u200B\u200B\u200B\u200B', '\u200E\u200E\u200E\u200E\u200E']) {
      expect((await call('ACCEPTED_COURIER', note)).status, JSON.stringify(note)).toBe(400);
    }
    expect(db.settlementMatch.update).not.toHaveBeenCalled();
    expect(db.orderNote.create).not.toHaveBeenCalled();
    // …and a short real reason passes.
    expect((await call('ACCEPTED_COURIER', 'خطأ بالرقم')).status).toBe(200);
  });

  it('exactly five, stored on the row with the person, and copied to the order’s internal notes', async () => {
    const res = await call('ACCEPTED_COURIER', ' اتفقن ');
    expect(res.status).toBe(200);
    expect(db.settlementMatch.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'm1' },
        data: expect.objectContaining({ resolution: 'ACCEPTED_COURIER', resolutionNote: 'اتفقن', resolvedById: 'u1' }),
      })
    );
    const note = db.orderNote.create.mock.calls[0][0].data;
    expect(note).toMatchObject({ orderId: 'o1', kind: 'internal' });
    expect(note.body).toContain('اتفقن');
    expect(note.body).toContain('اعتُمد رقم الشركة');
    expect(logAudit.mock.calls[0][0].newData).toMatchObject({ resolution: 'ACCEPTED_COURIER', explanation: 'اتفقن' });
  });
});

describe('the matrix is asked of the order as it is now', () => {
  it('an order already settled takes neither figure — the answer is the matrix’s own sentence, and nothing is written', async () => {
    state.order = { id: 'o1', shippingStatus: 'DELIVERED', settlementStatus: 'SETTLED' };
    for (const resolution of ['ACCEPTED_COURIER', 'OURS_STANDS']) {
      const res = await call(resolution);
      expect(res.status, resolution).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('DECISION_NOT_ALLOWED');
      expect(body.error).toContain('مُسوّى أصلاً');
    }
    expect(db.settlementMatch.update).not.toHaveBeenCalled();
    expect(db.orderNote.create).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('…but «قيد المراجعة» is always there, even for that order', async () => {
    state.order = { id: 'o1', shippingStatus: 'DELIVERED', settlementStatus: 'SETTLED' };
    expect((await call('UNDER_REVIEW', 'سُوّي بكشف آخر')).status).toBe(200);
    expect(db.settlementMatch.update.mock.calls[0][0].data.resolution).toBe('UNDER_REVIEW');
  });

  it('a parcel on the road: their figure yes, a claim no', async () => {
    state.order = { id: 'o1', shippingStatus: 'SHIPPED', settlementStatus: 'PENDING_COLLECTION' };
    expect((await call('OURS_STANDS')).status).toBe(409);
    expect((await call('ACCEPTED_COURIER')).status).toBe(200);
  });

  it('a cancel asked for and not answered stops both figures', async () => {
    state.requests = [{ orderId: 'o1', intent: 'CANCEL' }];
    const res = await call('ACCEPTED_COURIER');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('طلب إلغاء أو تأجيل مفتوح');
  });

  it('an order another row already holds stops both figures', async () => {
    state.holders = [{ orderId: 'o1' }];
    expect((await call('OURS_STANDS')).status).toBe(409);
  });

  it('a row with no order of ours cannot be answered at all', async () => {
    db.settlementMatch.findFirst.mockResolvedValue(row({ orderId: null, order: null }));
    state.order = null;
    expect((await call('UNDER_REVIEW', 'بلا طلب')).status).toBe(409);
  });

  it('«رقمنا» needs a shortfall: the company paid MORE than we expected is not a claim', async () => {
    db.settlementMatch.findFirst.mockResolvedValue(row({ expectedAmount: 20, statementAmount: 23, difference: 3 }));
    const res = await call('OURS_STANDS');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('لا نقص');
    expect((await call('ACCEPTED_COURIER')).status).toBe(200);
  });
});

describe('the statement’s row is locked first, and an approved statement no longer takes their figure', () => {
  it('locks before it reads the stamp or the order', async () => {
    await call('ACCEPTED_COURIER');
    const lock = db.$queryRaw.mock.invocationCallOrder[0];
    expect(lock).toBeLessThan(db.courierStatement.findFirst.mock.invocationCallOrder[0]);
    expect(lock).toBeLessThan(db.order.findMany.mock.invocationCallOrder[0]);
    expect(String(db.$queryRaw.mock.calls[0][0].join(''))).toContain('FOR UPDATE');
  });

  it('an approval that finished first: their figure is refused (it could never be carried out), nothing is written', async () => {
    state.approvedAt = new Date('2026-10-29T00:00:00Z');
    const res = await call('ACCEPTED_COURIER');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('كشف تسوية');
    expect(db.settlementMatch.update).not.toHaveBeenCalled();
  });

  it('…while the claim and the parking are records, and still stand after it', async () => {
    state.approvedAt = new Date('2026-10-29T00:00:00Z');
    expect((await call('OURS_STANDS')).status).toBe(200);
    expect((await call('UNDER_REVIEW', 'ننتظر الشركة')).status).toBe(200);
  });

  it('a statement of another store is not found', async () => {
    db.courierStatement.findFirst.mockResolvedValue(null);
    expect((await call('OURS_STANDS')).status).toBe(404);
    expect(db.settlementMatch.update).not.toHaveBeenCalled();
  });
});

describe('the answer carries the difference to the currency’s own places (RV306)', () => {
  it('a dinar: 2.125, not 2.13', async () => {
    db.settlementMatch.findFirst.mockResolvedValue(row({ expectedAmount: 20.125, statementAmount: 18, difference: -2.125 }));
    const body = await (await call('ACCEPTED_COURIER')).json();
    expect(body.gap).toBe(2.125);
    expect(db.orderNote.create.mock.calls[0][0].data.body).toContain('الفرق 2.125');
  });

  it('a currency of two places keeps two', async () => {
    requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 2 } });
    db.settlementMatch.findFirst.mockResolvedValue(row({ expectedAmount: 20.125, statementAmount: 18, difference: -2.125 }));
    expect((await (await call('ACCEPTED_COURIER')).json()).gap).toBe(2.13);
  });
});
