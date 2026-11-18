import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cadenceEveningAnchor, cadenceMorningAnchor, cadencePress, cadenceState, cadenceStep, cadenceWorkWindow, type CadenceCal, type CadenceFact } from './no-answer-cadence';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * REQUEST C2 — THE DIFFERENTIAL: THE NEW ENGINE AGAINST WHAT `osm/main` ANSWERED (DoD 2)
 *
 * `no-answer-cadence.main-golden.json` was written by `scripts/cadence-main-golden.ts` from the module as it was on `osm/main` before C2 (441b15c0) — the recipe is in the
 * script. Two tables:
 *   A · the due after the k-th counted press, for k = 1…4, at 08:59 · 09:00 · 10:59 · 11:00 · 16:00 · 18:00 · 19:30, over Syria's row (09:00-17:00), a 10:00-22:00 row, Jordan
 *       (09:00-17:00, Friday and Saturday off) and a DST zone (Berlin, both 2026 change weekends). EQUAL EVERYWHERE except the cells the two anchors change — listed below
 *       by name, with the reason — and in those cells the new due is the new anchor (or the floor).
 *   B · whole histories the door wrote BEFORE C2 (on time · an early press before each on-time one · late), each line carrying the due the door stored. Replayed by the new
 *       code: the order's state is BYTE-FOR-BYTE main's, and every press keeps its verdict (counted or not, closes or not, the attempt number) — decision 3, «history keeps
 *       its verdicts». Only the due a NEW counted #3 or #4 would write moves, and only where the anchors moved.
 * ═══════════════════════════════════════════════════════════════════════
 */

interface CalIn { name: string; timeZone: string; restDays: number[]; workHoursStart: string | null; workHoursEnd: string | null }
interface Step { cal: string; date: string; clock: string; k: number; prior: string[]; at: string; counted: boolean; dueAt: string | null; days: number }
interface Line { createdAt: string; result: string; attemptNumber: number; nextFollowUpAt: string | null }
interface Press { at: string; counted: boolean; dueAt: string | null; closes: boolean; attempt: number; stateDue: string | null }
interface History { cal: string; date: string; start: string; pattern: string; lines: Line[]; presses: Press[]; state: { counted: string[]; days: number; dueAt: string | null } }
const golden = JSON.parse(readFileSync(join(process.cwd(), 'src/lib/no-answer-cadence.main-golden.json'), 'utf8')) as { since: string; cals: CalIn[]; steps: Step[]; histories: History[] };

const calOf = (name: string): CadenceCal => {
  const c = golden.cals.find((x) => x.name === name)!;
  return { since: new Date(golden.since), timeZone: c.timeZone, restDays: c.restDays, workHoursStart: c.workHoursStart, workHoursEnd: c.workHoursEnd };
};
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const facts = (lines: Line[], withDue = true): CadenceFact[] =>
  lines.map((l) => ({ createdAt: new Date(l.createdAt), result: l.result, attemptNumber: l.attemptNumber, ...(withDue ? { nextFollowUpAt: l.nextFollowUpAt ? new Date(l.nextFollowUpAt) : null } : {}) }));

