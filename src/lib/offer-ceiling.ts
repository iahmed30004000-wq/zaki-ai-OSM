import { roundMinor } from './money';

/**
 * «العرض ما بصير يكون اكثر من السعر الاساسي» — THE OWNER, 28/10.
 *
 * WHAT THE TWO NUMBERS ARE, because comparing them as they stand is wrong:
 *
 *   Product.basePrice    the price of ONE piece
 *   Offer.sellingPrice   the price of the WHOLE bundle — `quantity` paid pieces, gifts on top at no price
 *
 * So the line an offer must stay under is the base price times its PAID pieces. «3 بـ60» at a base of 25 is 20 a
 * piece and passes (60 ≤ 75); comparing 60 with 25 would refuse every bundle there is, the screen's own «توليد سريع»
 * among them. Gift pieces are not counted: a gift costs the customer nothing, so «3 + 1 هدية» may cost what three
 * pieces cost and no more — 75, not 100. The landing page's «وفّرت» badge has always counted it that way.
 *
 * BOTH SIDES ARE ROUNDED BY THE STORE'S OWN CURRENCY, with the one rounding rule there is. A dinar has three places,
 * and 0.1 × 3 is 0.30000000000000004 in a computer: unrounded, the offer that sits exactly ON its line would be
 * refused. Equality passes — the hoodie «قطعتان + قطعة مجانية» is 50 at a base of 25 on the live shop today.
 *
 * WHAT IT DOES NOT LOOK AT, ON PURPOSE:
 *   · the offer's own `discount` — the rule reads the «السعر» box, the figure before the reduction, and a reduction
 *     can only bring what is charged further under the line;
 *   · delivery — a price «شامل التوصيل» is compared as it was typed;
 *   · a base price of 0 — «not priced yet», so there is no line to stay under until somebody writes one.
 *
 * CLIENT-SAFE, AND IT IMPORTS ONE THING. The offers screen draws its hint with these functions and the doors refuse
 * with them, so the figure the seller reads and the figure the server holds are one figure.
 */

/** The pieces a bundle charges for. A bundle of nonsense size (0, negative, NaN) is ONE piece, as `giftUnits` reads it. */
export function paidPieces(quantity: number): number {
  return quantity >= 1 ? quantity : 1;
}

/** The most this many paid pieces may cost — or null when there is no line to stay under. */
export function offerCeiling(basePrice: number, quantity: number, minorUnit: number): number | null {
  if (!(basePrice > 0)) return null;
  const ceiling = basePrice * paidPieces(quantity);
  /*
   * A FIGURE TOO LARGE TO HOLD IS NO LINE, NOT A LINE AT ZERO.
   *
   * `roundMinor` answers 0 for a value it cannot read, and the base price has no upper bound of its own: 1e308 × 2
   * is Infinity, and 1e308 survives the product only to overflow inside the rounding. A ceiling of 0 would refuse
   * every offer of that product, so both overflows read as «no ceiling».
   */
  if (!Number.isFinite(ceiling)) return null;
  const rounded = roundMinor(ceiling, minorUnit);
  return Number.isFinite(rounded) ? rounded : null;
}

/** The line this offer is above — or null when it is not above one. */
export function offerAboveBase(
  offer: { sellingPrice: number; quantity: number },
  basePrice: number,
  minorUnit: number
): number | null {
  const ceiling = offerCeiling(basePrice, offer.quantity, minorUnit);
  if (ceiling === null) return null;
  return roundMinor(offer.sellingPrice, minorUnit) > ceiling ? ceiling : null;
}
