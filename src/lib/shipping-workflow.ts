/**
 * SALESFLOW — Phase D2: Shipping & Delivery Workflow Engine
 *
 * All shippingStatus transitions are controlled server-side.
 * Server sets every timestamp (shippedAt, deliveredAt, ...) — never the client.
 */

export const SHIPPING_STATUSES = [
  'NOT_READY', 'READY_FOR_SHIPPING', 'PACKING', 'READY_FOR_PICKUP',
  'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'PARTIALLY_DELIVERED', 'FAILED_DELIVERY',
  'RETURN_REQUESTED', 'RETURNED', 'CANCELLED',
] as const;
export type ShippingStatus = (typeof SHIPPING_STATUSES)[number];

/**
 * Explicit allowed transitions. Anything not listed is rejected (409).
 * CANCELLED only via SUPER_ADMIN override path with reason.
 */
export const SHIPPING_TRANSITIONS: Record<ShippingStatus, ShippingStatus[]> = {
  NOT_READY: ['READY_FOR_SHIPPING'],
  READY_FOR_SHIPPING: ['PACKING'],
  PACKING: ['READY_FOR_PICKUP'],
  /*
   * ── REMOVED 28/10 (PR «قبل التسليم»): READY_FOR_PICKUP → RETURN_REQUESTED ──
   *
   * It was added so a labelled parcel that never moved could be «returned»
   * without faking a journey. But a parcel on our own floor has nothing to
   * return: nobody has it, so the status produced a FAKE RETURN that sat on the
   * returns desk, in the tracking alerts and in the customer's return rate for a
   * box that never left the building.
   *
   * What fits before «إغلاق الشحنة — سُلّمت للشركة» is the owner's M6 ruling:
   * cancel it (`endOrder`), hold it (`holdFromTrolley`), or move it to another
   * company as the same order (`moveBeforeHandover`). `beforeHandoverReturn`
   * below answers anybody still asking for the old transition, with those three.
   * The transition is MARKED here and not silently dropped; nothing else in the
   * state table changed.
   */
  READY_FOR_PICKUP: ['SHIPPED'],
  SHIPPED: ['OUT_FOR_DELIVERY'],
  // A partial delivery is reached at the door, like a whole one.
  OUT_FOR_DELIVERY: ['DELIVERED', 'PARTIALLY_DELIVERED', 'FAILED_DELIVERY'],
  FAILED_DELIVERY: ['RETURN_REQUESTED', 'SHIPPED'], // SHIPPED = retry dispatch
  RETURN_REQUESTED: ['RETURNED'],
  RETURNED: [],               // terminal
  DELIVERED: [],              // terminal
  // Terminal too: what was taken is taken, and the refused lines come back
  // through the normal return receiving, not by reopening the order.
  PARTIALLY_DELIVERED: [],
  CANCELLED: [],              // terminal
};

/** What anybody asking for the removed transition is told: the three doors that exist instead. */
export const RETURN_BEFORE_HANDOVER_AR =
  'الطرد لسّا عندنا وما انسلّم للشركة — ما في شي يرجع. ألغِ الطلب، أو أجّل شحنه، أو حوّله لشركة تانية (بيضل نفس الطلب).';

/**
 * Is this the removed READY_FOR_PICKUP → RETURN_REQUESTED?
 *
 * Asked BEFORE the transition table, because the table is the thing that was
 * changed and the override with a note (`orders.unlock`) walks past it: an
 * override must not bring the fake return back.
 */
export function beforeHandoverReturn(from: string, to: string): boolean {
  return from === 'READY_FOR_PICKUP' && to === 'RETURN_REQUESTED';
}

export function isValidShippingTransition(from: string, to: string): boolean {
  const list = SHIPPING_TRANSITIONS[from as ShippingStatus];
  if (!list) return false;
  return list.includes(to as ShippingStatus);
}

/** Timestamp field each shipping status sets (server-controlled) */
export const STATUS_TIMESTAMP: Partial<Record<ShippingStatus, string>> = {
  SHIPPED: 'shippedAt',
  OUT_FOR_DELIVERY: 'outForDeliveryAt',
  DELIVERED: 'deliveredAt',
  // A partial delivery IS a delivery — the customer took part of the parcel
  // and paid for it. Without this it had no deliveredAt, so the courier
  // statement sweep (settlement.ts, which filters on deliveredAt) never saw
  // the money, and the parcel stayed on the courier's debt list for ever.
  PARTIALLY_DELIVERED: 'deliveredAt',
  FAILED_DELIVERY: 'failedAt',
  RETURNED: 'returnedAt',
};

