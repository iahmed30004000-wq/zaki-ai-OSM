import { describe, expect, it } from 'vitest';
import { REJECTION_REASONS } from './confirmation-workflow';
import { repoFile, stripComments } from './guard-source';
import {
  AFTER_SHIPPING_AR,
  DEFAULT_WINBACK_RULE,
  maxWinbackDiscount,
  NEVER_WINBACK_REASONS,
  NOT_WINBACK_AR,
  returnLabel,
  returnedAfterShipping,
  WINBACK_COOLING_DAYS,
  WINBACK_MAX_DISCOUNT_SHARE,
  WINBACK_REASONS,
  winbackVerdict,
  type WinbackSource,
} from './winback';

/**
 * ASKING A SECOND TIME — AND KNOWING WHOM NOT TO ASK.
 *
 * Some orders are lost for a reason that stops being true: a price is
 * answered by a discount, a change of mind by time, three unanswered calls
 * by the fact that we never reached anybody. Most are not, and ringing
 * those is worse than leaving them alone — a duplicate means the customer
 * already has the goods, a refusal is an answer, and a wrong number reaches
 * nobody the second time either.
 *
 * So the rule is spelled out reason by reason rather than as a subtraction,
 * and the guard below fails when a reason is added to the vocabulary and
 * nobody decides which side of it that reason is on.
 */

const route = () => stripComments(repoFile('src/app/api/confirmation/winback/route.ts'));
const screen = () => stripComments(repoFile('src/components/screens/WinbackScreen.tsx'));

const DAY = 86_400_000;
const NOW = new Date('2026-09-27T09:00:00.000Z');
const long = new Date(NOW.getTime() - 40 * DAY);

const base: WinbackSource = {
  confirmationStatus: 'REJECTED',
  rejectionReason: 'PRICE_TOO_HIGH',
  rejectedAt: long,
  shippedAt: null,
  replacedByOrderNumber: null,
  replacesOrderNumber: null,
  sellingPrice: 100,
  discountAmount: 0,
};

describe('every rejection reason is decided, one way or the other', () => {
  /**
   * The one that matters most. A reason added to `REJECTION_REASONS` with no
   * entry on either list would silently fall to «لا يُعاد عليه» with the
   * generic sentence — a rule nobody chose, applied to real customers.
   */
  it('and none falls through unnamed', () => {
    for (const r of REJECTION_REASONS) {
      const winnable = (WINBACK_REASONS as readonly string[]).includes(r);
      if (winnable) {
        expect(NOT_WINBACK_AR[r], `${r} على القائمتين معاً`).toBeUndefined();
      } else {
        expect(NOT_WINBACK_AR[r], `${r} مستبعَدٌ بلا سببٍ مكتوب`).toBeTruthy();
      }
    }
  });

  /** Exactly the four the request named, refused for the reasons it gave. */
  it('excludes the duplicate, the refusal, the bad data and the uncovered area', () => {
    for (const r of [
      'DUPLICATE_ORDER',
      'CUSTOMER_DOES_NOT_WANT_PRODUCT',
      'WRONG_NUMBER',
      'FAKE_ORDER',
      'MODERATOR_DATA_ERROR',
      'OUT_OF_SERVICE_AREA',
      'OTHER',
    ]) {
      expect(WINBACK_REASONS, `${r} يُعاد عليه`).not.toContain(r);
      const v = winbackVerdict({ ...base, rejectionReason: r }, NOW);
      expect(v.eligible).toBe(false);
      if (!v.eligible) expect(v.code).toBe('REASON_NOT_WINBACK');
    }
  });

  it('and keeps the ones that time or a price answers', () => {
    // Listed rather than counted, so a reason gained or lost is read here
    // as a decision. «وجدها أرخص عند غيرنا» joined them as the most
    // winnable of all: he wants the product and said so, and the only
    // thing between him and it is a number we control.
    expect(WINBACK_REASONS).toEqual([
      'PRICE_TOO_HIGH',
      'FOUND_CHEAPER_ELSEWHERE',
      'CUSTOMER_CHANGED_MIND',
      'NO_ANSWER_3_ATTEMPTS',
    ]);
    for (const r of WINBACK_REASONS) {
      expect(winbackVerdict({ ...base, rejectionReason: r }, NOW).eligible, r).toBe(true);
    }
  });
});

