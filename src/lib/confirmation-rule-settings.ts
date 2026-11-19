import type { Prisma } from '@prisma/client';
import { zonedParts, zonedTimeToInstant } from './business-calendar';
import { updateCompanySettings } from './company-settings';
import { CONFIRMATION_RULE } from './confirmation-rule';
import type { db } from './db';
import { cadenceWorkWindow } from './no-answer-cadence';
import { hhmmToMinutes } from './work-hours';

type Client = Prisma.TransactionClient | typeof db;

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «أرقام القاعدة» — THE NUMBERS OF THE ONE CONFIRMATION RULE AS A STORED DOCUMENT (request Q3a of the rules plan; INERT).
 *
 * `Company.settings.confirmationRule` holds the owner's edit of `CONFIRMATION_RULE` (`confirmation-rule.ts`). In THIS request nothing in the engine reads it:
 * the door `/api/settings/confirmation-rule` saves, shows and reverts it, and every engine file still reads the constant. The engine starts reading it (through
 * `readConfirmationRule`, once per door or job) in the next request — so until then a saved document changes no answer anywhere.
 *
 * ── THE RULE ──
 * The fields of `CONFIRMATION_RULE`, with the schedule generalised to STEPS: an ordered list, one step per attempt after the first (attempts = steps + 1).
 *   · `{ kind: 'after', minutes }`              → the next attempt counts this many minutes (elapsed) after the previous counted one;
 *   · `{ kind: 'anchor', anchor, floorHours }`  → it counts at the morning / evening clock of a working day, never before `floorHours` (elapsed) after the previous one.
 * The default (`CONFIRMATION_RULE_DEFAULT`) is built FROM the constant, so it reproduces today's five attempts exactly: after 30 min · after 2 h · the morning anchor,
 * not before 8 h · the evening anchor, not before 3 h. `attempts` is never stored — it is `steps.length + 1` (`ruleAttempts`).
 *
 * ── THE DOCUMENT ──
 *   { v: 1, current, effectiveAt, savedAt, byUserId, previous: [{ rule, replacedAt, byUserId }] }
 * `current` is the last rule saved and `effectiveAt` the moment it starts; BEFORE that moment the rule in force is `previous[0].rule` (a «pending» change), after it
 * `current`. `byUserId` is who saved `current`; each `previous` entry keeps who had saved IT and when it was replaced. At most ten previous versions are kept: the
 * eleventh drops the oldest. A save while a change is pending replaces the pending one only — the rule in force stays `previous[0]`, and the replaced pending rule,
 * which never acted, is not kept as a version (its audit row is). The first save pushes the default as the first previous version, so «رجّع» can always go back to it.
 *
 * ── READING ──
 * `readConfirmationRule` is cached thirty seconds per company (the pull is hot: it will be asked on every press). The in-force rule is resolved from the cached
 * document at the moment asked, so a pending change starts exactly at its `effectiveAt` even inside the cache window. A stored value that is not exactly a valid
 * document — or a read that throws — answers the last good document this process saw, else the default: never a half-read rule, never «close after three».
 *
 * NOTHING HERE TOUCHES MONEY, ORDER CREATION OR A CONTRACT.
 * ═══════════════════════════════════════════════════════════════════════
 */

export const CONFIRMATION_RULE_SETTINGS_KEY = 'confirmationRule';

export type RuleStep = { kind: 'after'; minutes: number } | { kind: 'anchor'; anchor: 'morning' | 'evening'; floorHours: number };

export interface ConfirmationRuleNumbers {
  steps: RuleStep[];
  minDays: number;
  proofSeconds: number;
  hand: number;
  idleMinutes: number;
  morning: string;
  evening: string;
  freshMinutes: number;
  postponeMax: number;
}

export interface PreviousVersion {
  rule: ConfirmationRuleNumbers;
  replacedAt: string;
  byUserId: string | null;
}

export interface ConfirmationRuleDocument {
  v: 1;
  current: ConfirmationRuleNumbers;
  effectiveAt: string;
  savedAt: string;
  byUserId: string | null;
  previous: PreviousVersion[];
}

