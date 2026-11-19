import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { stripComments } from './guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * REQUEST Q3b — «THE ENGINE READS THE RULE IT IS GIVEN»: WITH AN EDITED RULE THE NEW NUMBERS ACT
 *
 * DEFINITION OF DONE (the row): with no stored document every door answers as before (`the-rule-engine-equals-main.test.ts`); with an edited one the new numbers act —
 * the plan's steps and attempts, the close's days, the proof's seconds, the hand and the idle minutes, «fresh», the postpone cap, the words, «القاعدة بالمختصر».
 * Edge cases held here: an order mid-cycle when the rule changes (its stored dues are not rewritten; the next press is judged by the rule in force; one whose counted
 * presses already reach a LOWERED limit closes on its next press and never by a job), and the rule read once per door — on a warm cache with no statement at all.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { sw } = vi.hoisted(() => ({ sw: { plan: null as Date | null, priority: false, priorityAsked: 0 } }));
vi.mock('./db', () => ({ db: {} }));
vi.mock('./no-answer-cadence-switch', () => ({ cadenceSince: async () => sw.plan }));
vi.mock('./queue-priority-switch', () => ({ queuePrioritySwitch: async () => ((sw.priorityAsked += 1), { enabled: sw.priority, enabledAt: null }) }));
vi.mock('./queue-modes-settings', async (orig) => ({ ...(await orig<object>()), readQueueModes: async () => ({ nightFrom: 9, nightTo: 11, peakFrom: 21, peakTo: 24 }) }));
vi.mock('./queue-priority-share', () => ({ readBacklogShare: async () => ({ result: { share: 0.37 } }), recentPullLanes: async () => [] }));

import {
  CADENCE_RULE_DEFAULT,
  CADENCE_START,
  cadenceCalOf,
  cadenceCardWords,
  cadenceCloses,
  cadenceLimit,
  cadencePress,
  cadencePressWords,
  cadenceState,
  cadenceStep,
  type CadenceFact,
} from './no-answer-cadence';
import {
  CONFIRMATION_RULE_DEFAULT,
  confirmationRuleOnce,
  documentAfterSave,
  readConfirmationRule,
  validateConfirmationRule,
  type ConfirmationRuleNumbers,
} from './confirmation-rule-settings';
import { callProofState, callProofVerdict } from './call-proof';
import { freshSince } from './queue-priority';
import { RETURNS_MODE, priorityPlanFor, returnsLimits } from './confirmation-queue';
import { ruleSummaryLines, type RuleFacts } from './confirmation-rule-summary';
import { orderTimeline } from './order-timeline';

const SINCE = new Date('2026-11-01T00:00:00.000Z');
// Damascus is UTC+3 all year: a local clock is the UTC hour minus three. 16/11/2026 is a Monday.
const dam = (d: number, h: number, mi = 0) => new Date(Date.UTC(2026, 10, d, h - 3, mi));
const COUNTRY = { timezone: 'Asia/Damascus', weekendDays: [] as number[], workHoursStart: '09:00', workHoursEnd: '22:00' };
const rule = (over: Partial<ConfirmationRuleNumbers>): ConfirmationRuleNumbers => ({ ...CONFIRMATION_RULE_DEFAULT, ...over });
const calOf = (r?: ConfirmationRuleNumbers) => cadenceCalOf(SINCE, COUNTRY, r);
const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Press `times` one after the other through the door's own question, storing each line as the door stores it. */
function pressAll(times: Date[], r?: ConfirmationRuleNumbers) {
  const lines: CadenceFact[] = [];
  const out: ReturnType<typeof cadencePress>[] = [];
  for (const at of times) {
    const p = cadencePress(lines, { at, result: 'NO_ANSWER' }, calOf(r));
    lines.push({ createdAt: at, result: 'NO_ANSWER', attemptNumber: lines.length + 1, nextFollowUpAt: p.counted ? p.dueAt : null });
    out.push(p);
  }
  return { lines, out };
}

/** A company's stored document holding `r`, in force since the epoch; the client counts its reads. */
function storedClient(r: ConfirmationRuleNumbers) {
  const doc = documentAfterSave(null, { rule: r, effectiveAt: new Date(0), byUserId: 'u1' }, 0);
  const findUnique = vi.fn(async () => ({ settings: JSON.stringify({ confirmationRule: doc }) }));
  return { client: { company: { findUnique } } as never, findUnique };
}

