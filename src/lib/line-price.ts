import { roundMinor } from './money';

/**
 * WHAT A LINE COSTS AT THE PRODUCT'S BASE PRICE — THE FIGURE THE ORDER FORM
 * PUTS IN ITS PRICE BOX WHILE NOBODY HAS WRITTEN ONE.
 *
 * The manual order form's box holds the TOTAL for the line's paid quantity,
 * never a unit price (`ProductLinesEditor.tsx`). It opened at the base price
 * for one piece and never moved, so a product at 25 changed to two pieces
 * still said 25, and the order was saved at 25 instead of 50 unless the
 * person fixed it by hand.
 *
 * This is the figure `computeCod` gives such a line — `roundMinor(quantity ×
 * unitPrice, minorUnit)` in `money.ts` — and `line-price.test.ts` holds the
 * two equal. It is a SUGGESTION: the door still takes the box exactly as it
 * is sent, and the COD is still the server's.
 *
 * NO FIGURE — `undefined`, which the box shows as empty — when:
 *
 *   · the base price is not a number above 0. Zero is the column's default
 *     and means «not set yet»; the storefront's quote door sells only
 *     products priced above it, for the same reason. A giveaway is still
 *     possible: a person types 0, and the door accepts it.
 *   · the paid quantity is not a whole number from 1. The door counts whole
 *     pieces and refuses the rest.
 *   · the minor unit is not known — a whole number from 0 to 6. Rounding to a
 *     unit nobody stated is the mistake `money-written-once.test.ts` names,
 *     and 0 is a real unit, so it is checked as a number and not as truth.
 *
 * GIFTS ARE NOT A PARAMETER. The caller passes the PAID quantity; the gift
 * rides on top at no price (`offer-gift.ts`, and `MoneyLine.freeQuantity`).
 */
export function atBasePrice(
  basePrice: number | null | undefined,
  paid: number,
  minorUnit: number | null | undefined
): number | undefined {
  if (typeof basePrice !== 'number' || !Number.isFinite(basePrice) || basePrice <= 0) return undefined;
  if (!Number.isInteger(paid) || paid < 1) return undefined;
  if (typeof minorUnit !== 'number' || !Number.isInteger(minorUnit) || minorUnit < 0 || minorUnit > 6) {
    return undefined;
  }
  return roundMinor(basePrice * paid, minorUnit);
}