/** Today's rule, from the constant — so the two can never drift apart. */
export const CONFIRMATION_RULE_DEFAULT: ConfirmationRuleNumbers = Object.freeze({
  steps: Object.freeze([
    Object.freeze({ kind: 'after', minutes: CONFIRMATION_RULE.gapsMinutes.afterFirst }),
    Object.freeze({ kind: 'after', minutes: CONFIRMATION_RULE.gapsMinutes.afterSecond }),
    Object.freeze({ kind: 'anchor', anchor: 'morning', floorHours: CONFIRMATION_RULE.floorsHours.beforeFourth }),
    Object.freeze({ kind: 'anchor', anchor: 'evening', floorHours: CONFIRMATION_RULE.floorsHours.beforeFifth }),
  ]) as unknown as RuleStep[],
  minDays: CONFIRMATION_RULE.minDays,
  proofSeconds: CONFIRMATION_RULE.proofSeconds,
  hand: CONFIRMATION_RULE.hand,
  idleMinutes: CONFIRMATION_RULE.idleMinutes,
  morning: CONFIRMATION_RULE.morning,
  evening: CONFIRMATION_RULE.evening,
  freshMinutes: CONFIRMATION_RULE.freshMinutes,
  postponeMax: CONFIRMATION_RULE.postponeMax,
}) as ConfirmationRuleNumbers;

/** The safe range of every number, inclusive — the validator's and the editor's one list. */
export const CONFIRMATION_RULE_RANGES = Object.freeze({
  steps: { min: 2, max: 6 },
  afterMinutes: { min: 10, max: 720 },
  floorHours: { min: 1, max: 24 },
  minDays: { min: 1, max: 3 },
  proofSeconds: { min: 15, max: 90 },
  hand: { min: 1, max: 10 },
  idleMinutes: { min: 10, max: 60 },
  freshMinutes: { min: 5, max: 60 },
  postponeMax: { min: 1, max: 5 },
});

/** How many previous versions a document keeps. */
const KEEP_VERSIONS = 10;

export function ruleAttempts(rule: ConfirmationRuleNumbers): number {
  return rule.steps.length + 1;
}

export type RuleValidation = { ok: true; rule: ConfirmationRuleNumbers } | { ok: false; error: string; field: string };

const FIELDS = ['steps', 'minDays', 'proofSeconds', 'hand', 'idleMinutes', 'morning', 'evening', 'freshMinutes', 'postponeMax'] as const;
type Range = { min: number; max: number };
const within = (n: unknown, r: Range): n is number => typeof n === 'number' && Number.isInteger(n) && n >= r.min && n <= r.max;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function stepOf(raw: unknown, i: number): { step: RuleStep } | { error: string } {
  const n = i + 1;
  const R = CONFIRMATION_RULE_RANGES;
  if (isObject(raw) && raw.kind === 'after' && Object.keys(raw).every((k) => k === 'kind' || k === 'minutes')) {
    if (!within(raw.minutes, R.afterMinutes)) return { error: `الخطوة ${n}: «بعد كم دقيقة» لازم يكون رقم صحيح من ${R.afterMinutes.min} لـ${R.afterMinutes.max}.` };
    return { step: { kind: 'after', minutes: raw.minutes } };
  }
  if (isObject(raw) && raw.kind === 'anchor' && Object.keys(raw).every((k) => k === 'kind' || k === 'anchor' || k === 'floorHours')) {
    if (raw.anchor !== 'morning' && raw.anchor !== 'evening') return { error: `الخطوة ${n}: الموعد لازم يكون موعد الصبح أو موعد المسا.` };
    if (!within(raw.floorHours, R.floorHours)) return { error: `الخطوة ${n}: «مش قبل كم ساعة» لازم يكون رقم صحيح من ${R.floorHours.min} لـ${R.floorHours.max}.` };
    return { step: { kind: 'anchor', anchor: raw.anchor, floorHours: raw.floorHours } };
  }
  return { error: `الخطوة ${n} لازم تكون «بعد كذا دقيقة» أو «على موعد الصبح أو المسا، مش قبل كذا ساعة».` };
}

