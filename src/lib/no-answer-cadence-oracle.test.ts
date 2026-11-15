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
 *   #3 → walk forward until the LOCAL DATE differs from the third attempt's, then until the local clock reads 09:00;
 *   #4 → walk from the first quarter-hour strictly after the fourth attempt until the local clock reads 18:00;
 *   counting, the early rule, the floor, the days set and the close are its own loop.
 *
 * Two ways of reaching the same instants must agree on every zone, every anchor (each zone's 2026 transition weekend, an ordinary week, a month end, a year end, a leap day),
 * every boundary (00:00:00.000 · 00:00:00.001 · 08:59:59.999 · 09:00 · 17:59:59.999 · 18:00:00.000 · 23:59:59.999 — each one is placed or the test fails, apart from a wall time a DST gap removed) and every press (due − 1 ms, at the due, + 1 ms, + 3 h) — or one of
 * them is wrong. Each mismatch prints the zone, the seed and the sequence.
 * ═══════════════════════════════════════════════════════════════════════
 */

const QUARTER = 15 * 60_000;
const NO_ANSWER_LIKE = ['NO_ANSWER', 'BUSY', 'UNREACHABLE'];

const formatters = new Map<string, Intl.DateTimeFormat>();
const clockCache = new Map<string, { date: string; hhmm: string }>();

/** The local date (`yyyy-mm-dd`) and clock (`hh:mm`) of the quarter-hour that contains `ms`, in `tz` — read from the oracle's own formatter. */
function localOf(ms: number, tz: string): { date: string; hhmm: string } {
  const q = Math.floor(ms / QUARTER);
  const key = `${tz}|${q}`;
  const hit = clockCache.get(key);
  if (hit) return hit;
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    formatters.set(tz, f);
  }
  const parts = Object.fromEntries(f.formatToParts(new Date(q * QUARTER)).map((p) => [p.type, p.value]));
  const out = { date: `${parts.year}-${parts.month}-${parts.day}`, hhmm: `${parts.hour}:${parts.minute}` };
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

/** The oracle's due after `counted` attempts, the last at `at`. */
function dueOracle(counted: number, at: number, tz: string): number {
  if (counted === 1) return at + 30 * 60_000;
  if (counted === 2) return at + 2 * 3_600_000;
  if (counted === 3) {
    const today = localOf(at, tz).date;
    let q = Math.floor(at / QUARTER) * QUARTER;
    while (localOf(q, tz).date === today) q += QUARTER; // the first quarter-hour of the NEXT local date
    while (localOf(q, tz).hhmm !== '09:00') q += QUARTER;
    return q;
  }
  let q = Math.floor(at / QUARTER) * QUARTER + QUARTER; // the first quarter-hour STRICTLY after `at`
  while (localOf(q, tz).hhmm !== '18:00') q += QUARTER;
  return q;
}

interface Line { at: number; result: string }
interface Verdict { counted: boolean; dueAt: number | null; closes: boolean; countedTimes: number[]; days: number; nextDue: number | null }

/** The oracle's own loop: fold the lines in the order given (attempt order), return the verdict of the LAST one. */
function verdictOf(lines: Line[], since: number, tz: string): Verdict {
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
    due = counted.length >= 5 ? null : dueOracle(counted.length, l.at, tz);
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
function moduleVerdict(lines: Line[], since: number, tz: string): Verdict {
  const cal: CadenceCal = { since: new Date(since), timeZone: tz };
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
  { tz: 'Europe/Berlin', anchors: ['2026-03-28', '2026-10-24', '2026-11-30', '2026-12-31'] },
  { tz: 'America/New_York', anchors: ['2026-03-07', '2026-10-31', '2026-12-31'] },
  { tz: 'Asia/Beirut', anchors: ['2026-03-28', '2026-03-29', '2026-10-24', '2026-10-25'] },
  { tz: 'Australia/Lord_Howe', anchors: ['2026-04-04', '2026-10-03'] },
  { tz: 'Pacific/Auckland', anchors: ['2026-04-04', '2026-09-26'] },
  { tz: 'Pacific/Chatham', anchors: ['2026-04-04', '2026-09-26'] },
  { tz: 'Asia/Kathmandu', anchors: ['2026-11-30', '2026-12-31'] },
];
const FIRST_PRESSES: Array<[string, number]> = [
  ['00:00', 0],
  ['00:00', 1],
  ['08:59', 59_999],
  ['09:00', 0],
  ['17:59', 59_999],
  ['18:00', 0],
  ['23:59', 59_999],
];

const SINCE_FAR = Date.UTC(2020, 0, 1);

describe('the oracle itself is sane', () => {
  it('knows the plan on a plain day in Amman (UTC+3)', () => {
    const t1 = Date.UTC(2026, 10, 15, 10, 0); // 13:00 local
    expect(dueOracle(1, t1, 'Asia/Amman')).toBe(t1 + 30 * 60_000);
    expect(new Date(dueOracle(3, Date.UTC(2026, 10, 15, 12, 30), 'Asia/Amman')).toISOString()).toBe('2026-11-16T06:00:00.000Z');
    expect(new Date(dueOracle(4, Date.UTC(2026, 10, 16, 6, 0), 'Asia/Amman')).toISOString()).toBe('2026-11-16T15:00:00.000Z');
    expect(new Date(dueOracle(4, Date.UTC(2026, 10, 16, 15, 0), 'Asia/Amman')).toISOString()).toBe('2026-11-17T15:00:00.000Z');
  });
});

describe('the module and the oracle agree', () => {
  it('on the boundary grid: every zone × anchor × first press, along the on-time path and its side branches', () => {
    const failures: string[] = [];
    // Every boundary that could not be placed — it must be a wall time that does not exist (a DST gap), never a silent hole in the grid.
    const skipped: string[] = [];
    let compared = 0;
    for (const { tz, anchors } of ZONES) {
      for (const anchor of anchors) {
        for (const [hhmm, extra] of FIRST_PRESSES) {
          const base = instantOf(tz, anchor, hhmm);
          if (base === null) {
            skipped.push(`${tz} ${anchor} ${hhmm}`);
            continue;
          }
          const t1 = base + extra;
          const path: Line[] = [{ at: t1, result: 'NO_ANSWER' }];
          for (let step = 0; step < 6; step++) {
            const stateNow = verdictOf(path, SINCE_FAR, tz);
            const check = (candidate: Line[]) => {
              const want = verdictOf(candidate, SINCE_FAR, tz);
              const got = moduleVerdict(candidate, SINCE_FAR, tz);
              compared++;
              if (JSON.stringify(want) !== JSON.stringify(got)) failures.push(JSON.stringify({ tz, anchor, hhmm, extra, step, candidate, want, got }));
            };
            check(path);
            const due = stateNow.nextDue;
            if (due === null) break;
            const dueDate = localOf(due, tz).date;
            const [dy, dm, dd] = dueDate.split('-').map(Number);
            const nextDay = new Date(Date.UTC(dy, dm - 1, dd + 1)).toISOString().slice(0, 10);
            const boundaries: number[] = [due - 1, due, due + 1, due + 3 * 3_600_000];
            for (const [date, clock, add] of [
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
    }
    expect(failures.slice(0, 3)).toEqual([]);
    // The only wall times that do not exist here: midnight of Beirut's 2026-03-29 (the clock jumps 00:00 → 01:00). Anything else skipped is a hole in the grid.
    expect(skipped.filter((s) => !['Asia/Beirut 2026-03-29 00:00', 'Asia/Beirut 2026-03-29 00:01'].includes(s))).toEqual([]);
    expect(compared).toBeGreaterThan(8_000);
  }, 120_000);

  it('on the floor: a line at enabledAt never counts, one millisecond after does, four older lines are invisible', () => {
    const tz = 'Asia/Amman';
    const since = Date.UTC(2026, 10, 15, 7, 0);
    const old: Line[] = [1, 2, 3, 4].map((n) => ({ at: since - n * 3_600_000, result: 'NO_ANSWER' }));
    for (const [at, counts] of [[since, false], [since + 1, true], [since - 1, false]] as const) {
      const lines = [...old, { at, result: 'NO_ANSWER' }];
      const want = verdictOf(lines, since, tz);
      expect(moduleVerdict(lines, since, tz)).toEqual(want);
      expect(want.counted).toBe(counts);
    }
  });

  it.each([11, 22, 33])('on three seeded random generators (seed %i): per press the flag, the due (to the millisecond), the days and the close agree', (seed) => {
    const failures: string[] = [];
    let compared = 0;
    for (const { tz, anchors } of ZONES) {
      for (let run = 0; run < 60; run++) {
        const rnd = mulberry32(seed * 1_000_003 + run * 7919 + tz.length);
        const anchor = anchors[Math.floor(rnd() * anchors.length)];
        const [y, m, d] = anchor.split('-').map(Number);
        let at = Date.UTC(y, m - 1, d, Math.floor(rnd() * 24), Math.floor(rnd() * 60), Math.floor(rnd() * 60), Math.floor(rnd() * 1000)) - 6 * 3_600_000;
        const lines: Line[] = [];
        const since = at - 24 * 3_600_000;
        for (let n = 0; n < 14; n++) {
          const result = ['NO_ANSWER', 'NO_ANSWER', 'NO_ANSWER', 'BUSY', 'UNREACHABLE', 'ANSWERED', 'CALLBACK_REQUESTED', 'OPENED', 'MESSAGE_SENT'][Math.floor(rnd() * 9)];
          lines.push({ at, result });
          const want = verdictOf(lines, since, tz);
          const got = moduleVerdict(lines, since, tz);
          compared++;
          if (JSON.stringify(want) !== JSON.stringify(got)) failures.push(JSON.stringify({ tz, seed, run, n, lines, want, got }));
          // invariants of the rule, asserted on the oracle's own answer
          if (want.nextDue !== null && want.countedTimes.length > 0) expect(want.nextDue).toBeGreaterThan(want.countedTimes[want.countedTimes.length - 1]);
          if (want.countedTimes.length >= 5) expect(want.days).toBeGreaterThanOrEqual(2);
          if (want.countedTimes.length === 3 && want.nextDue !== null) {
            const t3 = want.countedTimes[2];
            const [y3, m3, d3] = localOf(t3, tz).date.split('-').map(Number);
            const nextDate = new Date(Date.UTC(y3, m3 - 1, d3 + 1)).toISOString().slice(0, 10);
            expect(localOf(want.nextDue, tz)).toEqual({ date: nextDate, hhmm: '09:00' });
          }
          if (want.countedTimes.length === 4 && want.nextDue !== null) {
            expect(localOf(want.nextDue, tz).hhmm).toBe('18:00');
            expect(want.nextDue).toBeLessThan(want.countedTimes[3] + 26 * 3_600_000);
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
  }, 120_000);
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
