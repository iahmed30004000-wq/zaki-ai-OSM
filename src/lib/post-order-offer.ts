import { db } from './db';
import {
  POST_ORDER_ADDITION_AR,
  POST_ORDER_REFUSAL_AR,
  type PostOrderRefusal,
} from './post-order-offer-copy';
import { updateCompanySettings } from './company-settings';
import { computeCod } from './money';
import { postOrderOfferFor, postOrderOfferStateFor } from './offers';
import type { OfferView, PostOrderOfferOff, PostOrderOfferState } from './offers';

/*
 * The words are a leaf of their own (`post-order-offer-copy.ts`) so a
 * `'use client'` screen can read them without this module's Prisma import
 * following them into the browser bundle. Re-exported here so a server
 * caller has one place to look.
 */
export { POST_ORDER_ADDITION_AR, POST_ORDER_REFUSAL_AR };
export type { PostOrderRefusal };

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE OFFER AFTER THE ORDER — «وصلنا طلبك! زيد علبة كمان؟ 15 بدل 25»
 *
 * The owner said yes to one offer on the thank-you screen, and said it in
 * four sentences that are each a rule here:
 *
 *   ONE offer, the one the SELLER set for that product, at the SERVER's
 *   price. Never a price the page knew — `postOrderOfferFor` reads the
 *   product's own offers and returns what is CHARGED, computed by the same
 *   `allocateDiscount` and the same rounding as the door's price.
 *
 *   «آه، زيدها لطلبي» adds to the SAME order, never a new one, and only
 *   while the order is still untouched: NEW, nobody has tried to reach the
 *   customer yet, inside the window, and once.
 *
 *   «لا شكرًا» or the window passing leaves the order exactly as it was —
 *   which is why refusing is a thing the SCREEN does and this module never
 *   hears about. There is nothing to undo, so there is no door to undo it.
 *
 *   Totals come from the existing order arithmetic.
 *
 * ── WHAT «ONE LINE ON THE SAME ORDER» IS, AND WHY IT IS AN `OrderAddOn` ──
 *
 * It would read more naturally as an `OrderItem`, and it must not be one.
 * An `OrderItem` written after the order exists moves things the first
 * order already settled:
 *
 *   `subtotal` — which is what `Order.sellingPrice` records and what a
 *   discount may not exceed.
 *
 *   the DISCOUNT ALLOCATION. `allocateDiscount` spreads the order's
 *   discount across its lines by value, so adding a line re-cuts every
 *   `OrderItem.discountShare` — and that share is the figure a partial
 *   return refunds against. The customer accepted an offer; the refund due
 *   on a line they bought an hour ago would change.
 *
 *   the PARTIAL-DELIVERY reconstruction, which rebuilds what is owed from
 *   `deliveredQty` per line and has no answer for a line whose delivered
 *   quantity nobody set.
 *
 * `OrderAddOn` is the row a post-order addition has written since the
 * thank-you page existed, and — this is the part that matters — it is
 * already honoured by every reader of an order's money: `computeCod`
 * carries it in `addOns`, and `codForOrder`, the waybill, the labels, the
 * shipment, the settlement and the partial-delivery rule all pass it
 * through. There is a measured history here: upsell money once reached the
 * total and NOT the courier's shipment («12 of 32 on every upsold order,
 * 37%»), and then reached the total and not the settlement. Both were
 * fixed by teaching those readers about `addOns`. Writing a second kind of
 * post-order addition would be that defect built a third time, by hand, in
 * a module whose comment promised otherwise.
 *
 * ── AND THE TOTAL MOVES BY THE ADD-ON'S VALUE, NOTHING ELSE ──
 *
 * `increment`, not a recompute. A recompute of the whole order from its
 * stored facts is the one thing this door must not do: it would rewrite
 * the FIRST order's arithmetic — the discount, the fee policy, the
 * rounding — from today's configuration, and the first order's arithmetic
 * is settled. The value being added is computed by `computeCod`, the one
 * COD authority, so the figure written here and the figure every later
 * recompute (`codForOrder({ addOns })`) contributes are the same number by
 * construction, not by two people writing the same multiplication.
 *
 * ── WHAT THIS DOOR DOES NOT TOUCH, SAID OUT LOUD ──
 *
 * `priceIncludesDelivery` stays as the order set it. A post-order offer
 * marked «شامل التوصيل» does not flip it, because flipping it would change
 * what the courier collects for goods the customer bought before the offer
 * existed. The fee is charged once for the whole order either way, so the
 * flag on this particular bundle simply has no effect — and the seller is
 * told so on the offers screen.
 *
 * `estimatedCostOfGoods` and stock are likewise untouched, exactly as the
 * recommendation-list add-on has always left them. That is a real gap in
 * the add-on path and it is older than this work, so it is logged in
 * `BACKLOG_P2.md` rather than fixed inside a brief about the thank-you
 * screen.
 * ═══════════════════════════════════════════════════════════════════════
 */

