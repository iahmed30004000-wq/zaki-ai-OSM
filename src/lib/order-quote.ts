import { computeCod } from './money';
import { priceByOffer } from './offer-line-price';
import { atBasePrice } from './line-price';
import { giftUnits } from './offer-gift';

/**
 * «ZAKI ORDERS» — WHAT A HAND-TYPED ORDER WILL COST, ASKED OF THE SERVER BEFORE IT IS SENT (22/11).
 *
 * The app's «+ طلب» screen must show the very figure the order door will write, and the app must not carry a second copy
 * of the pricing rules (a copy is the one that drifts). So it asks: `POST /api/orders/quote` with the lines as the person
 * picked them, and gets back the lines AS THEY MUST BE SENT, the totals, and a ready `items[]` for `POST /api/orders`.
 *
 * THE SAME FIGURES THE WEB'S ORDER FORM SENDS — imported, not copied:
 *   · an offer line is priced by `priceByOffer` (offer-line-price.ts) at the bundle's price BEFORE its own reduction
 *     (`listPrice ?? price`), exactly the figure the web form's box holds (`liveOffersOf`, ProductLinesEditor.tsx). The
 *     reduction is NOT taken off a hand-typed order today — BACKLOG_P2 RV422/RV482 — and the quote says what the door will
 *     do, not what it should; the day that is fixed, it is fixed in one place for both.
 *   · a line with no offer is `atBasePrice` (line-price.ts);
 *   · the gift is `giftUnits` (offer-gift.ts), the door's own rule;
 *   · the total is `computeCod` (money.ts) — with no delivery fee, as the web form sends none: the fee follows the courier
 *     and is set when the shipment is made.
 *
 * AN INEXACT QUANTITY ON AN OFFER IS TWO LINES (the owner's brief): 4 on a «3 بـ75» is one line of 3 at 75 carrying the
 * offer and its gift, and one line of 1 at the base price with no offer. Never one line of 4 that the door would read
 * as «4 bundles' worth» of gift, and never the offer silently let go.
 *
 * REFUSED IS A SENTENCE, NEVER A FIGURE: an unknown base price, an offer that is not on sale, a quantity out of range —
 * the line comes back REFUSED with the Arabic reason and the quote has no total.
 */

export interface QuoteProduct {
  id: string;
  name: string;
  /** The product's base price for one piece, or null when not set. */
  basePrice: number | null;
}

export interface QuoteOffer {
  id: string;
  name: string;
  quantity: number;
  freeQuantity: number;
  /** What the customer is charged for the bundle (after its own reduction). */
  price: number;
  /** The bundle's price before its own reduction, or null. */
  listPrice: number | null;
  deliveryIncluded?: boolean | null;
}

export interface QuoteRequestLine {
  productId: string;
  offerId?: string | null;
  quantity: number;
}

export type QuoteBasis = 'OFFER' | 'BASE' | 'REFUSED';

export interface QuoteLine {
  productId: string;
  productName: string;
  offerId: string | null;
  offerName: string | null;
  /** Paid pieces. */
  quantity: number;
  /** Gift pieces the door will write on this line. */
  freeQuantity: number;
  /** What the line costs. Null when refused. */
  lineTotal: number | null;
  basis: QuoteBasis;
  /** Which request line this came from (an inexact offer line yields two). */
  from: number;
  notes: string[];
}

export interface Quote {
  ok: boolean;
  lines: QuoteLine[];
  /** Null when any line was refused. */
  subtotal: number | null;
  cod: number | null;
  minorUnit: number;
  /** Ready for `POST /api/orders` — `unitPrice` is the LINE's total, the door's legacy meaning. Empty when not ok. */
  items: Array<{ productId: string; offerId: string | null; quantity: number; unitPrice: number }>;
  /** True when a chosen offer carries delivery (the door then writes the order delivery-inclusive). */
  anyOfferIncludesDelivery: boolean;
  notes: string[];
}

const refusedLine = (
  from: number,
  product: { id: string; name: string },
  quantity: number,
  note: string,
  offer?: QuoteOffer | null
): QuoteLine => ({
  productId: product.id,
  productName: product.name,
  offerId: offer?.id ?? null,
  offerName: offer?.name ?? null,
  quantity,
  freeQuantity: 0,
  lineTotal: null,
  basis: 'REFUSED',
  from,
  notes: [note],
});

/**
 * The quote, from what the door read: the products (this store's), each product's LIVE offers (`activeOffersForProducts`,
 * the one reader every door uses) and the currency's minor unit. Pure — a test can hold it without a database.
 */
