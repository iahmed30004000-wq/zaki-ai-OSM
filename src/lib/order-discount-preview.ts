import { computeCod, roundMinor } from './money';
import { NOT_A_NUMBER, typedNumber } from './typed-box';

/**
 * «بعد الخصم» — WHAT THE DISCOUNT BOX WILL DO, SHOWN BEFORE ANYBODY PRESSES حفظ.
 *
 * The order card has two boxes that look like rivals: the price of each line
 * and «الخصم على الطلب». They are not. The price of a line is the line BEFORE
 * the discount; the discount is taken ONCE, off the whole order, and the
 * server spreads it over the lines by their value (`allocateDiscount`). The
 * person typing could not see that: «قيمة البضاعة» stayed put whatever she
 * wrote in the discount box, so a discount of 10 looked ignored — and the
 * fear that it would be taken twice, or fight with a price she had just
 * edited, had nothing to answer it.
 *
 * This file answers it with the SERVER'S OWN FUNCTIONS. It does not compute a
 * discount: it hands the boxes to `computeCod`, exactly as `PATCH
 * /api/orders/[id]` does — each line as `price ÷ quantity` per piece, the
 * discount as the number in the box — and reports what comes back. One
 * calculator, two callers. `order-discount-preview.test.ts` holds it equal to
 * the real door, in three currencies.
 *
 * WHAT IT LEAVES OUT, ON PURPOSE. The delivery fee, the add-ons a customer
 * accepted and the «price includes delivery» policy decide what is COLLECTED;
 * they play no part in what the discount does to the goods, and this card does
 * not hold the add-ons. «بعد الخصم» is the goods after the discount, and says
 * nothing about the courier's fee.
 */

export interface PreviewLine {
  quantity: number;
  /** The characters in the line's price box — the line BEFORE the discount, as the door reads it. */
  price: string | undefined;
}

export type DiscountPreview =
  /** A price box is empty or not a price, or the currency is not known yet: there is nothing true to show. */
  | { kind: 'unknown' }
  /** The discount box holds something the door refuses (below zero, or beyond the largest it accepts). */
  | { kind: 'invalid' }
  /** More off than the goods are worth — the door answers 400 for this. */
  | { kind: 'tooBig'; goods: number }
  | {
      kind: 'ok';
      /** The lines' value before any discount. */
      goods: number;
      /** What is actually taken off (the box's figure, to the currency's decimals). */
      discount: number;
      /** `goods` less `discount`. */
      after: number;
      /** What each line carries of the discount, in the order of the lines. */
      shares: number[];
      /** Each line once its share is off. */
      linesAfter: number[];
    };

/** The largest discount `PATCH /api/orders/[id]` accepts (`amount(100000)`). */
const LARGEST = 100000;

export function previewOrderDiscount(input: {
  lines: ReadonlyArray<PreviewLine>;
  /** The characters in the discount box. */
  discount: string;
  minorUnit: number | null | undefined;
}): DiscountPreview {
  const { minorUnit } = input;
  if (typeof minorUnit !== 'number' || !Number.isInteger(minorUnit) || minorUnit < 0 || minorUnit > 6) {
    return { kind: 'unknown' };
  }
  if (input.lines.length === 0) return { kind: 'unknown' };

  const money: { quantity: number; unitPrice: number }[] = [];
  for (const line of input.lines) {
    const price = typedNumber(line.price ?? '');
    if (price === undefined || price === NOT_A_NUMBER || price < 0 || price > LARGEST) return { kind: 'unknown' };
    if (!Number.isInteger(line.quantity) || line.quantity < 1) return { kind: 'unknown' };
    // The door's own reading of a line: the box is the total, `computeCod` is given the piece.
    money.push({ quantity: line.quantity, unitPrice: price / line.quantity });
  }

  // An emptied box is no discount, as the card sends it (`Number('')`).
  const typed = typedNumber(input.discount);
  const discount = typed === undefined ? 0 : typed;
  if (discount === NOT_A_NUMBER || discount < 0 || discount > LARGEST) return { kind: 'invalid' };

  const cod = computeCod({ lines: money, discount, minorUnit });
  // The door's refusal, asked the way the door asks it.
  if (discount > cod.subtotal) return { kind: 'tooBig', goods: cod.subtotal };

  return {
    kind: 'ok',
    goods: cod.subtotal,
    discount: cod.discount,
    after: roundMinor(cod.subtotal - cod.discount, minorUnit),
    shares: cod.discountShares,
    linesAfter: cod.lineTotals,
  };
}
