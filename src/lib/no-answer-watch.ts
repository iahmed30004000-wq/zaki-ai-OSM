import { db } from './db';
import { zonedParts, zonedTimeToInstant, type BusinessCalendar } from './business-calendar';
import { CONTACT_RESULTS, NO_ANSWER_RESULTS } from './confirmation-workflow';
import { OPEN_CONFIRMATION } from './confirmation-queue';
import { localDayKey, startOfLocalDay } from './local-day';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «لا رد» — WHAT EACH AGENT IS SITTING ON, AND WHEN CUSTOMERS PICK UP.
 *
 * The owner is redesigning how no-answer orders are held (step 1 of 4). Today
 * an order an agent has logged ONE attempt on stays hers for ever — the stale
 * release only takes claims with no attempt at all — and agents report about
 * 130 held orders each. Before any rule changes, the owner and the supervisor
 * must SEE it, and later measure the new rules against it. So this file only
 * reads: no write, no queue rule, no pull, no release, no close.
 *
 *   · THE BOARD (now): per agent — held, of those only-unanswered, promises
 *     due, stuck (last attempt older than two working days), confirmed today;
 *     and for the team — fresh NEW orders nobody pulled, and open orders
 *     nobody holds that already carry a no-answer.
 *   · THE REPORT (a range): the answer rate by local hour and by attempt
 *     number, every percentage beside the counts it was made from.
 *
 * Every query is scoped by company AND store, grouped (never one per agent),
 * and bounded: the board reads what is open now, the report a date range.
 * No customer field is read — agents and counts only.
 * ═══════════════════════════════════════════════════════════════════════
 */

/** Two working days without a single attempt on an order she holds. */
export const STUCK_BUSINESS_DAYS = 2;
/** «طلب جديد» still fresh: younger than this, wall clock. */
export const FRESH_NEW_HOURS = 2;
/** The report's default span, today included. */
export const REPORT_DEFAULT_DAYS = 14;
/** A follow-up the CUSTOMER asked for — a callback or a postponement. */
export const PROMISE_REASONS = ['CUSTOMER_REQUESTED_CALLBACK', 'POSTPONED'] as const;
/** Ceiling on rows read per question; reaching it is said on the screen, never hidden. */
export const ROW_CAP = 20000;
export const REPORT_ROW_CAP = 50000;

// ───────────────────────── reached or not ─────────────────────────

/**
 * WHAT ONE ATTEMPT SAYS ABOUT THE CUSTOMER.
 *
 *   · `NOT_REACHED` — the three results that count toward the 1/2/3 close
 *     (`NO_ANSWER_RESULTS`): nobody was reached.
 *   · `NOT_A_CALL` — a button pressed (`OPENED`) or a message written
 *     (`MESSAGE_SENT`): no outcome is claimed, so neither side of the rate.
 *   · `REACHED` — every other result in `CONTACT_RESULTS`: somebody answered.
 *
 * A stored value that is not in the list today is NOT counted as reached — a
 * rate that grows from strings nobody can read is the rate this report exists
 * to replace.
 */
export type Outcome = 'REACHED' | 'NOT_REACHED' | 'NOT_A_CALL';
const NOT_A_CALL = ['OPENED', 'MESSAGE_SENT'];

export function outcomeOf(result: string): Outcome {
  if ((NO_ANSWER_RESULTS as readonly string[]).includes(result)) return 'NOT_REACHED';
  if (NOT_A_CALL.includes(result) || !(CONTACT_RESULTS as readonly string[]).includes(result)) return 'NOT_A_CALL';
  return 'REACHED';
}

// ───────────────────────── the working day ─────────────────────────

function hhmm(value: string, fallback: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
}

/** Minutes in one working day of this calendar (the same hours `businessMinutesBetween` walks). */
export function workdayMinutes(cal: BusinessCalendar): number {
  const span = hhmm(cal.workHoursEnd, 17 * 60) - hhmm(cal.workHoursStart, 9 * 60);
  return span > 0 ? span : 8 * 60;
}

