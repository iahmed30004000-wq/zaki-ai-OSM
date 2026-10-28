import { describe, expect, it } from 'vitest';
import { REJECTION_REASONS, REJECTION_REASON_AR } from './confirmation-workflow';
import {
  DEFAULT_WINBACK_RULE,
  NEVER_WINBACK_REASONS,
  OPTIONAL_WINBACK_REASONS,
  SELECTABLE_WINBACK_REASONS,
  WINBACK_BOUNDS,
  WINBACK_COOLING_DAYS,
  WINBACK_LOOKBACK_DAYS,
  WINBACK_MAX_DISCOUNT_SHARE,
  WINBACK_REASONS,
  maxWinbackDiscount,
  parseWinbackRule,
  ruleSentence,
  validateWinbackRule,
  winbackVerdict,
  type WinbackRule,
  type WinbackSource,
} from './winback';

/**
 * «شو القاعدة تبعو لاني ممكن اعدلها» — THE RULE AS A VALUE, AND ITS EDGES.
 *
 * Four numbers lived in the code with a reason beside each. They are a rule the
 * owner may edit now, and what is held here is every edge of that:
 *
 *   • the defaults ARE the old constants, so an owner who never opens the
 *     editor sees nothing change — held by running the verdict both ways;
 *   • each thing he may turn changes exactly what it says, at its boundary;
 *   • each thing he may NOT turn stays shut whatever is stored or typed;
 *   • a typed rule is refused with a sentence, a stored one is read leniently.
 */

const NOW = new Date('2026-10-21T12:00:00.000Z');
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

/** An order that is eligible under the defaults: rejected at «السعر مرتفع» a month ago, never shipped, never offered. */
const base: WinbackSource = {
  confirmationStatus: 'REJECTED',
  rejectionReason: 'PRICE_TOO_HIGH',
  rejectedAt: ago(30),
  shippedAt: null,
  replacedByOrderNumber: null,
  replacesOrderNumber: null,
  sellingPrice: 100,
  discountAmount: 0,
};

const rule = (over: Partial<WinbackRule> = {}): WinbackRule => ({ ...DEFAULT_WINBACK_RULE, ...over });
const verdict = (over: Partial<WinbackSource>, r?: WinbackRule) => winbackVerdict({ ...base, ...over }, NOW, r);
const code = (v: ReturnType<typeof winbackVerdict>) => (v.eligible ? 'ELIGIBLE' : v.code);

describe('the defaults are the old constants', () => {
  /**
   * REWRITTEN ON 28/10: the defaults gained ONE key, `afterShipping: true` — the owner asked for the
   * lost orders «قبل الشحن وبعد», so the shop that never opens the editor gets both. Every number is
   * the constant it was.
   */
  it('— fourteen days, a hundred and twenty back, a quarter of the price, the four reasons, and returns after shipping', () => {
    expect(DEFAULT_WINBACK_RULE).toEqual({
      reasons: ['PRICE_TOO_HIGH', 'FOUND_CHEAPER_ELSEWHERE', 'CUSTOMER_CHANGED_MIND', 'NO_ANSWER_3_ATTEMPTS'],
      afterShipping: true,
      coolingDays: 14,
      lookbackDays: 120,
      maxDiscountShare: 0.25,
    });
    expect([WINBACK_COOLING_DAYS, WINBACK_LOOKBACK_DAYS, WINBACK_MAX_DISCOUNT_SHARE]).toEqual([14, 120, 0.25]);
    expect(DEFAULT_WINBACK_RULE.reasons).toEqual([...WINBACK_REASONS]);
  });

  it('and the verdict with no rule is the verdict with the default one, for every kind of order', () => {
    const cases: Partial<WinbackSource>[] = [
      {},
      { confirmationStatus: 'CONFIRMED' },
      { shippedAt: ago(40) },
      { replacedByOrderNumber: 'ORD-9' },
      { replacesOrderNumber: 'ORD-1' },
      { rejectionReason: null },
      { rejectionReason: 'DUPLICATE_ORDER' },
      { rejectionReason: 'OTHER' },
      { rejectionReason: 'CUSTOMER_DOES_NOT_WANT_PRODUCT' },
      { rejectedAt: null },
      { rejectedAt: ago(13) },
      { rejectedAt: ago(14) },
      { discountAmount: 20 },
      { discountAmount: 40 },
      // A parcel that came back: received, not received, still cooling from its receipt, not back at all.
      { confirmationStatus: 'CONFIRMED', shippedAt: ago(50), shippingStatus: 'RETURNED', returnReceivedAt: ago(30) },
      { confirmationStatus: 'CONFIRMED', shippedAt: ago(50), shippingStatus: 'RETURNED', returnReceivedAt: null },
      { confirmationStatus: 'CONFIRMED', shippedAt: ago(50), shippingStatus: 'RETURNED', returnReceivedAt: ago(3) },
      { shippedAt: ago(50), shippingStatus: 'PARTIALLY_DELIVERED', returnReceivedAt: ago(30) },
    ];
    for (const c of cases) {
      expect(JSON.stringify(verdict(c, DEFAULT_WINBACK_RULE)), JSON.stringify(c)).toBe(JSON.stringify(verdict(c)));
    }
  });

  it('and the ceiling with no share is a quarter, as it was', () => {
    expect(maxWinbackDiscount({ sellingPrice: 100, discountAmount: 0 })).toBe(25);
    expect(maxWinbackDiscount({ sellingPrice: 100, discountAmount: 10 })).toBe(15);
  });
});

