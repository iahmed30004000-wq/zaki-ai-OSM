import { describe, expect, it } from 'vitest';
import { computeCod } from './money';
import {
  MAX_EDIT_LINES,
  PROBLEM_CODES,
  doorOf,
  lineEditsSchema,
  previewDraftSchema,
  previewLineEdit,
  priceOrderLines,
  resolveLineEdits,
  stockEffect,
  suggestGift,
  suggestPrice,
  type LineEditInput,
  type OfferFact,
  type OrderEditFacts,
  type PreviewDraft,
  type PricingContext,
  type ProductFact,
  type StoredLine,
} from './order-line-edit';
import { repoFile, stripComments } from './guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE LINES ENGINE — what editing several fields of an order at once means.
 *
 * «الكمية أكيد بتتطلب أغير معها السعر… بدي تعمل بمنطق تحلل وبذكاء، والأهم بدون ما تخرب».
 *
 * Every figure below is worked by hand in the comment beside it, in the three currencies this system holds (JOD three
 * places, USD two, SYP none). The engine takes its facts as arguments, so these tests hand it any order they like and
 * the last block proves it cannot reach a database.
 * ═══════════════════════════════════════════════════════════════════════
 */

const CREAM = 'prod-cream-0001';
const SOAP = 'prod-soap-00002';
const DROPS = 'prod-drops-0003';

const line = (over: Partial<StoredLine> & { id: string }): StoredLine => ({
  productId: CREAM,
  productName: 'كريم',
  quantity: 3,
  freeQuantity: 0,
  lineTotal: 36,
  reservedQty: 0,
  deliveredQty: null,
  returnedQty: null,
  ...over,
});

const product = (id: string, name: string, basePrice: number, status = 'ACTIVE'): ProductFact => ({ id, name, basePrice, status });

/** «3 + 1 مجاناً بـ 25»: the bundle, on sale. */
const BUNDLE: OfferFact = {
  id: 'offer-3-plus-1',
  productId: CREAM,
  name: '3 + 1',
  quantity: 3,
  freeQuantity: 1,
  listPrice: 25,
  price: 25,
  live: true,
};

const ctxOf = (over: Partial<PricingContext> = {}): PricingContext => ({
  minorUnit: 3,
  products: new Map([
    [CREAM, product(CREAM, 'كريم', 12)],
    [SOAP, product(SOAP, 'صابون', 5)],
    [DROPS, product(DROPS, 'قطرة', 8.5)],
  ]),
  offers: [],
  orderOffer: null,
  orderDiscount: 0,
  ...over,
});

const edit = (lineId: string, rest: Omit<LineEditInput, 'lineId'> = {}): LineEditInput => ({ lineId, ...rest });

const resolve = (stored: StoredLine[], edits: LineEditInput[], over: Partial<PricingContext> = {}) =>
  resolveLineEdits(stored, edits, ctxOf(over));

const codes = (r: { problems: { code: string }[] }) => r.problems.map((p) => p.code);

/* ─────────────────────────── 1 · the money: one wrapper over computeCod ─────────────────────────── */

describe('Ⅰ · the money of a set of lines is computeCod, called the way the lines save calls it', () => {
  const base = {
    discount: 2.5,
    deliveryFee: 2.5,
    priceIncludesDelivery: false,
    addOns: [] as { quantity: number; price: number }[],
  };

  it('JOD, three places — 25 for three and 10 for two, 2.500 off, 2.500 to deliver', () => {
    const priced = priceOrderLines({
      ...base,
      lines: [
        { quantity: 3, lineTotal: 25, freeQuantity: 1 },
        { quantity: 2, lineTotal: 10, freeQuantity: 0 },
      ],
      minorUnit: 3,
    });
    // subtotal 35.000; shares 25/35 × 2.5 = 1.786 and 10/35 × 2.5 = 0.714 (sum 2.500); cod 35 − 2.5 + 2.5.
    expect(priced.totals.subtotal).toBe(35);
    expect(priced.totals.discountShares).toEqual([1.786, 0.714]);
    expect(priced.money.lineTotals).toEqual([23.214, 9.286]);
    expect(priced.totals.cod).toBe(35);
    expect(priced.totals.giftUnits).toBe(1);
  });

  it('USD, two places — the same lines come to the same dollars, and the shares still add up', () => {
    const priced = priceOrderLines({
      ...base,
      lines: [
        { quantity: 3, lineTotal: 25, freeQuantity: 0 },
        { quantity: 2, lineTotal: 10, freeQuantity: 0 },
      ],
      minorUnit: 2,
    });
    // 25/35 × 2.5 = 1.7857 → 1.79 and 0.7143 → 0.71; 1.79 + 0.71 = 2.50.
    expect(priced.totals.discountShares).toEqual([1.79, 0.71]);
    expect(priced.totals.discount).toBe(2.5);
    expect(priced.totals.cod).toBe(35);
  });

  it('SYP, no minor unit — every share is a whole pound and the remainder lands on the largest line', () => {
    const priced = priceOrderLines({
      lines: [
        { quantity: 3, lineTotal: 100, freeQuantity: 0 },
        { quantity: 2, lineTotal: 50, freeQuantity: 0 },
      ],
      discount: 7,
      deliveryFee: 10,
      priceIncludesDelivery: false,
      addOns: [],
      minorUnit: 0,
    });
    // 100/150 × 7 = 4.67 → 5 and 50/150 × 7 = 2.33 → 2: seven, exactly. cod = 150 − 7 + 10.
    expect(priced.totals.discountShares).toEqual([5, 2]);
    expect(priced.totals.cod).toBe(153);
  });

  it('is computeCod itself — the same call gives the same breakdown', () => {
    const lines = [
      { quantity: 3, lineTotal: 25, freeQuantity: 0 },
      { quantity: 5, lineTotal: 41.667, freeQuantity: 0 },
    ];
    const priced = priceOrderLines({ ...base, lines, minorUnit: 3 });
    const direct = computeCod({
      lines: lines.map((l) => ({ quantity: l.quantity, unitPrice: l.lineTotal / l.quantity })),
      discount: 2.5,
      deliveryFee: 2.5,
      priceIncludesDelivery: false,
      minorUnit: 3,
      addOns: [],
    });
    expect(priced.money).toEqual(direct);
  });

  it('the add-ons the customer accepted are collected and are NOT discounted', () => {
    const withAddOn = priceOrderLines({
      ...base,
      lines: [{ quantity: 3, lineTotal: 36, freeQuantity: 0 }],
      addOns: [{ quantity: 2, price: 4 }],
      minorUnit: 3,
    });
    const without = priceOrderLines({ ...base, lines: [{ quantity: 3, lineTotal: 36, freeQuantity: 0 }], minorUnit: 3 });
    // 36 − 2.5 + 8 + 2.5 = 44, and the discount is the same 2.500 with or without them.
    expect(withAddOn.totals.addOns).toBe(8);
    expect(withAddOn.totals.cod).toBe(44);
    expect(withAddOn.totals.discount).toBe(without.totals.discount);
  });

  it('a price that includes delivery: the fee is not added to the customer and comes off the revenue', () => {
    const priced = priceOrderLines({
      ...base,
      lines: [{ quantity: 3, lineTotal: 36, freeQuantity: 0 }],
      priceIncludesDelivery: true,
      minorUnit: 3,
    });
    expect(priced.totals.cod).toBe(33.5);
    expect(priced.totals.revenue).toBe(31);
  });
});

/* ─────────────────────────── 2 · the suggested price ─────────────────────────── */

