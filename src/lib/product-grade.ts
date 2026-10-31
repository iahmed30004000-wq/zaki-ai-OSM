import { rateOf } from './order-state';
import { rowCostStated } from './cod-vitals';
import { HEALTH_AR, type HealthTone } from './health';

/**
 * «المنتجات: AI + Score» — WHAT A PRODUCT'S GRADE CAN HONESTLY SAY.
 *
 * The owner wrote it twice. It is the last of the nine screens he asked for
 * a grade on, and «AI» in his note means the same thing it meant on the
 * other eight: let the screen tell me something instead of making me work
 * it out. NO MODEL IS CALLED HERE and nothing in this file could call one.
 * Every sentence below is a template around an integer somebody can count
 * by hand — and being countable by hand is the whole point, because a
 * sentence a model produced cannot be argued with.
 *
 * ─────────────────────────────────────────────────────────────────────
 * MEASURED FIRST, ON THE DEV DATABASE, 2026-09-29 — AND THE NUMBERS
 * CHANGED THE DESIGN THREE TIMES
 * ─────────────────────────────────────────────────────────────────────
 *
 *   114 products, every one ACTIVE. 12 have ever appeared on an order
 *     line. 102 have never been ordered at all.
 *   171 orders: 164 confirmed, 119 delivered, 32 returned.
 *   Ever-confirmed lines per product: 74, 31, 29, 8, 7, 6, 3, 2, 2, 1, 1, 0.
 *     So THREE products clear a floor of ten, and the fourth-busiest has
 *     eight. A grade is possible on three rows out of a hundred and
 *     fourteen, and pretending otherwise would mean inventing a floor low
 *     enough to grade a product that sold twice.
 *   Their delivery rates are 73%, 84% and 76% — a real spread, which is
 *     why the heaviest band is worth having at all.
 *   87% of the orders were created on ONE day (2026-09-10) and 96% of the
 *     deliveries landed on ONE day (2026-09-15, 114 of 119). Anything
 *     time-shaped is unmeasurable on this record, and two candidate bands
 *     died of it — see the refusals below.
 *   `estimatedCostOfGoods` is recorded on 4 of 119 delivered orders, and on
 *     NONE of the three products that can be graded. So the margin band is
 *     declared, weighted, permissioned — and null on every graded row
 *     today, which is why the score reads «من 70» rather than «من 100».
 *   90 of 114 products carry no `basePrice` at all, 113 of 114 no image,
 *     114 of 114 no category. Including the five products that brought
 *     almost every delivered pound in the shop.
 *
 * ─────────────────────────────────────────────────────────────────────
 * TWO AXES, DELIBERATELY NOT ADDED TOGETHER
 * ─────────────────────────────────────────────────────────────────────
 *
 * PERFORMANCE — a banded score out of what could be measured. It speaks
 * for 3 of 114 products, and for the other 111 it says which of four
 * different things is true of them.
 *
 * READINESS — whether the catalogue record is complete enough to sell the
 * thing at all. It speaks for all 114, needs no sample, and every gap it
 * names is a field on the products screen's own edit form.
 *
 * They are printed side by side and NEVER summed, for the reason
 * `employee-grade.ts` gives for keeping quality and presence apart: a
 * product with a perfect record and no price is not the same thing as one
 * with a price and a terrible record, and a single fused figure would hide
 * both. And the arithmetic reason is sharper here: a floor of ten confirmed
 * orders hides the score on 111 rows, so folding readiness into it would
 * hide the ONE thing this screen can say about 111 products behind a floor
 * that has nothing to do with it.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT `channel-score.ts`, AND WHAT IS BORROWED FROM IT
 * ─────────────────────────────────────────────────────────────────────
 *
 * `channel-score` scores DOORS. Its five bands are keyed to a channel's
 * funnel — confirmation, collection, the value of one order through that
 * door — and its docblock already explains why it is not
 * `performance-score.ts`, which scores PEOPLE. A product is a third
 * subject: it is the only one of the three that can be UNSELLABLE while
 * performing perfectly, and the only one whose grade has to answer for a
 * record 102 rows of which have never traded.
 *
 * Every convention is borrowed on purpose, so the three read as one idea:
 *
 *   the weights are FIXED in code and are never editable fields;
 *   a band that could not be measured scores NULL, never zero, and drops
 *     out of the total the row is «out of» — so a score reads «41 من 70»
 *     and the missing thirty points name themselves;
 *   below the sample floor there is no number at all;
 *   a band that this record cannot carry is declared, refused, and SAYS SO
 *     — which is exactly what `collection_rate` does over there.
 *
 * And the floor is the same TEN that `health.ts` puts under every rate it
 * judges and `channel-score.MIN_CONFIRMED` puts under a door: a product
 * whose delivery rate `health.ts` refuses to grade must not be handed a
 * score built mostly out of that same rate.
 */

