import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CONFIRMATION_RULE } from './confirmation-rule';
import {
  CONFIRMATION_RULE_DEFAULT,
  CONFIRMATION_RULE_RANGES,
  documentAfterCancel,
  documentAfterSave,
  nextWorkStart,
  parseConfirmationRuleDocument,
  readConfirmationRule,
  readConfirmationRuleDocument,
  ruleAt,
  ruleAttempts,
  validateConfirmationRule,
  type ConfirmationRuleDocument,
  type ConfirmationRuleNumbers,
} from './confirmation-rule-settings';

/**
 * «أرقام القاعدة» as a stored document (request Q3a, 19/11) — INERT: the door saves, shows and reverts it; no engine file reads it yet.
 *  · the default document IS today's `CONFIRMATION_RULE` (projected back to the constant's shape, deep-equal);
 *  · every range at both edges, and one step past each edge refused with its field and an Arabic sentence;
 *  · pending vs in force across `effectiveAt`; a save while pending replaces the pending one only; cancel; the eleventh version drops the oldest;
 *  · «بداية الدوام الجاي» by the Country's rest days (Friday evening, a country with no weekend);
 *  · the cached reader: a corrupt value answers the last good document, else the default; a failed read the same; thirty seconds of cache;
 *  · the blocker of this request: no file but the door imports this module.
 */

const valid = (over: Partial<Record<keyof ConfirmationRuleNumbers | 'attempts', unknown>> = {}) => ({ ...structuredClone(CONFIRMATION_RULE_DEFAULT), ...over });
const T0 = new Date('2026-11-19T10:00:00.000Z').getTime();
const H = 3_600_000;

/** The default projected back to the constant's shape — written out here, not by the module under test. */
function asConstantShape(rule: ConfirmationRuleNumbers) {
  const [a, b, c, d] = rule.steps;
  return {
    attempts: ruleAttempts(rule),
    minDays: rule.minDays,
    proofSeconds: rule.proofSeconds,
    hand: rule.hand,
    idleMinutes: rule.idleMinutes,
    morning: rule.morning,
    evening: rule.evening,
    freshMinutes: rule.freshMinutes,
    gapsMinutes: { afterFirst: a.kind === 'after' ? a.minutes : NaN, afterSecond: b.kind === 'after' ? b.minutes : NaN },
    floorsHours: { beforeFourth: c.kind === 'anchor' && c.anchor === 'morning' ? c.floorHours : NaN, beforeFifth: d.kind === 'anchor' && d.anchor === 'evening' ? d.floorHours : NaN },
    postponeMax: rule.postponeMax,
  };
}

describe('the default document is today’s rule', () => {
  it('deep-equals CONFIRMATION_RULE, four steps, five attempts', () => {
    expect(CONFIRMATION_RULE_DEFAULT.steps).toHaveLength(4);
    expect(asConstantShape(CONFIRMATION_RULE_DEFAULT)).toEqual(CONFIRMATION_RULE);
  });

  it('and the literal numbers of today, so a change to the constant cannot pass unseen', () => {
    expect(CONFIRMATION_RULE_DEFAULT).toEqual({
      steps: [
        { kind: 'after', minutes: 30 },
        { kind: 'after', minutes: 120 },
        { kind: 'anchor', anchor: 'morning', floorHours: 8 },
        { kind: 'anchor', anchor: 'evening', floorHours: 3 },
      ],
      minDays: 2, proofSeconds: 30, hand: 3, idleMinutes: 20, morning: '11:00', evening: '19:30', freshMinutes: 15, postponeMax: 2,
    });
  });

  it('passes its own validator unchanged', () => {
    expect(validateConfirmationRule(structuredClone(CONFIRMATION_RULE_DEFAULT))).toEqual({ ok: true, rule: CONFIRMATION_RULE_DEFAULT });
  });

  it('no stored document answers the default and nothing pending', () => {
    expect(ruleAt(null, T0)).toEqual({ rule: CONFIRMATION_RULE_DEFAULT, pending: null });
  });
});

