import type { Prisma } from '@prisma/client';
import type { db } from './db';
import type { BusinessCalendar } from './business-calendar';
import { CONFIRMATION_RULE_DEFAULT, CONFIRMATION_RULE_RANGES, confirmationRuleOnce, type ConfirmationRuleNumbers, type RuleNow, type RuleStep } from './confirmation-rule-settings';
import {
  CONFIRMATION_RULE_KIND_AR,
  CONFIRMATION_RULE_TEMPLATES,
  NUMBERS_OF_KIND,
  PULL_PACE_RANGE,
  ruleFor,
  ruleLevel,
  validateConfirmationRuleRow,
  type ConfirmationRuleKind,
  type ConfirmationRuleRow,
  type RulePayload,
  type ValidRule,
  ROUTING_FALLBACK,
} from './confirmation-rules';
import { mustHoldToWork, readReturnsMode } from './confirmation-queue';
import { cadenceSince } from './no-answer-cadence-switch';
import { queuePrioritySwitch } from './queue-priority-switch';
import { roundsSwitch } from './no-answer-rounds-switch';
import { callProofOn } from './call-proof-switch';
import { employeeNumbersOf, numbersAnswer, readConfirmationRules } from './employee-numbers';
import { CHANNEL_KIND_AR } from './order-channel-kinds';
import { DESK_KEYS, deskReadiness, type DeskReadiness } from './desk-readiness';
import { resolveAudience } from './notification-audience';
import { can, hasFullAccess } from './authorization';

type Client = Prisma.TransactionClient | typeof db;

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «قواعد خاصة» ON THE RULES PAGE — WHAT THE SCREEN'S DOORS SAY AND CHECK (request Q4c of the rules plan, 21/11).
 *
 * `confirmation-rules.ts` holds the table's rows, their validator, the resolver and the eight ready templates; `employee-numbers.ts` reads the rows for the doors that
 * act. This file is what the rules page's doors (`/api/confirmation/rules`, `…/[id]`, `…/preview`) add on top: the body of a save read into a row, the preview «مين
 * بتمسك ومين لا — وليش», the words of a row, and whether a number acts right now. The screen decides nothing: every word it shows is written here.
 *
 * ── ONLY A KIND THAT ACTS CAN BE SAVED ──
 * A rule that looks on and binds nobody is the owner's fear (18/11). The employee numbers act (Q4b) and the order numbers (Q4d, 21/11); the priority and the routing act with
 * Q5 — until then the door refuses them (`RULE_KIND_NOT_ACTING`) and the screen shows their templates greyed with the reason. Each stage adds its kind to
 * `KINDS_THAT_ACT`, one line.
 *
 * ── THE ORDER NUMBERS ON THE SCREEN (Q4d) ──
 * They name no person and no hours (the validator refuses both): the dialog asks «على أي طلبات» — a store, a product, a channel — instead. The schedule is offered as ONE
 * number, the attempts (3–7), turned here into steps by `scheduleOfAttempts` — the very steps of the two ready templates — so the owner never types a step. Their
 * preview names whoever works the orders they touch (logs a call · confirms or postpones), whether each number acts now, and a rule more specific on some orders.
 *
 * ── THE PREVIEW IS THE ENGINE'S, NEVER A ROLE TEMPLATE'S ──
 * The people are built by the door exactly as a session builds them (`resolveAudience` → `computeEffectiveGrants` → `can` → `deskReadiness`), and who wins between two
 * rules is asked of the real resolver (`ruleFor`). Per person and per number the reasons are, in order: not named · the number never reaches her (she does not pull, or
 * no order can be in her hands) · the number does not act right now (the switches it rides on are off) · a more specific rule wins.
 *
 * NOTHING HERE WRITES, TOUCHES MONEY, ORDER CREATION OR A CONTRACT.
 * ═══════════════════════════════════════════════════════════════════════
 */

/** The kinds a save may write today. Q4d added 'ORDER_NUMBERS' (21/11); Q5 adds 'PRIORITY' and 'ROUTING'. */
export const KINDS_THAT_ACT: readonly ConfirmationRuleKind[] = Object.freeze(['EMPLOYEE_NUMBERS', 'ORDER_NUMBERS']);

export const NOT_ACTING_YET_AR = '«هالطلبات أول» و«هالطلبات بس لهالموظفات» لسا ما بتشتغل بالمكتب — بتنفتح هون لما تنبني مرحلتها.';
export const NOT_ACTING_SHORT_AR = 'لسا ما بتشتغل — بتنفتح لما تنبني مرحلتها';

/** One number a rule may set, as the dialog offers it. */
export interface OwnRuleNumber {
  key: 'hand' | 'idleMinutes' | 'pullPerHour' | 'attempts' | 'proofSeconds' | 'postponeMax';
  kind: ConfirmationRuleKind;
  label: string;
  unit: string;
  range: { min: number; max: number };
}

