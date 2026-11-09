import type { Prisma } from '@prisma/client';
import type { BusinessCalendar } from './business-calendar';
import {
  ROUND_GAP_BUSINESS_MINUTES,
  countedRounds,
  releaseCutoffs,
  roundsClose,
  roundsOn,
  roundsReleaseReason,
  sinceLastReached,
  workClock,
  type AttemptFact,
  type ReleaseCutoffs,
  type RoundsSwitch,
  type WorkClock,
} from './no-answer-rounds';
import type { ReturnsMode } from './no-answer-returns';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «الشغل أول» — THE WORK SHE OWES COMES BEFORE A NEW PULL (the owner, 8/11).
 *
 * One agent held 489 orders and 479 of them sat in «لا يرد». Two facts of the old code made that possible:
 *
 *   · the desk decided a tab by ONE number, the count of no-answers, so an order she pulled that had been rung before landed
 *     under «لا يرد» and «للشغل» said 0 — she did not see she had something to do, and pulled another;
 *   · the pull refused her only while she held an order with NO attempt at all (`UNTOUCHED_ORDER`), and one click on «لا يرد»
 *     satisfied it.
 *
 * This file is the ONE question both halves ask — «does she owe this order a call right now?» — so the tab, the count, the
 * banner, the button and the pull's refusal can never disagree (the same reason the desk's split is made on the server).
 *
 * ── WHEN AN ORDER IS DUE NOW (an order she holds: hers, open, never shipped) ──
 *
 *   1 · NEW      — it has no contact attempt at all. What `UNTOUCHED_ORDER` already means: a pull nobody has rung. With
 *                  «نظام الجولات» off this is the ONLY case that exists, and it is today's behaviour.
 *   2 · ROUND    — it is in the no-answer cycle (since the last call that reached somebody, every attempt is a no-answer
 *                  or a button press) and its next round is due: no round has been COUNTED yet (a «لا يرد» pressed without
 *                  «اتصل» before it does not count — R5 — so she must dial, then log it), or at least
 *                  `ROUND_GAP_BUSINESS_MINUTES` working minutes have passed since the START of the last counted round.
 *   3 · PROMISE  — a date came due (`postponedUntil` or `nextFollowUpAt` ≤ now) and nothing was logged on the order since
 *                  that date: the customer asked to be called, the day came, she has not worked it.
 *
 * ── AND WHEN IT IS NOT ──
 *
 *   · a date still ahead — it falls due the moment the date arrives;
 *   · an order the next rounds-release pass will take (`roundsReleaseReason`) — it is leaving within minutes, and blocking a
 *     pull for it would wall every desk that already holds a pile on the first deploy;
 *   · an order the rounds close (R3) — the contact door closes it on the press that makes the third round;
 *   · an order whose last attempt REACHED the customer with no date and no cycle: it needs a decision (confirm, postpone,
 *     cancel), not a call, and it was never a blocker. Its tab and behaviour are exactly what they were.
 *
 * Everything about rounds applies only with «نظام الجولات» on. Pure: no clock of its own, no database — the caller hands
 * it the order's attempts, and one `DueContext` per request places the working calendar once.
 * ═══════════════════════════════════════════════════════════════════════
 */

export type DueReason = 'NEW' | 'PROMISE' | 'ROUND';

export interface DueVerdict {
  /** She owes this order a call right now. */
  due: boolean;
  /** Why, when it is due. */
  reason: DueReason | null;
  /** In the no-answer cycle and not due yet — «بانتظار». Always false with «نظام الجولات» off. */
  waiting: boolean;
  /** When it becomes due, when a time is known: the end of the round gap, or the date that is still ahead. */
  dueAt: Date | null;
}

