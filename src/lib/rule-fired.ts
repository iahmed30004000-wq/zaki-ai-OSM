import type { Prisma } from '@prisma/client';
import { db } from './db';
import { heavyOnce, REPORT_TTL_MS } from '@/lib/heavy-lane';
import { can, hasFullAccess } from './authorization';
import { resolveAudience } from './notification-audience';
import { DESK_KEYS, deskReadiness, type HoldVerdict } from './desk-readiness';
import { NINETY_MINUTE_RELEASE_REASON } from './auto-release';
import { IDLE_RETURNED_REASON, NO_ANSWER_RETURNED_REASON } from './no-answer-returns';
import { REPULL_RELEASE_REASON, ROUND_RELEASE_REASON } from './no-answer-rounds';
import { NO_ANSWER_CLOSE_NOTES, NO_ANSWER_RESULTS } from './confirmation-workflow';
import { PULL_REASON } from './held-flow';
import { cadenceSince } from './no-answer-cadence-switch';
import { dayRange, localDay } from './eod-report';
import { notSuperseded } from './superseded';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «القاعدة اشتغلت عندها كم مرة» — ONE DAY OF THE STORE, PER PERSON AT THE DESK (request Q2b, 19/11).
 *
 * The rules page says who is bound (`desk-readiness.ts`). This says whether the rules actually CAUGHT anybody on a given day:
 * for each person at the desk of this store, how many times each rule fired at her. Every figure is read from a record a door or a
 * job already writes — nothing new is written here, and nothing is counted in the browser:
 *
 *   · pulls               `order_claim_history` CLAIMED with the pull's reason (`PULL_REASON`).
 *   · idle returns        RELEASED by the clock because nothing was logged on the order in time: the ninety minutes, the idle return
 *                          of «الطلب يرجع للطابور فوراً», and a re-pulled order left untouched.
 *   · no-answer returns   RELEASED after «لا يرد»: her press under «يرجع فوراً», and a round nobody answered.
 *   · counted / early     her «لا يرد» lines (`NO_ANSWER_RESULTS`). Under the call plan (`cadenceSince`) the door stores the next due on
 *                          every counted press but the last, and nothing on an early one; the last counted press is the one that
 *                          closed the order. So a line after the plan's start with no stored due that closed nothing is EARLY;
 *                          every other line counted. Without the plan every press counts (the rule of three counts them all).
 *   · auto-closes         the confirmation status line `endOrder` writes with one of `NO_ANSWER_CLOSE_NOTES`, by the person whose
 *                          press closed it.
 *   · call-proof refusals the `CALL_PROOF_REFUSED` audit row (the refusal log does not repeat it), kept to this store's orders.
 *   · other refusals      `desk_refusals` (Q2a), by code. A missing table (rolled back) is said, never a failure.
 *   · decided             orders she confirmed or rejected that day (an order whose sale carried on in another — `notSuperseded` —
 *                          is not a sale she decided). Not a rule's firing: it is what the red line asks.
 *
 * THE RED LINE. A person who decided orders that day while «اسحبي الطلب أول» does not bind her (exempt by a key, or not at the
 * desk's work at all) and who is not the owner: she worked and no rule held her. The verdict is the same `deskReadiness` the
 * «مين مربوطة» door answers, from her effective grants as her session builds them (`resolveAudience`) — today's grants, not that day's.
 *
 * THE LANE. The answer is a report: it runs in the reports lane through `heavyOnce`, keyed by company, store and day — never by
 * the person asking (the permission check is the door's, before it asks). Days are the STORE's days (`localDay` / `dayRange` with the
 * country's time zone): a refusal at 23:30 of the store's evening is that day's, whatever the server's clock says.
 *
 * Ids and counts only: no customer field is read, and the answer carries no order.
 * ═══════════════════════════════════════════════════════════════════════
 */

/** The releases of an order nobody logged anything on in time. */
export const IDLE_RETURN_REASONS = [NINETY_MINUTE_RELEASE_REASON, IDLE_RETURNED_REASON, REPULL_RELEASE_REASON] as const;
/** The releases that follow «لا يرد». */
export const NO_ANSWER_RETURN_REASONS = [NO_ANSWER_RETURNED_REASON, ROUND_RELEASE_REASON] as const;

/**
 * Each logged refusal's name, short and spoken, for the rules page — one per code of `DESK_REFUSAL_CODES` (`desk-refusals.ts`; the test
 * pins that every code has its name). Not imported from there: that file's importers are the refusing doors only (its own guard).
 */
export const REFUSAL_LABEL_AR: Record<string, string> = {
  NOT_HELD: 'اشتغلت على طلب مش بإيدها',
  CONTACT_FIRST: 'قرّرت قبل ما تتصل',
  POSTPONE_LIMIT: 'تخطّت حد التأجيل',
  NO_ANSWER_NOT_A_POSTPONE: '«لا يرد» مكتوبة كتأجيل',
  PULL_TOO_FAST: 'سحبت بسرعة',
  CAP_TOTAL: 'إيدها مليانة',
  CAP_WITHOUT_ATTEMPT: 'عندها طلبات ما اتصلت فيها',
  UNTOUCHED_ORDER: 'عندها طلب ما لمسته',
  WORK_FIRST: 'عليها اتصالات قبل السحب',
  USE_THE_PULL: 'أخدت طلب بالرقم بدل السحب',
  CANNOT_WORK_IT: 'حوّلت لحدا ما بيقدر يشتغله',
  DIFFERENT_RANK: 'حوّلت لشغل تاني',
  HELD_BY_COLLEAGUE: 'الزبون على الخط: الطلب بإيد زميلة',
  RESERVED_FOR_COLLEAGUE: 'الزبون على الخط: محجوز لزميلة',
  CLOSED: 'الزبون على الخط: الطلب مسكّر',
  NEVER_CALLED: 'الزبون على الخط: ما حدا اتصل فيه',
  REACHED_SINCE_RELEASE: 'الزبون على الخط: انوصل للزبون بعدها',
  TAKEN_MEANWHILE: 'الزبون على الخط: انسحب بنفس اللحظة',
};
const OTHER_REFUSAL_AR = 'رفض تاني';

export function refusalLabel(code: string): string {
  return REFUSAL_LABEL_AR[code] ?? OTHER_REFUSAL_AR;
}

export const ALARM_TODAY_AR = 'اشتغلت اليوم وما في قاعدة مسكتها';
export const ALARM_OTHER_DAY_AR = 'اشتغلت بهاليوم وما في قاعدة مسكتها';
export const DAY_INVALID_AR = 'اليوم غير صالح.';
export const DAY_IN_FUTURE_AR = 'هاليوم لسا ما إجا — اختار اليوم أو أمس.';

/** A ceiling on the rows one question reads; reaching it is said in the answer (`truncated`), never hidden. */
export const FIRED_ROW_CAP = 50_000;

export interface FiredCounters {
  pulls: number;
  idleReturns: number;
  noAnswerReturns: number;
  countedNoAnswer: number;
  earlyNoAnswer: number;
  autoCloses: number;
  callProofRefusals: number;
  /** Desk refusals by code (the log of Q2a). */
  refusals: Record<string, number>;
  /** Orders she confirmed or rejected that day. */
  decided: number;
}

export function emptyCounters(): FiredCounters {
  return { pulls: 0, idleReturns: 0, noAnswerReturns: 0, countedNoAnswer: 0, earlyNoAnswer: 0, autoCloses: 0, callProofRefusals: 0, refusals: {}, decided: 0 };
}

/** What the reads bring back — already scoped to the company, the store and the day. */
export interface FiredRows {
  claims: { userId: string; action: string; reason: string | null }[];
  noAnswers: { employeeId: string; orderId: string; createdAt: Date; nextFollowUpAt: Date | null }[];
  closes: { changedById: string; orderId: string; createdAt: Date }[];
  decisions: { changedById: string; orderId: string }[];
  proofRefusals: { userId: string }[];
  /** null: the refusal log could not be read (the table rolled back). */
  refusals: { userId: string; code: string; count: number }[] | null;
  truncated: boolean;
}

/** A closing press and its close are written in one transaction; this much clock between them is the same moment. */
const SAME_PRESS_MS = 5_000;

/**
 * THE TALLY — pure. Rows in, counters per person out. `planSince` is the call plan's start (`cadenceSince`), null when it is off.
 */
export function tallyFired(rows: FiredRows, planSince: Date | null): Map<string, FiredCounters> {
  const out = new Map<string, FiredCounters>();
  const of = (userId: string) => {
    let c = out.get(userId);
    if (!c) out.set(userId, (c = emptyCounters()));
    return c;
  };
  const idle: readonly string[] = IDLE_RETURN_REASONS;
  const noAnswer: readonly string[] = NO_ANSWER_RETURN_REASONS;

  for (const r of rows.claims) {
    if (r.action === 'CLAIMED' && r.reason === PULL_REASON) of(r.userId).pulls += 1;
    else if (r.action === 'RELEASED' && r.reason && idle.includes(r.reason)) of(r.userId).idleReturns += 1;
    else if (r.action === 'RELEASED' && r.reason && noAnswer.includes(r.reason)) of(r.userId).noAnswerReturns += 1;
  }

  // The press that closed each order: her latest «لا يرد» line on it at the moment of the close.
  const closing = new Set<FiredRows['noAnswers'][number]>();
  for (const c of rows.closes) {
    of(c.changedById).autoCloses += 1;
    let press: FiredRows['noAnswers'][number] | null = null;
    for (const l of rows.noAnswers) {
      if (l.orderId !== c.orderId || l.employeeId !== c.changedById) continue;
      if (l.createdAt.getTime() > c.createdAt.getTime() + SAME_PRESS_MS) continue;
      if (!press || l.createdAt.getTime() > press.createdAt.getTime()) press = l;
    }
    if (press) closing.add(press);
  }
  for (const l of rows.noAnswers) {
    const underPlan = planSince !== null && l.createdAt.getTime() > planSince.getTime();
    const early = underPlan && l.nextFollowUpAt === null && !closing.has(l);
    if (early) of(l.employeeId).earlyNoAnswer += 1;
    else of(l.employeeId).countedNoAnswer += 1;
  }

  for (const p of rows.proofRefusals) of(p.userId).callProofRefusals += 1;
  for (const r of rows.refusals ?? []) {
    const c = of(r.userId);
    c.refusals[r.code] = (c.refusals[r.code] ?? 0) + r.count;
  }

  const decided = new Map<string, Set<string>>();
  for (const d of rows.decisions) decided.set(d.changedById, (decided.get(d.changedById) ?? new Set()).add(d.orderId));
  for (const [userId, orders] of decided) of(userId).decided = orders.size;
  return out;
}

type Client = typeof db | Prisma.TransactionClient;

/** The reads, scoped to the company, the store and the store's day. Grouped, bounded, no customer field. */
export async function readFiredRows(client: Client, scope: { companyId: string; storeId: string; start: Date; end: Date }): Promise<FiredRows> {
  const { companyId, storeId } = scope;
  const inDay = { gte: scope.start, lt: scope.end };
  const [claims, noAnswers, closes, decisions, proofAudit, refusals] = await Promise.all([
    client.orderClaimHistory.findMany({
      where: {
        companyId,
        createdAt: inDay,
        order: { storeId },
        OR: [
          { action: 'CLAIMED', reason: PULL_REASON },
          { action: 'RELEASED', reason: { in: [...IDLE_RETURN_REASONS, ...NO_ANSWER_RETURN_REASONS] } },
        ],
      },
      select: { userId: true, action: true, reason: true },
      take: FIRED_ROW_CAP,
    }),
    client.orderContactAttempt.findMany({
      where: { companyId, createdAt: inDay, result: { in: [...NO_ANSWER_RESULTS] }, order: { storeId } },
      select: { employeeId: true, orderId: true, createdAt: true, nextFollowUpAt: true },
      take: FIRED_ROW_CAP,
    }),
    client.orderStatusLog.findMany({
      where: { companyId, statusType: 'CONFIRMATION', note: { in: [...NO_ANSWER_CLOSE_NOTES] }, createdAt: inDay, order: { storeId } },
      select: { changedById: true, orderId: true, createdAt: true },
      take: FIRED_ROW_CAP,
    }),
    client.orderStatusLog.findMany({
      where: {
        companyId,
        statusType: 'CONFIRMATION',
        newValue: { in: ['CONFIRMED', 'REJECTED'] },
        createdAt: inDay,
        order: { storeId, ...notSuperseded },
      },
      select: { changedById: true, orderId: true },
      take: FIRED_ROW_CAP,
    }),
    client.auditLog.findMany({
      where: { companyId, action: 'CALL_PROOF_REFUSED', entity: 'Order', createdAt: inDay, userId: { not: null } },
      select: { userId: true, entityId: true },
      take: FIRED_ROW_CAP,
    }),
    readRefusals(client, scope),
  ]);

  // The audit row carries no store: keep the refusals whose order is this store's.
  const orderIds = [...new Set(proofAudit.map((a) => a.entityId))];
  const here = orderIds.length
    ? new Set((await client.order.findMany({ where: { companyId, storeId, id: { in: orderIds } }, select: { id: true } })).map((o) => o.id))
    : new Set<string>();

  const lists = [claims, noAnswers, closes, decisions, proofAudit];
  return {
    claims,
    noAnswers,
    closes: closes.filter((c): c is typeof c & { changedById: string } => !!c.changedById),
    decisions: decisions.filter((d): d is typeof d & { changedById: string } => !!d.changedById),
    proofRefusals: proofAudit.filter((a) => here.has(a.entityId)).map((a) => ({ userId: a.userId! })),
    refusals,
    truncated: lists.some((l) => l.length >= FIRED_ROW_CAP),
  };
}

/** The refusal log, grouped by person and code. A table that is not there (rolled back) answers null — the counters say so. */
async function readRefusals(client: Client, scope: { companyId: string; storeId: string; start: Date; end: Date }) {
  try {
    const groups = await client.deskRefusal.groupBy({
      by: ['userId', 'code'],
      where: { companyId: scope.companyId, storeId: scope.storeId, createdAt: { gte: scope.start, lt: scope.end } },
      _count: { _all: true },
    });
    return groups.map((g) => ({ userId: g.userId, code: g.code, count: g._count._all }));
  } catch {
    return null;
  }
}

export interface FiredPerson extends Omit<FiredCounters, 'refusals'> {
  userId: string;
  hold: HoldVerdict;
  refusals: { code: string; labelAr: string; count: number }[];
  /** The red line's sentence, or null. */
  alarmAr: string | null;
}

export interface RuleFiredAnswer {
  day: string;
  today: boolean;
  timeZone: string;
  /** False when the refusal log could not be read: its counters are zeros because nothing could be counted. */
  refusalLog: boolean;
  truncated: boolean;
  people: FiredPerson[];
}

export type DayVerdict = { ok: true; day: string; start: Date; end: Date; today: boolean } | { ok: false; code: 'INVALID_DAY' | 'DAY_IN_FUTURE'; errorAr: string };

/** `?day=` → the store's day: empty is today; a malformed day and a day still to come are refused. */
export function resolveFiredDay(raw: string | null, now: Date, timeZone: string): DayVerdict {
  const today = localDay(now, timeZone);
  const day = raw || today;
  const range = /^\d{4}-\d{2}-\d{2}$/.test(day) ? dayRange(day, timeZone) : null;
  if (!range || localDay(range.start, timeZone) !== day) return { ok: false, code: 'INVALID_DAY', errorAr: DAY_INVALID_AR };
  if (day > today) return { ok: false, code: 'DAY_IN_FUTURE', errorAr: DAY_IN_FUTURE_AR };
  return { ok: true, day, ...range, today: day === today };
}

/**
 * The door's answer: one day of the store, every person at the desk — zeros for a person with no activity, never missing.
 * Computed once per (company, store, day) in the reports lane and shared by whoever asks in the next minute.
 */
export async function ruleFiredAnswer(input: {
  companyId: string;
  storeId: string;
  timeZone: string;
  when: { day: string; start: Date; end: Date; today: boolean };
}): Promise<RuleFiredAnswer> {
  const { companyId, storeId, timeZone, when } = input;
  const key = ['rule-fired', companyId, storeId, when.day].join('|');
  return heavyOnce(key, REPORT_TTL_MS, async () => {
    const [people, since, rows] = await Promise.all([
      resolveAudience({ companyId, storeId, audience: { anyPermission: DESK_KEYS } }),
      cadenceSince(db, companyId),
      readFiredRows(db, { companyId, storeId, start: when.start, end: when.end }),
    ]);
    const tally = tallyFired(rows, since);
    const alarm = when.today ? ALARM_TODAY_AR : ALARM_OTHER_DAY_AR;
    return {
      day: when.day,
      today: when.today,
      timeZone,
      refusalLog: rows.refusals !== null,
      truncated: rows.truncated,
      people: people
        .map((p): FiredPerson => {
          const c = tally.get(p.id) ?? emptyCounters();
          const r = deskReadiness((k) => can(p, k), { fullAccess: hasFullAccess(p) });
          const unbound = r.hold === 'EXEMPT' || r.hold === 'DOES_NOT_WORK';
          return {
            ...c,
            userId: p.id,
            hold: r.hold,
            refusals: Object.entries(c.refusals)
              .map(([code, count]) => ({ code, labelAr: refusalLabel(code), count }))
              .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
            alarmAr: unbound && c.decided > 0 ? alarm : null,
          };
        })
        .sort((a, b) => a.userId.localeCompare(b.userId)),
    };
  });
}
