/**
 * THE THREE THINGS A CUSTOMER SAYS AFTER THE ORDER IS CONFIRMED.
 *
 * «غيّر العنوان». «ألغِ الطلب». «مش هذا الأسبوع».
 *
 * The agent has an answer to the first and none to the other two. Her own
 * «ألغِ» and «تأجيل» buttons live on the queue screen and they are gone the
 * moment she confirms — after that, cancelling needs `orders.unlock` (the
 * manager) and holding a shipment back is an operations screen she cannot
 * open. So the customer says "cancel it", she says "I'll tell someone", and
 * whether anyone is told depends on whether she remembers.
 *
 * All three are one act: SHE CANNOT DO IT, SOMEBODY WHO CAN DECIDES, AND IT
 * IS CARRIED OUT. That is precisely what the change-request door already is
 * — a decider, an SLA that escalates and never auto-approves, an audit row,
 * and a notification to whoever must answer. It was only ever wired to one
 * of the three.
 *
 * So the request gains a word for what it is asking, and an approved one is
 * carried out through the path that ALREADY exists for that thing:
 *
 *   EDIT     → the apply path (money, seal and audit as a direct edit)
 *   CANCEL   → the confirmation route's `cancel`, which already refuses
 *              after the goods left and says why
 *   POSTPONE → `ops/shipments/hold`, which holds a confirmed order back to a
 *              date without rewinding its confirmation — and, on a parcel
 *              already on a trolley, takes it off the trolley first
 *
 * Nothing new decides, nothing new moves money, and nothing new writes a
 * state. This file only says which of the three doors an approval opens.
 *
 * Pure and client-safe: the dialog reads it to decide what to offer.
 */

export const CHANGE_INTENTS = ['EDIT', 'CANCEL', 'POSTPONE'] as const;
export type ChangeIntent = (typeof CHANGE_INTENTS)[number];

export const INTENT_AR: Record<ChangeIntent, string> = {
  EDIT: 'تعديل',
  CANCEL: 'إلغاء',
  POSTPONE: 'تأجيل',
};

/** What the person deciding is being asked to allow, in a sentence. */
export const INTENT_ASK_AR: Record<ChangeIntent, string> = {
  EDIT: 'تعديل حقل في الطلب',
  CANCEL: 'إلغاء الطلب',
  POSTPONE: 'تأجيل شحن الطلب إلى تاريخ لاحق',
};

/**
 * Where the parcel is — the one fact the cancel and the postponement turn on.
 *
 * `handedToCourier`, NOT `hasLeftWarehouse` (M6, 28/10): the owner ruled that
 * cancelling and postponing stay possible «لغاية ما اضغط اغلاق الشحنة»
 * — until the press of «إغلاق الشحنة — سُلّمت للشركة». A printed waybill or a
 * parcel on the pickup shelf commits the GOODS (that 28/09 line still decides
 * stock, in `shipment-cancel`), but the box is on our floor and can be
 * opened, so for «may this still be cancelled or held?» the line is the
 * handover.
 */
export interface ParcelFacts {
  handedToCourier: boolean;
}

export type CarryOut =
  /** Through the change-request apply path, as today. */
  | { kind: 'EDIT_ORDER' }
  /**
   * Still ours: cancel outright. The units go back on the shelf — for a
   * labelled or pickup-shelf parcel, on the word of the person who opened
   * the box (`ATTESTATION_AR`).
   */
  | { kind: 'CANCEL_ORDER' }
  /**
   * Gone: the courier is told to cancel the waybill, and the goods return
   * through the returns door where they are counted. Our record does not
   * pretend the parcel stopped moving because we decided it should.
   */
  | { kind: 'CANCEL_VIA_COURIER' }
  /** Still ours: held back to a date, confirmation untouched, the goods and the waybill kept. */
  | { kind: 'HOLD_SHIPMENT' }
  | { kind: 'REFUSED'; reason: string };

export function carryOut(intent: ChangeIntent, facts: ParcelFacts): CarryOut {
  if (intent === 'EDIT') return { kind: 'EDIT_ORDER' };
  if (intent === 'CANCEL') {
    return facts.handedToCourier ? { kind: 'CANCEL_VIA_COURIER' } : { kind: 'CANCEL_ORDER' };
  }
  /**
   * A PARCEL IN A VAN CANNOT BE POSTPONED.
   *
   * Holding a shipment means not handing it over yet. Once it is handed
   * over there is nothing left to hold: the only two things that can still
   * happen to it are delivery and return. Answering "postponed" here would
   * put a date on a screen while the driver knocks on the door tomorrow.
   *
   * The refusal names the door that IS open, because the customer who says
   * "not this week" while the parcel is out is asking for a cancellation
   * whether or not she used the word.
   */
  if (facts.handedToCourier) {
    return {
      kind: 'REFUSED',
      reason: 'الطرد سُلّم لشركة الشحن — لم يبقَ ما يُؤجَّل. اطلب الإلغاء ليُعاد، ثم ارفع طلباً جديداً بالموعد الذي يناسبه.',
    };
  }
  return { kind: 'HOLD_SHIPMENT' };
}

/**
 * What the door offers, and why it withholds the rest.
 *
 * The dialog asks before it draws, so a person never picks an intent that
 * the decision would have refused an hour later. A button that is missing
 * with a sentence beside it beats a button that fails.
 */
export function refusalFor(intent: ChangeIntent, facts: ParcelFacts): string | null {
  const out = carryOut(intent, facts);
  return out.kind === 'REFUSED' ? out.reason : null;
}

/**
 * What a request of this intent must carry besides its reason.
 *
 * Read by the route that accepts one and by the dialog that raises it, so
 * an empty cancellation cannot be raised and a postponement without a date
 * cannot either.
 */
export function missingFor(
  intent: ChangeIntent,
  body: { changes?: object | null; postponeUntil?: string | null }
): string | null {
  if (intent === 'EDIT') {
    return body.changes && Object.keys(body.changes).length > 0 ? null : 'حدّد حقلاً واحداً على الأقل';
  }
  if (intent === 'POSTPONE') {
    return body.postponeUntil ? null : 'حدّد التاريخ المطلوب التأجيل إليه';
  }
  // A cancellation is the reason, and the reason is demanded of all three.
  return null;
}
