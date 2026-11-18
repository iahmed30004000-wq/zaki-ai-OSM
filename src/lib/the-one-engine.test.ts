import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * REQUEST C2 — «قاعدة وحدة، بطاقة وحدة، عدّاد واحد»: THE ONE ENGINE UNDER THE PLAN (the owner's plan of 17/11, §3.1)
 *
 * One test for every line of the rule and of its table, with «إثبات المكالمات وجدول المحاولات» ON — each says where osm/main answered otherwise:
 *   1. hand 3 / idle 20 whatever «أولوية الطابور» says              (main: 5 / 30 with that key off)
 *   2. the pull order (unchanged by C2: the priority key's steps)     — pinned by the queue's own tests; here: «fresh» is the rule set's 15
 *   3. «لا يرد» opens after «اتصال» + 30 s                              — the proof's seconds are the rule set's
 *   4. +30 min → +2 h → next day 11:00 → next day 19:30                (main: the start of work, and 18:00)
 *   5. the fifth over two days closes «لا يرد — 5 محاولات»
 *   6. a customer's date at most twice; «لا يرد» is never a postponement — the door's test `the-plan-holds-the-postponements.test.ts`
 *   7. one counter «محاولة N من 5» — on the timeline too                (main: «محاولة اتصال <line number>»)
 * And: the rounds' releases do not run under the plan (job + pull), with the plan off they do (main); no screen text prints «جولة» under the plan.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { plan, rounds, returns, priority, asked } = vi.hoisted(() => ({
  plan: { since: null as Date | null },
  rounds: { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } },
  returns: { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } },
  priority: { enabled: false },
  asked: { priority: 0 },
}));
vi.mock('./db', () => ({ db: {} }));
vi.mock('./no-answer-cadence-switch', () => ({ cadenceSince: async () => plan.since }));
vi.mock('./no-answer-rounds-switch', () => ({ roundsSwitch: async () => rounds.value }));
vi.mock('./no-answer-returns-switch', () => ({ returnsSwitch: async () => returns.value }));
vi.mock('./queue-priority-switch', () => ({ queuePrioritySwitch: async () => ((asked.priority += 1), { enabled: priority.enabled, enabledAt: null }) }));

import { CONFIRMATION_RULE } from './confirmation-rule';
import { CADENCE_FLOORS_MS, CADENCE_GAPS_MS, CADENCE_LIMIT, CADENCE_MIN_DAYS, CADENCE_START, cadenceCloses, cadenceStep, type CadenceCal } from './no-answer-cadence';
import { POSTPONE_MAX_TIMES, QUEUE_PRIORITY, QUEUE_PRIORITY_LIMITS } from './queue-priority';
import { MIN_CALL_MS } from './call-proof-words';
import { RETURNS_MODE, releaseNoAnswerRounds, returnsLimits } from './confirmation-queue';
import { returnsMode } from './no-answer-returns';
import { ROUND_RELEASE_REASON, workClock } from './no-answer-rounds';
import { attemptWords } from './attempt-words';
import { orderTimeline } from './order-timeline';
import { ruleSummaryLines } from './confirmation-rule-summary';
import { QUEUE_MODES_DEFAULTS } from './queue-modes-settings';
import { forgetCallProofSwitch } from './call-proof-switch';

const ON_AT = new Date('2026-11-01T06:00:00.000Z');
const ON = { enabled: true, enabledAt: ON_AT };
const OFF = { enabled: false, enabledAt: null };
// Damascus is UTC+3 all year: a local clock is the UTC hour minus three. 15/11/2026 is a Sunday.
const dam = (d: number, h: number, mi = 0) => new Date(Date.UTC(2026, 10, d, h - 3, mi));
const cal = (start: string, end: string): CadenceCal => ({ since: ON_AT, timeZone: 'Asia/Damascus', restDays: [], workHoursStart: start, workHoursEnd: end });

beforeEach(() => {
  plan.since = ON_AT;
  rounds.value = OFF;
  returns.value = OFF;
  priority.enabled = false;
  asked.priority = 0;
});