/** «HH:mm» exactly as the business calendar reads it (`parseHhMm` there): the hour capped at 23, the minute at 59. */
function windowTime(value: string, fallbackHour: number): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value ?? '');
  if (!m) return { hour: fallbackHour, minute: 0 };
  return { hour: Math.min(23, Number(m[1])), minute: Math.min(59, Number(m[2])) };
}

/**
 * THE LATEST INSTANT WITH AT LEAST `minutes` OF WORKING TIME BETWEEN IT AND `now`.
 *
 * Walked BACK from now over the same windows `businessMinutesBetween` walks forward (work hours, weekend days, the
 * country's timezone), once per request. It used to be the other way round: `businessMinutesBetween` per held order, each
 * walking every day since that order's last attempt and building a date formatter several times per day — 3.75 s of one
 * Node process for 1,300 held orders, two minutes for 20,000, while the agents' pulls wait on the same process. Now it is
 * a handful of days walked once, and each order is one comparison of two instants.
 *
 * A weekday is read from the calendar date itself (`Date.UTC(y, m, d).getUTCDay()`), so the walk builds no formatter for
 * it; only the two edges of each working window are placed in the timezone.
 */
export function workingMinutesBack(now: Date, minutes: number, cal: BusinessCalendar): Date {
  const local = zonedParts(now, cal.timezone);
  const from = windowTime(cal.workHoursStart, 9);
  const to = windowTime(cal.workHoursEnd, 17);
  let remaining = minutes * 60_000;
  for (let back = 0; back < 400; back++) {
    const day = new Date(Date.UTC(local.year, local.month - 1, local.day - back));
    if (cal.weekendDays.includes(day.getUTCDay())) continue;
    const [y, m, d] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()];
    const start = zonedTimeToInstant(cal.timezone, y, m, d, from.hour, from.minute).getTime();
    const close = zonedTimeToInstant(cal.timezone, y, m, d, to.hour, to.minute).getTime();
    if (close <= start) continue; // no working window that day — the calendar's own rule
    const end = Math.min(close, now.getTime());
    if (end <= start) continue; // today, before the doors opened
    if (end - start >= remaining) return new Date(end - remaining);
    remaining -= end - start;
  }
  return new Date(-8.64e15); // a calendar with no working time: nothing is ever stuck
}

/**
 * «عالق» FROM THIS INSTANT BACK: the last attempt at or before it is MORE than two working days old.
 *
 * Strictly more, as `businessMinutesBetween(lastAt, now) > 2 days` said it — that floors to whole minutes, so «more than
 * N» is «at least N + 1», and the cut-off is walked back N + 1 minutes. `no-answer-watch.test.ts` checks the two
 * readings agree on hundreds of instants.
 */
export function stuckCutoff(now: Date, cal: BusinessCalendar): Date {
  return workingMinutesBack(now, STUCK_BUSINESS_DAYS * workdayMinutes(cal) + 1, cal);
}

/** Is an order whose last attempt was at `lastAt` stuck? One comparison against the request's cut-off. */
export function isStuck(lastAt: Date, cutoff: Date): boolean {
  return lastAt.getTime() <= cutoff.getTime();
}

// ───────────────────────── the board ─────────────────────────

export interface HeldOrder {
  id: string;
  claimedById: string | null;
  nextFollowUpAt: Date | null;
  followUpReason: string | null;
  followUpStatus: string | null;
}

/** One row of `orderContactAttempt.groupBy(['orderId', 'result'])`. */
export interface AttemptGroup {
  orderId: string;
  result: string;
  _max: { createdAt: Date | null };
}

export interface AgentRow {
  id: string;
  name: string;
  /** Claimed by her, in an open confirmation status. */
  held: number;
  /** Of those: at least one no-answer, and nobody ever reached. */
  onlyNoAnswer: number;
  /** Of those: a callback or postponement the customer asked for, now due. */
  promisesDue: number;
  /** Of those: the last attempt is older than two working days. */
  stuck: number;
  /** Confirmed by her since the start of today. */
  confirmedToday: number;
}