describe('Ⅱ · a changed quantity gets numbered answers, and a default', () => {
  it('KEEP_UNIT is the default: 36 for three is 60 for five', () => {
    const l = line({ id: 'l1' });
    const options = suggestPrice(l, { productId: CREAM, quantity: 5 }, ctxOf());
    const keep = options.find((o) => o.basis === 'KEEP_UNIT')!;
    expect(keep.lineTotal).toBe(60);
    expect(keep.isDefault).toBe(true);
    expect(keep.delta).toBe(24);
    expect(options.filter((o) => o.isDefault)).toHaveLength(1);
  });

  it('«٣ بـ٢٥» keeps its figure whole: 25 for three is 50 for six, 41.667 for five at three places and 41.67 at two', () => {
    const l = line({ id: 'l1', lineTotal: 25 });
    const at = (n: number, minorUnit: number) =>
      suggestPrice(l, { productId: CREAM, quantity: n }, ctxOf({ minorUnit })).find((o) => o.basis === 'KEEP_UNIT')!.lineTotal;
    expect(at(6, 3)).toBe(50);
    expect(at(5, 3)).toBe(41.667);
    expect(at(5, 2)).toBe(41.67);
    // never 24.999 for the same three it started with
    expect(at(3, 3)).toBe(25);
  });

  it('a quantity that did not move keeps the stored total exactly, however it rounds', () => {
    const r = resolve([line({ id: 'l1', lineTotal: 25 })], [edit('l1', { quantity: 3 })]);
    expect(r.lines[0].lineTotal).toEqual({ from: 25, to: 25 });
    expect(r.lines[0].changed).toBe(false);
  });

  it('OFFER is the default only when the old line was priced by the order’s own offer', () => {
    const l = line({ id: 'l1', lineTotal: 25, freeQuantity: 1 });
    const priced = suggestPrice(l, { productId: CREAM, quantity: 6 }, ctxOf({ offers: [BUNDLE], orderOffer: BUNDLE }));
    const offer = priced.find((o) => o.basis === 'OFFER')!;
    expect(offer.lineTotal).toBe(50);
    expect(offer.offerId).toBe(BUNDLE.id);
    expect(offer.isDefault).toBe(true);
    expect(priced.find((o) => o.basis === 'KEEP_UNIT')!.isDefault).toBe(false);

    // The same line priced by hand (30, not 25): the bundle is offered, KEEP_UNIT stays the default.
    const byHand = suggestPrice(line({ id: 'l1', lineTotal: 30, freeQuantity: 1 }), { productId: CREAM, quantity: 6 }, ctxOf({ offers: [BUNDLE], orderOffer: BUNDLE }));
    expect(byHand.find((o) => o.basis === 'OFFER')!.isDefault).toBe(false);
    expect(byHand.find((o) => o.basis === 'KEEP_UNIT')!.isDefault).toBe(true);
    expect(byHand.find((o) => o.basis === 'KEEP_UNIT')!.lineTotal).toBe(60);
  });

  it('an offer is offered only for a whole number of its bundles', () => {
    const l = line({ id: 'l1', lineTotal: 25, freeQuantity: 1 });
    const none = suggestPrice(l, { productId: CREAM, quantity: 7 }, ctxOf({ offers: [BUNDLE], orderOffer: BUNDLE }));
    expect(none.some((o) => o.basis === 'OFFER')).toBe(false);
    expect(none.find((o) => o.isDefault)!.basis).toBe('KEEP_UNIT');
  });

  it('an ended offer is never priced from', () => {
    const ended = { ...BUNDLE, live: false };
    const l = line({ id: 'l1', lineTotal: 25, freeQuantity: 1 });
    const opts = suggestPrice(l, { productId: CREAM, quantity: 6 }, ctxOf({ offers: [], orderOffer: ended }));
    expect(opts.some((o) => o.basis === 'OFFER')).toBe(false);
  });

  it('BASE_PRICE is offered when the product has one, and is never the default; MANUAL carries no figure', () => {
    const opts = suggestPrice(line({ id: 'l1' }), { productId: CREAM, quantity: 5 }, ctxOf());
    const base = opts.find((o) => o.basis === 'BASE_PRICE')!;
    expect(base.lineTotal).toBe(60);
    expect(base.isDefault).toBe(false);
    const manual = opts.find((o) => o.basis === 'MANUAL')!;
    expect(manual.lineTotal).toBeNull();
    expect(manual.delta).toBeNull();
    // A product with no catalogue price has no such answer.
    const free = suggestPrice(line({ id: 'l1' }), { productId: CREAM, quantity: 5 }, ctxOf({ products: new Map([[CREAM, product(CREAM, 'كريم', 0)]]) }));
    expect(free.some((o) => o.basis === 'BASE_PRICE')).toBe(false);
  });
});

/* ─────────────────────────── 3 · resolving a draft ─────────────────────────── */

describe('Ⅲ · a quantity and a price edited together', () => {
  it('quantity alone re-prices at the line’s own piece price', () => {
    const r = resolve([line({ id: 'l1' })], [edit('l1', { quantity: 5 })]);
    expect(r.lines[0]).toMatchObject({
      changed: true,
      quantity: { from: 3, to: 5 },
      lineTotal: { from: 36, to: 60 },
      unitPrice: { from: 12, to: 12 },
      basis: 'KEEP_UNIT',
    });
  });

  it('quantity AND a typed unit price: the price is the person’s, labelled «يدوي»', () => {
    const r = resolve([line({ id: 'l1' })], [edit('l1', { quantity: 5, unitPrice: 11.6 })]);
    // 5 × 11.6 = 58 — the typed piece price, rounded once to the currency.
    expect(r.lines[0]).toMatchObject({ lineTotal: { from: 36, to: 58 }, basis: 'MANUAL' });
  });

  it('a typed LINE TOTAL is taken whole, with no piece price to drift: 25 for six pieces stays 25', () => {
    const r = resolve([line({ id: 'l1', lineTotal: 25 })], [edit('l1', { quantity: 6, lineTotal: 25 })]);
    expect(r.lines[0].lineTotal.to).toBe(25);
    expect(r.lines[0].unitPrice.to).toBe(4.167);
  });

  it('a unit price on a three-place currency rounds the line once: 3 × 8.333 is 24.999, not 25', () => {
    const r = resolve([line({ id: 'l1' })], [edit('l1', { unitPrice: 8.333 })]);
    expect(r.lines[0].lineTotal.to).toBe(24.999);
  });

  it('a basis claimed for a typed price is believed only if it reproduces the number', () => {
    const stored = [line({ id: 'l1', lineTotal: 25, freeQuantity: 1 })];
    const honest = resolve(stored, [edit('l1', { quantity: 6, lineTotal: 50, priceBasis: 'OFFER' })], { offers: [BUNDLE], orderOffer: BUNDLE });
    expect(honest.lines[0]).toMatchObject({ basis: 'OFFER', offerId: BUNDLE.id });
    const lying = resolve(stored, [edit('l1', { quantity: 6, lineTotal: 40, priceBasis: 'OFFER' })], { offers: [BUNDLE], orderOffer: BUNDLE });
    expect(lying.lines[0]).toMatchObject({ basis: 'MANUAL', offerId: null });
  });

  it('a chosen basis without a typed price takes that basis’s number', () => {
    const r = resolve([line({ id: 'l1' })], [edit('l1', { quantity: 5, priceBasis: 'BASE_PRICE' })]);
    expect(r.lines[0]).toMatchObject({ lineTotal: { to: 60 }, basis: 'BASE_PRICE' });
  });

  it('a basis that cannot be priced is refused — the line keeps the default figure so the screen can still draw', () => {
    const noOffer = resolve([line({ id: 'l1' })], [edit('l1', { quantity: 5, priceBasis: 'OFFER' })]);
    expect(codes(noOffer)).toContain('BASIS_UNAVAILABLE');
    expect(noOffer.problems.find((p) => p.code === 'BASIS_UNAVAILABLE')!.blocking).toBe(true);
    expect(noOffer.lines[0].lineTotal.to).toBe(60);
    const manualNoNumber = resolve([line({ id: 'l1' })], [edit('l1', { quantity: 5, priceBasis: 'MANUAL' })]);
    expect(codes(manualNoNumber)).toContain('BASIS_UNAVAILABLE');
  });

  it('every stored line comes back in its stored order, edited or not', () => {
    const stored = [line({ id: 'a', quantity: 3 }), line({ id: 'b', productId: SOAP, quantity: 2, lineTotal: 10 })];
    const r = resolve(stored, [edit('b', { quantity: 4 })]);
    expect(r.lines.map((l) => l.lineId)).toEqual(['a', 'b']);
    expect(r.lines[0].changed).toBe(false);
    expect(r.lines[1]).toMatchObject({ changed: true, lineTotal: { from: 10, to: 20 } });
  });

  it('a product swap re-prices at the old piece price and warns when it is far from the new product’s catalogue price', () => {
    // 36 for 3 is 12 each; DROPS costs 8.5 — 12 is within 2× and above half, so no warning…
    const ok = resolve([line({ id: 'l1' })], [edit('l1', { productId: DROPS })]);
    expect(ok.lines[0]).toMatchObject({ productId: { from: CREAM, to: DROPS }, productName: 'قطرة', lineTotal: { to: 36 } });
    expect(codes(ok)).not.toContain('PRICE_FAR_FROM_BASE');
    // …but 36 for 3 on a product whose catalogue price is 2 is six times it.
    const far = resolveLineEdits([line({ id: 'l1' })], [edit('l1', { productId: DROPS })], ctxOf({ products: new Map([[DROPS, product(DROPS, 'قطرة', 2)]]) }));
    expect(codes(far)).toContain('PRICE_FAR_FROM_BASE');
    expect(far.problems.find((p) => p.code === 'PRICE_FAR_FROM_BASE')!.blocking).toBe(false);
  });

  it('a product that is not in the company is refused; one that is switched off is only warned about', () => {
    const missing = resolve([line({ id: 'l1' })], [edit('l1', { productId: 'prod-unknown-001' })]);
    expect(missing.problems.find((p) => p.code === 'PRODUCT_UNAVAILABLE')!.blocking).toBe(true);
    const off = resolveLineEdits([line({ id: 'l1' })], [edit('l1', { productId: DROPS })], ctxOf({ products: new Map([[DROPS, product(DROPS, 'قطرة', 8.5, 'INACTIVE')]]) }));
    // a switched-off product is not «not found»: its own code, its own sentence, and it does not stop the request
    const inactive = off.problems.find((p) => p.code === 'PRODUCT_INACTIVE')!;
    expect(inactive.blocking).toBe(false);
    expect(inactive.messageAr).toContain('معطّل');
    expect(inactive.messageAr).not.toContain('مش موجود');
    expect(codes(off)).not.toContain('PRODUCT_UNAVAILABLE');
    expect(missing.problems.find((p) => p.code === 'PRODUCT_UNAVAILABLE')!.messageAr).toContain('مش موجود');
  });

  it('a price far below half or above double the catalogue price warns; 0 on a paid line is refused', () => {
    const cheap = resolve([line({ id: 'l1' })], [edit('l1', { unitPrice: 5 })]);
    expect(codes(cheap)).toContain('PRICE_FAR_FROM_BASE');
    const dear = resolve([line({ id: 'l1' })], [edit('l1', { unitPrice: 25 })]);
    expect(codes(dear)).toContain('PRICE_FAR_FROM_BASE');
    const fine = resolve([line({ id: 'l1' })], [edit('l1', { unitPrice: 13 })]);
    expect(codes(fine)).not.toContain('PRICE_FAR_FROM_BASE');
    const zero = resolve([line({ id: 'l1' })], [edit('l1', { lineTotal: 0 })]);
    expect(zero.problems.find((p) => p.code === 'ZERO_PRICE')!.blocking).toBe(true);
  });
});

