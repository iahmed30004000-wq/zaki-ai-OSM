import { z } from 'zod';
import { count, money } from './numeric-input';
import { omittedMeansOmitted } from './zod-patch';
import { evidencedWasPrices, struckThroughPrice } from './price-honesty';
// `money.ts` imports nothing from here, so the one money rule stays a leaf.
import { allocateDiscount, roundMinor } from './money';
import { offerAboveBase, paidPieces } from './offer-ceiling';
import type { Prisma } from '@prisma/client';
import type { db } from './db';

/**
 * OFFERS — a product's bundles, and the one place their prices live.
 *
 * A landing page used to carry its own copy of the same three tiers. Two
 * copies of a price is one price too many: raising it in the catalogue left
 * the page selling at the old one, and nothing in the system noticed. So the
 * product owns its offers and every surface reads them from the product.
 *
 * What an offer says:
 *   quantity + freeQuantity — what the customer receives
 *   sellingPrice           — what they pay for the whole bundle
 *   compareAtPrice         — the CEILING on a struck-through "was". Display
 *                            only, and shown only as far as real delivered
 *                            orders support it — see price-honesty.ts
 *   endsAt                 — when this bundle stops being for sale
 *   discount               — a real reduction, the only one computeCod sees, and an
 *                            ABSOLUTE amount of money. It must stay below the
 *                            selling price it reduces — see the rule under the schema
 *   deliveryIncluded       — whether the price already carries the fee
 *
 * The separation between compareAtPrice and discount is deliberate. One is a
 * marketing number and must never touch the money; the other is money. Mixing
 * them would let a display decision change what a customer is charged.
 */

const offerFields = z.object({
  name: z.string().min(1, 'اسم العرض مطلوب').max(120),
  quantity: count(999, 1).default(1),
  freeQuantity: count(999).default(0),
  sellingPrice: money(1_000_000),
  compareAtPrice: money(1_000_000).nullable().optional(),
  /**
   * When this bundle stops. Null means it does not.
   *
   * A countdown must be bound to a real ending, and the only way to keep
   * those two honest is to make them ONE FACT: the clock the customer sees
   * and the moment the price stops applying read this same column. A
   * countdown with a timer of its own is a countdown that reaches zero
   * while the offer carries on, which teaches the customer the number is
   * decoration.
   */
  endsAt: z.coerce.date().nullable().optional(),
  discount: money(1_000_000).default(0),
  deliveryIncluded: z.coerce.boolean().default(true),
  /**
   * «العرض بعد الطلب» — shown on the thank-you screen, and nowhere else.
   *
   * The seller sets it HERE, among the product's bundles, because a price
   * belongs to the product and this file is the one place a bundle's price
   * is allowed to live. Marking a bundle as the post-order offer withholds
   * it from every door — see `liveOfferWhere` — so the cheap «زيد علبة
   * كمان؟ 15 بدل 25» cannot be picked as the FIRST order's price.
   */
  postOrderOffer: z.coerce.boolean().default(false),
  isDefault: z.coerce.boolean().default(false),
  sortOrder: count(9999).default(0),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});

/**
 * A DISCOUNT THAT SWALLOWS ITS OWN PRICE IS A TYPO, AND EVERY DOOR GUESSED.
 *
 * `discount` is an absolute amount of money, and it used to be bounded only
 * by a million — never by the price it reduces. So `sellingPrice: 25,
 * discount: 30` was accepted and stored, and the doors then disagreed about
 * what that bundle costs:
 *
 *   landing-page order (createPublicOrder)    0   allocateDiscount clamps to the subtotal
 *   cart quote                                0   the same clamp
 *   AI intake’s suggestion                    0   the same clamp
 *   AI intake’s WRITE                        99   `p.finalPrice || product.basePrice`
 *                                                 read that clamped 0 as «absent»
 *                                                 and charged the base price
 *
 * One slip of the keyboard: three doors give the bundle away and a fourth
 * charges full base price. There is no reading that makes them agree,
 * because nobody designs a free bundle by writing a discount larger than
 * the price — they write `sellingPrice: 0`. So the row is refused where it
 * enters instead of being reinterpreted four times downstream.
 *
 * AND THE FOURTH DOOR HAS SINCE BEEN BROUGHT INTO LINE. The refusal below
 * closed the route to that particular 0, but not the legitimate one: a
 * bundle priced at 0 outright still reached `p.finalPrice || basePrice`
 * and was charged 99. That `||` is gone — the write stores what the
 * reviewer confirmed, zero included — so all four now agree, and `absent`
 * is refused by name rather than guessed at, because `finalPrice` is a
 * required field. Pinned in `ai-intake-discount.test.ts`.
 *
 * ONLY A POSITIVE DISCOUNT IS MEASURED. `discount: 0` means «no reduction
 * at all» and stays legal at any price, a price of 0 included: a free
 * bundle is a pricing decision, and refusing it here would be this rule
 * quietly making a different one than the one it was asked to make.
 */
