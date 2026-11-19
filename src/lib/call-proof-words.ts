/**
 * ═══════════════════════════════════════════════════════════════════════
 * «إثبات المكالمات» — THE CLIENT-SAFE HALF (Confirmation Center v2, step A).
 *
 * Numbers and words only, and NO IMPORTS: the screens import this file and nothing else of the rule, so the bundle of `/confirmation/mine` (at its ceiling) grows by the
 * strings and not by the rule. The rule itself — which «اتصال» press counts, since when — is `call-proof.ts`, and the server decides; a screen only ticks a number the
 * server gave it (`secondsLeft`).
 *
 * REQUEST Q3b (19/11): THE SECONDS ARE THE RULE IN FORCE'S, AND THEY REACH THE DESK FROM THE SERVER. The doors read the owner's rule (`readConfirmationRule`) and hand its
 * `proofSeconds` to `call-proof.ts`; `/api/confirmation/mine` answers them (`proofSeconds`) and the desk waits that long. The figure below is the DEFAULT only — what a
 * caller that was handed no rule, or a desk answer without the field, falls back to. It is typed here and not imported from `confirmation-rule.ts` so the desk's bundle
 * stops carrying the whole rule set for one number; `call-proof-words.test.ts` pins it equal to `CONFIRMATION_RULE.proofSeconds`.
 * ═══════════════════════════════════════════════════════════════════════
 */

/** The DEFAULT proof's milliseconds — `CONFIRMATION_RULE.proofSeconds` × 1000 (pinned by a test); the rule in force's come from the server. */
const PROOF_MS = 30_000;

/**
 * How long after the «اتصال» press a «didn't answer» may be recorded, per result, by the DEFAULT rule. One constant per result so the owner can lower «مشغول» or «مسكّر» later
 * (a busy tone is known in seconds) without anyone digging through the code; in step A all three are the spec's thirty seconds.
 */
export const MIN_CALL_MS = { NO_ANSWER: PROOF_MS, BUSY: PROOF_MS, UNREACHABLE: PROOF_MS } as const;

/** The phone-side safety on top of the thirty seconds: the phone's clock and the server's are not the same clock. Only the call sheet uses it. */
export const CLIENT_MARGIN_MS = 2_000;

/**
 * The status door's second half of a pair: the attempt line it must find as the order's newest outcome. The same two minutes the returns mode gives the second
 * half of her own press (`RETURNED_PRESS_GRACE_MS`) — a test pins the equality.
 */
export const PAIRED_PRESS_GRACE_MS = 120_000;

/** Whole seconds left until `unlocksAtMs` (rounded UP, never below zero). */
export function secondsLeft(unlocksAtMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((unlocksAtMs - nowMs) / 1000));
}

/** What a screen says, in the desk's own tone. */
export const CALL_PROOF_WORDS = {
  /** No «اتصال» press of hers is on record since she took the order (or since the last outcome). */
  noOpened: 'اضغط «اتصال» أول — بعدين بينفتح «لا يرد».',
  /** The press is on record but younger than the thirty seconds. */
  wait: (n: number) => `استنّى ${n} ث من ضغطة «اتصال» — بعدها بتقدر تسجّل «لا يرد».`,
  /** The status door: the attempt line was not logged first. */
  notLogged: 'سجّل محاولة الاتصال أول، وبعدين غيّر الحالة إلى «لا يرد».',
  /** The «contact first» refusal, with the proof on (the old one said «أو اكبس لا يرد», which is no longer a way out). */
  contactFirstV2: 'اتصل بالزبون أول — اضغط «اتصال» وبعدها سجّل النتيجة.',
  /** The refusals the server sends (`CALL_NOT_STARTED`, `CALL_TOO_SOON`, `CALL_NOT_LOGGED`), for the screens that must show them without a round trip. */
  refusedNotStarted: 'ما في اتصال مسجّل على هالطلب. اضغط «اتصال» أول، وبعد ما تكلّم الزبون سجّل النتيجة.',
  refusedTooSoon: (n: number) => `استنّى ${n} ثانية من ضغطة «اتصال» قبل ما تسجّل إنو الزبون ما ردّ.`,
  invalidDuration: 'مدة المكالمة غير صالحة.',
} as const;

/** The refusal codes of the three doors, spelled once. */
export const CALL_PROOF_CODES = ['CALL_NOT_STARTED', 'CALL_TOO_SOON', 'CALL_NOT_LOGGED'] as const;
export type CallProofCode = (typeof CALL_PROOF_CODES)[number];

/** What the server says about the viewer's «لا يرد» on one order. `unlocksAtMs` is the server clock's instant (null unless WAIT). */
export interface CallProofState {
  state: 'NO_OPENED' | 'WAIT' | 'READY';
  unlocksAtMs: number | null;
}
