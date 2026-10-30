import { z } from 'zod';
import { computeCod, moneyText, roundMinor, type CodBreakdown } from './money';
import { giftUnits } from './offer-gift';
import { count, money as amount } from './numeric-input';

/**
 * THE LINES ENGINE — what an edit of an order's lines MEANS, with no database and no network.
 *
 * A confirmed order is changed through a request, and the request used to carry one field at a time. The owner:
 * «أقدر أعدل كذا شغلة بنفس الوقت، مثلاً الكمية أكيد بتتطلب أغير معها السعر… بدي تعمل بمنطق تحلل وبذكاء، والأهم
 * بدون ما تخرب، وأي تأثير مالي أو مخزون بدك تاخدو بعين الاعتبار».
 *
 * This file is the arithmetic and the judgement of that, as pure functions. The facts it works on are READ elsewhere
 * (`order-edit-facts.ts`) and handed in, so a test can feed it any order and nothing here can write a row.
 *
 * WHAT IT DOES NOT DO, ON PURPOSE:
 *
 *   · It adds no formula. The money of a draft is `computeCod`, called exactly the way `PATCH /api/orders/[id]` calls
 *     it for a lines save (a line's TOTAL divided by its quantity, the same discount, the same fee, the same add-ons).
 *     `priceOrderLines` below is the single wrapper on THIS side. It is NOT shared with the save: `PATCH` calls
 *     `computeCod` itself, so the two agree because they call the same function the same way, and only a TEST holds
 *     that (`the-preview-and-the-save-agree.test.ts` feeds the same lines to the real `PATCH`). If the save ever
 *     changes how it calls `computeCod`, that test is what turns red — not the compiler.
 *   · It guesses nothing. A line it cannot find, a basis it cannot price, a fee source that disagrees with itself, a
 *     line already delivered: each is a REFUSAL with a sentence, never a plausible number.
 *   · It uses no language model. Everything here is arithmetic the reader can reproduce by hand, so no customer data
 *     goes anywhere.
 *
 * AND THE VOCABULARY. A «line total» in this file is what the line costs BEFORE the order's own discount, for the
 * PAID units only — the figure `PATCH` reads as `items[].unitPrice` and the lines card opens its price box on
 * (`totalsBeforeDiscount`). The order's discount is spread over the lines afterwards by `computeCod`, never here.
 */

/* ═══════════════════════════ constants ═══════════════════════════ */

/** The same ceiling as the lines save (`items.max(20)`): a draft the door would refuse is not previewed as fine. */
export const MAX_EDIT_LINES = 20;

/**
 * A unit price below half, or above double, the product's base price is worth a second look — a warning, not a
 * refusal: bundles and honest discounts exist. Adjustable here, in one place (owner rule: decide, record it).
 */
export const PRICE_FLOOR_RATIO = 0.5;
export const PRICE_CEILING_RATIO = 2;

/** How a line's new total was reached. `MANUAL` is a number a person typed; the others come from a rule. */
export const PRICE_BASES = ['KEEP_UNIT', 'OFFER', 'BASE_PRICE', 'MANUAL'] as const;
export type PriceBasis = (typeof PRICE_BASES)[number];

/* ═══════════════════════════ the draft (zod) ═══════════════════════════ */

/**
 * ONE LINE'S EDIT, as the browser may send it.
 *
 * Every value is a SUGGESTION. Nothing here is believed about the past: the `from` side of a change is taken from the
 * database by the server, never from this body (the rule `withFrom` already holds for the single fields).
 *
 * Bounds are the lines save's own (`count(999, 1)`, `amount(100000)`) so that a draft the preview accepts is a draft
 * the door will not refuse for its size. A price is EITHER a unit price OR a line total — both at once is two answers
 * to one question.
 */
const lineEditSchema = z
  .object({
    /** The stored line this edit is about. Never matched by product: two lines may hold the same one. */
    lineId: z.string().min(1).max(64),
    productId: z.string().min(10).max(64).optional(),
    /** The PAID units. The gift is the server's to work out, never a box. */
    quantity: count(999, 1).optional(),
    unitPrice: amount(100000).optional(),
    lineTotal: amount(100000).optional(),
    priceBasis: z.enum(PRICE_BASES).optional(),
    offerId: z.string().min(1).max(64).optional(),
  })
  .refine((l) => !(l.unitPrice !== undefined && l.lineTotal !== undefined), {
    message: 'اكتب سعر القطعة أو إجمالي السطر، مش الاثنين',
    path: ['lineTotal'],
  });

export type LineEditInput = z.infer<typeof lineEditSchema>;

/** The lines of a draft: at least one, at most twenty, and a line named once. */
export const lineEditsSchema = z
  .array(lineEditSchema)
  .min(1, 'ما في أسطر للتعديل')
  .max(MAX_EDIT_LINES, 'الحد الأعلى عشرين سطر')
  .refine((all) => new Set(all.map((l) => l.lineId)).size === all.length, {
    message: 'نفس السطر مكرر بالتعديل',
  });

/**
 * THE WHOLE DRAFT of «تعديل الطلب»: the lines, the order's discount, and the customer's own fields — the ones a
 * request can carry. Same bounds as the PATCH door's. Every key is optional; an empty draft previews "nothing changes".
 */
export const previewDraftSchema = z.object({
  lines: lineEditsSchema.optional(),
  discountAmount: amount(100000).optional(),
  regionId: z.string().uuid().nullable().optional(),
  customerName: z.string().trim().min(2).max(80).optional(),
  customerPhone: z.string().trim().min(7).max(20).optional(),
  customerAltPhone: z.string().trim().max(20).nullable().optional(),
  customerAddress: z.string().trim().max(300).optional(),
  customerNotes: z.string().trim().max(500).nullable().optional(),
});

export type PreviewDraft = z.infer<typeof previewDraftSchema>;

/* ═══════════════════════════ the facts it is handed ═══════════════════════════ */

/** A line as the database holds it. `lineTotal` is BEFORE the order's discount (see the file header). */
export interface StoredLine {
  id: string;
  productId: string;
  productName: string;
  quantity: number;
  freeQuantity: number;
  lineTotal: number;
  reservedQty: number;
  deliveredQty: number | null;
  returnedQty: number | null;
}

