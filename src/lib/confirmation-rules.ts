import { zonedParts } from './business-calendar';
import {
  CONFIRMATION_RULE_DEFAULT,
  validateConfirmationRule,
  type ConfirmationRuleNumbers,
  type RuleStep,
} from './confirmation-rule-settings';
import { CHANNEL_KINDS } from './order-channel-kinds';
import { hhmmToMinutes } from './work-hours';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «قواعد خاصة» — THE OWNER'S OWN RULES OF THE CONFIRMATION DESK, AND THE ONE RESOLVER (request Q4a of the rules plan, 20/11; INERT).
 *
 * The base rule (`confirmation-rule-settings.ts`) is one set of numbers for the whole company. A rule here changes ONE group of numbers for some people, or for some
 * orders, for some time: the table `confirmation_rules` (model `ConfirmationRule`, shaped like `PenaltyRule` / `CommissionRule`) holds them, and `ruleFor` says, for one
 * person and (when given) one order at one moment, which number is in force and which rule it came from.
 *
 * ── NOTHING CALLS `ruleFor` YET (NO_CALLER_FOUND, 20/11) ──
 * Q4b makes the employee numbers act at the pull, Q4d the order numbers at the order's doors, Q4c writes rows from the screen. Until then the table is empty and read by
 * nobody, and `confirmation-rules.test.ts` fails the day a file outside this module imports it without that request removing the pin. The confirmation desk's bundle
 * («طلباتي») is at its ceiling: the desk never imports this file — its words and numbers reach it from the server's answer.
 *
 * ── THE KINDS (the catalogue; a kind not here is a development request, never a free «if/then») ──
 *   EMPLOYEE_NUMBERS  the hand limit and the idle minutes of the people it names (or everyone). Resolved WITHOUT an order (`ruleFor({ person })`), so it names no product,
 *                     channel or phase; it may name a store (the store she works in) and hours of the day.
 *   ORDER_NUMBERS     the schedule of attempts (steps + their different days, as ONE number: they are validated together), the proof seconds and the postpone limit of
 *                     an ORDER — by its product, channel or store. It names nobody (an order's numbers do not change with who presses) and no hours (an order's cycle
 *                     would change under it at a clock line).
 *   PRIORITY          «هالطلبات أول» — by product, channel, store, phase (new / retry) and hours. Names nobody.
 *   ROUTING           «هالطلبات بس لهالموظفات» — the people allowed are its payload, not its «who»; by product, channel, store, phase and hours.
 * The amount of an order is NOT a condition (the owner, 20/11): there is no column for it, and a payload or a scope with any key not listed here is refused.
 *
 * ── MOST SPECIFIC WINS ──
 *   named employees (3) → a product or a channel (2) → a store (1) → the whole company (0) → the base rule.
 * Within one level: the rule naming more conditions, then the later `effectiveFrom`, then the later `createdAt`, then the smaller id — so the answer never depends on the
 * order the rows were read in. Each number is resolved on its own: a rule that sets only the proof seconds leaves the postpone limit to the next rule down.
 *
 * ── REFUSED AT SAVE ──
 * Two ACTIVE rules of the same level that set the same number for the same target — same store, product, channel and phase, at least one person in common, hours that
 * meet and dates that meet — cannot both stand: `overlapRefusal` answers the Arabic sentence naming the other rule (code `RULE_OVERLAP`). The save door (Q4c) asks it.
 *
 * ── PAYLOADS: THE BASE RULE'S OWN VALIDATOR, NEVER A SECOND SET OF RANGES ──
 * A payload's numbers are put on top of the DEFAULT rule and the whole is put through `validateConfirmationRule`, so a rule's hand limit is held to exactly the range the
 * base rule's is. The schedule travels as steps AND their different days together (the validator holds one against the other; with steps from one rule and days from
 * another, a later base edit could make the pair invalid).
 *
 * ── NEVER DELETED ──
 * There is no delete here and no door deletes: a rule is stopped (`isActive: false`) and stays in the history. A row whose stored payload no longer validates is SKIPPED by
 * the resolver (named in `skipped`) — a broken row can only fall back to the base rule, never half-act.
 *
 * ── ZERO ROWS = TODAY ──
 * With no rule that applies, every number is the base rule's (the one `readConfirmationRule` answers), every source is «base», nothing is first and nobody is excluded.
 * `confirmation-rules.test.ts` holds it over random people, orders, moments, time zones and base rules.
 *
 * NOTHING HERE TOUCHES MONEY, ORDER CREATION, A CONTRACT OR THE DATABASE.
 * ═══════════════════════════════════════════════════════════════════════
 */