beforeEach(() => {
  sw.plan = SINCE;
  sw.priority = false;
  sw.priorityAsked = 0;
});

describe('the default rule as the plan reads it is the stored default', () => {
  it('CADENCE_RULE_DEFAULT is CONFIRMATION_RULE_DEFAULT\'s steps, days and clocks — the two can never drift', () => {
    expect(CADENCE_RULE_DEFAULT).toEqual({
      steps: CONFIRMATION_RULE_DEFAULT.steps,
      minDays: CONFIRMATION_RULE_DEFAULT.minDays,
      morning: CONFIRMATION_RULE_DEFAULT.morning,
      evening: CONFIRMATION_RULE_DEFAULT.evening,
    });
    expect(cadenceLimit()).toBe(5);
    expect(cadenceLimit(CONFIRMATION_RULE_DEFAULT)).toBe(5);
  });

  it('a calendar with no rule is main\'s object, key for key (no `rule` key); with one it carries it', () => {
    expect(Object.keys(cadenceCalOf(SINCE, COUNTRY))).not.toContain('rule');
    expect(cadenceCalOf(SINCE, COUNTRY, CONFIRMATION_RULE_DEFAULT).rule).toBe(CONFIRMATION_RULE_DEFAULT);
  });
});

describe('the plan iterates the steps', () => {
  it('FOUR attempts (three steps): the fourth counted press over two days closes; with the default it would not', () => {
    const four = rule({ steps: [{ kind: 'after', minutes: 30 }, { kind: 'anchor', anchor: 'morning', floorHours: 8 }, { kind: 'anchor', anchor: 'evening', floorHours: 3 }] });
    const { out } = pressAll([dam(16, 10), dam(16, 10, 30), dam(17, 11), dam(17, 19, 30)], four);
    expect(out.map((p) => p.counted)).toEqual([true, true, true, true]);
    // #2 after 30 min; #3 at the next morning anchor; #4 at the evening anchor of that day
    expect(out.map((p) => iso(p.dueAt))).toEqual([iso(dam(16, 10, 30)), iso(dam(17, 11)), iso(dam(17, 19, 30)), null]);
    expect(out.map((p) => p.closes)).toEqual([false, false, false, true]);
    expect(pressAll([dam(16, 10), dam(16, 10, 30), dam(17, 11), dam(17, 19, 30)]).out[3].closes).toBe(false);
  });

  it('SIX attempts: the fifth counted press does not close, the sixth does, after its own step', () => {
    const six = rule({ steps: [...CONFIRMATION_RULE_DEFAULT.steps, { kind: 'after', minutes: 60 }] });
    const t = [dam(16, 10), dam(16, 10, 30), dam(16, 12, 30), dam(17, 11), dam(17, 19, 30)];
    const { out } = pressAll([...t, dam(17, 20, 30)], six);
    expect(out[4].closes).toBe(false);
    expect(iso(out[4].dueAt)).toBe(iso(dam(17, 20, 30)));
    expect(out[5].counted).toBe(true);
    expect(out[5].closes).toBe(true);
  });

  it('OTHER ANCHORS: morning 10:00 and evening 18:00 move #4 and #5 to those clocks', () => {
    const other = rule({ morning: '10:00', evening: '18:00' });
    const { out } = pressAll([dam(16, 10), dam(16, 10, 30), dam(16, 12, 30), dam(17, 10)], other);
    expect(iso(out[2].dueAt)).toBe(iso(dam(17, 10)));
    expect(iso(out[3].dueAt)).toBe(iso(dam(17, 18)));
  });

  it('an «after» step brings its due inside work time, as #2 always did (a press at 21:50 + 60 min → the next start)', () => {
    const r = rule({ steps: [{ kind: 'after', minutes: 60 }, { kind: 'after', minutes: 120 }] });
    expect(iso(cadenceStep(CADENCE_START, dam(16, 21, 50), calOf(r)).next.dueAt)).toBe(iso(dam(17, 9)));
  });

  it('minDays 1: three counted presses on ONE day close a three-attempt rule; minDays 2 would not', () => {
    const r1 = rule({ steps: [{ kind: 'after', minutes: 30 }, { kind: 'after', minutes: 30 }], minDays: 1 });
    expect(pressAll([dam(16, 10), dam(16, 10, 30), dam(16, 11)], r1).out[2].closes).toBe(true);
    expect(pressAll([dam(16, 10), dam(16, 10, 30), dam(16, 11)], { ...r1, minDays: 2 }).out[2].closes).toBe(false);
  });

  it('the words count the rule\'s attempts: «المحاولة 2 من 4», the card «محاولة 3 من 4», and «اكتملت المحاولات الـ4»', () => {
    const now = dam(16, 10);
    expect(cadencePressWords({ counted: true, closed: false, released: false, attempt: 2, dueAt: dam(16, 12), now, timeZone: 'Asia/Damascus', limit: 4 })).toContain('المحاولة 2 من 4');
    expect(cadenceCardWords({ counted: 2, due: true, waiting: false, dueAt: null }, now, 'Asia/Damascus', 4)).toBe('لا يرد راجع — محاولة 3 من 4');
    expect(cadencePressWords({ counted: false, closed: false, released: false, attempt: 4, dueAt: null, now, timeZone: 'Asia/Damascus', limit: 4 })).toBe('اكتملت المحاولات الـ4 — الضغطة انسجّلت بس ما انحسبت.');
  });
});

