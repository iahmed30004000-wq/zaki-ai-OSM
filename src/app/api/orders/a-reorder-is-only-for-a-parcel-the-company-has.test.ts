import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db, requireContext, createReplacement } = vi.hoisted(() => ({
  db: {
    order: { findFirst: vi.fn(), updateMany: vi.fn() },
    orderChangeRequest: { findFirst: vi.fn(), updateMany: vi.fn() },
    shippingBatch: { findFirst: vi.fn() },
    orderNote: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  createReplacement: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/notify', () => ({ notify: vi.fn() }));
vi.mock('@/lib/authorization', () => ({ can: () => true }));
vi.mock('@/lib/replacement-order', () => ({ createReplacement: (...a: unknown[]) => createReplacement(...a) }));
vi.mock('@/lib/change-request-apply', async (orig) => ({
  ...(await orig<typeof import('@/lib/change-request-apply')>()),
  authorises: () => ({ ok: true }),
  // A change to the goods: the one a courier cannot make in a carton.
  expandApproved: () => ({ ok: true, fields: { quantity: 2 } }),
}));

import { POST as reorder } from '@/app/api/orders/[id]/reorder/route';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «CANCEL AND REORDER» IS FOR A PARCEL THE COMPANY HAS — NOT ONE ON OUR FLOOR.
 *
 * (The owner, 28/10: «قبل التسليم: نفس الطلب».) A printed waybill seals an order,
 * so an approved change to the goods on a labelled parcel used to land on this
 * door: it closed the original as RETURN_REQUESTED — a return for a box that
 * never left the building — and raised a second order for the same goods. Before
 * the press of «إغلاق الشحنة — سُلّمت للشركة» the approved edit is made on the
 * SAME order and its waybill printed again (see
 * `an-approved-edit-before-handover-is-made-in-place.test.ts`); this door says so
 * and does nothing. After the press it is exactly what it was.
 * ═══════════════════════════════════════════════════════════════════════
 */

const ORDER_ID = '11111111-2222-4333-8444-555555555555';

const stored = (over: Record<string, unknown> = {}) => ({
  id: ORDER_ID, companyId: 'c1', storeId: 's1', version: 3, orderNumber: 'SY-1',
  confirmationStatus: 'CONFIRMED', shippingStatus: 'READY_FOR_PICKUP', shippedAt: null,
  labelPrintedAt: new Date('2026-10-28T08:00:00Z'), claimedById: null, replacedBy: null,
  ...over,
});

const run = async () => {
  const res = await reorder(
    new Request(`http://x/api/orders/${ORDER_ID}/reorder`, {
      method: 'POST',
      body: JSON.stringify({ changeRequestId: '99999999-8888-4777-8666-555555555555', courierNotified: true }),
    }),
    { params: Promise.resolve({ id: ORDER_ID }) }
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
};

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'م', role: 'COMPANY_ADMIN' },
    companyId: 'c1', storeId: 's1',
    country: { orderPrefix: 'SY', minorUnit: 2, allowNegativeStock: false },
  });
  db.orderChangeRequest.findFirst.mockResolvedValue({
    id: 'cr1', orderId: ORDER_ID, status: 'APPROVED', appliedAt: null, intent: 'EDIT',
    changes: { quantity: { to: 2 } }, reason: 'الزبون بدو قطعتين', decisionNote: null, requestedById: 'u2',
  });
  db.orderChangeRequest.updateMany.mockResolvedValue({ count: 1 });
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.orderNote.create.mockResolvedValue({});
  db.orderActivity.create.mockResolvedValue({});
  createReplacement.mockResolvedValue({ id: 'rep1', orderNumber: 'SY-2' });
});

describe('before the company took the parcel', () => {
  it('a labelled parcel on an open trolley is NOT closed as a return and NOT replaced', async () => {
    db.order.findFirst.mockResolvedValue(stored());
    db.shippingBatch.findFirst.mockResolvedValue({ status: 'READY', batchNumber: 'B-1' });

    const res = await run();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_A_REORDER');
    expect(res.body.error).toContain('نفس الطلب');
    expect(db.order.updateMany, 'انكتب مرتجع وهمي للطلب الأصلي').not.toHaveBeenCalled();
    expect(createReplacement, 'صدر طلب بديل لطرد ما غادر').not.toHaveBeenCalled();
  });

  it('a labelled parcel on no trolley at all is the same', async () => {
    db.order.findFirst.mockResolvedValue(stored());
    db.shippingBatch.findFirst.mockResolvedValue(null);

    const res = await run();

    expect(res.body.code).toBe('NOT_A_REORDER');
    expect(createReplacement).not.toHaveBeenCalled();
  });
});

describe('once the company has it — as before', () => {
  it('a pressed trolley: the original comes back as a return and the replacement is raised', async () => {
    db.order.findFirst.mockResolvedValue(stored({ shippingStatus: 'SHIPPED', shippedAt: new Date() }));
    db.shippingBatch.findFirst.mockResolvedValue({ status: 'SHIPPED', batchNumber: 'B-1' });

    const res = await run();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(createReplacement).toHaveBeenCalledTimes(1);
    expect(db.order.updateMany.mock.calls[0][0].data.shippingStatus).toBe('RETURN_REQUESTED');
  });

  it('a pressed trolley whose order status never moved counts: the batch is the fact', async () => {
    db.order.findFirst.mockResolvedValue(stored());
    db.shippingBatch.findFirst.mockResolvedValue({ status: 'SHIPPED', batchNumber: 'B-1' });

    const res = await run();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(createReplacement).toHaveBeenCalledTimes(1);
  });
});
