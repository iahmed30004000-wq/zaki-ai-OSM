import { rateOf } from './order-state';
import { trustOf, type Trust } from './cod-vitals';

/**
 * WHICH KIND OF SPENDING IS QUIETLY TAKING A BIGGER BITE.
 *
 * The expenses ledger lists rows: date, title, type, amount, notes. Nothing
 * anywhere adds them up PER TYPE, so the one question an owner actually has
 * about spending — «على أيّ بند يذهب مالي، وأيّ بند يكبر من تحتي» — had no
 * answer on any screen. The type was not even readable: the ledger printed
 * the raw enum, «MARKETING» in Latin capitals, in a right-to-left Arabic
 * table whose own form offers «تسويق وإعلانات».
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHAT THIS DELIBERATELY REFUSES TO BE, AND WHY
 * ─────────────────────────────────────────────────────────────────────
 *
 * It is NOT a «worth it» score, and it will not become one by weighting
 * things harder. «Worth it» is a ratio of what a kind of spending RETURNED
 * to what it cost, and this database holds no link from an expense to
 * anything it bought. `Expense.referenceId` is documented as «batchId or
 * orderId» and is the only candidate; there are no expense rows at all, so
 * it is set on none of them. Without that link the return of a marketing
 * dinar is unknowable, and a score built on an assumed return would be a
 * ranking of assumptions — the precise thing that killed this product's
 * intelligence layer, where every customer graded the same.
 *
 * It is also NOT a 0..100 score, for a plainer reason: a hundred-point
 * scale needs a ceiling, and there is no such thing as a perfect share of
 * revenue to spend on packaging. Inventing one bar per category would be
 * nine invented verdicts wearing arithmetic.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHAT IT IS INSTEAD: TWO NUMBERS AND A DIRECTION, ALL THREE DERIVED
 * ─────────────────────────────────────────────────────────────────────
 *
 *   SHARE OF SPEND — of everything the shop spent this window, how much of
 *   it went here. Needs no bar: it is a composition, and it sums to 100.
 *
 *   BURDEN — this type's spend as a share of DELIVERED revenue. Stated as a
 *   figure and given no verdict of its own, because nobody can say what
 *   percentage of revenue office costs ought to be. Revenue is the right
 *   denominator and the only sound one available: it is money that actually
 *   reached a door, and unlike this shop's profit margin it does not rest on
 *   a cost field that is 3% filled.
 *
 *   DIRECTION — the one thing that CAN be graded without inventing a
 *   constant, because the bar is the shop's own past: this type's burden
 *   this window against the SAME type's burden over the window before,
 *   equally long. «تغليف كان 4% من الإيراد وصار 9%» is a fact, fully
 *   explainable, and it is exactly what «يبلع من تحتي» means.
 *
 * Direction is graded and burden is not. That asymmetry is the honest part:
 * a comparison against yourself needs no threshold, and a comparison against
 * an ideal needs one nobody has.
 */

/**
 * THE TYPES, IN ONE PLACE AT LAST.
 *
 * The list existed three times and agreed nowhere: as a prose comment on the
 * Prisma column, as eight `<option>` elements hardcoded in the expense form,
 * and as whatever string a caller happened to post. The form offered eight
 * and the column's comment listed eight DIFFERENT ones — the comment has
 * `COMMISSION` and the form has it too, but the comment's order and the
 * form's disagree, and neither is reachable from code that has to render a
 * stored value. Which is why the ledger fell back to printing the enum.
 */
