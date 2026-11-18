/**
 * THE DIFFERENTIAL'S GOLDEN FILE — what `no-answer-cadence.ts` answered BEFORE request C2 (18/11), over a fixed grid, so the new code can be compared with it cell by cell
 * (`src/lib/the-one-engine-equals-main.test.ts`).
 *
 * Recipe (run once, from the worktree root; the copy sits beside the module so its relative imports resolve, and is deleted after):
 *
 *   git show <main-sha>:src/lib/no-answer-cadence.ts > src/lib/no-answer-cadence.main-copy.ts
 *   npx tsx scripts/cadence-main-golden.ts ./src/lib/no-answer-cadence.main-copy.ts src/lib/no-answer-cadence.main-golden.json
 *   rm src/lib/no-answer-cadence.main-copy.ts
 *
 * Pure: it reads no database and no clock; every instant is written out. The grid itself is in the JSON, so the test replays exactly these inputs.
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

type Iso = string;
interface CalIn { name: string; timeZone: string; restDays: number[]; workHoursStart: string | null; workHoursEnd: string | null }

const SINCE: Iso = '2026-01-01T00:00:00.000Z';
const CALS: CalIn[] = [
  { name: 'Syria row 09:00-17:00, no rest day', timeZone: 'Asia/Damascus', restDays: [], workHoursStart: '09:00', workHoursEnd: '17:00' },
  { name: 'a 10:00-22:00 row, no rest day', timeZone: 'Asia/Damascus', restDays: [], workHoursStart: '10:00', workHoursEnd: '22:00' },
  { name: 'Jordan 09:00-17:00, Friday and Saturday off', timeZone: 'Asia/Amman', restDays: [5, 6], workHoursStart: '09:00', workHoursEnd: '17:00' },
  { name: 'a DST zone (Berlin) 10:00-22:00', timeZone: 'Europe/Berlin', restDays: [], workHoursStart: '10:00', workHoursEnd: '22:00' },
];
const DATES: Record<string, string[]> = {
  'Asia/Damascus': ['2026-11-15', '2026-11-19'],
  'Asia/Amman': ['2026-11-15', '2026-11-19'],
  'Europe/Berlin': ['2026-03-28', '2026-03-29', '2026-10-24', '2026-10-25'],
};
const CLOCKS = ['08:59', '09:00', '10:59', '11:00', '16:00', '18:00', '19:30'];
const H = 3_600_000;

/** The instant a local wall clock reads `hhmm` on `date` in `tz` — by search over the offset, independent of the module. */
function localInstant(tz: string, date: string, hhmm: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  for (let off = -14 * 60; off <= 14 * 60; off += 15) {
    const t = Date.UTC(y, m - 1, d, hh, mm) - off * 60_000;
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    if (`${p.year}-${p.month}-${p.day}` === date && `${p.hour}:${p.minute}` === hhmm) return new Date(t);
  }
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - 2 * H); // a wall time in a DST gap: any fixed instant near it (both sides replay the same one)
}

async function main() {
  const [modPath, out] = process.argv.slice(2);
  const mod = await import(pathToFileURL(resolve(modPath)).href);
  const calOf = (c: CalIn) => ({ since: new Date(SINCE), timeZone: c.timeZone, restDays: c.restDays, workHoursStart: c.workHoursStart, workHoursEnd: c.workHoursEnd });
  const iso = (d: Date | null) => (d ? d.toISOString() : null);

  // A — the due after the k-th counted press, at every clock of the grid (a hand-built state, so each step is asked alone).
  const steps: unknown[] = [];
  for (const c of CALS) {
    for (const date of DATES[c.timeZone]) {
      for (const clock of CLOCKS) {
        const at = localInstant(c.timeZone, date, clock);
        for (let k = 1; k <= 4; k++) {
          const prior = [26, 25.5, 23.5].slice(0, k - 1).map((h) => new Date(at.getTime() - h * H));
          const state = { counted: prior, days: 0, dueAt: null };
          const r = mod.cadenceStep(state, at, calOf(c));
          steps.push({ cal: c.name, date, clock, k, prior: prior.map(iso), at: iso(at), counted: r.counted, dueAt: iso(r.next.dueAt), days: r.next.days });
        }
      }
    }
  }

  // B — whole histories written by the door BEFORE C2: each press asked through `cadencePress` with the lines before it, the line stored as the door stores it
  // (`nextFollowUpAt` = the due when counted, null otherwise). Patterns: on time; an early press before each on-time one; late presses.
  const histories: unknown[] = [];
  for (const c of CALS) {
    for (const date of DATES[c.timeZone]) {
      for (const start of ['09:00', '13:00', '16:30', '21:50']) {
        for (const pattern of ['on-time', 'early-then-on-time', 'late'] as const) {
          const lines: Array<{ createdAt: Iso; result: string; attemptNumber: number; nextFollowUpAt: Iso | null }> = [];
          const presses: unknown[] = [];
          let at = localInstant(c.timeZone, date, start);
          for (let n = 0; n < 8 && presses.length < 8; n++) {
            const stored = lines.map((l) => ({ ...l, createdAt: new Date(l.createdAt), nextFollowUpAt: l.nextFollowUpAt ? new Date(l.nextFollowUpAt) : null }));
            const r = mod.cadencePress(stored, { at, result: 'NO_ANSWER' }, calOf(c));
            lines.push({ createdAt: iso(at)!, result: 'NO_ANSWER', attemptNumber: lines.length + 1, nextFollowUpAt: r.counted ? iso(r.dueAt) : null });
            presses.push({ at: iso(at), counted: r.counted, dueAt: iso(r.dueAt), closes: r.closes, attempt: r.next.counted.length, stateDue: iso(r.next.dueAt) });
            if (r.closes) break;
            const due: Date | null = r.next.dueAt;
            if (!due) break;
            if (pattern === 'early-then-on-time' && r.counted) at = new Date(due.getTime() - 1);
            else if (pattern === 'late') at = new Date(due.getTime() + 5 * H);
            else at = due;
          }
          const finalState = mod.cadenceState(lines.map((l) => ({ ...l, createdAt: new Date(l.createdAt), nextFollowUpAt: l.nextFollowUpAt ? new Date(l.nextFollowUpAt) : null })), calOf(c));
          histories.push({ cal: c.name, date, start, pattern, lines, presses, state: { counted: finalState.counted.map(iso), days: finalState.days, dueAt: iso(finalState.dueAt) } });
        }
      }
    }
  }

  // One record per line: small, and a diff of the file shows the cell that moved.
  const rows = (xs: unknown[]) => xs.map((x) => '  ' + JSON.stringify(x)).join(',\n');
  writeFileSync(out, `{"since":${JSON.stringify(SINCE)},"cals":${JSON.stringify(CALS)},\n"steps":[\n${rows(steps)}\n],\n"histories":[\n${rows(histories)}\n]}\n`);
  console.log(`steps ${steps.length} · histories ${histories.length}`);
}

void main();
