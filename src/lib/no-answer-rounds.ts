import { zonedTimeToInstant, type BusinessCalendar } from './business-calendar';
import { NO_ANSWER_LIMIT, NO_ANSWER_RESULTS } from './confirmation-workflow';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «لا رد» IN ROUNDS — THE RULES, WITH NOTHING READ (the owner, 4/11: «بنمشي ع اخر خطة»).
 *
 * Behind a switch that is OFF unless the owner turns it on (`no-answer-rounds-switch.ts`). With it OFF none of this is
 * asked and every door works exactly as before: an order with one logged attempt stays with its agent, and the third
 * no-answer of all time closes it at once.
 *
 * With it ON:
 *
 *   R1 · LET GO — an order whose trailing run of no-answers (after the last call that reached somebody and after she took
 *        it) started three WORKING hours ago — counted from the switch when the run is older than it (6/11) — goes back to
 *        the shared queue, and the customer's
 *        other orders held for her go with it. So does a re-pulled order nobody has touched since it was taken, after the
 *        same ninety working minutes as an untouched one.
 *   R2 · A ROUND — presses of «لا يرد» within three working hours of the round's first count once. ONE function
 *        (`countedRounds`) answers it for the close, the desk's counter and the desk's two tabs.
 *   R3 · THE CLOSE — the third counted round closes the order only when the rounds fall on at least two different days.
 *   R4 · THE PULL — after what is held for her and what is due today, an order nobody has rung yet comes before one that
 *        was rung already.
 *   R5 · A DIAL FIRST — a no-answer counts as a round only if the same agent pressed «اتصل» (an `OPENED` line) on the
 *        order since the previous counted round. Otherwise it is kept and shown, and still starts the three hours of R1.
 *
 * ── «REACHED» ──
 *
 * Every result that is not a no-answer (`NO_ANSWER_RESULTS`) and not a button press (`OPENED`) or a message
 * (`MESSAGE_SENT`), which claim no outcome. The supervisor board (`no-answer-watch.ts`) reads the same three classes.
 *
 * ── THE CALENDAR, ONCE ──
 *
 * `businessMinutesBetween` builds date formatters for every day it walks, and calling it per order once stalled the one
 * server process (`no-answer-watch.ts`, `workingMinutesBack`). `workClock` places each working day ONCE per request and
 * answers every pair from that, so a desk of 250 orders is a handful of days placed and arithmetic on instants.
 * `no-answer-rounds.test.ts` holds it to `businessMinutesBetween` on hundreds of instants.
 * ═══════════════════════════════════════════════════════════════════════
 */

/** Presses within this many working minutes of a round's first are the same round. */
export const ROUND_GAP_BUSINESS_MINUTES = 180;
/** A trailing run of no-answers this many working minutes old lets the order go back to the queue. */
export const ROUND_RELEASE_BUSINESS_MINUTES = 180;
/** A re-pulled order nobody touched goes back after the same time as an untouched one (`AUTO_RELEASE_BUSINESS_MINUTES`). */
export const REPULL_RELEASE_BUSINESS_MINUTES = 90;
/**
 * She is on it: an attempt of any kind (a «اتصل» included) by the agent who holds the order, this many working minutes ago or
 * less, keeps it with her for this pass — a release never takes an order out of her hands in the middle of a call.
 */
export const HOLDER_ACTIVE_BUSINESS_MINUTES = 15;
/** The counted rounds must fall on at least this many different days before they close an order. */
export const ROUND_CLOSE_MIN_DAYS = 2;

/** The claim-history reasons of the two releases — named in Arabic in the order timeline (`order-timeline.ts`). */
export const ROUND_RELEASE_REASON = 'AUTO_RELEASE_NO_ANSWER_ROUND';
export const REPULL_RELEASE_REASON = 'AUTO_RELEASE_REPULLED_UNTOUCHED';

/**
 * What the switch says: off, or on since a moment. No clock of R1 runs before that moment — a run older than the switch
 * starts its three working hours when it went on (6/11) — and the close (R3) counts what the desk shows.
 */
export interface RoundsSwitch {
  enabled: boolean;
  enabledAt: Date | null;
}
export const ROUNDS_OFF: RoundsSwitch = Object.freeze({ enabled: false, enabledAt: null }) as RoundsSwitch;

/** On, with a moment it went on — the only state in which any rule here applies. */
export function roundsOn(sw: RoundsSwitch | null | undefined): sw is RoundsSwitch & { enabledAt: Date } {
  return !!sw && sw.enabled === true && sw.enabledAt instanceof Date && !Number.isNaN(sw.enabledAt.getTime());
}

const NOT_A_CALL = ['OPENED', 'MESSAGE_SENT'];

export function isNoAnswer(result: string): boolean {
  return (NO_ANSWER_RESULTS as readonly string[]).includes(result);
}