describe('both words for an order that did not happen', () => {
  /**
   * An order ends REJECTED when the agent records the customer's no, and
   * CANCELLED when a manager cancels it or the no-answer rule closes it.
   * The screen read the first word only, so everything cancelled the
   * second way was invisible on the one screen built to find it —
   * reported as «الإلغاء لا يظهر في استرجاع الملغي». Measured at the
   * time: three orders missing, one of them closed for no answer, which
   * is among the most winnable reasons there is.
   */
  it('a cancelled order is as reachable as a rejected one', () => {
    for (const confirmationStatus of ['REJECTED', 'CANCELLED']) {
      const v = winbackVerdict({ ...base, confirmationStatus }, NOW);
      expect(v.eligible, confirmationStatus).toBe(true);
    }
  });

  it('and the listing asks for both, not for one', () => {
    // 21/10: the question moved from the route into the query (`winback-filters.ts`), so the pin moved with it.
    const route = stripComments(repoFile('src/app/api/confirmation/winback/route.ts'));
    const filters = stripComments(repoFile('src/lib/winback-filters.ts'));
    expect(filters).toMatch(/confirmationStatus: \{ in: \[\.\.\.LOST_STATUSES\] \}/);
    expect(route, 'ما زال يقرأ كلمةً واحدة').not.toMatch(/confirmationStatus: 'REJECTED'/);
    expect(filters, 'ما زال يقرأ كلمةً واحدة').not.toMatch(/confirmationStatus: 'REJECTED'/);
    // …and the closing date still comes from a log row of EITHER word.
    expect(route).toMatch(/newValue: \{ in: \[\.\.\.LOST_STATUSES\] \}/);
    expect(filters).toMatch(/newValue: \{ in: \[\.\.\.LOST_STATUSES\] \}/);
  });
});