describe('the rule set — ONE object, and every older constant is read from it', () => {
  it('holds the numbers of §3.1\'s table', () => {
    expect(CONFIRMATION_RULE).toEqual({
      attempts: 5, minDays: 2, proofSeconds: 30, hand: 3, idleMinutes: 20, morning: '11:00', evening: '19:30', freshMinutes: 15,
      gapsMinutes: { afterFirst: 30, afterSecond: 120 }, floorsHours: { beforeFourth: 8, beforeFifth: 3 }, postponeMax: 2,
    });
  });

  it('the older names are the rule set\'s figures — no caller changed its import', () => {
    expect(CADENCE_LIMIT).toBe(CONFIRMATION_RULE.attempts);
    expect(CADENCE_MIN_DAYS).toBe(CONFIRMATION_RULE.minDays);
    expect(CADENCE_GAPS_MS).toEqual({ afterFirst: CONFIRMATION_RULE.gapsMinutes.afterFirst * 60_000, afterSecond: CONFIRMATION_RULE.gapsMinutes.afterSecond * 60_000 });
    expect(CADENCE_FLOORS_MS).toEqual({ beforeFourth: CONFIRMATION_RULE.floorsHours.beforeFourth * 3_600_000, beforeFifth: CONFIRMATION_RULE.floorsHours.beforeFifth * 3_600_000 });
    expect(QUEUE_PRIORITY_LIMITS).toEqual({ handLimit: CONFIRMATION_RULE.hand, idleBusinessMinutes: CONFIRMATION_RULE.idleMinutes });
    expect(POSTPONE_MAX_TIMES).toBe(CONFIRMATION_RULE.postponeMax);
    expect(QUEUE_PRIORITY.freshMinutes).toBe(CONFIRMATION_RULE.freshMinutes);
    expect(MIN_CALL_MS).toEqual({ NO_ANSWER: 30_000, BUSY: 30_000, UNREACHABLE: 30_000 });
    expect(MIN_CALL_MS.NO_ANSWER).toBe(CONFIRMATION_RULE.proofSeconds * 1000);
  });

  it('the rule set imports nothing (the desk\'s bundle reads it through `call-proof-words.ts`) and no figure of it is typed again in the files that re-export it', () => {
    const rule = readFileSync(join(process.cwd(), 'src/lib/confirmation-rule.ts'), 'utf8');
    expect(rule).not.toMatch(/^\s*import /m);
    const words = readFileSync(join(process.cwd(), 'src/lib/call-proof-words.ts'), 'utf8');
    expect(words).not.toContain('30_000');
    const pq = readFileSync(join(process.cwd(), 'src/lib/queue-priority.ts'), 'utf8');
    expect(pq).not.toMatch(/handLimit: 3|idleBusinessMinutes: 20|POSTPONE_MAX_TIMES = 2|freshMinutes: 15/);
  });
});

describe('line 1 — hand 3 / idle 20 under the plan, WHATEVER «أولوية الطابور» says', () => {
  it('the plan on, the priority OFF → 3 and 20 (main: 5 and 30) — and the priority key is not asked', async () => {
    expect(await returnsLimits({} as never, 'c1')).toEqual({ handLimit: 3, idleBusinessMinutes: 20 });
    expect(asked.priority).toBe(0);
  });

  it('the plan on, the priority on → 3 and 20', async () => {
    priority.enabled = true;
    expect(await returnsLimits({} as never, 'c1')).toEqual({ handLimit: 3, idleBusinessMinutes: 20 });
  });

  it('NEGATIVE / the way back: the plan OFF → main\'s answer, the priority key decides (5 and 30 off, 3 and 20 on)', async () => {
    plan.since = null;
    expect(await returnsLimits({} as never, 'c1')).toEqual(RETURNS_MODE);
    priority.enabled = true;
    expect(await returnsLimits({} as never, 'c1')).toEqual(QUEUE_PRIORITY_LIMITS);
    expect(asked.priority).toBe(2);
  });
});