/** The attempts an order rule may give (Q4d): the base rule's own range of steps, plus the first press. */
export const ATTEMPTS_RANGE = Object.freeze({ min: CONFIRMATION_RULE_RANGES.steps.min + 1, max: CONFIRMATION_RULE_RANGES.steps.max + 1 });

/**
 * THE STEPS OF N ATTEMPTS (Q4d) — built from the DEFAULT rule's four steps (after 30 min · after 2 h · the morning anchor · the evening anchor), so an order rule
 * keeps the owner's rhythm: fewer attempts drop the second «after» and then the evening, more repeat the next day's two anchors. The days stay the default's (two):
 * every list here holds at least one anchor, so the validator's «days ≤ anchors + 1» always holds. 7 and 3 are exactly the two ready templates' steps.
 */
export function scheduleOfAttempts(n: number): { steps: RuleStep[]; minDays: number } | null {
  if (!Number.isInteger(n) || n < ATTEMPTS_RANGE.min || n > ATTEMPTS_RANGE.max) return null;
  const [a1, a2, morning, evening] = CONFIRMATION_RULE_DEFAULT.steps;
  const lists: Record<number, RuleStep[]> = {
    3: [a1, morning],
    4: [a1, a2, morning],
    5: [a1, a2, morning, evening],
    6: [a1, a2, morning, evening, morning],
    7: [a1, a2, morning, evening, morning, evening],
  };
  return { steps: lists[n].map((s) => ({ ...s })), minDays: CONFIRMATION_RULE_DEFAULT.minDays };
}

export const OWN_RULE_NUMBERS: readonly OwnRuleNumber[] = Object.freeze([
  { key: 'hand', kind: 'EMPLOYEE_NUMBERS', label: 'حد اليد (كم طلب بإيدها)', unit: 'طلب', range: CONFIRMATION_RULE_RANGES.hand },
  { key: 'idleMinutes', kind: 'EMPLOYEE_NUMBERS', label: 'مهلة الطلب المتروك', unit: 'دقيقة دوام', range: CONFIRMATION_RULE_RANGES.idleMinutes },
  { key: 'pullPerHour', kind: 'EMPLOYEE_NUMBERS', label: 'سرعة السحب', unit: 'طلب بالساعة', range: PULL_PACE_RANGE },
  { key: 'attempts', kind: 'ORDER_NUMBERS', label: 'عدد محاولات «لا يرد»', unit: 'محاولات', range: ATTEMPTS_RANGE },
  { key: 'proofSeconds', kind: 'ORDER_NUMBERS', label: 'ثواني إثبات الاتصال', unit: 'ثانية', range: CONFIRMATION_RULE_RANGES.proofSeconds },
  { key: 'postponeMax', kind: 'ORDER_NUMBERS', label: 'حد تأجيل الزبون', unit: 'مرات', range: CONFIRMATION_RULE_RANGES.postponeMax },
] satisfies OwnRuleNumber[]);

const numberLabel = (key: string) => OWN_RULE_NUMBERS.find((n) => n.key === key)?.label ?? key;

/** A rule's length, in days from its start; null = until stopped. */
export const RULE_DAYS = Object.freeze({ min: 1, max: 90 });
const DAY_MS = 86_400_000;

/* ─────────────────────────── the words of a row ─────────────────────────── */

/** What a payload changes, one phrase per number. `nameOf` names a person (routing), or answers null when the viewer may not see names. */
export function payloadWords(p: RulePayload, nameOf: (id: string) => string | null = () => null): string[] {
  const out: string[] = [];
  if (p.hand !== undefined) out.push(`حد اليد ${p.hand}`);
  if (p.idleMinutes !== undefined) out.push(`مهلة المتروك ${p.idleMinutes} دقيقة دوام`);
  if (p.pullPerHour !== undefined) out.push(`سرعة السحب ${p.pullPerHour} طلب بالساعة`);
  if (p.steps !== undefined) out.push(`${p.steps.length + 1} محاولات على ${p.minDays ?? 1} يوم`);
  if (p.proofSeconds !== undefined) out.push(`إثبات الاتصال ${p.proofSeconds} ثانية`);
  if (p.postponeMax !== undefined) out.push(`تأجيل الزبون ${p.postponeMax} مرات`);
  if (p.first) out.push('طلباتها أول');
  if (p.toUserIds !== undefined) {
    const names = p.toUserIds.map(nameOf);
    out.push(p.toUserIds.length === 0 ? 'بس لموظفات بتختارهن' : names.every((n) => n) ? `بس لـ${names.join('، ')}` : `بس لـ${p.toUserIds.length} موظفات`);
    // Request Q5b: the number that keeps an order from waiting for nobody, said with the rule (its default when the rule sets none).
    out.push(`وإذا ما في حدا منهن بيقدر يسحب: للكل بعد ${p.fallbackMinutes ?? ROUTING_FALLBACK.defaultMinutes} دقيقة دوام`);
  }
  return out;
}