function discountBelowPrice(sellingPrice: number, discount: number, ctx: z.RefinementCtx) {
  if (discount > 0 && discount >= sellingPrice) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        `الخصم (${discount}) يساوي سعر العرض (${sellingPrice}) أو يزيد عليه — ` +
        `اكتب خصماً أقلّ من ${sellingPrice}`,
      path: ['discount'],
    });
  }
}

/**
 * A GIFT UNIT THE ORDER HAS NOWHERE TO WRITE DOWN IS A BROKEN PROMISE.
 *
 * The post-order offer is taken on the thank-you screen and recorded as an
 * `OrderAddOn` — see `post-order-offer.ts` for why that row and not an
 * `OrderItem`. That row has `quantity`, `price` and `total`, and it has NO
 * `freeQuantity` column: gift units are a concept of the order's own lines,
 * where they are real stock at zero price and feed COGS.
 *
 * So «ثلاث قطع + واحدة هدية» as a post-order offer would be advertised to
 * the customer, accepted, charged correctly — and the free piece would exist
 * nowhere. Nobody would pick it, nobody would ship it, and the customer
 * would be short one piece of what they were promised.
 *
 * Refused where it ENTERS rather than silently dropped at the door, which is
 * the same decision `discountBelowPrice` above makes and for the same
 * reason: four downstream readers reinterpreting an impossible row is worse
 * than one clear sentence to the seller who typed it. Any bundle may carry
 * gift units; a bundle marked as the offer after the order may not.
 */
function noGiftsAfterTheOrder(
  postOrderOffer: boolean,
  freeQuantity: number,
  ctx: z.RefinementCtx
) {
  if (postOrderOffer && freeQuantity > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'العرض بعد الطلب لا يقبل كمية مجانية — الزيادة بعد الطلب تُسجَّل كسطر ' +
        'بسعرٍ وكمية، وما إلها مكان تكتب فيه الهدية. اكتب الهدية داخل الكمية ' +
        'والسعر، أو شيل علامة «العرض بعد الطلب».',
      path: ['freeQuantity'],
    });
  }
}

export const offerInputSchema = offerFields.superRefine((o, ctx) => {
  discountBelowPrice(o.sellingPrice, o.discount, ctx);
  noGiftsAfterTheOrder(o.postOrderOffer, o.freeQuantity, ctx);
});