export interface ProductFact {
  id: string;
  name: string;
  basePrice: number;
  status: string;
}

/**
 * An offer as the doors charge it. `price` is what a bundle COSTS the customer (after the offer's own reduction —
 * `toOfferView`), `listPrice` the figure before it; they are equal when the offer has no reduction.
 */
export interface OfferFact {
  id: string;
  productId: string;
  name: string;
  quantity: number;
  freeQuantity: number;
  listPrice: number;
  price: number;
  /** On sale right now (`liveOfferWhere`). An ended offer is never priced from, never gifted from. */
  live: boolean;
}

export interface OrderFlags {
  /** Confirmed: its lines hold stock, and a change goes through a request. */
  confirmed: boolean;
  /** Cancelled, rejected, or already delivered/returned. */
  closed: boolean;
  /** The courier has taken the parcel (the press of «سُلّمت للشركة»). */
  handed: boolean;
  /** A printed waybill, or a barcode the company already holds. */
  labelled: boolean;
  /** A courier statement claims the order, or its settlement has moved past «قيد التحصيل». */
  statementLinked: boolean;
  priceIncludesDelivery: boolean;
  /** `Order.totalAmount` — what the courier was told to collect. */
  storedTotal: number;
  /** The fee `PATCH` recomputes with. */
  shippingCost: number;
  /** The fee the courier table wrote onto the order, when one did. A second source (see `FEE_SOURCE_DRIFT`). */
  deliveryFee: number | null;
  /** `Order.discountAmount`. */
  discount: number;
  version: number;
}

export interface CustomerFacts {
  phoneInvalid: boolean;
  altPhoneInvalid: boolean;
  phoneDuplicate: boolean;
  regionOutsideCountry: boolean;
  /** The courier table's fee for the NEW governorate against what the order carries; null when it cannot be said. */
  regionFee: { current: number; next: number } | null;
}

export interface OrderEditFacts {
  minorUnit: number;
  allowNegativeStock: boolean;
  order: OrderFlags;
  lines: StoredLine[];
  addOns: { productId: string; quantity: number; price: number }[];
  products: ProductFact[];
  /** Live offers of the products involved. */
  offers: OfferFact[];
  /** The offer the order was taken on, live or not. */
  orderOffer: OfferFact | null;
  /** Units a new reservation by THIS order could take, per product (the order's own holding left out). */
  available: Record<string, number>;
  /** The shipment calculator's figure for the stored lines, for the drift check only. */
  shipmentCod: number | null;
  customer: CustomerFacts;
}

/* ═══════════════════════════ small helpers ═══════════════════════════ */

/** Half a minor unit: two figures within it are the same figure at this currency's precision. */
const near = (a: number, b: number, minorUnit: number): boolean =>
  Math.abs(a - b) <= 0.5 / 10 ** Math.max(0, minorUnit) + 1e-9;

/** A bundle is `quantity` units; nonsense (zero, negative) is a bundle of one — the rule `giftUnits` holds. */
const bundleSize = (offer: { quantity: number }): number => (offer.quantity >= 1 ? offer.quantity : 1);

const text = (value: number, minorUnit: number): string => moneyText(value, null, minorUnit);

/* ═══════════════════════════ pricing (the one wrapper over computeCod) ═══════════════════════════ */

export interface Totals {
  subtotal: number;
  discount: number;
  discountShares: number[];
  deliveryFee: number;
  addOns: number;
  cod: number;
  revenue: number;
  giftUnits: number;
}

export interface PricedLines {
  money: CodBreakdown;
  totals: Totals;
}

/**
 * THE MONEY OF A SET OF LINES — `computeCod`, called the way the lines save calls it, and nothing more.
 *
 * `PATCH /api/orders/[id]` hands `computeCod` each line's quantity and `lineTotal / quantity`, the discount, the
 * order's `shippingCost`, the delivery policy and the accepted add-ons. This does the same with the same inputs, so
 * `after.cod` here IS the `totalAmount` that save writes. (Gift units are not part of the money, as in `computeCod`
 * itself: they are only counted.)
 */
export function priceOrderLines(input: {
  lines: ReadonlyArray<{ quantity: number; lineTotal: number; freeQuantity: number }>;
  discount: number;
  deliveryFee: number;
  priceIncludesDelivery: boolean;
  addOns: ReadonlyArray<{ quantity: number; price: number }>;
  minorUnit: number;
}): PricedLines {
  const money = computeCod({
    lines: input.lines.map((l) => ({
      quantity: l.quantity,
      unitPrice: l.quantity > 0 ? l.lineTotal / l.quantity : l.lineTotal,
    })),
    discount: input.discount,
    deliveryFee: input.deliveryFee,
    priceIncludesDelivery: input.priceIncludesDelivery,
    minorUnit: input.minorUnit,
    addOns: input.addOns.map((a) => ({ quantity: a.quantity, unitPrice: a.price })),
  });
  return {
    money,
    totals: {
      subtotal: money.subtotal,
      discount: money.discount,
      discountShares: money.discountShares,
      deliveryFee: money.deliveryFee,
      addOns: money.addOns,
      cod: money.cod,
      revenue: money.revenue,
      giftUnits: input.lines.reduce((sum, l) => sum + l.freeQuantity, 0),
    },
  };
}

/* ═══════════════════════════ price suggestions ═══════════════════════════ */

export interface PriceOption {
  basis: PriceBasis;
  offerId: string | null;
  /** The line's new total (before the order's discount). Null for `MANUAL`: the number is the person's. */
  lineTotal: number | null;
  /** For display only — the total over the quantity. */
  unitPrice: number | null;
  /** Against what the line costs today. */
  delta: number | null;
  isDefault: boolean;
}

export interface PricingContext {
  minorUnit: number;
  products: ReadonlyMap<string, ProductFact>;
  offers: readonly OfferFact[];
  orderOffer: OfferFact | null;
  /** The order's stored discount — only to say when it was not rescaled with an offer. */
  orderDiscount: number;
}

