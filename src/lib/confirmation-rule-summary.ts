import type { Prisma } from '@prisma/client';
import type { db } from './db';
import { AUTO_RELEASE_BUSINESS_MINUTES, returnsLimits } from './confirmation-queue';
import { NO_ANSWER_LIMIT } from './confirmation-workflow';
import { attemptWords } from './attempt-words';
import { cadenceEveningAnchor, cadenceMorningAnchor, cadenceWorkWindow } from './no-answer-cadence';
import { CONFIRMATION_RULE_DEFAULT, confirmationRuleOnce, ruleAttempts, type ConfirmationRuleNumbers, type RuleStep } from './confirmation-rule-settings';
import { cadenceSince } from './no-answer-cadence-switch';
import { ROUND_CLOSE_MIN_DAYS, ROUND_GAP_BUSINESS_MINUTES, ROUND_RELEASE_BUSINESS_MINUTES, roundsOn } from './no-answer-rounds';
import { roundsSwitch } from './no-answer-rounds-switch';
import { returnsSwitchOn } from './no-answer-returns';
import { returnsSwitch } from './no-answer-returns-switch';
import { QUEUE_PRIORITY } from './queue-priority';
import { QUEUE_MODES_DEFAULTS, readQueueModes, type QueueModesConfig } from './queue-modes-settings';
import { queuePrioritySwitch } from './queue-priority-switch';

type Client = Prisma.TransactionClient | typeof db;

/**
 * «القاعدة بالمختصر» — THE BOX AT THE TOP OF «قواعد مركز التأكيد» (18/11, request C1).
 *
 * One short box that tells the person what happens to an order that does not answer. It READS, it decides nothing and it types no number of its own: every figure in it
 * is a constant the engine already uses (`CADENCE_*`, `MIN_CALL_MS`, `QUEUE_PRIORITY*`, `RETURNS_MODE` through `returnsLimits`, `NO_ANSWER_LIMIT`) or a setting it
 * already reads (the two switches, the country's work hours, the two mode windows). The numbers that depend on a switch say the truth of the switch's state:
 * with «أولوية الطابور» off the hand is 5 and the idle limit 30 — it says that, it does not say 3 and 20.
 *
 * `ruleSummaryLines` is pure (the facts come in), so a test can put every combination of the two switches through it; `readRuleFacts` is the only part that reads.
 */

export interface RuleFacts {
  /** «إثبات المكالمات وجدول المحاولات» is on (the one switch of the five-attempt plan). */
  proofOn: boolean;
  /** «أولوية الطابور» is on. */
  priorityOn: boolean;
  /** «نظام الجولات» is on (the legacy counting and its three releases). */
  roundsOn: boolean;
  /** «الطلب يرجع للطابور فوراً» is STORED on — it works only with the rounds (or under the plan, which brings its own). */
  returnsOn: boolean;
  /** The hand limit and the idle limit the release actually uses — `returnsLimits`, never a literal. */
  hand: number;
  idleMinutes: number;
  /** The country's work hours as stored (the plan's own reader gives them its fallbacks). */
  workStart: string | null | undefined;
  workEnd: string | null | undefined;
  /** The two time-of-day windows, whole hours. */
  modes: QueueModesConfig;
  /**
   * The rule in force (request Q3b) — its steps, clocks, days, proof seconds, postpone cap and fresh minutes are what the box says, so it agrees with the engine after an
   * edit. Absent = the default rule (main's numbers).
   */
  rule?: ConfirmationRuleNumbers;
}

/** Hours in the way a person says them: «ساعة» · «ساعتين» · «5 ساعات». */
function hoursWords(h: number): string {
  return h === 1 ? 'ساعة' : h === 2 ? 'ساعتين' : h > 10 ? `${h} ساعة` : `${h} ساعات`;
}
const clock = (hour: number) => `${String(hour % 24).padStart(2, '0')}:00`;

/** A step's wait as a person says it: whole hours in hours («ساعتين»), anything else in minutes («30 دقيقة»). */
const waitWords = (minutes: number) => (minutes % 60 === 0 ? hoursWords(minutes / 60) : `${minutes} دقيقة`);

