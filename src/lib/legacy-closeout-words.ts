/**
 * «أقفل القديمة بلا باركود» — THE WORDS AND THE CHOICES, safe for a screen and for the commission rule to import.
 *
 *   «كل الطلبات اللي بانتظار التحصيل وما إلها باركود، سوّيها تم تحصيلها بدون ما تأثر على المالية — لأنها طلبات قديمة قبل قصة
 *   الباركود وقبل التسوية المالية» (the owner, 12/11).
 *
 * Nothing here touches the database or a Node module: the screen draws its choices from here, the door reads the same
 * constants, and `commission.ts` reads `LEGACY_CLOSE_ACTION` — one spelling of the mark, in one place.
 */

/**
 * The activity row every order closed by this door carries. It is THE MARK: the commission rule (`PROMOTABLE_BY_PAYOUT`)
 * reads it, so a commission on such an order never becomes payable — the money was collected before the system existed,
 * and the owner said no financial effect.
 */
export const LEGACY_CLOSE_ACTION = 'LEGACY_CLOSED_NO_MONEY';

/** The sentence on each order's settlement log: why a `SETTLED` order has no wallet movement and no statement behind it. */
export const LEGACY_CLOSE_NOTE = 'إقفال قديم بقرار المالك — انحصّل قبل الباركود والتسوية المالية، بلا حركة مال';

/**
 * HOW OLD AN ORDER MUST BE — a short list the owner chooses a row from, never a number he types.
 *
 * «awaiting collection, no barcode» is also exactly what a RECENT order of an agent or a manual company looks like: they
 * never carry a barcode, and the cash is still in the agent's hand. Closing that one would make it impossible to record the
 * handover («استلمت منه» refuses a settled order). So the door closes only what arrived before a cut — counted from the
 * day it was delivered, else shipped, else created — and the screen shows, for every cut, how many it would close.
 */
export const LEGACY_AGES = [1, 3, 7, 14, 30] as const;
export type LegacyAge = (typeof LEGACY_AGES)[number];

/** The longest of the shorter ones: the cut that leaves the most behind, so the first look never over-closes. */
export const DEFAULT_LEGACY_AGE: LegacyAge = 14;

/** More than this in one press is a question for a person, not a button. */
export const LEGACY_MOST = 20_000;

export const LEGACY_AGE_AR: Record<LegacyAge, string> = {
  1: 'أقدم من يوم',
  3: 'أقدم من 3 أيام',
  7: 'أقدم من أسبوع',
  14: 'أقدم من أسبوعين',
  30: 'أقدم من شهر',
};

/** A query string or a body field read as one of the allowed ages — anything else is null, never rounded to a neighbour. */
export function readLegacyAge(raw: unknown): LegacyAge | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  return (LEGACY_AGES as readonly number[]).includes(n) ? (n as LegacyAge) : null;
}

/** What the press would do — and what it would leave, and why. The screen only draws it. */
export interface LegacyMeasure {
  age: LegacyAge;
  /** Orders that arrived before this moment are old enough. */
  cutoff: string;
  /** More than `LEGACY_MOST` parcels are waiting: the press closes nothing and the screen says so. */
  tooMany: boolean;
  /** EXACTLY what the press closes. */
  closeable: {
    count: number;
    /** What the screen saw: the press sends it back and the door refuses if the orders are no longer these. */
    fingerprint: string;
    oldestAt: string | null;
    newestAt: string | null;
    /** By company, the biggest first. A manual company or an agent is the one to look at twice. */
    byCourier: { name: string; count: number }[];
    /** The orders' own value, per currency — a measure of the size of the press, not money that moves. */
    value: { currency: string; amount: number }[];
  };
  /** How many each age would close — the choice's own numbers. */
  options: { age: LegacyAge; count: number }[];
  /** Awaiting collection with no barcode, and NOT closed by this press. */
  left: {
    /** Newer than the cut: the cash may still be with the courier. */
    tooRecent: number;
    /** A settlement state that already carries money (collected by the courier, part-settled, refunded). */
    moneyRecorded: number;
    /** A courier statement names it, or a person tied a statement line to it: the statement will settle it. */
    onAStatement: number;
  };
}

