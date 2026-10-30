import { describe, expect, it } from 'vitest';
import {
  MIN_DELIVERED,
  MIN_SELLERS,
  PROSE_KEYS,
  dnaLineAr,
  fieldLabel,
  readDna,
  whyNoDna,
  type DnaProduct,
} from './product-dna';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A PATTERN NEEDS MORE THAN ONE.
 *
 * «إنشاءُ منتج من DNA منتجاتك الناجحة».
 *
 * MEASURED on this database before a line was written: TWELVE products, of
 * which exactly ONE has ever been ordered — 56 orders, 26 delivered — and
 * the other eleven have nothing at all.
 *
 * So the thing asked for cannot be computed today, and the honest engine is
 * one that says so. A DNA from one product answers «your winners are 50ml
 * dry-skin creams at 14 JOD», which is a description of that single product
 * wearing a finding's clothes — and that is exactly how this product's
 * previous intelligence layer came to grade every customer the same and had
 * to be abandoned.
 *
 * What is asserted below is therefore mostly about REFUSING:
 *
 *   one seller is not a population, and the sentence says the count;
 *   a trait on four of nine is not «what your winners have»;
 *   an ingredients sentence is not a trait;
 *   and nothing anywhere returns a probability — every number is a count
 *   out of a count, because a count is a fact the owner can check against
 *   their own memory and a prediction is a claim this data cannot support.
 *
 * The day ten products have sold, it starts answering by itself — which is
 * the same deal `delivery-time.ts` and `couriers/score.ts` make.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** A seller: enough deliveries to join the population. */
const p = (over: Partial<DnaProduct> & { id: string }): DnaProduct => ({
  name: over.id,
  category: 'العناية بالبشرة',
  price: 14,
  delivered: MIN_DELIVERED,
  attributes: null,
  ...over,
});

/** `n` products that all share `attributes`, so a trait is at 100%. */
const many = (n: number, over: Partial<DnaProduct> = {}) =>
  Array.from({ length: n }, (_, i) => p({ id: `p${i}`, ...over }));

describe('Ⅰ · it refuses a population it does not have', () => {
  it('this shop today — one seller out of twelve products — gets no reading', () => {
    /*
     * THE MEASURED STATE, reproduced: one product with 26 deliveries and
     * eleven with none.
     */
    const shop: DnaProduct[] = [
      p({ id: 'كريم مرطّب للوجه', delivered: 26, price: 14 }),
      ...Array.from({ length: 11 }, (_, i) => p({ id: `بلا بيع ${i}`, delivered: 0 })),
    ];
    const reading = readDna(shop);
    expect(reading.sellers, 'عُدَّ منتجٌ لم يُسلَّمْ منه شيء').toBe(1);
    expect(reading.traits, 'نمطٌ من منتجٍ واحد').toBeNull();
    expect(whyNoDna(reading)).toContain('1');
    expect(whyNoDna(reading)).toContain(String(MIN_SELLERS));
  });

  it('and a shop with nothing delivered says that, not «one»', () => {
    const reading = readDna(Array.from({ length: 12 }, (_, i) => p({ id: `x${i}`, delivered: 0 })));
    expect(reading.sellers).toBe(0);
    expect(whyNoDna(reading)).toContain(String(MIN_DELIVERED));
  });

  it('and a product with one delivery is not a seller — that is a friend', () => {
    expect(MIN_DELIVERED, 'الحدُّ تغيّر وهذا الاختبارُ مبنيٌّ عليه').toBe(3);
    const reading = readDna(many(20, { delivered: MIN_DELIVERED - 1 }));
    expect(reading.sellers).toBe(0);
  });

  it('and every count from 0 to 20 sellers lands on the right side of the floor', () => {
    /*
     * WALKED, not sampled. An off-by-one here reads a pattern out of nine
     * products or refuses ten, and neither shows up in a test that checks
     * 1 and 20.
     */
    const wrong: string[] = [];
    for (let n = 0; n <= 20; n++) {
      const reading = readDna(many(n));
      const answered = reading.traits !== null;
      if (answered !== n >= MIN_SELLERS) wrong.push(`${n} بائعاً: ${answered ? 'قرأ' : 'رفض'}`);
    }
    expect(wrong, `الحدُّ لا يُطبَّقُ حيث يَجب:\n${wrong.join('\n')}`).toEqual([]);
  });

  it('and exactly ten is enough — a floor, not a gap', () => {
    const reading = readDna(many(MIN_SELLERS));
    expect(reading.traits).not.toBeNull();
    expect(whyNoDna(reading)).toBeNull();
  });
});

