import { beforeEach, describe, expect, it, vi } from 'vitest';
import { repoFile, stripComments } from '@/lib/guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «٣ + ١» PASTED IS «٣ + ١» TYPED (RV172) — AND THE PREVIEW NAMES THE NEAREST BUNDLE, NOT THE FIRST (RV173).
 *
 * `POST /api/orders/ai-intake` priced the order at the offer's figure (RV151) but bound NO offer to it: the order's
 * `offerId` stayed empty, the line carried no gift, the goods were costed without it and a delivery-inclusive bundle was
 * written as if delivery were extra. So a customer who read «ثلاث قطع + واحدة هدية» on the page and whose message was
 * pasted in by the seller got three pieces, and the shelf never learned of the fourth.
 *
 * THE TWO DOORS ARE DRIVEN HERE ON ONE SET OF DOUBLES, by the real route files, and compared field by field — the gift
 * on the line, the order's bundle, the delivery policy, the cost of goods and the total. `giftUnits`, `computeCod`,
 * `roundMinor` and `toOfferView` are the shipped ones; nothing is mocked that does arithmetic.
 *
 * The decision — the owner, 28/10: «اي قرار بعد الان اتخذو دون الرجوع الي». The conservative reading of it: an offer
 * binds only when the pasted quantity IS the bundle (RV151 already says so), and what it binds is exactly what the
 * manual door binds, through the same functions.
 * ═══════════════════════════════════════════════════════════════════════
 */

const {
  db, requireContext, requirePermission, logAudit, notify, findOrCreateCustomer, productCost, productCosts,
  resolveRegionId, activeBlock, activeOffersFor, parseOrderText, matchProduct,
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
  parseOrderText: vi.fn(),
  matchProduct: vi.fn(),
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
vi.mock('@/lib/order-parser', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  parseOrderText: (...a: unknown[]) => parseOrderText(...a),
  matchProduct: (...a: unknown[]) => matchProduct(...a),
}));

import { toOfferView } from '@/lib/offers';
import { giftUnits } from '@/lib/offer-gift';

const { POST: manualPOST } = await import('@/app/api/orders/route');
const { POST: aiPOST } = await import('@/app/api/orders/ai-intake/route');

const SYRIA = {
  id: 'co-sy', code: 'SY', name: 'سوريا', currencyCode: 'USD', minorUnit: 2,
  timezone: 'Asia/Damascus', orderPrefix: 'SY', allowNegativeStock: false,
};
const PRODUCT = { id: 'prod-cream-0001', companyId: 'c1', name: 'كريم حرير', image: null, basePrice: 20, batches: [{ costPerUnit: 5 }] };
const UNIT_COST = 5;

/** «ثلاث قطع + واحدة هدية» بـ٦٠. */
interface OfferRow {
  id: string; name: string; quantity: number; freeQuantity: number; sellingPrice: number; discount: number;
  compareAtPrice: number | null; isDefault: boolean; deliveryIncluded: boolean; endsAt: Date | null;
}

const THREE_PLUS_ONE: OfferRow = {
  id: 'off-3-plus-1', name: '٣ + ١ هدية', quantity: 3, freeQuantity: 1, sellingPrice: 60, discount: 0,
  compareAtPrice: null, isDefault: false, deliveryIncluded: true, endsAt: null,
};

/** The row the manual door reads (`db.offer.findMany`) and the view the AI door reads (`activeOffersFor`) — one offer. */
function sell(row: OfferRow) {
  db.offer.findMany.mockResolvedValue([row]);
  activeOffersFor.mockResolvedValue([toOfferView(row, SYRIA.minorUnit)]);
}

