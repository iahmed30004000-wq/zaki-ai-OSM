import { describe, expect, it } from 'vitest';
import { computeCod } from './money';
import { giftUnits } from './offer-gift';
import { offerBoundToLine, OFFER_LINE_MAX_QUANTITY, priceByOffer, type LiveOfferTerms } from './offer-line-price';

/**
 * A LINE SOLD ON AN OFFER IS PRICED BY WHOLE BUNDLES, AND THE FIGURE IS THE ONE COD FUNCTION'S.
 *
 * «٣ + ١ هدية بـ٧٥» with a base price of 25: 3 is 75 and one gift, 6 is 150 and two, 4 is 75 + 25 and one gift, 2 lets
 * the offer go (50, no gift). The same function will fill the lines editor's price box and check a save, so these hold
 * it to `computeCod`'s own figure over the currencies the stores really use, refuse where it cannot say, and keep the
 * gift with the BUNDLES — never with the pieces.
 *
 * Every rule has its NEGATIVE beside it, so a check that cannot fail is seen to be able to.
 */

const THREE_FOR_75 = { quantity: 3, freeQuantity: 1, price: 75 };
const THREE_FOR_60 = { quantity: 3, freeQuantity: 0, price: 60 };
const ctx = (basePrice: number | null | undefined, minorUnit: number | null | undefined = 3) => ({ basePrice, minorUnit });

describe('the worked example: «٣ + ١ هدية» for 75, base price 25', () => {
  const rows: Array<[number, number, number, string]> = [
    // paid, total, gift, basis
    [1, 25, 0, 'BASE'],
    [2, 50, 0, 'BASE'],
    [3, 75, 1, 'OFFER'],
    [4, 100, 1, 'OFFER_AND_BASE'],
    [5, 125, 1, 'OFFER_AND_BASE'],
    [6, 150, 2, 'OFFER'],
    [7, 175, 2, 'OFFER_AND_BASE'],
    [9, 225, 3, 'OFFER'],
    [10, 250, 3, 'OFFER_AND_BASE'],
  ];
  it.each(rows)('%i paid -> %d, gift %i, %s', (paid, total, gift, basis) => {
    const answer = priceByOffer(THREE_FOR_75, paid, ctx(25));
    expect(answer.lineTotal).toBe(total);
    expect(answer.gift).toBe(gift);
    expect(answer.basis).toBe(basis);
  });

  it('pressing «+ حزمة» from 3 lands on 6: 150 and TWO gifts (the bundle, not the piece)', () => {
    const six = priceByOffer(THREE_FOR_75, 6, ctx(25));
    expect(six).toMatchObject({ bundles: 2, remainder: 0, price: 150, lineTotal: 150, gift: 2 });
    // NEGATIVE: a gift per piece would be one per paid piece — 6 — and the one-bundle gift doubled is 2.
    expect(six.gift).not.toBe(6);
    expect(six.gift).not.toBe(THREE_FOR_75.freeQuantity);
  });

  it('a quantity that is not a multiple: k bundles at the offer + the rest at the base price, and it says so', () => {
    const four = priceByOffer(THREE_FOR_75, 4, ctx(25));
    expect(four).toMatchObject({ bundles: 1, remainder: 1, price: 75, lineTotal: 100, gift: 1, basis: 'OFFER_AND_BASE' });
    expect(four.notes).toHaveLength(1);
    expect(four.notes[0]).toContain('75');
    expect(four.notes[0]).toContain('25');
  });

  it('shorter than one bundle: the offer is let go and there is no gift', () => {
    const two = priceByOffer(THREE_FOR_75, 2, ctx(25));
    expect(two).toMatchObject({ bundles: 0, remainder: 2, price: 0, lineTotal: 50, gift: 0, basis: 'BASE' });
    expect(two.notes[0]).toContain('بدون هدية');
  });

  it('whole bundles say nothing extra; there is nothing to explain', () => {
    expect(priceByOffer(THREE_FOR_75, 3, ctx(25)).notes).toEqual([]);
    expect(priceByOffer(THREE_FOR_75, 6, ctx(25)).notes).toEqual([]);
  });

  it('the base price does not matter for whole bundles — and is not asked for', () => {
    for (const base of [null, undefined, 0, -5, Number.NaN]) {
      const answer = priceByOffer(THREE_FOR_75, 6, ctx(base));
      expect(answer.lineTotal).toBe(150);
      expect(answer.basis).toBe('OFFER');
    }
  });
});

