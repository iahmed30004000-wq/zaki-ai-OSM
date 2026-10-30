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
 * U+2066–U+2069), the Arabic letter mark (U+061C), the byte-order mark
 * (U+FEFF) and the no-break space (U+00A0).
 */
const INVISIBLE = /[​-‏‪-‮⁦-⁩؜﻿ ]/g;

const clean = (s: string | null | undefined): string => (s ?? '').replace(INVISIBLE, '').trim();

/** The order number, as the screen prints it. */
export function orderNumberToCopy(shown: string | null | undefined): string {
  return clean(shown);
}

/**
 * The phone, as a dialler is handed it: Latin digits and a `+`, nothing
 * decorative — the same cleaning the `tel:` link beside it applies. When
 * fewer than five digits survive it is not a number the cleaning can speak
 * for, so what the row held is copied (still in Latin digits, still without
 * invisible marks) rather than a stump.
 */
export function phoneToCopy(shown: string | null | undefined): string {
  const readable = toLatinDigits(clean(shown));
  const dialled = readable.replace(/[^\d+]/g, '');
  const digits = dialled.replace(/\D/g, '');
  return digits.length >= 5 ? dialled : readable;
}

/** The courier's barcode or reference, exactly as the courier wrote it. */
export function barcodeToCopy(shown: string | null | undefined): string {
  return clean(shown);
}
