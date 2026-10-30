import { roundMinor } from './money';
import { giftUnits } from './offer-gift';
import { atBasePrice } from './line-price';

/**
 * WHAT A LINE COSTS WHEN IT IS SOLD ON AN OFFER — THE QUANTITY MOVES IN WHOLE BUNDLES.
 *
 * «بزر تعديل الطلب بالتأكيد بدي اختيار العرض… وكمان لو زدت العدد يتغير السعر وفق العرض مع الإبقاء على إمكانية تعديل
 * السعر» — the owner. This is the arithmetic of the first half and nothing else: no screen, no database, no write.
 * The lines editor will fill its price box from it, and the server will check a save against it, so the two read ONE
 * function (the pattern `atBasePrice` set in `line-price.ts`).
 *
 * THE OFFER SAYS: `quantity` paid pieces + `freeQuantity` gift pieces, for `price` — the whole bundle, never a piece.
 * `n` is the PAID quantity of the line, `k = floor(n / quantity)` the whole bundles in it, `r = n − k × quantity` the
 * pieces left over, `B` the product's base price for one piece.
 *
 *   n a whole number of bundles   total = k × price,                     gift = k × freeQuantity
 *   n has pieces left over        total = k × price + r × B,             gift = k × freeQuantity
 *   n is shorter than a bundle    total = n × B (the offer is let go),   gift = 0
 *
 * «٣ + ١ هدية بـ٧٥» at a base of 25: 3 → 75 and 1 gift; 6 → 150 and 2; 4 → 75 + 25 = 100 and 1; 2 → 50, no gift.
 *
 * NO NEW MONEY RULE. Rounding is `roundMinor` (`money.ts`), the base-price part is `atBasePrice` (`line-price.ts`),
 * the gift is `giftUnits` (`offer-gift.ts`) — all imported, none copied — and `offer-line-price.test.ts` holds the
 * total equal to what `computeCod` gives the same line written as a bundle line plus a base-price line.
 *
 * THE GIFT FOLLOWS THE BUNDLES, NEVER THE PIECES. A seventh piece on a «3 + 1» is an ordinary piece. Whoever types a
 * price over the offer's own leaves the bundles where they are, so the gift stays with them.
 *
 * THE SAFEST ANSWER WHEN THE ANSWER IS NOT KNOWN: A REFUSAL, WITH A SENTENCE — `basis: 'REFUSED'`, `lineTotal: null`.
 * Never a plausible figure. It refuses:
 *   · a quantity that is not a whole number from 1 to the door's own ceiling of 999 (`count(999, 1)`);
 *   · an offer whose bundle is not a whole number of pieces from 1, whose gift is not a whole number from 0, or whose
 *     price is not a number above 0;
 *   · a minor unit that is not a whole number from 0 to 6 (0 is a real unit — it is checked as a number);
 *   · a quantity that needs the base price (pieces left over, or shorter than a bundle) when the base price is not
 *     a number above 0 — `atBasePrice` says no figure and so does this.
 *
 * AND IT IS A SUGGESTION, like `atBasePrice`: the door still takes the box as it is sent and decides, and the COD is
 * still the server's.
 */

/** The most paid pieces one line may hold — the lines save's own `count(999, 1)`. */
export const OFFER_LINE_MAX_QUANTITY = 999;

/** What the offer is, as this function reads it: the paid pieces, the gift pieces, and the whole bundle's price. */
export interface OfferTerms {
  quantity: number;
  freeQuantity: number;
  /** The whole bundle's price — never a piece's. */
  price: number;
}

/**
 * How the line was priced.
 *
 *   OFFER           whole bundles only.
 *   OFFER_AND_BASE  whole bundles, and the pieces left over at the base price.
 *   BASE            shorter than one bundle: the offer is let go, the base price stands, no gift.
 *   REFUSED         nothing honest to say — see `notes` for the sentence.
 */
export type OfferLineBasis = 'OFFER' | 'OFFER_AND_BASE' | 'BASE' | 'REFUSED';

export interface OfferLinePrice {
  /** Whole bundles in the line. */
  bundles: number;
  /** Paid pieces that are not in a bundle — priced at the base price. */
  remainder: number;
  /** What the whole bundles cost: `bundles × price`, rounded by the currency. 0 when there are none. */
  price: number;
  /** Gift pieces: the offer's gift for each whole bundle. */
  gift: number;
  /** What the line costs, before the order's own discount. Null when `basis` is `REFUSED`. */
  lineTotal: number | null;
  basis: OfferLineBasis;
  /** Short Arabic sentences for the person: why it is refused, or how an uneven quantity was priced. */
  notes: string[];
}

const refused = (note: string): OfferLinePrice => ({
  bundles: 0,
  remainder: 0,
  price: 0,
  gift: 0,
  lineTotal: null,
  basis: 'REFUSED',
  notes: [note],
});

