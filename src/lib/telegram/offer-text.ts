import { toLatinDigits } from '../latin-digits';
import { normalizeArabic } from '../order-parser';
import { CURRENCY_WORDS } from './parser';

/**
 * «إسم العرض» OF A TELEGRAM MESSAGE — TIED TO ONE REAL OFFER OF THE PRODUCT.
 *
 * The owner, 28/10: «واريد كمان يكون نص العرض مربوط بالعرض». The text a seller pastes («قطعتين + قطعة هدية ( عدد 3 ) =25 $
 * + توصيل مجاني») names one of the product's active offers; this file finds which, and nothing else. The price, the gift
 * units and the delivery are the offer row's and are worked out by the storefront door's own functions (`resolvePublicLines`,
 * `basketDiscount`, `computeCod`) — never by anything here.
 *
 * PURE. No I/O.
 */

const BIDI = /[‎‏‪-‮⁦-⁩؜]/g;

/**
 * The form two names are compared in: digits Latin, the spelling folded (أ إ آ → ا, ى → ي, ة → ه, no marks), every
 * punctuation mark and currency symbol — ( ) = + ، $ — turned into a space, and the spaces collapsed.
 */
export function foldOfferText(text: string): string {
  return normalizeArabic(toLatinDigits(text ?? '').replace(BIDI, ''))
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type OfferMatch<T> = { kind: 'found'; offer: T } | { kind: 'ambiguous' } | { kind: 'none' };

/**
 * The ONE offer the text names, among the product's active offers.
 *
 * Tolerant, and in this order: an offer whose name IS the text (after folding) wins; otherwise the offers whose whole name
 * stands inside the text, word for word. When several stand inside, an offer whose name is part of another candidate's
 * name is set aside («قطعتين» inside «قطعتين + قطعة هدية»), and if exactly one candidate is left it is the answer. Two
 * offers with the same folded name, or two different candidates, are `ambiguous` — never guessed between.
 */
export function matchOfferText<T extends { name: string }>(text: string, offers: readonly T[]): OfferMatch<T> {
  const message = foldOfferText(text);
  if (!message) return { kind: 'none' };
  const named = offers.map((offer) => ({ offer, folded: foldOfferText(offer.name) })).filter((x) => x.folded);

  const equal = named.filter((x) => x.folded === message);
  if (equal.length === 1) return { kind: 'found', offer: equal[0].offer };
  if (equal.length > 1) return { kind: 'ambiguous' };

  const padded = ` ${message} `;
  const inside = named.filter((x) => padded.includes(` ${x.folded} `));
  if (inside.length === 0) return { kind: 'none' };
  const widest = inside.filter(
    (a) => !inside.some((b) => b !== a && b.folded.length > a.folded.length && ` ${b.folded} `.includes(` ${a.folded} `))
  );
  return widest.length === 1 ? { kind: 'found', offer: widest[0].offer } : { kind: 'ambiguous' };
}

/** Every currency the text names (by `Country.currencyCode`): «$» and «دولار» are USD, «ل.س» SYP, «د.أ» JOD. */
export function currenciesIn(text: string): string[] {
  const folded = normalizeArabic(toLatinDigits(text ?? '').replace(BIDI, ''));
  return CURRENCY_WORDS.filter((c) => new RegExp(`(?:^|[^\\p{L}])(?:${c.pattern})(?![\\p{L}])`, 'iu').test(folded)).map((c) => c.code);
}

/**
 * How many OFFERS the written quantity means, given the pieces one offer is paid for.
 *
 * «الكمية» is the product's pieces. 1 or exactly the offer's paid pieces is ONE offer; a whole multiple of them is that many
 * offers; any other number is not an offer and is `null` — a person looks at it. (A gift is not counted in the quantity: the
 * offer «قطعتين + قطعة هدية» is one offer for a quantity of 1 or 2, two offers for 4, and 3 matches nothing.)
 */
export function offersForQuantity(quantity: number, paidPieces: number): number | null {
  if (!Number.isInteger(quantity) || quantity < 1) return null;
  const paid = paidPieces >= 1 ? paidPieces : 1;
  if (quantity === 1 || quantity === paid) return 1;
  if (quantity % paid === 0) return quantity / paid;
  return null;
}