export const CONFIRMATION_RULE_KINDS = ['EMPLOYEE_NUMBERS', 'ORDER_NUMBERS', 'PRIORITY', 'ROUTING'] as const;
export type ConfirmationRuleKind = (typeof CONFIRMATION_RULE_KINDS)[number];

export const CONFIRMATION_RULE_KIND_AR: Record<ConfirmationRuleKind, string> = {
  EMPLOYEE_NUMBERS: 'أرقام الموظفة',
  ORDER_NUMBERS: 'أرقام الطلب',
  PRIORITY: 'هالطلبات أول',
  ROUTING: 'هالطلبات بس لهالموظفات',
};

export const ORDER_PHASES = ['NEW', 'RETRY'] as const;
export type OrderPhase = (typeof ORDER_PHASES)[number];

/** Every number a rule may set, by the kind that sets it. `schedule` = the steps and their different days, one number. */
export const NUMBERS_OF_KIND = {
  EMPLOYEE_NUMBERS: ['hand', 'idleMinutes'],
  ORDER_NUMBERS: ['schedule', 'proofSeconds', 'postponeMax'],
  PRIORITY: ['first'],
  ROUTING: ['onlyFor'],
} as const satisfies Record<ConfirmationRuleKind, readonly string[]>;
export type RuleNumber = (typeof NUMBERS_OF_KIND)[ConfirmationRuleKind][number];

/** What a payload holds, per kind (after validation). */
export interface RulePayload {
  hand?: number;
  idleMinutes?: number;
  steps?: RuleStep[];
  minDays?: number;
  proofSeconds?: number;
  postponeMax?: number;
  first?: true;
  toUserIds?: string[];
}

/** A row as the table stores it (the fields the resolver and the save check read). `payload` and `userIds` are JSON — validated here, never trusted. */
export interface ConfirmationRuleRow {
  id: string;
  companyId: string;
  storeId: string | null;
  name: string;
  kind: string;
  userIds: unknown;
  productId: string | null;
  channelKind: string | null;
  phase: string | null;
  hoursFrom: string | null;
  hoursTo: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  isActive: boolean;
  payload: unknown;
  createdAt: Date;
}

/** A rule that passed validation: the same fields, with its people and payload read. */
export interface ValidRule extends Omit<ConfirmationRuleRow, 'kind' | 'userIds' | 'payload' | 'phase'> {
  kind: ConfirmationRuleKind;
  /** null = everyone. */
  userIds: string[] | null;
  phase: OrderPhase | null;
  payload: RulePayload;
}

export type RuleCheck = { ok: true; rule: ValidRule } | { ok: false; code: string; field: string; errorAr: string };

const MAX_PEOPLE = 50;
const MAX_NAME = 80;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isDate = (v: unknown): v is Date => v instanceof Date && !Number.isNaN(v.getTime());

function peopleOf(raw: unknown, field: string): { ok: true; ids: string[] } | { ok: false; field: string; errorAr: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, field, errorAr: 'اختار موظفة وحدة على الأقل، أو خلّيها «كل الموظفات».' };
  if (raw.length > MAX_PEOPLE) return { ok: false, field, errorAr: `أكتر شي ${MAX_PEOPLE} موظفة بالقاعدة الوحدة.` };
  if (!raw.every((u) => typeof u === 'string' && u.trim().length > 0 && u === u.trim())) return { ok: false, field, errorAr: 'في اسم موظفة مش مفهوم بالقائمة.' };
  if (new Set(raw).size !== raw.length) return { ok: false, field, errorAr: 'في موظفة مكرّرة بالقائمة.' };
  return { ok: true, ids: [...(raw as string[])] };
}

