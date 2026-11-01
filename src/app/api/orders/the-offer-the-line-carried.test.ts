import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from '@/lib/guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE OFFER WAS ON THE LINE, AND THE DOOR LOOKED AT THE TOP.
 *
 * The owner, 21/10, reported two things as if they were two:
 *
 *   «في العروض الهدية الحبة الهدية ما بتنحسب من المخزون غلط»
 *   «لما احط في العرض شامل سعر التوصيل عند انشاء شحنة بضيف توصيل !!»
 *
 * They were one bug, in one line.
 *
 * `POST /api/orders` read `offerId` — the TOP-LEVEL field of the
 * single-product shorthand. The order dialog never sends it: it sends an
 * offer on every LINE (`CreateOrderModal.tsx:168`), which the schema
 * accepted and nothing then read. So on every order a moderator typed:
 *
 *   • `offer` was null, so `freeQuantity` was never written — and the
 *     gift left the warehouse unrecorded. Nothing downstream was broken:
 *     the reservation, the deduction at delivery, the return and the
 *     ready-to-ship guard all read `quantity + freeQuantity` already.
 *     The column was simply never filled.
 *
 *   • `deliveryIncluded` was never read, so the order was written
 *     `priceIncludesDelivery: false` — and the shipment then added the
 *     fee to a price that already contained it. The customer is asked for
 *     more than the page promised, and the statement disagrees with the
 *     order by exactly the fee.
 *
 *   • the order's own `offerId` column stayed empty, so «which bundle
 *     sold this» had no answer for the commonest kind of order.
 *
 * ── AND IT PASSED ITS TESTS ──
 *
 * `multi-line.test.ts:203` posts a top-level `offerId` BESIDE `items[]`
 * — a shape the real form never sends. The fixture agreed with the code
 * and neither agreed with the screen. That is the vacuous-fixture lesson
 * this repository has now paid for three times.
 * ═══════════════════════════════════════════════════════════════════════
 */

const door = () => stripComments(repoFile('src/app/api/orders/route.ts'));
const edit = () => stripComments(repoFile('src/app/api/orders/[id]/route.ts'));

