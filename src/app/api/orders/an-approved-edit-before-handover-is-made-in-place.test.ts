import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CourierRefusal } from '@/lib/couriers/logestechs';

const { db, requireContext, authorize, can, logAudit, adapterFor, planLineApply } = vi.hoisted(() => ({
  db: {
    order: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    orderChannel: { findFirst: vi.fn() },
    shippingBatch: { findFirst: vi.fn() },
    customer: { update: vi.fn() },
    orderNote: { create: vi.fn(async () => ({})) },
    orderAddOn: { findMany: vi.fn(async () => []) },
    orderItem: { findFirst: vi.fn() },
    product: { findFirst: vi.fn() },
    deliveryProvider: { findFirst: vi.fn() },
    orderStatusLog: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
    orderChangeRequest: { findFirst: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  authorize: vi.fn(),
  can: vi.fn(),
  logAudit: vi.fn(),
  adapterFor: vi.fn(),
  // The plan for the goods of an approved request (see the note on the second describe): this file's order is one the plan
  // leaves to the older rules — more than one line, so the shorthand cannot be translated into an edit of ONE line.
  planLineApply: vi.fn(async () => ({ ok: true as const, apply: null })),
}));

let ORDER: Record<string, unknown>;

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/authorization', () => ({
  authorize: (...a: unknown[]) => authorize(...a),
  can: (...a: unknown[]) => can(...a),
  getPermissionScope: () => ({ scope: 'ALL_COMPANY' }),
}));
vi.mock('@/lib/rbac', () => ({
  assertOrderAccess: async () => ({ allowed: true, order: ORDER }),
  orderVisibilityWhere: () => ({}),
}));
vi.mock('@/lib/order-line-apply', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  planLineApply: (...a: unknown[]) => (planLineApply as (...x: unknown[]) => unknown)(...a),
}));
vi.mock('@/lib/couriers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  adapterFor: (...a: unknown[]) => adapterFor(...a),
}));

