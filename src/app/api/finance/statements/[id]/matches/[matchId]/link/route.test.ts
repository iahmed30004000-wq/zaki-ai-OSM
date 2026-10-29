import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «اربطه بطلب» — THE DOOR.
 *
 * The rules of WHICH order may be tied are in `lib/hand-link.test.ts`; this pins what the route adds: the one
 * permission of the screen, a scope that comes from the session and never from the request, a reading of customers
 * that is counted in the person's tally, the refusal's own status, and one audit row per link.
 */

const { db, requireContext, requirePermission, logAudit, noteCustomersHandedOut, findLinkCandidates, linkLineToOrder } = vi.hoisted(() => ({
  db: { $transaction: vi.fn() },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
  noteCustomersHandedOut: vi.fn(),
  findLinkCandidates: vi.fn(),
  linkLineToOrder: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: (...a: unknown[]) => noteCustomersHandedOut(...a) }));
vi.mock('@/lib/api-error', () => ({ apiErrorResponse: (e: unknown) => new Response(String(e), { status: 500 }) }));
vi.mock('@/lib/hand-link', async () => {
  const real = await vi.importActual<typeof import('@/lib/hand-link')>('@/lib/hand-link');
  return {
    ...real,
    findLinkCandidates: (...a: unknown[]) => findLinkCandidates(...a),
    linkLineToOrder: (...a: unknown[]) => linkLineToOrder(...a),
  };
});

import { GET, POST } from './route';
import { LinkRefused } from '@/lib/hand-link';

const ids = { params: Promise.resolve({ id: 'st1', matchId: 'm1' }) };
const get = (q = 'q=0790000001') => GET(new Request(`http://x/api/finance/statements/st1/matches/m1/link?${q}`), ids);
const post = (body: unknown) =>
  POST(new Request('http://x/api/finance/statements/st1/matches/m1/link', { method: 'POST', body: JSON.stringify(body) }), ids);

const found = {
  header: 'لهذا الرقم 2 طلبات: 1 مغلق، 1 مفتوحة',
  counts: { total: 2, closed: 1, open: 1 },
  hint: null,
  otherCourierWarning: 'w',
  candidates: [
    { id: 'o1', customer: { id: 'cu1', fullName: 'سارة', phone: '0790000001' } },
    { id: 'o2', customer: { id: 'cu1', fullName: 'سارة', phone: '0790000001' } },
  ],
};
const linked = { matchId: 'm1', orderId: 'o1', orderNumber: 'ORD-1', result: 'MATCHED', note: null, difference: 0, otherCourier: false, reference: 'ST-1' };

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 3 } });
  requirePermission.mockResolvedValue({ id: 'u1' });
  findLinkCandidates.mockResolvedValue(found);
  linkLineToOrder.mockResolvedValue(linked);
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({ tx: true }));
});

describe('the search', () => {
  it('asks for settlement.review, and reads in the session’s store — never one from the request', async () => {
    const res = await get('q=0790000001&storeId=other&companyId=other');
    expect(res.status).toBe(200);
    expect(requirePermission).toHaveBeenCalledWith('settlement.review');
    expect(findLinkCandidates).toHaveBeenCalledWith(db, {
      companyId: 'c1', storeId: 's1', statementId: 'st1', matchId: 'm1', query: '0790000001', minorUnit: 3,
    });
    expect(await res.json()).toMatchObject({ header: found.header, counts: found.counts });
  });

  it('counts the customers it handed out in the person’s tally', async () => {
    await get();
    expect(noteCustomersHandedOut).toHaveBeenCalledTimes(1);
    const arg = noteCustomersHandedOut.mock.calls[0][0];
    expect(arg).toMatchObject({ companyId: 'c1', storeId: 's1', user: { id: 'u1' } });
    expect(arg.rows).toHaveLength(2);
    expect(arg.rows[0].customer).toMatchObject({ id: 'cu1', phone: '0790000001' });
  });

  it('refused without the permission: nothing is read', async () => {
    requirePermission.mockRejectedValueOnce(new Error('403'));
    const res = await get();
    expect(res.status).toBe(500);
    expect(findLinkCandidates).not.toHaveBeenCalled();
    expect(noteCustomersHandedOut).not.toHaveBeenCalled();
  });

  it('a refusal from the rules keeps its own status and sentence', async () => {
    findLinkCandidates.mockRejectedValueOnce(new LinkRefused(409, { error: 'x', code: 'NOT_LINKABLE' }));
    const res = await get();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'x', code: 'NOT_LINKABLE' });
  });
});

describe('the link', () => {
  it('asks for settlement.review and writes inside one transaction, scoped by the session', async () => {
    const res = await post({ orderId: 'o1' });
    expect(res.status).toBe(200);
    expect(requirePermission).toHaveBeenCalledWith('settlement.review');
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(linkLineToOrder).toHaveBeenCalledWith(
      { tx: true },
      { companyId: 'c1', storeId: 's1', statementId: 'st1', matchId: 'm1', orderId: 'o1', userId: 'u1', minorUnit: 3, acceptOtherCourier: false }
    );
  });

  it('passes the other-courier acceptance only when the body says exactly true', async () => {
    await post({ orderId: 'o1', acceptOtherCourier: true });
    expect(linkLineToOrder.mock.calls[0][1].acceptOtherCourier).toBe(true);
    linkLineToOrder.mockClear();
    const res = await post({ orderId: 'o1', acceptOtherCourier: 'yes' });
    expect(res.status).toBe(400);
    expect(linkLineToOrder).not.toHaveBeenCalled();
  });

  it('refuses a body without an order', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post(null)).status).toBe(400);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('writes one audit row, naming the statement, the order and the verdict', async () => {
    await post({ orderId: 'o1' });
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'STATEMENT_LINE_LINKED_BY_HAND', entity: 'SettlementMatch', entityId: 'm1', userId: 'u1',
        newData: expect.objectContaining({ statement: 'ST-1', orderNumber: 'ORD-1', result: 'MATCHED' }),
      })
    );
  });

  it('a refused link writes no audit row and answers with the refusal', async () => {
    linkLineToOrder.mockRejectedValueOnce(new LinkRefused(409, { error: 'لا يُربط', code: 'ORDER_NOT_LINKABLE' }));
    const res = await post({ orderId: 'o1' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ORDER_NOT_LINKABLE');
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('says in the message whether the figures agreed or the line needs a look', async () => {
    expect((await (await post({ orderId: 'o1' })).json()).message).toContain('متطابقة');
    linkLineToOrder.mockResolvedValueOnce({ ...linked, result: 'MISMATCHED', note: 'عليه طلب إلغاء مفتوح' });
    expect((await (await post({ orderId: 'o1' })).json()).message).toContain('عليه طلب إلغاء مفتوح');
  });
});
