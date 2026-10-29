import { totalsBeforeDiscount } from './money';

/**
 * DOES THIS EDIT MOVE A PRICE? — the question `orders.change_price` is asked about (perm-plan PR-6).
 *
 * A price edit used to ride on `orders.edit`: whoever could fix an address could also fix the figure the customer pays.
 * The key is its own now. But the lines card of the order window POSTS EVERY PRICE BOX BACK on every save — it sends
 * `items[].unitPrice` and `discountAmount` even when the person only changed the quantity or the note — so «the request
 * carries a price field» cannot be the test: it would lock a person who may not set prices out of every other edit of the
 * lines. The test is whether the figure the request carries is DIFFERENT from the one the order already has.
 *
 * WHAT COUNTS AS DIFFERENT (and the tolerance is one minor unit, per piece of quantity, so a figure that went through a
 * division and a rounding on its way back is not mistaken for a new price):
 *
 *   · `discountAmount` — differs from the stored discount.
 *   · `sellingPrice` — the single-line shorthand: the TOTAL for the quantity the request names. Compared with the stored
 *     total scaled to that quantity, so raising the quantity at the same piece price is not a price change.
 *   · `items[]` — each line's total BEFORE the order's discount (the figure the card opens its box on), compared with the
 *     stored line of the same product (scaled to the quantity sent). A product the order did not have is compared with
 *     the product's catalogue price for that quantity; a product with no catalogue price is a new price by definition.
 *     A line whose total stays put while its quantity changes has a new piece price, and is a price change: the card's
 *     «keep the saved total» choice is a discount nobody with only `orders.edit` may give.
 *
 * Pure: the route reads the order, its lines and the catalogue prices and passes them in. The route asks this ONLY when the
 * person does not hold `orders.change_price`, so the people who do hold it cost no extra query.
 */
export type PriceField = 'sellingPrice' | 'discountAmount' | 'items';

export interface StoredOrderMoney {
  sellingPrice: number;
  quantity: number;
  discountAmount: number;
}

export interface StoredLine {
  productId: string;
  quantity: number;
  /** The line's total BEFORE the order's discount, as `totalsBeforeDiscount` states it. */
  beforeDiscount: number;
}

export interface PriceEditRequest {
  sellingPrice?: number;
  quantity?: number;
  discountAmount?: number;
  items?: ReadonlyArray<{ productId: string; quantity: number; unitPrice: number }>;
}

export interface PriceEditContext {
  stored: StoredOrderMoney;
  /** Required when the request carries `items`. */
  lines?: readonly StoredLine[];
  /** The product's catalogue price (per piece), or `null` when it has none. Asked only for a product the order did not have. */
  catalogPrice?: (productId: string) => number | null;
  minorUnit: number;
}

const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;

/** A stored total scaled to a new quantity (the piece price held). A stored quantity of 0 has no piece price: the total stands. */
const scaled = (total: number, from: number, to: number) => (from > 0 ? (total / from) * to : total);

/** Which of the price fields in this request differ from what the order already holds. Empty = the request moves no price. */
export function priceFieldsChanged(req: PriceEditRequest, ctx: PriceEditContext): PriceField[] {
  const unit = 1 / 10 ** Math.max(0, ctx.minorUnit);
  const changed: PriceField[] = [];

  if (req.discountAmount !== undefined && !near(req.discountAmount, ctx.stored.discountAmount, unit)) {
    changed.push('discountAmount');
  }

  if (req.sellingPrice !== undefined) {
    const qty = req.quantity ?? ctx.stored.quantity;
    const expected = scaled(ctx.stored.sellingPrice, ctx.stored.quantity, qty);
    if (!near(req.sellingPrice, expected, unit * Math.max(1, qty))) changed.push('sellingPrice');
  }

  if (req.items !== undefined) {
    const free = [...(ctx.lines ?? [])];
    let any = false;
    for (const line of req.items) {
      const at = free.findIndex((l) => l.productId === line.productId);
      if (at >= 0) {
        const [stored] = free.splice(at, 1);
        const expected = scaled(stored.beforeDiscount, stored.quantity, line.quantity);
        if (!near(line.unitPrice, expected, unit * Math.max(1, line.quantity))) any = true;
      } else {
        const piece = ctx.catalogPrice ? ctx.catalogPrice(line.productId) : null;
        if (piece === null || !near(line.unitPrice, piece * line.quantity, unit * Math.max(1, line.quantity))) any = true;
      }
    }
    if (any) changed.push('items');
  }

  return changed;
}

/** The stored lines in the shape the check wants, from the rows the order window already reads. */
export function storedLinesOf(
  rows: ReadonlyArray<{ productId: string; quantity: number; lineTotal: unknown; discountShare: unknown }>,
  orderDiscount: number,
  minorUnit: number
): StoredLine[] {
  const before = totalsBeforeDiscount(rows, orderDiscount, minorUnit);
  return rows.map((r, i) => ({ productId: r.productId, quantity: r.quantity, beforeDiscount: before[i] }));
}

/** The one sentence the refusal says. */
export const PRICE_FORBIDDEN_AR = 'تغيير السعر أو الخصم بدّه صلاحية خاصة — باقي التعديل مسموح.';
