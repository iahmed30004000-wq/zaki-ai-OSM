import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — GET /api/ops/shipments/[id]/dispatch: «which orders are left to send»
 *
 * A batch of a hundred and sixty goes to the courier in pieces (components/ops/dispatchInChunks.ts), and the screen has to know which
 * orders to send first. This answers it:
 *
 *  1. The orders of THIS store's batch with no courier barcode (`pending`), and the ones that have one (`sent`), each as an id and an
 *     order number — no name, no phone, no address. It is the `ops.ship` door; the batch read that carries contact details is
 *     `ops.batches`, and a person who may send must not need it.
 *  2. In the order the send takes them (by order number), so the pieces are the same on every press.
 *  3. It refuses what the send refuses: a batch of another store, a batch no longer being filled (409, the same sentence), and a
 *     courier that is not the store's own. It writes nothing and calls nobody.
 *
 * Blockers: no money, no order creation, nothing sent to a courier.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, requirePermission } = vi.hoisted(() => ({
  db: { shippingBatch: { findFirst: vi.fn() }, order: { findMany: vi.fn() } },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/api-error', () => ({
  apiErrorResponse: (e: unknown) => Response.json({ error: `UNEXPECTED: ${(e as Error)?.message}` }, { status: 500 }),
}));

import { GET } from './route';

const ask = (id = 'b1') => GET(new Request(`http://localhost/api/ops/shipments/${id}/dispatch`), { params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1' });
  requirePermission.mockResolvedValue(undefined);
  db.shippingBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'READY', provider: { companyId: 'c1', storeId: 's1' } });
  db.order.findMany.mockResolvedValue([
    // extra columns a careless select would leak — the answer must not carry them
    { id: 'o1', orderNumber: 'ORD-1', trackingNumber: null, customer: { fullName: 'سعاد', phone: '0790000000' } },
    { id: 'o2', orderNumber: 'ORD-2', trackingNumber: 'K-2', customer: { fullName: 'نور', phone: '0791111111' } },
    { id: 'o3', orderNumber: 'ORD-3', trackingNumber: null },
  ]);
});

describe('the plan of a batch', () => {
  it('says which orders have no barcode and which have one — ids and numbers only', async () => {
    const res = await ask();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      pending: [{ id: 'o1', orderNumber: 'ORD-1' }, { id: 'o3', orderNumber: 'ORD-3' }],
      sent: [{ id: 'o2', orderNumber: 'ORD-2' }],
    });
    expect(JSON.stringify(body)).not.toMatch(/سعاد|0790000000|phone|trackingNumber/);
  });

  it('reads this store’s batch and its orders in the order the send takes them, and asks only for what it answers', async () => {
    await ask();
    expect(db.shippingBatch.findFirst.mock.calls[0][0].where).toEqual({ id: 'b1', companyId: 'c1', storeId: 's1' });
    const orders = db.order.findMany.mock.calls[0][0];
    expect(orders.where).toEqual({ shippingBatchId: 'b1', companyId: 'c1' });
    expect(orders.orderBy).toEqual({ orderNumber: 'asc' });
    expect(Object.keys(orders.select).sort()).toEqual(['id', 'orderNumber', 'trackingNumber']);
  });

  it('is the shipping key’s door: without it nothing is read', async () => {
    requirePermission.mockRejectedValue(new Error('FORBIDDEN'));
    const res = await ask();
    expect(res.status).toBe(500);
    expect(requirePermission).toHaveBeenCalledWith('ops.ship');
    expect(db.shippingBatch.findFirst).not.toHaveBeenCalled();
    expect(db.order.findMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a batch that is not this store’s is «غير موجودة», and none of its orders is read', async () => {
    db.shippingBatch.findFirst.mockResolvedValue(null);
    const res = await ask('other');
    expect(res.status).toBe(404);
    expect(db.order.findMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a batch no longer being filled answers the same 409 sentence the send does', async () => {
    db.shippingBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'SHIPPED', provider: { companyId: 'c1', storeId: 's1' } });
    const res = await ask();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('BATCH_NOT_READY');
    expect(body.errorAr).toContain('ما عادت قيد التجميع');
    expect(db.order.findMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a courier that is not this store’s own is refused, and nothing is read', async () => {
    db.shippingBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'READY', provider: { companyId: 'c1', storeId: 'other' } });
    const res = await ask();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain('COURIER_NOT_IN_STORE');
    expect(db.order.findMany).not.toHaveBeenCalled();
  });
});