/** The payload of one kind — its numbers checked by the BASE rule's validator, on top of the default (see the header). */
export function validateRulePayload(kind: ConfirmationRuleKind, raw: unknown): { ok: true; payload: RulePayload } | { ok: false; field: string; errorAr: string } {
  const fail = (field: string, errorAr: string) => ({ ok: false as const, field: `payload.${field}`, errorAr });
  if (!isObject(raw)) return fail('payload', 'القاعدة لازم تقول شو بتغيّر.');
  const allowed: Record<ConfirmationRuleKind, readonly string[]> = {
    EMPLOYEE_NUMBERS: ['hand', 'idleMinutes'],
    ORDER_NUMBERS: ['steps', 'minDays', 'proofSeconds', 'postponeMax'],
    PRIORITY: ['first'],
    ROUTING: ['toUserIds'],
  };
  const keys = Object.keys(raw);
  if (keys.length === 0) return fail('payload', 'القاعدة لازم تغيّر رقم واحد على الأقل.');
  const stranger = keys.find((k) => !allowed[kind].includes(k));
  if (stranger) return fail(stranger, `«${CONFIRMATION_RULE_KIND_AR[kind]}» ما بتغيّر هالخانة — كل قاعدة بتغيّر أرقام نوعها بس.`);

  if (kind === 'PRIORITY') {
    if (raw.first !== true) return fail('first', '«هالطلبات أول» لازم تكون مشغّلة.');
    return { ok: true, payload: { first: true } };
  }
  if (kind === 'ROUTING') {
    const people = peopleOf(raw.toUserIds, 'payload.toUserIds');
    if (!people.ok) return people;
    return { ok: true, payload: { toUserIds: people.ids } };
  }
  if (kind === 'ORDER_NUMBERS' && ('steps' in raw) !== ('minDays' in raw)) {
    return fail('steps', 'جدول المحاولات بينكتب كامل: الخطوات وعلى كم يوم مختلف سوا.');
  }
  // The base rule's validator, on the default with this payload on top: one set of ranges for the base and for every rule.
  const checked = validateConfirmationRule({ ...CONFIRMATION_RULE_DEFAULT, ...raw });
  if (!checked.ok) return fail(checked.field, checked.error);
  const payload: RulePayload = {};
  for (const k of keys) (payload as Record<string, unknown>)[k] = (checked.rule as unknown as Record<string, unknown>)[k];
  return { ok: true, payload };
}

/**
 * THE WHOLE ROW, OR NOTHING — the save door's check (Q4c) and the resolver's (a stored row is read through it too). One Arabic sentence for the first failure, with a
 * stable code and the field it belongs to.
 */
