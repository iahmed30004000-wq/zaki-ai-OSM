import { describe, expect, it } from 'vitest';
import * as kept from './business-calendar';
import { isoWithOffset } from './v1/shape';
import { readyAtWords } from './work-first';

/**
 * THE CALENDAR KEEPS ITS TOOLS — AND ANSWERS WHAT IT ALWAYS ANSWERED.
 *
 * The owner, 13/11: «ابحث عن سبب التعليق بالسايت ولوحة الأداء». The business calendar built a date formatter on every call
 * (45 µs against 4 µs to use one); a span of five minutes asked for fifteen of them and the team table asked for tens of
 * thousands of spans in one go, so the one server process answered nobody for 19.5 seconds. It keeps them now.
 *
 * What this file holds:
 *   1. THE OLD FUNCTIONS, copied word for word from the commit before the change, as the reference (`ref…`).
 *   2. A seeded comparison of every exported answer against them — odd zones, odd hours, odd weekends, spans from seconds to
 *      forty days — expecting not one difference.
 *   3. The guard that it does not come back: after warming, no formatter is built at all.
 *   4. The kept days are only a memory: dropping them changes no answer.
 */

// ───────────────────────── THE REFERENCE: the functions as they were ─────────────────────────

interface RefParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}
interface RefCalendar {
  workHoursStart: string;
  workHoursEnd: string;
  weekendDays: number[];
  timezone: string;
}

const REF_WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function refZonedParts(instant: Date, timeZone: string): RefParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });
  const parts = Object.fromEntries(fmt.formatToParts(instant).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: REF_WEEKDAY[parts.weekday as string] ?? 0,
  };
}

function refOffsetMinutes(instant: Date, timeZone: string): number {
  const p = refZonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0, 0);
  return Math.round((asUtc - instant.getTime() - (instant.getMilliseconds() - instant.getMilliseconds())) / 60_000) -
    Math.round((instant.getSeconds() * 1000) / 60_000);
}

function refZonedTimeToInstant(timeZone: string, year: number, month: number, day: number, hour: number, minute: number): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let guess = new Date(naive - refOffsetMinutes(new Date(naive), timeZone) * 60_000);
  guess = new Date(naive - refOffsetMinutes(guess, timeZone) * 60_000);
  return guess;
}

function refParseHhMm(value: string, fallbackHour: number): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value ?? '');
  if (!m) return { hour: fallbackHour, minute: 0 };
  return { hour: Math.min(23, Number(m[1])), minute: Math.min(59, Number(m[2])) };
}

