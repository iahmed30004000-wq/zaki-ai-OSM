import type { Prisma } from '@prisma/client';
import type { db } from './db';
import type { BusinessCalendar } from './business-calendar';
import { CONFIRMATION_RULE_RANGES, confirmationRuleOnce, type ConfirmationRuleNumbers, type RuleNow } from './confirmation-rule-settings';
import {
  CONFIRMATION_RULE_KIND_AR,
  CONFIRMATION_RULE_TEMPLATES,
  NUMBERS_OF_KIND,
  PULL_PACE_RANGE,
  ruleFor,
  validateConfirmationRuleRow,
  type ConfirmationRuleKind,
  type ConfirmationRuleRow,
  type RulePayload,
  type ValidRule,
} from './confirmation-rules';
import { mustHoldToWork, readReturnsMode } from './confirmation-queue';
import { cadenceSince } from './no-answer-cadence-switch';
import { queuePrioritySwitch } from './queue-priority-switch';
import { roundsSwitch } from './no-answer-rounds-switch';
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
 * A rule that looks on and binds nobody is the owner's fear (18/11). The employee numbers act (Q4b); the order numbers act with Q4d, the priority and the routing with
 * Q5 — until then the door refuses them (`RULE_KIND_NOT_ACTING`) and the screen shows their templates greyed with the reason. Each stage adds its kind to
 * `KINDS_THAT_ACT`, one line.
 *
 * ── THE PREVIEW IS THE ENGINE'S, NEVER A ROLE TEMPLATE'S ──
 * The people are built by the door exactly as a session builds them (`resolveAudience` → `computeEffectiveGrants` → `can` → `deskReadiness`), and who wins between two
 * rules is asked of the real resolver (`ruleFor`). Per person and per number the reasons are, in order: not named · the number never reaches her (she does not pull, or
 * no order can be in her hands) · the number does not act right now (the switches it rides on are off) · a more specific rule wins.
 *
 * NOTHING HERE WRITES, TOUCHES MONEY, ORDER CREATION OR A CONTRACT.
 * ═══════════════════════════════════════════════════════════════════════
 */

/** The kinds a save may write today. Q4d adds 'ORDER_NUMBERS'; Q5 adds 'PRIORITY' and 'ROUTING'. */
export const KINDS_THAT_ACT: readonly ConfirmationRuleKind[] = Object.freeze(['EMPLOYEE_NUMBERS']);

export const NOT_ACTING_YET_AR =
  'أرقام الطلب (المحاولات وثواني الإثبات وحد التأجيل) و«هالطلبات أول» و«هالطلبات بس لهالموظفات» لسا ما بتشتغل بالمكتب — بتنفتح هون لما تنبني مراحلها.';
export const NOT_ACTING_SHORT_AR = 'لسا ما بتشتغل — بتنفتح لما تنبني مرحلتها';

/** One number a rule may set, as the dialog offers it. */
export interface OwnRuleNumber {
  key: 'hand' | 'idleMinutes' | 'pullPerHour' | 'proofSeconds' | 'postponeMax';
  kind: ConfirmationRuleKind;
  label: string;
  unit: string;
  range: { min: number; max: number };
}

export const OWN_RULE_NUMBERS: readonly OwnRuleNumber[] = Object.freeze([
  { key: 'hand', kind: 'EMPLOYEE_NUMBERS', label: 'حد اليد (كم طلب بإيدها)', unit: 'طلب', range: CONFIRMATION_RULE_RANGES.hand },
  { key: 'idleMinutes', kind: 'EMPLOYEE_NUMBERS', label: 'مهلة الطلب المتروك', unit: 'دقيقة دوام', range: CONFIRMATION_RULE_RANGES.idleMinutes },
  { key: 'pullPerHour', kind: 'EMPLOYEE_NUMBERS', label: 'سرعة السحب', unit: 'طلب بالساعة', range: PULL_PACE_RANGE },
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
    payload: body.payload,
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
  }
): OwnRulePreview {
  const notes: string[] = [];
  if (!(KINDS_THAT_ACT as readonly string[]).includes(rule.kind) || rule.kind !== 'EMPLOYEE_NUMBERS') {
    return { bound: [], notBound: [], notes: [NOT_ACTING_YET_AR], bindsNobody: true };
  }
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
  return previewOwnRule(rule, { people, named, others, base, storeId, nowMs, inForce });
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
      prefill: { name: t.name, kind: t.kind, ...t.scope, payload, days: t.days },
    };
  });
}

/** The template a create names, or null — the screen sends its key; an unknown key is not an error (the rule is the owner's either way). */
export function templateKeyOf(raw: unknown): string | null {
  return typeof raw === 'string' && CONFIRMATION_RULE_TEMPLATES.some((t) => t.key === raw) ? raw : null;
}
