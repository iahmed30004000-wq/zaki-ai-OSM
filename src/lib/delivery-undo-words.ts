/**
 * «تراجع عن التسليم» — THE WORDS AND THE SHAPES, safe for a screen to import (13/11).
 *
 *   «هاد الطلب بالغلط حطيتو تم والشركة بتقول تم ارجاعها لازم يكون في زر تراجع مش محدود بمدة زمنية ويكون عليه صلاحية للمالك متاح» (the owner)
 *
 * Nothing here touches the database or a Node module: the dialog draws what the door answers (`UndoMeasure`), the door reads the same
 * constants, and the tests read the sentences from here — one spelling of each, in one place.
 *
 * ── WHAT THE BUTTON IS, IN ONE PARAGRAPH ──
 *
 * A delivery that was recorded by mistake is taken back: the order returns to the state it had BEFORE the recording, so the company's
 * word «تم إرجاعها» and the ordinary return flow (the returns desk counts the goods back in) can take over. There is NO time window —
 * not a quarter of an hour, not «same day»: the rules below refuse on facts (money recorded, a statement, a counted return, a payable
 * commission), never on the clock. It is the OWNER's: `ops.undo_delivery`, granted to nobody by any migration, seed or fallback.
 */

/** The activity row every undone delivery carries — and the audit line's action. One spelling, read by the timeline and the audit view. */
export const DELIVERY_UNDO_ACTION = 'DELIVERY_UNDONE';

/**
 * WHAT THE ORDER'S OWN HISTORY CALLS THE WAYS A DELIVERY GETS RECORDED — the evidence the undo reads to know what the recording wrote.
 *
 * It does not guess the path from the order's columns: each recorder leaves its own activity row in the same transaction as its writes
 * (`recordPartialDelivery` · `recordShippingMove` · the combined-status PATCH), and `delivery-undo.test.ts` («what each recorder writes»)
 * holds these three spellings to the real code, so a renamed action cannot silently blind the undo.
 */
export const DOOR_MARK = 'PARTIAL_DELIVERY_RECORDED';
export const SHIPPING_MARK = 'SHIPPING_STATUS_CHANGED';
export const OVERRIDE_MARK = 'STATUS_CHANGED';

/** The reason is required (a mistake that cannot be explained later is a mistake somebody has to explain later) and bounded. */
export const UNDO_REASON_MIN = 5;
export const UNDO_REASON_MAX = 300;

/** What the order's timeline line and its internal note start with; the reason follows. */
export const UNDO_NOTE_PREFIX = 'تراجع عن تسجيل التسليم';

/** Why an order is left alone, as a code the screen and the tests can read. */
export type UndoWhy =
  | 'NOT_FOUND'
  | 'NOT_DELIVERED'
  | 'ALREADY_UNDONE'
  | 'MONEY_RECORDED'
  | 'ON_A_STATEMENT'
  | 'RETURN_COUNTED'
  | 'COMMISSION_MOVED'
  | 'PATH_UNKNOWN';

export type UndoLineKey = 'STATUS' | 'ITEMS' | 'SETTLEMENT' | 'CUSTOMER' | 'COMMISSION' | 'STOCK' | 'MONEY' | 'HISTORY' | 'EVENTS';

/** One sentence of what the press would do (or would leave). `amount`, when there is one, is drawn by the screen as money. */
export interface UndoLine {
  key: UndoLineKey;
  text: string;
  amount?: { value: number; currency: string };
}

/** What the press would do to ONE order — and what it would leave, and why it refuses. The screen only draws it. */
export interface UndoMeasure {
  orderNumber: string;
  /** The company's name as the row shows it. */
  courier: string;
  allowed: boolean;
  /** Set exactly when `allowed` is false: the first refusal that applies, in words. */
  refusal: { code: UndoWhy; text: string } | null;
  /** What the dialog saw. The press sends it back, and the door refuses if the order is no longer this. Null when nothing can be undone. */
  fingerprint: string | null;
  /** The shipping states, as codes: `from` is today's, `to` is where the order goes back to. */
  from: string;
  to: string | null;
  /** EVERYTHING the press would reverse — nothing else is written. */
  lines: UndoLine[];
  /** What it leaves exactly as it is, and says so. */
  stays: UndoLine[];
}

/* ───────────────────────── the sentences ───────────────────────── */

export const UNDO_FORBIDDEN_AR = 'التراجع عن تسجيل التسليم مش من صلاحياتك — اطلبو من المالك.';
export const UNDO_ACK_AR = 'لازم تقرّ إنو التراجع بيغيّر حالة الطلب وسجل الزبون وعمولتو، وإنو بيتسجّل باسمك.';
export const UNDO_NOT_FOUND_AR = 'الطلب ما انلقى بهالمتجر.';
export const UNDO_CHANGED_AR = 'تغيّرت الأرقام من لما فتحت النافذة — افتحها من جديد وراجعها قبل ما تتراجع.';
export const UNDO_ORDERS_CHANGED_AR =
  'تغيّر وضع الطلب وقت التراجع (انحصّل أو انربط بكشف أو انعدّل أو تراجع عنو حدا). ما انتراجع عن شي — افتح النافذة من جديد.';
