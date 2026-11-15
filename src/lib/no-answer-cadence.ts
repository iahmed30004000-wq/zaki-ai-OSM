import { zonedParts, zonedTimeToInstant } from './business-calendar';
import { NO_ANSWER_RESULTS } from './confirmation-workflow';
import type { AttemptFact } from './no-answer-rounds';
import { verdictFromCount, type DueVerdict } from './work-first';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «جدول المحاولات» — THE FIVE-ATTEMPT PLAN FOR A «لا يرد», AS ONE PURE RULE (Confirmation Center v2, step B)
 *
 * Behind the same switch as step A (`Company.settings.callProofAndCadence`, read by `no-answer-cadence-switch.ts`), OFF unless plainly on. Nothing here reads a database, a
 * clock of its own or a framework, and no screen imports it: the door, the desk and the tests all go through `cadenceStep`, and the desk gets strings.
 *
 * ── THE PLAN (the owner's text, wall clock in the COUNTRY's timezone, no weekend skipping, no dependence on working hours) ──
 *
 *   #1  now                                  → #2 is due 30 minutes later (elapsed time: it crosses midnight)
 *   #2  from its due on                      → #3 is due 2 hours later (elapsed time, so a DST jump inside the two hours does not move it)
 *   #3  from its due on                      → #4 is due at 09:00 of the NEXT local calendar day  (window «بين 9 و12»)
 *   #4  from its due on                      → #5 is due at the first 18:00 STRICTLY after #4     (window «بين 6 و10 مساءً»)
 *   #5  → with attempts on two local days or more, the fifth COUNTED press closes the order (the door does that, `endOrder`; here it is `cadenceCloses`).
 *
 * The windows' ends (12:00, 22:00) are WORDING only: nothing expires. A due that was missed stays pullable (overdue) and never turns into an attempt by itself.
 *
 * ── WHAT COUNTS (D1) ──
 *
 * A line whose result is in `NO_ANSWER_RESULTS` (NO_ANSWER · BUSY · UNREACHABLE), from ANY employee, logged STRICTLY AFTER the switch went on (`since` — nothing logged before it
 * moves an order). The first one always counts. A later one counts only when its time is at or after the due the previous COUNTED one set — a press at the due to the millisecond
 * counts, one millisecond before does not. An early press is kept on the order, shown, and never counted: the state, and therefore the due, does not move. A call that REACHED
 * somebody (ANSWERED, CALLBACK_REQUESTED, …) is not an attempt and does not reset the plan. A sixth press after the fifth never counts.
 *
 * ONE function decides all of it — `cadenceStep` — folded over the order's lines (`cadenceState`) in the order the door decided them (`attemptNumber`, then time), so a replay of the
 * rows equals the door's decision even when two app instances' clocks disagree by a moment.
 *
 * NOTHING HERE TOUCHES MONEY, ORDER CREATION OR A CONTRACT.
 * ═══════════════════════════════════════════════════════════════════════
 */

/** Five counted attempts — the cadence's limit (`NO_ANSWER_LIMIT` in `confirmation-workflow.ts` stays 3: that is the switch-off rule). */
export const CADENCE_LIMIT = 5;
/** The fifth attempt closes the order only across this many different local days. */
export const CADENCE_MIN_DAYS = 2;
/** Elapsed time, not wall-clock: after the first attempt and after the second. */
export const CADENCE_GAPS_MS = { afterFirst: 1_800_000, afterSecond: 7_200_000 } as const;
/** The fourth attempt: from `from`:00 of the next local day (the window's end is wording). */
export const CADENCE_MORNING = { from: 9, to: 12 } as const;
/** The fifth attempt: from the first `from`:00 after the fourth (the window's end is wording). */
export const CADENCE_EVENING = { from: 18, to: 22 } as const;

/** What the plan needs of the world: the floor (the switch's `enabledAt`) and the Country's timezone. */
export interface CadenceCal {
  since: Date;
  timeZone: string;
}

/** Where an order stands in the plan: the COUNTED attempts, how many different local days they fall on, and when the next one counts (null before the first and after the fifth). */
export interface CadenceState {
  counted: readonly Date[];
  days: number;
  dueAt: Date | null;
}

