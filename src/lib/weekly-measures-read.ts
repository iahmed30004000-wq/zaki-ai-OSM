import { db } from './db';
import type { BusinessCalendar } from './business-calendar';
import { OPEN_CONFIRMATION } from './confirmation-queue';
import { NO_ANSWER_CLOSE, NO_ANSWER_RESULTS } from './confirmation-workflow';
import { REPORT_TTL_MS, heavyOnce } from './heavy-lane';
import { INTAKE_DUPLICATE_ACTION } from './intake-flags';
import { CALL_RESULTS, REPORT_ROW_CAP, ROW_CAP, answerRateReport, outcomeOf } from './no-answer-watch';
import { tallyWeekly, weeklyMeasuresOf, weeklyWindow, type WeekKey, type WeeklyMeasures, type WeeklyWindow } from './weekly-measures';

/**
 * «القياس كل أسبوع» — THE QUESTIONS (`weekly-measures.ts` holds the arithmetic and the words).
 *
 * Every question is scoped by company AND store, grouped or bounded (never one per agent or per order), and read OLDEST first, so a
 * bound that cuts takes the end of the window and `truncated` says so on the screen («حد أدنى»). Agents and counts only: no customer field
 * is selected — not a phone, not a name, not even to count «unique» (the intake filter's own line says «duplicate»).
 *
 * It runs in the REPORT LANE (`heavyOnce`): six people opening the tab ask once, the queries take the lane's pool and never the
 * desk's, and the answer is kept a minute. The key names the whole question — company, store, the window — never a user or `now`.
 */

/** The decisions that end the confirmation stage (the `held-flow.ts` reading). */
const DECISIONS = ['CONFIRMED', 'REJECTED', 'CANCELLED'];

export interface WeeklyCaps {
  rows: number;
  lines: number;
}
export const WEEKLY_CAPS: WeeklyCaps = { rows: ROW_CAP, lines: REPORT_ROW_CAP };

/** The cache key of one weekly question. */
export function weeklyKey(companyId: string, storeId: string, w: Pick<WeeklyWindow, 'fromDay' | 'toDay'>): string {
  return ['weekly-measures', companyId, storeId, w.fromDay, w.toDay].join('|');
}

export async function weeklyMeasures(input: {
  companyId: string;
  storeId: string;
  calendar: BusinessCalendar;
  week: WeekKey;
  now?: Date;
  /** How long the answer is kept — `REPORT_TTL_MS` (zero under test); a test of the cache hands a real one. */
  ttlMs?: number;
  /** Smaller bounds, for a test that must reach them. */
  caps?: Partial<WeeklyCaps>;
}): Promise<{ weekly: WeeklyMeasures; window: WeeklyWindow & { timezone: string } }> {
  const { companyId, storeId, calendar } = input;
  const window = weeklyWindow(input.now ?? new Date(), calendar.timezone, input.week);
  const weekly = await heavyOnce(weeklyKey(companyId, storeId, window), input.ttlMs ?? REPORT_TTL_MS, () =>
    computeWeekly({ companyId, storeId, calendar, window, caps: { ...WEEKLY_CAPS, ...input.caps } })
  );
  return { weekly, window: { ...window, timezone: calendar.timezone } };
}

