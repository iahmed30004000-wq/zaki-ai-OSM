import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Nothing enters stock before the count-and-inspect acknowledgement. */

const { db, requireContext, requirePermission, logAudit, reverseForOrder } = vi.hoisted(() => ({
  reverseForOrder: vi.fn(async (..._a: unknown[]) => 1),
  db: {
    /*
     * `count` is here because the list is PAGED now: the heading says
     * «عرض ١٢ من ٨٧», and the second number is a count over the same
     * predicate the rows use. Without it the door throws before it ever
     * reaches the arithmetic these tests are about.
     */
    order: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), count: vi.fn(async () => 0), groupBy: vi.fn(async () => []) },
    // The numbers beside the filters, and the names of the page's couriers and inspectors (the-returns-list-is-filtered.test.ts).
    deliveryProvider: { findMany: vi.fn(async () => []) },
    user: { findMany: vi.fn(async () => []) },
    returnReceipt: { create: vi.fn() },
    inventoryMovement: { findFirst: vi.fn(), create: vi.fn() },
    productionBatch: { findFirst: vi.fn(), create: vi.fn(), aggregate: vi.fn() },
    orderItem: { updateMany: vi.fn() },
    // 27/11: a receipt of an order with add-ons releases their holds too.
    orderAddOn: { updateMany: vi.fn() },
    orderNote: { create: vi.fn() },
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

import { GET, POST } from '@/app/api/ops/returns/route';

const ORDER_ID = '77777777-7777-4777-8777-777777777777';
const body = (b: unknown) =>
  new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'Warehouse', role: 'WAREHOUSE', status: 'ACTIVE' },
    companyId: 'c1', storeId: 's1',
    country: { minorUnit: 3, currencyCode: 'JOD' },
  });
  requirePermission.mockResolvedValue({});
  db.order.findFirst.mockResolvedValue({
    id: ORDER_ID, orderNumber: 'ORD-1', shippingStatus: 'RETURN_REQUESTED',
    regionId: 'r1', deliveryProviderId: 'dp1', returnReceipt: null,
    items: [{ id: 'i1', productId: 'p1', productName: 'مقشر', quantity: 3, freeQuantity: 0 }],
  });
  db.returnReceipt.create.mockImplementation(async ({ data }: any) => ({ id: 'rr1', ...data }));
  // No RETURN movement for this order yet — receiving one twice must not
  // restore the goods twice.
  // The ledger answers TWO different questions here, and one stub cannot
  // tell them apart: "was this already returned?" (RETURN) and "did it ever
  // leave the shelf?" (SALE). The default order in these tests is one that
  // WAS delivered and has not come back yet.
  db.inventoryMovement.findFirst.mockImplementation(async ({ where }: any) =>
    where?.type === 'SALE' ? { id: 'sale-1' } : null
  );
  db.productionBatch.findFirst.mockResolvedValue({ costPerUnit: 4 });
  db.productionBatch.create.mockResolvedValue({ id: 'b-ret' });
  db.productionBatch.aggregate.mockResolvedValue({ _sum: { quantityRemaining: 12 } });
  db.orderItem.updateMany.mockResolvedValue({ count: 1 });
  db.order.update.mockResolvedValue({});
  db.orderNote.create.mockResolvedValue({});
  db.deliveryFee.findFirst.mockResolvedValue({ fee: '2', lateThresholdDays: 3, returnFee: '1.5' });
});

