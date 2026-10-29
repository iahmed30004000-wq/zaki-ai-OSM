import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE DOOR CREATES TWO SETTLEMENTS AND SAYS SO.
 *
 *   «بصير الطلب بيتمم مرتين — مرة بيتمم للمستلم ومرة للطلب الراجع. واذا اتمم
 *    واحد فهو اتمم جزءي، ما بنغلق غير كامل»
 *
 * The person at this screen finishes their half and closes the dialog, so the
 * toast is the only moment they can be told there is a second one. It used to
 * read «تسليم جزئي — حُصِّل N», which says two wrong things at once: that
 * money was collected here (it is the courier's statement that writes money)
 * and that the order is done.
 */

const { db, requireContext, requirePermission, logAudit } = vi.hoisted(() => ({
  db: {
    orderItem: { findMany: vi.fn(), update: vi.fn() },
    order: { findFirst: vi.fn(), update: vi.fn() },
    orderActivity: { create: vi.fn() },
    orderNote: { create: vi.fn() },
    customer: { update: vi.fn() },
    deliveryAttempt: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({ id: 'a1', attemptNumber: 1 })) },
    $transaction: vi.fn(async (fn: any) => fn(db)),
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a), can: () => true }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/stock-consumption', () => ({ consumeOrderStock: vi.fn(async () => ({ taken: 0, short: 0 })) }));

import { POST } from './route';

const ORDER = '44444444-4444-4444-8444-444444444444';
const I1 = '55555555-5555-4555-8555-555555555555';

const post = (body: unknown) =>
  new Request('http://localhost/x', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/** One line of three units at 10 each, 5 delivery fee. */
const order = (over: Record<string, unknown> = {}) => ({
  id: ORDER,
  orderNumber: 'SY-2026-0148',
  shippingStatus: 'OUT_FOR_DELIVERY',
  deliveryFee: 5,
  priceIncludesDelivery: false,
  customerId: 'cust-1',
  deliveredAt: null,
  returnedAt: null,
  deliveryProviderId: 'dp1',
  settlementStatus: 'PENDING_COLLECTION',
  items: [{ id: I1, productId: 'p1', productName: 'ماء الكمأ', quantity: 3, freeQuantity: 0, unitPrice: 10, discountShare: 0, lineTotal: 30 }],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'متابعة', role: 'FOLLOW_UP', status: 'ACTIVE' },
    companyId: 'c1', storeId: 's1',
    country: { minorUnit: 2, currencyCode: 'SYP', allowNegativeStock: false },
  });
  requirePermission.mockResolvedValue({});
  db.order.findFirst.mockResolvedValue(order());
  db.order.update.mockResolvedValue({});
  db.orderItem.update.mockResolvedValue({});
  db.orderActivity.create.mockResolvedValue({});
  db.customer.update.mockResolvedValue({});
});

describe('a partial delivery is reported as half done', () => {
  const partial = () => post({ orderId: ORDER, lines: [{ itemId: I1, deliveredQty: 2 }] });

  it('returns both halves, neither of them settled', async () => {
    const res = await POST(partial());
    const out = await res.json();
    expect(out.status).toBe('PARTIALLY_DELIVERED');
    expect(out.deliveredUnits).toBe(2);
    expect(out.refusedUnits).toBe(1);
    expect(out.completion.halves.map((h: { key: string }) => h.key)).toEqual(['MONEY', 'GOODS']);
    expect(out.completion.complete).toBe(false);
  });

  it('never claims the refused units are already back on a shelf', async () => {
    // They are in the courier's van. The returns desk settles that half.
    const out = await (await POST(partial())).json();
    expect(out.completion.halves.find((h: { key: string }) => h.key === 'GOODS').settled).toBe(false);
  });

  it('says in the message that the order will not close on one half', async () => {
    const out = await (await POST(partial())).json();
    expect(out.message).toContain('بانتظار');
    // «المتوقَّع», not «حُصِّل»: nobody at this screen knows what money
    // arrived, and the door deliberately does not write it.
    expect(out.message).not.toContain('حُصِّل');
    expect(out.message).toContain('المتوقَّع');
  });

  it('counts the refused units in the message, in Western digits', async () => {
    const out = await (await POST(partial())).json();
    expect(out.message).toContain('1 قطعة راجعة');
    expect(out.message).not.toMatch(/[٠-٩]/);
  });

  it('records which half it left open in the audit trail', async () => {
    await POST(partial());
    expect(logAudit.mock.calls[0][0].newData).toMatchObject({ completion: 'NONE', awaiting: ['MONEY', 'GOODS'] });
  });
});

describe('the two outcomes that are not halved', () => {
  it('a whole delivery has one half — nothing is coming back', async () => {
    db.orderItem.findMany.mockResolvedValue([{ id: I1, quantity: 3, freeQuantity: 0 }]);
    const out = await (await POST(post({ orderId: ORDER, outcome: 'ALL' }))).json();
    expect(out.status).toBe('DELIVERED');
    expect(out.completion.halves.map((h: { key: string }) => h.key)).toEqual(['MONEY']);
  });

  it('and a whole delivery says what is EXPECTED, never that it was collected — delivering is not collecting', async () => {
    db.orderItem.findMany.mockResolvedValue([{ id: I1, quantity: 3, freeQuantity: 0 }]);
    const out = await (await POST(post({ orderId: ORDER, outcome: 'ALL' }))).json();
    expect(out.message).toContain('المتوقَّع');
    expect(out.message).toContain('بانتظار التحصيل');
    expect(out.message).not.toContain('حُصِّل');
  });

  it('a whole refusal has one half, and it is the goods', async () => {
    db.orderItem.findMany.mockResolvedValue([{ id: I1, quantity: 3, freeQuantity: 0 }]);
    const out = await (await POST(post({ orderId: ORDER, outcome: 'NONE' }))).json();
    expect(out.status).toBe('RETURNED');
    expect(out.completion.halves.map((h: { key: string }) => h.key)).toEqual(['GOODS']);
    expect(out.message).not.toContain('بانتظار');
  });
});

