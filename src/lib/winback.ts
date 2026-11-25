import { NO_ANSWER_CLOSE, REJECTION_REASONS, REJECTION_REASON_AR } from './confirmation-workflow';
import { DELIVERY_FAILURE_REASON_LABELS, RETURN_REASON_LABELS } from './shipping-workflow';

/**
 * A SECOND CALL, WEEKS LATER, WITH SOMETHING NEW TO SAY.
 *
 * Some orders are lost for a reason that stops being true. «السعر مرتفع» is
 * answered by a lower price. «غيّر رأيه» is answered by time. Three calls
 * that nobody picked up is not a refusal at all — we never reached them.
 *
 * MOST ARE NOT, and calling them anyway is worse than leaving them alone:
 *
 *   a DUPLICATE was never a lost sale — the customer has the goods, and
 *   ringing to offer them again says nobody here reads their own records;
 *
 *   a REFUSAL is an answer. «لا أريد المنتج» is the customer telling us,
 *   and a discount on a thing somebody does not want is a discount on
 *   nothing. Calling back to haggle is how a shop earns a reputation;
 *
 *   BAD DATA reaches nobody. A wrong number, a fake order, an entry error —
 *   there is no person at the other end of a second call either;
 *
 *   OUT OF COVERAGE has not changed. Offering a discount for a place we
 *   still cannot deliver to is a promise we would have to break;
 *
 *   «أخرى» we do not know. A blanket re-approach on the one code that means
 *   «none of these» is a guess, and it would be the largest bucket.
 *
 * AND AFTER IT SHIPPED TOO — SINCE 28/10, BY THE OWNER'S RULING.
 *
 * This paragraph used to argue the opposite: «a parcel that went out and
 * came back is a return: it has a courier fee against it, goods that
 * travelled, and a customer who saw the thing and sent it away. That is a
 * different conversation, and it is not this one.» The owner read the rule
 * on «ملغاة سابقاً» and asked «هل بيعرض الملغي قبل الشحن وبعد ؟ اذا اه تمام
 * اذا لأ خليه يجري ع ال 2». It did not; now it runs on both, under one rule,
 * with one switch he may turn off («يشمل المرتجع بعد الشحن» — on, because
 * he asked for both).
 *
 * What survives of the old argument is the word BACK. A parcel that left is
 * never cancelled in this system — it comes back, and it is back when the
 * counting desk receives it (`ReturnReceipt`). So the second kind is exactly
 * that: shipped, RETURNED, received. Not one still on the road
 * (FAILED_DELIVERY, RETURN_REQUESTED) — it may yet be delivered, and a
 * second order then is a double order; not a partial delivery — he took
 * part of it; not a return nobody received, nor one written off as a loss —
 * nobody knows whether the goods are in his hands, which is the reason a
 * duplicate is never rung either. Its cooling counts from the receipt. The
 * confirmation reasons do not gate it (the courier records none), but the
 * four nobody may ring still refuse it.
 *
 * Its listing and its offer are both gated on `confirmation.supervise`,
 * because the discount is money and an agent does not set it alone.
 */

/** The three a second call makes sense for, named one by one rather than as a subtraction. */
export const WINBACK_REASONS = [
  'PRICE_TOO_HIGH',
  // The most winnable of them all: he wants the product and said so — the
  // only thing between him and it is a number we control.
  'FOUND_CHEAPER_ELSEWHERE',
  'CUSTOMER_CHANGED_MIND',
  'NO_ANSWER_3_ATTEMPTS',
] as const;
export type WinbackReason = (typeof WINBACK_REASONS)[number];

/**
 * THREE MORE THE OWNER MAY CHOOSE TO INCLUDE — HIS SHOP, HIS REPUTATION.
 *
 * Nothing in the code can know whether a customer who said «لا أريد المنتج»
 * would answer a second call kindly, or whether «خارج التغطية» has since been
 * covered. The comment above argues they should not be called, and that
 * argument is the DEFAULT; but it is an argument about a shop, and the shop's
 * owner is the one who knows it. So he may switch each of these on.
 */
export const OPTIONAL_WINBACK_REASONS = ['CUSTOMER_DOES_NOT_WANT_PRODUCT', 'OUT_OF_SERVICE_AREA', 'OTHER'] as const;