/**
 * THE WHOLE RULE, OR NOTHING — one Arabic sentence for the first failure, and the field it belongs to (the editor prints it beside that field). Unknown keys are
 * refused; `attempts` may be sent (the door answers it) but only when it equals steps + 1, and it is never stored.
 */
export function validateConfirmationRule(input: unknown): RuleValidation {
  const R = CONFIRMATION_RULE_RANGES;
  const fail = (field: string, error: string): RuleValidation => ({ ok: false, error, field });
  if (!isObject(input)) return fail('rule', 'القاعدة لازم تنبعت كاملة: الخطوات وكل رقم من أرقامها.');
  const unknown = Object.keys(input).filter((k) => k !== 'attempts' && !(FIELDS as readonly string[]).includes(k));
  if (unknown.length > 0) return fail('rule', 'في خانة بالقاعدة مش من أرقامها — ابعت الخطوات والأرقام بس.');

  if (!Array.isArray(input.steps) || input.steps.length < R.steps.min || input.steps.length > R.steps.max) {
    return fail('steps', `عدد الخطوات لازم يكون من ${R.steps.min} لـ${R.steps.max} (يعني من ${R.steps.min + 1} لـ${R.steps.max + 1} محاولات).`);
  }
  const steps: RuleStep[] = [];
  for (let i = 0; i < input.steps.length; i++) {
    const read = stepOf(input.steps[i], i);
    if ('error' in read) return fail(`steps.${i}`, read.error);
    steps.push(read.step);
  }
  if (input.attempts !== undefined && input.attempts !== steps.length + 1) {
    return fail('attempts', 'عدد المحاولات هو عدد الخطوات وواحد — ما بينكتب لحالو.');
  }

  const anchors = steps.filter((s) => s.kind === 'anchor').length;
  if (!within(input.minDays, R.minDays)) return fail('minDays', `عدد الأيام المختلفة لازم يكون رقم صحيح من ${R.minDays.min} لـ${R.minDays.max}.`);
  if (input.minDays > anchors + 1) {
    return fail('minDays', `عدد الأيام المختلفة أكتر من اللي بتسمح فيه الخطوات: مع ${anchors} خطوة على موعد الصبح أو المسا بيصير أكتر شي ${anchors + 1}.`);
  }
  if (!within(input.proofSeconds, R.proofSeconds)) return fail('proofSeconds', `ثواني إثبات الاتصال لازم تكون رقم صحيح من ${R.proofSeconds.min} لـ${R.proofSeconds.max}.`);
  if (!within(input.hand, R.hand)) return fail('hand', `حد اليد لازم يكون رقم صحيح من ${R.hand.min} لـ${R.hand.max}.`);
  if (!within(input.idleMinutes, R.idleMinutes)) return fail('idleMinutes', `مهلة الطلب المتروك لازم تكون رقم صحيح من ${R.idleMinutes.min} لـ${R.idleMinutes.max} دقيقة.`);
  if (!within(input.freshMinutes, R.freshMinutes)) return fail('freshMinutes', `مدة الطلب الطازج لازم تكون رقم صحيح من ${R.freshMinutes.min} لـ${R.freshMinutes.max} دقيقة.`);
  if (!within(input.postponeMax, R.postponeMax)) return fail('postponeMax', `حد تأجيل الزبون لازم يكون رقم صحيح من ${R.postponeMax.min} لـ${R.postponeMax.max}.`);

  const morning = hhmmToMinutes(input.morning);
  const evening = hhmmToMinutes(input.evening);
  if (morning === null) return fail('morning', 'موعد الصبح لازم ينكتب ساعة ودقيقة متل 11:00.');
  if (evening === null) return fail('evening', 'موعد المسا لازم ينكتب ساعة ودقيقة متل 19:30.');
  if (morning >= evening) return fail('evening', 'موعد الصبح لازم يكون قبل موعد المسا.');

  return {
    ok: true,
    rule: {
      steps,
      minDays: input.minDays,
      proofSeconds: input.proofSeconds as number,
      hand: input.hand as number,
      idleMinutes: input.idleMinutes as number,
      morning: input.morning as string,
      evening: input.evening as string,
      freshMinutes: input.freshMinutes as number,
      postponeMax: input.postponeMax as number,
    },
  };
}

