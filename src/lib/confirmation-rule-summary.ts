import type { Prisma } from '@prisma/client';
import type { db } from './db';
import { AUTO_RELEASE_BUSINESS_MINUTES, returnsLimits } from './confirmation-queue';
import { NO_ANSWER_LIMIT } from './confirmation-workflow';
import { MIN_CALL_MS } from './call-proof-words';
import { attemptWords } from './attempt-words';
import { CADENCE_FLOORS_MS, CADENCE_GAPS_MS, CADENCE_LIMIT, CADENCE_MIN_DAYS, cadenceEveningAnchor, cadenceWorkWindow } from './no-answer-cadence';
import { cadenceSince } from './no-answer-cadence-switch';
import { POSTPONE_MAX_TIMES, QUEUE_PRIORITY } from './queue-priority';
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
  /** The hand limit and the idle limit the release actually uses — `returnsLimits`, never a literal. */
  hand: number;
  idleMinutes: number;
  /** The country's work hours as stored (the plan's own reader gives them its fallbacks). */
  workStart: string | null | undefined;
  workEnd: string | null | undefined;
  /** The two time-of-day windows, whole hours. */
  modes: QueueModesConfig;
}

/** Hours in the way a person says them: «ساعة» · «ساعتين» · «5 ساعات». */
function hoursWords(h: number): string {
  return h === 1 ? 'ساعة' : h === 2 ? 'ساعتين' : `${h} ساعات`;
}
const clock = (hour: number) => `${String(hour % 24).padStart(2, '0')}:00`;

export function ruleSummaryLines(f: RuleFacts): string[] {
  const priority = f.priorityOn ? 'أولوية الطابور شغّالة' : 'أولوية الطابور مطفية';
  if (!f.proofOn) {
    return [
      `«إثبات المكالمات وجدول المحاولات» مطفي: «لا يرد» بينفتح بأي وقت، والطلب بيسكّر لحالو بعد ${NO_ANSWER_LIMIT} مرات «لا يرد» (القاعدة القديمة)، من غير موعد محسوب بين المرة والمرة.`,
      `الطلب اللي ما انسجّلت عليه محاولة بيرجع للطابور بعد ${AUTO_RELEASE_BUSINESS_MINUTES} دقيقة عمل.`,
      f.priorityOn
        ? `أولوية الطابور شغّالة، بس حد اليد (${f.hand}) ومهلة ${f.idleMinutes} دقيقة ما بيشتغلوا إلا مع «إثبات المكالمات»، أو مع «نظام الجولات» و«الطلب يرجع للطابور فوراً» الاتنين (تحت).`
        : 'أولوية الطابور مطفية: السحب زي ما هو.',
      'شغّل «إثبات المكالمات وجدول المحاولات» لتشتغل القاعدة الجديدة، وهالصفحة بتتحدّث بأرقامها.',
    ];
  }
  const window = cadenceWorkWindow(f.workStart, f.workEnd);
  const lines = [
    `الموظفة بتسحب وبإيدها ${f.hand} طلبات بالأكثر، والطلب اللي ما انلمس ${f.idleMinutes} دقيقة دوام بيرجع للطابور لحالو (${priority}).`,
    `«لا يرد» ما بينفتح إلا بعد ضغطة «اتصال» و${MIN_CALL_MS.NO_ANSWER / 1000} ثانية — وإلا الزر بيقول ليش.`,
    `بعد كل «لا يرد» محسوبة بيطلع الطلب من إيدها وبيرجع لأي موظفة بموعدو: بعد ${CADENCE_GAPS_MS.afterFirst / 60_000} دقيقة، بعدين بعد ${hoursWords(CADENCE_GAPS_MS.afterSecond / 3_600_000)}، بعدين ببداية الدوام (${window.start}) وبعد ${hoursWords(CADENCE_FLOORS_MS.beforeFourth / 3_600_000)} على الأقل، وبعدين المسا (${cadenceEveningAnchor(window)}) وبعد ${hoursWords(CADENCE_FLOORS_MS.beforeFifth / 3_600_000)} على الأقل. الضغطة قبل موعدها بتنسجّل وما بتنحسب.`,
    `بعد المحاولة ${CADENCE_LIMIT} على ${CADENCE_MIN_DAYS} أيام مختلفين بيتسكّر الطلب لحالو وبيروح لقائمة «ملغاة سابقاً».`,
  ];
  if (f.priorityOn) {
    lines.push(
      `ترتيب السحب: الطلب الجديد (أقل من ${QUEUE_PRIORITY.freshMinutes} دقيقة) أول، والإعادة اللي تأخرت أكتر من ${hoursWords(QUEUE_PRIORITY.agingHours)} بتتقدّم، وللمتأخر حصة من السحبات. وتأجيل الطلب بموعد من الزبون حدّو ${POSTPONE_MAX_TIMES} مرات.`,
      `من ${clock(f.modes.nightFrom)} لـ${clock(f.modes.nightTo)} ومن ${clock(f.modes.peakFrom)} لـ${clock(f.modes.peakTo)}: الجديد أول والأقدم أول، بلا حصة.`
    );
  } else {
    lines.push('ترتيب السحب: زي ما هو، بلا حصة للمتأخر ولا حد لتأجيل الموعد (أولوية الطابور مطفية).');
  }
  lines.push(`وعدّاد واحد بكل الشاشات: «${attemptWords(2, CADENCE_LIMIT)}» — رقم المحاولة اللي بتصير بالضغطة الجاية.`);
  return lines;
}

/** Everything the box reads, in one place — the switches the engine reads, through the readers it uses. A failed read is «off», as everywhere. */
export async function readRuleFacts(
  client: Client,
  companyId: string,
  country: { workHoursStart?: string | null; workHoursEnd?: string | null }
): Promise<RuleFacts> {
  const [since, priority, limits, modes] = await Promise.all([
    cadenceSince(client, companyId),
    queuePrioritySwitch(client, companyId),
    returnsLimits(client, companyId),
    readQueueModes(client, companyId).catch(() => QUEUE_MODES_DEFAULTS),
  ]);
  return {
    proofOn: !!since,
    priorityOn: priority.enabled,
    hand: limits.handLimit,
    idleMinutes: limits.idleBusinessMinutes,
    workStart: country.workHoursStart,
    workEnd: country.workHoursEnd,
    modes,
  };
}

