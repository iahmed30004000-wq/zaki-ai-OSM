import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * WHAT THE DRIVER IS TOLD — pieces (ط32), the address (ط47), the amount (ط48), and the stock of an add-on (ط43).
 *
 * ط32 — the pieces announced to the courier were the ORDER'S HEAD (one line), so a basket of three products announced
 *       the pieces of one and an add-on was never counted.
 * ط47 — a returning customer who typed a new street got a waybill printed with the OLD one: the customer row keeps
 *       the first address ever given. The order now keeps its own; the waybill, the courier and the CSV read it first.
 * ط48 — «٣ بـ 25»: the unit price is stored rounded (8.333), three of them are 24.999, and the courier was told to
 *       collect a fil less than the customer was quoted. The stored line value settles it, within the rounding only.
 * ط43 — an add-on short on the shelf was shipped for; `shipmentBlocks` now asks about it, in the words «إضافة».
 *
 * «اي قرار بعد الان اتخذو دون الرجوع الي» — decided: the stored line value is used ONLY when it lies within half a
 * minor unit per piece of quantity × unit price (the rounding the unit price could have lost); anything else keeps the
 * multiplication it always had. `computeCod` itself is not touched.
 */

const { db } = vi.hoisted(() => ({
  db: {
    order: { count: vi.fn() },
    orderAddOn: { aggregate: vi.fn(), findMany: vi.fn() },
    orderItem: { findMany: vi.fn(), aggregate: vi.fn() },
    productionBatch: { aggregate: vi.fn() },
    deliveryFee: { findFirst: vi.fn() },
    deliveryProvider: { findFirst: vi.fn() },
  },
}));
vi.mock('./db', () => ({ db }));

import { piecesInParcel } from './couriers/dispatch';
import { codForOrder } from './delivery-fees';
import { shipmentBlocks } from './operations';
import { toLabelView, WAYBILL_SELECT, type WaybillOrder } from './waybill';

describe('ط32 — the pieces in the box', () => {
  it('two lines (2 and 1) are 3, a gift counts, and an add-on of 2 adds 2', () => {
    expect(piecesInParcel({ items: [{ quantity: 2, freeQuantity: 0 }, { quantity: 1, freeQuantity: 0 }] })).toBe(3);
    expect(piecesInParcel({ items: [{ quantity: 2, freeQuantity: 1 }] })).toBe(3);
    expect(piecesInParcel({ items: [{ quantity: 2, freeQuantity: 0 }, { quantity: 1, freeQuantity: 0 }], addOns: [{ quantity: 2 }] })).toBe(5);
  });

  it('NEGATIVE: the head says one line\'s worth — it does not win over the lines', () => {
    expect(piecesInParcel({ quantity: 2, freeQuantity: 1, items: [{ quantity: 2, freeQuantity: 1 }, { quantity: 4, freeQuantity: 0 }] })).toBe(7);
  });

  it('NEGATIVE: an order from before lines existed still has its head to go on, plus its add-ons', () => {
    expect(piecesInParcel({ quantity: 2, freeQuantity: 1, items: [], addOns: [{ quantity: 1 }] })).toBe(4);
    expect(piecesInParcel({ quantity: 2, freeQuantity: 1 })).toBe(3);
  });

  it('and is never zero', () => {
    expect(piecesInParcel({ items: [{ quantity: 0, freeQuantity: 0 }] })).toBe(1);
  });

  it('the dispatch reads the lines and the add-ons from the database', async () => {
    const { repoFile } = await import('./guard-source');
    const src = repoFile('src/lib/couriers/dispatch.ts');
    expect(src).toContain('items: { select: { quantity: true, freeQuantity: true } }');
    expect(src).toContain('addOns: { select: { quantity: true } }');
    expect(src).toContain('pieces: piecesInParcel(order)');
  });
});

describe('ط48 — the amount from the stored line value', () => {
  const run = (lines: Parameters<typeof codForOrder>[0]['lines'], minorUnit = 3, deliveryFee = 2) =>
    codForOrder({ lines, deliveryFee, priceIncludesDelivery: false, minorUnit }).cod;

  it('«٣ بـ 25» dinars is 25.000 + the fee, not 24.999 + the fee', () => {
    // unitPrice stored at three decimals: 25 / 3 = 8.333
    expect(run([{ quantity: 3, unitPrice: 8.333, discountShare: 0, lineTotal: 25 }])).toBe(27);
  });

  it('with an offer\'s discount spread into the share, the value before it is the line total plus the share', () => {
    // 3 pieces listed at 30 (10 each), a reduction of 5 → lineTotal 25, share 5. Cod: 30 - 5 + 2.
    expect(run([{ quantity: 3, unitPrice: 10, discountShare: 5, lineTotal: 25 }])).toBe(27);
  });

  it('a two-decimal currency: 3 for 10.00 is 10.00, not 9.99', () => {
    expect(run([{ quantity: 3, unitPrice: 3.33, discountShare: 0, lineTotal: 10 }], 2, 1)).toBe(11);
  });

  it('NEGATIVE: an ordinary line (no rounding to settle) is exactly what it was', () => {
    expect(run([{ quantity: 2, unitPrice: 12.5, discountShare: 0, lineTotal: 25 }])).toBe(27);
    expect(run([{ quantity: 2, unitPrice: 12.5, discountShare: 0 }])).toBe(27);
  });

  it('NEGATIVE: a stored value far from quantity × price (an edited or imported line) is NOT trusted — the multiplication stands', () => {
    // A legacy row written with lineTotal 0 must not make the courier collect nothing.
    expect(run([{ quantity: 2, unitPrice: 12.5, discountShare: 0, lineTotal: 0 }])).toBe(27);
    // And one far above it does not inflate the amount.
    expect(run([{ quantity: 2, unitPrice: 12.5, discountShare: 0, lineTotal: 90 }])).toBe(27);
  });

  it('NEGATIVE: the add-ons and the fee are untouched', () => {
    const cod = codForOrder({
      lines: [{ quantity: 3, unitPrice: 8.333, discountShare: 0, lineTotal: 25 }],
      addOns: [{ quantity: 1, price: 15 }],
      deliveryFee: 2,
      priceIncludesDelivery: false,
      minorUnit: 3,
    }).cod;
    expect(cod).toBe(42);
  });
});

