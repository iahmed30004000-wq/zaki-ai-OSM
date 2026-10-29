import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE REVIEWER IS SHOWN WHAT THE OFFER PROMISES — OR THEY CONFIRM A CHARGE
 * NOBODY INTENDED.
 *
 * `POST /api/orders/ai-intake` has two modes. The preview parses a pasted
 * message and SUGGESTS a price; the confirm mode raises the order from the
 * number the reviewer accepted. `AiOrderModal` copies `suggestedPrice`
 * straight into `finalPrice`, and `finalPrice` becomes `sellingPrice` and
 * the order's `totalAmount`. So the suggestion is a money write with one
 * human keystroke in the middle of it.
 *
 * THE DEFECT. The suggestion was `qtyOffer.price`, and `qtyOffer` comes from
 * `activeOffersFor`, whose `OfferView` has no `discount` field and whose
 * query does not select that column. An offer of `sellingPrice: 25` with
 * `discount: 3`:
 *
 *   the reviewer was shown   25
 *   every other door charges 22   (createPublicOrder, the cart quote, POST /orders)
 *   so the customer paid     25
 *
 * It was argued that a human confirming the figure makes this not a money
 * write. It is the opposite: the confirmation is what turns the wrong number
 * into a charge, and a reviewer cannot catch an error they are never shown.
 *
 * WHY THE DISCOUNT IS READ WITH A SECOND QUERY. `OfferView` is the shape
 * four PUBLIC surfaces hand to browsers; `offers.ts:25` keeps the marketing
 * number (`compareAtPrice`) and the money number (`discount`) apart on
 * purpose, and widening the view would leak the money figure to shoppers. So
 * the column is read server-side, keyed on the offer id already chosen, the
 * way `resolvePublicLines` reads it for a basket.
 *
 * WHAT THESE TESTS ARE WORTH. They drive the real route with the real
 * `money.ts` — `computeCod`, `allocateDiscount` and `roundMinor` are NOT
 * mocked, so the clamp and the currency's rounding are the shipped ones. The
 * mocked `activeOffersFor` returns a frozen view with NO `discount` property,
 * so a route that tried to read the figure off the view would get `undefined`
 * and land back on 25 — which these tests fail on, by the number.
 */

