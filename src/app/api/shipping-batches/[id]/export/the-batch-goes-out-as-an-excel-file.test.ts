import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readXlsxRows } from '@/lib/xlsx-reader';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE
 *
 * The owner, 31/10: BATCH-2026-0004 — 147 orders for الباشا — was closed before the dispatch sent them, so no order has
 * the courier's barcode, the waybill CSV and the print door refuse every one of them, and the parcels have to be made at
 * the courier's portal by hand: «بدي ياهم ملف اكسيل ضروري».
 *
 *  1. `GET /api/shipping-batches/:id/export` answers an .xlsx of EVERY order of the batch — with or without the courier's
 *     barcode, in any batch status — with the columns the dispatch sends the courier's API.
 *  2. It is a file of names, phones and addresses: it asks `ops.batches` AND `customers.view`, and counts the customers
 *     in the harvest tally. Without either key: 403 and nothing is read.
 *  3. The batch is read inside the session's company and store; another store's batch is a 404 and no order is read.
 *  4. The amount is the one the waybill prints (`waybillCod`) and is a NUMBER cell; the phone is the number as typed and
 *     stays text with its leading zero; a customer's «=…» stays text.
 *  5. An empty batch is refused, not answered with an empty file.
 *
 * Blockers: no money arithmetic changed (the amount is read, never computed here), no order written, no migration.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, can, noteCustomersHandedOut } = vi.hoisted(() => ({
  db: {
    shippingBatch: { findFirst: vi.fn() },
    order: { findMany: vi.fn() },
    deliveryFee: { findMany: vi.fn() },
  },
  requireContext: vi.fn(),
  can: vi.fn(),
  noteCustomersHandedOut: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ can: (...a: unknown[]) => can(...a), requirePermission: vi.fn() }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: (...a: unknown[]) => noteCustomersHandedOut(...a) }));

import { GET } from './route';

const ID = '99999999-9999-4999-8999-999999999999';
const call = (id = ID) => GET(new Request(`http://localhost/api/shipping-batches/${id}/export`), { params: Promise.resolve({ id }) });

const order = (n: number, over: Record<string, unknown> = {}) => ({
  id: `o${n}`, orderNumber: `ORD-2026-0${n}`, merchantRef: null, trackingNumber: null,
  totalAmount: 32.5, currency: 'USD', confirmationStatus: 'CONFIRMED', shippingStatus: 'READY_FOR_PICKUP',
  shippingBatchId: ID, deliveryProviderId: 'p1', regionId: 'r-sweida', priceIncludesDelivery: false,
  labelPrintedAt: null, createdAt: new Date('2026-10-30'), customerNotes: null, deliveryAddress: null,
  customer: { fullName: 'محمد', phone: '963991234567', rawPhone: '0991234567', altPhone: null, city: 'السويداء', address: 'حي المطار' },
  region: { name: 'السويداء' }, deliveryProvider: { name: 'الباشا' },
  items: [{ productName: 'كريم', quantity: 2, freeQuantity: 1, unitPrice: 10, discountShare: 0, lineTotal: 20 }],
  addOns: [],
  ...over,
});

const as = (keys: string[]) => {
  can.mockImplementation((_u: unknown, k: string) => keys.includes(k));
};

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'قباص' }, companyId: 'c1', storeId: 's1',
    country: { minorUnit: 2, currencyCode: 'USD', code: 'SY' },
  });
  as(['ops.batches', 'customers.view']);
  db.shippingBatch.findFirst.mockResolvedValue({ id: ID, batchNumber: 'BATCH-2026-0004', deliveryProviderId: 'p1' });
  db.order.findMany.mockResolvedValue([order(497), order(521, { trackingNumber: 'BSH123' })]);
  db.deliveryFee.findMany.mockResolvedValue([{ regionId: 'r-sweida', courierCityId: 445153 }]);
});