describe('Ⅳ · two lines of one product are two lines', () => {
  const stored = [
    line({ id: 'first', quantity: 2, lineTotal: 24, freeQuantity: 0 }),
    line({ id: 'second', quantity: 4, lineTotal: 40, freeQuantity: 0 }),
  ];

  it('an edit reaches the line it names and no other', () => {
    const r = resolve(stored, [edit('second', { quantity: 6 })]);
    expect(r.lines[0]).toMatchObject({ lineId: 'first', changed: false, quantity: { to: 2 }, lineTotal: { to: 24 } });
    // 40 for four is 10 each: six is 60.
    expect(r.lines[1]).toMatchObject({ lineId: 'second', changed: true, quantity: { to: 6 }, lineTotal: { to: 60 } });
  });

  it('both edited at once keep their own prices', () => {
    const r = resolve(stored, [edit('first', { quantity: 3 }), edit('second', { quantity: 2 })]);
    expect(r.lines[0].lineTotal.to).toBe(36);
    expect(r.lines[1].lineTotal.to).toBe(20);
  });

  it('a line id the order does not hold is refused, not matched by product', () => {
    const r = resolve(stored, [edit('ghost', { productId: CREAM, quantity: 9 })]);
    expect(r.problems.find((p) => p.code === 'UNKNOWN_LINE')).toMatchObject({ blocking: true, lineId: 'ghost' });
    expect(r.lines.every((l) => !l.changed)).toBe(true);
  });

  it('a line named twice is refused', () => {
    const r = resolve(stored, [edit('first', { quantity: 3 }), edit('first', { quantity: 4 })]);
    expect(r.problems.find((p) => p.code === 'DUPLICATE_LINE_EDIT')!.blocking).toBe(true);
    // the first answer stands; the second is not silently applied over it
    expect(r.lines[0].quantity.to).toBe(3);
  });

  it('swapping one line onto the product the other already holds is allowed', () => {
    const r = resolve([line({ id: 'a' }), line({ id: 'b', productId: SOAP, quantity: 2, lineTotal: 10 })], [edit('b', { productId: CREAM })]);
    expect(r.lines.map((l) => l.productId.to)).toEqual([CREAM, CREAM]);
    expect(r.problems.filter((p) => p.blocking)).toEqual([]);
  });
});

describe('Ⅴ · a line already delivered or returned is a record, not a draft', () => {
  it('any lines edit is refused while a line of the order is settled', () => {
    const stored = [line({ id: 'a', deliveredQty: 3 }), line({ id: 'b', productId: SOAP, quantity: 2, lineTotal: 10 })];
    const r = resolve(stored, [edit('b', { quantity: 3 })]);
    expect(r.problems.find((p) => p.code === 'LINE_SETTLED')).toMatchObject({ blocking: true, lineId: 'a' });
    expect(codes(resolve([line({ id: 'a', returnedQty: 1 })], [edit('a', { quantity: 2 })]))).toContain('LINE_SETTLED');
  });

  it('and nothing is said when the draft touches no line', () => {
    expect(codes(resolve([line({ id: 'a', deliveredQty: 3 })], []))).toEqual([]);
  });
});

/* ─────────────────────────── 4 · the gift ─────────────────────────── */

