import { SEALED_FIELDS } from './order-seal';
import { CHANGE_FIELD_AR, type ChangeableField } from './change-request-fields';

/**
 * A CHANGE TO AN ORDER THE COURIER IS ALREADY HOLDING.
 *
 * Once the waybill is printed and on the box, the paper is the address. The
 * seal says so in as many words — «changing the address in here changes
 * nothing the driver will ever read; it only makes our record disagree with
 * the parcel» — and then the apply path handed an approved change request a
 * key past it: `viaRequest ? [] : sealedFieldsIn(data)`.
 *
 * The reasoning behind that key was that a human had decided, and a human
 * deciding is assumed to have rung the courier. Nothing anywhere checked
 * that they had. So the common case was: supervisor approves «العنوان: حيّ
 * الوعر بدل بابا عمرو», somebody presses «طبّق», our record now says Al-Waer,
 * the parcel goes to Baba Amr, and every screen afterwards shows an address
 * that was never on the box.
 *
 * THE COURIER HOLDS THE TRUTH NOW, so the instrument is a message to them,
 * not an edit to us. What this file decides is which message, in words a
 * dispatcher can act on without opening our system.
 *
 *   AN ADDRESS OR A PHONE  → they can change it on their side, on the same
 *                            waybill. One message, and the parcel still goes.
 *   ANYTHING IN THE BOX    → quantity, product, offer. No dispatcher can
 *                            open a carton. It is a cancellation of this
 *                            waybill and a fresh order with the change.
 *   NOTHING SEALED         → a note, the customer's own remark. It never
 *                            reached the courier and does not need to.
 *
 * And our record changes only AFTER somebody says the courier was told, so
 * the two can no longer drift apart in silence.
 */

export const COURIER_ACTIONS = ['NONE', 'CONTACT_CHANGE', 'CANCEL_AND_REORDER'] as const;
export type CourierAction = (typeof COURIER_ACTIONS)[number];

/**
 * What the courier can still change on a waybill they hold.
 *
 * A dispatcher edits an address or a phone in their own system and the same
 * parcel goes to the new one. They cannot open the carton, so nothing about
 * the goods is on this list.
 */
export const COURIER_FIXABLE: readonly string[] = [
  'customerName',
  'customerPhone',
  'customerAltPhone',
  'customerAddress',
  'customerCity',
  'regionId',
];

/** Which requested fields the seal actually protects. */
export function sealedAmong(fields: readonly string[]): string[] {
  return fields.filter((f) => (SEALED_FIELDS as readonly string[]).includes(f));
}

export function courierActionFor(fields: readonly string[]): CourierAction {
  const sealed = sealedAmong(fields);
  if (sealed.length === 0) return 'NONE';
  // One field out of reach is enough: a waybill cannot be half-cancelled.
  return sealed.every((f) => COURIER_FIXABLE.includes(f)) ? 'CONTACT_CHANGE' : 'CANCEL_AND_REORDER';
}

export interface CourierMessageInput {
  action: Exclude<CourierAction, 'NONE'>;
  orderNumber: string;
  /** The courier's own barcode, which is what THEY search by. */
  trackingNumber?: string | null;
  storeName?: string | null;
  /** field → the value it should become, already in words. */
  changes: Record<string, string>;
}

/**
 * THE MESSAGE, WRITTEN FOR A DISPATCHER.
 *
 * Their tracking number first, because that is what they search by — our
 * order number means nothing in their system and is included only so the
 * reply can be matched back. Then the one thing we want done, in an
 * imperative sentence, and then the values. No pleasantries and no context
 * they did not ask for: this is read on a phone, between two other calls.
 */
export function courierMessage(input: CourierMessageInput): string {
  const { action, orderNumber, trackingNumber, storeName, changes } = input;
  const ref = trackingNumber?.trim()
    ? `بوليصة رقم ${trackingNumber.trim()}`
    : `طلب رقم ${orderNumber}`;
  const from = storeName?.trim() ? ` (${storeName.trim()})` : '';

  const lines = Object.entries(changes).map(
    ([field, value]) => `• ${CHANGE_FIELD_AR[field as ChangeableField] ?? field}: ${value}`
  );

  if (action === 'CONTACT_CHANGE') {
    return [
      `السلام عليكم، ${ref}${from}.`,
      'نرجو تعديل بيانات التسليم على البوليصة نفسها:',
      ...lines,
      'وأفيدونا بالتأكيد. شكراً لكم.',
    ].join('\n');
  }

  return [
    `السلام عليكم، ${ref}${from}.`,
    'نرجو إلغاء هذه البوليصة وعدم تسليمها — تغيّرت محتويات الطلب:',
    ...lines,
    'وسنرسل لكم بوليصة جديدة بالطلب المعدّل. شكراً لكم.',
  ].join('\n');
}

/** Why our record is not being changed yet, in the reader's own words. */
export function courierActionAr(action: CourierAction): string {
  if (action === 'CONTACT_CHANGE') {
    return 'الطرد عند شركة الشحن وبوليصتُه مطبوعة — يُعدَّل عندهم على البوليصة نفسها، ثمّ يُطبَّق عندنا.';
  }
  if (action === 'CANCEL_AND_REORDER') {
    return 'الطرد عند شركة الشحن ولا أحدَ يفتح الكرتونة — تُلغى البوليصة ويُرفع طلبٌ جديد بالتعديل.';
  }
  return '';
}

/**
 * A CANCELLATION OF A PARCEL THE COURIER ALREADY HOLDS.
 *
 * An approved cancel used to reach `stand-down`, which refuses once the
 * waybill is printed — and refusing was the end: the approval sat «waiting
 * to be applied» for ever, the courier was never told, and the customer's
 * parcel went on to the customer's door. The refusal's own text promised
 * «it is recorded as a cancel request», and the request WAS the record —
 * nothing carried it out.
 *
 * Carrying it out is a message to the company, not a change to our order:
 * the order stays where it is, the goods stay counted as the parcel's, and
 * the return comes back through the returns door, counted, like any other.
 * Same shape as `courierMessage`: their barcode first, one imperative
 * sentence, then the reason.
 */
export function courierCancelMessage(input: {
  orderNumber: string;
  trackingNumber?: string | null;
  storeName?: string | null;
  /** Why the customer cancelled, already in words. */
  reason?: string | null;
}): string {
  const { orderNumber, trackingNumber, storeName, reason } = input;
  const ref = trackingNumber?.trim() ? `بوليصة رقم ${trackingNumber.trim()}` : `طلب رقم ${orderNumber}`;
  const from = storeName?.trim() ? ` (${storeName.trim()})` : '';
  return [
    `السلام عليكم، ${ref}${from}.`,
    'نرجو إلغاء هذه البوليصة وعدم تسليم الطرد — الزبون ألغى الطلب.',
    ...(reason?.trim() ? [`• السبب: ${reason.trim()}`] : []),
    `وأفيدونا فور إرجاع الطرد إلينا (طلب رقم ${orderNumber}). شكراً لكم.`,
  ].join('\n');
}

/** Why our record is not changing: the courier has to stop the parcel first. */
export const COURIER_CANCEL_AR =
  'الطرد عند شركة الشحن وبوليصتُه مطبوعة — الإلغاء عندنا ما بيوقّفه. أبلغ الشركة ليوقفوه، وبيرجع عبر باب المرتجعات ويتعدّ.';
