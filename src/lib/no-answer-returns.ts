import type { Prisma } from '@prisma/client';
import { NO_ANSWER_RESULTS } from './confirmation-workflow';
import { ROUND_GAP_BUSINESS_MINUTES, roundsOn, type RoundsSwitch, type WorkClock } from './no-answer-rounds';
import { askedDate, promiseArrived } from './work-first';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «الطلب يرجع للطابور فوراً (تجريبي)» — THE RULES, WITH NOTHING READ (the owner, 9/11: «ابسط»).
 *
 * Behind a switch that is OFF unless the owner turns it on (`no-answer-returns-switch.ts`) AND «نظام الجولات» is on too: the close
 * (R2 · R3 · R5, `no-answer-rounds.ts`) is the rounds' counting, so with the rounds off this mode is off whatever is stored.
 *
 * WHY: a «لا يرد» order stayed in the agent's hands for up to twelve working hours, and one agent held 489 of them. Everything
 * built around that (the cap of 500 and 40 untouched, «الشغل أول», the pace, the twelve-hour release, the manager's return button,
 * the «بانتظار» tab) is a rule about orders sitting in somebody's hands. This mode takes them out of her hands instead.
 *
 * ── THE WHOLE RULE ──
 *
 *   OUT OF HER HAND, at once:
 *     (a) her press of «لا يرد» / busy / unreachable — the order is ready again `ROUND_GAP_BUSINESS_MINUTES` working minutes later;
 *     (b) a date she saved (a postponement, «اتصل لاحقاً») — ready AT the date (lead 0, not the two-day lead the old pull used);
 *     (c) nothing logged on it for `RETURNS_MODE.idleBusinessMinutes` working minutes — it goes back as it was, with a notice to her;
 *     (d) a decision (confirm · reject · cancel) ends it, as ever;
 *     (e) the third COUNTED round on two different days still closes it — that counting is the rounds', unchanged.
 *
 *   HER HAND is at most `RETURNS_MODE.handLimit`, in her hands plus held for her (`capLoad`). She pulls one at a time. (That is what
 *   the queue hands her: the orders she types herself are not counted against it — the creation doors are untouched, BACKLOG RV1658.)
 *
 *   THE POOL, in the order a pull takes it (`pickNextCandidate`; «الأولوية دائما للطلبات الجديدة» stays):
 *     1 · held for her (a returning customer, a twin)    2 · NEW — nobody has rung — oldest first
 *     3 · a promise whose date arrived, nearest first     4 · a returned order whose ready-time arrived — with the cadence on: the
 *         retry with the OLDEST due first (ties: the older order), then the rest oldest first; otherwise oldest first
 *   With the cadence on, step 3 widens (the planner 15/11, ruling 13): a PROMISE is any pullable order — of any status — whose customer-asked date arrived with
 *   nothing logged since (`promiseArrived`, `firstPromiseByDate`), and it goes before the retries; an order that is both a promise and a retry is a promise.
 *     and a bucket nobody pulls from: «بينتظر وقتو» — a date not yet arrived, or a «لا يرد» not yet three working hours old.
 *
 * ── READY, WITH NO NEW COLUMN ──
 *
 * An order in the pool is ready when
 *   · no «لا يرد» (any of `NO_ANSWER_RESULTS`) is NEWER than `readyCut` = `ROUND_GAP_BUSINESS_MINUTES` working minutes back from
 *     now — the order was pressed at T, so it is ready from `clock.forward(T, gap)`, which is `T <= clock.back(now, gap)`; and
 *   · every date it carries has arrived — the LATER of `postponedUntil` and `nextFollowUpAt` (the rounds' reading, `laterDate`).
 *     A postponement writes the same date in both columns and the other presses only the follow-up one, so this is
 *     `postponedUntil ?? nextFollowUpAt <= now` for everything the doors write; the later of the two is only stricter when a stale
 *     postponement date sits beside a fresher follow-up date.
 * Both are filters (`returnsReadyAnd`): the pull's picks, the counters and the supervisor's numbers read these two lines and
 * nothing else, so «the number shown is what the pull can hand out». `returns-filters-agree-with-the-rule.test.ts` holds them to an
 * independent oracle (the working clock walked FORWARD from each press) on every combination of age, result and date.
 *
 * ⚠️ A CALENDAR WITH NO WORKING TIME AT ALL never reaches the database as a sentinel (`clock.back` answers year -271821, which
 * PostgreSQL does not store — `return-no-answer-pile.ts`, #230). Both cut-offs are held at the epoch: every real attempt is then
 * «recent» and no real claim is idle — «nothing is old enough», as a date the database can compare.
 *
 * NOTHING HERE TOUCHES MONEY, ORDER CREATION OR A CONTRACT.
 * ═══════════════════════════════════════════════════════════════════════
 */

/** The claim-history reasons of the three ways an order leaves her hand in this mode — named in Arabic on the timeline (`order-timeline.ts`). */
export const NO_ANSWER_RETURNED_REASON = 'NO_ANSWER_RETURNED';
export const DATE_RETURNED_REASON = 'DATE_RETURNED';
/** Starts with `AUTO_RELEASE` like the other releases nobody pressed, so every reader that tells the system's lines apart sees it as one. */
export const IDLE_RETURNED_REASON = 'AUTO_RELEASE_IDLE_RETURNED';
export type ReturnsReason = typeof NO_ANSWER_RETURNED_REASON | typeof DATE_RETURNED_REASON | typeof IDLE_RETURNED_REASON;

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE RULE THAT WROTE A LINE (the planner 15/11 22:30, ruling 28).
 *
 * `NO_ANSWER_RETURNED` is one stored reason for two rules (the three-hour mode and «جدول المحاولات»), and the timeline's word for it follows the rule that WROTE the line — not the
 * switch at read time (flip the switch later and an old line must not change its story). So the PLAN's door stamps `{ "rule": "plan" }` into the line's own `metadata` (a JSON text
 * column, merged with whatever it already carries: `automatic`, `holder`…) when it writes. The older doors write nothing new: a line with no mark reads the older word, byte for byte.
 *
 * Every reader of that column (`isAutomaticRelease`, `managerReturnedBy`, `onTheLinePeople`, attendance, held-flow) parses it and looks at its own keys; an extra key is invisible to them.
 * ═══════════════════════════════════════════════════════════════════════
 */
export const PLAN_RULE_MARK = 'plan';

/** The rule a claim-history line says wrote it — today only `'plan'` — or null: no metadata, metadata that is not JSON, or a line the older doors wrote. Never throws. */
export function ruleOfLine(row: { metadata?: string | null }): typeof PLAN_RULE_MARK | null {
  if (!row.metadata) return null;
  try {
    const m = JSON.parse(row.metadata) as { rule?: unknown } | null;
    return m && typeof m === 'object' && m.rule === PLAN_RULE_MARK ? PLAN_RULE_MARK : null;
  } catch {
    return null;
  }
}

/** The line's metadata with the plan's mark merged in (every key it already had is kept). Metadata that is not a JSON object is replaced by just the mark. */
export function withPlanRuleMark(metadata: string | null | undefined): string {
  let base: Record<string, unknown> = {};
  try {
    const m = metadata ? (JSON.parse(metadata) as unknown) : null;
    if (m && typeof m === 'object' && !Array.isArray(m)) base = m as Record<string, unknown>;
  } catch {
    // Not JSON: nothing worth keeping.
  }
  return JSON.stringify({ ...base, rule: PLAN_RULE_MARK });
}

/**
 * THE PLAN'S DOOR STAMPS THE LINE IT JUST WROTE, in the same transaction (`returnToThePool` has returned true): the newest «NO_ANSWER_RETURNED» release of this holder on this order gets
 * the mark merged into its metadata. Only the plan's door calls this — with the plan off nothing is read and nothing is written. Returns whether a line was marked.
 */
export async function markPlanReturnLine(tx: Prisma.TransactionClient, args: { companyId: string; orderId: string; holderId: string }): Promise<boolean> {
  const row = await tx.orderClaimHistory.findFirst({
    where: { companyId: args.companyId, orderId: args.orderId, userId: args.holderId, action: 'RELEASED', reason: NO_ANSWER_RETURNED_REASON },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, metadata: true },
  });
  if (!row) return false;
  await tx.orderClaimHistory.update({ where: { id: row.id }, data: { metadata: withPlanRuleMark(row.metadata) } });
  return true;
}

/** What the switch says — the very shape of «نظام الجولات»' (`{ enabled, enabledAt }`), stored under its own key. */
export type ReturnsSwitch = RoundsSwitch;
export const RETURNS_OFF: ReturnsSwitch = Object.freeze({ enabled: false, enabledAt: null }) as ReturnsSwitch;

/** Plainly on: a real `true` with a real date — the only state in which the mode can apply. */
export function returnsSwitchOn(sw: ReturnsSwitch | null | undefined): boolean {
  return roundsOn(sw);
}

/** The mode, ON, at one moment: the cut-offs placed ONCE from the store's calendar, never per order. */
export interface ReturnsMode {
  /** The moment every question below is asked about. */
  now: Date;
  /** A «لا يرد» at or before this is `ROUND_GAP_BUSINESS_MINUTES` working minutes old: its order is ready again. Never before 1970. */
  readyCut: Date;
  /** A claim or a logged attempt at or before this is `idleBusinessMinutes` working minutes old: nothing happened since. Never before 1970. */
  idleCut: Date;
  /** The idle limit `idleCut` was placed with (30, or 20 under «أولوية الطابور») — so the notice of an idle release can say the figure the release used. Absent on a mode built by hand. */
  idleBusinessMinutes?: number;
  /**
   * «جدول المحاولات» ON (step B, `no-answer-cadence.ts`): readiness is the plan's due instant written on the line, not the `ROUND_GAP_BUSINESS_MINUTES` gap. `since` is the switch's
   * `enabledAt` — the FLOOR: a line at or before it holds nothing. The key is OMITTED, never `undefined`, when the cadence is off, so every older shape stays byte for byte.
   */
  cadence?: { since: Date };
}

const atEpochAtLeast = (edge: Date): Date => new Date(Math.max(edge.getTime(), 0));

export function returnsMode(now: Date, clock: WorkClock, idleBusinessMinutes: number, cadenceSince: Date | null = null): ReturnsMode {
  return {
    now,
    readyCut: atEpochAtLeast(clock.back(now, ROUND_GAP_BUSINESS_MINUTES)),
    idleCut: atEpochAtLeast(clock.back(now, idleBusinessMinutes)),
    idleBusinessMinutes,
    ...(cadenceSince ? { cadence: { since: cadenceSince } } : {}),
  };
}

// ───────────────────────── readiness, as filters ─────────────────────────

/** No «لا يرد» newer than the cut: the three working hours of the last one are over (or there was none). */
export function noRecentNoAnswerWhere(mode: Pick<ReturnsMode, 'readyCut'>) {
  return { contactAttempts: { none: { result: { in: [...NO_ANSWER_RESULTS] }, createdAt: { gt: mode.readyCut } } } };
}

/** Every date the order carries has arrived — both clauses are NULL-safe (`IS NULL` is its own branch), and no date at all is «arrived». */
export function datesArrivedAnd(mode: Pick<ReturnsMode, 'now'>) {
  return [
    { OR: [{ postponedUntil: null }, { postponedUntil: { lte: mode.now } }] },
    { OR: [{ nextFollowUpAt: null }, { nextFollowUpAt: { lte: mode.now } }] },
  ];
}

/**
 * THE CADENCE'S READINESS (step B): no «لا يرد» line, logged AFTER the switch went on, still carries a due instant in the future. The due is written by the door on the line itself
 * (`nextFollowUpAt`, a COUNTED press only — an early press and the fifth write none), so the pool reads one stored instant and recomputes nothing. Only `none` / `in` / `gt`:
 * NULL-safe (a NULL due is unknown, never true, and a row that is not true never blocks a `none`), and a line due exactly NOW is ready — the same comparison the pure plan counts with.
 */
export function cadenceReadyWhere(mode: { now: Date; cadence: { since: Date } }) {
  return {
    contactAttempts: {
      none: { result: { in: [...NO_ANSWER_RESULTS] }, createdAt: { gt: mode.cadence.since }, nextFollowUpAt: { gt: mode.now } },
    },
  };
}

/**
 * THE LINES THAT RANK A RETRY (the planner's ruling 2: «الإعادات اللي حان موعدها بتترتّب بالموعد»). The same set `cadenceReadyWhere` holds an order by — a «لا يرد»-class line, logged
 * after the floor, carrying a due — so the lines that make an order wait are the lines that say when it was due. `not: null`, never `gt`: the due of a READY order has passed.
 */
export function cadenceDueLineWhere(since: Date) {
  return { result: { in: [...NO_ANSWER_RESULTS] }, createdAt: { gt: since }, nextFollowUpAt: { not: null } };
}

export interface RetryLine {
  result: string;
  createdAt: Date | string;
  nextFollowUpAt?: Date | string | null;
}
export interface RetryRow {
  id: string;
  createdAt: Date | string;
  contactAttempts: readonly RetryLine[];
}

/**
 * An order's retry due, in ms: the LATEST due on the lines above — the due the last COUNTED press wrote (dues grow with every counted press; an early press and the fifth write none).
 * Null when no line qualifies. The predicate is applied again here on purpose: a test double that ignores `select` hands over every line, and on Prisma it is a no-op.
 *
 * ⚠️ «The latest due» equals «the due of the last counted line» only while dues grow with every counted press (`dueAfter`, `no-answer-cadence.ts`). If a rule ever lets a later
 * counted press carry an EARLIER due, this must become «the due of the latest counted line by `attemptNumber`».
 */
export function retryDueOf(lines: readonly RetryLine[], since: Date): number | null {
  let latest: number | null = null;
  for (const l of lines) {
    if (!(NO_ANSWER_RESULTS as readonly string[]).includes(l.result) || l.nextFollowUpAt == null) continue;
    if (!(new Date(l.createdAt).getTime() > since.getTime())) continue;
    const due = new Date(l.nextFollowUpAt).getTime();
    if (!Number.isNaN(due) && (latest === null || due > latest)) latest = due;
  }
  return latest;
}

/** The retry the pull gives first among the rows — the oldest due; equal due → the older order → the smaller id — WITH its due (the aging rule of step D asks how long it has waited). Null when no row carries a due. */
export function firstRetryWithDue(rows: readonly RetryRow[], since: Date): { id: string; due: number } | null {
  let best: { id: string; due: number; born: number } | null = null;
  for (const r of rows) {
    const due = retryDueOf(r.contactAttempts, since);
    if (due === null) continue;
    const born = new Date(r.createdAt).getTime();
    if (best === null || due < best.due || (due === best.due && (born < best.born || (born === best.born && r.id < best.id)))) best = { id: r.id, due, born };
  }
  return best ? { id: best.id, due: best.due } : null;
}

/** The id the pull gives first among the retries: the oldest due; equal due → the older order → the smaller id. Null when no row carries a due. */
export function firstRetryByDue(rows: readonly RetryRow[], since: Date): string | null {
  return firstRetryWithDue(rows, since)?.id ?? null;
}

/** One order as the promise ranking reads it: its dates and its NEWEST line (or all of them — `promiseArrived` asks the same question of either). */
export interface PromiseRow {
  id: string;
  createdAt: Date | string;
  postponedUntil?: Date | string | null;
  nextFollowUpAt?: Date | string | null;
  contactAttempts: readonly { createdAt: Date | string }[];
}

/**
 * THE PROMISES, RANKED (the planner 15/11, ruling 13: «الوعد اللي وصل وقته أول»): of the rows, the id the pull gives first among those whose customer-asked date has ARRIVED with no line logged
 * at or after it (`promiseArrived` — the same fact the desk's tag reads). The promise whose date came first goes first; equal date → the older order → the smaller id. Null when no row is a
 * promise. The fact is applied here on purpose, to every row: the database only narrows (a date on the order), and a test double that ignores `select` hands over every line.
 */
export function firstPromiseByDate(rows: readonly PromiseRow[], now: Date): string | null {
  let best: { id: string; asked: number; born: number } | null = null;
  for (const r of rows) {
    if (!promiseArrived(r, r.contactAttempts, now)) continue;
    const asked = askedDate(r)!;
    const born = new Date(r.createdAt).getTime();
    if (best === null || asked < best.asked || (asked === best.asked && (born < best.born || (born === best.born && r.id < best.id)))) best = { id: r.id, asked, born };
  }
  return best ? best.id : null;
}

/** The «لا يرد» clause of «ready»: the plan's due when the cadence is on, the three working hours otherwise. */
export function noAnswerReadyWhere(mode: ReturnsMode) {
  return mode.cadence ? cadenceReadyWhere({ now: mode.now, cadence: mode.cadence }) : noRecentNoAnswerWhere(mode);
}

/** The two lines of «ready», as `AND` members — the pull's picks and the counters append exactly these. */
export function returnsReadyAnd(mode: ReturnsMode) {
  return [...datesArrivedAnd(mode), noAnswerReadyWhere(mode)];
}

/**
 * The words of the hand limit — the sentence a pull refused at the limit says (the owner, 9/11). It names the number and the two
 * ways out, and the button it points at is the one the order sheet already draws.
 */
export function handLimitMessage(limit: number): string {
  return `وصلت للحد (${limit}) — خلّصي واحد أو اضغطي «أعِدْه إلى الطابور»`;
}