/**
 * THE PLAN'S FIVE-ATTEMPT CLOSE, ON ITS OWN TICK — the owner's ruling 25/11 (F12: «NO_ANSWER_5_ATTEMPTS is selectable»). It still rides on
 * «three» (`WINBACK_RIDERS`): a rule that ticks three — every rule saved before this — keeps reading the five-attempt closes too. Its own
 * tick lets him call for the five-attempt closes WITHOUT the three-attempt ones.
 */
export const SELECTABLE_RIDERS = [NO_ANSWER_CLOSE.five.reason] as const;

/** What the rule's editor offers: the four, the three, and the five-attempt close. */
export const SELECTABLE_WINBACK_REASONS: readonly string[] = [...WINBACK_REASONS, ...OPTIONAL_WINBACK_REASONS, ...SELECTABLE_RIDERS];

/**
 * AND THE FOUR NOBODY MAY TURN ON.
 *
 * A duplicate was never a lost sale — the customer has the goods. A wrong
 * number, a fake order and an entry error reach no person at all. No setting
 * changes any of that, so no setting offers it: a rule that could be edited
 * into ringing somebody who already has the parcel is not a rule worth having.
 */
export const NEVER_WINBACK_REASONS = ['DUPLICATE_ORDER', 'WRONG_NUMBER', 'FAKE_ORDER', 'MODERATOR_DATA_ERROR'] as const;

/**
 * ONE REASON, TWO STORED CODES. «Closed because nobody answered» is one winback reason whether the rule that closed it said three or five: the rule's tick (and every rule
 * already saved, which names only the old code) stands for both. A code listed here rides on the code it maps to — asked of the rule, never stored in it.
 */
export const WINBACK_RIDERS: Readonly<Record<string, string>> = { [NO_ANSWER_CLOSE.five.reason]: NO_ANSWER_CLOSE.three.reason };

/** The stored codes a rule's reasons stand for: what it lists, plus every code riding on one it lists. The verdict and the database filter both ask THIS. */
export const winbackCodes = (reasons: readonly string[]): string[] => [
  ...new Set([...reasons, ...Object.keys(WINBACK_RIDERS).filter((code) => reasons.includes(WINBACK_RIDERS[code]))]),
];

/**
 * The words of the RULE's tick and sentence UNDER THE PLAN: the host reads without a number, because with «جدول المحاولات» on it stands for three AND five.
 * Rows and filters always say their own code's words (`REJECTION_REASON_AR`).
 */
export const WINBACK_LABEL_AR: Readonly<Record<string, string>> = { [NO_ANSWER_CLOSE.three.reason]: 'أُغلق تلقائياً بعد محاولات بلا ردّ' };

/**
 * A reason as the rule's tick and sentence say it. THE SWITCH DECIDES (the planner 15/11, answer 6): with it OFF (the default — nothing handed) the label is
 * `REJECTION_REASON_AR`'s own, «أُغلق بعد ثلاث محاولات بلا ردّ», byte for byte as before the plan; `planOn: true` swaps in the number-free one above. An options object, not a
 * second positional: `.map(winbackLabel)` would hand it the index.
 */
export const winbackLabel = (code: string, opts: { planOn?: boolean } = {}): string =>
  (opts.planOn === true ? WINBACK_LABEL_AR[code] : undefined) ?? REJECTION_REASON_AR[code] ?? code;

/** And why each of the others is left alone — in the reader's language, on the screen. */
export const NOT_WINBACK_AR: Record<string, string> = {
  CUSTOMER_DOES_NOT_WANT_PRODUCT: 'رفضٌ صريح — الخصم على شيءٍ لا يريده ليس عرضاً',
  DUPLICATE_ORDER: 'مكرَّر — البضاعة عنده أصلاً',
  WRONG_NUMBER: 'بياناتٌ خاطئة — لا أحد على الطرف الآخر',
  FAKE_ORDER: 'بياناتٌ خاطئة — لا أحد على الطرف الآخر',
  MODERATOR_DATA_ERROR: 'بياناتٌ خاطئة — لا أحد على الطرف الآخر',
  OUT_OF_SERVICE_AREA: 'خارج التغطية — ولم يتغيّر شيء',
  OTHER: 'السبب غير محدَّد — لا نعرف ماذا نعرض',
};

