/**
 * «تراجع عن إقفال القديمة» — THE WORDS AND THE SHAPES, safe for a screen to import (25/11).
 *
 *   «اعملها بالكود» (the owner, on the orders that «إقفال القديمة» closed as collected while the company says they came back)
 *
 * Nothing here touches the database or a Node module: the dialog draws what the door answers (`TakeBackMeasure`), the door reads the
 * same constants, and the tests read the sentences from here — one spelling of each, in one place.
 *
 * ── WHAT THE BUTTON IS, IN ONE PARAGRAPH ──
 *
 * «أقفل القديمة» (and the owner's press on the orders he ticks) moved a delivered order to «مسوّى» with NO money: no wallet line, no
 * collected amount, no statement. When the parcel really came back, that «مسوّى» is wrong — and it is the one thing that keeps
 * «تراجع عن التسليم» and the returns desk away from the order. This press puts the settlement back to the state the close itself
 * recorded it took the order from, on ONE order, with a reason, and only when nothing but that close ever touched its money. After it,
 * the ordinary roads («تراجع عن التسليم», then the returns desk) take the order. It is the owner's: the very key the close asks,
 * `ops.close_legacy`, granted to nobody by any migration, seed or fallback.
 */

/** The activity row every taken-back order carries — and the audit line's action. One spelling, read by the timeline and the audit view. */
export const LEGACY_TAKE_BACK_ACTION = 'LEGACY_CLOSE_TAKEN_BACK';

/**
 * WHAT THE CLOSE'S MARK IS RENAMED TO — the spelling the owner's rollback script already uses
 * (`scripts/backfills/20261112-legacy-closeout.rollback.sql`, step 3). Renamed, never deleted: the history stays, and the commission rule
 * (`PROMOTABLE_BY_PAYOUT`, which reads the OLD name) stops leaving the order out — so a later real settlement pays its commission once.
 */
export const LEGACY_MARK_UNDONE = 'LEGACY_CLOSED_NO_MONEY_UNDONE';

/** What the settlement log line starts with; the reason follows. */
export const TAKE_BACK_NOTE_PREFIX = 'تراجع عن «إقفال القديمة» بلا مال';

/** Why an order is left alone, as a code the screen and the tests can read. */
export type TakeBackWhy =
  | 'NOT_FOUND'
  | 'NOT_SETTLED'
  | 'ALREADY_TAKEN_BACK'
  | 'NOT_BY_LEGACY_CLOSE'
  | 'MONEY_RECORDED'
  | 'COMMISSION_MOVED';

export type TakeBackLineKey = 'SETTLEMENT' | 'MARK' | 'NEXT' | 'SHIPPING' | 'MONEY' | 'STOCK' | 'COMMISSION' | 'HISTORY';

export interface TakeBackLine {
  key: TakeBackLineKey;
  text: string;
}

/** What the press would do to ONE order — and what it would leave, and why it refuses. The screen only draws it. */
export interface TakeBackMeasure {
  orderNumber: string;
  courier: string;
  allowed: boolean;
  /** Set exactly when `allowed` is false: the first refusal that applies, in words. */
  refusal: { code: TakeBackWhy; text: string } | null;
  /** What the dialog saw. The press sends it back, and the door refuses if the order is no longer this. Null when nothing can be done. */
  fingerprint: string | null;
  /** The settlement states, as codes: `from` is today's, `to` is where it goes back to. */
  from: string;
  to: string | null;
  /** EVERYTHING the press would write — nothing else is written. */
  lines: TakeBackLine[];
  /** What it leaves exactly as it is, and says so. */
  stays: TakeBackLine[];
}

/* ───────────────────────── the sentences ───────────────────────── */

