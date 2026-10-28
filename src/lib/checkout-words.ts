// Types only: this module ships to the public forms, and store-theme's values live beside zod.
import type { CheckoutField } from './store-theme';

/**
 * THE WORDS A PUBLIC ORDER FORM SAYS ABOUT THE SHOP'S «الدفع» — written once, read by the forms, by the door and by
 * the settings tab that has to say what a blank setting shows.
 *
 * No zod and no value import: the forms are on every public page, and this is a few lines of plain data.
 */

/** What the confirm button says when nobody wrote otherwise — the form block's own default (`landing-sections.ts`). */
export const DEFAULT_SUBMIT = 'تأكيد الطلب';

/** The line under the thank-you title when nobody wrote one — the «صفحة الشكر» block's own default message. */
export const DEFAULT_THANKS = 'سنتواصل معك قريبًا لتأكيد الطلب.';

/**
 * «اكتب …» — A FIELD THE SHOP MADE «إلزامي» AND THE VISITOR LEFT BLANK.
 *
 * The owner was asked, 28/10, whether such a field should refuse the order or be taken as before, and answered for
 * refusing it: «انطيني الصلاحية شو الي يظهر بالشيك اوت الي بينطلب والترتيب دراخ اند دروب». So the same rule is
 * asked twice:
 *
 *   · in the browser, before anything is sent — the visitor reads the sentence under the field at once;
 *   · at the door (`createPublicOrder`), which is the authority — a request that skipped the browser, or a page older
 *     than the shop's «الدفع», meets the same sentence and nothing is written.
 *
 * ONE sentence per field, here, so the two can never say different things. Only the two the shop may require are
 * named: the four a parcel needs keep the door's own checks and its own words (`landing-order-schema.ts`).
 */

/**
 * What a public door enforces from the shop's «الدفع»: the fields it requires — the four a parcel needs, plus what
 * the seller ticked and left visible. Resolved by `checkoutRules` in `store-theme.ts` from the store's LIVE theme and
 * handed to the order engine as plain data, so the engine that decides money imports nothing that knows what the
 * shop looks like (every-template.test.ts holds that boundary).
 */
export interface CheckoutRules {
  required: CheckoutField[];
}

/** The name each field travels under in an order sent to a public door. */
export const CHECKOUT_WIRE: Record<CheckoutField, string> = {
  name: 'full_name',
  phone: 'phone',
  altPhone: 'alt_phone',
  region: 'city',
  address: 'address',
  note: 'notes',
};

/** What the visitor reads under a blank field the shop requires. */
const ASK: Partial<Record<CheckoutField, string>> = {
  altPhone: 'اكتب رقم هاتف بديل',
  note: 'اكتب ملاحظتك',
};

/**
 * The required fields left blank (whitespace is blank), keyed by their wire names the way a door's `fieldErrors`
 * are — or null when nothing is missing.
 *
 * `required` is what the shop's «الدفع» resolved to (`requiredCheckoutFields`): a hidden field is never in it, so a
 * page that does not draw a field is never refused over it.
 */
export function blankRequired(
  required: readonly CheckoutField[],
  sent: Readonly<Record<string, unknown>>
): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const field of required) {
    const sentence = ASK[field];
    if (!sentence) continue;
    const wire = CHECKOUT_WIRE[field];
    const value = sent[wire];
    if (typeof value !== 'string' || value.trim() === '') out[wire] = sentence;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * The line near the button when the door refused a field THIS page does not draw — a page built before the seller
 * changed «الدفع». The visitor cannot fill what is not there; a reload brings it.
 */
export const NEW_REQUIRED_FIELD = 'صار في خانة مطلوبة جديدة — حدّث الصفحة وعيد الطلب';

/** Whether a door's `fieldErrors` name a field this form does not draw. */
export function refusesUndrawn(fieldErrors: Readonly<Record<string, string>>, drawn: readonly CheckoutField[]): boolean {
  return (Object.keys(CHECKOUT_WIRE) as CheckoutField[]).some(
    (field) => !drawn.includes(field) && Boolean(fieldErrors[CHECKOUT_WIRE[field]])
  );
}
