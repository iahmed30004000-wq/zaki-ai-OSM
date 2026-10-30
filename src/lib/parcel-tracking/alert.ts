/**
 * WHAT THE PERSON CHASING A PARCEL MUST BE TOLD.
 *
 * The tracking list shows where every parcel is. It did not show the two
 * things that make chasing one pointless or wrong:
 *
 *   THE ORDER WAS CANCELLED while the parcel is still moving. She rings
 *   the customer about a delivery that is not happening, and the courier
 *   is still carrying goods nobody is going to pay for.
 *
 *   THE ORDER'S DATA CHANGED — an approved change was written onto it.
 *   The address she is reading, or the amount she is about to quote, is
 *   not the one that was true when she last looked.
 *
 * Asked for in these words: «الطلب بيضوي أحمر إذا ملغي في قائمة متابعة
 * الطلبات، وبرتقالي إذا في تعديل بالبيانات. والبنت المتابِعة مجرد ما
 * تشوف، لازم زر، وبالزر يطلع Pop إنها أدركت الإجراء».
 *
 * AND IT IS ACKNOWLEDGED, NOT DISMISSED. A colour that anybody can turn
 * off teaches people to turn it off. Pressing the button writes who saw
 * it and when, onto the order, beside everything else that happened to
 * it — so «did anyone notice this was cancelled» has an answer.
 *
 * Pure: the screen and the route both read it, and a rule written twice
 * is a rule that disagrees with itself.
 */

export const TRACKING_ACK_ACTION = 'TRACKING_ALERT_ACKNOWLEDGED';

export type TrackingAlertKind = 'CANCELLED' | 'CHANGED';

export interface TrackingAlert {
  kind: TrackingAlertKind;
  /** When the thing being announced happened. */
  at: Date;
  /** True once somebody has said they saw THIS one. */
  acknowledged: boolean;
}

/** Confirmation states that mean the order is dead while the parcel lives. */
export const DEAD_CONFIRMATION: readonly string[] = ['REJECTED', 'CANCELLED'];

export interface AlertSource {
  confirmationStatus: string;
  /**
   * When it was cancelled. Null when it is not cancelled, or when no
   * status log survives — in which case the order's own last write is the
   * honest approximation and is passed in as such.
   */
  cancelledAt: Date | string | null;
  /** The most recent moment an approved change was written onto it. */
  changeAppliedAt: Date | string | null;
  /** The most recent acknowledgement on this order, whatever it was for. */
  acknowledgedAt: Date | string | null;
  /**
   * Whether the parcel is still on its way. An alert is about a parcel that MOVES while the order is dead or rewritten;
   * one that has arrived or come back has nothing left to stop or re-read. Left out, it is taken as «on its way», which
   * is what every caller before this knew.
   */
  inFlight?: boolean;
}

const at = (v: Date | string | null | undefined): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? null : d;
};

/**
 * The one thing worth saying about this order, or nothing.
 *
 * CANCELLED WINS over a data change: if the order is dead, what its
 * address says no longer matters, and two colours on one row is a row
 * nobody reads.
 */
export function trackingAlert(order: AlertSource): TrackingAlert | null {
  if (order.inFlight === false) return null;
  const ack = at(order.acknowledgedAt);
  const seen = (when: Date) => !!ack && ack.getTime() >= when.getTime();

  if (DEAD_CONFIRMATION.includes(order.confirmationStatus)) {
    const when = at(order.cancelledAt);
    // A cancellation with no timestamp is still a cancellation: it is
    // announced, and any acknowledgement counts for it.
    if (!when) return { kind: 'CANCELLED', at: new Date(0), acknowledged: !!ack };
    return { kind: 'CANCELLED', at: when, acknowledged: seen(when) };
  }

  const changed = at(order.changeAppliedAt);
  if (changed) return { kind: 'CHANGED', at: changed, acknowledged: seen(changed) };

  return null;
}

/** What the row says, in the reader's own words. */
export const ALERT_AR: Record<TrackingAlertKind, string> = {
  CANCELLED: 'أُلغي الطلب — الطرد ما زال عند الشحن',
  CHANGED: 'تغيّرت بيانات الطلب بعد إرساله',
};

/** And what pressing the button means, said before it is pressed. */
export const ALERT_CONFIRM_AR: Record<TrackingAlertKind, string> = {
  CANCELLED: 'يُسجَّل باسمك أنّك رأيتَ الإلغاء وستتصرّف — ولا يتغيّر شيءٌ في الطلب.',
  CHANGED: 'يُسجَّل باسمك أنّك رأيتَ التعديل — ولا يتغيّر شيءٌ في الطلب.',
};