describe('Ⅱ · what it says is a count, never a prediction', () => {
  const sellers = [
    ...many(6, { category: 'العناية بالبشرة', price: 14, attributes: { skin: 'جافة', need: ['جفاف'], ml: 50 } }),
    ...many(4, { category: 'مكمّلات', price: 30, attributes: { skin: 'دهنية', need: ['حبوب'], ml: 150 } }),
  ].map((x, i) => ({ ...x, id: `s${i}` }));

  it('a trait on six of ten is said, with both numbers', () => {
    const reading = readDna(sellers);
    const skin = reading.traits!.find((t) => t.field === 'skin' && t.value === 'جافة');
    expect(skin, 'الخاصيّةُ المشتركةُ غائبة').toBeTruthy();
    expect(skin!.shared).toBe(6);
    expect(skin!.outOf).toBe(10);
    expect(dnaLineAr(skin!)).toBe('نوع البشرة: جافة — 6 من 10');
  });

  it('and a trait on four of ten is NOT said', () => {
    /*
     * «Something four of them have» is not «what your winners have», and a
     * list that includes it is a list the owner stops trusting.
     */
    const reading = readDna(sellers);
    expect(reading.traits!.some((t) => t.value === 'دهنية'), 'أربعةٌ من عشرةٍ صارت قاعدة').toBe(false);
    expect(reading.traits!.some((t) => t.value === 'مكمّلات')).toBe(false);
  });

  it('and no line anywhere is a percentage or a probability', () => {
    const reading = readDna(sellers);
    for (const t of reading.traits!) {
      const line = dnaLineAr(t);
      expect(line, `«${line}» يُخفي المقام`).not.toMatch(/%|٪/);
      expect(line, `«${line}» يَتكلّمُ عن المستقبل`).not.toMatch(/سيبيع|متوقّع|احتمال|ينجح/);
      expect(line, 'سطرٌ بلا مقام').toMatch(/\d+ من \d+/);
    }
  });

  it('and nothing is ever read out of a product’s NAME', () => {
    /*
     * A word-frequency reading of twelve Arabic names would find «كريم» and
     * call it DNA. The names below are deliberately identical and must
     * produce no trait of their own.
     */
    const reading = readDna(many(12, { name: 'كريم كريم كريم', attributes: null }));
    expect(reading.traits!.some((t) => t.field === 'name' || t.value.includes('كريم'))).toBe(false);
  });
});

