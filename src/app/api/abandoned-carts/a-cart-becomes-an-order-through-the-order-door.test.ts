import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «حوّل لطلب» MAKES THE ORDER THROUGH THE ORDER DOOR THAT EXISTS, AND ONLY THEN TIES THE CART TO IT.
 *
 * The brief: «يمر بنفس مسار إنشاء الطلب الموجود (نفس التحقق والتسعير والحظر والأحداث، بدون أي حساب مال جديد)». So the
 * order here is created by the real `POST /api/orders` handler, with the body the new-order form sends when it is filled
 * from a cart, and the cart is then CONVERTED by `POST /api/abandoned-carts/:id/convert` — which writes no order, no
 * line and no figure. The mocks are `multi-line.test.ts`'s, the order door's own harness.
 */

const { db, requireContext, requirePermission, logAudit, activeBlock, createNotification } = vi.hoisted(() => ({
  db: {
    customer: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    product: { findMany: vi.fn(), findFirst: vi.fn() },
    offer: { findFirst: vi.fn(), findMany: vi.fn(async (): Promise<unknown[]> => []) },
    store: { findFirst: vi.fn() },
    region: { findFirst: vi.fn() },
    user: { findFirst: vi.fn() },
    order: { create: vi.fn(), count: vi.fn(), findFirst: vi.fn() },
    orderItem: { createMany: vi.fn(), create: vi.fn() },
    orderActivity: { create: vi.fn() },
    orderStatusLog: { create: vi.fn() },
    productionBatch: { findMany: vi.fn() },
    productFixedCost: { findMany: vi.fn(async (): Promise<{ productId: string; amount: number }[]> => []) },
    abandonedCart: { findFirst: vi.fn(), update: vi.fn() },
    abandonedCartActivity: { create: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
  activeBlock: vi.fn(),
  createNotification: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/blacklist', () => ({ activeBlock: (...a: unknown[]) => activeBlock(...a) }));
vi.mock('@/lib/notification', () => ({ createNotification: (...a: unknown[]) => createNotification(...a) }));
vi.mock('@/lib/rbac', () => ({ applyQueueFilter: (_u: unknown, w: unknown) => w }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: (...a: unknown[]) => requirePermission(...a),
  getPermissionScope: () => ({ scope: 'ALL_COMPANY' }),
  can: () => true,
}));
vi.mock('@/lib/order-ref', () => ({
  orderRefFields: async () => ({ orderNumber: 'JO-2026-0300', merchantRef: 'JO-2026-0300' }),
}));

import { POST as createOrder } from '@/app/api/orders/route';
import { POST as convert } from './[id]/convert/route';

const HONEY = { id: 'prod-honey-0001', name: 'دبس رمان', image: null, basePrice: 15, batches: [] };
const jordan = { id: 'jo', code: 'JO', name: 'الأردن', currencyCode: 'JOD', minorUnit: 3, timezone: 'Asia/Amman', orderPrefix: 'JO', allowNegativeStock: false };

/** The body the «طلب سريع جديد» form sends when «حوّل لطلب» filled it (`useCartConversion` → `CreateOrderModal`). */
const FROM_CART = {
  customerName: 'محمد',
  customerPhone: '0791234567',
  customerAltPhone: '',
  customerAddress: 'شارع الجامعة',
  customerCity: 'عمّان',
  regionId: null,
  items: [{ productId: HONEY.id, offerId: null, quantity: 1, unitPrice: 15 }],
  priceIncludesDelivery: true,
  channelId: null,
  moderatorId: null,
  customerNotes: '',
  internalNotes: 'من سلة مهجورة — صفحة «رمانة»',
};

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'هدى', role: 'EMPLOYEE', status: 'ACTIVE' },
    companyId: 'c1',
    storeId: 's1',
    countryId: 'jo',
    country: jordan,
  });
  requirePermission.mockResolvedValue({ id: 'u1', companyId: 'c1' });
  createNotification.mockResolvedValue(undefined);
  activeBlock.mockResolvedValue(null);
  db.customer.findUnique.mockResolvedValue({ id: 'cu1', fullName: 'محمد', totalOrders: 0 });
  db.customer.findFirst.mockResolvedValue({ id: 'cu1', fullName: 'محمد', totalOrders: 0 });
  db.product.findMany.mockImplementation(async ({ where }: any) => [HONEY].filter((p) => where.id.in.includes(p.id)));
  db.store.findFirst.mockResolvedValue({ priceIncludesDelivery: true });
  db.user.findFirst.mockResolvedValue({ id: 'u1' });
  db.order.create.mockResolvedValue({ id: 'o-new', orderNumber: 'JO-2026-0300', createdAt: new Date() });
  db.productionBatch.findMany.mockResolvedValue([]);
  db.$transaction.mockImplementation(async (fn: any) => fn(db));
  db.abandonedCart.findFirst.mockResolvedValue({ id: 'cart1', status: 'NO_ANSWER', assignedToId: 'u1', orderId: null, attempts: 2, nextFollowUpAt: null });
  db.abandonedCart.update.mockResolvedValue({});
});

