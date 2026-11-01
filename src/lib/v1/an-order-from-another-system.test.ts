import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * O7 — AN ORDER ANOTHER SYSTEM TOOK, LANDING IN THIS ONE.
 *
 * THE RULE THE WHOLE FILE IS ABOUT: «ما بيثق بأرقام نظام تاني». The replies
 * system sends a name, a phone, an address, quantities, unit prices and a
 * complete `totals` block — and this door writes the customer's details and
 * NOTHING ELSE from that list. Every figure is recomputed from our own
 * catalogue, through the same `computeCod` every screen uses.
 *
 * `computeCod` is NOT mocked here, on purpose. A money test that mocks the
 * money function proves the wiring and nothing about the arithmetic, and
 * the arithmetic is the part that reaches a courier.
 * ═══════════════════════════════════════════════════════════════════════
 */

const h = vi.hoisted(() => ({
  db: {
    product: { findMany: vi.fn() },
    customer: { findMany: vi.fn(), update: vi.fn() },
    order: { create: vi.fn() },
    orderItem: { createMany: vi.fn() },
    orderActivity: { create: vi.fn() },
    store: { findMany: vi.fn() },
    // The fixed cost an admin set for a product (`ProductFixedCost`): none here, re-armed in `beforeEach`.
    productFixedCost: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
  activeBlock: vi.fn(),
  findOrCreateCustomer: vi.fn(),
  activeOffersFor: vi.fn(),
  productCosts: vi.fn(),
  resolveRegionId: vi.fn(),
  priceIncludesDeliveryFor: vi.fn(),
  orderRefFields: vi.fn(),
  logAudit: vi.fn(),
  notify: vi.fn(),
  encryptSecret: vi.fn(),
  encryptionAvailable: vi.fn(),
  isValidPhoneFor: vi.fn(),
}));

vi.mock('../db', () => ({ db: h.db }));
vi.mock('../blacklist', () => ({ activeBlock: (...a: unknown[]) => h.activeBlock(...a) }));
vi.mock('../customer-identity', () => ({
  findOrCreateCustomer: (...a: unknown[]) => h.findOrCreateCustomer(...a),
}));
vi.mock('../offers', () => ({ activeOffersFor: (...a: unknown[]) => h.activeOffersFor(...a) }));
vi.mock('../product-cost', () => ({ productCosts: (...a: unknown[]) => h.productCosts(...a) }));
vi.mock('../regions', () => ({ resolveRegionId: (...a: unknown[]) => h.resolveRegionId(...a) }));
vi.mock('../delivery-fees', () => ({
  priceIncludesDeliveryFor: (...a: unknown[]) => h.priceIncludesDeliveryFor(...a),
}));
vi.mock('../order-ref', () => ({ orderRefFields: (...a: unknown[]) => h.orderRefFields(...a) }));
vi.mock('../audit', () => ({ logAudit: (...a: unknown[]) => h.logAudit(...a) }));
vi.mock('../notify', () => ({ notify: (...a: unknown[]) => h.notify(...a) }));
vi.mock('../secrets', () => ({
  encryptSecret: (...a: unknown[]) => h.encryptSecret(...a),
  encryptionAvailable: () => h.encryptionAvailable(),
}));
vi.mock('../phone-rules', () => ({
  isValidPhoneFor: (...a: unknown[]) => h.isValidPhoneFor(...a),
  phoneErrorFor: () => 'رقم الهاتف غير صالح',
  canonicalPhone: (p: string) => p,
}));

import { V1_CODE, V1Fault } from './door';
import { createSystemOrder, v1OrderSchema } from './order-intake';
import type { SystemCaller } from './system-token';

const CALLER: SystemCaller = {
  tokenId: 'tok_1',
  companyId: 'c1',
  system: 'replies',
  scopes: ['orders.create'],
};

const SY = {
  id: 'country_sy',
  code: 'SY',
  currencyCode: 'USD',
  minorUnit: 2,
  orderPrefix: 'SY',
  timezone: 'Asia/Damascus',
};

const product = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  sku: 'TIN01',
  name: 'منتج الطنين',
  image: null,
  basePrice: 15,
  storeId: 's1',
  store: { id: 's1', countryId: SY.id, country: SY },
  ...over,
});

