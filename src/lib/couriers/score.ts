import { rateOf } from '../order-state';
import { trustOf, type Trust } from '../cod-vitals';

/**
 * WHICH COURIER GETS THE PARCEL TO THE DOOR — NOT WHICH ONE CARRIES THE MOST.
 *
 * «AI + Score في تسعة مواضع … متابعة الشحن». Eight of those nine places
 * already carry a number and a sentence; this was the ninth that had a
 * sentence and no number. `parcel-tracking/priority.ts` ranks a PARCEL by how
 * urgently it needs chasing, which is a different question — it tells the
 * follow-up clerk what to do next and says nothing at all about whether the
 * courier doing the carrying is any good.
 *
 * And the screen that compares couriers printed raw counts and one bare
 * percentage: «مُسند 26 · مسلَّم 19 · مرتجع 3 · 88% نجاح». Measured on this
 * shop, that is one courier with twenty-six parcels and two with none, and
 * a bare 88% next to a bare «—» invites the reader to compare them. There
 * was no weight, no sample floor, and no sentence saying why a courier has
 * no number.
 *
 * ── WHY THIS IS NOT `channel-score.ts`, AND WHY IT IS ITS TWIN ──
 *
 * That engine scores a DOOR orders come in through: its heaviest band is
 * confirmation — whether the door brings real people — and a courier has
 * no part in that. Its `delivered_value` band reads the basket, which is a
 * product decision and nothing a courier affects. Different subject,
 * separate engine; scoring a courier through it would mean inventing a
 * channel called «أرامكس».
 *
 * EVERY CONVENTION IS BORROWED, deliberately, so the two read as one idea:
 *
 *   the weights are FIXED in code and are never editable fields, because a
 *   number whose weights move cannot be compared with last month's;
 *
 *   a band that could not be measured scores NULL, never zero, and drops
 *   out of the total the row is «out of» — so a score reads «72 من 90» and
 *   the missing ten points name themselves;
 *
 *   below the sample floor there is no number at all, because a delivery
 *   rate over four parcels is noise and a noisy score shown once is
 *   believed for a month.
 *
 * ── AND THE DENOMINATOR IS WHAT THE COURIER FINISHED ──
 *
 * Not what it was handed. A parcel still in a van is not a verdict on
 * anybody: counting it against the courier means a courier handed fifty
 * parcels this morning scores worse than one handed none. So every rate
 * here is out of `decided` — delivered, partly delivered, failed or
 * returned — which is the same denominator
 * `/api/orders/shipping/performance` already used for its success rate.
 *
 * A PARTIAL DELIVERY COUNTS AS DELIVERED. The courier got the parcel to the
 * customer and the customer kept some of it; the refused lines are a return
 * and are counted as one in their own band. The performance route's own
 * comment records this: leaving partials out made every rate run over a
 * silently smaller population and «a courier who got most of the parcel to
 * the door scored nothing for it».
 *
 * ── ONE BAND CANNOT BE MEASURED ON THIS SHOP, AND SAYS SO ──
 *
 * MEASURED when this was written: 23 deliveries carry both timestamps, and
 * the gap between shipping and delivery is ZERO OR ONE SECOND on every one
 * of them. There are no real durations in this database, so `speed` is
 * declared, refused, and explains itself — rather than scoring every
 * courier full marks for an instant delivery that never happened. The day
 * real durations land it starts scoring by itself.
 *
 * Collection, by contrast, IS measurable here — 12 of 23 delivered parcels
 * are settled — which is the one place this engine's data is better off
 * than the channel engine's.
 */

export type CourierBandKey = 'delivery_rate' | 'return_rate' | 'failure_rate' | 'collection_rate' | 'speed';

export interface CourierBand {
  key: CourierBandKey;
  ar: string;
  /** Fixed. Not a setting, not a column, not a field on any screen. */
  weight: number;
  /** Less is better. */
  negative?: boolean;
  /**
   * `rate` values are whole-number percentages, 0..100 — the unit `rateOf`
   * produces everywhere in this system. `hours` is a duration read against
   * the fastest courier in the same shop.
   */
  unit: 'rate' | 'hours';
}