describe('«حوّل لطلب»', () => {
  it('the order is created by POST /api/orders — its own checks, blacklist, pricing, history and audit — then the cart is CONVERTED', async () => {
    const made = await createOrder(
      new Request('http://localhost/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(FROM_CART) })
    );
    expect(made.status).toBe(200);
    const { order } = (await made.json()) as { order: { id: string; orderNumber: string } };
    expect(order.id).toBe('o-new');

    // The order door did its own work: the blacklist, the order row, its line, its history, its audit.
    expect(activeBlock).toHaveBeenCalled();
    expect(db.order.create).toHaveBeenCalledTimes(1);
    expect(db.orderItem.createMany).toHaveBeenCalledTimes(1);
    expect(db.orderActivity.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'ORDER_CREATED' }) }));
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'ORDER_CREATED' }));

    db.order.findFirst.mockResolvedValue({ id: 'o-new', orderNumber: 'JO-2026-0300' });
    const tied = await convert(
      new Request('http://localhost/api/abandoned-carts/cart1/convert', { method: 'POST', body: JSON.stringify({ orderId: order.id }) }),
      { params: Promise.resolve({ id: 'cart1' }) }
    );
    expect(tied.status).toBe(200);
    expect(await tied.json()).toEqual({ ok: true, status: 'CONVERTED', orderNumber: 'JO-2026-0300' });
    expect(db.abandonedCart.update.mock.calls[0][0].data).toMatchObject({ status: 'CONVERTED', orderId: 'o-new' });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'ABANDONED_CART_CONVERTED', userId: 'u1' }));

    // The tie made no second order and wrote no line.
    expect(db.order.create).toHaveBeenCalledTimes(1);
    expect(db.orderItem.createMany).toHaveBeenCalledTimes(1);
  });

  it('a blacklisted number is refused by the order door, and the cart is never tied', async () => {
    activeBlock.mockResolvedValue({ id: 'b1', reason: 'احتيال' });
    const made = await createOrder(
      new Request('http://localhost/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(FROM_CART) })
    );
    expect(made.status).toBe(409);
    expect(db.order.create).not.toHaveBeenCalled();
    expect(db.abandonedCart.update).not.toHaveBeenCalled();
  });
});

describe('the code behind the button', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

  it('the screen opens the ordinary form and posts nothing to the order door itself', () => {
    const parts = read('src/components/carts/cart-parts.tsx');
    expect(parts).toMatch(/<CreateOrderModal/);
    expect(parts).not.toMatch(/['"`]\/api\/orders['"`]/);
    expect(parts).toMatch(/\/api\/abandoned-carts\/\$\{target\.id\}\/convert/);
  });

  it('nothing on the cart side writes an order, a line or a figure', () => {
    for (const file of ['src/lib/abandoned-carts.ts', 'src/lib/v1/landing-carts.ts', 'src/app/api/abandoned-carts/[id]/convert/route.ts']) {
      const src = read(file);
      expect(src, file).not.toMatch(/\b(?:db|tx)\.(?:order|orderItem)\.(?:create|update|upsert|delete)/);
      expect(src, file).not.toMatch(/computeCod|totalAmount|sellingPrice|lineTotal/);
    }
  });
});