export const CADENCE_START: CadenceState = Object.freeze({ counted: Object.freeze([]) as readonly Date[], days: 0, dueAt: null });

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** The local calendar day of an instant in the Country's timezone, as `yyyy-mm-dd`. (Not `localDayKey`: that name belongs to `local-day.ts`.) */
function dayKey(at: Date, timeZone: string): string {
  const p = zonedParts(at, timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/**
 * From when the NEXT attempt counts, given that `counted` attempts are done and the last counted one was at `at`.
 * An invalid IANA zone throws RangeError from Intl, exactly as `workClock` does for the rounds: the door lets its transaction fail rather than guess.
 */
function dueAfter(counted: 1 | 2 | 3 | 4, at: Date, timeZone: string): Date {
  if (counted === 1) return new Date(at.getTime() + CADENCE_GAPS_MS.afterFirst);
  if (counted === 2) return new Date(at.getTime() + CADENCE_GAPS_MS.afterSecond);
  const p = zonedParts(at, timeZone);
  if (counted === 3) {
    // 09:00 local of the day AFTER the third attempt's local day. `Date.UTC` carries month and year ends; it is never the same day.
    const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
    return zonedTimeToInstant(timeZone, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), CADENCE_MORNING.from, 0);
  }
  // counted 4: the first 18:00 local STRICTLY after the fourth attempt — today's if it is still ahead, else tomorrow's.
  const today = zonedTimeToInstant(timeZone, p.year, p.month, p.day, CADENCE_EVENING.from, 0);
  if (today.getTime() > at.getTime()) return today;
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return zonedTimeToInstant(timeZone, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), CADENCE_EVENING.from, 0);
}

/**
 * THE ONE RULE: does a no-answer press at `at` count, and where does the plan stand after it? The result class is the caller's to check (`cadencePress` does). Never mutates its input.
 *
 * Not counted: an invalid time, a time at or before the floor (`since`: «strictly after», the pool's `createdAt gt since`), a plan already complete, a press BEFORE the due the last
 * counted one set (early — kept, shown, the state unmoved). Counted: everything else; the first counted press counts however late after `since`.
 */
export function cadenceStep(state: CadenceState, at: Date, cal: CadenceCal): { next: CadenceState; counted: boolean } {
  const t = at.getTime();
  if (Number.isNaN(t) || !(t > cal.since.getTime())) return { next: state, counted: false };
  if (state.counted.length >= CADENCE_LIMIT) return { next: state, counted: false };
  if (state.counted.length > 0 && state.dueAt !== null && t < state.dueAt.getTime()) return { next: state, counted: false };
  const times = [...state.counted, at];
  const days = new Set(times.map((d) => dayKey(d, cal.timeZone))).size;
  const dueAt = times.length >= CADENCE_LIMIT ? null : dueAfter(times.length as 1 | 2 | 3 | 4, at, cal.timeZone);
  return { next: { counted: times, days, dueAt }, counted: true };
}

/** An order's plan from its lines: only the no-answer ones, in the order the door decided them (`attemptNumber`, then time), folded through `cadenceStep`. */
export function cadenceState(facts: readonly AttemptFact[], cal: CadenceCal): CadenceState {
  const at = (f: AttemptFact): number => new Date(f.createdAt).getTime();
  const lines = facts
    .filter((f) => (NO_ANSWER_RESULTS as readonly string[]).includes(f.result) && !Number.isNaN(at(f)))
    .sort((a, b) => (a.attemptNumber ?? 0) - (b.attemptNumber ?? 0) || at(a) - at(b));
  let state = CADENCE_START;
  for (const f of lines) state = cadenceStep(state, new Date(f.createdAt), cal).next;
  return state;
}

/**
 * Is the plan complete — five counted attempts across at least two local days? Under the plan the second clause cannot fail (the fourth is due on a later local day than the third,
 * which is not before the first's), so it is a guard, not a gate. Asked of the state AFTER a press, counted or not: a sixth no-answer after a refused close asks again.
 */