describe('line 3 — «لا يرد» after «اتصال» + 30 seconds', () => {
  it('the proof\'s wait is the rule set\'s 30 seconds for every no-answer result', () => {
    for (const r of ['NO_ANSWER', 'BUSY', 'UNREACHABLE'] as const) expect(MIN_CALL_MS[r] / 1000).toBe(30);
  });
});

describe('line 4 — after «لا يرد»: +30 min → +2 h → next day 11:00 → next day 19:30', () => {
  const step = (s: typeof CADENCE_START, at: Date, c: CadenceCal) => {
    const r = cadenceStep(s, at, c);
    expect(r.counted).toBe(true);
    return r.next;
  };

  it('a 10:00-22:00 row: #1 Sunday 13:00 → #2 13:30 → #3 15:30 → #4 MONDAY 11:00 → #5 MONDAY 19:30 (main: Monday 10:00 and 18:00)', () => {
    const c = cal('10:00', '22:00');
    let s = step(CADENCE_START, dam(15, 13), c);
    expect(s.dueAt).toEqual(dam(15, 13, 30));
    s = step(s, dam(15, 13, 30), c);
    expect(s.dueAt).toEqual(dam(15, 15, 30));
    s = step(s, dam(15, 15, 30), c);
    expect(s.dueAt).toEqual(dam(16, 11));
    expect(s.dueAt).not.toEqual(dam(16, 10));
    s = step(s, dam(16, 11), c);
    expect(s.dueAt).toEqual(dam(16, 19, 30));
    expect(s.dueAt).not.toEqual(dam(16, 18));
    s = step(s, dam(16, 19, 30), c);
    expect(s.counted).toHaveLength(5);
    expect(cadenceCloses(s)).toBe(true);
  });

  it('the live Syria row (09:00-17:00): 11:00 and 16:00 — the evening anchor is an hour before the end (the window is the owner\'s press)', () => {
    const c = cal('09:00', '17:00');
    let s = step(CADENCE_START, dam(15, 13), c);
    s = step(s, s.dueAt!, c);
    s = step(s, s.dueAt!, c);
    expect(s.dueAt).toEqual(dam(16, 11));
    s = step(s, s.dueAt!, c);
    expect(s.dueAt).toEqual(dam(16, 16));
  });

  it('a press at the old 10:00 is EARLY now (kept, not counted); at 11:00 it counts', () => {
    const c = cal('10:00', '22:00');
    let s = step(CADENCE_START, dam(15, 13), c);
    s = step(s, s.dueAt!, c);
    s = step(s, s.dueAt!, c);
    expect(cadenceStep(s, dam(16, 10), c).counted).toBe(false);
    expect(cadenceStep(s, dam(16, 11), c).counted).toBe(true);
  });
});

describe('line 5 — the fifth over two days closes', () => {
  it('five counted over two local days close; four never do', () => {
    const c = cal('10:00', '22:00');
    let s = CADENCE_START;
    for (const at of [dam(15, 13), dam(15, 13, 30), dam(15, 15, 30), dam(16, 11)]) s = cadenceStep(s, at, c).next;
    expect(cadenceCloses(s)).toBe(false);
    s = cadenceStep(s, dam(16, 19, 30), c).next;
    expect(cadenceCloses(s)).toBe(true);
  });
});

describe('line 7 — one counter, «محاولة N من 5»', () => {
  it('the words are the one function\'s', () => {
    expect(attemptWords(2, CADENCE_LIMIT)).toBe('محاولة 2 من 5');
  });
});

/** A transaction that records every order read; nothing is found, so nothing is written. */
function recordingTx() {
  const reads: Array<Record<string, unknown>> = [];
  const tx = {
    order: { findMany: vi.fn(async (a: { where: Record<string, unknown> }) => (reads.push(a.where), [])), updateMany: vi.fn() },
    orderClaimHistory: { create: vi.fn() },
    notification: { createMany: vi.fn() },
  };
  return { tx, reads };
}
const roundsScans = (reads: Array<Record<string, unknown>>) => reads.filter((w) => JSON.stringify(w).includes('"contactAttempts":{"some":{}}')).length;
const SCOPE = { companyId: 'c1', storeId: 's1' };
const JO = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' };
const NOW = new Date('2026-11-16T14:00:00.000Z');

