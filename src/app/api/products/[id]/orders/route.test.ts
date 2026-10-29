import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «أحدث الطلبات على هذا المنتج» — THE DOOR THE CARD READS, AND WHAT IT MUST NOT SAY.
 *
 * The card read `product.orders` off `GET /api/products/[id]`, which has never sent it. This door sends the latest orders
 * and says nothing about a customer beyond a name and a city, because the alternative — `GET /api/orders?productId=` —
 * answers with every customer's phone and address and is counted as a person pulling that many customers' contact
 * details. Every gate below is tested by its REFUSAL, not by its success.
 */

const { db, requireContext, authorize, getPermissionScope, applyQueueFilter } = vi.hoisted(() => ({
  db: { product: { findFirst: vi.fn() }, order: { count: vi.fn(), findMany: vi.fn() } },
  requireContext: vi.fn(),
  authorize: vi.fn(),
  getPermissionScope: vi.fn(),
  applyQueueFilter: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  authorize: (...a: unknown[]) => authorize(...a),
  getPermissionScope: (...a: unknown[]) => getPermissionScope(...a),
}));
vi.mock('@/lib/rbac', () => ({ applyQueueFilter: (...a: unknown[]) => applyQueueFilter(...a) }));

import { GET } from './route';

const USER = { id: 'u1', role: 'MODERATOR', companyId: 'c1', status: 'ACTIVE' };
const PRODUCT = { id: 'p1', companyId: 'c1', categoryId: null };

const row = (over: Record<string, unknown> = {}) => ({
  id: 'o1',
  orderNumber: 'ORD-26-0001',
  createdAt: new Date('2026-10-20T12:00:00Z'),
  totalAmount: 40,
  confirmationStatus: 'CONFIRMED',
  shippingStatus: 'DELIVERED',
  claimedById: null,
  shippedAt: new Date('2026-10-18T12:00:00Z'),
  labelPrintedAt: null,
  customer: { fullName: 'نور الحسن', city: 'عمّان' },
  moderator: { name: 'سارة' },
  ...over,
});

const call = (id = 'p1') => GET(new Request(`http://x/api/products/${id}/orders`), { params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.resetAllMocks();
  requireContext.mockResolvedValue({
    user: USER,
    companyId: 'c1',
    storeId: 's1',
    country: { currencyCode: 'JOD', minorUnit: 3 },
  });
  getPermissionScope.mockReturnValue({ scope: 'ALL_COMPANY', scopeIds: null });
  authorize.mockReturnValue({ allowed: true });
  // Wraps, like the real one, so the test can tell the visibility envelope was applied and to what.
  applyQueueFilter.mockImplementation((_user: unknown, where: unknown) => ({ AND: [where, { visible: 'for-this-reader' }] }));
  db.product.findFirst.mockResolvedValue(PRODUCT);
  db.order.count.mockResolvedValue(131);
  db.order.findMany.mockResolvedValue([row()]);
});

describe('who may ask', () => {
  it('refuses without orders.view — in Arabic, and reads nothing on the way to the refusal', async () => {
    getPermissionScope.mockReturnValue(null);
    const res = await call();
    expect(res.status).toBe(403);
    expect((await res.json()).errorAr).toBe('لا تملك صلاحية عرض الطلبات.');
    expect(db.product.findFirst).not.toHaveBeenCalled();
    expect(db.order.count).not.toHaveBeenCalled();
    expect(db.order.findMany).not.toHaveBeenCalled();
  });

  it('asks the scope for orders.view — the key the orders list itself is gated on', async () => {
    await call();
    expect(getPermissionScope.mock.calls[0][1]).toBe('orders.view');
  });

  it('answers 404 for a product outside this store, and reads no order for it', async () => {
    db.product.findFirst.mockResolvedValue(null);
    const res = await call('elsewhere');
    expect(res.status).toBe(404);
    expect(db.order.findMany).not.toHaveBeenCalled();
  });

  it('answers 404 for a product outside this caller’s scope — asked as products.view, the product page’s own question', async () => {
    authorize.mockReturnValue({ allowed: false, reason: 'OUT_OF_SCOPE' });
    const res = await call();
    expect(authorize.mock.calls[0][1]).toBe('products.view');
    expect(authorize.mock.calls[0][2]).toMatchObject({ id: 'p1', companyId: 'c1' });
    expect(res.status).toBe(404);
    expect(db.order.findMany).not.toHaveBeenCalled();
  });

  it('answers 403 for someone who may not view products at all', async () => {
    authorize.mockReturnValue({ allowed: false, reason: 'NO_PERMISSION' });
    const res = await call();
    expect(res.status).toBe(403);
    expect(db.order.findMany).not.toHaveBeenCalled();
  });

  it('looks the product up inside THIS store only — and with no store chosen, matches nothing', async () => {
    await call();
    expect(db.product.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'p1', companyId: 'c1', storeId: 's1' });
    requireContext.mockResolvedValue({ user: USER, companyId: 'c1', storeId: null, country: { currencyCode: 'JOD', minorUnit: 3 } });
    await call();
    expect(db.product.findFirst.mock.calls[1][0].where.id).toEqual({ in: [] });
  });
});