/**
 * THE BANDS, AND WHY EACH ONE EARNS WHAT IT DOES.
 *
 *   DELIVERY 35 — the heaviest, because it is the whole job: of what this
 *   courier finished with, how much reached a customer.
 *
 *   RETURN 20 — the parcel we paid to send and paid to get back, with goods
 *   that travelled for nothing. Weighted apart from delivery rather than
 *   folded into it, because a courier can deliver most parcels and still
 *   return heavily on one region or one kind of customer.
 *
 *   COLLECTION 20 — whether the money came back to us. A courier who
 *   delivers perfectly and settles late is a cash-flow problem wearing a
 *   good delivery rate, and nothing on the old screen could say that.
 *
 *   FAILURE 15 — an attempt that did not land and is not a return yet. It
 *   is lighter than a return because it is recoverable — a second attempt
 *   often works — and it is here at all because each one is a trip we pay
 *   for.
 *
 *   SPEED 10 — the lightest, and unmeasurable on this database today. Days
 *   in transit are the customer's experience rather than our loss, and a
 *   courier who is slow but lands everything is still the one to use. It
 *   keeps its weight so the day durations are real the score gets stricter
 *   rather than changing shape.
 */
export const COURIER_BANDS: readonly CourierBand[] = [
  { key: 'delivery_rate', ar: 'نسبة التسليم', weight: 35, unit: 'rate' },
  { key: 'return_rate', ar: 'نسبة الإرجاع', weight: 20, negative: true, unit: 'rate' },
  { key: 'collection_rate', ar: 'نسبة التحصيل', weight: 20, unit: 'rate' },
  { key: 'failure_rate', ar: 'نسبة تعذّر التوصيل', weight: 15, negative: true, unit: 'rate' },
  { key: 'speed', ar: 'سرعة التوصيل', weight: 10, unit: 'hours' },
];

/**
 * The floor under the whole score.
 *
 * Ten, the same number `health.ts` puts under every rate it judges and
 * `channel-score.ts` under every channel — deliberately identical, because
 * a courier whose delivery rate `health.ts` refuses to grade must not be
 * handed a score built mostly out of that same rate.
 *
 * Measured: of three couriers on this shop, ONE has twenty-six finished
 * parcels and two have none at all. So two of the three must read «لا
 * يكفي» with a reason, and the floor is what produces that instead of a
 * zero that ranks them below the one that works.
 */
export const MIN_DECIDED = 10;

export interface CourierBandInput {
  /** The raw figure in the band's own unit. Null = nothing was measurable. */
  value: number | null;
  /** What it is measured against, for the bands that need one. */
  reference?: number | null;
}

export type CourierScoreInput = Partial<Record<CourierBandKey, CourierBandInput>>;

export interface ScoredCourierBand {
  key: CourierBandKey;
  ar: string;
  weight: number;
  /** Null when this band had nothing to measure — NOT zero. */
  points: number | null;
  value: number | null;
  reference: number | null;
  unit: CourierBand['unit'];
  negative: boolean;
}