describe('Ⅵ · the gift follows the order’s offer, by whole bundles — and only then', () => {
  const offerLine = line({ id: 'l1', quantity: 3, freeQuantity: 1, lineTotal: 25 });
  const withOffer = { offers: [BUNDLE], orderOffer: BUNDLE };

  it('3 → 6 on a «3 + 1»: the gift goes 1 → 2, the price 25 → 50', () => {
    const r = resolve([offerLine], [edit('l1', { quantity: 6 })], withOffer);
    expect(r.lines[0]).toMatchObject({ freeQuantity: { from: 1, to: 2 }, lineTotal: { to: 50 }, basis: 'OFFER', offerId: BUNDLE.id });
    expect(r.problems).toEqual([]);
  });

  it('3 → 2: below one bundle there is no gift and no offer price (the gift goes 1 → 0, the piece price is kept)', () => {
    const r = resolve([offerLine], [edit('l1', { quantity: 2 })], withOffer);
    expect(r.lines[0]).toMatchObject({ freeQuantity: { from: 1, to: 0 }, basis: 'KEEP_UNIT' });
    expect(r.lines[0].lineTotal.to).toBe(16.667);
    expect(codes(r)).toContain('QTY_BELOW_OFFER_MIN');
    expect(r.problems.find((p) => p.code === 'QTY_BELOW_OFFER_MIN')!.blocking).toBe(false);
  });

  it('7 on a «3 + 1»: two whole bundles earn two gifts — the seventh piece is an ordinary one', () => {
    const r = resolve([offerLine], [edit('l1', { quantity: 7 })], withOffer);
    expect(r.lines[0].freeQuantity).toEqual({ from: 1, to: 2 });
    expect(codes(r)).toContain('QTY_NOT_BUNDLE');
    // no offer price for a quantity that is not whole bundles: the piece price (25/3) × 7
    expect(r.lines[0]).toMatchObject({ basis: 'KEEP_UNIT' });
    expect(r.lines[0].lineTotal.to).toBe(58.333);
  });

  it('suggestGift states what it did, in three cases', () => {
    expect(suggestGift(offerLine, { productId: CREAM, quantity: 9 }, BUNDLE, 3)).toEqual({ value: 3, derived: true, warn: null });
    // not the offer's line: the gift stays and says so
    const stranger = line({ id: 'x', quantity: 3, freeQuantity: 2, lineTotal: 25 });
    expect(suggestGift(stranger, { productId: CREAM, quantity: 6 }, BUNDLE, 3)).toEqual({ value: 2, derived: false, warn: 'GIFT_NOT_RESCALED' });
    // a line with no gift and no offer has nothing to say
    expect(suggestGift(line({ id: 'y' }), { productId: CREAM, quantity: 6 }, null, 3)).toEqual({ value: 0, derived: false, warn: null });
    // the quantity did not move: nothing is touched
    expect(suggestGift(offerLine, { productId: CREAM, quantity: 3 }, BUNDLE, 3)).toEqual({ value: 1, derived: false, warn: null });
  });

  it('NO GIFT IS INVENTED: two pieces with no gift on a «3 + 1» order, raised to six, get none — and are told why', () => {
    // «0 = 0» is true of any line shorter than a bundle; it was never bought as the offer.
    const two = line({ id: 'l1', quantity: 2, freeQuantity: 0, lineTotal: 24 });
    const r = resolve([two], [edit('l1', { quantity: 6 })], withOffer);
    expect(r.lines[0].freeQuantity).toEqual({ from: 0, to: 0 });
    expect(codes(r)).toContain('GIFT_NOT_RESCALED');
    // and the price is the piece price (12 × 6), not the bundle's
    expect(r.lines[0]).toMatchObject({ lineTotal: { to: 72 }, basis: 'KEEP_UNIT' });
    expect(suggestGift(two, { productId: CREAM, quantity: 6 }, BUNDLE, 3)).toEqual({ value: 0, derived: false, warn: 'GIFT_NOT_RESCALED' });
  });

  it('nor for a line of a whole bundle that was priced by hand: three at 30 on a «3 + 1» for 25', () => {
    const byHand = line({ id: 'l1', quantity: 3, freeQuantity: 1, lineTotal: 30 });
    const r = resolve([byHand], [edit('l1', { quantity: 6 })], withOffer);
    expect(r.lines[0].freeQuantity).toEqual({ from: 1, to: 1 });
    expect(codes(r)).toContain('GIFT_NOT_RESCALED');
    // and no «below the bundle» or «not a bundle» talk about a line the offer never priced
    expect(codes(resolve([line({ id: 'l1', quantity: 2, lineTotal: 24 })], [edit('l1', { quantity: 4 })], withOffer))).not.toContain('QTY_NOT_BUNDLE');
  });

  it('a gift that no longer matches the offer is NOT re-derived — an offer is never invented', () => {
    const odd = line({ id: 'l1', quantity: 3, freeQuantity: 2, lineTotal: 25 });
    const r = resolve([odd], [edit('l1', { quantity: 6 })], withOffer);
    expect(r.lines[0].freeQuantity).toEqual({ from: 2, to: 2 });
    expect(codes(r)).toContain('GIFT_NOT_RESCALED');
  });

  it('a product swap does NOT carry the gift to the new product — the save starts it at none — and says so', () => {
    // The gift is real stock of the OLD product: carried over, it would ask the new product's shelf for a piece nobody gave.
    const r = resolve([offerLine], [edit('l1', { productId: DROPS })], withOffer);
    expect(r.lines[0].freeQuantity).toEqual({ from: 1, to: 0 });
    expect(r.problems.find((p) => p.code === 'GIFT_DROPPED')!.blocking).toBe(false);
    // a swap of a line with no gift has nothing to say
    expect(codes(resolve([line({ id: 'x' })], [edit('x', { productId: DROPS })]))).not.toContain('GIFT_DROPPED');
    // and nothing of the old product's gift is asked of the shelf
    const preview = previewLineEdit(factsOf({ lines: [offerLine] }), { lines: [{ lineId: 'l1', productId: DROPS }] });
    expect(preview.after.giftUnits).toBe(0);
  });

  it('an ended offer neither prices nor gifts, and the person is told', () => {
    const ended = { ...BUNDLE, live: false };
    const r = resolve([offerLine], [edit('l1', { quantity: 6 })], { offers: [], orderOffer: ended });
    expect(r.lines[0]).toMatchObject({ freeQuantity: { to: 1 }, basis: 'KEEP_UNIT' });
    expect(r.lines[0].lineTotal.to).toBe(50);
    expect(codes(r)).toContain('OFFER_ENDED');
  });

  it('an offer’s own reduction does not follow the quantity — the person is told to retype the discount', () => {
    const reduced: OfferFact = { ...BUNDLE, listPrice: 30, price: 25 };
    const manualDoor = line({ id: 'l1', quantity: 3, freeQuantity: 1, lineTotal: 30 });
    const r = resolve([manualDoor], [edit('l1', { quantity: 6 })], { offers: [reduced], orderOffer: reduced, orderDiscount: 5 });
    // priced by LIST (30 for a bundle): six is 60, and the 5.000 discount stays 5.000.
    expect(r.lines[0].lineTotal.to).toBe(60);
    expect(codes(r)).toContain('DISCOUNT_NOT_RESCALED');
    // and the storefront way (25 after the reduction, discount 0) needs no such warning
    const storefront = line({ id: 'l1', quantity: 3, freeQuantity: 1, lineTotal: 25 });
    const s = resolve([storefront], [edit('l1', { quantity: 6 })], { offers: [reduced], orderOffer: reduced, orderDiscount: 0 });
    expect(s.lines[0].lineTotal.to).toBe(50);
    expect(codes(s)).not.toContain('DISCOUNT_NOT_RESCALED');
  });
});

/* ─────────────────────────── 5 · the shelf ─────────────────────────── */