describe('the door reads the offer each line carried', () => {
  it('— every line’s offer, in one query, scoped to the company', () => {
    /*
     * Scoped: an id from another tenant must resolve to nothing rather
     * than to somebody else's bundle — which would let a crafted request
     * price an order from a stranger's offer.
     */
    const src = door();
    expect(src, 'الباب لسّا بيقرا العرض من فوق بس').toMatch(/requestedLines\.map\(\(l\) => l\.offerId\)/);
    expect(src).toMatch(/findMany\(\{\s*where: \{ id: \{ in: lineOfferIds \}, companyId \}/);
  });

  it('and the gift reaches the line, ONE PER BUNDLE — through `giftUnits`, the one rule', () => {
    // 22/10 — this pinned «per unit of the line» (`freeFor(line) * line.quantity`): an offer giving one free gave three on a
    // line of three, so a typed «3 + 1» was stored 3 + 3. The gift is one per bundle, as the storefront door counts it
    // (`offer.freeQuantity × count`); `offer-gift.test.ts` holds the two equal.
    const src = door();
    expect(src).toMatch(/freeQuantity: giftOf\(line\)/);
    expect(src, 'عاد الضربُ بعددِ القطع').not.toMatch(/freeFor|freeQuantity[^;]*\*\s*line\.quantity/);
  });

  it('and the gift is costed, because a free unit is free to the CUSTOMER only', () => {
    /*
     * It is a unit off the shelf like any other. Costing only
     * `l.quantity` made the profit on every bundle look better than it
     * was, by exactly the cost of what was given away.
     */
    const src = door();
    const cost = src.slice(src.indexOf('estimatedCostOfGoods'));
    expect(cost.slice(0, 400), 'التكلفة بتتجاهل الهديّة').toContain('giftOf(l)');
  });

  it('and ANY line that includes delivery makes the whole order include it', () => {
    /*
     * One parcel, one delivery fee or none — the rule the storefront door
     * already applies. Asking it per line would have to answer «half the
     * order is delivery-inclusive», which no courier can collect.
     */
    const src = door();
    // (old → new, 1/11) «any line includes» is read by `offersSayDeliveryIncluded` — shared by every door — which is also where an
    // offer's «no» is heard. The door hands it one entry per line (and the top-level offer of the single-product shorthand).
    expect(src).toMatch(/offersSayDeliveryIncluded\(/);
    /*
     * ⚠️ AND IT IS PASSED TO THE RULE, NOT MERELY COMPUTED.
     *
     * The first version of this claim asserted only that the name
     * existed. A mutation that removed the argument from
     * `priceIncludesDeliveryFor` left the declaration standing, and the
     * claim passed — a guard that watched a variable be born and never
     * asked whether anybody used it. Found by breaking the fix on
     * purpose, which is the only way that kind of claim is ever found.
     */
    const call = src.slice(src.indexOf('priceIncludesDeliveryFor('));
    expect(call.slice(0, 500), 'محسوب وما بينمرّر للقاعدة').toContain('offersSayDeliveryIncluded(');
    expect(call.slice(0, 500), 'سطور الطلب كلها بتنقرأ').toContain('requestedLines.map(');
  });

  it('and the order records which bundle sold it', () => {
    expect(door()).toMatch(/offerId: offerId \|\| requestedLines\.find\(\(l\) => l\.offerId\)\?\.offerId \|\| null/);
  });
});

describe('and an edit does not throw the gift away', () => {
  it('— the lines are replaced, and what they held is carried over', () => {
    /*
     * Replacing the lines wholesale is right: a product removed from the
     * screen is removed from the order. But the new rows were built with
     * no `freeQuantity`, so the column was silently reset to zero — and
     * an order that came from a landing page WITH a gift lost it the
     * first time anybody touched its lines. That is during confirmation,
     * which is to say: on the way to almost every order that carried one.
     */
    const src = edit();
    expect(src, 'التعديل لسّا بيمسح الهديّة').toMatch(/giftByProduct/);
    /*
     * Per PRODUCT, summed, and given once. `giftByProduct.get(…) ?? 0` on
     * every new line let the last stored row of a product decide and copied
     * it onto each line of it — a gift lost or doubled by row order. What the
     * rows hold is added up, the product's first line gets the sum, and the
     * key goes so its other lines start at none. The behaviour itself is
     * held in `[id]/the-lines-save-again.test.ts` (Ⅵ).
     */
    expect(src).toMatch(/\(giftByProduct\.get\(it\.productId\) \?\? 0\) \+ it\.freeQuantity/);
    expect(src, 'الهديّة بتنعطى لكل سطر من المنتج').toMatch(/giftByProduct\.delete\(line\.productId\)/);
    expect(src).toMatch(/freeQuantity: gifts\[i\]/);
  });

  it('and it is carried, never re-derived — this door binds no offer', () => {
    // Its item schema has no `offerId`, so deriving a gift afresh would
    // be inventing one. A product that was not on the order before starts
    // at none.
    const src = edit();
    const items = src.slice(src.indexOf('  items: z'), src.indexOf('  items: z') + 400);
    expect(items, 'باب التعديل صار بيربط عرضاً بلا ما حدا يقرّر').not.toContain('offerId');
  });
});

describe('and the AI door asks the store what its prices mean', () => {
  it('— it wrote nothing, so every order through it took the schema default', () => {
    /*
     * `priceIncludesDelivery` defaults to `false`. A shop whose prices
     * are advertised delivery-inclusive therefore had the fee added
     * again at shipment, on every order pasted in through this door.
     */
    const src = stripComments(repoFile('src/app/api/orders/ai-intake/route.ts'));
    // Was `priceIncludesDeliveryFor(storeId)` alone. RV172: the door now binds the bundle whose quantity the paste
    // matches, so it passes that bundle's `deliveryIncluded` as the manual door does — the question to the store is
    // still asked, with one more thing it may only turn ON. `an-offer-pasted-is-the-offer-typed.test.ts` drives it.
    // 1/11: the reviewer's own box («شامل التوصيل») is her word for the order when it is sent; the question to the store
    // is what is asked when it is NOT sent, so it is still there, unchanged — as the fallback of the box.
    expect(src, 'باب الذكاء لسّا ما بيسأل عن سياسة المتجر').toContain(
      ': await priceIncludesDeliveryFor(storeId, quantityOffer?.deliveryIncluded)'
    );
    expect(src, 'خانة «شامل التوصيل» ما بتُقرأ').toContain("typeof p.priceIncludesDelivery === 'boolean'");
  });
});

describe('and the screen can show what it is about to send', () => {
  it('— the offers the dialog reads carry their gift', () => {
    // Without the column the dialog could not show a gift, and the line
    // it sent carried none: «٣+١» reached the warehouse as three.
    const src = stripComments(repoFile('src/app/api/products/route.ts'));
    const offers = src.slice(src.indexOf('offers: {'));
    // 900, not 300: `stripComments` blanks a comment in place rather
    // than removing it, so the explanation above the field counts toward
    // the window.
    expect(offers.slice(0, 900)).toContain('freeQuantity: true');
  });

  it('and the picker names it, so it is not a surprise in the warehouse', () => {
    const src = repoFile('src/components/orders/ProductLinesEditor.tsx');
    expect(src).toContain('هدية');
  });
});