const asJson = (b: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

/**
 * The order the seller TYPED. 'line': the offer rides on the line, as the order dialog sends it. 'top': the
 * single-product shorthand — the only shape in which the manual door applies the offer's own reduction (see the PR:
 * out of scope here).
 */
async function typed(row: OfferRow, quantity: number, lineTotal: number, shape: 'line' | 'top' = 'line') {
  const lines = shape === 'line'
    ? { items: [{ productId: PRODUCT.id, offerId: row.id, quantity, unitPrice: lineTotal }] }
    : { productId: PRODUCT.id, offerId: row.id, quantity, sellingPrice: lineTotal };
  const res = await manualPOST(
    new Request('http://localhost/api/orders', asJson({
      customerName: 'محمد الحسن', customerPhone: '0944555666', customerAddress: 'دوما', source: 'Manual',
      ...lines,
    })),
  );
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
  return written('createMany');
}

/** The same order PASTED, and confirmed at the figure the preview showed. */
async function pasted(quantity: number, finalPrice: number) {
  const res = await aiPOST(
    new Request('http://localhost/api/orders/ai-intake', asJson({
      confirm: true,
      parsed: {
        customerName: 'محمد الحسن', phone: '0944555666', address: 'دوما', governorate: 'دمشق',
        productId: PRODUCT.id, quantity, finalPrice,
      },
    })),
  );
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
  return written('create');
}

function written(itemWriter: 'create' | 'createMany') {
  const order = db.order.create.mock.calls[0][0].data;
  const raw = db.orderItem[itemWriter].mock.calls[0][0];
  const line = itemWriter === 'createMany' ? raw.data[0] : raw.data;
  return { order, line };
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
  // The store does NOT say its prices include delivery: only the OFFER can turn it on.
  db.store.findFirst.mockResolvedValue({ priceIncludesDelivery: false });
  db.user.findFirst.mockResolvedValue({ id: 'u1' });
  db.product.findFirst.mockResolvedValue(PRODUCT);
  db.product.findMany.mockResolvedValue([PRODUCT]);
  db.order.create.mockResolvedValue({ id: 'o-new', orderNumber: 'SY-2026-0200', source: 'AI Intake' });
  db.customer.update.mockResolvedValue({});
  findOrCreateCustomer.mockResolvedValue({ id: 'cu1', city: 'دمشق', firstOrderDate: null });
  productCost.mockResolvedValue({ average: UNIT_COST });
  productCosts.mockImplementation(async (_d: unknown, _c: unknown, ids: string[]) => new Map(ids.map((id) => [id, { average: UNIT_COST }])));
  resolveRegionId.mockResolvedValue('r1');
  delete process.env.OPENROUTER_API_KEY;
});

