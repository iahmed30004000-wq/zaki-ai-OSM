import type { ZodError } from 'zod';

/**
 * A VALIDATION FAILURE, IN A SENTENCE SOMEBODY CAN ACT ON.
 *
 * Forty-eight routes returned `error.issues[0].message` straight to the
 * screen, so an Arabic user pressing a button got:
 *
 *   "Too small: expected string to have >=10 characters"
 *
 * Which field? Too small compared to what? What should they type? The
 * message names none of it, and it is in the wrong language. The person
 * concludes the screen is broken — and often they are half right, because
 * the usual cause is a dropdown that was never chosen and sent an empty
 * value that no rule was ever going to accept.
 *
 * So: name the field in Arabic, say what is wrong with it, and for the
 * empty-id case say the thing that actually helps — choose one.
 */

/** Field names as the person sees them on screen. */
const FIELDS: Record<string, string> = {
  productId: 'المنتج',
  offerId: 'العرض',
  orderId: 'الطلب',
  orderIds: 'الطلبات',
  customerId: 'العميل',
  moderatorId: 'المودريتر',
  channelId: 'جهة الطلب',
  regionId: 'المحافظة',
  storeId: 'المتجر',
  countryId: 'البلد',
  roleId: 'الدور',
  batchId: 'الدفعة',
  shippingBatchId: 'دفعة الشحن',
  deliveryProviderId: 'شركة الشحن',
  name: 'الاسم',
  slug: 'الرابط المختصر',
  email: 'البريد الإلكتروني',
  password: 'كلمة المرور',
  phone: 'رقم الهاتف',
  customerName: 'اسم العميل',
  customerPhone: 'هاتف العميل',
  customerAddress: 'العنوان',
  quantity: 'الكمية',
  unitPrice: 'سعر الوحدة',
  sellingPrice: 'سعر البيع',
  // The AI intake's own name for the price the reviewer confirms. Without it
  // an empty price box on that modal came back «حقل مطلوب ناقص» — a missing
  // field, unnamed, on a form with eight boxes.
  finalPrice: 'السعر',
  typedPrice: 'سعر الزبون',
  amount: 'المبلغ',
  // The production-run door. Without these the reader got «حقل مطلوب
  // ناقص» for a missing quantity and the raw English «Too small: …» for a
  // negative cost — which is the half of a refusal that nobody can act on.
  quantityProduced: 'الكمية المنتجة',
  manufacturingCost: 'كلفة التصنيع',
  packagingCost: 'كلفة التغليف',
  rawMaterialCost: 'كلفة المواد الخام',
  otherCosts: 'كلف أخرى',
  deliveryFee: 'رسوم التوصيل',
  reason: 'السبب',
  note: 'الملاحظة',
  notes: 'الملاحظات',
  title: 'العنوان',
  label: 'اسم البند',
  model: 'اسم النموذج',
  apiKey: 'المفتاح',
  question: 'السؤال',
  prompt: 'البرومبت',
  countedQuantity: 'الكمية المعدودة',
  width: 'العرض',
  height: 'الارتفاع',
  body: 'نص الرسالة',
  templates: 'الرسائل',
  changes: 'التعديلات',
  decision: 'القرار',
  kind: 'النوع',
  until: 'التاريخ',
  provider: 'المزوّد',
  costLines: 'بنود الكلفة',
  rejectionReason: 'سبب الإلغاء',
  followUpReason: 'سبب المتابعة',
  trackingNumber: 'رقم التتبع',
  batchNumber: 'رقم الدفعة',
  sku: 'رمز المنتج',
  category: 'النوع',
  role: 'الدور',
  // The partners' doors (13/11): the profit shares and the draws.
  walletId: 'المحفظة',
  partnerId: 'الشريك',
  partners: 'الشركاء',
  sharePercent: 'النسبة',
  valueInStoreCurrency: 'ما يعادله بعملة المتجر',
};

/**
 * Is this issue about a string's length, or a number's value?
 *
 * The property moved between Zod majors — `type` then `origin` — so both
 * are read. Getting it wrong prints "الاسم: 3 على الأقل" for a name, which
 * reads as a quantity rather than a length.
 */
