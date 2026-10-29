import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkStep, pendingChangesMessage } from '@/lib/batch-steps';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A TROLLEY GOES ONE WAY, IN ONE TRANSACTION, AND THE PRESS NAMES WHAT IT
 * WOULD LEAVE BEHIND.
 *
 * The batch PATCH took any status from any status, in two statements: the
 * batch row, then its orders. A press on a closed batch reopened it, a
 * READY → CLOSED skipped the handover, two presses at once stamped twice,
 * and a parcel with a cancel waiting for an answer was handed over anyway.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, can, logAudit } = vi.hoisted(() => ({
  db: {
    shippingBatch: { findFirst: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
    order: { updateMany: vi.fn() },
    orderChangeRequest: { findMany: vi.fn() },
    deliveryProvider: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  can: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ can: (...a: unknown[]) => can(...a), requirePermission: vi.fn() }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: vi.fn() }));

import { PATCH } from './[id]/route';

const BATCH = (over: Record<string, unknown> = {}) => ({
  id: 'b1', companyId: 'c1', storeId: 's1', status: 'READY', shippedAt: null, batchNumber: 'BATCH-1', ...over,
});

const patch = async (body: Record<string, unknown>) => {
  const res = await PATCH(
    new Request('http://localhost/api/shipping-batches/b1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'b1' }) }
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1', name: 'م' }, companyId: 'c1', storeId: 's1' });
  can.mockReturnValue(true);
  db.shippingBatch.findFirst.mockResolvedValue(BATCH());
  db.shippingBatch.updateMany.mockResolvedValue({ count: 1 });
  db.shippingBatch.findUniqueOrThrow.mockResolvedValue(BATCH({ status: 'SHIPPED' }));
  db.order.updateMany.mockResolvedValue({ count: 3 });
  db.orderChangeRequest.findMany.mockResolvedValue([]);
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
});

describe('the steps', () => {
  it('allow READY → SHIPPED → CLOSED and nothing else', () => {
    expect(checkStep('READY', 'SHIPPED').ok).toBe(true);
    expect(checkStep('SHIPPED', 'CLOSED').ok).toBe(true);
    for (const [from, to] of [
      ['SHIPPED', 'READY'], ['CLOSED', 'READY'], ['CLOSED', 'SHIPPED'], ['READY', 'CLOSED'],
    ] as const) {
      const v = checkStep(from, to);
      expect(v.ok, `${from} → ${to}`).toBe(false);
      if (!v.ok) expect(v.code).toBe('BATCH_FORWARD_ONLY');
    }
  });

  it('and the same status is a second press, told apart from a backward step', () => {
    const v = checkStep('SHIPPED', 'SHIPPED');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('BATCH_STEP_DONE');
  });

  it('names at most eight parcels and counts the rest', () => {
    const msg = pendingChangesMessage(Array.from({ length: 11 }, (_, i) => `SY-${i}`));
    expect(msg).toContain('SY-0');
    expect(msg).toContain('SY-7');
    expect(msg).not.toContain('SY-8');
    expect(msg).toContain('3 غيرها');
  });
});

describe('the press: READY → SHIPPED', () => {
  it('stamps the batch and its orders in ONE transaction, the batch as a condition', async () => {
    const res = await patch({ status: 'SHIPPED' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.shippingBatch.updateMany.mock.calls[0][0].where).toMatchObject({ id: 'b1', status: 'READY' });
    expect(db.shippingBatch.updateMany.mock.calls[0][0].data.status).toBe('SHIPPED');
    expect(db.order.updateMany.mock.calls[0][0]).toMatchObject({
      where: { shippingBatchId: 'b1', shippingStatus: 'READY_FOR_PICKUP' },
      data: { shippingStatus: 'SHIPPED' },
    });
  });

  it('refuses when a parcel in it has a cancel waiting — by name — and stamps nothing', async () => {
    db.orderChangeRequest.findMany.mockResolvedValue([
      { order: { orderNumber: 'SY-7' } },
      { order: { orderNumber: 'SY-7' } },
      { order: { orderNumber: 'SY-9' } },
    ]);

    const res = await patch({ status: 'SHIPPED' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PENDING_CHANGES');
    expect(res.body.orders).toEqual(['SY-7', 'SY-9']);
    expect(String(res.body.error)).toContain('SY-7');
    expect(db.order.updateMany, 'انختمت طرود مع قرار معلّق').not.toHaveBeenCalled();
  });

  it('looks for a pending OR approved-but-unapplied cancel or postponement on THIS batch only', async () => {
    await patch({ status: 'SHIPPED' });

    expect(db.orderChangeRequest.findMany.mock.calls[0][0].where).toMatchObject({
      companyId: 'c1',
      intent: { in: ['CANCEL', 'POSTPONE'] },
      OR: [{ status: 'PENDING' }, { status: 'APPROVED', appliedAt: null }],
      order: { shippingBatchId: 'b1' },
    });
  });

  it('a second press at the same moment loses: the condition finds nothing, nothing is stamped', async () => {
    db.shippingBatch.updateMany.mockResolvedValue({ count: 0 });

    const res = await patch({ status: 'SHIPPED' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BATCH_MOVED');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('a press on a batch that is already handed over is refused before any write', async () => {
    db.shippingBatch.findFirst.mockResolvedValue(BATCH({ status: 'SHIPPED' }));

    const res = await patch({ status: 'SHIPPED' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BATCH_STEP_DONE');
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe('the other steps', () => {
  it('will not reopen a closed batch', async () => {
    db.shippingBatch.findFirst.mockResolvedValue(BATCH({ status: 'CLOSED' }));

    const res = await patch({ status: 'READY' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BATCH_FORWARD_ONLY');
    expect(db.shippingBatch.updateMany).not.toHaveBeenCalled();
  });

  it('will not close a batch that was never handed over', async () => {
    const res = await patch({ status: 'CLOSED' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BATCH_FORWARD_ONLY');
    expect(db.shippingBatch.updateMany).not.toHaveBeenCalled();
  });

  it('closes a handed-over batch, and does not re-stamp its orders', async () => {
    db.shippingBatch.findFirst.mockResolvedValue(BATCH({ status: 'SHIPPED', shippedAt: new Date() }));
    db.shippingBatch.findUniqueOrThrow.mockResolvedValue(BATCH({ status: 'CLOSED' }));

    const res = await patch({ status: 'CLOSED' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(db.shippingBatch.updateMany.mock.calls[0][0].where).toMatchObject({ status: 'SHIPPED' });
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.orderChangeRequest.findMany, 'سُئل عن القرارات المعلّقة عند الإغلاق').not.toHaveBeenCalled();
  });

  it('refuses a status word it does not know instead of ignoring it', async () => {
    const res = await patch({ status: 'FLYING' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BATCH_STATUS_UNKNOWN');
  });

  it('a note on a batch stays an ordinary save', async () => {
    db.shippingBatch.findUniqueOrThrow.mockResolvedValue(BATCH());

    const res = await patch({ notes: 'يستلمها أبو علي' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(db.shippingBatch.updateMany.mock.calls[0][0].data).toEqual({ notes: 'يستلمها أبو علي' });
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('and the same status together with a note is a save, not a second press', async () => {
    db.shippingBatch.findFirst.mockResolvedValue(BATCH({ status: 'SHIPPED' }));
    db.shippingBatch.findUniqueOrThrow.mockResolvedValue(BATCH({ status: 'SHIPPED' }));

    const res = await patch({ status: 'SHIPPED', notes: 'ملاحظة' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(db.shippingBatch.updateMany.mock.calls[0][0].data).not.toHaveProperty('status');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });
});