/** The body the contract's own example sends, parsed. */
const BODY = {
  external_ref: 'ORD-MG8K2J-X7Q',
  source: 'replies',
  channel: 'whatsapp',
  customer: {
    name: 'أبو أحمد',
    phone: '0936654998',
    city: 'حلب',
    address: 'الفرقان، جانب الجامع',
  },
  items: [
    { product_code: 'TIN01', name: 'منتج الطنين', quantity: 2, unit_price: '15.00', line_total: '30.00' },
  ],
  totals: {
    subtotal: '30.00',
    discount: '0.00',
    delivery_fee: '3.00',
    total: '33.00',
    currency: 'USD',
  },
  notes: 'بعد الساعة ٥',
  attribution: {
    method: 'CODE',
    ad_id: null,
    ad_source_type: null,
    ctwa_clid: null,
    ref_code: 'K7Q2',
    ref_code_at: '2026-10-09T20:14:00+03:00',
    touch_at: '2026-10-09T20:14:00+03:00',
    page_id: null,
    psid: null,
    waba_id: null,
    conversation_ref: 'cv_abcdefghijkl',
  },
};

const parse = (over: Record<string, unknown> = {}) => {
  const parsed = v1OrderSchema.safeParse({ ...BODY, ...over });
  if (!parsed.success) throw new Error('fixture does not fit the schema: ' + parsed.error.message);
  return parsed.data;
};

async function faultOf(fn: () => Promise<unknown>): Promise<V1Fault | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof V1Fault ? e : null;
  }
}

/** The `data` the order was created with, whichever attempt won. */
const created = () => h.db.order.create.mock.calls[0][0].data;

beforeEach(() => {
  vi.clearAllMocks();
  h.db.product.findMany.mockResolvedValue([product()]);
  h.activeBlock.mockResolvedValue(null);
  h.isValidPhoneFor.mockReturnValue(true);
  h.findOrCreateCustomer.mockResolvedValue({ id: 'cust_1', city: 'حلب', firstOrderDate: null });
  h.activeOffersFor.mockResolvedValue([]);
  h.productCosts.mockResolvedValue(new Map([['p1', { average: 4 }]]));
  h.db.productFixedCost.findMany.mockResolvedValue([]);
  h.resolveRegionId.mockResolvedValue('region_aleppo');
  h.priceIncludesDeliveryFor.mockResolvedValue(false);
  h.orderRefFields.mockResolvedValue({ orderNumber: 'SY-2026-0148', merchantRef: 'SY-2026-0148' });
  h.encryptionAvailable.mockReturnValue(true);
  h.encryptSecret.mockImplementation((v: string) => `v1:sealed:${v}`);
  h.db.order.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: 'o1', confirmationStatus: 'NEW', totalAmount: 30, currency: 'USD', ...data })
  );
  h.db.orderItem.createMany.mockResolvedValue({ count: 1 });
  h.db.customer.update.mockResolvedValue({});
  h.db.orderActivity.create.mockResolvedValue({});
  // One transaction, and the callback gets a client that is NOT `db`.
  h.db.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      order: h.db.order,
      orderItem: h.db.orderItem,
      customer: h.db.customer,
      orderActivity: h.db.orderActivity,
    })
  );
});

