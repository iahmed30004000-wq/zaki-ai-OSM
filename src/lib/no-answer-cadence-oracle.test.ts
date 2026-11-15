import { describe, expect, it } from 'vitest';
import { cadencePress, type CadenceCal } from './no-answer-cadence';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE PLAN, WRITTEN A SECOND TIME THE OTHER WAY ROUND.
 *
 * `no-answer-cadence.ts` places the due instants with `zonedParts` / `zonedTimeToInstant` (arithmetic on the local calendar). This oracle NEVER calls them, nor `dueAfter`, nor
 * `cadenceStep`. It owns a formatter and WALKS: every supported zone's offset is a multiple of 15 minutes, so a grid of quarter-hours placed in UTC is a grid of quarter-hours
 * of the local clock too, and
 *
 *   #1 → +30 min and #2 → +2 h are millisecond additions;
 *   #3 → walk forward from the instant 8 h (elapsed) later: the first quarter-hour that is at or after it (exactly 8 h counts), reads 10:00 on the local clock, falls on a day that is
 *        not a rest day (the formatter's own weekday) and is not the local DATE of the first attempt (the independent form of the first-day guard);
 *   #4 → walk from the first quarter-hour strictly after the fourth attempt until the local clock reads 18:00 on a day that is not a rest day; never earlier than the fourth + 3 h;
 *   counting, the early rule, the floor, the days set and the close are its own loop.
 *
 * Two ways of reaching the same instants must agree on every zone, every anchor (each zone's 2026 transition weekend INCLUDING its 25-hour day, an ordinary week, a month end, a year
 * end, a leap day), every boundary (00:00:00.000 · 00:00:00.001 · 09:59:59.999 · 10:00 · 14:59:59.999 · 15:00 · 17:59:59.999 · 18:00:00.000 · 23:29:59.999 · 23:30 · 23:59:59.999 — each one is
 * placed or the test fails, apart from a wall time a DST gap removed; the three at 23:29–23:30 put the third attempt on the 8-hour cliff at 02:00) and every press (due − 1 ms, at the
 * due, + 1 ms, + 3 h), under four weeks — no rest day, Friday, Friday + Saturday, Sunday — or one of them is wrong. Each mismatch prints the zone, the seed and the sequence.
 * ═══════════════════════════════════════════════════════════════════════
 */

const QUARTER = 15 * 60_000;
const HOUR = 3_600_000;
const NO_ANSWER_LIKE = ['NO_ANSWER', 'BUSY', 'UNREACHABLE'];
/** #4's clock and #5's anchor, spelled again here on purpose (the oracle imports no constant of the module). */
const START = '10:00';
const EVENING = '18:00';
/** A walk of sixteen days of quarter-hours: far more than any due needs (the longest wait is a week of rest days). */
const MAX_WALK = 16 * 96;

/** The week a country keeps: the local weekdays (0 = Sunday) no #4 / #5 due lands on. */
interface Rules { rest: number[] }
const RULESETS: Rules[] = [{ rest: [] }, { rest: [5] }, { rest: [5, 6] }, { rest: [0] }];

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
  const counted = times.length;
  const at = times[counted - 1];
  if (counted === 1) return at + 30 * 60_000;
  if (counted === 2) return at + 2 * HOUR;
  if (counted === 3) {
    const floor = at + 8 * HOUR; // ELAPSED hours: «>=» below is the «exactly 8 h counts» rule
    const firstDate = localOf(times[0], tz).date;
    let q = Math.floor(floor / QUARTER) * QUARTER;
    for (let n = 0; n < MAX_WALK; n++, q += QUARTER) {
      if (q < floor) continue;
      const l = localOf(q, tz);
      // the last clause is the independent first-day guard: #4 is never on the local date of #1
      if (l.hhmm === START && !rules.rest.includes(l.wd) && l.date !== firstDate) return q;
    }
    throw new Error(`oracle: no #4 within sixteen days (${tz})`);
  }
  let q = Math.floor(at / QUARTER) * QUARTER + QUARTER; // the first quarter-hour STRICTLY after `at`
  for (let n = 0; n < MAX_WALK; n++, q += QUARTER) {
    const l = localOf(q, tz);
    if (l.hhmm === EVENING && !rules.rest.includes(l.wd)) return Math.max(q, at + 3 * HOUR);
  }
  throw new Error(`oracle: no #5 within sixteen days (${tz})`);
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

/** What the real module says about the same last line. */
function moduleVerdict(lines: Line[], since: number, tz: string, rules: Rules): Verdict {
  const cal: CadenceCal = { since: new Date(since), timeZone: tz, restDays: rules.rest };
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
  // 2026-10-25 (Berlin), 2026-11-01 (New York) and 2026-04-05 (Auckland, Chatham, Lord Howe) are the days the clocks go BACK: without them the first-day guard is never reached.
  { tz: 'Europe/Berlin', anchors: ['2026-03-28', '2026-10-24', '2026-10-25', '2026-11-30', '2026-12-31'] },
  { tz: 'America/New_York', anchors: ['2026-03-07', '2026-10-31', '2026-11-01', '2026-12-31'] },
  { tz: 'Asia/Beirut', anchors: ['2026-03-28', '2026-03-29', '2026-10-24', '2026-10-25'] },
  { tz: 'Australia/Lord_Howe', anchors: ['2026-04-04', '2026-04-05', '2026-10-03'] },
  { tz: 'Pacific/Auckland', anchors: ['2026-04-04', '2026-04-05', '2026-09-26'] },
  { tz: 'Pacific/Chatham', anchors: ['2026-04-04', '2026-04-05', '2026-09-26'] },
  { tz: 'Asia/Kathmandu', anchors: ['2026-11-30', '2026-12-31'] },
];
const FIRST_PRESSES: Array<[string, number]> = [
  ['00:00', 0],
  ['00:00', 1],
  ['09:59', 59_999],
  ['10:00', 0],
  ['17:59', 59_999],
  ['18:00', 0],
  ['23:29', 59_999], // the third attempt then lands at 01:59:59.999 …
  ['23:30', 0], // … 02:00:00.000 …
  ['23:30', 1], // … 02:00:00.001: either side of the 8-hour cliff
  ['23:59', 59_999],
];
/** Wednesday to Sunday in every zone: the days a Friday / Saturday / Sunday rest set bites on. */
const REST_ANCHORS = ['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'];
const REST_FIRST_PRESSES: Array<[string, number]> = [
  ['00:00', 0],
  ['09:59', 59_999],
  ['10:00', 0],
  ['23:30', 1],
  ['23:59', 59_999],
];

const SINCE_FAR = Date.UTC(2020, 0, 1);

describe('the oracle itself is sane', () => {
  it('knows the plan on a plain day in Amman (UTC+3), with no rest day', () => {
    const none: Rules = { rest: [] };
    const t1 = Date.UTC(2026, 10, 15, 10, 0); // Sunday 13:00 local
    const t2 = t1 + 30 * 60_000;
    const t3 = Date.UTC(2026, 10, 15, 12, 30); // 15:30 local
    expect(dueOracle([t1], 'Asia/Amman', none)).toBe(t1 + 30 * 60_000);
    expect(dueOracle([t1, t2], 'Asia/Amman', none)).toBe(t2 + 2 * HOUR);
    expect(new Date(dueOracle([t1, t2, t3], 'Asia/Amman', none)).toISOString()).toBe('2026-11-16T07:00:00.000Z');
    const t4 = Date.UTC(2026, 10, 16, 7, 0);
    expect(new Date(dueOracle([t1, t2, t3, t4], 'Asia/Amman', none)).toISOString()).toBe('2026-11-16T15:00:00.000Z');
    expect(new Date(dueOracle([t1, t2, t3, Date.UTC(2026, 10, 16, 15, 0)], 'Asia/Amman', none)).toISOString()).toBe('2026-11-17T15:00:00.000Z');
  });

  it('knows the 8-hour cliff, the 3-hour floor, a rest weekend and the first-day guard', () => {
    const none: Rules = { rest: [] };
    const amman = (d: number, h: number, mi = 0) => Date.UTC(2026, 10, d, h - 3, mi); // Amman is UTC+3 all year
    const upTo3 = (t3: number) => [t3 - 150 * 60_000, t3 - 120 * 60_000, t3];
    // 02:00:00.000 → exactly 8 h to 10:00 counts; one millisecond later waits for tomorrow's 10:00
    expect(dueOracle(upTo3(amman(3, 2)), 'Asia/Amman', none)).toBe(amman(3, 10));
    expect(dueOracle(upTo3(amman(3, 2) + 1), 'Asia/Amman', none)).toBe(amman(4, 10));
    // 15:00:00.000 → the 3 h floor equals the anchor; one millisecond later the floor binds
    const t1 = amman(2, 9);
    const four = (t4: number) => [t1, t1 + 30 * 60_000, t1 + 150 * 60_000, t4];
    expect(dueOracle(four(amman(10, 15)), 'Asia/Amman', none)).toBe(amman(10, 18));
    expect(dueOracle(four(amman(10, 15) + 1), 'Asia/Amman', none)).toBe(amman(10, 18) + 1);
    // Thursday 19/11 14:00 with Friday and Saturday off → Sunday 22/11 10:00; Thursday 19:00 → Sunday 18:00
    expect(dueOracle(upTo3(amman(19, 14)), 'Asia/Amman', { rest: [5, 6] })).toBe(amman(22, 10));
    expect(dueOracle([amman(17, 10), amman(17, 10, 30), amman(17, 12, 30), amman(19, 19)], 'Asia/Amman', { rest: [5, 6] })).toBe(amman(22, 18));
    // Berlin, 25/10/2026 (the clocks go back at 03:00 CEST): 00:00 → 00:30 → 02:30 CEST is 10:00 CET on the SAME date at 8 h, so #4 waits for the 26th
    const BER = 'Europe/Berlin';
    const b1 = Date.UTC(2026, 9, 24, 22, 0);
    expect(new Date(dueOracle([b1, b1 + 30 * 60_000, b1 + 150 * 60_000], BER, none)).toISOString()).toBe('2026-10-26T09:00:00.000Z');
  });
});

/** One cell of the boundary grid: every first press × the on-time path and its side branches, for each zone × anchor given. */
function gridRun(cells: Array<{ tz: string; anchor: string }>, presses: Array<[string, number]>, rules: Rules, failures: string[], skipped: string[]): number {
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
        const dueDate = localOf(due, tz).date;
        const [dy, dm, dd] = dueDate.split('-').map(Number);
        const nextDay = new Date(Date.UTC(dy, dm - 1, dd + 1)).toISOString().slice(0, 10);
        const boundaries: number[] = [due - 1, due, due + 1, due + 3 * HOUR];
        for (const [date, clock, add] of [
          [dueDate, '14:59', 59_999], // the 3-hour floor's cliff: 15:00 + 3 h = 18:00
          [dueDate, '15:00', 0],
          [dueDate, '15:00', 1],
          [dueDate, '17:59', 59_999],
          [dueDate, '18:00', 0],
          [dueDate, '23:59', 59_999],
          [nextDay, '00:00', 0],
          [nextDay, '00:01', 0],
        ] as const) {
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
  // The only wall times that do not exist here: midnight of Beirut's 2026-03-29 (the clock jumps 00:00 → 01:00). Anything else skipped is a hole in the grid.
  const GAP_WHITELIST = ['Asia/Beirut 2026-03-29 00:00', 'Asia/Beirut 2026-03-29 00:01'];

  it('on the boundary grid: every zone × anchor × first press, along the on-time path and its side branches, with no rest day', () => {
    const failures: string[] = [];
    // Every boundary that could not be placed — it must be a wall time that does not exist (a DST gap), never a silent hole in the grid.
    const skipped: string[] = [];
    const cells = ZONES.flatMap(({ tz, anchors }) => anchors.map((anchor) => ({ tz, anchor })));
    const compared = gridRun(cells, FIRST_PRESSES, RULESETS[0], failures, skipped);
    expect(failures.slice(0, 3)).toEqual([]);
    expect(skipped.filter((s) => !GAP_WHITELIST.includes(s))).toEqual([]);
    expect(compared).toBeGreaterThan(8_000);
  }, 300_000);

  it.each(RULESETS.slice(1))('on the boundary grid with rest days %j: Wednesday to Sunday in every zone × five first presses, along the on-time path and its side branches', (rules) => {
    const failures: string[] = [];
    const skipped: string[] = [];
    const cells = ZONES.flatMap(({ tz }) => REST_ANCHORS.map((anchor) => ({ tz, anchor })));
    const compared = gridRun(cells, REST_FIRST_PRESSES, rules, failures, skipped);
    expect(failures.slice(0, 3)).toEqual([]);
    expect(skipped.filter((s) => !GAP_WHITELIST.includes(s))).toEqual([]);
    expect(compared).toBeGreaterThan(10_000);
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
          if (times.length === 3 && want.nextDue !== null) {
            const [t1, t3] = [times[0], times[2]];
            const due = localOf(want.nextDue, tz);
            expect(want.nextDue).toBeGreaterThanOrEqual(t3 + 8 * HOUR); // at least 8 elapsed hours
            expect(due.hhmm).toBe(START);
            expect(rules.rest).not.toContain(due.wd);
            expect(due.date).not.toBe(localOf(t1, tz).date); // never on the first attempt's local date
            expect(want.nextDue).toBeLessThan(t3 + (8 + 24 * (2 + rules.rest.length)) * HOUR);
          }
          if (times.length === 4 && want.nextDue !== null) {
            const t4 = times[3];
            const due = localOf(want.nextDue, tz);
            expect(want.nextDue).toBeGreaterThanOrEqual(t4 + 3 * HOUR); // at least 3 elapsed hours
            expect(due.hhmm >= EVENING && due.hhmm < '22:00').toBe(true); // an evening clock (21:00 at the latest, 22:00 as the DST margin)
            expect(rules.rest).not.toContain(due.wd);
            expect(want.nextDue).toBeLessThan(t4 + (26 + 24 * rules.rest.length) * HOUR);
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
