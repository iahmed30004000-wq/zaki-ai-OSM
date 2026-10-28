import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «العرض ما بصير يكون اكثر من السعر الاساسي» — AND THE SYSTEMS DOOR DID NOT CHANGE.
 *
 * The rule refuses a NEW offer above its line at the offer doors. An offer saved above it before the rule stays on
 * sale as it is — flagged on the offers screen, the owner's to decide — and v1 goes on honouring it as it honours
 * every advertised bundle: the exact-quantity offer is the price. Charging it anything else would be a change to
 * order creation, which is a fixed blocker and was not asked for.
 *
 * `../offers` is NOT mocked, unlike `an-order-from-another-system.test.ts`: the real `activeOffersFor` and the real
 * `liveOfferWhere` run over a mocked table, so a price filter slipped into either would fail here.
 */

const h = vi.hoisted(() => ({
  db: {
    product: { findMany: vi.fn() },
    offer: { findMany: vi.fn() },
    customer: { findMany: vi.fn(), update: vi.fn() },
    order: { create: vi.fn(), groupBy: vi.fn() },
    orderItem: { createMany: vi.fn() },
    orderActivity: { create: vi.fn() },
    store: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
  activeBlock: vi.fn(),
  findOrCreateCustomer: vi.fn(),
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

import { createSystemOrder, v1OrderSchema } from './order-intake';
import { offerAboveBase } from '../offer-ceiling';
import type { SystemCaller } from './system-token';

const CALLER: SystemCaller = { tokenId: 'tok_1', companyId: 'c1', system: 'replies', scopes: ['orders.create'] };

const SY = { id: 'country_sy', code: 'SY', currencyCode: 'USD', minorUnit: 2, orderPrefix: 'SY', timezone: 'Asia/Damascus' };

/** 15 a piece. */
const PRODUCT = {
  id: 'p1',
  sku: 'TIN01',
  name: 'منتج الطنين',
  image: null,
  basePrice: 15,
  storeId: 's1',
  store: { id: 's1', countryId: SY.id, country: SY },
};

/** «حبتين» at 34: above its line of 2 × 15 = 30 — the row the offer doors now refuse to write. */
const ABOVE = {
  id: 'off_above',
  name: 'حبتين',
  quantity: 2,
  freeQuantity: 0,
  sellingPrice: 34,
  discount: 0,
  compareAtPrice: null,
  isDefault: true,
  deliveryIncluded: false,
  endsAt: null,
};

const order = () =>
  v1OrderSchema.parse({
    external_ref: 'ORD-ABOVE-1',
    source: 'replies',
    channel: 'whatsapp',
    customer: { name: 'أبو أحمد', phone: '0936654998', city: 'حلب', address: 'الفرقان، جانب الجامع' },
    items: [{ product_code: 'TIN01', quantity: 2 }],
    totals: null,
    notes: null,
    attribution: null,
  });

const created = () => h.db.order.create.mock.calls[0][0].data;

beforeEach(() => {
  vi.clearAllMocks();
  h.db.product.findMany.mockResolvedValue([PRODUCT]);
  h.db.offer.findMany.mockImplementation(async ({ where }: { where: { productId?: string } }) =>
    where.productId === PRODUCT.id ? [ABOVE] : []
  );
  // No delivered history, so no struck-through «was» price — the evidence read of `activeOffersFor`.
  h.db.order.groupBy.mockResolvedValue([]);
  h.activeBlock.mockResolvedValue(null);
  h.isValidPhoneFor.mockReturnValue(true);
  h.findOrCreateCustomer.mockResolvedValue({ id: 'cust_1', city: 'حلب', firstOrderDate: null });
  h.productCosts.mockResolvedValue(new Map([['p1', { average: 4 }]]));
  h.resolveRegionId.mockResolvedValue('region_aleppo');
  h.priceIncludesDeliveryFor.mockResolvedValue(false);
  h.orderRefFields.mockResolvedValue({ orderNumber: 'SY-2026-0201', merchantRef: 'SY-2026-0201' });
  h.encryptionAvailable.mockReturnValue(true);
  h.encryptSecret.mockImplementation((v: string) => `v1:sealed:${v}`);
  h.db.order.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: 'o1', confirmationStatus: 'NEW', currency: 'USD', ...data })
  );
  h.db.orderItem.createMany.mockResolvedValue({ count: 1 });
  h.db.customer.update.mockResolvedValue({});
  h.db.orderActivity.create.mockResolvedValue({});
  h.db.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
    fn({ order: h.db.order, orderItem: h.db.orderItem, customer: h.db.customer, orderActivity: h.db.orderActivity })
  );
});

describe('a stored bundle above its line, through v1', () => {
  it('is above its line — the fixture is the case the rule is about', () => {
    expect(offerAboveBase(ABOVE, PRODUCT.basePrice, SY.minorUnit)).toBe(30);
  });

  it('is still the price for its exact quantity — 34, its own, and not the 30 of its line', async () => {
    const result = await createSystemOrder(CALLER, order());
    expect(created().offerId).toBe(ABOVE.id);
    expect(result.totals.subtotal).toBe(34);
    expect(result.totals.total).toBe(34);
    expect(h.db.orderItem.createMany.mock.calls[0][0].data[0].unitPrice).toBe(17);
  });

  it('and the offers it may price from are chosen by the live predicate alone — nothing about price', async () => {
    await createSystemOrder(CALLER, order());
    const read = h.db.offer.findMany.mock.calls.find((c) => c[0]?.where?.productId === PRODUCT.id);
    expect(read).toBeTruthy();
    expect(read![0].where).toEqual({
      companyId: 'c1',
      productId: PRODUCT.id,
      status: 'ACTIVE',
      postOrderOffer: false,
      OR: [{ endsAt: null }, { endsAt: { gt: expect.any(Date) } }],
    });
  });
});
