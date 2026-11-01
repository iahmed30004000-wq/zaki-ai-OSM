import { priceIncludesDeliveryFor } from './delivery-fees';
import { offersSayDeliveryIncluded } from './offer-delivery';
import { activeOffersFor, postOrderOfferFor, type OfferView } from './offers';
import { DEFAULT_POST_ORDER_OFFER, postOrderOfferSettings } from './post-order-offer';
import { db } from './db';
import { findOrCreateCustomer } from './customer-identity';
import { normalizePhoneNumber } from './phone';
import { orderRefFields } from './order-ref';
import { computeCod, roundMinor } from './money';
import { productCost } from './product-cost';
import { matchRegion } from './regions';
import { NEUTRAL_REFUSAL, isBlocked } from './blacklist';
import { rateLimit, releaseRateLimit } from './rate-limit';
import { ADDON_TOKEN_MINUTES, signAddonToken } from './landing-pages';
import { toLatinDigits } from './latin-digits';
import { emitAppEvent } from './apps/events';
import { notify } from './notify';
import { flagRecentTwins } from './recent-twin-order';
import { queueConversions } from './conversions/emit';
import {
  buildPublicOrderSchema,
  mapZodFieldErrors,
  ORDER_VALIDATION_ERROR_BODY,
} from './landing-order-schema';
// Plain rules and plain sentences — never `store-theme`: the engine that decides money sees nothing of the look.
import { blankRequired, type CheckoutRules } from './checkout-words';

/**
 * TAKING AN ORDER FROM A STRANGER.
 *
 * A landing page and a storefront are two doors into one shop. Everything
 * behind the door is identical — the same validation against the same
 * country, the same blacklist, the same duplicate guard, the same customer
 * record, the same ONE cod function, the same Order row. Only the doorway
 * differs: which page it was, what the order's source says, and which
 * counter goes up.
 *
 * So the intake lives here, once. A second copy would drift on the day one
 * of them gained a rule the other did not — and the rules here are the ones
 * that decide what a customer is charged and whether a blocked number gets
 * through.
 *
 * Nothing in the request is trusted. The price, the quantity, the product,
 * the company and the country are all derived on the server from the
 * surface; the visitor supplies a name, a phone, an address, a city, a
 * chosen offer id and a note, and nothing else is read.
 */

/** Where the order came in through. Resolved by the route, never by the browser. */
/**
 * ONE THING ORDERED, priced by the server.
 *
 * `quantity` is PIECES, not picks: two of a «٣ قطع» bundle is six. The
 * division from a bundle's total to a unit price happens once, where the
 * offer row is read, and never in a browser.
 */
export interface ResolvedLine {
  product: { id: string; name: string; image: string | null; basePrice: number };
  offer: OfferView | null;
  quantity: number;
  freeQuantity: number;
  unitPrice: number;
  /**
   * THE OFFER'S OWN REDUCTION — an ABSOLUTE amount in the store's currency,
   * never a percentage. `allocateDiscount` clamps it with
   * `Math.min(discount, subtotal)` and spreads it by line value; a
   * percentage clamped against a subtotal would be nonsense, and the admin
   * form validates it with `money(1_000_000)`, not a 0–100 range.
   *
   * It is not on `OfferView`. That view is what a BROWSER is handed, and
   * `activeOffersFor` does not select this column — so it is read here,
   * server-side, for the offers the basket actually chose. 0 for a line
   * sold at the product's base price, which has no offer to reduce.
   */
  offerDiscount: number;
}

/** What a basket asked for, before anything has been priced. */
export interface ChosenLine {
  productId: string;
  /** '' for the product at its base price. */
  offerId: string;
  count: number;
}

export type ResolveResult =
  | { ok: true; lines: ResolvedLine[] }
  | { ok: false; fieldErrors: Record<string, string> };

/**
 * WHAT THIS BASKET IS, AND WHAT EACH LINE COSTS — the one answer.
 *
 * Extracted from `createPublicOrder` because the cart page has to show a
 * total before anybody orders, and the only honest way to get one is to
 * ask the code that will charge it. A second pricing path beside this one
 * would agree on the day it was written and disagree on the next.
 *
 * Every figure comes from the offer row. A quantity or a price sent by a
 * browser is ignored, and an offer's price is the TOTAL for its own
 * quantity — so asking for two of a «٣ قطع» bundle is six pieces at the
 * same unit price, and that division happens here, once.
 *
 * `products` is everything the door may sell. A product that is not in it
 * is refused rather than priced: that is how an id from another shop's
 * catalogue fails.
 */
