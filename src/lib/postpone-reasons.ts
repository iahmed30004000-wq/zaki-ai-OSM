/**
 * WHY AN ORDER WAS PUT OFF — the codes `followUpReason` holds, and the words for them.
 *
 * Lived inside the confirmation dialogs, so the postponed list could only read the words by importing the whole dialog
 * file (the product picker, the regions hook). It is a list, not a screen, so it sits here; the dialogs import it from here.
 */
export const POSTPONE_REASONS = [
  { value: 'CUSTOMER_REQUESTED_CALLBACK', label: 'العميل طلب معاودة الاتصال' },
  { value: 'POSTPONED', label: 'العميل طلب التأجيل' },
  { value: 'NO_ANSWER', label: 'لا يرد — إعادة المحاولة لاحقاً' },
  { value: 'FAILED_CONFIRMATION', label: 'تعذر التأكيد' },
  { value: 'OTHER', label: 'سبب آخر' },
] as const;
