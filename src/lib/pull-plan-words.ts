/**
 * THE PULL PANEL'S WORDS UNDER THE PLAN (the planner 15/11, ruling 24) — said by the server, drawn by the screen without logic (the way `closedCardWords` is).
 *
 * With «جدول المحاولات» on, the pull hands orders out as: held for her · NEW · the promise that arrived · the retry whose time came · the rest. The panel's
 * counter and its sentence say those four things, in that order, so the figure above the button and the order the button gives are one story.
 * Off, none of this is sent: the response keeps its three old keys and the screen keeps its old words (a test pins it).
 *
 * Pure. The numbers come from `waitingByPlan` (the pull's own predicates); this file only gives them names.
 */
import type { WaitingByPlan } from './confirmation-queue';

export interface PlanPart {
  label: string;
  hint: string;
  value: number;
}

export interface PlanWords {
  /** In the pull's order. The screen draws them as they come (the first is the urgent one). */
  parts: PlanPart[];
  /** The one sentence under the card: who comes first. Replaces the static sentence, which names the old order. */
  rule: string;
}

/**
 * The sentence under the card. The idle number is NOT written here (the planner 16/11, ruling 36): the caller passes the setting itself
 * (`RETURNS_MODE.idleBusinessMinutes` — today 30, so «30 دقيقة دوام»), so the screen can never say a figure the release does not use.
 * Only this plan-on sentence is changed; with the key off the screen keeps its old sentence word for word (a live screen, unchanged).
 */
export function planRule(idleBusinessMinutes: number): string {
  return `طلب الزبون الراجع اللي تابع إلك بيجيك أول، وبعده الجديد اللي ما حدا اتصل فيه، وبعده الوعد اللي وصل موعده، وبعده الإعادة اللي حان موعدها، وبعده الباقي الأقدم. أي طلب بلا محاولة اتصال بيرجع للطابور بعد ${idleBusinessMinutes} دقيقة دوام.`;
}

/**
 * THE SENTENCE UNDER THE CARD WITH «الطلب يرجع للطابور فوراً» ON AND THE PLAN OFF (the rounds + the returns mode, the legacy pair — finding #10 of the rules map, 18/11).
 * The panel's own old sentence says «المؤجّل اللي موعده خلال 2 يوم» and «بعد 90 دقيقة عمل»: both are the mode-OFF rules. With the mode on a postponed order is pulled AT its date
 * (the lead is 0) and the untouched release is the mode's idle limit (30, or 20 with «أولوية الطابور») — passed in by the caller from `returnsLimits`, the one function every reader asks.
 * Mode off: the server sends nothing and the screen keeps its old sentence, word for word.
 */
export function returnsModeRule(idleBusinessMinutes: number): string {
  return `طلب الزبون الراجع اللي تابع إلك بيجيك أول، وبعده الطلب الجديد اللي ما حدا اتصل فيه، وبعده المؤجّل اللي وصل موعده، وبعده الأقدم. أي طلب بلا محاولة اتصال بيرجع للطابور بعد ${idleBusinessMinutes} دقيقة دوام.`;
}

export function planWords(parts: WaitingByPlan, idleBusinessMinutes: number): PlanWords {
  return {
    parts: [
      { label: 'جديد', hint: 'ما حدا اتصل فيه', value: parts.fresh },
      { label: 'وعد وصل', hint: 'الزبون طلب نكلمو وحان موعده', value: parts.promise },
      { label: 'إعادة حان موعدها', hint: 'حان وقت المحاولة التانية', value: parts.retry },
      { label: 'الباقي', hint: 'الأقدم أول', value: parts.rest },
    ],
    rule: planRule(idleBusinessMinutes),
  };
}