const {
  db,
  requireContext,
  requirePermission,
  logAudit,
  notify,
  findOrCreateCustomer,
  productCost,
  resolveRegionId,
  orderRefFields,
  activeBlock,
  activeOffersFor,
  parseOrderText,
  matchProduct,
} = vi.hoisted(() => ({
  db: {
    product: { findFirst: vi.fn(), findMany: vi.fn() },
    /*
     * The AI door now asks the store what its prices mean. It wrote
     * nothing before, so every order through it took the schema
     * default and the shipment added a fee to a delivery-inclusive
     * price. «No» keeps these fixtures saying what they said.
     */
    store: { findFirst: vi.fn(async () => ({ priceIncludesDelivery: false })) },
    offer: { findFirst: vi.fn() },
    user: { findFirst: vi.fn() },
    order: { create: vi.fn() },
    orderItem: { create: vi.fn() },
    customer: { update: vi.fn(), findFirst: vi.fn() },
    orderActivity: { create: vi.fn() },
    // The opening row of the state history, which this door now writes
    // beside the order — see `an-order-and-its-lines-are-one-write`.
    orderStatusLog: { create: vi.fn() },
    /*
     * THE DOUBLE IS GIVEN THE TRANSACTION, NOT THE CODE A WAY AROUND IT.
     *
     * `ai-intake` writes the order, its line, the customer's counters, the
     * activity and the opening state row in ONE transaction, because a
     * failure between the first two leaves a LINELESS ORDER — the one shape
     * no money rule in this product can price.
     *
     * So the fake hands the same object back as the transaction client, the
     * way six other doubles in this repository already do. The alternative
     * was to accommodate the fake by splitting the writes again, and that
     * is the mistake this repository has a name for: a test double is not a
     * reason to make the product worse.
     */
    $transaction: vi.fn(async (fn: unknown) =>
      typeof fn === 'function' ? (fn as (tx: unknown) => unknown)(db) : fn
    ),
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
  notify: vi.fn(),
  findOrCreateCustomer: vi.fn(),
  productCost: vi.fn(),
  resolveRegionId: vi.fn(),
  orderRefFields: vi.fn(),
  activeBlock: vi.fn(),
  activeOffersFor: vi.fn(),
  parseOrderText: vi.fn(),
  matchProduct: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  /*
   * `can` answers «does this account keep the orders it enters?»
   * (`entryOwnership`). False: these tests are about the money and the
   * payload, and an entry that goes to the pull queue is what every
   * one of them has always asserted. `order-entry-ownership.test.ts`
   * owns the rule itself.
   */
  can: () => false, requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/notify', () => ({ notify: (...a: unknown[]) => notify(...a) }));
vi.mock('@/lib/customer-identity', () => ({
  findOrCreateCustomer: (...a: unknown[]) => findOrCreateCustomer(...a),
}));
vi.mock('@/lib/product-cost', () => ({ productCost: (...a: unknown[]) => productCost(...a) }));
vi.mock('@/lib/regions', () => ({ resolveRegionId: (...a: unknown[]) => resolveRegionId(...a) }));
vi.mock('@/lib/order-ref', () => ({ orderRefFields: (...a: unknown[]) => orderRefFields(...a) }));
vi.mock('@/lib/blacklist', () => ({ activeBlock: (...a: unknown[]) => activeBlock(...a) }));
vi.mock('@/lib/offers', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  activeOffersFor: (...a: unknown[]) => activeOffersFor(...a),
}));
// The parse is not the subject: the price is. Everything else in the parser
// module stays real so a rename there is still a compile error here.
vi.mock('@/lib/order-parser', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  parseOrderText: (...a: unknown[]) => parseOrderText(...a),
  matchProduct: (...a: unknown[]) => matchProduct(...a),
}));

import { repoFile, stripComments } from '@/lib/guard-source';
// The real one: the view the route reads is built by it, not typed out.
import { toOfferView } from '@/lib/offers';

const { POST } = await import('@/app/api/orders/ai-intake/route');

/** JOD: three decimals. The rounding rule is the currency's, never a global one. */
const JOD = { orderPrefix: 'JO', minorUnit: 3, currencyCode: 'JOD', allowNegativeStock: false };
/** SYP: whole units — the same inputs must round differently here. */
const SYP = { orderPrefix: 'SY', minorUnit: 0, currencyCode: 'SYP', allowNegativeStock: false };

/**
 * THE OFFER ROW, as `activeOffersFor` selects it — the money column
 * included, which is the change this file was rewritten for.
 *
 * It used to be a frozen VIEW with no `discount` property, so that a route
 * reaching for the money figure could not be fed one. That was the right
 * guard for the wrong architecture: keeping the column out of the view is
 * what left `price` at 25 while every door charged 22.
 */
const OFFER_ROW = Object.freeze({
  id: 'off-25',
  name: 'قطعتان',
  /** PIECES PER PICK. 25 is the bundle's total, never a unit price. */
  quantity: 2,
  freeQuantity: 0,
  sellingPrice: 25,
  discount: 3,
  compareAtPrice: null,
  isDefault: true,
  deliveryIncluded: false,
  endsAt: null,
});

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/orders/ai-intake', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );

/** The preview mode, answered as JSON. */
async function preview(text = 'اسمي سامر ورقمي 0999111222 وبدي قطعتين من منتج أ') {
  const res = await post({ text });
  const json = await res.json();
  expect(res.status, JSON.stringify(json)).toBe(200);
  return json as { suggestedPrice: number | null; suggestedOfferName: string | null };
}

/**
 * THE VIEW THE ROUTE IS HANDED, BUILT BY THE REAL `toOfferView`.
 *
 * A second, by-id read of `Offer.discount` used to stand here and this
 * helper mocked it. The reduction is applied once now, inside
 * `activeOffersFor`, so there is nothing left for the route to ask — and
 * the honest way to mock a function that does arithmetic is to let it do
 * the arithmetic. `toOfferView` is imported for real through
 * `importOriginal`, so the rounding tests below still measure the one
 * rounding rule rather than a number typed into a fixture.
 */
