import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AN EMPTY OPEN BATCH CAN BE TAKEN AWAY — AND NOTHING ELSE CAN (the owner, 17/11: BATCH-2026-0020, 0 طلب).
 *
 * One statement, one condition: the row goes only if it is still READY and still holds no order. A batch with an order on it, a
 * handed-over one and a closed one are refused with their own sentence, a stranger's batch is «not found», and a person without the
 * shipping-status key is refused before anything is read. The audit row is written only for a delete that happened.
 */
const { db, requireContext, can, logAudit } = vi.hoisted(() => ({
  db: { shippingBatch: { deleteMany: vi.fn(), findFirst: vi.fn() } },
  requireContext: vi.fn(),
  can: vi.fn(),
  logAudit: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ can: (...a: unknown[]) => can(...a), authorize: vi.fn(() => ({ allowed: true })), requirePermission: vi.fn() }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: vi.fn() }));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: vi.fn() }));

import { DELETE } from './[id]/route';

const call = () => DELETE(new Request('http://x/api/shipping-batches/b20', { method: 'DELETE' }), { params: Promise.resolve({ id: 'b20' }) });

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1', name: 'احمد' }, companyId: 'c1', storeId: 's1' });
  can.mockReturnValue(true);
});

describe('DELETE /api/shipping-batches/[id]', () => {
  it('removes an open batch with no order — one statement, scoped to the company and the store, conditional on READY and «no order»', async () => {
    db.shippingBatch.deleteMany.mockResolvedValue({ count: 1 });
    const res = await call();
    expect(res.status).toBe(200);
    expect(db.shippingBatch.deleteMany).toHaveBeenCalledTimes(1);
    expect(db.shippingBatch.deleteMany).toHaveBeenCalledWith({ where: { id: 'b20', companyId: 'c1', storeId: 's1', status: 'READY', orders: { none: {} } } });
    expect(db.shippingBatch.findFirst).not.toHaveBeenCalled();
  });

  it('writes one audit row, for a delete that happened', async () => {
    db.shippingBatch.deleteMany.mockResolvedValue({ count: 1 });
    await call();
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit.mock.calls[0][0]).toMatchObject({ action: 'SHIPPING_BATCH_DELETED_EMPTY', entity: 'ShippingBatch', entityId: 'b20', userId: 'u1' });
  });

  it('refuses a batch that holds an order — 409 BATCH_NOT_EMPTY — and writes no audit row', async () => {
    db.shippingBatch.deleteMany.mockResolvedValue({ count: 0 });
    db.shippingBatch.findFirst.mockResolvedValue({ status: 'READY', _count: { orders: 3 } });
    const res = await call();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('BATCH_NOT_EMPTY');
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('refuses a batch that is not «قيد التجميع» — 409 BATCH_NOT_OPEN', async () => {
    db.shippingBatch.deleteMany.mockResolvedValue({ count: 0 });
    db.shippingBatch.findFirst.mockResolvedValue({ status: 'SHIPPED', _count: { orders: 0 } });
    const res = await call();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('BATCH_NOT_OPEN');
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('a batch of another company or store is «not found» — the same read, scoped the same way', async () => {
    db.shippingBatch.deleteMany.mockResolvedValue({ count: 0 });
    db.shippingBatch.findFirst.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(404);
    expect(db.shippingBatch.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'b20', companyId: 'c1', storeId: 's1' } }));
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('without the shipping-status key: 403, and nothing is read or deleted', async () => {
    can.mockReturnValue(false);
    const res = await call();
    expect(res.status).toBe(403);
    expect(can).toHaveBeenCalledWith(expect.anything(), 'orders.change_status');
    expect(db.shippingBatch.deleteMany).not.toHaveBeenCalled();
    expect(db.shippingBatch.findFirst).not.toHaveBeenCalled();
  });
});