export function validateConfirmationRuleRow(row: ConfirmationRuleRow): RuleCheck {
  const fail = (code: string, field: string, errorAr: string): RuleCheck => ({ ok: false, code, field, errorAr });
  if (!(CONFIRMATION_RULE_KINDS as readonly string[]).includes(row.kind)) return fail('RULE_KIND', 'kind', 'نوع القاعدة مش من الأنواع الأربعة.');
  const kind = row.kind as ConfirmationRuleKind;
  const name = typeof row.name === 'string' ? row.name.trim() : '';
  if (name.length === 0 || name.length > MAX_NAME) return fail('RULE_NAME', 'name', `اسم القاعدة لازم يكون من حرف لـ${MAX_NAME} حرف.`);

  let userIds: string[] | null = null;
  if (row.userIds !== null && row.userIds !== undefined) {
    const people = peopleOf(row.userIds, 'userIds');
    if (!people.ok) return fail('RULE_PEOPLE', people.field, people.errorAr);
    userIds = people.ids;
  }
  if (userIds && kind !== 'EMPLOYEE_NUMBERS') {
    return fail('RULE_SCOPE', 'userIds', 'بس «أرقام الموظفة» بتنكتب لموظفات بالاسم — هالنوع بيمشي على الطلبات، مش على الموظفات.');
  }
  if (kind === 'EMPLOYEE_NUMBERS' && (row.productId || row.channelKind || row.phase)) {
    return fail('RULE_SCOPE', 'productId', '«أرقام الموظفة» ما بتتعلّق بمنتج ولا بمصدر ولا بنوع الطلب — هي أرقامها هي.');
  }
  if (kind === 'ORDER_NUMBERS' && row.phase) return fail('RULE_SCOPE', 'phase', '«أرقام الطلب» بتمشي على الطلب من أوّله لآخره — ما بتنقسم جديد وإعادة.');
  if (row.channelKind !== null && !(CHANNEL_KINDS as readonly string[]).includes(row.channelKind)) return fail('RULE_CHANNEL', 'channelKind', 'مصدر الطلب مش من المصادر المعروفة.');
  if (row.phase !== null && !(ORDER_PHASES as readonly string[]).includes(row.phase)) return fail('RULE_PHASE', 'phase', 'نوع الطلب لازم يكون «جديد» أو «إعادة».');
  for (const [k, v] of [['storeId', row.storeId], ['productId', row.productId]] as const) {
    if (v !== null && (typeof v !== 'string' || v.trim().length === 0)) return fail('RULE_SCOPE', k, 'في خانة من «على أي طلبات» فاضية.');
  }

  if ((row.hoursFrom === null) !== (row.hoursTo === null)) return fail('RULE_HOURS', 'hoursFrom', 'الساعات بتنكتب من وإلى سوا.');
  if (row.hoursFrom !== null) {
    if (kind === 'ORDER_NUMBERS') return fail('RULE_HOURS', 'hoursFrom', '«أرقام الطلب» ما بتتغيّر حسب الساعة — الطلب بيكمّل دورته على نفس الأرقام.');
    const from = hhmmToMinutes(row.hoursFrom);
    const to = hhmmToMinutes(row.hoursTo);
    if (from === null || to === null) return fail('RULE_HOURS', 'hoursFrom', 'الساعة بتنكتب ساعة ودقيقة متل 17:00.');
    if (from === to) return fail('RULE_HOURS', 'hoursTo', 'ساعة البداية والنهاية لازم يختلفوا.');
  }

  if (!isDate(row.effectiveFrom)) return fail('RULE_DATES', 'effectiveFrom', 'لازم تاريخ بداية للقاعدة.');
  if (row.effectiveTo !== null && (!isDate(row.effectiveTo) || row.effectiveTo.getTime() <= row.effectiveFrom.getTime())) {
    return fail('RULE_DATES', 'effectiveTo', 'تاريخ النهاية لازم يكون بعد تاريخ البداية.');
  }

  const payload = validateRulePayload(kind, row.payload);
  if (!payload.ok) return fail('RULE_PAYLOAD', payload.field, payload.errorAr);

  return {
    ok: true,
    rule: { ...row, name, kind, userIds, phase: row.phase as OrderPhase | null, payload: payload.payload },
  };
}

/* ─────────────────────────── matching ─────────────────────────── */

/** The level of a rule: who it is most specifically about (see the header). */
export function ruleLevel(rule: Pick<ValidRule, 'userIds' | 'productId' | 'channelKind' | 'storeId'>): 0 | 1 | 2 | 3 {
  if (rule.userIds) return 3;
  if (rule.productId || rule.channelKind) return 2;
  if (rule.storeId) return 1;
  return 0;
}

function conditionCount(rule: ValidRule): number {
  return [rule.userIds, rule.storeId, rule.productId, rule.channelKind, rule.phase, rule.hoursFrom].filter((v) => v !== null).length;
}

/** The minutes of the day a window covers, as [from, to) pieces; null = the whole day. A window whose end is before its start runs through midnight. */
function windowPieces(from: string | null, to: string | null): [number, number][] {
  if (from === null || to === null) return [[0, 1440]];
  const a = hhmmToMinutes(from)!;
  const b = hhmmToMinutes(to)!;
  return a < b ? [[a, b]] : [[a, 1440], [0, b]];
}