describe('ط47 — the waybill takes the parcel\'s own address first', () => {
  const orderRow = (over: Record<string, unknown> = {}) => ({
    id: 'o1', orderNumber: 'SY-1', merchantRef: 'SY-1', trackingNumber: 'BC-1', totalAmount: 30, currency: 'SYP',
    shippingBatchId: 'b1', deliveryProviderId: 'p1', regionId: 'r1', priceIncludesDelivery: false,
    customerNotes: null, deliveryAddress: null,
    customer: { fullName: 'زبون', phone: '944', rawPhone: '0944', altPhone: null, city: 'حلب', address: 'العنوان القديم' },
    region: { name: 'حلب' }, deliveryProvider: { name: 'شركة' },
    items: [{ productName: 'شامبو', quantity: 1, freeQuantity: 0, unitPrice: 30, discountShare: 0, lineTotal: 30 }],
    addOns: [],
    ...over,
  }) as unknown as WaybillOrder;

  it('the new street the visitor typed is the one printed', async () => {
    const view = await toLabelView(orderRow({ deliveryAddress: 'العنوان الجديد' }), 2);
    expect(view.place).toContain('العنوان الجديد');
    expect(view.place).not.toContain('العنوان القديم');
  });

  it('NEGATIVE: an order with no address of its own (or an older one) prints the customer\'s, as before', async () => {
    const view = await toLabelView(orderRow(), 2);
    expect(view.place).toContain('العنوان القديم');
  });

  it('the select reads the column, and the CSV and the courier read it before the customer\'s', async () => {
    const { repoFile } = await import('./guard-source');
    expect(Object.keys(WAYBILL_SELECT)).toContain('deliveryAddress');
    expect(repoFile('src/app/api/ops/labels/print/route.ts')).toContain('o.deliveryAddress ?? o.customer.address');
    expect(repoFile('src/lib/couriers/dispatch.ts')).toContain('order.deliveryAddress ?? order.customer?.address');
  });

  it('and a staff correction of the address is written on the order, so it is not hidden behind the typed one', async () => {
    const { repoFile } = await import('./guard-source');
    expect(repoFile('src/app/api/orders/[id]/route.ts')).toContain('updateData.deliveryAddress = customerAddress;');
  });
});

describe('ط43 — the stock of an add-on', () => {
  const order = { id: 'o1', companyId: 'c1', storeId: 's1', customerId: 'cu1', regionId: 'r1', deliveryProviderId: 'dp1' };

  beforeEach(() => {
    vi.clearAllMocks();
    db.order.count.mockResolvedValue(0);
    db.deliveryFee.findFirst.mockResolvedValue({ id: 'f1' });
    db.orderItem.findMany.mockResolvedValue([]);
    db.orderItem.aggregate.mockResolvedValue({ _sum: { reservedQty: 0 } });
    db.orderAddOn.aggregate.mockResolvedValue({ _sum: { reservedQty: 0 } });
    db.orderAddOn.findMany.mockResolvedValue([{ productId: 'p1', productName: 'مقشر', quantity: 2 }]);
  });

  it('an add-on the shelf cannot cover is a stock shortage that names it an add-on', async () => {
    db.productionBatch.aggregate.mockResolvedValue({ _sum: { quantityRemaining: 0 } });
    const blocks = await shipmentBlocks(db as never, order, { allowNegativeStock: false });
    const stock = blocks.find((b) => b.code === 'STOCK_SHORTAGE');
    expect(stock).toMatchObject({ hard: true });
    expect(stock!.message).toContain('مقشر');
    expect(stock!.message).toContain('إضافة');
    expect(stock!.message).toContain('2');
  });

  it('NEGATIVE: an add-on the shelf covers is no block', async () => {
    db.productionBatch.aggregate.mockResolvedValue({ _sum: { quantityRemaining: 5 } });
    const blocks = await shipmentBlocks(db as never, order, { allowNegativeStock: false });
    expect(blocks.find((b) => b.code === 'STOCK_SHORTAGE')).toBeUndefined();
  });

  it('NEGATIVE: an order with no add-ons asks nothing more than before', async () => {
    db.orderAddOn.findMany.mockResolvedValue([]);
    db.productionBatch.aggregate.mockResolvedValue({ _sum: { quantityRemaining: 0 } });
    const blocks = await shipmentBlocks(db as never, order, { allowNegativeStock: false });
    expect(blocks.find((b) => b.code === 'STOCK_SHORTAGE')).toBeUndefined();
  });
});