/** Somebody was reached: neither a no-answer nor a press that claims no outcome. */
export function isReaching(result: string): boolean {
  return !isNoAnswer(result) && !NOT_A_CALL.includes(result);
}

// ───────────────────────── the working clock ─────────────────────────

export interface WorkClock {
  /** Working minutes between two instants, floored — `businessMinutesBetween`'s answer. */
  minutesBetween(a: Date, b: Date): number;
  /** The latest instant with at least `minutes` working minutes between it and `from`. */
  back(from: Date, minutes: number): Date;
  /** The local calendar date of an instant, `yyyy-mm-dd`. */
  dayKey(at: Date): string;
}

function hhmm(value: string, fallbackHour: number): { hour: number; minute: number } {
  // Exactly as the business calendar reads it (`parseHhMm` there).
  const m = /^(\d{1,2}):(\d{2})$/.exec(value ?? '');
  if (!m) return { hour: fallbackHour, minute: 0 };
  return { hour: Math.min(23, Number(m[1])), minute: Math.min(59, Number(m[2])) };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** One clock per request: each local day is placed once, whatever the number of orders asked about. */
export function workClock(cal: BusinessCalendar): WorkClock {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: cal.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const from = hhmm(cal.workHoursStart, 9);
  const to = hhmm(cal.workHoursEnd, 17);
  const windows = new Map<number, { start: number; end: number } | null>();

  /** Days since the epoch of the local calendar date of an instant. */
  const localDay = (at: Date): number => {
    const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
    return Math.round(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / DAY_MS);
  };
  const windowOf = (day: number) => {
    if (windows.has(day)) return windows.get(day)!;
    const date = new Date(day * DAY_MS);
    let win: { start: number; end: number } | null = null;
    if (!cal.weekendDays.includes(date.getUTCDay())) {
      const [y, m, d] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
      const start = zonedTimeToInstant(cal.timezone, y, m, d, from.hour, from.minute).getTime();
      const end = zonedTimeToInstant(cal.timezone, y, m, d, to.hour, to.minute).getTime();
      if (end > start) win = { start, end };
    }
    windows.set(day, win);
    return win;
  };

  return {
    minutesBetween(a, b) {
      if (b <= a) return 0;
      let total = 0;
      const last = localDay(b);
      for (let day = localDay(a); day <= last; day++) {
        const win = windowOf(day);
        if (!win) continue;
        const lo = Math.max(win.start, a.getTime());
        const hi = Math.min(win.end, b.getTime());
        if (hi > lo) total += hi - lo;
      }
      return Math.floor(total / 60_000);
    },
    back(at, minutes) {
      let remaining = minutes * 60_000;
      const first = localDay(at);
      for (let day = first; day > first - 400; day--) {
        const win = windowOf(day);
        if (!win) continue;
        const end = Math.min(win.end, at.getTime());
        if (end <= win.start) continue;
        if (end - win.start >= remaining) return new Date(end - remaining);
        remaining -= end - win.start;
      }
      return new Date(-8.64e15); // no working time at all: nothing is ever old enough
    },
    dayKey(at) {
      return new Date(localDay(at) * DAY_MS).toISOString().slice(0, 10);
    },
  };
}

// ───────────────────────── R2 · R3 · R5: the rounds ─────────────────────────

export interface AttemptFact {
  createdAt: Date | string;
  result: string;
  employeeId?: string | null;
  attemptNumber?: number | null;
}

export interface Rounds {
  /** The no-answers that started a counted round, in order. */
  counted: Date[];
  /** Different local days those rounds fall on. */
  days: number;
}

const at = (a: AttemptFact) => new Date(a.createdAt);

/** Oldest first; the attempt number breaks a tie of the same instant. */
function chronological(attempts: readonly AttemptFact[]): AttemptFact[] {
  return [...attempts].sort((x, y) => at(x).getTime() - at(y).getTime() || (x.attemptNumber ?? 0) - (y.attemptNumber ?? 0));
}

/**
 * THE ONE ANSWER TO «WHICH ROUND IS THIS ORDER ON» — for the close (R3), the desk's «جولة n من 3» and its two tabs.
 *
 * A no-answer starts a counted round when it is at least `ROUND_GAP_BUSINESS_MINUTES` working minutes after the previous
 * counted round started (R2), and the same agent pressed «اتصل» on the order since that round (R5). Otherwise it is part of
 * the round already running, or a press nobody proved was a call: kept, shown in the history, never counted.
 *
 * Never more than the counts the switch-off rule makes: every counted round is a no-answer, so with the switch on an order
 * can only close LATER than it would have with it off, never sooner.
 */
export function countedRounds(attempts: readonly AttemptFact[], clock: WorkClock): Rounds {
  const counted: Date[] = [];
  let dialled = new Set<string>();
  for (const a of chronological(attempts)) {
    const who = a.employeeId ?? '';
    if (a.result === 'OPENED') {
      dialled.add(who);
      continue;
    }
    if (!isNoAnswer(a.result)) continue;
    const prev = counted[counted.length - 1];
    const spaced = !prev || clock.minutesBetween(prev, at(a)) >= ROUND_GAP_BUSINESS_MINUTES;
    if (!spaced || !dialled.has(who)) continue;
    counted.push(at(a));
    dialled = new Set();
  }
  return { counted, days: new Set(counted.map((d) => clock.dayKey(d))).size };
}

/** R3: the rounds that close an order — three counted, on at least two different days. */
export function roundsClose(rounds: Rounds): boolean {
  return rounds.counted.length >= NO_ANSWER_LIMIT && rounds.days >= ROUND_CLOSE_MIN_DAYS;
}

// ───────────────────────── R1: letting go ─────────────────────────

export interface HeldFacts {
  claimedAt: Date | string;
  /** Who holds it — an attempt of hers in the last `HOLDER_ACTIVE_BUSINESS_MINUTES` keeps it. */
  claimedById?: string | null;
  postponedUntil?: Date | string | null;
  nextFollowUpAt?: Date | string | null;
}

/** The two cut-offs of one release pass — computed once per call, never per order. */
export interface ReleaseCutoffs {
  /** A trailing run that started at or before this is three working hours old. */
  round: Date;
  /** A re-pulled claim taken at or before this is ninety working minutes old. */
  repull: Date;
  /** An attempt by the holder AFTER this is «she is on it right now». */
  recent: Date;
}

export function releaseCutoffs(now: Date, clock: WorkClock): ReleaseCutoffs {
  return {
    round: clock.back(now, ROUND_RELEASE_BUSINESS_MINUTES),
    repull: clock.back(now, REPULL_RELEASE_BUSINESS_MINUTES),
    recent: clock.back(now, HOLDER_ACTIVE_BUSINESS_MINUTES),
  };
}

/**
 * WHY THIS HELD ORDER GOES BACK TO THE QUEUE — or null when it stays with her. Pure: one comparison per attempt against the
 * pass's cut-offs.
 *
 *   · a date ahead (a postponement or a callback the customer asked for) keeps it, whatever else;
 *   · so does an attempt by the agent who holds it in the last `HOLDER_ACTIVE_BUSINESS_MINUTES` working minutes;
 *   · no attempt at all is the ninety-minute rule's (`releaseStaleClaims`), not this one's;
 *   · worked before, and nothing logged since she took it: `REPULL_RELEASE_REASON`, ninety working minutes after she took
 *     it or after the switch went on, whichever is later;
 *   · otherwise the no-answers after the last call that reached somebody and after she took it: three working hours after
 *     the first of them, or after the switch went on when that is later, is `ROUND_RELEASE_REASON`.
 */
export function roundsReleaseReason(
  order: HeldFacts,
  attempts: readonly AttemptFact[],
  sw: { enabledAt: Date },
  cut: ReleaseCutoffs,
  now: Date
): typeof ROUND_RELEASE_REASON | typeof REPULL_RELEASE_REASON | null {
  const ahead = (v: Date | string | null | undefined) => !!v && new Date(v).getTime() > now.getTime();
  if (ahead(order.postponedUntil) || ahead(order.nextFollowUpAt)) return null;
  if (attempts.length === 0) return null;
  // She is on the call (or just was): not this pass.
  if (order.claimedById && attempts.some((a) => a.employeeId === order.claimedById && at(a).getTime() > cut.recent.getTime())) {
    return null;
  }

  const claimedAt = new Date(order.claimedAt).getTime();
  const enabledAt = sw.enabledAt.getTime();
  const sorted = chronological(attempts);

  if (!sorted.some((a) => at(a).getTime() >= claimedAt)) {
    return Math.max(claimedAt, enabledAt) <= cut.repull.getTime() ? REPULL_RELEASE_REASON : null;
  }

  /*
   * THE PILE FROM BEFORE THE SWITCH GOES BACK TOO (the owner, 6/11: «ع الفاضي ما انسحب منها الطلبات»). A run of no-answers
   * that started before the switch went on is still a run — 237 orders on one desk said so — but its three working hours
   * are counted FROM THE SWITCH, never from the old press: turning it on gives every desk three working hours' notice, and
   * nothing leaves the moment it is pressed. A call that reached somebody before the switch still ends the run before it.
   */
  let anchor = claimedAt;
  for (const a of sorted) if (isReaching(a.result)) anchor = Math.max(anchor, at(a).getTime() + 1);
  const run = sorted.find((a) => isNoAnswer(a.result) && at(a).getTime() >= anchor);
  if (!run) return null;
  return Math.max(at(run).getTime(), enabledAt) <= cut.round.getTime() ? ROUND_RELEASE_REASON : null;
}