export function cadenceCloses(state: CadenceState): boolean {
  return state.counted.length >= CADENCE_LIMIT && state.days >= CADENCE_MIN_DAYS;
}

/**
 * THE DOOR'S QUESTION. `stored` is the order's lines BEFORE the new one (the door reads before it writes); `press` is the new line. Returns whether it counts, the due the LINE stores
 * (`dueAt`: a due only for a counted press that is not the fifth — null for an early press, for the fifth and for a result that is not a no-answer), the state after, and whether that
 * state closes the order.
 */
export function cadencePress(
  stored: readonly AttemptFact[],
  press: { at: Date; result: string },
  cal: CadenceCal
): { counted: boolean; dueAt: Date | null; next: CadenceState; closes: boolean } {
  const before = cadenceState(stored, cal);
  if (!(NO_ANSWER_RESULTS as readonly string[]).includes(press.result)) return { counted: false, dueAt: null, next: before, closes: false };
  const { next, counted } = cadenceStep(before, press.at, cal);
  return { counted, dueAt: counted ? next.dueAt : null, next, closes: cadenceCloses(next) };
}

/**
 * WHEN THE NEXT ATTEMPT COUNTS, in the agent's words. `nextSlot` is its number (2…5); the day word is «بكرة» when the due is on the next local day. Western digits. The windows' ends
 * (12, 22) come from the constants and are wording only.
 */
export function cadenceWhen(nextSlot: number, dueAt: Date, now: Date, timeZone: string): string {
  const p = zonedParts(dueAt, timeZone);
  const q = zonedParts(now, timeZone);
  const gap = Math.round((Date.UTC(p.year, p.month - 1, p.day) - Date.UTC(q.year, q.month - 1, q.day)) / 86_400_000);
  const day = gap >= 1 ? 'بكرة ' : '';
  if (nextSlot === 4) return `${day}بين ${CADENCE_MORNING.from} و${CADENCE_MORNING.to}`;
  if (nextSlot === 5) return `${day}بين ${CADENCE_EVENING.from - 12} و${CADENCE_EVENING.to - 12} مساءً`;
  return `${day}الساعة ${pad2(p.hour)}:${pad2(p.minute)}`;
}

/**
 * WHAT THE PRESS TOLD HER — the sentence the desk prints after a no-answer line (`cadence.words` in the POST answer). `attempt` is the COUNTED number after the press and `dueAt` the
 * state's due after it (also for an early press, which does not move it). The closing press is spoken by the desk's own «أُغلق الطلب … تلقائياً» sentence first; `closed` is for other callers.
 */
export function cadencePressWords(a: { counted: boolean; closed: boolean; released: boolean; attempt: number; dueAt: Date | null; now: Date; timeZone: string }): string {
  const next = a.attempt + 1;
  if (a.closed) return `انحسبت المحاولة ${a.attempt} من ${CADENCE_LIMIT} — أُغلق الطلب تلقائياً وراح على قائمة «ملغاة سابقاً».`;
  if (a.counted) {
    if (a.dueAt) {
      const when = cadenceWhen(next, a.dueAt, a.now, a.timeZone);
      return a.released
        ? `انحسبت المحاولة ${a.attempt} من ${CADENCE_LIMIT} — رجع الطلب للطابور، والمحاولة الجاية ${when}.`
        : `انحسبت المحاولة ${a.attempt} من ${CADENCE_LIMIT} — المحاولة الجاية ${when}.`;
    }
    return `انحسبت المحاولة ${CADENCE_LIMIT} من ${CADENCE_LIMIT} — الطلب لسا مفتوح، والضغطة الجاية بتجرّب تسكّره من جديد.`;
  }
  if (a.dueAt) return `سجّلنا الضغطة بس ما انحسبت محاولة — لسا بدري. المحاولة ${next} من ${CADENCE_LIMIT} بتنحسب ${cadenceWhen(next, a.dueAt, a.now, a.timeZone)}.`;
  return a.attempt >= CADENCE_LIMIT ? 'اكتملت المحاولات الخمس — الضغطة انسجّلت بس ما انحسبت.' : 'انسجّلت الضغطة بس ما انحسبت محاولة.';
}

