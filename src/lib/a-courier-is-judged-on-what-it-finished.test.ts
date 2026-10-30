import { describe, expect, it } from 'vitest';
import {
  COURIER_BANDS,
  MIN_DECIDED,
  courierCollectionTrust,
  courierRates,
  scoreCourier,
  whyNoCourierScore,
} from './couriers/score';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A COURIER IS JUDGED ON WHAT IT FINISHED.
 *
 * «AI + Score في تسعة مواضع … متابعة الشحن». Eight of the nine already
 * carried a number and a sentence. This one had a sentence and no number:
 * `parcel-tracking/priority.ts` ranks a PARCEL by how urgently it needs chasing,
 * which never says whether the courier carrying it is any good — and the
 * screen comparing couriers printed raw counts and one bare percentage.
 *
 * ── THE NUMBERS BELOW ARE THIS SHOP'S OWN ──
 *
 * MEASURED when this was written: أرامكس الأردن has 26 parcels — 19
 * delivered, 4 partly delivered, 0 failed, 3 returned, 12 settled — and the
 * other two couriers have NOTHING. So one courier scores, two must read «لا
 * يكفي» with a reason, and that is asserted on those figures rather than on
 * invented ones.
 *
 * And ONE BAND CANNOT BE MEASURED on this database: 23 deliveries carry
 * both timestamps and every gap is zero or one second. Speed therefore
 * answers null here, the row reads «out of 90», and the missing ten points
 * name themselves. Asserted, because the alternative — awarding every
 * courier full marks for an instant delivery that never happened — is what
 * the band would do if its guard were dropped.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** أرامكس الأردن as the database holds it. */
const ARAMEX = { landed: 19 + 4, failed: 0, returned: 3, settled: 12 };

describe('Ⅰ · the denominator is what the courier finished', () => {
  it('a parcel still in a van counts against nobody', () => {
    /*
     * Fifty parcels handed over this morning and none decided: the rates
     * are null, the sample is zero, and there is no score. Counting those
     * fifty as failures would make a courier handed work this morning
     * score worse than one handed none.
     */
    const { decided, input } = courierRates({ landed: 0, failed: 0, returned: 0, settled: 0 });
    expect(decided, 'طردٌ في الطريقِ عُدَّ قراراً').toBe(0);
    expect(input.delivery_rate!.value).toBeNull();
    expect(scoreCourier(input, { sample: decided }).total).toBeNull();
  });

  it('and a partial delivery counts as landed, once', () => {
    /*
     * The parcel reached the customer and the customer kept some of it.
     * The refused lines are a return and are counted in their own band —
     * so a partial must not be counted as landed AND as a failure, which
     * is what leaving it out of the denominator amounted to before.
     *
     * `landed` is ONE field for exactly this reason: `whereDelivered()` is
     * already DELIVERED + PARTIALLY_DELIVERED, so a caller handing both
     * would double-count every partial and produce a rate over 100%.
     */
    const { decided, input } = courierRates(ARAMEX);
    expect(decided, 'المقامُ ليس ما أنجزَه المندوب').toBe(26);
    expect(input.delivery_rate!.value, '23 من 26').toBe(88);
    expect(input.return_rate!.value).toBe(12);
    expect(input.failure_rate!.value).toBe(0);
  });

  it('and collection is out of what LANDED, not out of what was decided', () => {
    // There is no money to collect on a parcel that came back. 12 of 23,
    // not 12 of 26.
    expect(courierRates(ARAMEX).input.collection_rate!.value).toBe(52);
  });

  it('and a negative count cannot bend a rate', () => {
    const { decided, input } = courierRates({ landed: -5, failed: -1, returned: 3, settled: -2 });
    expect(decided).toBe(3);
    expect(input.delivery_rate!.value).toBe(0);
    expect(input.collection_rate!.value, 'قُسِمَ على صفرٍ من هبط').toBeNull();
  });
});