export interface ScopeNames {
  person: (id: string) => string | null;
  store: (id: string) => string | null;
  product: (id: string) => string | null;
}

/** On whom and on which orders, in words: who · store · product · channel · new or retry · hours. */
export function scopeWords(r: Pick<ValidRule, 'userIds' | 'storeId' | 'productId' | 'channelKind' | 'phase' | 'hoursFrom' | 'hoursTo'>, names: ScopeNames): string[] {
  const out: string[] = [];
  if (r.userIds) {
    const n = r.userIds.map(names.person);
    out.push(n.every((x) => x) ? `على: ${n.join('، ')}` : `على ${r.userIds.length} موظفات بالاسم`);
  } else {
    out.push('على كل الموظفات');
  }
  out.push(r.storeId ? `بمتجر ${names.store(r.storeId) ?? 'محذوف'}` : 'بكل المتاجر');
  if (r.productId) out.push(`منتج ${names.product(r.productId) ?? 'محذوف'}`);
  if (r.channelKind) out.push(`مصدر ${CHANNEL_KIND_AR[r.channelKind] ?? r.channelKind}`);
  if (r.phase) out.push(r.phase === 'NEW' ? 'الطلبات الجديدة' : 'طلبات الإعادة');
  if (r.hoursFrom && r.hoursTo) out.push(`من الساعة ${r.hoursFrom} لـ${r.hoursTo}`);
  return out;
}

export type OwnRuleState = 'ACTIVE' | 'PENDING' | 'ENDED' | 'STOPPED';
export const OWN_RULE_STATE_AR: Record<OwnRuleState, string> = {
  ACTIVE: 'شغّالة',
  PENDING: 'لسا ما بلّشت',
  ENDED: 'خلصت مدتها',
  STOPPED: 'موقوفة',
};

export function ruleState(r: Pick<ConfirmationRuleRow, 'isActive' | 'effectiveFrom' | 'effectiveTo'>, nowMs: number): OwnRuleState {
  if (!r.isActive) return 'STOPPED';
  if (r.effectiveTo && r.effectiveTo.getTime() <= nowMs) return 'ENDED';
  if (r.effectiveFrom.getTime() > nowMs) return 'PENDING';
  return 'ACTIVE';
}

/* ─────────────────────────── the body of a save ─────────────────────────── */

export type Refusal = { ok: false; code: string; field: string; errorAr: string };
const refuse = (code: string, field: string, errorAr: string): Refusal => ({ ok: false, code, field, errorAr });
export const START_CHOICES = ['NOW', 'NEXT_WORK_START'] as const;
export type StartChoice = (typeof START_CHOICES)[number];

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const optString = (v: unknown): string | null | undefined => (v === undefined || v === null || v === '' ? null : typeof v === 'string' ? v.trim() || null : undefined);

/** The end of a rule `days` after `from`, or null; a refusal when `days` is not a whole number in `RULE_DAYS`. */
export function endAfter(from: Date, days: unknown): { ok: true; to: Date | null } | Refusal {
  if (days === undefined || days === null || days === '') return { ok: true, to: null };
  if (typeof days !== 'number' || !Number.isInteger(days) || days < RULE_DAYS.min || days > RULE_DAYS.max) {
    return refuse('RULE_DATES', 'days', `المدة لازم تكون من ${RULE_DAYS.min} لـ${RULE_DAYS.max} يوم، أو تتركها فاضية (لحد ما توقّفها).`);
  }
  return { ok: true, to: new Date(from.getTime() + days * DAY_MS) };
}

/** When a rule starts: now, or the store's next start of work (the default — the owner's decision R5). */
export function startOf(raw: unknown, nowMs: number, nextWorkStart: Date): { ok: true; from: Date; start: StartChoice } | Refusal {
  const start = raw === undefined || raw === null ? 'NEXT_WORK_START' : raw;
  if (!(START_CHOICES as readonly unknown[]).includes(start)) return refuse('RULE_DATES', 'start', 'البداية لازم تكون «هلق» أو «من بداية الدوام الجاي».');
  return { ok: true, from: start === 'NOW' ? new Date(nowMs) : nextWorkStart, start: start as StartChoice };
}

/**
 * THE BODY OF A SAVE (or a preview), read into a row and checked WHOLE by the table's own validator. The moment is the server's: `start` and `days` are turned into
 * dates here. A kind that does not act yet is refused before anything else is read.
 */