function inForce(rule: ValidRule, now: Date, timezone: string): boolean {
  const t = now.getTime();
  if (!rule.isActive || t < rule.effectiveFrom.getTime() || (rule.effectiveTo && t >= rule.effectiveTo.getTime())) return false;
  if (rule.hoursFrom === null) return true;
  const p = zonedParts(now, timezone);
  const m = p.hour * 60 + p.minute;
  return windowPieces(rule.hoursFrom, rule.hoursTo).some(([a, b]) => m >= a && m < b);
}

/** The person asked about: who she is and the store she is working in. */
export interface RulePerson {
  id: string;
  storeId: string | null;
}

/** The order asked about: its store, the products of its CURRENT lines, its channel's kind and whether it is new or a retry. */
export interface RuleOrder {
  storeId: string | null;
  productIds: readonly string[];
  channelKind: string | null;
  phase: OrderPhase | null;
}

function appliesToPerson(rule: ValidRule, person: RulePerson): boolean {
  if (rule.kind !== 'EMPLOYEE_NUMBERS') return false;
  if (rule.userIds && !rule.userIds.includes(person.id)) return false;
  return rule.storeId === null || rule.storeId === person.storeId;
}

function appliesToOrder(rule: ValidRule, order: RuleOrder): boolean {
  if (rule.kind === 'EMPLOYEE_NUMBERS') return false;
  if (rule.storeId !== null && rule.storeId !== order.storeId) return false;
  if (rule.productId !== null && !order.productIds.includes(rule.productId)) return false;
  if (rule.channelKind !== null && rule.channelKind !== order.channelKind) return false;
  return rule.phase === null || rule.phase === order.phase;
}

/** Which rule wins among those that set one number: higher level, then more conditions, later start, later creation, smaller id. */
function better(a: ValidRule, b: ValidRule): ValidRule {
  const keys: [number, number][] = [
    [ruleLevel(a), ruleLevel(b)],
    [conditionCount(a), conditionCount(b)],
    [a.effectiveFrom.getTime(), b.effectiveFrom.getTime()],
    [a.createdAt.getTime(), b.createdAt.getTime()],
  ];
  for (const [x, y] of keys) if (x !== y) return x > y ? a : b;
  return a.id < b.id ? a : b;
}

function setsNumber(rule: ValidRule, n: RuleNumber): boolean {
  const p = rule.payload;
  switch (n) {
    case 'hand': return p.hand !== undefined;
    case 'idleMinutes': return p.idleMinutes !== undefined;
    case 'schedule': return p.steps !== undefined;
    case 'proofSeconds': return p.proofSeconds !== undefined;
    case 'postponeMax': return p.postponeMax !== undefined;
    case 'first': return p.first === true;
    case 'onlyFor': return p.toUserIds !== undefined;
  }
}

/* ─────────────────────────── the resolver ─────────────────────────── */

export type RuleSource = { from: 'BASE' } | { from: 'RULE'; ruleId: string; name: string; level: 0 | 1 | 2 | 3 };
export interface Sourced<T> {
  value: T;
  source: RuleSource;
}

export interface EffectiveRule {
  hand: Sourced<number>;
  idleMinutes: Sourced<number>;
  schedule: Sourced<{ steps: RuleStep[]; minDays: number }>;
  proofSeconds: Sourced<number>;
  postponeMax: Sourced<number>;
  /** «هالطلبات أول». */
  first: Sourced<boolean>;
  /** «هالطلبات بس لهالموظفات» — null = anyone may take it. */
  onlyFor: Sourced<string[] | null>;
  /** The base rule with every number above in place — what a door hands to the pure rules. */
  numbers: ConfirmationRuleNumbers;
  /** Rows that apply to nothing because their stored form no longer validates (ids only). */
  skipped: string[];
}

export interface RuleContext {
  companyId: string;
  /** The base rule in force (`readConfirmationRule`). */
  base: ConfirmationRuleNumbers;
  /** The store's timezone, for rules with hours. */
  timezone: string;
  rules: readonly ConfirmationRuleRow[];
}

/**
 * THE NUMBERS IN FORCE for `person` (and `order`, when given) at `now`, each with the rule it came from. Without an order, the order's numbers are the base rule's.
 * Pure: the rows are read by the caller (Q4b).
 */