describe('and the other four gates', () => {
  it('refuses one that is not rejected at all', () => {
    const v = winbackVerdict({ ...base, confirmationStatus: 'CONFIRMED' }, NOW);
    expect(v.eligible).toBe(false);
    if (!v.eligible) expect(v.code).toBe('NOT_REJECTED');
  });

  /**
   * REWRITTEN ON 28/10, DELIBERATELY. This read «A parcel that went out and came
   * back is a return, with its own bill» and asserted that ANY shipped order was
   * refused — the argument the owner overruled («قبل الشحن وبعد»). What is still
   * refused is a parcel that left and is not back: on the road, or with the
   * customer in whole or in part. A caller that does not say where the parcel is
   * gets that refusal too, which is what every caller got before.
   */
  it('refuses one that shipped and is not back — wherever it is, and whatever it was', () => {
    for (const shippingStatus of [undefined, 'SHIPPED', 'OUT_FOR_DELIVERY', 'FAILED_DELIVERY', 'RETURN_REQUESTED', 'DELIVERED', 'PARTIALLY_DELIVERED']) {
      const v = winbackVerdict({ ...base, shippedAt: new Date('2026-09-01'), shippingStatus }, NOW);
      expect(v.eligible, `يعرض خصماً على طردٍ لم يرجع (${shippingStatus})`).toBe(false);
      if (!v.eligible) {
        expect(v.code, String(shippingStatus)).toBe('ALREADY_SHIPPED');
        expect(v.reason).toBe('شُحن ولم يرجع إلينا — ما زال عند شركة الشحن أو عند العميل');
      }
    }
  });

  /**
   * ONE SECOND CHANCE, NOT A CHAIN.
   *
   * The database stops the ORIGINAL being offered twice — `replacesOrderId`
   * is unique — and says nothing about the replacement. So A was won back as
   * B, B was rejected, and fourteen days later B looked like an ordinary
   * lost sale: offered again, cheaper, to a customer who had now said no
   * three times. The rule is «من قال لا مرّتين قال لا», and it was being
   * applied to one order rather than to one customer's answer.
   */
  it('refuses one that is itself a second chance', () => {
    const v = winbackVerdict({ ...base, replacesOrderNumber: 'SY-0007' }, NOW);
    expect(v.eligible, 'سلسلةُ خصوماتٍ بلا نهاية').toBe(false);
    if (!v.eligible) {
      expect(v.code).toBe('ALREADY_A_SECOND_CHANCE');
      expect(v.reason).toContain('SY-0007');
    }
  });

  /** Somebody who said no twice has answered twice. */
  it('refuses one already offered, and names the order that was raised', () => {
    const v = winbackVerdict({ ...base, replacedByOrderNumber: 'SY-0099' }, NOW);
    expect(v.eligible).toBe(false);
    if (!v.eligible) {
      expect(v.code).toBe('ALREADY_OFFERED');
      expect(v.reason).toContain('SY-0099');
    }
  });

  /**
   * THE COOLING PERIOD, AND ITS EDGE.
   *
   * Rung back on Thursday about Tuesday's no, the customer has been
   * pestered rather than won back.
   */
  it('refuses one still inside the cooling period, and says when it is due', () => {
    const fresh = new Date(NOW.getTime() - 3 * DAY);
    const v = winbackVerdict({ ...base, rejectedAt: fresh }, NOW);
    expect(v.eligible).toBe(false);
    if (!v.eligible) {
      expect(v.code).toBe('COOLING');
      expect(v.dueAt?.getTime()).toBe(fresh.getTime() + WINBACK_COOLING_DAYS * DAY);
    }
  });

  it('and allows it the moment the period is up, not a day later', () => {
    const exactly = new Date(NOW.getTime() - WINBACK_COOLING_DAYS * DAY);
    expect(winbackVerdict({ ...base, rejectedAt: exactly }, NOW).eligible).toBe(true);
    const oneShort = new Date(NOW.getTime() - WINBACK_COOLING_DAYS * DAY + 1000);
    expect(winbackVerdict({ ...base, rejectedAt: oneShort }, NOW).eligible).toBe(false);
  });

  it('refuses one with no rejection date rather than guessing', () => {
    const v = winbackVerdict({ ...base, rejectedAt: null }, NOW);
    expect(v.eligible).toBe(false);
    if (!v.eligible) expect(v.code).toBe('NO_DATE');
  });
});

/**
 * «هل بيعرض الملغي قبل الشحن وبعد ؟ اذا اه تمام اذا لأ خليه يجري ع ال 2» — 28/10.
 *
 * It did not. A parcel that shipped and came back is a lost sale too now, under
 * the same rule — and only when it is BACK: RETURNED, and received by the desk.
 * The order a refused parcel leaves behind is CONFIRMED, with no rejection reason
 * (the courier records none), so that is the fixture, not a lost one dressed up.
 */