export interface CourierScore {
  /** Null when the sample is too small for any of this to mean anything. */
  total: number | null;
  /** The weights that actually applied. The row says «out of» this. */
  possible: number;
  bands: ScoredCourierBand[];
  /** Parcels this courier FINISHED — the denominator of every rate. */
  sample: number;
  minSample: number;
  reason: 'BELOW_MINIMUM' | null;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * One band's points, or null when it could not be measured.
 *
 * Every mapping is linear and every constant is above, because a band whose
 * curve nobody can restate in a sentence is a band the owner cannot argue
 * with — and being able to argue with it is most of what makes a grade
 * worth showing.
 */
function pointsFor(key: CourierBandKey, input: CourierBandInput | undefined, weight: number): number | null {
  if (!input || input.value === null || !Number.isFinite(input.value)) return null;
  const value = input.value;
  const reference = input.reference ?? null;

  switch (key) {
    // The rate IS the fraction of the band: 88% of 35 is 31.
    case 'delivery_rate':
    case 'collection_rate':
      return (clamp(value, 0, 100) / 100) * weight;

    // Nothing coming back, and nothing failing, is full marks.
    case 'return_rate':
    case 'failure_rate':
      return (1 - clamp(value, 0, 100) / 100) * weight;

    /**
     * SPEED IS READ AGAINST THE FASTEST COURIER IN THE SAME SHOP, because
     * «fast» has no absolute meaning: two days to a village is excellent
     * and two days across one city is not. Alone, you are the fastest —
     * which is true, and harmless in a measuring tool.
     *
     * A non-positive duration is not a measurement. Measured on this
     * database, EVERY delivery has a gap of zero or one second, so this
     * band answers null here rather than awarding every courier ten points
     * for an instant delivery that did not happen.
     */
    case 'speed':
      if (value <= 0) return null;
      if (reference === null || reference <= 0) return null;
      return clamp(reference / value, 0, 1) * weight;
  }
}

/**
 * The score, band by band.
 *
 * The total is the sum of the ROUNDED bands, not the rounded sum: a row
 * whose parts do not add up to its headline is a row nobody believes, and
 * being believed is the entire job of this number.
 */
export function scoreCourier(input: CourierScoreInput, opts: { sample: number; minSample?: number }): CourierScore {
  const minSample = opts.minSample ?? MIN_DECIDED;
  const sample = Number.isFinite(opts.sample) && opts.sample > 0 ? Math.floor(opts.sample) : 0;

  const bands: ScoredCourierBand[] = COURIER_BANDS.map((band) => {
    const raw = pointsFor(band.key, input[band.key], band.weight);
    return {
      key: band.key,
      ar: band.ar,
      weight: band.weight,
      points: raw === null ? null : Math.round(raw),
      value: input[band.key]?.value ?? null,
      reference: input[band.key]?.reference ?? null,
      unit: band.unit,
      negative: band.negative ?? false,
    };
  });

  if (sample < minSample) {
    return { total: null, possible: 0, bands, sample, minSample, reason: 'BELOW_MINIMUM' };
  }

  const scored = bands.filter((b) => b.points !== null);
  return {
    total: scored.reduce((s, b) => s + (b.points ?? 0), 0),
    possible: scored.reduce((s, b) => s + b.weight, 0),
    bands,
    sample,
    minSample,
    reason: null,
  };
}

/**
 * WHY A COURIER HAS NO SCORE, IN A SENTENCE THE OWNER CAN ACT ON.
 *
 * «لا يكفي» on its own invites the reader to assume the courier is bad.
 * The count and the floor together say the opposite: nothing is known about
 * this courier yet, which is a reason to try them rather than to drop them.
 */
export function whyNoCourierScore(score: CourierScore): string | null {
  if (score.reason !== 'BELOW_MINIMUM') return null;
  if (score.sample === 0) return 'لم يُسلَّم إليه طردٌ انتهى أمرُه بعد — لا شيءَ يُحكَمُ عليه.';
  return `${score.sample} طردٍ منتهٍ فقط — تحت ${score.minSample}، والحكمُ على عيّنةٍ بهذا الصغر تخمين.`;
}

/**
 * WHETHER «COLLECTED» MAY BE SCORED AT ALL, FOR THE WHOLE SHOP.
 *
 * Asked once over every delivered parcel rather than per courier, because
 * the answer is a fact about the settlement process and not about any one
 * carrier: if nobody in this shop has ever settled a statement, then no
 * courier's collection rate means anything, and three couriers each
 * scoring zero would rank them by a tie and call it a finding.
 *
 * The gate is `trustOf` — the same one that refuses the profit margin when
 * the cost field is empty. Same question in a different column: is the
 * field this figure rests on actually written.
 *
 * Measured here: 12 of 23 delivered parcels are settled, so this shop CAN
 * be asked. The channel engine's identical band is refused on the same
 * database for the same reason inverted — it asks about orders rather than
 * parcels, and no order has ever been marked collected.
 */
export function courierCollectionTrust(settled: number, delivered: number): Trust {
  return trustOf({ present: settled, population: delivered, subject: 'التحصيل' });
}

/**
 * THE RATES, FROM COUNTS, IN ONE PLACE.
 *
 * The performance route computed three of these inline and the tracking
 * screen computed none; a second copy of «what is the denominator» is how
 * two screens come to disagree about the same courier. `decided` is the
 * answer and it is returned too, because it is also the sample the floor is
 * applied to and a caller deriving it again would be free to derive it
 * differently.
 */
export function courierRates(counts: {
  /**
   * PARCELS THAT REACHED A CUSTOMER, partial deliveries INCLUDED.
   *
   * One number, not `delivered` plus `partial`, and that is the whole
   * reason: `whereDelivered()` in order-state.ts is already
   * `DELIVERED + PARTIALLY_DELIVERED`, so a caller counting with it and
   * handing both fields would count every partial twice — and a delivery
   * rate over 100% is a number somebody has to debug on a live screen.
   * The definition lives in one place and this takes its answer.
   */
  landed: number;
  failed: number;
  returned: number;
  settled: number;
}): { decided: number; input: CourierScoreInput } {
  const landed = Math.max(0, counts.landed);
  const decided = landed + Math.max(0, counts.failed) + Math.max(0, counts.returned);
  return {
    decided,
    input: {
      delivery_rate: { value: rateOf(landed, decided) },
      return_rate: { value: rateOf(Math.max(0, counts.returned), decided) },
      failure_rate: { value: rateOf(Math.max(0, counts.failed), decided) },
      // Out of what LANDED, not out of what was decided: there is no money
      // to collect on a parcel that came back.
      collection_rate: { value: rateOf(Math.max(0, counts.settled), landed) },
    },
  };
}
