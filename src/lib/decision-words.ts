/**
 * THE FEW WORDS OF A DECISION THAT A SCREEN AND A DOOR BOTH READ — pure, with no imports.
 *
 * The rule «an answer needs an explanation of five characters at least» is read by the door that records the
 * answer and by the box a person types it into. It lives here, apart from `settlement-decisions`, because that
 * file reaches the database and the courier tables: a screen that only needs the number five must not carry
 * them into the browser.
 */

/** An explanation shorter than this is not one. */
export const MIN_EXPLANATION = 5;

/** The most rows one bulk decision takes. */
export const BULK_LIMIT = 200;

/** Of those five, this many must be real letters or digits: dots, stretch marks and invisible characters are not a reason. */
export const MIN_REAL_CHARACTERS = 3;

export const EXPLANATION_SENTENCE = `اكتب تفسيراً واضحاً: ${MIN_EXPLANATION} أحرف على الأقل، منها ${MIN_REAL_CHARACTERS} حروف أو أرقام`;

/**
 * THE EXPLANATION, TRIMMED — or null when it is not one. The ONE rule: the single door, the bulk door, the approval
 * and the box a person types into all ask this function.
 *
 * Five characters is not a reason by itself: «.....», five stretch marks «ـــــــ» and zero-width or direction marks all
 * have length. So the text must ALSO carry three real letters or digits after the invisible characters
 * (format characters, the stretch mark) are put aside. «خطأ بالرقم» passes; four real letters are short.
 */
export function explanationOf(text: string | null | undefined): string | null {
  const t = String(text ?? '').trim();
  if (t.length < MIN_EXPLANATION) return null;
  const real = t.replace(/[\p{Cf}\u0640]/gu, '').match(/[\p{L}\p{N}]/gu) ?? [];
  return real.length >= MIN_REAL_CHARACTERS ? t : null;
}