const isMoment = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(new Date(v).getTime());
const isAuthor = (v: unknown): v is string | null => v === null || typeof v === 'string';

/** A stored value as a document — or null when it is not EXACTLY a valid one (a single bad version makes the whole value unreadable: nothing is half-read). */
export function parseConfirmationRuleDocument(raw: unknown): ConfirmationRuleDocument | null {
  if (!isObject(raw) || raw.v !== 1 || !isMoment(raw.effectiveAt) || !isMoment(raw.savedAt) || !isAuthor(raw.byUserId)) return null;
  const current = validateConfirmationRule(raw.current);
  if (!current.ok || !Array.isArray(raw.previous) || raw.previous.length > KEEP_VERSIONS) return null;
  const previous: PreviousVersion[] = [];
  for (const p of raw.previous) {
    if (!isObject(p) || !isMoment(p.replacedAt) || !isAuthor(p.byUserId)) return null;
    const rule = validateConfirmationRule(p.rule);
    if (!rule.ok) return null;
    previous.push({ rule: rule.rule, replacedAt: p.replacedAt, byUserId: p.byUserId });
  }
  return { v: 1, current: current.rule, effectiveAt: raw.effectiveAt, savedAt: raw.savedAt, byUserId: raw.byUserId, previous };
}

/** The rule in force at `nowMs`, and the pending change if one waits for its moment. No document = the default, nothing pending. */
export function ruleAt(doc: ConfirmationRuleDocument | null, nowMs: number): { rule: ConfirmationRuleNumbers; pending: { rule: ConfirmationRuleNumbers; effectiveAt: string; byUserId: string | null } | null } {
  if (!doc) return { rule: CONFIRMATION_RULE_DEFAULT, pending: null };
  if (nowMs >= new Date(doc.effectiveAt).getTime()) return { rule: doc.current, pending: null };
  return { rule: doc.previous[0]?.rule ?? CONFIRMATION_RULE_DEFAULT, pending: { rule: doc.current, effectiveAt: doc.effectiveAt, byUserId: doc.byUserId } };
}

/**
 * THE DOCUMENT AFTER A SAVE of `rule` from `effectiveAt` by `byUserId`, decided at `nowMs` on the document as it is stored at that moment (the door calls it under
 * the row lock). A pending change is replaced; a rule in force becomes the newest previous version; the eleventh drops off.
 */
export function documentAfterSave(
  doc: ConfirmationRuleDocument | null,
  change: { rule: ConfirmationRuleNumbers; effectiveAt: Date; byUserId: string | null },
  nowMs: number
): ConfirmationRuleDocument {
  const effectiveAt = change.effectiveAt.toISOString();
  let previous: PreviousVersion[];
  if (!doc) {
    previous = [{ rule: CONFIRMATION_RULE_DEFAULT, replacedAt: effectiveAt, byUserId: null }];
  } else if (nowMs < new Date(doc.effectiveAt).getTime()) {
    previous = doc.previous.map((p, i) => (i === 0 ? { ...p, replacedAt: effectiveAt } : p));
  } else {
    previous = [{ rule: doc.current, replacedAt: effectiveAt, byUserId: doc.byUserId }, ...doc.previous].slice(0, KEEP_VERSIONS);
  }
  return { v: 1, current: change.rule, effectiveAt, savedAt: new Date(nowMs).toISOString(), byUserId: change.byUserId, previous };
}

/** THE DOCUMENT AFTER «إلغاء التعديل المعلّق»: the rule in force stays, from now on, and the pending one is gone. Null when nothing is pending. */
export function documentAfterCancel(doc: ConfirmationRuleDocument | null, nowMs: number): ConfirmationRuleDocument | null {
  if (!doc || nowMs >= new Date(doc.effectiveAt).getTime()) return null;
  const [inForce, ...older] = doc.previous;
  const now = new Date(nowMs).toISOString();
  return { v: 1, current: inForce?.rule ?? CONFIRMATION_RULE_DEFAULT, effectiveAt: now, savedAt: now, byUserId: inForce?.byUserId ?? null, previous: older };
}