/*
 * ── THE PRESS ON THE ORDERS THE OWNER TICKED (13/11) ──
 *
 *   «اقدر اعمل هالحركة هاي لاي طلب حتى لو عليه باركود، بس بدي الزر هاد متاح للمالك فقط» (the owner)
 *
 * Same promise as the old-ones press (no money moves; the commission never becomes payable) and the same key, but the choice of
 * orders is HIS: the ones he ticked on the list, with a barcode or without, of any age. What it still refuses, order by order and
 * with the reason: not delivered, already settled, a settlement state that carries money, and an order a statement speaks for.
 */

/** The most orders one press on ticked orders may carry — the collect door's own ceiling, so «اختر الكل» on a page always fits. */
export const PICKED_MOST = 500;

/** The audit line of that press (the mark on each order is still `LEGACY_CLOSE_ACTION`: the commission rule reads ONE spelling). */
export const PICKED_CLOSE_AUDIT = 'PICKED_CLOSED_NO_MONEY';

/** The sentence on each order's settlement log for an order he ticked. */
export const PICKED_CLOSE_NOTE = 'إقفال بقرار المالك على طلب محدَّد — انحصّل خارج النظام، بلا حركة مال';

/** «Recent» for a ticked order: arrived less than this many days ago. The old press's default cut — one number, not a second opinion. */
export const PICKED_RECENT_DAYS = DEFAULT_LEGACY_AGE;

/** Why a ticked order is left alone. */
export type PickedWhy = 'NOT_FOUND' | 'NOT_DELIVERED' | 'ALREADY_SETTLED' | 'MONEY_RECORDED' | 'ON_A_STATEMENT';

/** What the press on ticked orders would do — and what it would leave, and why. The screen only draws it. */
export interface PickedMeasure {
  /** How many different orders were ticked. */
  asked: number;
  /** EXACTLY what the press closes. */
  closeable: {
    count: number;
    /** What the screen saw: the press sends it back and the door refuses if the orders are no longer these. */
    fingerprint: string;
    oldestAt: string | null;
    newestAt: string | null;
    byCourier: { name: string; count: number }[];
    /** The orders' own value, per currency — a measure of the size of the press, not money that moves. */
    value: { currency: string; amount: number }[];
    /** How many of them carry a barcode (a statement could still arrive for them). */
    withBarcode: number;
    /** How many arrived less than `recentDays` ago: the cash may still be in the courier's hand. */
    recent: number;
  };
  recentDays: number;
  /** The ticked orders it leaves alone, one line each in the order they were ticked (the first ones; `leftTotal` is all of them). */
  left: { orderNumber: string | null; why: PickedWhy; text: string }[];
  leftTotal: number;
}

export const PICKED_NOTHING_AR = 'ما في ولا طلب من المحدّدين ينقفل — شوف السبب جنب كل طلب.';
export const PICKED_CHANGED_AR = 'تغيّر وضع طلب أو أكثر من المحدّدين وقت القفل (انحصّل أو انربط بكشف). ما انقفل شي — افتح النافذة من جديد.';
export const PICKED_LATE_STATEMENT_AR = 'كشف ذكر طلباً من المحدّدين وقت القفل — الكشف هو اللي بيسوّيه. ما انقفل شي.';

export const NOTHING_TO_CLOSE_AR = 'ما في طلب قديم بلا باركود بهالعمر ينقفل.';
export const CHANGED_AR = 'تغيّرت الأرقام من لما فتحت النافذة — افتحها من جديد وراجعها قبل ما تقفل.';
export const FORBIDDEN_LEGACY_AR = 'قفل الطلبات القديمة بلا باركود مش من صلاحياتك — اطلبها من المالك.';
export const BAD_AGE_AR = 'عمر الطلبات لازم يكون واحد من: يوم · 3 أيام · أسبوع · أسبوعين · شهر.';
export const ACK_AR = 'لازم تقرّ إنو القفل بلا حركة مال وما بيرجع من الشاشة.';