describe('every rejection reason is classified exactly once', () => {
  it('— the four it was built for, the three the owner may choose, the four nobody may: the whole catalogue, with no overlap', () => {
    const all = [...WINBACK_REASONS, ...OPTIONAL_WINBACK_REASONS, ...NEVER_WINBACK_REASONS];
    expect([...all].sort()).toEqual([...REJECTION_REASONS].sort());
    expect(new Set(all).size).toBe(all.length);
    expect(SELECTABLE_WINBACK_REASONS).toHaveLength(7);
    for (const r of NEVER_WINBACK_REASONS) expect(SELECTABLE_WINBACK_REASONS, r).not.toContain(r);
    // A reason added to the workflow tomorrow fails here until somebody decides which kind it is.
    for (const r of REJECTION_REASONS) expect(REJECTION_REASON_AR[r], r).toBeTruthy();
  });
});

describe('the reasons', () => {
  it.each([...WINBACK_REASONS, ...OPTIONAL_WINBACK_REASONS])('— «%s» is called for only while the rule lists it', (reason) => {
    expect(code(verdict({ rejectionReason: reason }, rule({ reasons: [reason] })))).toBe('ELIGIBLE');
    const others = SELECTABLE_WINBACK_REASONS.filter((r) => r !== reason);
    expect(code(verdict({ rejectionReason: reason }, rule({ reasons: others })))).toBe('REASON_NOT_WINBACK');
  });

  it.each([...NEVER_WINBACK_REASONS])('— «%s» is refused whatever the rule says, even a rule built by hand that lists it', (reason) => {
    const v = verdict({ rejectionReason: reason }, rule({ reasons: [reason, ...SELECTABLE_WINBACK_REASONS] }));
    expect(code(v)).toBe('REASON_NOT_WINBACK');
    if (!v.eligible) expect(v.reason.length).toBeGreaterThan(5);
  });

  it('and an order with no reason at all is not called, however wide the rule', () => {
    expect(code(verdict({ rejectionReason: null }, rule({ reasons: SELECTABLE_WINBACK_REASONS })))).toBe('REASON_NOT_WINBACK');
  });

  it('and the other refusals stand whatever reasons are listed — shipped and not back, back and not received, offered, a second chance, not rejected', () => {
    const wide = rule({ reasons: SELECTABLE_WINBACK_REASONS });
    expect(code(verdict({ shippedAt: ago(40) }, wide))).toBe('ALREADY_SHIPPED');
    expect(code(verdict({ shippedAt: ago(40), shippingStatus: 'RETURN_REQUESTED' }, wide))).toBe('ALREADY_SHIPPED');
    expect(code(verdict({ shippedAt: ago(40), shippingStatus: 'RETURNED', returnReceivedAt: null }, wide))).toBe('RETURN_NOT_RECEIVED');
    expect(code(verdict({ replacedByOrderNumber: 'ORD-9' }, wide))).toBe('ALREADY_OFFERED');
    expect(code(verdict({ replacesOrderNumber: 'ORD-1' }, wide))).toBe('ALREADY_A_SECOND_CHANCE');
    expect(code(verdict({ confirmationStatus: 'CONFIRMED' }, wide))).toBe('NOT_REJECTED');
  });
});