export interface NoAnswerBoard {
  agents: AgentRow[];
  totals: Omit<AgentRow, 'id' | 'name'>;
  team: {
    /** NEW, nobody holds it, younger than two hours. */
    freshUnclaimed: number;
    /** Open, nobody holds it, and it already carries a no-answer. */
    unclaimedWithNoAnswer: number;
  };
  /** The held list reached `ROW_CAP`: the per-agent figures are a floor. */
  truncated: boolean;
}

/** Due, asked for by the customer, and still a promise (the confirmation door's own reading: status unset or SCHEDULED). */
const isPromise = (o: HeldOrder, now: Date) =>
  !!o.nextFollowUpAt &&
  o.nextFollowUpAt <= now &&
  (PROMISE_REASONS as readonly string[]).includes(o.followUpReason ?? '') &&
  (o.followUpStatus === null || o.followUpStatus === 'SCHEDULED');

/** The arithmetic of the board, with nothing read: the same rows give the same figures. */
export function tallyBoard(input: {
  held: HeldOrder[];
  attempts: AttemptGroup[];
  confirmedToday: Map<string, number>;
  names: Map<string, string>;
  calendar: BusinessCalendar;
  now: Date;
}): Pick<NoAnswerBoard, 'agents' | 'totals'> {
  const { held, attempts, confirmedToday, names, calendar, now } = input;
  // Once per request, never per order — see `workingMinutesBack`.
  const cutoff = stuckCutoff(now, calendar);

  // Per order: was anybody reached, was a no-answer logged, and when was the last attempt of any kind.
  const per = new Map<string, { reached: boolean; noAnswer: boolean; lastAt: Date | null }>();
  for (const a of attempts) {
    const o = per.get(a.orderId) ?? { reached: false, noAnswer: false, lastAt: null };
    const outcome = outcomeOf(a.result);
    if (outcome === 'REACHED') o.reached = true;
    if (outcome === 'NOT_REACHED') o.noAnswer = true;
    const at = a._max.createdAt;
    if (at && (!o.lastAt || at > o.lastAt)) o.lastAt = at;
    per.set(a.orderId, o);
  }

  const rows = new Map<string, AgentRow>();
  const rowOf = (id: string) => {
    let r = rows.get(id);
    if (!r) {
      r = { id, name: names.get(id) ?? '—', held: 0, onlyNoAnswer: 0, promisesDue: 0, stuck: 0, confirmedToday: 0 };
      rows.set(id, r);
    }
    return r;
  };

  for (const o of held) {
    if (!o.claimedById) continue;
    const r = rowOf(o.claimedById);
    r.held++;
    const a = per.get(o.id);
    if (a?.noAnswer && !a.reached) r.onlyNoAnswer++;
    if (isPromise(o, now)) r.promisesDue++;
    if (a?.lastAt && isStuck(a.lastAt, cutoff)) r.stuck++;
  }
  for (const [id, n] of confirmedToday) rowOf(id).confirmedToday = n;

  const agents = [...rows.values()].sort((a, b) => b.held - a.held || b.confirmedToday - a.confirmedToday);
  const sum = (k: keyof NoAnswerBoard['totals']) => agents.reduce((s, r) => s + r[k], 0);
  return {
    agents,
    totals: {
      held: sum('held'),
      onlyNoAnswer: sum('onlyNoAnswer'),
      promisesDue: sum('promisesDue'),
      stuck: sum('stuck'),
      confirmedToday: sum('confirmedToday'),
    },
  };
}