/**
 * Was this line priced by the order's own offer, and in which of the two ways the doors write it?
 *
 *   CHARGED — the storefront's way: the bundle's price after its own reduction × the bundles.
 *   LIST    — the manual door's way: the list price × the bundles, the reduction kept in the order's discount.
 *
 * Neither, if the line is not a whole number of bundles of THIS offer's product or its total is some other figure.
 */
function pricedBy(line: StoredLine, offer: OfferFact | null, minorUnit: number): 'CHARGED' | 'LIST' | null {
  if (!offer || offer.productId !== line.productId) return null;
  const q = bundleSize(offer);
  if (line.quantity < q || line.quantity % q !== 0) return null;
  const bundles = line.quantity / q;
  if (near(line.lineTotal, roundMinor(offer.price * bundles, minorUnit), minorUnit)) return 'CHARGED';
  if (near(line.lineTotal, roundMinor(offer.listPrice * bundles, minorUnit), minorUnit)) return 'LIST';
  return null;
}

/**
 * THE NUMBERED ANSWERS to «what should this line cost now?», for a line whose quantity or product changed.
 *
 *   KEEP_UNIT  — the piece price the line has today, times the new quantity. The behaviour the single-line shorthand
 *                has always had, and the default unless the order was priced by its offer.
 *   OFFER      — an offer on sale for the (new) product whose bundle divides the quantity: its bundle price × the
 *                bundles. The default ONLY when the old line was priced by that same offer.
 *   BASE_PRICE — the product's catalogue price × the quantity. Never the default.
 *   MANUAL     — a number a person types; carries no figure of its own.
 *
 * Each carries its difference from what the line costs now, so the person chooses with the consequence in view.
 * Totals are always built from the line's TOTAL (36 for 3, so 60 for 5), never from a rounded piece price — «٣ بـ٢٥»
 * is 25 for three and 50 for six, not 24.999.
 */
export function suggestPrice(
  line: StoredLine,
  next: { productId: string; quantity: number },
  ctx: PricingContext
): PriceOption[] {
  const n = next.quantity;
  const total = (v: number) => roundMinor(v, ctx.minorUnit);
  const unit = (t: number) => (n > 0 ? roundMinor(t / n, ctx.minorUnit) : t);
  const raw: Array<{ basis: PriceBasis; offerId: string | null; lineTotal: number | null }> = [];

  // KEEP_UNIT
  const keep =
    line.quantity > 0 && n !== line.quantity ? total((line.lineTotal * n) / line.quantity) : total(line.lineTotal);
  raw.push({ basis: 'KEEP_UNIT', offerId: null, lineTotal: keep });

  // OFFER — every live bundle of the new product that the quantity is a whole number of.
  const priced = pricedBy(line, ctx.orderOffer, ctx.minorUnit);
  const candidates = [...ctx.offers];
  if (ctx.orderOffer && ctx.orderOffer.live && !candidates.some((o) => o.id === ctx.orderOffer!.id)) {
    candidates.push(ctx.orderOffer);
  }
  for (const o of candidates) {
    if (!o.live || o.productId !== next.productId) continue;
    const q = bundleSize(o);
    if (n < q || n % q !== 0) continue;
    // The order's own offer keeps the way the line was priced; any other bundle is quoted as the doors quote it.
    const bundlePrice = ctx.orderOffer && o.id === ctx.orderOffer.id && priced === 'LIST' ? o.listPrice : o.price;
    raw.push({ basis: 'OFFER', offerId: o.id, lineTotal: total((bundlePrice * n) / q) });
  }

  // BASE_PRICE
  const product = ctx.products.get(next.productId);
  if (product && product.basePrice > 0) {
    raw.push({ basis: 'BASE_PRICE', offerId: null, lineTotal: total(product.basePrice * n) });
  }

  // MANUAL
  raw.push({ basis: 'MANUAL', offerId: null, lineTotal: null });

  const sameProduct = next.productId === line.productId;
  const preferred =
    priced !== null && ctx.orderOffer && ctx.orderOffer.live && sameProduct
      ? raw.find((r) => r.basis === 'OFFER' && r.offerId === ctx.orderOffer!.id)
      : undefined;
  const chosen = preferred ?? raw[0];

  return raw.map((r) => ({
    basis: r.basis,
    offerId: r.offerId,
    lineTotal: r.lineTotal,
    unitPrice: r.lineTotal === null ? null : unit(r.lineTotal),
    delta: r.lineTotal === null ? null : roundMinor(r.lineTotal - line.lineTotal, ctx.minorUnit),
    isDefault: r === chosen,
  }));
}

/* ═══════════════════════════ the gift ═══════════════════════════ */

export interface GiftSuggestion {
  value: number;
  /** Worked out from the order's offer, not carried over. */
  derived: boolean;
  /** Why it was not re-derived, when there was something to re-derive. */
  warn: 'GIFT_NOT_RESCALED' | 'GIFT_DROPPED' | null;
}

/**
 * THE GIFT A LINE CARRIES AFTER ITS QUANTITY CHANGES — derived only when the line is demonstrably the order's offer.
 *
 * «Demonstrably»: the line is of the offer's product, the offer is on sale, the line WAS PRICED BY THE OFFER (a whole
 * number of its bundles at its price — `pricedBy`), and the gift it holds today is exactly what the offer gives for
 * today's quantity. Then the new gift is what the offer gives for the new quantity — one per WHOLE bundle
 * (`giftUnits`), so 3+1 → six is two and → two is none. Gift-equals-gift alone is NOT enough: a line of two with no
 * gift satisfies «0 = 0» on a «3 + 1» without ever having been bought as the offer, and raising it to six must not
 * hand it two free pieces (owner rule: refuse, do not guess). In every other case the gift stays as it is and the
 * caller is told it did not move. A line whose PRODUCT is swapped does not carry its gift to the new product — the
 * save starts a product new to the order at none — and says so (`GIFT_DROPPED`).
 * The gift is real stock (it is reserved and costed like any unit) but it is not money.
 */
