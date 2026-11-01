import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — «السعر شامل التوصيل»: THE BOX ON THE ORDER FORM (the owner, 1/11)
 *
 * His words, after ORD-2026-1711 (a 20$ line the customer was told includes delivery, typed without its offer, collected at 23):
 * «يكون حاط شيك بوكس شامل التوصيل، لو مش محطوط صح يضيف توصيل. الافتراضي فيه شامل التوصيل يعني البوكس صح».
 *
 *  1. The order form, the AI order dialog and the import dialog send `priceIncludesDelivery`, ticked unless the person unticks it.
 *  2. When it is SENT it is the order's flag — at both doors that write an order from a form (`POST /api/orders` and the AI
 *     confirm): ticked, the courier's fee is never added; unticked, it is added at the shipment — whatever the offer or the store's
 *     policy says, because the person has just said it for THIS order.
 *  3. When it is NOT sent (an API caller, an older screen) nothing changed: the offer's flag, else the store's policy.
 *  4. Only a boolean is a word: anything else is a refusal, never a guess.
 *
 * Blockers: this touches order CREATION (the flag the shipment's fee reads) — hence the explicit negative for each cell, and that
 * the figures other than the flag and the total are asserted unchanged. No money formula changed: the total still comes from
 * `computeCod`. No migration.
 * ═══════════════════════════════════════════════════════════════════════
 */

const {
  db, requireContext, requirePermission, logAudit, notify, findOrCreateCustomer, productCost, productCosts,
  resolveRegionId, activeBlock, activeOffersFor,
} = vi.hoisted(() => ({
  db: {
    customer: { update: vi.fn(), findFirst: vi.fn() },
    product: { findFirst: vi.fn(), findMany: vi.fn() },
    offer: { findMany: vi.fn() },
    store: { findFirst: vi.fn() },
    region: { findFirst: vi.fn() },
    user: { findFirst: vi.fn() },
    order: { create: vi.fn() },
    orderItem: { create: vi.fn(), createMany: vi.fn() },
    orderActivity: { create: vi.fn() },
    orderStatusLog: { create: vi.fn() },
    $transaction: vi.fn(async (fn: unknown) => (typeof fn === 'function' ? (fn as (tx: unknown) => unknown)(db) : fn)),
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
  notify: vi.fn(),
  findOrCreateCustomer: vi.fn(),
  productCost: vi.fn(),
  productCosts: vi.fn(),
  resolveRegionId: vi.fn(),
  activeBlock: vi.fn(),
  activeOffersFor: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  can: () => false,
  getPermissionScope: () => ({ scope: 'ALL_COMPANY' }),
  requirePermission: (...a: unknown[]) => requirePermission(...a),
}));
vi.mock('@/lib/rbac', () => ({ applyQueueFilter: (_u: unknown, w: unknown) => w }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/notify', () => ({ notify: (...a: unknown[]) => notify(...a) }));
vi.mock('@/lib/blacklist', () => ({ activeBlock: (...a: unknown[]) => activeBlock(...a) }));
vi.mock('@/lib/customer-identity', () => ({ findOrCreateCustomer: (...a: unknown[]) => findOrCreateCustomer(...a) }));
vi.mock('@/lib/product-cost', () => ({
  productCost: (...a: unknown[]) => productCost(...a),
  productCosts: (...a: unknown[]) => productCosts(...a),
}));
vi.mock('@/lib/regions', () => ({ resolveRegionId: (...a: unknown[]) => resolveRegionId(...a) }));
vi.mock('@/lib/order-ref', () => ({ orderRefFields: async () => ({ orderNumber: 'SY-2026-0200', merchantRef: 'SY-2026-0200' }) }));
vi.mock('@/lib/offers', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  activeOffersFor: (...a: unknown[]) => activeOffersFor(...a),
}));

import { toOfferView } from '@/lib/offers';

const { POST: manualPOST } = await import('@/app/api/orders/route');
const { POST: aiPOST } = await import('@/app/api/orders/ai-intake/route');

const SYRIA = {
  id: 'co-sy', code: 'SY', name: 'سوريا', currencyCode: 'USD', minorUnit: 2,
  timezone: 'Asia/Damascus', orderPrefix: 'SY', allowNegativeStock: false,
};
const PRODUCT = { id: 'prod-cream-0001', companyId: 'c1', name: 'كريم حرير', image: null, basePrice: 20, batches: [{ costPerUnit: 5 }] };

/** «عبوة واحدة» بـ٢٠، السعر شامل التوصيل — the offer the 1/11 order was NOT bound to. */
const ONE_PIECE = {
  id: 'off-one-piece', name: 'عبوة واحدة', quantity: 1, freeQuantity: 0, sellingPrice: 20, discount: 0,
  compareAtPrice: null as number | null, isDefault: false, deliveryIncluded: true, endsAt: null as Date | null,
};
/** The same bundle sold WITHOUT delivery in its price. */
const ONE_PIECE_PLUS_DELIVERY = { ...ONE_PIECE, id: 'off-one-piece-plus', deliveryIncluded: false };

const asJson = (b: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

function sell(row: typeof ONE_PIECE | null) {
  db.offer.findMany.mockResolvedValue(row ? [row] : []);
  activeOffersFor.mockResolvedValue(row ? [toOfferView(row, SYRIA.minorUnit)] : []);
}

/**
 * The order the form sends: one line, NOT bound to an offer (the 1/11 shape), a fee of 3 that the courier will take — what the
 * door writes is the flag and the total. `box` left out is «the form did not say».
 */
async function manual(box: unknown, extra: Record<string, unknown> = {}) {
  const res = await manualPOST(
    new Request('http://localhost/api/orders', asJson({
      customerName: 'محمد الحسن', customerPhone: '0944555666', customerAddress: 'دوما', source: 'Manual', shippingCost: 3,
      items: [{ productId: PRODUCT.id, quantity: 1, unitPrice: 20 }],
      ...(box === undefined ? {} : { priceIncludesDelivery: box }),
      ...extra,
    })),
  );
  return res;
}
const manualWritten = () => db.order.create.mock.calls[0][0].data as Record<string, unknown>;

async function pasted(box: unknown, quantity = 1, finalPrice = 20) {
  const res = await aiPOST(
    new Request('http://localhost/api/orders/ai-intake', asJson({
      confirm: true,
      parsed: {
        customerName: 'محمد الحسن', phone: '0944555666', address: 'دوما', governorate: 'دمشق',
        productId: PRODUCT.id, quantity, finalPrice,
        ...(box === undefined ? {} : { priceIncludesDelivery: box }),
      },
    })),
  );
  return res;
}

beforeEach(() => {
  vi.resetAllMocks();
  db.$transaction.mockImplementation(async (fn: unknown) => (typeof fn === 'function' ? (fn as (tx: unknown) => unknown)(db) : fn));
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'سارة', role: 'MODERATOR' },
    companyId: 'c1', storeId: 's1', countryId: 'co-sy', country: SYRIA,
  });
  requirePermission.mockResolvedValue({ id: 'u1', companyId: 'c1' });
  activeBlock.mockResolvedValue(null);
  // The store does NOT say its prices include delivery: it is the offer, or the box, that says so.
  db.store.findFirst.mockResolvedValue({ priceIncludesDelivery: false });
  db.user.findFirst.mockResolvedValue({ id: 'u1' });
  db.product.findFirst.mockResolvedValue(PRODUCT);
  db.product.findMany.mockResolvedValue([PRODUCT]);
  db.order.create.mockResolvedValue({ id: 'o-new', orderNumber: 'SY-2026-0200', source: 'AI Intake' });
  db.customer.update.mockResolvedValue({});
  db.customer.findFirst.mockResolvedValue(null);
  findOrCreateCustomer.mockResolvedValue({ id: 'cu1', city: 'دمشق', firstOrderDate: null });
  productCost.mockResolvedValue({ average: 5 });
  productCosts.mockImplementation(async (_d: unknown, _c: unknown, ids: string[]) => new Map(ids.map((id) => [id, { average: 5 }])));
  resolveRegionId.mockResolvedValue('r1');
  sell(ONE_PIECE);
  delete process.env.OPENROUTER_API_KEY;
});

