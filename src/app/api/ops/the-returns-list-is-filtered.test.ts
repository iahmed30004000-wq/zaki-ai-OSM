import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE RETURNS LIST, FILTERED AND SEARCHED — THE DOOR.
 *
 * «المرتجعات — صفحات + فلاتر + بحث». The door already handed out pages; what is held here is what it asks for with
 * what the clerk chose, what it refuses, what it sends back for each of the two views — and above all that no choice
 * in the address can widen what the person is allowed to see: the scope is spread at the top of the question, the
 * choices are ANDed onto it, and a person who may not read phones cannot confirm one by searching for it.
 */

const { db, requireContext, requirePermission, can, noteCustomersHandedOut } = vi.hoisted(() => ({
  db: {
    order: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
    deliveryProvider: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  can: vi.fn(),
  noteCustomersHandedOut: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: (...a: unknown[]) => requirePermission(...a),
  can: (...a: unknown[]) => can(...a),
}));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/commission', () => ({ reverseForOrder: vi.fn() }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: (...a: unknown[]) => noteCustomersHandedOut(...a) }));

import { GET } from '@/app/api/ops/returns/route';
import { PENDING_ORDER_BY, RECEIVED_ORDER_BY, noBarcodeWhere } from '@/lib/returns-filters';

const DAY = 86_400_000;
const COURIER = '22222222-2222-4222-8222-222222222222';
const clerk = { id: 'u-clerk', name: 'أمين المستودع', role: 'WAREHOUSE', status: 'ACTIVE' };
const get = (query = '') => GET(new Request(`http://localhost/api/ops/returns${query ? `?${query}` : ''}`));
const asked = () =>
  db.order.findMany.mock.calls.at(-1)![0] as { where: Record<string, any>; skip: number; take: number; orderBy: unknown[]; select: Record<string, any> };
const ago = (days: number) => new Date(Date.now() - days * DAY);

const line = { id: 'i1', productId: 'p1', productName: 'ماء الكمأ', quantity: 3, freeQuantity: 0, deliveredQty: null };
const pending = (over: Record<string, unknown> = {}) => ({
  id: 'o1',
  orderNumber: 'ORD-1',
  merchantRef: null,
  trackingNumber: 'TRK-1',
  shippingStatus: 'RETURNED',
  settlementStatus: 'NOT_APPLICABLE',
  returnReason: 'CUSTOMER_REFUSED',
  returnedAt: ago(5),
  failedAt: null,
  deliveredAt: null,
  updatedAt: ago(1),
  regionId: 'r1',
  deliveryProviderId: COURIER,
  customer: { fullName: 'سارة', phone: '0790000000' },
  region: { id: 'r1', name: 'عمّان' },
  deliveryProvider: { id: COURIER, name: 'ناقل' },
  items: [line],
  ...over,
});

const received = (over: Record<string, unknown> = {}) => ({
  ...pending({ returnedAt: ago(9), shippingStatus: 'RETURNED' }),
  returnReceipt: {
    expectedQty: 3, receivedQty: 2, damagedQty: 1, missingQty: 0, courierFeeCharged: true,
    inspectedById: 'u-insp', inspectedAt: ago(2), note: 'علبة مفتوحة',
  },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: clerk, companyId: 'c1', storeId: 's1' });
  requirePermission.mockResolvedValue(clerk);
  can.mockReturnValue(true);
  db.order.findMany.mockResolvedValue([]);
  db.order.count.mockResolvedValue(0);
  db.order.groupBy.mockResolvedValue([]);
  db.deliveryProvider.findMany.mockResolvedValue([]);
  db.user.findMany.mockResolvedValue([]);
});