export function suggestGift(
  line: StoredLine,
  next: { productId: string; quantity: number },
  offer: OfferFact | null,
  minorUnit: number
): GiftSuggestion {
  const changedProduct = next.productId !== line.productId;
  if (!changedProduct && next.quantity === line.quantity) return { value: line.freeQuantity, derived: false, warn: null };
  if (changedProduct) {
    return { value: 0, derived: false, warn: line.freeQuantity > 0 ? 'GIFT_DROPPED' : null };
  }
  const linked =
    !!offer &&
    offer.live &&
    offer.productId === line.productId &&
    pricedBy(line, offer, minorUnit) !== null &&
    line.freeQuantity === giftUnits(offer, line.quantity);
  if (linked) return { value: giftUnits(offer, next.quantity), derived: true, warn: null };
  // A gift the offer WOULD give for the new quantity, left ungiven because the line is not demonstrably its: say so.
  const wouldGive = !!offer && offer.live && offer.productId === line.productId && giftUnits(offer, next.quantity) > 0;
  return { value: line.freeQuantity, derived: false, warn: line.freeQuantity > 0 || wouldGive ? 'GIFT_NOT_RESCALED' : null };
}

/* ═══════════════════════════ problems ═══════════════════════════ */

/**
 * EVERY WARNING AND EVERY REFUSAL, by a code that does not change. The sentence for the screen is attached; the code is
 * what a test, a decider's screen and the apply door speak in.
 */
export const PROBLEM_CODES = [
  // the draft itself
  'UNKNOWN_LINE',
  'DUPLICATE_LINE_EDIT',
  'BASIS_UNAVAILABLE',
  'ORDER_CLOSED',
  // money
  'DISCOUNT_EXCEEDS_TOTAL',
  'ZERO_PRICE',
  'FEE_SOURCE_DRIFT',
  'COD_DRIFT',
  'STATEMENT_LINKED',
  'LINE_SETTLED',
  'PRICE_FAR_FROM_BASE',
  'DISCOUNT_NOT_RESCALED',
  'PRICE_INCLUDES_DELIVERY',
  // offers and gifts
  'QTY_BELOW_OFFER_MIN',
  'QTY_NOT_BUNDLE',
  'OFFER_ENDED',
  'GIFT_NOT_RESCALED',
  'GIFT_DROPPED',
  // stock
  'PRODUCT_UNAVAILABLE',
  'PRODUCT_INACTIVE',
  'STOCK_SHORT_BLOCKED',
  'STOCK_SHORT_ALLOWED',
  'STOCK_ALREADY_SHORT',
  // the customer
  'PHONE_INVALID',
  'DUPLICATE_PHONE',
  'REGION_NOT_IN_COUNTRY',
  'REGION_FEE_DIFFERS',
  // the parcel
  'PARCEL_HANDED',
  'LABEL_WILL_RESET',
] as const;
export type ProblemCode = (typeof PROBLEM_CODES)[number];

export interface Problem {
  code: ProblemCode;
  /** A blocking problem stops the request from being raised. The rest are shown and let through. */
  blocking: boolean;
  messageAr: string;
  lineId?: string;
  productId?: string;
  detail?: Record<string, string | number>;
}

/** The sentence for each code, short and in the words the team uses. `{…}` is filled from `detail`. */
const MESSAGE_AR: Record<ProblemCode, string> = {
  UNKNOWN_LINE: 'سطر مش موجود بالطلب — أعد تحميل الطلب.',
  DUPLICATE_LINE_EDIT: 'نفس السطر مكرر بالتعديل.',
  BASIS_UNAVAILABLE: 'طريقة التسعير المختارة مش متاحة لهالسطر.',
  ORDER_CLOSED: 'الطلب مغلق (ملغى أو مرفوض أو مسلَّم) — ما بيتعدل.',
  DISCOUNT_EXCEEDS_TOTAL: 'الخصم أكبر من إجمالي الطلب. الحد الأعلى {max}.',
  ZERO_PRICE: 'سعر السطر صفر. الهدية بتنعطى من العرض، مش بسعر صفر.',
  FEE_SOURCE_DRIFT: 'أجرة التوصيل على هالطلب إلها رقمين مختلفين — ما بنعدّل ماله لحد ما يتوحّدوا.',
  COD_DRIFT: 'إجمالي الطلب المخزّن ({stored}) ما بيطابق حساب الأسطر ({computed}).',
  STATEMENT_LINKED: 'الطلب مربوط بكشف شركة الشحن — الكشف هو اللي بيكتب المال.',
  LINE_SETTLED: 'في سطر انسلّم أو ارتجع — ما بتتعدل الأسطر.',
  PRICE_FAR_FROM_BASE: 'سعر القطعة بعيد كتير عن سعر المنتج الأساسي ({base}).',
  DISCOUNT_NOT_RESCALED: 'الخصم ما تغيّر مع الكمية — اكتب الخصم الجديد إذا لزم.',
  PRICE_INCLUDES_DELIVERY: 'السعر شامل التوصيل — ربحك بيتغيّر بنفس فرق السعر ({before} ← {after}).',
  QTY_BELOW_OFFER_MIN: 'الكمية أقل من حزمة العرض ({bundle}) — بدون هدية وبدون سعر العرض.',
  QTY_NOT_BUNDLE: 'الكمية مش من مضاعفات حزمة العرض ({bundle}) — الهدية للحزم الكاملة بس.',
  OFFER_ENDED: 'عرض الطلب انتهى — ما بنحسب منه سعر ولا هدية.',
  GIFT_NOT_RESCALED: 'الهدية ما تغيّرت: السطر مش مسعَّر بالعرض، فما بنخترع هدية.',
  GIFT_DROPPED: 'الهدية ما بتنتقل لمنتج ثاني — صارت صفر.',
  PRODUCT_UNAVAILABLE: 'المنتج مش موجود بهالشركة.',
  PRODUCT_INACTIVE: 'المنتج معطّل حالياً.',
  STOCK_SHORT_BLOCKED: 'المخزون ما بيكفي لـ{name}.',
  STOCK_SHORT_ALLOWED: 'المخزون ما بيكفي لـ{name} — البلد بتسمح بالسالب.',
  STOCK_ALREADY_SHORT: 'كان في نقص بـ{name} قبل التعديل، وما زاد.',
  PHONE_INVALID: 'رقم الهاتف مش صحيح لهالبلد.',
  DUPLICATE_PHONE: 'رقم الهاتف مستخدم عند زبون ثاني.',
  REGION_NOT_IN_COUNTRY: 'المحافظة مش من بلد هالطلب.',
  REGION_FEE_DIFFERS: 'رسم التوصيل ما بيتغيّر مع المحافظة. رسم جدول المندوب للمحافظة الجديدة {next}، والحالي {current}.',
  PARCEL_HANDED: 'الطرد عند شركة الشحن — لازم نبلّغ الشركة، والتعديل ما بيصير بنفسه.',
  LABEL_WILL_RESET: 'رح تنمسح البوليصة المطبوعة، وبنطلب من الشركة تلغي الباركود.',
};

