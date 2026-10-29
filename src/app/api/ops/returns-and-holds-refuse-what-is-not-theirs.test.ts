import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * TWO DOORS THAT TOOK ANY ORDER ID.
 *
 * THE RETURNS POST. The list never offers a delivered, settled order, but
 * the door took any id: a call straight to the API rewrote a delivered,
 * settled order as RETURNED and reversed the commission it had earned — a
 * sale undone by a typed order number.
 *
 * THE HOLD RELEASE. Lifting a hold reserves the goods again. It did so for
 * an order cancelled while it sat held, and for a parcel already gone, with
 * no check that the order was the one the page had read.
 *
 * Each refusal has its negative: the ordinary return and the ordinary
 * release are untouched.
 * ═══════════════════════════════════════════════════════════════════════
 */

const {
  db, requireContext, requirePermission, logAudit, reverseForOrder, reserveOrderLines, releaseOrderLines,
} = vi.hoisted(() => ({
  reverseForOrder: vi.fn(async (..._a: unknown[]) => 1),
  reserveOrderLines: vi.fn(async (..._a: unknown[]) => undefined),
  releaseOrderLines: vi.fn(async (..._a: unknown[]) => undefined),
  db: {
    order: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), count: vi.fn(async () => 0), groupBy: vi.fn(async () => []) },
    deliveryProvider: { findMany: vi.fn(async () => []) },
    user: { findMany: vi.fn(async () => []) },
    returnReceipt: { create: vi.fn() },
    inventoryMovement: { findFirst: vi.fn(), create: vi.fn() },
    productionBatch: { findFirst: vi.fn(), create: vi.fn(), aggregate: vi.fn() },
    orderItem: { updateMany: vi.fn() },
    orderNote: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
    deliveryFee: { findFirst: vi.fn() },
    $transaction: vi.fn(async (fn: any) => fn(db)),
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ can: () => true, requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/commission', () => ({ reverseForOrder }));
vi.mock('@/lib/reservation', () => ({ reserveOrderLines, releaseOrderLines }));

import { POST as receiveReturn } from '@/app/api/ops/returns/route';
import { POST as holdDoor } from '@/app/api/ops/shipments/hold/route';

const ORDER_ID = '77777777-7777-4777-8777-777777777777';

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'Warehouse', role: 'WAREHOUSE', status: 'ACTIVE' },
    companyId: 'c1', storeId: 's1',
    country: { minorUnit: 3, currencyCode: 'JOD', allowNegativeStock: false },
  });
  requirePermission.mockResolvedValue({});
});