const NOT_DUE: DueVerdict = Object.freeze({ due: false, reason: null, waiting: false, dueAt: null });
const DUE_NEW: DueVerdict = Object.freeze({ due: true, reason: 'NEW', waiting: false, dueAt: null });
const DUE_ROUND: DueVerdict = Object.freeze({ due: true, reason: 'ROUND', waiting: false, dueAt: null });
const DUE_PROMISE: DueVerdict = Object.freeze({ due: true, reason: 'PROMISE', waiting: false, dueAt: null });

/** What `dueVerdict` needs to know about the order — all of it is on the row the desk and the pull already read. */
export interface DueOrder {
  claimedAt?: Date | string | null;
  claimedById?: string | null;
  postponedUntil?: Date | string | null;
  nextFollowUpAt?: Date | string | null;
}

/** One per request: the working calendar is placed once, whatever the number of orders asked about. */
export interface DueContext {
  now: Date;
  clock: WorkClock;
  rounds: RoundsSwitch;
  cut: ReleaseCutoffs;
}

export function dueContext(args: { now: Date; cal: BusinessCalendar; rounds: RoundsSwitch; clock?: WorkClock }): DueContext {
  // A caller that already placed the calendar for this request (the desk counts rounds with it) hands it over.
  const clock = args.clock ?? workClock(args.cal);
  return { now: args.now, clock, rounds: args.rounds, cut: releaseCutoffs(args.now, clock) };
}

const EPOCH = new Date(0);
const ms = (v: Date | string | null | undefined): number => (v ? new Date(v).getTime() : Number.NaN);
/** `WorkClock.forward` answers this when the calendar has no working time at all. */
const NEVER_MS = 8.64e15;

/**
 * THE VERDICT FOR ONE ORDER. `attempts` are ALL of the order's contact attempts, in any order.
 *
 * The cases are checked in the order that matters: a date ahead and an order that is leaving or closed are never due,
 * whatever else is true of them; then the promise; then the round.
 */
export function dueVerdict(order: DueOrder, attempts: readonly AttemptFact[], ctx: DueContext): DueVerdict {
  // 1 · NEW — nobody has tried to reach the customer. With the switch off this is the only case there is.
  if (attempts.length === 0) return DUE_NEW;
  const sw = ctx.rounds;
  if (!roundsOn(sw)) return NOT_DUE;

  const now = ctx.now.getTime();
  const dates = [ms(order.postponedUntil), ms(order.nextFollowUpAt)].filter((n) => !Number.isNaN(n));
  const later = dates.length ? Math.max(...dates) : null;
  /** Since the last call that reached somebody, only no-answers and presses: the cycle a round is made of. */
  const cycle = sinceLastReached(attempts).length > 0;

  // A date still ahead keeps it off her list, whatever else is true. Nothing can be logged after a future date, so it falls
  // due the moment the date arrives.
  if (later !== null && later > now) return { due: false, reason: null, waiting: cycle, dueAt: new Date(later) };

  const rounds = countedRounds(attempts, ctx.clock);
  const leaving =
    roundsReleaseReason(
      {
        claimedAt: order.claimedAt ?? EPOCH,
        claimedById: order.claimedById,
        postponedUntil: order.postponedUntil,
        nextFollowUpAt: order.nextFollowUpAt,
      },
      attempts,
      sw,
      ctx.cut
    ) !== null;
  // Leaving within minutes (the next release pass takes it) or closed by the third round: not a call she owes.
  if (leaving || roundsClose(rounds)) return { due: false, reason: null, waiting: cycle, dueAt: null };

  // 3 · PROMISE — the date came and nothing was logged on the order since (an attempt AT the date's instant counts as logged).
  if (later !== null && !attempts.some((a) => new Date(a.createdAt).getTime() >= later)) return DUE_PROMISE;

  // Reached the customer, no date, no cycle: a decision to take, not a call to make.
  if (!cycle) return NOT_DUE;

  // 2 · ROUND — none counted yet (she must dial and then log), or the gap since the last one began is over.
  const last = rounds.counted[rounds.counted.length - 1];
  if (!last || ctx.clock.minutesBetween(last, ctx.now) >= ROUND_GAP_BUSINESS_MINUTES) return DUE_ROUND;
  const ready = ctx.clock.forward(last, ROUND_GAP_BUSINESS_MINUTES);
  return { due: false, reason: null, waiting: true, dueAt: ready.getTime() >= NEVER_MS ? null : ready };
}