// ─── THE BANDS ───

export type ProductBandKey = 'delivery_rate' | 'goods_margin' | 'delivered_value';

export interface ProductBand {
  key: ProductBandKey;
  ar: string;
  /** Fixed. Not a setting, not a column, not a field on any screen. */
  weight: number;
  /** `rate` is a whole-number percentage 0..100 — the unit `rateOf` produces. */
  unit: 'rate' | 'money';
}

/**
 * THE BANDS, AND WHY EACH ONE EARNS WHAT IT DOES.
 *
 *   DELIVERY 50 — the owner's actual question about a product: of what we
 *   agreed to send, how much a customer actually took. Half the score,
 *   because in a cash-on-delivery shop a product that does not land is not
 *   a product, and the measured spread across the three gradeable rows is
 *   eleven points of delivery rate.
 *
 *   MARGIN 30 — what one delivered unit LEFT us with. It keeps its weight
 *   although it is null on every graded row today, so that the day somebody
 *   starts recording the cost of goods the score gets STRICTER rather than
 *   changing shape. That is the same decision `channel-score` made for
 *   collection.
 *
 *   VALUE 20 — what one DELIVERED order of this product is worth, against
 *   the best product in the same shop. The lightest, because a small basket
 *   is a pricing decision more than a product one — but it is here because
 *   an order worth 19 and one worth 22 are different businesses at the same
 *   delivery rate, and nothing on the products screen could say that.
 */
export const PRODUCT_BANDS: readonly ProductBand[] = [
  { key: 'delivery_rate', ar: 'نسبة التسليم', weight: 50, unit: 'rate' },
  { key: 'goods_margin', ar: 'هامش الوحدة المسلَّمة', weight: 30, unit: 'rate' },
  { key: 'delivered_value', ar: 'قيمة الطلب المسلَّم', weight: 20, unit: 'money' },
];

export function productBand(key: ProductBandKey): ProductBand {
  return PRODUCT_BANDS.find((b) => b.key === key)!;
}

/**
 * EVERY BAND THAT WAS TESTED AGAINST THIS RECORD AND REFUSED — AND THE
 * MEASUREMENT THAT KILLED IT.
 *
 * Kept in the code rather than in a commit message, because the next person
 * to be asked for «AI + Score» on this screen will reach for exactly these
 * four, and the reason each one is absent is a fact about the data that
 * they would otherwise have to rediscover.
 *
 *   RETURN RATE — returns out of what the product has FINISHED with. It is
 *   not an independent fact HERE: the three gradeable products have 2, 0
 *   and 0 confirmed orders still open, so returned = confirmed − delivered
 *   almost exactly, and the band would restate the delivery band backwards.
 *   Measured: delivery 73/84/76 against 100 − return of 75/84/76. A score
 *   whose bands all restate one number is that number with extra
 *   arithmetic, so one of the two had to go, and delivery is the one the
 *   owner asks for out loud. The counts are still RETURNED on the row, as
 *   facts beside the grade rather than as points inside it.
 *
 *   LAST SOLD / RECENCY — 96% of this shop's deliveries landed on one day,
 *   and the last delivery of each of the three gradeable products is 13.6,
 *   13.5 and 13.6 days ago. A band returning the same number for every row
 *   measures the day the data was imported, not the product. It is also
 *   already owned: `stock-health.recencyBand` reads that date for the
 *   inventory screen.
 *
 *   STOCK COVER — owned outright by `stock-health.ts`, which grades exactly
 *   this for the balances screen, with nine states, three bands and its own
 *   floors. A second, cruder answer to «هل يكفي المخزون» on a second screen
 *   is how `avgCostPerUnit` came to have two values on one page.
 *
 *   CONFIRMATION REFUSAL — the whole company has 7 refusals, of which 3
 *   name a product-side reason (2 × CUSTOMER_DOES_NOT_WANT_PRODUCT, 1 ×
 *   PRICE_TOO_HIGH); the three gradeable products carry 0, 0 and 1 between
 *   them. There is nothing to measure yet, and `deliveryFailureReason` is
 *   null on all 171 orders, so the door cannot be asked either.
 *
 *   BASKET DEPTH — units per delivered order, measured 1.93, 1.15 and 1.18.
 *   Genuinely independent of the delivery rate, and refused anyway because
 *   it is `delivered_value ÷ unit price`: with the value band present it
 *   would be the same money counted a second time.
 */