describe('«٣ بـ٦٠» and «٣ بـ٧٥» over 1..10: the same figure computeCod gives the same line', () => {
  /** The line as the saved order holds it: the bundles as one line, the loose pieces at the base price as another. */
  const viaCod = (offerPrice: number, base: number, n: number, q: number, unit: number): number => {
    const k = Math.floor(n / q);
    const r = n - k * q;
    const lines = [
      ...(k > 0 ? [{ quantity: k, unitPrice: offerPrice }] : []),
      ...(r > 0 ? [{ quantity: r, unitPrice: base }] : []),
    ];
    return computeCod({ lines, minorUnit: unit }).subtotal;
  };

  it('is the same on every quantity, for both prices, in three currencies and four base prices', () => {
    let compared = 0;
    for (const unit of [0, 2, 3]) {
      for (const offerPrice of [60, 75]) {
        for (const base of [25, 0.1, 1.2345, 12.5]) {
          for (let n = 1; n <= 10; n++) {
            const answer = priceByOffer({ quantity: 3, freeQuantity: 1, price: offerPrice }, n, ctx(base, unit));
            expect(answer.lineTotal, `${n} @ ${offerPrice}/${base}/${unit}`).toBe(viaCod(offerPrice, base, n, 3, unit));
            compared++;
          }
        }
      }
    }
    expect(compared).toBe(3 * 2 * 4 * 10);
  });

  it('a total the price box holds goes through computeCod untouched (a one-piece line of that total)', () => {
    for (let n = 1; n <= 10; n++) {
      const answer = priceByOffer(THREE_FOR_60, n, ctx(25, 3));
      const total = answer.lineTotal ?? Number.NaN;
      expect(computeCod({ lines: [{ quantity: 1, unitPrice: total }], minorUnit: 3 }).lineTotals[0]).toBe(total);
    }
  });

  it('NEGATIVE: the keep-the-piece-price answer (60/3 × 4 = 80) is NOT this function’s — it prices the 4th piece at the base', () => {
    expect(priceByOffer(THREE_FOR_60, 4, ctx(25)).lineTotal).toBe(85);
    expect(priceByOffer(THREE_FOR_60, 4, ctx(25)).lineTotal).not.toBe(80);
  });
});

describe('the gift is one per BUNDLE', () => {
  it('«٣ + ١»: n = 3, 4, 6, 7 give 1, 1, 2, 2 — and 1, 2, 5 give none or one', () => {
    const at = (n: number) => priceByOffer(THREE_FOR_75, n, ctx(25)).gift;
    expect([at(3), at(4), at(6), at(7)]).toEqual([1, 1, 2, 2]);
    expect([at(1), at(2)]).toEqual([0, 0]);
    expect(at(5)).toBe(1);
    expect(at(9)).toBe(3);
  });

  it('is exactly `giftUnits` — one rule, imported and not copied', () => {
    for (let n = 1; n <= 30; n++) {
      expect(priceByOffer(THREE_FOR_75, n, ctx(25)).gift, `n=${n}`).toBe(giftUnits(THREE_FOR_75, n));
    }
  });

  it('a bigger gift per bundle multiplies by bundles: «٢ + ٣» at 5 bundles is 15', () => {
    expect(priceByOffer({ quantity: 2, freeQuantity: 3, price: 40 }, 10, ctx(25)).gift).toBe(15);
    // NEGATIVE: not one per piece (30) and not the single bundle's 3.
    expect(priceByOffer({ quantity: 2, freeQuantity: 3, price: 40 }, 10, ctx(25)).gift).not.toBe(30);
  });

  it('the gift never reaches the price: 3 + 1 is 75, not 100', () => {
    expect(priceByOffer(THREE_FOR_75, 3, ctx(25)).lineTotal).toBe(75);
  });
});

