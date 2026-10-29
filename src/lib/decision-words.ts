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

export const EXPLANATION_SENTENCE = `اكتب تفسير القرار — ${MIN_EXPLANATION} أحرف على الأقل`;

/** The explanation, trimmed — or null when it is too short to count. */
export function explanationOf(text: string | null | undefined): string | null {
  const t = String(text ?? '').trim();
  return t.length >= MIN_EXPLANATION ? t : null;
}