function refWindowFor(cal: RefCalendar, dayInstant: Date): { start: Date; end: Date } | null {
  const p = refZonedParts(dayInstant, cal.timezone);
  if (cal.weekendDays.includes(p.weekday)) return null;
  const from = refParseHhMm(cal.workHoursStart, 9);
  const to = refParseHhMm(cal.workHoursEnd, 17);
  const start = refZonedTimeToInstant(cal.timezone, p.year, p.month, p.day, from.hour, from.minute);
  const end = refZonedTimeToInstant(cal.timezone, p.year, p.month, p.day, to.hour, to.minute);
  return end > start ? { start, end } : null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function refBusinessMinutesBetween(start: Date, end: Date, cal: RefCalendar): number {
  if (end <= start) return 0;
  let total = 0;
  for (let cursor = start.getTime() - DAY_MS; cursor <= end.getTime() + DAY_MS; cursor += DAY_MS) {
    const win = refWindowFor(cal, new Date(cursor));
    if (!win) continue;
    const from = Math.max(win.start.getTime(), start.getTime());
    const to = Math.min(win.end.getTime(), end.getTime());
    if (to > from) total += (to - from) / 60_000;
  }
  return Math.floor(total);
}

function refAddBusinessMinutes(start: Date, minutes: number, cal: RefCalendar): Date {
  if (minutes <= 0) return start;
  let remaining = minutes;
  let cursor = start.getTime() - DAY_MS;
  for (let guard = 0; guard < 400 && remaining > 0; guard++, cursor += DAY_MS) {
    const win = refWindowFor(cal, new Date(cursor));
    if (!win) continue;
    const from = Math.max(win.start.getTime(), start.getTime());
    if (win.end.getTime() <= from) continue;
    const available = (win.end.getTime() - from) / 60_000;
    if (available >= remaining) return new Date(from + remaining * 60_000);
    remaining -= available;
  }
  return new Date(cursor);
}

function refIsWithinBusinessHours(instant: Date, cal: RefCalendar): boolean {
  const win = refWindowFor(cal, instant);
  return !!win && instant >= win.start && instant <= win.end;
}

/** `isoWithOffset` of `src/lib/v1/shape.ts`, as it was: a new formatter on every call. */
function refIsoWithOffset(at: Date, timeZone: string): string {
  if (Number.isNaN(at.getTime())) throw new Error('isoWithOffset: not a date');
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const part: Record<string, string> = {};
  for (const p of fmt.formatToParts(at)) part[p.type] = p.value;
  const hour = part.hour === '24' ? '00' : part.hour;
  const asUtc = Date.UTC(Number(part.year), Number(part.month) - 1, Number(part.day), Number(hour), Number(part.minute), Number(part.second));
  const offsetMinutes = Math.round((asUtc - at.getTime()) / 60_000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${part.year}-${part.month}-${part.day}` + `T${hour}:${part.minute}:${part.second}` + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

// ───────────────────────── the inputs: seeded, so a failure can be run again ─────────────────────────

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Zones that follow daylight rules, zones that do not, half-hour and forty-five-minute offsets, and the two that changed in 2022. */
const ZONES = ['Asia/Damascus', 'Asia/Amman', 'Africa/Tripoli', 'Europe/Berlin', 'America/New_York', 'UTC', 'Asia/Kolkata', 'Australia/Lord_Howe', 'Asia/Riyadh', 'Asia/Kathmandu'];
/** Ordinary hours, hours that cross midnight (never open), hours the parser rejects (fall back to 9 and 17), a closed day of zero length, odd spellings. */
const HOURS: [string, string][] = [['09:00', '17:00'], ['10:00', '22:00'], ['00:00', '23:59'], ['9:5', '18:30'], ['22:00', '06:00'], ['bad', 'worse'], ['08:30', '08:30'], ['09:00', '24:00']];
const WEEKENDS = [[5], [5, 6], [], [0, 6], [0, 1, 2, 3, 4, 5, 6], [4, 5]];

const FROM = Date.UTC(2019, 0, 1);
const TO = Date.UTC(2028, 11, 31);
const MINUTE = 60_000;

function inputs(seed: number) {
  const next = rng(seed);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(next() * xs.length)];
  const instant = () => new Date(FROM + Math.floor(next() * (TO - FROM)));
  const calendar = (): RefCalendar => {
    const [workHoursStart, workHoursEnd] = pick(HOURS);
    return { workHoursStart, workHoursEnd, weekendDays: pick(WEEKENDS), timezone: pick(ZONES) };
  };
  /** Seconds and milliseconds included: the floor of a sum of fractional minutes is where two «equal» clocks would part. */
  const span = () => {
    const k = next();
    if (k < 0.5) return Math.floor(next() * 180) * MINUTE + Math.floor(next() * 60_000);
    if (k < 0.8) return Math.floor(next() * 3 * 24 * 60) * MINUTE;
    return Math.floor(next() * 40 * 24 * 60) * MINUTE + Math.floor(next() * 1000);
  };
  return { next, pick, instant, calendar, span };
}

function firstFive(found: unknown[]) {
  return found.slice(0, 5);
}

// ───────────────────────── 1 + 2: the same answers ─────────────────────────

describe('the calendar keeps its tools, and says what it always said', () => {
  it('reads the local clock of an instant as it did', () => {
    const { instant, pick } = inputs(20261113);
    const different: unknown[] = [];
    for (let i = 0; i < 5000; i++) {
      const at = instant();
      const zone = pick(ZONES);
      const a = JSON.stringify(refZonedParts(at, zone));
      const b = JSON.stringify(kept.zonedParts(at, zone));
      if (a !== b) different.push({ at, zone, a, b });
    }
    expect(firstFive(different)).toEqual([]);
  }, 120_000);

  it('places a wall-clock time on the timeline as it did', () => {
    const { instant, pick } = inputs(7);
    const different: unknown[] = [];
    for (let i = 0; i < 1000; i++) {
      const zone = pick(ZONES);
      const p = kept.zonedParts(instant(), zone);
      const a = refZonedTimeToInstant(zone, p.year, p.month, p.day, p.hour, p.minute).getTime();
      const b = kept.zonedTimeToInstant(zone, p.year, p.month, p.day, p.hour, p.minute).getTime();
      if (a !== b) different.push({ zone, p, a, b });
    }
    expect(firstFive(different)).toEqual([]);
  }, 120_000);

  it('counts business minutes as it did, for spans from seconds to forty days (a few of them backwards)', () => {
    const { instant, calendar, span, next } = inputs(99);
    const different: unknown[] = [];
    for (let i = 0; i < 2500; i++) {
      const cal = calendar();
      const start = instant();
      const end = new Date(start.getTime() + (next() < 0.03 ? -span() : span()));
      const a = refBusinessMinutesBetween(start, end, cal);
      const b = kept.businessMinutesBetween(start, end, cal);
      if (a !== b) different.push({ cal, start, end, a, b });
    }
    expect(firstFive(different)).toEqual([]);
  }, 120_000);

  it('adds business minutes as it did, including zero, negative and more than a year of them', () => {
    const { instant, calendar, next } = inputs(31);
    const different: unknown[] = [];
    for (let i = 0; i < 800; i++) {
      const cal = calendar();
      const start = instant();
      const minutes = next() < 0.05 ? -5 : Math.floor(next() * 9000) + (next() < 0.02 ? 600_000 : 0);
      const a = refAddBusinessMinutes(start, minutes, cal).getTime();
      const b = kept.addBusinessMinutes(start, minutes, cal).getTime();
      if (a !== b) different.push({ cal, start, minutes, a, b });
    }
    expect(firstFive(different)).toEqual([]);
  }, 120_000);

  it('says whether an instant is inside working hours as it did', () => {
    const { instant, calendar } = inputs(5);
    const different: unknown[] = [];
    for (let i = 0; i < 3000; i++) {
      const cal = calendar();
      const at = instant();
      if (refIsWithinBusinessHours(at, cal) !== kept.isWithinBusinessHours(at, cal)) different.push({ cal, at });
    }
    expect(firstFive(different)).toEqual([]);
  }, 120_000);

  it('writes the offset of the published API byte for byte as it did', () => {
    const { instant, pick } = inputs(11);
    const different: unknown[] = [];
    for (let i = 0; i < 3000; i++) {
      const at = new Date(Math.floor(instant().getTime() / 1000) * 1000 + (i % 7) * 1000);
      const zone = pick(ZONES);
      const a = refIsoWithOffset(at, zone);
      const b = isoWithOffset(at, zone);
      if (a !== b) different.push({ at, zone, a, b });
    }
    expect(firstFive(different)).toEqual([]);
  }, 120_000);

  it('still refuses a name that is not a zone, every time, and not a date', () => {
    const cal = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5], timezone: 'Not/AZone' };
    const at = new Date('2026-10-01T08:00:00Z');
    expect(() => kept.zonedParts(at, 'Not/AZone')).toThrow();
    expect(() => kept.zonedParts(at, 'Not/AZone')).toThrow();
    expect(() => kept.businessMinutesBetween(at, new Date('2026-10-02T08:00:00Z'), cal)).toThrow();
    expect(() => isoWithOffset(at, 'Not/AZone')).toThrow();
    expect(() => isoWithOffset(new Date('x'), 'UTC')).toThrow('isoWithOffset: not a date');
  });
});

// ───────────────────────── 3: it does not come back ─────────────────────────

/** Counts every `new Intl.DateTimeFormat` while `run` works — the thing that cost seconds per request (the harness of `no-answer-watch.test.ts`). */
function formattersBuiltBy(run: () => void): number {
  const Real = Intl.DateTimeFormat;
  let built = 0;
  const Counting = function (this: unknown, ...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
    built++;
    return new Real(...args);
  } as unknown as typeof Intl.DateTimeFormat;
  Object.assign(Counting, { supportedLocalesOf: Real.supportedLocalesOf });
  Intl.DateTimeFormat = Counting;
  try {
    run();
  } finally {
    Intl.DateTimeFormat = Real;
  }
  return built;
}

describe('no formatter is built once the calendar is warm', () => {
  const CAL = { workHoursStart: '09:00', workHoursEnd: '21:00', weekendDays: [5], timezone: 'Asia/Damascus' };
  const base = Date.UTC(2026, 9, 1, 8, 0, 0);

  it('a business span of five minutes costs no formatter, however many are asked', () => {
    // warm: the zone and the days this loop will walk
    for (let i = 0; i < 2000; i++) kept.businessMinutesBetween(new Date(base + i * 14 * MINUTE), new Date(base + i * 14 * MINUTE + 5 * MINUTE), CAL);
    const built = formattersBuiltBy(() => {
      for (let i = 0; i < 2000; i++) kept.businessMinutesBetween(new Date(base + i * 14 * MINUTE), new Date(base + i * 14 * MINUTE + 5 * MINUTE), CAL);
      for (let i = 0; i < 300; i++) kept.addBusinessMinutes(new Date(base + i * 14 * MINUTE), 90, CAL);
      for (let i = 0; i < 300; i++) kept.isWithinBusinessHours(new Date(base + i * 14 * MINUTE), CAL);
    });
    expect(built).toBe(0);
  });

  it('the published API date costs none', () => {
    isoWithOffset(new Date(base), 'Asia/Damascus');
    const built = formattersBuiltBy(() => {
      for (let i = 0; i < 500; i++) isoWithOffset(new Date(base + i * 60_000), 'Asia/Damascus');
    });
    expect(built).toBe(0);
  });

  it('the desk\'s «جاهز الساعة» sentence costs none for a zone it already knows', () => {
    // every branch of the sentence (today, tomorrow, this week, later) and a zone that is not one
    const now = new Date('2026-10-01T08:00:00Z');
    const days = [0, 1, 3, 9];
    for (const d of days) readyAtWords(new Date(now.getTime() + d * DAY_MS), now, 'Asia/Amman');
    readyAtWords(now, now, 'Not/AZone');
    const built = formattersBuiltBy(() => {
      for (let i = 0; i < 200; i++) {
        readyAtWords(new Date(now.getTime() + days[i % days.length] * DAY_MS + i * 60_000), now, 'Asia/Amman');
        readyAtWords(now, now, 'Not/AZone');
      }
    });
    expect(built).toBe(0);
  });

  it('and its words do not change: a zone that is not one falls back to the machine\'s clock, as before', () => {
    const now = new Date('2026-10-01T08:00:00Z');
    expect(readyAtWords(new Date('2026-10-01T10:30:00Z'), now, 'Not/AZone')).toBe(readyAtWords(new Date('2026-10-01T10:30:00Z'), now, null));
    expect(readyAtWords(new Date('2026-10-01T10:30:00Z'), now, 'Asia/Amman')).toBe('جاهز الساعة 13:30');
  });
});

// ───────────────────────── 4: the kept days are a memory, not a second source of truth ─────────────────────────

describe('the kept working days are only a memory', () => {
  it('is right again after it was filled past its bound and dropped', () => {
    // every day is a working day here, so every day is kept: 25,000 distinct days overflow the bound (20,000) at least once
    const CAL = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [] as number[], timezone: 'Asia/Amman' };
    const start = Date.UTC(2000, 0, 1);
    for (let d = 0; d < 25_000; d++) kept.isWithinBusinessHours(new Date(start + d * DAY_MS + 10 * 3_600_000), CAL);
    const { instant, next } = inputs(2026);
    const different: unknown[] = [];
    for (let i = 0; i < 200; i++) {
      const a0 = instant();
      const b0 = new Date(a0.getTime() + Math.floor(next() * 6 * 24 * 60) * MINUTE);
      const a = refBusinessMinutesBetween(a0, b0, CAL);
      const b = kept.businessMinutesBetween(a0, b0, CAL);
      if (a !== b) different.push({ a0, b0, a, b });
    }
    expect(firstFive(different)).toEqual([]);
  }, 120_000);

  it('a day whose closing is not after its opening has no window at all, not even at the very instant it «opens»', () => {
    const cal = { workHoursStart: '08:30', workHoursEnd: '08:30', weekendDays: [] as number[], timezone: 'Asia/Amman' };
    const exactly = kept.zonedTimeToInstant('Asia/Amman', 2026, 10, 7, 8, 30);
    expect(refIsWithinBusinessHours(exactly, cal)).toBe(false);
    expect(kept.isWithinBusinessHours(exactly, cal)).toBe(false);
    // asked again, so this answer comes from what was kept
    expect(kept.isWithinBusinessHours(exactly, cal)).toBe(false);
  });

  it('keeps two calendars of one zone apart: the hours are part of what a day is', () => {
    // Sunday 12:00 to 20:00 in Damascus (UTC+3): the morning shift is over by noon, the afternoon one is worked in full
    const at = new Date('2026-10-04T09:00:00Z');
    const end = new Date(at.getTime() + 8 * 3_600_000);
    const early = { workHoursStart: '08:00', workHoursEnd: '12:00', weekendDays: [5], timezone: 'Asia/Damascus' };
    const late = { workHoursStart: '14:00', workHoursEnd: '20:00', weekendDays: [5], timezone: 'Asia/Damascus' };
    const a = kept.businessMinutesBetween(at, end, early);
    const b = kept.businessMinutesBetween(at, end, late);
    expect(a).toBe(refBusinessMinutesBetween(at, end, early));
    expect(b).toBe(refBusinessMinutesBetween(at, end, late));
    expect(a).toBe(0);
    expect(b).toBe(360);
  });
});
