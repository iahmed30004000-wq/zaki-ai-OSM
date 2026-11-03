/**
 * WHICH PRICE THE FIRST SCREEN SHOWS — one rule for every hero that draws one.
 *
 * The plain `Hero` in PageBlocks.tsx states this rule inline (a guard reads it
 * there); the designed hero (`DesignedBlocks.tsx`) reads it from here, and
 * `the-designs-wear-our-blocks.test.tsx` renders both over five shapes of offer
 * and holds them to one figure. This only CHOOSES a figure already computed by
 * the server; it adds and multiplies nothing.
 *
 * The bundle shown is the one the form PRESELECTS (`isDefault`, else the
 * first), so the first screen and the submit button carry one number. The
 * struck-through figure follows the offer cards' rule: the certain one
 * (`listPrice`) wins over the claim about the past (`compareAtPrice`).
 */
export interface HeroOffer {
  id: string;
  name: string;
  freeQuantity: number;
  price: number;
  listPrice?: number | null;
  compareAtPrice?: number | null;
  isDefault?: boolean;
}

export function heroPrice<O extends HeroOffer>(offers: O[], basePrice: number): { selected: O | null; shown: number; was: number | null } {
  const selected = offers.find((o) => o.isDefault) ?? offers[0] ?? null;
  const shown = selected ? selected.price : basePrice;
  const was = selected ? (selected.listPrice ?? selected.compareAtPrice ?? null) : null;
  return { selected, shown, was };
}
