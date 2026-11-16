/**
 * A country's working day — the one validator every door that writes
 * Country.workHoursStart / workHoursEnd shares.
 *
 * The planner's ruling (2026-11-15, question 18): there is NO night shift.
 * A day runs from its start to its end, inside one calendar day, so the start
 * must be strictly before the end — equal is refused as well, a zero-length
 * day gives the cadence and the SLA no window to work in. A value that is not
 * HH:mm (24:00, 9:00, 09:60, empty, a number) is refused with its own message.
 *
 * Pure: no database, no clock. The routes pass the stored value for the half
 * the request did not send (see `effectiveWorkHours`).
 */

export const WORK_HOURS_FORMAT_MESSAGE = 'وقت الدوام غير صالح — اكتبه بصيغة HH:mm بين 00:00 و23:59 (مثل 09:00)';
export const WORK_HOURS_ORDER_MESSAGE = 'بداية الدوام يجب أن تكون قبل نهايته — لا يوجد دوام ليلي ولا يصح أن يتساوى الوقتان';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Minutes since midnight for a valid HH:mm, else null. */
export function hhmmToMinutes(value: unknown): number | null {
  if (typeof value !== 'string' || !HHMM.test(value)) return null;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}

/** The Arabic reason a pair of hours may not be saved, or null when it may. */
export function workHoursError(start: unknown, end: unknown): string | null {
  const s = hhmmToMinutes(start);
  const e = hhmmToMinutes(end);
  if (s === null || e === null) return WORK_HOURS_FORMAT_MESSAGE;
  if (s >= e) return WORK_HOURS_ORDER_MESSAGE;
  return null;
}

/**
 * What a write of `patch` would leave on the row: the half that was not sent
 * comes from the stored row. `touches` is false when the payload carries
 * neither half — such a save (a name, the weekend) is never judged on hours,
 * even when the stored row is an old night shift.
 */
export function effectiveWorkHours(
  patch: { workHoursStart?: string; workHoursEnd?: string },
  stored: { workHoursStart: string; workHoursEnd: string }
): { touches: boolean; start: string; end: string } {
  return {
    touches: patch.workHoursStart !== undefined || patch.workHoursEnd !== undefined,
    start: patch.workHoursStart ?? stored.workHoursStart,
    end: patch.workHoursEnd ?? stored.workHoursEnd,
  };
}