const isWhole = (v: unknown, min: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min;

const isBase = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

export function priceByOffer(
  offer: OfferTerms,
  quantity: number,
  ctx: { basePrice: number | null | undefined; minorUnit: number | null | undefined }
): OfferLinePrice {
  const { minorUnit, basePrice } = ctx;
  if (typeof minorUnit !== 'number' || !Number.isInteger(minorUnit) || minorUnit < 0 || minorUnit > 6) {
    return refused('عملة الطلب غير معروفة، فما بنقدر نحسب السعر');
  }
  if (!isWhole(quantity, 1) || quantity > OFFER_LINE_MAX_QUANTITY) {
    return refused(`الكمية لازم تكون عدد صحيح من 1 إلى ${OFFER_LINE_MAX_QUANTITY}`);
  }
  if (!offer || !isWhole(offer.quantity, 1) || !isWhole(offer.freeQuantity, 0) || !isBase(offer.price)) {
    return refused('العرض غير صالح للحساب: كميته أو سعره غير مفهوم');
  }

  const bundles = Math.floor(quantity / offer.quantity);
  const remainder = quantity - bundles * offer.quantity;
  const gift = giftUnits(offer, quantity);

  if (bundles === 0) {
    const total = atBasePrice(basePrice, quantity, minorUnit);
    if (total === undefined) {
      return refused('الكمية أقل من حزمة العرض والسعر الأساسي غير معروف: صحّح الكمية أو اترك العرض');
    }
    return {
      bundles: 0,
      remainder: quantity,
      price: 0,
      gift: 0,
      lineTotal: total,
      basis: 'BASE',
      notes: ['الكمية أقل من حزمة العرض: السعر الأساسي وبدون هدية'],
    };
  }

  const bundlesPrice = roundMinor(bundles * offer.price, minorUnit);

  if (remainder === 0) {
    if (!Number.isFinite(bundlesPrice)) return refused('السعر كبير أكثر من اللازم');
    return { bundles, remainder: 0, price: bundlesPrice, gift, lineTotal: bundlesPrice, basis: 'OFFER', notes: [] };
  }

  const rest = atBasePrice(basePrice, remainder, minorUnit);
  if (rest === undefined) {
    return refused('الكمية مش من مضاعفات حزمة العرض والسعر الأساسي غير معروف: صحّح الكمية أو اترك العرض');
  }
  const total = roundMinor(bundlesPrice + rest, minorUnit);
  if (!Number.isFinite(total)) return refused('السعر كبير أكثر من اللازم');
  const each = roundMinor(offer.price, minorUnit);
  const bundlesText = bundles === 1 ? `${offer.quantity} بـ${each}` : `${bundles} × (${offer.quantity} بـ${each})`;
  return {
    bundles,
    remainder,
    price: bundlesPrice,
    gift,
    lineTotal: total,
    basis: 'OFFER_AND_BASE',
    notes: [`${bundlesText} + ${remainder} بالسعر الأساسي (${rest})`],
  };
}

/** Half a minor unit: two figures within it are the same figure at this currency's precision. */
const near = (a: number, b: number, minorUnit: number): boolean =>
  Math.abs(a - b) <= 0.5 / 10 ** Math.max(0, minorUnit) + 1e-9;

/** A live offer as the matcher reads it: its terms, and the price it had before its own reduction (null when none). */
export interface LiveOfferTerms extends OfferTerms {
  id: string;
  listPrice: number | null;
}

/**
 * WHICH LIVE OFFER, IF ANY, A STORED LINE WAS SOLD ON.
 *
 * `OrderItem` has no offer column, so the only evidence is the figure: a line is bound to an offer when it is a whole
 * number of that offer's bundles AND its total, before the order's discount, is those bundles at the offer's price —
 * either after the offer's own reduction (the storefront's way, `CHARGED`) or before it (the manual door's way,
 * `LIST`). The same test `order-line-edit.ts` applies to the order's one offer, here over every live offer of the
 * product. A line with pieces left over, a typed price, or no live offer at all is bound to NOTHING — and that is
 * the safe answer: «unbound» changes no gift and no price.
 *
 * Two offers can fit one line (6 pieces is two «3 بـ75» and one «6 بـ150» when the prices agree). The tie is broken by
 * evidence, in this order: the offer whose gift is the gift the line already carries; the offer the order itself was
 * taken on (`preferId`); the first in the order given.
 *
 * It reads `priceByOffer` and nothing else, so the total it compares against is the very figure the editor will put in
 * the box.
 */
export function offerBoundToLine(
  line: { quantity: number; freeQuantity: number; total: number },
  offers: readonly LiveOfferTerms[],
  minorUnit: number,
  preferId?: string | null
): { offer: LiveOfferTerms; gift: number } | null {
  const fits: Array<{ offer: LiveOfferTerms; gift: number }> = [];
  for (const offer of offers) {
    const prices = [offer.price, offer.listPrice].filter((p): p is number => typeof p === 'number');
    for (const price of prices) {
      const answer = priceByOffer({ ...offer, price }, line.quantity, { basePrice: null, minorUnit });
      if (answer.basis !== 'OFFER' || answer.lineTotal === null) continue;
      if (!near(line.total, answer.lineTotal, minorUnit)) continue;
      fits.push({ offer, gift: answer.gift });
      break;
    }
  }
  if (fits.length === 0) return null;
  const agreeing = fits.filter((f) => f.gift === line.freeQuantity);
  const pool = agreeing.length > 0 ? agreeing : fits;
  return pool.find((f) => f.offer.id === preferId) ?? pool[0] ?? null;
}
