/**
 * The keys that free their holder from «اسحبي الطلب أول» — and the sentence the permissions screen says beside each of them.
 *
 * A file with NO imports, on purpose. `desk-readiness.ts` (which re-exports the list) imports `confirmation-queue.ts`, and that one
 * imports the database: a screen in the browser (the permissions screen's warning) cannot import it. Nor can the list live beside
 * `mustHoldToWork` in confirmation-queue.ts — that file reaches the confirmation desk's bundle, which sits at its ceiling — so the
 * rule keeps the two keys written out, and `desk-readiness.test.ts` pins that its source names exactly these keys.
 * `confirmation.supervise` is NOT one of them: adding it would excuse every live agent.
 */
export const EXEMPTS_FROM_HOLD = ['orders.unlock', 'orders.assign'] as const;

/** Beside each key of `EXEMPTS_FROM_HOLD` on the permissions screen. */
export const EXEMPT_FROM_HOLD_SENTENCE = 'هالمفتاح بيعفي حامله من قاعدة «اسحبي الطلب أول»';