describe('which orders', () => {
  it('— the orders OF THIS PRODUCT, in this store, through the reader’s own visibility envelope', async () => {
    await call();
    const [user, where, queue] = applyQueueFilter.mock.calls[0];
    expect(user).toBe(USER);
    expect(queue, 'ما في صفٌّ مطلوب: المغلَّف الافتراضيّ للدور').toBeNull();
    // Was `productId: 'p1'` (the legacy first-line column). RV75: «of this product» is any line — the first line OR a
    // later one — as the reports count it; `orders-of-a-product-are-any-line.test.ts` runs the clause over real orders.
    expect(where).toMatchObject({
      companyId: 'c1',
      storeId: 's1',
      AND: [{ OR: [{ productId: 'p1' }, { items: { some: { productId: 'p1' } } }] }],
    });
    // The envelope wraps what was asked, and what is READ is the wrapped question.
    const asked = db.order.findMany.mock.calls[0][0].where;
    expect(asked).toEqual({ AND: [where, { visible: 'for-this-reader' }] });
    // …and so is what is COUNTED: the total beside the rows is about the same orders.
    expect(db.order.count.mock.calls[0][0].where).toBe(asked);
  });

  it('— the newest first, the id to end the order, and eight of them', async () => {
    await call();
    const q = db.order.findMany.mock.calls[0][0];
    expect(q.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'asc' }]);
    expect(q.take).toBe(8);
  });
});

describe('what it says about a customer', () => {
  it('— a name and a city, and the query SELECTS nothing else of them', async () => {
    await call();
    const select = db.order.findMany.mock.calls[0][0].select;
    expect(select.customer).toEqual({ select: { fullName: true, city: true } });
    expect(select.moderator).toEqual({ select: { name: true } });
  });

  it('and not one phone, alternative phone or address is in the answer', async () => {
    db.order.findMany.mockResolvedValue([row({ customer: { fullName: 'نور الحسن', city: 'عمّان', phone: '0791234567', rawPhone: '0791234567', address: 'شارع الجامعة' } })]);
    const text = JSON.stringify(await (await call()).json());
    for (const leak of ['phone', 'rawPhone', 'address', '0791234567', 'شارع الجامعة']) expect(text, leak).not.toContain(leak);
  });
});

describe('the answer', () => {
  it('— the state is DERIVED, as everywhere, from the stored fields (never the legacy `status`)', async () => {
    db.order.findMany.mockResolvedValue([
      row({ id: 'a', shippingStatus: 'DELIVERED' }),
      row({ id: 'b', confirmationStatus: 'CANCELLED', shippingStatus: 'NOT_READY' }),
    ]);
    const body = await (await call()).json();
    expect(body.orders.map((o: { state: string }) => o.state)).toEqual(['DELIVERED', 'CANCELLED']);
  });

  it('and carries the rows, how many there are in all, and the store’s own currency', async () => {
    const body = await (await call()).json();
    expect(body.total).toBe(131);
    expect(body.currency).toEqual({ code: 'JOD', minorUnit: 3 });
    expect(body.orders[0]).toEqual({
      id: 'o1',
      orderNumber: 'ORD-26-0001',
      state: 'DELIVERED',
      totalAmount: 40,
      createdAt: '2026-10-20T12:00:00.000Z',
      customer: { fullName: 'نور الحسن', city: 'عمّان' },
      moderator: 'سارة',
    });
  });

  it('and an order with no moderator, or a customer with no city, says null rather than inventing', async () => {
    db.order.findMany.mockResolvedValue([row({ moderator: null, customer: { fullName: 'ليلى', city: null } })]);
    const o = (await (await call()).json()).orders[0];
    expect(o.moderator).toBeNull();
    expect(o.customer).toEqual({ fullName: 'ليلى', city: null });
  });

  it('and a product nobody has ordered is an empty list with a total of zero — not an error', async () => {
    db.order.count.mockResolvedValue(0);
    db.order.findMany.mockResolvedValue([]);
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ total: 0, orders: [] });
  });
});
