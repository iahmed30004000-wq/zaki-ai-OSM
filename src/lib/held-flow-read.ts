import { db } from './db';
import type { BusinessCalendar } from './business-calendar';
import { OPEN_CONFIRMATION } from './confirmation-queue';
import { ROW_CAP, REPORT_ROW_CAP } from './no-answer-watch';
import { workClock } from './no-answer-rounds';
import { FAST_MINUTES, FLOW_WINDOWS, readFlow, tallyFlow, type FlowWindowKey, type HeldFlow } from './held-flow';

/**
 * «حركة الطلبات» — THE QUESTIONS (`held-flow.ts` holds the arithmetic and the words).
 *
 * Five questions, asked at once, every one scoped by company AND store, every one bounded, none one-per-agent or one-per-order:
 *
 *   1. orders created in the window            — a count, on `(storeId, createdAt)`;
 *   2. the claim ledger of the window          — one row per line, `CLAIMED` · `RELEASED` · `TRANSFERRED` …;
 *   3. the decisions out of an open status     — the confirmation status log, for orders that carry a holder;
 *   4. the attempts of the window              — who tried which order, and when;
 *   5. the orders held now                     — only their claim time, oldest first.
 *
 * THE INDEXES THAT ALREADY EXIST ARE ENOUGH. `order_claim_history` has no `(companyId, createdAt)`; the window rides on `companyId`
 * (`(companyId, userId)`) and the store through the order (`(orderId, createdAt)`), the shape `teamPerformance` has asked for since it
 * was written. No migration: a missing index would be an additive hand-written one, and none was needed (measured, see the PR).
 *
 * WHEN A BOUND CUTS, THE END OF THE WINDOW GOES. Every list is read OLDEST first, so what is missing is the newest and everything
 * kept is whole; `truncated` says which list was cut and the arithmetic and the sentence read it (a count is a floor, a ratio is not
 * judged, the speed is not drawn). The held list is read oldest-claim first too: when it is cut, the old buckets are exact.
 */

/** The decisions that end the confirmation stage. */
const DECISIONS = ['CONFIRMED', 'REJECTED', 'CANCELLED'];

export interface FlowCaps {
  ledger: number;
  decisions: number;
  attempts: number;
  held: number;
}

/** The bounds: the board's `ROW_CAP` for what is open now and for the ledger, the report's for the attempts (a week of calls is the biggest list here). */
export const FLOW_CAPS: FlowCaps = { ledger: ROW_CAP, decisions: ROW_CAP, attempts: REPORT_ROW_CAP, held: ROW_CAP };

export async function heldFlow(input: {
  companyId: string;
  storeId: string;
  calendar: BusinessCalendar;
  windowKey: FlowWindowKey;
  now?: Date;
  /** Smaller bounds, for a test that must reach them without twenty thousand rows. Left out, `FLOW_CAPS`. */
  caps?: Partial<FlowCaps>;
}): Promise<HeldFlow> {
  const { companyId, storeId, calendar, windowKey } = input;
  const caps = { ...FLOW_CAPS, ...input.caps };
  const now = input.now ?? new Date();
  const start = new Date(now.getTime() - FLOW_WINDOWS[windowKey].ms);
  const inWindow = { gte: start, lte: now };

  const [created, claims, decisions, attempts, held] = await Promise.all([
    db.order.count({ where: { companyId, storeId, createdAt: inWindow } }),
    db.orderClaimHistory.findMany({
      where: { companyId, order: { storeId }, createdAt: inWindow },
      select: { orderId: true, userId: true, action: true, reason: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: caps.ledger,
    }),
    // A decision FROM an open status, on an order that carries a holder: the hand letting go by a yes or a no.
    db.orderStatusLog.findMany({
      where: {
        companyId,
        statusType: 'CONFIRMATION',
        previousValue: { in: OPEN_CONFIRMATION },
        newValue: { in: DECISIONS },
        createdAt: inWindow,
        order: { storeId, claimedById: { not: null } },
      },
      select: { orderId: true, newValue: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: caps.decisions,
    }),
    db.orderContactAttempt.findMany({
      where: { companyId, order: { storeId }, createdAt: inWindow },
      select: { orderId: true, employeeId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: caps.attempts,
    }),
    // «بيد الموظفات الآن» exactly as the board reads it (`noAnswerBoard`): a holder, and still open.
    db.order.findMany({
      where: { companyId, storeId, claimedById: { not: null }, confirmationStatus: { in: OPEN_CONFIRMATION } },
      select: { claimedAt: true },
      orderBy: { claimedAt: 'asc' },
      take: caps.held,
    }),
  ]);

  // One clock for the request: each local day is placed once, whatever the number of pulls asked about.
  const clock = workClock(calendar);
  const figures = tallyFlow({
    created,
    claims: claims.map((c) => ({ orderId: c.orderId, userId: c.userId, action: c.action, reason: c.reason, at: c.createdAt })),
    decisions: decisions.map((d) => ({ orderId: d.orderId, to: d.newValue ?? '', at: d.createdAt })),
    attempts: attempts.map((a) => ({ orderId: a.orderId, userId: a.employeeId, at: a.createdAt })),
    held,
    now,
    minutesBetween: (from, to) => clock.minutesBetween(from, to),
    workMinutes: clock.minutesBetween(start, now),
    truncated: {
      ledger: claims.length >= caps.ledger,
      decisions: decisions.length >= caps.decisions,
      attempts: attempts.length >= caps.attempts,
      held: held.length >= caps.held,
    },
  });

  return {
    ...figures,
    window: { key: windowKey, label: FLOW_WINDOWS[windowKey].label, start: start.toISOString(), end: now.toISOString() },
    reading: readFlow(figures),
    rules: { fastMinutes: FAST_MINUTES },
  };
}