/** Structured delivery-failure reasons */
export const DELIVERY_FAILURE_REASONS = [
  'CUSTOMER_NOT_AVAILABLE', 'PHONE_UNREACHABLE', 'WRONG_ADDRESS',
  'CUSTOMER_REFUSED', 'ADDRESS_NOT_FOUND', 'AREA_NOT_SERVICED',
  'CUSTOMER_REQUESTED_DELAY', 'OTHER',
] as const;

/** Structured return reasons */
export const RETURN_REASONS = [
  'CUSTOMER_REFUSED', 'FAILED_DELIVERY', 'DAMAGED_PRODUCT',
  'WRONG_PRODUCT', 'CUSTOMER_REQUEST', 'OTHER',
] as const;

/**
 * AND WHAT THOSE TWO LISTS ARE CALLED, beside the lists themselves.
 *
 * Both label tables lived inside `ShippingSection.tsx` as `const
 * RETURN_REASONS` — shadowing the canonical list imported from here, under
 * the same name. Nothing kept them in step, and a code added to the list
 * here would have rendered to an Arabic reader as a raw English constant on
 * every screen. That is the divergence the delivery-attempt vocabulary
 * already cost this codebase once, and the reason `REJECTION_REASON_AR` sits
 * next to `REJECTION_REASONS` rather than in a screen.
 *
 * Bilingual, because the screen that renders them renders English too —
 * moved here exactly as they were, so nothing reads differently today.
 */
export const RETURN_REASON_LABELS: Record<string, { ar: string; en: string }> = {
  CUSTOMER_REFUSED: { ar: 'العميل رفض', en: 'Customer refused' },
  FAILED_DELIVERY: { ar: 'فشل التوصيل', en: 'Failed delivery' },
  DAMAGED_PRODUCT: { ar: 'منتج تالف', en: 'Damaged product' },
  WRONG_PRODUCT: { ar: 'منتج خاطئ', en: 'Wrong product' },
  CUSTOMER_REQUEST: { ar: 'طلب العميل', en: 'Customer request' },
  OTHER: { ar: 'أخرى', en: 'Other' },
};

export const DELIVERY_FAILURE_REASON_LABELS: Record<string, { ar: string; en: string }> = {
  CUSTOMER_NOT_AVAILABLE: { ar: 'العميل غير متوفر', en: 'Customer not available' },
  PHONE_UNREACHABLE: { ar: 'الهاتف لا يرد', en: 'Phone unreachable' },
  WRONG_ADDRESS: { ar: 'عنوان خاطئ', en: 'Wrong address' },
  CUSTOMER_REFUSED: { ar: 'العميل رفض', en: 'Customer refused' },
  ADDRESS_NOT_FOUND: { ar: 'العنوان غير موجود', en: 'Address not found' },
  AREA_NOT_SERVICED: { ar: 'منطقة غير مخدومة', en: 'Area not serviced' },
  CUSTOMER_REQUESTED_DELAY: { ar: 'العميل طلب تأخير', en: 'Customer requested delay' },
  OTHER: { ar: 'أخرى', en: 'Other' },
};

/**
 * WHAT HAPPENED TO THE PARCEL — and, separately, why.
 *
 * This list used to carry `CUSTOMER_UNAVAILABLE` and `CUSTOMER_REFUSED`
 * beside `FAILED`, while `DELIVERY_FAILURE_REASONS` carried
 * `CUSTOMER_NOT_AVAILABLE` and `CUSTOMER_REFUSED`. Two vocabularies for one
 * event, and two spellings of it — which is precisely how the screen ended
 * up with a translation map that had `CUSTOMER_NOT_AVAILABLE` in it and
 * could not read a row that said `CUSTOMER_UNAVAILABLE`.
 *
 * So a result says what became of the parcel and nothing else. A `FAILED`
 * result carries its reason in `failureReason`, from the eight-value list
 * above, which the endpoint already REQUIRES — so nothing is lost by the
 * result no longer guessing at it.
 *
 * `PARTIALLY_DELIVERED` is new here and was always missing: the domain
 * produces that outcome (`recordPartialDelivery`), the screen already knew
 * the word for it, and the only place it could not be written was the
 * column meant to record it.
 */
export const DELIVERY_ATTEMPT_RESULTS = [
  'DELIVERED', 'PARTIALLY_DELIVERED', 'FAILED', 'RESCHEDULED', 'OTHER',
] as const;
export type DeliveryAttemptResult = (typeof DELIVERY_ATTEMPT_RESULTS)[number];

/**
 * Readable in Arabic — including the two codes no longer offered.
 *
 * `delivery_attempts` measured 0 rows here, so narrowing the writable list
 * costs nothing on this database. But this is a dev database and I cannot
 * see production, so the two retired codes keep their words: an old row
 * must still read as a sentence rather than as an English constant.
 */