/**
 * AN EDIT THAT DID NOT MENTION A FIELD USED TO OVERWRITE IT ANYWAY.
 *
 * `.partial()` makes a field optional. It does NOT remove the field's
 * `.default()` — so in zod 4 every defaulted field came back PRESENT,
 * carrying its default instead of the stored value. MEASURED on an offer
 * stored as `quantity: 2, discount: 3, isDefault: true, sortOrder: 5`:
 *
 *     offerFields.partial().safeParse({ sortOrder: 1 })
 *       → { sortOrder: 1, quantity: 1, freeQuantity: 0, discount: 0,
 *           deliveryIncluded: true, isDefault: false, status: 'ACTIVE' }
 *
 * `PATCH /api/offers/[id]` writes `input.x !== undefined ? { x } : {}`, and
 * every one of those defaults is `!== undefined`. So dragging a bundle up
 * the list — `PATCH { sortOrder: 1 }`, the one edit the offers screen sends
 * alone — turned «قطعتان بحسم ٣» into one piece at no discount, no longer
 * the default, forced back to ACTIVE. No error, and nothing in the request
 * asked for any of it.
 *
 * THE DEFAULTS ARE REMOVED HERE RATHER THAN THE MERGE PATCHED THERE. A
 * route that compares against `undefined` is correct the moment «omitted»
 * actually arrives omitted, and this schema is the one place every door
 * reads — the edit route today and any caller written later. Patching the
 * route would hand the next reader of `offerPatchSchema` the same loaded
 * gun.
 *
 * AND IT IS DONE OVER THE SHAPE, NOT FIELD BY FIELD. A field added to
 * `offerFields` tomorrow with a `.default()` is stripped without anybody
 * remembering to strip it, which is the only version of this fix that
 * cannot rot. `offers.test.ts` walks every field of the patch schema and
 * refuses any that invents a value out of `undefined`, so a zod wrapper
 * this helper does not know about fails the suite instead of shipping.
 *
 * The create door keeps every default, which is right there: `POST` is the
 * row being written whole, and an unstated quantity really is 1.
 *
 * THE HELPER ITSELF NOW LIVES IN `zod-patch.ts`, NOT HERE. Three more doors
 * were found carrying the same defect — a campaign's spend, a store page's
 * text, a redirect's 301 — and this file is the wrong home for the answer
 * to all four: it is a domain module that knows about Prisma, while
 * `store-pages.ts` must stay client-safe. One implementation, no domain
 * attached, beside `zod-message.ts`.
 */

/** Every offer field, optional, and silent when the caller was silent. */
const offerPatchFields = z.object(omittedMeansOmitted(offerFields.shape));

/**
 * THE SAME DISCOUNT RULE FOR AN EDIT, MEASURED AGAINST THE ROW BEING EDITED.
 *
 * A PATCH may carry the discount on its own, and `{ discount: 30 }` says
 * nothing about the price it has to stay under — so the stored row supplies
 * whatever the request leaves out and the rule reads the values the offer
 * WILL have once the update lands. Checking only the fields that were sent
 * would shut the create door and leave the edit door open, which is exactly
 * how a rule becomes decoration.
 *
 * BOTH FALLBACKS ARE LIVE NOW, which they were not before the defaults were
 * stripped: an omitted `discount` used to arrive as 0 and the route wrote
 * that 0, so `{ sellingPrice: 2 }` against a stored discount of 3 parsed
 * clean and landed a row with no reduction at all. It is refused now,
 * because the row it would leave is 2 with a discount of 3.
 *
 * A function rather than a schema for two reasons: the stored row is not
 * known until the route has read it, and zod refuses to `.partial()` an
 * object that already carries a refinement — it throws rather than silently
 * dropping the rule, so `offerInputSchema.partial()` is not an option.
 */
export function offerPatchSchema(existing: {
  sellingPrice: number;
  discount: number;
  /**
   * The two fields the gift rule reads, supplied by the stored row for the
   * same reason the discount's price is: `{ postOrderOffer: true }` alone
   * says nothing about the gift units the offer already carries, and a rule
   * that only looked at what was sent would shut the create door and leave
   * this one open.
   */
  postOrderOffer?: boolean;
  freeQuantity?: number;
}) {
  return offerPatchFields.superRefine((o, ctx) => {
    discountBelowPrice(
      o.sellingPrice ?? existing.sellingPrice,
      o.discount ?? existing.discount,
      ctx
    );
    noGiftsAfterTheOrder(
      o.postOrderOffer ?? existing.postOrderOffer ?? false,
      o.freeQuantity ?? existing.freeQuantity ?? 0,
      ctx
    );
  });
}

export type OfferInput = z.infer<typeof offerInputSchema>;

type Tx = Prisma.TransactionClient | typeof db;

/* ─────────────── «العرض ما بصير يكون اكثر من السعر الاساسي» ─────────────── */