describe('the switch «يشمل المرتجع بعد الشحن»', () => {
  const back: Partial<WinbackSource> = { confirmationStatus: 'CONFIRMED', rejectionReason: null, shippedAt: ago(50), shippingStatus: 'RETURNED', returnReceivedAt: ago(30) };

  it('— on, a parcel that came back is called; off, it is refused in words and nothing before shipping moves', () => {
    expect(code(verdict(back, rule({ afterShipping: true })))).toBe('ELIGIBLE');
    expect(code(verdict(back, rule({ afterShipping: false })))).toBe('AFTER_SHIPPING_OFF');
    for (const over of [{}, { rejectedAt: ago(3) }, { rejectionReason: 'OTHER' }, { replacedByOrderNumber: 'ORD-9' }] as Partial<WinbackSource>[]) {
      expect(code(verdict(over, rule({ afterShipping: false }))), JSON.stringify(over)).toBe(code(verdict(over, rule({ afterShipping: true }))));
    }
  });

  it('and everything else in the rule applies to a return alike: the cooling, the look-back, the ceiling', () => {
    expect(code(verdict({ ...back, returnReceivedAt: ago(29) }, rule({ coolingDays: 30 })))).toBe('COOLING');
    expect(code(verdict({ ...back, returnReceivedAt: ago(30) }, rule({ coolingDays: 30 })))).toBe('ELIGIBLE');
    expect(code(verdict({ ...back, createdAt: ago(61) }, rule({ lookbackDays: 60 })))).toBe('TOO_OLD');
    const v = verdict({ ...back, sellingPrice: 100 }, rule({ maxDiscountShare: 0.4 }));
    expect(v.eligible && v.maxDiscount).toBe(40);
  });

  /** Only a real true turns it on: a rule built by hand with no switch is read as off, the refusal every return got before. */
  it('and a hand-built rule without the switch does not let a return in', () => {
    const { afterShipping: _gone, ...noSwitch } = DEFAULT_WINBACK_RULE;
    expect(code(winbackVerdict({ ...base, ...back }, NOW, noSwitch as WinbackRule))).toBe('AFTER_SHIPPING_OFF');
  });
});

describe('the cooling', () => {
  it('— is the rule’s: thirty days means 29 is still cooling, 30 is not, and the sentence says thirty', () => {
    const r = rule({ coolingDays: 30 });
    const v29 = verdict({ rejectedAt: ago(29) }, r);
    expect(code(v29)).toBe('COOLING');
    if (!v29.eligible) expect(v29.reason).toContain('30');
    expect(code(verdict({ rejectedAt: ago(30) }, r))).toBe('ELIGIBLE');
    expect(code(verdict({ rejectedAt: ago(31) }, r))).toBe('ELIGIBLE');
  });

  it('and one day means a day', () => {
    const r = rule({ coolingDays: 1 });
    expect(code(verdict({ rejectedAt: new Date(NOW.getTime() - DAY + 1) }, r))).toBe('COOLING');
    expect(code(verdict({ rejectedAt: new Date(NOW.getTime() - DAY) }, r))).toBe('ELIGIBLE');
  });

  it('and «when it becomes work» follows the rule', () => {
    const v = verdict({ rejectedAt: ago(10) }, rule({ coolingDays: 30 }));
    expect(v.eligible).toBe(false);
    if (!v.eligible) expect(v.dueAt!.getTime()).toBe(ago(10).getTime() + 30 * DAY);
  });
});