async function computeWeekly(a: {
  companyId: string;
  storeId: string;
  calendar: BusinessCalendar;
  window: WeeklyWindow;
  caps: WeeklyCaps;
}): Promise<WeeklyMeasures> {
  const { companyId, storeId, calendar, window, caps } = a;
  const inWindow = { gte: window.start, lt: window.end };
  const createdIn = { storeId, createdAt: inWindow };

  const [created, duplicates, firstCalls, callLines, claims, attempts, decisions, confirmed, report] = await Promise.all([
    // 1, 2 · the orders created in the window.
    db.order.findMany({
      where: { companyId, ...createdIn },
      select: { id: true, createdAt: true, confirmedAt: true, rejectionReason: true },
      orderBy: { createdAt: 'asc' },
      take: caps.rows,
    }),
    // 2 · of them, those the intake filter marked duplicate.
    db.orderActivity.findMany({
      where: { companyId, action: INTAKE_DUPLICATE_ACTION, order: createdIn },
      select: { orderId: true },
      take: caps.rows,
    }),
    // 1 · the first call outcome of each order created in the window (whenever it came).
    db.orderContactAttempt.groupBy({
      by: ['orderId'],
      where: { companyId, result: { in: [...CALL_RESULTS] }, order: createdIn },
      _min: { createdAt: true },
      orderBy: { orderId: 'asc' },
      take: caps.rows,
    }),
    // 3, 4 · the call lines of the window.
    db.orderContactAttempt.findMany({
      where: { companyId, order: { storeId }, createdAt: inWindow, result: { in: [...CALL_RESULTS] } },
      select: { orderId: true, result: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: caps.lines,
    }),
    // 5 and the second check · the claim ledger of the window.
    db.orderClaimHistory.findMany({
      where: { companyId, order: { storeId }, createdAt: inWindow },
      select: { orderId: true, userId: true, action: true, reason: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: caps.lines,
    }),
    // 5 · every attempt of the window — who tried which order, and when.
    db.orderContactAttempt.findMany({
      where: { companyId, order: { storeId }, createdAt: inWindow },
      select: { orderId: true, employeeId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: caps.lines,
    }),
    // 4 · the decisions out of an open status in the window.
    db.orderStatusLog.findMany({
      where: {
        companyId,
        statusType: 'CONFIRMATION',
        previousValue: { in: OPEN_CONFIRMATION },
        newValue: { in: DECISIONS },
        createdAt: inWindow,
        order: { storeId },
      },
      select: { orderId: true, newValue: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: caps.rows,
    }),
    // 6 · the orders confirmed in the window, and where their parcel stands.
    db.order.findMany({
      where: { companyId, storeId, confirmedAt: inWindow },
      select: { id: true, shippingStatus: true, confirmationStatus: true },
      orderBy: { confirmedAt: 'asc' },
      take: caps.rows,
    }),
    // The first check · the window's answer rate by attempt, numbered as the report numbers it (the plan's one counter).
    answerRateReport({ companyId, storeId, timezone: calendar.timezone, calendar, start: window.start, end: new Date(window.end.getTime() - 1) }),
  ]);

  const missedIds = [...new Set(callLines.filter((l) => outcomeOf(l.result) === 'NOT_REACHED').map((l) => l.orderId))];
  const decidedIds = [...new Set(decisions.map((d) => d.orderId))];

  const [missedBefore, closedByRule, firstMisses] = await Promise.all([
    // 4 · of the orders missed in the window, those missed BEFORE it too — their first miss is not in the window.
    missedIds.length
      ? db.orderContactAttempt.groupBy({
          by: ['orderId'],
          where: { companyId, orderId: { in: missedIds }, result: { in: [...NO_ANSWER_RESULTS] }, createdAt: { lt: window.start } },
          _count: { _all: true },
          orderBy: { orderId: 'asc' },
          take: caps.lines,
        })
      : [],
    // 3 · of them, those the five-attempt rule closed.
    missedIds.length
      ? db.order.findMany({
          where: { companyId, storeId, id: { in: missedIds }, rejectionReason: NO_ANSWER_CLOSE.five.reason },
          select: { id: true },
          take: caps.rows,
        })
      : [],
    // 4 · of the decided orders, the time of their first miss.
    decidedIds.length
      ? db.orderContactAttempt.groupBy({
          by: ['orderId'],
          where: { companyId, orderId: { in: decidedIds }, result: { in: [...NO_ANSWER_RESULTS] }, createdAt: { lt: window.end } },
          _min: { createdAt: true },
          orderBy: { orderId: 'asc' },
          take: caps.rows,
        })
      : [],
  ]);

  const duplicateIds = new Set(duplicates.map((d) => d.orderId));
  const figures = tallyWeekly({
    window,
    calendar,
    created: created.map((o) => ({
      id: o.id,
      createdAt: o.createdAt,
      confirmed: o.confirmedAt !== null,
      duplicateMarked: duplicateIds.has(o.id),
      rejectionReason: o.rejectionReason,
    })),
    firstCalls: new Map(firstCalls.flatMap((g) => (g._min?.createdAt ? [[g.orderId, g._min.createdAt] as const] : []))),
    callLines: callLines.map((l) => ({ orderId: l.orderId, at: l.createdAt, reached: outcomeOf(l.result) === 'REACHED' })),
    notReachedBefore: new Set(missedBefore.map((g) => g.orderId)),
    closedByRule: new Set(closedByRule.map((o) => o.id)),
    decisions: decisions.map((d) => ({ orderId: d.orderId, to: d.newValue ?? '', at: d.createdAt })),
    firstNotReachedAt: new Map(firstMisses.flatMap((g) => (g._min?.createdAt ? [[g.orderId, g._min.createdAt] as const] : []))),
    claims: claims.map((c) => ({ orderId: c.orderId, userId: c.userId, action: c.action, reason: c.reason, at: c.createdAt })),
    attempts: attempts.map((t) => ({ orderId: t.orderId, userId: t.employeeId, at: t.createdAt })),
    confirmedOrders: confirmed.map((o) => ({ id: o.id, shippingStatus: o.shippingStatus, confirmationStatus: o.confirmationStatus })),
    fifth: (() => {
      const row = report.byAttempt.find((r) => r.key === '5');
      return { reached: row?.reached ?? 0, base: row?.base ?? 0 };
    })(),
    truncated:
      report.truncated ||
      [created, duplicates, firstCalls, decisions, confirmed, closedByRule, firstMisses].some((l) => l.length >= caps.rows) ||
      [callLines, claims, attempts, missedBefore].some((l) => l.length >= caps.lines),
  });
  return weeklyMeasuresOf(figures);
}