export function quoteOrder(input: {
  lines: QuoteRequestLine[];
  products: Map<string, QuoteProduct>;
  liveOffers: Map<string, QuoteOffer[]>;
  minorUnit: number;
  priceIncludesDelivery: boolean;
}): Quote {
  const { minorUnit } = input;
  const out: QuoteLine[] = [];
  let anyOfferIncludesDelivery = false;

  input.lines.forEach((req, from) => {
    const product = input.products.get(req.productId);
    if (!product) {
      out.push(refusedLine(from, { id: req.productId, name: '' }, req.quantity, 'المنتج غير موجود في هذا المتجر'));
      return;
    }
    const base = product.basePrice;

    if (!req.offerId) {
      const total = Number.isInteger(req.quantity) && req.quantity >= 1 && req.quantity <= 999 ? atBasePrice(base, req.quantity, minorUnit) : undefined;
      if (total === undefined) {
        out.push(
          refusedLine(
            from,
            product,
            req.quantity,
            Number.isInteger(req.quantity) && req.quantity >= 1 && req.quantity <= 999
              ? 'السعر الأساسي للمنتج غير محدد: اختر عرضاً أو حدّد السعر من شاشة المنتج'
              : 'الكمية لازم تكون عدد صحيح من 1 إلى 999'
          )
        );
        return;
      }
      out.push({
        productId: product.id, productName: product.name, offerId: null, offerName: null,
        quantity: req.quantity, freeQuantity: 0, lineTotal: total, basis: 'BASE', from, notes: [],
      });
      return;
    }

    const offer = (input.liveOffers.get(product.id) ?? []).find((o) => o.id === req.offerId);
    if (!offer) {
      out.push(refusedLine(from, product, req.quantity, 'العرض غير متاح اليوم لهذا المنتج: اختر عرضاً آخر أو بدون عرض'));
      return;
    }
    // The figure the web form sends for an offer line (see the header): before the bundle's own reduction.
    const bundlePrice = offer.listPrice ?? offer.price;
    const priced = priceByOffer(
      { quantity: offer.quantity, freeQuantity: offer.freeQuantity, price: bundlePrice },
      req.quantity,
      { basePrice: base, minorUnit }
    );
    if (priced.basis === 'REFUSED' || priced.lineTotal === null) {
      out.push(refusedLine(from, product, req.quantity, priced.notes[0] ?? 'تعذّر حساب السعر', offer));
      return;
    }
    if (priced.basis === 'BASE') {
      // Shorter than one bundle: the offer is let go, the base price stands, no gift — said out loud.
      out.push({
        productId: product.id, productName: product.name, offerId: null, offerName: null,
        quantity: req.quantity, freeQuantity: 0, lineTotal: priced.lineTotal, basis: 'BASE', from, notes: priced.notes,
      });
      return;
    }

    if (offer.deliveryIncluded === true) anyOfferIncludesDelivery = true;
    const bundleQty = priced.bundles * offer.quantity;
    out.push({
      productId: product.id, productName: product.name, offerId: offer.id, offerName: offer.name,
      quantity: bundleQty,
      // The door's own gift rule for the line it will write — equal to priced.gift by construction.
      freeQuantity: giftUnits(offer, bundleQty),
      lineTotal: priced.price, basis: 'OFFER', from, notes: [],
    });
    if (priced.remainder > 0) {
      const rest = atBasePrice(base, priced.remainder, minorUnit)!; // priceByOffer already refused an unknown base
      out.push({
        productId: product.id, productName: product.name, offerId: null, offerName: null,
        quantity: priced.remainder, freeQuantity: 0, lineTotal: rest, basis: 'BASE', from,
        notes: [`${priced.remainder} زيادة عن حزمة العرض بالسعر الأساسي`],
      });
    }
  });

  const ok = out.length > 0 && out.every((l) => l.basis !== 'REFUSED');
  if (!ok) {
    return {
      ok: false, lines: out, subtotal: null, cod: null, minorUnit, items: [], anyOfferIncludesDelivery,
      notes: out.length === 0 ? ['أضف منتجاً واحداً على الأقل'] : [],
    };
  }
  const money = computeCod({
    lines: out.map((l) => ({ quantity: l.quantity, unitPrice: (l.lineTotal as number) / l.quantity })),
    discount: 0,
    deliveryFee: 0,
    priceIncludesDelivery: input.priceIncludesDelivery,
    minorUnit,
  });
  return {
    ok: true,
    lines: out,
    subtotal: money.subtotal,
    cod: money.cod,
    minorUnit,
    items: out.map((l) => ({ productId: l.productId, offerId: l.offerId, quantity: l.quantity, unitPrice: l.lineTotal as number })),
    anyOfferIncludesDelivery,
    notes: [],
  };
}