describe('receiving a return', () => {
  const stored = (over: Record<string, unknown> = {}) => ({
    id: ORDER_ID, orderNumber: 'ORD-1', shippingStatus: 'RETURN_REQUESTED', settlementStatus: 'PENDING_COLLECTION',
    regionId: 'r1', deliveryProviderId: 'dp1', returnReceipt: null,
    items: [{ id: 'i1', productId: 'p1', productName: 'مقشر', quantity: 3, freeQuantity: 0 }],
    ...over,
  });

  const receive = async () => {
    const res = await receiveReturn(
      new Request('http://localhost/x', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: ORDER_ID, receivedQty: 3, countedAndInspected: true }),
      })
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  beforeEach(() => {
    db.returnReceipt.create.mockImplementation(async ({ data }: any) => ({ id: 'rr1', ...data }));
    db.inventoryMovement.findFirst.mockImplementation(async ({ where }: any) => (where?.type === 'SALE' ? { id: 'sale-1' } : null));
    db.productionBatch.findFirst.mockResolvedValue({ costPerUnit: 4 });
    db.productionBatch.create.mockResolvedValue({ id: 'b-ret' });
    db.productionBatch.aggregate.mockResolvedValue({ _sum: { quantityRemaining: 12 } });
    db.orderItem.updateMany.mockResolvedValue({ count: 1 });
    db.order.update.mockResolvedValue({});
    db.orderNote.create.mockResolvedValue({});
    db.deliveryFee.findFirst.mockResolvedValue({ fee: '2', lateThresholdDays: 3, returnFee: '1.5' });
  });

  it('refuses a DELIVERED order whose money is SETTLED, and reverses nothing', async () => {
    db.order.findFirst.mockResolvedValue(stored({ shippingStatus: 'DELIVERED', settlementStatus: 'SETTLED' }));

    const res = await receive();

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('DELIVERED_AND_SETTLED');
    expect(db.returnReceipt.create, 'انكتب إيصال مرتجع على طلب مسلّم').not.toHaveBeenCalled();
    expect(reverseForOrder, 'انعكست عمولة طلب مسلّم').not.toHaveBeenCalled();
    expect(db.order.update).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('still receives an ordinary return', async () => {
    db.order.findFirst.mockResolvedValue(stored());

    const res = await receive();

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(db.returnReceipt.create).toHaveBeenCalledTimes(1);
    expect(reverseForOrder).toHaveBeenCalledTimes(1);
  });

  it('and a partly delivered order, even a settled one, still takes back what was refused', async () => {
    db.order.findFirst.mockResolvedValue(stored({ shippingStatus: 'PARTIALLY_DELIVERED', settlementStatus: 'SETTLED' }));

    const res = await receive();

    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it('and a delivered order whose money is not settled yet is not what this guard is about', async () => {
    db.order.findFirst.mockResolvedValue(stored({ shippingStatus: 'DELIVERED', settlementStatus: 'COLLECTED' }));

    const res = await receive();

    expect(res.body.code).not.toBe('DELIVERED_AND_SETTLED');
  });
});

describe('lifting a hold', () => {
  const held = (over: Record<string, unknown> = {}) => ({
    id: ORDER_ID, orderNumber: 'ORD-9', confirmationStatus: 'CONFIRMED', shippingStatus: 'NOT_READY',
    shippingBatchId: null, shipHoldUntil: new Date(Date.now() + 86_400_000), version: 8,
    shippedAt: null, labelPrintedAt: null,
    ...over,
  });

  const release = async () => {
    const res = await holdDoor(
      new Request('http://localhost/x', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: ORDER_ID, release: true }),
      })
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  beforeEach(() => {
    db.order.update.mockResolvedValue({ id: ORDER_ID, orderNumber: 'ORD-9', shipHoldUntil: null, shipHoldReason: null });
    db.orderActivity.create.mockResolvedValue({});
  });

  it.each([
    ['cancelled while it sat held', { confirmationStatus: 'CANCELLED' }],
    ['rejected while it sat held', { confirmationStatus: 'REJECTED' }],
    ['no longer confirmed', { confirmationStatus: 'POSTPONED' }],
    ['already shipped', { shippingStatus: 'SHIPPED', shippedAt: new Date() }],
    ['reported by the courier', { shippingStatus: 'OUT_FOR_DELIVERY' }],
    ['written off as cancelled', { shippingStatus: 'CANCELLED' }],
  ])('refuses an order %s, and reserves nothing', async (_name, over) => {
    db.order.findFirst.mockResolvedValue(held(over));

    const res = await release();

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('NOT_RESERVABLE');
    expect(reserveOrderLines, 'انحجزت بضاعة طلب ميّت').not.toHaveBeenCalled();
    expect(db.order.update).not.toHaveBeenCalled();
  });

  it('releases a held, confirmed order — reserving again, at the version it read', async () => {
    db.order.findFirst.mockResolvedValue(held());

    const res = await release();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(reserveOrderLines).toHaveBeenCalledTimes(1);
    expect(db.order.update.mock.calls[0][0].where).toMatchObject({ id: ORDER_ID, version: 8 });
  });

  it('and a stale page, finding the version moved, reserves nothing', async () => {
    db.order.findFirst.mockResolvedValue(held());
    db.order.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('not found', { code: 'P2025', clientVersion: 'test' })
    );

    const res = await release();

    expect(res.status).toBe(409);
    expect(reserveOrderLines, 'انحجزت بضاعة بعد ما فشل التحديث').not.toHaveBeenCalled();
    expect(db.orderActivity.create).not.toHaveBeenCalled();
  });
});
