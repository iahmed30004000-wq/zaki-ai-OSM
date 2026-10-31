import { beforeEach, describe, expect, it, vi } from 'vitest';
import { unsentMessage } from '@/lib/batch-steps';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE
 *
 * 31/10: BATCH-2026-0004 (الباشا, connected by API) was closed with «إغلاق الشحنة — سُلّمت للشركة» BEFORE «رحّل إلى الشركة
 * واجلب الباركود». After that press the dispatch refuses the batch for good, so 147 orders had no courier barcode and no
 * waybill could be printed. The owner: «بدنا مانوقع بهذا الخطأ».
 *
 *  1. A batch whose courier is connected by API, with a parcel that has no courier barcode, is NOT handed over by a plain press:
 *     409 BATCH_UNSENT, the count and the first order numbers in the sentence, and nothing is stamped, logged or announced.
 *  2. The person who means it sends `acknowledgeUnsent: true` and the handover goes through; the audit row says how many
 *     went without a barcode.
 *  3. Nobody is asked who is not at risk: every parcel already has its barcode, the courier is worked by hand, or the batch has
 *     no courier.
 *  4. Only the handover is asked — ending a batch is not.
 *
 * Blockers: no money arithmetic, no order creation, the dispatch door and its READY-only rule untouched.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, can, logAudit, emitAppEvent, isAutomated } = vi.hoisted(() => ({
  db: {
    shippingBatch: { findFirst: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
    order: { updateMany: vi.fn(), findMany: vi.fn() },
    orderStatusLog: { createMany: vi.fn() },
    orderChangeRequest: { findMany: vi.fn() },
    deliveryProvider: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  can: vi.fn(),
  logAudit: vi.fn(),
  emitAppEvent: vi.fn(async (..._a: unknown[]) => 1),
  isAutomated: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ can: (...a: unknown[]) => can(...a), requirePermission: vi.fn() }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: vi.fn() }));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: (...a: unknown[]) => emitAppEvent(...a) }));
vi.mock('@/lib/couriers', async (orig) => ({
  ...(await orig<typeof import('@/lib/couriers')>()),
  isAutomated: (...a: unknown[]) => isAutomated(...a),
}));

import { PATCH } from './[id]/route';

const member = (n: number, trackingNumber: string | null) => ({
  id: `o${n}`, orderNumber: `ORD-2026-0${n}`, totalAmount: 20, currency: 'USD', trackingNumber,
});
const BATCH = (over: Record<string, unknown> = {}) => ({
  id: 'b1', companyId: 'c1', storeId: 's1', status: 'READY', shippedAt: null, batchNumber: 'BATCH-2026-0004', deliveryProviderId: 'p1', ...over,
});

let members: ReturnType<typeof member>[];
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
  members = [member(497, null), member(521, 'BSH-521'), member(551, null)];
  requireContext.mockResolvedValue({ user: { id: 'u1', name: 'Qabas', role: 'WAREHOUSE' }, companyId: 'c1', storeId: 's1' });
  can.mockReturnValue(true);
  isAutomated.mockReturnValue(true);
  db.shippingBatch.findFirst.mockResolvedValue(BATCH());
  db.shippingBatch.updateMany.mockResolvedValue({ count: 1 });
  db.shippingBatch.findUniqueOrThrow.mockResolvedValue(BATCH({ status: 'SHIPPED' }));
  db.deliveryProvider.findFirst.mockResolvedValue({ name: 'الباشا', code: 'BASHA', adapterCode: 'LOGESTECHS', apiEnabled: true });
  db.order.findMany.mockImplementation(async () => members);
  db.order.updateMany.mockImplementation(async () => ({ count: members.length }));
  db.orderStatusLog.createMany.mockResolvedValue({ count: 3 });
  db.orderChangeRequest.findMany.mockResolvedValue([]);
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
});

