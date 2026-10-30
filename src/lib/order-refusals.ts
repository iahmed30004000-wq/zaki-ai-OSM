/**
 * WHAT THE ORDERS GROUP SAYS WHEN IT REFUSES, WRITTEN ONCE.
 *
 * Measured across `src/app/api/orders/**`: ninety-four refusals in
 * English, in seventeen route files — fifty-six per cent of the whole
 * product's English-message debt, sitting in the one group people work in
 * all day. The same situation was also worded differently in different
 * files, which is the second defect hiding inside the first:
 *
 *   «Order not found»
 *   «Order not found or not assigned to you»
 *   «This order was updated by another user. Please refresh before saving.»
 *   «This order is currently being edited by …»
 *   «Lock expired. Please re-acquire the lock.»
 *   «You do not hold the editing lock on this order.»
 *   «You do not hold the editing lock.»
 *
 * The last two are one sentence written twice. So this file is the
 * vocabulary, not a translation table: one situation, one sentence, and
 * every sentence says what to DO. A translated dead end is still a dead
 * end — `arabic-refusals.test.ts` already holds that standard for the two
 * routes it covers, and this extends it to the group.
 *
 * `error` stays in English wherever it already is: fifteen test files
 * assert on it and support reads the permission key out of it. The Arabic
 * travels beside it as `errorAr`, the channel ten components already
 * prefer and `apiJson` reads first.
 */

/** The order is absent, another store's, or somebody else's work. */
export const ORDER_NOT_FOUND = 'لا يوجد طلب بهذا المعرّف بين طلباتك. أعد تحميل القائمة.';

/** A write lost a race with another write. */
export const ORDER_STALE =
  'عدّل هذا الطلبَ شخصٌ آخر بعد أن فتحتَه. أعد تحميل الصفحة ثم احفظ.';

/** The caller did not send `expectedVersion`. A bug, but a person sees it. */
export const ORDER_VERSION_MISSING =
  'تعذّر الحفظ — أعد تحميل الصفحة ثم حاول مرّة أخرى.';

/** Somebody else holds the editing lock right now. */
export const orderLockedBy = (name?: string | null): string =>
  `الطلب مفتوحٌ للتعديل عند ${name || 'شخصٍ آخر'} الآن. انتظر حتّى يُغلقه، أو اطلب فكّ القفل من المشرف.`;

/** The caller is editing without holding the lock. */
export const ORDER_LOCK_NOT_HELD = 'قفل التعديل ليس بيدك. اطلب القفل أولاً ثم احفظ.';

/** The lock ran out while the form was open. */
export const ORDER_LOCK_EXPIRED = 'انتهت مهلة قفل التعديل. اطلب القفل من جديد ثم احفظ.';

/** Another employee pulled this order from the queue first. */
export const orderClaimedBy = (name?: string | null): string =>
  `سحب هذا الطلبَ ${name || 'موظّفٌ آخر'} قبلك. اختر طلباً آخر من الطابور.`;

/** A supervisor pulling an order back asked for it with nobody holding it. */
export const ORDER_ALREADY_IN_QUEUE = 'الطلب في الطابور أصلاً، ما في أحد يحمله.';

/** Giving an order back to the queue is a confirmation-desk move; later it would reopen a settled step. */
export const ORDER_PAST_CONFIRMATION =
  'الطلب تعدّى مرحلة التأكيد، فلا يرجع للطابور. عدّله مباشرة، أو استلمه بنفسك.';

/** Pulling another person's order back needs the reason in writing, like every hand-over. */
export const ORDER_TAKEBACK_REASON = 'اكتب سبب سحب الطلب منه — يُسجَّل في سجل الطلب.';

/** The caller does not hold the claim they are trying to act on. */
export const ORDER_CLAIM_NOT_HELD =
  'هذا الطلب ليس بين يديك. اسحبه أولاً، أو اطلبه من مَن يحمله.';