describe('the look-back', () => {
  it('— an order made longer ago than the rule reads is too old, and says how many days', () => {
    const r = rule({ lookbackDays: 60 });
    const v = verdict({ createdAt: ago(61) }, r);
    expect(code(v)).toBe('TOO_OLD');
    if (!v.eligible) expect(v.reason).toContain('60');
  });

  it('and exactly the look-back is still read — the list’s own line, `createdAt >= now - days`', () => {
    expect(code(verdict({ createdAt: ago(60) }, rule({ lookbackDays: 60 })))).toBe('ELIGIBLE');
    expect(code(verdict({ createdAt: new Date(ago(60).getTime() - 1) }, rule({ lookbackDays: 60 })))).toBe('TOO_OLD');
  });

  it('and an order whose age is not given is not judged by it — what every caller got before the rule had a look-back', () => {
    expect(code(verdict({ createdAt: undefined }, rule({ lookbackDays: 30 })))).toBe('ELIGIBLE');
    expect(code(verdict({ createdAt: null }, rule({ lookbackDays: 30 })))).toBe('ELIGIBLE');
  });

  it('and the offer refuses, by default, an order the screen would never have listed', () => {
    expect(code(verdict({ createdAt: ago(121) }))).toBe('TOO_OLD');
    expect(code(verdict({ createdAt: ago(119) }))).toBe('ELIGIBLE');
  });
});

describe('the ceiling', () => {
  it('— is the rule’s share of the price, less what was already given', () => {
    expect(maxWinbackDiscount({ sellingPrice: 200, discountAmount: 0 }, 0.1)).toBe(20);
    expect(maxWinbackDiscount({ sellingPrice: 200, discountAmount: 5 }, 0.1)).toBe(15);
    expect(maxWinbackDiscount({ sellingPrice: 200, discountAmount: 0 }, 0.5)).toBe(100);
  });

  it('and a share of nothing is nothing — a second call with no discount, not a refusal', () => {
    expect(maxWinbackDiscount({ sellingPrice: 200, discountAmount: 0 }, 0)).toBe(0);
    const v = verdict({ sellingPrice: 200 }, rule({ maxDiscountShare: 0 }));
    expect(v.eligible && v.maxDiscount).toBe(0);
  });

  it('and what was already given can use all of it — never a negative', () => {
    expect(maxWinbackDiscount({ sellingPrice: 100, discountAmount: 60 }, 0.25)).toBe(0);
  });

  it('and the verdict carries the rule’s ceiling, not the default one', () => {
    const v = verdict({ sellingPrice: 100 }, rule({ maxDiscountShare: 0.4 }));
    expect(v.eligible && v.maxDiscount).toBe(40);
  });

  it('and it is rounded to the cent, as it always was', () => {
    expect(maxWinbackDiscount({ sellingPrice: 33.33, discountAmount: 0 }, 0.25)).toBe(8.33);
  });
});