describe('Ⅱ · the score on this shop’s own figures', () => {
  const { decided, input } = courierRates(ARAMEX);

  it('أرامكس scores 74 out of 90 — and the missing ten are the unmeasured speed', () => {
    /*
     * WORKED OUT BY HAND so the engine cannot quietly change its mind:
     *   delivery   88% of 35 = 30.8 → 31
     *   return     (1 − 12%) of 20 = 17.6 → 18
     *   collection 52% of 20 = 10.4 → 10
     *   failure    (1 − 0%) of 15 = 15
     *   speed      no duration in this database → null, −10 from «out of»
     *   total      31 + 18 + 10 + 15 = 74 out of 90
     */
    const score = scoreCourier({ ...input, speed: { value: 0, reference: 0 } }, { sample: decided });
    expect(score.bands.find((b) => b.key === 'delivery_rate')!.points).toBe(31);
    expect(score.bands.find((b) => b.key === 'return_rate')!.points).toBe(18);
    expect(score.bands.find((b) => b.key === 'collection_rate')!.points).toBe(10);
    expect(score.bands.find((b) => b.key === 'failure_rate')!.points).toBe(15);
    expect(score.bands.find((b) => b.key === 'speed')!.points, 'سرعةٌ قُيِّمت بلا مدّة').toBeNull();
    expect(score.total).toBe(74);
    expect(score.possible, 'النقاطُ العشرُ المفقودةُ لم تُسَمِّ نفسَها').toBe(90);
  });

  it('and the headline is the sum of the parts a reader can add up', () => {
    const score = scoreCourier(input, { sample: decided });
    const parts = score.bands.filter((b) => b.points !== null).reduce((n, b) => n + b.points!, 0);
    expect(score.total, 'الرأسُ لا يُساوي مجموعَ بنودِه').toBe(parts);
  });

  it('and a perfect courier scores every band it could be measured on', () => {
    const { decided: d, input: i } = courierRates({ landed: 40, failed: 0, returned: 0, settled: 40 });
    const score = scoreCourier({ ...i, speed: { value: 24, reference: 24 } }, { sample: d });
    expect(score.total).toBe(100);
    expect(score.possible).toBe(100);
  });

  it('and a courier that loses everything scores only the bands that reward absence', () => {
    // Everything returned: delivery 0, collection 0 (nothing landed, so
    // null), failure full marks (nothing failed), return nothing.
    const { decided: d, input: i } = courierRates({ landed: 0, failed: 0, returned: 30, settled: 0 });
    const score = scoreCourier(i, { sample: d });
    expect(score.bands.find((b) => b.key === 'delivery_rate')!.points).toBe(0);
    expect(score.bands.find((b) => b.key === 'return_rate')!.points).toBe(0);
    expect(score.bands.find((b) => b.key === 'failure_rate')!.points, 'لا شيءَ تعذّر، فالبندُ كامل').toBe(15);
    expect(score.total).toBe(15);
  });
});

describe('Ⅲ · below the floor there is no number, and it says why', () => {
  it('the two couriers with nothing read a sentence, not a zero', () => {
    const { decided, input } = courierRates({ landed: 0, failed: 0, returned: 0, settled: 0 });
    const score = scoreCourier(input, { sample: decided });
    expect(score.total, 'صفرٌ يُرتِّبُ مَن لم يُجرَّبْ تحتَ مَن يَفشل').toBeNull();
    expect(score.possible).toBe(0);
    expect(whyNoCourierScore(score)).toContain('لم يُسلَّم إليه');
  });

  it('and nine finished parcels is still below the floor', () => {
    expect(MIN_DECIDED, 'الحدُّ تغيّر وهذا الاختبارُ مبنيٌّ عليه').toBe(10);
    const nine = scoreCourier(courierRates({ landed: 9, failed: 0, returned: 0, settled: 9 }).input, { sample: 9 });
    expect(nine.total).toBeNull();
    expect(whyNoCourierScore(nine)).toContain('9');
    expect(whyNoCourierScore(nine)).toContain('10');
  });

  it('and ten is enough — the floor is a floor, not a gap', () => {
    const ten = scoreCourier(courierRates({ landed: 10, failed: 0, returned: 0, settled: 10 }).input, { sample: 10 });
    expect(ten.total, 'الحدُّ صارَ فجوةً لا أرضيّة').not.toBeNull();
    expect(whyNoCourierScore(ten)).toBeNull();
  });

  it('and every sample from 0 to 20 is on one side of the floor or the other', () => {
    /*
     * WALKED, not sampled. An off-by-one here is a courier that scores at
     * nine parcels or refuses at eleven, and neither shows up in a test
     * that checks 0 and 26.
     */
    const wrong: string[] = [];
    for (let n = 0; n <= 20; n++) {
      const score = scoreCourier(courierRates({ landed: n, failed: 0, returned: 0, settled: n }).input, { sample: n });
      const scored = score.total !== null;
      if (scored !== n >= MIN_DECIDED) wrong.push(`${n} طرداً: ${scored ? 'قُيِّم' : 'رُفض'}`);
    }
    expect(wrong, `الحدُّ لا يُطبَّقُ حيث يَجب:\n${wrong.join('\n')}`).toEqual([]);
  });
});