describe('an order mid-cycle when the rule changes', () => {
  const t = [dam(16, 10), dam(16, 10, 30), dam(16, 12, 30), dam(17, 11)];
  it('its stored dues are not rewritten: the fold keeps the due each line STORED under the old rule', () => {
    const { lines } = pressAll(t.slice(0, 2)); // the default rule: #2 stored 10:30 → #3 due 12:30
    const later = rule({ steps: [{ kind: 'after', minutes: 30 }, { kind: 'after', minutes: 300 }, ...CONFIRMATION_RULE_DEFAULT.steps.slice(2)] });
    expect(iso(cadenceState(lines, calOf(later)).dueAt)).toBe(iso(dam(16, 12, 30)));
    // …and the NEXT press is judged by the rule in force: #3 counts at the stored 12:30 and its own due follows the new rule's step 3.
    const p = cadencePress(lines, { at: dam(16, 12, 30), result: 'NO_ANSWER' }, calOf(later));
    expect(p.counted).toBe(true);
    expect(iso(p.dueAt)).toBe(iso(dam(17, 11)));
  });

  it('four counted under the default, the limit LOWERED to four: complete — its next press closes it (a press, never a job)', () => {
    const { lines } = pressAll(t);
    const four = rule({ steps: CONFIRMATION_RULE_DEFAULT.steps.slice(0, 3) });
    const st = cadenceState(lines, calOf(four));
    expect(st.counted).toHaveLength(4);
    expect(cadenceCloses(st, four)).toBe(true);
    const next = cadencePress(lines, { at: dam(17, 12), result: 'NO_ANSWER' }, calOf(four));
    expect(next.counted).toBe(false);
    expect(next.closes).toBe(true);
    // under the default the same order is NOT complete
    expect(cadenceCloses(cadenceState(lines, calOf()))).toBe(false);
  });

  it('no job closes an order or replays a plan: nothing under jobs/ asks the cadence or closes by «لا يرد»', () => {
    const dir = join(process.cwd(), 'src/lib/jobs/definitions');
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/cadencePress|cadenceCloses|cadenceStep|NO_ANSWER_CLOSE|CONTACT_AUTO_CLOSE/);
    }
  });
});

describe('the proof\'s seconds', () => {
  const now = new Date('2026-11-16T10:00:00.000Z');
  const opened = (msAgo: number) => [{ createdAt: new Date(now.getTime() - msAgo), result: 'OPENED', employeeId: 'e1', attemptNumber: 1 }];
  it('proof 45: 44.999 s refused (wait 1), 45 s allowed — and 30 s is no longer enough', () => {
    expect(callProofVerdict({ attempts: opened(44_999), employeeId: 'e1', claimedAt: null, result: 'NO_ANSWER', now, proofSeconds: 45 })).toMatchObject({ ok: false, code: 'TOO_SOON', waitSeconds: 1 });
    expect(callProofVerdict({ attempts: opened(45_000), employeeId: 'e1', claimedAt: null, result: 'BUSY', now, proofSeconds: 45 }).ok).toBe(true);
    expect(callProofVerdict({ attempts: opened(30_000), employeeId: 'e1', claimedAt: null, result: 'UNREACHABLE', now, proofSeconds: 45 }).ok).toBe(false);
    expect(callProofState({ attempts: opened(10_000), employeeId: 'e1', claimedAt: null, now, proofSeconds: 45 })).toEqual({ state: 'WAIT', unlocksAtMs: now.getTime() + 35_000 });
  });
  it('proof 15: 15 s is enough (the default would refuse it)', () => {
    expect(callProofVerdict({ attempts: opened(15_000), employeeId: 'e1', claimedAt: null, result: 'NO_ANSWER', now, proofSeconds: 15 }).ok).toBe(true);
    expect(callProofVerdict({ attempts: opened(15_000), employeeId: 'e1', claimedAt: null, result: 'NO_ANSWER', now }).ok).toBe(false);
  });
});