function discountIs(discount: number, minorUnit = JOD.minorUnit) {
  activeOffersFor.mockResolvedValue([
    toOfferView({ ...OFFER_ROW, discount }, minorUnit),
  ]);
}

beforeEach(() => {
  vi.resetAllMocks();
  // No key: the model path is skipped and the deterministic parser is used.
  delete process.env.OPENROUTER_API_KEY;

  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'موظف', role: 'ADMIN' },
    companyId: 'c1',
    storeId: 's1',
    countryId: 'jo',
    country: JOD,
  });
  requirePermission.mockResolvedValue(undefined);
  activeBlock.mockResolvedValue(null);
  parseOrderText.mockImplementation(() => ({
    customerName: 'سامر الأحمد',
    phone: '0999111222',
    governorate: 'عمّان',
    address: 'شارع',
    productQuery: 'منتج أ',
    quantity: 2,
    price: null,
    notes: '',
    source: '',
  }));
  matchProduct.mockReturnValue({ id: 'p-a', name: 'منتج أ', sku: 'SKU-A', score: 40 });
  db.product.findMany.mockResolvedValue([{ id: 'p-a', name: 'منتج أ', sku: 'SKU-A' }]);
  db.customer.findFirst.mockResolvedValue(null);
  activeOffersFor.mockResolvedValue([toOfferView(OFFER_ROW, JOD.minorUnit)]);
  discountIs(3);

  // The write path's cast, used only by the confirm tests.
  db.product.findFirst.mockResolvedValue({
    id: 'p-a',
    companyId: 'c1',
    name: 'منتج أ',
    basePrice: 99,
    image: null,
    batches: [],
  });
  findOrCreateCustomer.mockResolvedValue({ id: 'cust1', city: 'عمّان', firstOrderDate: null });
  productCost.mockResolvedValue({ average: 7 });
  orderRefFields.mockResolvedValue({ merchantReference: 'JO-1' });
  resolveRegionId.mockResolvedValue('r1');
  db.order.create.mockResolvedValue({ id: 'o1', orderNumber: 1, source: 'AI Intake' });
  db.orderItem.create.mockResolvedValue({});
  db.customer.update.mockResolvedValue({});
  db.orderActivity.create.mockResolvedValue({});
  logAudit.mockResolvedValue(undefined);
  notify.mockReturnValue(undefined);
});

afterEach(() => {
  delete process.env.OPENROUTER_API_KEY;
});

