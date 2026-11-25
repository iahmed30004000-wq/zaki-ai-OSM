/**
 * «تراجع عن المرتجع» — THE WORDS AND THE SHAPES, safe for a screen to import (25/11).
 *
 * The mirror of «تراجع عن التسليم» (`delivery-undo-words.ts`): a RETURN recorded at the door by mistake («رجعت» — nothing taken) is taken
 * back, so the company's own word («تم توصيلها» on its statement) and the ordinary roads (the statement's close, or «استلم») can take over.
 *
 * Nothing here touches the database or a Node module: the dialog draws what the door answers (`ReturnUndoMeasure`), the door reads the same
 * constants, and the tests read the sentences from here — one spelling of each, in one place.
 *
 * It is the OWNER's, through the same key as «تراجع عن التسليم» (`ops.undo_delivery`): one box on the roles screen for both mistakes.
 */

export { UNDO_REASON_MAX, UNDO_REASON_MIN } from './delivery-undo-words';

/** The activity row every undone return carries — and the audit line's action. One spelling, read by the timeline and the audit view. */
export const RETURN_UNDO_ACTION = 'RETURN_UNDONE';

/** What the order's timeline line and its internal note start with; the reason follows. */
export const RETURN_UNDO_NOTE_PREFIX = 'تراجع عن تسجيل المرتجع';

/** Why an order is left alone, as a code the screen and the tests can read. */
export type ReturnUndoWhy =
  | 'NOT_FOUND'
  | 'NOT_RETURNED'
  | 'ALREADY_UNDONE'
  | 'NOT_BY_THE_DOOR'
  | 'CHANGED_AFTER'
  | 'RETURN_COUNTED'
  | 'MONEY_RECORDED'
  | 'OPEN_REQUEST';

export type ReturnUndoLineKey = 'STATUS' | 'ITEMS' | 'CUSTOMER' | 'STOCK' | 'MONEY' | 'HISTORY' | 'STATEMENT';

/** One sentence of what the press would do (or would leave). */
export interface ReturnUndoLine {
  key: ReturnUndoLineKey;
  text: string;
}

/** What the press would do to ONE order — and what it would leave, and why it refuses. The screen only draws it. */
export interface ReturnUndoMeasure {
  orderNumber: string;
  /** The company's name as the row shows it. */
  courier: string;
  allowed: boolean;
  /** Set exactly when `allowed` is false: the first refusal that applies, in words. */
  refusal: { code: ReturnUndoWhy; text: string } | null;
  /** What the dialog saw. The press sends it back, and the door refuses if the order is no longer this. Null when nothing can be undone. */
  fingerprint: string | null;
  /** The shipping states, as codes: `from` is today's, `to` is where the order goes back to. */
  from: string;
  to: string | null;
  /** EVERYTHING the press would put back — nothing else is written. */
  lines: ReturnUndoLine[];
  /** What it leaves exactly as it is, and says so. */
  stays: ReturnUndoLine[];
}

/* ───────────────────────── the sentences ───────────────────────── */

export const RETURN_UNDO_FORBIDDEN_AR = 'التراجع عن تسجيل المرتجع مش من صلاحياتك — اطلبو من المالك.';
export const RETURN_UNDO_ACK_AR = 'لازم تقرّ إنو التراجع بيغيّر حالة الطلب وسجل الزبون، وإنو بيتسجّل باسمك.';
export const RETURN_UNDO_NOT_FOUND_AR = 'الطلب ما انلقى بهالمتجر.';
export const RETURN_UNDO_CHANGED_AR = 'تغيّرت الأرقام من لما فتحت النافذة — افتحها من جديد وراجعها قبل ما تتراجع.';
export const RETURN_UNDO_ORDERS_CHANGED_AR =
  'تغيّر وضع الطلب وقت التراجع (انعدّ مرتجعو أو انعدّل أو انطلب إلغاؤو أو تأجيلو أو تراجع عنو حدا). ما انتراجع عن شي — افتح النافذة من جديد.';