/**
 * THE CEILING'S REFUSAL, WRITTEN ONCE FOR EVERY DOOR THAT WRITES AN OFFER'S PRICE.
 *
 * The arithmetic is `offer-ceiling.ts`, which the offers screen draws its hint with. What lives here is what a door
 * ANSWERS: one sentence naming the price, the line and the figure to type instead; a code a caller can recognise it
 * by; and the line itself as `maxPrice`.
 *
 * NOT A ZOD ISSUE, deliberately. `offerInputSchema` and `offerPatchSchema` are read directly by `offers.test.ts` and
 * `the-offer-after-the-order.test.ts` and know nothing about the product, so they stay exactly as they are; and a
 * refusal filed under the path `sellingPrice` would
 * reach the screen as «سعر البيع: …» — `zod-message.ts` puts the box's label in front — which is a sentence about a
 * box, not about the rule.
 */
export const OFFER_ABOVE_BASE = 'OFFER_ABOVE_BASE';

export interface OfferAboveBaseRefusal {
  error: string;
  code: typeof OFFER_ABOVE_BASE;
  /** The line, rounded by the store's currency: the most this bundle may cost. */
  maxPrice: number;
}

/** «(3 × 25 = 75)» — the line, written the way a person checks it. */
const lineOf = (pieces: number, basePrice: number, maxPrice: number) => `(${pieces} × ${basePrice} = ${maxPrice})`;

export function offerAboveBaseRefusal(
  offer: { sellingPrice: number; quantity: number },
  basePrice: number,
  minorUnit: number
): OfferAboveBaseRefusal | null {
  const maxPrice = offerAboveBase(offer, basePrice, minorUnit);
  if (maxPrice === null) return null;
  return {
    error:
      `سعر العرض (${roundMinor(offer.sellingPrice, minorUnit)}) أعلى من السعر الأساسي لنفس عدد القطع ` +
      `${lineOf(paidPieces(offer.quantity), basePrice, maxPrice)} — اكتب ${maxPrice} أو أقلّ. القطع المجانية ما بتنحسب.`,
    code: OFFER_ABOVE_BASE,
    maxPrice,
  };
}

/**
 * THE SAME LINE ON AN EDIT — MEASURED FOR WHAT THE EDIT DOES, NOT FOR WHAT THE ROW ALREADY WAS.
 *
 * Offers stored above the line before the rule existed stay on sale, unchanged, and the screen flags them. So an
 * edit is refused only when IT moves the offer against the line:
 *
 *   · the price or the quantity really changes — compared rounded, against the stored row — and the row the edit
 *     will leave is above the line. `{ quantity: 1 }` alone on «3 بـ60» is 60 for ONE piece, so the stored row fills
 *     in what the edit leaves out, exactly as `offerPatchSchema` does for the discount;
 *   · a stopped offer is switched back ON while it is above the line — that is putting it back on sale.
 *
 * Everything else passes: the order, the star, the name, the ending, the «was» price, and switching it OFF. The
 * «تعديل» form sends the price and the quantity on EVERY save, so a rule keyed on their presence would refuse
 * renaming an old offer, or changing its ending, until somebody repriced it; and a drag sends one PATCH per moved
 * row with nothing holding them together, so one refusal there would leave the list half reordered.
 */
export function offerEditAboveBaseRefusal(
  stored: { sellingPrice: number; quantity: number; status: string },
  edit: { sellingPrice?: number; quantity?: number; status?: string },
  basePrice: number,
  minorUnit: number
): OfferAboveBaseRefusal | null {
  const repriced =
    edit.sellingPrice !== undefined &&
    roundMinor(edit.sellingPrice, minorUnit) !== roundMinor(stored.sellingPrice, minorUnit);
  const resized = edit.quantity !== undefined && edit.quantity !== stored.quantity;
  const backOnSale = edit.status === 'ACTIVE' && stored.status !== 'ACTIVE';
  if (!repriced && !resized && !backOnSale) return null;

  const after = {
    sellingPrice: edit.sellingPrice ?? stored.sellingPrice,
    quantity: edit.quantity ?? stored.quantity,
  };
  const refusal = offerAboveBaseRefusal(after, basePrice, minorUnit);
  if (!refusal || repriced || resized) return refusal;
  // Only switched back on: the seller pressed the eye, not the price box, so the sentence says what the eye did.
  return {
    ...refusal,
    error:
      `ما بيرجع هالعرض للبيع وسعره (${roundMinor(after.sellingPrice, minorUnit)}) أعلى من السعر الأساسي لنفس عدد القطع ` +
      `${lineOf(paidPieces(after.quantity), basePrice, refusal.maxPrice)} — عدّل سعره لـ ${refusal.maxPrice} أو أقلّ أوّلاً، وبعدين شغّله.`,
  };
}

