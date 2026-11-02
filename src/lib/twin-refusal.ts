/**
 * WHAT THE CONFIRMATION DOOR SAYS WHEN THE CUSTOMER ALREADY HAS A CONFIRMED TWIN — THE WORDS AND THE SHAPE, FOR BOTH SIDES.
 *
 * Client-safe on purpose: it imports nothing, so the server door (`confirmed-twin.ts`) and the screens that confirm read ONE
 * sentence and ONE shape, instead of each keeping a copy that drifts. The query itself — the part that needs the database —
 * lives next door and is not importable from a screen.
 *
 * THE CASE (the owner, 2/11): a customer sends the same order three times, three confirmation agents each pull a different
 * copy, each confirms its own — three confirmed orders, three parcels, one person. The door now asks, before it writes the
 * yes, whether this customer already has a confirmed order for the same product that the courier has not taken yet.
 *
 * The refusal names the other orders by NUMBER, TIME AND COLLEAGUE and nothing else: no id, no name of the customer, no
 * phone, no address. A number is what a person on the phone says out loud, and the orders list is where she opens it.
 */

/** The `code` of the 409. A screen tells this refusal from `CONTACT_FIRST`, `REGION_REQUIRED` and the rest by it. */
export const TWIN_CONFIRMED_CODE = 'TWIN_CONFIRMED';

/** One confirmed twin, as the door names it and as the dialog reads it. */
export interface ConfirmedTwinView {
  orderNumber: string;
  /** ISO time of the yes, or null when the order was confirmed by a door that did not stamp it. */
  confirmedAt: string | null;
  /** The colleague who confirmed it, or null when that account is gone. */
  confirmedByName: string | null;
}

/**
 * The sentence the door answers with. It says what is true, which two things it may be, and what each costs — in the words an
 * agent says to a colleague.
 */
export function twinConfirmedSentence(orderNumbers: string[]): string {
  const named = orderNumbers.length > 0 ? ` (${orderNumbers.join('، ')})` : '';
  return `الزبون عنده طلب مؤكَّد بنفس المنتج${named} — إذا هالطلب مكرر ارفضه كمكرر، وإذا طلب تاني فعلاً أكّده وانت متأكد`;
}
