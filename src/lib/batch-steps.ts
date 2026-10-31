/**
 * A TROLLEY GOES ONE WAY: READY → SHIPPED → CLOSED.
 *
 * The batch PATCH used to take any of the three words from any of the three
 * states, in two separate statements: the batch row first, then its orders.
 * So a press on an already-handed-over batch stamped nothing twice but a
 * press on a CLOSED one reopened it, a READY → CLOSED skipped the handover
 * and left every parcel un-stamped, and a failure between the two statements
 * left a batch SHIPPED with orders still waiting for pickup.
 *
 * This file owns the one list of steps and the words for refusing the rest.
 * The route writes the step as a CONDITION on the batch's current status, in
 * one transaction, so two presses at once cannot both win.
 */

export const BATCH_STATUSES = ['READY', 'SHIPPED', 'CLOSED'] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

/** From → the only status it may go to. */
const NEXT: Record<BatchStatus, BatchStatus | null> = {
  READY: 'SHIPPED',
  SHIPPED: 'CLOSED',
  CLOSED: null,
};

export type StepVerdict =
  | { ok: true }
  | { ok: false; code: 'BATCH_STEP_DONE' | 'BATCH_FORWARD_ONLY'; message: string };

export function checkStep(from: string, to: BatchStatus): StepVerdict {
  if (from === to) {
    return { ok: false, code: 'BATCH_STEP_DONE', message: 'الدفعة بهالحالة أصلاً — يمكن حدا ضغط قبلك. حدّث الصفحة.' };
  }
  if (NEXT[from as BatchStatus] !== to) {
    return {
      ok: false,
      code: 'BATCH_FORWARD_ONLY',
      message: 'الدفعة بتمشي لقدّام بس: تجميع، ثم تسليم، ثم إغلاق. ما بترجع ولا بتقفز.',
    };
  }
  return { ok: true };
}

/** The refusal for pressing «إغلاق الشحنة — سُلّمت للشركة» on a trolley with nothing on it. */
export const EMPTY_BATCH_AR = 'الدفعة فاضية — ما في طرد يتسلّم للشركة.';

/** The refusal that names the parcels still waiting for an answer. */
export function pendingChangesMessage(orderNumbers: string[]): string {
  const shown = orderNumbers.slice(0, 8).join('، ');
  const more = orderNumbers.length > 8 ? ` و${orderNumbers.length - 8} غيرها` : '';
  return `ما بيصير تسلّم الدفعة: على هالطلبات إلغاء أو تأجيل لسّا ما انحسم (${shown}${more}). قرّروا فيهم أوّلاً.`;
}

/**
 * THE HANDOVER OF A BATCH THAT WAS NEVER SENT TO ITS COURIER.
 *
 * «إغلاق الشحنة — سُلّمت للشركة» is the line after which a parcel can no longer be sent to the company by API (the dispatch
 * refuses a batch that is not READY), so the courier's barcode can never come back and no waybill can be printed. A courier
 * that is connected by API is sent to BEFORE the handover; pressing the handover first is the mistake this sentence stops
 * (BATCH-2026-0004, 31/10: 147 orders). The press may still go ahead when the person says so — the courier's API can be
 * down on the day — but only on purpose, with the number in front of her.
 */
export function unsentMessage(orderNumbers: string[]): string {
  const shown = orderNumbers.slice(0, 5).join('، ');
  const more = orderNumbers.length > 5 ? ' …' : '';
  return (
    `${orderNumbers.length} طلب من هالدفعة ما انرحّل للشركة وما إله باركودها (${shown}${more}). ` +
    'بعد «إغلاق الشحنة» ما بيصير ترحيله من هون، وما بتنطبع بوالصه. رحّل الدفعة أولاً بزر «رحّل إلى الشركة واجلب الباركود».'
  );
}
