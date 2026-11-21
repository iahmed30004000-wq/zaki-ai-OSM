import { describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * REQUEST Q4d (21/11) — NO ORDER BECOMES UNCLOSABLE, WHATEVER STEPS AND DAYS A RULE GIVES IT, AND WHATEVER RULE IT CHANGES TO MID-CYCLE.
 *
 * An owner's rule may give the orders of a product, a store or a channel their own steps and days (2–6 steps, 1–3 days, any «after» minutes and anchor floors the base
 * validator accepts). An order's rule may change under it: a rule starts or stops, its product is changed by an edit. The plan's own guarantees (`no-answer-cadence.ts`:
 * `mustBeANewDay` places the anchors on the days a rule asks; `completesTheDays` closes an order whose counted presses reached a LOWER limit on too few days) hold
 * for ANY valid rule. Here they are held over seeded random rules and random switches, pressing the way an agent does — at the due or a little after it, now and
 * then too early (which must not count), on a new day once the attempts are spent — with the contact door's own close condition (the plan says «closes», and the
 * counted presses reach the rule of three the door also asks).
 * ═══════════════════════════════════════════════════════════════════════
 */

vi.mock('./db', () => ({ db: {} }));

import { CONFIRMATION_RULE_DEFAULT, CONFIRMATION_RULE_RANGES, validateConfirmationRule, type ConfirmationRuleNumbers, type RuleStep } from './confirmation-rule-settings';
import { validateRulePayload } from './confirmation-rules';
import { cadenceCalOf, cadenceLimit, cadencePress, type CadenceFact } from './no-answer-cadence';
import { NO_ANSWER_LIMIT } from './confirmation-workflow';
import { scheduleOfAttempts } from './confirmation-own-rules';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const R = CONFIRMATION_RULE_RANGES;
const COUNTRIES = [
  { timezone: 'Asia/Amman', workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6] },
  { timezone: 'Asia/Damascus', workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5] },
  { timezone: 'UTC', workHoursStart: '10:00', workHoursEnd: '22:00', weekendDays: [] },
  { timezone: 'Africa/Cairo', workHoursStart: '08:00', workHoursEnd: '20:00', weekendDays: [5, 6] },
];

/** A random ORDER rule's schedule the save door would accept (the payload validator, i.e. the base validator on the default). */
function randomSchedule(next: () => number): { steps: RuleStep[]; minDays: number } {
  for (;;) {
    if (next() < 0.25) return scheduleOfAttempts(3 + Math.floor(next() * 5))!;
    const n = R.steps.min + Math.floor(next() * (R.steps.max - R.steps.min + 1));
    const steps: RuleStep[] = Array.from({ length: n }, () =>
      next() < 0.5
        ? { kind: 'after', minutes: R.afterMinutes.min + Math.floor(next() * (R.afterMinutes.max - R.afterMinutes.min + 1)) }
        : { kind: 'anchor', anchor: next() < 0.5 ? 'morning' : 'evening', floorHours: R.floorHours.min + Math.floor(next() * (R.floorHours.max - R.floorHours.min + 1)) }
    );
    const anchors = steps.filter((s) => s.kind === 'anchor').length;
    const minDays = 1 + Math.floor(next() * Math.min(R.minDays.max, anchors + 1));
    const payload = validateRulePayload('ORDER_NUMBERS', { steps, minDays });
    if (payload.ok) return { steps: payload.payload.steps!, minDays: payload.payload.minDays! };
  }
}

const SINCE = new Date('2026-11-01T00:00:00.000Z');
const MIN = 60_000;
const DAY = 86_400_000;