/** How long after ordering the offer may still be taken. */
export interface PostOrderOfferSettings {
  /**
   * The window, in minutes, measured from when the order was created.
   *
   * Fifteen by default, and the owner's number to change. It is deliberately
   * NOT the add-on token's thirty-minute TTL: the token answers «does this
   * visitor own this order», which is a security question with a security
   * answer, and this answers «is this still the same moment the customer was
   * ordering in», which is a business judgement about how long a seller is
   * willing to let an order grow before the confirmation team picks it up.
   * Two questions, two numbers, and the stricter one wins because both are
   * checked.
   */
  windowMinutes: number;
}

export const DEFAULT_POST_ORDER_OFFER: PostOrderOfferSettings = {
  windowMinutes: 15,
};

/** The settings key inside `Company.settings`. */
export const POST_ORDER_OFFER_KEY = 'postOrderOffer';

/**
 * A stored block as this build understands it.
 *
 * Clamped rather than refused, for the reason `parsePerformance` gives: these
 * arrive from a form, and a settings row that throws would take the whole
 * thank-you screen down with it. One minute is the floor — zero would mean
 * «the offer is never addable», which is a decision to make by not setting an
 * offer, not by setting a window of nothing. A day is the ceiling, because
 * past that the confirmation team has certainly already worked the order and
 * the gates below would refuse anyway.
 */
export function parsePostOrderOffer(raw: unknown): PostOrderOfferSettings {
  const o = (raw ?? {}) as Record<string, unknown>;
  const n = o.windowMinutes;
  const minutes =
    typeof n === 'number' && Number.isFinite(n)
      ? Math.round(Math.min(1440, Math.max(1, n)))
      : DEFAULT_POST_ORDER_OFFER.windowMinutes;
  return { windowMinutes: minutes };
}

export async function postOrderOfferSettings(companyId: string): Promise<PostOrderOfferSettings> {
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { settings: true },
  });
  try {
    const all = company?.settings ? JSON.parse(company.settings) : {};
    return parsePostOrderOffer(all[POST_ORDER_OFFER_KEY]);
  } catch {
    // A broken settings blob must not take the thank-you screen down.
    return { ...DEFAULT_POST_ORDER_OFFER };
  }
}

export async function savePostOrderOfferSettings(
  companyId: string,
  /** Raw from a form. `parsePostOrderOffer` narrows and clamps it. */
  input: unknown
): Promise<PostOrderOfferSettings> {
  const clean = parsePostOrderOffer(input);
  // Through `updateCompanySettings`, under the row lock, so a save here
  // cannot write back somebody else's key — see that function.
  await updateCompanySettings<PostOrderOfferSettings>(companyId, POST_ORDER_OFFER_KEY, () => clean);
  return clean;
}

