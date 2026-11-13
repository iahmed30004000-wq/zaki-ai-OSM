import { db } from './db';
import { zonedParts, type BusinessCalendar } from './business-calendar';
import { shiftCalendar, type PersonShift } from './employee-shift';
import { isReleaseSheDidNotPress } from './auto-release';
import { breatheEvery } from './breathe';

/**
 * WHO CAME, WHEN, AND FOR HOW LONG.
 *
 * Two records of the same day, kept apart on purpose:
 *
 *   PRESENCE is what the person says. The login is one mark of it and the
 *   "استلمت" button is another; both mean "I am here".
 *
 *   WORK is what the system saw them do — a claim, a decision, a call
 *   logged. It cannot be pressed and then slept through.
 *
 * Showing only presence lets somebody sign in and disappear. Showing only
 * work punishes the morning a queue stayed empty, or the afternoon spent in
 * a meeting. So both are reported, and the distance between them is the
 * thing a manager actually wants to see.
 *
 * LATENESS is measured against THIS PERSON's shift where they have one,
 * and the country's work hours where they do not — in the country's own
 * timezone either way. Somebody whose shift starts at noon measured against
 * a nine o'clock country is three hours late every day of their life, and
 * every figure built on that is wrong in the same direction. A day nobody
 * arrived at all is absent, not late: counting an off day as infinitely
 * late would drown every real figure.
 *
 * Nothing here is stored. Every number is derived from the marks and the
 * shift, so changing the work hours corrects the history rather than
 * leaving a stale column behind.
 */

/** A mark somebody makes, or the system makes for them. */
export type MarkKind = 'LOGIN' | 'CHECK_IN' | 'CHECK_OUT';

export interface DayRow {
  /** yyyy-MM-dd in the country's timezone. */
  date: string;
  /** Earliest "I am here" — a login or a pressed check-in. */
  arrivedAt: Date | null;
  /** Latest sign of presence: a pressed check-out, else the last work seen. */
  leftAt: Date | null;
  /** Minutes between arriving and leaving. Null when one end is missing. */
  presentMinutes: number | null;
  /** First and last moment the system saw actual work. */
  workStartedAt: Date | null;
  workEndedAt: Date | null;
  workedMinutes: number | null;
  /** Minutes past the shift's start. 0 when on time, null when absent. */
  lateMinutes: number | null;
  /** True when they left before the shift ended. */
  leftEarly: boolean;
  /** They pressed the button rather than being seen. */
  checkedOut: boolean;
  /**
   * Nobody marked an arrival, so it was taken from their first piece of
   * work. A session lasts days, so somebody who never signs out produces no
   * login on most mornings — and their first order is later than the moment
   * they actually sat down. Lateness built on this is an upper bound, and
   * the only cure is pressing "استلمت".
   */
  arrivalFromWork: boolean;
}

export interface AttendanceRow {
  userId: string;
  days: DayRow[];
  /** Days with any sign of presence at all. */
  daysPresent: number;
  /** Days they arrived after the shift began. */
  daysLate: number;
  totalLateMinutes: number;
  /** Total and typical presence across the days they came. */
  totalPresentMinutes: number;
  avgPresentMinutes: number | null;
  /** Days present but with no work record — here, but nothing to show. */
  daysWithoutWork: number;
  /**
   * Of the late days, how many rest on an arrival guessed from the first
   * piece of work. A high number means the team is not pressing "استلمت",
   * not that they are late.
   */
  daysLateEstimated: number;
}

const MINUTE = 60 * 1000;

/** "HH:mm" → minutes since midnight. Bad input falls back to the default. */
function hhmm(value: string, fallback: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value ?? '');
  if (!m) return fallback;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return minutes >= 0 && minutes <= 24 * 60 ? minutes : fallback;
}