/**
 * HOW LONG BEFORE WE ASK AGAIN.
 *
 * Long enough that the call is a new conversation rather than the same one
 * continued after a pause — somebody rung back on Thursday about the Tuesday
 * they said no has been pestered, not won back. Short enough that the
 * customer still remembers the product and the price still stands.
 *
 * Fourteen days, the same shape as `POSTPONE_LEAD_DAYS` and `NO_ANSWER_LIMIT`:
 * one named number with its reason beside it, not a setting nobody will tune.
 */
export const WINBACK_COOLING_DAYS = 14;

/** The most of the price that may be given away to win one back. */
export const WINBACK_MAX_DISCOUNT_SHARE = 0.25;

/** Rejected orders are read this far back; past that a call is archaeology. */
export const WINBACK_LOOKBACK_DAYS = 120;

/**
 * THE RULE, AS A VALUE THE OWNER MAY EDIT — WITHIN BOUNDS.
 *
 * The owner, 21/10: «شو القاعدة تبعو لاني ممكن اعدلها». The four numbers above
 * were written into the code, with a reason beside each, and the answer to
 * «could I change fourteen days?» was «ask somebody to change the code».
 *
 * What he may turn: which reasons are worth a second call (the four, and three
 * more at his own risk), whether a parcel that shipped and came back is read at
 * all («يشمل المرتجع بعد الشحن», since 28/10), how long to wait, how far back to
 * look, how much of the price may be given away. What he may NOT: a parcel that
 * left and is not back — on the road, delivered in whole or in part, returned
 * and never received — is no lost call under any setting (this line read «a
 * shipped parcel is a return and never a lost call» until he ruled for the ones
 * that came back); an order that was already offered is never offered again
 * («من قال لا مرّتين قال لا»); a second chance is never itself a first one; and
 * a duplicate, a wrong number, a fake order or an entry error has nobody to
 * ring. Those are not settings — they are what makes the screen safe to leave
 * alone, and the verdict still applies every one of them whatever is stored.
 *
 * The defaults are exactly the constants, so an owner who never opens the editor
 * sees nothing change. The bounds are here because a stored number is read by
 * the list AND the offer, and a «0 days» or «500%» that got in would be read by
 * both.
 */
export interface WinbackRule {
  /** The rejection reasons a second call is made for — always some of `SELECTABLE_WINBACK_REASONS`. They gate an order lost BEFORE it shipped. */
  reasons: readonly string[];
  /**
   * Whether a parcel that shipped and came back (RETURNED, and received by the desk) is a lost sale too.
   * On unless the owner turns it off: he asked for both («قبل الشحن وبعد», 28/10).
   */
  afterShipping: boolean;
  /** Days between the cancellation — or the return's receipt — and the call. */
  coolingDays: number;
  /** Orders created longer ago than this are not read at all. */
  lookbackDays: number;
  /** The most of the price that may be given away, as a share: 0 to 0.5. */
  maxDiscountShare: number;
}

export const DEFAULT_WINBACK_RULE: WinbackRule = {
  reasons: WINBACK_REASONS,
  afterShipping: true,
  coolingDays: WINBACK_COOLING_DAYS,
  lookbackDays: WINBACK_LOOKBACK_DAYS,
  maxDiscountShare: WINBACK_MAX_DISCOUNT_SHARE,
};

export const WINBACK_BOUNDS = {
  coolingDays: { min: 1, max: 90 },
  lookbackDays: { min: 30, max: 365 },
  maxDiscountShare: { min: 0, max: 0.5 },
} as const;

const clampInt = (n: unknown, lo: number, hi: number, fallback: number): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;

/**
 * A STORED RULE, AS THIS BUILD UNDERSTANDS IT.
 *
 * Tolerant, because it is read on every load of the list and a row that throws
 * would take the screen down: a reason that is not one of the seven is dropped,
 * an empty list falls back to the four, a number out of its bounds is clamped,
 * and a look-back no longer than the cooling (which would admit no order at
 * all) is lifted to a week past it. The switch is read only when it is a real
 * yes or no; a rule stored before it existed has none, and reads as on — what
 * the owner asked for.
 */