export const EXPENSE_CATEGORIES = [
  'MANUFACTURING', 'PACKAGING', 'SHIPPING', 'MARKETING',
  'COMMISSION', 'SALARIES', 'OFFICE', 'OTHER',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const EXPENSE_CATEGORY_AR: Record<string, string> = {
  MANUFACTURING: 'تصنيع',
  PACKAGING: 'تغليف',
  SHIPPING: 'شحن وتوصيل',
  MARKETING: 'تسويق وإعلانات',
  COMMISSION: 'عمولات',
  SALARIES: 'رواتب',
  OFFICE: 'مكتب وخدمات',
  OTHER: 'أخرى',
};

/**
 * In Arabic, falling back to the STORED VALUE rather than to a guess.
 *
 * A category this list has never heard of is printed as it was written. The
 * alternative — folding it into «أخرى» — would hide a typo'd or renamed type
 * inside a bucket that already means something, and then the composition
 * would add up while being wrong.
 */
export function categoryLabel(category: string): string {
  return EXPENSE_CATEGORY_AR[category] ?? category;
}

export function isKnownCategory(category: string): boolean {
  return (EXPENSE_CATEGORIES as readonly string[]).includes(category);
}

/**
 * THE ORDER THE FORM LISTS THEM IN, and what it calls the two that the profit ALSO counts somewhere else.
 *
 * `Expense` rows are subtracted from net profit, and so are two things a delivered order already carries:
 * `shippingCost` (the courier's fee, per delivered order) and `estimatedCostOfGoods` (the batch cost, per
 * delivered order). A «شحن» or «تصنيع» expense for the same parcel or the same batch is therefore counted twice.
 * Refusing the two types would also drop what only an expense can carry (a return fee, a failed delivery, a
 * product whose batch has no cost written), so they stay — named for what they are FOR, with the sentence that
 * says what NOT to put in them. Stored rows keep reading through `EXPENSE_CATEGORY_AR`, unchanged.
 */
export const EXPENSE_FORM_ORDER: readonly ExpenseCategory[] = [
  'MARKETING', 'PACKAGING', 'SHIPPING', 'COMMISSION', 'SALARIES', 'OFFICE', 'MANUFACTURING', 'OTHER',
];

/** What the form calls a type for NEW rows. */
export const EXPENSE_FORM_LABEL: Partial<Record<ExpenseCategory, string>> = {
  SHIPPING: 'شحن غير محسوب على طلب مسلَّم — إرجاع أو توصيل فاشل',
  MANUFACTURING: 'تصنيع — لمنتج بلا كلفة على تشغيلاته',
};

/** One sentence under the box when this type is chosen. */
export const EXPENSE_FORM_HINT: Partial<Record<ExpenseCategory, string>> = {
  SHIPPING:
    'أجرة توصيل كل طلب مسلَّم يطرحها الربح من الطلب نفسه — فاتورة شركة الشحن عن طرود مسلَّمة لا تُسجَّل هنا. سجّل هنا ما لا يحمله طلب مسلَّم: رسوم الإرجاع والتوصيل الفاشل.',
  MANUFACTURING:
    'إن كانت كلفة التشغيلة مكتوبة في «تشغيلات الإنتاج» فالربح يطرحها من كل طلب مسلَّم، وتسجيلها هنا يطرحها مرّتين. سجّل هنا فقط ما لم يُكتب على تشغيلة.',
};

/**
 * The type a door was handed, as the stored key — or null when it is not one of the eight.
 *
 * The door used to store WHATEVER string arrived: `'rent'`, `'Marketing'`, `''` after a trim, a number. A type
 * the ledger has never heard of is printed as written and grouped apart from the real ones, so the spend-by-type
 * card added up while being wrong. The Arabic label and any letter case are accepted and stored as the key.
 */
export function resolveExpenseCategory(category: unknown): ExpenseCategory | null {
  if (typeof category !== 'string') return null;
  const t = category.trim();
  if (!t) return null;
  const byLabel = Object.entries(EXPENSE_CATEGORY_AR).find(([, ar]) => ar === t)?.[0];
  const key = byLabel ?? t.toUpperCase();
  return isKnownCategory(key) ? (key as ExpenseCategory) : null;
}

export const SPEND_DIRECTIONS = ['GROWING', 'STEADY', 'SHRINKING', 'NEW', 'UNKNOWN'] as const;
export type SpendDirection = (typeof SPEND_DIRECTIONS)[number];

/**
 * How much a type's burden must move before it is called a move.
 *
 * A fifth, not a tenth and not a point. Spending is lumpy — one invoice
 * landing on the 29th instead of the 1st swings a month's packaging figure —
 * and a threshold tight enough to catch that would flag every type every
 * month, which is the same as flagging none.
 */
export const DIRECTION_TOLERANCE = 0.2;

/**
 * The floor under a direction.
 *
 * Two rows, in the window being judged. One invoice against one invoice is
 * not a trend, it is two invoices — and «تضاعف» said about a pair of numbers
 * is the kind of sentence that gets a supplier fired over a timing
 * difference.
 */
export const MIN_ROWS_FOR_DIRECTION = 2;

export interface ExpenseTypeInput {
  category: string;
  /** Rows of this type in the window — the sample under the direction. */
  rows: number;
  /** Total spent on this type, summed on the server. */
  amount: number;
  /** The same type over the window before, equally long. Null when none. */
  priorAmount?: number | null;
  priorRows?: number | null;
}

export interface ExpenseWindow {
  /** Everything spent this window, all types — the composition denominator. */
  totalSpend: number;
  /**
   * Delivered revenue for the same window, from the one profit engine.
   * Never recomputed here: this file does arithmetic on money it is handed
   * and owns no definition of it.
   */
  deliveredRevenue: number;
  priorTotalSpend?: number | null;
  priorDeliveredRevenue?: number | null;
}

export interface ExpenseTypeGrade {
  category: string;
  label: string;
  known: boolean;
  rows: number;
  amount: number;
  /** Whole-number percentage of everything spent. Null with nothing spent. */
  shareOfSpend: number | null;
  /** Whole-number percentage of delivered revenue. Null with no revenue. */
  burden: number | null;
  /** The same burden over the previous window, for the reader to check. */
  priorBurden: number | null;
  direction: SpendDirection;
  /** One sentence naming every figure the direction was read from. */
  why: string;
}

const num = (n: number | null | undefined): number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;

/**
 * ONE TYPE, READ AGAINST ITS OWN PAST.
 *
 * The direction compares BURDENS, not amounts, and that is the whole design.
 * Spending twice as much in a month the shop also sold twice as much is not
 * a leak — it is a bigger shop. Comparing raw amounts would call it one, and
 * would flag every single type in any growing month.
 */
export function gradeExpenseType(input: ExpenseTypeInput, window: ExpenseWindow): ExpenseTypeGrade {
  const rows = Math.max(0, Math.floor(num(input.rows)));
  const amount = num(input.amount);
  const revenue = num(window.deliveredRevenue);
  const totalSpend = num(window.totalSpend);
  const label = categoryLabel(input.category);

  const shareOfSpend = totalSpend > 0 ? rateOf(amount, totalSpend) : null;
  const burden = revenue > 0 ? rateOf(amount, revenue) : null;

  const priorAmount = input.priorAmount === null || input.priorAmount === undefined ? null : num(input.priorAmount);
  const priorRevenue =
    window.priorDeliveredRevenue === null || window.priorDeliveredRevenue === undefined
      ? null
      : num(window.priorDeliveredRevenue);
  const priorBurden =
    priorAmount !== null && priorRevenue !== null && priorRevenue > 0 ? rateOf(priorAmount, priorRevenue) : null;

  const grade = { category: input.category, label, known: isKnownCategory(input.category), rows, amount, shareOfSpend, burden, priorBurden };

  if (rows < MIN_ROWS_FOR_DIRECTION) {
    return {
      ...grade,
      direction: 'UNKNOWN',
      why: `${rows} مصروف فقط على هذا البند — تحت ${MIN_ROWS_FOR_DIRECTION}، ولا اتجاه يُقرأ من رقمٍ واحد.`,
    };
  }
  if (burden === null) {
    return {
      ...grade,
      direction: 'UNKNOWN',
      // No revenue means no denominator at all. Saying «100% of revenue»
      // about a shop that delivered nothing would be a division by zero
      // wearing a percent sign.
      why: 'لا إيراد مسلَّم في هذه المدة — لا نسبة تُقاس عليها.',
    };
  }
  if (priorAmount === null || priorRevenue === null) {
    return {
      ...grade,
      direction: 'UNKNOWN',
      why: `${burden}% من الإيراد المسلَّم — ولا مدة سابقة تُقارن بها.`,
    };
  }
  /**
   * NEW MEANS «NOTHING WAS SPENT ON THIS BEFORE» — and it is decided on the
   * prior AMOUNT, never on the prior burden.
   *
   * Deciding it on the burden is a bug this had, and the dry run against the
   * real database caught it: last month's delivered revenue is zero, so every
   * prior burden came back null, so «رواتب 600 ثم 600» was labelled «بند
   * جديد». A type somebody has been paying for months is not new because the
   * shop happened to deliver nothing in the window before.
   */
  if (priorAmount === 0) {
    return {
      ...grade,
      direction: 'NEW',
      why: `${burden}% من الإيراد المسلَّم — ولم يُصرف على هذا البند شيء في المدة السابقة.`,
    };
  }
  if (priorBurden === null || priorBurden === 0) {
    // Spent on before, but there is no prior revenue to take a share of. The
    // amounts could be compared instead — and that is exactly the comparison
    // this file refuses, because it calls a bigger shop a leak.
    return {
      ...grade,
      direction: 'UNKNOWN',
      why: `${burden}% من الإيراد المسلَّم — وصُرف على هذا البند في المدة السابقة بلا إيراد مسلَّم فيها، فلا نسبة تُقارن.`,
    };
  }

  const move = (burden - priorBurden) / priorBurden;
  if (move > DIRECTION_TOLERANCE) {
    return {
      ...grade,
      direction: 'GROWING',
      why: `${priorBurden}% من الإيراد ثم ${burden}% — نصيبه يكبر.`,
    };
  }
  if (move < -DIRECTION_TOLERANCE) {
    return {
      ...grade,
      direction: 'SHRINKING',
      why: `${priorBurden}% من الإيراد ثم ${burden}% — نصيبه يصغر.`,
    };
  }
  return {
    ...grade,
    direction: 'STEADY',
    why: `${priorBurden}% من الإيراد ثم ${burden}% — نصيبه ثابت.`,
  };
}

/**
 * EVERY TYPE, HEAVIEST FIRST.
 *
 * By AMOUNT and not by burden or by direction. The first question is «where
 * does my money go», and a type that doubled its share of a trivial total is
 * not the top line of that answer — it is the interesting second line, and
 * the direction beside each row is what surfaces it.
 */
export function gradeExpenseTypes(
  inputs: readonly ExpenseTypeInput[],
  window: ExpenseWindow
): ExpenseTypeGrade[] {
  return inputs
    .map((i) => gradeExpenseType(i, window))
    .sort((a, b) => b.amount - a.amount || b.rows - a.rows);
}

/**
 * IS THE LEDGER ITSELF WORTH READING?
 *
 * Every figure above rests on the expense rows being a complete record of
 * what left the shop. `Expense.walletId` is what ties a recorded expense to
 * money actually leaving a wallet, and the schema says why it matters: an
 * expense with no wallet makes the daily closing show a shortfall nobody can
 * explain, and somebody then writes a second expense to explain it.
 *
 * So the coverage of that one field is the coverage of the whole reading,
 * and it is asked with `trustOf` — the same gate that refuses the profit
 * margin when the cost field is empty. A ledger whose expenses mostly have
 * no wallet is not a ledger; it is a list.
 */
export function ledgerTrust(withWallet: number, rows: number): Trust {
  const trust = trustOf({ present: withWallet, population: rows, subject: 'المحفظة على المصروف' });
  /**
   * `trustOf` says «لا طلبات في هذه المدة» when it has nothing to measure,
   * because every caller it was built for counts orders. An empty EXPENSE
   * ledger is not an absence of orders, and printing that sentence on the
   * finance screen would answer a question nobody asked. The gate's
   * arithmetic is reused; only the noun is the caller's to own.
   */
  if (trust.population === 0) return { ...trust, ar: 'لا مصروف مسجَّل بعد — لا شيء يُحكم على دفتره.' };
  return trust;
}