describe('المقترَح للمراجع هو ما يَعِدُ به العرضُ فعلاً', () => {
  it('عرضٌ ٢٥ بخصمٍ ٣: يُقترَح ٢٢، لا ٢٥', async () => {
    const json = await preview();
    expect(
      json.suggestedPrice,
      'المراجع يرى السعرَ المعلَن ٢٥ والعرضُ يَقبِض ٢٢ — فيُؤكّد رقماً لا يُطابق أيَّ بابٍ آخر'
    ).toBe(22);
    expect(json.suggestedPrice).not.toBe(25);
    // The offer is still named, so the reviewer knows which bundle this is.
    expect(json.suggestedOfferName).toBe('قطعتان');
  });

  it('ولا استعلامَ ثانيَ للخصمِ أصلاً — العرضُ المُسلَّمُ يَحمِلُه', async () => {
    await preview();
    // The catalogue read still happens — the positive control. Without it a
    // «no second read» assertion would pass on a route that reads nothing.
    expect(activeOffersFor).toHaveBeenCalledTimes(1);
    // And nothing else asks the offer table anything.
    expect(db.offer.findFirst).toHaveBeenCalledTimes(0);
    // The view it comes from carries both figures, which is why: what is
    // charged, and what the bundle costs before its own reduction.
    const view = toOfferView(OFFER_ROW, JOD.minorUnit);
    expect(view.price).toBe(22);
    expect(view.listPrice).toBe(25);
  });

  it('خصمٌ أكبرُ من السعرِ يَقِفُ عند صفر ولا يَنقلب', async () => {
    discountIs(30);
    const json = await preview();
    expect(json.suggestedPrice).toBe(0);
    expect(json.suggestedPrice).toBeGreaterThanOrEqual(0);
  });

  it('والتدويرُ تدويرُ عملةِ الطلبِ وحدَها — ٢٢٫٦ بالدينار و٢٣ بالليرة', async () => {
    discountIs(2.4);
    // JOD, three decimals: nothing to round away.
    expect((await preview()).suggestedPrice).toBe(22.6);

    // The same offer, the same discount, a whole-unit currency: the
    // reduction rounds to 2 and the suggestion is 23. A file doing its own
    // `25 - 2.4` would answer 22.6 here too.
    requireContext.mockResolvedValue({
      user: { id: 'u1', name: 'موظف', role: 'ADMIN' },
      companyId: 'c1',
      storeId: 's1',
      countryId: 'sy',
      country: SYP,
    });
    // The same offer and the same reduction, read in the whole-unit
    // currency: `allocateDiscount` rounds 2.4 to 2 and the suggestion is 23.
    // A file doing its own `25 - 2.4` would answer 22.6 here too.
    discountIs(2.4, SYP.minorUnit);
    expect((await preview()).suggestedPrice).toBe(23);
  });

  it('وخصمُ صفرٍ يُبقي السعرَ المعلَنَ كما هو', async () => {
    discountIs(0);
    expect((await preview()).suggestedPrice).toBe(25);
  });

  /*
   * REVERSED BY THE OWNER, 27/10 (RV151): «سعر العرض هو اللي بيمشي بإدخال
   * الطلب بالذكاء». This test said the customer's figure beat the offer —
   * «السعر: 5» beside a bundle of 22 opened the box on 5, and one keystroke
   * made it the charge.
   */
  it('وسعرٌ ذكرَه الزبونُ في رسالتِه لا يَسبِقُ العرضَ — يُقترَح سعرُ العرض ويُقال رقمُ الزبون بجانبه', async () => {
    parseOrderText.mockImplementation(() => ({
      customerName: 'سامر الأحمد',
      phone: '0999111222',
      governorate: 'عمّان',
      address: 'شارع',
      productQuery: 'منتج أ',
      quantity: 2,
      price: 19,
      notes: '',
      source: '',
    }));
    const json = (await preview()) as Record<string, unknown>;
    expect(json.suggestedPrice, 'رقمُ الزبون غلبَ العرض').toBe(22);
    expect(json.suggestedOfferName).toBe('قطعتان');
    expect(json.priceFromOffer).toBe(true);
    expect(json.typedPrice).toBe(19);
    expect(json.offerPrices).toEqual([{ quantity: 2, price: 22, name: 'قطعتان' }]);
    expect(db.offer.findFirst).not.toHaveBeenCalled();
  });

  it('ورقمُ الزبونِ إذا ساوى سعرَ العرضِ لا يُقال، فلا تنبيهَ بلا سبب', async () => {
    parseOrderText.mockImplementation(() => ({
      customerName: 'سامر الأحمد', phone: '0999111222', governorate: 'عمّان', address: 'شارع',
      productQuery: 'منتج أ', quantity: 2, price: 22, notes: '', source: '',
    }));
    const json = (await preview()) as Record<string, unknown>;
    expect(json.suggestedPrice).toBe(22);
    expect(json.typedPrice).toBeNull();
  });

  it('ورقمٌ فوقَ حدِّ أيِّ سعرٍ (١٥٠٠٠٠) لا يُحمَل كرقمِ الزبون — فلا يَسُدُّ التسجيلَ بعدها', async () => {
    parseOrderText.mockImplementation(() => ({
      customerName: 'سامر الأحمد', phone: '0999111222', governorate: 'عمّان', address: 'شارع',
      productQuery: 'منتج أ', quantity: 2, price: 150000, notes: '', source: '',
    }));
    const json = (await preview()) as Record<string, unknown>;
    expect(json.suggestedPrice).toBe(22);
    expect(json.typedPrice).toBeNull();
  });

  it('وكميّةٌ لا عرضَ لها بالضبط: لا يُقفَل المربّع، ورقمُ الرسالةِ يبقى اقتراحاً كما كان', async () => {
    parseOrderText.mockImplementation(() => ({
      customerName: 'سامر الأحمد', phone: '0999111222', governorate: 'عمّان', address: 'شارع',
      productQuery: 'منتج أ', quantity: 3, price: 30, notes: '', source: '',
    }));
    const json = (await preview()) as Record<string, unknown>;
    // An offer of two is not the price of three.
    expect(json.priceFromOffer).toBe(false);
    expect(json.typedPrice).toBeNull();
    expect(json.suggestedPrice).toBe(30);
  });

  it('وبلا عرضٍ حيٍّ لا يُقترَح شيءٌ ولا يُستعلَم عن خصم', async () => {
    activeOffersFor.mockResolvedValue([]);
    const json = await preview();
    expect(json.suggestedPrice).toBeNull();
    expect(json.suggestedOfferName).toBeNull();
    expect(db.offer.findFirst).not.toHaveBeenCalled();
  });
});

