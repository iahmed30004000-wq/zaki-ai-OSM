/**
 * WHY A TELEGRAM MESSAGE IS WAITING FOR A PERSON — IN ARABIC, ONCE (T10).
 *
 * The door writes a code into `TelegramMessage.reviewReason`; a person reads this. The map lived inside the screen and
 * had gone short: NO_STORE and CUSTOMER_BLOCKED had no entry, so the raw English code was printed on a row somebody was
 * supposed to act on. Every code the door can write is here — `review-reasons.test.ts` reads the door's source for them,
 * so a new code without a sentence fails the build instead of reaching a screen.
 *
 * `line` is the line of his seven-line format the reason is about. The screen marks that cell, and says «السطر N» when
 * the message is in that format. A message with labels has no line numbers, so it gets the sentence alone.
 *
 * `retry` says whether «إعادة المعالجة» can change the answer. The stored text never changes (an edited Telegram message
 * is not re-read), so a reason that lives in the text gets the same answer every time, and the screen says «صحّح الرسالة
 * وابعتها من جديد» instead. The catalogue, the store, the blacklist and the store's settings can change, so those may.
 *
 * Pure: the screen imports it, and so does the door's test.
 */

export interface ReviewReason {
  /** The sentence a person reads — short and plain. */
  text: string;
  /** The line of the seven-line format this reason is about. */
  line?: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  /** Whether running the same text again may give another answer. */
  retry: boolean;
}

export const REVIEW_REASONS = {
  LINE_COUNT: { text: 'المطلوب 7 أسطر: مرجع، تاريخ، عميل، هاتف، محافظة، منتج، عرض', retry: false },
  BAD_DATE: { line: 2, text: 'لازم يكون تاريخ مثل 2026-10-28 15:40:01', retry: false },
  SOURCE_TIME_OFF: { line: 2, text: 'التاريخ بعيد عن وقت وصول الرسالة', retry: false },
  MISSING_CUSTOMER_NAME: { line: 3, text: 'اسم العميل ناقص', retry: false },
  INVALID_PHONE: { line: 4, text: 'رقم الهاتف مش صالح', retry: false },
  CUSTOMER_BLOCKED: { line: 4, text: 'الرقم بقائمة الحظر', retry: true },
  COUNTRY_MISMATCH: { line: 5, text: 'البلد مش بلد المتجر', retry: false },
  MISSING_ADDRESS: { line: 5, text: 'المحافظة ناقصة', retry: false },
  MISSING_PRODUCT: { line: 6, text: 'المنتج ناقص', retry: false },
  PRODUCT_NOT_FOUND: { line: 6, text: 'المنتج مش موجود', retry: true },
  AMBIGUOUS_PRODUCT: { line: 6, text: 'الاسم بيطابق أكتر من منتج', retry: true },
  PRODUCT_GUESSED: { line: 6, text: 'المنتج تخمين — ما منعمل طلب على تخمين', retry: true },
  INVALID_QUANTITY: { line: 7, text: 'الكمية مش صالحة', retry: false },
  MISSING_PRICE: { line: 7, text: 'السعر ناقص أو مش صالح', retry: false },
  OFFER_UNREADABLE: { line: 7, text: 'العرض ما انقرأ — اكتب مثل: القطعتين ب 25 $ + توصيل مجاني', retry: false },
  DELIVERY_FEE_STATED: { line: 7, text: 'أجرة التوصيل من جدول المناطق مش من الرسالة', retry: false },
  CURRENCY_MISMATCH: { line: 7, text: 'العملة غير عملة المتجر — ما منحوّل', retry: true },
  GIFT_NEEDS_OFFER: { line: 7, text: 'الهدية بدها عرض مربوط بالمنتج — لسا ما منقرأها من الرسالة', retry: false },
  DUPLICATE_REF: { text: 'نفس المرجع ونفس الوقت صار طلب', retry: false },
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

/**
 * The sentence for a stored code. `lines` — the message is in the seven-line format, so the line is named; `lineCount`
 * — how many lines it had, for the one reason that is about all of them.
 */
export function reviewReasonText(
  code: string | null | undefined,
  context: { lines?: boolean; lineCount?: number } = {}
): string {
  const reason = reviewReason(code);
  if (!reason) return '';
  if (code === 'LINE_COUNT' && context.lineCount) {
    return `عدد أسطر الرسالة ${context.lineCount}، والمطلوب 7: مرجع، تاريخ، عميل، هاتف، محافظة، منتج، عرض`;
  }
  return context.lines && reason.line ? `السطر ${reason.line}: ${reason.text}` : reason.text;
}
