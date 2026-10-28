import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * THE DATABASE IS MOCKED FOR THE WHOLE FILE, and `vi.mock` is hoisted
 * whatever it is written next to — so it is written here, at the top, where
 * a reader expects to find it rather than buried in the one `describe` that
 * needs it.
 *
 * `price-honesty` goes with it. `postOrderOfferFor` runs the real
 * `toOfferView`, which asks that module what this bundle has really been
 * delivered at before; the answer is a query, and «nothing proven» is the
 * honest fixture — a struck-through «was» must be earned from delivered
 * orders, and inventing one in a test would be inventing the exact thing
 * that module exists to refuse.
 */
const dbMock = vi.hoisted(() => ({
  order: { findFirst: vi.fn(), update: vi.fn() },
  orderAddOn: { count: vi.fn(), create: vi.fn() },
  offer: { findFirst: vi.fn(), findMany: vi.fn() },
  company: { findUnique: vi.fn() },
  landingPage: { update: vi.fn() },
  orderActivity: { create: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock('./db', () => ({ db: dbMock, default: dbMock }));
vi.mock('./price-honesty', () => ({
  evidencedWasPrices: async () => new Map<string, number>(),
  struckThroughPrice: () => null,
}));

import { repoFile, stripComments } from './guard-source';
import { doorMoney, expectedAmountFor, type SettlementFacts } from './settlement';
import { roundMinor } from './money';
import { liveOfferWhere, offerInputSchema, offerPatchSchema, postOrderOfferWhere } from './offers';
import {
  DEFAULT_POST_ORDER_OFFER,
  addOnFromOffer,
  addOnValue,
  addPostOrderOffer,
  parsePostOrderOffer,
  postOrderGate,
} from './post-order-offer';
import { POST_ORDER_ADDITION_AR, POST_ORDER_REFUSAL_AR } from './post-order-offer-copy';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «العرض بعد الطلب» — THE OFFER AFTER THE ORDER.
 *
 * The owner's design, in four sentences: «وصلنا طلبك!» → «زيد علبة كمان؟ 15
 * بدل 25» → «آه، زيدها لطلبي» / «لا شكرًا». One offer, the seller's, at the
 * server's price, onto the SAME order, while that order is still untouched,
 * once — and refusing it leaves the order exactly as it was.
 *
 * ── WHAT THIS FILE IS MOSTLY ABOUT, AND WHY ──
 *
 * It is about MONEY, because the one thing this feature can break is a
 * figure somebody already agreed to. The history is specific and it is
 * written down twice in this repository:
 *
 *   `shipment-cod-addons.test.ts` — upsell money reached the order's total
 *   and NOT the courier's shipment. «12 of 32 on every upsold order, 37%».
 *
 *   `settlement.ts`, on `SettlementFacts.addOns` — the same money reached
 *   the total and not the SETTLEMENT, so a whole delivery of 3 × 12 with a
 *   fee of 2.5 and an upsell of 5 expected 36 instead of 41. Five dinars
 *   written off in silence, the order marked SETTLED, and an honest courier
 *   statement of 41 reported MISMATCHED.
 *
 * Both were ONE post-order addition breaking money that the first order had
 * already settled. So the claims below are not «the add works»; they are
 * «the add moved the total by its own value and moved NOTHING ELSE», tested
 * on a FULL delivery and on a PARTIAL one, because the measured regression
 * was in the full-delivery branch that everybody assumed was the safe one.
 *
 * ── AND THE FIXTURES CARRY AN INDEPENDENT TOTAL ──
 *
 * The guard that was supposed to catch that regression pinned a total of
 * 38.5 against lines summing to 36 and a fee of 2.5 — so the total was
 * derivable from the fixture's own lines, both branches agreed by
 * construction, and the guard proved nothing. A money fixture whose total
 * can be rebuilt from its own lines cannot test a rule about where the
 * total comes from. Every fixture here states its total as a fact of its
 * own, exactly as a database row does.
 * ═══════════════════════════════════════════════════════════════════════
 */

/** JOD — three decimal places, which is where the lost-fils family lives. */
const JOD = 3;

describe('«الزيادة بتزيد الإجمالي بقيمتها، وما بتلمس إشي تاني» — the money', () => {
  /**
   * ONE ORDER, THE WAY THE DATABASE HOLDS IT.
   *
   * Three units at 12, no discount, a courier fee of 2.5 that is NOT in the
   * price, and `totalAmount` stated as its own fact. `deliveredQty` is what
   * the door counted, so one fixture serves the full and the partial case by
   * changing that single number.
   */
  const order = (opts: {
    deliveredQty: number;
    totalAmount: number;
    addOns?: { quantity: number; price: number }[];
  }): SettlementFacts => ({
    shippingStatus: 'DELIVERED',
    totalAmount: opts.totalAmount,
    collectedAmount: null,
    deliveryFee: 2.5,
    priceIncludesDelivery: false,
    items: [
      {
        quantity: 3,
        freeQuantity: 0,
        unitPrice: 12,
        discountShare: 0,
        lineTotal: 36,
        deliveredQty: opts.deliveredQty,
      },
    ],
    addOns: opts.addOns ?? [],
    returnReceipt: null,
  });

  /** The offer the customer accepted: one piece at 5. */
  const ADDED = { quantity: 1, price: 5 };

  it('a WHOLE delivery expects the add-on money too — the five dinars that went missing once', () => {
    /*
     * THE MEASURED DEFECT, as a number.
     *
     * Before: the courier collects 38.5, keeps the 2.5 fee, owes 36.
     * After:  the customer accepted 5 on the thank-you screen, so the
     *         courier collects 43.5, keeps the same 2.5, and owes 41.
     *
     * The regression this pins answered 36 in both cases, because it
     * rebuilt the expectation from the order's LINES and a post-order
     * addition is not a line. Forty-one is the whole claim.
     */
    const before = expectedAmountFor(order({ deliveredQty: 3, totalAmount: 38.5 }), JOD);
    const after = expectedAmountFor(
      order({ deliveredQty: 3, totalAmount: 43.5, addOns: [ADDED] }),
      JOD
    );

    expect(before, 'التوقّع قبل الزيادة تغيّر').toBe(36);
    expect(after, 'الزيادة بعد الطلب ما وصلت توقّع التحصيل — هاي هي الخمس دنانير اللي ضاعت').toBe(41);
    expect(after - before, 'الإجمالي تحرّك بغير قيمة الزيادة').toBe(5);
  });

  it('and a PARTIAL delivery keeps it, while the lines’ own share shrinks alone', () => {
    /*
     * The customer took two of the three units and the box they added on the
     * thank-you screen. The goods halve to 24; the add-on is still 5.
     *
     * This is the case the partial-delivery rule was rewritten for, and the
     * pairing is the point: a change that drops the add-on fails the test
     * above, and a change that lets the add-on ride along with the RETURNED
     * units — refunding money for a box the customer kept — fails this one.
     */
    const partial = order({ deliveredQty: 2, totalAmount: 43.5, addOns: [ADDED] });
    const money = doorMoney(partial, JOD);

    expect(money.goods, 'قيمة البضاعة المسلَّمة غلط').toBe(24);
    expect(money.addOns, 'الزيادة بعد الطلب ضاعت مع القطع الراجعة').toBe(5);
    expect(money.fee, 'أجرة التوصيل تغيّرت بسبب الزيادة').toBe(2.5);
    expect(money.collected, 'المبلغ المحصَّل عند الباب غلط').toBe(31.5);
    expect(expectedAmountFor(partial, JOD), 'التوقّع بعد تسليمٍ جزئيّ غلط').toBe(29);
  });

  it('and the add changes the GOODS by nothing at all — on both branches', () => {
    /*
     * THE CLAIM THAT WOULD FAIL IF THE ADD WERE AN `OrderItem`.
     *
     * An `OrderItem` written after the order exists moves `subtotal`, and
     * `allocateDiscount` re-cuts every line's `discountShare` — the figure a
     * partial return refunds against. So the natural-reading implementation
     * changes money the customer agreed to an hour earlier, and it changes
     * it on the goods half of the expectation.
     *
     * `goods` is therefore pinned EQUAL across the add, and `addOns` is
     * pinned as the whole of the movement. An implementation that routes the
     * addition through the order's lines fails this on both branches at
     * once: `goods` rises and `addOns` stays 0.
     */
    for (const deliveredQty of [3, 2]) {
      const before = doorMoney(order({ deliveredQty, totalAmount: 38.5 }), JOD);
      const after = doorMoney(
        order({ deliveredQty, totalAmount: 43.5, addOns: [ADDED] }),
        JOD
      );
      expect(after.goods, `قيمة البضاعة تغيّرت بالزيادة (deliveredQty=${deliveredQty})`).toBe(
        before.goods
      );
      expect(after.fee, `أجرة التوصيل تغيّرت بالزيادة (deliveredQty=${deliveredQty})`).toBe(
        before.fee
      );
      expect(after.addOns - before.addOns, 'قيمة الزيادة مش كلّ الحركة').toBe(5);
      expect(after.collected - before.collected, 'المحصَّل تحرّك بغير قيمة الزيادة').toBe(5);
    }
  });

  it('and a parcel that came back whole owes nothing extra for an offer nobody received', () => {
    // A RETURNED order short-circuits before any of this, which is right:
    // the customer accepted the offer on a screen and then refused the
    // parcel at the door. Nothing was handed over, so nothing is expected —
    // and the add-on must not turn that into a debt.
    const returned: SettlementFacts = {
      ...order({ deliveredQty: 0, totalAmount: 43.5, addOns: [ADDED] }),
      shippingStatus: 'RETURNED',
    };
    expect(expectedAmountFor(returned, JOD), 'طلبٌ رجع كامل انقلب إلى مبلغٍ مستحق').toBe(0);
  });
});

describe('«السعر من السيرفر» — what one add is worth', () => {
  it('is the bundle’s price, and the row’s three columns agree with each other', () => {
    // «قطعتان بـ 25» is ONE row of two pieces, not two rows — the division
    // to a unit price happens where the offer is read, exactly as
    // `resolvePublicLines` does it at the door.
    const row = addOnFromOffer(
      { id: 'o1', name: 'علبتان', quantity: 2, freeQuantity: 0, price: 25, listPrice: 40, compareAtPrice: null, isDefault: false, deliveryIncluded: true, endsAt: null },
      JOD
    );
    expect(row.quantity, 'عدد القطع غلط').toBe(2);
    expect(row.unitPrice, 'سعر القطعة غلط').toBe(12.5);
    expect(row.total, 'إجمالي السطر ما يساوي سعر العرض').toBe(25);
  });

  it('and a price that does not divide loses no fils on the way back out', () => {
    /*
     * THE LOST-FILS FAMILY, PRE-EMPTED.
     *
     * Three pieces for 10.000 JOD is 3.3333… each. Rounding the unit price
     * first and multiplying it back gives 3 × 3.333 = 9.999 — a fils under
     * what the customer was quoted, on every bundle whose price does not
     * divide by its quantity. The unit price is left at full precision and
     * only the TOTAL is rounded, by the order's own currency.
     */
    const row = addOnFromOffer(
      { id: 'o1', name: 'ثلاث علب', quantity: 3, freeQuantity: 0, price: 10, listPrice: null, compareAtPrice: null, isDefault: false, deliveryIncluded: true, endsAt: null },
      JOD
    );
    expect(row.total, 'ضاع فلس بين سعر العرض وسطر الزيادة').toBe(10);
    expect(roundMinor(row.quantity * row.unitPrice, JOD)).toBe(10);
  });

  it('and the rounding is the currency’s, never two decimals', () => {
    // `.toFixed(2)` on a JOD add-on was a real defect one door down: an
    // add-on at 1.234 was stored 1.23, a fils lost on the order and three
    // rows disagreeing with the product they came from.
    expect(addOnValue(1, 1.234, 3), 'التدوير ما احترم عملة المتجر').toBe(1.234);
    expect(addOnValue(1, 1.234, 2), 'التدوير ما احترم عملةً من منزلتين').toBe(1.23);
  });
});

describe('«بس والطلب لسا جديد» — the four gates', () => {
  const NOW = new Date('2026-10-15T12:00:00.000Z');
  const fresh = (over: Partial<Parameters<typeof postOrderGate>[0]> = {}) => ({
    status: 'NEW',
    confirmationStatus: 'NEW',
    createdAt: new Date(NOW.getTime() - 60_000),
    contactAttempts: 0,
    postOrderAddOns: 0,
    ...over,
  });

  it('lets an untouched order grow', () => {
    expect(postOrderGate(fresh(), 15, NOW)).toEqual({ allowed: true });
  });

  it('refuses once the order has moved on — either column', () => {
    // Both, not either: the confirmation stage moves one and operations
    // moves the other, and an order already in a shipment must not gain
    // goods the courier was never told about.
    expect(postOrderGate(fresh({ status: 'CONFIRMED' }), 15, NOW)).toEqual({
      allowed: false,
      reason: 'NOT_NEW',
    });
    expect(postOrderGate(fresh({ confirmationStatus: 'CONFIRMED' }), 15, NOW)).toEqual({
      allowed: false,
      reason: 'NOT_NEW',
    });
  });

  it('refuses after anybody has tried to reach the customer', () => {
    // Any `OrderContactAttempt` — a call answered, a call not answered, an
    // SMS, a WhatsApp. Once a person has spoken about this order, the order
    // grows through that person, or the agent reads a total on their screen
    // that the customer changed while they were dialling.
    expect(postOrderGate(fresh({ contactAttempts: 1 }), 15, NOW)).toEqual({
      allowed: false,
      reason: 'CONTACTED',
    });
  });

  it('refuses once the window has passed, and gives the boundary to the customer', () => {
    const at = (minutesAgo: number) =>
      postOrderGate(fresh({ createdAt: new Date(NOW.getTime() - minutesAgo * 60_000) }), 15, NOW);
    // Exactly fifteen minutes old is still inside fifteen minutes. A `>=`
    // here would take the last millisecond off a window the screen has just
    // promised in writing.
    expect(at(15), 'الدقيقة الأخيرة من المهلة انسحبت من الزبون').toEqual({ allowed: true });
    expect(at(15.001)).toEqual({ allowed: false, reason: 'WINDOW_PASSED' });
    expect(at(60)).toEqual({ allowed: false, reason: 'WINDOW_PASSED' });
  });

  it('and a clock that went backwards is inside the window, not outside it', () => {
    // A machine whose time was corrected must not cost a customer their
    // offer. A negative elapsed time is «not yet fifteen minutes».
    expect(postOrderGate(fresh({ createdAt: new Date(NOW.getTime() + 60_000) }), 15, NOW)).toEqual({
      allowed: true,
    });
  });

  it('refuses a second time, and says so rather than blaming the clock', () => {
    /*
     * «مرة واحدة», and the ORDER of the checks is part of the claim.
     *
     * A customer who pressed the button twice is told their offer is already
     * on the order. Telling them the window had passed would be true of the
     * state and useless to them, which is how an honest message becomes a
     * shrug — so `ALREADY_ADDED` is tested before everything else and wins
     * even on an order that has also moved on and aged out.
     */
    expect(postOrderGate(fresh({ postOrderAddOns: 1 }), 15, NOW)).toEqual({
      allowed: false,
      reason: 'ALREADY_ADDED',
    });
    expect(
      postOrderGate(
        fresh({
          postOrderAddOns: 1,
          status: 'CONFIRMED',
          contactAttempts: 2,
          createdAt: new Date(NOW.getTime() - 3_600_000),
        }),
        15,
        NOW
      )
    ).toEqual({ allowed: false, reason: 'ALREADY_ADDED' });
  });

  it('and every refusal has a sentence of its own', () => {
    // «حدث خطأ» would be a lie about six different situations. Each code
    // names what happened, and where there is a way forward it says so.
    const sentences = Object.values(POST_ORDER_REFUSAL_AR);
    expect(new Set(sentences).size, 'رسالتان متشابهتان لحالتين مختلفتين').toBe(sentences.length);
    for (const [code, text] of Object.entries(POST_ORDER_REFUSAL_AR)) {
      expect(text.length, `«${code}» بلا رسالة`).toBeGreaterThan(10);
      expect(text, `«${code}» ما بالعربي`).toMatch(/[؀-ۿ]/);
    }
  });
});

describe('«المهلة إعداد، افتراضها ربع ساعة»', () => {
  it('is fifteen minutes when nobody set one', () => {
    expect(DEFAULT_POST_ORDER_OFFER.windowMinutes).toBe(15);
    expect(parsePostOrderOffer(undefined).windowMinutes).toBe(15);
    expect(parsePostOrderOffer({}).windowMinutes).toBe(15);
  });

  it('and a stored number is read, clamped, never thrown on', () => {
    // Clamped rather than refused: these arrive from a form, and a settings
    // row that throws would take the whole thank-you screen down with it.
    expect(parsePostOrderOffer({ windowMinutes: 30 }).windowMinutes).toBe(30);
    expect(parsePostOrderOffer({ windowMinutes: 0 }).windowMinutes).toBe(1);
    expect(parsePostOrderOffer({ windowMinutes: -5 }).windowMinutes).toBe(1);
    expect(parsePostOrderOffer({ windowMinutes: 99_999 }).windowMinutes).toBe(1440);
    expect(parsePostOrderOffer({ windowMinutes: 'ربع ساعة' }).windowMinutes).toBe(15);
    expect(parsePostOrderOffer({ windowMinutes: NaN }).windowMinutes).toBe(15);
  });
});

describe('«العرض بعد الطلب ما بينباع على الباب»', () => {
  const now = new Date('2026-10-15T12:00:00.000Z');

  it('the door predicate withholds it, and the after-order one asks for it', () => {
    /*
     * THE DIRECTION OF THE DEFAULT IS THE WHOLE ARGUMENT.
     *
     * `liveOfferWhere` is what the storefront grid's from-price, the product
     * page's picker and `activeOffersFor` all read — and `activeOffersFor`
     * is what `resolvePublicLines` prices an order from. A bundle priced for
     * «زيد علبة كمان؟ 15 بدل 25» reaching any of them lets the visitor pick
     * 15 before ordering anything, and the after-order price has become a
     * price cut on the catalogue.
     *
     * So the safe answer is the one a forgetful future caller gets for free.
     */
    expect(liveOfferWhere(now).postOrderOffer, 'الباب صار يبيع عرض ما بعد الطلب').toBe(false);
    expect(postOrderOfferWhere(now).postOrderOffer).toBe(true);
  });

  it('and the two are exact mirrors, so no offer can be in both', () => {
    // An offer pickable at the door AND offered after it would let the same
    // customer buy the same bundle at the after-order price twice over.
    const door = liveOfferWhere(now);
    const after = postOrderOfferWhere(now);
    expect(after.status).toBe(door.status);
    expect(after.OR).toEqual(door.OR);
    expect(after.postOrderOffer).not.toBe(door.postOrderOffer);
  });

  it('and every door reads the predicate rather than spelling it out', () => {
    // Three queries once spelled `status: 'ACTIVE'` themselves, and adding
    // an ending was three edits with one forgotten. The same reasoning
    // applies the moment a fourth condition joins the predicate.
    for (const file of ['src/lib/offers.ts', 'src/lib/storefront.ts']) {
      const src = stripComments(repoFile(file));
      expect(src, `«${file}» بيكتب شرط البيع بيده`).not.toContain("status: 'ACTIVE',\n    OR:");
    }
    const offers = stripComments(repoFile('src/lib/offers.ts'));
    expect(offers).toContain('...liveOfferWhere(now)');
    expect(offers).toContain('...postOrderOfferWhere(now)');
  });
});

describe('«ولا يقبل كمية مجانية»', () => {
  const base = { name: 'علبة', sellingPrice: 15 };

  it('an ordinary bundle may carry gift units', () => {
    expect(offerInputSchema.safeParse({ ...base, quantity: 3, freeQuantity: 1 }).success).toBe(true);
  });

  it('and the offer after the order may not', () => {
    /*
     * `OrderAddOn` has `quantity`, `price` and `total`, and NO
     * `freeQuantity`: gift units are a concept of the order's own lines,
     * where they are real stock at zero price and feed COGS. A post-order
     * bundle carrying one would be advertised, accepted, charged correctly —
     * and the free piece would exist nowhere. Nobody would pick it, nobody
     * would ship it, and the customer would be short what they were
     * promised.
     *
     * Refused where it ENTERS, which is the same decision the discount rule
     * in this file makes and for the same reason.
     */
    const r = offerInputSchema.safeParse({ ...base, quantity: 3, freeQuantity: 1, postOrderOffer: true });
    expect(r.success, 'عرضٌ بعد الطلب بهدية مرّ من الباب').toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].path, 'الخطأ مش على الخانة الصح').toEqual(['freeQuantity']);
      expect(r.error.issues[0].message).toMatch(/كمية مجانية/);
    }
  });

  it('and an EDIT is measured against the row it will leave behind', () => {
    // `{ postOrderOffer: true }` alone says nothing about the gift units the
    // offer already carries. Checking only what was sent would shut the
    // create door and leave this one open, which is exactly how a rule
    // becomes decoration.
    const stored = { sellingPrice: 15, discount: 0, postOrderOffer: false, freeQuantity: 1 };
    expect(offerPatchSchema(stored).safeParse({ postOrderOffer: true }).success).toBe(false);
    // And the way out is to clear the gift units in the same edit.
    expect(
      offerPatchSchema(stored).safeParse({ postOrderOffer: true, freeQuantity: 0 }).success
    ).toBe(true);
  });
});

describe('«بيعدّل الطلب نفسه، وما بيلمس إشي تاني» — the write, read from the source', () => {
  const service = () => stripComments(repoFile('src/lib/post-order-offer.ts'));

  it('creates no order, and no order LINE', () => {
    const src = service();
    /*
     * THE CALL, not the substring. `order.createdAt` — the field this
     * module reads to measure the window — contains `order.create`, so a
     * plain substring check fails on correct code and teaches the next
     * reader to delete the guard.
     */
    expect(src, 'الزيادة بعد الطلب بتعمل طلب جديد').not.toMatch(/order\.create\s*\(/);
    // The one that would quietly re-cut every line's discount share.
    expect(src, 'الزيادة بعد الطلب بتكتب سطر طلب').not.toMatch(/orderItem\.create/);
  });

  it('and the only money it writes is the increment', () => {
    /*
     * A RECOMPUTE HERE WOULD REWRITE THE FIRST ORDER'S ARITHMETIC.
     *
     * The discount, the fee policy and the rounding were settled when the
     * order was created; rebuilding the total from today's configuration
     * would quietly re-decide all three. So the total moves by the add-on's
     * value and by nothing else, and the value itself comes from
     * `computeCod` — the one COD authority — so the figure written here and
     * the figure every later recompute contributes are the same number by
     * construction.
     */
    const src = service();
    expect(src).toContain('totalAmount: { increment: total }');
    expect(src, 'في مكان تاني بيكتب الإجمالي').not.toContain('totalAmount: roundMinor');
    expect(src).toContain('computeCod(');
  });

  it('and it touches none of the figures the first order settled', () => {
    const src = service();
    for (const column of [
      'sellingPrice:',
      'discountShare',
      'estimatedCostOfGoods',
      'priceIncludesDelivery:',
      'shippingCost',
      'deliveryFee:',
    ]) {
      expect(src, `الزيادة بعد الطلب بتكتب «${column}»`).not.toContain(column);
    }
  });

  it('and the gates are decided BEFORE anything is written', () => {
    // «لا شكرًا» أو انتهاء المهلة بيخلّي الطلب زي ما هو — which is only true
    // if the refusal returns before the transaction opens.
    const src = service();
    const gate = src.indexOf('if (!gate.allowed) return refuse(gate.reason)');
    const write = src.indexOf('db.$transaction');
    expect(gate, 'ما في بوّابة').toBeGreaterThan(0);
    expect(write, 'ما في كتابة').toBeGreaterThan(0);
    expect(gate, 'الكتابة قبل البوّابة').toBeLessThan(write);
  });

  it('and «مرة واحدة» is checked again inside the transaction', () => {
    // Two presses landing together both pass the read above; only one may
    // write. It costs one query on the one path that writes.
    const src = service();
    const tx = src.slice(src.indexOf('db.$transaction'));
    expect(tx).toContain("offerId: { not: null }");
    expect(tx).toContain('if (already > 0) return null;');
  });

  it('and there is no door for refusing, because refusing writes nothing', () => {
    // The order was placed before the card appeared. A refusal has nothing
    // to undo, so a `decline` endpoint would be state invented to be stored.
    const src = service();
    expect(src.toLowerCase()).not.toContain('decline');
    expect(src.toLowerCase()).not.toContain('function refusepostorder');
  });
});

describe('«لا سعر ولا كمية على السلك» — the public door', () => {
  const route = () =>
    stripComments(repoFile('src/app/api/public/orders/[orderNumber]/post-order-offer/route.ts'));

  it('reads a token and an offer id, and nothing else', () => {
    const src = route();
    expect(src).toContain('token: z.string()');
    expect(src).toContain('offerId: z.string()');
    for (const forbidden of ['price: z.', 'quantity: z.', 'total: z.', 'companyId: z.']) {
      expect(src, `الباب بيقرأ «${forbidden}» من المتصفّح`).not.toContain(forbidden);
    }
  });

  it('and knowing an order number is not enough to touch somebody’s order', () => {
    // The CALL, not the import: renaming the imported symbol leaves the call
    // site reading the same and proves nothing.
    expect(route()).toContain('await verifyAddonToken(v.token)');
    expect(route()).toContain('tok.orderNumber !== decoded');
  });

  it('and every figure it returns came back from the service', () => {
    const src = route();
    expect(src).toContain('await addPostOrderOffer(');
    expect(src).toContain('newTotal: result.newTotal');
    // No arithmetic in a route: the service owns every figure.
    expect(src, 'الباب بيحسب فلوس').not.toContain('roundMinor');
  });

  it('and it announces no app event, because the contract is frozen', () => {
    /*
     * ── THE ANSWER TO «HOW DOES A CHANGED TOTAL REACH SYSTEM 7?» ──
     *
     * `contracts/oms-app-events.v1` is frozen: no new event type, no new
     * field on the `{ event, at, data }` envelope. `events-sites.test.ts`
     * pins the announcing call sites to exactly three files, and this door
     * is not one of them — so it must not announce anything at all.
     *
     * It does not need to. The window this door writes inside is strictly
     * BEFORE confirmation: `postOrderGate` requires `confirmationStatus`
     * still `NEW`, so every add lands before `order.confirmed` is emitted.
     * And that emission reads the total FRESH from the database after the
     * commit — `total: Number(fresh?.totalAmount ?? 0)` — not from a value
     * captured earlier. So the figure System 7 receives at confirmation
     * already carries the addition, by construction, with v1 untouched.
     *
     * `order.created` fired earlier and carries the opening total. That is
     * correct and not a gap: it is a record of what happened when the order
     * was created, and the total that matters to the replies system is the
     * one on the order it is replying about.
     */
    expect(route(), 'باب جديد بيعلن حدثاً لنظام ٧').not.toContain('emitAppEvent');

    const confirmation = stripComments(
      repoFile('src/app/api/orders/[id]/confirmation/route.ts')
    );
    expect(
      confirmation,
      'باب التأكيد ما عاد يقرأ الإجمالي من قاعدة البيانات بعد الحفظ — الزيادة بعد الطلب ما بتوصل نظام ٧'
    ).toContain('total: Number(fresh?.totalAmount ?? 0)');
    expect(confirmation).toContain('const fresh = await db.order.findUnique({ where: { id } });');
  });
});

describe('«بيظهر بعد الطلب، مرة وحدة، وبيختفي إذا رفضه» — the screen', () => {
  const form = () => stripComments(repoFile('src/components/landing/OrderForm.tsx'));
  /*
   * THE CARD LEFT THE FORM, AND THESE CLAIMS WENT WITH IT.
   *
   * `ThankYouOfferCard` is the one card every door draws — the landing form
   * and the basket's thank-you page (RV250) — so its markup, its request and
   * its refusal live there now. Each claim below reads the file that holds
   * the thing it is about: the form for WHETHER the card is drawn, the
   * countdown and the header's total; the card for what it prints, what it
   * sends and what a refusal does. Not one claim was dropped or loosened.
   */
  const card = () => stripComments(repoFile('src/components/landing/ThankYouOfferCard.tsx'));

  it('draws the offer only when the SERVER sent one', () => {
    // `null` is a real answer — the seller set none — and draws nothing.
    // Better than inventing a suggestion nobody configured.
    expect(form()).toContain('const showUpsell = !!postOrder.offer && !postOrderRefused');
    expect(form()).toContain('{showUpsell && postOrder.offer && (');
  });

  it('and prints the server’s two numbers rather than working one out', () => {
    /*
     * «15 بدل 25» is `price` and `listPrice`, both computed on the server by
     * `toOfferView` — the same function that priced the bundles on this very
     * page. A browser subtracting a discount is a second pricing path, and
     * this product's history is a list of those: the landing page once
     * printed 25 for a bundle the cart door priced at 22.
     */
    const src = form();
    expect(card()).toContain('fmt(postOrder.offer.price)');
    expect(card()).toContain('fmt(postOrder.offer.listPrice)');
    // The window is STATED from the server's own number. A countdown exists only when the seller chose «عدّاد»
    // («شريط … أو عدّاد», 26/10), and it counts that same number of minutes — the page invents no deadline of its own.
    expect(card()).toContain('{postOrder.windowMinutes} دقيقة');
    expect(src.match(/setInterval/g) ?? [], 'عدّاد غير العدّاد الوحيد').toHaveLength(1);
    expect(card().match(/setInterval/g) ?? [], 'البطاقة صار عندها عدّاد لحالها').toHaveLength(0);
    expect(src).toContain("look.banner === 'countdown' && offersFrom !== null && postOrder.windowMinutes > 0");
    expect(src).toContain('postOrder.windowMinutes * 60_000');
  });

  it('and the two answers the owner wrote are the two buttons', () => {
    const src = card();
    expect(src).toContain('آه، زيدها لطلبي');
    expect(src).toContain('لا شكراً');
  });

  it('and refusing writes nothing — not to the server, not to the total', () => {
    /*
     * THE HANDLER, not the declaration. `indexOf('setPostOrderRefused')`
     * finds the `useState` line first, so a window measured from there looks
     * at the wrong four hundred characters entirely — which is how a
     * mutation inside a refusal handler once went unnoticed in this file.
     */
    const src = card();
    const at = src.indexOf('setPostOrderRefused(true)');
    expect(at, 'ما في طريقة يرفض').toBeGreaterThan(0);
    const around = src.slice(at - 300, at + 300);
    expect(around, 'الرفض بيكلّم السيرفر').not.toContain('fetch(');
    expect(around, 'الرفض بيعدّل الإجمالي').not.toContain('setTotals');
    expect(around, 'الرفض بيعدّل الإجمالي').not.toContain('onTotal');
    // And «لا شكراً» presses exactly that function.
    expect(src).toContain('onClick={refusePostOrderOffer}');
  });

  it('and the new total is the server’s, after the add', () => {
    // The card hands the server's number to its door, and the form prints it.
    expect(card()).toContain("if (typeof json?.newTotal === 'number') onTotal(json.newTotal);");
    expect(form()).toContain('onTotal: (total) => setTotals({ total })');
    // The recommendation add-on, which is still the form's own, does the same.
    expect(form()).toContain("if (typeof json?.newTotal === 'number') setTotals({ total: json.newTotal });");
    // The header prints `totals.total` once there is one — the server's
    // answer after the add, not a sum this component kept.
    expect(form()).toContain("state === 'success' && totals ? totals.total");
  });

  it('and a refusal shows the server’s sentence and closes the card', () => {
    const src = card();
    expect(src).toContain("setPostOrderState('gone')");
    expect(src).toContain('setPostOrderMsg(json?.error');
    // No map of codes to Arabic kept in the page: the server that made the
    // decision supplies the words for it.
    expect(src, 'البطاقة بتترجم أكواد الرفض بحالها').not.toContain('WINDOW_PASSED');
    expect(form(), 'الصفحة بتترجم أكواد الرفض بحالها').not.toContain('WINDOW_PASSED');
  });

  it('and saying no to the bundle does not withdraw the recommendation list', () => {
    // Two different things are being refused. One flag for both would mean
    // declining the seller's bundle silently removed everything else.
    const src = form();
    expect(src).toContain('const showUpsell = !!postOrder.offer && !postOrderRefused');
    // The list answers to its OWN refusal; refusing the bundle only ever REVEALS it (the «ورا بعض» order).
    expect(src).toContain('const showCrossSell = !offerRefused && !windowOver && recommendations.length > 0');
  });
});

describe('«موظفة التأكيد تشوف «زيادة بعد الطلب» على السطر»', () => {
  it('the words live in one place, and that place is client-safe', () => {
    /*
     * `post-order-offer.ts` knows about Prisma, and `db.ts` carries no
     * `server-only` marker — so importing it into a `'use client'` screen
     * for the sake of one Arabic label would pull the whole Prisma client
     * into the browser bundle. The words are a leaf of their own, exactly
     * the split this repo already made for `store-pages.ts`.
     */
    const copy = stripComments(repoFile('src/lib/post-order-offer-copy.ts'));
    expect(copy, 'ملف الكلمات بيستورد إشي — صار مش آمن للمتصفّح').not.toMatch(/^import /m);
    expect(POST_ORDER_ADDITION_AR).toBe('زيادة بعد الطلب');
  });

  it('and the order screen draws them instead of naming the row', () => {
    // «منتجات إضافية» named the row and said nothing about the moment, and
    // the moment is the whole of what the person on the phone needs: a line
    // the customer chose before anybody called is not a line this agent
    // sold, and the total they are about to read aloud moved after the order
    // was placed.
    const modal = stripComments(repoFile('src/components/orders/OrderDetailModal.tsx'));
    expect(modal).toContain("from '@/lib/post-order-offer-copy'");
    expect(modal).toContain('{POST_ORDER_ADDITION_AR}:');
    expect(modal, 'السطر لسا اسمه «منتجات إضافية»').not.toContain('منتجات إضافية:');
  });

  it('and the timeline carries the same words', () => {
    const src = stripComments(repoFile('src/lib/post-order-offer.ts'));
    expect(src).toContain('label: POST_ORDER_ADDITION_AR');
    expect(src).toContain("action: 'UPSELL_ADDED'");
    // An anonymous visitor did this, which is also what keeps it off an
    // agent's cross-sell commission: `crossSellUnits` counts `orderItem`
    // rows added by a NAMED user, and this is neither.
    expect(src).toContain('userId: null');
  });
});

describe('«العرض لازم يكون على منتجٍ في الطلب»', () => {
  /*
   * A WRITE TEST WITH THE DATABASE MOCKED, because the ORDER of the gates
   * and the «which offer» check are the two things a reader cannot verify
   * from the pure function alone: both are about what is NOT written.
   */
  const NOW = new Date('2026-10-15T12:00:00.000Z');

  /** A fresh order, one minute old, one product, nobody has called. */
  const ORDER = {
    id: 'ord1',
    orderNumber: 'JO-2026-0001',
    companyId: 'c1',
    status: 'NEW',
    confirmationStatus: 'NEW',
    createdAt: new Date(NOW.getTime() - 60_000),
    currency: 'JOD',
    landingPageId: 'lp1',
    productId: 'p1',
    items: [{ productId: 'p1' }],
    store: { country: { minorUnit: 3 } },
    _count: { contactAttempts: 0 },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.company.findUnique.mockResolvedValue({ settings: null });
    dbMock.orderAddOn.count.mockResolvedValue(0);
    dbMock.order.findFirst.mockResolvedValue(ORDER);
    dbMock.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(dbMock));
    dbMock.orderAddOn.create.mockResolvedValue({
      id: 'a1',
      productName: 'علبة',
      quantity: 1,
      price: 15,
      total: 15,
    });
    dbMock.order.update.mockResolvedValue({
      orderNumber: 'JO-2026-0001',
      totalAmount: 40,
      currency: 'JOD',
    });
  });

  const liveOffer = {
    id: 'of1',
    name: 'علبة كمان',
    quantity: 1,
    freeQuantity: 0,
    sellingPrice: 25,
    discount: 10,
    compareAtPrice: null,
    isDefault: false,
    deliveryIncluded: true,
    endsAt: null,
  };

  it('adds the offer at the SERVER’s price, once, to the same order', async () => {
    dbMock.offer.findFirst.mockResolvedValue({
      id: 'of1',
      productId: 'p1',
      product: { id: 'p1', name: 'علبة', status: 'ACTIVE' },
    });
    dbMock.offer.findMany.mockResolvedValue([liveOffer]);

    const r = await addPostOrderOffer({
      orderId: 'ord1',
      orderNumber: 'JO-2026-0001',
      offerId: 'of1',
      now: NOW,
    });

    expect(r.ok, 'العرض بعد الطلب انرفض على طلبٍ جديد').toBe(true);
    // 25 less a stored discount of 10 — the CHARGED figure, through
    // `allocateDiscount`, never `sellingPrice`.
    expect(dbMock.orderAddOn.create.mock.calls[0][0].data).toMatchObject({
      orderId: 'ord1',
      offerId: 'of1',
      quantity: 1,
      price: 15,
      total: 15,
    });
    expect(dbMock.order.update.mock.calls[0][0].data).toEqual({
      totalAmount: { increment: 15 },
    });
  });

  it('and refuses an offer whose product is not in the order', async () => {
    // A real, live post-order offer — of another product in the same shop.
    // The token proves which ORDER; it says nothing about which offer, and
    // an id is guessable in the way any id is.
    dbMock.offer.findFirst.mockResolvedValue({
      id: 'of9',
      productId: 'p9',
      product: { id: 'p9', name: 'شي تاني', status: 'ACTIVE' },
    });

    const r = await addPostOrderOffer({
      orderId: 'ord1',
      orderNumber: 'JO-2026-0001',
      offerId: 'of9',
      now: NOW,
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('NOT_IN_ORDER');
    expect(dbMock.orderAddOn.create, 'كتبت زيادة لمنتجٍ مش في الطلب').not.toHaveBeenCalled();
    expect(dbMock.order.update).not.toHaveBeenCalled();
  });

  it('and refuses an offer that is no longer the offer after the order', async () => {
    dbMock.offer.findFirst.mockResolvedValue({
      id: 'of1',
      productId: 'p1',
      product: { id: 'p1', name: 'علبة', status: 'ACTIVE' },
    });
    // The predicate returns nothing: the seller switched it off, it ended,
    // or the flag moved to another bundle. The row above still exists, which
    // is exactly why the price is re-read through the predicate instead.
    dbMock.offer.findMany.mockResolvedValue([]);

    const r = await addPostOrderOffer({
      orderId: 'ord1',
      orderNumber: 'JO-2026-0001',
      offerId: 'of1',
      now: NOW,
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('OFFER_GONE');
    expect(dbMock.order.update).not.toHaveBeenCalled();
  });

  it('and an order that has been called about is left exactly as it was', async () => {
    dbMock.order.findFirst.mockResolvedValue({ ...ORDER, _count: { contactAttempts: 1 } });
    dbMock.offer.findFirst.mockResolvedValue({
      id: 'of1',
      productId: 'p1',
      product: { id: 'p1', name: 'علبة', status: 'ACTIVE' },
    });

    const r = await addPostOrderOffer({
      orderId: 'ord1',
      orderNumber: 'JO-2026-0001',
      offerId: 'of1',
      now: NOW,
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe(POST_ORDER_REFUSAL_AR.CONTACTED);
    // Not one write, and that IS «بيخلّي الطلب زي ما هو».
    expect(dbMock.$transaction).not.toHaveBeenCalled();
    expect(dbMock.orderAddOn.create).not.toHaveBeenCalled();
    expect(dbMock.order.update).not.toHaveBeenCalled();
    expect(dbMock.landingPage.update).not.toHaveBeenCalled();
    expect(dbMock.orderActivity.create).not.toHaveBeenCalled();
  });
});
