import { zonedParts, zonedTimeToInstant } from './business-calendar';
import { NO_ANSWER_RESULTS } from './confirmation-workflow';
import { attemptWords, nextAttemptWords } from './attempt-words';
import { CONFIRMATION_RULE } from './confirmation-rule';
import type { RuleStep } from './confirmation-rule-settings';
import { parseHhMm } from './employee-shift';
import type { AttemptFact } from './no-answer-rounds';
import { DUE_PROMISE, promiseArrived, verdictFromCount, type DueOrder, type DueVerdict } from './work-first';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «جدول المحاولات» — THE FIVE-ATTEMPT PLAN FOR A «لا يرد», AS ONE PURE RULE (Confirmation Center v2, step B)
 *
 * Behind the same switch as step A (`Company.settings.callProofAndCadence`, read by `no-answer-cadence-switch.ts`), OFF unless plainly on. Nothing here reads a database, a
 * clock of its own or a framework, and no screen imports it: the door, the desk and the tests all go through `cadenceStep`, and the desk gets strings.
 *
 * ── THE PLAN (the owner's text and the planner's rulings of 15/11; wall clock in the COUNTRY's timezone) ──
 *
 *   #1  now                                  → #2 is due 30 minutes later (elapsed time), brought INSIDE WORK TIME (below)
 *   #2  from its due on                      → #3 is due 2 hours later (elapsed time, so a DST jump inside the two hours does not move it), brought inside work time the same way
 *   #3  from its due on                      → #4 is due at the MORNING ANCHOR (11:00 clamped into [start, end − 1 h]; request C2 — it was the start of work) on the first WORKING day, and not before 8 HOURS (elapsed; exactly 8 counts) after #3
 *   #4  from its due on                      → #5 is due at the first EVENING ANCHOR (below; min(19:30, end − 1 h) since request C2) local STRICTLY after #4 on a working day, and not before 3 HOURS (elapsed) after #4 — always inside work time
 *   #5  → with attempts on two local days or more, the fifth COUNTED press closes the order (the door does that, `endOrder`; here it is `cadenceCloses`).
 *
 * WORK TIME (the planner's ruling 12 of 15/11 — «no work after 22:00») is a working day (not one of the Country's rest days) AND a local clock in [workHoursStart, workHoursEnd): the end is
 * EXCLUSIVE, a raw due exactly at the start is inside. The raw due of #2 and #3 (the previous COUNTED press + 30 min / + 2 h, elapsed) that falls outside it becomes the FIRST COMING
 * workHoursStart on a working day at or after it: before the start on a working day → that day's start; at or after the end, or on a rest day → the next working day's start.
 * `cadenceWorkWindow` is the ONE place that reads the two hours, with its fallbacks (10:00 and 22:00).
 *
 * REST DAYS are the Country's `weekendDays` (0 = Sunday … 6), read through `cadenceCalOf`; an empty list skips nothing. They move every day-anchored due — #2 and #3 through «work time», #4 and
 * #5 through their own day — but never the elapsed gaps themselves: a due that lands inside work time is exactly press + 30 min / + 2 h.
 * #4's clock is the Country's `workHoursStart` (ruling 1; 10:00 when the row has none). #5's clock is the EVENING ANCHOR (the planner's ruling 16 of 15/11 22:30, option «ب»):
 * `min(18:00, workHoursEnd − 1 hour)` in the Country's local clock — Syria (10:00-22:00) stays 18:00, Jordan (09:00-17:00) becomes 16:00 — and never before `workHoursStart` (a window shorter than an
 * hour, or one that starts after 18:00, would otherwise put the anchor outside it: then the anchor IS the start). #5 = max(first anchor STRICTLY after #4 on a working day, #4 + 3 h elapsed); if that
 * is outside work time (at or after `workHoursEnd` — the end is exclusive — before the start, or on a rest day) it becomes the anchor of the FIRST WORKING DAY after it instead, so #5 is always
 * inside [workHoursStart, workHoursEnd) on a working day. A country with no readable hours has the fallbacks (10:00-22:00), so its anchor is 18:00.
 * The 8 h floor still makes #4 land on the next local day for a #3 that was PRESSED after 02:00 (the due of #3 is inside work time, but a press may come at any hour): a #3 at 02:00:00.000
 * waits 8 h for a 10:00 start, 02:00:00.001 waits 32 h — the literal «at least 8 hours», not a bug.
 *
 * FIVE ATTEMPTS OVER TWO LOCAL DAYS holds on a 25-hour DST day through a guard: #4 never lands on the local day of #1 (the next working-day start strictly after it is taken instead). With #2 and #3
 * inside work time #4 is always on a later day than #1 by construction (#3 is not before the start of work, so #3 + 8 h is after that day's start), so the guard cannot fire through the steps any
 * more; it stays — the planner confirmed it (ruling 4 of 15/11) — as defence in depth for a state that did not come from them.
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

