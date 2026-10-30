import { visibleWork, type WorkItem, type WorkKey } from './my-work';

/**
 * «مهمّتك الجاية» — THE ONE THING, CHOSEN ONCE, FOR THIS PERSON.
 *
 * The owner's plan, المرحلة ١: «بطاقة «مهمّتك الجاية» أول الرئيسية لكل دور:
 * الرقم من السيرفر وزر واحد». The dashboard already had «شغلك اليوم» — a
 * grid of every count that is not zero, each with a sentence about what it
 * is for. A grid answers «what is there»; it does not answer «what do I do
 * first», and the person who has just sat down is asking the second one.
 *
 * So this is not a second set of numbers and not a second rule. It is the
 * FIRST card of the list the server already sent — the same `WorkItem`s, in
 * the same order `visibleWork` has always put them in — with the one
 * difference that matters: a card is only a mission when it leads somewhere
 * this person may actually go. Work with no door (a moderator's own
 * unconfirmed orders) is work, but it is not a step, and a mission card
 * whose button is missing is a card that shouts and then shrugs.
 *
 * ── WHAT THIS FILE DOES NOT DO ──
 *
 *   • It computes no figure. `count` is the server's, printed as it arrived
 *     (see `src/lib/the-frontend-invariants.test.ts`: the UI computes nothing
 *     the backend already computes). Nothing here adds, subtracts or
 *     re-derives a total.
 *   • It does not decide who sees what. `items` already came scoped by
 *     permission from `/api/me/work`; the permission question asked here is
 *     the narrow one the dashboard has always asked — «may they open the
 *     screen this leads to?» — and it arrives as an argument, as it does for
 *     `canAccessRoute` and `roadPosition`, so the same answer can be asked in
 *     a test with no session.
 *   • It does not invent a role ladder. The order is `WorkKind.rank`, which
 *     is where the product already says late work outranks waiting work, and
 *     a confirmation agent who holds nothing else still lands on «الطلبات
 *     الجديدة» because it is the only work she has.
 */

/**
 * THE WORDS THE CARD PUTS AROUND THE SERVER'S NUMBER.
 *
 * Written per kind, beside the kind, for the same reason `todo` is: a
 * sentence stored somewhere else drifts from the thing it describes. Kept
 * apart from `my-work.ts` because this is DASHBOARD copy — the header chip
 * says «14 مرتجع» and must not grow into a paragraph — while `ar` and `todo`
 * are shared by both.
 *
 * `noun` follows the number («12 طلب جديد بستنوا تأكيد») and `cta` is the one
 * button. Both are dialect on purpose: this is the owner's own sentence in
 * the plan, and the person reading it is standing in a warehouse.
 */
export interface MissionCopy {
  /** What the number counts — a plural noun phrase, read after the figure. */
  noun: string;
  /** The one button's label. Imperative, and only for work that has a door. */
  cta: string;
}

export const MISSION_COPY: Readonly<Record<WorkKey, MissionCopy>> = {
  CONFIRM_POOL: { noun: 'طلب جديد بستنوا تأكيد', cta: 'ابدأ التأكيد' },
  READY_TO_SHIP: { noun: 'طلب جاهز للشحن', cta: 'ابدأ الشحن' },
  RETURNS_WAITING: { noun: 'مرتجع بستنى استلام', cta: 'ابدأ الاستلام' },
  LATE_SHIPMENTS: { noun: 'شحنة متأخّرة', cta: 'تابع الشحن' },
  CHANGE_REQUESTS: { noun: 'طلب تعديل بستنى قرار', cta: 'راجع الطلبات' },
  TO_PREPARE: { noun: 'طلب بستنى التجهيز', cta: 'ابدأ التجهيز' },
  ISSUES_OPEN: { noun: 'إشكال بستنى تصحيح', cta: 'صحّح الإشكالات' },
  POSTPONED_DUE: { noun: 'طلب مؤجَّل حان موعده', cta: 'اتصل بهم' },
  STATEMENTS_OPEN: { noun: 'كشف بستنى اعتماد', cta: 'راجع الكشوف' },
  /**
   * No door by design (`workKind('MY_UNCONFIRMED').href === null`), so this
   * copy is never read on a mission card. It exists so the map is total and
   * a new kind cannot be added without somebody deciding its words.
   */
  MY_UNCONFIRMED: { noun: 'طلب غير مؤكَّد', cta: 'افتح الطلبات' },
};

/** A supervisor who may not pull watches the queue; she does not «start confirming» from it. */
export const WATCH_ONLY_CTA = 'راقب الطابور';

export interface Mission {
  /** The server's item, untouched — the number is printed from here. */
  item: WorkItem;
  /** Where the one button goes. Always a route this person may open. */
  href: string;
  noun: string;
  cta: string;
}

/**
 * THE TOP MISSION, OR NOTHING.
 *
 * Nothing is the right answer more often than it looks: a queue that is
 * empty, a request that has not come back, a person who may open none of
 * the screens their counts lead to. The card does not then say «لا شيء
 * ينتظرك» — «شغلك اليوم» already has the one place that sentence belongs,
 * and it says it only when it knows it is true.
 */
export function missionFor(
  items: readonly WorkItem[],
  mayOpen: (href: string) => boolean,
  /**
   * Asked once, for the one kind whose button promises something only a
   * permission delivers: «ابدأ التأكيد» says the reader will pull from the
   * queue, which a supervisor without the pull key cannot. Left out, every
   * reader is taken to hold what the button promises.
   */
  mayDo: (permission: string) => boolean = () => true
): Mission | null {
  const first = visibleWork(items, items.length).find((i) => i.href !== null && mayOpen(i.href));
  if (!first || !first.href) return null;
  // `key` is a `WorkKey`, so the map is total and no fallback is needed — a
  // second lookup here would only hide a kind somebody forgot to write copy for.
  const copy = MISSION_COPY[first.key];
  const watchOnly = first.key === 'CONFIRM_POOL' && !mayDo('confirmation.pull');
  return { item: first, href: first.href, noun: copy.noun, cta: watchOnly ? WATCH_ONLY_CTA : copy.cta };
}

/**
 * THE SENTENCE, ASSEMBLED — «12 طلب جديد بستنوا تأكيد ← ابدأ التأكيد».
 *
 * Kept here rather than in the component so the wording can be asserted
 * without a browser, and so the figure is never formatted by two places:
 * digits arrive as Latin (`ar-u-nu-latn` is the product's rule) and the
 * server's own ceiling is the one thing that shortens a number.
 */
export function missionSentence(mission: Mission, ceiling = 999): string {
  const n = mission.item.count >= ceiling ? `${ceiling}+` : String(mission.item.count);
  return `${n} ${mission.noun} ← ${mission.cta}`;
}