describe('the file', () => {
  it('is an .xlsx named by the batch number, never cached', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('spreadsheetml.sheet');
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="BATCH-2026-0004.xlsx"');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('lists EVERY order of the batch — the one with no barcode too — with what the dispatch sends the courier', async () => {
    const rows = readXlsxRows(Buffer.from(await (await call()).arrayBuffer()));
    expect(rows[0]).toEqual([
      'رقم الطلب', 'باركود الشركة', 'اسم المستلم', 'الهاتف', 'هاتف إضافي', 'المحافظة', 'رمز المدينة عند الشركة',
      'العنوان', 'المبلغ المطلوب', 'العملة', 'المحتويات', 'ملاحظات الزبون',
    ]);
    expect(rows).toHaveLength(3);
    // No barcode yet: the cell is empty, and the order is still in the file.
    expect(rows[1].slice(0, 3)).toEqual(['ORD-2026-0497', '', 'محمد']);
    expect(rows[2].slice(0, 3)).toEqual(['ORD-2026-0521', 'BSH123', 'محمد']);
    // The phone AS TYPED, with its zero; the courier's own id for the governorate; the amount; the box.
    expect(rows[1][3]).toBe('0991234567');
    expect(rows[1][5]).toBe('السويداء');
    expect(rows[1][6]).toBe('445153');
    expect(rows[1][8]).toBe('32.5');
    expect(rows[1][9]).toBe('USD');
    expect(rows[1][10]).toBe('كريم x3');
  });

  it('is built for a batch in ANY status — reading it commits nothing (no order is written)', async () => {
    // The route reads; the fake has no `update`, so a write would throw.
    expect((await call()).status).toBe(200);
    expect(Object.keys(db.order)).toEqual(['findMany']);
  });

  it('keeps a customer-typed «=…» as text, and the governorate id empty when the courier has none', async () => {
    db.order.findMany.mockResolvedValue([
      order(1, { regionId: 'r-other', customer: { fullName: '=HYPERLINK("x")', phone: '1', rawPhone: '0991111111', altPhone: null, city: 'x', address: 'a' } }),
    ]);
    const rows = readXlsxRows(Buffer.from(await (await call()).arrayBuffer()));
    expect(rows[1][2]).toBe('=HYPERLINK("x")');
    expect(rows[1][6] ?? '').toBe('');
  });

  it('the order is read inside the session company and store, and its batch is this one', async () => {
    await call();
    expect(db.shippingBatch.findFirst.mock.calls[0][0].where).toEqual({ id: ID, companyId: 'c1', storeId: 's1' });
    expect(db.order.findMany.mock.calls[0][0].where).toEqual({ shippingBatchId: ID, companyId: 'c1', storeId: 's1' });
  });

  it('the customers in it are counted in the harvest tally, once, before the file leaves', async () => {
    await call();
    expect(noteCustomersHandedOut).toHaveBeenCalledTimes(1);
    expect(noteCustomersHandedOut.mock.calls[0][0]).toMatchObject({ companyId: 'c1', storeId: 's1', where: 'ملف إكسل لدفعة شحن' });
    expect(noteCustomersHandedOut.mock.calls[0][0].rows).toHaveLength(2);
  });
});

describe('who may, and what is refused', () => {
  it('without the batches key: 403, and nothing is read', async () => {
    as(['customers.view']);
    const res = await call();
    expect(res.status).toBe(403);
    expect(db.shippingBatch.findFirst).not.toHaveBeenCalled();
    expect(db.order.findMany).not.toHaveBeenCalled();
    expect(noteCustomersHandedOut).not.toHaveBeenCalled();
  });

  it('without the address-book key: 403 in words, and no customer is read — the file is names and phones', async () => {
    as(['ops.batches']);
    const res = await call();
    expect(res.status).toBe(403);
    expect((await res.json()).errorAr).toContain('عرض العملاء');
    expect(db.order.findMany).not.toHaveBeenCalled();
    expect(noteCustomersHandedOut).not.toHaveBeenCalled();
  });

  it('another store’s batch is a 404 and no order is read', async () => {
    db.shippingBatch.findFirst.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(404);
    expect(db.order.findMany).not.toHaveBeenCalled();
    expect(noteCustomersHandedOut).not.toHaveBeenCalled();
  });

  it('an empty batch is refused, not answered with an empty file', async () => {
    db.order.findMany.mockResolvedValue([]);
    const res = await call();
    expect(res.status).toBe(409);
    expect(noteCustomersHandedOut).not.toHaveBeenCalled();
  });

  it('no store chosen: 400, nothing read', async () => {
    requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: null, country: { minorUnit: 2, code: 'SY' } });
    const res = await call();
    expect(res.status).toBe(400);
    expect(db.shippingBatch.findFirst).not.toHaveBeenCalled();
  });
});