export const REFUSED_BANDS = ['return_rate', 'last_sold', 'stock_cover', 'confirmation_rate', 'basket_depth'] as const;

/**
 * The floor under the whole score: ten confirmed orders.
 *
 * `health.ts` puts ten under every rate it judges and `channel-score` puts
 * ten under a door. MEASURED: three of this shop's products clear it (74,
 * 31 and 29 confirmed lines) and the fourth has eight. Lowering it to eight
 * would buy one more graded row and cost the meaning of every row.
 */
export const MIN_CONFIRMED_ORDERS = 10;

// ─── THE FACTS, AS THE ROUTE READS THEM ───

/**
 * What the record says about this product's trading. Plain numbers only:
 * this file reads no database and derives no total the route could have
 * derived differently.
 */
export interface ProductSales {
  /** Order lines for this product whose order was CONFIRMED — the sample. */
  confirmed: number;
  /** Of those, lines whose order reached a customer. The delivery band. */
  delivered: number;
  /** Lines whose parcel came back or is coming back. A fact, never a band. */
  returned: number;
  /** Lines refused on the phone before anything was sent. Also a fact only. */
  refused: number;
  /** Money from the delivered ones, by the rule the profit screen uses. */
  deliveredRevenue: number;
  /**
   * Recorded cost of goods against that revenue.
   *
   * NULL MEANS «THIS CALLER MAY NOT SEE COST» — not «zero» and not «none
   * recorded», which is a separate case with its own sentence. A zero here
   * would be a claim that the goods were free, and `cost-visibility.ts`
   * exists because this very endpoint once made claims like that.
   */
  deliveredCogs: number | null;
  /**
   * The best delivered-order value among the store's own products, for the
   * money band's ceiling. Null when no product in the shop has one.
   *
   * The caller computes it, over the whole store and over the products that
   * themselves clear the floor — a sample too thin to be graded is too thin
   * to grade everybody else against. The route carries the measurement that
   * forced that rule.
   */
  bestDeliveredValue: number | null;
}

/** The catalogue record — the three fields this screen's own form can fix. */
export interface ProductCatalogue {
  /** ACTIVE, INACTIVE, OUT_OF_STOCK. A withdrawn product is not a defect. */
  status: string;
  basePrice: number;
  imageCount: number;
  hasCategory: boolean;
}

export interface ProductFacts {
  productId: string;
  catalogue: ProductCatalogue;
  /** NULL MEANS «THIS CALLER MAY NOT SEE PERFORMANCE» — see `SALES_HIDDEN`. */
  sales: ProductSales | null;
}

// ─── THE SCORE ───

export interface ScoredProductBand {
  key: ProductBandKey;
  ar: string;
  weight: number;
  /** Null when this band had nothing to measure — NOT zero. */
  points: number | null;
  /** The measured figure in the band's own unit, for the reader to check. */
  value: number | null;
  /** What it was measured against, for the bands that need one. */
  reference: number | null;
  unit: ProductBand['unit'];
  /** Why it earned that, or why it earned nothing. Never left to be inferred. */
  why: string;
}

export interface ProductScore {
  /** Null when the sample cannot carry any of this. */
  total: number | null;
  /** The weights that actually applied. The row says «من» this. */
  possible: number;
  bands: ScoredProductBand[];
  /** Confirmed orders — the denominator of the heaviest band. */
  sample: number;
  minSample: number;
}