/** The board as it stands now, for one store. Five grouped reads and one for the names. */
export async function noAnswerBoard(input: {
  companyId: string;
  storeId: string;
  calendar: BusinessCalendar;
  now?: Date;
}): Promise<NoAnswerBoard> {
  const { companyId, storeId, calendar } = input;
  const now = input.now ?? new Date();
  const scope = { companyId, storeId };
  const heldWhere = { ...scope, claimedById: { not: null }, confirmationStatus: { in: OPEN_CONFIRMATION } };
  // «اليوم» as «أكّدتها» reads it (`/api/confirmation/mine`): the same day boundary, so the two screens agree.
  const startOfToday = startOfLocalDay(localDayKey(now))!;

  const [held, attempts, confirmed, freshUnclaimed, unclaimedWithNoAnswer] = await Promise.all([
    db.order.findMany({
      where: heldWhere,
      select: { id: true, claimedById: true, nextFollowUpAt: true, followUpReason: true, followUpStatus: true },
      take: ROW_CAP,
    }),
    // One row per order and result, with its latest moment: enough for «ever reached», «ever unanswered» and «last attempt».
    db.orderContactAttempt.groupBy({
      by: ['orderId', 'result'],
      where: { companyId, order: heldWhere },
      _max: { createdAt: true },
    }),
    db.order.groupBy({
      by: ['confirmedById'],
      where: { ...scope, confirmationStatus: 'CONFIRMED', confirmedById: { not: null }, confirmedAt: { gte: startOfToday } },
      _count: { _all: true },
    }),
    db.order.count({
      where: {
        ...scope,
        claimedById: null,
        confirmationStatus: 'NEW',
        createdAt: { gte: new Date(now.getTime() - FRESH_NEW_HOURS * 3_600_000) },
      },
    }),
    db.order.count({
      where: {
        ...scope,
        claimedById: null,
        confirmationStatus: { in: OPEN_CONFIRMATION },
        contactAttempts: { some: { result: { in: [...NO_ANSWER_RESULTS] } } },
      },
    }),
  ]);

  const confirmedToday = new Map<string, number>();
  for (const c of confirmed) if (c.confirmedById) confirmedToday.set(c.confirmedById, c._count._all);

  const ids = new Set<string>(confirmedToday.keys());
  for (const o of held) if (o.claimedById) ids.add(o.claimedById);
  // By id alone, as the team table does: the ids came from rows already scoped to this company and store.
  const people = ids.size
    ? await db.user.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true } })
    : [];

  const { agents, totals } = tallyBoard({
    held,
    attempts: attempts as AttemptGroup[],
    confirmedToday,
    names: new Map(people.map((p) => [p.id, p.name])),
    calendar,
    now,
  });
  return { agents, totals, team: { freshUnclaimed, unclaimedWithNoAnswer }, truncated: held.length >= ROW_CAP };
}

// ───────────────────────── the report ─────────────────────────

export interface RateRow {
  /** The hour (0–23, local) or the attempt bucket ('1', '2', '3', '4+'). */
  key: string;
  reached: number;
  notReached: number;
  /** reached + notReached — the base of the rate. */
  base: number;
  /** A button pressed or a message sent: counted, and outside the rate. */
  notACall: number;
  /** reached ÷ base, as a whole percentage. Null when the base is zero. */
  rate: number | null;
}

export interface AnswerRateReport {
  byHour: RateRow[];
  byAttempt: RateRow[];
  total: RateRow;
  /** The range reached `REPORT_ROW_CAP`: the figures cover only part of it. */
  truncated: boolean;
}

export const ATTEMPT_BUCKETS = ['1', '2', '3', '4+'] as const;
const bucketOf = (n: number) => (n >= 4 ? '4+' : String(Math.max(1, n)));

const emptyRow = (key: string): RateRow => ({ key, reached: 0, notReached: 0, base: 0, notACall: 0, rate: null });
function add(row: RateRow, outcome: Outcome) {
  if (outcome === 'REACHED') row.reached++;
  else if (outcome === 'NOT_REACHED') row.notReached++;
  else row.notACall++;
}
function close(row: RateRow): RateRow {
  row.base = row.reached + row.notReached;
  row.rate = row.base > 0 ? Math.round((row.reached / row.base) * 100) : null;
  return row;
}

/** The results that are an outcome of a call — the ones the call number counts. */
export const CALL_RESULTS = CONTACT_RESULTS.filter((r) => outcomeOf(r) !== 'NOT_A_CALL');

/**
 * The local hour of an instant, from ONE formatter per request. `zonedParts` used to build a formatter per call (it keeps
 * them now), and once per row of a 50,000-row report that was seconds of one Node process.
 */