export function candidateFromBody(
  body: unknown,
  ctx: { companyId: string; userId: string; nowMs: number; nextWorkStart: Date; id?: string }
): { ok: true; row: ConfirmationRuleRow & { createdById: string }; rule: ValidRule; start: StartChoice; days: number | null } | Refusal {
  if (!isObject(body)) return refuse('RULE_BODY', 'body', 'الطلب فاضي — عبّي القاعدة وجرّب.');
  if (typeof body.kind !== 'string' || !(KINDS_THAT_ACT as readonly string[]).includes(body.kind)) {
    if (typeof body.kind === 'string' && body.kind in CONFIRMATION_RULE_KIND_AR) {
      return refuse('RULE_KIND_NOT_ACTING', 'kind', `«${CONFIRMATION_RULE_KIND_AR[body.kind as ConfirmationRuleKind]}» ${NOT_ACTING_SHORT_AR}.`);
    }
    return refuse('RULE_KIND', 'kind', 'اختار شو بتغيّر القاعدة.');
  }
  const fields: Record<string, string | null> = {};
  for (const k of ['storeId', 'productId', 'channelKind', 'phase', 'hoursFrom', 'hoursTo'] as const) {
    const v = optString(body[k]);
    if (v === undefined) return refuse('RULE_SCOPE', k, 'في خانة مش مفهومة بالقاعدة.');
    fields[k] = v;
  }
  // The attempts (Q4d): one number on the screen, the steps of `scheduleOfAttempts` in the row — so the stored payload is the one the resolver and the validator know.
  let payloadIn: unknown = body.payload;
  if (body.kind === 'ORDER_NUMBERS' && isObject(body.payload) && 'attempts' in body.payload) {
    const { attempts, ...rest } = body.payload;
    const schedule = typeof attempts === 'number' ? scheduleOfAttempts(attempts) : null;
    if (!schedule) return refuse('RULE_PAYLOAD', 'payload.attempts', `عدد المحاولات لازم يكون رقم صحيح من ${ATTEMPTS_RANGE.min} لـ${ATTEMPTS_RANGE.max}.`);
    payloadIn = { ...rest, ...schedule };
  }
  // A ready template's blanks are the owner's to fill (Q4d): «منتج غالي» saved with no product would give EVERY order seven attempts.
  const template = CONFIRMATION_RULE_TEMPLATES.find((t) => t.key === templateKeyOf(body.templateKey));
  for (const need of template?.needs ?? []) {
    if (need === 'productId' && !fields.productId) return refuse('RULE_TEMPLATE_BLANK', 'productId', 'هالقالب بدّو تختار المنتج.');
    if (need === 'storeId' && !fields.storeId) return refuse('RULE_TEMPLATE_BLANK', 'storeId', 'هالقالب بدّو تختار المتجر.');
  }
  const start = startOf(body.start, ctx.nowMs, ctx.nextWorkStart);
  if (!start.ok) return start;
  const end = endAfter(start.from, body.days);
  if (!end.ok) return end;

  const row: ConfirmationRuleRow & { createdById: string } = {
    id: ctx.id ?? '',
    companyId: ctx.companyId,
    storeId: fields.storeId,
    name: typeof body.name === 'string' ? body.name : '',
    kind: body.kind,
    userIds: body.userIds === undefined ? null : body.userIds,
    productId: fields.productId,
    channelKind: fields.channelKind,
    phase: fields.phase,
    hoursFrom: fields.hoursFrom,
    hoursTo: fields.hoursTo,
    effectiveFrom: start.from,
    effectiveTo: end.to,
    isActive: true,
    payload: payloadIn,
    createdAt: new Date(ctx.nowMs),
    createdById: ctx.userId,
  };
  const checked = validateConfirmationRuleRow(row);
  if (!checked.ok) return checked;
  return { ok: true, row: { ...row, name: checked.rule.name }, rule: checked.rule, start: start.start, days: typeof body.days === 'number' ? body.days : null };
}

/* ─────────────────────────── does a number act right now ─────────────────────────── */

export interface NumbersInForce {
  hand: boolean;
  idleMinutes: boolean;
  pullPerHour: boolean;
}

/**
 * Whether each employee number acts RIGHT NOW in this company — read with the very functions the pull reads (`readReturnsMode`, `returnsLimits`' own switches): the
 * hand and the idle minutes are the rule's only where the returns mode is on AND «إثبات المكالمات وجدول المحاولات» or «أولوية الطابور» is on; otherwise the pull uses
 * the mode's own figures or the cap, whatever a rule says. The pace acts always.
 */
export async function numbersInForce(client: Client, companyId: string, now: Date, calendar: BusinessCalendar, rule?: RuleNow): Promise<NumbersInForce> {
  const rounds = await roundsSwitch(client, companyId, now.getTime());
  const returns = await readReturnsMode(client, companyId, { now, calendar: () => calendar, rounds, rule });
  if (!returns) return { hand: false, idleMinutes: false, pullPerHour: true };
  const fromRule = !!(await cadenceSince(client, companyId)) || (await queuePrioritySwitch(client, companyId, now.getTime())).enabled;
  return { hand: fromRule, idleMinutes: fromRule, pullPerHour: true };
}

export const NOT_IN_FORCE_AR = 'ما بيشتغل هلق — حد اليد ومهلة المتروك بيمشوا بس لما يكون «إثبات المكالمات وجدول المحاولات» أو «أولوية الطابور» شغّال.';