/**
 * WHY A PRODUCT HAS NO SCORE — EXACTLY ONE OF THESE IS TRUE OF ANY ROW.
 *
 * Five states rather than one blank, for the reason `employee-grade.ts`
 * gives: a column blank on 111 of 114 rows teaches a reader that the
 * feature is broken, while 111 rows each naming which of four things is
 * true is the same record, usable. They are checked in order, most
 * informative first.
 */
export const PRODUCT_GRADE_STATES = [
  /** The caller may see the catalogue but not how it performs. */
  'SALES_HIDDEN',
  /**
   * Not one order line IN THE WINDOW the grade reads (ninety days). Never «ever»: the window is all this grade can see, and
   * four products that delivered 103 to 154 units were told «لم يُطلب قطّ» (31/10) because their orders were older.
   */
  'NEVER_ORDERED',
  /** Ordered in the window and never confirmed — refused on the phone every time. */
  'NEVER_CONFIRMED',
  /** Confirmed, but under the floor. Nothing is wrong; there is not enough. */
  'THIN_SAMPLE',
  /** The bands speak. */
  'GRADED',
] as const;

export type ProductGradeState = (typeof PRODUCT_GRADE_STATES)[number];

const STATE_LABEL: Record<ProductGradeState, string> = {
  SALES_HIDDEN: 'الأداء محجوب',
  NEVER_ORDERED: 'لا طلب في الفترة',
  NEVER_CONFIRMED: 'لا تأكيد في الفترة',
  THIN_SAMPLE: HEALTH_AR.unknown,
  GRADED: 'مقيَّم',
};

/**
 * «مقيَّم» IS GREEN AND IT DOES NOT MEAN «GOOD PRODUCT».
 *
 * It means the record can speak about this one. The total beside it is left
 * uncoloured, exactly as `ScoreCard` and the employees row leave theirs:
 * there is no owner-set bar for a composite out of seventy, and painting
 * one green would be this screen inventing a bar nobody set.
 *
 * AND NOTHING HERE IS RED. Not one of the four ungraded states is a fault
 * of the product: 102 rows have never been ordered, and 102 red chips would
 * teach the reader to ignore red by Thursday — the argument `stock-health`
 * makes for painting `no_sales` grey rather than amber. The red on this
 * screen belongs to readiness, where there is something to fix.
 */