export function ruleFor(ask: { person: RulePerson; order?: RuleOrder | null; now: Date }, ctx: RuleContext): EffectiveRule {
  const { person, order, now } = ask;
  const skipped: string[] = [];
  const live: ValidRule[] = [];
  for (const row of ctx.rules) {
    if (row.companyId !== ctx.companyId) continue;
    const checked = validateConfirmationRuleRow(row);
    if (!checked.ok) {
      skipped.push(row.id);
      continue;
    }
    const r = checked.rule;
    if (!inForce(r, now, ctx.timezone)) continue;
    if (appliesToPerson(r, person) || (order && appliesToOrder(r, order))) live.push(r);
  }

  const pick = (n: RuleNumber): ValidRule | null => live.filter((r) => setsNumber(r, n)).reduce<ValidRule | null>((best, r) => (best ? better(best, r) : r), null);
  const source = (r: ValidRule | null): RuleSource => (r ? { from: 'RULE', ruleId: r.id, name: r.name, level: ruleLevel(r) } : { from: 'BASE' });
  const base = ctx.base;

  const hand = pick('hand');
  const idle = pick('idleMinutes');
  const schedule = pick('schedule');
  const proof = pick('proofSeconds');
  const postpone = pick('postponeMax');
  const first = pick('first');
  const onlyFor = pick('onlyFor');

  const out = {
    hand: { value: hand ? hand.payload.hand! : base.hand, source: source(hand) },
    idleMinutes: { value: idle ? idle.payload.idleMinutes! : base.idleMinutes, source: source(idle) },
    schedule: {
      value: schedule ? { steps: schedule.payload.steps!, minDays: schedule.payload.minDays! } : { steps: base.steps, minDays: base.minDays },
      source: source(schedule),
    },
    proofSeconds: { value: proof ? proof.payload.proofSeconds! : base.proofSeconds, source: source(proof) },
    postponeMax: { value: postpone ? postpone.payload.postponeMax! : base.postponeMax, source: source(postpone) },
    first: { value: first !== null, source: source(first) },
    onlyFor: { value: onlyFor ? [...onlyFor.payload.toUserIds!] : null, source: source(onlyFor) },
  };
  const numbers: ConfirmationRuleNumbers = {
    ...base,
    hand: out.hand.value,
    idleMinutes: out.idleMinutes.value,
    steps: out.schedule.value.steps,
    minDays: out.schedule.value.minDays,
    proofSeconds: out.proofSeconds.value,
    postponeMax: out.postponeMax.value,
  };
  return { ...out, numbers, skipped };
}

/* ─────────────────────────── refused at save ─────────────────────────── */

const intersects = (a: [number, number][], b: [number, number][]) => a.some(([a0, a1]) => b.some(([b0, b1]) => a0 < b1 && b0 < a1));

/**
 * The refusal of saving `candidate` beside `existing`, or null. Asked by the save door (Q4c) with the company's rows; a stopped candidate is never refused (stopping is
 * always allowed), and a row compared with itself (an edit) is skipped. Rows of another company never count.
 */
export function overlapRefusal(candidate: ValidRule, existing: readonly ConfirmationRuleRow[]): { code: 'RULE_OVERLAP'; otherRuleId: string; errorAr: string } | null {
  if (!candidate.isActive) return null;
  const numbers = NUMBERS_OF_KIND[candidate.kind].filter((n) => setsNumber(candidate, n));
  for (const row of existing) {
    if (row.id === candidate.id || row.companyId !== candidate.companyId || !row.isActive) continue;
    const checked = validateConfirmationRuleRow(row);
    if (!checked.ok) continue;
    const other = checked.rule;
    if (other.kind !== candidate.kind || ruleLevel(other) !== ruleLevel(candidate)) continue;
    if (!numbers.some((n) => setsNumber(other, n))) continue;
    if (other.storeId !== candidate.storeId || other.productId !== candidate.productId || other.channelKind !== candidate.channelKind || other.phase !== candidate.phase) continue;
    if (candidate.userIds && other.userIds && !candidate.userIds.some((u) => other.userIds!.includes(u))) continue;
    if (!intersects(windowPieces(candidate.hoursFrom, candidate.hoursTo), windowPieces(other.hoursFrom, other.hoursTo))) continue;
    const aEnd = candidate.effectiveTo?.getTime() ?? Infinity;
    const bEnd = other.effectiveTo?.getTime() ?? Infinity;
    if (!(candidate.effectiveFrom.getTime() < bEnd && other.effectiveFrom.getTime() < aEnd)) continue;
    return {
      code: 'RULE_OVERLAP',
      otherRuleId: other.id,
      errorAr: `في قاعدة تانية «${other.name}» بتغيّر نفس الرقم لنفس الطلبات أو الموظفات بنفس الوقت — عدّلها أو وقّفها أول.`,
    };
  }
  return null;
}