/** Whether each ORDER number acts right now (Q4d) — the switches the doors ask before they read it. */
export interface OrderNumbersInForce {
  schedule: boolean;
  proofSeconds: boolean;
  postponeMax: boolean;
}

/**
 * Read with the doors' own switches: the steps and their days are the plan's (`cadenceSince` — the contact door builds the plan only with it), the proof seconds the
 * proof's (`callProofOn`), the postpone cap the confirmation door's (the plan or «أولوية الطابور»).
 */
export async function orderNumbersInForce(client: Client, companyId: string, now: Date): Promise<OrderNumbersInForce> {
  const plan = !!(await cadenceSince(client, companyId));
  const proof = await callProofOn(client, companyId);
  const priority = plan || (await queuePrioritySwitch(client, companyId, now.getTime())).enabled;
  return { schedule: plan, proofSeconds: proof, postponeMax: priority };
}

export const ORDER_NOT_IN_FORCE_AR: Record<keyof OrderNumbersInForce, string> = {
  schedule: 'ما بيشتغل هلق — عدد المحاولات بيمشي بس لما يكون «إثبات المكالمات وجدول المحاولات» شغّال.',
  proofSeconds: 'ما بيشتغل هلق — ثواني الإثبات بتمشي بس لما يكون «إثبات المكالمات وجدول المحاولات» شغّال.',
  postponeMax: 'ما بيشتغل هلق — حد التأجيل بيمشي بس لما يكون «إثبات المكالمات وجدول المحاولات» أو «أولوية الطابور» شغّال.',
};

/** The store's calendar as the pull reads it. */
export function calendarOf(country: { timezone: string; workHoursStart?: string | null; workHoursEnd?: string | null; weekendDays?: readonly number[] | null }): BusinessCalendar {
  return {
    workHoursStart: country.workHoursStart,
    workHoursEnd: country.workHoursEnd,
    weekendDays: country.weekendDays,
    timezone: country.timezone,
  } as BusinessCalendar;
}

/**
 * The numbers of every person on the rules page («مين مربوطة»): each one's three numbers with the rule they came from (the same resolver the pull asks), and whether
 * each acts right now. A read that fails answers null — the list of people never breaks for it.
 */
export async function deskNumbers(
  client: Client,
  companyId: string,
  storeId: string,
  country: Parameters<typeof calendarOf>[0],
  ids: readonly string[],
  nowMs: number = Date.now()
) {
  try {
    const now = new Date(nowMs);
    const rule = confirmationRuleOnce(client, companyId, nowMs);
    const rules = await readConfirmationRules(client, companyId, nowMs);
    const base = await rule();
    const inForce = await numbersInForce(client, companyId, now, calendarOf(country), rule);
    return new Map(
      ids.map((id) => [
        id,
        { ...numbersAnswer(employeeNumbersOf({ person: { id, storeId }, now }, { companyId, base, timezone: country.timezone, rules })), inForce },
      ])
    );
  } catch {
    return null;
  }
}

/* ─────────────────────────── the preview ─────────────────────────── */

export interface PreviewPerson {
  id: string;
  name: string;
  readiness: DeskReadiness;
  /**
   * Takes an order by its number (`orders.claim`) without being bound to «اسحبي الطلب أول» (`mustHoldToWork`) — the claim door then applies HER hand limit
   * (`orders/[id]/claim`, `returnsLimits(..., { userId })`). Built by the door from her real grants. Absent = false.
   */
  claimsByNumber?: boolean;
}

export interface OwnRulePreview {
  /** Whom it binds, with the numbers that reach her. */
  bound: { id: string; name: string; numbers: string[] }[];
  /** Whom it does not, with the reason. */
  notBound: { id: string; name: string; reason: string }[];
  /** What the owner must know about the rule as a whole (a later start, an end, hours, a number not acting now). */
  notes: string[];
  bindsNobody: boolean;
}

const CANDIDATE_ID = '\u0000candidate';
type EmployeeKey = (typeof NUMBERS_OF_KIND)['EMPLOYEE_NUMBERS'][number];

/**
 * Whether a number can ever reach her at the desk: the hand and the pace where she pulls (the hand also at «الزبون على الخط», and at the claim by number for whoever is not bound to «اسحبي الطلب أول»). The idle minutes reach every person
 * of the desk: whoever holds an order — pulled, handed, or claimed by its number — is released by her own minutes (Q4b), so no key is said to keep her out of them.
 */
function reaches(n: EmployeeKey, r: DeskReadiness, claimsByNumber = false): string | null {
  const has = (id: string) => r.tools.find((t) => t.id === id)?.has === true;
  if (n === 'pullPerHour') return has('pull') ? null : 'ما بتسحب طلبات — سرعة السحب ما بتوصلها';
  // The hand also binds whoever takes an order by its number: the claim door asks HER hand limit (review of #446).
  if (n === 'hand') return has('pull') || has('on_the_line') || claimsByNumber ? null : 'ما بتسحب ولا بتاخد طلب برقمه ولا «الزبون على الخط» — حد اليد ما بيوصلها';
  return null;
}