function say(code: ProblemCode, detail: Record<string, string | number> = {}): string {
  return MESSAGE_AR[code].replace(/\{(\w+)\}/g, (_m, key: string) => String(detail[key] ?? ''));
}

function problem(
  code: ProblemCode,
  blocking: boolean,
  extra: { lineId?: string; productId?: string; detail?: Record<string, string | number> } = {}
): Problem {
  return { code, blocking, messageAr: say(code, extra.detail), ...extra };
}

/* ═══════════════════════════ resolving the edits ═══════════════════════════ */

export interface FromTo<T> {
  from: T;
  to: T;
}

/** One stored line, with what the draft makes of it. Same shape as the `lines.edits` a request will store. */
export interface ResolvedLine {
  lineId: string;
  changed: boolean;
  productId: FromTo<string>;
  productName: string;
  quantity: FromTo<number>;
  freeQuantity: FromTo<number>;
  /** Before the order's discount, paid units. */
  lineTotal: FromTo<number>;
  /** For display: the total over the quantity. */
  unitPrice: FromTo<number>;
  basis: PriceBasis | null;
  offerId: string | null;
}

export interface ResolvedLines {
  lines: ResolvedLine[];
  suggestions: Array<{ lineId: string; options: PriceOption[] }>;
  problems: Problem[];
}

/**
 * WHAT EACH STORED LINE BECOMES UNDER THE DRAFT — every stored line comes back, in the stored order, edited or not,
 * because the save replaces the whole set and the preview must price the whole set.
 *
 * Matching is by `lineId` ONLY. Two lines of one product are two lines, and a product is never an address.
 * A price the person typed wins; the basis they claim for it is believed only if it reproduces the number (a figure
 * labelled «عرض» that is not the offer's is recorded as «يدوي»). Without a typed price a changed quantity or product
 * takes the basis they chose, or the default of `suggestPrice`. A basis that cannot be priced is refused — the
 * line still carries the default number so the screen can draw a result, but the problem is blocking.
 */
export function resolveLineEdits(
  stored: readonly StoredLine[],
  edits: readonly LineEditInput[],
  ctx: PricingContext
): ResolvedLines {
  const problems: Problem[] = [];
  const suggestions: ResolvedLines['suggestions'] = [];
  const byId = new Map(stored.map((s) => [s.id, s]));
  const editOf = new Map<string, LineEditInput>();
  for (const e of edits) {
    if (!byId.has(e.lineId)) {
      problems.push(problem('UNKNOWN_LINE', true, { lineId: e.lineId }));
      continue;
    }
    if (editOf.has(e.lineId)) {
      problems.push(problem('DUPLICATE_LINE_EDIT', true, { lineId: e.lineId }));
      continue;
    }
    editOf.set(e.lineId, e);
  }

  // A delivered or returned line is a record of something that happened; the save would delete it and write it again.
  if (editOf.size > 0) {
    const settled = stored.find((s) => s.deliveredQty !== null || s.returnedQty !== null);
    if (settled) problems.push(problem('LINE_SETTLED', true, { lineId: settled.id, productId: settled.productId }));
  }

  const offer = ctx.orderOffer;
  const lines: ResolvedLine[] = stored.map((s) => {
    const e = editOf.get(s.id);
    const productId = e?.productId ?? s.productId;
    const quantity = e?.quantity ?? s.quantity;
    const changedProduct = productId !== s.productId;
    const changedQty = quantity !== s.quantity;
    const product = ctx.products.get(productId);

    if (changedProduct && !product) {
      problems.push(problem('PRODUCT_UNAVAILABLE', true, { lineId: s.id, productId }));
    } else if (changedProduct && product && product.status === 'INACTIVE') {
      problems.push(problem('PRODUCT_INACTIVE', false, { lineId: s.id, productId }));
    }

    const options = changedProduct || changedQty ? suggestPrice(s, { productId, quantity }, ctx) : [];
    if (options.length > 0) suggestions.push({ lineId: s.id, options });

    // ── the new total, and how it was reached
    let lineTotal = roundMinor(s.lineTotal, ctx.minorUnit);
    let basis: PriceBasis | null = null;
    let offerId: string | null = null;

    const typed =
      e?.lineTotal !== undefined
        ? roundMinor(e.lineTotal, ctx.minorUnit)
        : e?.unitPrice !== undefined
          ? roundMinor(e.unitPrice * quantity, ctx.minorUnit)
          : null;

    if (typed !== null) {
      lineTotal = typed;
      if (typed !== roundMinor(s.lineTotal, ctx.minorUnit) || changedProduct || changedQty) {
        const claimed = e?.priceBasis;
        const matched =
          claimed && claimed !== 'MANUAL'
            ? options.find(
                (o) => o.basis === claimed && o.lineTotal === typed && (!e?.offerId || o.offerId === e.offerId)
              )
            : undefined;
        basis = matched ? matched.basis : 'MANUAL';
        offerId = matched ? matched.offerId : null;
      }
    } else if (changedProduct || changedQty) {
      const asked = e?.priceBasis;
      const pick =
        asked === undefined
          ? options.find((o) => o.isDefault)
          : options.find((o) => o.basis === asked && o.lineTotal !== null && (!e?.offerId || o.offerId === e.offerId));
      const fallback = options.find((o) => o.isDefault) ?? options[0];
      if (asked !== undefined && !pick) problems.push(problem('BASIS_UNAVAILABLE', true, { lineId: s.id }));
      const used = pick ?? fallback;
      lineTotal = used.lineTotal ?? lineTotal;
      basis = pick ? pick.basis : fallback.basis;
      offerId = pick ? pick.offerId : fallback.offerId;
    }

    // ── the gift
    const gift = suggestGift(s, { productId, quantity }, offer, ctx.minorUnit);
    if (gift.warn) problems.push(problem(gift.warn, false, { lineId: s.id, productId: s.productId }));

    // ── what the offer, if the line is its, says about this quantity
    const offerLine = !!offer && offer.productId === s.productId && !changedProduct;
    if (offerLine && offer && (changedQty || changedProduct)) {
      const priced = pricedBy(s, offer, ctx.minorUnit);
      const linked = priced !== null;
      if (linked && !offer.live) {
        problems.push(problem('OFFER_ENDED', false, { lineId: s.id, productId: s.productId }));
      } else if (linked && changedQty) {
        const q = bundleSize(offer);
        if (quantity < q) {
          problems.push(problem('QTY_BELOW_OFFER_MIN', false, { lineId: s.id, productId: s.productId, detail: { bundle: q } }));
        } else if (quantity % q !== 0) {
          problems.push(problem('QTY_NOT_BUNDLE', false, { lineId: s.id, productId: s.productId, detail: { bundle: q } }));
        }
        // The offer's own reduction lives in the order's discount for the manual door, and does not follow the quantity.
        if (offer.listPrice > offer.price && ctx.orderDiscount > 0) {
          problems.push(problem('DISCOUNT_NOT_RESCALED', false, { lineId: s.id }));
        }
      }
    }

    const priceMoved = lineTotal !== roundMinor(s.lineTotal, ctx.minorUnit);
    const changed = changedProduct || changedQty || priceMoved || gift.value !== s.freeQuantity;

    if (e && changed) {
      if (lineTotal <= 0) problems.push(problem('ZERO_PRICE', true, { lineId: s.id, productId }));
      if (product && product.basePrice > 0 && quantity > 0 && (priceMoved || changedProduct)) {
        const piece = lineTotal / quantity;
        if (piece < product.basePrice * PRICE_FLOOR_RATIO || piece > product.basePrice * PRICE_CEILING_RATIO) {
          problems.push(
            problem('PRICE_FAR_FROM_BASE', false, {
              lineId: s.id,
              productId,
              detail: { base: text(product.basePrice, ctx.minorUnit) },
            })
          );
        }
      }
    }

    return {
      lineId: s.id,
      changed,
      productId: { from: s.productId, to: productId },
      productName: product?.name ?? s.productName,
      quantity: { from: s.quantity, to: quantity },
      freeQuantity: { from: s.freeQuantity, to: gift.value },
      lineTotal: { from: roundMinor(s.lineTotal, ctx.minorUnit), to: lineTotal },
      unitPrice: {
        from: s.quantity > 0 ? roundMinor(s.lineTotal / s.quantity, ctx.minorUnit) : s.lineTotal,
        to: quantity > 0 ? roundMinor(lineTotal / quantity, ctx.minorUnit) : lineTotal,
      },
      basis: changed ? basis : null,
      offerId: changed ? offerId : null,
    };
  });

  return { lines, suggestions, problems };
}