/*
 * ── REQUEST C2 (18/11): THE NUMBERS ARE THE ONE RULE SET'S (`confirmation-rule.ts`), AND #4 / #5 HAVE NEW ANCHORS ──
 *
 * Every figure below is read from `CONFIRMATION_RULE` (no caller changed its import). Two clocks moved, by the owner's plan of 17/11 (§3.1, the answer rate by hour):
 *   · #4 is due at the MORNING ANCHOR (`cadenceMorningAnchor`) = 11:00 clamped into the Country's window [start, end − 1 h] — it was the start of work;
 *   · #5 is due at the EVENING ANCHOR (`cadenceEveningAnchor`) = min(19:30, end − 1 h), raised to the start — it was min(18:00, end − 1 h).
 * #2 and #3, the floors, the day guard, the close and the counting are unchanged. And HISTORY KEEPS ITS VERDICTS: when the lines are folded (`cadenceState`), the due a
 * counted line STORED (`nextFollowUpAt`, which the door writes on every counted press but the fifth) is the due the next line is checked against; the anchors are only
 * computed for a line that stored none (or a fact that does not carry the field). So every press written before C2 replays to the very state it had.
 */

/*
 * ── REQUEST Q3b (19/11): THE PLAN READS THE RULE IT IS GIVEN ──
 *
 * The numbers below are now the DEFAULT rule's. The rule in force — the owner's stored edit, read ONCE per door or job through `readConfirmationRule`
 * (`confirmation-rule-settings.ts`) — travels in the calendar (`CadenceCal.rule`, put there by `cadenceCalOf`), and every step reads it from there:
 *   · attempts = steps + 1 (`cadenceLimit`), the close needs `minDays`;
 *   · the due after the k-th counted press is the k-th STEP: `after` = that many minutes (elapsed) brought inside work time — the old #2 / #3 rule; an `anchor` step
 *     keeps the algorithm its anchor always had: `morning` = the morning clock on the first working day at least `floorHours` after (with the first-day guard) — the
 *     old #4; `evening` = the first evening clock strictly after, but never before `floorHours`, moved to the next working day's evening when outside work time — the
 *     old #5. The morning / evening clocks are the rule's, clamped into the window as before.
 * A calendar without a rule (a hand-built one, a test) answers by the default — so the default steps reproduce the old five attempts cell for cell
 * (`the-rule-engine-equals-main.test.ts` against a frozen golden of `osm/main`).
 * Stored dues are never rewritten: the fold keeps the due a line STORED, so a rule changed while an order is mid-cycle judges only the NEXT press.
 */

/** What the plan reads of the rule — the steps, the days, the two clocks (the fields of `ConfirmationRuleNumbers` it needs; a whole rule fits). */
export interface CadenceRule {
  steps: readonly RuleStep[];
  minDays: number;
  morning: string;
  evening: string;
}

/** The counted attempts that complete a rule's plan: its steps and the first press. */
export function cadenceLimit(rule: CadenceRule = CADENCE_RULE_DEFAULT): number {
  return rule.steps.length + 1;
}

/** Five counted attempts — the DEFAULT cadence's limit (`NO_ANSWER_LIMIT` in `confirmation-workflow.ts` stays 3: that is the switch-off rule). The rule in force: `cadenceLimit`. */
export const CADENCE_LIMIT = CONFIRMATION_RULE.attempts;
/** The fifth attempt closes the order only across this many different local days. */
export const CADENCE_MIN_DAYS = CONFIRMATION_RULE.minDays;
/** Elapsed time, not wall-clock: after the first attempt and after the second. */
export const CADENCE_GAPS_MS = {
  afterFirst: CONFIRMATION_RULE.gapsMinutes.afterFirst * 60_000,
  afterSecond: CONFIRMATION_RULE.gapsMinutes.afterSecond * 60_000,
} as const;
/** Minimum ELAPSED time before the 4th / 5th may count: 8 h after #3 (planner 15/11, ruling 4), 3 h after #4 (ruling 3). */
export const CADENCE_FLOORS_MS = {
  beforeFourth: CONFIRMATION_RULE.floorsHours.beforeFourth * 3_600_000,
  beforeFifth: CONFIRMATION_RULE.floorsHours.beforeFifth * 3_600_000,
} as const;
/**
 * Today's rule as the plan reads it — from the default figures above (themselves the one rule set's), so it can never drift from `CONFIRMATION_RULE_DEFAULT` (a test pins
 * the equality). The old #2 · #3 · #4 · #5 are its four steps.
 */