describe('a stored rule is read leniently', () => {
  it('— nothing stored, or garbage, is the default', () => {
    for (const raw of [undefined, null, 7, 'x', [], {}, { reasons: 'PRICE_TOO_HIGH' }]) {
      expect(parseWinbackRule(raw), JSON.stringify(raw)).toEqual(DEFAULT_WINBACK_RULE);
    }
  });

  it('and reasons are kept in the order the editor offers them, deduplicated, and only the selectable', () => {
    const r = parseWinbackRule({ reasons: ['OTHER', 'PRICE_TOO_HIGH', 'PRICE_TOO_HIGH', 'DUPLICATE_ORDER', 'NOT_A_REASON', 7] });
    expect(r.reasons).toEqual(['PRICE_TOO_HIGH', 'OTHER']);
  });

  it('and a list that leaves nothing falls back to the four, never to «no reasons» (which would hide the screen’s whole work)', () => {
    expect(parseWinbackRule({ reasons: ['DUPLICATE_ORDER', 'WRONG_NUMBER'] }).reasons).toEqual([...WINBACK_REASONS]);
    expect(parseWinbackRule({ reasons: [] }).reasons).toEqual([...WINBACK_REASONS]);
  });

  it('and numbers are clamped to their bounds, fractions rounded', () => {
    const lo = parseWinbackRule({ coolingDays: 0, lookbackDays: 3, maxDiscountShare: -1 });
    expect([lo.coolingDays, lo.lookbackDays, lo.maxDiscountShare]).toEqual([1, 30, 0]);
    const hi = parseWinbackRule({ coolingDays: 500, lookbackDays: 9000, maxDiscountShare: 9 });
    expect([hi.coolingDays, hi.lookbackDays, hi.maxDiscountShare]).toEqual([90, 365, 0.5]);
    expect(parseWinbackRule({ coolingDays: 14.6 }).coolingDays).toBe(15);
    expect(parseWinbackRule({ coolingDays: 'ten', maxDiscountShare: NaN }).coolingDays).toBe(14);
  });

  it('and a look-back no longer than the cooling — which would admit no order — is lifted to a week past it', () => {
    const r = parseWinbackRule({ coolingDays: 60, lookbackDays: 40 });
    expect([r.coolingDays, r.lookbackDays]).toEqual([60, 67]);
    // …and never past its own ceiling.
    expect(parseWinbackRule({ coolingDays: 90, lookbackDays: 30 }).lookbackDays).toBe(97);
    expect(parseWinbackRule({ coolingDays: 90, lookbackDays: 90 }).lookbackDays).toBeGreaterThan(90);
  });

  it('and the switch: a rule stored before it existed reads as on — what the owner asked for', () => {
    expect(parseWinbackRule({ coolingDays: 30 }).afterShipping).toBe(true);
    expect(parseWinbackRule(undefined).afterShipping).toBe(true);
  });

  it('and a stored «off» is respected — and so is a stored «on»', () => {
    expect(parseWinbackRule({ afterShipping: false }).afterShipping).toBe(false);
    expect(parseWinbackRule({ afterShipping: true }).afterShipping).toBe(true);
    // The rest of a stored rule is read as it always was beside it.
    expect(parseWinbackRule({ afterShipping: false, coolingDays: 30 })).toMatchObject({ afterShipping: false, coolingDays: 30, lookbackDays: 120 });
  });

  it.each([['the word «false»', 'false'], ['a zero', 0], ['a one', 1], ['nothing', null], ['a list', [false]]])(
    'and %s is not a yes or a no — it reads as on, never as off',
    (_what, stored) => {
      expect(parseWinbackRule({ afterShipping: stored }).afterShipping).toBe(true);
    }
  );
});