/* ═══════════════════════════ stock ═══════════════════════════ */

export type StockStatus =
  | 'UNCHANGED'
  | 'FREES'
  | 'ENOUGH'
  | 'SHORT_ALLOWED'
  | 'SHORT_BLOCKED'
  | 'ALREADY_SHORT'
  /** The order holds no stock yet (it is not confirmed): the figures are for information. */
  | 'NOT_HELD';

/**
 * WHAT THE DRAFT DOES TO ONE PRODUCT'S SHELF — the engine's own working figures.
 *
 * `needed` and `missing` are INTERNAL: with both, `needed − missing` is the shelf's balance, so a response that
 * carried the pair would hand the balance to whoever may preview. What leaves the engine is `PublicStockEffect`:
 * the order's own units and a verdict, nothing from which the shelf's count follows by subtraction.
 */
export interface StockEffect {
  productId: string;
  productName: string;
  /** Paid + gift units the order's lines hold today / would hold after. */
  before: number;
  after: number;
  /** Units the order's lines have reserved now. */
  held: number;
  /** Units that go back to the shelf (before − after, when positive). */
  freed: number;
  /** Units the order would need: its lines after the edit plus the add-ons the customer accepted. */
  needed: number;
  /** Units of that the shelf cannot give. */
  missing: number;
  enough: boolean;
  status: StockStatus;
}

/**
 * THE SHELF, PER PRODUCT, BEFORE AND AFTER — the question `reserveOrderLines` will ask when the request is applied.
 *
 * The save deletes the order's lines and writes them again with nothing reserved, then reserves them all: so EVERY
 * product on the order is asked again, not only the ones that changed. `available` is what a reservation by this order
 * may take (its own holding already left out), and the add-ons the customer accepted come off it first, as the
 * reservation does for a product the order also buys as a line.
 *
 * A shortage blocks only if it GREW — compared with the gap the order has on the SAME shelf with its lines as they
 * are. An order that was already short (stock counted down since, an earlier negative allowance) is not stopped from
 * an unrelated edit by an old gap; one more missing unit is. When the country allows negative stock the shortage is
 * let through and reported.
 */
