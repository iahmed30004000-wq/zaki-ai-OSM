/**
 * WHAT THE OFFERS ON A SALES-PAGE ORDER SAY ABOUT DELIVERY — «yes», «no», or nothing at all.
 *
 * An offer carries «السعر شامل التوصيل» as a box the owner ticks or unticks (`Offer.deliveryIncluded`, ticked by default). The store
 * has its own policy («السعر المُعلن يشمل التوصيل») for the orders no offer speaks for. The landing page and the storefront
 * (`public-order.ts`) are the one door where an offer may say NO as well as yes (1/11, the owner: «بدي اترك مجال … من اللاندنج انو
 * اقدر احدد اذا شامل ولا لأ بظبط»); this is the reader it uses, and `priceIncludesDeliveryFor` asks the store only when this returns
 * `undefined`. Telegram, the systems door and the paste-in dialog do NOT use it: the store's switch covers them whole, and an offer
 * there still only ever turns delivery on.
 *
 *   · ANY line whose offer includes delivery makes the whole order include it — a customer pays one delivery fee or none, and the
 *     owner ruled that a printed promise («السعر شامل التوصيل») is never broken at the door.
 *   · «NO» only when EVERY line carries an offer and EVERY one of them says no.
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
