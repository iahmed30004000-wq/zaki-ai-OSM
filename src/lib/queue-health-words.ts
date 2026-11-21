/**
 * ═══════════════════════════════════════════════════════════════════════
 * QUEUE HEALTH — THE PURE RULES AND THE WORDS (Confirmation Center v2, step D2). No imports: the screen reads this file too.
 *
 * The study found zero pulls between 21:00 and 11:00 while 44% of the orders arrive then, and a backlog that grew unseen. The supervisor's board says it, and when it is
 * bad the supervisors and the company admin are told:
 *
 *   · BACKLOG_HIGH       — more than 150 orders waiting behind a «لا يرد».
 *   · OLDEST_DUE_STALE   — the oldest retry whose due arrived has waited more than 24 hours.
 *   · NO_PULLS           — inside shift hours, new orders wait and nobody has pulled for 20 minutes (the gap counts from the shift's start when that is later).
 *   · NEW_UNCLAIMED      — inside shift hours, the oldest new order has been unclaimed for more than 30 minutes (counted from the shift's start when that is later).
 *
 * Every number on the board says how it is counted (`HEALTH_RULE_AR`): a figure with no rule is an opinion.
 * ═══════════════════════════════════════════════════════════════════════
 */

export const QUEUE_HEALTH = {
  backlogAlert: 150,
  oldestDueHours: 24,
  coverageMinutes: 20,
  unclaimedMinutes: 30,
} as const;

export type HealthAlertKind = 'BACKLOG_HIGH' | 'OLDEST_DUE_STALE' | 'NO_PULLS' | 'NEW_UNCLAIMED';

export interface QueueHealth {
  /** Open orders with at least one logged «لا يرد». */
  backlog: number;
  /** Of them, the ones whose due (the plan's date, else the last «لا يرد») has arrived and nobody holds. */
  dueNow: number;
  /** Hours the oldest due one has waited past its due; null when none is due. */
  oldestDueHours: number | null;
  /** Orders whose FIRST «لا يرد» is today (store day). */
  enteredToday: number;
  /** Orders that had a «لا يرد» before today and reached a final status today. */
  closedToday: number;
  /** Never-rung, unclaimed, takeable new orders. */
  newWaiting: number;
  /** Minutes the oldest of them has waited — counted from the shift's start when that is later; null when none waits or it is outside shift hours. */
  oldestNewMinutes: number | null;
  /** Minutes since anybody pulled in this store — counted from the shift's start when that is later; null outside shift hours. */
  noPullMinutes: number | null;
  inShift: boolean;
  /**
   * «طلبات بلا موظفة» (request Q5b, 21/11): orders of the pool a routing rule gives to people none of whom can pull now (they wait the rule's fallback minutes, then go
   * to everyone). Present only while a routing rule is in force for the store — absent, the board is as it was. Said on the board by request Q5c.
   */
  unstaffed?: number;
}

export interface HealthAlert {
  kind: HealthAlertKind;
  title: string;
  message: string;
}

export function healthAlerts(h: QueueHealth): HealthAlert[] {
  const out: HealthAlert[] = [];
  if (h.backlog > QUEUE_HEALTH.backlogAlert) {
    out.push({ kind: 'BACKLOG_HIGH', title: 'طلبات «لا يرد» كتيرة', message: `${h.backlog} طلب بانتظار إعادة الاتصال — فوق الحد (${QUEUE_HEALTH.backlogAlert}).` });
  }
  if (h.oldestDueHours !== null && h.oldestDueHours > QUEUE_HEALTH.oldestDueHours) {
    out.push({ kind: 'OLDEST_DUE_STALE', title: 'إعادة اتصال متأخرة', message: `أقدم إعادة حان موعدها صار لها ${Math.floor(h.oldestDueHours)} ساعة — فوق الحد (${QUEUE_HEALTH.oldestDueHours} ساعة).` });
  }
  if (h.inShift && h.newWaiting > 0 && h.noPullMinutes !== null && h.noPullMinutes > QUEUE_HEALTH.coverageMinutes) {
    out.push({ kind: 'NO_PULLS', title: 'ما حدا عم يسحب', message: `${h.newWaiting} طلب جديد بالانتظار وما سحب حدا من ${Math.floor(h.noPullMinutes)} دقيقة خلال الدوام.` });
  }
  if (h.inShift && h.oldestNewMinutes !== null && h.oldestNewMinutes > QUEUE_HEALTH.unclaimedMinutes) {
    out.push({ kind: 'NEW_UNCLAIMED', title: 'طلب جديد بلا استلام', message: `أقدم طلب جديد صار له ${Math.floor(h.oldestNewMinutes)} دقيقة بدون ما حدا يستلمو خلال الدوام (الحد ${QUEUE_HEALTH.unclaimedMinutes}).` });
  }
  return out;
}

/**
 * «طلبات بلا موظفة» ON THE BOARD (request Q5c, 21/11): the line said under the tiles while a routing rule is in force (`health.unstaffed` present), with how it is
 * counted. null without the count — the board is as it was.
 */
export function unstaffedLine(n: number | undefined): string | null {
  if (n === undefined) return null;
  return `طلبات بلا موظفة: ${n} — طلبات قاعدة توزيع ما في ولا وحدة من موظفاتها بتقدر تسحبها هلق. بتستنى مهلة القاعدة (دقائق دوام من وصول الطلب)، وبعدها بتروح لكل الموظفات.`;
}

/** «قاعدة الاحتساب» — said under the board. */
export const HEALTH_RULE_AR =
  'قاعدة الاحتساب: «بالانتظار» = طلب مفتوح عليه «لا يرد» واحد على الأقل. «حان موعده» = موعد الخطة (أو آخر «لا يرد») وصل وما حدا ماسكو. «دخل اليوم» = أول «لا يرد» إلو اليوم بتوقيت المتجر. «انسكّر اليوم» = كان عليه «لا يرد» قبل اليوم ووصل لحالة نهائية اليوم. ' +
  `التنبيه: أكتر من ${QUEUE_HEALTH.backlogAlert} بالانتظار، أو أقدم موعد صار له أكتر من ${QUEUE_HEALTH.oldestDueHours} ساعة، أو خلال الدوام ما حدا سحب ${QUEUE_HEALTH.coverageMinutes} دقيقة والجدد بالانتظار، أو أقدم جديد بلا استلام أكتر من ${QUEUE_HEALTH.unclaimedMinutes} دقيقة (بتنعدّ من بداية الدوام لو كانت أحدث).`;
