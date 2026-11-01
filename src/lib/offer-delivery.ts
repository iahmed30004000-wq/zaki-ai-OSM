/**
 * WHAT THE OFFERS ON AN ORDER SAY ABOUT DELIVERY — «yes», «no», or nothing at all.
 *
 * An offer carries «السعر شامل التوصيل» as a box the owner ticks or unticks (`Offer.deliveryIncluded`, ticked by default). The store has
 * its own policy («السعر المُعلن يشمل التوصيل») for the orders no offer speaks for — a Telegram message, a sheet row, a price typed by
 * hand. This is the one place that reads the offers of an order and answers for them; `priceIncludesDeliveryFor` then asks the store
 * only when this returns `undefined`.
 *
 *   · ANY line whose offer includes delivery makes the whole order include it — a customer pays one delivery fee or none, and the
 *     owner ruled that a printed promise («السعر شامل التوصيل») is never broken at the door (see `public-order.ts`).
 *   · «NO» only when EVERY line carries an offer and EVERY one of them says no. The owner can tell a sales-page offer «لا، أضف التوصيل»
 *     even in a store that includes delivery for everything else (1/11: «بدي اترك مجال … أحدد إذا شامل ولا لأ بظبط»).
 *   · Anything else — no offers at all, or a line with no offer beside a line whose offer says no — is silence: the store decides for
 *     the line that has no offer, and a basket with one line the store includes is a basket that includes.
 *
 * Pure, and in a module of its own so a test that replaces `delivery-fees` (it reads the database) does not take this with it.
 *
 * @param flags one entry per selling line: the offer's `deliveryIncluded`, or `undefined`/`null` for a line with no offer.
 */
export function offersSayDeliveryIncluded(flags: ReadonlyArray<boolean | null | undefined>): boolean | undefined {
  if (flags.some((f) => f === true)) return true;
  if (flags.length > 0 && flags.every((f) => f === false)) return false;
  return undefined;
}