describe('the hand, the idle minutes and «fresh» come from the rule in force', () => {
  it('HAND 2, idle 40 under the plan — read through the stored document', async () => {
    const { client } = storedClient(rule({ hand: 2, idleMinutes: 40 }));
    expect(await returnsLimits(client, 'co-hand', 1_000)).toEqual({ handLimit: 2, idleBusinessMinutes: 40 });
  });
  it('the priority key alone (plan off) → the rule\'s numbers too; both off → RETURNS_MODE and the rule is never read', async () => {
    sw.plan = null;
    sw.priority = true;
    const a = storedClient(rule({ hand: 7 }));
    expect((await returnsLimits(a.client, 'co-prio', 1_000)).handLimit).toBe(7);
    sw.priority = false;
    const b = storedClient(rule({ hand: 7 }));
    expect(await returnsLimits(b.client, 'co-off', 1_000)).toBe(RETURNS_MODE);
    expect(b.findUnique).not.toHaveBeenCalled();
  });
  it('fresh 30 moves «fresh» back thirty minutes, and the pull carries it in its plan (the default: no key at all)', async () => {
    const now = new Date('2026-11-16T09:00:00.000Z');
    expect(freshSince(now, 30).toISOString()).toBe('2026-11-16T08:30:00.000Z');
    sw.priority = true;
    const edited = storedClient(rule({ freshMinutes: 30 }));
    const plan = await priorityPlanFor(edited.client, { companyId: 'co-fresh', storeId: 's' }, 'u', { timezone: 'Asia/Damascus' } as never, now);
    expect(plan?.freshMinutes).toBe(30);
    const def = storedClient(CONFIRMATION_RULE_DEFAULT);
    const plain = await priorityPlanFor(def.client, { companyId: 'co-fresh-default', storeId: 's' }, 'u', { timezone: 'Asia/Damascus' } as never, now);
    expect(plain && 'freshMinutes' in plain).toBe(false);
  });
});

describe('read ONCE per door — and on a warm cache, no statement at all', () => {
  it('confirmationRuleOnce reads nothing until asked, then answers the same rule to every helper', async () => {
    const { client, findUnique } = storedClient(rule({ hand: 4 }));
    const once = confirmationRuleOnce(client, 'co-once', 5_000);
    expect(findUnique).not.toHaveBeenCalled();
    const [a, b] = await Promise.all([once(), once()]);
    expect(a).toBe(b);
    expect(a.hand).toBe(4);
    expect(findUnique).toHaveBeenCalledTimes(1);
  });
  it('a warm cache: the pull\'s readers (returns limits, the priority plan) ask the database NOTHING for the rule', async () => {
    sw.priority = true;
    const { client, findUnique } = storedClient(rule({ hand: 4 }));
    const now = new Date(10_000);
    await readConfirmationRule(client, 'co-warm', now.getTime());
    findUnique.mockClear();
    const once = confirmationRuleOnce(client, 'co-warm', now.getTime());
    await returnsLimits(client, 'co-warm', now.getTime(), once);
    await priorityPlanFor(client, { companyId: 'co-warm', storeId: 's' }, 'u', { timezone: 'Asia/Damascus' } as never, now, once);
    expect(findUnique).not.toHaveBeenCalled();
  });
  it('a read that throws is the default rule — never «close by three»', async () => {
    const client = { company: { findUnique: vi.fn(async () => { throw new Error('down'); }) } } as never;
    expect(await readConfirmationRule(client, 'co-down', 1)).toEqual(CONFIRMATION_RULE_DEFAULT);
  });
});