export const UNDO_LATE_STATEMENT_AR = 'كشف ذكر الطلب وقت التراجع — الكشف هو اللي بيحكي بحالو. ما انتراجع عن شي.';
export const UNDO_LATE_COMMISSION_AR = 'عمولة الطلب صارت قابلة للدفع وقت التراجع. ما انتراجع عن شي — افتح النافذة من جديد.';

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
export const settlementWord = (s: string): string => SETTLEMENT_AR[s] ?? s;

export const UNDO_WHY_AR = {
  notDelivered: (shipping: string) => `الطلب مش مسجَّل مسلَّم (حالتو «${shipping}») — ما في تسليم نتراجع عنو.`,
  alreadyUndone: (shipping: string) => `انتراجع عن تسليم هالطلب من قبل — حالتو هلّق «${shipping}».`,
  moneyState: (state: string) => `تسوية الطلب بحالة «${settlementWord(state)}» — فيها مصاري أو مسكّرة، وما بيتراجع عن تسليمو من هون.`,
  moneyAmount: 'عالطلب مبلغ محصَّل مكتوب — المصاري تسجّلت، وما بيتراجع عن تسليمو من هون.',
  returnCounted: 'انعدّ مرتجع هالطلب بقسم المرتجعات — ما بيتراجع عن التسليم بعد العدّ.',
  commissionMoved: (n: number) =>
    `عمولة الطلب ما بتنلغي: ${n} قيد منها صار قابل للدفع أو اندفع — المصاري تحرّكت، ما بيتراجع عن التسليم.`,
  noRecord: 'ما لقينا بسجل الطلب كيف انسجّل تسليمو — ما بنقدر نثبت شو لازم يرجع، فما بيتراجع عنو من هون.',
  override: 'انسجّل تسليمو من باب «تجاوز الحالة» — ما بنقدر نثبت أرقام الزبون منو، فما بيتراجع عنو من هون.',
  changedAfter: 'الحالة تغيّرت بعد ما انسجّل التسليم (مش من باب التسليم نفسو) — ما بنقدر نثبت شو لازم يرجع، فما بيتراجع عنو من هون.',
  collectedUnexplained: 'حالة التحصيل «محصَّل» ما بيكتبها الباب اللي سجّل تسليم هالطلب — ما بنقدر نفسّرها، فما بيتراجع عنو من هون.',
  noFigure: 'سجل التسليم ما فيه رقم التحصيل المتوقَّع — ما بنقدر نثبت شو انكتب بسجل الزبون، فما بيتراجع عنو من هون.',
} as const;

/** The words of one line of the measure, built from the facts — kept here so the dialog and the tests read the same sentences. */
export const UNDO_LINE_AR = {
  status: (from: string, to: string, defaulted: boolean) =>
    defaulted
      ? `حالة الشحن بترجع من «${from}» لـ«${to}» (الحالة اللي قبل التسليم مش محفوظة بالسجل)، وتاريخ التسليم بيتمسح.`
      : `حالة الشحن بترجع من «${from}» لـ«${to}»، وتاريخ التسليم بيتمسح.`,
  items: (n: number) => `${n} بند بيرجعوا لـ«الباب لسا ما حكى» — بتنمسح الكميات المسلَّمة والراجعة اللي انكتبت عليهم.`,
  settlement: (from: string, to: string) => `حالة التحصيل بترجع من «${from}» لـ«${to}» — التسليم هو اللي كتبها، وما فيها مصاري.`,
  customer: (afterOrders: number, beforeOrders: number) =>
    beforeOrders > 0
      ? `سجل الزبون: «الطلبات المسلَّمة» بتنقص واحد (من ${beforeOrders} لـ${afterOrders})، وقيمة مشترياتو بتنقص بمقدار التحصيل المتوقَّع وقت التسليم:`
      : 'سجل الزبون: «الطلبات المسلَّمة» أصلاً صفر فبتضل صفر، وقيمة مشترياتو بتنقص (بحد الصفر) بمقدار التحصيل المتوقَّع وقت التسليم:',
  commission: (n: number) => `عمولة الطلب (${n} قيد) بتنلغي بقيد عكسي — القيد الأصلي بيضل بالسجل.`,
} as const;

export const UNDO_STAYS_AR = {
  stock: (out: number, back: number) =>
    out > 0
      ? back > 0
        ? `المخزون ما بيتغيّر: ${out} قطعة طلعت من الرف عند التسليم و${back} رجعت من قبل بقسم المرتجعات.`
        : `المخزون ما بيتغيّر: ${out} قطعة طلعت من الرف عند التسليم وبتضل طالعة — البضاعة عند الشركة، وبترجع للرف لما تنعدّ بقسم المرتجعات، مش من هون.`
      : 'المخزون ما بيتغيّر — ما في خروج من الرف مسجَّل على هالطلب.',
  money: 'ما بينكتب ولا قرش: لا حركة محفظة ولا مبلغ محصَّل.',
  history: 'السجل ما بيتمسح منو شي: بيضيف سطر على خط الطلب وملاحظة داخلية فيها السبب.',
  events: 'إشعار «انسلّم» اللي انبعت وقت التسجيل للتطبيقات ولمنصة الإعلانات ما بينسحب.',
  noCommission: 'ما في عمولة مكتوبة على الطلب.',
} as const;

export const UNDO_SUCCESS_AR = (orderNumber: string, to: string) => `اتراجع عن تسليم الطلب ${orderNumber} — رجع «${to}»`;
