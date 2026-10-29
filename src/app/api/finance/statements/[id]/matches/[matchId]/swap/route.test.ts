import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «كان من طرد طلب آخر» AT ITS DOOR — who may knock, what the client may and may not say, what is refused in
 * words, what is audited, and what is announced and when.
 *
 * The work itself is tested against a world that applies filters in `src/lib/parcel-swap.test.ts`; here the lib is
 * replaced and the route is asked only what a route owns.
 */

const { db, requireContext, requirePermission, logAudit, recordParcelSwap, findSwapCandidates, announceSwap, noteCustomersHandedOut } =
  vi.hoisted(() => ({
    db: { $transaction: vi.fn(async (fn: (tx: unknown) => unknown, _options?: unknown) => fn({ tx: true })) },
    requireContext: vi.fn(),
    requirePermission: vi.fn(),
    logAudit: vi.fn(),
    recordParcelSwap: vi.fn(),
    findSwapCandidates: vi.fn(),
    announceSwap: vi.fn(),
    noteCustomersHandedOut: vi.fn(),
  }));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a), can: () => true }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: (...a: unknown[]) => noteCustomersHandedOut(...a) }));
vi.mock('@/lib/parcel-swap-events', () => ({ announceSwap: (...a: unknown[]) => announceSwap(...a) }));
vi.mock('@/lib/parcel-swap', async (orig) => ({
  ...(await orig<typeof import('@/lib/parcel-swap')>()),
  recordParcelSwap: (...a: unknown[]) => recordParcelSwap(...a),
  findSwapCandidates: (...a: unknown[]) => findSwapCandidates(...a),
}));

import { GET, POST } from './route';
import { SwapRefused } from '@/lib/parcel-swap';

const params = { params: Promise.resolve({ id: 'st1', matchId: 'mY' }) };
const send = (body: unknown) =>
  new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const result = (over: Record<string, unknown> = {}) => ({
  reference: 'ST-1',
  line: { matchId: 'mY', result: 'MATCHED', expected: 37.5, stated: 37.5 },
  sale: { id: 'sale1', orderNumber: 'JO-2026-0100', total: 40, fee: 2.5, currency: 'JOD', reshaped: false },
  owner: { id: 'x', orderNumber: 'JO-2026-0001', boxBack: true },
  box: { id: 'y', orderNumber: 'JO-2026-0002', endedAs: 'RETURNED', pieces: 2, total: 2 },
  boxRow: { totalAmount: 35, currency: 'JOD', trackingNumber: null, shippingStatus: 'SHIPPED' },
  stock: { released: 2, consumed: 2 },
  counters: { customerDelivered: 1, customerRefusalTakenBack: false, boxCustomerCancelled: true },
  commission: { created: 2, amount: 2.625 },
  closedRequests: 1,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'المحاسبة', role: 'ACCOUNTANT' },
    companyId: 'c1', storeId: 's1',
    country: { minorUnit: 3, orderPrefix: 'JO', allowNegativeStock: false },
  });
  requirePermission.mockResolvedValue({});
});