/**
 * WHOM `rule` BINDS AND WHOM IT DOES NOT, WITH THE REASON — pure. `people` are the desk's people as the door built them (their real grants); `named` are people the rule
 * names who are not among them (stopped, another store, no desk key); `others` are the company's other ACTIVE rows (the precedence is asked of `ruleFor`, with every
 * rule's hours left out — two rules with hours are said to meet).
 */
export function previewOwnRule(
  rule: ValidRule,
  ctx: {
    people: readonly PreviewPerson[];
    named: readonly { id: string; name: string }[];
    others: readonly ConfirmationRuleRow[];
    base: ConfirmationRuleNumbers;
    storeId: string;
    nowMs: number;
    inForce: NumbersInForce;
    /** Whether each ORDER number acts now (Q4d, `orderNumbersInForce`) — asked only for an order rule; absent = all on. */
    orderInForce?: OrderNumbersInForce;
  }
): OwnRulePreview {
  const notes: string[] = [];
  if (!(KINDS_THAT_ACT as readonly string[]).includes(rule.kind)) {
    return { bound: [], notBound: [], notes: [NOT_ACTING_YET_AR], bindsNobody: true };
  }
  if (rule.kind === 'ORDER_NUMBERS') return previewOrderRule(rule, ctx);
  if (rule.kind !== 'EMPLOYEE_NUMBERS') return { bound: [], notBound: [], notes: [NOT_ACTING_YET_AR], bindsNobody: true };
  const numbers = NUMBERS_OF_KIND.EMPLOYEE_NUMBERS.filter((n) => rule.payload[n] !== undefined);
  const sleeping = numbers.filter((n) => !ctx.inForce[n]);
  if (sleeping.length) notes.push(`${sleeping.map(numberLabel).join(' و')}: ${NOT_IN_FORCE_AR}`);
  if (rule.effectiveFrom.getTime() > ctx.nowMs) notes.push('بتبدأ بالموعد اللي تحت، مش هلق.');
  if (rule.effectiveTo) notes.push('إلها نهاية — بعدها بترجع الأرقام لحالها.');
  if (rule.hoursFrom && rule.hoursTo) notes.push(`بتشتغل بس من الساعة ${rule.hoursFrom} لـ${rule.hoursTo} بتوقيت المتجر.`);
  if (!rule.storeId) notes.push('القاعدة لكل المتاجر — الأسماء هون من المتجر اللي فاتح عليه.');

  const moment = new Date(Math.max(ctx.nowMs, rule.effectiveFrom.getTime()) + 1);
  const noHours = <T extends ConfirmationRuleRow>(r: T): T => ({ ...r, hoursFrom: null, hoursTo: null });
  const me: ConfirmationRuleRow = noHours({ ...rule, id: CANDIDATE_ID, isActive: true, userIds: rule.userIds, payload: rule.payload, createdAt: new Date(moment.getTime()) });
  const rows = [...ctx.others.filter((o) => o.id !== rule.id && o.isActive).map(noHours), me];
  const hadHours = new Set(ctx.others.filter((o) => o.hoursFrom).map((o) => o.id));

  const bound: OwnRulePreview['bound'] = [];
  const notBound: OwnRulePreview['notBound'] = [];
  for (const p of ctx.people) {
    if (rule.userIds && !rule.userIds.includes(p.id)) {
      notBound.push({ id: p.id, name: p.name, reason: 'مش مكتوبة بالقاعدة' });
      continue;
    }
    const eff = ruleFor({ person: { id: p.id, storeId: rule.storeId ?? ctx.storeId }, now: moment }, { companyId: rule.companyId, base: ctx.base, timezone: 'UTC', rules: rows });
    const got: string[] = [];
    const why: string[] = [];
    for (const n of numbers) {
      const far = reaches(n, p.readiness, p.claimsByNumber === true);
      if (far) { why.push(far); continue; }
      if (!ctx.inForce[n]) { why.push(`${numberLabel(n)} ما بيشتغل هلق`); continue; }
      const src = eff[n].source;
      if (src.from === 'RULE' && src.ruleId !== CANDIDATE_ID) {
        why.push(`قاعدة «${src.name}» أخص منها على ${numberLabel(n)}${hadHours.has(src.ruleId) ? ' (بساعاتها)' : ''}`);
        continue;
      }
      got.push(`${numberLabel(n)}: ${rule.payload[n]}`);
    }
    if (got.length) bound.push({ id: p.id, name: p.name, numbers: got });
    else notBound.push({ id: p.id, name: p.name, reason: [...new Set(why)].join(' · ') });
  }
  const here = new Set(ctx.people.map((p) => p.id));
  for (const n of ctx.named) {
    if (!here.has(n.id)) notBound.push({ id: n.id, name: n.name, reason: 'مش على مكتب التأكيد بهالمتجر (موقوفة، أو ما بتوصل للمتجر، أو ما معها مفاتيح المكتب)' });
  }
  return { bound, notBound, notes, bindsNobody: bound.length === 0 };
}