describe('and after it shipped — a parcel that came back', () => {
  const SHIPPED = new Date(NOW.getTime() - 50 * DAY);
  const returned: WinbackSource = {
    confirmationStatus: 'CONFIRMED',
    rejectionReason: null,
    rejectedAt: null,
    shippedAt: SHIPPED,
    shippingStatus: 'RETURNED',
    returnReceivedAt: long,
    replacedByOrderNumber: null,
    replacesOrderNumber: null,
    sellingPrice: 100,
    discountAmount: 0,
    createdAt: new Date(NOW.getTime() - 60 * DAY),
  };
  const code = (v: ReturnType<typeof winbackVerdict>) => (v.eligible ? 'ELIGIBLE' : v.code);

  it('— back, received and cooled: eligible, with the ceiling a lost order of the same price gets', () => {
    const v = winbackVerdict(returned, NOW);
    expect(v.eligible, 'المرتجع المستلَم لا يُعرض').toBe(true);
    if (v.eligible) {
      expect(v.maxDiscount).toBe(25);
      expect(v.maxDiscount).toBe(maxWinbackDiscount(returned));
      const lost = winbackVerdict(base, NOW);
      expect(lost.eligible && lost.maxDiscount).toBe(v.maxDiscount);
    }
    // The discount already given still counts against it, as it does for a cancellation.
    const discounted = winbackVerdict({ ...returned, sellingPrice: 80, discountAmount: 5 }, NOW);
    expect(discounted.eligible && discounted.maxDiscount).toBe(15);
  });

  it('and whatever the confirmation said of it — a CONFIRMED parcel refused at the door, or one marked lost after it left', () => {
    for (const confirmationStatus of ['CONFIRMED', 'REJECTED', 'CANCELLED']) {
      expect(code(winbackVerdict({ ...returned, confirmationStatus }, NOW)), confirmationStatus).toBe('ELIGIBLE');
    }
  });

  it('and the rule’s reasons do not gate it: no reason, or one the rule does not list, is still called', () => {
    expect(code(winbackVerdict({ ...returned, rejectionReason: null }, NOW))).toBe('ELIGIBLE');
    expect(code(winbackVerdict({ ...returned, rejectionReason: 'OTHER' }, NOW))).toBe('ELIGIBLE');
    expect(code(winbackVerdict({ ...returned, rejectionReason: 'CUSTOMER_DOES_NOT_WANT_PRODUCT' }, NOW))).toBe('ELIGIBLE');
    // …even under a rule that lists only one reason — and the same order lost BEFORE shipping is refused by it.
    const narrow = { ...DEFAULT_WINBACK_RULE, reasons: ['PRICE_TOO_HIGH'] };
    expect(code(winbackVerdict({ ...returned, rejectionReason: 'OTHER' }, NOW, narrow))).toBe('ELIGIBLE');
    expect(code(winbackVerdict({ ...base, rejectionReason: 'OTHER' }, NOW, narrow))).toBe('REASON_NOT_WINBACK');
  });

  it.each([...NEVER_WINBACK_REASONS])('but «%s» is refused after it came back too — there is still nobody to ring', (reason) => {
    const v = winbackVerdict({ ...returned, rejectionReason: reason }, NOW);
    expect(code(v)).toBe('REASON_NOT_WINBACK');
    if (!v.eligible) expect(v.reason).toBe(NOT_WINBACK_AR[reason]);
  });

  it('and a duplicate in particular, in its own words', () => {
    const v = winbackVerdict({ ...returned, rejectionReason: 'DUPLICATE_ORDER' }, NOW);
    expect(!v.eligible && v.reason).toBe('مكرَّر — البضاعة عنده أصلاً');
  });

  it('— NOT received: waiting at the desk, or written off as a loss, is refused with words that say so', () => {
    for (const confirmationStatus of ['CONFIRMED', 'REJECTED']) {
      const v = winbackVerdict({ ...returned, confirmationStatus, returnReceivedAt: null }, NOW);
      expect(code(v), confirmationStatus).toBe('RETURN_NOT_RECEIVED');
      if (!v.eligible) {
        expect(v.reason).toContain('لم يستلمه المستودع');
        expect(v.reason).toContain('أُغلق كخسارة');
      }
    }
    // A missing date is no date: the field left out is not a receipt either.
    expect(code(winbackVerdict({ ...returned, returnReceivedAt: undefined }, NOW))).toBe('RETURN_NOT_RECEIVED');
    expect(code(winbackVerdict({ ...returned, returnReceivedAt: 'not a date' }, NOW))).toBe('RETURN_NOT_RECEIVED');
  });

  it('— a receipt that says NOTHING CAME BACK (a write-off, a zero count) is refused though it carries a date', () => {
    const v = winbackVerdict({ ...returned, returnNothingCameBack: true }, NOW);
    expect(code(v)).toBe('RETURN_NOT_RECEIVED');
    // NEGATIVE: the same order with a receipt that holds units, or with the flag absent, is still called.
    expect(code(winbackVerdict({ ...returned, returnNothingCameBack: false }, NOW))).toBe('ELIGIBLE');
    expect(code(winbackVerdict({ ...returned }, NOW))).toBe('ELIGIBLE');
  });

  /**
   * NOT BACK. A partial delivery carries a receipt — the refused units are counted in — and stays
   * PARTIALLY_DELIVERED: he took part of it. FAILED_DELIVERY and RETURN_REQUESTED may yet be delivered.
   * Each is refused WITH a receipt beside it, so the receipt alone is shown not to be what lets one in.
   */
  it.each(['FAILED_DELIVERY', 'RETURN_REQUESTED', 'PARTIALLY_DELIVERED', 'DELIVERED', 'SHIPPED', 'OUT_FOR_DELIVERY'])(
    '— %s, even with a receipt, is not back: refused',
    (shippingStatus) => {
      for (const confirmationStatus of ['REJECTED', 'CANCELLED']) {
        expect(code(winbackVerdict({ ...returned, confirmationStatus, shippingStatus }, NOW)), confirmationStatus).toBe('ALREADY_SHIPPED');
      }
      // And one that was never lost at confirmation is no lost order at all.
      expect(code(winbackVerdict({ ...returned, shippingStatus }, NOW))).toBe('NOT_REJECTED');
    }
  );

  it('— the owner’s switch off: refused, in his words, and the same order back on when it is on', () => {
    const off = { ...DEFAULT_WINBACK_RULE, afterShipping: false };
    const v = winbackVerdict(returned, NOW, off);
    expect(code(v)).toBe('AFTER_SHIPPING_OFF');
    expect(!v.eligible && v.reason).toBe('المرتجع بعد الشحن غير مشمول في القاعدة');
    expect(code(winbackVerdict(returned, NOW, { ...off, afterShipping: true }))).toBe('ELIGIBLE');
    // And the switch touches nothing before shipping.
    expect(code(winbackVerdict(base, NOW, off))).toBe('ELIGIBLE');
  });

  it('— already offered, or itself a second chance: refused as before', () => {
    expect(code(winbackVerdict({ ...returned, replacedByOrderNumber: 'SY-0099' }, NOW))).toBe('ALREADY_OFFERED');
    expect(code(winbackVerdict({ ...returned, replacesOrderNumber: 'SY-0007' }, NOW))).toBe('ALREADY_A_SECOND_CHANCE');
  });

  /**
   * A COURIER-TRANSFER REPLACEMENT THAT CAME BACK is refused here as «itself a second chance». It is not one —
   * it is the first sale, re-shipped — but `createReplacement` leaves nothing on the row that tells it from a
   * win-back: both are linked by `replacesOrderId` alone. Pinned as it stands, and listed as outside this change.
   */
  it('— and a transfer replacement that came back cannot be told from a win-back one, so it is refused alike', () => {
    expect(code(winbackVerdict({ ...returned, replacesOrderNumber: 'SY-0007' }, NOW))).toBe('ALREADY_A_SECOND_CHANCE');
  });

  it('— too old: made before the look-back, returned yesterday — by when the ORDER was made, as a cancellation is', () => {
    const v = winbackVerdict(
      { ...returned, createdAt: new Date(NOW.getTime() - 121 * DAY), returnReceivedAt: new Date(NOW.getTime() - DAY) },
      NOW
    );
    expect(code(v)).toBe('TOO_OLD');
  });

  it('— the cooling counts from the RECEIPT, on the same strict line: exactly fourteen days is due, a second short is not', () => {
    const exactly = new Date(NOW.getTime() - WINBACK_COOLING_DAYS * DAY);
    expect(code(winbackVerdict({ ...returned, returnReceivedAt: exactly }, NOW))).toBe('ELIGIBLE');
    const short = new Date(exactly.getTime() + 1000);
    const v = winbackVerdict({ ...returned, returnReceivedAt: short }, NOW);
    expect(code(v)).toBe('COOLING');
    if (!v.eligible) {
      expect(v.dueAt?.getTime()).toBe(short.getTime() + WINBACK_COOLING_DAYS * DAY);
      expect(v.reason).toBe(`ما زال في مهلة الـ${WINBACK_COOLING_DAYS} يوماً`);
    }
  });

  it('and NOT from the day it shipped, nor from an old loss in the log', () => {
    const fresh = new Date(NOW.getTime() - 3 * DAY);
    const v = winbackVerdict({ ...returned, shippedAt: new Date(NOW.getTime() - 40 * DAY), rejectedAt: long, returnReceivedAt: fresh }, NOW);
    expect(code(v)).toBe('COOLING');
    if (!v.eligible) expect(v.dueAt?.getTime()).toBe(fresh.getTime() + WINBACK_COOLING_DAYS * DAY);
  });

  it('— and a parcel RETURNED that never left (cancelled at the pickup) is read as before shipping, as it always was', () => {
    expect(returnedAfterShipping({ shippedAt: null, shippingStatus: 'RETURNED' })).toBe(false);
    expect(code(winbackVerdict({ ...base, shippingStatus: 'RETURNED', returnReceivedAt: long }, NOW))).toBe('ELIGIBLE');
    expect(code(winbackVerdict({ ...base, shippingStatus: 'RETURNED', rejectionReason: 'OTHER' }, NOW))).toBe('REASON_NOT_WINBACK');
    expect(code(winbackVerdict({ ...returned, shippedAt: null }, NOW))).toBe('NOT_REJECTED');
  });
});