export async function resolvePublicLines(
  companyId: string,
  products: SellingSurface['products'],
  chosen: ChosenLine[],
  /** The order's own currency — `activeOffersFor` rounds the charged price with it. */
  minorUnit: number
): Promise<ResolveResult> {
  const byId = new Map(products.map((p) => [p.id, p]));
  const lines: ResolvedLine[] = [];

  for (const want of chosen) {
    const p = byId.get(want.productId);
    if (!p) {
      return { ok: false, fieldErrors: { items: 'أحد المنتجات لم يعد متاحاً. أعد تحميل الصفحة.' } };
    }

    // One query per product: a basket is bounded at MAX_CART_LINES, and
    // this runs when somebody opens their cart or presses «اطلب».
    const offers = await activeOffersFor(db, companyId, p.id, minorUnit);
    let offer: OfferView | null = null;
    if (want.offerId) {
      const found = offers.find((o) => o.id === want.offerId);
      if (!found) return { ok: false, fieldErrors: { offerId: 'يرجى اختيار أحد العروض.' } };
      offer = found;
    } else if (offers.length > 0) {
      // Offers exist — an explicit selection is required.
      return { ok: false, fieldErrors: { offerId: 'يرجى اختيار أحد العروض.' } };
    }

    /*
     * THE PRE-DISCOUNT UNIT PRICE, AND THE REDUCTION, BOTH FROM THE VIEW.
     *
     * `offer.price` is now what the customer is CHARGED and `offer.listPrice`
     * is the bundle before its own reduction, so the difference IS the
     * discount — and `computeCod` must be handed the figures BEFORE it, or
     * it would subtract a reduction already taken and charge 19 for a bundle
     * that promises 22.
     *
     * The reduction is not simply dropped instead. `computeCod` allocates it
     * into `OrderItem.discountShare`, which is the figure a partial return
     * refunds against — losing it is the quieter half of the defect 448ba22
     * was written for.
     */
    const unitsPerPick = offer ? offer.quantity : 1;
    const listTotal = offer ? offer.listPrice ?? offer.price : p.basePrice;
    const unitPrice = offer ? listTotal / offer.quantity : p.basePrice;
    lines.push({
      product: p,
      offer,
      quantity: unitsPerPick * want.count,
      freeQuantity: (offer ? offer.freeQuantity : 0) * want.count,
      unitPrice,
      offerDiscount: offer ? Math.max(0, listTotal - offer.price) : 0,
    });
  }

  /*
   * THE SECOND QUERY IS GONE, and so is the reason it existed.
   *
   * A basket-wide read of `Offer.discount` stood here, under a comment
   * explaining that the view «does not carry this column; widening it would
   * put a money figure into the shape four public surfaces render». The
   * view already carried a money figure — `price` — and the real defect was
   * that it was the WRONG one: the figure before the bundle's reduction,
   * while every door charged the figure after. So the landing page printed
   * 25 for a bundle the cart priced at 22.
   *
   * `activeOffersFor` now returns both, computed once by `allocateDiscount`,
   * and the loop above reads them. One source, one subtraction, and a query
   * per basket fewer.
   */
  return { ok: true, lines };
}

/**
 * WHAT THIS BASKET'S DISCOUNT IS — the one number `computeCod` is given.
 *
 * THE DEFECT THIS EXISTS FOR. Two doors create orders and both call the
 * same `computeCod`. The manual door (`/api/orders`) passed
 * `discount: offer?.discount ?? 0`; this one passed no discount at all. So
 * an offer of 25 with a discount of 3 was 22 by phone and 25 from the
 * landing page — the waybill carried 25 and the courier collected 25. The
 * owner's ruling: pass it, exactly as the manual door does.
 *
 * ONCE PER OFFER, NOT ONCE PER PICK. The manual door applies the offer's
 * discount flat — one order, one offer, one reduction, whatever the
 * quantity — and that is the behaviour being matched. Counting it per pick
 * would be a new pricing rule and the owner's to make, not this
 * function's. Deduplicating by offer id is what makes «the same bundle
 * twice as two cart lines» and «the same bundle at count 2» agree; without
 * it a browser could split one bundle across two lines and claim the
 * reduction twice.
 *
 * SUMMED ACROSS DISTINCT OFFERS, though. A basket may hold two different
 * bundles, each advertising its own reduction, and the manual door has no
 * opinion because it only ever knows one offer. Honouring only one of them
 * would break a promise printed on the other — the same reasoning
 * `deliveryIncluded` already settles below.
 *
 * `computeCod` clamps the result to the subtotal and allocates it across
 * the lines, so a discount larger than the basket cannot make a negative
 * total and the per-line `discountShare` always adds back up to the whole.
 */