/**
 * THE WRITE PATH, RE-JUDGED.
 *
 * It binds the bundle whose quantity the paste matches (RV172: the order's `offerId`, the gift on the line, the
 * delivery policy — `an-offer-pasted-is-the-offer-typed.test.ts`) but it passes no `discount`, and its
 * `NO_OFFER_BOUND` entry stands: the figure it is handed is already the bundle's NET price. These two tests pin the
 * reason, because the obvious «fix» to that entry is the dangerous one: now that the preview hands over the NET figure,
 * passing the discount here too would charge 19 for an offer that promises 22.
 */
describe('وبابُ الكتابةِ يقبض ما أكّدَه المراجعُ، لا أقلَّ منه', () => {
  const confirm = (finalPrice: number) =>
    post({
      confirm: true,
      parsed: {
        customerName: 'سامر الأحمد',
        phone: '0999111222',
        address: 'شارع',
        governorate: 'عمّان',
        productId: 'p-axxxxxxxxxx',
        quantity: 2,
        finalPrice,
      },
    });

  it('٢٢ مؤكَّدةً تُكتَب ٢٢ — لا ١٩، فالخصمُ لا يُحسَب مرّتَين', async () => {
    const res = await confirm(22);
    expect(res.status).toBe(200);
    const data = db.order.create.mock.calls[0][0].data;
    expect(data.totalAmount).toBe(22);
    expect(data.sellingPrice).toBe(22);
    expect(data.totalAmount, 'الخصمُ طُبِّق مرّةً في الاقتراحِ ومرّةً هنا').not.toBe(19);
  });

  it('ويسألُ العروضَ مرّةً واحدةً بالقراءةِ المشتركة — لا قراءةَ ثانيةً للخصم', async () => {
    await confirm(22);
    expect(db.offer.findFirst).not.toHaveBeenCalled();
    // Once, to know the bundle's price for this quantity (RV151) — the same view the preview reads.
    expect(activeOffersFor).toHaveBeenCalledTimes(1);
  });

  /**
   * AND A ZERO IS A PRICE, NOT A GAP.
   *
   * `const price = p.finalPrice || product.basePrice` stood here under a
   * comment saying it matched `POST /orders`. It did not — that door writes
   * `sellingPrice ?? 0` — and `offers.ts` names this exact expression as
   * the one door of four that disagrees, while ruling in writing that «a
   * free bundle is a pricing decision».
   *
   * The fixture's `basePrice` is 99, which is the number the old reading
   * charged for an order a person had just confirmed at zero.
   */
  it('وصفرٌ مؤكَّدٌ يُكتَب صفراً — لا ٩٩، سعرَ المنتجِ الذي لم يَطلُبْه أحد', async () => {
    // No bundle for this product: the reviewer's figure is the price (with one, the offer's is — RV151).
    activeOffersFor.mockResolvedValue([]);
    const res = await confirm(0);
    expect(res.status).toBe(200);
    const data = db.order.create.mock.calls[0][0].data;
    expect(data.totalAmount, 'سعرُ المنتجِ حلَّ محلَّ صفرٍ كتبَه المراجع').not.toBe(99);
    expect(data.totalAmount).toBe(0);
    expect(data.sellingPrice).toBe(0);
  });

  it('ومع ذلك يبقى غيابُ السعرِ مرفوضاً بالاسم — فالصفرُ ليس بديلاً عن الغياب', async () => {
    /*
     * This is what makes deleting the fallback safe rather than reckless:
     * `finalPrice: amount(100000)` is REQUIRED, so the route never has to
     * guess at a missing price — it refuses the payload and says which
     * field. The two cases stay two cases all the way to the column.
     */
    const res = await post({
      confirm: true,
      parsed: {
        customerName: 'سامر الأحمد',
        phone: '0999111222',
        address: 'شارع',
        governorate: 'عمّان',
        productId: 'p-axxxxxxxxxx',
        quantity: 2,
      },
    });
    expect(res.status).toBe(400);
    expect(db.order.create).not.toHaveBeenCalled();
  });

  it('وسعرٌ موجبٌ يمرّ كما هو، فالحذفُ لم يَكسِرِ الحالةَ الشائعة', async () => {
    activeOffersFor.mockResolvedValue([]);
    const res = await confirm(45.5);
    expect(res.status).toBe(200);
    expect(db.order.create.mock.calls[0][0].data.totalAmount).toBe(45.5);
  });
});