describe('rounding is the currency’s, read and not assumed', () => {
  it('0.1 × 3 is 0.3 at two places, not float noise', () => {
    // an offer of ONE piece for 0.1 so three of them are three bundles
    const answer = priceByOffer({ quantity: 1, freeQuantity: 0, price: 0.1 }, 3, ctx(0.1, 2));
    expect(answer.lineTotal).toBe(0.3);
    expect(String(answer.lineTotal)).toBe('0.3');
    // NEGATIVE: the bare product is not 0.3, so the rounding is what made it so.
    expect(0.1 * 3).not.toBe(0.3);
  });

  it('JOD (3 places) keeps the third: 3 بـ0.3 + 1 at 0.125 is 0.425, and 7 is 0.725', () => {
    const offer = { quantity: 3, freeQuantity: 0, price: 0.3 };
    expect(priceByOffer(offer, 4, ctx(0.125, 3)).lineTotal).toBe(0.425);
    expect(priceByOffer(offer, 7, ctx(0.125, 3)).lineTotal).toBe(0.725);
    expect(priceByOffer(offer, 5, ctx(0.125, 3)).lineTotal).toBe(0.55);
  });

  it('USD (2 places) rounds half away from zero: the same 0.125 piece is 0.13, so 0.43', () => {
    const offer = { quantity: 3, freeQuantity: 0, price: 0.3 };
    expect(priceByOffer(offer, 4, ctx(0.125, 2)).lineTotal).toBe(0.43);
    // NEGATIVE: at three places the same line is 0.425 — the unit is read, not fixed at two.
    expect(priceByOffer(offer, 4, ctx(0.125, 2)).lineTotal).not.toBe(0.425);
  });

  it('SYP (no places) rounds the piece to a whole: 12.5 -> 13, so 3 بـ60 + 1 is 73', () => {
    expect(priceByOffer(THREE_FOR_60, 4, ctx(12.5, 0)).lineTotal).toBe(73);
    expect(priceByOffer(THREE_FOR_60, 4, ctx(12.5, 0)).lineTotal).not.toBe(72.5);
    // and 0 IS a unit — a check that read it as «no unit» would refuse here.
    expect(priceByOffer(THREE_FOR_60, 3, ctx(25, 0)).basis).toBe('OFFER');
  });

  it('a bundle price with more places than the currency is rounded once, for the bundles', () => {
    // 3 × 20.0004 at two places is 60 — not 60.0012
    expect(priceByOffer({ quantity: 1, freeQuantity: 0, price: 20.0004 }, 3, ctx(25, 2)).lineTotal).toBe(60);
  });
});

describe('a base price that is not known', () => {
  it('refuses a quantity that needs it, in words, with no figure', () => {
    for (const base of [null, undefined, 0, -5, Number.NaN]) {
      const uneven = priceByOffer(THREE_FOR_75, 4, ctx(base));
      expect(uneven.basis).toBe('REFUSED');
      expect(uneven.lineTotal).toBeNull();
      expect(uneven.gift).toBe(0);
      expect(uneven.notes[0]).toMatch(/السعر الأساسي/);
      const short = priceByOffer(THREE_FOR_75, 2, ctx(base));
      expect(short.basis).toBe('REFUSED');
      expect(short.lineTotal).toBeNull();
    }
  });

  it('NEGATIVE: the same quantity with a known base price is priced, so the refusal is the base price’s and nothing else', () => {
    expect(priceByOffer(THREE_FOR_75, 4, ctx(25)).basis).toBe('OFFER_AND_BASE');
    expect(priceByOffer(THREE_FOR_75, 2, ctx(25)).basis).toBe('BASE');
  });
});