type OrderKey = keyof OrderNumbersInForce;
const ORDER_LABEL: Record<OrderKey, string> = { schedule: 'عدد محاولات «لا يرد»', proofSeconds: 'ثواني إثبات الاتصال', postponeMax: 'حد تأجيل الزبون' };
/** The desk tool through which each order number reaches a person: the steps and the proof at the call she logs, the cap at the date she gives. */
const ORDER_TOOL: Record<OrderKey, string> = { schedule: 'log_call', proofSeconds: 'log_call', postponeMax: 'decide' };
const orderValueWords = (n: OrderKey, p: RulePayload) => (n === 'schedule' ? `${(p.steps?.length ?? 0) + 1} محاولات` : String(p[n]));

/**
 * THE PREVIEW OF AN ORDER RULE (Q4d) — pure. It binds ORDERS, so whom it reaches is whoever works them at the desk: a person is bound when a number it sets reaches her
 * (she logs calls, or she confirms and postpones) and acts now. The notes say what the owner must know of the rule as a whole: which orders, a later start or an end, a
 * number not acting now, and every other active rule MORE specific that takes some of its orders (a product rule inside a store rule, by the resolver's levels).
 */
function previewOrderRule(rule: ValidRule, ctx: Parameters<typeof previewOwnRule>[1]): OwnRulePreview {
  const notes: string[] = [];
  const inForce: OrderNumbersInForce = ctx.orderInForce ?? { schedule: true, proofSeconds: true, postponeMax: true };
  const p = rule.payload;
  const numbers = (['schedule', 'proofSeconds', 'postponeMax'] as const).filter((n) => (n === 'schedule' ? p.steps !== undefined : p[n] !== undefined));
  notes.push('بتمشي على الطلبات مش على الموظفات: كل موظفة بتشتغل على طلب منها بتمشي عليها.');
  for (const n of numbers) if (!inForce[n]) notes.push(`${ORDER_LABEL[n]}: ${ORDER_NOT_IN_FORCE_AR[n]}`);
  if (rule.effectiveFrom.getTime() > ctx.nowMs) notes.push('بتبدأ بالموعد اللي تحت، مش هلق.');
  if (rule.effectiveTo) notes.push('إلها نهاية — بعدها بترجع الأرقام لحالها.');
  if (!rule.storeId) notes.push('القاعدة لكل المتاجر — الأسماء هون من المتجر اللي فاتح عليه.');
  if (rule.productId) notes.push('الطلب اللي فيه أكتر من منتج: كل سطر بيحسب، والأخص بتغلب.');
  const meet = (a: string | null, b: string | null) => a === null || b === null || a === b;
  const level = ruleLevel(rule);
  for (const row of ctx.others) {
    if (row.id === rule.id || !row.isActive || row.kind !== 'ORDER_NUMBERS') continue;
    const checked = validateConfirmationRuleRow(row);
    if (!checked.ok) continue;
    const o = checked.rule;
    const common = numbers.filter((n) => (n === 'schedule' ? o.payload.steps !== undefined : o.payload[n] !== undefined));
    if (common.length === 0 || ruleLevel(o) <= level) continue;
    if (!meet(o.storeId, rule.storeId) || !meet(o.productId, rule.productId) || !meet(o.channelKind, rule.channelKind)) continue;
    notes.push(`على بعض الطلبات قاعدة «${o.name}» أخص منها على ${common.map((n) => ORDER_LABEL[n]).join(' و')}.`);
  }

  const bound: OwnRulePreview['bound'] = [];
  const notBound: OwnRulePreview['notBound'] = [];
  for (const person of ctx.people) {
    const has = (id: string) => person.readiness.tools.find((t) => t.id === id)?.has === true;
    const got: string[] = [];
    const why: string[] = [];
    for (const n of numbers) {
      if (!has(ORDER_TOOL[n])) {
        why.push(ORDER_TOOL[n] === 'log_call' ? 'ما بتسجّل نتيجة اتصال — المحاولات والإثبات ما بيوصلوها' : 'ما بتأكّد ولا بتأجّل — حد التأجيل ما بيوصلها');
        continue;
      }
      if (!inForce[n]) {
        why.push(`${ORDER_LABEL[n]} ما بيشتغل هلق`);
        continue;
      }
      got.push(`${ORDER_LABEL[n]}: ${orderValueWords(n, p)}`);
    }
    if (got.length) bound.push({ id: person.id, name: person.name, numbers: got });
    else notBound.push({ id: person.id, name: person.name, reason: [...new Set(why)].join(' · ') });
  }
  return { bound, notBound, notes, bindsNobody: bound.length === 0 };
}