describe('the body it will accept', () => {
  it('takes the contract’s own example', () => {
    expect(v1OrderSchema.safeParse(BODY).success).toBe(true);
  });

  it('and names no company and no store — the token decides both', () => {
    const shape = v1OrderSchema.safeParse({
      ...BODY,
      companyId: 'c_other',
      store_id: 's_other',
    });
    expect(shape.success).toBe(true);
    // Zod strips what it does not declare, so there is nothing to read even
    // if a caller sends it. This is the tenant rule as a property of the
    // shape rather than of each handler remembering.
    expect(Object.keys(shape.success ? shape.data : {})).not.toContain('companyId');
    expect(Object.keys(shape.success ? shape.data : {})).not.toContain('store_id');
  });

  it('and refuses a price that is not written like a decimal', () => {
    for (const bad of ['', '  ', 'abc', '15.0.0', '-1', '1e3', '١٥']) {
      const r = v1OrderSchema.safeParse({
        ...BODY,
        items: [{ product_code: 'TIN01', quantity: 1, unit_price: bad }],
      });
      expect(r.success, bad).toBe(false);
    }
  });

  it('and holds the same quantity ceiling the dashboard’s own door holds', () => {
    expect(
      v1OrderSchema.safeParse({ ...BODY, items: [{ product_code: 'TIN01', quantity: 1000 }] }).success
    ).toBe(false);
    expect(
      v1OrderSchema.safeParse({ ...BODY, items: [{ product_code: 'TIN01', quantity: 0 }] }).success
    ).toBe(false);
  });
});

describe('what it refuses, and refuses before it writes', () => {
  it('a product code this company does not sell — and names which', async () => {
    h.db.product.findMany.mockResolvedValue([]);
    const fault = await faultOf(() => createSystemOrder(CALLER, parse()));
    expect(fault?.status).toBe(422);
    expect(fault?.code).toBe(V1_CODE.PRODUCT_UNKNOWN);
    expect(fault?.details).toEqual({ product_codes: ['TIN01'] });
    expect(h.db.order.create).not.toHaveBeenCalled();
  });

  it('and the catalogue is asked for THIS company only, and only real stores', async () => {
    await faultOf(() => createSystemOrder(CALLER, parse()));
    const where = h.db.product.findMany.mock.calls[0][0].where;
    expect(where.companyId).toBe('c1');
    expect(where.status).toBe('ACTIVE');
    // A bench's figures «لا تدخل أيَّ حسبة», and an outside system selling
    // off one would put real orders on it.
    expect(where.store).toEqual({ isTest: false });
  });

  it('lines from two different stores, because one order is one shop', async () => {
    h.db.product.findMany.mockResolvedValue([
      product(),
      product({ id: 'p2', sku: 'TIN02', storeId: 's2', store: { id: 's2', countryId: SY.id, country: SY } }),
    ]);
    const fault = await faultOf(() =>
      createSystemOrder(
        CALLER,
        parse({
          items: [
            { product_code: 'TIN01', quantity: 1 },
            { product_code: 'TIN02', quantity: 1 },
          ],
        })
      )
    );
    expect(fault?.code).toBe(V1_CODE.ITEMS_SPAN_STORES);
    expect(h.db.order.create).not.toHaveBeenCalled();
  });

  it('a blocked phone — and the reason is NOT sent to the other system', async () => {
    h.activeBlock.mockResolvedValue({ id: 'b1', reason: 'رفض ثلاث شحنات' });
    const fault = await faultOf(() => createSystemOrder(CALLER, parse()));
    expect(fault?.status).toBe(422);
    expect(fault?.code).toBe(V1_CODE.CUSTOMER_BLACKLISTED);
    /*
     * A seller on a screen is told why, because they decide whether to
     * release it. A program on the other side of a webhook is not: the
     * reason would travel into a log nobody here decided to keep it in.
     */
    expect(JSON.stringify(fault)).not.toContain('رفض ثلاث شحنات');
    expect(h.db.order.create).not.toHaveBeenCalled();
    expect(h.findOrCreateCustomer).not.toHaveBeenCalled();
  });

  it('and the block is asked on the RAW phone, which is how it cannot be walked round', async () => {
    await createSystemOrder(CALLER, parse({ customer: { ...BODY.customer, phone: '+963936654998' } }));
    // Normalising first would drop the leading `+` that marks an
    // international form, and a block stored from «+963…» would then miss a
    // local «0…» — the exact way around a block.
    expect(h.activeBlock).toHaveBeenCalledWith(h.db, 'c1', '+963936654998');
  });

  it('a phone that is not a number for the store’s country', async () => {
    h.isValidPhoneFor.mockReturnValue(false);
    const fault = await faultOf(() => createSystemOrder(CALLER, parse()));
    expect(fault?.code).toBe(V1_CODE.INVALID_PHONE);
    expect(h.db.order.create).not.toHaveBeenCalled();
    // Against THIS country's rule, read from the product's own store.
    expect(h.isValidPhoneFor).toHaveBeenCalledWith('SY', '0936654998');
  });

  it('and a product that sits in no store at all, rather than guessing one', async () => {
    h.db.product.findMany.mockResolvedValue([product({ store: null })]);
    const fault = await faultOf(() => createSystemOrder(CALLER, parse()));
    expect(fault?.code).toBe(V1_CODE.PRODUCT_UNKNOWN);
  });
});

