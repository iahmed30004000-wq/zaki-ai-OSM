/**
 * ═══════════════════════════════════════════════════════════════════════
 * ONE OR TWO IS NOT THE SAME ORDER AS ZERO.
 *
 * «لا يرد» separates an order nobody has reached — which is a call — from
 * an order rung twice with nothing, which is a decision: one more and it
 * closes itself. Mixed into one list, the second kind was invisible until
 * the counter inside a button said «2/3».
 *
 * ── AND THE COLOUR DOES NOT CARRY IT ALONE ──
 *
 * The meaning colours are fixed product-wide — amber is «needs
 * attention», red is «late or money lost» — so this invents no hue. It
 * uses amber at two strengths: a soft card at one no-answer, and at two
 * the border is amber outright, because the next call closes the order.
 *
 * ⚠️ `noAnswerWords` says the same thing in words, for the agent who
 * cannot tell the two ambers apart and for the one reading this on a
 * phone in the sun. Here and not inside the screen so a test can put
 * real counts through it rather than reading its source.
 * ═══════════════════════════════════════════════════════════════════════
 */

/** The card's surface: calm · one no-answer · the next one closes it · closed. */
export function cardTone(count: number, limit: number, closed?: boolean): string {
  if (closed) return 'bg-[var(--sys-destructive-soft)] border-[var(--sys-destructive-border)]';
  if (count >= limit - 1 && count > 0) return 'bg-[var(--sys-warning-soft)] border-[var(--sys-warning)]';
  if (count > 0) return 'bg-[var(--sys-warning-soft)] border-[var(--sys-warning)]/40';
  return 'bg-[var(--sys-card)] border-[var(--sys-border)]';
}

/** The count in words, so colour is never carrying it alone. */
export function noAnswerWords(count: number): string {
  if (count === 1) return 'ما ردّ مرّة واحدة';
  if (count === 2) return 'ما ردّ مرّتين';
  return `ما ردّ ${count} مرّات`;
}

/**
 * «نظام الجولات» ON (`no-answer-rounds.ts`): the count is ROUNDS, not presses — presses within three working hours are one
 * round, and the third round closes the order only on a second day. The words say a round so she is not told «ما ردّ مرّة
 * واحدة» about an order she rang four times this morning.
 */
export function roundWords(rounds: number, limit: number): string {
  return `جولة ${rounds} من ${limit}`;
}