describe('Ⅶ · what the draft does to the shelf', () => {
  const names = new Map([[CREAM, 'كريم'], [SOAP, 'صابون']]);
  const run = (over: Partial<Parameters<typeof stockEffect>[0]> = {}) =>
    stockEffect({
      stored: [line({ id: 'l1', quantity: 3, freeQuantity: 1, reservedQty: 4 })],
      next: [{ productId: CREAM, quantity: 3, freeQuantity: 1 }],
      addOns: [],
      available: { [CREAM]: 10 },
      names,
      allowNegativeStock: false,
      reserves: true,
      ...over,
    })[0];

  it('nothing changed: UNCHANGED', () => {
    expect(run()).toMatchObject({ status: 'UNCHANGED', before: 4, after: 4, missing: 0, enough: true });
  });

  it('fewer units: FREES, and says how many go back', () => {
    expect(run({ next: [{ productId: CREAM, quantity: 2, freeQuantity: 0 }] })).toMatchObject({ status: 'FREES', before: 4, after: 2, freed: 2 });
  });

  it('more units and the shelf has them: ENOUGH', () => {
    expect(run({ next: [{ productId: CREAM, quantity: 6, freeQuantity: 2 }] })).toMatchObject({ status: 'ENOUGH', after: 8, needed: 8, missing: 0 });
  });

  it('more units than the shelf can give, negative stock not allowed: SHORT_BLOCKED, with the number missing', () => {
    expect(run({ next: [{ productId: CREAM, quantity: 12, freeQuantity: 0 }] })).toMatchObject({ status: 'SHORT_BLOCKED', missing: 2, enough: false });
  });

  it('the same, where the country allows negative stock: SHORT_ALLOWED', () => {
    expect(run({ allowNegativeStock: true, next: [{ productId: CREAM, quantity: 12, freeQuantity: 0 }] })).toMatchObject({ status: 'SHORT_ALLOWED', missing: 2 });
  });

  it('an order already short is not stopped by a gap that did not grow — but one more missing unit is', () => {
    const base = { stored: [line({ id: 'l1', quantity: 3, freeQuantity: 1, reservedQty: 0 })], available: { [CREAM]: 3 } };
    // 4 needed, 3 on the shelf: one missing before and after.
    expect(run({ ...base, next: [{ productId: CREAM, quantity: 3, freeQuantity: 1 }] })).toMatchObject({ status: 'ALREADY_SHORT', missing: 1 });
    // a smaller order: the gap closes
    expect(run({ ...base, next: [{ productId: CREAM, quantity: 3, freeQuantity: 0 }] })).toMatchObject({ status: 'FREES', missing: 0 });
    // a bigger one: the gap grows
    expect(run({ ...base, next: [{ productId: CREAM, quantity: 4, freeQuantity: 1 }] })).toMatchObject({ status: 'SHORT_BLOCKED', missing: 2 });
  });

  it('the add-ons the customer accepted come off the shelf first', () => {
    const r = run({ addOns: [{ productId: CREAM, quantity: 3 }], next: [{ productId: CREAM, quantity: 8, freeQuantity: 0 }] });
    // 8 + 3 = 11 needed against 10: one missing.
    expect(r).toMatchObject({ needed: 11, missing: 1, status: 'SHORT_BLOCKED' });
  });

  it('two lines of one product are one product on the shelf', () => {
    const r = stockEffect({
      stored: [line({ id: 'a', quantity: 2, reservedQty: 2 }), line({ id: 'b', quantity: 3, reservedQty: 3 })],
      next: [{ productId: CREAM, quantity: 2, freeQuantity: 0 }, { productId: CREAM, quantity: 9, freeQuantity: 0 }],
      addOns: [],
      available: { [CREAM]: 10 },
      names,
      allowNegativeStock: false,
      reserves: true,
    });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ before: 5, after: 11, held: 5, missing: 1, status: 'SHORT_BLOCKED' });
  });

  it('a product swapped in is asked of the shelf too, and the one swapped out is freed', () => {
    const r = stockEffect({
      stored: [line({ id: 'a', quantity: 3, reservedQty: 3 })],
      next: [{ productId: SOAP, quantity: 3, freeQuantity: 0 }],
      addOns: [],
      available: { [CREAM]: 5, [SOAP]: 2 },
      names,
      allowNegativeStock: false,
      reserves: true,
    });
    expect(r.map((s) => [s.productId, s.status, s.missing])).toEqual([
      [CREAM, 'FREES', 0],
      [SOAP, 'SHORT_BLOCKED', 1],
    ]);
  });

  it('an order that holds no stock yet reports the figures and blocks nothing', () => {
    expect(run({ reserves: false, next: [{ productId: CREAM, quantity: 99, freeQuantity: 0 }] })).toMatchObject({ status: 'NOT_HELD', missing: 89 });
  });

  it('never carries the shelf’s whole balance', () => {
    expect(Object.keys(run())).not.toContain('available');
  });
});

/* ─────────────────────────── 6 · the draft's problems ─────────────────────────── */

const factsOf = (over: Partial<OrderEditFacts> = {}, order: Partial<OrderEditFacts['order']> = {}): OrderEditFacts => ({
  minorUnit: 3,
  allowNegativeStock: false,
  order: {
    confirmed: true,
    closed: false,
    handed: false,
    labelled: false,
    statementLinked: false,
    priceIncludesDelivery: false,
    // 36 + 10 − 0 + 2.5
    storedTotal: 48.5,
    shippingCost: 2.5,
    deliveryFee: null,
    discount: 0,
    version: 7,
    ...order,
  },
  lines: [
    line({ id: 'l1', quantity: 3, freeQuantity: 1, lineTotal: 36, reservedQty: 4 }),
    line({ id: 'l2', productId: SOAP, productName: 'صابون', quantity: 2, lineTotal: 10, reservedQty: 2 }),
  ],
  addOns: [],
  products: [product(CREAM, 'كريم', 12), product(SOAP, 'صابون', 5), product(DROPS, 'قطرة', 8.5)],
  offers: [],
  orderOffer: null,
  available: { [CREAM]: 20, [SOAP]: 20, [DROPS]: 20 },
  shipmentCod: 48.5,
  customer: { phoneInvalid: false, altPhoneInvalid: false, phoneDuplicate: false, regionOutsideCountry: false, regionFee: null },
  ...over,
});

const problemsOf = (facts: OrderEditFacts, draft: PreviewDraft) => previewLineEdit(facts, draft).problems;
const has = (ps: { code: string }[], code: string) => ps.some((p) => p.code === code);

describe('Ⅷ · the discount may not exceed the order — and is never trimmed to fit', () => {
  it('a smaller order under the same fixed discount is refused, with the new ceiling', () => {
    const facts = factsOf({}, { discount: 30, storedTotal: 18.5 });
    const ps = problemsOf(facts, { lines: [{ lineId: 'l1', quantity: 1 }, { lineId: 'l2', quantity: 1 }] });
    // 12 + 5 = 17 < 30
    const p = ps.find((x) => x.code === 'DISCOUNT_EXCEEDS_TOTAL')!;
    expect(p.blocking).toBe(true);
    expect(p.messageAr).toContain('17');
  });

  it('a discount typed above the total is refused; at the total it is allowed', () => {
    expect(has(problemsOf(factsOf(), { discountAmount: 46 }), 'DISCOUNT_EXCEEDS_TOTAL')).toBe(false);
    expect(has(problemsOf(factsOf(), { discountAmount: 46.001 }), 'DISCOUNT_EXCEEDS_TOTAL')).toBe(true);
    expect(has(problemsOf(factsOf(), { discountAmount: 50 }), 'DISCOUNT_EXCEEDS_TOTAL')).toBe(true);
  });
});