/* ─────────────────────────── the ready templates ─────────────────────────── */

/** What the owner chooses before a template can be turned on. */
export type TemplateBlank = 'userIds' | 'productId' | 'storeId' | 'toUserIds';

export interface RuleTemplate {
  key: string;
  name: string;
  kind: ConfirmationRuleKind;
  /** The scope as shipped; the blanks are filled on the screen. */
  scope: { channelKind?: string; phase?: OrderPhase; hoursFrom?: string; hoursTo?: string };
  payload: RulePayload;
  needs: readonly TemplateBlank[];
  /** A suggested length, in days, from the moment it is turned on; null = until stopped. */
  days: number | null;
}

const b = CONFIRMATION_RULE_DEFAULT.steps;
/**
 * «قوالب جاهزة» — the eight example rules the owner was shown (20/11), as DATA. None is a row: nothing is written until he presses one on (Q4c), and each is OFF until
 * then. Every one, its blanks filled, passes `validateConfirmationRuleRow` (the test holds it), so a template can never be a rule the resolver would skip.
 */
export const CONFIRMATION_RULE_TEMPLATES: readonly RuleTemplate[] = Object.freeze([
  { key: 'new-employee-hand', name: 'الموظفة الجديدة: حد اليد 2', kind: 'EMPLOYEE_NUMBERS', scope: {}, payload: { hand: 2 }, needs: ['userIds'], days: 7 },
  { key: 'evening-idle', name: 'دوام المسا: مهلة الطلب المتروك 30 دقيقة', kind: 'EMPLOYEE_NUMBERS', scope: { hoursFrom: '17:00', hoursTo: '23:00' }, payload: { idleMinutes: 30 }, needs: [], days: null },
  {
    key: 'expensive-product-attempts', name: 'منتج غالي: 7 محاولات', kind: 'ORDER_NUMBERS', scope: {},
    payload: { steps: [...b, b[2], b[3]], minDays: CONFIRMATION_RULE_DEFAULT.minDays }, needs: ['productId'], days: null,
  },
  {
    key: 'page-leads-attempts', name: 'طلبات صفحات الهبوط: 3 محاولات', kind: 'ORDER_NUMBERS', scope: { channelKind: 'LANDING_PAGE' },
    payload: { steps: [b[0], b[2]], minDays: CONFIRMATION_RULE_DEFAULT.minDays }, needs: [], days: null,
  },
  { key: 'store-proof', name: 'متجر: إثبات الاتصال 20 ثانية', kind: 'ORDER_NUMBERS', scope: {}, payload: { proofSeconds: 20 }, needs: ['storeId'], days: null },
  { key: 'product-postpone-once', name: 'منتج: تأجيل الزبون مرة وحدة', kind: 'ORDER_NUMBERS', scope: {}, payload: { postponeMax: 1 }, needs: ['productId'], days: null },
  { key: 'product-first', name: 'منتج: طلباته أول', kind: 'PRIORITY', scope: {}, payload: { first: true }, needs: ['productId'], days: null },
  { key: 'store-to-its-team', name: 'متجر: طلباته بس لموظفاته', kind: 'ROUTING', scope: {}, payload: { toUserIds: [] }, needs: ['storeId', 'toUserIds'], days: null },
] satisfies RuleTemplate[]);