/** The order's own facts, as the gates read them. */
export interface PostOrderGateFacts {
  status: string;
  confirmationStatus: string;
  createdAt: Date;
  /** Any `OrderContactAttempt` on this order — a call, an SMS, a WhatsApp. */
  contactAttempts: number;
  /** Add-ons on this order that already came from a post-order offer. */
  postOrderAddOns: number;
}

export type PostOrderGate = { allowed: true } | { allowed: false; reason: PostOrderRefusal };

/**
 * MAY THIS ORDER STILL GROW BY ITSELF? — and it is a pure function.
 *
 * Pure because this is the rule the whole feature is, and a rule that can
 * only be exercised by creating an order, a contact attempt and a clock is
 * a rule nobody tests at its edges. Every fact it needs is handed to it.
 *
 * ── THE FOUR GATES, AND WHY EACH ONE IS A GATE ──
 *
 * STILL NEW. `status` and `confirmationStatus` both, not either: the
 * confirmation stage moves one and the operations stage moves the other,
 * and an order already in a shipment must not gain goods the courier was
 * never told about. This is the same «after confirmation the order is
 * read-only» rule the change-request flow exists for — a customer on a web
 * page is not a bigger exception to it than an agent on the phone.
 *
 * NOBODY HAS CALLED YET. Any `OrderContactAttempt` closes the door, and
 * `confirmation-queue.ts` already defines what counts: a call answered, a
 * call not answered, an SMS, a WhatsApp message. Once a person has spoken
 * about this order, the order grows through that person — otherwise the
 * agent reads a total on their screen that the customer changed while they
 * were dialling.
 *
 * INSIDE THE WINDOW, measured from `createdAt`, because the thing being
 * bounded is «the customer is still in the moment of ordering». Measuring
 * from now-minus-anything-else would let an order sat in a queue for a day
 * reopen the moment somebody looked at it.
 *
 * ONCE. The brief says once, and `OrderAddOn.offerId` is what makes it a
 * fact on the row: a second press, a replayed request, two tabs — all of
 * them read the same count and all of them are refused.
 *
 * ── THE ORDER OF THE CHECKS IS THE ORDER OF THE SENTENCES ──
 *
 * `ALREADY_ADDED` is tested first on purpose. A customer who pressed the
 * button twice should be told their offer is already on the order, not
 * that the window has passed — the second sentence is true and useless.
 */
export function postOrderGate(
  facts: PostOrderGateFacts,
  windowMinutes: number,
  now: Date
): PostOrderGate {
  if (facts.postOrderAddOns > 0) return { allowed: false, reason: 'ALREADY_ADDED' };
  if (facts.status !== 'NEW' || facts.confirmationStatus !== 'NEW') {
    return { allowed: false, reason: 'NOT_NEW' };
  }
  if (facts.contactAttempts > 0) return { allowed: false, reason: 'CONTACTED' };
  const elapsedMs = now.getTime() - facts.createdAt.getTime();
  // `>` and not `>=`: the boundary minute belongs to the customer. A window
  // of 15 means fifteen minutes are available, and a request that lands on
  // the exact millisecond is inside them.
  if (elapsedMs > windowMinutes * 60_000) {
    return { allowed: false, reason: 'WINDOW_PASSED' };
  }
  // A clock that has gone backwards — a reissued token, a machine whose time
  // was corrected — is inside the window, not outside it. Refusing a
  // negative elapsed time would punish the customer for our clock.
  return { allowed: true };
}

/**
 * WHAT ONE ADD-ON IS WORTH, through the one COD authority.
 *
 * `computeCod` with no lines and this one add-on: `addOns` is then exactly
 * `roundMinor(quantity * unitPrice, minorUnit)` — computed by the function
 * that will compute it again on every later recompute of this order, with
 * the same rounding, in the order's own currency. A `.toFixed(2)` here is
 * the defect that cost a fils on every JOD add-on, and a hand-written
 * multiplication is the same defect waiting for the next currency.
 */
export function addOnValue(quantity: number, unitPrice: number, minorUnit: number): number {
  return computeCod({ lines: [], addOns: [{ quantity, unitPrice }], minorUnit }).addOns;
}