describe('Ⅲ · a list value is several traits, and prose is none', () => {
  it('two products sharing ONE need out of two share that need', () => {
    /*
     * MEASURED: `need` is a list on every product on this shop that has it
     * — «need: ['تجاعيد','جفاف']». Comparing the joined strings would find
     * a wrinkles-and-dryness product entirely different from a dryness one,
     * which is the opposite of true.
     */
    const sellers = [
      ...many(5, { attributes: { need: ['تجاعيد', 'جفاف'] } }),
      ...many(5, { attributes: { need: ['جفاف'] } }),
    ].map((x, i) => ({ ...x, id: `n${i}` }));
    const reading = readDna(sellers);
    const dry = reading.traits!.find((t) => t.field === 'need' && t.value === 'جفاف');
    expect(dry, 'القائمةُ قُورنت كنصٍّ واحد').toBeTruthy();
    expect(dry!.shared).toBe(10);
  });

  it('and one product listing a value twice counts once', () => {
    const reading = readDna(many(10, { attributes: { need: ['جفاف', 'جفاف'] } }));
    expect(reading.traits!.find((t) => t.value === 'جفاف')!.shared, 'عُدَّ المنتجُ مرّتين').toBe(10);
  });

  it('and an ingredients sentence is never a trait', () => {
    /*
     * «ماء، جلسرين، زبدة الشيا، فيتامين هـ» — no two products share it
     * verbatim, so it is noise; and splitting it on the comma would invent
     * a taxonomy the seller never agreed to.
     */
    expect(PROSE_KEYS).toContain('made');
    const reading = readDna(many(10, { attributes: { made: 'ماء، جلسرين، زبدة الشيا' } }));
    expect(reading.traits!.some((t) => t.field === 'made'), 'جملةُ المكوّناتِ صارت نمطاً').toBe(false);
  });

  it('and a value that is neither text nor a number is not a trait', () => {
    const reading = readDna(many(10, { attributes: { skin: { ar: 'جافة' }, ml: Number.NaN, need: [] } }));
    expect(reading.traits!.some((t) => t.field === 'skin')).toBe(false);
    expect(reading.traits!.some((t) => t.field === 'ml')).toBe(false);
    expect(reading.traits!.some((t) => t.field === 'need')).toBe(false);
  });

  it('and a missing attributes object does not throw', () => {
    for (const attributes of [null, undefined, {}]) {
      expect(() => readDna(many(10, { attributes: attributes as never }))).not.toThrow();
    }
  });
});

describe('Ⅳ · the price is a band the shop chose, not a round number', () => {
  it('it is the sellers’ own middle half', () => {
    const prices = [5, 8, 9, 10, 12, 14, 18, 22, 30, 60];
    const reading = readDna(prices.map((price, i) => p({ id: `b${i}`, price, attributes: null })));
    const band = reading.traits!.find((t) => t.field === 'price')!;
    // Nearest-rank 25th and 75th of ten sorted prices: the 3rd and the 8th.
    expect(band.value).toBe('9 — 22');
    expect(band.value, 'رقمٌ مستديرٌ اختارَه أحد').not.toMatch(/^(10|20|50)$/);
  });

  it('and a shop whose sellers are all one price says the one price', () => {
    const reading = readDna(many(10, { price: 14 }));
    expect(reading.traits!.find((t) => t.field === 'price')!.value).toBe('14');
  });

  it('and a price of zero is not a price', () => {
    const reading = readDna(many(10, { price: 0 }));
    expect(reading.traits!.some((t) => t.field === 'price'), 'صفرٌ صارَ نطاقَ سعر').toBe(false);
  });
});

describe('Ⅴ · the fields are named in the reader’s words', () => {
  it('for the keys this shop actually fills', () => {
    for (const [field, label] of [
      ['category', 'التصنيف'],
      ['price', 'السعر'],
      ['need', 'يُستعمل لـ'],
      ['skin', 'نوع البشرة'],
      ['ml', 'الحجم'],
    ] as const) {
      expect(fieldLabel(field)).toBe(label);
    }
  });

  it('and a key the shop invented keeps its own name rather than vanishing', () => {
    // Better a reader sees `scent` than a row labelled «undefined».
    expect(fieldLabel('scent')).toBe('scent');
  });

  it('and no label is written in Arabic-Indic digits', () => {
    const reading = readDna(many(10, { attributes: { skin: 'جافة' } }));
    for (const t of reading.traits!) {
      expect(t.label, `${t.field} مكتوبٌ بأرقامٍ هندية`).not.toMatch(/[٠-٩]/);
      expect(dnaLineAr(t)).not.toMatch(/[٠-٩]/);
    }
  });
});
