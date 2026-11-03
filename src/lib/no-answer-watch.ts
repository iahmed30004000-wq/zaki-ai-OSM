import { db } from './db';
import { businessMinutesBetween, zonedParts, type BusinessCalendar } from './business-calendar';
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

/** Is an order whose last attempt was at `lastAt` stuck at `now`? Working minutes, so a weekend is not waiting. */
export function isStuck(lastAt: Date, now: Date, cal: BusinessCalendar): boolean {
  return businessMinutesBetween(lastAt, now, cal) > STUCK_BUSINESS_DAYS * workdayMinutes(cal);
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
    if (a?.lastAt && isStuck(a.lastAt, now, calendar)) r.stuck++;
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

/** The arithmetic of the report. Hours are the store country's local hours; only hours with an attempt are rows. */
export function tallyAnswerRate(
  rows: { result: string; attemptNumber: number; createdAt: Date }[],
  timezone: string
): Omit<AnswerRateReport, 'truncated'> {
  const hours = new Map<number, RateRow>();
  const tries = new Map<string, RateRow>(ATTEMPT_BUCKETS.map((b) => [b, emptyRow(b)]));
  const total = emptyRow('الكل');
  for (const r of rows) {
    const outcome = outcomeOf(r.result);
    const hour = zonedParts(r.createdAt, timezone).hour;
    if (!hours.has(hour)) hours.set(hour, emptyRow(String(hour)));
    add(hours.get(hour)!, outcome);
    add(tries.get(bucketOf(r.attemptNumber))!, outcome);
    add(total, outcome);
  }
  return {
    byHour: [...hours.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => close(row)),
    byAttempt: ATTEMPT_BUCKETS.map((b) => close(tries.get(b)!)),
    total: close(total),
  };
}

/** The report over a range, for one store. One bounded read of three columns. */
export async function answerRateReport(input: {
  companyId: string;
  storeId: string;
  timezone: string;
  start: Date;
  end: Date;
}): Promise<AnswerRateReport> {
  const { companyId, storeId, timezone, start, end } = input;
  const rows = await db.orderContactAttempt.findMany({
    where: { companyId, order: { storeId }, createdAt: { gte: start, lte: end } },
    select: { result: true, attemptNumber: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: REPORT_ROW_CAP,
  });
  return { ...tallyAnswerRate(rows, timezone), truncated: rows.length >= REPORT_ROW_CAP };
}