describe('Ⅸ · a draft is refused, not guessed at, when the order disagrees with itself', () => {
  const draft: PreviewDraft = { lines: [{ lineId: 'l1', quantity: 4 }] };

  it('two fee sources that differ: FEE_SOURCE_DRIFT, blocking', () => {
    const p = problemsOf(factsOf({}, { deliveryFee: 3.5 }), draft).find((x) => x.code === 'FEE_SOURCE_DRIFT')!;
    expect(p.blocking).toBe(true);
    // equal to the third decimal is the same fee
    expect(has(problemsOf(factsOf({}, { deliveryFee: 2.5 }), draft), 'FEE_SOURCE_DRIFT')).toBe(false);
  });

  it('a stored total that is not the lines’ total: COD_DRIFT, blocking for a lines draft — the save would rewrite it', () => {
    const p = problemsOf(factsOf({}, { storedTotal: 50 }), draft).find((x) => x.code === 'COD_DRIFT')!;
    expect(p.blocking).toBe(true);
    expect(p.messageAr).toContain('50.000');
  });

  it('…and the case that costs money: shares that are not the order’s own discount, so a save takes the discount twice', () => {
    // 29.5 stored; the lines hold 4.5 of shares against a discount of 3 — before-discount figures are taken as stored
    // and the order's 3.000 comes off AGAIN: 26.5.
    const facts = factsOf(
      {
        lines: [line({ id: 'l1', quantity: 3, lineTotal: 25, reservedQty: 3 }), line({ id: 'l2', productId: SOAP, quantity: 2, lineTotal: 7, reservedQty: 2 })],
        shipmentCod: 29.5,
      },
      { storedTotal: 29.5, discount: 3, shippingCost: 0 }
    );
    const ps = problemsOf(facts, { lines: [{ lineId: 'l1', quantity: 4 }] });
    expect(ps.find((x) => x.code === 'COD_DRIFT')!.blocking).toBe(true);
  });

  it('a discount alone over a drifting order only warns; a lines draft over it blocks', () => {
    const facts = factsOf({}, { storedTotal: 50 });
    expect(problemsOf(facts, { discountAmount: 1 }).find((x) => x.code === 'COD_DRIFT')!.blocking).toBe(false);
    expect(problemsOf(facts, { lines: [{ lineId: 'l2', quantity: 3 }] }).find((x) => x.code === 'COD_DRIFT')!.blocking).toBe(true);
  });

  it('a shipment calculator that disagrees with the stored total also blocks a lines draft', () => {
    expect(problemsOf(factsOf({ shipmentCod: 47 }), draft).find((x) => x.code === 'COD_DRIFT')!.blocking).toBe(true);
  });

  it('an order in a courier statement: STATEMENT_LINKED, blocking — the statement writes the money', () => {
    expect(problemsOf(factsOf({}, { statementLinked: true }), draft).find((x) => x.code === 'STATEMENT_LINKED')!.blocking).toBe(true);
    // a note on the customer is not money
    expect(has(problemsOf(factsOf({}, { statementLinked: true }), { customerNotes: 'ملاحظة' }), 'STATEMENT_LINKED')).toBe(false);
  });

  it('a closed order: ORDER_CLOSED, blocking', () => {
    expect(problemsOf(factsOf({}, { closed: true }), draft).find((x) => x.code === 'ORDER_CLOSED')!.blocking).toBe(true);
  });

  it('none of this is said about a draft that moves no money', () => {
    const ps = problemsOf(factsOf({}, { deliveryFee: 9, storedTotal: 1 }), { customerName: 'سامر الأحمد' });
    expect(has(ps, 'FEE_SOURCE_DRIFT')).toBe(false);
    expect(has(ps, 'COD_DRIFT')).toBe(false);
  });

  it('a clean draft on a clean order has no problems at all', () => {
    expect(problemsOf(factsOf(), { lines: [{ lineId: 'l2', quantity: 3 }] })).toEqual([]);
  });

  it('blocking problems come first', () => {
    const ps = problemsOf(factsOf({}, { storedTotal: 50, statementLinked: true }), draft);
    const flags = ps.map((p) => p.blocking);
    expect(flags).toEqual([...flags].sort((a, b) => Number(b) - Number(a)));
    expect(ps[0].blocking).toBe(true);
  });

  it('a price that includes delivery says the profit moves by the same difference', () => {
    const ps = problemsOf(factsOf({}, { priceIncludesDelivery: true, storedTotal: 46 }), draft);
    const p = ps.find((x) => x.code === 'PRICE_INCLUDES_DELIVERY')!;
    expect(p.blocking).toBe(false);
    expect(has(problemsOf(factsOf({}, { priceIncludesDelivery: true, storedTotal: 46 }), { customerNotes: 'x' }), 'PRICE_INCLUDES_DELIVERY')).toBe(false);
  });
});

describe('Ⅹ · the parcel and the customer', () => {
  const draft: PreviewDraft = { lines: [{ lineId: 'l1', quantity: 4 }] };

  it('with the courier: PARCEL_HANDED, and the door is COURIER_ACTION', () => {
    const preview = previewLineEdit(factsOf({}, { handed: true }), draft);
    // no lines are rewritten once the courier has the parcel — cancel and re-order is the way
    expect(preview.problems.find((p) => p.code === 'PARCEL_HANDED')!.blocking).toBe(true);
    expect(preview.blocked).toBe(true);
    expect(preview.door).toBe('COURIER_ACTION');
    // a note on the customer is not a line: said, not refused
    expect(previewLineEdit(factsOf({}, { handed: true }), { customerNotes: 'ملاحظة' }).problems.find((p) => p.code === 'PARCEL_HANDED')!.blocking).toBe(false);
  });

  it('a printed waybill on a parcel that is still ours: LABEL_WILL_RESET, only for what the driver reads', () => {
    expect(has(problemsOf(factsOf({}, { labelled: true }), draft), 'LABEL_WILL_RESET')).toBe(true);
    expect(has(problemsOf(factsOf({}, { labelled: true }), { customerAddress: 'شارع جديد' }), 'LABEL_WILL_RESET')).toBe(true);
    expect(has(problemsOf(factsOf({}, { labelled: true }), { customerNotes: 'ملاحظة' }), 'LABEL_WILL_RESET')).toBe(false);
    expect(has(problemsOf(factsOf({}, { labelled: true, handed: true }), draft), 'LABEL_WILL_RESET')).toBe(false);
  });

  it('a phone that is wrong or taken, and a governorate from another country, are refused', () => {
    const customer = (c: Partial<OrderEditFacts['customer']>) => factsOf({ customer: { ...factsOf().customer, ...c } });
    expect(problemsOf(customer({ phoneInvalid: true }), { customerPhone: '12345678' }).find((p) => p.code === 'PHONE_INVALID')!.blocking).toBe(true);
    expect(has(problemsOf(customer({ altPhoneInvalid: true }), { customerAltPhone: '123' }), 'PHONE_INVALID')).toBe(true);
    expect(problemsOf(customer({ phoneDuplicate: true }), { customerPhone: '0791234567' }).find((p) => p.code === 'DUPLICATE_PHONE')!.blocking).toBe(true);
    expect(problemsOf(customer({ regionOutsideCountry: true }), { regionId: '11111111-1111-4111-8111-111111111111' }).find((p) => p.code === 'REGION_NOT_IN_COUNTRY')!.blocking).toBe(true);
    // the facts are only read when the draft carries the field
    expect(has(problemsOf(customer({ phoneInvalid: true, phoneDuplicate: true }), { customerNotes: 'x' }), 'PHONE_INVALID')).toBe(false);
  });

  it('a new governorate with another table fee: a warning, and the fee itself is NOT changed', () => {
    const facts = factsOf({ customer: { ...factsOf().customer, regionFee: { current: 2.5, next: 4 } } });
    const preview = previewLineEdit(facts, { regionId: '11111111-1111-4111-8111-111111111111' });
    const p = preview.problems.find((x) => x.code === 'REGION_FEE_DIFFERS')!;
    expect(p.blocking).toBe(false);
    expect(preview.before.deliveryFee).toBe(2.5);
    expect(preview.after.deliveryFee).toBe(2.5);
    expect(preview.after.cod).toBe(preview.before.cod);
  });
});

describe('Ⅺ · the door a change goes through', () => {
  const flags = { confirmed: true, closed: false, handed: false, labelled: false };
  it.each([
    ['not confirmed: in place', { ...flags, confirmed: false }, 'DIRECT'],
    ['confirmed, ours: a request', flags, 'REQUEST'],
    ['confirmed, printed: a request that resets the waybill', { ...flags, labelled: true }, 'REQUEST_REPRINT'],
    ['with the courier', { ...flags, handed: true, labelled: true }, 'COURIER_ACTION'],
    ['closed beats everything', { ...flags, closed: true, handed: true }, 'CLOSED'],
  ] as const)('%s', (_n, f, door) => {
    expect(doorOf(f)).toBe(door);
  });
});