export function hourReader(timeZone: string): (at: Date) => number {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, hour12: false, hour: '2-digit' });
  return (at) => Number(fmt.formatToParts(at).find((p) => p.type === 'hour')?.value ?? 0) % 24;
}

export interface AttemptRow {
  orderId: string;
  result: string;
  createdAt: Date;
  /** Only to order two rows of one order written in the same millisecond. */
  attemptNumber: number;
}

/**
 * THE ARITHMETIC OF THE REPORT.
 *
 * By hour: every row, in the store country's local hour; only hours with an attempt are rows.
 *
 * By call number — NOT the stored `attemptNumber`. Every press of «اتصال» writes `OPENED` under its own number, so an order
 * rung as OPENED #1 · NO_ANSWER #2 · OPENED #3 · ANSWERED #4 read «رقم 1: base 0» and «4+: 100%» when the truth is «the
 * first call was not answered, the second was». So only the rows that ARE an outcome (`CALL_RESULTS`) are numbered, per
 * order, in time order, starting after the calls that order already had before the range (`priorCalls`). A button or a
 * message gets no number; it is counted in the hour table, outside the rate.
 */
export function tallyAnswerRate(
  rows: AttemptRow[],
  priorCalls: Map<string, number>,
  timezone: string
): Omit<AnswerRateReport, 'truncated'> {
  const hourOf = hourReader(timezone);
  const hours = new Map<number, RateRow>();
  const tries = new Map<string, RateRow>(ATTEMPT_BUCKETS.map((b) => [b, emptyRow(b)]));
  const total = emptyRow('الكل');
  const callsSoFar = new Map(priorCalls);
  const inOrder = [...rows].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.attemptNumber - b.attemptNumber
  );
  for (const r of inOrder) {
    const outcome = outcomeOf(r.result);
    const hour = hourOf(r.createdAt);
    if (!hours.has(hour)) hours.set(hour, emptyRow(String(hour)));
    add(hours.get(hour)!, outcome);
    add(total, outcome);
    if (outcome === 'NOT_A_CALL') continue;
    const n = (callsSoFar.get(r.orderId) ?? 0) + 1;
    callsSoFar.set(r.orderId, n);
    add(tries.get(bucketOf(n))!, outcome);
  }
  return {
    byHour: [...hours.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => close(row)),
    byAttempt: ATTEMPT_BUCKETS.map((b) => close(tries.get(b)!)),
    total: close(total),
  };
}

/**
 * The report over a range, for one store. Two bounded reads:
 *
 *   · the range's rows, OLDEST first, so that when the cap cuts it is the end of the range that goes and every row kept
 *     still has all of its order's earlier rows in the range;
 *   · per order with a row in the range, how many calls it had BEFORE the range — one grouped count, not the rows.
 */
export async function answerRateReport(input: {
  companyId: string;
  storeId: string;
  timezone: string;
  start: Date;
  end: Date;
}): Promise<AnswerRateReport> {
  const { companyId, storeId, timezone, start, end } = input;
  const inRange = { gte: start, lte: end };
  const [rows, before] = await Promise.all([
    db.orderContactAttempt.findMany({
      where: { companyId, order: { storeId }, createdAt: inRange },
      select: { orderId: true, result: true, createdAt: true, attemptNumber: true },
      orderBy: [{ createdAt: 'asc' }, { attemptNumber: 'asc' }],
      take: REPORT_ROW_CAP,
    }),
    db.orderContactAttempt.groupBy({
      by: ['orderId'],
      where: {
        companyId,
        createdAt: { lt: start },
        result: { in: [...CALL_RESULTS] },
        order: { storeId, contactAttempts: { some: { createdAt: inRange } } },
      },
      _count: { _all: true },
      // At most one group per order with a row in the range — never more than the rows read beside it.
      orderBy: { orderId: 'asc' },
      take: REPORT_ROW_CAP,
    }),
  ]);
  const priorCalls = new Map(before.map((b) => [b.orderId, b._count._all]));
  return { ...tallyAnswerRate(rows, priorCalls, timezone), truncated: rows.length >= REPORT_ROW_CAP };
}