import { PATCH } from './[id]/route';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * AN APPROVED EDIT, BEFORE THE COMPANY TOOK THE PARCEL, IS MADE IN PLACE.
 *
 * The owner, 28/10: «قبل التسليم: نفس الطلب». A printed waybill used to seal
 * an approved request just like a pressed trolley did, and the answer was «tell
 * the courier» — for a box still on our own floor. Now, until «إغلاق الشحنة —
 * سُلّمت للشركة», the approved edit is written on the SAME order (no
 * replacement, no cancel-and-reorder), and the waybill that no longer matches
 * it is cleared so it is printed again. A parcel the company already has a
 * barcode for is cancelled THERE first.
 *
 * Every claim has its negative: a direct edit with no decision is still
 * refused, a pressed trolley still owes the courier a message, and an order
 * with no waybill has nothing to reprint.
 *
 * (old → new, review of #68) The first version of this file asserted that a QUANTITY
 * edit on a packed parcel is made in place (200, the order's `quantity` written,
 * the waybill cleared). That pinned a half-edit: this door writes the order's columns and
 * leaves its lines and the units reserved against them, so the shelf keeps counting
 * the OLD goods and the next sale can be oversold — and #68 opened that road for a
 * labelled parcel while closing `reorder`, the one door that made a replacement with a
 * correct reservation. The owner's temporary ruling: a quantity or a product is NOT
 * made in place on a reserved order; the request stays approved-and-unapplied and the
 * answer says to cancel and create a new one. An address, a phone, a note or a discount
 * carry no goods and are still made in place.
 * ═══════════════════════════════════════════════════════════════════════
 */

const ORDER_ID = '11111111-2222-4333-8444-555555555555';
const REQUEST_ID = 'aaaaaaaa-1111-4222-8333-444444444444';

const patch = (body: unknown) =>
  PATCH(
    new Request(`http://localhost/api/orders/${ORDER_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: ORDER_ID }) }
  );

const approved = (over: Record<string, unknown> = {}) => ({
  id: REQUEST_ID, orderId: ORDER_ID, status: 'APPROVED', appliedAt: null,
  reason: 'الزبون انتقل لشقة جديدة', decisionNote: 'موافق',
  changes: { customerAddress: { from: 'شارع قديم', to: 'شارع جديد' } },
  ...over,
});

const activities = () => db.orderActivity.create.mock.calls.map((c: any[]) => c[0].data);
const written = () => db.order.updateMany.mock.calls[0][0] as { where: Record<string, any>; data: Record<string, any> };

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'owner', name: 'المالك', role: 'COMPANY_ADMIN' },
    companyId: 'c1', storeId: 's1',
    country: { minorUnit: 2, currencyCode: 'JOD' },
  });
  authorize.mockReturnValue({ allowed: false, reason: 'OUT_OF_SCOPE' });
  can.mockImplementation(() => true);
  // A packed, confirmed parcel with its waybill printed, on a trolley still being filled.
  ORDER = {
    id: ORDER_ID, companyId: 'c1', storeId: 's1', customerId: 'cu1', version: 3, orderNumber: 'SY-1',
    confirmationStatus: 'CONFIRMED', shippingStatus: 'READY_FOR_PICKUP', shippedAt: null,
    labelPrintedAt: new Date('2026-10-28T08:00:00Z'), shippingBatchId: 'b1', deliveryProviderId: 'co1',
    trackingNumber: null, courierSendStartedAt: null,
    claimedById: null, lockedById: null, lockExpiresAt: null, shippingCost: 3,
    quantity: 1, sellingPrice: 20, discountAmount: 0, totalAmount: 23, productId: 'p1',
    priceIncludesDelivery: false,
  };
  db.order.findUnique.mockResolvedValue(ORDER);
  db.shippingBatch.findFirst.mockResolvedValue({ status: 'READY', batchNumber: 'BATCH-7' });
  db.$transaction.mockImplementation(async (fn: never) =>
    typeof fn === 'function' ? (fn as (tx: unknown) => unknown)(db) : fn
  );
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.order.update.mockResolvedValue(ORDER);
  db.customer.update.mockResolvedValue({});
  db.orderActivity.create.mockResolvedValue({});
  db.orderChangeRequest.findFirst.mockResolvedValue(approved());
  db.orderChangeRequest.updateMany.mockResolvedValue({ count: 1 });
  // A confirmed, packed parcel has its goods reserved.
  db.orderItem.findFirst.mockResolvedValue({ id: 'line-1' });
  db.deliveryProvider.findFirst.mockResolvedValue({ name: 'أرامكس', phone: '0700000000' });
  adapterFor.mockReturnValue({ automated: false, code: 'MANUAL', name: 'يدوي' });
});

describe('an approved edit on a parcel the company has not taken', () => {
  it('goes through with NO courier message — there is no courier to tell', async () => {
    const res = await patch({ expectedVersion: 3, changeRequestId: REQUEST_ID });

    expect(res.status, await res.clone().text()).toBe(200);
    expect(db.customer.update).toHaveBeenCalled();
    expect(JSON.stringify(db.customer.update.mock.calls)).toContain('شارع جديد');
  });

  it('is written on the SAME order — the one update is for this id, and nothing is replaced', async () => {
    await patch({ expectedVersion: 3, changeRequestId: REQUEST_ID });

    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
    expect(written().where).toMatchObject({ id: ORDER_ID, version: 3 });
    expect(JSON.stringify(activities().map((a: any) => a.action))).not.toContain('CHANGE_REQUEST_REORDERED');
    expect(JSON.stringify(activities().map((a: any) => a.metadata))).not.toContain('REPLACE');
  });

  it('clears the printed waybill in the same write, and says on the order that it is printed again', async () => {
    await patch({ expectedVersion: 3, changeRequestId: REQUEST_ID });

    expect(written().data.labelPrintedAt).toBeNull();
    const stale = activities().find((a: any) => a.action === 'LABEL_STALE_REPRINT');
    expect(stale.orderId).toBe(ORDER_ID);
    expect(JSON.parse(stale.metadata)).toMatchObject({ fields: ['customerAddress'], requestId: REQUEST_ID });
  });

  it('a DISCOUNT (carries no goods) is made in place too, with the waybill reprinted', async () => {
    db.orderChangeRequest.findFirst.mockResolvedValue(approved({ changes: { discountAmount: { from: 0, to: 2 } } }));

    const res = await patch({ expectedVersion: 3, changeRequestId: REQUEST_ID });

    expect(res.status, await res.clone().text()).toBe(200);
    expect(written().data.discountAmount).toBe(2);
    expect(written().data.labelPrintedAt).toBeNull();
    expect(activities().some((a: any) => a.action === 'LABEL_STALE_REPRINT')).toBe(true);
  });

  it('NEGATIVE: an order with no printed waybill has nothing to reprint', async () => {
    ORDER = { ...ORDER, labelPrintedAt: null };
    db.order.findUnique.mockResolvedValue(ORDER);

    const res = await patch({ expectedVersion: 3, changeRequestId: REQUEST_ID });

    expect(res.status).toBe(200);
    expect(written().data).not.toHaveProperty('labelPrintedAt');
    expect(activities().some((a: any) => a.action === 'LABEL_STALE_REPRINT')).toBe(false);
  });

  it('NEGATIVE: a note is not for the driver — it resets nothing', async () => {
    db.orderChangeRequest.findFirst.mockResolvedValue(approved({ changes: { customerNotes: { from: '', to: 'ملاحظة' } } }));

    await patch({ expectedVersion: 3, changeRequestId: REQUEST_ID });

    if (db.order.updateMany.mock.calls.length > 0) expect(written().data).not.toHaveProperty('labelPrintedAt');
    expect(activities().some((a: any) => a.action === 'LABEL_STALE_REPRINT')).toBe(false);
  });

  it('NEGATIVE: the same edit made DIRECTLY, with no decision, is still refused by the seal', async () => {
    authorize.mockReturnValue({ allowed: true });
    // (old → new, 30/10) The person here holds every key the mock knows — and now one of them, `ops.edit_in_batch`, is the packing
    // table's own pen, which makes exactly this edit in place on an open trolley (prep-edit-in-batch.test.ts). This claim is about
    // everyone WITHOUT that key, so the mock no longer hands it out.
    can.mockImplementation((_user: unknown, key: string) => key !== 'ops.edit_in_batch');

    const res = await patch({ expectedVersion: 3, customerAddress: 'شارع جديد' });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ORDER_SEALED');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });
});

/*
 * (old → new, طلب التعديل متعدد الحقول ٤) THE PREMISE OF THIS BLOCK CHANGED, THE RULING DID NOT.
 *
 * It said «a quantity or a product on a reserved order is never made in place», because the door wrote the order's own
 * columns and left the lines and their reservation behind. That is now true of ONE case only: an order with MORE THAN ONE
 * line, where the shorthand («the quantity», «the price») cannot say which line it means. An order with exactly one line
 * has its shorthand translated into an edit of that line and applied whole — the lines, the reservation, the gift, the
 * total — and that is held in `an-approved-lines-edit-is-written-whole.test.ts`, against a database fake that runs the
 * real plan, the real engine and the real reservation.
 *
 * So the plan is stubbed here to answer what it answers for such an order — «not mine, leave it to the older rules» — and
 * every claim below is the old one, word for word: the refusal, its code, its sentence, the order of the checks, and the
 * negatives.
 */
describe('a quantity or a product is NOT made in place on a reserved order of more than one line (temporary ruling)', () => {
  const SENTENCE = 'تعديل الكمية أو المنتج لطلب محجوز بيحتاج إلغاء الطلب وإنشاء جديد — لسا ما في تعديل بمكانو.';

  it('a quantity: refused with the sentence, and NOTHING is written or applied', async () => {
    db.orderChangeRequest.findFirst.mockResolvedValue(approved({ changes: { quantity: { from: 1, to: 2 } } }));

    const res = await patch({ expectedVersion: 3, changeRequestId: REQUEST_ID });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('RESERVED_GOODS_EDIT');
    expect(body.error).toBe(SENTENCE);
    expect(db.order.updateMany, 'انكتبت كمية جديدة والحجز على القديمة').not.toHaveBeenCalled();
    expect(db.customer.update).not.toHaveBeenCalled();
    // The request stays as it is: approved, not applied.
    expect(db.orderChangeRequest.updateMany).not.toHaveBeenCalled();
    expect(activities().some((a: any) => a.action === 'LABEL_STALE_REPRINT')).toBe(false);
  });

  it('a product: refused the same way', async () => {
    db.orderChangeRequest.findFirst.mockResolvedValue(
      approved({ changes: { productId: { from: 'p1', to: '3f9a1c52-7b1e-4a2d-8c6f-0d5e8a4b1c37' } } })
    );

    const res = await patch({ expectedVersion: 3, changeRequestId: REQUEST_ID });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('RESERVED_GOODS_EDIT');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('is decided BEFORE the company is asked anything: a barcode is not cancelled for an edit that will not happen', async () => {
    ORDER = { ...ORDER, trackingNumber: 'LG-9', courierSendStartedAt: new Date() };
    db.order.findUnique.mockResolvedValue(ORDER);
    const cancelShipment = vi.fn(async () => undefined);
    adapterFor.mockReturnValue({ automated: true, code: 'LOGESTECHS', name: 'LogesTechs', cancelShipment });
    db.orderChangeRequest.findFirst.mockResolvedValue(approved({ changes: { quantity: { from: 1, to: 3 } } }));

    const res = await patch({ expectedVersion: 3, changeRequestId: REQUEST_ID });

    expect(res.status).toBe(409);
    expect(cancelShipment).not.toHaveBeenCalled();
  });

  it('NEGATIVE: an address is still made in place on the same reserved order', async () => {
    const res = await patch({ expectedVersion: 3, changeRequestId: REQUEST_ID });

    expect(res.status, await res.clone().text()).toBe(200);
    expect(db.customer.update).toHaveBeenCalled();
    expect(db.orderItem.findFirst, 'سأل عن الحجز لتعديل ما فيه بضاعة').not.toHaveBeenCalled();
  });

  it('NEGATIVE: a phone and a note are made in place too', async () => {
    db.orderChangeRequest.findFirst.mockResolvedValue(approved({ changes: { customerNotes: { from: '', to: 'قبل الظهر' } } }));

    const res = await patch({ expectedVersion: 3, changeRequestId: REQUEST_ID });

    expect(res.status, await res.clone().text()).toBe(200);
  });

  it('NEGATIVE: an order with no reservation (not yet confirmed) changes its quantity in place as before', async () => {
    db.orderItem.findFirst.mockResolvedValue(null);
    db.orderChangeRequest.findFirst.mockResolvedValue(approved({ changes: { quantity: { from: 1, to: 2 } } }));

    const res = await patch({ expectedVersion: 3, changeRequestId: REQUEST_ID });

    expect(res.status, await res.clone().text()).toBe(200);
    expect(written().data.quantity).toBe(2);
    expect(db.orderItem.findFirst.mock.calls[0][0].where).toMatchObject({ orderId: ORDER_ID, reservedQty: { gt: 0 } });
  });

  it('NEGATIVE: a quantity the request leaves as it is asks for nothing', async () => {
    db.orderChangeRequest.findFirst.mockResolvedValue(approved({ changes: { quantity: { from: 1, to: 1 }, customerAddress: { to: 'شارع جديد' } } }));

    const res = await patch({ expectedVersion: 3, changeRequestId: REQUEST_ID });

    expect(res.status, await res.clone().text()).toBe(200);
  });
});

describe('once the company has the parcel — as before', () => {
  it('a pressed trolley still owes the courier a message', async () => {
    db.shippingBatch.findFirst.mockResolvedValue({ status: 'SHIPPED', batchNumber: 'BATCH-7' });

    const res = await patch({ expectedVersion: 3, changeRequestId: REQUEST_ID });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('COURIER_ACTION_REQUIRED');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('a parcel that left on its own (shippedAt) too', async () => {
    ORDER = { ...ORDER, shippingStatus: 'SHIPPED', shippedAt: new Date() };
    db.order.findUnique.mockResolvedValue(ORDER);

    const res = await patch({ expectedVersion: 3, changeRequestId: REQUEST_ID });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('COURIER_ACTION_REQUIRED');
  });

  it('and told, a pressed trolley’s order is written without touching its waybill', async () => {
    db.shippingBatch.findFirst.mockResolvedValue({ status: 'SHIPPED', batchNumber: 'BATCH-7' });

    const res = await patch({ expectedVersion: 3, changeRequestId: REQUEST_ID, courierNotified: true });

    expect(res.status).toBe(200);
    expect(written().data).not.toHaveProperty('labelPrintedAt');
  });
});

describe('a barcode the company already holds is cancelled there first', () => {
  const api = (cancelShipment: () => Promise<void>) => ({
    automated: true, code: 'LOGESTECHS', name: 'LogesTechs', cancelShipment: vi.fn(cancelShipment),
  });
  const barcoded = () => {
    ORDER = { ...ORDER, trackingNumber: 'LG-9', courierSendStartedAt: new Date() };
    db.order.findUnique.mockResolvedValue(ORDER);
  };

  it('on a clear yes: the barcode and the claim go in the same write, and the order is edited', async () => {
    barcoded();
    const adapter = api(async () => undefined);
    adapterFor.mockReturnValue(adapter);

    const res = await patch({ expectedVersion: 3, changeRequestId: REQUEST_ID });

    expect(res.status, await res.clone().text()).toBe(200);
    expect(adapter.cancelShipment).toHaveBeenCalledWith('LG-9');
    expect(written().data).toMatchObject({ trackingNumber: null, courierSendStartedAt: null, labelPrintedAt: null });
  });

  it('on their refusal: their words, and NOTHING is edited', async () => {
    barcoded();
    adapterFor.mockReturnValue(api(async () => { throw new CourierRefusal('x', 400, 'الطرد مع السائق'); }));

    const res = await patch({ expectedVersion: 3, changeRequestId: REQUEST_ID });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('COURIER_REFUSED');
    expect(body.error).toContain('الطرد مع السائق');
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.customer.update).not.toHaveBeenCalled();
  });

  it('on an answer nobody heard: nothing is edited', async () => {
    barcoded();
    adapterFor.mockReturnValue(api(async () => { throw new Error('timeout'); }));

    const res = await patch({ expectedVersion: 3, changeRequestId: REQUEST_ID });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('COURIER_UNSURE');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('is asked AFTER every other refusal — a bad request never cancels a company’s parcel', async () => {
    barcoded();
    const adapter = api(async () => undefined);
    adapterFor.mockReturnValue(adapter);
    db.orderChangeRequest.findFirst.mockResolvedValue(approved({ changes: { customerAddress: { to: 'x' }, offerId: { to: 'o2' } } }));

    const res = await patch({ expectedVersion: 3, changeRequestId: REQUEST_ID });

    expect(res.status).toBe(422);
    expect(adapter.cancelShipment, 'انلغى طرد الشركة وبعدين انرفض التعديل').not.toHaveBeenCalled();
  });

  it('if the company said yes and the write lost its race, the order says so — never silent', async () => {
    barcoded();
    adapterFor.mockReturnValue(api(async () => undefined));
    db.order.updateMany.mockResolvedValue({ count: 0 });

    await patch({ expectedVersion: 3, changeRequestId: REQUEST_ID });

    expect(activities().some((a: any) => a.action === 'COURIER_CANCELLED_ORDER_MOVED')).toBe(true);
  });

  it('NEGATIVE: a manual company (nobody to call) keeps its hand-typed barcode and is not asked anything', async () => {
    barcoded();

    const res = await patch({ expectedVersion: 3, changeRequestId: REQUEST_ID });

    expect(res.status, await res.clone().text()).toBe(200);
    expect(written().data).not.toHaveProperty('trackingNumber');
  });

  it('FAILS CLOSED when the trolley it names cannot be read', async () => {
    db.shippingBatch.findFirst.mockResolvedValue(null);

    const res = await patch({ expectedVersion: 3, changeRequestId: REQUEST_ID });

    expect(res.status).toBe(409);
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });
});