describe('POST /api/orders — the box on the order form', () => {
  it('TICKED: a line typed at the offer’s price, without the offer, is delivery-included — no fee on top (the 1/11 case)', async () => {
    const res = await manual(true);
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    const o = manualWritten();
    expect(o.priceIncludesDelivery).toBe(true);
    expect(o.totalAmount).toBe(20);
    expect(o.offerId ?? null).toBeNull();
  });

  it('UNTICKED: the fee is added — whatever an offer says, because she has said it for this order', async () => {
    const res = await manual(false);
    expect(res.status).toBe(200);
    expect(manualWritten().priceIncludesDelivery).toBe(false);
    expect(manualWritten().totalAmount).toBe(23);
  });

  it('UNTICKED beats an offer that includes delivery; TICKED beats an offer that does not', async () => {
    const bound = [{ productId: PRODUCT.id, offerId: ONE_PIECE.id, quantity: 1, unitPrice: 20 }];
    await manual(false, { items: bound });
    expect(manualWritten().priceIncludesDelivery).toBe(false);
    expect(manualWritten().totalAmount).toBe(23);

    vi.clearAllMocks();
    db.order.create.mockResolvedValue({ id: 'o-new', orderNumber: 'SY-2026-0200' });
    sell(ONE_PIECE_PLUS_DELIVERY);
    await manual(true, { items: [{ productId: PRODUCT.id, offerId: ONE_PIECE_PLUS_DELIVERY.id, quantity: 1, unitPrice: 20 }] });
    expect(manualWritten().priceIncludesDelivery).toBe(true);
    expect(manualWritten().totalAmount).toBe(20);
  });

  it('NOT SENT: nothing changed — the offer decides when there is one, the store’s policy when there is none', async () => {
    await manual(undefined);
    expect(manualWritten().priceIncludesDelivery).toBe(false); // no offer, store policy off: the fee is added (as before)
    expect(manualWritten().totalAmount).toBe(23);

    vi.clearAllMocks();
    db.order.create.mockResolvedValue({ id: 'o-new', orderNumber: 'SY-2026-0200' });
    await manual(undefined, { items: [{ productId: PRODUCT.id, offerId: ONE_PIECE.id, quantity: 1, unitPrice: 20 }] });
    expect(manualWritten().priceIncludesDelivery).toBe(true); // the bundle includes it (as before)
    expect(manualWritten().totalAmount).toBe(20);

    vi.clearAllMocks();
    db.order.create.mockResolvedValue({ id: 'o-new', orderNumber: 'SY-2026-0200' });
    db.store.findFirst.mockResolvedValue({ priceIncludesDelivery: true });
    await manual(undefined);
    expect(manualWritten().priceIncludesDelivery).toBe(true); // the store's policy (as before)
  });

  it('only the flag and the total depend on the box: the goods, the price and the units are the same either way', async () => {
    await manual(true);
    const on = manualWritten();
    vi.clearAllMocks();
    db.order.create.mockResolvedValue({ id: 'o-new', orderNumber: 'SY-2026-0200' });
    await manual(false);
    const off = manualWritten();
    for (const k of ['quantity', 'sellingPrice', 'shippingCost', 'estimatedCostOfGoods', 'currency', 'productId', 'discountAmount']) {
      expect(on[k], k).toEqual(off[k]);
    }
    expect(on.totalAmount).not.toEqual(off.totalAmount);
  });

  it('NEGATIVE: anything but a boolean is refused before a customer or an order is written', async () => {
    for (const word of ['true', 'yes', 1, 0, null, {}]) {
      vi.clearAllMocks();
      const res = await manual(word);
      expect(res.status, String(word)).toBe(400);
      expect(db.order.create).not.toHaveBeenCalled();
    }
  });
});