/** The settlement states in words, for the refusal that names one. */
const SETTLEMENT_AR: Record<string, string> = {
  NOT_APPLICABLE: 'لا ينطبق',
  PENDING: 'معلّق',
  PENDING_COLLECTION: 'لم يُحصَّل',
  COLLECTED: 'محصَّل',
  PARTIALLY_SETTLED: 'مسوّى جزئياً',
  SETTLED: 'مسوّى',
  UNSETTLED: 'غير مسوّى',
  REFUNDED: 'مُسترد',
  PARTIALLY_REFUNDED: 'مُسترد جزئياً',
  CANCELLED: 'ملغى',
};
const settlementWord = (s: string): string => SETTLEMENT_AR[s] ?? 'غير معروفة';

export const RETURN_UNDO_WHY_AR = {
  notReturned: (shipping: string) => `الطلب مش مسجَّل مرتجع (حالتو «${shipping}») — ما في مرتجع نتراجع عنو.`,
  alreadyUndone: (shipping: string) => `انتراجع عن مرتجع هالطلب من قبل — حالتو هلّق «${shipping}».`,
  notByTheDoor: 'المرتجع ما انسجّل من زر «رجعت» على باب الزبون — ما بنقدر نثبت شو انكتب وقتها، فما بيتراجع عنو من هون.',
  changedAfter: 'حالة الطلب تغيّرت بعد ما انسجّل المرتجع — ما بنقدر نثبت شو لازم يرجع، فما بيتراجع عنو من هون.',
  returnCounted: 'انعدّ مرتجع هالطلب بقسم المرتجعات — البضاعة رجعت عالرف، فما بيتراجع عنو من هون.',
  moneyState: (state: string) => `تسوية الطلب بحالة «${settlementWord(state)}» — فيها مصاري أو مسكّرة، وما بيتراجع عن مرتجعو من هون.`,
  moneyAmount: 'عالطلب مبلغ محصَّل مكتوب — المصاري تسجّلت، وما بيتراجع عن مرتجعو من هون.',
  openRequest: 'عالطلب طلب إلغاء أو تأجيل لسا مفتوح — خلّصو أول، وبعدين تراجع عن المرتجع.',
} as const;

/** The words of one line of the measure, built from the facts — kept here so the dialog and the tests read the same sentences. */
export const RETURN_UNDO_LINE_AR = {
  status: (from: string, to: string, defaulted: boolean) =>
    defaulted
      ? `حالة الشحن بترجع من «${from}» لـ«${to}» (الحالة اللي قبل المرتجع مش محفوظة بالسجل)، وتاريخ الإرجاع وسببو بينمسحوا.`
      : `حالة الشحن بترجع من «${from}» لـ«${to}»، وتاريخ الإرجاع وسببو بينمسحوا.`,
  items: (n: number) => `${n} بند بيرجعوا لـ«الباب لسا ما حكى» — بتنمسح الكميات اللي انكتبت عليهم وقت «رجعت».`,
  customer: (afterRefused: number, beforeRefused: number) =>
    beforeRefused > 0
      ? `سجل الزبون: «الطلبات المرفوضة» بتنقص واحد (من ${beforeRefused} لـ${afterRefused}) — هي اللي زادها «رجعت».`
      : 'سجل الزبون: «الطلبات المرفوضة» أصلاً صفر فبتضل صفر.',
} as const;

export const RETURN_UNDO_STAYS_AR = {
  stock:
    'المخزون ما بيتغيّر: «رجعت» ما طلّع ولا قطعة من الرف، والتراجع ما بيطلّع ولا بيرجّع. لما يثبت التسليم (الكشف أو «استلم») بتطلع البضاعة من الرف مرة وحدة.',
  money: 'ما بينكتب ولا قرش: لا حركة محفظة ولا مبلغ محصَّل ولا عمولة.',
  history: 'السجل ما بيتمسح منو شي: بيضيف سطر على خط الطلب وملاحظة داخلية فيها السبب، ومحاولة التوصيل اللي انسجّلت بتضل.',
  statement: 'في كشف بيذكر الطلب — هاد مش مانع، هو سبب التراجع. بعد التراجع شغّل المطابقة من جديد ليقرأ الكشف الطلب.',
} as const;

export const RETURN_UNDO_SUCCESS_AR = (orderNumber: string, to: string) => `اتراجع عن مرتجع الطلب ${orderNumber} — رجع «${to}»`;