describe('POST — record the swap', () => {
  it('asks for the permission of the screen it is pressed on, before it reads the body', async () => {
    requirePermission.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    const res = await POST(send({ ownerOrderId: 'x', pieces: 2, ownerBoxBack: true }), params);
    expect(requirePermission).toHaveBeenCalledWith('settlement.review');
    expect(res.status).not.toBe(200);
    expect(recordParcelSwap).not.toHaveBeenCalled();
  });

  it('takes three things from the client, and the store, the currency and the unit from the session', async () => {
    recordParcelSwap.mockResolvedValue(result());
    const res = await POST(
      send({ ownerOrderId: 'x', pieces: 2, ownerBoxBack: true, storeId: 'other', currency: 'USD', paid: 1, minorUnit: 0 }),
      params
    );
    expect(res.status).toBe(200);
    expect(recordParcelSwap.mock.calls[0][1]).toEqual({
      companyId: 'c1', storeId: 's1', statementId: 'st1', matchId: 'mY',
      ownerOrderId: 'x', pieces: 2, ownerBoxBack: true,
      user: { id: 'u1', name: 'المحاسبة', role: 'ACCOUNTANT' },
      minorUnit: 3, orderPrefix: 'JO', attempt: 0, allowNegativeStock: false,
    });
  });

  it.each([
    [{ pieces: 2, ownerBoxBack: true }],
    [{ ownerOrderId: 'x', pieces: 0, ownerBoxBack: true }],
    [{ ownerOrderId: 'x', pieces: 1.5, ownerBoxBack: true }],
    [{ ownerOrderId: 'x', pieces: 2 }],
    [{ ownerOrderId: 'x', pieces: 2, ownerBoxBack: 'yes' }],
  ])('refuses a body that is not three plain answers: %j', async (body) => {
    const res = await POST(send(body), params);
    expect(res.status).toBe(400);
    expect(recordParcelSwap).not.toHaveBeenCalled();
  });

  it('a refusal reaches the person as the door worded it, with its status — and is neither audited nor announced', async () => {
    recordParcelSwap.mockRejectedValue(new SwapRefused(409, { error: 'الكشف معتمد — التصحيح بعد الاعتماد يكون بكشف تسوية', code: 'ALREADY_APPROVED' }));
    const res = await POST(send({ ownerOrderId: 'x', pieces: 2, ownerBoxBack: true }), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'الكشف معتمد — التصحيح بعد الاعتماد يكون بكشف تسوية', code: 'ALREADY_APPROVED' });
    expect(logAudit).not.toHaveBeenCalled();
    expect(announceSwap).not.toHaveBeenCalled();
  });

  it('an order-number clash retries the whole transaction from outside, with the next number', async () => {
    recordParcelSwap
      .mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }))
      .mockResolvedValueOnce(result());
    const res = await POST(send({ ownerOrderId: 'x', pieces: 2, ownerBoxBack: true }), params);
    expect(res.status).toBe(200);
    expect(recordParcelSwap.mock.calls.map((c) => (c[1] as { attempt: number }).attempt)).toEqual([0, 1]);
  });

  it('five clashes in a row end in words, not in a crash', async () => {
    recordParcelSwap.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    const res = await POST(send({ ownerOrderId: 'x', pieces: 2, ownerBoxBack: true }), params);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('NUMBER_CLASH');
  });

  it('audits what happened, and announces the sale as delivered and the box as returned — after the commit', async () => {
    recordParcelSwap.mockResolvedValue(result());
    await POST(send({ ownerOrderId: 'x', pieces: 2, ownerBoxBack: true }), params);
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit.mock.calls[0][0]).toMatchObject({
      action: 'PARCEL_SWAPPED', entity: 'SettlementMatch', entityId: 'mY', userId: 'u1',
      newData: { statement: 'ST-1', sale: 'JO-2026-0100', owner: 'JO-2026-0001', box: 'JO-2026-0002', pieces: 2 },
    });
    expect(announceSwap).toHaveBeenCalledTimes(1);
    expect(announceSwap.mock.calls[0][0]).toEqual({
      companyId: 'c1',
      sale: { id: 'sale1', orderNumber: 'JO-2026-0100', total: 40, currency: 'JOD', replacesOrderNumber: 'JO-2026-0001' },
      box: { id: 'y', orderNumber: 'JO-2026-0002', totalAmount: 35, currency: 'JOD', trackingNumber: null, previousStatus: 'SHIPPED', endedAs: 'RETURNED' },
    });
    // the transaction had a long timeout: a swap writes a dozen tables
    expect(db.$transaction.mock.calls[0][1]).toEqual({ timeout: 30_000 });
  });

  it('says in one sentence what was done', async () => {
    recordParcelSwap.mockResolvedValue(result());
    const body = await (await POST(send({ ownerOrderId: 'x', pieces: 2, ownerBoxBack: true }), params)).json();
    expect(body.message).toContain('JO-2026-0100');
    expect(body.message).not.toMatch(/[A-Za-z]{4,}/);
    expect(body.swap.sale.total).toBe(40);
  });
});

describe('GET — who might have taken the box', () => {
  it('searches within the session\'s store and counts the names it hands out', async () => {
    findSwapCandidates.mockResolvedValue({
      box: { orderNumber: 'JO-2026-0002', pieces: 2, products: [], blockedBy: [] },
      candidates: [{ id: 'x', orderNumber: 'JO-2026-0001', customer: { id: 'cuA', fullName: 'سارة', phone: '790000001' }, shippingStatus: 'SHIPPED', expected: 17.5, blockedBy: [] }],
      hint: null,
    });
    const res = await GET(new Request('http://localhost/x?q=79000'), params);
    expect(res.status).toBe(200);
    expect(requirePermission).toHaveBeenCalledWith('settlement.review');
    expect(findSwapCandidates.mock.calls[0][1]).toEqual({
      companyId: 'c1', storeId: 's1', statementId: 'st1', matchId: 'mY', query: '79000', minorUnit: 3,
    });
    expect(noteCustomersHandedOut).toHaveBeenCalledTimes(1);
    expect(noteCustomersHandedOut.mock.calls[0][0]).toMatchObject({
      companyId: 'c1', storeId: 's1', rows: [{ customer: { id: 'cuA' } }],
    });
  });

  it('a search by someone who may not review is refused before anything is read', async () => {
    requirePermission.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    const res = await GET(new Request('http://localhost/x?q=79000'), params);
    expect(res.status).not.toBe(200);
    expect(findSwapCandidates).not.toHaveBeenCalled();
  });

  it('a refusal about the line comes back in words', async () => {
    findSwapCandidates.mockRejectedValue(new SwapRefused(409, { error: 'x', code: 'NOT_SWAPPABLE' }));
    const res = await GET(new Request('http://localhost/x?q=79000'), params);
    expect(res.status).toBe(409);
  });
});