export function basketDiscount(lines: ResolvedLine[]): number {
  const seen = new Set<string>();
  let total = 0;
  for (const line of lines) {
    const id = line.offer?.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    total += Math.max(0, line.offerDiscount);
  }
  return total;
}

export interface SellingSurface {
  companyId: string;
  store: {
    id: string;
    countryId: string;
    country: { code: string; currencyCode: string; orderPrefix: string; minorUnit: number };
  };
  /**
   * EVERYTHING THIS DOOR MAY SELL, and nothing else.
   *
   * One product for a landing page or a single-product shop. For a cart, the
   * products the basket named — loaded by the ROUTE, scoped to this store,
   * so an id from another shop's catalogue simply is not here and the order
   * is refused rather than priced.
   *
   * It was a single product, and everything downstream was single with it
   * although `computeCod` has taken a list of lines all along.
   */
  products: { id: string; name: string; image: string | null; basePrice: number }[];
  /** The landing page, when the door was one. */
  landingPage: { id: string; name: string; slug: string } | null;
  /** What the order records as its origin. */
  source: string;
  /**
   * The paid campaign that brought this visitor, resolved from the `c=`
   * code in the link they clicked.
   *
   * Resolved by the ROUTE against this store's campaigns, never taken from
   * the browser as an id: a visitor who could name a campaign id could
   * credit another shop's spend with their order.
   */
  campaignId: string | null;
  /** Scopes the one-order-per-phone guard to this door. */
  dedupeScope: string;
  /**
   * The kind of device the order came from (mobile / tablet / desktop),
   * classed by the route from the request. Never the raw user agent.
   */
  deviceClass?: 'mobile' | 'tablet' | 'desktop' | null;
  /** Title and message of the new-order notification. */
  notice: { title: string; message: (orderNumber: string) => string };
  /**
   * WHAT THIS SHOP'S «الدفع» REQUIRES, AS THE DOOR ENFORCES IT.
   *
   * Resolved by the ROUTE from the store's LIVE theme (`checkoutRules`), never from the browser and never from the
   * draft. The four a parcel needs keep the schema's own checks; what this adds is the second number and the note,
   * when the seller ticked «إلزامي» and left them visible. Absent or null — a door that names none — asks nothing
   * beyond the four, exactly as before.
   */
  checkout?: CheckoutRules | null;
}

export type IntakeResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; body: Record<string, unknown>; headers?: Record<string, string> };

/**
 * Create a real order from a public visitor.
 *
 * Returns a shaped result rather than a Response so the two routes keep
 * their own CORS and their own 404s, and so this stays testable without a
 * request object.
 */
export async function createPublicOrder(
  surface: SellingSurface,
  raw: unknown
): Promise<IntakeResult> {
  /*
   * THE SLOT IS GIVEN BACK WHEN NOTHING WAS SAVED.
   *
   * The one-order-per-phone slot is taken before the customer and the order are written, and a write that threw (a
   * 500) used to leave it taken: the customer pressed «اطلب» again and was told «تم استلام طلبك» about an order that
   * does not exist. `held` carries the slot's key out of the intake; if the intake throws before the order was
   * saved, the slot is released and the second press is a real second try. Once saved it is never released — that
   * is the case the slot is for.
   */
  const held: { key: string | null; saved: boolean } = { key: null, saved: false };
  try {
    return await takeOrder(surface, raw, held);
  } catch (e) {
    if (held.key && !held.saved) releaseRateLimit(held.key);
    throw e;
  }
}