describe('«القاعدة بالمختصر» says the rule in force', () => {
  const facts = (r?: ConfirmationRuleNumbers): RuleFacts => ({
    proofOn: true, priorityOn: true, roundsOn: false, returnsOn: false, hand: 3, idleMinutes: 20, workStart: '09:00', workEnd: '22:00',
    modes: { nightFrom: 9, nightTo: 11, peakFrom: 21, peakTo: 24 }, ...(r ? { rule: r } : {}),
  });
  it('the default reads main\'s schedule sentence, letter for letter', () => {
    expect(ruleSummaryLines(facts())[2]).toBe(
      'بعد كل «لا يرد» محسوبة بيطلع الطلب من إيدها وبيرجع لأي موظفة بموعدو: بعد 30 دقيقة، بعدين بعد ساعتين، بعدين تاني يوم الصبح (11:00) وبعد 8 ساعات على الأقل، وبعدين المسا (19:30) وبعد 3 ساعات على الأقل. الضغطة قبل موعدها بتنسجّل وما بتنحسب.'
    );
  });
  it('an edited rule: its steps, attempts, proof, postpone cap and fresh minutes', () => {
    const r = rule({ steps: [{ kind: 'after', minutes: 45 }, { kind: 'anchor', anchor: 'evening', floorHours: 2 }], proofSeconds: 45, postponeMax: 3, freshMinutes: 20, evening: '18:00' });
    const lines = ruleSummaryLines(facts(r)).join('\n');
    expect(lines).toContain('بعد 45 دقيقة، وبعدين المسا (18:00) وبعد ساعتين على الأقل.');
    expect(lines).toContain('بعد المحاولة 3 على 2 أيام');
    expect(lines).toContain('و45 ثانية');
    expect(lines).toContain('موعد من الزبون: 3 مرات');
    expect(lines).toContain('أقل من 20 دقيقة');
    expect(lines).toContain('«محاولة 2 من 3»');
  });
});

describe('every door and job hands the rule down', () => {
  const root = join(process.cwd(), 'src');
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n)) files.push(p);
    }
  };
  walk(root);
  it('no call of `cadenceCalOf` outside the tests leaves the rule out (a two-argument call would plan by the default whatever is stored)', () => {
    /** The number of top-level arguments of the call whose `(` is at `open`. */
    const argCount = (src: string, open: number): number => {
      let depth = 0;
      let commas = 0;
      for (let i = open; i < src.length; i++) {
        const ch = src[i];
        if ('({['.includes(ch)) depth++;
        else if (')}]'.includes(ch)) {
          depth--;
          if (depth === 0) return commas + 1;
        } else if (ch === ',' && depth === 1) commas++;
      }
      return -1;
    };
    const calls: string[] = [];
    for (const f of files) {
      const rel = relative(root, f).replace(/\\/g, '/');
      if (rel === 'lib/no-answer-cadence.ts') continue;
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\bcadenceCalOf\(/g)) calls.push(`${rel}:${argCount(src, m.index! + m[0].length - 1)}`);
    }
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(calls.filter((c) => !c.endsWith(':3'))).toEqual([]);
  });
  it('no door types a figure of the rule: the old constants are not read by the doors that now read the rule', () => {
    for (const p of [
      'app/api/confirmation/mine/route.ts',
      'app/api/orders/[id]/contact-attempts/route.ts',
      'app/api/orders/[id]/confirmation/route.ts',
      'lib/order-timeline.ts',
      'lib/confirmation-rule-summary.ts',
    ]) {
      const src = stripComments(readFileSync(join(root, p), 'utf8'));
      expect(src, p).not.toMatch(/\b(CADENCE_LIMIT|CADENCE_MIN_DAYS|CADENCE_GAPS_MS|CADENCE_FLOORS_MS|POSTPONE_MAX_TIMES|QUEUE_PRIORITY_LIMITS|MIN_CALL_MS)\b/);
    }
  });
});

/**
 * REVIEW 19/11 (blocker 1): NO RULE THE SAVE DOOR ACCEPTS MAY LEAVE AN ORDER THAT NEVER CLOSES. Random VALID rules (each passes `validateConfirmationRule`) × random
 * calendars × random first presses, every later press made at its due (or later): the press number `steps + 1` closes the order, and no press before it does.
 */