/**
 * THE OTHER WAY INTO THE SAME LINE — A BASE PRICE THAT COMES DOWN UNDER A LIVE OFFER.
 *
 * The line IS the base price, so lowering the base price lowers every offer's line at once, and a rule held only at
 * the offer doors would be undone from the product page by typing one number. So the product door asks here before
 * it writes, and the sentence names each offer it would leave above the line: the offer, its price, the new line.
 *
 *   · only when the line comes DOWN — a first base price, or a lower one. A raise lifts every line, so it cannot put
 *     an offer above one; an old offer still above after a raise was above before it, and is already flagged.
 *   · every ACTIVE offer of the product, ended or not, the one after the order included. A stopped offer is not on
 *     sale and is measured when it is switched back on; an ended one returns the moment its ending is moved, which
 *     the offer door lets through.
 *   · a base price of 0 is «not priced yet» and draws no line at all.
 *
 * The query lives here and not in the route: `one-calculator.test.ts` sweeps the tree for a second `offer.findMany`
 * by product and ACTIVE status, and is right to. This one asks a different question from `activeOffersFor`, and
 * keeping the two side by side is how they stay apart.
 */
export async function baseBelowActiveOffersRefusal(
  tx: Tx,
  product: { id: string; companyId: string; basePrice: number },
  nextBasePrice: number,
  minorUnit: number
): Promise<string | null> {
  const lineComesDown = nextBasePrice > 0 && (!(product.basePrice > 0) || nextBasePrice < product.basePrice);
  if (!lineComesDown) return null;

  const live = await tx.offer.findMany({
    where: { companyId: product.companyId, productId: product.id, status: 'ACTIVE' },
    orderBy: [{ sortOrder: 'asc' }, { quantity: 'asc' }],
    select: { name: true, quantity: true, sellingPrice: true },
  });
  const above = live.flatMap((o) => {
    const maxPrice = offerAboveBase(o, nextBasePrice, minorUnit);
    if (maxPrice === null) return [];
    const line = lineOf(paidPieces(o.quantity), nextBasePrice, maxPrice);
    return [`عرض «${o.name}» سعره ${roundMinor(o.sellingPrice, minorUnit)} والحدّ الجديد ${line}`];
  });
  if (above.length === 0) return null;
  return (
    `ما بينفع يصير السعر الأساسي ${nextBasePrice}: ${above.join('، و')}. ` +
    (above.length === 1 ? 'عدّل سعر العرض أو أوقفه أوّلاً.' : 'عدّل أسعار هالعروض أو أوقفها أوّلاً.')
  );
}

/**
 * Exactly one default per product.
 *
 * Two defaults is not a cosmetic problem: the landing page preselects one and
 * the quick-order screen preselects the other, so the same customer is quoted
 * two prices depending on which door they came through.
 */
export async function clearOtherDefaults(
  tx: Tx,
  offer: { id: string; productId: string; companyId: string; isDefault: boolean }
) {
  if (!offer.isDefault) return;
  await tx.offer.updateMany({
    where: {
      companyId: offer.companyId,
      productId: offer.productId,
      id: { not: offer.id },
      isDefault: true,
    },
    data: { isDefault: false },
  });
}