export const CADENCE_RULE_DEFAULT: CadenceRule = Object.freeze({
  steps: Object.freeze([
    Object.freeze({ kind: 'after', minutes: CADENCE_GAPS_MS.afterFirst / 60_000 }),
    Object.freeze({ kind: 'after', minutes: CADENCE_GAPS_MS.afterSecond / 60_000 }),
    Object.freeze({ kind: 'anchor', anchor: 'morning', floorHours: CADENCE_FLOORS_MS.beforeFourth / 3_600_000 }),
    Object.freeze({ kind: 'anchor', anchor: 'evening', floorHours: CADENCE_FLOORS_MS.beforeFifth / 3_600_000 }),
  ]) as readonly RuleStep[],
  minDays: CADENCE_MIN_DAYS,
  morning: CONFIRMATION_RULE.morning,
  evening: CONFIRMATION_RULE.evening,
});

/** The start of work when the Country's `workHoursStart` is missing or unreadable (the planner's 10:00; Syria's live row becomes 10:00-22:00). #4 is due at the start. */
export const CADENCE_WORKDAY_START = '10:00';
/** The end of work (exclusive) when the Country's `workHoursEnd` is missing or unreadable: «no work after 22:00» (planner, ruling 12 of 15/11). */
export const CADENCE_WORKDAY_END = '22:00';
/** The CAP of #5's evening anchor: 19:30 local since request C2 (it was 18:00), on a working day — the anchor is `min(19:30, workHoursEnd − 1 hour)` (see `cadenceEveningAnchor`). */
export const CADENCE_EVENING_FROM = CONFIRMATION_RULE.evening;
/** #4's clock since request C2: 11:00 local (it was the start of work), clamped into the window — see `cadenceMorningAnchor`. */
export const CADENCE_MORNING_AT = CONFIRMATION_RULE.morning;
/** The anchor stays this long before the end of work (planner, ruling 16): one hour. */
const EVENING_BEFORE_END_MIN = 60;

/** What the plan needs of the world: the floor (the switch's `enabledAt`), the Country's timezone, rest days and work hours. */
export interface CadenceCal {
  since: Date;
  timeZone: string;
  /** Country `weekendDays` (0 = Sunday … 6) — the local days that are not work days. Absent or empty → none skipped. */
  restDays?: readonly number[];
  /** Country `workHoursStart` / `workHoursEnd` («HH:mm», local) — read through `cadenceWorkWindow`, which falls back to 10:00 / 22:00. Absent → the fallbacks. */
  workHoursStart?: string | null;
  workHoursEnd?: string | null;
  /** The rule in force (request Q3b) — absent = the default rule (`CADENCE_RULE_DEFAULT`). The doors put it here through `cadenceCalOf`. */
  rule?: CadenceRule;
}

/** The rule a calendar carries, or the default. */
const ruleOf = (cal: CadenceCal): CadenceRule => cal.rule ?? CADENCE_RULE_DEFAULT;

/**
 * THE WORK WINDOW of a local day — the ONE place the Country's two hours are read. Each value goes through the existing `parseHhMm` (`employee-shift.ts`); one that is missing or
 * unreadable falls back to its own constant (10:00 / 22:00). Then, if the end is not AFTER the start — an overnight shift («22:00-06:00»), equal hours, or garbage on one side — BOTH ends fall back
 * to the constants: a window that wraps midnight has no meaning for a plan that is due «inside work time», and half of one would be worse than none.
 * A value that is present but unreadable, or a pair that falls back, ALSO emits one `console.warn` per distinct input per process (ruling 18; the settings page refuses to save such a window, so one that
 * arrives is a row written another way). The message holds the two hour strings only — never an order or a customer. A missing value, and a valid window, never warn.
 */
export function cadenceWorkWindow(start: unknown, end: unknown): { start: string; end: string } {
  const readStart = parseHhMm(start);
  const readEnd = parseHhMm(end);
  const from = readStart ?? CADENCE_WORKDAY_START;
  const to = readEnd ?? CADENCE_WORKDAY_END;
  if (to > from) {
    // A value that is there but not a clock is corrupt (it fell back on its own side); a MISSING side is not (a country row with no hours is ordinary) and stays silent.
    if ((readStart === null && present(start)) || (readEnd === null && present(end))) warnBadHours(start, end);
    return { start: from, end: to };
  }
  // The ruling 18 fallback — an overnight shift, equal hours, garbage — keeps working as before and now says so, once per distinct input per process.
  warnBadHours(start, end);
  return { start: CADENCE_WORKDAY_START, end: CADENCE_WORKDAY_END };
}

/** Is there something in the value at all — `null`, `undefined` and an empty or blank string are «no value», not a corrupt one. */
const present = (v: unknown): boolean => v !== null && v !== undefined && !(typeof v === 'string' && v.trim() === '');