describe('every number in its range, at both edges', () => {
  const numeric: [keyof typeof CONFIRMATION_RULE_RANGES & keyof ConfirmationRuleNumbers, number, number][] = [
    ['proofSeconds', 15, 90],
    ['hand', 1, 10],
    ['idleMinutes', 10, 60],
    ['freshMinutes', 5, 60],
    ['postponeMax', 1, 5],
  ];
  it.each(numeric)('%s: %i and %i pass; one past each edge, a fraction, a string are refused on that field', (field, min, max) => {
    expect(CONFIRMATION_RULE_RANGES[field]).toEqual({ min, max });
    expect(validateConfirmationRule(valid({ [field]: min })).ok).toBe(true);
    expect(validateConfirmationRule(valid({ [field]: max })).ok).toBe(true);
    for (const bad of [min - 1, max + 1, min + 0.5, String(min), null]) {
      const r = validateConfirmationRule(valid({ [field]: bad }));
      expect(r.ok, `${field}=${String(bad)}`).toBe(false);
      if (!r.ok) {
        expect(r.field).toBe(field);
        expect(r.error).toMatch(/[؀-ۿ]/);
        expect(r.error).toContain(String(min));
        expect(r.error).toContain(String(max));
      }
    }
  });

  const after = (minutes: number) => ({ kind: 'after', minutes });
  const morning = (floorHours = 8) => ({ kind: 'anchor', anchor: 'morning', floorHours });
  const evening = (floorHours = 3) => ({ kind: 'anchor', anchor: 'evening', floorHours });

  it('steps: 2 and 6 pass (3 and 7 attempts); 1 and 7 are refused', () => {
    expect(validateConfirmationRule(valid({ steps: [after(30), morning()] })).ok).toBe(true);
    expect(validateConfirmationRule(valid({ steps: [after(30), after(60), after(90), after(120), morning(), evening()] })).ok).toBe(true);
    for (const steps of [[morning()], [after(30), after(60), after(90), after(120), morning(), evening(), evening()], [], 'x', null]) {
      const r = validateConfirmationRule(valid({ steps }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.field).toBe('steps');
    }
  });

  it('«after N minutes»: 10 and 720 pass; 9, 721 and a fraction are refused on that step', () => {
    for (const m of [10, 720]) expect(validateConfirmationRule(valid({ steps: [after(m), morning(), evening()] })).ok).toBe(true);
    for (const m of [9, 721, 30.5]) {
      const r = validateConfirmationRule(valid({ steps: [after(30), after(m), morning()] }));
      expect(r).toMatchObject({ ok: false, field: 'steps.1' });
    }
  });

  it('floors: 1 and 24 hours pass; 0 and 25 are refused on that step', () => {
    for (const f of [1, 24]) expect(validateConfirmationRule(valid({ steps: [after(30), morning(f), evening(f)] })).ok).toBe(true);
    for (const f of [0, 25, 2.5]) {
      expect(validateConfirmationRule(valid({ steps: [after(30), morning(f)] }))).toMatchObject({ ok: false, field: 'steps.1' });
    }
  });

  it('a step that is neither kind, an anchor that is neither clock, or a stray key is refused', () => {
    for (const s of [{ kind: 'at', minutes: 30 }, { kind: 'anchor', anchor: 'noon', floorHours: 3 }, { kind: 'after', minutes: 30, extra: 1 }, 30, null]) {
      expect(validateConfirmationRule(valid({ steps: [after(30), s] }))).toMatchObject({ ok: false, field: 'steps.1' });
    }
  });

  it('minDays: 1 to 3, and never more than the anchor steps allow', () => {
    expect(validateConfirmationRule(valid({ minDays: 1 })).ok).toBe(true);
    expect(validateConfirmationRule(valid({ minDays: 3 })).ok).toBe(true); // two anchors → three days at most
    expect(validateConfirmationRule(valid({ minDays: 0 }))).toMatchObject({ ok: false, field: 'minDays' });
    expect(validateConfirmationRule(valid({ minDays: 4, steps: [after(30), morning(), morning(), evening()] }))).toMatchObject({ ok: false, field: 'minDays' });
    // no anchor at all → one day only
    expect(validateConfirmationRule(valid({ minDays: 1, steps: [after(30), after(120)] })).ok).toBe(true);
    const r = validateConfirmationRule(valid({ minDays: 2, steps: [after(30), after(120)] }));
    expect(r).toMatchObject({ ok: false, field: 'minDays' });
    // one anchor → two days, not three
    expect(validateConfirmationRule(valid({ minDays: 2, steps: [after(30), morning()] })).ok).toBe(true);
    expect(validateConfirmationRule(valid({ minDays: 3, steps: [after(30), morning()] }))).toMatchObject({ ok: false, field: 'minDays' });
  });

  it('morning before evening, both «HH:mm»', () => {
    expect(validateConfirmationRule(valid({ morning: '00:00', evening: '23:59' })).ok).toBe(true);
    expect(validateConfirmationRule(valid({ morning: '19:30', evening: '19:30' }))).toMatchObject({ ok: false, field: 'evening' });
    expect(validateConfirmationRule(valid({ morning: '20:00', evening: '19:30' }))).toMatchObject({ ok: false, field: 'evening' });
    for (const m of ['9:00', '24:00', '11:60', 1100, '']) expect(validateConfirmationRule(valid({ morning: m }))).toMatchObject({ ok: false, field: 'morning' });
    expect(validateConfirmationRule(valid({ evening: '7pm' }))).toMatchObject({ ok: false, field: 'evening' });
  });

  it('attempts may be sent only as steps + 1, and is never stored', () => {
    const ok = validateConfirmationRule(valid({ attempts: 5 }));
    expect(ok.ok && 'attempts' in ok.rule).toBe(false);
    expect(validateConfirmationRule(valid({ attempts: 6 }))).toMatchObject({ ok: false, field: 'attempts' });
  });

  it('an unknown field, or no object at all, is refused whole', () => {
    expect(validateConfirmationRule(valid({ closeAfter: 3 } as never))).toMatchObject({ ok: false, field: 'rule' });
    for (const x of [null, undefined, [], 'rule', 5]) expect(validateConfirmationRule(x)).toMatchObject({ ok: false, field: 'rule' });
  });
});

const edited = (hand: number): ConfirmationRuleNumbers => ({ ...structuredClone(CONFIRMATION_RULE_DEFAULT), hand });

describe('the document: pending, in force, versions', () => {
  it('a change from a later moment is pending until it, then in force from it exactly', () => {
    const doc = documentAfterSave(null, { rule: edited(5), effectiveAt: new Date(T0 + 2 * H), byUserId: 'u1' }, T0);
    expect(ruleAt(doc, T0 + 2 * H - 1)).toEqual({ rule: CONFIRMATION_RULE_DEFAULT, pending: { rule: edited(5), effectiveAt: new Date(T0 + 2 * H).toISOString(), byUserId: 'u1' } });
    expect(ruleAt(doc, T0 + 2 * H)).toEqual({ rule: edited(5), pending: null });
    expect(doc.previous).toEqual([{ rule: CONFIRMATION_RULE_DEFAULT, replacedAt: new Date(T0 + 2 * H).toISOString(), byUserId: null }]);
  });

  it('a save NOW is in force at once', () => {
    const doc = documentAfterSave(null, { rule: edited(4), effectiveAt: new Date(T0), byUserId: 'u1' }, T0);
    expect(ruleAt(doc, T0)).toEqual({ rule: edited(4), pending: null });
  });

  it('a save while one is pending replaces the pending one only', () => {
    const first = documentAfterSave(null, { rule: edited(4), effectiveAt: new Date(T0), byUserId: 'u1' }, T0);
    const pending = documentAfterSave(first, { rule: edited(5), effectiveAt: new Date(T0 + 5 * H), byUserId: 'u1' }, T0 + H);
    const replaced = documentAfterSave(pending, { rule: edited(6), effectiveAt: new Date(T0 + 6 * H), byUserId: 'u2' }, T0 + 2 * H);
    expect(replaced.previous.map((p) => p.rule.hand)).toEqual([4, 3]);
    expect(replaced.previous[0].replacedAt).toBe(new Date(T0 + 6 * H).toISOString());
    expect(ruleAt(replaced, T0 + 6 * H - 1)).toMatchObject({ rule: edited(4), pending: { rule: edited(6), byUserId: 'u2' } });
    expect(ruleAt(replaced, T0 + 6 * H).rule).toEqual(edited(6));
  });

  it('the eleventh version drops the oldest', () => {
    let doc: ConfirmationRuleDocument | null = null;
    for (let i = 1; i <= 11; i++) doc = documentAfterSave(doc, { rule: edited(i % 10 || 10), effectiveAt: new Date(T0 + i * H), byUserId: `u${i}` }, T0 + i * H);
    // previous after 11 saves: saves 10…1 (10 versions); the default that the first save pushed is gone
    expect(doc!.previous).toHaveLength(10);
    expect(doc!.previous.map((p) => p.byUserId)).toEqual(['u10', 'u9', 'u8', 'u7', 'u6', 'u5', 'u4', 'u3', 'u2', 'u1']);
    expect(doc!.previous.some((p) => p.byUserId === null)).toBe(false);
    // the tenth: the default is still the oldest
    let ten: ConfirmationRuleDocument | null = null;
    for (let i = 1; i <= 10; i++) ten = documentAfterSave(ten, { rule: edited(2), effectiveAt: new Date(T0 + i * H), byUserId: `u${i}` }, T0 + i * H);
    expect(ten!.previous).toHaveLength(10);
    expect(ten!.previous[9]).toMatchObject({ rule: CONFIRMATION_RULE_DEFAULT, byUserId: null });
  });

  it('cancel: the rule in force stays, the pending one is gone; nothing pending → nothing to cancel', () => {
    const first = documentAfterSave(null, { rule: edited(4), effectiveAt: new Date(T0), byUserId: 'u1' }, T0);
    const pending = documentAfterSave(first, { rule: edited(5), effectiveAt: new Date(T0 + 5 * H), byUserId: 'u2' }, T0 + H);
    const cancelled = documentAfterCancel(pending, T0 + 2 * H)!;
    expect(ruleAt(cancelled, T0 + 2 * H)).toEqual({ rule: edited(4), pending: null });
    expect(ruleAt(cancelled, T0 + 9 * H)).toEqual({ rule: edited(4), pending: null });
    expect(cancelled.byUserId).toBe('u1');
    expect(cancelled.previous).toEqual(first.previous);
    expect(documentAfterCancel(first, T0 + H)).toBeNull();
    expect(documentAfterCancel(null, T0)).toBeNull();
  });

  it('a stored document survives the round trip; any bad part makes the whole value unreadable', () => {
    const doc = documentAfterSave(null, { rule: edited(4), effectiveAt: new Date(T0), byUserId: 'u1' }, T0);
    expect(parseConfirmationRuleDocument(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
    const broken = [
      { ...doc, v: 2 },
      { ...doc, effectiveAt: 'soon' },
      { ...doc, current: { ...doc.current, hand: 99 } },
      { ...doc, previous: [{ ...doc.previous[0], rule: { ...doc.previous[0].rule, proofSeconds: 5 } }] },
      { ...doc, previous: Array.from({ length: 11 }, () => doc.previous[0]) },
      'x', 42, [], null,
    ];
    for (const b of broken) expect(parseConfirmationRuleDocument(b)).toBeNull();
  });
});

describe('«من بداية الدوام الجاي» lands on the next working day of that country', () => {
  const jordan = { timezone: 'Asia/Amman', workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6] };
  const syria = { timezone: 'Asia/Damascus', workHoursStart: '10:00', workHoursEnd: '22:00', weekendDays: [5] };
  const noWeekend = { timezone: 'Asia/Amman', workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [] as number[] };
  const at = (iso: string) => nextWorkStart(new Date(iso), jordan).toISOString();

  it('Friday evening in a Friday–Saturday weekend → Sunday’s start', () => {
    expect(at('2026-11-20T19:00:00+03:00')).toBe(new Date('2026-11-22T09:00:00+03:00').toISOString());
  });
  it('Thursday after work → Sunday’s start; Sunday before work → that morning; Sunday at the start exactly → Monday', () => {
    expect(at('2026-11-19T18:00:00+03:00')).toBe(new Date('2026-11-22T09:00:00+03:00').toISOString());
    expect(at('2026-11-22T08:00:00+03:00')).toBe(new Date('2026-11-22T09:00:00+03:00').toISOString());
    expect(at('2026-11-22T09:00:00+03:00')).toBe(new Date('2026-11-23T09:00:00+03:00').toISOString());
  });
  it('Syria (Friday only) → Saturday at ten', () => {
    expect(nextWorkStart(new Date('2026-11-20T19:00:00+03:00'), syria).toISOString()).toBe(new Date('2026-11-21T10:00:00+03:00').toISOString());
  });
  it('a country with no weekend → the very next day', () => {
    expect(nextWorkStart(new Date('2026-11-20T19:00:00+03:00'), noWeekend).toISOString()).toBe(new Date('2026-11-21T09:00:00+03:00').toISOString());
    expect(nextWorkStart(new Date('2026-11-20T19:00:00+03:00'), { ...noWeekend, weekendDays: [0, 1, 2, 3, 4, 5, 6] }).toISOString()).toBe(new Date('2026-11-21T09:00:00+03:00').toISOString());
  });
  it('unreadable hours fall back to the plan’s 10:00', () => {
    expect(nextWorkStart(new Date('2026-11-20T19:00:00+03:00'), { ...noWeekend, workHoursStart: 'x', workHoursEnd: null }).toISOString()).toBe(new Date('2026-11-21T10:00:00+03:00').toISOString());
  });
});

describe('the cached reader', () => {
  const clientOf = (settings: () => string | null) => {
    const findUnique = vi.fn(async () => ({ settings: settings() }));
    return { client: { company: { findUnique } } as never, findUnique };
  };
  const good = documentAfterSave(null, { rule: edited(7), effectiveAt: new Date(T0), byUserId: 'u1' }, T0);

  it('no stored value → the default', async () => {
    const { client } = clientOf(() => JSON.stringify({ other: 1 }));
    expect(await readConfirmationRule(client, 'r-none', T0)).toEqual(CONFIRMATION_RULE_DEFAULT);
  });

  it('a corrupt value with nothing read before → the default (never «close after three»)', async () => {
    const { client } = clientOf(() => JSON.stringify({ confirmationRule: { v: 1, current: { hand: 3 } } }));
    expect(await readConfirmationRule(client, 'r-corrupt', T0)).toEqual(CONFIRMATION_RULE_DEFAULT);
  });

  it('a corrupt value after a good read → the last good value; a failed read too', async () => {
    let raw: string | null = JSON.stringify({ confirmationRule: good });
    const findUnique = vi.fn(async () => {
      if (raw === 'THROW') throw new Error('db down');
      return { settings: raw };
    });
    const client = { company: { findUnique } } as never;
    expect((await readConfirmationRule(client, 'r-last', T0)).hand).toBe(7);
    raw = '{not json';
    expect((await readConfirmationRule(client, 'r-last', T0 + 31_000)).hand).toBe(7);
    raw = JSON.stringify({ confirmationRule: { ...good, current: { ...good.current, hand: 50 } } });
    expect((await readConfirmationRule(client, 'r-last', T0 + 62_000)).hand).toBe(7);
    raw = 'THROW';
    expect((await readConfirmationRule(client, 'r-last', T0 + 93_000)).hand).toBe(7);
    expect(findUnique).toHaveBeenCalledTimes(4);
  });

  it('cached thirty seconds, then read again', async () => {
    const { client, findUnique } = clientOf(() => JSON.stringify({ confirmationRule: good }));
    await readConfirmationRuleDocument(client, 'r-cache', T0);
    await readConfirmationRuleDocument(client, 'r-cache', T0 + 29_999);
    expect(findUnique).toHaveBeenCalledTimes(1);
    await readConfirmationRuleDocument(client, 'r-cache', T0 + 30_000);
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('a pending change starts at its moment even inside the cache window', async () => {
    const pending = documentAfterSave(null, { rule: edited(9), effectiveAt: new Date(T0 + 10_000), byUserId: 'u1' }, T0);
    const { client, findUnique } = clientOf(() => JSON.stringify({ confirmationRule: pending }));
    expect((await readConfirmationRule(client, 'r-pending', T0)).hand).toBe(3);
    expect((await readConfirmationRule(client, 'r-pending', T0 + 10_000)).hand).toBe(9);
    expect(findUnique).toHaveBeenCalledTimes(1);
  });
});

/*
 * UPDATED 2026-11-19 (request Q3b — «the engine reads the rule it is given»): this guard was «INERT: no file under src imports this module except the door» — the blocker
 * of Q3a. Q3b is the request that makes the engine read it, so the list is now EXACTLY the door and the engine's readers named by the row (its doors, its job, its
 * libraries) — a new importer still turns it red, and so does any screen: the desk's bundle is at its ceiling and gets the rule's numbers from the server. The scan also
 * sees `import('…')` and `require('…')` now (the Q3a review: the old pattern saw only `from '…'`).
 */
describe('who reads the stored rule: the door and the engine — never a screen', () => {
  it('the files under src that import confirmation-rule-settings are exactly the door and the engine (tests aside)', () => {
    const root = join(__dirname, '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(p);
      }
    };
    walk(root);
    const importers = files
      .filter((f) => /(from\s+|import\s*\(\s*|require\s*\(\s*)['"][^'"]*confirmation-rule-settings['"]/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(root, f).replace(/\\/g, '/'))
      .sort();
    expect(importers).toEqual([
      'app/api/confirmation/mine/route.ts',
      'app/api/confirmation/queue/route.ts',
      // ADDED 2026-11-21 (request Q4b): «افحص موظفة» reads the rule in force once, to give her numbers over it — a door, not a screen.
      'app/api/confirmation/rules/check/route.ts',
      'app/api/orders/[id]/confirmation/route.ts',
      'app/api/orders/[id]/contact-attempts/route.ts',
      // ADDED 2026-11-20 (request Q3c): the door of «مين بيقدر يعدّل» reads the stored document for the authors' ids of its versions — a door, not a screen.
      'app/api/settings/confirmation-rule/editors/route.ts',
      'app/api/settings/confirmation-rule/route.ts',
      'lib/confirmation-queue.ts',
      'lib/confirmation-rule-summary.ts',
      // ADDED 2026-11-20 (request Q4a): the owner's own rules (`confirmation-rules.ts`) hold every payload to the base rule's validator and fall back to its default —
      // the engine's resolver (inert until Q4b), never a screen.
      'lib/confirmation-rules.ts',
      // ADDED 2026-11-21 (request Q4b): her numbers over the base rule (`employee-numbers.ts`, a type import) and the returning-customer hold, which now reads the rule once per run to give each agent her own hand.
      'lib/employee-numbers.ts',
      'lib/jobs/definitions/release-stale-claims.ts',
      'lib/no-answer-cadence.ts',
      'lib/no-answer-watch.ts',
      'lib/order-timeline.ts',
      'lib/reserve-returning-customers.ts',
    ]);
    // …and no screen at all: a component or a client file that read it would put the reader (and the database client behind it) into a bundle.
    expect(importers.filter((f) => f.startsWith('components/') || /^'use client'/m.test(readFileSync(join(root, f), 'utf8')))).toEqual([]);
  });
});