export const ATTEMPT_RESULT_AR: Record<string, string> = {
  DELIVERED: 'سُلّم',
  PARTIALLY_DELIVERED: 'سُلّم جزئياً',
  FAILED: 'فشل',
  RESCHEDULED: 'أُعيدت جدولته',
  OTHER: 'أخرى',
  // Retired, still readable.
  CUSTOMER_UNAVAILABLE: 'العميل غير متواجد',
  CUSTOMER_REFUSED: 'العميل رفض الاستلام',
};

/**
 * THE ATTEMPT A STATUS CHANGE IMPLIES, IF ANY.
 *
 * An order does not arrive at DELIVERED by itself — somebody stood at a
 * door. That knock is what `delivery_attempts` is for, and until now only
 * the failures were written there: the table's name said «attempts» and its
 * contents were failures, so «delivered on the first try» was not a
 * measurable thing.
 *
 * RETURNED is deliberately absent. It follows RETURN_REQUESTED and happens
 * at a warehouse, not at a door — a parcel coming back is not a further
 * attempt to hand it over. The door-side refusal is recorded by
 * `recordPartialDelivery`, which knows it was a refusal.
 */
export function attemptForShippingStatus(
  status: string,
  opts: { failureReason?: string | null } = {}
): { result: DeliveryAttemptResult; failureReason: string | null } | null {
  if (status === 'DELIVERED') return { result: 'DELIVERED', failureReason: null };
  if (status === 'PARTIALLY_DELIVERED') return { result: 'PARTIALLY_DELIVERED', failureReason: null };
  if (status === 'FAILED_DELIVERY') return { result: 'FAILED', failureReason: opts.failureReason ?? 'OTHER' };
  return null;
}

/**
 * Confirmation dependency (Section 4): shipping may only start on CONFIRMED orders.
 * Entering READY_FOR_SHIPPING requires confirmationStatus === 'CONFIRMED'.
 */
export function canEnterShipping(confirmationStatus: string): boolean {
  return confirmationStatus === 'CONFIRMED';
}

/**
 * ONE WORD PER SHIPPING STATUS, AND IT LIVES HERE.
 *
 * `order-state.ts` learned this lesson once already, for the core state:
 * «There were three copies… six of the sixteen states were spelled
 * differently between the first two». The shipping status never learned
 * it. It had SIX vocabularies — the shipping card, the tracking screen,
 * the courier-custody screen, `ui/Badge`, the status route and `i18n` —
 * and every single value had at least two spellings:
 *
 *   DELIVERED          مسلَّم · تم التسليم · سُلّم · مُسلَّم
 *   SHIPPED            مشحون · تم الشحن
 *   OUT_FOR_DELIVERY   خرج للتوصيل · خارج للتوصيل
 *   FAILED_DELIVERY    فشل التوصيل · تعذر التوصيل · تعذّر التوصيل
 *   RETURN_REQUESTED   طلب إرجاع · طُلب إرجاعه · مطلوب إرجاعه
 *   READY_FOR_PICKUP   جاهز للاستلام · بانتظار الاستلام
 *   PACKING            تغليف · قيد التجهيز
 *
 * Nobody chose that; each screen chose once. The parcel a warehouse calls
 * «سُلّم» is the one the tracking screen calls «تم التسليم», and a person
 * comparing two screens cannot tell whether they are looking at the same
 * fact.
 *
 * HOW EACH WORD WAS PICKED. Where a core state carries the same name, its
 * word wins — the two axes describe one parcel, and a badge reading
 * «مسلَّم» above a card reading «تم التسليم» is the defect whichever of
 * them is «right». Otherwise the spelling already used in the most places
 * wins. The one exception is PACKING: the status route called it «قيد
 * التجهيز», which is the core state PREPARING's word, so the two would
 * have collided — it is «قيد التغليف», which is what it is.
 */
export const SHIPPING_STATUS_AR: Record<ShippingStatus, string> = {
  NOT_READY: 'غير جاهز',
  READY_FOR_SHIPPING: 'جاهز للشحن',
  PACKING: 'قيد التغليف',
  READY_FOR_PICKUP: 'بانتظار الاستلام',
  SHIPPED: 'مشحون',
  OUT_FOR_DELIVERY: 'خرج للتوصيل',
  DELIVERED: 'مسلَّم',
  PARTIALLY_DELIVERED: 'مسلَّم جزئياً',
  FAILED_DELIVERY: 'فشل التوصيل',
  RETURN_REQUESTED: 'طلب إرجاع',
  RETURNED: 'مرتجع',
  CANCELLED: 'ملغى',
};