/** The distinct bad inputs already warned about in this process: a scan of 2000 rows must not print 2000 lines. Capped, so a stream of different garbage cannot grow it without end. */
const warnedHours = new Set<string>();
const WARNED_HOURS_CAP = 100;
/** How a bad hour is printed: the text itself cut to 16 characters (a clock is 5), or the TYPE of what is not text. Never an id — the inputs are the Country's two hour strings, not an order or a customer. */
const shown = (v: unknown): string => (typeof v === 'string' ? JSON.stringify(v.slice(0, 16)) : v === null || v === undefined ? 'missing' : typeof v);
function warnBadHours(start: unknown, end: unknown): void {
  const key = `${shown(start)}|${shown(end)}`;
  if (warnedHours.has(key) || warnedHours.size >= WARNED_HOURS_CAP) return;
  warnedHours.add(key);
  console.warn(`[cadence] the country work hours are corrupt or a night shift (start ${shown(start)}, end ${shown(end)}) — using ${CADENCE_WORKDAY_START}-${CADENCE_WORKDAY_END}`);
}

/**
 * #5's EVENING ANCHOR for a work window (ruling 16): `min(18:00, end − 1 hour)`, raised to the start when that would fall before it — a window shorter than an hour (end − 1 h before the start) or one
 * that starts after 18:00 — so the anchor is ALWAYS inside [start, end). «HH:mm», from a window that already went through `cadenceWorkWindow`.
 */
export function cadenceEveningAnchor(window: { start: string; end: string }, evening: string = CADENCE_EVENING_FROM): string {
  return anchorInside(evening, window);
}

/**
 * #4's MORNING ANCHOR for a work window (request C2): 11:00 clamped into [start, end − 1 hour] — `max(start, min(11:00, end − 1 hour))`, the evening anchor's own
 * formula with the morning's clock. A start after 11:00 → the start; a day that ends before 12:00 → an hour before its end; a window shorter than an hour → the start.
 * Never after the evening anchor (its clock is earlier and the formula is the same). «HH:mm», from a window that already went through `cadenceWorkWindow`.
 */
export function cadenceMorningAnchor(window: { start: string; end: string }, morning: string = CADENCE_MORNING_AT): string {
  return anchorInside(morning, window);
}

/** `max(start, min(clock, end − 1 hour))` as «HH:mm» — the one formula both anchors use, so each is ALWAYS inside [start, end). */
function anchorInside(clock: string, window: { start: string; end: string }): string {
  const minutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
  const t = Math.max(minutes(window.start), Math.min(minutes(clock), minutes(window.end) - EVENING_BEFORE_END_MIN));
  return `${pad2(Math.floor(t / 60))}:${pad2(t % 60)}`;
}

/**
 * THE ONE BUILDER of the plan's world — the door and the desk both call it, so they can never disagree about the calendar. The Country's timezone, rest days and work hours are read, as they
 * are (the window's fallbacks live in `cadenceWorkWindow`, so a hand-built calendar gets them too): #4 is due at the start of work, #2 and #3 inside it.
 */