describe('Ⅻ · the whole preview', () => {
  it('quantity + price + gift + product at once on a confirmed order', () => {
    const facts = factsOf({
      offers: [BUNDLE],
      orderOffer: BUNDLE,
      lines: [
        line({ id: 'l1', quantity: 3, freeQuantity: 1, lineTotal: 25, reservedQty: 4 }),
        line({ id: 'l2', productId: SOAP, productName: 'صابون', quantity: 2, lineTotal: 10, reservedQty: 2 }),
      ],
      shipmentCod: 37.5,
    }, { storedTotal: 37.5 });
    const preview = previewLineEdit(facts, {
      lines: [{ lineId: 'l1', quantity: 6 }, { lineId: 'l2', productId: DROPS, unitPrice: 6 }],
      discountAmount: 5,
    });
    // l1: 25 → 50, gift 1 → 2.  l2: DROPS ×2 at 6 = 12.  subtotal 62, discount 5, fee 2.5.
    expect(preview.before).toMatchObject({ subtotal: 35, cod: 37.5, giftUnits: 1, deliveryFee: 2.5 });
    expect(preview.after).toMatchObject({ subtotal: 62, discount: 5, deliveryFee: 2.5, cod: 59.5, giftUnits: 2 });
    expect(preview.after.discountShares).toHaveLength(2);
    expect(preview.after.discountShares.reduce((a, b) => a + b, 0)).toBe(5);
    expect(preview.lines.map((l) => l.discountShare + l.totalAfterDiscount)).toEqual([50, 12]);
    expect(preview.problems.filter((p) => p.blocking)).toEqual([]);
    expect(preview.blocked).toBe(false);
    expect(preview.door).toBe('REQUEST');
    expect(preview.orderVersion).toBe(7);
    expect(preview.stock.map((s) => [s.productId, s.status])).toEqual([
      [CREAM, 'ENOUGH'],
      [SOAP, 'FREES'],
      [DROPS, 'ENOUGH'],
    ]);
  });

  it('an empty draft previews «nothing changes»', () => {
    const preview = previewLineEdit(factsOf(), {});
    expect(preview.after).toEqual(preview.before);
    expect(preview.lines.every((l) => !l.changed)).toBe(true);
    expect(preview.problems).toEqual([]);
    expect(preview.suggestions).toEqual([]);
  });

  it('customer fields alone never raise a stock verdict', () => {
    const facts = factsOf({ available: { [CREAM]: 0, [SOAP]: 0 } });
    const preview = previewLineEdit(facts, { customerName: 'سامر الأحمد' });
    expect(preview.stock.every((s) => s.status === 'UNCHANGED' && s.enough)).toBe(true);
    expect(preview.blocked).toBe(false);
  });

  it('blocked is the OR of the blocking problems', () => {
    const preview = previewLineEdit(factsOf({ available: { [CREAM]: 1, [SOAP]: 20 } }), { lines: [{ lineId: 'l1', quantity: 9 }] });
    expect(preview.stock.find((s) => s.productId === CREAM)!.status).toBe('SHORT_BLOCKED');
    expect(has(preview.problems, 'STOCK_SHORT_BLOCKED')).toBe(true);
    expect(preview.blocked).toBe(true);
  });

  it('three currencies, one preview: the same order in dinars, dollars and pounds', () => {
    for (const [mu, total] of [[3, 25], [2, 25], [0, 25]] as const) {
      const facts = factsOf({ minorUnit: mu, lines: [line({ id: 'l1', lineTotal: total })] }, { storedTotal: total + 2.5, shippingCost: 2.5 });
      const preview = previewLineEdit(facts, { lines: [{ lineId: 'l1', quantity: 5 }] });
      const direct = priceOrderLines({ lines: [{ quantity: 5, lineTotal: preview.lines[0].lineTotal.to, freeQuantity: 0 }], discount: 0, deliveryFee: 2.5, priceIncludesDelivery: false, addOns: [], minorUnit: mu });
      expect(preview.after.cod).toBe(direct.totals.cod);
    }
  });
});

/* ─────────────────────────── 7 · the draft schema ─────────────────────────── */