describe('the rounds\' releases (12 h · date + 3 h · re-pull 90 min) do not run under the plan', () => {
  it('rounds stored ON + the plan ON, the pull\'s call (the plan\'s mode handed in): the rounds\' scan never runs — only the plan\'s idle release', async () => {
    rounds.value = ON;
    const { tx, reads } = recordingTx();
    const mode = returnsMode(NOW, workClock(JO), 20, ON_AT);
    await releaseNoAnswerRounds(tx as never, SCOPE, JO, NOW, { rounds: rounds.value, returns: mode });
    expect(roundsScans(reads)).toBe(0);
    expect(reads.length).toBe(1); // the idle release's one read
  });

  it('rounds stored ON + the plan ON, a caller that handed no mode: the plan is read, and still no rounds\' scan', async () => {
    rounds.value = ON;
    const { tx, reads } = recordingTx();
    await releaseNoAnswerRounds(tx as never, SCOPE, JO, NOW, { rounds: rounds.value });
    expect(roundsScans(reads)).toBe(0);
  });

  it('NEGATIVE / the way back: the plan OFF, rounds ON → the rounds\' scan runs, as on main', async () => {
    plan.since = null;
    rounds.value = ON;
    const { tx, reads } = recordingTx();
    await releaseNoAnswerRounds(tx as never, SCOPE, JO, NOW, { rounds: rounds.value });
    expect(roundsScans(reads)).toBe(1);
  });

  it('NEGATIVE: the plan OFF, rounds + returns ON (the legacy mode handed in) → the rounds\' scan AND the idle release, as on main', async () => {
    plan.since = null;
    rounds.value = ON;
    const { tx, reads } = recordingTx();
    await releaseNoAnswerRounds(tx as never, SCOPE, JO, NOW, { rounds: rounds.value, returns: returnsMode(NOW, workClock(JO), 30) });
    expect(roundsScans(reads)).toBe(1);
    expect(reads.length).toBe(2);
  });
});

