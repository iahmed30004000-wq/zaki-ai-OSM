import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * قائمة «إنشاء شحنة» تسأل سؤال الباب.
 *
 * طلب مؤكَّد سطره غير محجوز (المخزون دخل بعد التأكيد) ظهر «جاهز» والباب رفضه بـ409 «لا يوجد طلب صالح للشحن».
 * الصف يسأل الآن `assertReadyToShip` نفسها، على الأسطر والإضافات نفسها، فلا يختلف الصف عن الباب: نص واحد،
 * وحكم واحد. والقراءة كلها بـ select واحد (لا استعلام لكل صف).
 */

const { db, requireContext, shipmentBlocks, resolveDeliveryFee } = vi.hoisted(() => ({
  db: {
    deliveryProvider: { findFirst: vi.fn() },
    order: { findMany: vi.fn(), count: vi.fn(), update: vi.fn() },
    shippingBatch: { findFirst: vi.fn(), count: vi.fn(), create: vi.fn(), findUnique: vi.fn() },
    orderStatusLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  shipmentBlocks: vi.fn(),
  resolveDeliveryFee: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: vi.fn() }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: vi.fn() }));
vi.mock('@/lib/operations', () => ({ shipmentBlocks: (...a: unknown[]) => shipmentBlocks(...a) }));
vi.mock('@/lib/delivery-fees', async (orig) => ({
  ...(await orig<typeof import('@/lib/delivery-fees')>()),
  resolveDeliveryFee: (...a: unknown[]) => resolveDeliveryFee(...a),
}));
// The REAL assertReadyToShip and guardLines — they are what the row and the door must share.

import { GET, POST } from '@/app/api/ops/shipments/route';
import { assertReadyToShip } from '@/lib/order-state';
import { guardLines } from '@/lib/reservation';

const PROVIDER = '11111111-1111-4111-8111-111111111111';
const ORDER_ID = '22222222-2222-4222-8222-222222222222';

const line = (reservedQty: number, over: Record<string, unknown> = {}) => ({
  productName: 'منتج', quantity: 1, freeQuantity: 0, unitPrice: 20, discountShare: 0, lineTotal: 20, reservedQty, ...over,
});

const order = (over: Record<string, unknown> = {}) => ({
  id: ORDER_ID, orderNumber: 'SY-2026-0001', merchantRef: null, createdAt: new Date('2026-10-01'), currency: 'SYP',
  shipHoldUntil: null, shipHoldReason: null, priceIncludesDelivery: false, deliveryFee: 0, regionId: 'r1',
  deliveryProviderId: null, customerId: 'cu1', companyId: 'c1', storeId: 's1', confirmationStatus: 'CONFIRMED',
  shippingStatus: 'NOT_READY', shippedAt: null, labelPrintedAt: null, shippingBatchId: null, version: 1,
  customer: { id: 'cu1', fullName: 'سامر', phone: '0790000000', city: 'دمشق', totalOrders: 1 },
  region: { id: 'r1', name: 'دمشق' },
  items: [line(1)],
  addOns: [],
  ...over,
});

const list = async (qs = '') => {
  const res = await GET(new Request(`http://localhost/api/ops/shipments${qs}`));
  return (await res.json()) as {
    orders: { id: string; selectable: boolean; hardBlocked: boolean; blocks: { code: string; message: string; hard: boolean; hint?: string }[] }[];
  };
};

const post = () =>
  POST(
    new Request('http://localhost/api/ops/shipments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deliveryProviderId: PROVIDER, orderIds: [ORDER_ID] }),
    })
  );

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', role: 'WAREHOUSE' }, companyId: 'c1', storeId: 's1',
    country: { minorUnit: 2, allowNegativeStock: false },
  });
  db.deliveryProvider.findFirst.mockResolvedValue({ id: PROVIDER });
  db.order.count.mockResolvedValue(0);
  shipmentBlocks.mockResolvedValue([]);
  resolveDeliveryFee.mockResolvedValue({ fee: 3, lateThresholdDays: 5, returnFee: 0, source: 'TABLE' });
  db.shippingBatch.findFirst.mockResolvedValue(null);
  db.shippingBatch.count.mockResolvedValue(0);
  db.shippingBatch.create.mockResolvedValue({ id: 'b1', batchNumber: 'BATCH-1' });
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  db.order.update.mockResolvedValue({});
  db.orderStatusLog.create.mockResolvedValue({});
});

