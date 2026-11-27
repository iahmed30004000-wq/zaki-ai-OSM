import type { Prisma } from '@prisma/client';
import { REJECTION_REASON_AR } from './confirmation-workflow';
import {
  CALL_RESULTS,
  DAILY_FROM_HOURS,
  DAILY_REASONS,
  DAILY_TO_HOURS,
  MAX_CALL_NOTE,
  type CallResult,
  type DailyKind,
} from './winback-daily-words';
import type { db } from './db';
import { WINBACK_NOT_NEVER } from './winback-filters';

type Client = Prisma.TransactionClient | typeof db;

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE DAILY WINBACK LIST (Confirmation Center v2, step F1) — who to call today about an order lost or a date missed, 24 to 72 hours after it happened.
 *
 *   · LOST  an order lost for a changed mind, a price, or five unanswered calls (three under the old rule): its LAST «lost» decision is 24–72 hours old, nothing was offered on it yet
 *     (no replacement order), and it has not shipped.
 *   · MISSED_POSTPONED  an order postponed whose date (the customer's, or the follow-up date) passed 24–72 hours ago and which is still postponed. It is a call list ONLY: it is not lost, has no
 *     replacement to hang an offer on, and the offer door says «not rejected» to it — a second order from an open one would be a double.
 *
 * WHO CALLS and WHAT CAME OF IT are two kinds of append-only audit line on the order (\`WINBACK_ASSIGNED\`, \`WINBACK_CALLED\`) — no table, no column, no migration; the latest of each wins. The reactivation is
 * credited to whoever made the offer (the existing \`WINBACK_OFFERED\` line and the new order's \`createdById\`), a READ in the scorecard: nothing here writes money, an order or a commission.
 *
 * No customer field is read: the list names the order, the product reason and the person who should call; opening the order shows the rest under the usual access.
 * ═══════════════════════════════════════════════════════════════════════
 */

export type WindowVerdict = 'TOO_EARLY' | 'DUE' | 'TOO_LATE';

/** The pure window: less than 24 hours since it happened is too early, 24 to 72 inclusive is due, past 72 is too late. A moment in the future is too early. */
export function dailyVerdict(happenedAt: Date | string | number, now: Date): WindowVerdict {
  const hours = (now.getTime() - new Date(happenedAt).getTime()) / 3_600_000;
  if (!(hours >= DAILY_FROM_HOURS)) return 'TOO_EARLY';
  return hours > DAILY_TO_HOURS ? 'TOO_LATE' : 'DUE';
}

/** The moments a window is open for «now»: an outcome at or before `latest` and at or after `earliest` is due. */
export function dailyWindow(now: Date): { earliest: Date; latest: Date } {
  return { earliest: new Date(now.getTime() - DAILY_TO_HOURS * 3_600_000), latest: new Date(now.getTime() - DAILY_FROM_HOURS * 3_600_000) };
}

export interface DailyItem {
  orderId: string;
  orderNumber: string;
  kind: DailyKind;
  reason: string;
  reasonAr: string;
  /** When the outcome (or the missed date) happened. */
  happenedAt: string;
  assignee: { id: string; name: string } | null;
  lastCall: { result: CallResult; note: string | null; by: string; at: string } | null;
}

interface Line {
  entityId: string;
  action: string;
  userId: string | null;
  newData: string | null;
  createdAt: Date;
}

const parse = (raw: string | null): Record<string, unknown> => {
  try {
    return (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
  } catch {
    return {};
  }
};

/** The latest assignment and the latest call per order, from the audit lines (oldest first). Anything malformed is skipped. */
export function foldLines(lines: readonly Line[], names: ReadonlyMap<string, string>): Map<string, { assignee: DailyItem['assignee']; lastCall: DailyItem['lastCall'] }> {
  const out = new Map<string, { assignee: DailyItem['assignee']; lastCall: DailyItem['lastCall'] }>();
  for (const l of [...lines].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const cur = out.get(l.entityId) ?? { assignee: null, lastCall: null };
    const data = parse(l.newData);
    if (l.action === 'WINBACK_ASSIGNED' && typeof data.assigneeId === 'string') {
      cur.assignee = { id: data.assigneeId, name: names.get(data.assigneeId) ?? '—' };
    } else if (l.action === 'WINBACK_CALLED' && (CALL_RESULTS as readonly string[]).includes(data.result as string)) {
      cur.lastCall = { result: data.result as CallResult, note: typeof data.note === 'string' && data.note ? data.note.slice(0, MAX_CALL_NOTE) : null, by: names.get(l.userId ?? '') ?? '—', at: l.createdAt.toISOString() };
    }
    out.set(l.entityId, cur);
  }
  return out;
}

/** The daily list for one store, newest outcome first. Read only. */
export async function readDailyList(client: Client, scope: { companyId: string; storeId: string }, now: Date = new Date()): Promise<DailyItem[]> {
  const w = dailyWindow(now);
  const inWindow = { gte: w.earliest, lte: w.latest };

  const [lostLogs, postponed] = await Promise.all([
    client.orderStatusLog.findMany({
      where: {
        companyId: scope.companyId,
        statusType: 'CONFIRMATION',
        newValue: { in: ['REJECTED', 'CANCELLED'] },
        createdAt: inWindow,
        order: {
          storeId: scope.storeId,
          confirmationStatus: { in: ['REJECTED', 'CANCELLED'] },
          rejectionReason: { in: [...DAILY_REASONS] },
          shippedAt: null,
          replacedBy: null,
          replacesOrderId: null,
          // «إلغاء نهائي» on «قايمة الاسترجاع»: never on the daily list either.
          ...WINBACK_NOT_NEVER,
        },
      },
      select: { orderId: true, createdAt: true, order: { select: { orderNumber: true, rejectionReason: true } } },
      orderBy: { createdAt: 'desc' },
      take: 2_000,
    }),
    client.order.findMany({
      where: {
        companyId: scope.companyId,
        storeId: scope.storeId,
        confirmationStatus: 'POSTPONED',
        OR: [{ postponedUntil: inWindow }, { postponedUntil: null, nextFollowUpAt: inWindow }],
      },
      select: { id: true, orderNumber: true, postponedUntil: true, nextFollowUpAt: true },
      take: 2_000,
    }),
  ]);

  // the LAST lost decision of an order is the one that counts: an order lost again later is on its own clock
  const lastLost = new Map<string, (typeof lostLogs)[number]>();
  for (const l of [...lostLogs].reverse()) lastLost.set(l.orderId, l);

  const items: DailyItem[] = [];
  for (const l of lastLost.values()) {
    // the query already holds the window; the verdict is asked once more of what came back, so the pure rule and the database cannot drift apart unseen
    if (dailyVerdict(l.createdAt, now) !== 'DUE') continue;
    const reason = l.order.rejectionReason ?? 'OTHER';
    items.push({ orderId: l.orderId, orderNumber: l.order.orderNumber, kind: 'LOST', reason, reasonAr: REJECTION_REASON_AR[reason] ?? reason, happenedAt: l.createdAt.toISOString(), assignee: null, lastCall: null });
  }
  for (const o of postponed) {
    const date = o.postponedUntil ?? o.nextFollowUpAt;
    if (!date || dailyVerdict(date, now) !== 'DUE') continue;
    items.push({ orderId: o.id, orderNumber: o.orderNumber, kind: 'MISSED_POSTPONED', reason: 'MISSED_DATE', reasonAr: 'فات موعد الاتصال المتفق عليه', happenedAt: date.toISOString(), assignee: null, lastCall: null });
  }
  if (items.length === 0) return [];

  const ids = items.map((i) => i.orderId);
  const lines = await client.auditLog.findMany({
    where: { companyId: scope.companyId, entity: 'Order', entityId: { in: ids }, action: { in: ['WINBACK_ASSIGNED', 'WINBACK_CALLED'] } },
    select: { entityId: true, action: true, userId: true, newData: true, createdAt: true },
    take: 20_000,
  });
  const people = new Set<string>();
  for (const l of lines) {
    if (l.userId) people.add(l.userId);
    const a = parse(l.newData).assigneeId;
    if (typeof a === 'string') people.add(a);
  }
  const users = people.size ? await client.user.findMany({ where: { id: { in: [...people] } }, select: { id: true, name: true } }) : [];
  const folded = foldLines(lines, new Map(users.map((u) => [u.id, u.name ?? '—'])));
  for (const i of items) {
    const f = folded.get(i.orderId);
    if (f) {
      i.assignee = f.assignee;
      i.lastCall = f.lastCall;
    }
  }
  return items.sort((a, b) => (a.happenedAt < b.happenedAt ? 1 : -1));
}
