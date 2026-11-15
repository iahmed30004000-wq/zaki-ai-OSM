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
 * ── THE PLAN (the owner's text and the planner's rulings of 15/11; wall clock in the COUNTRY's timezone) ──
 *
 *   #1  now                                  → #2 is due 30 minutes later (elapsed time: it crosses midnight)
 *   #2  from its due on                      → #3 is due 2 hours later (elapsed time, so a DST jump inside the two hours does not move it)
 *   #3  from its due on                      → #4 is due at 10:00 local on the first WORKING day, and not before 8 HOURS (elapsed; exactly 8 counts) after #3
 *   #4  from its due on                      → #5 is due at the first 18:00 local STRICTLY after #4 on a working day, and not before 3 HOURS (elapsed) after #4
 *   #5  → with attempts on two local days or more, the fifth COUNTED press closes the order (the door does that, `endOrder`; here it is `cadenceCloses`).
 *
 * REST DAYS are the Country's `weekendDays` (0 = Sunday … 6), read through `cadenceCalOf`; an empty list skips nothing. They move the two day-anchored dues only (#4's day, #5's day):
 * never the 30-minute and 2-hour gaps, which are elapsed time from a real press. #4's clock is the planner's 10:00 — a constant, NOT the Country's `workHoursStart` — and #5's is 18:00.
 * The 8 h floor makes #4 land on the next local day for a #3 pressed after 02:00 (a #3 at 02:00:00.000 waits 8 h, 02:00:00.001 waits 32 h): the literal «at least 8 hours», not a bug.
 *
 * FIVE ATTEMPTS OVER TWO LOCAL DAYS stays true on a 25-hour DST day through a guard: #4 never lands on the local day of #1 (the next working-day start strictly after it is taken instead).
 *
 * A due that was missed stays pullable (overdue) and never turns into an attempt by itself. The desk REPLAYS the stored lines with the CURRENT settings while the pool reads the due
 * STORED on the line, so changing the Country's rest days while the key is on can make the two disagree for orders in flight, until their next press.
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
/** Minimum ELAPSED time before the 4th / 5th may count: 8 h after #3 (planner 15/11, ruling 4), 3 h after #4 (ruling 3). */
export const CADENCE_FLOORS_MS = { beforeFourth: 28_800_000, beforeFifth: 10_800_000 } as const;
/** #4's clock: the planner's 10:00 — a constant, never the Country's `workHoursStart`. */
export const CADENCE_WORKDAY_START = '10:00';
/** #5's anchor: 18:00 local, on a working day. */
export const CADENCE_EVENING_FROM = '18:00';

/** What the plan needs of the world: the floor (the switch's `enabledAt`), the Country's timezone and the Country's rest days. */
export interface CadenceCal {
  since: Date;
  timeZone: string;
  /** Country `weekendDays` (0 = Sunday … 6) — the local days no #4 / #5 due lands on. Absent or empty → none skipped. */
  restDays?: readonly number[];
}

/**
 * THE ONE BUILDER of the plan's world — the door and the desk both call it, so they can never disagree about the calendar. Only the Country's timezone and rest days are read:
 * #4's clock is `CADENCE_WORKDAY_START` (the planner's fixed 10:00), never the country's `workHoursStart` (it must not silently become 09:00 because a row still says so).
 */
export function cadenceCalOf(since: Date, country: { timezone: string; weekendDays?: readonly number[] | null }): CadenceCal {
  return { since, timeZone: country.timezone, restDays: country.weekendDays ?? undefined };
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

const DAY_MS = 86_400_000;

/** A wall clock «HH:mm» of the plan's own constants, as the two numbers `zonedTimeToInstant` takes. */
const clockOf = (hhmm: string): { hour: number; minute: number } => ({ hour: Number(hhmm.slice(0, 2)), minute: Number(hhmm.slice(3)) });

/** The rest days as a set: whatever is not a weekday number is ignored; no days, or all seven (nowhere to skip to), skip nothing. */
function restSet(days: readonly number[] | undefined): ReadonlySet<number> {
  const set = new Set((days ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6));
  return set.size >= 7 ? new Set<number>() : set;
}

/**
 * The first instant at which the local clock reads `clock` on a day that is not a rest day, at or after `from` (STRICTLY after it when `strict`). Calendar arithmetic on a UTC cursor over
 * the local dates, so a month end, a year end or a DST shift never moves it, and a skipped day costs no Intl call. An invalid IANA zone throws RangeError from Intl, as everywhere here.
 */
function firstClockOnWorkday(from: Date, clock: { hour: number; minute: number }, rest: ReadonlySet<number>, strict: boolean, timeZone: string): Date {
  const p = zonedParts(from, timeZone);
  let day = Date.UTC(p.year, p.month - 1, p.day);
  // At most 8 are ever needed: the day of `from`, then at most six rest days, then one workday. Sixteen is the bound that cannot be reached.
  for (let i = 0; i < 16; i++, day += DAY_MS) {
    const d = new Date(day);
    if (rest.has(d.getUTCDay())) continue;
    const at = zonedTimeToInstant(timeZone, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), clock.hour, clock.minute);
    if (strict ? at.getTime() > from.getTime() : at.getTime() >= from.getTime()) return at;
  }
  throw new RangeError('cadence: no working day within 16 days');
}

/**
 * From when the NEXT attempt counts. `times` are the COUNTED attempts INCLUDING the one being decided (1…4 of them); the last is the one the due follows.
 * An invalid IANA zone throws RangeError from Intl, exactly as `workClock` does for the rounds: the door lets its transaction fail rather than guess.
 */
function dueAfter(times: readonly Date[], cal: CadenceCal): Date {
  const counted = times.length;
  const at = times[counted - 1];
  if (counted === 1) return new Date(at.getTime() + CADENCE_GAPS_MS.afterFirst);
  if (counted === 2) return new Date(at.getTime() + CADENCE_GAPS_MS.afterSecond);
  const rest = restSet(cal.restDays);
  if (counted === 3) {
    // 10:00 local on the first working day at least 8 hours (elapsed) after #3 — `>=`: exactly 8 hours counts.
    const start = clockOf(CADENCE_WORKDAY_START);
    const due = firstClockOnWorkday(new Date(at.getTime() + CADENCE_FLOORS_MS.beforeFourth), start, rest, false, cal.timeZone);
    // The first-day guard: five attempts over two local days must stay true on a 25-hour DST day, so #4 is never on #1's local day (only a lengthened day can ever do that).
    return dayKey(due, cal.timeZone) === dayKey(times[0], cal.timeZone) ? firstClockOnWorkday(due, start, rest, true, cal.timeZone) : due;
  }
  // counted 4: the first 18:00 local STRICTLY after #4 on a working day, but never less than 3 hours (elapsed) after it.
  const evening = firstClockOnWorkday(at, clockOf(CADENCE_EVENING_FROM), rest, true, cal.timeZone);
  const floor = new Date(at.getTime() + CADENCE_FLOORS_MS.beforeFifth);
  return evening.getTime() >= floor.getTime() ? evening : floor;
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
  const dueAt = times.length >= CADENCE_LIMIT ? null : dueAfter(times, cal);
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
 * Is the plan complete — five counted attempts across at least two local days? Under the plan the second clause cannot fail (the fourth is never due on the first's local day: the
 * guard in `dueAfter`, which only a 25-hour DST day ever needs), so it is a guard, not a gate. Asked of the state AFTER a press, counted or not: a sixth no-answer after a refused close asks again.
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

const WEEKDAY_AR = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'] as const;

/**
 * WHEN THE NEXT ATTEMPT COUNTS, in the agent's words — the REAL due, one format for all four dues (there are no windows any more: after the 8 h and 3 h floors a window could lie, a #5 due at
 * 20:55 read «بين 6 و10»). «الساعة 10:00» when it is today, «بكرة الساعة 18:00» tomorrow, and the weekday's name — «السبت الساعة 10:00» — when rest days put it two days or more away
 * («بعد بكرة» is ambiguous, so it is not used). Western digits.
 */
export function cadenceWhen(dueAt: Date, now: Date, timeZone: string): string {
  const p = zonedParts(dueAt, timeZone);
  const q = zonedParts(now, timeZone);
  const gap = Math.round((Date.UTC(p.year, p.month - 1, p.day) - Date.UTC(q.year, q.month - 1, q.day)) / DAY_MS);
  const day = gap <= 0 ? '' : gap === 1 ? 'بكرة ' : `${WEEKDAY_AR[p.weekday]} `;
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
      const when = cadenceWhen(a.dueAt, a.now, a.timeZone);
      return a.released
        ? `انحسبت المحاولة ${a.attempt} من ${CADENCE_LIMIT} — رجع الطلب للطابور، والمحاولة الجاية ${when}.`
        : `انحسبت المحاولة ${a.attempt} من ${CADENCE_LIMIT} — المحاولة الجاية ${when}.`;
    }
    return `انحسبت المحاولة ${CADENCE_LIMIT} من ${CADENCE_LIMIT} — الطلب لسا مفتوح، والضغطة الجاية بتجرّب تسكّره من جديد.`;
  }
  if (a.dueAt) return `سجّلنا الضغطة بس ما انحسبت محاولة — لسا بدري. المحاولة ${next} من ${CADENCE_LIMIT} بتنحسب ${cadenceWhen(a.dueAt, a.now, a.timeZone)}.`;
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
  if (desk.waiting && desk.dueAt) return `محاولة ${next} من ${CADENCE_LIMIT} — جاهز ${cadenceWhen(desk.dueAt, now, timeZone)}`;
  return null;
}

/**
 * THE CLOSED-TODAY CARD'S WORDS WHEN ITS COUNT IS NOT THE CLOSE'S (RV2391, the planner's ruling 9). The card prints «ما ردّ N مرّات» / «أُغلق بعد N محاولات» only when the count reached
 * the limit the desk reads under — otherwise the order was closed by the OTHER mode on the day the switch flipped (a legacy 3-rule close read under the plan counts 0 of 5) and a number would lie.
 * Null = print the numbers as always; a string = print this instead (server-written, no number). Here and not in `no-answer-tone.ts`: the screen is barred from importing this file, so the sentence cannot leak into its bundle.
 */
export const CLOSED_WITHOUT_COUNT_WORDS = 'بعد عدّة محاولات بلا رد';
export function closedCardWords(count: number, limit: number): string | null {
  return count >= limit ? null : CLOSED_WITHOUT_COUNT_WORDS;
}