/**
 * سعرُ العرضِ هو الذي يُكتَب — قرارُ المالك، ٢٧/١٠ (RV151).
 *
 * The preview locks the box on the offer's price; the write holds the same
 * rule, so a box edited around the lock, a product changed after the parse
 * or a hand-made payload cannot record a bundle at a price it does not have.
 */
describe('وبابُ الكتابةِ يُسجِّلُ سعرَ العرضِ لكميّتِه بالضبط', () => {
  const confirmAt = (finalPrice: number, quantity = 2, extra: Record<string, unknown> = {}) =>
    post({
      confirm: true,
      parsed: {
        customerName: 'سامر الأحمد',
        phone: '0999111222',
        address: 'شارع',
        governorate: 'عمّان',
        productId: 'p-axxxxxxxxxx',
        quantity,
        finalPrice,
        ...extra,
      },
    });

  it('NEGATIVE: «السعر: ٥» بجانب عرضٍ بـ٢٢ يُرفَض بسعرِ العرض، ولا يُكتَب شيء', async () => {
    const res = await confirmAt(5);
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe('OFFER_PRICE');
    expect(json.offerPrice).toBe(22);
    expect(json.offerName).toBe('قطعتان');
    expect(json.error).toContain('قطعتان');
    expect(db.order.create).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
    // and no customer row is left behind a refused confirmation
    expect(findOrCreateCustomer).not.toHaveBeenCalled();
  });

  it('وسعرُ العرضِ نفسُه يمرّ، ورقمُ الزبونِ يُحفَظ بتاريخِ الطلبِ — لا بملاحظتِه التي تُطبَع للشركة', async () => {
    const res = await confirmAt(22, 2, { typedPrice: 5, notes: 'بعد العصر' });
    expect(res.status).toBe(200);
    const data = db.order.create.mock.calls[0][0].data;
    expect(data.totalAmount).toBe(22);
    expect(data.customerNotes).toBe('بعد العصر');
    const meta = JSON.parse(db.orderActivity.create.mock.calls[0][0].data.metadata);
    expect(meta.customerTypedPrice).toBe(5);
  });

  it('ورقمُ الزبونِ سجلٌّ لا شرط: رقمٌ خارجَ الحدِّ يُسقَط ولا يَرُدُّ الطلب', async () => {
    const res = await confirmAt(22, 2, { typedPrice: 150000 });
    expect(res.status).toBe(200);
    const meta = JSON.parse(db.orderActivity.create.mock.calls[0][0].data.metadata);
    expect(meta).not.toHaveProperty('customerTypedPrice');
  });

  it('وبلا رقمٍ من الزبونِ لا يُكتَب في التاريخِ شيءٌ عنه', async () => {
    await confirmAt(22);
    const meta = JSON.parse(db.orderActivity.create.mock.calls[0][0].data.metadata);
    expect(meta).not.toHaveProperty('customerTypedPrice');
  });

  it('وكميّةٌ لا عرضَ لها بالضبط تُكتَب بما أكّدَه المراجع — عرضُ قطعتين ليس سعرَ ثلاث', async () => {
    const res = await confirmAt(30, 3);
    expect(res.status).toBe(200);
    expect(db.order.create.mock.calls[0][0].data.totalAmount).toBe(30);
  });

  it('والمقارنةُ بتدويرِ عملةِ الطلب — لا يُرفَض فرقُ كسرٍ لا تحمله العملة', async () => {
    // SYP has no minor unit: a bundle of 23 (25 − 2.4, rounded by the currency) and a box of 23 agree.
    requireContext.mockResolvedValue({
      user: { id: 'u1', name: 'موظف', role: 'ADMIN' },
      companyId: 'c1', storeId: 's1', countryId: 'sy', country: SYP,
    });
    discountIs(2.4, SYP.minorUnit);
    const res = await confirmAt(23);
    expect(res.status).toBe(200);
  });
});