/**
 * WHAT «ON SALE AT THE DOOR RIGHT NOW» MEANS, in one place.
 *
 * Three queries used to spell `status: 'ACTIVE'` themselves — this one and
 * the two in storefront.ts. Adding an ending would have been three edits,
 * and the one that was forgotten would have gone on selling an offer that
 * had finished. A predicate instead, so there is one answer.
 *
 * ── AND THE POST-ORDER OFFER IS NOT ONE OF THEM ──
 *
 * `postOrderOffer: false` is part of the predicate rather than bolted onto
 * its three callers, and the direction of that default is the whole
 * argument. Every one of those callers is a DOOR — the storefront grid's
 * from-price, the product page's picker, and `activeOffersFor`, which is
 * what `resolvePublicLines` prices an order from. A bundle the seller
 * priced for «زيد علبة كمان؟ 15 بدل 25» reaching any of them is not a
 * cosmetic slip: the visitor picks 15 before ordering anything, and the
 * after-order price has become a price cut on the whole catalogue.
 *
 * So the safe answer is the one a forgetful future caller gets for free,
 * and the single place that wants the other answer has to ask for it by
 * name — `postOrderOfferWhere` below.
 *
 * NOTHING STORED TODAY MOVES. The column is new and false on every existing
 * row, so this predicate returns exactly what it returned before for every
 * offer in the database.
 */
export function liveOfferWhere(now: Date) {
  return {
    status: 'ACTIVE',
    postOrderOffer: false,
    OR: [{ endsAt: null }, { endsAt: { gt: now } }],
  };
}

/**
 * WHEN THESE OFFERS STOP — the `endsAt` column and nothing else.
 *
 * Owner decision D8's countdown reads ONE FACT, and `endsAt` is it: the
 * moment the server stops charging the offer's price. So the clock asks
 * this, and asking it HERE is the point — `one-calculator.test.ts` sweeps
 * the repository for a second `offer.findMany` filtered by product and
 * ACTIVE status, and it is right to: a reader with its own query is a
 * reader free to disagree about which bundles count.
 *
 * It is deliberately NOT `activeOffersFor`. That one withholds a finished
 * bundle, because a price that is not for sale must not be reachable — and
 * a countdown needs the finished ones in hand to answer «has this ended».
 * So this returns the dates, nulls and past ones included, and
 * `countdownEnd` picks the soonest one still ahead.
 *
 * `scope` is the product or the whole store: a landing page sells one
 * article, a shop's home page sells the shelf.
 *
 * AND IT SKIPS THE AFTER-ORDER BUNDLE, for the same reason
 * `liveOfferWhere` does: that one is not pickable at the door, so its
 * ending is not a deadline anybody standing at the door is under. A clock
 * counting down to it would be counting down to an offer the visitor
 * cannot take — which is the exact dishonesty this countdown exists to
 * remove.
 */
export async function offerEndings(
  tx: Tx,
  companyId: string,
  scope: { productId: string } | { storeId: string }
): Promise<(Date | null)[]> {
  const rows = await tx.offer.findMany({
    where: {
      companyId,
      status: 'ACTIVE',
      postOrderOffer: false,
      ...('productId' in scope ? { productId: scope.productId } : { product: { storeId: scope.storeId } }),
    },
    select: { endsAt: true },
  });
  return rows.map((o) => o.endsAt);
}

/**
 * The complement: live, and shown ONLY after an order exists.
 *
 * Written as the exact mirror of `liveOfferWhere` so the two can never
 * drift into overlapping — an offer that is both pickable at the door and
 * offered after the order would let the same customer buy the same bundle
 * at the after-order price twice over.
 */
export function postOrderOfferWhere(now: Date) {
  return {
    status: 'ACTIVE',
    postOrderOffer: true,
    OR: [{ endsAt: null }, { endsAt: { gt: now } }],
  };
}

/**
 * Exactly one post-order offer per product.
 *
 * The same rule, and the same mechanism, as `clearOtherDefaults` above:
 * the brief says the thank-you screen shows ONE offer, and two rows flagged
 * for it would make «which one» a question answered by whatever
 * `orderBy` happened to run. It is kept inside the write transaction
 * rather than by a partial unique index because the create lands before
 * the clear, so an index would refuse the second row and leave the seller
 * unable to move the flag at all.
 */