export function stockEffect(input: {
  stored: readonly StoredLine[];
  next: ReadonlyArray<{ productId: string; quantity: number; freeQuantity: number }>;
  addOns: ReadonlyArray<{ productId: string; quantity: number }>;
  available: Readonly<Record<string, number>>;
  names: ReadonlyMap<string, string>;
  allowNegativeStock: boolean;
  /** Whether the order's lines hold stock: true once it is confirmed. */
  reserves: boolean;
}): StockEffect[] {
  const ids: string[] = [];
  for (const l of input.stored) if (!ids.includes(l.productId)) ids.push(l.productId);
  for (const l of input.next) if (!ids.includes(l.productId)) ids.push(l.productId);

  return ids.map((productId) => {
    const before = input.stored.filter((l) => l.productId === productId).reduce((s, l) => s + l.quantity + l.freeQuantity, 0);
    const held = input.stored.filter((l) => l.productId === productId).reduce((s, l) => s + l.reservedQty, 0);
    const after = input.next.filter((l) => l.productId === productId).reduce((s, l) => s + l.quantity + l.freeQuantity, 0);
    const addOnUnits = input.addOns.filter((a) => a.productId === productId).reduce((s, a) => s + a.quantity, 0);
    const available = input.available[productId] ?? 0;

    const needed = after + addOnUnits;
    const missing = Math.max(0, needed - available);
    // The same question asked of the order as it stands: the gap an unrelated edit must not be blamed for.
    const missingNow = Math.max(0, before + addOnUnits - available);
    const freed = Math.max(0, before - after);

    let status: StockStatus;
    if (!input.reserves) status = 'NOT_HELD';
    else if (missing > 0) {
      if (input.allowNegativeStock) status = 'SHORT_ALLOWED';
      else if (missing > missingNow) status = 'SHORT_BLOCKED';
      else status = 'ALREADY_SHORT';
    } else if (after < before) status = 'FREES';
    else if (after > before) status = 'ENOUGH';
    else status = 'UNCHANGED';

    return {
      productId,
      productName: input.names.get(productId) ?? '',
      before,
      after,
      held,
      freed,
      needed,
      missing,
      enough: missing === 0,
      status,
    };
  });
}

/* ═══════════════════════════ the door ═══════════════════════════ */

/**
 * WHICH DOOR THE CHANGE WILL GO THROUGH.
 *
 *   DIRECT          — not confirmed yet: the order is edited in place, no request.
 *   REQUEST         — confirmed, the parcel is still ours and nothing is printed.
 *   REQUEST_REPRINT — confirmed, still ours, but the waybill is printed (or the company holds a barcode): applied in
 *                     place and the waybill is reset.
 *   COURIER_ACTION  — the courier has the parcel: the system does not edit its lines; the company is told.
 *   CLOSED          — cancelled, rejected, delivered or returned: nothing to change.
 */
export type EditDoor = 'DIRECT' | 'REQUEST' | 'REQUEST_REPRINT' | 'COURIER_ACTION' | 'CLOSED';

export function doorOf(order: Pick<OrderFlags, 'confirmed' | 'closed' | 'handed' | 'labelled'>): EditDoor {
  if (order.closed) return 'CLOSED';
  if (order.handed) return 'COURIER_ACTION';
  if (!order.confirmed) return 'DIRECT';
  return order.labelled ? 'REQUEST_REPRINT' : 'REQUEST';
}

/* ═══════════════════════════ the draft's problems ═══════════════════════════ */

export interface DraftCheck {
  facts: OrderEditFacts;
  draft: PreviewDraft;
  resolved: ResolvedLines;
  before: Totals;
  after: Totals;
  /** The discount the draft would leave on the order. */
  nextDiscount: number;
  stock: StockEffect[];
}

/**
 * EVERYTHING WRONG OR WORTH SAYING ABOUT A DRAFT, in one list: blocking first, then by code, then by line.
 *
 * Refusal beats guessing, always (owner rule, 28/10): a stored total that disagrees with its own lines, two fee
 * sources, a statement that claims the order, a settled line — each is a sentence, not a "best effort" figure.
 */
export function draftProblems(check: DraftCheck): Problem[] {
  const { facts, draft, resolved, before, after, stock } = check;
  const mu = facts.minorUnit;
  const o = facts.order;
  const out: Problem[] = [...resolved.problems];

  const lineDraft = !!draft.lines && draft.lines.length > 0;
  const moneyDraft = lineDraft || draft.discountAmount !== undefined;
  const touchesDriver =
    moneyDraft ||
    draft.regionId !== undefined ||
    draft.customerName !== undefined ||
    draft.customerPhone !== undefined ||
    draft.customerAltPhone !== undefined ||
    draft.customerAddress !== undefined;

  // ── the order's own state
  if (o.closed) out.push(problem('ORDER_CLOSED', true));
  // With the courier the system does not rewrite the lines (cancel and re-order instead): blocking for a lines draft.
  if (o.confirmed && !o.closed && o.handed) out.push(problem('PARCEL_HANDED', lineDraft));
  if (o.confirmed && !o.closed && !o.handed && o.labelled && touchesDriver) out.push(problem('LABEL_WILL_RESET', false));
  if (moneyDraft && o.statementLinked) out.push(problem('STATEMENT_LINKED', true));

  // ── the money
  if (moneyDraft) {
    if (check.nextDiscount > after.subtotal) {
      out.push(problem('DISCOUNT_EXCEEDS_TOTAL', true, { detail: { max: text(after.subtotal, mu) } }));
    }
    const twoFees = o.deliveryFee !== null && !near(o.deliveryFee, o.shippingCost, mu);
    if (twoFees) {
      out.push(problem('FEE_SOURCE_DRIFT', true));
    } else {
      const off = !near(before.cod, o.storedTotal, mu) || (facts.shipmentCod !== null && !near(facts.shipmentCod, o.storedTotal, mu));
      if (off) {
        out.push(
          problem('COD_DRIFT', lineDraft, {
            detail: {
              stored: text(o.storedTotal, mu),
              computed: text(facts.shipmentCod !== null && !near(facts.shipmentCod, o.storedTotal, mu) ? facts.shipmentCod : before.cod, mu),
            },
          })
        );
      }
    }
    if (o.priceIncludesDelivery && !near(after.revenue, before.revenue, mu)) {
      out.push(
        problem('PRICE_INCLUDES_DELIVERY', false, {
          detail: { before: text(before.revenue, mu), after: text(after.revenue, mu) },
        })
      );
    }
  }

  // ── the shelf
  for (const s of stock) {
    if (s.status === 'SHORT_BLOCKED') {
      out.push(problem('STOCK_SHORT_BLOCKED', true, { productId: s.productId, detail: { name: s.productName } }));
    } else if (s.status === 'SHORT_ALLOWED') {
      out.push(problem('STOCK_SHORT_ALLOWED', false, { productId: s.productId, detail: { name: s.productName } }));
    } else if (s.status === 'ALREADY_SHORT') {
      out.push(problem('STOCK_ALREADY_SHORT', false, { productId: s.productId, detail: { name: s.productName } }));
    }
  }

  // ── the customer
  const c = facts.customer;
  if (draft.customerPhone !== undefined && c.phoneInvalid) out.push(problem('PHONE_INVALID', true));
  if (draft.customerAltPhone && c.altPhoneInvalid) out.push(problem('PHONE_INVALID', true));
  if (draft.customerPhone !== undefined && c.phoneDuplicate) out.push(problem('DUPLICATE_PHONE', true));
  if (draft.regionId && c.regionOutsideCountry) out.push(problem('REGION_NOT_IN_COUNTRY', true));
  if (draft.regionId && c.regionFee && !near(c.regionFee.next, c.regionFee.current, mu)) {
    out.push(
      problem('REGION_FEE_DIFFERS', false, {
        detail: { next: text(c.regionFee.next, mu), current: text(c.regionFee.current, mu) },
      })
    );
  }

  const rank = (p: Problem) => PROBLEM_CODES.indexOf(p.code);
  return out.sort(
    (a, b) =>
      Number(b.blocking) - Number(a.blocking) || rank(a) - rank(b) || (a.lineId ?? '').localeCompare(b.lineId ?? '')
  );
}

