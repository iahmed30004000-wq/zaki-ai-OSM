/**
 * BUSINESS CALENDAR — per country, from its work hours, weekend days and
 * timezone (Stage 1 fields on Country).
 *
 * SLA counters must freeze outside working hours and on weekend days: an
 * order claimed at 16:55 is not "90 minutes late" the next morning. Every
 * countdown in the system (auto-release, change-request SLA) measures
 * BUSINESS minutes, never wall-clock minutes.
 */

export interface BusinessCalendar {
  /** "HH:mm" in the country's local time. */
  workHoursStart: string;
  workHoursEnd: string;
  /** 0 = Sunday … 6 = Saturday. */
  weekendDays: number[];
  /** IANA timezone, e.g. Asia/Damascus. */
  timezone: string;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * ONE FORMATTER PER TIMEZONE, KEPT.
 *
 * Building an `Intl.DateTimeFormat` is the expensive part of reading a clock in a zone — measured 13/11: 45 µs to build one
 * against 4 µs to use one — and this file built one on every call. A span of five minutes asked for fifteen of them, and the
 * team table asked for tens of thousands of spans in one go: the one server process answered nobody for 19.5 seconds.
 * A handful of zones exist for the life of the process (the countries the company sells in), so they are kept.
 */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = FORMATTERS.get(timeZone);
  if (!fmt) {
    // A name that is not a zone throws here, every time it is asked — nothing is kept for it.
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
    FORMATTERS.set(timeZone, fmt);
  }
  return fmt;
}

/** Local calendar parts of an instant in the given timezone. */
export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const fmt = formatterFor(timeZone);
  const parts = Object.fromEntries(fmt.formatToParts(instant).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WEEKDAY_INDEX[parts.weekday as string] ?? 0,
  };
}

/** Offset of a timezone at an instant, in minutes (UTC + offset = local). */
function offsetMinutes(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0, 0);
  return Math.round((asUtc - instant.getTime() - (instant.getMilliseconds() - instant.getMilliseconds())) / 60_000) -
    Math.round((instant.getSeconds() * 1000) / 60_000);
}

/** The instant of a local wall-clock time in a timezone (DST-safe: two passes). */
export function zonedTimeToInstant(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let guess = new Date(naive - offsetMinutes(new Date(naive), timeZone) * 60_000);
  guess = new Date(naive - offsetMinutes(guess, timeZone) * 60_000);
  return guess;
}

function parseHhMm(value: string, fallbackHour: number): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value ?? '');
  if (!m) return { hour: fallbackHour, minute: 0 };
  return { hour: Math.min(23, Number(m[1])), minute: Math.min(59, Number(m[2])) };
}

/**
 * THE WORKING WINDOW OF EACH LOCAL DAY, KEPT.
 *
 * Placing a day's opening and closing instants costs four more clock readings, and every span walks at least three days.
 * The answer depends only on the zone, the hours (as parsed) and the local date, so it is kept under exactly those. The weekend test
 * stays in front of it (the weekend days are therefore not part of the key). Bounded: past the bound the whole map is
 * dropped and the next ask places its day again — the answers never depend on what happens to be kept.
 */
const WINDOWS = new Map<string, { start: Date; end: Date } | null>();
const MAX_WINDOWS = 20_000;

/** Working window of one local day, or null when that day is a weekend. */
function windowFor(cal: BusinessCalendar, dayInstant: Date): { start: Date; end: Date } | null {
  const p = zonedParts(dayInstant, cal.timezone);
  if (cal.weekendDays.includes(p.weekday)) return null;
  const from = parseHhMm(cal.workHoursStart, 9);
  const to = parseHhMm(cal.workHoursEnd, 17);
  // Keyed on the hours AS PARSED, not as typed: that is all the window below is made of, so two spellings that read alike are
  // one window, and a typed text with a bar in it can never stand for another calendar's (the review of 13/11).
  const key = `${cal.timezone}|${from.hour}:${from.minute}|${to.hour}:${to.minute}|${p.year}-${p.month}-${p.day}`;
  const kept = WINDOWS.get(key);
  // `null` is an answer too (a day whose closing is not after its opening): only `undefined` means «not placed yet».
  if (kept !== undefined) return kept;
  const start = zonedTimeToInstant(cal.timezone, p.year, p.month, p.day, from.hour, from.minute);
  const end = zonedTimeToInstant(cal.timezone, p.year, p.month, p.day, to.hour, to.minute);
  const win = end > start ? { start, end } : null;
  if (WINDOWS.size >= MAX_WINDOWS) WINDOWS.clear();
  WINDOWS.set(key, win);
  return win;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Business minutes elapsed between two instants (0 when end <= start). */
export function businessMinutesBetween(start: Date, end: Date, cal: BusinessCalendar): number {
  if (end <= start) return 0;
  let total = 0;
  // Walk local days, starting a little before to catch the day of `start`.
  for (let cursor = start.getTime() - DAY_MS; cursor <= end.getTime() + DAY_MS; cursor += DAY_MS) {
    const win = windowFor(cal, new Date(cursor));
    if (!win) continue;
    const from = Math.max(win.start.getTime(), start.getTime());
    const to = Math.min(win.end.getTime(), end.getTime());
    if (to > from) total += (to - from) / 60_000;
  }
  return Math.floor(total);
}

/** The instant reached after adding business minutes (for SLA deadlines). */
export function addBusinessMinutes(start: Date, minutes: number, cal: BusinessCalendar): Date {
  if (minutes <= 0) return start;
  let remaining = minutes;
  let cursor = start.getTime() - DAY_MS;
  for (let guard = 0; guard < 400 && remaining > 0; guard++, cursor += DAY_MS) {
    const win = windowFor(cal, new Date(cursor));
    if (!win) continue;
    const from = Math.max(win.start.getTime(), start.getTime());
    if (win.end.getTime() <= from) continue;
    const available = (win.end.getTime() - from) / 60_000;
    if (available >= remaining) return new Date(from + remaining * 60_000);
    remaining -= available;
  }
  return new Date(cursor);
}

/** Is this instant inside working hours? (used by "silence is not consent" jobs) */
export function isWithinBusinessHours(instant: Date, cal: BusinessCalendar): boolean {
  const win = windowFor(cal, instant);
  return !!win && instant >= win.start && instant <= win.end;
}