describe('a connected courier and parcels never sent to it', () => {
  it('a plain press is stopped: 409, the count, the first order numbers — and nothing is stamped, logged or announced', async () => {
    const res = await patch({ status: 'SHIPPED' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BATCH_UNSENT');
    expect(res.body.unsent).toBe(2);
    expect(res.body.orders).toEqual(['ORD-2026-0497', 'ORD-2026-0551']);
    expect(String(res.body.errorAr)).toContain('2 طلب');
    expect(String(res.body.errorAr)).toContain('ORD-2026-0497');
    expect(String(res.body.errorAr)).toContain('رحّل إلى الشركة واجلب الباركود');
    expect(db.order.updateMany, 'انختمت طرود بلا باركود').not.toHaveBeenCalled();
    expect(db.orderStatusLog.createMany).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
    expect(emitAppEvent).not.toHaveBeenCalled();
  });

  it('the courier is read inside the session company, with the select that tells connected from manual', async () => {
    await patch({ status: 'SHIPPED' });
    const call = db.deliveryProvider.findFirst.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'p1', companyId: 'c1' });
    expect(Object.keys(call.select)).toEqual(expect.arrayContaining(['apiEnabled', 'adapterCode', 'code']));
  });

  it('«سلّم رغم ذلك» (acknowledgeUnsent: true) hands it over, and the audit row says how many went without a barcode', async () => {
    const res = await patch({ status: 'SHIPPED', acknowledgeUnsent: true });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
    expect(logAudit.mock.calls[0][0].newData).toMatchObject({ status: 'SHIPPED', handedOverUnsent: 2 });
  });

  it('only a real `true` counts: the word «true», a 1, or nothing is not the answer', async () => {
    for (const acknowledgeUnsent of ['true', 1, null, undefined]) {
      vi.clearAllMocks();
      db.order.findMany.mockImplementation(async () => members);
      db.shippingBatch.findFirst.mockResolvedValue(BATCH());
      db.shippingBatch.updateMany.mockResolvedValue({ count: 1 });
      db.deliveryProvider.findFirst.mockResolvedValue({ apiEnabled: true });
      db.orderChangeRequest.findMany.mockResolvedValue([]);
      db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
      isAutomated.mockReturnValue(true);
      requireContext.mockResolvedValue({ user: { id: 'u1', name: 'Q', role: 'W' }, companyId: 'c1', storeId: 's1' });
      can.mockReturnValue(true);
      const res = await patch({ status: 'SHIPPED', acknowledgeUnsent });
      expect(res.status, String(acknowledgeUnsent)).toBe(409);
      expect(db.order.updateMany).not.toHaveBeenCalled();
    }
  });
});

describe('nobody is asked who is not at risk', () => {
  it('every parcel already has its barcode: the press goes through with no question and no mark in the audit row', async () => {
    members = [member(1, 'B-1'), member(2, 'B-2')];
    const res = await patch({ status: 'SHIPPED' });
    expect(res.status).toBe(200);
    expect(logAudit.mock.calls[0][0].newData).not.toHaveProperty('handedOverUnsent');
  });

  it('a courier worked by hand has no barcode to wait for: not asked', async () => {
    isAutomated.mockReturnValue(false);
    const res = await patch({ status: 'SHIPPED' });
    expect(res.status).toBe(200);
    expect(logAudit.mock.calls[0][0].newData).not.toHaveProperty('handedOverUnsent');
  });

  it('a batch with no courier at all: not asked, and the courier table is not even read', async () => {
    db.shippingBatch.findFirst.mockResolvedValue(BATCH({ deliveryProviderId: null }));
    const res = await patch({ status: 'SHIPPED' });
    expect(res.status).toBe(200);
    expect(db.deliveryProvider.findFirst).not.toHaveBeenCalled();
  });

  it('ending a batch (SHIPPED → CLOSED) is not a handover and is not asked', async () => {
    db.shippingBatch.findFirst.mockResolvedValue(BATCH({ status: 'SHIPPED', shippedAt: new Date() }));
    db.shippingBatch.findUniqueOrThrow.mockResolvedValue(BATCH({ status: 'CLOSED' }));
    const res = await patch({ status: 'CLOSED' });
    expect(res.status).toBe(200);
    expect(db.deliveryProvider.findFirst).not.toHaveBeenCalled();
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });
});

describe('the sentence', () => {
  it('names five orders and marks the rest', () => {
    const text = unsentMessage(Array.from({ length: 9 }, (_, i) => `ORD-${i}`));
    expect(text).toContain('9 طلب');
    expect(text).toContain('ORD-4');
    expect(text).not.toContain('ORD-5');
    expect(text).toContain('…');
  });
});