describe('the row says what the door will answer', () => {
  it('a confirmed order with an unreserved line is not selectable, and says why', async () => {
    db.order.findMany.mockResolvedValue([order({ items: [line(0)] })]);
    const { orders } = await list();
    expect(orders[0].selectable).toBe(false);
    expect(orders[0].hardBlocked).toBe(true);
    const block = orders[0].blocks.find((b) => b.code === 'UNRESERVED_LINES');
    expect(block?.hard).toBe(true);
    expect(block?.message).toBe('لا يمكن التجهيز: 1 سطر غير محجوز بالكامل');
    expect(block?.hint).toContain('أجِّل');
    expect(block?.hint).toContain('ليُعاد الحجز');
  });

  it('a fully reserved order stays ready, exactly as before', async () => {
    db.order.findMany.mockResolvedValue([order({ items: [line(1)] })]);
    const { orders } = await list();
    expect(orders[0].blocks).toEqual([]);
    expect(orders[0].selectable).toBe(true);
    expect(orders[0].hardBlocked).toBe(false);
  });

  it('gift units count: 1 + 1 free reserved as 1 is short', async () => {
    db.order.findMany.mockResolvedValue([order({ items: [line(1, { freeQuantity: 1 })] })]);
    const { orders } = await list();
    expect(orders[0].selectable).toBe(false);
    expect(orders[0].blocks[0].message).toContain('1 سطر غير محجوز');
  });

  it('an unreserved add-on is counted as the door counts it, in its own words', async () => {
    db.order.findMany.mockResolvedValue([order({ items: [line(1)], addOns: [{ quantity: 1, price: 15, reservedQty: 0 }] })]);
    const { orders } = await list();
    expect(orders[0].selectable).toBe(false);
    expect(orders[0].blocks[0].message).toBe('لا يمكن التجهيز: 1 إضافة غير محجوزة بالكامل');
  });

  it('a reserved add-on does not hold the order back', async () => {
    db.order.findMany.mockResolvedValue([order({ items: [line(1)], addOns: [{ quantity: 1, price: 15, reservedQty: 1 }] })]);
    const { orders } = await list();
    expect(orders[0].selectable).toBe(true);
  });

  it('an order with no lines is refused in the door\'s words and has nothing to postpone', async () => {
    db.order.findMany.mockResolvedValue([order({ items: [], addOns: [] })]);
    const { orders } = await list();
    expect(orders[0].selectable).toBe(false);
    expect(orders[0].blocks[0].message).toBe('الطلب بلا أسطر — لا يمكن تجهيزه');
    expect(orders[0].blocks[0].hint).toBeUndefined();
  });

  it('the held list is not asked: its units were given back on purpose, and «أرجِعه» takes them again', async () => {
    db.order.findMany.mockResolvedValue([order({ items: [line(0)], shipHoldUntil: new Date('2999-01-01') })]);
    const { orders } = await list('?held=only');
    expect(orders[0].blocks).toEqual([]);
  });

  it('keeps the other blocks beside it, and a soft one is still acknowledgeable', async () => {
    shipmentBlocks.mockResolvedValue([{ code: 'RECENT_RETURN', message: 'للعميل 1 مرتجع خلال 30 يوماً', hard: false }]);
    db.order.findMany.mockResolvedValue([order({ items: [line(1)] })]);
    const { orders } = await list();
    expect(orders[0].blocks.map((b) => b.code)).toEqual(['RECENT_RETURN']);
    expect(orders[0].hardBlocked).toBe(false);
    expect(orders[0].selectable).toBe(false);
  });

  it('300 rows are one read: the reservations come from the select, not from a query per row', async () => {
    const many = Array.from({ length: 300 }, (_, i) =>
      order({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, orderNumber: `SY-${i}`, items: [line(i % 2)] })
    );
    db.order.findMany.mockResolvedValue(many);
    const { orders } = await list();
    expect(orders).toHaveLength(300);
    expect(orders.filter((o) => !o.selectable)).toHaveLength(150);
    // the single list read, nothing extra for the readiness question
    expect(db.order.findMany).toHaveBeenCalledTimes(1);
    const select = db.order.findMany.mock.calls[0][0].select;
    expect(select.items.select.reservedQty).toBe(true);
    expect(select.addOns.select.reservedQty).toBe(true);
  });
});

describe('the row and the door cannot disagree', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['an unreserved line', { items: [line(0)] }],
    ['a short gift', { items: [line(1, { freeQuantity: 2 })] }],
    ['an unreserved add-on', { addOns: [{ quantity: 2, price: 5, reservedQty: 1 }] }],
    ['no lines', { items: [] }],
    ['everything reserved', { items: [line(1)], addOns: [{ quantity: 1, price: 5, reservedQty: 1 }] }],
  ];

  it.each(cases)('%s: the list and the POST give the same verdict and the same sentence', async (_name, over) => {
    const o = order(over);
    db.order.findMany.mockResolvedValue([o]);
    const { orders } = await list();
    const rowSaid = orders[0].blocks.find((b) => b.code === 'UNRESERVED_LINES')?.message;

    db.order.findMany.mockResolvedValue([o]);
    const res = await post();
    const body = (await res.json()) as { exceptions?: { reasons: string[] }[] };
    const doorSaid = body.exceptions?.[0]?.reasons.find((r) => r.includes('لا يمكن التجهيز') || r.includes('بلا أسطر'));

    expect(rowSaid).toBe(doorSaid);
    // and both are the library's own answer
    const direct = assertReadyToShip(o as never, guardLines(o.items as never, o.addOns as never));
    expect(rowSaid).toBe(direct.allowed ? undefined : direct.message);
    expect(res.status).toBe(direct.allowed ? 201 : 409);
  });
});