/* ═══════════════════════════ the whole preview ═══════════════════════════ */

export interface PreviewLine extends ResolvedLine {
  /** This line's share of the order's discount after the edit. */
  discountShare: number;
  /** The line after the order's discount — what the courier is told this line comes to. */
  totalAfterDiscount: number;
}

/** The shelf verdict a response may carry: the order's own units and a status — no count of what the shelf holds. */
export type PublicStockEffect = Omit<StockEffect, 'needed' | 'missing'>;

/** What a response may say of a product's shelf: everything of `StockEffect` except the two figures that give it away. */
function openStock(s: StockEffect): PublicStockEffect {
  return { productId: s.productId, productName: s.productName, before: s.before, after: s.after, held: s.held, freed: s.freed, enough: s.enough, status: s.status };
}

export interface OrderEditPreview {
  before: Totals;
  after: Totals;
  lines: PreviewLine[];
  /**
   * THE LINES' ORDER, EXPLICIT. The remainder of a discount that does not divide lands on the first largest line, so
   * the order the lines are given to `computeCod` decides which line carries it (0.334 / 0.333 / 0.333 on three equal
   * lines). Stored rows written together share one `createdAt`, so this order is the preview's own deterministic one
   * (`createdAt`, then `id`). The APPLY phase must write the lines in exactly this order — reuse this array, do
   * not re-read the rows and sort again — or the shares it writes can differ by a minor unit from the ones shown.
   */
  lineOrder: string[];
  stock: PublicStockEffect[];
  suggestions: ResolvedLines['suggestions'];
  problems: Problem[];
  /** True when at least one problem stops the request from being raised. */
  blocked: boolean;
  door: EditDoor;
  orderVersion: number;
  minorUnit: number;
}

/**
 * THE PREVIEW OF A DRAFT, as a pure function of the facts: before, after, the lines, the shelf, the problems and the
 * door. Nothing here reads or writes anything; `order-edit-facts.ts` supplies the facts and returns this unchanged.
 */
export function previewLineEdit(facts: OrderEditFacts, draft: PreviewDraft): OrderEditPreview {
  const mu = facts.minorUnit;
  const o = facts.order;
  const products = new Map(facts.products.map((p) => [p.id, p]));
  const ctx: PricingContext = {
    minorUnit: mu,
    products,
    offers: facts.offers,
    orderOffer: facts.orderOffer,
    orderDiscount: o.discount,
  };

  const resolved = resolveLineEdits(facts.lines, draft.lines ?? [], ctx);
  const nextDiscount = draft.discountAmount ?? o.discount;

  const beforePriced = priceOrderLines({
    lines: facts.lines.map((l) => ({ quantity: l.quantity, lineTotal: l.lineTotal, freeQuantity: l.freeQuantity })),
    discount: o.discount,
    deliveryFee: o.shippingCost,
    priceIncludesDelivery: o.priceIncludesDelivery,
    addOns: facts.addOns,
    minorUnit: mu,
  });
  const afterPriced = priceOrderLines({
    lines: resolved.lines.map((l) => ({ quantity: l.quantity.to, lineTotal: l.lineTotal.to, freeQuantity: l.freeQuantity.to })),
    discount: nextDiscount,
    deliveryFee: o.shippingCost,
    priceIncludesDelivery: o.priceIncludesDelivery,
    addOns: facts.addOns,
    minorUnit: mu,
  });

  const stock = stockEffect({
    stored: facts.lines,
    next: resolved.lines.map((l) => ({ productId: l.productId.to, quantity: l.quantity.to, freeQuantity: l.freeQuantity.to })),
    addOns: facts.addOns,
    available: facts.available,
    names: new Map(facts.products.map((p) => [p.id, p.name])),
    allowNegativeStock: facts.allowNegativeStock,
    reserves: o.confirmed,
  });

  // Stock only matters when the lines are rewritten: a draft of the customer's fields alone never reserves anything.
  const lineDraft = !!draft.lines && draft.lines.length > 0;
  const stockForDraft = lineDraft ? stock : stock.map((s) => ({ ...s, status: 'UNCHANGED' as const, missing: 0, enough: true }));

  const problems = draftProblems({
    facts,
    draft,
    resolved,
    before: beforePriced.totals,
    after: afterPriced.totals,
    nextDiscount,
    stock: stockForDraft,
  });

  return {
    before: beforePriced.totals,
    after: afterPriced.totals,
    lines: resolved.lines.map((l, i) => ({
      ...l,
      discountShare: afterPriced.money.discountShares[i] ?? 0,
      totalAfterDiscount: afterPriced.money.lineTotals[i] ?? 0,
    })),
    lineOrder: resolved.lines.map((l) => l.lineId),
    stock: stockForDraft.map(openStock),
    suggestions: resolved.suggestions,
    problems,
    blocked: problems.some((p) => p.blocking),
    door: doorOf(o),
    orderVersion: o.version,
    minorUnit: mu,
  };
}