describe('what it refuses, never guessing', () => {
  const refusedAt = (quantity: number) => priceByOffer(THREE_FOR_75, quantity, ctx(25));

  it('a quantity that is not a whole number from 1 to the door’s ceiling', () => {
    for (const bad of [0, -1, -3, 1.5, 0.1, Number.NaN, Number.POSITIVE_INFINITY, OFFER_LINE_MAX_QUANTITY + 1, 1e9]) {
      const answer = refusedAt(bad);
      expect(answer.basis, `quantity ${bad}`).toBe('REFUSED');
      expect(answer.lineTotal).toBeNull();
      expect(answer.gift).toBe(0);
    }
    // NEGATIVE: the ceiling itself is a real line.
    expect(OFFER_LINE_MAX_QUANTITY).toBe(999);
    expect(refusedAt(999).basis).toBe('OFFER');
    expect(refusedAt(999).lineTotal).toBe(333 * 75);
    expect(refusedAt(999).gift).toBe(333);
  });

  it('an offer that makes no sense', () => {
    const bad: Array<[string, { quantity: number; freeQuantity: number; price: number }]> = [
      ['bundle of zero', { quantity: 0, freeQuantity: 1, price: 75 }],
      ['negative bundle', { quantity: -3, freeQuantity: 1, price: 75 }],
      ['fractional bundle', { quantity: 1.5, freeQuantity: 1, price: 75 }],
      ['NaN bundle', { quantity: Number.NaN, freeQuantity: 1, price: 75 }],
      ['negative gift', { quantity: 3, freeQuantity: -1, price: 75 }],
      ['fractional gift', { quantity: 3, freeQuantity: 0.5, price: 75 }],
      ['zero price', { quantity: 3, freeQuantity: 1, price: 0 }],
      ['negative price', { quantity: 3, freeQuantity: 1, price: -75 }],
      ['NaN price', { quantity: 3, freeQuantity: 1, price: Number.NaN }],
      ['infinite price', { quantity: 3, freeQuantity: 1, price: Number.POSITIVE_INFINITY }],
    ];
    for (const [name, offer] of bad) {
      const answer = priceByOffer(offer, 6, ctx(25));
      expect(answer.basis, name).toBe('REFUSED');
      expect(answer.lineTotal, name).toBeNull();
    }
    // NEGATIVE: a gift of zero is a real offer (a plain «٣ بـ٦٠»).
    expect(priceByOffer({ quantity: 3, freeQuantity: 0, price: 60 }, 6, ctx(25)).lineTotal).toBe(120);
  });

  it('a currency that is not a whole number from 0 to 6', () => {
    for (const bad of [undefined, null, -1, 7, 2.5, Number.NaN]) {
      const answer = priceByOffer(THREE_FOR_75, 6, { basePrice: 25, minorUnit: bad as number | null | undefined });
      expect(answer.basis, `unit ${String(bad)}`).toBe('REFUSED');
      expect(answer.lineTotal).toBeNull();
    }
    for (const good of [0, 2, 3, 6]) expect(priceByOffer(THREE_FOR_75, 6, ctx(25, good)).basis).toBe('OFFER');
  });

  it('every refusal is a sentence in Arabic, with no Latin letter', () => {
    const answers = [
      refusedAt(0),
      priceByOffer({ quantity: 0, freeQuantity: 1, price: 75 }, 6, ctx(25)),
      priceByOffer(THREE_FOR_75, 6, { basePrice: 25, minorUnit: undefined }),
      priceByOffer(THREE_FOR_75, 4, ctx(null)),
      priceByOffer(THREE_FOR_75, 2, ctx(null)),
    ];
    for (const a of answers) {
      expect(a.notes.length).toBeGreaterThan(0);
      for (const note of a.notes) expect(note).not.toMatch(/[A-Za-z]/);
    }
    // the explanations too
    for (const n of [2, 4, 7]) for (const note of priceByOffer(THREE_FOR_75, n, ctx(25)).notes) expect(note).not.toMatch(/[A-Za-z]/);
  });

  it('is pure: the same question twice is the same answer, and a frozen input is not touched', () => {
    const offer = Object.freeze({ quantity: 3, freeQuantity: 1, price: 75 });
    const first = priceByOffer(offer, 7, ctx(25));
    const second = priceByOffer(offer, 7, ctx(25));
    expect(second).toEqual(first);
    expect(offer).toEqual({ quantity: 3, freeQuantity: 1, price: 75 });
    // NEGATIVE: the answers are separate objects — editing one does not edit the next.
    first.notes.push('x');
    expect(priceByOffer(offer, 7, ctx(25)).notes).toHaveLength(1);
  });
});

