/**
 * «الطلب يرجع للطابور فوراً (تجريبي)» — THE TWO NUMBERS OF THE MODE, IN ONE PLACE (the owner, 9/11; the rules in `no-answer-returns.ts`, the readers in `confirmation-queue.ts`,
 * which re-exports this so every importer is unchanged).
 *
 *   · `handLimit` — the most one agent holds, in her hands plus held for her. `idleBusinessMinutes` — nothing logged on an order in her hand for this many WORKING minutes lets it go back.
 *   · With «أولوية الطابور» on, `QUEUE_PRIORITY_LIMITS` (`queue-priority.ts`) are the numbers instead — `returnsLimits` asks.
 *
 * A FILE WITH NO IMPORTS, on purpose (18/11): `auto-release.ts` says the idle figure in its notice, and a screen of the desk imports `auto-release.ts` — a constant
 * that lived in a rules module dragged that module into the desk's bundle, which is at its ceiling.
 */
export const RETURNS_MODE = { handLimit: 5, idleBusinessMinutes: 30 } as const;