export function cadenceCalOf(
  since: Date,
  country: { timezone: string; weekendDays?: readonly number[] | null; workHoursStart?: string | null; workHoursEnd?: string | null },
  /**
   * The rule in force, read once by the caller through `readConfirmationRule` (request Q3b). Every door and job passes it — `the-rule-engine-reads-the-rule.test.ts`
   * fails a non-test call with two arguments; absent (a test's hand-built calendar) = the default rule, and the calendar is main's key for key.
   */
  rule?: CadenceRule
): CadenceCal {
  return {
    since,
    timeZone: country.timezone,
    restDays: country.weekendDays ?? undefined,
    workHoursStart: country.workHoursStart ?? undefined,
    workHoursEnd: country.workHoursEnd ?? undefined,
    ...(rule ? { rule } : {}),
  };
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

/** A wall clock «HH:mm» that already went through `parseHhMm` (the window's, or the plan's own constants), as the two numbers `zonedTimeToInstant` takes. */
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
 * Is this instant WORK TIME: a local day that is not a rest day, at a local clock in [start, end) — the end exclusive, the start inclusive. The clock is read to the minute, and both edges are
 * whole minutes, so 09:59:59.999 is before the start and 21:59:59.999 is still inside an end of 22:00.
 */
function insideWorkTime(at: Date, window: { start: string; end: string }, rest: ReadonlySet<number>, timeZone: string): boolean {
  const p = zonedParts(at, timeZone);
  if (rest.has(p.weekday)) return false;
  const minutes = p.hour * 60 + p.minute;
  const from = clockOf(window.start);
  const to = clockOf(window.end);
  return minutes >= from.hour * 60 + from.minute && minutes < to.hour * 60 + to.minute;
}

/**
 * From when the NEXT attempt counts. `times` are the COUNTED attempts INCLUDING the one being decided (1…4 of them); the last is the one the due follows.
 * An invalid IANA zone throws RangeError from Intl, exactly as `workClock` does for the rounds: the door lets its transaction fail rather than guess.
 */
function dueAfter(times: readonly Date[], cal: CadenceCal): Date {
  const counted = times.length;
  const at = times[counted - 1];
  const rule = ruleOf(cal);
  // The step after the k-th counted press is the rule's k-th (request Q3b); the default's four are the old #2 · #3 · #4 · #5.
  const step = rule.steps[counted - 1];
  const rest = restSet(cal.restDays);
  const window = cadenceWorkWindow(cal.workHoursStart, cal.workHoursEnd);
  const start = clockOf(window.start);
  if (step.kind === 'after') {
    // An «after» step (the old #2 and #3): the elapsed gap from the last counted press, brought INSIDE work time — a due already inside it is exactly press + gap, otherwise the first coming start of work.
    const raw = new Date(at.getTime() + step.minutes * 60_000);
    return insideWorkTime(raw, window, rest, cal.timeZone) ? raw : firstClockOnWorkday(raw, start, rest, false, cal.timeZone);
  }
  let due: Date;
  let clock: { hour: number; minute: number };
  if (step.anchor === 'morning') {
    // The MORNING ANCHOR (request C2: 11:00 clamped into the window; it was the start of work) on the first working day at least `floorHours` (elapsed; 8 by default) after the press — `>=`: exactly the floor counts.
    clock = clockOf(cadenceMorningAnchor(window, rule.morning));
    const first = firstClockOnWorkday(new Date(at.getTime() + step.floorHours * 3_600_000), clock, rest, false, cal.timeZone);
    // The first-day guard: five attempts over two local days must stay true on a 25-hour DST day, so #4 is never on #1's local day (defence in depth now: see the header — #2 and #3 inside work time already put #4 a day on).
    due = dayKey(first, cal.timeZone) === dayKey(times[0], cal.timeZone) ? firstClockOnWorkday(first, clock, rest, true, cal.timeZone) : first;
  } else {
    // The EVENING ANCHOR (the old #5): the first evening anchor local STRICTLY after the press on a working day, but never less than `floorHours` (elapsed; 3 by default) after it — and if that lands outside work time
    // (the floor can carry it past the end of a short day), the anchor of the first working day AFTER it. Terminates: `firstClockOnWorkday` looks ahead a bounded sixteen days, and the anchor is inside the window.
    clock = clockOf(cadenceEveningAnchor(window, rule.evening));
    const evening = firstClockOnWorkday(at, clock, rest, true, cal.timeZone);
    const floor = new Date(at.getTime() + step.floorHours * 3_600_000);
    const raw = evening.getTime() >= floor.getTime() ? evening : floor;
    due = insideWorkTime(raw, window, rest, cal.timeZone) ? raw : firstClockOnWorkday(raw, clock, rest, true, cal.timeZone);
  }
  return mustBeANewDay(times, rule, counted, cal.timeZone) ? onALaterDay(due, at, clock, rest, cal.timeZone) : due;
}

/**
 * THE DAYS GUARANTEE OF AN EDITED RULE (request Q3b, review 19/11). The save door accepts `minDays` up to «anchor steps + 1», on the promise that the anchors can carry the
 * attempts onto that many local days. This keeps the promise: when every anchor step still to come (this one included) is needed for a NEW local day — the days already
 * counted plus those anchors are no more than `minDays` — this anchor's due is moved to its clock on the first working day AFTER the press's day (so any press at or after it is
 * on a day none of the counted presses is on). Then, pressing at every due, the last counted press always meets `minDays` and closes the order exactly at the limit.
 *
 * NOT FOR THE DEFAULT STEPS (the old five over two days): their own guard — #4 never on #1's local day, above — already gives every history the door can write its two days,
 * and they keep main's dues byte for byte, even for a hand-built state that no door wrote.
 */
function mustBeANewDay(times: readonly Date[], rule: CadenceRule, counted: number, timeZone: string): boolean {
  if (isDefaultPlan(rule)) return false;
  const days = new Set(times.map((d) => dayKey(d, timeZone))).size;
  const anchorsLeft = rule.steps.slice(counted - 1).filter((s) => s.kind === 'anchor').length;
  return days < rule.minDays && days + anchorsLeft <= rule.minDays;
}

/** The anchor's clock on the first working day after `at`'s local day, when `due` is still on that day (bounded, as `firstClockOnWorkday` is). */
function onALaterDay(due: Date, at: Date, clock: { hour: number; minute: number }, rest: ReadonlySet<number>, timeZone: string): Date {
  let d = due;
  for (let i = 0; i < 3 && dayKey(d, timeZone) === dayKey(at, timeZone); i++) d = firstClockOnWorkday(d, clock, rest, true, timeZone);
  return d;
}

/** Are these the default STEPS and DAYS (whatever the two clocks) — the plan whose own first-day guard already holds the days? */
function isDefaultPlan(rule: CadenceRule): boolean {
  const d = CADENCE_RULE_DEFAULT;
  return (
    rule === d ||
    (rule.minDays === d.minDays &&
      rule.steps.length === d.steps.length &&
      rule.steps.every((s, i) => JSON.stringify(s) === JSON.stringify(d.steps[i])))
  );
}

/**
 * THE ONE RULE: does a no-answer press at `at` count, and where does the plan stand after it? The result class is the caller's to check (`cadencePress` does). Never mutates its input.
 *
 * Not counted: an invalid time, a time at or before the floor (`since`: «strictly after», the pool's `createdAt gt since`), a plan already complete, a press BEFORE the due the last
 * counted one set (early — kept, shown, the state unmoved). Counted: everything else; the first counted press counts however late after `since`.
 */
export function cadenceStep(state: CadenceState, at: Date, cal: CadenceCal): { next: CadenceState; counted: boolean } {
  const t = at.getTime();
  const limit = cadenceLimit(ruleOf(cal));
  if (Number.isNaN(t) || !(t > cal.since.getTime())) return { next: state, counted: false };
  if (state.counted.length >= limit) return { next: state, counted: false };
  if (state.counted.length > 0 && state.dueAt !== null && t < state.dueAt.getTime()) return { next: state, counted: false };
  const times = [...state.counted, at];
  const days = new Set(times.map((d) => dayKey(d, cal.timeZone))).size;
  const dueAt = times.length >= limit ? null : dueAfter(times, cal);
  return { next: { counted: times, days, dueAt }, counted: true };
}

/**
 * A line as the plan folds it: the attempt fact, plus the due the door STORED on it (`OrderContactAttempt.nextFollowUpAt`) when the reader selected it. Absent (`undefined`)
 * = the reader did not select it: the due is computed, as before C2.
 */
export type CadenceFact = AttemptFact & { nextFollowUpAt?: Date | string | null };

/** The due a line stored, when it is a real date — null for none, for a reader that did not select it, and for garbage. */
function storedDue(f: CadenceFact): Date | null {
  if (f.nextFollowUpAt === undefined || f.nextFollowUpAt === null) return null;
  const d = new Date(f.nextFollowUpAt);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * THE FOLD, with each no-answer line's verdict: only the no-answer lines, in the order the door decided them (`attemptNumber`, then time), through `cadenceStep`.
 * HISTORY KEEPS ITS VERDICTS (request C2, decision 3): after a COUNTED line that stored a due, the state's due IS the stored one — the anchors are only computed for a
 * line without it. A press written before C2 therefore replays to the state the door decided then, under whichever anchors it used.
 */
function cadenceFold(facts: readonly CadenceFact[], cal: CadenceCal): { state: CadenceState; lines: { fact: CadenceFact; counted: number | null }[] } {
  const at = (f: AttemptFact): number => new Date(f.createdAt).getTime();
  const sorted = facts
    .filter((f) => (NO_ANSWER_RESULTS as readonly string[]).includes(f.result) && !Number.isNaN(at(f)))
    .sort((a, b) => (a.attemptNumber ?? 0) - (b.attemptNumber ?? 0) || at(a) - at(b));
  let state = CADENCE_START;
  const lines: { fact: CadenceFact; counted: number | null }[] = [];
  for (const f of sorted) {
    const step = cadenceStep(state, new Date(f.createdAt), cal);
    const kept = step.counted && step.next.dueAt !== null ? storedDue(f) : null;
    state = kept ? { ...step.next, dueAt: kept } : step.next;
    lines.push({ fact: f, counted: step.counted ? state.counted.length : null });
  }
  return { state, lines };
}

/** An order's plan from its lines (see `cadenceFold`). */
export function cadenceState(facts: readonly CadenceFact[], cal: CadenceCal): CadenceState {
  return cadenceFold(facts, cal).state;
}

/**
 * EACH NO-ANSWER LINE'S NUMBER IN THE PLAN — the counted attempt it was («محاولة N من 5»), or null for a press that did not count (early, before the switch, after
 * the fifth). The order timeline prints it (request C2, decision 9: one counter). Lines that are not a no-answer are not in the map.
 */
export function cadenceLineNumbers<F extends CadenceFact>(facts: readonly F[], cal: CadenceCal): Map<F, number | null> {
  return new Map(cadenceFold(facts, cal).lines.map((l) => [l.fact as F, l.counted] as const));
}

/**
 * Is the plan complete — five counted attempts across at least two local days? Under the plan the second clause cannot fail (the fourth is never due on the first's local day: the
 * guard in `dueAfter`, which only a 25-hour DST day ever needs), so it is a guard, not a gate. Asked of the state AFTER a press, counted or not: a sixth no-answer after a refused close asks again.
 */
export function cadenceCloses(state: CadenceState, rule: CadenceRule = CADENCE_RULE_DEFAULT): boolean {
  // Request Q3b: the rule's attempts and days. An order whose counted presses already reach a LOWERED limit is complete: its next press — at the desk, never a job — closes it.
  return state.counted.length >= cadenceLimit(rule) && state.days >= rule.minDays;
}

/**
 * THE DOOR'S QUESTION. `stored` is the order's lines BEFORE the new one (the door reads before it writes); `press` is the new line. Returns whether it counts, the due the LINE stores
 * (`dueAt`: a due only for a counted press that is not the fifth — null for an early press, for the fifth and for a result that is not a no-answer), the state after, and whether that
 * state closes the order.
 */
export function cadencePress(
  stored: readonly CadenceFact[],
  press: { at: Date; result: string },
  cal: CadenceCal
): { counted: boolean; dueAt: Date | null; next: CadenceState; closes: boolean } {
  const before = cadenceState(stored, cal);
  if (!(NO_ANSWER_RESULTS as readonly string[]).includes(press.result)) return { counted: false, dueAt: null, next: before, closes: false };
  const { next, counted } = cadenceStep(before, press.at, cal);
  return { counted, dueAt: counted ? next.dueAt : null, next, closes: cadenceCloses(next, ruleOf(cal)) || completesTheDays(before, stored, press.at, cal) };
}

/**
 * THE WAY OUT OF A RULE CHANGED MID-CYCLE (request Q3b, review 19/11): an order whose counted presses already reach an EDITED rule's limit on fewer local days than it asks
 * (its dues were stored under the old rule, so the days guarantee could not place them) is not left with no press that can ever close it: the «لا يرد» presses past the limit
 * (after the last counted one, not early) count toward the MISSING DAYS, and the press that brings the local days of the counted presses and those to `minDays` closes it — so
 * a day with a press on it, each working day, always gets there (three days asked, one counted: two more days of presses). Never for the default steps and days — there the
 * door's history always has its two days (main, unchanged) — and only at a press, never by a job.
 */
function completesTheDays(state: CadenceState, lines: readonly CadenceFact[], at: Date, cal: CadenceCal): boolean {
  const rule = ruleOf(cal);
  if (isDefaultPlan(rule) || state.counted.length < cadenceLimit(rule) || state.days >= rule.minDays) return false;
  const floor = Math.max(cal.since.getTime(), state.counted[state.counted.length - 1].getTime(), state.dueAt ? state.dueAt.getTime() - 1 : -Infinity);
  const t = at.getTime();
  if (Number.isNaN(t) || !(t > floor)) return false;
  const past = lines
    .filter((f) => (NO_ANSWER_RESULTS as readonly string[]).includes(f.result))
    .map((f) => new Date(f.createdAt))
    .filter((d) => d.getTime() > floor && d.getTime() <= t);
  return new Set([...state.counted, ...past, at].map((d) => dayKey(d, cal.timeZone))).size >= rule.minDays;
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
export function cadencePressWords(a: {
  counted: boolean;
  closed: boolean;
  released: boolean;
  attempt: number;
  dueAt: Date | null;
  now: Date;
  timeZone: string;
  /** The rule's attempts (`cadenceLimit`, request Q3b) — absent = the default five. */
  limit?: number;
}): string {
  const next = a.attempt + 1;
  const limit = a.limit ?? CADENCE_LIMIT;
  if (a.closed) return `انحسبت ${attemptWords(a.attempt, limit, true)} — أُغلق الطلب تلقائياً وراح على قائمة «ملغاة سابقاً».`;
  if (a.counted) {
    if (a.dueAt) {
      const when = cadenceWhen(a.dueAt, a.now, a.timeZone);
      return a.released
        ? `انحسبت ${attemptWords(a.attempt, limit, true)} — رجع الطلب للطابور، والمحاولة الجاية ${when}.`
        : `انحسبت ${attemptWords(a.attempt, limit, true)} — المحاولة الجاية ${when}.`;
    }
    return `انحسبت ${attemptWords(limit, limit, true)} — الطلب لسا مفتوح، والضغطة الجاية بتجرّب تسكّره من جديد.`;
  }
  if (a.dueAt) return `سجّلنا الضغطة بس ما انحسبت محاولة — لسا بدري. ${attemptWords(next, limit, true)} بتنحسب ${cadenceWhen(a.dueAt, a.now, a.timeZone)}.`;
  if (a.attempt < limit) return 'انسجّلت الضغطة بس ما انحسبت محاولة.';
  return limit === 5 ? 'اكتملت المحاولات الخمس — الضغطة انسجّلت بس ما انحسبت.' : `اكتملت المحاولات الـ${limit} — الضغطة انسجّلت بس ما انحسبت.`;
}

// ───────────────────────────── the desk («طلباتي») ─────────────────────────────

/**
 * WHERE ONE HELD ORDER STANDS, for her desk, on the SERVER's clock. `counted` is the number the card shows (and the close counts); `due` is «a call is owed now» (the due arrived —
 * a due exactly NOW is due, the mirror of the pool's `gt`); `waiting` is «counted, due still ahead»; `closesOnNext` is «a press made now would close it» — the very step the door runs.
 * A fact at the moment of the read: the desk has no timer.
 */
export function cadenceDesk(
  facts: readonly CadenceFact[],
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
    closesOnNext: cadenceCloses(cadenceStep(s, now, cal).next, ruleOf(cal)) || completesTheDays(s, facts, now, cal),
  };
}

/**
 * The «الشغل أول» verdict of one held order under the plan, in the shape `deskTab` / `summariseDue` / `dueNow` already read (so `work-first.ts`'s verdict is not edited): no counted attempt yet
 * → by the order's own attempt count (a NEW order is due NEW; an order with only «اتصال» lines, or only lines from before the switch, is not due and lands by its count); the due arrived →
 * «ROUND»; the due ahead → waiting; a plan complete and still open (five counted, a close that did not go through) → not due and not waiting, so it stays in «بانتظار» by its count.
 *
 * ONE exception, and it comes first: THE CUSTOMER'S PROMISE («الزبون طلب نكلمو هلّق», the planner 15/11 ruling 9 — «وعد الزبون لازم يبيّن دايماً»). A rung order whose date has arrived with nothing
 * logged since (`promiseArrived`, the very fact the rounds and the pull read) is due NOW, reason PROMISE, whatever the plan says (not counted, waiting, due, complete) and whether or not
 * «نظام الجولات» is on: the plan computes the fact ITSELF from the order's dates and lines, it is not handed the rounds' answer. The rounds' own exclusions (a release about to take the order,
 * a third round) do not apply to the plan. A never-rung order (`attemptCount` 0) is NEW first — as in the rounds, and as the pull's first group — whatever its dates. A date still ahead
 * changes nothing here (RV2392's other half).
 */
export function cadenceVerdict(
  desk: Pick<ReturnType<typeof cadenceDesk>, 'counted' | 'due' | 'waiting' | 'dueAt'>,
  attemptCount: number,
  /** The order's dates and ALL of its lines (any result), and the moment asked about — what `promiseArrived` needs. Required: a caller that forgot it would silently lose the tag. */
  promise: { order: Pick<DueOrder, 'postponedUntil' | 'nextFollowUpAt'>; lines: readonly Pick<AttemptFact, 'createdAt'>[]; now: Date }
): DueVerdict {
  if (attemptCount > 0 && promiseArrived(promise.order, promise.lines, promise.now)) return DUE_PROMISE;
  if (desk.counted === 0) return verdictFromCount(attemptCount);
  if (desk.due) return { due: true, reason: 'ROUND', waiting: false, dueAt: null };
  if (desk.waiting) return { due: false, reason: null, waiting: true, dueAt: desk.dueAt };
  return { due: false, reason: null, waiting: false, dueAt: null };
}

/**
 * THE LINE A HELD CARD PRINTS, written here so the screen decides nothing: «لا يرد راجع — محاولة 3 من 5» when the due arrived, «محاولة 2 من 5 — جاهز الساعة 17:30» while it waits.
 * Null for an order with no counted attempt (a NEW order keeps «جديد — سحبتيه هلّق») and for a complete plan: the caller falls back to `dueLabel`, which has nothing to say for those.
 */
export function cadenceCardWords(
  desk: Pick<ReturnType<typeof cadenceDesk>, 'counted' | 'due' | 'waiting' | 'dueAt'>,
  now: Date,
  timeZone: string,
  /** The rule's attempts (`cadenceLimit`, request Q3b) — absent = the default five. */
  limit: number = CADENCE_LIMIT
): string | null {
  if (desk.counted < 1 || desk.counted >= limit) return null;
  if (desk.due) return `لا يرد راجع — ${nextAttemptWords(desk.counted, limit)}`;
  if (desk.waiting && desk.dueAt) return `${nextAttemptWords(desk.counted, limit)} — جاهز ${cadenceWhen(desk.dueAt, now, timeZone)}`;
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