describe('return receiving', () => {
  it('refuses without the count-and-inspect acknowledgement, and writes no stock', async () => {
    const res = await POST(body({ orderId: ORDER_ID, receivedQty: 3 }));
    expect(res.status).toBe(400);
    expect(db.inventoryMovement.create).not.toHaveBeenCalled();
    expect(db.returnReceipt.create).not.toHaveBeenCalled();
  });

  it('computes the missing units instead of trusting a typed number', async () => {
    const res = await POST(body({ orderId: ORDER_ID, receivedQty: 1, damagedQty: 1, countedAndInspected: true }));
    expect(res.status).toBe(201);
    expect((await res.json()).missingQty).toBe(1);
    expect(db.returnReceipt.create.mock.calls[0][0].data).toMatchObject({ expectedQty: 3, missingQty: 1 });
  });

  it('restores only the sound units, after the acknowledgement', async () => {
    await POST(body({ orderId: ORDER_ID, receivedQty: 2, damagedQty: 1, countedAndInspected: true }));
    expect(db.inventoryMovement.create).toHaveBeenCalledTimes(1);
    expect(db.inventoryMovement.create.mock.calls[0][0].data).toMatchObject({ type: 'RETURN', quantity: 2, balanceAfter: 12 });
  });

  it('puts the sound units into a real batch, not only into the ledger', async () => {
    // A ledger line on its own moves nothing: stock lives in batches, and
    // without one the shipment screen keeps reporting a shortage for goods
    // the ledger says are back on the shelf.
    await POST(body({ orderId: ORDER_ID, receivedQty: 2, damagedQty: 1, countedAndInspected: true }));
    expect(db.productionBatch.create).toHaveBeenCalledTimes(1);
    expect(db.productionBatch.create.mock.calls[0][0].data).toMatchObject({
      // TWO units go back on the shelf, not three: the broken one does not.
      quantityRemaining: 2,
      quantitySold: 0,
      /**
       * AND THEY CARRY THE THIRD ONE'S MONEY.
       *
       * «إذا في توالف لازم تنقص من المخزون بس داخلة ضمن التكلفة تبع المخزون
       * للمنتج» — the owner's ruling. Three units at 4.00 left; the two that
       * survived come back holding all twelve, at 6.00 each. Writing the
       * broken one off instead would put 8.00 on the shelf and lose 4.00,
       * and every price set from that cost would under-recover.
       */
      totalProductionCost: 12,
      costPerUnit: 6,
    });
  });

  it('takes the courier return fee from the table, never from the receiver', async () => {
    const res = await POST(body({ orderId: ORDER_ID, receivedQty: 3, countedAndInspected: true, chargeCourierFee: true, courierFeeAmount: 999 }));
    expect((await res.json()).courierFeeAmount).toBe(1.5);
  });

  it('refuses more units than were shipped', async () => {
    const res = await POST(body({ orderId: ORDER_ID, receivedQty: 5, countedAndInspected: true }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('OVER_RECEIVED');
  });

  it('refuses a second receipt for the same order', async () => {
    db.order.findFirst.mockResolvedValue({
      id: ORDER_ID, orderNumber: 'ORD-1', returnReceipt: { id: 'rr0' }, items: [], regionId: 'r1', deliveryProviderId: 'dp1',
    });
    const res = await POST(body({ orderId: ORDER_ID, receivedQty: 1, countedAndInspected: true }));
    expect(res.status).toBe(409);
  });

  it('takes the commission back off, in the LEDGER', async () => {
    // The order was delivered, so the ledger accrued on it. Zeroing the
    // legacy `moderatorCommission` column — which is what this used to do —
    // left the ledger holding the full amount, so the month still paid
    // commission on goods that are back on the shelf.
    await POST(body({ orderId: ORDER_ID, receivedQty: 3, countedAndInspected: true }));
    expect(db.order.update.mock.calls[0][0].data).toMatchObject({ shippingStatus: 'RETURNED' });
    expect(reverseForOrder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orderId: ORDER_ID })
    );
  });

  it('reverses inside the same transaction as the receipt, so neither can land alone', async () => {
    await POST(body({ orderId: ORDER_ID, receivedQty: 3, countedAndInspected: true }));
    // `db` is what $transaction hands the callback in this mock; being
    // called with it is what says the reversal is inside.
    expect(reverseForOrder.mock.calls[0][0]).toBe(db);
  });

  it('does not write the retired per-order commission column at all', async () => {
    await POST(body({ orderId: ORDER_ID, receivedQty: 3, countedAndInspected: true }));
    expect(db.order.update.mock.calls[0][0].data).not.toHaveProperty('moderatorCommission');
  });
});

/**
 * NOTHING COMES BACK THAT NEVER LEFT.
 *
 * Stock is consumed at DELIVERY, not at dispatch. So a parcel refused at the
 * door never took its units out of any batch — and "restoring" them then
 * does not put stock back, it INVENTS it: a fresh batch of units the shelf
 * already holds. The figure climbs by a whole parcel every time one comes
 * back undelivered, which on a refusal-heavy week is most of them.
 */