/** The predicate, as a yes or no. */
export function isDueNow(order: DueOrder, attempts: readonly AttemptFact[], ctx: DueContext): boolean {
  return dueVerdict(order, attempts, ctx).due;
}

/**
 * The verdict when the only thing known about the order is HOW MANY attempts it carries — the desk with «نظام الجولات» off
 * reads a count, not the attempts. The same first case as `dueVerdict`, written once.
 */
export function verdictFromCount(attemptCount: number): DueVerdict {
  return attemptCount === 0 ? DUE_NEW : NOT_DUE;
}

/**
 * WHICH TAB OF «طلباتي» HOLDS THE ORDER — decided by the verdict, with the old count deciding only what the verdict leaves open.
 *
 *   · due now                          → «اتصلي هلّق» (work);
 *   · in the no-answer cycle, not due  → «بانتظار» (noAnswer);
 *   · anything else — an order that needs a decision, and every order with the switch off — goes where its count of
 *     no-answers always put it: none, work; one or more, noAnswer. An open order past the limit stays in «بانتظار», so
 *     it is never on no list at all.
 */
export function deskTab(verdict: DueVerdict, noAnswerCount: number): 'work' | 'noAnswer' {
  if (verdict.due) return 'work';
  if (verdict.waiting) return 'noAnswer';
  return noAnswerCount > 0 ? 'noAnswer' : 'work';
}

/** The oldest due order and how many are due: what the banner, the button and the refusal all say. */
export interface DueSummary {
  count: number;
  first: { id: string; orderNumber: string } | null;
}

export interface DueRow {
  id: string;
  orderNumber: string;
  claimedAt?: Date | string | null;
  due: boolean;
}

/** Oldest claim first (the one that has waited longest), a row with no claim time last, then the order number. */
export function oldestFirst(a: Pick<DueRow, 'claimedAt' | 'orderNumber'>, b: Pick<DueRow, 'claimedAt' | 'orderNumber'>): number {
  const x = ms(a.claimedAt);
  const y = ms(b.claimedAt);
  const ax = Number.isNaN(x) ? Infinity : x;
  const by = Number.isNaN(y) ? Infinity : y;
  if (ax !== by) return ax < by ? -1 : 1;
  return a.orderNumber < b.orderNumber ? -1 : a.orderNumber > b.orderNumber ? 1 : 0;
}

export function summariseDue(rows: readonly DueRow[]): DueSummary {
  const due = rows.filter((r) => r.due);
  if (due.length === 0) return { count: 0, first: null };
  const first = [...due].sort(oldestFirst)[0];
  return { count: due.length, first: { id: first.id, orderNumber: first.orderNumber } };
}

// ───────────────────────────── the words ─────────────────────────────

/** «طلب واحد» · «طلبين» · «5 طلبات» · «12 طلب» — the way an order is counted in the speech of the desk. */
export function ordersCounted(n: number): string {
  if (n === 1) return 'طلب واحد';
  if (n === 2) return 'طلبين';
  const tail = n % 100;
  if (tail >= 3 && tail <= 10) return `${n} طلبات`;
  return `${n} طلب`;
}

/** The banner's sentence, and the first half of the refusal's. */
export function dueSentence(count: number): string {
  return `عندك ${ordersCounted(count)} لازم ترني ${count === 1 ? 'عليه' : 'عليهم'} هلّق`;
}

/** The banner when nothing is owed and a pull is possible. */
export const CAUGHT_UP_SENTENCE = 'خلّصتي. اسحبي التالي';
/** The pull button while she owes a call: pressing it opens the oldest of them instead of pulling. */
export const WORK_FIRST_BUTTON = 'اسحب طلب جديد — خلّصي اللي فوق أول';

