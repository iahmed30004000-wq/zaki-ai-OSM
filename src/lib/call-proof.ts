import { NOT_A_CALL, chronological, isNoAnswer, type AttemptFact } from './no-answer-rounds';
import { MIN_CALL_MS, PAIRED_PRESS_GRACE_MS, type CallProofState } from './call-proof-words';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «إثبات المكالمات» — THE RULE, WITH NOTHING READ (Confirmation Center v2, step A; the owner's spec: «Releasing as NO_ANSWER requires a logged attempt and
 * ≥ 30 seconds since the attempt started»). Pure: no database, no clock of its own, no framework.
 *
 * Behind the company switch `callProofAndCadence` (`call-proof-switch.ts`), OFF unless the owner turns it on. The doors ask it BEFORE they write.
 *
 * ── WHAT «THE ATTEMPT» IS ──
 *
 * The LATEST «اتصال» press (`OPENED`) of the person who is recording the result, on THIS order, that is no older than her claim and that no outcome line has
 * come after. An outcome line is any row whose result is not `OPENED` and not `MESSAGE_SENT` — hers or anybody's, a no-answer, the entry door's ANSWERED, the
 * landing chat's. Latest and not earliest: an early accidental press must not license a quick «ما رد» after a later real dial, and a deliberate re-dial restarts
 * the thirty seconds. Her claim comes from `Order.claimedAt` — the column every release rule reads — so a press from before she re-pulled the order is not hers now.
 *
 * ── WHAT IS MEASURED, AND BY WHOM ──
 *
 * Only the SERVER's `createdAt` of that press and the server's `now`. Nothing the client sends is ever read to ALLOW a press. Exactly 30 000 ms is allowed;
 * 29 999 is refused. A press that landed late (an offline retry) has a late `createdAt`, so the thirty seconds can only start LATER — it fails closed.
 *
 * ── WHAT THE PROOF IS NOT ──
 *
 * A logged press plus elapsed time. It is not proof that a conversation (or a ring) happened: a script, or a deliberately delayed tap, can pass it. It makes
 * the quick «ما رد» — one ring or no call — impossible, and leaves the evidence (`durationSeconds`, one audit row per refusal) for step G to measure.
 * ═══════════════════════════════════════════════════════════════════════
 */

export type CallProofVerdict =
  | { ok: true; guarded: boolean; openedAt: Date | null; elapsedSeconds: number | null }
  | { ok: false; code: 'NO_OPENED' }
  | { ok: false; code: 'TOO_SOON'; waitSeconds: number; unlocksAtMs: number };

export type PairedLineVerdict = { ok: true } | { ok: false; code: 'NOT_LOGGED' | 'NO_OPENED' };

const at = (a: AttemptFact) => new Date(a.createdAt);

/**
 * The minimum age of the press for a result, or null when the result is not a guarded one. `proofSeconds` is the rule in force's (request Q3b: the door read it once
 * through `readConfirmationRule` and hands it in) and applies to every guarded result; absent = the default per result (`MIN_CALL_MS`).
 */
function minCallMs(result: string, proofSeconds?: number): number | null {
  if (!isNoAnswer(result)) return null;
  return proofSeconds === undefined ? (MIN_CALL_MS as Record<string, number>)[result] ?? null : proofSeconds * 1000;
}

/** The press that is still «the attempt»: hers, no older than her claim, and not followed by any outcome line. */
function latestUnresolvedPress(attempts: readonly AttemptFact[], employeeId: string, claimedAt: Date | null): AttemptFact | null {
  const floor = claimedAt ? claimedAt.getTime() : -Infinity;
  let latest: AttemptFact | null = null;
  for (const a of chronological(attempts)) {
    if (a.result === 'OPENED') {
      if (a.employeeId === employeeId && at(a).getTime() >= floor) latest = a;
    } else if (!NOT_A_CALL.includes(a.result)) {
      latest = null; // an outcome consumes the press — the same press is never spent twice
    }
  }
  return latest;
}

/**
 * May `employeeId` record `result` on this order now? `attempts` are ALL the order's lines (any order, any author — the walk sorts them).
 * A result outside the guarded class (`NO_ANSWER`, `BUSY`, `UNREACHABLE`) is always `ok`, with `guarded: false`.
 */
export function callProofVerdict(input: {
  attempts: readonly AttemptFact[];
  employeeId: string;
  claimedAt: Date | null;
  result: string;
  now: Date;
  /** The rule in force's seconds (request Q3b); absent = the default thirty. */
  proofSeconds?: number;
}): CallProofVerdict {
  const need = minCallMs(input.result, input.proofSeconds);
  if (need === null) return { ok: true, guarded: false, openedAt: null, elapsedSeconds: null };
  const press = latestUnresolvedPress(input.attempts, input.employeeId, input.claimedAt);
  if (!press) return { ok: false, code: 'NO_OPENED' };
  const elapsed = input.now.getTime() - at(press).getTime();
  if (elapsed < need) {
    return { ok: false, code: 'TOO_SOON', waitSeconds: Math.ceil((need - elapsed) / 1000), unlocksAtMs: at(press).getTime() + need };
  }
  return { ok: true, guarded: true, openedAt: at(press), elapsedSeconds: Math.floor(elapsed / 1000) };
}

/**
 * The status door (`contact_result` → «لا يرد»): it is the second half of a pair whose first half — the attempt line — already passed `callProofVerdict`, so it
 * asks only that the order's NEWEST OUTCOME line (presses and messages are walked past) be the caller's own line of the same result, no older than
 * `PAIRED_PRESS_GRACE_MS`. «رقم غلط» also puts the order on «لا يرد» there but is not a guarded result at the attempt door, so for it the walk before the paired
 * line must also hold a press (no waiting — a wrong number is found in seconds, a press is still what proves she dialled).
 */
export function pairedLineVerdict(input: {
  attempts: readonly AttemptFact[];
  employeeId: string;
  claimedAt: Date | null;
  result: string;
  now: Date;
}): PairedLineVerdict {
  const sorted = chronological(input.attempts);
  let idx = -1;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (!NOT_A_CALL.includes(sorted[i].result)) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return { ok: false, code: 'NOT_LOGGED' };
  const last = sorted[idx];
  if (last.employeeId !== input.employeeId || last.result !== input.result || input.now.getTime() - at(last).getTime() > PAIRED_PRESS_GRACE_MS) {
    return { ok: false, code: 'NOT_LOGGED' };
  }
  if (input.result === 'WRONG_NUMBER' && !latestUnresolvedPress(sorted.slice(0, idx), input.employeeId, input.claimedAt)) {
    return { ok: false, code: 'NO_OPENED' };
  }
  return { ok: true };
}

/**
 * What the SCREENS are told about the viewer's «لا يرد» on one order — computed here, on the server, with the same function the door asks, so a screen never
 * decides the rule: it only ticks `unlocksAtMs` against the server clock.
 */
export function callProofState(input: { attempts: readonly AttemptFact[]; employeeId: string; claimedAt: Date | null; now: Date; proofSeconds?: number }): CallProofState {
  const v = callProofVerdict({ ...input, result: 'NO_ANSWER' });
  if (v.ok) return { state: 'READY', unlocksAtMs: null };
  return v.code === 'NO_OPENED' ? { state: 'NO_OPENED', unlocksAtMs: null } : { state: 'WAIT', unlocksAtMs: v.unlocksAtMs };
}