describe('every valid rule closes exactly at its limit when every due is pressed', () => {
  const seeded = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const CALS = [
    { timezone: 'Asia/Damascus', weekendDays: [] as number[], workHoursStart: '09:00', workHoursEnd: '22:00' },
    { timezone: 'Asia/Damascus', weekendDays: [5], workHoursStart: '09:00', workHoursEnd: '17:00' },
    { timezone: 'Asia/Amman', weekendDays: [5, 6], workHoursStart: '10:00', workHoursEnd: '18:00' },
    { timezone: 'Europe/Berlin', weekendDays: [0], workHoursStart: '08:00', workHoursEnd: '20:00' },
    { timezone: 'Asia/Damascus', weekendDays: [] as number[], workHoursStart: '12:00', workHoursEnd: '12:40' },
  ];
  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  it('the reviewer\'s case: after 10 min · evening anchor, not before 1 h · two days — pressed 10:00, 10:10, 19:30 → the third press is on a new day and closes', () => {
    const r = rule({ steps: [{ kind: 'after', minutes: 10 }, { kind: 'anchor', anchor: 'evening', floorHours: 1 }], minDays: 2 });
    expect(validateConfirmationRule(r).ok).toBe(true);
    const a = pressAll([dam(16, 10)], r);
    const second = cadencePress(a.lines, { at: dam(16, 10, 10), result: 'NO_ANSWER' }, calOf(r));
    expect(iso(second.dueAt)).toBe(iso(dam(17, 19, 30)));
    const { out } = pressAll([dam(16, 10), dam(16, 10, 10), dam(17, 19, 30)], r);
    expect(out.map((p) => p.closes)).toEqual([false, false, true]);
  });

  it('2,000 random valid rules: never stuck, never early', () => {
    const r = seeded(20261119);
    let checked = 0;
    for (let n = 0; n < 2000; n++) {
      const count = 2 + Math.floor(r() * 5);
      const steps = Array.from({ length: count }, () =>
        r() < 0.5
          ? { kind: 'after' as const, minutes: 10 + Math.floor(r() * 711) }
          : { kind: 'anchor' as const, anchor: r() < 0.5 ? ('morning' as const) : ('evening' as const), floorHours: 1 + Math.floor(r() * 24) }
      );
      const anchors = steps.filter((s) => s.kind === 'anchor').length;
      const morningAt = 6 * 60 + Math.floor(r() * 8 * 60);
      const candidate = {
        ...CONFIRMATION_RULE_DEFAULT,
        steps,
        minDays: 1 + Math.floor(r() * Math.min(3, anchors + 1)),
        morning: hhmm(morningAt),
        evening: hhmm(morningAt + 30 + Math.floor(r() * 8 * 60)),
      };
      const v = validateConfirmationRule(candidate);
      if (!v.ok) continue;
      const country = CALS[Math.floor(r() * CALS.length)];
      const cal = cadenceCalOf(SINCE, country, v.rule);
      const limit = steps.length + 1;
      const lines: CadenceFact[] = [];
      let at = new Date(Date.UTC(2026, 10 + Math.floor(r() * 8), 1 + Math.floor(r() * 27), Math.floor(r() * 24), Math.floor(r() * 60)));
      for (let k = 1; k <= limit; k++) {
        const p = cadencePress(lines, { at, result: 'NO_ANSWER' }, cal);
        const where = `rule ${JSON.stringify(v.rule)} in ${country.timezone} ${country.workHoursStart}-${country.workHoursEnd}, press ${k} at ${at.toISOString()}`;
        expect(p.counted, where).toBe(true);
        expect(p.closes, where).toBe(k === limit);
        lines.push({ createdAt: at, result: 'NO_ANSWER', attemptNumber: k, nextFollowUpAt: p.counted ? p.dueAt : null });
        if (k < limit) at = r() < 0.8 ? p.dueAt! : new Date(p.dueAt!.getTime() + Math.floor(r() * 30) * 3_600_000);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('a rule changed mid-cycle that leaves the limit reached on too few days: a later press on a new day closes it (a press, never a job)', () => {
    const r = rule({ steps: [{ kind: 'after', minutes: 10 }, { kind: 'anchor', anchor: 'evening', floorHours: 1 }], minDays: 2 });
    // three presses on ONE day, their dues stored under another rule
    const stored = [dam(16, 10, 10), dam(16, 19, 30), null];
    const lines: CadenceFact[] = [dam(16, 10), dam(16, 10, 10), dam(16, 19, 30)].map((t, i) => ({ createdAt: t, result: 'NO_ANSWER', attemptNumber: i + 1, nextFollowUpAt: stored[i] }));
    expect(cadenceState(lines, calOf(r)).counted).toHaveLength(3);
    expect(cadenceState(lines, calOf(r)).days).toBe(1);
    expect(cadencePress(lines, { at: dam(16, 20), result: 'NO_ANSWER' }, calOf(r)).closes).toBe(false);
    expect(cadencePress(lines, { at: dam(17, 10), result: 'NO_ANSWER' }, calOf(r)).closes).toBe(true);
  });
});

describe('the timeline numbers the lines by the rule in force (review 19/11, blocker 2)', () => {
  it('a stored rule of FOUR attempts: «محاولة 1 من 4», «محاولة 2 من 4»', async () => {
    const doc = documentAfterSave(null, { rule: rule({ steps: CONFIRMATION_RULE_DEFAULT.steps.slice(0, 3) }), effectiveAt: new Date(0), byUserId: 'u9' }, 0);
    const AT = (h: number, mi = 0) => new Date(Date.UTC(2026, 10, 15, h - 3, mi)); // Amman, Sunday
    const line = (id: string, at: Date, n: number, due: Date | null) => ({ id, companyId: 'co-tl-q3b', orderId: 'o1', createdAt: at, result: 'NO_ANSWER', contactMethod: 'PHONE', attemptNumber: n, employeeId: 'u1', note: null, nextFollowUpAt: due });
    const none = { findMany: vi.fn(async () => []) };
    const tx = {
      orderStatusLog: none, callLog: none, callHelperReading: none, deliveryAttempt: none, orderNote: none, orderActivity: none, orderChangeRequest: none, orderIssue: none, orderClaimHistory: none,
      orderContactAttempt: { findMany: vi.fn(async () => [line('a', AT(13), 1, AT(13, 30)), line('b', AT(13, 30), 2, AT(15, 30))]) },
      user: { findMany: vi.fn(async () => [{ id: 'u1', name: 'موظفة' }]) },
      order: { findUnique: vi.fn(async () => ({ country: { timezone: 'Asia/Amman', weekendDays: [5, 6], workHoursStart: '09:00', workHoursEnd: '17:00' } })) },
      company: { findUnique: vi.fn(async () => ({ settings: JSON.stringify({ confirmationRule: doc }) })) },
    };
    const titles = (await orderTimeline(tx as never, 'o1')).filter((e) => e.kind === 'CONTACT').map((e) => e.title.split(' عبر ')[0]);
    expect(titles).toEqual(['محاولة 1 من 4', 'محاولة 2 من 4']);
  });
});

describe('the default steps keep main\'s dues even where the days guarantee would move them', () => {
  it('a hand-built state, four presses on one day: #5 stays at 19:30 that evening (main), for the stored default too — the guarantee is for edited rules', () => {
    const state = { counted: [dam(16, 10), dam(16, 10, 30), dam(16, 12, 30)], days: 1, dueAt: null };
    for (const cal of [calOf(), calOf(CONFIRMATION_RULE_DEFAULT), calOf(rule({ morning: '10:00' }))]) {
      expect(iso(cadenceStep(state, dam(16, 13), cal).next.dueAt)).toBe(iso(dam(16, 19, 30)));
    }
    // …while the same steps with three days asked would be an edited rule, and are moved
    expect(iso(cadenceStep(state, dam(16, 13), calOf(rule({ steps: [...CONFIRMATION_RULE_DEFAULT.steps.slice(0, 3), { kind: 'anchor', anchor: 'evening', floorHours: 2 }] }))).next.dueAt)).toBe(iso(dam(17, 19, 30)));
  });
});

/**
 * REVIEW 19/11, round 2: A RULE SAVED MID-CYCLE NEVER STRANDS AN ORDER. Orders pressed under the DEFAULT for 1–4 counted presses (each line storing the due the door
 * stored), then a random VALID rule (three days asked included) is in force; every later press is made at the due the door answers, or — past the limit — once a day.
 * Every order closes, at a door press.
 */
describe('mid-cycle switches: every order still closes', () => {
  const DAMASCUS = { timezone: 'Asia/Damascus', weekendDays: [] as number[], workHoursStart: '10:00', workHoursEnd: '22:00' };
  const DAY = 86_400_000;
  const DAM = (d: number, h: number, mi = 0) => new Date(Date.UTC(2026, 10, d, h - 3, mi));

  /** Press on, door-style, from `lines` under `cal`, up to `max` presses: at each answered due, else the same clock the next day. The press that closed, or null. */
  function pressUntilClosed(lines: CadenceFact[], cal: ReturnType<typeof cadenceCalOf>, start: Date, max = 40): number | null {
    let at = start;
    for (let i = 0; i < max; i++) {
      const p = cadencePress(lines, { at, result: 'NO_ANSWER' }, cal);
      lines.push({ createdAt: at, result: 'NO_ANSWER', attemptNumber: lines.length + 1, nextFollowUpAt: p.counted ? p.dueAt : null });
      if (p.closes) return i;
      at = p.next.dueAt && p.next.dueAt.getTime() > at.getTime() ? p.next.dueAt : new Date(at.getTime() + DAY);
    }
    return null;
  }

  it('the reviewer\'s case: 11:00 and 11:30 under the default, then two evening steps and three days — the order closes on the third local day', () => {
    // the default's stored due after #2 is 13:30 the same day (10:00–22:00 here)
    const lines: CadenceFact[] = [];
    const defCal = cadenceCalOf(new Date('2026-10-01T00:00:00.000Z'), DAMASCUS);
    let at = DAM(2, 11);
    for (let i = 0; i < 2; i++) {
      const p = cadencePress(lines, { at, result: 'NO_ANSWER' }, defCal);
      lines.push({ createdAt: at, result: 'NO_ANSWER', attemptNumber: i + 1, nextFollowUpAt: p.dueAt });
      at = p.dueAt!;
    }
    expect(iso(at)).toBe(iso(DAM(2, 13, 30)));
    const edited = rule({ steps: [{ kind: 'anchor', anchor: 'evening', floorHours: 1 }, { kind: 'anchor', anchor: 'evening', floorHours: 1 }], minDays: 3 });
    expect(validateConfirmationRule(edited).ok).toBe(true);
    const cal = cadenceCalOf(new Date('2026-10-01T00:00:00.000Z'), DAMASCUS, edited);
    const closedAt = pressUntilClosed(lines, cal, at);
    expect(closedAt).not.toBeNull();
    expect(new Set(lines.map((l) => new Date(l.createdAt).toISOString().slice(0, 10))).size).toBeGreaterThanOrEqual(3);
  });

  it('1,500 random switches (default history of 1–4 counted presses → a random valid rule): none stranded', () => {
    const r = ((seed: number) => () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296))(19112026);
    const since = new Date('2026-10-01T00:00:00.000Z');
    let checked = 0;
    for (let n = 0; n < 1500; n++) {
      const count = 2 + Math.floor(r() * 5);
      const steps = Array.from({ length: count }, () =>
        r() < 0.4
          ? { kind: 'after' as const, minutes: 10 + Math.floor(r() * 711) }
          : { kind: 'anchor' as const, anchor: r() < 0.5 ? ('morning' as const) : ('evening' as const), floorHours: 1 + Math.floor(r() * 24) }
      );
      const anchors = steps.filter((s) => s.kind === 'anchor').length;
      const v = validateConfirmationRule({ ...CONFIRMATION_RULE_DEFAULT, steps, minDays: 1 + Math.floor(r() * Math.min(3, anchors + 1)) });
      if (!v.ok) continue;
      const country = r() < 0.5 ? DAMASCUS : { timezone: 'Asia/Amman', weekendDays: [5, 6], workHoursStart: '09:00', workHoursEnd: '17:00' };
      const lines: CadenceFact[] = [];
      const defCal = cadenceCalOf(since, country);
      let at = new Date(Date.UTC(2026, 10, 1 + Math.floor(r() * 25), 6 + Math.floor(r() * 12), Math.floor(r() * 60)));
      const before = 1 + Math.floor(r() * 4);
      for (let k = 0; k < before; k++) {
        const p = cadencePress(lines, { at, result: 'NO_ANSWER' }, defCal);
        lines.push({ createdAt: at, result: 'NO_ANSWER', attemptNumber: k + 1, nextFollowUpAt: p.counted ? p.dueAt : null });
        at = p.dueAt ?? new Date(at.getTime() + DAY);
      }
      const where = `rule ${JSON.stringify(v.rule)} in ${country.timezone}, after ${before} default presses`;
      expect(pressUntilClosed(lines, cadenceCalOf(since, country, v.rule), at), where).not.toBeNull();
      checked++;
    }
    expect(checked).toBeGreaterThan(800);
  });
});