export function parseWinbackRule(raw: unknown): WinbackRule {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const chosen = Array.isArray(o.reasons)
    ? SELECTABLE_WINBACK_REASONS.filter((r) => (o.reasons as unknown[]).includes(r))
    : [];
  const cooling = clampInt(o.coolingDays, WINBACK_BOUNDS.coolingDays.min, WINBACK_BOUNDS.coolingDays.max, DEFAULT_WINBACK_RULE.coolingDays);
  const lookback = clampInt(o.lookbackDays, WINBACK_BOUNDS.lookbackDays.min, WINBACK_BOUNDS.lookbackDays.max, DEFAULT_WINBACK_RULE.lookbackDays);
  const share =
    typeof o.maxDiscountShare === 'number' && Number.isFinite(o.maxDiscountShare)
      ? Math.min(WINBACK_BOUNDS.maxDiscountShare.max, Math.max(WINBACK_BOUNDS.maxDiscountShare.min, Math.round(o.maxDiscountShare * 10_000) / 10_000))
      : DEFAULT_WINBACK_RULE.maxDiscountShare;
  return {
    reasons: chosen.length > 0 ? chosen : [...DEFAULT_WINBACK_RULE.reasons],
    afterShipping: typeof o.afterShipping === 'boolean' ? o.afterShipping : DEFAULT_WINBACK_RULE.afterShipping,
    coolingDays: cooling,
    lookbackDays: lookback > cooling ? lookback : Math.min(WINBACK_BOUNDS.lookbackDays.max, cooling + 7),
    maxDiscountShare: share,
  };
}

export type WinbackRuleInput =
  | { ok: true; rule: WinbackRule }
  | { ok: false; code: string; errorAr: string };

/**
 * WHAT THE EDITOR SENDS, REFUSED RATHER THAN CLAMPED.
 *
 * A stored rule is read leniently (above); a typed one is judged. «500%» typed
 * into a box is a slip, and quietly storing 50 would let the owner believe he
 * had set what he typed. Every refusal names the field and the limit, in Arabic.
 * The discount arrives as a PERCENT, because that is what a person types, and
 * leaves as the share the arithmetic reads.
 *
 * The switch is a yes or a no and nothing else: «"true"» or a 1 is refused by
 * name. Left out, it is on — a form from before the switch existed saves what
 * the owner asked for rather than turning off what he never saw.
 */
export function validateWinbackRule(input: unknown): WinbackRuleInput {
  const refuse = (code: string, errorAr: string): WinbackRuleInput => ({ ok: false, code, errorAr });
  if (!input || typeof input !== 'object' || Array.isArray(input)) return refuse('BAD_BODY', 'الطلب غير صالح');
  const o = input as Record<string, unknown>;
  const known = new Set(['reasons', 'afterShipping', 'coolingDays', 'lookbackDays', 'maxDiscountPercent']);
  const stray = Object.keys(o).find((k) => !known.has(k));
  if (stray) return refuse('UNKNOWN_FIELD', `حقلٌ غير معروف: ${stray}`);

  if (!Array.isArray(o.reasons) || o.reasons.length === 0) return refuse('REASONS', 'اختر سبباً واحداً على الأقلّ');
  if (new Set(o.reasons).size !== o.reasons.length) return refuse('REASONS', 'سببٌ مكرَّر');
  const bad = o.reasons.find((r) => typeof r !== 'string' || !SELECTABLE_WINBACK_REASONS.includes(r));
  if (bad !== undefined) {
    // A body that lists the five-attempt code by hand lands here too (it rides on its host, it is never stored): the editor never sends it.
    const label = typeof bad === 'string' ? winbackLabel(bad) : String(bad);
    return refuse('REASONS', `«${label}» لا يمكن الاتصال لأجله بأيّ إعداد`);
  }
  if (o.afterShipping !== undefined && typeof o.afterShipping !== 'boolean') {
    return refuse('AFTER_SHIPPING', 'يشمل المرتجع بعد الشحن: نعم أو لا فقط');
  }

  const whole =(v: unknown, name: string, b: { min: number; max: number }, code: string): number | WinbackRuleInput => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < b.min || v > b.max) return refuse(code, `${name}: رقمٌ صحيحٌ من ${b.min} إلى ${b.max}`);
    return v;
  };
  const cooling = whole(o.coolingDays, 'المهلة بالأيام', WINBACK_BOUNDS.coolingDays, 'COOLING_DAYS');
  if (typeof cooling !== 'number') return cooling;
  const lookback = whole(o.lookbackDays, 'أبعد طلب بالأيام', WINBACK_BOUNDS.lookbackDays, 'LOOKBACK_DAYS');
  if (typeof lookback !== 'number') return lookback;
  if (lookback <= cooling) return refuse('LOOKBACK_DAYS', 'أبعد طلبٍ يجب أن يكون أكبر من المهلة — وإلا لا يدخل أيُّ طلب');

  const pct = o.maxDiscountPercent;
  const maxPct = WINBACK_BOUNDS.maxDiscountShare.max * 100;
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > maxPct) {
    return refuse('MAX_DISCOUNT', `أقصى خصم: من 0 إلى ${maxPct}٪`);
  }
  return {
    ok: true,
    rule: {
      reasons: SELECTABLE_WINBACK_REASONS.filter((r) => (o.reasons as string[]).includes(r)),
      afterShipping: o.afterShipping === undefined ? DEFAULT_WINBACK_RULE.afterShipping : (o.afterShipping as boolean),
      coolingDays: cooling,
      lookbackDays: lookback,
      maxDiscountShare: Math.round(pct * 100) / 10_000,
    },
  };
}