describe('the timeline prints the ONE counter under the plan (decision 9)', () => {
  const AT = (h: number, mi = 0) => new Date(Date.UTC(2026, 10, 15, h - 3, mi)); // Amman, Sunday
  function timelineTx(planOn: boolean, claims: unknown[] = []) {
    plan.since = planOn ? ON_AT : null;
    const contacts = [
      { id: 'c1', companyId: 'co-tl', orderId: 'o1', createdAt: AT(12, 59), result: 'OPENED', contactMethod: 'PHONE', attemptNumber: 1, employeeId: 'u1', note: null, nextFollowUpAt: null },
      { id: 'c2', companyId: 'co-tl', orderId: 'o1', createdAt: AT(13), result: 'NO_ANSWER', contactMethod: 'PHONE', attemptNumber: 2, employeeId: 'u1', note: null, nextFollowUpAt: AT(13, 30) },
      { id: 'c3', companyId: 'co-tl', orderId: 'o1', createdAt: AT(13, 10), result: 'NO_ANSWER', contactMethod: 'PHONE', attemptNumber: 3, employeeId: 'u1', note: null, nextFollowUpAt: null },
      { id: 'c4', companyId: 'co-tl', orderId: 'o1', createdAt: AT(13, 30), result: 'BUSY', contactMethod: 'PHONE', attemptNumber: 4, employeeId: 'u1', note: null, nextFollowUpAt: AT(15, 30) },
    ];
    const none = { findMany: vi.fn(async () => []) };
    return {
      orderStatusLog: none, callLog: none, callHelperReading: none, deliveryAttempt: none, orderNote: none, orderActivity: none, orderChangeRequest: none, orderIssue: none,
      orderClaimHistory: { findMany: vi.fn(async () => claims) },
      orderContactAttempt: { findMany: vi.fn(async () => contacts) },
      user: { findMany: vi.fn(async () => [{ id: 'u1', name: 'موظفة' }]) },
      order: { findUnique: vi.fn(async () => ({ country: { timezone: 'Asia/Amman', weekendDays: [5, 6], workHoursStart: '09:00', workHoursEnd: '17:00' } })) },
      company: { findUnique: vi.fn(async () => ({ settings: JSON.stringify(planOn ? { callProofAndCadence: { enabled: true, enabledAt: '2026-11-01T00:00:00.000Z' } } : {}) })) },
    };
  }
  beforeEach(() => forgetCallProofSwitch());

  it('the plan ON: a counted «لا يرد» reads «محاولة N من 5», an early one «ضغطة ما انحسبت محاولة», another result «اتصال» — no running line number', async () => {
    const titles = (await orderTimeline(timelineTx(true) as never, 'o1')).filter((e) => e.kind === 'CONTACT').map((e) => e.title);
    expect(titles).toEqual([
      'اتصال عبر هاتف — ' + titles[0].split(' — ')[1],
      'محاولة 1 من 5 عبر هاتف — لم يرد',
      'ضغطة ما انحسبت محاولة عبر هاتف — لم يرد',
      `محاولة 2 من 5 عبر هاتف — ${titles[3].split(' — ')[1]}`,
    ]);
    expect(titles.join(' ')).not.toMatch(/محاولة اتصال \d/);
  });

  it('NEGATIVE / the way back: the plan OFF → main\'s «محاولة اتصال N» for every line', async () => {
    const titles = (await orderTimeline(timelineTx(false) as never, 'o1')).filter((e) => e.kind === 'CONTACT').map((e) => e.title);
    expect(titles.map((t) => t.split(' عبر ')[0])).toEqual(['محاولة اتصال 1', 'محاولة اتصال 2', 'محاولة اتصال 3', 'محاولة اتصال 4']);
  });

  it('an OLD rounds release on the timeline does not print «جولة» under the plan — and prints main\'s words with the plan off', async () => {
    const claim = { id: 'h1', orderId: 'o1', userId: 'u1', action: 'RELEASED', reason: ROUND_RELEASE_REASON, metadata: JSON.stringify({ automatic: true, holder: 'u1' }), createdAt: AT(14) };
    const on = (await orderTimeline(timelineTx(true, [claim]) as never, 'o1')).find((e) => e.kind === 'OWNERSHIP')!;
    forgetCallProofSwitch();
    const off = (await orderTimeline(timelineTx(false, [claim]) as never, 'o1')).find((e) => e.kind === 'OWNERSHIP')!;
    expect(off.detail).toContain('جولة');
    expect(on.detail).not.toContain('جولة');
    expect(on.detail).toContain('تحرير تلقائي');
  });
});

describe('DoD 6 — under the plan no screen text this request writes prints «جولة»; the counter is «محاولة N من 5»', () => {
  it('the rule box, with every legacy switch stored ON beside the plan', () => {
    const lines = ruleSummaryLines({ proofOn: true, priorityOn: true, roundsOn: true, returnsOn: true, hand: 3, idleMinutes: 20, workStart: '09:00', workEnd: '17:00', modes: QUEUE_MODES_DEFAULTS });
    expect(lines.join(' ')).not.toContain('جولة');
    expect(lines.join(' ')).toContain('محاولة 2 من 5');
  });

  it('the screens and cards this request touched carry no «جولة» in their visible text', () => {
    for (const file of ['src/components/screens/ConfirmationRulesScreen.tsx', 'src/components/settings/CallProofCard.tsx', 'src/components/settings/QueuePriorityCard.tsx', 'src/lib/postpone-reasons.ts', 'src/lib/retired-switch.ts']) {
      const code = readFileSync(join(process.cwd(), file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code, file).not.toContain('جولة');
    }
  });
});