describe('a parcel that came back is named in words', () => {
  it('— the return’s own reason, from the labels the shipping screens use', () => {
    expect(AFTER_SHIPPING_AR).toBe('مرتجع بعد الشحن');
    expect(returnLabel({ returnReason: 'CUSTOMER_REFUSED' })).toBe('مرتجع بعد الشحن — العميل رفض');
    expect(returnLabel({ returnReason: 'DAMAGED_PRODUCT', deliveryFailureReason: 'PHONE_UNREACHABLE' })).toBe('مرتجع بعد الشحن — منتج تالف');
  });

  it('and why the delivery failed, when the return itself says nothing', () => {
    expect(returnLabel({ returnReason: null, deliveryFailureReason: 'PHONE_UNREACHABLE' })).toBe('مرتجع بعد الشحن — الهاتف لا يرد');
  });

  it('and never the prose a write-off or a transfer typed, never a code nobody labelled — just the return', () => {
    for (const prose of ['أُغلق كخسارة — لم تُستلم البضاعة. ضاع عند المندوب', 'سحب من أرامكس وإصدار طلب بديل لـ سمسا', 'SOMETHING_NEW', 'constructor', '__proto__']) {
      expect(returnLabel({ returnReason: prose }), prose).toBe('مرتجع بعد الشحن');
    }
    expect(returnLabel({})).toBe('مرتجع بعد الشحن');
  });
});