export const NEW_TAG = 'جديد — سحبتيه هلّق';
export const PROMISE_TAG = 'الزبون طلب نكلمو هلّق';

/** The tag on a card that is due: what she pulled, in a few words. */
export function dueTag(reason: DueReason, rounds: number, limit: number): string {
  if (reason === 'NEW') return NEW_TAG;
  if (reason === 'PROMISE') return PROMISE_TAG;
  return rounds > 0 ? `لا يرد راجع — جولة ${rounds} من ${limit}` : 'لا يرد راجع';
}

/**
 * THE WORDS ON A CARD, written once — on the server: a card she owes says what she pulled (`dueTag`); a card that is waiting
 * says when it is ready (`readyAtWords`, on the store's clock). Null when the card has nothing to say. The screen prints this
 * line and ships no wording logic of its own: «طلباتي» is the agents' first-load JavaScript, held under a ceiling
 * (`staff-confirmation-first-load.test.ts`), and a formatter and a sentence-builder there cost bytes on every agent's phone.
 */
export function dueLabel(verdict: DueVerdict, args: { rounds: number; limit: number; now: Date; timeZone?: string | null }): string | null {
  if (verdict.due && verdict.reason) return dueTag(verdict.reason, args.rounds, args.limit);
  if (verdict.dueAt) return readyAtWords(verdict.dueAt, args.now, args.timeZone);
  return null;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(key: string, make: () => Intl.DateTimeFormat): Intl.DateTimeFormat {
  let f = formatters.get(key);
  if (!f) {
    f = make();
    formatters.set(key, f);
  }
  return f;
}

/** The store's own timezone when it is a real one; the machine's otherwise. */
function zoneOf(timeZone: string | undefined | null): string | undefined {
  if (!timeZone) return undefined;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
    return timeZone;
  } catch {
    return undefined;
  }
}

/**
 * «جاهز الساعة 14:30» — WHEN A WAITING ORDER IS READY, ON THE STORE'S CLOCK.
 *
 * The time is the store's (its timezone, 24-hour, Latin digits, as `arTime` writes it elsewhere). A day word is added only
 * when the day is not today — «بكرة», or the weekday inside the week — because "ready at 09:00" read at 16:00 on a Thursday is
 * a sentence she would have to work out.
 */
export function readyAtWords(dueAt: Date | string, now: Date, timeZone?: string | null): string {
  const at = new Date(dueAt);
  if (Number.isNaN(at.getTime())) return '';
  const zone = zoneOf(timeZone);
  const key = zone ?? 'device';
  const clockOf = formatter(`clock:${key}`, () => new Intl.DateTimeFormat('en-CA', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
  const dayOf = formatter(`day:${key}`, () => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }));
  const time = clockOf.format(at);
  const gap = Math.round((Date.parse(`${dayOf.format(at)}T00:00:00Z`) - Date.parse(`${dayOf.format(now)}T00:00:00Z`)) / 86_400_000);
  let day = '';
  if (gap === 1) day = 'بكرة ';
  else if (gap >= 2 && gap <= 6) day = `${formatter(`week:${key}`, () => new Intl.DateTimeFormat('ar-u-nu-latn', { timeZone: zone, weekday: 'long' })).format(at)} `;
  else if (gap >= 7) day = `${formatter(`date:${key}`, () => new Intl.DateTimeFormat('ar-u-nu-latn', { timeZone: zone, day: 'numeric', month: 'long' })).format(at)} `;
  return `جاهز ${day}الساعة ${time}`;
}

// ───────────────────────────── the pull's gate ─────────────────────────────

/**
 * THE PULL'S REFUSAL: `code`, the sentence, the oldest order she owes (so the screen opens it) and how many she owes.
 * `UNTOUCHED_ORDER` carries its order the same way (`PullRefusal`).
 */