/**
 * The rule in one line — what is printed on the screen, so it never looks arbitrary.
 *
 * Both kinds while the switch is on, and the reasons said to be the before-shipping
 * kind's, because that is the only kind they gate. Off, the sentence is the one the
 * screen printed before 28/10, word for word — the switch puts back what it takes.
 *
 * `opts.planOn` is «جدول المحاولات» being on — a second, unrelated switch: left out (or false) the sentence is exactly what it was before the plan, «أُغلق بعد ثلاث محاولات
 * بلا ردّ» included; on, the no-answer close reads number-free (`winbackLabel`). The caller reads the switch the normal way (`cadenceSince`).
 */
export function ruleSentence(rule: WinbackRule, opts: { planOn?: boolean } = {}): string {
  const reasons = rule.reasons.map((r) => winbackLabel(r, opts)).join('، ');
  const pct = Math.round(rule.maxDiscountShare * 10_000) / 100;
  if (rule.afterShipping !== true) {
    return `ملغى · لم يُشحن · لم يُعرض عليه من قبل · السبب: ${reasons} · بعد ${rule.coolingDays} يوماً من الإلغاء · من طلباتِ آخر ${rule.lookbackDays} يوماً · خصمٌ حتى ${pct}٪`;
  }
  return `ملغى قبل الشحن أو مرتجع بعده · لم يُعرض عليه من قبل · سبب الإلغاء قبل الشحن: ${reasons} · بعد ${rule.coolingDays} يوماً من الإلغاء أو استلام المرتجع · من طلباتِ آخر ${rule.lookbackDays} يوماً · خصمٌ حتى ${pct}٪`;
}

/**
 * WHAT A PARCEL THAT CAME BACK IS CALLED — on its row, and in the new order's note.
 *
 * The return's own reason in words when one was recorded as a code (`returnReason`
 * first, then why the delivery failed), through the labels the shipping screens use.
 * Never a raw code, and never a sentence somebody typed: the courier transfer and the
 * write-off both write prose into `returnReason`, and prose is not a label.
 */
export const AFTER_SHIPPING_AR = 'مرتجع بعد الشحن';

const labelOf = (table: Record<string, { ar: string }>, code: string | null | undefined): string | null =>
  code && Object.prototype.hasOwnProperty.call(table, code) ? table[code].ar : null;

export function returnLabel(o: { returnReason?: string | null; deliveryFailureReason?: string | null }): string {
  const said = labelOf(RETURN_REASON_LABELS, o.returnReason) ?? labelOf(DELIVERY_FAILURE_REASON_LABELS, o.deliveryFailureReason);
  return said ? `${AFTER_SHIPPING_AR} — ${said}` : AFTER_SHIPPING_AR;
}

export interface WinbackSource {
  confirmationStatus: string;
  rejectionReason: string | null;
  /** When it was closed. Null falls back to nothing — an order with no date is not due. */
  rejectedAt: Date | string | null;
  /**
   * Anything non-null means the parcel left. From then on only a parcel that is BACK
   * (`shippingStatus` RETURNED, and received by the desk) is a lost sale; one still out is not.
   */
  shippedAt: Date | string | null;
  /**
   * Where the parcel is now. Read only once it shipped: RETURNED is the one state in
   * which it came back. Optional, like `createdAt`: a caller that does not know it
   * gets the refusal every shipped order got before 28/10.
   */
  shippingStatus?: string | null;
  /**
   * When the counting desk received it back — `ReturnReceipt.inspectedAt`, and the
   * moment a returned order's cooling counts from. Null while nobody has.
   */
  returnReceivedAt?: Date | string | null;
  /**
   * The desk's receipt says no unit came back: a zero count, or a write-off (`nothingCameBack`). The order is
   * closed and there is no parcel to resell, so it is never a win-back call, whatever date the receipt carries.
   */
  returnNothingCameBack?: boolean;
  /** The replacement it already has. A customer asked twice has answered twice. */
  replacedByOrderNumber: string | null;
  /**
   * The order this one was raised to win back, if it is itself a second
   * chance. Null for an ordinary order.
   */
  replacesOrderNumber: string | null;
  sellingPrice: number;
  discountAmount: number;
  /**
   * When the ORDER was made. Optional: a caller that does not know it gets no
   * look-back check, which is what every caller got before the rule had one.
   */
  createdAt?: Date | string | null;
}