describe('a return of goods that never left', () => {
  beforeEach(() => {
    // No SALE on this order: it was refused at the door, so nothing was ever
    // consumed for it.
    db.inventoryMovement.findFirst.mockResolvedValue(null);
  });

  it('creates no batch and no ledger line', async () => {
    await POST(body({ orderId: ORDER_ID, receivedQty: 3, countedAndInspected: true }));
    expect(db.productionBatch.create).not.toHaveBeenCalled();
    expect(db.inventoryMovement.create).not.toHaveBeenCalled();
  });

  it('still records the receipt — the count happened and is the record of it', async () => {
    // Refusing to restore stock is not refusing the return. The parcel was
    // counted and inspected; that fact is kept whatever the ledger says.
    const res = await POST(body({ orderId: ORDER_ID, receivedQty: 3, countedAndInspected: true }));
    expect(res.status).toBe(201);
    expect(db.returnReceipt.create).toHaveBeenCalledTimes(1);
  });

  it('asks the ledger, not the order’s status', async () => {
    // A status can be rewritten by a later path; the movement rows cannot.
    await POST(body({ orderId: ORDER_ID, receivedQty: 3, countedAndInspected: true }));
    const asked = db.inventoryMovement.findFirst.mock.calls.map((c: any) => c[0].where.type);
    expect(asked).toContain('SALE');
  });
});

/**
 * A PARTIAL DELIVERY'S REFUSED UNITS ARE A RETURN TOO.
 *
 * They left the warehouse with the parcel and the customer handed them back
 * to the courier. Until the desk could list the order, nobody counted them
 * in — and now that the door consumes the whole parcel, every refused unit
 * would be missing from stock permanently.
 */
describe('receiving what a partial delivery sent back', () => {
  const partial = (items: unknown[]) => {
    db.order.findFirst.mockResolvedValue({
      id: ORDER_ID, orderNumber: 'ORD-1', shippingStatus: 'PARTIALLY_DELIVERED',
      returnReceipt: null, regionId: 'r1', deliveryProviderId: 'dp1', items,
    });
  };

  it('expects only what the customer refused, not the whole parcel', async () => {
    // Three shipped, the customer kept two. One is coming back — and asking
    // for three would record two "missing" units the customer is holding and
    // has paid for, then put that shortfall on the courier's record.
    partial([{ id: 'i1', productId: 'p1', productName: 'X', quantity: 3, freeQuantity: 0, deliveredQty: 2 }]);
    const res = await POST(body({ orderId: ORDER_ID, receivedQty: 1, countedAndInspected: true }));
    expect(res.status).toBe(201);
    expect(db.returnReceipt.create.mock.calls[0][0].data).toMatchObject({ expectedQty: 1, missingQty: 0 });
  });

  it('refuses more units than were refused at the door', async () => {
    partial([{ id: 'i1', productId: 'p1', productName: 'X', quantity: 3, freeQuantity: 0, deliveredQty: 2 }]);
    const res = await POST(body({ orderId: ORDER_ID, receivedQty: 3, countedAndInspected: true }));
    expect((await res.json()).code).toBe('OVER_RECEIVED');
  });

  it('does NOT rewrite the order into a return', async () => {
    // It was partly delivered and the customer paid for what they kept.
    // Stamping RETURNED erases the delivery; NOT_APPLICABLE drops money the
    // courier is still holding out of everything that chases it.
    partial([{ id: 'i1', productId: 'p1', productName: 'X', quantity: 3, freeQuantity: 0, deliveredQty: 2 }]);
    await POST(body({ orderId: ORDER_ID, receivedQty: 1, countedAndInspected: true }));
    const data = db.order.update.mock.calls[0][0].data;
    expect(data.shippingStatus).toBeUndefined();
    expect(data.status).toBeUndefined();
    expect(data.settlementStatus).toBeUndefined();
  });

  it('still puts the refused units back on the shelf', async () => {
    partial([{ id: 'i1', productId: 'p1', productName: 'X', quantity: 3, freeQuantity: 0, deliveredQty: 2 }]);
    await POST(body({ orderId: ORDER_ID, receivedQty: 1, countedAndInspected: true }));
    // The door consumed the whole parcel, so a SALE exists and the restore
    // guard lets these through.
    expect(db.productionBatch.create).toHaveBeenCalledTimes(1);
  });

  it('a full return still becomes RETURNED, as it always did', async () => {
    await POST(body({ orderId: ORDER_ID, receivedQty: 3, countedAndInspected: true }));
    expect(db.order.update.mock.calls[0][0].data).toMatchObject({
      shippingStatus: 'RETURNED', status: 'RETURNED', settlementStatus: 'NOT_APPLICABLE',
    });
  });
});

/**
 * THIS DESK CLOSES ONE HALF.
 *
 *   «بصير الطلب بيتمم مرتين — مرة بيتمم للمستلم ومرة للطلب الراجع. واذا اتمم
 *    واحد فهو اتمم جزءي، ما بنغلق غير كامل»
 *
 * The receipt settles the goods. The money the customer paid at the door is
 * the courier's statement's to settle, and until it does the order is not
 * finished — a fact that was recorded in no column, no note and no response,
 * so the clerk who wrote the receipt left believing they had closed it.
 */