/** The calendar day an instant falls on, in the country's own timezone. */
function localDay(at: Date, timezone: string): string {
  const p = zonedParts(at, timezone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Minutes since local midnight. */
function localMinutes(at: Date, timezone: string): number {
  const p = zonedParts(at, timezone);
  return p.hour * 60 + p.minute;
}

const earliest = (a: Date | null, b: Date | null) => (!a ? b : !b ? a : a < b ? a : b);
const latest = (a: Date | null, b: Date | null) => (!a ? b : !b ? a : a > b ? a : b);

/**
 * Record an arrival or a departure.
 *
 * Append-only: a correction is a new mark with a note, never an edit. The
 * row that says when somebody arrived is exactly the kind people have
 * reasons to change.
 */
export async function markAttendance(input: {
  companyId: string | null;
  userId: string;
  kind: MarkKind;
  source?: 'AUTO' | 'MANUAL';
  note?: string | null;
}) {
  return db.attendanceMark.create({
    data: {
      companyId: input.companyId,
      userId: input.userId,
      kind: input.kind,
      source: input.source ?? 'AUTO',
      note: input.note ?? null,
    },
  });
}

/**
 * A login is a fingerprint, and it must never cost anyone a login.
 *
 * The session is already issued by the time this runs, so a database hiccup
 * here would otherwise turn "your attendance was not recorded" into "you
 * cannot sign in". It is swallowed deliberately.
 */
export async function markLogin(companyId: string | null, userId: string): Promise<void> {
  try {
    await markAttendance({ companyId, userId, kind: 'LOGIN', source: 'AUTO' });
  } catch {
    /* attendance is a report, not a gate */
  }
}

export async function attendance(input: {
  companyId: string;
  storeId: string;
  userIds: string[];
  calendar: BusinessCalendar;
  /**
   * Each person's own hours, where they have them. Absent or missing a
   * person means the country's — which is what everybody had before shifts
   * existed, so nothing moves until one is set.
   */
  shifts?: Map<string, PersonShift>;
  start: Date;
  end: Date;
}): Promise<Map<string, AttendanceRow>> {
  const { companyId, storeId, userIds, calendar, shifts, start, end } = input;
  const result = new Map<string, AttendanceRow>();
  if (userIds.length === 0) return result;

  const when = { gte: start, lte: end };
  const [marks, claims, decisions, attempts] = await Promise.all([
    db.attendanceMark.findMany({
      where: { userId: { in: userIds }, at: when },
      select: { userId: true, kind: true, at: true },
      orderBy: { at: 'asc' },
    }),
    // What the system SAW them do, from the same append-only records the
    // performance report reads. Presence is claimed; this is observed.
    // The action, reason and metadata come too: some lines carry a person's
    // name that the person never wrote (see below).
    db.orderClaimHistory.findMany({
      where: { companyId, userId: { in: userIds }, order: { storeId }, createdAt: when },
      select: { userId: true, createdAt: true, action: true, reason: true, metadata: true },
    }),
    db.orderStatusLog.findMany({
      where: { companyId, changedById: { in: userIds }, order: { storeId }, createdAt: when },
      select: { changedById: true, createdAt: true },
    }),
    db.orderContactAttempt.findMany({
      where: { companyId, employeeId: { in: userIds }, order: { storeId }, createdAt: when },
      select: { employeeId: true, createdAt: true },
    }),
  ]);

  // Four reads with no cap come back here, and every loop below runs over all of their rows without waiting for anything: each
  // hands the thread back now and then (`breathe.ts`), so the rest of the site is answered while this is worked out.
  const pause = breatheEvery();

  /** The hours THIS person is judged by: their own, or the country's. */
  const shiftOf = (userId: string) => {
    const cal = shiftCalendar(shifts?.get(userId), calendar);
    return {
      start: hhmm(cal.workHoursStart, 9 * 60),
      end: hhmm(cal.workHoursEnd, 17 * 60),
      weekend: new Set(cal.weekendDays ?? []),
    };
  };

  // user → date → the day being assembled.
  const byUser = new Map<string, Map<string, DayRow>>();
  const dayOf = (userId: string, at: Date): DayRow => {
    let days = byUser.get(userId);
    if (!days) byUser.set(userId, (days = new Map()));
    const date = localDay(at, calendar.timezone);
    let day = days.get(date);
    if (!day) {
      days.set(
        date,
        (day = {
          date,
          arrivedAt: null,
          leftAt: null,
          presentMinutes: null,
          workStartedAt: null,
          workEndedAt: null,
          workedMinutes: null,
          lateMinutes: null,
          leftEarly: false,
          checkedOut: false,
          arrivalFromWork: false,
        })
      );
    }
    return day;
  };

  for (const m of marks) {
    const turn = pause();
    if (turn) await turn;
    const day = dayOf(m.userId, m.at);
    if (m.kind === 'CHECK_OUT') {
      day.leftAt = latest(day.leftAt, m.at);
      day.checkedOut = true;
    } else {
      // A login and a pressed check-in both mean "I am here"; the earlier
      // one is the arrival.
      day.arrivedAt = earliest(day.arrivedAt, m.at);
      day.leftAt = latest(day.leftAt, m.at);
    }
  }

  const sawWork = (userId: string, at: Date) => {
    const day = dayOf(userId, at);
    day.workStartedAt = earliest(day.workStartedAt, at);
    day.workEndedAt = latest(day.workEndedAt, at);
  };
  // A release the clock wrote, or a colleague's take on the line, is filed
  // under the HOLDER (the line says whose order it was) — but she did nothing.
  // Counted as work, a day she never came looked like a day she was there, and
  // a late arrival could be pulled back to the line's moment.
  for (const c of claims) {
    const turn = pause();
    if (turn) await turn;
    if (!isReleaseSheDidNotPress(c)) sawWork(c.userId, c.createdAt);
  }
  for (const d of decisions) {
    const turn = pause();
    if (turn) await turn;
    if (d.changedById) sawWork(d.changedById, d.createdAt);
  }
  for (const a of attempts) {
    const turn = pause();
    if (turn) await turn;
    sawWork(a.employeeId, a.createdAt);
  }

  for (const userId of userIds) {
    const days = [...(byUser.get(userId)?.values() ?? [])].sort((a, b) => a.date.localeCompare(b.date));
    const shift = shiftOf(userId);

    let daysLate = 0;
    let totalLate = 0;
    let totalPresent = 0;
    let daysPresent = 0;
    let daysWithoutWork = 0;
    let daysLateEstimated = 0;

    for (const day of days) {
      const turn = pause();
      if (turn) await turn;
      // Somebody who never marked but worked is present from their first
      // record: a missing button press is not a missing day.
      if (!day.arrivedAt && day.workStartedAt) day.arrivalFromWork = true;
      day.arrivedAt = earliest(day.arrivedAt, day.workStartedAt);
      // Without a pressed check-out, the last thing they did is when we
      // last knew they were there. Claiming anything later would be
      // inventing minutes.
      if (!day.checkedOut) day.leftAt = latest(day.leftAt, day.workEndedAt);

      if (day.arrivedAt && day.leftAt && day.leftAt > day.arrivedAt) {
        day.presentMinutes = Math.round((+day.leftAt - +day.arrivedAt) / MINUTE);
      } else if (day.arrivedAt) {
        day.presentMinutes = 0;
      }

      if (day.workStartedAt && day.workEndedAt) {
        day.workedMinutes = Math.round((+day.workEndedAt - +day.workStartedAt) / MINUTE);
      }

      if (day.arrivedAt) {
        daysPresent++;
        totalPresent += day.presentMinutes ?? 0;
        if (!day.workStartedAt) daysWithoutWork++;

        // A weekend day worked is extra, never late: the shift does not
        // start on a day that is not a work day.
        const p = zonedParts(day.arrivedAt, calendar.timezone);
        if (!shift.weekend.has(p.weekday)) {
          const late = localMinutes(day.arrivedAt, calendar.timezone) - shift.start;
          day.lateMinutes = Math.max(0, late);
          if (day.lateMinutes > 0) {
            daysLate++;
            totalLate += day.lateMinutes;
            if (day.arrivalFromWork) daysLateEstimated++;
          }
          if (day.leftAt && localMinutes(day.leftAt, calendar.timezone) < shift.end) {
            day.leftEarly = true;
          }
        }
      }
    }

    result.set(userId, {
      userId,
      days,
      daysPresent,
      daysLate,
      totalLateMinutes: totalLate,
      totalPresentMinutes: totalPresent,
      avgPresentMinutes: daysPresent > 0 ? Math.round(totalPresent / daysPresent) : null,
      daysWithoutWork,
      daysLateEstimated,
    });
  }

  return result;
}