describe('RV172 — «٣ + ١» بالذكاء = «٣ + ١» باليد', () => {
  it('الهدية على السطر واحدة، كما يكتبها الباب اليدوي — لا ثلاث', async () => {
    sell(THREE_PLUS_ONE);
    const byHand = await typed(THREE_PLUS_ONE, 3, 60);
    vi.clearAllMocks();
    db.$transaction.mockImplementation(async (fn: unknown) => (typeof fn === 'function' ? (fn as (tx: unknown) => unknown)(db) : fn));
    db.order.create.mockResolvedValue({ id: 'o-new', orderNumber: 'SY-2026-0200', source: 'AI Intake' });
    const byPaste = await pasted(3, 60);

    expect(byHand.line.freeQuantity, 'الباب اليدوي نفسه تغيّر').toBe(1);
    expect(byPaste.line.freeQuantity, 'الهدية ما وصلت السطر').toBe(1);
    expect(byPaste.line.freeQuantity).toBe(byHand.line.freeQuantity);
    // The old per-piece multiplication (3 + 3) is the bug this pins from coming back through either door.
    expect(byPaste.line.freeQuantity).not.toBe(3);
    expect(byPaste.line.quantity + byPaste.line.freeQuantity).toBe(4);
    expect(byPaste.line.freeQuantity).toBe(giftUnits(THREE_PLUS_ONE, 3));
  });

  it('والطلب يعرف أي عرض باعه — وسياسة التوصيل من العرض — والتكلفة تشمل الهدية — والمبلغ واحد', async () => {
    sell(THREE_PLUS_ONE);
    const byHand = await typed(THREE_PLUS_ONE, 3, 60);
    vi.clearAllMocks();
    db.$transaction.mockImplementation(async (fn: unknown) => (typeof fn === 'function' ? (fn as (tx: unknown) => unknown)(db) : fn));
    db.order.create.mockResolvedValue({ id: 'o-new', orderNumber: 'SY-2026-0200', source: 'AI Intake' });
    const byPaste = await pasted(3, 60);

    expect(byPaste.order.offerId, 'الطلب بلا عرض').toBe(THREE_PLUS_ONE.id);
    expect(byPaste.order.offerId).toBe(byHand.order.offerId);
    // The store says «no», the bundle says «delivery is in the price»: the bundle wins, as at the manual door.
    expect(byPaste.order.priceIncludesDelivery, 'العرض يشمل التوصيل والطلب كُتب بغيره').toBe(true);
    expect(byPaste.order.priceIncludesDelivery).toBe(byHand.order.priceIncludesDelivery);
    // Four units leave the shelf and the cost says so: 4 × 5.
    expect(byPaste.order.estimatedCostOfGoods).toBe(UNIT_COST * 4);
    expect(byPaste.order.estimatedCostOfGoods).toBe(byHand.order.estimatedCostOfGoods);
    expect(byPaste.order.totalAmount).toBe(60);
    expect(byPaste.order.totalAmount).toBe(byHand.order.totalAmount);
    expect(byPaste.order.quantity).toBe(byHand.order.quantity);
  });

  it('وعرضٌ بخصم: ٢٥ بخصم ٣ يُكتب ٢٢ بالبابين — والخصم لا يُطرح مرتين', async () => {
    const withDiscount = { ...THREE_PLUS_ONE, id: 'off-two-pieces-0001', name: 'قطعتان', quantity: 2, freeQuantity: 0, sellingPrice: 25, discount: 3 };
    sell(withDiscount);
    const byHand = await typed(withDiscount, 2, 25, 'top');
    vi.clearAllMocks();
    db.$transaction.mockImplementation(async (fn: unknown) => (typeof fn === 'function' ? (fn as (tx: unknown) => unknown)(db) : fn));
    db.order.create.mockResolvedValue({ id: 'o-new', orderNumber: 'SY-2026-0200', source: 'AI Intake' });
    const byPaste = await pasted(2, 22);

    expect(byHand.order.totalAmount).toBe(22);
    expect(byPaste.order.totalAmount).toBe(22);
    expect(byPaste.order.totalAmount, 'الخصم طُبِّق مرتين').not.toBe(19);
    expect(byPaste.order.offerId).toBe('off-two-pieces-0001');
    expect(byPaste.line.freeQuantity).toBe(0);
  });

  it('وكميةٌ لا عرضَ لها بالضبط: لا عرض ولا هدية، وسياسة المتجر وحدها — والتكلفة على القطع المدفوعة فقط', async () => {
    sell(THREE_PLUS_ONE);
    // Four pieces is not the bundle of three: RV151 — an offer of three is not the price of four.
    const byPaste = await pasted(4, 80);
    expect(byPaste.order.offerId).toBeNull();
    expect(byPaste.line.freeQuantity).toBe(0);
    expect(byPaste.order.priceIncludesDelivery).toBe(false);
    expect(byPaste.order.estimatedCostOfGoods).toBe(UNIT_COST * 4);
    expect(byPaste.order.totalAmount).toBe(80);
  });

  it('وعرضٌ لا يشمل التوصيل لا يُشمِلُه: سياسة المتجر هي الجواب', async () => {
    const noDelivery = { ...THREE_PLUS_ONE, deliveryIncluded: false };
    sell(noDelivery);
    const byPaste = await pasted(3, 60);
    expect(byPaste.order.offerId).toBe(noDelivery.id);
    expect(byPaste.order.priceIncludesDelivery).toBe(false);
  });

  it('وعرضٌ بلا هدية يكتب سطراً بلا هدية — لا صفر مخترَع ولا واحد', async () => {
    const noGift = { ...THREE_PLUS_ONE, freeQuantity: 0, name: 'ثلاث قطع' };
    sell(noGift);
    const byPaste = await pasted(3, 60);
    expect(byPaste.line.freeQuantity).toBe(0);
    expect(byPaste.order.estimatedCostOfGoods).toBe(UNIT_COST * 3);
  });

  it('وسعرٌ غير سعر العرض يبقى مرفوضاً قبل أن يُكتب شيء (RV151 لم يتغيّر)', async () => {
    sell(THREE_PLUS_ONE);
    const res = await aiPOST(
      new Request('http://localhost/api/orders/ai-intake', asJson({
        confirm: true,
        parsed: { customerName: 'محمد الحسن', phone: '0944555666', productId: PRODUCT.id, quantity: 3, finalPrice: 5 },
      })),
    );
    expect(res.status).toBe(409);
    expect(db.order.create).not.toHaveBeenCalled();
  });

  it('والباب اليدوي والباب الذكي يستعملان القاعدة نفسها بالاسم — لا حساب ثانٍ للهدية', () => {
    const ai = stripComments(repoFile('src/app/api/orders/ai-intake/route.ts'));
    const hand = stripComments(repoFile('src/app/api/orders/route.ts'));
    expect(ai).toMatch(/import \{ giftUnits \} from '@\/lib\/offer-gift'/);
    expect(hand).toMatch(/import \{ giftUnits \} from '@\/lib\/offer-gift'/);
    expect(ai).toContain('giftUnits(quantityOffer, qty)');
    expect(ai, 'ضربُ الهدية بعدد القطع عاد').not.toMatch(/freeQuantity\s*\*\s*qty|qty\s*\*\s*[\w.]*freeQuantity/);
  });
});

