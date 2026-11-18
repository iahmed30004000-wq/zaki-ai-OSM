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
 * NO IMPORTS, and read by the SERVER only (`/api/confirmation/mine` writes the words on each card): the desk's bundle is at its ceiling, so the desk prints strings and
 * counts nothing. The limit (5) is handed in (`CADENCE_LIMIT` in `no-answer-cadence.ts`) — it is never typed here.
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

/**
 * THE HINT BESIDE «لا يرد» (finding #11 of the rules map, 18/11): only what is TRUE for the rule in force, written by the server.
 *   · the plan: «the next attempt closes it» only when the server's own clock says a press now would (`closesOnNext`) — never a client countdown (an early press does not count);
 *   · the rounds: nothing — presses are not rounds, so «N left» would be false;
 *   · the base rule (neither switch): every press counts, so the countdown is true and is said as it always was.
 * `undefined` = say nothing.
 */
export function noAnswerHint(a: { planned: boolean; rounds: boolean; closesOnNext?: boolean; count: number; limit: number }): string | undefined {
  if (a.planned) return a.closesOnNext ? 'المحاولة القادمة تُغلق الطلب تلقائياً' : undefined;
  if (a.rounds) return undefined;
  const left = Math.max(0, a.limit - a.count);
  return left === 0 ? 'بلغ الحد' : left === 1 ? 'المحاولة القادمة تُغلق الطلب تلقائياً' : `متبقٍ ${left} محاولات قبل الإغلاق التلقائي`;
}