/** main's #5 anchor: min(18:00, end − 1 h), never before the start. */
const oldEvening = (w: { start: string; end: string }) => {
  const m = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  const t = Math.max(m(w.start), Math.min(18 * 60, m(w.end) - 60));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
/**
 * WHERE THE ANCHORS MOVED, by calendar and by the press that sets the due (k = the counted presses including the one deciding):
 *   k = 3 → #4's due: main = the start of work, C2 = the morning anchor;  k = 4 → #5's due: main = min(18:00, end − 1 h), C2 = min(19:30, end − 1 h).
 */
const anchorMoved = (calName: string, k: number): string | null => {
  const c = calOf(calName);
  const w = cadenceWorkWindow(c.workHoursStart, c.workHoursEnd);
  if (k === 3 && cadenceMorningAnchor(w) !== w.start) return `#4 moved from the start of work (${w.start}) to the morning anchor (${cadenceMorningAnchor(w)})`;
  if (k === 4 && cadenceEveningAnchor(w) !== oldEvening(w)) return `#5 moved from ${oldEvening(w)} to the evening anchor (${cadenceEveningAnchor(w)})`;
  return null;
};

describe('A · the due after each press, over the grid — equal to main except the named anchor cells', () => {
  it('the golden grid is the one the brief asks for (4 calendars, the seven clocks, k = 1…4) and was written by main', () => {
    expect(golden.cals.map((c) => c.name)).toHaveLength(4);
    expect(new Set(golden.steps.map((s) => s.clock))).toEqual(new Set(['08:59', '09:00', '10:59', '11:00', '16:00', '18:00', '19:30']));
    expect(golden.steps.length).toBe(280);
  });

  it('counted and days are equal in EVERY cell; the due is equal in every cell the anchors do not reach', () => {
    const mismatches: string[] = [];
    for (const s of golden.steps) {
      const r = cadenceStep({ counted: s.prior.map((p) => new Date(p)), days: 0, dueAt: null }, new Date(s.at), calOf(s.cal));
      if (r.counted !== s.counted || r.next.days !== s.days) mismatches.push(`verdict ${s.cal} ${s.date} ${s.clock} k=${s.k}`);
      if (iso(r.next.dueAt) !== s.dueAt && !anchorMoved(s.cal, s.k)) mismatches.push(`due ${s.cal} ${s.date} ${s.clock} k=${s.k}: main ${s.dueAt} now ${iso(r.next.dueAt)}`);
    }
    expect(mismatches).toEqual([]);
  });

  it('THE CELLS THAT MOVED, by name and reason — exactly these calendars and presses, and nowhere else', () => {
    const moved = new Map<string, string>();
    for (const s of golden.steps) {
      const r = cadenceStep({ counted: s.prior.map((p) => new Date(p)), days: 0, dueAt: null }, new Date(s.at), calOf(s.cal));
      if (iso(r.next.dueAt) !== s.dueAt) moved.set(`${s.cal} · k=${s.k}`, anchorMoved(s.cal, s.k)!);
    }
    expect(Object.fromEntries([...moved].sort())).toEqual({
      'Jordan 09:00-17:00, Friday and Saturday off · k=3': '#4 moved from the start of work (09:00) to the morning anchor (11:00)',
      'Syria row 09:00-17:00, no rest day · k=3': '#4 moved from the start of work (09:00) to the morning anchor (11:00)',
      'a 10:00-22:00 row, no rest day · k=3': '#4 moved from the start of work (10:00) to the morning anchor (11:00)',
      'a 10:00-22:00 row, no rest day · k=4': '#5 moved from 18:00 to the evening anchor (19:30)',
      'a DST zone (Berlin) 10:00-22:00 · k=3': '#4 moved from the start of work (10:00) to the morning anchor (11:00)',
      'a DST zone (Berlin) 10:00-22:00 · k=4': '#5 moved from 18:00 to the evening anchor (19:30)',
    });
    // The two rows that end at 17:00 keep #5 at 16:00 (an hour before the end is earlier than both caps): no k=4 cell of theirs moved.
    expect([...moved.keys()].filter((k) => k.endsWith('k=4') && k.includes('17:00'))).toEqual([]);
  });

  it('in a moved cell the new due is ON the new anchor, or on the floor (8 h after #3 / 3 h after #4)', () => {
    const fmt = (tz: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    for (const s of golden.steps) {
      const c = calOf(s.cal);
      const r = cadenceStep({ counted: s.prior.map((p) => new Date(p)), days: 0, dueAt: null }, new Date(s.at), c);
      if (iso(r.next.dueAt) === s.dueAt) continue;
      const w = cadenceWorkWindow(c.workHoursStart, c.workHoursEnd);
      const local = fmt(c.timeZone).format(r.next.dueAt!);
      const floor = new Date(s.at).getTime() + (s.k === 3 ? 8 : 3) * 3_600_000;
      expect(local === (s.k === 3 ? cadenceMorningAnchor(w) : cadenceEveningAnchor(w)) || r.next.dueAt!.getTime() === floor, `${s.cal} ${s.date} ${s.clock} k=${s.k} → ${local}`).toBe(true);
    }
  });
});

describe('B · histories written before C2 keep their verdicts (decision 3)', () => {
  it('120 histories, on time · early · late, over the four calendars', () => {
    expect(golden.histories).toHaveLength(120);
    expect(golden.histories.some((h) => h.presses.some((p) => !p.counted))).toBe(true);
    expect(golden.histories.some((h) => h.presses.some((p) => p.closes))).toBe(true);
  });

  it('the state of every history, replayed by the new code with the dues the lines stored, is byte-for-byte main\'s', () => {
    for (const h of golden.histories) {
      const s = cadenceState(facts(h.lines), calOf(h.cal));
      expect(JSON.stringify({ counted: s.counted.map(iso), days: s.days, dueAt: iso(s.dueAt) }), `${h.cal} ${h.date} ${h.start} ${h.pattern}`).toBe(JSON.stringify(h.state));
    }
  });

  it('every press keeps its verdict — counted, the attempt, the close — and the due it set is main\'s except where a counted #3/#4 meets a moved anchor', () => {
    const wrong: string[] = [];
    for (const h of golden.histories) {
      h.presses.forEach((p, i) => {
        const r = cadencePress(facts(h.lines.slice(0, i)), { at: new Date(p.at), result: 'NO_ANSWER' }, calOf(h.cal));
        const tag = `${h.cal} ${h.date} ${h.start} ${h.pattern} press ${i + 1}`;
        if (r.counted !== p.counted || r.closes !== p.closes || r.next.counted.length !== p.attempt) wrong.push(`verdict ${tag}`);
        if (iso(r.dueAt) !== p.dueAt && !(p.counted && anchorMoved(h.cal, p.attempt))) wrong.push(`due ${tag}: main ${p.dueAt} now ${iso(r.dueAt)}`);
      });
    }
    expect(wrong).toEqual([]);
  });

  it('NEGATIVE: without the stored dues (recomputed instead of stored) the new anchors WOULD change verdicts — the stored due is what keeps them', () => {
    let changed = 0;
    for (const h of golden.histories) {
      const s = cadenceState(facts(h.lines, false), calOf(h.cal));
      if (JSON.stringify({ counted: s.counted.map(iso), days: s.days, dueAt: iso(s.dueAt) }) !== JSON.stringify(h.state)) changed++;
    }
    expect(changed).toBeGreaterThan(10);
  });

  it('an order with a due stored under 09:00 that is pressed before 11:00 still counts at 09:00 (the old press keeps its old due — the edge case of the brief)', () => {
    // Jordan, #3 pressed under main at Sunday 15:30 → main stored #4's due at Monday 09:00. A press Monday 09:30 counts (stored due), though C2 would compute 11:00.
    const cal: CadenceCal = { since: new Date('2026-01-01T00:00:00Z'), timeZone: 'Asia/Amman', restDays: [5, 6], workHoursStart: '09:00', workHoursEnd: '17:00' };
    const at = (d: number, h: number, m = 0) => new Date(Date.UTC(2026, 10, d, h - 3, m));
    const lines: CadenceFact[] = [
      { createdAt: at(15, 13), result: 'NO_ANSWER', attemptNumber: 1, nextFollowUpAt: at(15, 13, 30) },
      { createdAt: at(15, 13, 30), result: 'NO_ANSWER', attemptNumber: 2, nextFollowUpAt: at(15, 15, 30) },
      { createdAt: at(15, 15, 30), result: 'NO_ANSWER', attemptNumber: 3, nextFollowUpAt: at(16, 9) },
    ];
    expect(cadencePress(lines, { at: at(16, 9, 30), result: 'NO_ANSWER' }, cal).counted).toBe(true);
    // the same lines as a reader that did not select the stored due: computed under C2 → 11:00 → early
    expect(cadencePress(lines.map(({ nextFollowUpAt: _n, ...l }) => l), { at: at(16, 9, 30), result: 'NO_ANSWER' }, cal).counted).toBe(false);
  });
});
