import type { Prisma } from '@prisma/client';
import { isWithinBusinessHours, zonedParts, type BusinessCalendar } from './business-calendar';
import { NO_ANSWER_RESULTS } from './confirmation-workflow';
import type { db } from './db';
import { OPEN_CONFIRMATION, readyToPullWhere, type QueueScope } from './confirmation-queue';
import { dayRange } from './eod-report';
import type { QueueHealth } from './queue-health-words';

type Client = Prisma.TransactionClient | typeof db;

/**
 * THE QUEUE'S HEALTH, READ (step D2): six counts and two ages over one store, read-only — nothing here writes. The rules and the words are `queue-health-words.ts`. A bounded read:
 * the due list is capped at 2,000 rows (an order past the cap only makes the oldest age a little younger), the rest are counts over indexed columns.
 */
const DUE_LIST_CAP = 2000;
const FINAL = ['CONFIRMED', 'REJECTED', 'CANCELLED'];

function localMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export async function readQueueHealth(client: Client, scope: QueueScope, cal: BusinessCalendar, now: Date): Promise<QueueHealth> {
  const noAnswer = { result: { in: [...NO_ANSWER_RESULTS] } };
  const open = { ...scope, confirmationStatus: { in: [...OPEN_CONFIRMATION] }, contactAttempts: { some: noAnswer } };
  const inShift = isWithinBusinessHours(now, cal);

  const local = zonedParts(now, cal.timezone);
  const pad = (n: number) => String(n).padStart(2, '0');
  const today = dayRange(`${local.year}-${pad(local.month)}-${pad(local.day)}`, cal.timezone);
  const dayStart = today?.start ?? new Date(now.getTime() - 86_400_000);

  // minutes since the shift opened (only meaningful inside shift hours): the gaps below never count the night before it
  const start = localMinutes(cal.workHoursStart);
  const minutesInShift = inShift && start !== null ? Math.max(0, local.hour * 60 + local.minute - start) : null;
  const capped = (minutes: number): number => (minutesInShift === null ? minutes : Math.min(minutes, minutesInShift));

  /*
   * «ENTERED TODAY» AND «CLOSED TODAY» START FROM TODAY (H2, cause 7 of the hang — 18/11). Each was one count over EVERY order of the store with two
   * correlated checks on its attempts and no date to start from. Now each first finds the few orders today names — the company's no-answer lines since
   * the store's midnight (`order_contact_attempts (companyId, createdAt)`, the 14/11 index), and the store's orders closed and touched since midnight
   * (`orders (companyId, updatedAt)`) — and asks the SAME question of those ids only. The answers are the same counts (a no-answer line carries its
   * order's company, as every writer sets it): `queue-health-counts-start-from-todays-attempts.test.ts` holds them to osm/main's on the same rows.
   */
  const enteredTodayOf = async (): Promise<number> => {
    const lines = await client.orderContactAttempt.findMany({
      where: { companyId: scope.companyId, ...noAnswer, createdAt: { gte: dayStart } },
      select: { orderId: true },
      distinct: ['orderId'],
    });
    if (lines.length === 0) return 0;
    return client.order.count({
      where: { ...scope, id: { in: lines.map((l) => l.orderId) }, contactAttempts: { some: { ...noAnswer, createdAt: { gte: dayStart } }, none: { ...noAnswer, createdAt: { lt: dayStart } } } },
    });
  };
  const closedTodayOf = async (): Promise<number> => {
    const touched = await client.order.findMany({
      where: { ...scope, confirmationStatus: { in: FINAL }, updatedAt: { gte: dayStart } },
      select: { id: true },
    });
    if (touched.length === 0) return 0;
    return client.order.count({
      where: { ...scope, id: { in: touched.map((o) => o.id) }, confirmationStatus: { in: FINAL }, updatedAt: { gte: dayStart }, contactAttempts: { some: { ...noAnswer, createdAt: { lt: dayStart } } } },
    });
  };

  const [backlog, dueRows, enteredToday, closedToday, newWaiting, oldestNew, lastPull] = await Promise.all([
    client.order.count({ where: open }),
    client.order.findMany({
      where: { ...readyToPullWhere(scope, undefined, now), confirmationStatus: { in: [...OPEN_CONFIRMATION] }, contactAttempts: { some: noAnswer } },
      take: DUE_LIST_CAP,
      select: { contactAttempts: { where: noAnswer, orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true, nextFollowUpAt: true } } },
    }),
    enteredTodayOf(),
    closedTodayOf(),
    client.order.count({ where: { ...readyToPullWhere(scope, undefined, now), confirmationStatus: 'NEW', contactAttempts: { none: {} } } }),
    client.order.findFirst({ where: { ...readyToPullWhere(scope, undefined, now), confirmationStatus: 'NEW', contactAttempts: { none: {} } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
    client.orderClaimHistory.findFirst({ where: { companyId: scope.companyId, action: 'CLAIMED', reason: 'PULL_NEXT', order: { storeId: scope.storeId } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
  ]);

  let dueNow = 0;
  let oldestDueMs: number | null = null;
  for (const row of dueRows) {
    const last = row.contactAttempts[0];
    if (!last) continue;
    const due = (last.nextFollowUpAt ?? last.createdAt).getTime();
    if (due > now.getTime()) continue;
    dueNow++;
    const waited = now.getTime() - due;
    if (oldestDueMs === null || waited > oldestDueMs) oldestDueMs = waited;
  }

  const minutesSince = (at: Date | undefined | null): number | null => (at ? Math.max(0, (now.getTime() - at.getTime()) / 60_000) : null);
  const waitedNew = minutesSince(oldestNew?.createdAt);
  const sincePull = minutesSince(lastPull?.createdAt);

  return {
    backlog,
    dueNow,
    oldestDueHours: oldestDueMs === null ? null : oldestDueMs / 3_600_000,
    enteredToday,
    closedToday,
    newWaiting,
    oldestNewMinutes: inShift && waitedNew !== null ? capped(waitedNew) : null,
    // nobody has ever pulled here: the gap is the whole shift so far
    noPullMinutes: inShift ? (sincePull === null ? minutesInShift : capped(sincePull)) : null,
    inShift,
  };
}