async function takeOrder(
  surface: SellingSurface,
  raw: unknown,
  held: { key: string | null; saved: boolean }
): Promise<IntakeResult> {
  const { companyId, store } = surface;
  const principalProduct = surface.products[0];
  if (!principalProduct) {
    return { ok: false, status: 400, body: { error: 'لا يوجد منتج في هذا الطلب' } };
  }

  // ─── Validation, against THIS country ───
  // The phone format and the list of cities depend on the country the shop
  // sells into. A Jordanian store must not be validated against Syrian rules.
  const regions = await db.region.findMany({
    where: { countryId: store.countryId, isActive: true },
    select: { id: true, name: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });

  const parsed = buildPublicOrderSchema({
    countryCode: store.country.code,
    regions: regions.map((r) => r.name),
  }).safeParse(raw);
  if (!parsed.success) {
    // Safe Arabic field errors only — no Zod internals leak to the visitor.
    return {
      ok: false,
      status: 400,
      body: { ...ORDER_VALIDATION_ERROR_BODY, fieldErrors: mapZodFieldErrors(parsed.error) },
    };
  }
  const v = parsed.data;

  // Honeypot filled → bot. Generic rejection.
  if (v.website && v.website.length > 0) {
    return { ok: false, status: 400, body: { error: 'تعذر إرسال الطلب' } };
  }

  /*
   * «إلزامي» IS MEANT AT THE DOOR — the owner's answer, 28/10, to «refuse, or take it as before?».
   *
   * A second number or a note the shop requires, left blank, is refused HERE: after the schema and before anything
   * is written — no customer, no order, no activity, no event, no notification, and not the one-order-per-phone
   * slot either, so the visitor who fills it in and presses again is not told the order was already received. The
   * same sentence the form says under the field (`checkout-words.ts`). A field the shop hid is never required, and
   * a value sent for one by an older page is taken as before.
   */
  const blank = blankRequired(surface.checkout?.required ?? [], v);
  if (blank) {
    return { ok: false, status: 400, body: { ...ORDER_VALIDATION_ERROR_BODY, fieldErrors: blank } };
  }

  const normalizedPhone = normalizePhoneNumber(v.phone, store.country.code);
  if (normalizedPhone.length < 7 || normalizedPhone.length > 15) {
    return { ok: false, status: 400, body: { error: 'رقم الهاتف غير صالح' } };
  }

  // The chosen city is a real region of this country, so the order carries
  // its id — that is what the delivery-fee table is keyed on. Same matcher
  // every other intake path uses.
  const region = matchRegion(regions, v.city);

  // ─── What was ordered, resolved on the server ───
  // The offers belong to the PRODUCT: one bundle, one price, wherever it is
  // sold. quantity / freeQuantity / price all come from the row — a quantity
  // or a price sent by the browser is ignored.
  //
  // A basket, when one was sent, IS the order; `offerId` is then ignored,
  // because two ways of saying what was ordered, both honoured, is two
  // orders. One query per product: a basket is bounded at MAX_CART_LINES,
  // and this runs once, when somebody presses «اطلب».
  const chosen = v.items?.length
    ? v.items.map((i) => ({ productId: i.productId, offerId: i.offerId || '', count: i.quantity }))
    : [{ productId: principalProduct.id, offerId: v.offerId || '', count: 1 }];

  const resolved = await resolvePublicLines(companyId, surface.products, chosen, surface.store.country.minorUnit);
  if (!resolved.ok) {
    return {
      ok: false,
      status: 400,
      body: { ...ORDER_VALIDATION_ERROR_BODY, fieldErrors: resolved.fieldErrors },
    };
  }
  const lines = resolved.lines;

  /*
   * AN ORDER WORTH NOTHING IS NOT AN ORDER — refused before anything is taken.
   *
   * A product at 0 with no offer, or an offer at 0, used to create an order for 0: a parcel that ships and a
   * courier who collects nothing. The same `computeCod` that will charge the order is asked what the goods come
   * to (it is pure, so asking early writes nothing), and a basket whose goods come to nothing is told the product is
   * not available. Asked before the blacklist, the phone slot and the customer, so the refusal costs the visitor
   * nothing and leaves no customer row behind. Gift units never reach it: they are free lines inside a paid one.
   */
  const money = computeCod({
    lines: lines.map((l) => ({
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      freeQuantity: l.freeQuantity,
    })),
    discount: basketDiscount(lines),
    minorUnit: store.country.minorUnit,
  });
  if (money.subtotal <= 0) {
    return { ok: false, status: 400, body: { error: 'هذا المنتج غير متاح للطلب حاليًا' } };
  }

  // ─── Blacklist, company-wide ───
  // The message says nothing: telling somebody they are blacklisted invites
  // them to try another number, and tells them which one is burned. The RAW
  // phone as typed — normalizing first would drop the leading + that marks
  // an international form, and a block stored from "+963…" would then miss a
  // local "0…", which is the exact way around a block.
  if (await isBlocked(db, companyId, v.phone)) {
    return { ok: false, status: 400, body: { error: NEUTRAL_REFUSAL } };
  }

  // ─── Duplicate-submission protection (per phone, per door) ───
  const dup = rateLimit(`pub_order_dup:${surface.dedupeScope}:${normalizedPhone}`, 1, 5 * 60_000);
  // The slot this request now holds — given back by `createPublicOrder` if the order is never saved.
  if (dup.allowed) held.key = `pub_order_dup:${surface.dedupeScope}:${normalizedPhone}`;
  if (!dup.allowed) {
    return {
      ok: false,
      status: 429,
      body: { error: 'تم استلام طلبك بالفعل. سنتواصل معك قريبًا' },
      headers: { 'Retry-After': String(dup.retryAfterSec) },
    };
  }

  // ─── Customer upsert (the same one every other door uses) ───
  const customer = await findOrCreateCustomer(db, {
    companyId,
    storeId: store.id,
    phone: normalizedPhone,
    // Latin digits: the phone is typed on an Arabic keyboard, and «٠٧٩١٢٣٤٥٦٧» reached the courier as it was typed.
    rawPhone: toLatinDigits(v.phone),
    fullName: v.full_name,
    // Stored when given; the phone above stays the identity.
    altPhone: v.alt_phone ? normalizePhoneNumber(v.alt_phone, store.country.code) : null,
    address: v.address,
    city: v.city,
    notes: v.notes || null,
  });

  // ─── Create the REAL order (same Order model, same defaults) ───

  /**
   * WHAT THE GOODS COST — and it is not zero.
   *
   * This read `const unitCost = 0`, with a comment saying public orders have
   * no batch context and finance would finalise it later. Both halves were
   * wrong in the way that matters:
   *
   *   An order does not need a BATCH to be costed. It needs the product's
   *   cost, and `productCost` already computes the weighted average of the
   *   stock actually on hand — that is the number the internal order door
   *   has used all along, and the whole point of that helper is to stop two
   *   doors choosing differently.
   *
   *   Finance never finalised anything. `productCost` is null on every one
   *   of the 166 orders on this database, and the finance door falls back to
   *   `estimatedCostOfGoods` — the zero this line wrote.
   *
   * Measured: 115 delivered orders, ALL of them carrying zero cost of goods,
   * six of them raised through this very door rather than imported. Every
   * profit figure over them is overstated by the entire cost of the goods,
   * and the storefront is the channel the launch runs on.
   *
   * Zero stays possible and stays honest: a product with no costed stock on
   * hand averages to zero, and that is a real answer to «ما كلفة وحدةٍ
   * الآن؟» when there is nothing on the shelf to read a price from.
   */
  // Per line, and summed. `productCost` is asked once per distinct product:
  // a basket with two bundles of the same product must not count its cost
  // twice as a query, only as a quantity.
  const unitCosts = new Map<string, number>();
  for (const line of lines) {
    if (!unitCosts.has(line.product.id)) {
      unitCosts.set(line.product.id, (await productCost(db, companyId, line.product.id)).average);
    }
  }
  /*
   * ⚠️ THE GIFT COSTS WHAT IT COSTS — here as at the internal door.
   *
   * «عبوتان + الثالثة مجاناً» puts THREE units in the box: the stock is already told so (`quantity + freeQuantity`
   * everywhere downstream), and this line costed only the two that were paid for. Every bundle with a gift sold
   * through a landing page or a shop therefore reported a profit too large by exactly the cost of the gift. The
   * internal door (`POST /api/orders`) has costed `quantity + gift` all along; the two doors now agree.
   * Free to the customer is not free to the shop — the money the customer pays is untouched by this.
   */
  const costOfGoods = lines.reduce(
    (sum, l) => sum + (unitCosts.get(l.product.id) ?? 0) * (l.quantity + l.freeQuantity),
    0
  );

  // ONE COD function (contract PART 5). The offer price is the total for its
  // quantity; free units are real lines at zero price, so they never enter
  // the money maths — only stock and COGS.
  //
  // `discount` IS NOT OPTIONAL HERE, whatever its type says. Leaving it off
  // was this door's defect: the manual door passed the offer's discount and
  // this one did not, so the same offer cost two different amounts
  // depending on which door the customer came through, and the courier
  // collected the undiscounted figure. See `basketDiscount`.
  // The one `computeCod` answer was asked above, before anything was written.
  const totalAmount = money.cod;

  /**
   * THE HEAD OF THE ORDER IS ITS PRINCIPAL LINE.
   *
   * `Order.productId`, `quantity`, `sellingPrice` and the two snapshots are
   * what every existing screen shows in a row, and they cannot show four
   * products in one cell. So they describe the LARGEST line, and
   * `Order.items` is what was ordered. For a one-line order the two are the
   * same thing, which is every order this system has taken until now.
   *
   * `totalAmount` is the whole order and always has been — it comes from
   * `computeCod` over every line, so the head being one line never makes
   * the money wrong.
   */
  let principal = 0;
  for (let i = 1; i < lines.length; i++) {
    if ((money.lineTotals[i] ?? 0) > (money.lineTotals[principal] ?? 0)) principal = i;
  }
  const head = lines[principal];

  /**
   * The store's pricing policy — the same rule a direct order follows.
   *
   * An offer may override it, and the contract settles what happens when a
   * basket holds more than one: «If ANY line includes delivery, the whole
   * order does.»
   *
   * THIS USED TO IGNORE EVERY OFFER THE MOMENT THERE WERE TWO LINES, and
   * fell back to the shop's policy. The reasoning was not silly — the fee is
   * charged once for the whole order, so two bundles disagreeing have no
   * answer between them — but the effect was that a bundle advertised as
   * «السعر شامل التوصيل» had the fee added anyway as soon as the customer
   * put something else in the basket. A promise printed on the offer and
   * broken at the door.
   *
   * WHAT THE CONTRACT'S RULE COSTS, said plainly rather than hidden: a
   * customer can add one cheap delivery-included bundle to a large basket
   * and the whole order ships free. That is the price of never breaking the
   * printed promise, and it is the owner's ruling. The lever if it is ever
   * abused is the OFFER — do not mark a cheap bundle delivery-included —
   * not a second rule here.
   *
   * AND AN OFFER'S «NO» IS HEARD TOO (the owner, 1/11: «بدي اترك مجال … أحدد إذا شامل ولا لأ بظبط»). When EVERY line carries an offer and
   * every offer is unticked, the order is not delivery-included even in a store whose policy includes delivery for everything else;
   * a line with no offer, or any offer that says yes, leaves the answer as it was. `offersSayDeliveryIncluded` is the one reader.
   */
  const priceIncludesDelivery = await priceIncludesDeliveryFor(
    store.id,
    offersSayDeliveryIncluded(lines.map((l) => l.offer?.deliveryIncluded))
  );

  // The door, as the order channels name it — so the channel table on the
  // performance screen and the landing-page tab count the same orders. New
  // public orders carried no channel at all, and only the historical ones
  // (filled by a one-time backfill) were counted there.
  const channel = await db.orderChannel.findFirst({
    where: { companyId, kind: surface.landingPage ? 'LANDING_PAGE' : 'WEBSITE', isActive: true },
    orderBy: { sortOrder: 'asc' },
    select: { id: true },
  });

  /*
   * THE NUMBER'S RETRY LIVES OUTSIDE THE TRANSACTION.
   *
   * Two orders taking the same number race, and the loser gets a P2002 on the insert. On Postgres a failed statement
   * aborts the whole transaction, so a retry INSIDE it could not even run — every later statement answered «current
   * transaction is aborted». The loop is out here instead: a collision rolls the transaction back and the whole of
   * it runs again with the next attempt, like `ops/tracking/transfer`.
   */
  let placed: Awaited<ReturnType<typeof createOrderOnce>> | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      placed = await createOrderOnce(attempt);
      break;
    } catch (e: unknown) {
      if ((e as { code?: string })?.code === 'P2002' && attempt < 4) continue;
      throw e;
    }
  }
  if (!placed) throw new Error('Failed to generate a unique order number');
  const order = placed;
  // From here the order exists: nothing below may give the phone slot back.
  held.saved = true;

  async function createOrderOnce(attempt: number) {
    return db.$transaction(async (tx) => {
        const refs = await orderRefFields(tx, companyId, store.country.orderPrefix, attempt);
        const created = await tx.order.create({
          data: {
            companyId,
            countryId: store.countryId,
            storeId: store.id,
            regionId: region?.id ?? null,
            ...refs,
            customerId: customer!.id,
            productId: head.product.id,
            quantity: head.quantity,
            freeQuantity: head.freeQuantity,
            sellingPrice: money.lineTotals[principal] ?? money.subtotal,
            shippingCost: 0,
            totalAmount,
            currency: store.country.currencyCode,
            moderatorId: null, // anonymous source — no user may be assigned from the browser
            // Cost rounds by the CURRENCY, like every other figure on
            // this row — `.toFixed(2)` here put a 2-decimal cost beside a
            // 3-decimal JOD total, and the profit report subtracts one from
            // the other.
            estimatedCostOfGoods: roundMinor(costOfGoods, store.country.minorUnit),
            productNameSnapshot: head.product.name,
            productImageSnapshot: head.product.image || null,
            status: 'NEW',
            confirmationStatus: 'NEW',
            shippingStatus: 'NOT_READY',
            settlementStatus: 'NOT_APPLICABLE',
            assignedToId: null,
            claimedById: null,
            currentOwnerId: null,
            signatureStatus: 'UNSIGNED',
            version: 1,
            source: surface.source,
            landingPageId: surface.landingPage?.id ?? null,
            campaignId: surface.campaignId,
            channelId: channel?.id ?? null,
            deviceClass: surface.deviceClass ?? null,
            priceIncludesDelivery,
            offerId: head.offer?.id ?? null,
            customerNotes: v.notes || null,
            internalNotes: null,
            // WHERE THIS PARCEL GOES, as the visitor typed it. The customer row keeps one address (the first they
            // ever gave), and a returning customer who types a new street used to have the waybill printed with the
            // old one. The order keeps its own; readers take it before the customer's.
            deliveryAddress: v.address,
          },
        });

    // Every line, gift units included: they consume stock and show in COGS.
    // `createMany` rather than a loop — one statement, and a basket that
    // half-wrote itself is not a thing this order path can produce.
    await tx.orderItem.createMany({
      data: lines.map((l, i) => ({
        companyId,
        orderId: created!.id,
        productId: l.product.id,
        // A snapshot: the name as it was sold, so renaming a product later
        // never rewrites what an old order says was bought.
        productName: l.product.name,
        quantity: l.quantity,
        freeQuantity: l.freeQuantity,
        unitPrice: l.unitPrice,
        discountShare: money.discountShares[i] ?? 0,
        lineTotal: money.lineTotals[i] ?? 0,
        addedStage: 'INTAKE',
      })),
    });

    await tx.customer.update({
      where: { id: customer!.id },
      data: {
        totalOrders: { increment: 1 },
        lastOrderDate: new Date(),
        firstOrderDate: customer!.firstOrderDate || new Date(),
      },
    });

    await tx.orderActivity.create({
      data: {
        companyId,
        orderId: created.id,
        userId: null, // anonymous visitor — no user to attribute
        action: 'ORDER_CREATED',
        newStatus: 'NEW',
        metadata: JSON.stringify({
          source: surface.source,
          landingPage: surface.landingPage?.name ?? null,
          landingPageSlug: surface.landingPage?.slug ?? null,
          // Every line, not just the head: the head is a display choice, and
          // an activity entry that recorded only it would be a record of
          // part of the order.
          lines: lines.map((l) => ({
            product: l.product.name,
            quantity: l.quantity,
            freeQuantity: l.freeQuantity,
            offer: l.offer ? l.offer.name : null,
            unitPrice: l.unitPrice,
          })),
          createdBy: 'public visitor',
          // What was typed, when it is not what the customer row already says — so whoever opens the order can see
          // the returning customer gave a different name or city this time.
          ...(customer!.fullName !== v.full_name || customer!.city !== v.city
            ? { typed: { name: v.full_name, city: v.city } }
            : {}),
        }),
      },
    });

    if (surface.landingPage) {
      await tx.landingPage.update({
        where: { id: surface.landingPage.id },
        data: { ordersCount: { increment: 1 } },
      });
    }

    return created;
    });
  }

  // Same customer, same product, minutes apart: a flag on the history for the person who calls — never a refusal.
  // After the commit and never able to fail it (the five-minute limiter above refuses a second SUBMISSION; this notes
  // a second ORDER the limiter let through, such as the same product asked for again after the window).
  await flagRecentTwins(db, {
    companyId,
    orderId: order.id,
    customerId: customer.id,
    productIds: lines.map((l) => l.product.id),
    at: order.createdAt,
    userId: null,
  });

  // The same announcement every other new order makes, through the one
  // function that makes it: this store's confirmation supervisors, one row
  // each. A visitor is not an employee, so there is no actor to leave out.
  // Never throws — the order is saved whatever happens here.
  notify({
    companyId,
    storeId: store.id,
    audience: { permission: 'confirmation.supervise' },
    title: surface.notice.title,
    message: surface.notice.message(order.orderNumber),
    type: 'ORDER_NEW',
    link: ['/confirmation/queue', '/confirmation/mine', '/orders'],
  });

  // Tell the installed apps. Never inline with the write: an order that
  // saved has saved, whatever any integration thinks about it.
  await emitAppEvent(companyId, 'order.created', {
    orderId: order.id,
    orderNumber: order.orderNumber,
    total: Number(order.totalAmount),
    currency: order.currency,
    // The head line, as the row shows it — and the count of everything in
     // the order beside it, so an app that only reads one number reads the
     // one that is true of the whole order.
     quantity: head.quantity,
     items: lines.length,
     pieces: lines.reduce((n, l) => n + l.quantity + l.freeQuantity, 0),
     productId: head.product.id,
     productName: head.product.name,
    source: surface.source,
    storeId: store.id,
    city: v.city,
  });

  // And tell Meta, if the seller asked for this moment. Same rule as above:
  // never able to undo the order, and never inline with the write.
  await queueConversions(companyId, 'order.created', order.id);

  // Short-lived add-on capability token for the success screen (upsells).
  // Stateless (no DB), order-scoped, 30-minute TTL.
  let addonToken: string | null = null;
  try {
    addonToken = await signAddonToken({ orderId: order.id, orderNumber: order.orderNumber });
  } catch (e) {
    console.error('Addon token signing failed (non-fatal):', e);
  }

  // Server-provided upsells for the success screen. A storefront has no
  // recommendation list of its own yet, so it simply offers none — better
  // than inventing a suggestion nobody configured.
  //
  // Never fatal, and never free: a failed read is an empty list (the order is already saved, and a thank-you screen
  // that fails to load is a customer who does not know their order was taken), and a suggestion with no name or no
  // price is not offered — `add-product` would refuse it anyway, and a card that always fails teaches nothing.
  let recommendations: {
    id: string;
    product: { id: string; name: string; basePrice: number; image: string | null } | null;
  }[] = [];
  try {
    recommendations = surface.landingPage
      ? await db.landingPageRecommendation.findMany({
          where: { landingPageId: surface.landingPage.id, isActive: true, product: { status: 'ACTIVE' } },
          orderBy: { sortOrder: 'asc' },
          select: { id: true, product: { select: { id: true, name: true, basePrice: true, image: true } } },
        })
      : [];
    recommendations = recommendations.filter((r) => !!r.product?.name && (r.product?.basePrice ?? 0) > 0);
  } catch (e) {
    console.error('Recommendations lookup failed (non-fatal):', e);
    recommendations = [];
  }

  /*
   * ─── THE OFFER AFTER THE ORDER ───
   *
   * «وصلنا طلبك!» → «زيد علبة كمان؟ 15 بدل 25». ONE offer, the one the
   * seller flagged on the head product, at the price the SERVER computes —
   * `postOrderOfferFor` runs the same `toOfferView` the door's own prices
   * came from, so the figure on the thank-you screen is the figure this
   * shop charges and not a number a page remembered.
   *
   * NOTHING ABOUT THE ORDER THAT WAS JUST CREATED CHANGES HERE. This is a
   * read, after the write, added to the RESPONSE — the same shape and the
   * same place `recommendations` and `addonToken` already occupy. The order
   * row, its lines, its total and its events are byte-for-byte what they
   * were before this block existed, which is the one thing this brief was
   * allowed to touch order creation for and the one thing it must not do.
   *
   * The HEAD product, because the head is the line every screen shows and
   * the one the customer was looking at. A basket of four products offering
   * four after-order bundles is four decisions on a screen that has just
   * been thanked; the brief says one.
   *
   * Never fatal. A thank-you screen that fails to load because an upsell
   * query threw is a customer who does not know their order was taken.
   */
  let postOrderOffer: OfferView | null = null;
  let postOrderWindowMinutes = DEFAULT_POST_ORDER_OFFER.windowMinutes;
  try {
    postOrderOffer = await postOrderOfferFor(
      db,
      companyId,
      head.product.id,
      store.country.minorUnit
    );
    /*
     * THE WINDOW THE SCREEN IS TOLD IS THE ONE THAT CLOSES FIRST.
     *
     * Two clocks stand on an add-on: the seller's window (`postOrderOfferSettings`, up to a day) and the link's own
     * life (`ADDON_TOKEN_MINUTES`, thirty). The screen was told the first, so a seller who set sixty had a counter
     * running for an hour on a link that died at thirty. Told the smaller, and told it whenever ANY add-on can be
     * taken here — a recommendation counts as much as the offer, and it used to get the default fifteen whatever
     * the seller had set.
     */
    if (postOrderOffer || recommendations.length > 0) {
      postOrderWindowMinutes = Math.min(
        (await postOrderOfferSettings(companyId)).windowMinutes,
        ADDON_TOKEN_MINUTES
      );
    }
  } catch (e) {
    console.error('Post-order offer lookup failed (non-fatal):', e);
  }

  return {
    ok: true,
    body: {
      success: true,
      orderNumber: order.orderNumber,
      addonToken,
      /**
       * The one after-order bundle, or null when the seller set none.
       *
       * `OfferView` and not a shape of its own: `price` on it is already
       * what the customer is CHARGED, and `listPrice` is the bundle before
       * its own reduction — which is exactly «15 بدل 25» and is the only
       * honest way for a screen to print those two numbers without
       * subtracting anything itself.
       */
      postOrderOffer,
      /**
       * How long the offer may still be taken, in minutes, from the
       * company's own setting. The screen STATES it; it does not enforce it
       * — every gate is on the server, in `postOrderGate`.
       */
      postOrderWindowMinutes,
      // Server-authoritative amounts — the ONLY source for Purchase
      // conversion tracking (client/browser values are never trusted).
      total: Number(order.totalAmount),
      currency: order.currency,
      recommendations: recommendations.map((r) => ({
        id: r.id,
        name: r.product?.name || null,
        price: r.product?.basePrice ?? 0,
        image: r.product?.image || null,
      })),
    },
  };
}