describe('the price is ours', () => {
  it('ignores the unit price that was sent and charges the catalogue’s', async () => {
    const result = await createSystemOrder(
      CALLER,
      parse({ items: [{ product_code: 'TIN01', quantity: 2, unit_price: '1.00', line_total: '2.00' }] })
    );
    // 2 × 15 from `basePrice`, not 2 × 1 from the body.
    expect(result.totals.subtotal).toBe(30);
    expect(result.totals.total).toBe(30);
    expect(created().sellingPrice).toBe(30);
    expect(created().totalAmount).toBe(30);
  });

  it('and says so, so the other system can tell the customer before the courier does', async () => {
    const result = await createSystemOrder(
      CALLER,
      parse({ totals: { ...BODY.totals, subtotal: '20.00' } })
    );
    expect(result.priceAdjusted).toBe(true);
  });

  it('and does not cry wolf when the two agree', async () => {
    const result = await createSystemOrder(CALLER, parse());
    expect(result.priceAdjusted).toBe(false);
  });

  it('and no `totals` at all is not a disagreement — nothing was claimed', async () => {
    const result = await createSystemOrder(CALLER, parse({ totals: null }));
    expect(result.priceAdjusted).toBe(false);
  });

  it('and an advertised bundle at the quantity asked for IS honoured', async () => {
    /*
     * `GET /api/v1/products` publishes this product's live offers — «حبتين
     * بـ 25» — so the calling system quotes from them. Charging 2 × 15 for
     * a bundle it had just read off our own endpoint would break a promise
     * at the door, which is the defect `public-order.ts` documents at
     * length. The figures come from `activeOffersFor`, the one offer view
     * four public surfaces already render.
     */
    h.activeOffersFor.mockResolvedValue([
      { id: 'off_1', name: 'حبتين بـ 25', quantity: 2, freeQuantity: 0, price: 25, listPrice: 30, deliveryIncluded: false, endsAt: null },
    ]);
    const result = await createSystemOrder(CALLER, parse());
    // 30 before the bundle's own reduction, less a discount of 5.
    expect(result.totals.subtotal).toBe(30);
    expect(result.totals.discount).toBe(5);
    expect(result.totals.total).toBe(25);
    expect(created().offerId).toBe('off_1');
  });

  it('and the bundle’s reduction lands on the LINE, where a return refunds it', async () => {
    h.activeOffersFor.mockResolvedValue([
      { id: 'off_1', name: 'حبتين بـ 25', quantity: 2, freeQuantity: 0, price: 25, listPrice: 30, deliveryIncluded: false, endsAt: null },
    ]);
    await createSystemOrder(CALLER, parse());
    const lines = h.db.orderItem.createMany.mock.calls[0][0].data;
    expect(lines[0].discountShare).toBe(5);
    expect(lines[0].lineTotal).toBe(25);
  });

  it('and a bundle whose quantity does not match is not applied', async () => {
    // Picking «the best offer under the quantity» would be a pricing POLICY
    // and the owner's to make; inventing one here would undercut the
    // seller's own advertised prices.
    h.activeOffersFor.mockResolvedValue([
      { id: 'off_1', name: 'ثلاث حبات', quantity: 3, freeQuantity: 0, price: 35, listPrice: 45, deliveryIncluded: false, endsAt: null },
    ]);
    const result = await createSystemOrder(CALLER, parse());
    expect(result.totals.subtotal).toBe(30);
    expect(result.totals.discount).toBe(0);
    expect(created().offerId).toBeNull();
  });

  it('and one bundle split across two lines claims its reduction ONCE', async () => {
    /*
     * The same rule and the same reason as `basketDiscount` in
     * `public-order.ts`: without de-duplication by offer id, a caller could
     * split one bundle across two lines and take the reduction twice.
     */
    h.activeOffersFor.mockResolvedValue([
      { id: 'off_1', name: 'حبتين بـ 25', quantity: 2, freeQuantity: 0, price: 25, listPrice: 30, deliveryIncluded: false, endsAt: null },
    ]);
    const result = await createSystemOrder(
      CALLER,
      parse({
        items: [
          { product_code: 'TIN01', quantity: 2 },
          { product_code: 'TIN01', quantity: 2 },
        ],
      })
    );
    expect(result.totals.subtotal).toBe(60);
    expect(result.totals.discount).toBe(5);
  });

  it('and the delivery fee the caller sent is never written', async () => {
    /*
     * A fee belongs to a COURIER in a REGION, and no courier is chosen
     * until a shipment is built — which is why both other doors that take
     * an order from outside this building write 0 and let shipment creation
     * put the real figure on. Accepting `totals.delivery_fee` would be
     * money arithmetic taken from a client.
     */
    const result = await createSystemOrder(CALLER, parse());
    expect(created().shippingCost).toBe(0);
    expect(result.totals.deliveryFee).toBe(0);
    expect(result.totals.total).toBe(30); // not 33
  });

  it('and the store’s delivery-inclusive policy is read, not assumed', async () => {
    h.priceIncludesDeliveryFor.mockResolvedValue(true);
    await createSystemOrder(CALLER, parse());
    expect(h.priceIncludesDeliveryFor).toHaveBeenCalledWith('s1', undefined);
    expect(created().priceIncludesDelivery).toBe(true);
  });

  it('and an offer that promises delivery turns it on for the whole order', async () => {
    h.activeOffersFor.mockResolvedValue([
      { id: 'off_1', name: 'حبتين', quantity: 2, freeQuantity: 0, price: 25, listPrice: null, deliveryIncluded: true, endsAt: null },
    ]);
    await createSystemOrder(CALLER, parse());
    expect(h.priceIncludesDeliveryFor).toHaveBeenCalledWith('s1', true);
  });

  it('and the cost of goods is the shared weighted average, not a guess', async () => {
    await createSystemOrder(CALLER, parse());
    expect(h.productCosts).toHaveBeenCalledWith(h.db, 'c1', ['p1']);
    expect(created().estimatedCostOfGoods).toBe(8); // 2 × 4
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE SYSTEMS DOOR COSTS A PRODUCT AT ITS FIXED COST WHEN IT HAS ONE (the owner, 1/11: «ثابت لكل الطلبات»)
 *
 * The same order as above (two units of p1; the shelf says 4 a unit). A figure an admin set for the product wins over the shelf, the
 * gift included; a product with none is exactly what it was. The replies system's own prices are untouched — this is our cost.
 * ═══════════════════════════════════════════════════════════════════════
 */
describe('a fixed cost is what the systems door costs a product at', () => {
  const armed = (amount: number, productId = 'p1') => h.db.productFixedCost.findMany.mockResolvedValue([{ productId, amount }]);

  it('a figure of 6: 2 × 6 = 12 — not the 8 of the shelf', async () => {
    armed(6);
    await createSystemOrder(CALLER, parse());
    expect(created().estimatedCostOfGoods).toBe(12);
  });

  it('ZERO is a figure: the order costs nothing, the 4 of the shelf is not used', async () => {
    armed(0);
    await createSystemOrder(CALLER, parse());
    expect(created().estimatedCostOfGoods).toBe(0);
  });

  it('a figure wins where the shelf holds nothing costed: 2 × 6, not 0', async () => {
    armed(6);
    h.productCosts.mockResolvedValue(new Map([['p1', { average: 0 }]]));
    await createSystemOrder(CALLER, parse());
    expect(created().estimatedCostOfGoods).toBe(12);
  });

  it('the gift counts: an offer of two with one free makes three units — 3 × 6 = 18', async () => {
    armed(6);
    h.activeOffersFor.mockResolvedValue([
      { id: 'off_1', name: 'حبتين + هدية', quantity: 2, freeQuantity: 1, price: 30, listPrice: null, deliveryIncluded: false, endsAt: null },
    ]);
    await createSystemOrder(CALLER, parse());
    expect(created().freeQuantity).toBe(1);
    expect(created().estimatedCostOfGoods).toBe(18);
  });

  it('the figure of ANOTHER product moves nothing: the shelf’s 8 stands', async () => {
    armed(6, 'p9');
    await createSystemOrder(CALLER, parse());
    expect(created().estimatedCostOfGoods).toBe(8);
  });

  it('rounded by the order’s currency: 2 × 1.00555 = 2.0111 is 2.01 at two places', async () => {
    armed(1.00555);
    await createSystemOrder(CALLER, parse());
    expect(created().estimatedCostOfGoods).toBe(2.01);
  });

  it('and what the customer is charged does not move with it', async () => {
    armed(6);
    await createSystemOrder(CALLER, parse());
    expect(created().totalAmount).toBe(30);
    expect(created().sellingPrice).toBe(30);
  });

  it('the figure is asked for THIS token’s company, for the distinct products of the order, once', async () => {
    armed(6);
    await createSystemOrder(CALLER, parse());
    expect(h.db.productFixedCost.findMany).toHaveBeenCalledTimes(1);
    expect(h.db.productFixedCost.findMany).toHaveBeenCalledWith({
      where: { companyId: 'c1', productId: { in: ['p1'] } },
      select: { productId: true, amount: true },
    });
  });
});

describe('the company is the token’s', () => {
  it('on every query and on the row itself', async () => {
    await createSystemOrder({ ...CALLER, companyId: 'c_other' }, parse());
    expect(h.db.product.findMany.mock.calls[0][0].where.companyId).toBe('c_other');
    expect(h.activeBlock.mock.calls[0][1]).toBe('c_other');
    expect(created().companyId).toBe('c_other');
    expect(h.findOrCreateCustomer.mock.calls[0][1].companyId).toBe('c_other');
  });
});

describe('the one write', () => {
  it('is one transaction — an order with no lines is the shape nothing can price', async () => {
    await createSystemOrder(CALLER, parse());
    expect(h.db.$transaction).toHaveBeenCalledTimes(1);
    // Settlement rebuilds the delivered goods from the lines and the
    // reservation lives per line, so a lineless order is unpriceable.
    expect(h.db.orderItem.createMany).toHaveBeenCalledTimes(1);
    expect(h.db.customer.update).toHaveBeenCalledTimes(1);
    expect(h.db.orderActivity.create).toHaveBeenCalledTimes(1);
  });

  it('and the order number retries on a race rather than failing the customer', async () => {
    const race = Object.assign(new Error('taken'), { code: 'P2002' });
    h.db.order.create.mockRejectedValueOnce(race);
    const result = await createSystemOrder(CALLER, parse());
    expect(result.orderNumber).toBe('SY-2026-0148');
    // The retry asks for the NEXT number, not the same one again.
    expect(h.orderRefFields.mock.calls.map((c) => c[3])).toEqual([0, 1]);
  });

  it('and a failure that is not a race is not retried for ever', async () => {
    h.db.order.create.mockRejectedValue(new Error('database gone'));
    await expect(createSystemOrder(CALLER, parse())).rejects.toThrow('database gone');
    expect(h.db.order.create).toHaveBeenCalledTimes(1);
  });

  it('and names no employee, because none took this order', async () => {
    /*
     * `createdById` null is the same answer the public door gives. Putting
     * a user here would print an employee's name on work they never did —
     * and the entry caps, the transfer screen and the commission ledger all
     * read that column.
     */
    await createSystemOrder(CALLER, parse());
    expect(created().createdById).toBeNull();
    expect(created().moderatorId).toBeNull();
    expect(created().claimedById).toBeNull();
    expect(created().currentOwnerId).toBeNull();
    expect(h.db.orderActivity.create.mock.calls[0][0].data.userId).toBeNull();
  });

  it('and lands in the confirmation queue exactly as every other new order does', async () => {
    await createSystemOrder(CALLER, parse());
    expect(created().status).toBe('NEW');
    expect(created().confirmationStatus).toBe('NEW');
    expect(created().shippingStatus).toBe('NOT_READY');
    expect(created().settlementStatus).toBe('NOT_APPLICABLE');
    // And the supervisors are told, through the one function that tells them.
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0][0]).toMatchObject({
      audience: { permission: 'confirmation.supervise' },
      type: 'ORDER_NEW',
    });
  });

  it('and the governorate is bound to a real region, because the fee is keyed on it', async () => {
    await createSystemOrder(CALLER, parse());
    expect(h.resolveRegionId).toHaveBeenCalledWith(h.db, 'country_sy', 'حلب');
    expect(created().regionId).toBe('region_aleppo');
  });
});

describe('the ad evidence it records', () => {
  it('writes what was reported, and nothing it was not', async () => {
    await createSystemOrder(CALLER, parse());
    expect(created()).toMatchObject({
      externalRef: 'ORD-MG8K2J-X7Q',
      externalChannel: 'whatsapp',
      refCode: 'K7Q2',
      conversationRef: 'cv_abcdefghijkl',
      adId: null,
      pageId: null,
      wabaId: null,
    });
    expect(created().refCodeAt).toEqual(new Date('2026-10-09T20:14:00+03:00'));
    expect(created().touchAt).toEqual(new Date('2026-10-09T20:14:00+03:00'));
  });

  it('and `method` stands in for `ad_source_type` when only one of them came', async () => {
    await createSystemOrder(CALLER, parse());
    expect(created().adSourceType).toBe('CODE');
  });

  it('and the click id and the chat account go in SEALED', async () => {
    await createSystemOrder(
      CALLER,
      parse({ attribution: { ...BODY.attribution, ctwa_clid: 'CLICK_123', psid: 'PSID_456' } })
    );
    expect(h.encryptSecret).toHaveBeenCalledWith('CLICK_123');
    expect(h.encryptSecret).toHaveBeenCalledWith('PSID_456');
    expect(created().ctwaClidEnc).toBe('v1:sealed:CLICK_123');
    expect(created().psidEnc).toBe('v1:sealed:PSID_456');
    // The plaintext is in no other column.
    const row = JSON.stringify(created()).replace(/v1:sealed:\w+/g, '');
    expect(row).not.toContain('CLICK_123');
    expect(row).not.toContain('PSID_456');
  });

  it('and with no key configured they are DROPPED, never written in the clear', async () => {
    /*
     * A column named `…Enc` holding plaintext is worse than an empty one:
     * every reader afterwards believes it is sealed. And an ad click id is
     * not worth refusing a customer's order over, so the order still lands.
     */
    h.encryptionAvailable.mockReturnValue(false);
    await createSystemOrder(
      CALLER,
      parse({ attribution: { ...BODY.attribution, ctwa_clid: 'CLICK_123', psid: 'PSID_456' } })
    );
    expect(h.encryptSecret).not.toHaveBeenCalled();
    expect(created().ctwaClidEnc).toBeNull();
    expect(created().psidEnc).toBeNull();
    expect(h.db.order.create).toHaveBeenCalledTimes(1);
  });

  it('and the audit says which system issued the order, never the key', async () => {
    await createSystemOrder(CALLER, parse());
    const entry = h.logAudit.mock.calls[0][0];
    expect(entry).toMatchObject({
      companyId: 'c1',
      userId: null,
      action: 'ORDER_CREATED_API_V1',
      entity: 'Order',
    });
    expect(JSON.stringify(entry)).not.toContain('zk1_');
  });
});