describe('a typed rule is judged — refused with a sentence, never clamped', () => {
  const ok = { reasons: ['PRICE_TOO_HIGH', 'OTHER'], coolingDays: 10, lookbackDays: 90, maxDiscountPercent: 12.5 };
  const refuse = (over: Record<string, unknown>) => validateWinbackRule({ ...ok, ...over });

  /** REWRITTEN ON 28/10: the rule that comes back carries the switch — on, when the form did not send one. */
  it('— a good rule comes back as the rule, the percent as the share the arithmetic reads', () => {
    const r = validateWinbackRule(ok);
    expect(r).toEqual({
      ok: true,
      rule: { reasons: ['PRICE_TOO_HIGH', 'OTHER'], afterShipping: true, coolingDays: 10, lookbackDays: 90, maxDiscountShare: 0.125 },
    });
  });

  it('and the switch comes back as it was sent: off is off, on is on', () => {
    const off = refuse({ afterShipping: false });
    expect(off.ok && off.rule.afterShipping).toBe(false);
    const on = refuse({ afterShipping: true });
    expect(on.ok && on.rule.afterShipping).toBe(true);
  });

  it.each([['the word «true»', 'true'], ['a one', 1], ['a zero', 0], ['nothing', null], ['a word', 'نعم']])(
    'and a switch sent as %s is refused by name, in Arabic — never read as a yes',
    (_what, value) => {
      const r = refuse({ afterShipping: value });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe('AFTER_SHIPPING');
        expect(r.errorAr).toBe('يشمل المرتجع بعد الشحن: نعم أو لا فقط');
      }
    }
  );

  it('and the percent is kept to two decimals — what is stored is what the sentence prints, not a share the screen would round for him', () => {
    const r = refuse({ maxDiscountPercent: 12.346 });
    expect(r.ok && r.rule.maxDiscountShare).toBe(0.1235);
    expect(r.ok && ruleSentence(r.rule)).toContain('خصمٌ حتى 12.35٪');
    // Whole and tiny percents carry no float dust: 7% is 0.07, 29% is 0.29.
    for (const [pct, share] of [[7, 0.07], [29, 0.29], [0.07, 0.0007]] as const) {
      const g = refuse({ maxDiscountPercent: pct });
      expect(g.ok && g.rule.maxDiscountShare, String(pct)).toBe(share);
    }
  });

  it('and the reasons come back in the editor’s order, whatever order they were sent', () => {
    const r = refuse({ reasons: ['OTHER', 'CUSTOMER_CHANGED_MIND', 'PRICE_TOO_HIGH'] });
    expect(r.ok && r.rule.reasons).toEqual(['PRICE_TOO_HIGH', 'CUSTOMER_CHANGED_MIND', 'OTHER']);
  });

  it.each([
    ['no reasons', { reasons: [] }, 'REASONS', 'اختر سبباً'],
    ['a repeated reason', { reasons: ['PRICE_TOO_HIGH', 'PRICE_TOO_HIGH'] }, 'REASONS', 'مكرَّر'],
    ['a duplicate order', { reasons: ['PRICE_TOO_HIGH', 'DUPLICATE_ORDER'] }, 'REASONS', 'طلب مكرّر'],
    ['a wrong number', { reasons: ['WRONG_NUMBER'] }, 'REASONS', 'رقم خاطئ'],
    ['a fake order', { reasons: ['FAKE_ORDER'] }, 'REASONS', 'طلب وهميّ'],
    ['an entry error', { reasons: ['MODERATOR_DATA_ERROR'] }, 'REASONS', 'خطأ إدخال'],
    ['a reason nobody has heard of', { reasons: ['PRICE_TOO_HIGH', 'SOMETHING'] }, 'REASONS', 'SOMETHING'],
    ['a reason that is not text', { reasons: [7] }, 'REASONS', '7'],
    ['reasons that are not a list', { reasons: 'PRICE_TOO_HIGH' }, 'REASONS', 'اختر سبباً'],
    ['no cooling', { coolingDays: 0 }, 'COOLING_DAYS', '1 إلى 90'],
    ['a cooling past the ceiling', { coolingDays: 91 }, 'COOLING_DAYS', '1 إلى 90'],
    ['half a day', { coolingDays: 1.5 }, 'COOLING_DAYS', 'رقمٌ صحيح'],
    ['a cooling typed as text', { coolingDays: '14' }, 'COOLING_DAYS', 'رقمٌ صحيح'],
    ['a cooling that is not a number', { coolingDays: Number.NaN }, 'COOLING_DAYS', 'رقمٌ صحيح'],
    ['a look-back under a month', { lookbackDays: 29 }, 'LOOKBACK_DAYS', '30 إلى 365'],
    ['a look-back past a year', { lookbackDays: 366 }, 'LOOKBACK_DAYS', '30 إلى 365'],
    ['a look-back no longer than the cooling', { coolingDays: 60, lookbackDays: 60 }, 'LOOKBACK_DAYS', 'أكبر من المهلة'],
    ['a discount below nothing', { maxDiscountPercent: -1 }, 'MAX_DISCOUNT', '0 إلى 50'],
    ['a discount past half the price', { maxDiscountPercent: 50.01 }, 'MAX_DISCOUNT', '0 إلى 50'],
    ['«500%»', { maxDiscountPercent: 500 }, 'MAX_DISCOUNT', '0 إلى 50'],
    ['a discount typed as text', { maxDiscountPercent: '25' }, 'MAX_DISCOUNT', '0 إلى 50'],
    ['a discount that is not a number', { maxDiscountPercent: Number.NaN }, 'MAX_DISCOUNT', '0 إلى 50'],
    ['a field nobody asked for', { maxDiscount: 25 }, 'UNKNOWN_FIELD', 'maxDiscount'],
  ])('— %s is refused', (_what, over, wantCode, mention) => {
    const r = refuse(over);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe(wantCode);
      expect(r.errorAr).toContain(mention);
    }
  });

  it('and the edges themselves are accepted: 1 and 90 days, 30 and 365 back, 0 and 50 percent', () => {
    for (const over of [{ coolingDays: 1 }, { coolingDays: 90, lookbackDays: 365 }, { lookbackDays: 30, coolingDays: 1 }, { maxDiscountPercent: 0 }, { maxDiscountPercent: 50 }]) {
      expect(refuse(over).ok, JSON.stringify(over)).toBe(true);
    }
  });

  it.each([null, undefined, 'x', 7, [], true])('— a body that is %j is not a rule', (body) => {
    const r = validateWinbackRule(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('BAD_BODY');
  });

  it('and the bounds named in the code are the ones enforced', () => {
    expect(WINBACK_BOUNDS).toEqual({
      coolingDays: { min: 1, max: 90 },
      lookbackDays: { min: 30, max: 365 },
      maxDiscountShare: { min: 0, max: 0.5 },
    });
  });
});