export interface WorkFirstRefusal {
  code: 'WORK_FIRST';
  message: string;
  orderId: string;
  orderNumber: string;
  count: number;
}

export function workFirstRefusal(summary: DueSummary): WorkFirstRefusal | null {
  if (summary.count <= 0 || !summary.first) return null;
  return {
    code: 'WORK_FIRST',
    message: `${dueSentence(summary.count)} قبل سحب طلب جديد — أولها الطلب ${summary.first.orderNumber}.`,
    orderId: summary.first.id,
    orderNumber: summary.first.orderNumber,
    count: summary.count,
  };
}

/**
 * MAY SHE PULL — THE ONE QUESTION THIS FILE ADDS TO THE PULL (asked inside the pull's own transaction, after every refusal the
 * pull already had and before anything is taken).
 *
 * Cheap and bounded: with the switch off it reads nothing; with it on it makes ONE read of the orders she holds — at most the cap
 * (`room`) — with only the fields and attempts `dueVerdict` needs, and every verdict after that is arithmetic on instants (the
 * working calendar is placed once). No query per order. The database narrows what it cheaply can: hers, open, never shipped,
 * and not dated for later (an order with attempts and a date ahead is never due; one with no attempt is `NEW` whatever its
 * dates, as `UNTOUCHED_ORDER` reads it). The cap IS the other narrowing: she cannot hold more.
 *
 * What is only HELD FOR her (a returning customer's order she has not pulled) is not in her hands and is not read.
 */
export async function workFirstGate(
  tx: Pick<Prisma.TransactionClient, 'order'>,
  args: {
    scope: { companyId: string; storeId: string };
    userId: string;
    cal: BusinessCalendar;
    now: Date;
    rounds: RoundsSwitch;
    /** The statuses that still belong to the confirmation stage (`OPEN_CONFIRMATION`). */
    open: readonly string[];
    /** The most she may hold (`CLAIM_CAPS.total`): the read never takes more. */
    room: number;
    /** How many open orders she holds, when the caller already counted — none means nothing to read. */
    held?: number;
    /**
     * «الطلب يرجع للطابور فوراً» on (`no-answer-returns.ts`): the rule goes quiet by construction, not by deletion. An order she rang
     * to no answer is not in her hand to be owed, and she pulls one at a time (`UNTOUCHED_ORDER`) — so nothing holds the pull back here.
     * Absent or null, the gate is exactly what it was.
     */
    returns?: ReturnsMode | null;
  }
): Promise<WorkFirstRefusal | null> {
  if (!roundsOn(args.rounds)) return null;
  if (args.returns) return null;
  if (args.held === 0) return null;
  const ctx = dueContext({ now: args.now, cal: args.cal, rounds: args.rounds });
  const rows = await tx.order.findMany({
    where: {
      ...args.scope,
      claimedById: args.userId,
      confirmationStatus: { in: [...args.open] },
      // Never shipped — the contact door's own reading of «still ours to call».
      shippingStatus: 'NOT_READY',
      shippingBatchId: null,
      trackingNumber: null,
      labelPrintedAt: null,
      OR: [
        { contactAttempts: { none: {} } },
        {
          AND: [
            { OR: [{ postponedUntil: null }, { postponedUntil: { lte: args.now } }] },
            { OR: [{ nextFollowUpAt: null }, { nextFollowUpAt: { lte: args.now } }] },
          ],
        },
      ],
    },
    orderBy: { claimedAt: 'asc' },
    take: args.room,
    select: {
      id: true,
      orderNumber: true,
      claimedAt: true,
      claimedById: true,
      postponedUntil: true,
      nextFollowUpAt: true,
      contactAttempts: { select: { createdAt: true, result: true, attemptNumber: true, employeeId: true } },
    },
  });
  return workFirstRefusal(
    summariseDue(rows.map((row) => ({ id: row.id, orderNumber: row.orderNumber, claimedAt: row.claimedAt, due: isDueNow(row, row.contactAttempts, ctx) })))
  );
}