export const BINDS_NOBODY_AR = 'هالقاعدة ما بتمسك حدا هلق — إذا بدك تحفظها هيك أكّد إنك عارف.';

/**
 * THE COMPANY'S RULES LOCK — held by a save (create, or new dates) from the overlap check to its write, inside one transaction, so two saves at one moment cannot both
 * pass `overlapRefusal`. Released by Postgres at commit or rollback.
 */
export async function lockRulesOf(tx: Prisma.TransactionClient, companyId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`own-rules:${companyId}`}::text, 0))`;
}

/** The company's ACTIVE rows, read fresh (never the thirty-second cache: a save is judged against what is stored NOW). */
export async function activeRowsFresh(client: Client, companyId: string): Promise<ConfirmationRuleRow[]> {
  return (await client.confirmationRule.findMany({
    where: { companyId, isActive: true },
    orderBy: { createdAt: 'asc' },
    take: 500,
    select: {
      id: true, companyId: true, storeId: true, name: true, kind: true, userIds: true, productId: true, channelKind: true, phase: true,
      hoursFrom: true, hoursTo: true, effectiveFrom: true, effectiveTo: true, isActive: true, payload: true, createdAt: true,
    },
  })) as ConfirmationRuleRow[];
}

/**
 * THE PREVIEW AS A DOOR ASKS IT: the desk's people of the rule's store (or the open store, for a rule of every store) built as their sessions are, the named people who
 * are not among them, the company's other active rows, the base rule and whether each number acts now — then `previewOwnRule`.
 */
export async function previewAtTheDoor(
  client: Client,
  ask: { companyId: string; storeId: string; country: Parameters<typeof calendarOf>[0]; rule: ValidRule; nowMs: number; others?: readonly ConfirmationRuleRow[] }
): Promise<OwnRulePreview> {
  const { companyId, rule, nowMs } = ask;
  const storeId = rule.storeId ?? ask.storeId;
  const audience = await resolveAudience({ companyId, storeId, audience: { anyPermission: DESK_KEYS } });
  const people = audience.map((p) => {
    const holds = (k: string) => can(p, k);
    return { id: p.id, name: p.name, readiness: deskReadiness(holds, { fullAccess: hasFullAccess(p) }), claimsByNumber: holds('orders.claim') && !mustHoldToWork(holds) };
  });
  const missing = (rule.userIds ?? []).filter((id) => !people.some((p) => p.id === id));
  const named = missing.length ? await client.user.findMany({ where: { id: { in: missing }, companyId }, select: { id: true, name: true } }) : [];
  const others = ask.others ?? (await activeRowsFresh(client, companyId));
  const ruleNow = confirmationRuleOnce(client, companyId, nowMs);
  const base = await ruleNow();
  const inForce = await numbersInForce(client, companyId, new Date(nowMs), calendarOf(ask.country), ruleNow);
  const orderInForce = rule.kind === 'ORDER_NUMBERS' ? await orderNumbersInForce(client, companyId, new Date(nowMs)) : undefined;
  return previewOwnRule(rule, { people, named, others, base, storeId, nowMs, inForce, orderInForce });
}

/* ─────────────────────────── the ready templates ─────────────────────────── */

/**
 * «قوالب جاهزة» as the screen shows them: each template's words, whether its kind acts yet, how many ACTIVE rules were made from it, and what the dialog opens with —
 * a COPY of the template's payload (the templates are frozen at the top only).
 */
export function templatesAnswer(activeFrom: ReadonlyMap<string, number>) {
  return CONFIRMATION_RULE_TEMPLATES.map((t) => {
    const acts = (KINDS_THAT_ACT as readonly string[]).includes(t.kind);
    const payload = JSON.parse(JSON.stringify(t.payload)) as RulePayload;
    // The dialog offers the schedule as ONE number (Q4d): a template's steps open as their attempts, and the save turns them back into exactly these steps.
    const prefillPayload: Record<string, unknown> = payload.steps ? { attempts: payload.steps.length + 1 } : { ...payload };
    return {
      key: t.key,
      name: t.name,
      kind: t.kind,
      kindLabel: CONFIRMATION_RULE_KIND_AR[t.kind],
      whatAr: payloadWords(payload).join(' · '),
      hoursAr: t.scope.hoursFrom && t.scope.hoursTo ? `من الساعة ${t.scope.hoursFrom} لـ${t.scope.hoursTo}` : null,
      needs: [...t.needs],
      acts,
      blockedAr: acts ? null : NOT_ACTING_SHORT_AR,
      activeCount: activeFrom.get(t.key) ?? 0,
      prefill: { name: t.name, kind: t.kind, ...t.scope, payload: prefillPayload, days: t.days },
    };
  });
}

/** The template a create names, or null — the screen sends its key; an unknown key is not an error (the rule is the owner's either way). */
export function templateKeyOf(raw: unknown): string | null {
  return typeof raw === 'string' && CONFIRMATION_RULE_TEMPLATES.some((t) => t.key === raw) ? raw : null;
}