export type WinbackVerdict =
  | { eligible: true; dueAt: Date; maxDiscount: number }
  | { eligible: false; code: string; reason: string; dueAt?: Date };

const asDate = (v: Date | string | null): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? null : d;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * CAN THIS ONE BE ASKED AGAIN, AND FOR HOW MUCH AT MOST?
 *
 * Pure, and it refuses in words rather than with a boolean: the screen lists
 * the ones it turned down beside the ones it did not, so a supervisor reading
 * «مكرَّر — البضاعة عنده أصلاً» learns the rule instead of wondering where an
 * order went.
 */
/**
 * THE TWO WORDS FOR ONE THING.
 *
 * An order that did not happen ends as REJECTED when the agent records the
 * customer's no, and as CANCELLED when a manager cancels it or the
 * no-answer rule closes it. This screen read the first word only — so
 * every order cancelled the second way was invisible on the one screen
 * built to find them, and the seller reported it as «الإلغاء لا يظهر في
 * استرجاع الملغي».
 *
 * Measured when it was fixed: three cancelled orders were missing, one of
 * them closed by the no-answer rule — which is among the most winnable
 * reasons there is.
 */
export const LOST_STATUSES: readonly string[] = ['REJECTED', 'CANCELLED'];

/**
 * A PARCEL THAT LEFT AND CAME BACK — shipped, and RETURNED. Received or not is the
 * verdict's next question, not this one: the row is named a return either way.
 * `winback-filters.ts` writes the same two conditions for the database.
 */
export const returnedAfterShipping = (o: Pick<WinbackSource, 'shippedAt' | 'shippingStatus'>): boolean =>
  !!asDate(o.shippedAt) && o.shippingStatus === 'RETURNED';

