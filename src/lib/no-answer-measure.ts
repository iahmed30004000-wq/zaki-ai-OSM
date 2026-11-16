import type { Prisma } from '@prisma/client';
import { zonedParts } from './business-calendar';
import { NOT_A_CALL, isNoAnswer } from './no-answer-rounds';
import type { db } from './db';

type Client = Prisma.TransactionClient | typeof db;

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE NO-ANSWER MEASUREMENT REPORT (Confirmation Center v2, step G1) — the report the owner asked for INSTEAD of running a query on production (planner's answer 3):
 * per agent per day, how many «اتصل» presses (OPENED), how many «لا يرد» lines, and what share of them came less than 30 seconds / 1 minute / 2 minutes after her press.
 *
 * Read-only, agents and counts only — no customer field is read. Every percentage is printed beside its counts and a zero base is «—» (the tab's own rule).
 *
 * THE RULE («قاعدة الاحتساب»): a «لا يرد» line (NO_ANSWER, BUSY, UNREACHABLE) is paired with the press that opened it — HER latest «اتصل» press (OPENED) on the SAME order before
 * the line, with no other result of hers in between. The gap is the line's time minus the press's. A line with no such press is counted apart («بلا ضغطة اتصال»): it has no ring
 * window to measure and is NOT in the base of the three shares. A press that ended in anything but «لا يرد» (answered, call-back, a message…) is not in them either.
 * ═══════════════════════════════════════════════════════════════════════
 */

export const MEASURE_THRESHOLDS_SECONDS = [30, 60, 120] as const;

export const MEASURE_RULE =
  'كل سطر «لا يرد» (لا يرد، مشغول، مسكّر) بينربط بآخر ضغطة «اتصل» إلها هي على نفس الطلب قبلو بدون أي نتيجة بينهم، والفرق بين الوقتين هو مدة الرنين. السطر بلا ضغطة اتصال بينعدّ لحالو وما بيدخل بقاعدة النسب التلاتة. النسبة = عدد السطور اللي رنينها أقل من الحد ÷ عدد السطور اللي إلها ضغطة.';

export interface MeasureRow {
  /** The local day, YYYY-MM-DD. */
  day: string;
  userId: string;
  name: string;
  opened: number;
  noAnswer: number;
  /** «لا يرد» lines that have a press to measure from. */
  withPress: number;
  /** «لا يرد» lines with no press before them. */
  withoutPress: number;
  /** Per threshold: how many of the `withPress` lines rang for less than that many seconds. */
  under: { seconds: number; count: number; rate: number | null }[];
}

export interface MeasureLine {
  userId: string;
  orderId: string;
  result: string;
  at: Date;
}

/** The pure tally. `lines` may come in any order. */
export function tallyMeasure(lines: readonly MeasureLine[], names: ReadonlyMap<string, string>, timeZone: string): MeasureRow[] {
  const pad = (n: number) => String(n).padStart(2, '0');
  const dayOf = (at: Date) => {
    const p = zonedParts(at, timeZone);
    return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  };
  const cells = new Map<string, { day: string; userId: string; opened: number; noAnswer: number; gaps: number[]; without: number }>();
  const cell = (at: Date, userId: string) => {
    const day = dayOf(at);
    const key = `${day}|${userId}`;
    let hit = cells.get(key);
    if (!hit) {
      hit = { day, userId, opened: 0, noAnswer: 0, gaps: [], without: 0 };
      cells.set(key, hit);
    }
    return hit;
  };

  // per (agent, order): her lines in time order — the press that opens a «لا يرد» is the line right before it, if that line is a press
  const sequences = new Map<string, MeasureLine[]>();
  for (const l of [...lines].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const k = `${l.userId}|${l.orderId}`;
    sequences.set(k, [...(sequences.get(k) ?? []), l]);
  }
  for (const seq of sequences.values()) {
    let openPress: MeasureLine | null = null;
    for (const l of seq) {
      if (l.result === 'OPENED') {
        cell(l.at, l.userId).opened += 1;
        openPress = l;
      } else if (isNoAnswer(l.result)) {
        const c = cell(l.at, l.userId);
        c.noAnswer += 1;
        if (openPress) c.gaps.push((l.at.getTime() - openPress.at.getTime()) / 1000);
        else c.without += 1;
        openPress = null;
      } else if (!NOT_A_CALL.includes(l.result)) {
        openPress = null; // she got a result of another kind: the press is spent
      }
    }
  }

  const rows: MeasureRow[] = [...cells.values()].map((c) => ({
    day: c.day,
    userId: c.userId,
    name: names.get(c.userId) ?? '—',
    opened: c.opened,
    noAnswer: c.noAnswer,
    withPress: c.gaps.length,
    withoutPress: c.without,
    under: MEASURE_THRESHOLDS_SECONDS.map((seconds) => {
      const count = c.gaps.filter((g) => g < seconds).length;
      return { seconds, count, rate: c.gaps.length > 0 ? Math.round((count / c.gaps.length) * 100) : null };
    }),
  }));
  // newest day first, then by name — never by a figure
  return rows.sort((a, b) => (a.day === b.day ? a.name.localeCompare(b.name, 'ar') : a.day < b.day ? 1 : -1));
}

/** The report over a window and a store. Read-only. */
export async function readMeasure(
  client: Client,
  scope: { companyId: string; storeId: string; start: Date; end: Date; timezone: string }
): Promise<{ rows: MeasureRow[]; rule: string; thresholds: readonly number[] }> {
  const attempts = await client.orderContactAttempt.findMany({
    where: { companyId: scope.companyId, createdAt: { gte: scope.start, lt: scope.end }, order: { storeId: scope.storeId } },
    select: { employeeId: true, orderId: true, result: true, createdAt: true },
    take: 200_000,
  });
  const userIds = [...new Set(attempts.map((a) => a.employeeId))];
  const users = userIds.length ? await client.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
  const rows = tallyMeasure(
    attempts.map((a) => ({ userId: a.employeeId, orderId: a.orderId, result: a.result, at: a.createdAt })),
    new Map(users.map((u) => [u.id, u.name ?? '—'])),
    scope.timezone
  );
  return { rows, rule: MEASURE_RULE, thresholds: MEASURE_THRESHOLDS_SECONDS };
}