describe('the discount has a ceiling, and it counts what was already given', () => {
  it('a quarter of the price', () => {
    expect(WINBACK_MAX_DISCOUNT_SHARE).toBe(0.25);
    expect(maxWinbackDiscount({ sellingPrice: 100, discountAmount: 0 })).toBe(25);
  });

  /**
   * Otherwise an order discounted by five before rejection could take a
   * fresh quarter on top, and two people each keeping to the rule would
   * give away a third of the price between them.
   */
  it('less whatever came off before', () => {
    expect(maxWinbackDiscount({ sellingPrice: 100, discountAmount: 10 }), 'الخصمُ السابق لم يُحسب').toBe(15);
    expect(maxWinbackDiscount({ sellingPrice: 100, discountAmount: 40 }), 'سقفٌ سالب').toBe(0);
  });

  it('and the verdict carries it, so the screen never offers more', () => {
    const v = winbackVerdict({ ...base, sellingPrice: 80, discountAmount: 5 }, NOW);
    expect(v.eligible).toBe(true);
    if (v.eligible) expect(v.maxDiscount).toBe(15);
  });
});

describe('the offer raises a new order and leaves the loss where it is', () => {
  /**
   * Reviving the rejected order is the shorter code and the wrong record:
   * every report that reads `confirmationStatus` would show fewer
   * rejections the harder we worked at winning them back.
   */
  it('creates rather than revives', () => {
    const src = route();
    expect(src).toContain('tx.order.create');
    expect(src).toContain('replacesOrderId: order.id');
    expect(src, 'أعاد الملغى إلى الحياة فمحا الخسارة').not.toMatch(
      /order\.update\([\s\S]{0,300}confirmationStatus: 'NEW'/
    );
  });

  it('and the new one lands in the ordinary pool, held by nobody', () => {
    const src = route();
    expect(src).toContain("confirmationStatus: 'NEW'");
    expect(src).toContain("shippingStatus: 'NOT_READY'");
    // No second queue: nothing here claims it for anyone.
    expect(src).not.toContain('claimedById:');
  });

  /** `replacesOrderId` is `@unique`, so the database refuses the second offer. */
  it('once only, and the database is what enforces it', () => {
    expect(stripComments(repoFile('prisma/schema.prisma'))).toMatch(
      /replacesOrderId\s+String\?\s+@unique/
    );
  });

  /** And both doors have to load the link, or the guard reads null for ever. */
  it('and both the list and the offer read whether it is already one', () => {
    const src = route();
    expect((src.match(/replaces: \{ select: \{ orderNumber: true \} \}/g) ?? []).length).toBe(2);
    expect((src.match(/replacesOrderNumber:/g) ?? []).length).toBe(2);
  });

  /**
   * And both doors read where the parcel is and whether the desk has it — or a parcel that came back reads as
   * «not back» for ever in one of them, and the list offers what the button refuses (or the reverse).
   */
  it('and both read the parcel’s state and its receipt, the one the verdict cools a return from', () => {
    const src = route();
    const at = src.indexOf('export async function POST');
    // Each half on its own: the whole file passing with one of them missing is how a door goes blind.
    for (const [half, body] of [['القائمة', src.slice(0, at)], ['العرض', src.slice(at)]] as const) {
      expect(body, `${half}: لا يقرأ الاستلام`).toContain('returnReceipt: { select: { inspectedAt: true, receivedQty: true, damagedQty: true, missingQty: true } }');
      expect(body, `${half}: لا يمرّر حالة الشحن`).toMatch(/shippingStatus: o(?:rder)?\.shippingStatus,/);
      // (the day is passed only when something came back; a receipt that says nothing did is not a return received)
      expect(body, `${half}: لا يمرّر يوم الاستلام`).toMatch(/returnReceivedAt: o(?:rder)?\.returnReceipt && !nothingCameBack/);
      expect(body, `${half}: لا يمرّر أنّ الإيصال يقول لم يصل شيء`).toMatch(/returnNothingCameBack: o(?:rder)?\.returnReceipt \? nothingCameBack/);
    }
  });

  /** A row eligible when the screen loaded may not be when the button lands. */
  it('re-takes the whole verdict on the server before writing', () => {
    const post = route().slice(route().indexOf('export async function POST'));
    expect(post, 'يثق بما قرّرته الشاشة').toMatch(/if \(!verdict\.eligible\) \{/);
    expect(post).toMatch(/if \(discount > ceiling\) \{/);
    expect(post).toContain('DISCOUNT_TOO_LARGE');
  });

  /**
   * THE REJECTION DATE COMES FROM THE STATUS LOG.
   *
   * The order carries no rejection timestamp, and `updatedAt` is not one: a
   * note added yesterday would reset the customer's cooling period to
   * yesterday and hide them for another fortnight.
   *
   * AND BY BOTH WORDS FOR THE CLOSING. This guard used to spell the lookup
   * out as `newValue: 'REJECTED'`, which is how it came to certify the bug it
   * was written to prevent: `LOST_STATUSES` had been widened to REJECTED and
   * CANCELLED so the no-answer rule's closures could be reached, the listing's
   * lookup was not, and every cancelled order arrived with no date and the
   * verdict NO_DATE — a state with no way out. The guard passed throughout.
   * It now names the rule instead of one of its two values.
   */
  it('and reads when it was closed from the log, by both words, not from updatedAt', () => {
    const src = route();
    expect(src).toContain("statusType: 'CONFIRMATION'");
    const lookups = [...src.matchAll(/newValue:\s*([^,\n]+)/g)].map((m) => m[1].trim());
    expect(lookups.length, 'لا قراءةَ لسجلّ الحالة').toBeGreaterThanOrEqual(2);
    for (const lookup of lookups) {
      expect(lookup, 'قراءةٌ بكلمةٍ واحدةٍ من كلمتَي الإلغاء').toContain('LOST_STATUSES');
    }
    expect(src, 'اعتمد على updatedAt').not.toContain('updatedAt');
  });

  it('is money, so it is gated and written down', () => {
    const src = route();
    // BOTH HALVES, separately. The permission is written twice — once to
    // list and once to offer — so reading the whole file passed with either
    // one deleted, which is how the first version of this guard let the
    // offer itself go ungated.
    const at = src.indexOf('export async function POST');
    const list = src.slice(0, at);
    const post = src.slice(at);
    expect(list, 'القائمة مفتوحة').toContain("requirePermission('confirmation.supervise')");
    expect(post, 'العرض مفتوح لأيّ موظّف').toContain("requirePermission('confirmation.supervise')");
    expect(post).toContain("action: 'WINBACK_OFFERED'");
    expect(post).toContain('orderNote.create');
  });
});

describe('and the screen teaches the rule instead of hiding it', () => {
  /**
   * A supervisor who remembers rejecting an order and cannot find it here
   * concludes the screen is broken, not that the rule excluded it.
   */
  it('shows the refused ones with the reason, as a view of their own', () => {
    // 21/10: «behind a switch» became «a view»: the refused are a page of their own (paged, filterable,
    // searchable like the work), and every card says in words WHICH rule put it there.
    const src = screen();
    expect(src).toContain('VIEW_AR');
    expect(src).toContain('r.verdict.reason');
    expect(route()).toContain('winbackFilters(params');
    expect(route(), 'عاد المفتاح القديم').not.toContain("searchParams.get('all') === '1'");
    // The default view is the work, not the lecture.
    expect(stripComments(repoFile('src/lib/winback-filters.ts'))).toContain("export const DEFAULT_VIEW: View = 'ready';");
  });

  it('and never offers more than the ceiling the server sent', () => {
    const src = screen();
    expect(src).toMatch(/const max = r\.verdict\.maxDiscount;/);
    expect(src, 'الشاشة تقبل أيّ رقم').toMatch(/discount > max/);
  });

  it('borrows its heading from the registry, like every other screen — and inside «المتابعة» the page carries it', () => {
    expect(screen()).toContain('<ScreenTitle');
    expect(screen(), 'عنوانٌ مكتوبٌ في الشاشة يخالف القائمة').not.toMatch(/ScreenTitle[\s\S]{0,80}title=/);
    // The screen is a tab of «المتابعة» now: its address is the page's, and `embedded`
    // keeps it from drawing a second title under the page's own.
    expect(stripComments(repoFile('src/lib/route-registry.ts'))).toContain("r('/confirmation/follow-up'");
    expect(screen()).toMatch(/embedded \? \(/);
  });

  it('and says why it is empty when it is', () => {
    expect(screen()).toContain('<EmptyState');
    expect(screen()).toContain('لا طلبَ جاهزاً لمحاولةٍ ثانية');
  });
});