describe('what it asks for', () => {
  it('— with nothing chosen: this company, this store, the four states, no receipt, oldest first, 25 from the start', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const q = asked();
    expect(q.where).toMatchObject({
      companyId: 'c1',
      storeId: 's1',
      shippingStatus: { in: ['RETURN_REQUESTED', 'RETURNED', 'FAILED_DELIVERY', 'PARTIALLY_DELIVERED'] },
      returnReceipt: null,
    });
    expect(q.where.AND).toEqual([]);
    expect(q).toMatchObject({ skip: 0, take: 25 });
    expect(q.orderBy).toEqual(PENDING_ORDER_BY);
  });

  it('and only whoever may work the desk reads it — the permission is asked by name, and a refusal is a 403 with nothing read', async () => {
    requirePermission.mockRejectedValue(new Error('Forbidden: missing required permission ops.returns'));
    expect((await get()).status).toBe(403);
    expect(requirePermission).toHaveBeenCalledWith('ops.returns');
    expect(db.order.findMany).not.toHaveBeenCalled();
    expect(db.order.count).not.toHaveBeenCalled();
    expect(db.order.groupBy).not.toHaveBeenCalled();
  });

  it('and every word chosen is one more thing that must hold, ANDed onto the scope — never in place of it', async () => {
    await get(`status=FAILED_DELIVERY&courier=${COURIER}&age=week&q=TRK`);
    expect(asked().where.AND).toHaveLength(4);
    expect(asked().where).toMatchObject({ companyId: 'c1', storeId: 's1', returnReceipt: null });
  });

  it('and a filter that names another company is still inside this one', async () => {
    await get(`courier=${'33333333-3333-4333-8333-333333333333'}`);
    expect(asked().where.companyId).toBe('c1');
    expect(asked().where.storeId).toBe('s1');
  });

  it('and the other view asks for what was counted in: a receipt that exists, latest count first, with the receipt selected', async () => {
    await get('view=received');
    const q = asked();
    expect(q.where).toMatchObject({ companyId: 'c1', storeId: 's1', returnReceipt: { isNot: null } });
    expect(q.where.shippingStatus).toBeUndefined();
    expect(q.orderBy).toEqual(RECEIVED_ORDER_BY);
    expect(q.select.returnReceipt.select).toMatchObject({ receivedQty: true, damagedQty: true, missingQty: true, inspectedById: true, inspectedAt: true });
  });

  it('and the waiting view does not select the receipt it is defined by not having', async () => {
    await get();
    expect(asked().select.returnReceipt).toBeUndefined();
  });

  it('and «بلا باركود» is one more thing that must hold — null or blank — in either view, with the scope still on top', async () => {
    for (const [query, scope] of [
      ['barcode=none', { returnReceipt: null }],
      ['view=received&barcode=none', { returnReceipt: { isNot: null } }],
    ] as const) {
      await get(query);
      const q = asked();
      expect(q.where, query).toMatchObject({ companyId: 'c1', storeId: 's1', ...scope });
      expect(q.where.AND, query).toEqual([noBarcodeWhere]);
    }
    // …and asked for nothing, it is not there at all.
    await get('barcode=all');
    expect(asked().where.AND).toEqual([]);
  });

  it('and it is one question with the company: both are ANDed, each by its own word', async () => {
    await get(`courier=${COURIER}&barcode=none`);
    expect(asked().where.AND).toEqual([{ deliveryProviderId: COURIER }, noBarcodeWhere]);
  });
});

describe('whose phone the search may confirm', () => {
  const searchFields = () => (asked().where.AND[0] as { OR: Record<string, any>[] }).OR.flatMap((c) => (c.customer ? Object.keys(c.customer) : Object.keys(c)));

  it('— a person who may read phones searches them, and the name', async () => {
    can.mockReturnValue(true);
    await get('q=0791234567');
    expect(searchFields().sort()).toEqual(['fullName', 'merchantRef', 'orderNumber', 'phone', 'rawPhone', 'trackingNumber']);
  });

  it('and one who may NOT is not given a phone-to-parcel oracle: the same search asks the name and the codes only', async () => {
    can.mockReturnValue(false);
    await get('q=0791234567');
    expect(searchFields().sort()).toEqual(['fullName', 'merchantRef', 'orderNumber', 'trackingNumber']);
    expect(can).toHaveBeenCalledWith(clerk, 'customers.view');
  });

  it('and the same holds in the record of what was counted in', async () => {
    can.mockReturnValue(false);
    await get('view=received&q=0791234567');
    expect(searchFields()).not.toContain('phone');
    expect(searchFields()).not.toContain('rawPhone');
  });

  it('and the rows are redacted the same way: no phone, no address, to a person who may not read them — in both views', async () => {
    can.mockReturnValue(false);
    db.order.findMany.mockResolvedValue([pending({ customer: { fullName: 'سارة', phone: '0790000000', address: 'شارع 1' } })]);
    const w = (await (await get()).json()).orders[0].customer;
    expect(w).toEqual({ fullName: 'سارة' });
    db.order.findMany.mockResolvedValue([received({ customer: { fullName: 'سارة', phone: '0790000000', address: 'شارع 1' } })]);
    const r = (await (await get('view=received')).json()).orders[0].customer;
    expect(r).toEqual({ fullName: 'سارة' });
  });

  it('and a person who may read them gets them', async () => {
    can.mockReturnValue(true);
    db.order.findMany.mockResolvedValue([pending()]);
    expect((await (await get()).json()).orders[0].customer.phone).toBe('0790000000');
  });
});