export async function clearOtherPostOrderOffers(
  tx: Tx,
  offer: { id: string; productId: string; companyId: string; postOrderOffer: boolean }
) {
  if (!offer.postOrderOffer) return;
  await tx.offer.updateMany({
    where: {
      companyId: offer.companyId,
      productId: offer.productId,
      id: { not: offer.id },
      postOrderOffer: true,
    },
    data: { postOrderOffer: false },
  });
}

/**
 * The offers a customer may be shown for this product, in order, in the
 * shape every public surface renders.
 *
 * Inactive and finished bundles are withheld everywhere, not merely greyed
 * out in the UI: a price that is not for sale must not be reachable by
 * guessing its id.
 *
 * It returns the VIEW, not the rows. `toOfferView` existed and nothing
 * called it — four surfaces hand-copied the same mapping, each free to get
 * the struck-through rule a little wrong, and one of them was the raw HTML
 * page nobody looks at. The raw `compareAtPrice` now never leaves this
 * file.
 */
export async function activeOffersFor(
  tx: Tx,
  companyId: string,
  productId: string,
  /*
   * THE CURRENCY, AND IT IS REQUIRED ON PURPOSE.
   *
   * `price` below is money the customer is charged, so it is rounded, and
   * rounding is the order's own currency's business — JOD has three places
   * and the dollar two. A default here would be a fourth place money gets
   * decided, and a caller that forgets is a compile error instead.
   */
  minorUnit: number,
  now: Date = new Date()
): Promise<OfferView[]> {
  const rows = await tx.offer.findMany({
    where: { companyId, productId, ...liveOfferWhere(now) },
    orderBy: [{ sortOrder: 'asc' }, { quantity: 'asc' }],
    select: {
      id: true,
      name: true,
      quantity: true,
      freeQuantity: true,
      sellingPrice: true,
      // The bundle's own reduction. Selected here for the first time: for as
      // long as it was not, `price` below was the figure BEFORE it, while
      // every door charged the figure after — see `toOfferView`.
      discount: true,
      compareAtPrice: true,
      isDefault: true,
      deliveryIncluded: true,
      endsAt: true,
    },
  });

  const evidence = await evidencedWasPrices(tx, rows);
  return rows.map((o) => toOfferView(o, minorUnit, evidence.get(o.id)));
}

/**
 * THE ONE OFFER SHOWN AFTER THE ORDER — «زيد علبة كمان؟ 15 بدل 25».
 *
 * `activeOffersFor` with the mirror predicate, and the rest of it
 * deliberately identical: the same `select`, the same `evidencedWasPrices`,
 * the same `toOfferView`. The price a customer reads on the thank-you
 * screen is therefore produced by the same arithmetic as the price they
 * read on the landing page — `allocateDiscount` once, rounded by the
 * order's own currency — rather than by a second mapping free to get the
 * discount or the struck-through rule a little differently.
 *
 * ONE, not a list, and `null` when the seller set none. `take: 1` is the
 * query saying what the screen says: the brief is «ONE offer», and a
 * second flagged row is already prevented by `clearOtherPostOrderOffers`.
 * The ordering is kept anyway so that a row that slipped past — restored
 * from a backup, written by a script — resolves to the same one every time
 * rather than to whatever the planner returned first.
 */
export async function postOrderOfferFor(
  tx: Tx,
  companyId: string,
  productId: string,
  /** The order's own currency. See `activeOffersFor` for why it is required. */
  minorUnit: number,
  now: Date = new Date()
): Promise<OfferView | null> {
  const rows = await tx.offer.findMany({
    where: { companyId, productId, ...postOrderOfferWhere(now) },
    orderBy: [{ sortOrder: 'asc' }, { quantity: 'asc' }],
    take: 1,
    select: {
      id: true,
      name: true,
      quantity: true,
      freeQuantity: true,
      sellingPrice: true,
      discount: true,
      compareAtPrice: true,
      isDefault: true,
      deliveryIncluded: true,
      endsAt: true,
    },
  });
  const row = rows[0];
  if (!row) return null;

  const evidence = await evidencedWasPrices(tx, rows);
  return toOfferView(row, minorUnit, evidence.get(row.id));
}