describe('the rule in a sentence', () => {
  /**
   * REWRITTEN ON 28/10, DELIBERATELY. This asserted that the default sentence says «لم يُشحن» — the
   * rule as it stood before the owner asked «هل بيعرض الملغي قبل الشحن وبعد ؟». The default now says both
   * kinds; «لم يُشحن» is what the sentence says with his switch OFF, word for word, below.
   */
  it('— the defaults read as both kinds, and say which kind the reasons are for', () => {
    const s = ruleSentence(DEFAULT_WINBACK_RULE);
    expect(s).toBe(
      'ملغى قبل الشحن أو مرتجع بعده · لم يُعرض عليه من قبل · سبب الإلغاء قبل الشحن: السعر مرتفع، وجدها أرخص عند غيرنا، غيّر رأيه، أُغلق بعد ثلاث محاولات بلا ردّ · بعد 14 يوماً من الإلغاء أو استلام المرتجع · من طلباتِ آخر 120 يوماً · خصمٌ حتى 25٪'
    );
    expect(s).not.toContain('لم يُشحن');
  });

  it('and with the switch off it is the sentence the screen was built on, exactly', () => {
    const s = ruleSentence(rule({ afterShipping: false }));
    expect(s).toBe(
      'ملغى · لم يُشحن · لم يُعرض عليه من قبل · السبب: السعر مرتفع، وجدها أرخص عند غيرنا، غيّر رأيه، أُغلق بعد ثلاث محاولات بلا ردّ · بعد 14 يوماً من الإلغاء · من طلباتِ آخر 120 يوماً · خصمٌ حتى 25٪'
    );
    for (const part of ['ملغى', 'لم يُشحن', 'لم يُعرض عليه من قبل', 'السعر مرتفع', 'وجدها أرخص عند غيرنا', 'غيّر رأيه', 'أُغلق بعد ثلاث محاولات بلا ردّ', 'بعد 14 يوماً', 'آخر 120 يوماً', 'حتى 25٪']) {
      expect(s, part).toContain(part);
    }
    expect(s).not.toContain('مرتجع');
  });

  it('and it follows what the owner set — it can never say fourteen while the list says ten', () => {
    const s = ruleSentence(rule({ reasons: ['OTHER'], coolingDays: 10, lookbackDays: 45, maxDiscountShare: 0.125 }));
    expect(s).toContain('سبب آخر');
    expect(s).not.toContain('السعر مرتفع');
    expect(s).toContain('بعد 10 يوماً');
    expect(s).toContain('آخر 45 يوماً');
    expect(s).toContain('حتى 12.5٪');
  });
});