describe('a receipt closes one half of a partial delivery, and says so', () => {
  const partial = (deliveredQty: number, over: Record<string, unknown> = {}) => {
    db.order.findFirst.mockResolvedValue({
      id: ORDER_ID, orderNumber: 'ORD-1', shippingStatus: 'PARTIALLY_DELIVERED',
      settlementStatus: 'PENDING_COLLECTION',
      returnReceipt: null, regionId: 'r1', deliveryProviderId: 'dp1',
      items: [{ id: 'i1', productId: 'p1', productName: 'X', quantity: 3, freeQuantity: 0, deliveredQty }],
      ...over,
    });
  };

  it('reports the order as HALF settled, with the money still open', async () => {
    partial(2);
    const res = await POST(body({ orderId: ORDER_ID, receivedQty: 1, countedAndInspected: true }));
    const { completion } = await res.json();
    expect(completion.degree).toBe('PARTIAL');
    expect(completion.complete).toBe(false);
    expect(completion.awaiting).toEqual(['MONEY']);
  });

  it('writes the remaining half into the note thread a person actually reads', async () => {
    partial(2);
    await POST(body({ orderId: ORDER_ID, receivedQty: 1, countedAndInspected: true }));
    expect(db.orderNote.create.mock.calls[0][0].data.body).toContain('بانتظار');
  });

  it('and closes the order once the courier’s money has arrived too', async () => {
    // The receipt is the same receipt; what changed is the other half.
    partial(2, { settlementStatus: 'SETTLED' });
    const res = await POST(body({ orderId: ORDER_ID, receivedQty: 1, countedAndInspected: true }));
    const { completion } = await res.json();
    expect(completion.complete).toBe(true);
    expect(completion.degree).toBe('FULL');
    // Nothing left to chase, so the note says nothing about waiting.
    expect(db.orderNote.create.mock.calls[0][0].data.body).not.toContain('بانتظار');
  });

  it('a whole return is finished by its receipt — it has no money half', async () => {
    // Nothing was handed over, so nobody owes anything for it.
    const res = await POST(body({ orderId: ORDER_ID, receivedQty: 3, countedAndInspected: true }));
    const { completion } = await res.json();
    expect(completion.halves.map((h: { key: string }) => h.key)).toEqual(['GOODS']);
    expect(completion.complete).toBe(true);
  });

  it('records which half it closed in the audit trail', async () => {
    partial(2);
    await POST(body({ orderId: ORDER_ID, receivedQty: 1, countedAndInspected: true }));
    expect(logAudit.mock.calls[0][0].newData).toMatchObject({ completion: 'PARTIAL', awaiting: ['MONEY'] });
  });

  it('still refuses to rewrite the shipping status — the delivery happened', async () => {
    // Closing the goods half is not the same as turning the order into a
    // return. The completion is derived; no column is stamped for it.
    partial(2);
    await POST(body({ orderId: ORDER_ID, receivedQty: 1, countedAndInspected: true }));
    const data = db.order.update.mock.calls[0][0].data;
    expect(data.shippingStatus).toBeUndefined();
    expect(data.settlementStatus).toBeUndefined();
  });
});

/**
 * THE EXPECTED-BACK SUM IS WORKED OUT IN ONE PLACE.
 *
 * The route held its own `expectedBack`, and the screen listed every line at
 * its full shipped quantity. Two copies of one rule, and they disagreed on
 * exactly the case the owner asked about: the total said one unit was coming
 * back while the list beside it said three.
 */
describe('what is coming back is counted once', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

  it('the route reads the rule from the library instead of restating it', () => {
    const route = read('src/app/api/ops/returns/route.ts');
    expect(route).toContain('expectedBackTotal');
    // The old private copy, in the shape it had.
    expect(route).not.toMatch(/function expectedBack\s*\(/);
  });

  it('and the screen renders the server’s lines rather than the raw items', () => {
    const screen = read('src/components/screens/ReturnsScreen.tsx');
    expect(screen).toContain('order.lines.map');
    // «productName × quantity + freeQuantity» — the list that lied.
    expect(screen).not.toMatch(/i\.quantity \+ i\.freeQuantity/);
  });

  it('and the screen is told the completion rather than deriving it', () => {
    const screen = read('src/components/screens/ReturnsScreen.tsx');
    expect(screen).toContain('order.completion');
    expect(screen).not.toContain('MONEY_RESOLVED');
  });
});