/**
 * THE SCHEDULE, step by step (request Q3b): «بعد 30 دقيقة، بعدين بعد ساعتين، بعدين تاني يوم الصبح (11:00) وبعد 8 ساعات على الأقل، وبعدين المسا (19:30) وبعد 3 ساعات على
 * الأقل» for the default — main's words, letter for letter — and the same grammar for any other list of steps.
 */
function stepsWords(steps: readonly RuleStep[], window: { start: string; end: string }, rule: ConfirmationRuleNumbers): string {
  const parts = steps.map((s) =>
    s.kind === 'after'
      ? `بعد ${waitWords(s.minutes)}`
      : s.anchor === 'morning'
        ? `تاني يوم الصبح (${cadenceMorningAnchor(window, rule.morning)}) وبعد ${hoursWords(s.floorHours)} على الأقل`
        : `المسا (${cadenceEveningAnchor(window, rule.evening)}) وبعد ${hoursWords(s.floorHours)} على الأقل`
  );
  return parts.map((p, i) => (i === 0 ? p : i === parts.length - 1 ? `، وبعدين ${p}` : `، بعدين ${p}`)).join('');
}

export function ruleSummaryLines(f: RuleFacts): string[] {
  const priority = f.priorityOn ? 'أولوية الطابور شغّالة' : 'أولوية الطابور مطفية';
  const hours = (minutes: number) => hoursWords(minutes / 60);
  if (!f.proofOn) {
    // THE LEGACY STATES (18/11, review of C1): which of the old rules runs is decided by «نظام الجولات» and «الطلب يرجع للطابور فوراً» — the box says the one in force.
    const legacyReturns = f.roundsOn && f.returnsOn;
    const lines = [
      f.roundsOn
        ? `«إثبات المكالمات وجدول المحاولات» مطفي، و«نظام الجولات» شغّال: «لا يرد» خلال ${hours(ROUND_GAP_BUSINESS_MINUTES)} عمل = جولة وحدة، والطلب بيسكّر لحالو بعد ${NO_ANSWER_LIMIT} جولات على ${ROUND_CLOSE_MIN_DAYS} أيام مختلفين.`
        : `«إثبات المكالمات وجدول المحاولات» مطفي: «لا يرد» بينفتح بأي وقت، والطلب بيسكّر لحالو بعد ${NO_ANSWER_LIMIT} مرات «لا يرد» (القاعدة القديمة)، من غير موعد محسوب بين المرة والمرة.`,
      legacyReturns
        ? `«الطلب يرجع للطابور فوراً» شغّال: «لا يرد» أو موعد بيطلّع الطلب من إيدها فوراً، وبعد «لا يرد» بيجهز بعد ${hours(ROUND_GAP_BUSINESS_MINUTES)} عمل. بإيدها ${f.hand} طلبات بالأكثر، والطلب اللي ما انسجّلت عليه محاولة ${f.idleMinutes} دقيقة عمل بيرجع للطابور لحالو (${priority}).`
        : f.roundsOn
          ? `الطلب اللي ما انسجّلت عليه محاولة بيرجع للطابور بعد ${AUTO_RELEASE_BUSINESS_MINUTES} دقيقة عمل، والجولة اللي ما حدا ردّ عليها بترجع بعد ${hours(ROUND_RELEASE_BUSINESS_MINUTES)} عمل.`
          : `الطلب اللي ما انسجّلت عليه محاولة بيرجع للطابور بعد ${AUTO_RELEASE_BUSINESS_MINUTES} دقيقة عمل.`,
    ];
    if (f.returnsOn && !f.roundsOn) lines.push('«الطلب يرجع للطابور فوراً» مخزّن شغّال بس ما بيشتغل: بدّو «نظام الجولات».');
    if (!legacyReturns) {
      lines.push(
        f.priorityOn
          ? `أولوية الطابور شغّالة، بس حد اليد (${f.hand}) ومهلة ${f.idleMinutes} دقيقة ما بيشتغلوا إلا مع «إثبات المكالمات»، أو مع «نظام الجولات» و«الطلب يرجع للطابور فوراً» الاتنين (تحت).`
          : 'أولوية الطابور مطفية: السحب زي ما هو.'
      );
    }
    lines.push('شغّل «إثبات المكالمات وجدول المحاولات» لتشتغل القاعدة الجديدة، وهالصفحة بتتحدّث بأرقامها.');
    return lines;
  }
  const window = cadenceWorkWindow(f.workStart, f.workEnd);
  const rule = f.rule ?? CONFIRMATION_RULE_DEFAULT;
  const attempts = ruleAttempts(rule);
  const lines = [
    // Request C2: under the plan the hand and the idle release are the rule set's whatever «أولوية الطابور» says (`returnsLimits`), so the line names no switch.
    `الموظفة بتسحب وبإيدها ${f.hand} طلبات بالأكثر، والطلب اللي ما انلمس ${f.idleMinutes} دقيقة دوام بيرجع للطابور لحالو.`,
    `«لا يرد» ما بينفتح إلا بعد ضغطة «اتصال» و${rule.proofSeconds} ثانية — وإلا الزر بيقول ليش.`,
    `بعد كل «لا يرد» محسوبة بيطلع الطلب من إيدها وبيرجع لأي موظفة بموعدو: ${stepsWords(rule.steps, window, rule)}. الضغطة قبل موعدها بتنسجّل وما بتنحسب.`,
    `بعد المحاولة ${attempts} على ${rule.minDays} أيام مختلفين بيتسكّر الطلب لحالو وبيروح لقائمة «ملغاة سابقاً».`,
    // Request C2: the postponement cap and «لا يرد is not a postponement» hold under the plan whatever «أولوية الطابور» says (the confirmation door).
    `موعد من الزبون: ${rule.postponeMax} مرات بالأكثر. والتأجيل بسبب «لا يرد» ممنوع — بتنسجّل محاولة.`,
  ];
  if (f.priorityOn) {
    lines.push(
      `ترتيب السحب: الطلب الجديد (أقل من ${rule.freshMinutes} دقيقة) أول، والإعادة اللي تأخرت أكتر من ${hoursWords(QUEUE_PRIORITY.agingHours)} بتتقدّم، وللمتأخر حصة من السحبات.`,
      `من ${clock(f.modes.nightFrom)} لـ${clock(f.modes.nightTo)} ومن ${clock(f.modes.peakFrom)} لـ${clock(f.modes.peakTo)}: الجديد أول والأقدم أول، بلا حصة.`
    );
  } else {
    lines.push('ترتيب السحب: زي ما هو، بلا حصة للمتأخر (أولوية الطابور مطفية).');
  }
  // Request C2: «نظام الجولات» stored on beside the plan does nothing any more (its releases stop too), so the box says nothing of it under the plan.
  lines.push(`وعدّاد واحد بكل الشاشات: «${attemptWords(2, attempts)}» — رقم المحاولة اللي بتصير بالضغطة الجاية.`);
  return lines;
}