describe('what it refuses', () => {
  it.each([
    ['view=everything', 'العرض غير معروف: everything'],
    ['status=SHIPPED', 'الحالة غير معروف: SHIPPED'],
    ['courier=dhl', 'شركة الشحن غير معروف: dhl'],
    ['age=yesterday', 'العمر غير معروف: yesterday'],
    ['barcode=with', 'فلتر الباركود غير معروف: with'],
  ])('— %s: 400, in Arabic, and nothing was read', async (query, arabic) => {
    const res = await get(query);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errorAr).toBe(arabic);
    expect(body.error).toMatch(/^Unknown /);
    expect(db.order.findMany).not.toHaveBeenCalled();
    expect(db.order.count).not.toHaveBeenCalled();
  });
});

describe('the page', () => {
  it('— page and size come from the address, the size capped at a hundred; words are the default', async () => {
    db.order.count.mockResolvedValue(500);
    await get('page=3&limit=10');
    expect(asked()).toMatchObject({ skip: 20, take: 10 });
    await get('page=2&limit=1000');
    expect(asked()).toMatchObject({ skip: 100, take: 100 });
    await get('page=abc&limit=xyz');
    expect(asked()).toMatchObject({ skip: 0, take: 25 });
  });

  it('and a page past the end is answered with the last, and the body says which — `count` is what is ON the page, `total` is how many there are', async () => {
    // The page's own count is asked first; the numbers beside the options are asked after it.
    db.order.count.mockResolvedValueOnce(60).mockResolvedValue(7);
    db.order.findMany.mockResolvedValue([pending()]);
    const body = await (await get('page=99999')).json();
    expect(body.pagination).toEqual({ total: 60, page: 3, limit: 25, totalPages: 3 });
    expect(body.count).toBe(1);
    expect(asked().skip).toBe(50);
  });

  it('and the numbers beside the options come back with it, over the same scope — and say what was applied', async () => {
    const body = await (await get('view=received&courier=none')).json();
    expect(Object.keys(body.facts)).toEqual(['views', 'statuses', 'couriers', 'ages', 'noBarcode']);
    expect(Object.keys(body.facts.views)).toEqual(['pending', 'received']);
    for (const [arg] of db.order.count.mock.calls) expect((arg as { where: Record<string, unknown> }).where).toMatchObject({ companyId: 'c1', storeId: 's1' });
    expect(body.applied).toEqual({ view: 'received', status: null, courier: 'none', age: null, q: null });
  });

  it('and «بلا باركود (N)» is counted over the OPEN view, with the scope on top — so choosing it brings exactly N rows', async () => {
    db.order.count.mockImplementation(async ({ where }: { where: Record<string, any> }) => ((where.AND ?? []).includes(noBarcodeWhere) ? 7 : 0));
    for (const [view, scope] of [
      ['pending', { returnReceipt: null }],
      ['received', { returnReceipt: { isNot: null } }],
    ] as const) {
      db.order.count.mockClear();
      const body = await (await get(`view=${view}`)).json();
      expect(body.facts.noBarcode, view).toBe(7);
      const asks = db.order.count.mock.calls.map((c) => (c[0] as { where: Record<string, any> }).where).filter((w) => (w.AND ?? []).includes(noBarcodeWhere));
      expect(asks, view).toHaveLength(1);
      expect(asks[0], view).toMatchObject({ companyId: 'c1', storeId: 's1', ...scope });
    }
  });

  it('and what was applied says the barcode only when it was asked', async () => {
    expect((await (await get('barcode=none')).json()).applied).toEqual({ view: 'pending', status: null, courier: null, age: null, q: null, barcode: 'none' });
    expect((await (await get()).json()).applied).not.toHaveProperty('barcode');
  });

  it('and the contact details handed out are tallied for the page that was sent, in either view', async () => {
    db.order.findMany.mockResolvedValue([pending({ id: 'a' }), pending({ id: 'b' })]);
    await get();
    expect(noteCustomersHandedOut).toHaveBeenCalledTimes(1);
    expect(noteCustomersHandedOut.mock.calls[0][0].rows.map((r: { id: string }) => r.id)).toEqual(['a', 'b']);
    expect(noteCustomersHandedOut.mock.calls[0][0]).toMatchObject({ companyId: 'c1', storeId: 's1' });
    await get('view=received');
    expect(noteCustomersHandedOut).toHaveBeenCalledTimes(2);
  });
});

