/**
 * The state label of a confirmed bench order, in the owner's words (B2, 18/11 — `test-store.ts`).
 *
 * Its own file, imported by the state chip, so the browser bundle of every screen that draws a state does not carry the
 * rest of `test-store.ts` (the bench's refusal sentences and query helpers). `test-store.ts` re-exports it.
 */
export const BENCH_CONFIRMED_AR = 'مؤكَّد — تيست، ما بينشحن';