/**
 * THE PREVIEW — THE SAME DOOR, ASKED AND NOT TOLD.
 *
 * `DeliverDialog` showed the money a courier is about to be asked to
 * collect, and it worked the figure out itself: a loop over the lines, the
 * discount share spread back per unit, the fee added unless the price
 * already held it. `the-frontend-invariants.test.ts` carried that as the
 * last entry on its DIVERGED list, and the two copies disagreed —
 * measured, by running the real `doorMoney` against the screen's own
 * expression:
 *
 *   an order carrying a thank-you-page upsell   door 29.5   screen 24.5
 *   the same, one of two units refused          door 18.5   screen 13.5
 *   Syrian pounds, whole units                  door 21     screen 21.333…
 *
 * The upsell is the one that mattered: `OrderAddOn` has no `OrderItem`
 * row, so a loop over lines could not see it however carefully written.
 * The courier was told to collect five dinars less than the door records.
 *
 * So the browser stopped computing. These tests are the other half: the
 * door answers the question, and it answers it with the SAME arithmetic it
 * will use when the person presses the button.
 */
describe('asking what a delivery would collect', () => {
  it('answers the figures and writes absolutely nothing', async () => {
    const res = await POST(
      post({ orderId: ORDER, lines: [{ itemId: I1, deliveredQty: 3 }], preview: true })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // 3 × 10 = 30 of goods, plus the 5 fee.
    expect(body.preview).toEqual({
      goods: 30,
      addOns: 0,
      fee: 5,
      collected: 35,
      anythingTaken: true,
    });
    // THE WRITES, named one by one — a preview that settled a parcel would
    // be far worse than one that priced it wrongly.
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.order.update).not.toHaveBeenCalled();
    expect(db.orderItem.update).not.toHaveBeenCalled();
    expect(db.orderActivity.create).not.toHaveBeenCalled();
    expect(db.customer.update).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('and gives the SAME numbers the submit then records', async () => {
    /*
     * The whole point. A preview computed by a second expression would be
     * the same defect with the copy moved one file to the left, so the two
     * answers are compared rather than each checked against a literal.
     */
    const asked = await POST(
      post({ orderId: ORDER, lines: [{ itemId: I1, deliveredQty: 2 }], preview: true })
    );
    const preview = (await asked.json()).preview;

    vi.clearAllMocks();
    requireContext.mockResolvedValue({
      user: { id: 'u1', name: 'متابعة', role: 'FOLLOW_UP', status: 'ACTIVE' },
      companyId: 'c1', storeId: 's1',
      country: { minorUnit: 2, currencyCode: 'SYP', allowNegativeStock: false },
    });
    requirePermission.mockResolvedValue({});
    db.order.findFirst.mockResolvedValue(order());
    db.order.update.mockResolvedValue({});
    db.orderItem.update.mockResolvedValue({});
    db.orderActivity.create.mockResolvedValue({});
    db.customer.update.mockResolvedValue({});

    const done = await POST(post({ orderId: ORDER, lines: [{ itemId: I1, deliveredQty: 2 }] }));
    expect(done.status).toBe(200);
    /*
     * The settled figure is in the ACTIVITY, not on the order: the money
     * that lands on `collectedAmount` comes from the courier's statement,
     * and this file's own header says so. What the door records is what it
     * EXPECTS, and that is the number the dialog was printing.
     */
    const activity = JSON.parse(db.orderActivity.create.mock.calls[0][0].data.metadata);
    expect(preview.collected).toBe(activity.expectedCollection);
    // And not vacuously equal because both are zero: 2 of 3 units at 10,
    // plus the whole 5 fee.
    expect(preview.collected).toBe(25);
  });

  it('charges the fee in full on a partial, and waives it when nothing is kept', async () => {
    const partial = await POST(
      post({ orderId: ORDER, lines: [{ itemId: I1, deliveredQty: 1 }], preview: true })
    );
    const one = (await partial.json()).preview;
    // The courier travelled: 10 of goods and the whole 5.
    expect(one).toMatchObject({ goods: 10, fee: 5, collected: 15, anythingTaken: true });

    const none = await POST(
      post({ orderId: ORDER, lines: [{ itemId: I1, deliveredQty: 0 }], preview: true })
    );
    expect((await none.json()).preview).toMatchObject({
      goods: 0,
      fee: 0,
      collected: 0,
      anythingTaken: false,
    });
  });

  it('and the upsell the screen could never see is in the answer', async () => {
    // `OrderAddOn` has no line, so this is the figure no loop over `items`
    // could have produced. 30 of goods + 12 upsell + 5 fee.
    db.order.findFirst.mockResolvedValue(order({ addOns: [{ quantity: 1, price: 12 }] }));
    const res = await POST(
      post({ orderId: ORDER, lines: [{ itemId: I1, deliveredQty: 3 }], preview: true })
    );
    const body = (await res.json()).preview;
    expect(body.addOns).toBe(12);
    expect(body.collected, 'الزيادة التي لا سطرَ لها غابت عن الجواب').toBe(47);
    expect(body.collected).not.toBe(35);
  });

  it('refuses an order that is not this company’s, without pricing it', async () => {
    db.order.findFirst.mockResolvedValue(null);
    const res = await POST(
      post({ orderId: ORDER, lines: [{ itemId: I1, deliveredQty: 3 }], preview: true })
    );
    expect(res.status).toBe(404);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