describe('RV173 — المعاينة تقترح العرض الأقرب لكمية الرسالة، أو لا شيء', () => {
  const view = (quantity: number, price: number, name: string, id: string) =>
    toOfferView({ ...THREE_PLUS_ONE, id, name, quantity, freeQuantity: 0, sellingPrice: price, discount: 0 }, SYRIA.minorUnit);

  async function previewFor(quantity: number, offers: ReturnType<typeof view>[], price: number | null = null) {
    parseOrderText.mockImplementation(() => ({
      customerName: 'سامر', phone: '0944555666', governorate: 'دمشق', address: 'شارع',
      productQuery: 'كريم', quantity, price, notes: '', source: '',
    }));
    matchProduct.mockReturnValue({ id: PRODUCT.id, name: PRODUCT.name, sku: 'S', score: 40 });
    db.product.findMany.mockResolvedValue([{ id: PRODUCT.id, name: PRODUCT.name, sku: 'S' }]);
    db.customer.findFirst.mockResolvedValue(null);
    activeOffersFor.mockResolvedValue(offers);
    const res = await aiPOST(new Request('http://localhost/api/orders/ai-intake', asJson({ text: 'طلب' })));
    expect(res.status).toBe(200);
    return (await res.json()) as { suggestedPrice: number | null; suggestedOfferName: string | null; priceFromOffer: boolean };
  }

  const ONE = () => view(1, 10, 'قطعة', 'o1');
  const TWO = () => view(2, 18, 'قطعتان', 'o2');
  const FOUR = () => view(4, 30, 'أربع قطع', 'o4');

  it('لثلاث قطع وعرضان (١ و٢): الأقرب هو ٢ — لا أول صفٍّ في القائمة', async () => {
    const json = await previewFor(3, [ONE(), TWO()]);
    expect(json.suggestedOfferName, 'عاد أول صف').not.toBe('قطعة');
    expect(json.suggestedOfferName).toBe('قطعتان');
    expect(json.suggestedPrice).toBe(18);
    expect(json.priceFromOffer, 'ما ليس مطابقاً لا يُقفَل').toBe(false);
  });

  it('وإذا تساوى بُعدان (٢ و٤ لثلاث): لا شيء — لا يُختار الأرخص ولا الأول', async () => {
    const json = await previewFor(3, [TWO(), FOUR()]);
    expect(json.suggestedOfferName).toBeNull();
    expect(json.suggestedPrice).toBeNull();
  });

  it('والمطابق بالضبط يغلب الأقرب ويُقفَل كما كان', async () => {
    const json = await previewFor(2, [ONE(), TWO(), FOUR()]);
    expect(json.suggestedOfferName).toBe('قطعتان');
    expect(json.suggestedPrice).toBe(18);
    expect(json.priceFromOffer).toBe(true);
  });

  it('وسعرٌ ذكره الزبون يبقى مقترَحاً فوق عرضٍ غير مطابق — لا يستبدله العرض الأقرب', async () => {
    const json = await previewFor(3, [ONE(), TWO()], 40);
    expect(json.suggestedPrice).toBe(40);
    expect(json.suggestedOfferName).toBe('قطعتان');
  });
});
