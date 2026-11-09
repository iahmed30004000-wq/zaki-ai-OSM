/**
 * «استلم» FOR A PAGE OF PARCELS AT ONCE — WHICH PARCELS QUALIFY, SAID IN ONE PLACE.
 *
 * The delivery company's feed never writes «delivered» on an order (`COURIER_CANNOT_ASSERT`): it keeps its word as a line
 * on the timeline, and the follow-up list draws that word on the row («الشركة بتقول: تم التوصيل»). The people chasing a
 * late parcel still pressed «استلم» one parcel at a time, and most of the late pile turned out to be parcels the company
 * already says it delivered. This is the rule for ONE press over a page of them, and it is deliberately narrow:
 *
 *   · only a parcel whose NEWEST word is exactly «تم التوصيل» — never a part delivery, never «مؤجلة», never no word;
 *   · only a parcel that has the «استلم» box on the screen (on the road: «مشحون» or «خرج للتوصيل»);
 *   · the same box as the single press (`ops.deliver`), the server judging each row itself — the screen only draws.
 *
 * It records the delivery and takes the goods off the shelf EXACTLY like the single «استلم» (the door calls the same
 * `recordPartialDelivery`). It writes no money: the amount still comes from the company's statement, and the company's
 * word is a word — the statement is the proof.
 *
 * Pure and light on purpose: the screen reads the same constants and the same test the door judges with, so a box
 * drawn on a row and the answer the door gives cannot be two rules. No database, no server module is imported here.
 */

/** Most parcels one press may carry. The page is 25; the door refuses a bigger request outright. */
export const BULK_DELIVER_MOST = 50;

/**
 * The states whose row carries the «استلم» box on the follow-up screen.
 *
 * The single door also accepts «فشل التوصيل» (a failed attempt is a parcel still on the road, RV111), but the screen
 * draws no «استلم» for it — so the press over a page does not take it either: the page may not do more than the row.
 */
export const DELIVER_BOX_STATES = ['SHIPPED', 'OUT_FOR_DELIVERY'] as const;
export const hasDeliverBox = (shippingStatus: string): boolean => (DELIVER_BOX_STATES as readonly string[]).includes(shippingStatus);

/**
 * Does THIS row, as the list sent it, qualify to be ticked? Its newest word (`courierSaid`, judged by the server with the
 * company's CODE and never the free note) is «تم التوصيل» and it has the box. The door asks the same question again,
 * about the order as it is at the moment of the press.
 */
export function canBulkDeliver(row: { shippingStatus: string; courierSaid?: { status: string } | null }): boolean {
  return hasDeliverBox(row.shippingStatus) && row.courierSaid?.status === 'DELIVERED';
}

/** One row of the answer. `orderNumber` is null for an id the door could not find in this store. */
export interface BulkDeliverResult {
  orderId: string;
  orderNumber: string | null;
  ok: boolean;
  /** Why the row was not recorded — a short plain sentence, only when `ok` is false. */
  reason?: string;
}

/** The answer of the press: one line per parcel, in the order asked, and the two totals. */
export interface BulkDeliverReport {
  results: BulkDeliverResult[];
  delivered: number;
  refused: number;
}

/**
 * What the confirmation says, in plain words: what will happen, and what will NOT. The money is the statement's — said
 * here, in the dialog, so nobody presses it believing the amount was collected.
 */
export const BULK_DELIVER_CONFIRM_AR = [
  'الشركة بتقول إنها وصّلت هالطرود. بالضغط بينسجّل إنها انسلّمت للزبون وبتنزل من المخزون.',
  'ما رح ينكتب أي مبلغ: المبلغ بيجي لما يتطابق كشف الشركة. كلمة الشركة مجرد كلمة، والكشف هو الإثبات.',
  'النظام بيفحص كل طرد لحاله: اللي تغيّرت كلمة الشركة عنو أو انسجّل قبل بيتخطّاه وبيقولك ليش.',
].join('\n');

/** The internal note each recorded order carries, so a later reader knows how its delivery came to be written. */
export const BULK_DELIVER_NOTE_AR = 'سُجِّل بـ«استلم» الجماعي لأنّ الشركة قالت «تم التوصيل»';