describe('XIII · the draft schema', () => {
  const parse = (v: unknown) => previewDraftSchema.safeParse(v);

  it('takes lines, a discount and the customer’s fields; every key is optional', () => {
    expect(parse({}).success).toBe(true);
    expect(parse({ lines: [{ lineId: 'x', quantity: 4, unitPrice: '11.6' }], discountAmount: 2, customerPhone: '0791234567' }).success).toBe(true);
  });

  it('refuses a unit price and a line total together', () => {
    expect(parse({ lines: [{ lineId: 'x', unitPrice: 5, lineTotal: 15 }] }).success).toBe(false);
  });

  it('refuses a zero or fractional quantity, a negative price and an unknown basis', () => {
    for (const bad of [{ quantity: 0 }, { quantity: 1.5 }, { quantity: 1000 }, { unitPrice: -1 }, { lineTotal: 100001 }, { priceBasis: 'FREE' }]) {
      expect(parse({ lines: [{ lineId: 'x', ...bad }] }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('allows twenty lines and refuses twenty-one, and refuses a line named twice', () => {
    const many = (n: number) => Array.from({ length: n }, (_v, i) => ({ lineId: `line-${i}`, quantity: 2 }));
    expect(lineEditsSchema.safeParse(many(MAX_EDIT_LINES)).success).toBe(true);
    expect(lineEditsSchema.safeParse(many(MAX_EDIT_LINES + 1)).success).toBe(false);
    expect(lineEditsSchema.safeParse([{ lineId: 'a' }, { lineId: 'a' }]).success).toBe(false);
    expect(lineEditsSchema.safeParse([]).success).toBe(false);
  });

  it('has no field for the gift and no field for a `from` — neither is the browser’s to say', () => {
    const r = parse({ lines: [{ lineId: 'x', quantity: 4, freeQuantity: 9, from: 3 }] });
    expect(r.success).toBe(true);
    expect(JSON.stringify(r.success ? r.data : null)).not.toMatch(/freeQuantity|from/);
  });

  it('keeps the customer fields to the lengths the order door keeps', () => {
    expect(parse({ customerName: 'س' }).success).toBe(false);
    expect(parse({ customerPhone: '123' }).success).toBe(false);
    expect(parse({ customerAddress: 'x'.repeat(301) }).success).toBe(false);
    expect(parse({ regionId: 'not-a-uuid' }).success).toBe(false);
    expect(parse({ regionId: null }).success).toBe(true);
  });
});

/* ─────────────────────────── 8 · what the engine is not allowed to be ─────────────────────────── */

/* ─────────────────────────── 7b · what the reviewer found ─────────────────────────── */

describe('XIII-ب · the shelf is never answered in numbers a subtraction can undo', () => {
  const short = (available: number, allowNegativeStock = false) =>
    previewLineEdit(factsOf({ available: { [CREAM]: available, [SOAP]: 20 }, allowNegativeStock }), { lines: [{ lineId: 'l1', quantity: 9 }] });

  it('a shortage carries neither the units needed nor the units missing', () => {
    const r = short(5);
    const cream = r.stock.find((s) => s.productId === CREAM)!;
    expect(cream.status).toBe('SHORT_BLOCKED');
    expect(Object.keys(cream).sort()).toEqual(['after', 'before', 'enough', 'freed', 'held', 'productId', 'productName', 'status']);
    expect(r.problems.find((p) => p.code === 'STOCK_SHORT_BLOCKED')!.detail).toEqual({ name: 'كريم' });
    expect(r.problems.find((p) => p.code === 'STOCK_SHORT_BLOCKED')!.messageAr).not.toMatch(/\d/);
  });

  it('the answer does not change with how short the shelf is: 5, 3 and 0 on the shelf say the same thing', () => {
    // needed − missing was the balance. If the response is byte-for-byte the same whatever the balance, no pair of its
    // numbers can give it away, and no sum, difference or product of them either.
    const five = JSON.stringify(short(5));
    expect(JSON.stringify(short(3))).toBe(five);
    expect(JSON.stringify(short(0))).toBe(five);
    // …and it is the same where the country lets the shelf go negative, up to the verdict
    expect(JSON.stringify(short(2, true))).toBe(JSON.stringify(short(0, true)));
    // …and where there is enough, 100 and 100000 say the same too
    const enough = (n: number) => JSON.stringify(previewLineEdit(factsOf({ available: { [CREAM]: n, [SOAP]: n } }), { lines: [{ lineId: 'l1', quantity: 5 }] }));
    expect(enough(100)).toBe(enough(100_000));
  });

  it('the verdict itself still moves: short is short and enough is enough', () => {
    expect(short(5).blocked).toBe(true);
    expect(previewLineEdit(factsOf({ available: { [CREAM]: 500, [SOAP]: 500 } }), { lines: [{ lineId: 'l1', quantity: 9 }] }).blocked).toBe(false);
  });
});

describe('XIII-ج · the order of the lines is part of the answer', () => {
  const three = (ids: string[]) =>
    ids.map((id) => line({ id, productId: CREAM, quantity: 1, lineTotal: 10, reservedQty: 1 }));

  it('a discount that does not divide puts its remainder on the FIRST of equal lines: 0.334, 0.333, 0.333', () => {
    // 1.000 over three equal lines: 0.333 each, 0.001 left over.
    const facts = factsOf({ lines: three(['a', 'b', 'c']), shipmentCod: 30 + 2.5 }, { storedTotal: 32.5 });
    const preview = previewLineEdit(facts, { discountAmount: 1 });
    expect(preview.after.discountShares).toEqual([0.334, 0.333, 0.333]);
    expect(preview.lineOrder).toEqual(['a', 'b', 'c']);
    expect(preview.lines.map((l) => l.lineId)).toEqual(preview.lineOrder);
  });

  it('the same lines the other way round put it on the other line — which is why the order is returned, not assumed', () => {
    const facts = factsOf({ lines: three(['c', 'b', 'a']), shipmentCod: 32.5 }, { storedTotal: 32.5 });
    const preview = previewLineEdit(facts, { discountAmount: 1 });
    expect(preview.lineOrder).toEqual(['c', 'b', 'a']);
    expect(preview.lines.map((l) => [l.lineId, l.discountShare])).toEqual([['c', 0.334], ['b', 0.333], ['a', 0.333]]);
  });

  it('the lines come back in the order they went in, edited or not', () => {
    const facts = factsOf({ lines: three(['z', 'm', 'a']), shipmentCod: 32.5 }, { storedTotal: 32.5 });
    expect(previewLineEdit(facts, { lines: [{ lineId: 'a', quantity: 2 }] }).lineOrder).toEqual(['z', 'm', 'a']);
  });
});

describe('XIII-د · prices derived from nothing but the stored line, with the answers written by hand', () => {
  // Each row: what the line is, what is asked, and the figures a person gets with a pencil.
  it.each([
    // 7 pieces for 21.000 are 3.000 each: ten are 30.000, four are 12.000.
    ['KEEP_UNIT up', { quantity: 7, lineTotal: 21 }, { quantity: 10 }, { subtotal: 30, basis: 'KEEP_UNIT' }],
    ['KEEP_UNIT down', { quantity: 7, lineTotal: 21 }, { quantity: 4 }, { subtotal: 12, basis: 'KEEP_UNIT' }],
    // 25 for three, four pieces: 25 × 4 ÷ 3 = 33.3333 → 33.333 at three places.
    ['KEEP_UNIT, the third of a fil', { quantity: 3, lineTotal: 25 }, { quantity: 4 }, { subtotal: 33.333, basis: 'KEEP_UNIT' }],
    // a bundle of 3 for 24.000: nine pieces are three bundles, 72.000.
    ['OFFER, three bundles', { quantity: 3, lineTotal: 24 }, { quantity: 9, priceBasis: 'OFFER' as const }, { subtotal: 72, basis: 'OFFER' }],
    // catalogue price 2.500: four pieces are 10.000, whatever the line cost.
    ['BASE_PRICE', { quantity: 7, lineTotal: 21 }, { quantity: 4, priceBasis: 'BASE_PRICE' as const }, { subtotal: 10, basis: 'BASE_PRICE' }],
    // a typed piece price 2.75 × 4 = 11.000
    ['MANUAL by piece', { quantity: 7, lineTotal: 21 }, { quantity: 4, unitPrice: 2.75 }, { subtotal: 11, basis: 'MANUAL' }],
    // a typed line total is taken whole
    ['MANUAL by total', { quantity: 7, lineTotal: 21 }, { quantity: 4, lineTotal: 11.5 }, { subtotal: 11.5, basis: 'MANUAL' }],
  ])('%s', (_name, stored, asked, want) => {
    const offer: OfferFact = { id: 'offer-hand', productId: CREAM, name: '3', quantity: 3, freeQuantity: 0, listPrice: 24, price: 24, live: true };
    const facts = factsOf(
      {
        lines: [line({ id: 'only', ...stored, reservedQty: stored.quantity })],
        products: [product(CREAM, 'كريم', 2.5)],
        offers: [offer],
        orderOffer: offer,
        available: { [CREAM]: 1000 },
        shipmentCod: stored.lineTotal,
      },
      { storedTotal: stored.lineTotal, shippingCost: 0 }
    );
    const preview = previewLineEdit(facts, { lines: [{ lineId: 'only', ...asked }] });
    expect(preview.after.subtotal).toBe(want.subtotal);
    expect(preview.after.cod).toBe(want.subtotal);
    expect(preview.lines[0].basis).toBe(want.basis);
  });
});

describe('XIII-هـ · what is KNOWN not to be perfect, pinned so a change to it is a decision (BACKLOG_P2: RV401)', () => {
  it('KEEP_UNIT goes and comes back a fil off: 25 for three → two → three is 25.001, not 25', () => {
    // 25 × 2 ÷ 3 = 16.667, and 16.667 × 3 ÷ 2 = 25.0005 → 25.001. The preview shows the new figure before it is sent.
    const down = resolve([line({ id: 'l1', lineTotal: 25 })], [edit('l1', { quantity: 2 })]);
    expect(down.lines[0].lineTotal.to).toBe(16.667);
    const back = resolve([line({ id: 'l1', quantity: 2, lineTotal: 16.667 })], [edit('l1', { quantity: 3 })]);
    expect(back.lines[0].lineTotal.to).toBe(25.001);
    // a typed figure does not drift
    expect(resolve([line({ id: 'l1', quantity: 2, lineTotal: 16.667 })], [edit('l1', { quantity: 3, lineTotal: 25 })]).lines[0].lineTotal.to).toBe(25);
  });
});

describe('XIV · pure: no database, no network, one calculator', () => {
  const src = stripComments(repoFile('src/lib/order-line-edit.ts'));

  it('imports no database, no client library, no fetch, and awaits nothing', () => {
    expect(src).not.toMatch(/from '\.\/db'|from '@\/lib\/db'|@prisma|prisma\./);
    expect(src).not.toMatch(/\bfetch\(|\bawait\b|\basync\b|\bsetTimeout\b|node:/);
  });

  it('calls computeCod once, in priceOrderLines — and nobody else in this feature calls it', () => {
    expect(src.match(/computeCod\(/g)).toHaveLength(1);
    expect(src.indexOf('computeCod(')).toBeGreaterThan(src.indexOf('export function priceOrderLines('));
    for (const f of ['src/lib/order-edit-facts.ts', 'src/app/api/orders/[id]/change-requests/preview/route.ts']) {
      expect(stripComments(repoFile(f)), f).not.toMatch(/computeCod\(/);
    }
  });

  it('writes no row and rounds only with roundMinor', () => {
    expect(src).not.toMatch(/\.(create|update|updateMany|upsert|createMany|delete|deleteMany)\(/);
    expect(src).not.toMatch(/toFixed\(|Math\.round\(/);
  });

  it('changes none of the functions it stands on', () => {
    const money = stripComments(repoFile('src/lib/money.ts'));
    for (const name of ['computeCod', 'roundMinor', 'allocateDiscount']) expect(money).toContain(`export function ${name}(`);
    expect(stripComments(repoFile('src/lib/offer-gift.ts'))).toContain('export function giftUnits(');
  });

  it('every problem code has a sentence in Arabic, and there are the seventeen of the design and the ones added to hold them', () => {
    expect(PROBLEM_CODES.length).toBeGreaterThanOrEqual(17);
    const preview = previewLineEdit(factsOf({ available: { [CREAM]: 0, [SOAP]: 0 } }, { statementLinked: true, storedTotal: 1, closed: true }), {
      lines: [{ lineId: 'l1', quantity: 9, lineTotal: 0 }, { lineId: 'ghost' }],
      discountAmount: 99,
    });
    expect(preview.problems.length).toBeGreaterThan(3);
    for (const p of preview.problems) {
      expect(p.messageAr, p.code).toMatch(/[؀-ۿ]/);
      expect(p.messageAr, p.code).not.toMatch(/[A-Za-z]{3,}/);
      expect(p.messageAr, p.code).not.toMatch(/\{\w+\}/);
    }
  });
});