/**
 * «من بداية الدوام الجاي» — the first start of work STRICTLY after `now`, on a day that is not one of the Country's rest days, in its timezone. The start is read
 * through `cadenceWorkWindow` (the plan's one reader of the two hours, with its fallbacks). No rest days, or all seven, skip nothing.
 */
export function nextWorkStart(now: Date, country: { timezone: string; workHoursStart?: string | null; workHoursEnd?: string | null; weekendDays?: readonly number[] | null }): Date {
  const start = cadenceWorkWindow(country.workHoursStart, country.workHoursEnd).start;
  const hour = Number(start.slice(0, 2));
  const minute = Number(start.slice(3));
  const rest = new Set((country.weekendDays ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6));
  if (rest.size >= 7) rest.clear();
  const p = zonedParts(now, country.timezone);
  let day = Date.UTC(p.year, p.month - 1, p.day);
  for (let i = 0; i < 16; i++, day += 86_400_000) {
    const d = new Date(day);
    if (rest.has(d.getUTCDay())) continue;
    const at = zonedTimeToInstant(country.timezone, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hour, minute);
    if (at.getTime() > now.getTime()) return at;
  }
  throw new RangeError('confirmation rule: no working day within 16 days');
}

const CACHE_MS = 30_000;
const cache = new Map<string, { doc: ConfirmationRuleDocument | null; at: number }>();
/** The last document this process read whole, per company — what a corrupt value or a failed read answers instead. */
const lastGood = new Map<string, ConfirmationRuleDocument | null>();

/** The stored document of this company, cached half a minute; see the header for what a corrupt value or a failed read answers. */
export async function readConfirmationRuleDocument(client: Client, companyId: string, nowMs: number = Date.now()): Promise<ConfirmationRuleDocument | null> {
  const hit = cache.get(companyId);
  if (hit && nowMs - hit.at >= 0 && nowMs - hit.at < CACHE_MS) return hit.doc;
  let doc: ConfirmationRuleDocument | null;
  try {
    const company = await client.company.findUnique({ where: { id: companyId }, select: { settings: true } });
    const raw = (company?.settings ? JSON.parse(company.settings) : {})[CONFIRMATION_RULE_SETTINGS_KEY];
    if (raw === undefined || raw === null) {
      doc = null;
      lastGood.set(companyId, null);
    } else {
      const parsed = parseConfirmationRuleDocument(raw);
      if (parsed) lastGood.set(companyId, parsed);
      doc = parsed ?? lastGood.get(companyId) ?? null;
    }
  } catch {
    doc = lastGood.get(companyId) ?? null;
  }
  cache.set(companyId, { doc, at: nowMs });
  return doc;
}

/** THE RULE IN FORCE for this company at `nowMs` — the one function the engine will read it through (from the next request on; nothing calls it for that yet). */
export async function readConfirmationRule(client: Client, companyId: string, nowMs: number = Date.now()): Promise<ConfirmationRuleNumbers> {
  return ruleAt(await readConfirmationRuleDocument(client, companyId, nowMs), nowMs).rule;
}

/**
 * Change the stored document under the row lock: `next` gets the document AS STORED NOW (a corrupt value reads as none) and answers the new one, or null to write
 * nothing. The cache learns the result at once.
 */
export async function changeConfirmationRuleDocument(
  companyId: string,
  next: (stored: ConfirmationRuleDocument | null) => ConfirmationRuleDocument | null
): Promise<{ written: boolean; doc: ConfirmationRuleDocument | null }> {
  let written = false;
  const stored = await updateCompanySettings<unknown>(companyId, CONFIRMATION_RULE_SETTINGS_KEY, (raw) => {
    const out = next(parseConfirmationRuleDocument(raw));
    if (!out) return raw;
    written = true;
    return out;
  });
  const doc = parseConfirmationRuleDocument(stored);
  if (written) {
    lastGood.set(companyId, doc);
    cache.set(companyId, { doc, at: Date.now() });
  }
  return { written, doc };
}
