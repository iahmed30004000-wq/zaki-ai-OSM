/**
 * WHAT A PERSON IS TOLD AFTER RAISING A CHANGE REQUEST — WHERE IT WENT.
 *
 * «حتى لما رفعت طلب تعديل ما ظهر بطلبات التعديل». A request its raiser may also decide is approved on the spot, so it is
 * not in «بانتظار القرار» at all; if carrying it out then fails (the parcel is labelled, the shelf is short, the total
 * moved) it sits in «بانتظار التطبيق» — and the screen she raised it from said «أُرسل الطلب» or showed a bare error, and she
 * went looking in the tab that was empty. There are three places a raised request can be, and each is said in a sentence
 * that names where to look:
 *
 *   APPLIED           — carried out. Nothing to look for.
 *   APPROVED_WAITING  — approved by its raiser on the spot, and the last step failed: it waits in «بانتظار التطبيق».
 *   WAITING           — raised; somebody else decides it, in «بانتظار القرار».
 *
 * A person who does not hold the screen of the requests is never pointed at it: a link to a page she cannot open is the
 * same dead end with a button on it. Pure and client-safe (the raisers run in the browser).
 */

export type RaiseOutcome = 'APPLIED' | 'APPROVED_WAITING' | 'WAITING';

export interface RaisedAnswer {
  outcome: RaiseOutcome;
  message: string;
}

export type RaisedIntent = 'EDIT' | 'CANCEL' | 'POSTPONE';

/** Where the request is looked for, by tab — the words the tabs carry. */
export const WHERE_APPROVED_AR = 'افتح طلبات التعديل ← بانتظار التطبيق';
export const WHERE_PENDING_AR = 'طلبات التعديل ← بانتظار القرار';

/**
 * The statuses of an order before confirmation (`BEFORE_OPERATIONS` of `change-request-routing`, which is server-only; a
 * test holds the two lists equal). Before it, the agent holding the order decides, or any supervisor.
 */
export const BEFORE_CONFIRMATION = ['NEW', 'IN_PROGRESS', 'NO_ANSWER', 'FOLLOW_UP_REQUIRED', 'POSTPONED'];

/**
 * WHO WILL DECIDE IT, in the words the team uses — from the order's status, the one thing the raising answer carries.
 *
 * Whoever cannot open the requests screen is told «المشرف»: the supervisor can always decide, and it is the one name that
 * is true for every stage. Whoever can is told the stage's own deciders (`deciderFor`): the agent holding the order before
 * confirmation, the packing table or a supervisor after it. The exact person is the server's to know and is not guessed.
 */
export function waitingFor(orderStatus: string | null | undefined, canOpenQueue: boolean): string {
  if (!canOpenQueue) return 'المشرف';
  return orderStatus && BEFORE_CONFIRMATION.includes(orderStatus) ? 'الموظف المسؤول عن الطلب أو المشرف' : 'المشرف أو مسؤول المخزن';
}

const DONE_AR: Record<RaisedIntent, string> = {
  EDIT: 'طُبِّق التعديل على الطلب.',
  CANCEL: 'نُفِّذ الإلغاء.',
  POSTPONE: 'أُجّل الشحن.',
};

export function answerAfterRaise(a: {
  intent: RaisedIntent;
  /** The server said the raiser may also decide it and the parcel is still ours. */
  readyToApply: boolean;
  /** The sentence the last step failed with, when it did. Only read when `readyToApply`. */
  failure?: string | null;
  orderStatus?: string | null;
  /** Holds the screen of the requests. */
  canOpenQueue: boolean;
}): RaisedAnswer {
  if (a.readyToApply && a.failure === undefined) {
    return { outcome: 'APPLIED', message: DONE_AR[a.intent] };
  }
  if (a.readyToApply) {
    const where = a.canOpenQueue ? WHERE_APPROVED_AR : 'بلّغ المشرف ليطبّقه';
    const why = a.failure ? ` (${a.failure})` : '';
    return { outcome: 'APPROVED_WAITING', message: `اعتُمد مباشرة وهو بانتظار التطبيق — ${where}.${why}` };
  }
  const who = waitingFor(a.orderStatus, a.canOpenQueue);
  return {
    outcome: 'WAITING',
    message: a.canOpenQueue ? `رُفع طلبك وبانتظار قرار ${who} — تجده في ${WHERE_PENDING_AR}.` : `رُفع طلبك وبانتظار قرار ${who}.`,
  };
}
