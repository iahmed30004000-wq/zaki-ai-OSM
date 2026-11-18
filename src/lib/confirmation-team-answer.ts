import { db } from './db';
import { teamPerformance } from './team-performance';
import { attendance } from './attendance';
import { REPORT_TTL_MS, heavyOnce } from '@/lib/heavy-lane';
import type { PersonShift } from './employee-shift';
import type { BusinessCalendar } from './business-calendar';

/**
 * THE CONFIRMATION TEAM'S NUMBERS FOR ONE WINDOW — ONE COMPUTATION, TWO DOORS (plan 17/11, R14a).
 *
 * This is the block that sat inside `GET /api/orders/confirmation/team`, MOVED here without a line of it changing, so that the door of
 * ONE person (`/api/orders/confirmation/team/[userId]`, the drawer under a row of the table) reads the very same answer. Two copies would
 * agree today and part the day one of them changes: the table would say 71% and the drawer 68% for the same person and the same days.
 * Both doors now ask this function, under one key, so they also share the minute the reports' lane keeps the answer.
 *
 * ONE COMPUTATION PER QUESTION, IN THE REPORTS' LANE (`lib/heavy-lane.ts`, the owner 13/11: «لوحة الأداء بتضل تعلق»).
 *
 * The table reads three append-only logs of a ninety-day window for every employee at once. Asked by two tabs, or again by a
 * page that timed out, it is computed once and shared; and it runs on the reports' six connections, not on the pool every other
 * screen waits in. The answer holds no figure that depends on who asks (the door checks the key before it calls this).
 */
export async function confirmationTeamAnswer(input: {
  companyId: string;
  storeId: string;
  calendar: BusinessCalendar;
  start?: Date;
  end?: Date;
}) {
  const { companyId, storeId, calendar, start, end } = input;
  const key = ['team', companyId, storeId, start?.toISOString() ?? '', end?.toISOString() ?? ''].join('|');
  return heavyOnce(key, REPORT_TTL_MS, async () => {
    const result = await teamPerformance({ companyId, storeId, calendar, start, end });

    // Attendance rides along on the same window, for the same people. Two
    // requests for one table would let the halves disagree about the dates.
    const userIds = result.employees.map((e) => e.id);
    // Each person's own hours, where they have them. Without these the
    // lateness column measures a noon shift against a nine o'clock country
    // and reports three hours late, every day, forever.
    const shifts = new Map<string, PersonShift>(
      (
        await db.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, shiftStart: true, shiftEnd: true, restDays: true },
        })
      ).map((u) => [u.id, { shiftStart: u.shiftStart, shiftEnd: u.shiftEnd, restDays: u.restDays }])
    );

    const marks =
      start && end
        ? await attendance({ companyId, storeId, userIds, calendar, shifts, start, end })
        : new Map();
    return { result, marks };
  });
}

/** One employee's row with their attendance beside it — the shape both doors send. */
export function withAttendance<E extends { id: string }>(
  e: E,
  marks: Awaited<ReturnType<typeof attendance>>,
) {
  const a = marks.get(e.id);
  return {
    ...e,
    // Days here, days late, and the hours actually spent — the
    // fingerprint, beside the work it produced.
    daysPresent: a?.daysPresent ?? 0,
    daysLate: a?.daysLate ?? 0,
    totalLateMinutes: a?.totalLateMinutes ?? 0,
    avgPresentMinutes: a?.avgPresentMinutes ?? null,
    daysWithoutWork: a?.daysWithoutWork ?? 0,
    daysLateEstimated: a?.daysLateEstimated ?? 0,
  };
}