/**
 * THE BUNDLE AS AN ADD-ON ROW: pieces, a unit price, a total.
 *
 * An offer's `price` is the total for its own `quantity` — «قطعتان بـ 25» is
 * one row of two pieces, not two rows — so the division to a unit price
 * happens here, once, exactly as `resolvePublicLines` does it at the door.
 * The total is NOT `offer.price`: it is the add-on arithmetic over the
 * pieces and the unit price, so the row's three columns agree with each
 * other and with every reader that recomputes from `quantity * price`.
 */
export function addOnFromOffer(offer: OfferView, minorUnit: number) {
  const quantity = Math.max(1, offer.quantity);
  const unitPrice = offer.price / quantity;
  return { quantity, unitPrice, total: addOnValue(quantity, unitPrice, minorUnit) };
}

export type PostOrderAddResult =
  | {
      ok: true;
      orderNumber: string;
      addOn: { id: string; productName: string; quantity: number; price: number; total: number };
      newTotal: number;
      currency: string;
    }
  | { ok: false; reason: PostOrderRefusal; message: string };

/**
 * ADD THE POST-ORDER OFFER TO THIS ORDER — the audited server action.
 *
 * The caller has already proved the visitor owns this order (the signed
 * add-on token). Everything else is decided here: which product, which
 * offer, what it costs, whether the order may still grow. The route passes
 * an id and a token and nothing else, so there is no figure on the wire for
 * a browser to choose.
 */
