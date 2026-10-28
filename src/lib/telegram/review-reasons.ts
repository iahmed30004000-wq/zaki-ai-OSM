/**
 * WHY A TELEGRAM MESSAGE IS WAITING FOR A PERSON (OR WAS SET ASIDE) — IN ARABIC, ONCE.
 *
 * The door writes a code into `TelegramMessage.reviewReason`; a person reads this. Every code the door can write is
 * here — `review-reasons.test.ts` reads the door's source for them, so a new code without a sentence fails the build
 * instead of reaching a screen with raw English on it.
 *
 * The message is in the owner's labeled format (nine labels, `labeled-order.ts`), so a reason names the FIELD it is
 * about («ناقص: رقم الهاتف»), and `field` is the column the screen marks.
 *
 * `retry` says whether «إعادة المعالجة» can change the answer. The stored text never changes (an edited Telegram message
 * is not re-read), so a reason that lives in the text gets the same answer every time, and the screen says «صحّح الرسالة
 * وابعتها من جديد» instead. The catalogue, the store, the blacklist and the store's settings can change, so those may.
 *
 * Pure: the screen imports it, and so does the door's test.
 */

/** The column of the screen a reason is about («السعر» and «الكمية» share one column). */
export type ReasonField = 'orderedAt' | 'customer' | 'phone' | 'address' | 'product' | 'offer' | 'priceQuantity';

export interface ReviewReason {
  /** The sentence a person reads — short and plain. */
  text: string;
  /** The column this reason is about. */
  field?: ReasonField;
  /** Whether running the same text again may give another answer. */
  retry: boolean;
}

export const REVIEW_REASONS = {
  NOT_IN_FORMAT: { text: 'الرسالة مش بصيغة الطلب', retry: false },
  STRAY_LINE: { text: 'في سطر زيادة مش تابع لأي عنوان — كل معلومة بسطر وبعنوانها', retry: false },
  REPEATED_ORDER_NUMBER: { text: 'مكرر: رقم الطلب', retry: false },
  REPEATED_ORDERED_AT: { field: 'orderedAt', text: 'مكرر: تاريخ الطلب', retry: false },
  REPEATED_CUSTOMER_NAME: { field: 'customer', text: 'مكرر: إسم العميل', retry: false },
  REPEATED_PHONE: { field: 'phone', text: 'مكرر: رقم الهاتف', retry: false },
  REPEATED_ADDRESS: { field: 'address', text: 'مكرر: عنوان العميل', retry: false },
  REPEATED_PRODUCT: { field: 'product', text: 'مكرر: إسم المنتج', retry: false },
  REPEATED_OFFER_NAME: { field: 'offer', text: 'مكرر: إسم العرض', retry: false },
  REPEATED_PRICE: { field: 'priceQuantity', text: 'مكرر: السعر', retry: false },
  REPEATED_QUANTITY: { field: 'priceQuantity', text: 'مكرر: الكمية', retry: false },
  MISSING_ORDERED_AT: { field: 'orderedAt', text: 'ناقص: تاريخ الطلب', retry: false },
  MISSING_CUSTOMER_NAME: { field: 'customer', text: 'ناقص: إسم العميل', retry: false },
  MISSING_PHONE: { field: 'phone', text: 'ناقص: رقم الهاتف', retry: false },
  MISSING_ADDRESS: { field: 'address', text: 'ناقص: عنوان العميل', retry: false },
  MISSING_PRODUCT: { field: 'product', text: 'ناقص: إسم المنتج', retry: false },
  MISSING_OFFER_NAME: { field: 'offer', text: 'ناقص: إسم العرض', retry: false },
  MISSING_PRICE: { field: 'priceQuantity', text: 'ناقص: السعر — أو مش رقم صالح', retry: false },
  MISSING_QUANTITY: { field: 'priceQuantity', text: 'ناقص: الكمية', retry: false },
  BAD_DATE: { field: 'orderedAt', text: 'تاريخ الطلب لازم يكون مثل 2026-10-28 15:40:01', retry: false },
  SOURCE_TIME_OFF: { field: 'orderedAt', text: 'تاريخ الطلب بعيد عن وقت وصول الرسالة', retry: false },
  INVALID_CUSTOMER_NAME: { field: 'customer', text: 'إسم العميل مش صالح — حرفين عالأقل وبلا أرقام', retry: false },
  INVALID_PHONE: { field: 'phone', text: 'رقم الهاتف مش صالح', retry: false },
  CUSTOMER_BLOCKED: { field: 'phone', text: 'الرقم بقائمة الحظر', retry: true },
  COUNTRY_MISMATCH: { field: 'address', text: 'البلد بالعنوان مش بلد المتجر', retry: false },
  PRODUCT_NOT_FOUND: { field: 'product', text: 'المنتج مش موجود', retry: true },
  AMBIGUOUS_PRODUCT: { field: 'product', text: 'الاسم بيطابق أكتر من منتج', retry: true },
  PRODUCT_GUESSED: { field: 'product', text: 'المنتج تخمين — ما منعمل طلب على تخمين', retry: true },
  INVALID_QUANTITY: { field: 'priceQuantity', text: 'الكمية لازم تكون رقم صحيح من 1 لـ1000', retry: false },
  CURRENCY_MISMATCH: { field: 'priceQuantity', text: 'عملة السعر غير عملة المتجر — ما منحوّل', retry: true },
  DUPLICATE_ORDER: { text: 'نفس الزبون والمنتج والوقت صار طلب', retry: false },
  NO_STORE: { text: 'المجموعة مش مربوطة بمتجر', retry: true },
  NO_SYSTEM_ACTOR: { text: 'ما في مدير شركة فعّال ينسجّل الطلب باسمه', retry: true },
  CREATION_FAILED: { text: 'ما زبط إنشاء الطلب — جرّب كمان مرة', retry: true },
  PROCESSING_ERROR: { text: 'ما زبطت المعالجة — جرّب كمان مرة', retry: true },
  NOT_FOUND: { text: 'الرسالة مش موجودة', retry: false },
} satisfies Record<string, ReviewReason>;

export type ReviewReasonCode = keyof typeof REVIEW_REASONS;

/** A code no version of the door wrote — still said in Arabic, and a press is allowed: it costs nothing to ask again. */
const UNKNOWN: ReviewReason = { text: 'سبب ما منعرفه', retry: true };

export function reviewReason(code: string | null | undefined): ReviewReason | null {
  if (!code) return null;
  return (REVIEW_REASONS as Record<string, ReviewReason>)[code] ?? UNKNOWN;
}

/** The sentence for a stored code, or '' when there is none. */
export function reviewReasonText(code: string | null | undefined): string {
  return reviewReason(code)?.text ?? '';
}
