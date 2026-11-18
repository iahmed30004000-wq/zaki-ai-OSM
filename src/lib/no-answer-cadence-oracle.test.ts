import { describe, expect, it } from 'vitest';
import { cadencePress, cadenceStep, type CadenceCal, type CadenceState } from './no-answer-cadence';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE PLAN, WRITTEN A SECOND TIME THE OTHER WAY ROUND (step B of Confirmation Center v2)
 *
 * What must agree, to the millisecond, between `no-answer-cadence.ts` and this file: for every press — whether it counts, the due it stores, the counted attempts, the local days they fall on
 * and whether the order closes — across the DST-transition zones, every boundary of the work window, and every rule set a country can bring: Syria's row (10:00-22:00, no rest day), Jordan's
 * (09:00-17:00, Friday and Saturday off), Friday only, six rest days of seven, all seven (= none), a row with no hours, garbage hours, an overnight shift and one half-missing.
 * Edge cases: a due exactly at the start / exactly at the end / one millisecond either side; #1 at 21:50 (#2 waits for the next start); a Thursday-evening chain across Friday and Saturday;
 * the 8-hour boundary (#3 exactly 8 h before a start counts, a millisecond later waits a day); the 3-hour floor; the first-day guard; the floor (`enabledAt`); random seeded worlds.
 * RULING 16 (15/11 22:30, option «ب»), the newest item: #5 lands INSIDE the country's work hours. Its anchor is min(18:00, workHoursEnd − 1 h) (never before the start): Syria 10-22 → 18:00, Jordan
 * 09-17 → 16:00, a 09-12 day → 11:00. #5 = max(first anchor strictly after #4 on a work day, #4 + 3 h); outside [start, end) (the end exclusive) → the anchor of the first work day after it (a 09-12
 * day with #4 at 09:00: #4 + 3 h = 12:00 is the end, so tomorrow 11:00). Extra rule sets: a 09-12 day, a window under an hour (anchor = start), an evening window 19-23 (anchor = start), an odd 08:15-16:45.
 * PROPERTY: for any window of at least an hour and any rest set that leaves a work day, #5 is always inside [start, end) on a work day, at least 3 h after #4 — over a grid of #4 presses in four zones.
 * Blockers: a mismatch anywhere. The oracle must NOT call `zonedParts`, `zonedTimeToInstant`, `dueAfter`, `cadenceStep` or the module's window reader — it imports `cadencePress`, `cadenceStep` (the property
 * test feeds it a hand-built state) and the type only; the anchor is spelled out again here.
 *
 * UPDATED 2026-11-18 (request C2, the owner's plan of 17/11 §3.1): the two anchors moved — #4 is due at the MORNING anchor, 11:00 clamped into [start, end − 1 h] (it was the
 * start of work), and #5's cap is 19:30 (it was 18:00). The oracle spells both again (`MORNING_AT`, `EVENING_CAP`), walks to the morning anchor for #4, and every hand-written
 * expectation below is the new instant; the rest of the walk, the grids and the property are unchanged.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * `no-answer-cadence.ts` places the due instants with `zonedParts` / `zonedTimeToInstant` (arithmetic on the local calendar). This oracle owns a formatter and WALKS: every supported zone's
 * offset is a multiple of 15 minutes, so a grid of quarter-hours placed in UTC is a grid of quarter-hours of the local clock too, and (the window's edges being quarter-hours)
 *
 *   #1 → raw = +30 min and #2 → raw = +2 h are millisecond additions; the raw is INSIDE work time when the quarter-hour that contains it reads a clock in [start, end) on a day that is not a rest
 *        day (the end exclusive), and then it is the due; otherwise the due is the first quarter-hour at or after it that reads `start` on a day that is not a rest day;
 *   #3 → walk forward from the instant 8 h (elapsed) later: the first quarter-hour that is at or after it (exactly 8 h counts), reads `start` on the local clock, falls on a day that is
 *        not a rest day (the formatter's own weekday) and is not the local DATE of the first attempt (the independent form of the first-day guard);
 *   #5 → walk from the first quarter-hour strictly after the fourth attempt until the local clock reads the EVENING ANCHOR on a day that is not a rest day; never earlier than the fourth + 3 h; if the
 *        quarter-hour that contains that is not inside the window on a work day, walk on from the first quarter-hour strictly after it to the next anchor on a work day;
 *   counting, the early rule, the floor, the days set and the close are its own loop; the work window is read by the oracle's OWN reader of «HH:mm» with its own fallbacks.
 *
 * Two ways of reaching the same instants must agree on every zone, every anchor (each zone's 2026 transition weekend INCLUDING its 25-hour day, an ordinary week, a month end, a year
 * end, a leap day), every boundary of the window of the rule set at hand, and every press (due − 1 ms, at the due, + 1 ms, + 3 h, and the clocks that put the NEXT due on an edge), or one of
 * them is wrong. Each mismatch prints the zone, the seed and the sequence.
 * ═══════════════════════════════════════════════════════════════════════
 */

const QUARTER = 15 * 60_000;
const HOUR = 3_600_000;
const NO_ANSWER_LIKE = ['NO_ANSWER', 'BUSY', 'UNREACHABLE'];
/** The fallback window and the cap of #5's anchor, spelled again here on purpose (the oracle imports no constant of the module). */
const FALLBACK = { start: '10:00', end: '22:00' };
const EVENING_CAP = '19:30';
/** #4's clock (request C2): 11:00, clamped into [start, end − 1 h] — spelled again here on purpose. */
const MORNING_AT = '11:00';
/** A walk of sixteen days of quarter-hours: far more than any due needs (the longest wait is a week of rest days). */
const MAX_WALK = 16 * 96;

/** What a country brings: its rest days and what its row SAYS about work hours — raw, so that a missing or garbage value reaches the module as it would in production. */
interface Rules {
  name: string;
  /** The local weekdays (0 = Sunday) that are not work days. All seven means «nowhere to skip to»: nothing is skipped. */
  rest: number[];
  rowStart?: string | null;
  rowEnd?: string | null;
}
const RULESETS: Rules[] = [
  { name: 'Syria-style: no rest day, 10:00-22:00', rest: [], rowStart: '10:00', rowEnd: '22:00' },
  { name: 'Jordan-style: Friday and Saturday off, 09:00-17:00', rest: [5, 6], rowStart: '09:00', rowEnd: '17:00' },
  { name: 'Friday only, 10:00-22:00', rest: [5], rowStart: '10:00', rowEnd: '22:00' },
  { name: 'all but Saturday off, 10:00-22:00', rest: [0, 1, 2, 3, 4, 5], rowStart: '10:00', rowEnd: '22:00' },
  { name: 'a late shift 12:30-20:15, Sunday off', rest: [0], rowStart: '12:30', rowEnd: '20:15' },
  { name: 'no hours on the row (fallback 10:00-22:00), Friday off', rest: [5], rowStart: undefined, rowEnd: undefined },
  { name: 'garbage hours (fallback 10:00-22:00)', rest: [], rowStart: 'garbage', rowEnd: '25:61' },
  { name: 'an overnight shift 22:00-06:00 (fallback 10:00-22:00 for both ends), Saturday off', rest: [6], rowStart: '22:00', rowEnd: '06:00' },
  { name: 'the end missing (start 09:00 kept, end falls back to 22:00)', rest: [], rowStart: '09:00', rowEnd: null },
  { name: 'all seven days marked rest (nothing is skipped), 10:00-22:00', rest: [0, 1, 2, 3, 4, 5, 6], rowStart: '10:00', rowEnd: '22:00' },
  // ruling 16: the windows where #5's anchor is not 18:00 (appended, so the indexes above stay)
  { name: 'a short day 09:00-12:00 (#5 anchor 11:00), Friday off', rest: [5], rowStart: '09:00', rowEnd: '12:00' },
  { name: 'a window under an hour 09:00-09:45 (#5 anchor = the start), no rest day', rest: [], rowStart: '09:00', rowEnd: '09:45' },
  { name: 'an evening window 19:00-23:00 (#5 anchor = the start, 18:00 is before it), Saturday off', rest: [6], rowStart: '19:00', rowEnd: '23:00' },
  { name: 'an odd day 08:15-16:45 (#5 anchor 15:45), Friday and Saturday off', rest: [5, 6], rowStart: '08:15', rowEnd: '16:45' },
];
const SYRIA = RULESETS[0];
/** The rule sets that are about the READING of the hours, not about zones: they run on three zones only. */
const READING_SETS = new Set([RULESETS[5], RULESETS[6], RULESETS[7], RULESETS[8], RULESETS[9]]);
/** The ruling-16 sets: three zones plus a few clock-change days (their point is the anchor, not the zone). */
const ANCHOR_SETS = new Set(RULESETS.slice(10));

/** The oracle's own reader of «HH:mm»: the zero-padded clock, or null. */
function readClock(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}
/** The window the country's row means: each side falls back on its own, and an end that is not after the start sends both to the fallback. */
function windowOf(rules: Rules): { start: string; end: string } {
  const start = readClock(rules.rowStart) ?? FALLBACK.start;
  const end = readClock(rules.rowEnd) ?? FALLBACK.end;
  return end > start ? { start, end } : { ...FALLBACK };
}
/** The rest days that count: all seven (nowhere to skip to) skip nothing. */
const restOf = (rules: Rules): number[] => (new Set(rules.rest).size >= 7 ? [] : rules.rest);
/** A clock «HH:mm» moved by whole minutes round the day — arithmetic on the clock face, no calendar. */
function shiftClock(clock: string, minutes: number): string {
  const [h, m] = clock.split(':').map(Number);
  const t = (((h * 60 + m + minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const clockCache = new Map<string, { date: string; hhmm: string; wd: number }>();
/** The oracle's own weekday table — it does not borrow the module's. */
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The local date (`yyyy-mm-dd`), clock (`hh:mm`) and weekday (0 = Sunday) of the quarter-hour that contains `ms`, in `tz` — read from the oracle's own formatter. */
function localOf(ms: number, tz: string): { date: string; hhmm: string; wd: number } {
  const q = Math.floor(ms / QUARTER);
  const key = `${tz}|${q}`;
  const hit = clockCache.get(key);
  if (hit) return hit;
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    formatters.set(tz, f);
  }
  const parts = Object.fromEntries(f.formatToParts(new Date(q * QUARTER)).map((p) => [p.type, p.value]));
  const wd = WEEKDAY[parts.weekday];
  if (wd === undefined) throw new Error(`oracle: unknown weekday ${parts.weekday}`);
  const out = { date: `${parts.year}-${parts.month}-${parts.day}`, hhmm: `${parts.hour}:${parts.minute}`, wd };
  clockCache.set(key, out);
  return out;
}

/** The instant the local clock first reads `date` `hhmm` — found by walking, never by arithmetic. Null when that wall time does not exist (a DST gap). */
function instantOf(tz: string, date: string, hhmm: string): number | null {
  // The grid is quarter-hours, so a minute that is not one (08:59, 17:59, 23:59, 00:01) is the quarter below it plus the remainder — still found by walking, never by arithmetic on the calendar.
  const [hh, mm] = hhmm.split(':').map(Number);
  if (mm % 15 !== 0) {
    const base = instantOf(tz, date, `${String(hh).padStart(2, '0')}:${String(mm - (mm % 15)).padStart(2, '0')}`);
    return base === null ? null : base + (mm % 15) * 60_000;
  }
  const [y, m, d] = date.split('-').map(Number);
  const start = Math.floor((Date.UTC(y, m - 1, d) - 15 * 3_600_000) / QUARTER) * QUARTER;
  for (let q = start; q <= start + 52 * 3_600_000; q += QUARTER) {
    const l = localOf(q, tz);
    if (l.date === date && l.hhmm === hhmm) return q;
  }
  return null;
}

/** The oracle's due after the attempts `times` (the COUNTED ones, the last at `times[times.length - 1]`). */
function dueOracle(times: number[], tz: string, rules: Rules): number {
  const win = windowOf(rules);
  const rest = restOf(rules);
  const counted = times.length;
  const at = times[counted - 1];
  if (counted <= 2) {
    const raw = at + (counted === 1 ? 30 * 60_000 : 2 * HOUR);
    const here = localOf(raw, tz); // the quarter-hour that contains the raw: the window's edges are quarter-hours, so it classifies the raw exactly
    if (!rest.includes(here.wd) && here.hhmm >= win.start && here.hhmm < win.end) return raw;
    let q = Math.ceil(raw / QUARTER) * QUARTER; // the first quarter-hour at or after the raw
    for (let n = 0; n < MAX_WALK; n++, q += QUARTER) {
      const l = localOf(q, tz);
      if (l.hhmm === win.start && !rest.includes(l.wd)) return q;
    }
    throw new Error(`oracle: no start of work within sixteen days (${tz})`);
  }
  if (counted === 3) {
    const floor = at + 8 * HOUR; // ELAPSED hours: «>=» below is the «exactly 8 h counts» rule
    const firstDate = localOf(times[0], tz).date;
    let q = Math.floor(floor / QUARTER) * QUARTER;
    for (let n = 0; n < MAX_WALK; n++, q += QUARTER) {
      if (q < floor) continue;
      const l = localOf(q, tz);
      // the last clause is the independent first-day guard: #4 is never on the local date of #1
      if (l.hhmm === morningOf(win) && !rest.includes(l.wd) && l.date !== firstDate) return q;
    }
    throw new Error(`oracle: no #4 within sixteen days (${tz})`);
  }
  const anchor = anchorOf(win);
  /** The first quarter-hour STRICTLY after `after` that reads the anchor on a day that is not a rest day. */
  const nextAnchor = (after: number): number => {
    let q = Math.floor(after / QUARTER) * QUARTER + QUARTER;
    for (let n = 0; n < MAX_WALK; n++, q += QUARTER) {
      const l = localOf(q, tz);
      if (l.hhmm === anchor && !rest.includes(l.wd)) return q;
    }
    throw new Error(`oracle: no #5 within sixteen days (${tz})`);
  };
  const candidate = Math.max(nextAnchor(at), at + 3 * HOUR);
  const there = localOf(candidate, tz); // the quarter-hour that contains the candidate: the window's edges are quarter-hours, so it classifies the candidate exactly
  if (!rest.includes(there.wd) && there.hhmm >= win.start && there.hhmm < win.end) return candidate;
  return nextAnchor(candidate); // outside work time (at or after the end, before the start, or on a rest day): the anchor of the next work day
}

/** The minutes since midnight of an «HH:mm», and back — the oracle's own, with no wrap round midnight. */
const minutesOf = (c: string): number => Number(c.slice(0, 2)) * 60 + Number(c.slice(3));
const clockOfMinutes = (t: number): string => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
/** #5's evening anchor (ruling 16): the earlier of 18:00 and an hour before the end of work — but never before the start of work. */
function anchorOf(win: { start: string; end: string }): string {
  return clockOfMinutes(Math.max(minutesOf(win.start), Math.min(minutesOf(EVENING_CAP), minutesOf(win.end) - 60)));
}
/** #4's morning anchor (request C2): 11:00 clamped into [start, end − 1 h] — never before the start. */
function morningOf(win: { start: string; end: string }): string {
  return clockOfMinutes(Math.max(minutesOf(win.start), Math.min(minutesOf(MORNING_AT), minutesOf(win.end) - 60)));
}

interface Line { at: number; result: string }
interface Verdict { counted: boolean; dueAt: number | null; closes: boolean; countedTimes: number[]; days: number; nextDue: number | null }

/** The oracle's own loop: fold the lines in the order given (attempt order), return the verdict of the LAST one. */
function verdictOf(lines: Line[], since: number, tz: string, rules: Rules): Verdict {
  const counted: number[] = [];
  let due: number | null = null;
  let last = false;
  for (const l of lines) {
    last = false;
    if (!NO_ANSWER_LIKE.includes(l.result)) continue;
    if (!(l.at > since)) continue;
    if (counted.length >= 5) continue;
    if (counted.length > 0 && due !== null && l.at < due) continue;
    counted.push(l.at);
    due = counted.length >= 5 ? null : dueOracle([...counted], tz, rules);
    last = true;
  }
  const days = new Set(counted.map((t) => localOf(t, tz).date)).size;
  const lastIsNoAnswer = lines.length > 0 && NO_ANSWER_LIKE.includes(lines[lines.length - 1].result);
  return {
    counted: last,
    dueAt: last ? due : null,
    closes: lastIsNoAnswer && counted.length >= 5 && days >= 2,
    countedTimes: counted,
    days,
    nextDue: due,
  };
}

/** What the real module says about the same last line — handed the country's row exactly as it says it (raw hours, missing or garbage included). */
function moduleVerdict(lines: Line[], since: number, tz: string, rules: Rules): Verdict {
  const cal: CadenceCal = { since: new Date(since), timeZone: tz, restDays: rules.rest, workHoursStart: rules.rowStart, workHoursEnd: rules.rowEnd };
  const stored = lines.slice(0, -1).map((l, i) => ({ createdAt: new Date(l.at), result: l.result, attemptNumber: i + 1 }));
  const last = lines[lines.length - 1];
  const r = cadencePress(stored, { at: new Date(last.at), result: last.result }, cal);
  return {
    counted: r.counted,
    dueAt: r.dueAt ? r.dueAt.getTime() : null,
    closes: r.closes,
    countedTimes: r.next.counted.map((d) => d.getTime()),
    days: r.next.days,
    nextDue: r.next.dueAt ? r.next.dueAt.getTime() : null,
  };
}

const ZONES: Array<{ tz: string; anchors: string[] }> = [
  { tz: 'Asia/Amman', anchors: ['2026-03-27', '2026-11-15', '2026-11-30', '2026-12-31', '2028-02-29'] },
  { tz: 'Asia/Damascus', anchors: ['2026-03-27', '2026-10-30', '2026-12-31'] },
  // 2026-10-25 (Berlin), 2026-11-01 (New York) and 2026-04-05 (Auckland, Chatham, Lord Howe) are the days the clocks go BACK: the window's clocks are read across a 25-hour day there.
  { tz: 'Europe/Berlin', anchors: ['2026-03-28', '2026-10-24', '2026-10-25', '2026-11-30', '2026-12-31'] },
  { tz: 'America/New_York', anchors: ['2026-03-07', '2026-10-31', '2026-11-01', '2026-12-31'] },
  { tz: 'Asia/Beirut', anchors: ['2026-03-28', '2026-03-29', '2026-10-24', '2026-10-25'] },
  { tz: 'Australia/Lord_Howe', anchors: ['2026-04-04', '2026-04-05', '2026-10-03'] },
  { tz: 'Pacific/Auckland', anchors: ['2026-04-04', '2026-04-05', '2026-09-26'] },
  { tz: 'Pacific/Chatham', anchors: ['2026-04-04', '2026-04-05', '2026-09-26'] },
  { tz: 'Asia/Kathmandu', anchors: ['2026-11-30', '2026-12-31'] },
];
/** Wednesday to Sunday in every zone: the days a Friday / Saturday / Sunday rest set bites on. */
const REST_ANCHORS = ['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'];
/** A few days a clock-change falls on, for the rule sets whose grid is not the full one. */
const DST_CELLS: Array<{ tz: string; anchor: string }> = [
  { tz: 'Europe/Berlin', anchor: '2026-03-28' },
  { tz: 'Europe/Berlin', anchor: '2026-10-25' },
  { tz: 'America/New_York', anchor: '2026-03-07' },
  { tz: 'America/New_York', anchor: '2026-11-01' },
  { tz: 'Pacific/Auckland', anchor: '2026-04-05' },
  { tz: 'Asia/Beirut', anchor: '2026-03-28' },
];
const THREE_ZONES = ['Asia/Amman', 'Europe/Berlin', 'America/New_York'];

/** The days a wall clock does not exist for a stretch of the small hours (spring-forward) — the only place a boundary may legitimately be unplaceable. */
const GAP_DAYS = ['Asia/Beirut 2026-03-29', 'Europe/Berlin 2026-03-29', 'America/New_York 2026-03-08', 'Pacific/Auckland 2026-09-27', 'Pacific/Chatham 2026-09-27', 'Australia/Lord_Howe 2026-10-04'];
/** A skipped boundary is acceptable only inside the small hours of a spring-forward day: anywhere else it is a hole in the grid. */
const isKnownGap = (entry: string): boolean => {
  const [tz, date, clock] = entry.split(' ');
  return GAP_DAYS.includes(`${tz} ${date}`) && clock < '04:00';
};

/** The cells a rule set is run on: the full grid (every zone × its anchors) for Syria's, the week of rest days in every zone and a few clock-change days for the others — three zones for the reading-only sets. */
function cellsFor(rules: Rules): Array<{ tz: string; anchor: string }> {
  if (rules === SYRIA) return ZONES.flatMap(({ tz, anchors }) => anchors.map((anchor) => ({ tz, anchor })));
  const small = READING_SETS.has(rules) || ANCHOR_SETS.has(rules);
  const zones = small ? ZONES.filter(({ tz }) => THREE_ZONES.includes(tz)) : ZONES;
  const week = zones.flatMap(({ tz }) => REST_ANCHORS.map((anchor) => ({ tz, anchor })));
  return READING_SETS.has(rules) ? week : [...week, ...DST_CELLS];
}

/** The first presses of a cell: the clocks that put #2's raw due exactly on the window's edges (±1 ms), the edges themselves, the day's ends, and 21:50. */
function firstPresses(rules: Rules): Array<[string, number]> {
  const win = windowOf(rules);
  const out: Array<[string, number]> = [['00:00', 0], ['00:00', 1], ['21:50', 0], ['23:59', 59_999], ['17:59', 59_999], ['18:00', 0], [shiftClock(win.start, -1), 59_999], [win.start, 0]];
  for (const edge of [win.start, win.end]) {
    const c = shiftClock(edge, -30); // a first press here makes #2's raw due the edge itself
    out.push([shiftClock(c, -1), 59_999], [c, 0], [c, 1]);
  }
  const seen = new Set<string>();
  return out.filter(([c, extra]) => !seen.has(`${c}|${extra}`) && seen.add(`${c}|${extra}`));
}

const SINCE_FAR = Date.UTC(2020, 0, 1);

describe('the oracle itself is sane', () => {
  // Amman is UTC+3 all year: a local clock is the UTC hour minus three.
  const amman = (d: number, h: number, mi = 0, s = 0, ms = 0) => Date.UTC(2026, 10, d, h - 3, mi, s, ms);
  const AMMAN = 'Asia/Amman';

  it('knows the plan on a plain day with Syria’s hours: inside work time a due is the raw press + gap, to the millisecond', () => {
    const t1 = amman(15, 13, 0); // Sunday 13:00
    const t2 = t1 + 30 * 60_000;
    expect(dueOracle([t1], AMMAN, SYRIA)).toBe(t1 + 30 * 60_000);
    expect(dueOracle([t1, t2], AMMAN, SYRIA)).toBe(t2 + 2 * HOUR);
    expect(dueOracle([amman(15, 11, 7, 12, 345)], AMMAN, SYRIA)).toBe(amman(15, 11, 37, 12, 345));
  });

  it('knows the window: #1 at 21:50 waits for the next start; the end is exclusive, the start inclusive', () => {
    expect(new Date(dueOracle([amman(15, 21, 50)], AMMAN, SYRIA)).toISOString()).toBe('2026-11-16T07:00:00.000Z'); // Monday 10:00
    expect(dueOracle([amman(15, 21, 29, 59, 999)], AMMAN, SYRIA)).toBe(amman(15, 21, 59, 59, 999)); // a millisecond before the end: inside
    expect(dueOracle([amman(15, 21, 30)], AMMAN, SYRIA)).toBe(amman(16, 10)); // raw == the end: outside
    expect(dueOracle([amman(15, 9, 30)], AMMAN, SYRIA)).toBe(amman(15, 10)); // raw == the start: inside, the raw itself
    expect(dueOracle([amman(15, 9, 29, 59, 999)], AMMAN, SYRIA)).toBe(amman(15, 10)); // a millisecond before the start: that day's start
    expect(dueOracle([amman(15, 3)], AMMAN, SYRIA)).toBe(amman(15, 10));
    const t1 = amman(14, 8);
    expect(dueOracle([t1, amman(15, 8, 0)], AMMAN, SYRIA)).toBe(amman(15, 10)); // #2 at 08:00 → raw 10:00 is the start
    expect(dueOracle([t1, amman(15, 20, 0)], AMMAN, SYRIA)).toBe(amman(16, 10)); // #2 at 20:00 → raw 22:00 is the end
  });

  it('reads the row its own way: each side falls back alone, a bad pair sends both to 10:00-22:00', () => {
    expect(windowOf({ name: '', rest: [], rowStart: '09:00', rowEnd: '17:00' })).toEqual({ start: '09:00', end: '17:00' });
    expect(windowOf({ name: '', rest: [], rowStart: undefined, rowEnd: '17:00' })).toEqual({ start: '10:00', end: '17:00' });
    expect(windowOf({ name: '', rest: [], rowStart: '09:00', rowEnd: null })).toEqual({ start: '09:00', end: '22:00' });
    expect(windowOf({ name: '', rest: [], rowStart: '22:00', rowEnd: '06:00' })).toEqual({ start: '10:00', end: '22:00' });
    expect(windowOf({ name: '', rest: [], rowStart: 'x', rowEnd: 'y' })).toEqual({ start: '10:00', end: '22:00' });
    expect(restOf({ name: '', rest: [0, 1, 2, 3, 4, 5, 6] })).toEqual([]);
    expect(restOf({ name: '', rest: [5, 6] })).toEqual([5, 6]);
  });

  it('knows the 8-hour cliff, the 3-hour floor and the rest weekend (Friday and Saturday off, Jordan’s hours)', () => {
    const none: Rules = { name: 'none', rest: [], rowStart: '10:00', rowEnd: '22:00' };
    const upTo3 = (t3: number) => [t3 - 150 * 60_000, t3 - 120 * 60_000, t3];
    // C2: 03:00:00.000 → exactly 8 h to 11:00 counts; one millisecond later waits for tomorrow's 11:00
    // (#1 and #2 the evening before, so the first-day guard is not what moves it)
    const evenBefore = (t3: number) => [amman(2, 20), amman(2, 20, 30), t3];
    expect(dueOracle(evenBefore(amman(3, 3)), AMMAN, none)).toBe(amman(3, 11));
    expect(dueOracle(evenBefore(amman(3, 3) + 1), AMMAN, none)).toBe(amman(4, 11));
    // …and with #1 on the same local date the guard sends it to the next day's 11:00
    expect(dueOracle(upTo3(amman(3, 3)), AMMAN, none)).toBe(amman(4, 11));
    // C2: 16:30:00.000 → the 3 h floor equals the 19:30 anchor; one millisecond later the floor binds
    const t1 = amman(2, 9);
    const four = (t4: number) => [t1, t1 + 30 * 60_000, t1 + 150 * 60_000, t4];
    expect(dueOracle(four(amman(10, 16, 30)), AMMAN, none)).toBe(amman(10, 19, 30));
    expect(dueOracle(four(amman(10, 16, 30) + 1), AMMAN, none)).toBe(amman(10, 19, 30) + 1);
    // Thursday 19/11 14:00 with Friday and Saturday off → Sunday 22/11 11:00; Thursday 19:00 (floor 22:00 = the end) → Sunday 19:30
    const fridaySaturday: Rules = { name: 'fs', rest: [5, 6], rowStart: '10:00', rowEnd: '22:00' };
    expect(dueOracle(upTo3(amman(19, 14)), AMMAN, fridaySaturday)).toBe(amman(22, 11));
    expect(dueOracle([amman(17, 10), amman(17, 10, 30), amman(17, 12, 30), amman(19, 19)], AMMAN, fridaySaturday)).toBe(amman(22, 19, 30));
    // a Thursday-evening first press: #2 skips the weekend, and #3 (raw 22:30) waits for Sunday too
    expect(dueOracle([amman(19, 21, 55)], AMMAN, fridaySaturday)).toBe(amman(22, 10));
    expect(dueOracle([amman(19, 20), amman(19, 20, 30)], AMMAN, fridaySaturday)).toBe(amman(22, 10));
    // Jordan's own hours: 16:30 → raw 17:00 is the end → Sunday 09:00 across the weekend
    expect(dueOracle([amman(19, 16, 30)], AMMAN, RULESETS[1])).toBe(amman(22, 9));
    // Berlin, 25/10/2026 (the clocks go back at 03:00 CEST): 8 h after 02:30 CEST is 09:30 CET, so #4 would be 11:00 CET the SAME date: the first-day guard sends it to the 26th
    const BER = 'Europe/Berlin';
    const b1 = Date.UTC(2026, 9, 24, 22, 0);
    expect(new Date(dueOracle([b1, b1 + 30 * 60_000, b1 + 150 * 60_000], BER, none)).toISOString()).toBe('2026-10-26T10:00:00.000Z');
  });
});

/** One cell of the boundary grid: every first press × the on-time path and its side branches, for each zone × anchor given. */
function gridRun(cells: Array<{ tz: string; anchor: string }>, presses: Array<[string, number]>, rules: Rules, failures: string[], skipped: string[]): number {
  const win = windowOf(rules);
  /** A press `minutes` before `clock` — one millisecond before the clock, exactly at it, one millisecond after. */
  const around = (clock: string, minutes: number): Array<[string, number]> => {
    const c = shiftClock(clock, -minutes);
    return [[shiftClock(c, -1), 59_999], [c, 0], [c, 1]];
  };
  let compared = 0;
  for (const { tz, anchor } of cells) {
    for (const [hhmm, extra] of presses) {
      const base = instantOf(tz, anchor, hhmm);
      if (base === null) {
        skipped.push(`${tz} ${anchor} ${hhmm}`);
        continue;
      }
      const t1 = base + extra;
      const path: Line[] = [{ at: t1, result: 'NO_ANSWER' }];
      for (let step = 0; step < 6; step++) {
        const stateNow = verdictOf(path, SINCE_FAR, tz, rules);
        const check = (candidate: Line[]) => {
          const want = verdictOf(candidate, SINCE_FAR, tz, rules);
          const got = moduleVerdict(candidate, SINCE_FAR, tz, rules);
          compared++;
          if (JSON.stringify(want) !== JSON.stringify(got)) failures.push(JSON.stringify({ tz, anchor, hhmm, extra, rules, step, candidate, want, got }));
        };
        check(path);
        const due = stateNow.nextDue;
        if (due === null) break;
        const counted = stateNow.countedTimes.length;
        const dueDate = localOf(due, tz).date;
        const [dy, dm, dd] = dueDate.split('-').map(Number);
        const nextDay = new Date(Date.UTC(dy, dm - 1, dd + 1)).toISOString().slice(0, 10);
        const boundaries: number[] = [due - 1, due, due + 1, due + 3 * HOUR];
        const clocks: Array<[string, string, number]> = [
          [dueDate, '23:59', 59_999],
          [nextDay, '00:00', 0],
          [nextDay, '00:01', 0],
        ];
        // The press that puts the NEXT due on an edge: after #1 the next press is #2 (its raw due is +2 h), after #2 it is #3 (its 8 h floor lands on a start), after #3 it is #4 (the 3 h floor and the 18:00)
        if (counted === 1) for (const edge of [win.start, win.end]) for (const [c, x] of around(edge, 120)) for (const date of [dueDate, nextDay]) clocks.push([date, c, x]);
        if (counted === 2) for (const [c, x] of [...around(win.start, 480), ...around(morningOf(win), 480)]) for (const date of [dueDate, nextDay]) clocks.push([date, c, x]);
        if (counted === 3) {
          for (const [c, x] of [['16:29', 59_999], ['16:30', 0], ['16:30', 1], ['19:29', 59_999], ['19:30', 0], ['14:59', 59_999], ['15:00', 0], ['17:59', 59_999], ['18:00', 0]] as Array<[string, number]>) clocks.push([dueDate, c, x]);
          // ruling 16: the presses whose 3 h floor lands exactly on the window's end (±1 ms), on the anchor, and the presses at the anchor and just after it (the next anchor is tomorrow's)
          for (const [c, x] of [...around(win.end, 180), ...around(anchorOf(win), 180), ...around(anchorOf(win), 0), ...around(win.end, 0)]) for (const date of [dueDate, nextDay]) clocks.push([date, c, x]);
        }
        for (const [date, clock, add] of clocks) {
          const at = instantOf(tz, date, clock);
          if (at === null) skipped.push(`${tz} ${date} ${clock}`);
          else boundaries.push(at + add);
        }
        for (const at of boundaries) check([...path, { at, result: 'NO_ANSWER' }]);
        // …and the line before the floor and at it, on the same state
        check([...path, { at: SINCE_FAR, result: 'NO_ANSWER' }]);
        path.push({ at: due, result: 'NO_ANSWER' }); // the on-time path continues from the due
      }
    }
  }
  return compared;
}

describe('the module and the oracle agree', () => {
  it('on the boundary grid of Syria’s hours: every zone × anchor (clock-change days included) × first press, along the on-time path and its side branches', () => {
    const failures: string[] = [];
    // Every boundary that could not be placed — it must be a wall time that does not exist (a DST gap), never a silent hole in the grid.
    const skipped: string[] = [];
    const compared = gridRun(cellsFor(SYRIA), firstPresses(SYRIA), SYRIA, failures, skipped);
    expect(failures.slice(0, 3)).toEqual([]);
    expect(skipped.filter((s) => !isKnownGap(s))).toEqual([]);
    expect(compared).toBeGreaterThan(20_000);
  }, 300_000);

  it.each(RULESETS.slice(1))('on the boundary grid of the rule set «$name»: Wednesday to Sunday in the zones, along the on-time path and its side branches', (rules) => {
    const failures: string[] = [];
    const skipped: string[] = [];
    const compared = gridRun(cellsFor(rules), firstPresses(rules), rules, failures, skipped);
    expect(failures.slice(0, 3)).toEqual([]);
    expect(skipped.filter((s) => !isKnownGap(s))).toEqual([]);
    expect(compared).toBeGreaterThan(READING_SETS.has(rules) ? 10_000 : ANCHOR_SETS.has(rules) ? 12_000 : 30_000);
  }, 300_000);

  it('on the floor: a line at enabledAt never counts, one millisecond after does, four older lines are invisible', () => {
    const tz = 'Asia/Amman';
    const since = Date.UTC(2026, 10, 15, 7, 0);
    const old: Line[] = [1, 2, 3, 4].map((n) => ({ at: since - n * 3_600_000, result: 'NO_ANSWER' }));
    for (const rules of RULESETS) {
      for (const [at, counts] of [[since, false], [since + 1, true], [since - 1, false]] as const) {
        const lines = [...old, { at, result: 'NO_ANSWER' }];
        const want = verdictOf(lines, since, tz, rules);
        expect(moduleVerdict(lines, since, tz, rules)).toEqual(want);
        expect(want.counted).toBe(counts);
      }
    }
  });

  it.each([11, 22, 33])('on three seeded random generators (seed %i): per press the flag, the due (to the millisecond), the days and the close agree', (seed) => {
    const failures: string[] = [];
    let compared = 0;
    for (const { tz, anchors } of ZONES) {
      for (let run = 0; run < 60; run++) {
        const rnd = mulberry32(seed * 1_000_003 + run * 7919 + tz.length);
        const rules = RULESETS[Math.floor(rnd() * RULESETS.length)];
        const win = windowOf(rules);
        const rest = restOf(rules);
        const anchor = anchors[Math.floor(rnd() * anchors.length)];
        const [y, m, d] = anchor.split('-').map(Number);
        let at = Date.UTC(y, m - 1, d, Math.floor(rnd() * 24), Math.floor(rnd() * 60), Math.floor(rnd() * 60), Math.floor(rnd() * 1000)) - 6 * 3_600_000;
        const lines: Line[] = [];
        const since = at - 24 * 3_600_000;
        for (let n = 0; n < 14; n++) {
          const result = ['NO_ANSWER', 'NO_ANSWER', 'NO_ANSWER', 'BUSY', 'UNREACHABLE', 'ANSWERED', 'CALLBACK_REQUESTED', 'OPENED', 'MESSAGE_SENT'][Math.floor(rnd() * 9)];
          lines.push({ at, result });
          const want = verdictOf(lines, since, tz, rules);
          const got = moduleVerdict(lines, since, tz, rules);
          compared++;
          if (JSON.stringify(want) !== JSON.stringify(got)) failures.push(JSON.stringify({ tz, seed, run, n, rules, lines, want, got }));
          // invariants of the rule, asserted on the oracle's own answer
          const times = want.countedTimes;
          if (want.nextDue !== null && times.length > 0) expect(want.nextDue).toBeGreaterThan(times[times.length - 1]);
          if (times.length >= 5) expect(want.days).toBeGreaterThanOrEqual(2);
          if ((times.length === 1 || times.length === 2) && want.nextDue !== null) {
            const raw = times[times.length - 1] + (times.length === 1 ? 30 * 60_000 : 2 * HOUR);
            const due = localOf(want.nextDue, tz);
            expect(want.nextDue).toBeGreaterThanOrEqual(raw); // never earlier than the elapsed gap
            expect(rest).not.toContain(due.wd); // a working day
            expect(due.hhmm >= win.start && due.hhmm < win.end).toBe(true); // inside work time, the end exclusive
            if (want.nextDue !== raw) expect(due.hhmm).toBe(win.start); // moved: it is exactly a start of work
            expect(want.nextDue).toBeLessThan(raw + 24 * (rest.length + 2) * HOUR);
          }
          if (times.length === 3 && want.nextDue !== null) {
            const [t1, t3] = [times[0], times[2]];
            const due = localOf(want.nextDue, tz);
            expect(want.nextDue).toBeGreaterThanOrEqual(t3 + 8 * HOUR); // at least 8 elapsed hours
            expect(due.hhmm).toBe(morningOf(win)); // C2: the morning anchor
            expect(rest).not.toContain(due.wd);
            expect(due.date).not.toBe(localOf(t1, tz).date); // never on the first attempt's local date
            expect(want.nextDue).toBeLessThan(t3 + (8 + 24 * (2 + rest.length)) * HOUR);
          }
          if (times.length === 4 && want.nextDue !== null) {
            const t4 = times[3];
            const due = localOf(want.nextDue, tz);
            expect(want.nextDue).toBeGreaterThanOrEqual(t4 + 3 * HOUR); // at least 3 elapsed hours
            expect(due.hhmm >= win.start && due.hhmm < win.end).toBe(true); // ruling 16: #5 is inside the country's work hours, the end exclusive
            expect(rest).not.toContain(due.wd);
            expect(want.nextDue).toBeLessThan(t4 + (50 + 24 * rest.length) * HOUR);
          }
          // the next press lands early, on time, or late: a few minutes to a day and a half later
          const due = want.nextDue;
          const pick = rnd();
          at = due !== null && pick < 0.25 ? due - 1 : due !== null && pick < 0.5 ? due : due !== null && pick < 0.65 ? due + 1 : at + Math.floor((1 + rnd() * 2160) * 60_000);
        }
      }
    }
    expect(failures.slice(0, 3)).toEqual([]);
    expect(compared).toBeGreaterThan(7_000);
  }, 300_000);
});

describe('ruling 16 (15/11 22:30): #5 lands inside the country’s work hours', () => {
  const AMMAN = 'Asia/Amman';
  // Amman is UTC+3 all year: a local clock is the UTC hour minus three. 15/11/2026 is a Sunday.
  const amman = (d: number, h: number, mi = 0, s = 0, ms = 0) => Date.UTC(2026, 10, d, h - 3, mi, s, ms);
  const rulesOf = (rest: number[], rowStart: string, rowEnd: string): Rules => ({ name: `${rowStart}-${rowEnd} rest ${rest.join(',')}`, rest, rowStart, rowEnd });
  const JORDAN = RULESETS[1];

  /** The module's #5 due after a fourth press at `t4`: the first three counted lines are placed earlier, by hand (only the fourth press decides #5). */
  function moduleFifth(t4: number, tz: string, rules: Rules): number {
    const state: CadenceState = { counted: [new Date(t4 - 10 * HOUR), new Date(t4 - 9 * HOUR), new Date(t4 - 8 * HOUR)], days: 2, dueAt: null };
    const cal: CadenceCal = { since: new Date(SINCE_FAR), timeZone: tz, restDays: rules.rest, workHoursStart: rules.rowStart, workHoursEnd: rules.rowEnd };
    const r = cadenceStep(state, new Date(t4), cal);
    expect(r.counted).toBe(true);
    return r.next.dueAt!.getTime();
  }
  const oracleFifth = (t4: number, tz: string, rules: Rules): number => dueOracle([t4 - 10 * HOUR, t4 - 9 * HOUR, t4 - 8 * HOUR, t4], tz, rules);

  // UPDATED 2026-11-18 (C2): the cap is 19:30 — Syria 19:30 (was 18:00), the evening window 19:30 (was its start 19:00), the fallback 19:30; Jordan, 09-12, 08:15-16:45 and the short window unchanged.
  it('the anchor: Syria 19:30, Jordan 16:00, a 09-12 day 11:00, a short window starts at its start, an evening window 19:30', () => {
    expect(anchorOf(windowOf(SYRIA))).toBe('19:30');
    expect(anchorOf(windowOf(JORDAN))).toBe('16:00');
    expect(anchorOf({ start: '09:00', end: '12:00' })).toBe('11:00');
    expect(anchorOf({ start: '08:15', end: '16:45' })).toBe('15:45');
    expect(anchorOf({ start: '09:00', end: '09:45' })).toBe('09:00'); // end − 1 h is 08:45, before the start
    expect(anchorOf({ start: '19:00', end: '23:00' })).toBe('19:30'); // 19:30 is inside
    expect(anchorOf({ start: '20:00', end: '23:00' })).toBe('20:00'); // 19:30 is before the start
    expect(anchorOf(windowOf(rulesOf([], 'garbage', '25:61')))).toBe('19:30'); // the fallback 10:00-22:00
    // and the morning anchor (C2): 11:00 clamped into [start, end − 1 h]
    expect(morningOf(windowOf(SYRIA))).toBe('11:00');
    expect(morningOf(windowOf(JORDAN))).toBe('11:00');
    expect(morningOf({ start: '12:30', end: '20:15' })).toBe('12:30');
    expect(morningOf({ start: '09:00', end: '11:30' })).toBe('10:30');
    expect(morningOf({ start: '09:00', end: '09:45' })).toBe('09:00');
  });

  it('Syria (10-22, no rest day): #5 at 19:30 (C2) — and at 3 h after a late #4, and tomorrow when the floor reaches the end', () => {
    for (const [t4, want] of [[amman(16, 10), amman(16, 19, 30)], [amman(16, 18), amman(16, 21)], [amman(16, 17, 30), amman(16, 20, 30)], [amman(16, 19), amman(17, 19, 30)], [amman(16, 16, 30), amman(16, 19, 30)]]) {
      expect(moduleFifth(t4, AMMAN, SYRIA)).toBe(want);
      expect(oracleFifth(t4, AMMAN, SYRIA)).toBe(want);
    }
  });

  it('Jordan (09-17, Friday and Saturday off): #5 is 16:00 — Sunday 09:00 → Sunday 16:00; Thursday 16:30 → Sunday 16:00; Sunday 15:30 (the 3 h floor 18:30 is past the end) → Monday 16:00', () => {
    for (const [t4, want] of [
      [amman(22, 9), amman(22, 16)],
      [amman(19, 16, 30), amman(22, 16)],
      [amman(22, 15, 30), amman(23, 16)],
      [amman(22, 13), amman(22, 16)], // the 3 h floor is exactly the anchor: 16:00
      [amman(22, 13, 0, 0, 1), amman(22, 16, 0, 0, 1)], // a millisecond later the floor binds, and 16:00:00.001 is still inside
      [amman(22, 13, 59, 59, 999), amman(22, 16, 59, 59, 999)], // the floor, a millisecond before the end
      [amman(22, 14), amman(23, 16)], // the floor is 17:00 exactly = the end (exclusive): outside, so Monday's anchor
      [amman(19, 9), amman(19, 16)], // a Thursday 09:00: Thursday 16:00 (Friday and Saturday are not in the way)
    ] as Array<[number, number]>) {
      expect(moduleFifth(t4, AMMAN, JORDAN), new Date(t4).toISOString()).toBe(want);
      expect(oracleFifth(t4, AMMAN, JORDAN), new Date(t4).toISOString()).toBe(want);
    }
  });

  it('a 09-12 day: the anchor is 11:00; #4 at 09:00 makes #4 + 3 h = 12:00 = the end (exclusive), so #5 is the next work day’s 11:00', () => {
    const nine = rulesOf([5], '09:00', '12:00'); // only Friday off
    for (const [t4, want] of [
      [amman(22, 9), amman(23, 11)], // Sunday 09:00 → Monday 11:00
      [amman(22, 8, 59, 59, 999), amman(22, 11, 59, 59, 999)], // the floor is a millisecond inside: the due is the floor itself
      [amman(22, 8), amman(22, 11)], // floor 11:00 = the anchor
      [amman(19, 9), amman(21, 11)], // Thursday 09:00: the floor 12:00 is the end → Friday is off → Saturday (a work day here) 11:00
      [amman(22, 11, 30), amman(23, 11)], // pressed after the anchor: tomorrow's
    ] as Array<[number, number]>) {
      expect(moduleFifth(t4, AMMAN, nine), new Date(t4).toISOString()).toBe(want);
      expect(oracleFifth(t4, AMMAN, nine), new Date(t4).toISOString()).toBe(want);
    }
  });

  it('a window under an hour and an evening window: the anchor is the start of work, and the floor that falls outside moves #5 to the next work day’s start', () => {
    const short = rulesOf([], '09:00', '09:45');
    expect(moduleFifth(amman(16, 8), AMMAN, short)).toBe(amman(17, 9)); // floor 11:00 is past the end; the first anchor after it is tomorrow's
    expect(moduleFifth(amman(16, 5), AMMAN, short)).toBe(amman(16, 9)); // E = 09:00 today, the floor (08:00) is before it
    expect(oracleFifth(amman(16, 8), AMMAN, short)).toBe(amman(17, 9));
    // C2: the evening window 19-23 now anchors at 19:30 (inside it); one that starts at 20:00 anchors at its start
    const evening = rulesOf([6], '19:00', '23:00');
    expect(moduleFifth(amman(19, 10), AMMAN, evening)).toBe(amman(19, 19, 30)); // Thursday 10:00 → Thursday 19:30
    expect(moduleFifth(amman(19, 20), AMMAN, evening)).toBe(amman(20, 19, 30)); // Thursday 20:00, pressed after the anchor: Friday 19:30 (Friday is a work day here, only Saturday is off)
    expect(oracleFifth(amman(19, 20), AMMAN, evening)).toBe(amman(20, 19, 30));
    expect(moduleFifth(amman(20, 20), AMMAN, evening)).toBe(amman(22, 19, 30)); // Friday 20:00 → Saturday is off → Sunday 19:30
    const late = rulesOf([6], '20:00', '23:00');
    expect(moduleFifth(amman(19, 10), AMMAN, late)).toBe(amman(19, 20)); // the anchor is the start: 19:30 is before it
    expect(oracleFifth(amman(19, 10), AMMAN, late)).toBe(amman(19, 20));
  });

  it('a country with no readable hours keeps the fallbacks: 19:30 (C2)', () => {
    const none = rulesOf([], 'x', 'y');
    expect(moduleFifth(amman(16, 10), AMMAN, none)).toBe(amman(16, 19, 30));
    expect(oracleFifth(amman(16, 10), AMMAN, none)).toBe(amman(16, 19, 30));
  });

  it('PROPERTY: for every window and every rest set that leaves a work day, #5 is inside [start, end) on a work day, never within 3 h of #4, and the oracle and the module agree — four zones, a grid of #4 presses', () => {
    const windows: Array<[string, string]> = [['09:00', '10:00'], ['09:00', '12:00'], ['09:00', '17:00'], ['10:00', '22:00'], ['00:00', '23:45'], ['08:15', '16:45'], ['19:00', '23:00'], ['00:00', '01:00'], ['09:00', '09:45'], ['22:00', '23:45']];
    const restSets: number[][] = [[], [5], [5, 6], [0, 6], [0, 1, 2, 3, 4, 5]];
    const zones = ['Asia/Amman', 'Europe/Berlin', 'America/New_York', 'Pacific/Auckland'];
    const dates = ['2026-11-18', '2026-10-25', '2026-11-01', '2026-04-05'];
    const failures: string[] = [];
    let checked = 0;
    for (const [rowStart, rowEnd] of windows) {
      for (const rest of restSets) {
        const rules = rulesOf(rest, rowStart, rowEnd);
        for (const tz of zones) {
          for (const date of dates) {
            const midnight = instantOf(tz, date, '00:00') ?? instantOf(tz, date, '01:00')!;
            for (let k = 0; k < 66; k++) {
              const t4 = midnight + k * 40 * 60_000 + (k % 7) * 9_000 + (k % 11) * 13; // odd seconds and milliseconds on top
              const due = moduleFifth(t4, tz, rules);
              const l = localOf(due, tz);
              checked++;
              const ok = !rest.includes(l.wd) && l.hhmm >= rowStart && l.hhmm < rowEnd && due >= t4 + 3 * HOUR && due > t4 && due === oracleFifth(t4, tz, rules);
              if (!ok) failures.push(JSON.stringify({ tz, date, rowStart, rowEnd, rest, t4: new Date(t4).toISOString(), due: new Date(due).toISOString(), local: l }));
            }
          }
        }
      }
    }
    expect(failures.slice(0, 3)).toEqual([]);
    expect(checked).toBeGreaterThan(30_000);
  }, 300_000);
});

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