function toneOf(state: ProductGradeState): HealthTone {
  return state === 'GRADED' ? 'good' : 'unknown';
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round2 = (n: number) => Number(n.toFixed(2));

/**
 * ONE BAND, WITH ITS SENTENCE.
 *
 * Every mapping is linear and every constant is named above, because a band
 * whose curve nobody can restate in a sentence is a band the owner cannot
 * argue with — and being able to argue with it is most of what makes a
 * grade worth showing.
 */
function bandOf(band: ProductBand, s: ProductSales): ScoredProductBand {
  const out = (points: number | null, value: number | null, reference: number | null, why: string): ScoredProductBand => ({
    key: band.key,
    ar: band.ar,
    weight: band.weight,
    points: points === null ? null : Math.round(clamp(points, 0, band.weight)),
    value,
    reference,
    unit: band.unit,
    why,
  });

  switch (band.key) {
    /**
     * Out of what was CONFIRMED, never out of everything brought: an order
     * nobody confirmed was never the courier's to deliver, and counting it
     * against the product blames the wrong step. The same denominator
     * `attribution-performance` and `channel-score` already use.
     */
    case 'delivery_rate': {
      const rate = rateOf(s.delivered, s.confirmed);
      if (rate === null) return out(null, null, null, 'لا طلبَ مؤكَّداً يُقاس عليه التسليم.');
      // The rate IS the fraction of the band: 73% of 50 is 37.
      return out(
        (rate / 100) * band.weight,
        rate,
        null,
        `${s.delivered} من ${s.confirmed} طلباً مؤكَّداً وصلت إلى عميل، أي ${rate}%.`
      );
    }

    /**
     * WHAT ONE DELIVERED UNIT LEFT US WITH — AND THE THREE WAYS IT REFUSES
     * ITSELF.
     *
     * The cost is the one the profit screen already prints per product:
     * `estimatedCostOfGoods` on the delivered orders, which is the money
     * that ACTUALLY left when the goods left. `product-cost.ts` says why
     * that and not the shelf's current average — «the cost of a sold unit
     * was read at the moment it sold» — and the shop's own per-product
     * profit table is gated on exactly this field by `rowCostStated`.
     * Building this band on the on-hand average instead would put a margin
     * of 95% on the products screen for a product whose margin the
     * performance screen refuses to state, under nearly the same Arabic
     * label. That is the `avgCostPerUnit` fault this very endpoint was just
     * repaired for, and once is enough.
     *
     * It is a GOODS margin and it says so in its name: the courier's fee is
     * charged per PARCEL, and apportioning one fee between two products on
     * one waybill is a rule nobody in this system has written. Measured: 0
     * of 171 orders carry a second line today, so the temptation is real
     * and the day it breaks is invisible. `expense-grade` and the profit
     * screen own the shop's NET margin; this is not it.
     */
    case 'goods_margin': {
      if (s.deliveredCogs === null) {
        return out(null, null, null, 'كلفة البضاعة لا تُعرَض لهذا الحساب، فلا هامشَ يُحسَب هنا — والدرجة من أقلّ.');
      }
      if (s.deliveredRevenue <= 0) {
        return out(null, null, null, 'لا إيرادَ مسلَّماً بعد، ولا هامشَ على فراغ.');
      }
      if (!rowCostStated({ revenue: s.deliveredRevenue, cogs: s.deliveredCogs })) {
        return out(
          null,
          null,
          null,
          'لا كلفةَ بضاعةٍ مسجَّلةً على طلباته المسلَّمة — والهامش بلا كلفةٍ هو الإيراد نفسه، فلا يُقال.'
        );
      }
      const margin = Math.round(((s.deliveredRevenue - s.deliveredCogs) / s.deliveredRevenue) * 100);
      // A negative margin scores nothing and is still PRINTED: selling under
      // cost is the finding, and hiding the number hides it.
      return out(
        (clamp(margin, 0, 100) / 100) * band.weight,
        margin,
        null,
        `إيرادٌ مسلَّمٌ ${round2(s.deliveredRevenue)} وكلفةُ بضاعةٍ ${round2(s.deliveredCogs)} — أي هامشُ بضاعةٍ ${margin}% قبل الشحن والعمولة.`
      );
    }

    /**
     * Money has no natural ceiling, so it is read against the best product
     * in the same shop — the rule `channel-score.delivered_value` set for
     * the same unit. Alone, you are the best, which is true and harmless in
     * a measuring tool.
     */
    case 'delivered_value': {
      if (s.delivered <= 0 || s.deliveredRevenue <= 0) {
        return out(null, null, null, 'لا طلبَ مسلَّماً بعد، فلا قيمةَ لطلبٍ تُقاس.');
      }
      const value = round2(s.deliveredRevenue / s.delivered);
      const best = s.bestDeliveredValue;
      if (best === null || best <= 0) {
        return out(band.weight, value, null, `الطلبُ المسلَّمُ من هذا المنتج يساوي ${value} — ولا منتجَ آخرَ في المتجر سلَّم شيئاً يُقاس عليه.`);
      }
      return out(
        clamp(value / best, 0, 1) * band.weight,
        value,
        round2(best),
        `الطلبُ المسلَّمُ يساوي ${value}، وأعلى منتجٍ في المتجر ${round2(best)}.`
      );
    }
  }
}

// ─── READINESS ───

export const READINESS_GAP_KEYS = ['price', 'image', 'category'] as const;
export type ReadinessGapKey = (typeof READINESS_GAP_KEYS)[number];

export interface ReadinessGap {
  key: ReadinessGapKey;
  ar: string;
  /** What this specific absence stops, in words. Never «حقلٌ مفقود». */
  why: string;
  /** Blocking gaps stop the product being sold at all. */
  blocking: boolean;
}

export interface ProductReadiness {
  tone: HealthTone;
  label: string;
  gaps: ReadinessGap[];
  /** The whole verdict in one sentence, with the gaps named. */
  why: string;
  /** Whether a customer could be sold this today through the shop's own doors. */
  sellable: boolean;
}

/**
 * WHETHER THE RECORD IS COMPLETE ENOUGH TO SELL THE THING.
 *
 * Three checks, and they are three because these are the three fields the
 * products screen's own form owns — a reader who sees the gap can close it
 * without leaving the row.
 *
 * WHY «NO PRICE» BLOCKS AND THE OTHER TWO DO NOT, MEASURED RATHER THAN
 * ASSUMED. `storefront.ts` selects the public catalogue with `status:
 * 'ACTIVE', basePrice: { gt: 0 }` — twice, for the list and for the single
 * product — and `public-order.ts` falls back to `product.basePrice` when no
 * offer applies. So a product at zero is not merely untidy: it cannot
 * appear in the store and cannot be quoted by a landing page. 90 of 114
 * products on this database are in that state, including the five that
 * brought almost every delivered pound in the shop. An ACTIVE offer does
 * NOT rescue it — the storefront query filters on `basePrice` before offers
 * are ever read, and measured, 0 products are priced through an offer
 * alone. Neither of the other two appears in any `where` clause: a product
 * with no image is sold badly, not blocked.
 *
 * AND STOCK IS NOT ASKED ABOUT HERE. `stock-health.ts` grades the stock
 * position for the balances screen — nine states, its own floors, its own
 * alerts row. A cruder «بلا مخزون» chip on this screen would be a second
 * answer to one question, which is the fault this endpoint was repaired for
 * a fortnight ago.
 */
export function productReadiness(c: ProductCatalogue): ProductReadiness {
  // A product deliberately withdrawn is not a defective record. Measured:
  // all 114 are ACTIVE today, so this costs nothing and stops the screen
  // shouting at somebody who turned a product off on purpose.
  if (c.status !== 'ACTIVE') {
    return {
      tone: 'unknown',
      label: 'مسحوبٌ من العرض',
      gaps: [],
      why: `حالةُ المنتج «${c.status}» — مسحوبٌ من العرض بقرار، فلا يُحاسَب على نقص بياناته.`,
      sellable: false,
    };
  }

  const gaps: ReadinessGap[] = [];
  if (!(c.basePrice > 0)) {
    gaps.push({
      key: 'price',
      ar: 'بلا سعر',
      why: 'لا سعرَ أساسيّاً — والمتجر لا يعرض إلا ما سعرُه أكبر من صفر، وصفحةُ الهبوط تسعّر منه. لا يُباع من أيّ بابٍ عامّ.',
      blocking: true,
    });
  }
  if (c.imageCount <= 0) {
    gaps.push({
      key: 'image',
      ar: 'بلا صورة',
      why: 'لا صورةَ واحدة — يُعرض ويُباع، لكن على صفحةٍ لا يُرى فيها.',
      blocking: false,
    });
  }
  if (!c.hasCategory) {
    gaps.push({
      key: 'category',
      ar: 'بلا تصنيف',
      why: 'لا تصنيف — والتصنيف يحدّد من يرى المنتج، وكيف تُجمَّع تقاريره، وما يستطيع المساعد الإجابة عنه.',
      blocking: false,
    });
  }

  if (gaps.length === 0) {
    return {
      tone: 'good',
      label: 'جاهزٌ للبيع',
      gaps,
      why: 'سعرٌ وصورةٌ وتصنيف — لا ينقصه شيءٌ من بيانات العرض.',
      sellable: true,
    };
  }

  const blocking = gaps.filter((g) => g.blocking);
  const names = gaps.map((g) => g.ar).join('، ');
  return {
    tone: blocking.length > 0 ? 'bad' : 'ok',
    label: blocking.length > 0 ? 'لا يُعرض للبيع' : 'ناقصُ بيانات',
    gaps,
    why: `${names} — ${gaps.map((g) => g.why).join(' ')}`,
    sellable: blocking.length === 0,
  };
}

// ─── ONE ROW ───

export interface ProductGrade {
  productId: string;
  state: ProductGradeState;
  tone: HealthTone;
  /** Two words for the chip. Never a number pretending to be a verdict. */
  label: string;
  /** Why it says that, with the counted numbers in it, for the line beneath. */
  why: string;
  /** Null for every state but GRADED. Never a zero standing in for «unknown». */
  score: ProductScore | null;
  /** What the record says, beside the grade rather than inside it. */
  sales: ProductSales | null;
  readiness: ProductReadiness;
}

/**
 * ONE PRODUCT'S GRADE.
 *
 * Pure: counted integers in, a state, a score and two sentences out. It
 * reads no database, opens no clock and asks no model.
 */
export function gradeProduct(facts: ProductFacts, opts: { minSample?: number } = {}): ProductGrade {
  const minSample = opts.minSample ?? MIN_CONFIRMED_ORDERS;
  const readiness = productReadiness(facts.catalogue);
  const s = facts.sales;

  const say = (state: ProductGradeState, why: string, score: ProductScore | null = null): ProductGrade => ({
    productId: facts.productId,
    state,
    tone: toneOf(state),
    label: STATE_LABEL[state],
    why,
    score,
    sales: s,
    readiness,
  });

  // FIRST, because it is a fact about the READER and not about the product:
  // every sentence below would be a claim this caller is not allowed to be
  // told, and «no order in the window» to somebody who simply may not see the orders
  // would be a lie with a number in it.
  if (s === null) {
    return say(
      'SALES_HIDDEN',
      'أداءُ البيع لا يُعرَض لهذا الحساب — يحتاج صلاحيةَ التقارير أو التحليلات. وجاهزيّةُ العرض أدناه بياناتُ كتالوجٍ يراها من يرى المنتج.'
    );
  }

  const ordered = s.confirmed + s.refused;

  // SECOND: it outranks every thinner reason. «0 من 10» invites the reader
  // to wait for a sample to grow; a product nobody has ever ordered is not
  // waiting for anything, and on this database that is 102 rows of 114.
  if (ordered === 0) {
    return say(
      'NEVER_ORDERED',
      'لا سطرَ طلبٍ واحداً على هذا المنتج في فترة التقييم — والدرجة تُقاس على ما حدث فيها، ولم يحدث شيء. وهذا لا يعني أنه لم يُبَع قبلها: المبيعات من أول طلب بعمود «المبيعات». ما ينقصه ليُطلب مكتوبٌ في جاهزيّة العرض.'
    );
  }

  // THIRD: ordered and refused every time. A different fact from «too few»,
  // and a more useful one: the phone said no, which is a reason somebody can
  // go and read in the rejection notes.
  if (s.confirmed === 0) {
    return say(
      'NEVER_CONFIRMED',
      `طُلب ${ordered} مرةً في فترة التقييم ولم يُؤكَّد ولا مرّة — كلُّها رُفضت على الهاتف. لا نسبةَ تسليمٍ تُقاس على صفرِ تأكيد، والسببُ مكتوبٌ في أسباب الرفض على الطلبات نفسها.`
    );
  }

  const bands = PRODUCT_BANDS.map((band) => bandOf(band, s));

  // FOURTH: the floor. MEASURED — the products under it hold 8, 7, 6, 3, 2,
  // 2, 1 and 1 confirmed orders, and a delivery rate over two orders is a
  // coin toss with a reason attached.
  if (s.confirmed < minSample) {
    return say(
      'THIN_SAMPLE',
      `${s.confirmed} طلباً مؤكَّداً فقط، والحدّ الأدنى ${minSample} — لا درجةَ بعد، لأنّ رقماً من عيّنةٍ بهذا الصغر يُصدَّق شهراً كاملاً. ` +
        `وما يُبنى عليه: ${PRODUCT_BANDS.map((b) => b.ar).join('، ')}.`
    );
  }

  // The total is the sum of the ROUNDED bands, not the rounded sum: a row
  // whose parts do not add up to its headline is a row nobody believes, and
  // being believed is the entire job of this number.
  const scored = bands.filter((b) => b.points !== null);
  const score: ProductScore = {
    total: scored.reduce((sum, b) => sum + (b.points ?? 0), 0),
    possible: scored.reduce((sum, b) => sum + b.weight, 0),
    bands,
    sample: s.confirmed,
    minSample,
  };

  const missing = bands.filter((b) => b.points === null);
  const shortfall =
    missing.length > 0
      ? ` وبنودٌ لم تُقَس فسقطت من المجموع: ${missing.map((b) => b.ar).join('، ')}.`
      : '';

  return say(
    'GRADED',
    `${score.total} من ${score.possible} عن ${s.confirmed} طلباً مؤكَّداً.${shortfall}`,
    score
  );
}

/**
 * BEST FIRST, AND «WE CANNOT TELL YET» IS NOT LAST PLACE.
 *
 * The rule `byEmployeeGrade` and `scoreRole` both keep: an ungraded row
 * placed under a measured low scorer reads as worse than it, which is a
 * verdict nobody computed. Graded rows sort by their number; the rest sort
 * by state in the declared order reversed, so the rows nearest to being
 * gradable come first and the hundred that have never been ordered gather
 * at the end where they can be dealt with in one pass.
 */
export function byProductGrade(a: ProductGrade, b: ProductGrade): number {
  const at = a.score?.total ?? null;
  const bt = b.score?.total ?? null;
  if (at !== null && bt !== null) return bt - at;
  if (at !== null) return -1;
  if (bt !== null) return 1;
  const rank = (g: ProductGrade) => PRODUCT_GRADE_STATES.indexOf(g.state);
  return rank(b) - rank(a);
}

// ─── THE WHOLE CATALOGUE, IN ONE SENTENCE ───

export interface CatalogueReadiness {
  total: number;
  graded: number;
  thinSample: number;
  neverConfirmed: number;
  neverOrdered: number;
  salesHidden: number;
  /** Rows carrying a blocking gap — no price. */
  notSellable: number;
  /** Rows missing at least one field of the three. */
  incomplete: number;
  /** How many rows each gap is missing from, so the backlog is one number. */
  gaps: { key: ReadinessGapKey; ar: string; count: number }[];
  /** Every band name the grade is built from, once each. */
  madeOf: string[];
  why: string;
}

/**
 * WHAT THE GRADE IS MADE OF, AND WHAT IS MISSING BEFORE IT CAN SPEAK.
 *
 * The two honest things a screen can say on a day when it can grade three
 * rows out of a hundred and fourteen — and on this database that day is
 * today. It is not a consolation for an empty column: an owner who reads
 * «90 منتجاً بلا سعر» has found the reason his catalogue does not sell
 * itself, which is worth more than a score for three products.
 */
export function catalogueReadiness(grades: readonly ProductGrade[]): CatalogueReadiness {
  const count = (s: ProductGradeState) => grades.filter((g) => g.state === s).length;
  const gapCount = (key: ReadinessGapKey) =>
    grades.filter((g) => g.readiness.gaps.some((x) => x.key === key)).length;
  const gapName = (key: ReadinessGapKey) =>
    grades.flatMap((g) => g.readiness.gaps).find((x) => x.key === key)?.ar ?? key;

  const out = {
    total: grades.length,
    graded: count('GRADED'),
    thinSample: count('THIN_SAMPLE'),
    neverConfirmed: count('NEVER_CONFIRMED'),
    neverOrdered: count('NEVER_ORDERED'),
    salesHidden: count('SALES_HIDDEN'),
    notSellable: grades.filter((g) => g.readiness.gaps.some((x) => x.blocking)).length,
    incomplete: grades.filter((g) => g.readiness.gaps.length > 0).length,
    gaps: READINESS_GAP_KEYS.map((key) => ({ key, ar: gapName(key), count: gapCount(key) })).filter(
      (g) => g.count > 0
    ),
    madeOf: PRODUCT_BANDS.map((b) => b.ar),
  };

  if (out.total === 0) return { ...out, why: 'لا منتجَ في هذه القائمة.' };

  // Only the non-zero parts, so the sentence says what is true of THIS
  // catalogue rather than reciting five categories four of which are empty.
  const parts: string[] = [];
  if (out.graded) parts.push(`${out.graded} له درجة`);
  if (out.thinSample) parts.push(`${out.thinSample} عيّنتُه تحت الحدّ`);
  if (out.neverConfirmed) parts.push(`${out.neverConfirmed} طُلب ولم يُؤكَّد`);
  if (out.neverOrdered) parts.push(`${out.neverOrdered} لم يُطلب في فترة التقييم`);
  if (out.salesHidden) parts.push(`${out.salesHidden} أداؤه محجوبٌ عن هذا الحساب`);

  const gaps = out.gaps.length > 0 ? ` وفي بيانات العرض: ${out.gaps.map((g) => `${g.count} ${g.ar}`).join('، ')}.` : '';

  return { ...out, why: `من ${out.total} منتجاً: ${parts.join('، ')}.${gaps}` };
}
