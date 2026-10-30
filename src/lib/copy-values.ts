import { toLatinDigits } from './latin-digits';

/**
 * WHAT LANDS ON THE CLIPBOARD WHEN SOMEONE PRESSES «نسخ» NEXT TO AN ORDER.
 *
 * One rule: **copy what is on the screen, and nothing the screen did not
 * show.** These are pure functions of the strings a row already holds — no
 * lookup, no guess, no write. A phone number is not given a country code
 * that the row did not carry (that is a different piece of work and a wrong
 * guess costs a delivery), and a courier's barcode is not re-cased.
 *
 * INVISIBLE DIRECTION MARKS ARE TAKEN OUT OF EVERYTHING. Latin digits are
 * drawn inside a right-to-left line with direction marks around them; copying
 * the glyphs copies the marks, and pasting «‎0791234567‎» into a courier's
 * search box finds nothing, with nothing visible to blame.
 */

/**
 * Marks that have no glyph: LRM/RLM and the other zero-width joiners
 * (U+200B–U+200F), the embedding and isolate controls (U+202A–U+202E,
 * U+2066–U+2069), the Arabic letter mark (U+061C), the narrow no-break space
 * (U+202F), the word joiner (U+2060), the byte-order mark (U+FEFF) and the
 * no-break space (U+00A0). Written as escapes so the source holds no mark
 * that an editor could swallow.
 */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202F\u2060\u2066-\u2069\u061C\uFEFF\u00A0]/g;

const clean = (s: string | null | undefined): string => (s ?? '').replace(INVISIBLE, '').trim();

/**
 * A field that holds MORE THAN ONE number, or a number and an extension:
 * a slash, a comma (Latin or Arabic), a semicolon, a vertical bar, a line
 * break, «ext» or «داخلي»/«تحويلة». Stripping such a field down to digits
 * glues two numbers into one that dials nobody.
 */
const MORE_THAN_ONE = /[/,،;؛|\n\r]|\bext\b|داخلي|تحويلة/i;

/** The order number, as the screen prints it. */
export function orderNumberToCopy(shown: string | null | undefined): string {
  return clean(shown);
}

/**
 * The phone, as a dialler is handed it: Latin digits and a `+`, nothing
 * decorative. The `tel:` link beside it (`ContactButtons`) strips with
 * `[^\d+]`, which does not see Arabic-Indic digits at all, so this reads them
 * as Latin FIRST — the copy is therefore at least as complete as the link.
 *
 * Two cases hand the row's text back instead of a cleaned number:
 *   · the field holds several numbers or an extension (see `MORE_THAN_ONE`):
 *     what the row said is copied as it is, minus invisible marks — the
 *     person picks the one they need;
 *   · fewer than five digits survive, so it is not a number the cleaning can
 *     speak for: the row text, in Latin digits, rather than a stump.
 */
export function phoneToCopy(shown: string | null | undefined): string {
  const text = clean(shown);
  if (MORE_THAN_ONE.test(text)) return text;
  const readable = toLatinDigits(text);
  const dialled = readable.replace(/[^\d+]/g, '');
  const digits = dialled.replace(/\D/g, '');
  return digits.length >= 5 ? dialled : readable;
}

/** The courier's barcode or reference, exactly as the courier wrote it. */
export function barcodeToCopy(shown: string | null | undefined): string {
  return clean(shown);
}
