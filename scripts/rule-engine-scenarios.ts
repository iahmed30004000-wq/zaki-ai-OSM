/**
 * THE SCENARIOS OF REQUEST Q3b'S DIFFERENTIAL — one runner, two callers:
 *   · `scripts/rule-engine-main-golden.ts` runs it over the modules as they were on `osm/main` before Q3b and writes the answers down (the golden file);
 *   · `src/lib/the-rule-engine-equals-main.test.ts` runs it over today's modules — once with NO rule handed in, once with the DEFAULT rule handed in the way the doors
 *     hand it (`cadenceCalOf(…, rule)`, `proofSeconds`, `limit`, `freshMinutes`, `RuleFacts.rule`) — and asks for the golden, record for record.
 *
 * Pure and seeded (mulberry32): no database, no clock. Every scenario is regenerated from its seed, so the golden holds only answers.
 * The modules are passed in loosely typed on purpose: the main copies do not have the new parameters, and an extra argument is ignored there.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Mod = any;

export interface ScenarioModules {
  cadence: Mod;
  proof: Mod;
  summary: Mod;
  priority: Mod;
}

/** The default rule as the doors hand it, or undefined for «nothing handed in». */
export interface HandedRule {
  steps: readonly unknown[];
  minDays: number;
  proofSeconds: number;
  freshMinutes: number;
  morning: string;
  evening: string;
  hand: number;
  idleMinutes: number;
  postponeMax: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CALS = [
  { timeZone: 'Asia/Damascus', restDays: [] as number[], workHoursStart: '09:00', workHoursEnd: '17:00' },
  { timeZone: 'Asia/Damascus', restDays: [5], workHoursStart: '10:00', workHoursEnd: '22:00' },
  { timeZone: 'Asia/Amman', restDays: [5, 6], workHoursStart: '09:00', workHoursEnd: '17:00' },
  { timeZone: 'Europe/Berlin', restDays: [0], workHoursStart: '10:00', workHoursEnd: '22:00' },
  { timeZone: 'Asia/Damascus', restDays: [] as number[], workHoursStart: null, workHoursEnd: null },
  { timeZone: 'Asia/Amman', restDays: [5], workHoursStart: '12:00', workHoursEnd: '12:40' },
];
const SINCE = new Date('2026-01-01T00:00:00.000Z');
const RESULTS = ['NO_ANSWER', 'NO_ANSWER', 'NO_ANSWER', 'BUSY', 'UNREACHABLE', 'ANSWERED', 'OPENED', 'CALLBACK_REQUESTED'];
const NO_ANSWER = new Set(['NO_ANSWER', 'BUSY', 'UNREACHABLE']);
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function runScenarios(m: ScenarioModules, opts: { n: number; seed: number; rule?: HandedRule }) {
  const r = mulberry32(opts.seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const rule = opts.rule;
  const limit = rule ? rule.steps.length + 1 : undefined;
  const calOf = (c: (typeof CALS)[number], since = SINCE) => {
    const base = { since, timeZone: c.timeZone, restDays: c.restDays, workHoursStart: c.workHoursStart, workHoursEnd: c.workHoursEnd };
    return rule ? m.cadence.cadenceCalOf(since, { timezone: c.timeZone, weekendDays: c.restDays, workHoursStart: c.workHoursStart, workHoursEnd: c.workHoursEnd }, rule) : base;
  };
  const randomInstant = () => new Date(Date.UTC(2026, 1 + Math.floor(r() * 9), 1 + Math.floor(r() * 28), Math.floor(r() * 24), Math.floor(r() * 60), Math.floor(r() * 60), Math.floor(r() * 1000)));

  // ── A: door-written histories, each press asked the way the door asks it ──
  const histories: unknown[] = [];
  for (let s = 0; s < opts.n; s++) {
    const c = pick(CALS);
    const cal = calOf(c);
    const lines: { createdAt: Date; result: string; attemptNumber: number; nextFollowUpAt: Date | null }[] = [];
    const presses: unknown[] = [];
    let at = randomInstant();
    let due: Date | null = null;
    const count = 1 + Math.floor(r() * 10);
    for (let i = 0; i < count; i++) {
      const result = pick(RESULTS);
      if (NO_ANSWER.has(result)) {
        const out = m.cadence.cadencePress(lines, { at, result }, cal);
        lines.push({ createdAt: at, result, attemptNumber: lines.length + 1, nextFollowUpAt: out.counted ? out.dueAt : null });
        const released = r() < 0.5;
        const words = m.cadence.cadencePressWords({
          counted: out.counted, closed: out.closes, released, attempt: out.next.counted.length, dueAt: out.next.dueAt, now: at, timeZone: c.timeZone,
          ...(limit ? { limit } : {}),
        });
        presses.push({ at: iso(at), counted: out.counted, dueAt: iso(out.dueAt), closes: out.closes, attempt: out.next.counted.length, days: out.next.days, stateDue: iso(out.next.dueAt), words });
        if (out.next.dueAt) due = out.next.dueAt;
      } else {
        lines.push({ createdAt: at, result, attemptNumber: lines.length + 1, nextFollowUpAt: r() < 0.3 ? new Date(at.getTime() + 3_600_000) : null });
      }
      const how = r();
      at = due && how < 0.35 ? due : due && how < 0.5 ? new Date(due.getTime() - 1) : due && how < 0.6 ? new Date(due.getTime() + Math.floor(r() * 9) * 3_600_000) : new Date(at.getTime() + Math.floor(r() * 3000) * 60_000 + Math.floor(r() * 60_000));
    }
    const now = new Date(at.getTime() + Math.floor(r() * 600) * 60_000);
    const desk = m.cadence.cadenceDesk(lines, cal, now);
    const card = limit ? m.cadence.cadenceCardWords(desk, now, c.timeZone, limit) : m.cadence.cadenceCardWords(desk, now, c.timeZone);
    const numbers = [...m.cadence.cadenceLineNumbers(lines, cal).values()];
    const st = m.cadence.cadenceState(lines, cal);
    histories.push({
      presses,
      desk: { counted: desk.counted, dueAt: iso(desk.dueAt), due: desk.due, waiting: desk.waiting, closesOnNext: desk.closesOnNext },
      card,
      numbers,
      state: { counted: st.counted.map(iso), days: st.days, dueAt: iso(st.dueAt), closes: rule ? m.cadence.cadenceCloses(st, rule) : m.cadence.cadenceCloses(st) },
    });
  }

  // ── B: lines the door never wrote (any due stored, any order, garbage) — the fold must still answer as main ──
  const folds: unknown[] = [];
  for (let s = 0; s < opts.n; s++) {
    const c = pick(CALS);
    const cal = calOf(c, r() < 0.2 ? randomInstant() : SINCE);
    const facts = Array.from({ length: Math.floor(r() * 9) }, () => {
      const createdAt = randomInstant();
      const d = r();
      return {
        createdAt,
        result: pick(RESULTS),
        attemptNumber: r() < 0.2 ? null : Math.floor(r() * 9),
        nextFollowUpAt: d < 0.3 ? null : d < 0.4 ? 'garbage' : d < 0.5 ? undefined : new Date(createdAt.getTime() + Math.floor(r() * 4000) * 60_000),
      };
    });
    const st = m.cadence.cadenceState(facts, cal);
    folds.push({ counted: st.counted.map(iso), days: st.days, dueAt: iso(st.dueAt), numbers: [...m.cadence.cadenceLineNumbers(facts, cal).values()] });
  }

  // ── C: one step on a hand-built state, k = 1…6 counted before (past the limit too) ──
  const steps: unknown[] = [];
  for (let s = 0; s < opts.n; s++) {
    const c = pick(CALS);
    const at = randomInstant();
    const k = Math.floor(r() * 6);
    const counted = Array.from({ length: k }, (_, i) => new Date(at.getTime() - (k - i) * Math.floor(1 + r() * 20) * 3_600_000));
    const dueAt = r() < 0.5 ? null : new Date(at.getTime() + Math.floor((r() - 0.5) * 600) * 60_000);
    const out = m.cadence.cadenceStep({ counted, days: 0, dueAt }, at, calOf(c));
    steps.push({ counted: out.counted, n: out.next.counted.length, days: out.next.days, dueAt: iso(out.next.dueAt) });
  }

  // ── D: the proof — every guarded and unguarded result, presses of two people, a claim or none ──
  const proofs: unknown[] = [];
  for (let s = 0; s < opts.n; s++) {
    const now = randomInstant();
    const attempts = Array.from({ length: Math.floor(r() * 6) }, (_, i) => ({
      createdAt: new Date(now.getTime() - Math.floor(r() * 120_000)),
      result: pick(['OPENED', 'OPENED', 'NO_ANSWER', 'ANSWERED', 'MESSAGE_SENT', 'BUSY']),
      employeeId: pick(['e1', 'e2']),
      attemptNumber: i + 1,
    }));
    const claimedAt = r() < 0.3 ? null : new Date(now.getTime() - Math.floor(r() * 150_000));
    const result = pick(['NO_ANSWER', 'BUSY', 'UNREACHABLE', 'ANSWERED', 'WRONG_NUMBER']);
    const handed = rule ? { proofSeconds: rule.proofSeconds } : {};
    proofs.push({
      verdict: m.proof.callProofVerdict({ attempts, employeeId: 'e1', claimedAt, result, now, ...handed }),
      state: m.proof.callProofState({ attempts, employeeId: 'e1', claimedAt, now, ...handed }),
      paired: m.proof.pairedLineVerdict({ attempts, employeeId: 'e1', claimedAt, result, now }),
    });
  }

  // ── E: «القاعدة بالمختصر» over every switch combination and four windows ──
  const summaries: unknown[] = [];
  for (const window of [['09:00', '17:00'], ['10:00', '22:00'], [null, null], ['12:00', '12:40']] as const) {
    for (let bits = 0; bits < 16; bits++) {
      for (const [hand, idleMinutes] of [[3, 20], [5, 30]]) {
        const facts = {
          proofOn: !!(bits & 1), priorityOn: !!(bits & 2), roundsOn: !!(bits & 4), returnsOn: !!(bits & 8), hand, idleMinutes,
          workStart: window[0], workEnd: window[1], modes: { nightFrom: 9, nightTo: 11, peakFrom: 21, peakTo: 24 },
          ...(rule ? { rule } : {}),
        };
        summaries.push(m.summary.ruleSummaryLines(facts));
      }
    }
  }

  // ── F: «fresh» ──
  const fresh: unknown[] = [];
  for (let s = 0; s < 50; s++) {
    const now = randomInstant();
    fresh.push(iso(rule ? m.priority.freshSince(now, rule.freshMinutes) : m.priority.freshSince(now)));
  }

  return { histories, folds, steps, proofs, summaries, fresh };
}