function isAboutText(issue: { type?: string; origin?: string }): boolean {
  return issue.type === 'string' || issue.origin === 'string';
}

/** The deepest named key in the path — `items.0.productId` → `productId`. */
function fieldOf(path: PropertyKey[]): string | null {
  for (let i = path.length - 1; i >= 0; i--) {
    if (typeof path[i] === 'string') return path[i] as string;
  }
  return null;
}

function label(path: PropertyKey[]): string | null {
  const key = fieldOf(path);
  if (!key) return null;
  return FIELDS[key] ?? null;
}

const ARABIC = /[\u0600-\u06FF]/;

/** "الحقل: الرسالة" — unless the message already names the field. */
function withField(named: string | null, message: string): string {
  if (!named || message.includes(named)) return message;
  return `${named}: ${message}`;
}

/**
 * One readable Arabic sentence for the first thing that is wrong.
 *
 * Falls back to the raw message rather than inventing one: a message we do
 * not recognise is still better than a generic "بيانات غير صالحة" that
 * hides which of eleven fields is the problem.
 */
export function zodMessage(error: ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'بيانات غير صالحة';

  const named = label(issue.path);
  const key = fieldOf(issue.path);
  const isId = !!key && /Id$/.test(key);

  switch (issue.code) {
    case 'invalid_type': {
      /*
       * «NOT FILLED IN» AND «FILLED IN WRONG» ARE DIFFERENT SENTENCES.
       *
       * An unchosen dropdown arrives as undefined or null, and "expected
       * string, received undefined" is not something anyone can act on —
       * `مطلوب` is. But a value that ARRIVED and is merely of the wrong
       * kind got the same `مطلوب`, which sends the reader looking for an
       * empty box they already filled. Measured on the production door,
       * where `quantityProduced: '3,5'` from an Arabic keyboard is the
       * commonest case: «الكمية المنتجة مطلوب» named the right field and
       * then told the operator the opposite of what was wrong.
       *
       * Zod's own message carries the distinction — `received undefined`
       * against `received string` — so nothing has to be guessed.
       */
      const absent = /received (?:undefined|null|nan)\b/i.test(issue.message);
      if (absent) return named ? `${named} مطلوب` : 'حقل مطلوب ناقص';
      const expected = (issue as { expected?: string }).expected;
      if (expected === 'number' || expected === 'int') {
        const whole = expected === 'int' ? ' صحيحاً' : '';
        return named ? `${named}: اكتبه رقماً${whole} بالأرقام` : `اكتب رقماً${whole} بالأرقام`;
      }
      return named ? `${named} غير صالح` : 'قيمة غير صالحة';
    }

    case 'too_small': {
      if (isId) return named ? `اختر ${named} أولاً` : 'اختر القيمة المطلوبة أولاً';
      const min = (issue as { minimum?: number | bigint }).minimum;
      if (named && typeof min !== 'undefined') {
        return isAboutText(issue as { type?: string; origin?: string })
          ? `${named}: ${min} أحرف على الأقل`
          : `${named}: ${min} على الأقل`;
      }
      return named ? `${named} قصير جداً` : issue.message;
    }

    case 'too_big': {
      const max = (issue as { maximum?: number | bigint }).maximum;
      if (named && typeof max !== 'undefined') {
        return isAboutText(issue as { type?: string; origin?: string })
          ? `${named}: ${max} حرفاً على الأكثر`
          : `${named}: ${max} على الأكثر`;
      }
      return named ? `${named} أكبر من المسموح` : issue.message;
    }

    case 'invalid_format':
    case 'invalid_value':
      // A regex that fails with the author's own Arabic sentence — «رمز
      // العملة ثلاثة أحرف (ISO)», «يجب أن تحتوي على رقم» — already says what
      // to do. Replacing it with «غير صالح» threw away the only helpful part.
      if (ARABIC.test(issue.message)) return withField(named, issue.message);
      return named ? `${named} غير صالح` : issue.message;

    default:
      return withField(named, issue.message);
  }
}
