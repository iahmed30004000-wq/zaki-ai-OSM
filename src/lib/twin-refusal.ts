/**
 * WHAT THE CONFIRMATION DOOR SAYS WHEN THE CUSTOMER ALREADY HAS A CONFIRMED TWIN — THE WORDS AND THE SHAPE, FOR BOTH SIDES.
 *
 * Client-safe on purpose: it imports nothing, so the server door (`confirmed-twin.ts`), the two screens that confirm
 * (`ConfirmationActions`, `ConfirmationMineScreen`), the new-order form's «أكّده الآن» (`confirm-now.ts`) and the dialog all
 * read ONE sentence and ONE shape, instead of each keeping a copy that drifts. The query itself — the part that needs the
 * database — lives next door and is not importable from a screen.
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
 * The sentence the door answers with, and the form's toast quotes. It says what is true, which two things it may be, and
 * what each costs — in the words an agent says to a colleague.
 */
export function twinConfirmedSentence(orderNumbers: string[]): string {
  const named = orderNumbers.length > 0 ? ` (${orderNumbers.join('، ')})` : '';
  return `الزبون عنده طلب مؤكَّد بنفس المنتج${named} — إذا هالطلب مكرر ارفضه كمكرر، وإذا طلب تاني فعلاً أكّده وانت متأكد`;
}

/**
 * What a refusal body means, or `null` when it is not this refusal.
 *
 * `data` is whatever the door answered with (`apiJson` hangs it on the error as `.data`). Anything that is not the twin
 * refusal reads as `null` and falls through to the screen's ordinary error line; inside the twin refusal, an entry that
 * is not a well-formed twin is dropped rather than drawn half-empty.
 */
export function twinsFromRefusal(data: unknown): ConfirmedTwinView[] | null {
  if (!data || typeof data !== 'object') return null;
  const body = data as { code?: unknown; twins?: unknown };
  if (body.code !== TWIN_CONFIRMED_CODE) return null;
  if (!Array.isArray(body.twins)) return [];
  const out: ConfirmedTwinView[] = [];
  for (const raw of body.twins) {
    if (!raw || typeof raw !== 'object') continue;
    const t = raw as Record<string, unknown>;
    if (typeof t.orderNumber !== 'string' || !t.orderNumber) continue;
    out.push({
      orderNumber: t.orderNumber,
      confirmedAt: typeof t.confirmedAt === 'string' ? t.confirmedAt : null,
      confirmedByName: typeof t.confirmedByName === 'string' && t.confirmedByName ? t.confirmedByName : null,
    });
  }
  return out;
}

/**
 * The two decisions the dialog offers, as the bodies the confirmation door takes. WRITTEN ONCE, HERE, so the two screens
 * cannot send different things for the same button.
 *
 * «رفضه كمكرر» is the door's own reject with the reason that already exists (`DUPLICATE_ORDER`, one of the reasons that
 * needs no word with the customer). «طلب تاني فعلاً — أكّد» is the confirm again with the one word that says she knows —
 * and this is the ONLY place in the product that writes `acknowledgeTwin: true`: nothing confirms past the guard by itself.
 */
export function rejectAsDuplicateBody(expectedVersion: number) {
  return { action: 'reject', rejectionReason: 'DUPLICATE_ORDER', expectedVersion };
}

export function confirmAnywayBody(expectedVersion: number, note?: string) {
  const said = note?.trim();
  return { action: 'confirm', acknowledgeTwin: true, expectedVersion, ...(said ? { note: said } : {}) };
}

/** What the new-order form says when it created the order and the door held the yes back for a twin. */
export function twinFormReason(twins: ConfirmedTwinView[]): string {
  const numbers = twins.map((t) => t.orderNumber);
  return `عند الزبون طلب مؤكَّد بنفس المنتج${numbers.length > 0 ? ` (${numbers.join('، ')})` : ''}`;
}

export const TWIN_FORM_NEXT = 'افتحه من شاشة الطلبات: ارفضه كمكرر، أو أكّده إذا هو طلب تاني فعلاً.';