// ───────────────────────────── the desk («طلباتي») ─────────────────────────────

/**
 * WHERE ONE HELD ORDER STANDS, for her desk, on the SERVER's clock. `counted` is the number the card shows (and the close counts); `due` is «a call is owed now» (the due arrived —
 * a due exactly NOW is due, the mirror of the pool's `gt`); `waiting` is «counted, due still ahead»; `closesOnNext` is «a press made now would close it» — the very step the door runs.
 * A fact at the moment of the read: the desk has no timer.
 */
export function cadenceDesk(
  facts: readonly AttemptFact[],
  cal: CadenceCal,
  now: Date
): { counted: number; dueAt: Date | null; due: boolean; waiting: boolean; closesOnNext: boolean } {
  const s = cadenceState(facts, cal);
  const counted = s.counted.length;
  const ahead = counted >= 1 && s.dueAt !== null;
  return {
    counted,
    dueAt: s.dueAt,
    due: ahead && s.dueAt!.getTime() <= now.getTime(),
    waiting: ahead && s.dueAt!.getTime() > now.getTime(),
    closesOnNext: cadenceCloses(cadenceStep(s, now, cal).next),
  };
}

/**
 * The «الشغل أول» verdict of one held order under the plan, in the shape `deskTab` / `summariseDue` / `dueNow` already read (so `work-first.ts` is not edited): no counted attempt yet
 * → by the order's own attempt count (a NEW order is due NEW; an order with only «اتصال» lines, or only lines from before the switch, is not due and lands by its count); the due arrived →
 * «ROUND»; the due ahead → waiting; a plan complete and still open (five counted, a close that did not go through) → not due and not waiting, so it stays in «بانتظار» by its count.
 * The order's own dates are NOT read — parity with the rounds-off desk (`verdictFromCount`); the holder's own date releases the order anyway. One exception, and only when handed over:
 * the rounds' PROMISE («الزبون طلب نكلمو هلّق», RV2392) comes first — the customer named the time.
 */
export function cadenceVerdict(
  desk: Pick<ReturnType<typeof cadenceDesk>, 'counted' | 'due' | 'waiting' | 'dueAt'>,
  attemptCount: number,
  rounds: DueVerdict | null = null
): DueVerdict {
  // `rounds` is the rounds' own answer for this order, handed over only when «نظام الجولات» is on too. ONE word of it is taken — PROMISE (a date arrived, nothing logged since) — and it
  // outranks the plan: the customer asked for this call. ROUND / NEW / waiting from the rounds are never used (the plan speaks, and never says «جولة»).
  if (rounds?.reason === 'PROMISE') return rounds;
  if (desk.counted === 0) return verdictFromCount(attemptCount);
  if (desk.due) return { due: true, reason: 'ROUND', waiting: false, dueAt: null };
  if (desk.waiting) return { due: false, reason: null, waiting: true, dueAt: desk.dueAt };
  return { due: false, reason: null, waiting: false, dueAt: null };
}

/**
 * THE LINE A HELD CARD PRINTS, written here so the screen decides nothing: «لا يرد راجع — محاولة 3 من 5» when the due arrived, «محاولة 2 من 5 — جاهز الساعة 17:30» while it waits.
 * Null for an order with no counted attempt (a NEW order keeps «جديد — سحبتيه هلّق») and for a complete plan: the caller falls back to `dueLabel`, which has nothing to say for those.
 */
export function cadenceCardWords(desk: Pick<ReturnType<typeof cadenceDesk>, 'counted' | 'due' | 'waiting' | 'dueAt'>, now: Date, timeZone: string): string | null {
  if (desk.counted < 1 || desk.counted >= CADENCE_LIMIT) return null;
  const next = desk.counted + 1;
  if (desk.due) return `لا يرد راجع — محاولة ${next} من ${CADENCE_LIMIT}`;
  if (desk.waiting && desk.dueAt) return `محاولة ${next} من ${CADENCE_LIMIT} — جاهز ${cadenceWhen(next, desk.dueAt, now, timeZone)}`;
  return null;
}