/**
 * The shape every public surface renders an offer in.
 *
 * `price` is the bundle's total — never a unit price. Every caller that
 * divides by the quantity does so from this one number, so a per-unit figure
 * shown to a customer can never disagree with what they are charged.
 *
 * THAT SENTENCE WAS FALSE FOR AS LONG AS A DISCOUNT EXISTED, and this file
 * said it anyway. `price` was `sellingPrice`, the figure BEFORE the bundle's
 * own `discount`, while `createPublicOrder`, the cart quote and `POST /orders`
 * all charged the figure after it. Measured on the live app: the landing page
 * printed «25 JOD · 12.50 / قطعة» for an offer the quote door priced at 22,
 * and printed the identical 25 for the plain two-piece bundle beside it —
 * two cards a customer cannot tell apart, three dinars apart at the door.
 * `price` is now what is charged, which is what this doc always claimed and
 * what `struckThroughPrice` has always documented its own argument to be.
 */
export interface OfferView {
  id: string;
  name: string;
  quantity: number;
  freeQuantity: number;
  /** What the customer is charged for this bundle. */
  price: number;
  /**
   * The bundle's price before its OWN reduction, and null when there is none.
   *
   * Not the same fact as `compareAtPrice`: that is a claim about the past and
   * must be earned from delivered orders, while this is a certainty about
   * today — the seller typed both numbers, and `57eb1d6` refuses a discount
   * that reaches the price, so it is always above it.
   */
  listPrice: number | null;
  /** Already measured against real delivered orders. Null means show nothing. */
  compareAtPrice: number | null;
  isDefault: boolean;
  deliveryIncluded: boolean;
  /** The moment this bundle stops — the countdown's only source. */
  endsAt: Date | null;
}

export function toOfferView(
  o: {
    id: string;
    name: string;
    quantity: number;
    freeQuantity: number;
    sellingPrice: number;
    /** Absent only for a caller that has not selected it; treated as none. */
    discount?: number | null;
    compareAtPrice: number | null;
    isDefault: boolean;
    deliveryIncluded?: boolean;
    endsAt?: Date | null;
  },
  /** The order's own currency. See `activeOffersFor` for why it is required. */
  minorUnit: number,
  /**
   * What this bundle was really delivered at before, from
   * `evidencedWasPrices`. Absent means «not proven», which shows nothing —
   * so a caller that forgets to look understates the discount rather than
   * inventing one.
   */
  evidence?: number
): OfferView {
  /*
   * THE REDUCTION IS APPLIED BY `allocateDiscount`, NOT HERE.
   *
   * A bundle is one line, so the allocation is the whole of it — and going
   * through the shared function is what makes this card and the door agree
   * by construction rather than by two people writing the same subtraction.
   * It carries the clamp (`Math.min(discount, subtotal)`, so a reduction can
   * never invert a price) and the one rounding rule, both of which a hand
   * -written `sellingPrice - discount` would have to restate.
   */
  const [taken] = allocateDiscount(
    [{ quantity: 1, unitPrice: o.sellingPrice }],
    Number(o.discount ?? 0),
    minorUnit
  );
  const charged = roundMinor(o.sellingPrice - taken, minorUnit);
  return {
    id: o.id,
    name: o.name,
    quantity: o.quantity,
    freeQuantity: o.freeQuantity,
    price: charged,
    listPrice: taken > 0 ? roundMinor(o.sellingPrice, minorUnit) : null,
    compareAtPrice: struckThroughPrice({
      // The charged figure, so an evidenced «was» is compared against what is
      // actually paid. A past 24 beside a charged 22 is a true strike-through
      // and used to be hidden, because 24 is not above the pre-discount 25.
      price: charged,
      claim: o.compareAtPrice,
      evidence,
    }),
    isDefault: o.isDefault,
    deliveryIncluded: o.deliveryIncluded ?? true,
    endsAt: o.endsAt ?? null,
  };
}