export function winbackVerdict(order: WinbackSource, now: Date, rule: WinbackRule = DEFAULT_WINBACK_RULE): WinbackVerdict {
  const back = returnedAfterShipping(order);
  if (!back && !LOST_STATUSES.includes(order.confirmationStatus)) {
    return { eligible: false, code: 'NOT_REJECTED', reason: 'هذا الطلب ليس ملغى' };
  }

  /**
   * AFTER IT SHIPPED, ONLY WHAT IS BACK — «قبل الشحن وبعد», 28/10.
   *
   * This was one refusal for every parcel that ever left: «شُحن ثمّ عاد — هذا إرجاع،
   * وله حسابه الخاصّ». The owner ruled the ones that came back in, so the refusal
   * is now three, each saying which part is missing: it is not back (on the road,
   * or with the customer in whole or in part — a second order for a parcel that may
   * yet be delivered is a double order); it is back but nobody received it (waiting
   * at the desk, or written off as a loss — nobody knows whose hands the goods are
   * in); or it is back and received, and the owner has switched the kind off.
   */
  if (asDate(order.shippedAt)) {
    if (!back) {
      return { eligible: false, code: 'ALREADY_SHIPPED', reason: 'شُحن ولم يرجع إلينا — ما زال عند شركة الشحن أو عند العميل' };
    }
    if (!asDate(order.returnReceivedAt ?? null) || order.returnNothingCameBack === true) {
      return { eligible: false, code: 'RETURN_NOT_RECEIVED', reason: 'رجع ولم يستلمه المستودع بعد، أو أُغلق كخسارة ولن يعود' };
    }
    if (rule.afterShipping !== true) {
      return { eligible: false, code: 'AFTER_SHIPPING_OFF', reason: 'المرتجع بعد الشحن غير مشمول في القاعدة' };
    }
  }
  if (order.replacedByOrderNumber) {
    return {
      eligible: false,
      code: 'ALREADY_OFFERED',
      reason: `عُرض عليه مرّةً بالفعل (${order.replacedByOrderNumber}) — ومن قال لا مرّتين قال لا`,
    };
  }

  /**
   * ONE SECOND CHANCE, NOT A CHAIN OF THEM.
   *
   * The database stops the ORIGINAL order being offered twice —
   * `replacesOrderId` is unique, so it can carry at most one replacement.
   * It says nothing about the replacement itself, and this verdict only
   * looked at «has anybody offered on THIS order», never at «is this order
   * already somebody's second chance».
   *
   * So order A was won back as B; B was rejected; fourteen days later B
   * appeared in the list looking like an ordinary lost sale, was offered a
   * discount, became C — and so on, each round cheaper than the last, to a
   * customer who had now said no three times. The rule this screen exists to
   * apply is «من قال لا مرّتين قال لا», and it was applying it to one order
   * rather than to one customer's answer.
   */
  if (order.replacesOrderNumber) {
    return {
      eligible: false,
      code: 'ALREADY_A_SECOND_CHANCE',
      reason: `هذا نفسه محاولةُ استرجاعٍ لـ${order.replacesOrderNumber} ورُفض — ومن قال لا مرّتين قال لا`,
    };
  }

  const reason = order.rejectionReason;
  // The four nobody may turn on are refused HERE too, not only by the editor and the reader of the stored rule:
  // a rule built by hand, or stored before a reason was classified, still cannot ring somebody who has the parcel.
  const neverCalled = !!reason && (NEVER_WINBACK_REASONS as readonly string[]).includes(reason);
  // A return is not gated by the rule's reasons — the courier's feed records none, so gating it would show
  // nothing — but a return whose order was once marked a duplicate, a wrong number, a fake or an entry error
  // has nobody to ring after it came back either.
  if (back ? neverCalled : !reason || neverCalled || !winbackCodes(rule.reasons).includes(reason)) {
    return {
      eligible: false,
      code: 'REASON_NOT_WINBACK',
      reason: reason ? (NOT_WINBACK_AR[reason] ?? 'سببُ الإلغاء لا يُعاد عليه') : 'أُلغي بلا سببٍ مُسجَّل',
    };
  }

  // The moment it was lost: the last loss in the log, or — for a parcel that came back — the desk's receipt.
  const closed = asDate(back ? (order.returnReceivedAt ?? null) : order.rejectedAt);
  if (!closed) {
    return { eligible: false, code: 'NO_DATE', reason: 'لا تاريخَ لإلغائه — لا يمكن حساب المهلة' };
  }

  // Too old to be worth a call. The list has always read this far back and no
  // further; the OFFER now refuses the same, so a request that names an order
  // the screen would never have listed is turned away alike. By when the ORDER
  // was made, for both kinds: a parcel ordered five months ago that came back
  // yesterday is as old as its order, exactly as a cancellation is.
  const made = asDate(order.createdAt ?? null);
  if (made && now.getTime() - made.getTime() > rule.lookbackDays * 86_400_000) {
    return { eligible: false, code: 'TOO_OLD', reason: `أقدم من ${rule.lookbackDays} يوماً — فات وقتُ الاتصال` };
  }

  const dueAt = new Date(closed.getTime() + rule.coolingDays * 86_400_000);
  if (now.getTime() < dueAt.getTime()) {
    return {
      eligible: false,
      code: 'COOLING',
      reason: `ما زال في مهلة الـ${rule.coolingDays} يوماً`,
      dueAt,
    };
  }

  return { eligible: true, dueAt, maxDiscount: maxWinbackDiscount(order, rule.maxDiscountShare) };
}

/**
 * THE CEILING, AND IT COUNTS WHAT WAS ALREADY GIVEN.
 *
 * An order that was rejected at «السعر مرتفع» after five had already come
 * off the price does not get a fresh quarter on top: the discount the
 * customer is offered is the whole of it, not the second helping. Without
 * this an order could be discounted twice over by two people who each
 * thought they were within the rule.
 */
export function maxWinbackDiscount(
  order: Pick<WinbackSource, 'sellingPrice' | 'discountAmount'>,
  share: number = DEFAULT_WINBACK_RULE.maxDiscountShare
): number {
  const ceiling = (order.sellingPrice || 0) * share;
  return round2(Math.max(0, ceiling - (order.discountAmount || 0)));
}