export async function addPostOrderOffer(params: {
  orderId: string;
  orderNumber: string;
  offerId: string;
  now?: Date;
}): Promise<PostOrderAddResult> {
  const now = params.now ?? new Date();
  const refuse = (reason: PostOrderRefusal): PostOrderAddResult => ({
    ok: false,
    reason,
    message: POST_ORDER_REFUSAL_AR[reason],
  });

  const order = await db.order.findFirst({
    where: { id: params.orderId, orderNumber: params.orderNumber },
    select: {
      id: true,
      orderNumber: true,
      companyId: true,
      status: true,
      confirmationStatus: true,
      createdAt: true,
      currency: true,
      landingPageId: true,
      productId: true,
      items: { select: { productId: true } },
      store: { select: { country: { select: { minorUnit: true } } } },
      _count: { select: { contactAttempts: true } },
    },
  });
  // A token that verifies against an order that is not there is not a
  // refusal with a sentence — it is the same «غير مسموح» the route gives a
  // mismatched token, so nothing here tells a prober what exists.
  if (!order) return refuse('OFFER_GONE');

  const postOrderAddOns = await db.orderAddOn.count({
    where: { orderId: order.id, offerId: { not: null } },
  });

  const { windowMinutes } = await postOrderOfferSettings(order.companyId);
  const gate = postOrderGate(
    {
      status: order.status,
      confirmationStatus: order.confirmationStatus,
      createdAt: order.createdAt,
      contactAttempts: order._count.contactAttempts,
      postOrderAddOns,
    },
    windowMinutes,
    now
  );
  if (!gate.allowed) return refuse(gate.reason);

  /*
   * THE OFFER HAS TO BE ON A PRODUCT THIS ORDER ACTUALLY CONTAINS.
   *
   * The token proves which order; it says nothing about which offer, and an
   * offer id is guessable in the way any id is. Without this check a visitor
   * could name the post-order offer of a product in the same shop that they
   * never ordered — the price would still be the server's, and the order
   * would still grow by goods nobody offered this customer.
   *
   * `Order.productId` is the head line and `items` is everything, so both
   * are consulted: a basket's second product is as much «in the order» as
   * its largest one.
   */
  const inOrder = new Set<string>([order.productId, ...order.items.map((i) => i.productId)]);

  const minorUnit = order.store?.country?.minorUnit ?? 2;
  const offerRow = await db.offer.findFirst({
    where: { id: params.offerId, companyId: order.companyId },
    select: { id: true, productId: true, product: { select: { id: true, name: true, status: true } } },
  });
  if (!offerRow || !offerRow.product) return refuse('OFFER_GONE');
  if (!inOrder.has(offerRow.productId)) return refuse('NOT_IN_ORDER');
  if (offerRow.product.status !== 'ACTIVE') return refuse('OFFER_GONE');

  /*
   * AND IT IS RE-READ THROUGH THE PREDICATE, not trusted from the row above.
   *
   * `postOrderOfferFor` is what the thank-you screen was given its price
   * by, and asking it again is what makes the price charged the price
   * shown: it applies `postOrderOfferWhere` (so an offer switched off,
   * finished, or no longer flagged as the post-order offer is simply not
   * returned) and it runs the same `toOfferView`. Reading `sellingPrice`
   * off the row and subtracting the discount by hand would be a second
   * pricing path, and this file's own history is a list of those.
   */
  const offer = await postOrderOfferFor(db, order.companyId, offerRow.productId, minorUnit, now);
  if (!offer || offer.id !== offerRow.id) return refuse('OFFER_GONE');

  const { quantity, unitPrice, total } = addOnFromOffer(offer, minorUnit);

  const written = await db.$transaction(async (tx) => {
    /*
     * THE ORDER'S ROW IS LOCKED FIRST — two presses at the same moment add once.
     *
     * Both read the order and the count above, both passed, and both wrote: the total grew by the bundle twice (20
     * became 50 with the offer at 15). An UPDATE holds the row until the transaction ends, so the second press waits
     * here and then reads the order AS IT IS NOW — the add-on the first one wrote, and any confirmation or call that
     * landed meanwhile. `version` moves with the lock, so a staff member saving from a copy older than this add-on
     * is told the order changed instead of overwriting it.
     */
    await tx.order.update({ where: { id: order.id }, data: { version: { increment: 1 } }, select: { id: true } });

    /*
     * «مرة وحدة» UNDER THE TRANSACTION TOO.
     *
     * The count above is read before the gates and is what produces the
     * honest Arabic sentence. This one is the race: two presses landing
     * together both pass that read, and only one may write. It costs one
     * query on the one path that writes.
     */
    const already = await tx.orderAddOn.count({
      where: { orderId: order.id, offerId: { not: null } },
    });
    if (already > 0) return null;

    // And the gates again, on the row as the lock now shows it: the first read is the honest sentence, this is the race.
    const latest = await tx.order.findFirst({
      where: { id: order.id },
      select: { status: true, confirmationStatus: true, createdAt: true, _count: { select: { contactAttempts: true } } },
    });
    if (latest) {
      const again = postOrderGate(
        {
          status: latest.status,
          confirmationStatus: latest.confirmationStatus,
          createdAt: latest.createdAt,
          contactAttempts: latest._count.contactAttempts,
          postOrderAddOns: 0,
        },
        windowMinutes,
        now
      );
      if (!again.allowed) return { kind: 'gate' as const, reason: again.reason };
    }

    const addOn = await tx.orderAddOn.create({
      data: {
        companyId: order.companyId,
        orderId: order.id,
        productId: offerRow.product!.id,
        landingPageId: order.landingPageId,
        // A snapshot: the name as it was sold, so renaming the product
        // later never rewrites what this order says was bought.
        productName: offerRow.product!.name,
        quantity,
        price: unitPrice,
        total,
        offerId: offer.id,
      },
    });

    // The total moves by the add-on's value and by nothing else — see the
    // header. `increment` is the whole of the money change on this door.
    const updated = await tx.order.update({
      where: { id: order.id },
      data: { totalAmount: { increment: total } },
      select: { orderNumber: true, totalAmount: true, currency: true },
    });

    // The landing page's own counters, when the order came through one. A
    // storefront order has no page to credit, and crediting none is right.
    if (order.landingPageId) {
      await tx.landingPage.update({
        where: { id: order.landingPageId },
        data: { upsellAddsCount: { increment: 1 }, upsellRevenue: { increment: total } },
      });
    }

    /*
     * AND THE CONFIRMATION TEAM SEES «زيادة بعد الطلب».
     *
     * `UPSELL_ADDED` is the action the recommendation-list add-on has
     * always written, and the order's timeline is where an agent picking
     * the order up reads what happened to it. The metadata names the OFFER
     * as well as the product, because «زاد علبة» and «زاد علبة بعرض 15 بدل
     * 25» are different facts to somebody on the phone.
     *
     * `userId: null` — an anonymous visitor did this. That is also what
     * keeps it off an agent's cross-sell commission: `crossSellUnits`
     * counts `orderItem` rows added by a named user, and this is neither.
     */
    await tx.orderActivity.create({
      data: {
        companyId: order.companyId,
        orderId: order.id,
        userId: null,
        action: 'UPSELL_ADDED',
        newStatus: null,
        metadata: JSON.stringify({
          source: 'post-order offer',
          label: POST_ORDER_ADDITION_AR,
          addOnId: addOn.id,
          offerId: offer.id,
          offerName: offer.name,
          product: offerRow.product!.name,
          quantity,
          price: unitPrice,
          total,
          windowMinutes,
        }),
      },
    });

    return { kind: 'added' as const, addOn, updated };
  });

  if (!written) return refuse('ALREADY_ADDED');
  if (written.kind === 'gate') return refuse(written.reason);

  return {
    ok: true,
    orderNumber: written.updated.orderNumber,
    addOn: {
      id: written.addOn.id,
      productName: written.addOn.productName,
      quantity: written.addOn.quantity,
      price: Number(written.addOn.price),
      total: Number(written.addOn.total),
    },
    newTotal: Number(written.updated.totalAmount),
    currency: written.updated.currency,
  };
}