function run(seed: number) {
  const next = rng(seed);
  const country = COUNTRIES[Math.floor(next() * COUNTRIES.length)];
  const base: ConfirmationRuleNumbers = CONFIRMATION_RULE_DEFAULT;
  const pool: ConfirmationRuleNumbers[] = [base, ...Array.from({ length: 3 }, () => ({ ...base, ...randomSchedule(next) }))];
  for (const r of pool) expect(validateConfirmationRule(r).ok).toBe(true);
  let rule = pool[Math.floor(next() * pool.length)];
  const lines: CadenceFact[] = [];
  let at = new Date(Date.UTC(2026, 10, 2, 6 + Math.floor(next() * 12), Math.floor(next() * 60)));
  let dueAt: Date | null = null;
  let switches = 0;
  for (let press = 1; press <= 80; press++) {
    // The order's rule changes under it (a rule starts or stops, its product is changed) — now and then, during the first presses only.
    if (press <= 14 && next() < 0.3) {
      rule = pool[Math.floor(next() * pool.length)];
      switches++;
    }
    const cal = cadenceCalOf(SINCE, country, rule);
    const early = dueAt !== null && next() < 0.15;
    const when: Date = early ? new Date(dueAt!.getTime() - 1 - Math.floor(next() * 20) * MIN) : at;
    const out = cadencePress(lines, { at: when, result: 'NO_ANSWER' }, cal);
    if (early) expect(out.counted, `seed ${seed} press ${press}: an early press counted`).toBe(false);
    lines.push({ createdAt: when, result: 'NO_ANSWER', attemptNumber: lines.length + 1, employeeId: 'u1', nextFollowUpAt: out.counted ? out.dueAt : null } as CadenceFact);
    // The contact door's close: the plan says so AND the counted presses reach the rule of three (`noAnswers >= NO_ANSWER_LIMIT`).
    if (out.closes && out.next.counted.length >= NO_ANSWER_LIMIT) {
      expect(out.next.counted.length, `seed ${seed}: closed below its rule's attempts`).toBeGreaterThanOrEqual(cadenceLimit(rule));
      return { closedAt: press, switches, limit: cadenceLimit(rule) };
    }
    expect(out.closes, `seed ${seed}: the plan says «closes» below the door's three`).toBe(false);
    if (!early) {
      dueAt = out.next.dueAt;
      // The next press: at its due or up to two hours after it; once the attempts are spent, the next day.
      at = dueAt ? new Date(dueAt.getTime() + Math.floor(next() * 120) * MIN) : new Date(when.getTime() + DAY + Math.floor(next() * 60) * MIN);
    }
  }
  return { closedAt: null, switches, limit: cadenceLimit(rule) };
}

describe('every order closes, whatever valid steps and days its rule gives it, and whatever rule it moves to mid-cycle', () => {
  it('600 seeded orders: each closes at a counted press, and an early press never counts', () => {
    const results = Array.from({ length: 600 }, (_, i) => ({ seed: 20261121 + i, ...run(20261121 + i) }));
    const stranded = results.filter((r) => r.closedAt === null);
    expect(stranded, JSON.stringify(stranded.slice(0, 5))).toEqual([]);
    // The scenarios really changed rules mid-cycle, and closed under short and long rules alike.
    expect(results.filter((r) => r.switches > 0).length).toBeGreaterThan(300);
    expect(new Set(results.map((r) => r.limit)).size).toBeGreaterThanOrEqual(4);
  });

  it('the five ready schedules (3–7 attempts), with no switch: each closes exactly at its own attempt count when every press is on time', () => {
    for (let n = 3; n <= 7; n++) {
      const rule = { ...CONFIRMATION_RULE_DEFAULT, ...scheduleOfAttempts(n)! };
      const cal = cadenceCalOf(SINCE, COUNTRIES[0], rule);
      const lines: CadenceFact[] = [];
      let at = new Date('2026-11-15T07:00:00.000Z');
      let closedAt = 0;
      for (let press = 1; press <= 12 && !closedAt; press++) {
        const out = cadencePress(lines, { at, result: 'NO_ANSWER' }, cal);
        lines.push({ createdAt: at, result: 'NO_ANSWER', attemptNumber: press, employeeId: 'u1', nextFollowUpAt: out.counted ? out.dueAt : null } as CadenceFact);
        if (out.closes) closedAt = press;
        else at = out.next.dueAt ?? new Date(at.getTime() + DAY);
      }
      expect(closedAt, `${n} attempts`).toBe(n);
    }
  });
});

/**
 * REVIEW OF #448 (21/11), the blocker: a rule switched mid-cycle ONTO THE DEFAULT PLAN. Five counted presses on ONE day (written under a rule of «after» steps and one
 * day — an edited base, or an order rule) and then the order lands on the default (its rule stopped or ended, or its product edited onto another): five counted reach
 * the default's limit on one day, and the default asks two. The way out (`completesTheDays`) used to skip the default plan — the order never closed. It now closes at
 * the first «لا يرد» on another day, and a history written under the default alone is untouched (both goldens, and the three doors' main-goldens).
 */