describe('a waiting parcel, as sent', () => {
  it('— says how many whole days it has waited, from the first column that has a moment: the return date, the failed delivery, the part-delivery, the last write', async () => {
    db.order.findMany.mockResolvedValue([
      pending({ id: 'a', returnedAt: ago(5), failedAt: ago(30) }),
      pending({ id: 'b', returnedAt: null, failedAt: ago(3) }),
      pending({ id: 'c', returnedAt: null, failedAt: null, deliveredAt: ago(2) }),
      pending({ id: 'd', returnedAt: null, failedAt: null, deliveredAt: null, updatedAt: ago(0) }),
    ]);
    const { orders } = await (await get()).json();
    expect(orders.map((o: { daysWaited: number }) => o.daysWaited)).toEqual([5, 3, 2, 0]);
  });

  it('and the other three dates are read to say it, and not sent — one fact, one shape', async () => {
    db.order.findMany.mockResolvedValue([pending()]);
    const [o] = (await (await get()).json()).orders;
    for (const field of ['failedAt', 'deliveredAt', 'updatedAt', 'items', 'returnReceipt']) expect(o[field], field).toBeUndefined();
    expect(asked().select).toMatchObject({ failedAt: true, deliveredAt: true, updatedAt: true });
  });

  it('and it carries the desk’s own figures: what is due back, the lines, the completion and the extra question', async () => {
    db.order.findMany.mockResolvedValue([pending()]);
    const [o] = (await (await get()).json()).orders;
    expect(o.expectedQty).toBe(3);
    expect(o.lines).toHaveLength(1);
    expect(o.completion.complete).toBe(false);
    expect(o).toHaveProperty('action');
  });
});

describe('a parcel that was counted in, as sent', () => {
  it('— says what was counted, by whom — by NAME — and when', async () => {
    db.order.findMany.mockResolvedValue([received()]);
    db.user.findMany.mockResolvedValue([{ id: 'u-insp', name: 'منى' }]);
    const [o] = (await (await get('view=received')).json()).orders;
    expect(o.receipt).toMatchObject({
      expectedQty: 3, receivedQty: 2, damagedQty: 1, missingQty: 0, courierFeeCharged: true, inspectedBy: 'منى', note: 'علبة مفتوحة',
    });
    expect(typeof o.receipt.inspectedAt).toBe('string');
  });

  it('and is a RECORD: no lines, no due-back figure, no extra question, no completion — nothing here can be received again', async () => {
    db.order.findMany.mockResolvedValue([received()]);
    const [o] = (await (await get('view=received')).json()).orders;
    for (const field of ['lines', 'expectedQty', 'action', 'completion', 'items', 'daysWaited', 'returnReceipt']) expect(o[field], field).toBeUndefined();
  });

  it('and the inspectors’ names are looked up ONCE, for the page’s own ids, in this company', async () => {
    db.order.findMany.mockResolvedValue([
      received({ id: 'a' }),
      received({ id: 'b', returnReceipt: { ...received().returnReceipt, inspectedById: 'u-other' } }),
      received({ id: 'c' }),
    ]);
    await get('view=received');
    expect(db.user.findMany).toHaveBeenCalledTimes(1);
    const arg = db.user.findMany.mock.calls[0][0];
    expect(arg.where.companyId).toBe('c1');
    expect([...arg.where.id.in].sort()).toEqual(['u-insp', 'u-other']);
  });

  it('and an inspector who is no longer on the list is nobody — not a crash, not another person’s name', async () => {
    db.order.findMany.mockResolvedValue([received()]);
    db.user.findMany.mockResolvedValue([]);
    const [o] = (await (await get('view=received')).json()).orders;
    expect(o.receipt.inspectedBy).toBeNull();
  });

  it('and the waiting view looks up nobody', async () => {
    db.order.findMany.mockResolvedValue([pending()]);
    await get();
    expect(db.user.findMany).not.toHaveBeenCalled();
  });
});