/**
 * «بقلي انو الخدمة غير مفعلة لما اجي اعملها من صفحة الهبوط» — WHAT THIS PAGE'S THANK-YOU SCREEN WILL OFFER.
 *
 * The question the landing editor's «بعد الطلب» panel asks, answered for ONE page the way an order through that page
 * is answered: the page's own product, the page's own store's currency, and `postOrderOfferStateFor` — whose offer
 * is `postOrderOfferFor`'s, the function `createPublicOrder` hands the thank-you screen its offer from.
 *
 * The page is read exactly as `GET /api/landing-pages/[id]` reads it — its id, the company and the selected store —
 * so a page of another store or another company is not found here either, and none of its offers is read.
 *
 * `null` is «no such page», which the route answers with a 404. A page with no product is an answer and not a 404:
 * the editor opens it, and the sentence says the offer hangs off the page's product.
 */
export interface AfterOrderOfPage extends Omit<PostOrderOfferState, 'why'> {
  productId: string | null;
  productName: string | null;
  why: 'NO_PRODUCT' | PostOrderOfferOff | null;
  /** The decimals of the page's store — what every figure in `offer` was rounded by, so the panel prints them so. */
  minorUnit: number;
}

export async function afterOrderOfPage(
  page: { id: string; companyId: string; storeId: string },
  now: Date = new Date()
): Promise<AfterOrderOfPage | null> {
  const lp = await db.landingPage.findFirst({
    where: { id: page.id, companyId: page.companyId, storeId: page.storeId },
    select: {
      product: { select: { id: true, name: true } },
      store: { select: { country: { select: { minorUnit: true } } } },
    },
  });
  if (!lp?.store) return null;

  const minorUnit = lp.store.country.minorUnit;
  if (!lp.product) {
    return { productId: null, productName: null, offer: null, why: 'NO_PRODUCT', flagged: null, flaggedCount: 0, minorUnit };
  }
  const state = await postOrderOfferStateFor(db, page.companyId, lp.product.id, minorUnit, now);
  return { productId: lp.product.id, productName: lp.product.name, ...state, minorUnit };
}
