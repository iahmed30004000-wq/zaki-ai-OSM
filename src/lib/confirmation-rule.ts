/**
 * ═══════════════════════════════════════════════════════════════════════
 * «قاعدة وحدة» — THE ONE RULE SET OF THE CONFIRMATION DESK (the owner's plan of 17/11, request C2).
 *
 * Every number of the rule «إثبات المكالمات وجدول المحاولات» in ONE object. The older constants (`CADENCE_LIMIT`, `CADENCE_MIN_DAYS`, `CADENCE_GAPS_MS`,
 * `CADENCE_FLOORS_MS` in `no-answer-cadence.ts` · `QUEUE_PRIORITY_LIMITS`, `POSTPONE_MAX_TIMES`, `QUEUE_PRIORITY.freshMinutes` in `queue-priority.ts` ·
 * `MIN_CALL_MS` in `call-proof-words.ts`) are now READ FROM HERE, so no caller changed its import and no number is typed twice.
 *
 *   attempts      5        counted «لا يرد» presses; the fifth closes the order…
 *   minDays       2        …only when they fall on this many different local days
 *   proofSeconds  30       «لا يرد» opens this long after her «اتصال» press
 *   hand          3        the most one agent holds while the rule is on
 *   idleMinutes   20       working minutes with nothing logged → the order goes back by itself
 *   morning       11:00    #4 is due here on the first working day ≥ 8 h after #3 (clamped into the Country's window [start, end − 1 h])
 *   evening       19:30    #5 is due here: min(19:30, end − 1 h), never before the start
 *   freshMinutes  15       a new order younger than this is «fresh» and goes first
 *   gapsMinutes   30 / 120 #2 and #3 after the previous counted press (elapsed)
 *   floorsHours   8 / 3    #4 never before 8 h after #3, #5 never before 3 h after #4 (elapsed)
 *   postponeMax   2        a customer's date, at most twice
 *
 * NO IMPORTS, on purpose: `call-proof-words.ts` reads the proof seconds from here and the confirmation desk's bundle (at its ceiling) imports that file.
 * Editing these numbers from a card is a later request: nothing here is a setting, and nothing writes them.
 * ═══════════════════════════════════════════════════════════════════════
 */
export const CONFIRMATION_RULE = {
  attempts: 5,
  minDays: 2,
  proofSeconds: 30,
  hand: 3,
  idleMinutes: 20,
  morning: '11:00',
  evening: '19:30',
  freshMinutes: 15,
  gapsMinutes: { afterFirst: 30, afterSecond: 120 },
  floorsHours: { beforeFourth: 8, beforeFifth: 3 },
  postponeMax: 2,
} as const;