describe('a mid-cycle switch onto the default plan never strands an order', () => {
  const ONE_DAY_FAST: ConfirmationRuleNumbers = { ...CONFIRMATION_RULE_DEFAULT, steps: Array.from({ length: 6 }, () => ({ kind: 'after' as const, minutes: 10 })), minDays: 1 };
  const AMMAN = COUNTRIES[0];

  it('the reviewer’s case: 5 counted on Sunday under «7 × after 10 min, one day», then the default — Monday’s first «لا يرد» closes it', () => {
    expect(validateRulePayload('ORDER_NUMBERS', { steps: ONE_DAY_FAST.steps, minDays: 1 }).ok).toBe(true);
    const fast = cadenceCalOf(SINCE, AMMAN, ONE_DAY_FAST);
    const lines: CadenceFact[] = [];
    let at = new Date('2026-11-15T07:00:00.000Z'); // Sunday 10:00 Amman
    for (let i = 0; i < 5; i++) {
      const out = cadencePress(lines, { at, result: 'NO_ANSWER' }, fast);
      expect(out.counted).toBe(true);
      expect(out.closes).toBe(false);
      lines.push({ createdAt: at, result: 'NO_ANSWER', attemptNumber: i + 1, employeeId: 'u1', nextFollowUpAt: out.dueAt } as CadenceFact);
      at = out.dueAt!;
    }
    const plain = cadenceCalOf(SINCE, AMMAN, CONFIRMATION_RULE_DEFAULT);
    // The same day: two days are asked, one is all there is — not yet.
    expect(cadencePress(lines, { at: new Date('2026-11-15T12:00:00.000Z'), result: 'NO_ANSWER' }, plain).closes).toBe(false);
    // The next working day: closes.
    const monday = cadencePress(lines, { at: new Date('2026-11-16T07:00:00.000Z'), result: 'NO_ANSWER' }, plain);
    expect(monday.closes).toBe(true);
    expect(monday.next.counted.length).toBeGreaterThanOrEqual(NO_ANSWER_LIMIT);
  });

  it('600 seeded orders whose rules include «after»-only one-day schedules and the default: every one closes', () => {
    const stranded: number[] = [];
    for (let i = 0; i < 600; i++) {
      const next = rng(7_000_000 + i);
      const fastN = 3 + Math.floor(next() * 4);
      const fastRule: ConfirmationRuleNumbers = {
        ...CONFIRMATION_RULE_DEFAULT,
        steps: Array.from({ length: fastN }, () => ({ kind: 'after' as const, minutes: 10 + Math.floor(next() * 50) })),
        minDays: 1,
      };
      const pool = [fastRule, CONFIRMATION_RULE_DEFAULT, { ...CONFIRMATION_RULE_DEFAULT, ...scheduleOfAttempts(3 + Math.floor(next() * 5))! }, { ...CONFIRMATION_RULE_DEFAULT, ...randomSchedule(next) }];
      const country = COUNTRIES[Math.floor(next() * COUNTRIES.length)];
      let rule = fastRule;
      const lines: CadenceFact[] = [];
      let at = new Date(Date.UTC(2026, 10, 2, 7 + Math.floor(next() * 4), Math.floor(next() * 60)));
      let closed = false;
      for (let press = 1; press <= 60 && !closed; press++) {
        if (press >= 2 && press <= 10 && next() < 0.35) rule = pool[Math.floor(next() * pool.length)];
        const out = cadencePress(lines, { at, result: 'NO_ANSWER' }, cadenceCalOf(SINCE, country, rule));
        lines.push({ createdAt: at, result: 'NO_ANSWER', attemptNumber: press, employeeId: 'u1', nextFollowUpAt: out.counted ? out.dueAt : null } as CadenceFact);
        if (out.closes && out.next.counted.length >= NO_ANSWER_LIMIT) closed = true;
        else at = out.next.dueAt ? new Date(out.next.dueAt.getTime() + Math.floor(next() * 30) * MIN) : new Date(at.getTime() + DAY);
      }
      if (!closed) stranded.push(7_000_000 + i);
    }
    expect(stranded).toEqual([]);
  });
});