/**
 * WHAT THE DESK IS HANDED BEFORE IT COUNTS.
 *
 * The list is what the clerk works from, so the per-line breakdown and the
 * extra question are decided here and not in the screen — the same division
 * the collect dialog uses, where the server sends `expectedCollection` and
 * the dialog adds it up rather than re-deriving it.
 */
describe('the returns list', () => {
  const listed = (items: unknown[], over: Record<string, unknown> = {}) => {
    db.order.findMany.mockResolvedValue([
      {
        id: ORDER_ID, orderNumber: 'ORD-1', merchantRef: null, trackingNumber: 'TRK-1',
        shippingStatus: 'PARTIALLY_DELIVERED', settlementStatus: 'PENDING_COLLECTION',
        returnReason: null, returnedAt: null, regionId: 'r1', deliveryProviderId: 'dp1',
        customer: { fullName: 'سارة', phone: '0900' },
        region: { id: 'r1', name: 'دمشق' },
        deliveryProvider: { id: 'dp1', name: 'ناقل' },
        items,
        ...over,
      },
    ]);
  };
  const get = () => GET(new Request('http://localhost/api/ops/returns'));
  const split = [{ id: 'i1', productId: 'p1', productName: 'ماء الكمأ', quantity: 3, freeQuantity: 0, deliveredQty: 2 }];

  it('sends the per-line breakdown, not only a total', async () => {
    listed(split);
    const { orders } = await (await get()).json();
    expect(orders[0].expectedQty).toBe(1);
    expect(orders[0].lines).toEqual([
      { itemId: 'i1', productId: 'p1', productName: 'ماء الكمأ', shipped: 3, delivered: 2, expectedBack: 1 },
    ]);
  });

  it('does not also send the raw items — one fact, one shape', async () => {
    // Shipping both invites the screen to reach for the list that lied.
    listed(split);
    const { orders } = await (await get()).json();
    expect(orders[0].items).toBeUndefined();
  });

  it('sends the extra question for a parcel the door split', async () => {
    listed(split);
    const { orders } = await (await get()).json();
    expect(orders[0].action.key).toBe('GOODS');
    expect(orders[0].action.yes).toContain('نعم');
  });

  it('and sends none for an announced return, whose flow is unchanged', async () => {
    listed([{ id: 'i1', productId: 'p1', productName: 'ماء الكمأ', quantity: 3, freeQuantity: 0, deliveredQty: null }]);
    const { orders } = await (await get()).json();
    expect(orders[0].action).toBeNull();
    expect(orders[0].lines[0].delivered).toBeNull();
    expect(orders[0].expectedQty).toBe(3);
  });

  it('counts the add-ons in the box, and the receipt accepts exactly the number the list showed (27/11)', async () => {
    const items = [{ id: 'i1', productId: 'p1', productName: 'ماء الكمأ', quantity: 2, freeQuantity: 0, deliveredQty: null }];
    const addOns = [{ id: 'a1', productId: 'p2', productName: 'صابون', quantity: 1 }];
    listed(items, { addOns });
    const { orders } = await (await get()).json();
    expect(orders[0].expectedQty).toBe(3);
    expect(orders[0].lines.map((l: { productName: string; expectedBack: number }) => [l.productName, l.expectedBack])).toEqual([
      ['ماء الكمأ', 2],
      ['صابون (إضافة)', 1],
    ]);
    // One fact, one shape: the raw add-ons are not sent beside the lines.
    expect(orders[0].addOns).toBeUndefined();

    db.order.findFirst.mockResolvedValue({
      id: ORDER_ID, orderNumber: 'ORD-1', shippingStatus: 'RETURN_REQUESTED', regionId: 'r1', deliveryProviderId: 'dp1',
      returnReceipt: null, items, addOns,
    });
    const over = await POST(body({ orderId: ORDER_ID, receivedQty: 4, countedAndInspected: true }));
    expect((await over.json()).code).toBe('OVER_RECEIVED');
    const res = await POST(body({ orderId: ORDER_ID, receivedQty: orders[0].expectedQty, countedAndInspected: true }));
    expect(res.status).toBe(201);
    expect((await res.json()).missingQty).toBe(0);
    expect(db.orderAddOn.updateMany).toHaveBeenCalledWith({ where: { orderId: ORDER_ID, reservedQty: { gt: 0 } }, data: { reservedQty: 0 } });
  });

  it('shows both halves as open — nothing in this list has been received yet', async () => {
    listed(split);
    const { orders } = await (await get()).json();
    expect(orders[0].completion.halves.map((h: { key: string }) => h.key)).toEqual(['MONEY', 'GOODS']);
    expect(orders[0].completion.complete).toBe(false);
  });
});