/** Everything the box reads, in one place — the switches the engine reads, through the readers it uses. A failed read is «off», as everywhere. */
export async function readRuleFacts(
  client: Client,
  companyId: string,
  country: { workHoursStart?: string | null; workHoursEnd?: string | null }
): Promise<RuleFacts> {
  // Request Q3b: the rule in force, read ONCE for the box — its numbers and the hand / idle limits below come from the same reading.
  const ruleNow = confirmationRuleOnce(client, companyId);
  const [since, priority, limits, modes, rounds, returns, rule] = await Promise.all([
    cadenceSince(client, companyId),
    queuePrioritySwitch(client, companyId),
    returnsLimits(client, companyId, Date.now(), ruleNow),
    readQueueModes(client, companyId).catch(() => QUEUE_MODES_DEFAULTS),
    roundsSwitch(client, companyId).catch(() => null),
    returnsSwitch(client, companyId).catch(() => null),
    ruleNow(),
  ]);
  return {
    proofOn: !!since,
    priorityOn: priority.enabled,
    roundsOn: roundsOn(rounds),
    returnsOn: returnsSwitchOn(returns),
    hand: limits.handLimit,
    idleMinutes: limits.idleBusinessMinutes,
    workStart: country.workHoursStart,
    workEnd: country.workHoursEnd,
    modes,
    rule,
  };
}