describe('Ⅳ · the weights are fixed and add up', () => {
  it('to a hundred, so a score is readable as a percentage', () => {
    expect(COURIER_BANDS.reduce((n, b) => n + b.weight, 0)).toBe(100);
  });

  it('and delivery is the heaviest, because it is the whole job', () => {
    const heaviest = [...COURIER_BANDS].sort((a, b) => b.weight - a.weight)[0];
    expect(heaviest.key).toBe('delivery_rate');
  });

  it('and every band has an Arabic name and no two share a key', () => {
    expect(new Set(COURIER_BANDS.map((b) => b.key)).size).toBe(COURIER_BANDS.length);
    for (const b of COURIER_BANDS) {
      expect(b.ar.length, `${b.key} بلا اسم`).toBeGreaterThan(2);
      expect(b.ar, `${b.key} مكتوبٌ بأرقامٍ هندية`).not.toMatch(/[٠-٩]/);
    }
  });

  it('and the two bands where less is better are marked as such', () => {
    const negative = COURIER_BANDS.filter((b) => b.negative).map((b) => b.key).sort();
    expect(negative, 'بندٌ عكسيٌّ بلا علامة — سيُقرأُ كأنّ الإرجاعَ الكثيرَ جيّد').toEqual([
      'failure_rate',
      'return_rate',
    ]);
  });
});

describe('Ⅴ · speed is read against the shop, and refused without a duration', () => {
  const base = courierRates(ARAMEX);
  const speedOf = (value: number | null, reference: number | null) =>
    scoreCourier({ ...base.input, speed: { value, reference } }, { sample: base.decided }).bands.find(
      (b) => b.key === 'speed'
    )!.points;

  it('the fastest courier in the shop takes the band', () => {
    expect(speedOf(24, 24)).toBe(10);
  });

  it('and twice as slow takes half of it', () => {
    expect(speedOf(48, 24)).toBe(5);
  });

  it('and a zero duration is not a measurement — it is this database', () => {
    // Every gap here is zero or one second. Full marks for that would be
    // the engine agreeing with a seeding artefact.
    expect(speedOf(0, 0), 'صفرُ ساعاتٍ صارَ توصيلاً فوريّاً').toBeNull();
    expect(speedOf(0.0003, 0.0003), 'ثانيةٌ واحدةٌ صارت سرعةً كاملة').not.toBeNull();
  });

  it('and a courier with no durations at all scores nothing for speed, not zero', () => {
    expect(speedOf(null, 24)).toBeNull();
  });

  it('and with no reference there is nothing to read it against', () => {
    expect(speedOf(48, null)).toBeNull();
  });
});

describe('Ⅵ · whether «collected» may be scored at all', () => {
  it('is asked once for the shop, and this shop can be asked', () => {
    // MEASURED: 12 of 23 landed parcels are settled.
    expect(courierCollectionTrust(12, 23).level).not.toBe('WITHHELD');
  });

  it('and a shop that has never settled anything withholds the band', () => {
    expect(courierCollectionTrust(0, 23).level).toBe('WITHHELD');
  });
});