/**
 * ONE PLACE COMPUTES MONEY. Not a check that a name appears — the numbers
 * above are that — but a check that no THIRD arithmetic has been added
 * beside them: two `computeCod` calls in this file (the preview and the
 * write), and no rounding of its own.
 */
describe('وحسابُ المالِ يبقى في money.ts', () => {
  const src = () => stripComments(repoFile('src/app/api/orders/ai-intake/route.ts'));

  it('نداءٌ واحدٌ لـ computeCod ولا ثانٍ', () => {
    /*
     * It was two: one to raise the order and one the suggestion did of its
     * own, beside a second read of `Offer.discount`. Both are gone — the
     * view hands the route the charged figure, and a second subtraction
     * here would charge 19 for a bundle promising 22.
     */
    expect(src().match(/computeCod\(/g) ?? []).toHaveLength(1);
    // Was `suggestedPrice = qtyOffer.price;` (the suggestion for ANY nearest bundle). RV173, reviewer's ruling: only the
    // bundle of EXACTLY this quantity is priced; the nearest is named and the box stays empty.
    expect(src()).toContain('suggestedPrice = exact.price;');
    expect(src(), 'عاد تسعيرُ عرضٍ لكميّةٍ مختلفة').not.toContain('suggestedPrice = qtyOffer.price');
  });

  it('ولا تدويرَ من عندِه', () => {
    expect(src()).not.toMatch(/Math\.round|toFixed/);
  });

  it('ولا سعرَ احتياطيٍّ خلفَ السعرِ المؤكَّد — ولا حتى بـ ??', () => {
    /*
     * THE NUMBERS ABOVE CANNOT SEE THIS ONE.
     *
     * Restoring `|| product.basePrice` dies by the number — 99 against 0.
     * Restoring `?? product.basePrice` does NOT: `finalPrice` is a required
     * field, so it is never null or undefined and that branch can never
     * run. Every test passes and the line reads, to anyone opening the
     * file, like a live fallback policy.
     *
     * That is the defect this repository has met before — a fallback that
     * can never fire is worse than none, because it is believed. So the
     * absence is pinned here rather than only its behaviour.
     */
    expect(src()).toContain('const price = p.finalPrice;');
    expect(src(), 'سعرٌ احتياطيٌّ عادَ خلفَ ما أكّدَه المراجع').not.toMatch(
      /p\.finalPrice\s*(?:\|\||\?\?)/
    );
  });
});