export const TAKE_BACK_FORBIDDEN_AR = 'التراجع عن «إقفال القديمة» مش من صلاحياتك — اطلبو من المالك.';
export const TAKE_BACK_ACK_AR = 'لازم تقرّ إنو التراجع بيرجّع تسوية الطلب لحالتها قبل الإقفال، وإنو بيتسجّل باسمك.';
export const TAKE_BACK_NOT_FOUND_AR = 'الطلب ما انلقى بهالمتجر.';
export const TAKE_BACK_CHANGED_AR = 'تغيّر وضع الطلب من لما فتحت النافذة — افتحها من جديد وراجعها قبل ما ترجّع.';
export const TAKE_BACK_ORDERS_CHANGED_AR =
  'تغيّر وضع الطلب وقت التراجع (انحصّل أو انربط بكشف أو انعدّل أو رجّعو حدا). ما رجع شي — افتح النافذة من جديد.';
export const TAKE_BACK_LATE_MONEY_AR = 'ظهرت مصاري عالطلب وقت التراجع (حركة محفظة أو كشف أو عمولة). ما رجع شي — افتح النافذة من جديد.';

export const TAKE_BACK_WHY_AR = {
  notSettled: (state: string) => `تسوية الطلب «${state}» مش «مسوّى» — ما في إقفال نتراجع عنو.`,
  alreadyTakenBack: (state: string) => `انتراجع عن إقفال هالطلب من قبل — تسويتو هلّق «${state}».`,
  notByLegacy: 'الطلب مسوّى، بس مش بـ«إقفال القديمة» — تسويتو جاية من كشف أو تحصيل، وما بترجع من هون.',
  changedAfter: 'الطلب انقفل بـ«إقفال القديمة»، بس تسويتو انكتبت بعدها من باب تاني — ما بنقدر نثبت إنو «مسوّى» هلّق من الإقفال، فما بترجع من هون.',
  unknownBefore: 'سجل الإقفال ما فيه حالة تحصيل بلا مصاري كانت قبلو — ما بنعرف لوين نرجّعو، فما بيرجع من هون.',
  moneyAmount: 'عالطلب مبلغ محصَّل مكتوب — المصاري تسجّلت، وما بيرجع من هون.',
  wallet: (n: number) => `في ${n} حركة محفظة باسم هالطلب — المصاري دخلت، وما بيرجع من هون.`,
  manualCollection: 'انسجّل عالطلب «استلمت منه» — المصاري دخلت باليد، وما بيرجع من هون.',
  statement: (reference: string) => `كشف ${reference} سوّى هالطلب أو بتّ فيه بمصاري — الكشف هو صاحب مصاريه، وما بيرجع من هون.`,
  commissionMoved: (n: number) => `عمولة الطلب: ${n} قيد منها صار قابل للدفع أو اندفع — المصاري تحرّكت، وما بيرجع من هون.`,
} as const;

/** The words of one line of the measure, built from the facts — kept here so the dialog and the tests read the same sentences. */
export const TAKE_BACK_LINE_AR = {
  settlement: (from: string, to: string) => `حالة التحصيل بترجع من «${from}» لـ«${to}» — الحالة اللي كانت عليها قبل «إقفال القديمة».`,
  mark: 'علامة «إقفال القديمة» على الطلب بتتعطّل (ما بتنمسح) — فإذا سوّاه كشف بعدين بمصاري حقيقية، عمولتو بتصير قابلة للدفع مرة وحدة متل أي طلب.',
  next: 'بعدها، إذا الطرد رجع فعلاً: اضغط «تراجع عن التسليم»، وقسم المرتجعات بيستلمو.',
} as const;

export const TAKE_BACK_STAYS_AR = {
  shipping: (state: string) => `حالة الشحن ما بتتغيّر — بتضل «${state}».`,
  money: 'ما بينكتب ولا قرش: لا حركة محفظة ولا مبلغ محصَّل.',
  stock: 'المخزون ما بيتغيّر.',
  commission: 'قيود العمولة نفسها ما بتتغيّر.',
  history: 'السجل ما بيتمسح منو شي: بيضيف سطر على تسوية الطلب وسطر بسجل التدقيق فيهن السبب.',
} as const;

export const TAKE_BACK_SUCCESS_AR = (orderNumber: string, to: string) =>
  `رجعت تسوية الطلب ${orderNumber} لـ«${to}» — هلّق فيك تتراجع عن تسليمو إذا رجع.`;