describe('which live offer a stored line was sold on', () => {
  const o3: LiveOfferTerms = { id: 'o3', quantity: 3, freeQuantity: 1, price: 75, listPrice: null };
  const o6: LiveOfferTerms = { id: 'o6', quantity: 6, freeQuantity: 2, price: 150, listPrice: null };
  const find = (line: { quantity: number; freeQuantity: number; total: number }, offers: LiveOfferTerms[], prefer?: string | null) =>
    offerBoundToLine(line, offers, 3, prefer);

  it('a whole number of bundles at the offer’s price is bound, with the gift the offer gives', () => {
    expect(find({ quantity: 3, freeQuantity: 1, total: 75 }, [o3])).toMatchObject({ offer: { id: 'o3' }, gift: 1 });
    expect(find({ quantity: 6, freeQuantity: 2, total: 150 }, [o3])).toMatchObject({ offer: { id: 'o3' }, gift: 2 });
  });

  it('a line that fits no offer is bound to nothing (null, never a guess)', () => {
    expect(find({ quantity: 4, freeQuantity: 1, total: 100 }, [o3]), 'pieces left over').toBeNull();
    expect(find({ quantity: 3, freeQuantity: 1, total: 70 }, [o3]), 'a typed price').toBeNull();
    expect(find({ quantity: 2, freeQuantity: 0, total: 50 }, [o3]), 'shorter than a bundle').toBeNull();
    expect(find({ quantity: 3, freeQuantity: 1, total: 75 }, []), 'no live offer').toBeNull();
    expect(find({ quantity: 3, freeQuantity: 1, total: 75 }, [o6]), 'a bigger bundle').toBeNull();
  });

  it('a total within half a minor unit is the same figure; a whole unit off is not', () => {
    expect(find({ quantity: 3, freeQuantity: 1, total: 75.0004 }, [o3])).not.toBeNull();
    expect(find({ quantity: 3, freeQuantity: 1, total: 75.001 }, [o3])).toBeNull();
  });

  it('either way the doors write it: after the bundle’s own reduction (CHARGED) or before it (LIST)', () => {
    const reduced: LiveOfferTerms = { id: 'r', quantity: 3, freeQuantity: 1, price: 72, listPrice: 75 };
    expect(find({ quantity: 6, freeQuantity: 2, total: 144 }, [reduced])).toMatchObject({ offer: { id: 'r' } });
    expect(find({ quantity: 6, freeQuantity: 2, total: 150 }, [reduced])).toMatchObject({ offer: { id: 'r' } });
    // NEGATIVE: a figure between the two is neither.
    expect(find({ quantity: 6, freeQuantity: 2, total: 147 }, [reduced])).toBeNull();
  });

  it('two offers fit one line: the one whose gift is the gift already stored wins, then the order’s own, then the first', () => {
    // 6 pieces at 150: two «٣ + ١» (gift 2) or one «٦ + ٢» (gift 2) — same gift here, so the order’s own decides
    expect(find({ quantity: 6, freeQuantity: 2, total: 150 }, [o3, o6])?.offer.id).toBe('o3');
    expect(find({ quantity: 6, freeQuantity: 2, total: 150 }, [o3, o6], 'o6')?.offer.id).toBe('o6');
    // an offer id that is not among them changes nothing
    expect(find({ quantity: 6, freeQuantity: 2, total: 150 }, [o3, o6], 'gone')?.offer.id).toBe('o3');
    // different gifts: the stored gift is the evidence
    const o6b: LiveOfferTerms = { ...o6, freeQuantity: 3 };
    expect(find({ quantity: 6, freeQuantity: 3, total: 150 }, [o3, o6b])?.offer.id).toBe('o6');
    expect(find({ quantity: 6, freeQuantity: 2, total: 150 }, [o3, o6b], 'o6')?.offer.id).toBe('o3');
  });

  it('the same offer listed twice is one answer', () => {
    expect(find({ quantity: 3, freeQuantity: 1, total: 75 }, [o3, o3])?.offer.id).toBe('o3');
  });

  it('reads priceByOffer: an offer it refuses (a bundle of zero) binds nothing', () => {
    const broken: LiveOfferTerms = { id: 'b', quantity: 0, freeQuantity: 1, price: 75, listPrice: null };
    expect(find({ quantity: 3, freeQuantity: 1, total: 75 }, [broken])).toBeNull();
  });
});
