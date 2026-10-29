import { describe, expect, it } from 'vitest';
import { computeCod, roundMinor } from './money';
import { repoFile, stripComments } from './guard-source';

/**
 * «العرض ع ٣ بـ١٠ بنحصّل ع ١٠. إذا قطعة بنحسب ثمن قطعة عدد صحيح.»
 *
 * The owner's rule, and it settles a conflict I had reported as unresolvable:
 * a total that does not divide evenly cannot be `quantity × unitPrice` at any
 * number of decimals, so somebody must absorb the remainder. The answer is
 * that nobody does — because the unit price must not be rounded at all.
 *
 * The division carries its own precision and the PRODUCT is what gets
 * rounded. 10 ÷ 3 is 3.3333333333333335; multiplied by three it is
 * 10.000000000000002; rounded to the currency it is exactly 10. Round the
 * unit price first and you get 3.333 and a total of 9.999 — a fils lost to
 * arithmetic nobody asked for.
 *
 * I had this wrong twice in one day: the Telegram door rounded to two
 * decimals, I "fixed" it to round by the currency, and both are wrong in the
 * same way. The offers door never rounded, which is why it was always right.
 */

const JOD = 3; // minorUnit in this database

describe('what was advertised is what is collected', () => {
  it('three for ten collects ten, not 9.999', () => {
    const money = computeCod({
      lines: [{ quantity: 3, unitPrice: 10 / 3 }],
      deliveryFee: 0,
      minorUnit: JOD,
    });
    expect(money.cod).toBe(10);
  });

  it('and rounding the unit price first is what loses the fils', () => {
    // The shape of the bug, kept so the reason is visible rather than
    // remembered: both of these were shipped at some point today.
    const roundedByCurrency = computeCod({
      lines: [{ quantity: 3, unitPrice: roundMinor(10 / 3, JOD) }],
      deliveryFee: 0,
      minorUnit: JOD,
    });
    expect(roundedByCurrency.cod).toBe(9.999);

    const roundedToTwo = computeCod({
      lines: [{ quantity: 3, unitPrice: Number((10 / 3).toFixed(2)) }],
      deliveryFee: 0,
      minorUnit: JOD,
    });
    expect(roundedToTwo.cod).toBe(9.99);
  });

  it('a single piece is its own whole price', () => {
    // «إذا قطعة بنحسب ثمن قطعة عدد صحيح».
    const money = computeCod({ lines: [{ quantity: 1, unitPrice: 14 / 1 }], deliveryFee: 0, minorUnit: JOD });
    expect(money.cod).toBe(14);
  });

  it('and it holds for the awkward divisions, not just the famous one', () => {
    for (const [total, qty] of [[10, 3], [100, 7], [25, 6], [1, 3], [37.5, 4], [14, 3]] as const) {
      const money = computeCod({
        lines: [{ quantity: qty, unitPrice: total / qty }],
        deliveryFee: 0,
        minorUnit: JOD,
      });
      expect(money.cod, `${total} ÷ ${qty}`).toBe(total);
    }
  });

  it('the delivery fee still lands on top of it, unrounded away', () => {
    const money = computeCod({
      lines: [{ quantity: 3, unitPrice: 10 / 3 }],
      deliveryFee: 2.5,
      minorUnit: JOD,
    });
    expect(money.cod).toBe(12.5);
  });
});

describe('every door divides the same way', () => {
  it('the offers door never rounds a derived unit price', () => {
    const src = stripComments(repoFile('src/lib/public-order.ts'));
    /*
     * The division that makes a bundle total into a unit price, and it must
     * stay unrounded: `roundMinor(10/3) * 3` is not 10, which is the whole
     * of this section.
     *
     * It divides `listTotal` now, not `offer.price`. `OfferView.price`
     * became the figure the customer is CHARGED, so dividing it would hand
     * `computeCod` a unit price with the reduction already inside and the
     * reduction would be taken twice — 19 for a bundle promising 22.
     * `listTotal` is the bundle before its own reduction, which is what
     * `computeCod` is built to be given.
     */
    expect(src).toContain('const unitPrice = offer ? listTotal / offer.quantity : p.basePrice;');
    expect(src).not.toMatch(/roundMinor\(\s*listTotal/);
    expect(src).not.toMatch(/roundMinor\(\s*offer\.price/);
    expect(src).not.toMatch(/listTotal \/ offer\.quantity\)\.toFixed/);
    // And the figure it is derived FROM is the pre-discount one, not the
    // charged one — the difference between 12.5 a piece and 11.
    expect(src).toContain('const listTotal = offer ? offer.listPrice ?? offer.price : p.basePrice;');
  });

  it('and the offer view rounds the CHARGED total, which is not an intermediate', () => {
    /*
     * Not rounding a derived unit price is not «stop rounding». `price` on
     * the view is money a customer is shown and charged, so it is rounded
     * once, by the order's own currency — the same distinction the Telegram
     * door's test below draws between an intermediate and a written figure.
     */
    const src = stripComments(repoFile('src/lib/offers.ts'));
    expect(src).toContain('const charged = roundMinor(o.sellingPrice - taken, minorUnit);');
    // And the reduction itself comes from the one place that allocates it.
    expect(src).toMatch(/allocateDiscount\(/);
  });

  it('and the Telegram door does not either — its unit price is the offer’s, unrounded, from the storefront’s own function', () => {
    // 29/10: the message's offer text is bound to a real offer (28/10: «نص العرض مربوط بالعرض»), so the unit price is no longer
    // `total / quantity` computed here: it is `ResolvedLine.unitPrice` from `resolvePublicLines`, the line asserted above.
    const src = stripComments(repoFile('src/lib/telegram/order-creation.ts'));
    expect(src).not.toContain('const price = totalAmount / quantity;');
    expect(src).toContain('unitPrice: line.unitPrice');
    expect(src).not.toMatch(/unitPrice: roundMinor/);
    expect(src).not.toMatch(/const price = roundMinor/);
    expect(src).not.toMatch(/const price = Number\(\(totalAmount/);
    const door = stripComments(repoFile('src/lib/telegram/inbound.ts'));
    expect(door).toMatch(/resolvePublicLines\(/);
  });

  it('while the money that is WRITTEN is still rounded by the currency', () => {
    // Not rounding the unit price is not «stop rounding». The cost of goods,
    // the add-on's total and every stored figure still go through
    // `roundMinor` — it is the derived intermediate that must keep its
    // precision until the multiplication is done. The WRITTEN price is read by the currency's own places, in the door.
    const src = stripComments(repoFile('src/lib/telegram/order-creation.ts'));
    expect(src).toMatch(/estimatedCostOfGoods = roundMinor\(/);
    expect(src).toMatch(/minorUnit: store\.country\.minorUnit|priceTelegramLine\(line, store\.country\.minorUnit\)/);
    const door = stripComments(repoFile('src/lib/telegram/inbound.ts'));
    expect(door).toContain('parseAdvertisedPrice(priceText, country.minorUnit)');
  });
});
