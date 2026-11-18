/**
 * ONE COUNTER, ONE SENTENCE — «محاولة N من 5» (the owner, 16–17/11: three counters for one order).
 *
 * Under «إثبات المكالمات وجدول المحاولات» an order is counted in attempts, and every place of the confirmation desk that prints an attempt number prints it
 * THROUGH THIS FILE: the «لا يرد» button, the card's tag, the sentence the server says after a press, the closed card. The number means one thing — the attempt
 * the next «لا يرد» press WILL BE (`nextAttempt`), and, said after a press, the attempt that press WAS (`attemptWords(done, …)`, the same sentence).
 *
 * The counters of the older generations («جولة N من 3» under the rounds, «N/3» under the base rule) are not here and are not touched: they are what the desk
 * prints with the switch OFF, which is the way back.
 *
 * NO IMPORTS, on purpose: the desk's bundle is a few hundred bytes under its ceiling, so this file is a template and a `Math.min`, and the limit (5) arrives from
 * the server (`noAnswerLimit`, which is `CADENCE_LIMIT` in `no-answer-cadence.ts`) — it is never typed here.
 */

/**
 * «محاولة 2 من 5». Western digits, as everywhere on the desk. `definite` is the same words after a verb that takes the article — «انحسبت المحاولة 2 من 5» — so a
 * sentence the server says after a press still carries the one counter and not a second spelling of it.
 */
export function attemptWords(attempt: number, limit: number, definite = false): string {
  return `${definite ? 'المحاولة' : 'محاولة'} ${attempt} من ${limit}`;
}

/** The attempt the next press will be: one after the counted ones, and never past the limit (a plan that is full has no sixth). */
export function nextAttempt(counted: number, limit: number): number {
  return Math.min(Math.max(counted, 0) + 1, limit);
}

/** What the card prints for an order with `counted` attempts behind it: the attempt the next press will be. */
export function nextAttemptWords(counted: number, limit: number): string {
  return attemptWords(nextAttempt(counted, limit), limit);
}