describe('POST /api/orders/ai-intake (confirm) — the same box on the reviewer’s dialog', () => {
  it('TICKED: delivery-included, whatever the offer or the store says; UNTICKED: the fee is added, even for a bundle that includes it', async () => {
    sell(ONE_PIECE_PLUS_DELIVERY); // the bundle does not include delivery
    expect((await pasted(true)).status).toBe(200);
    expect(db.order.create.mock.calls[0][0].data.priceIncludesDelivery).toBe(true);

    vi.clearAllMocks();
    db.order.create.mockResolvedValue({ id: 'o-new', orderNumber: 'SY-2026-0200', source: 'AI Intake' });
    sell(ONE_PIECE); // the bundle includes it
    expect((await pasted(false)).status).toBe(200);
    expect(db.order.create.mock.calls[0][0].data.priceIncludesDelivery).toBe(false);
  });

  it('NOT SENT: the offer and the store decide, as before', async () => {
    sell(ONE_PIECE);
    expect((await pasted(undefined)).status).toBe(200);
    expect(db.order.create.mock.calls[0][0].data.priceIncludesDelivery).toBe(true);

    vi.clearAllMocks();
    db.order.create.mockResolvedValue({ id: 'o-new', orderNumber: 'SY-2026-0200', source: 'AI Intake' });
    sell(ONE_PIECE_PLUS_DELIVERY);
    expect((await pasted(undefined)).status).toBe(200);
    expect(db.order.create.mock.calls[0][0].data.priceIncludesDelivery).toBe(false);
  });

  it('NEGATIVE: a non-boolean word is refused here too', async () => {
    const res = await pasted('yes');
    expect(res.status).toBe(400);
    expect(db.order.create).not.toHaveBeenCalled();
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE STORE'S SWITCH COVERS THE FORM-LESS DOORS WHOLE — an unticked offer does not beat it here (the owner, 1/11)
 *
 * His words: «إذا كل طلباتك توصيلها مجاني، شغّله ليشمل تلجرام والشيتات وصفحات البيع … بس بدي اترك مجال لاضافة الطلب يدويا او من اللاندنج
 * انو اقدر احدد اذا شامل ولا لأ بظبط». The room he asks for is two places: the order typed by hand (the box above) and the sales page
 * (`public-order.ts`, held in `public-order-delivery.test.ts`). Everywhere else the store's switch decides: an offer there still only
 * ever turns delivery ON. A first version of this change let an offer's «no» through at EVERY door; the independent review showed that
 * left the store's switch nothing to decide for Telegram (every Telegram order is bound to an offer, and an offer always answers).
 *
 * So, at these two doors WITHOUT the box (an API caller, an older screen): an unticked bundle in a store that includes delivery is
 * delivery-included; in a store that does not, it is not.
 * ═══════════════════════════════════════════════════════════════════════
 */
describe('without the box, the store’s switch beats an unticked offer — at the manual and the paste-in doors', () => {
  const store = (includes: boolean) => db.store.findFirst.mockResolvedValue({ priceIncludesDelivery: includes });
  const bound = (offer: { id: string }) => [{ productId: PRODUCT.id, offerId: offer.id, quantity: 1, unitPrice: 20 }];

  it('POST /api/orders: an unticked offer in a store that includes delivery → included (the store covers it)', async () => {
    store(true);
    sell(ONE_PIECE_PLUS_DELIVERY);
    const res = await manual(undefined, { items: bound(ONE_PIECE_PLUS_DELIVERY) });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(manualWritten().priceIncludesDelivery).toBe(true);
    expect(manualWritten().totalAmount).toBe(20);
  });

  it('POST /api/orders: the single-product shorthand (a top-level offerId, no items) follows the same rule', async () => {
    store(true);
    sell(ONE_PIECE_PLUS_DELIVERY);
    const res = await manualPOST(
      new Request('http://localhost/api/orders', asJson({
        customerName: 'محمد الحسن', customerPhone: '0944555666', customerAddress: 'دوما', source: 'Manual', shippingCost: 3,
        productId: PRODUCT.id, offerId: ONE_PIECE_PLUS_DELIVERY.id, quantity: 1, sellingPrice: 20,
      })),
    );
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(manualWritten().priceIncludesDelivery).toBe(true); // the store covers it: an unticked offer is not heard at this door
  });

  it('POST /api/orders: the same offer in a store that does not include delivery → the fee is added (as always)', async () => {
    store(false);
    sell(ONE_PIECE_PLUS_DELIVERY);
    await manual(undefined, { items: bound(ONE_PIECE_PLUS_DELIVERY) });
    expect(manualWritten().priceIncludesDelivery).toBe(false);
    expect(manualWritten().totalAmount).toBe(23);
  });

  it('POST /api/orders: the box still beats the store — ticked or not — whatever the offer', async () => {
    store(true);
    sell(ONE_PIECE_PLUS_DELIVERY);
    await manual(false, { items: bound(ONE_PIECE_PLUS_DELIVERY) });
    expect(manualWritten().priceIncludesDelivery).toBe(false);
  });

  it('POST /api/orders/ai-intake: a pasted order matched to an unticked offer, in a store that includes delivery → included', async () => {
    store(true);
    sell(ONE_PIECE_PLUS_DELIVERY);
    expect((await pasted(undefined)).status).toBe(200);
    expect(db.order.create.mock.calls[0][0].data.priceIncludesDelivery).toBe(true);
  });

  it('POST /api/orders/ai-intake: with no offer matched, the store speaks, either way', async () => {
    store(true);
    sell(null);
    expect((await pasted(undefined)).status).toBe(200);
    expect(db.order.create.mock.calls[0][0].data.priceIncludesDelivery).toBe(true);

    vi.clearAllMocks();
    db.order.create.mockResolvedValue({ id: 'o-new', orderNumber: 'SY-2026-0200', source: 'AI Intake' });
    store(false);
    sell(null);
    expect((await pasted(undefined)).status).toBe(200);
    expect(db.order.create.mock.calls[0][0].data.priceIncludesDelivery).toBe(false);
  });
});
