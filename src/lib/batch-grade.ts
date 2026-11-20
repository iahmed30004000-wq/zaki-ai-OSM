import { HEALTH_AR, type HealthTone } from './health';
import { batchTotal, batchUnitCost } from './product-cost';

/**
 * WHY A BOUGHT PRODUCT IS SITTING ON THE PRODUCTION-RUNS SCREEN.
 *
 * The owner's note, in his words: «ليش المنتجات الجاهزة موجودة بتشغيلات
 * الإنتاج». He is not wrong and it is not a bug — it is a leak of the
 * implementation into his screen. Units live in exactly one place in this
 * system, `ProductionBatch.quantityRemaining`, because on-hand is the sum of
 * batch remainders and anything that writes only a ledger line leaves the
 * shipment screen reporting a shortage for stock that was just entered
 * (`receiving.ts` says so at length). So EVERY door that puts units in opens
 * a batch: a production run, a delivery of ready goods, a physical recount,
 * the opening count at cutover. Four doors, one table — and a screen called
 * «تشغيلات الإنتاج» that lists the table calls all four a production run.
 *
 * Measured on the dev database before any of this was written: 110 batches.
 * 17 are actual runs. 4 came in through «استلام بضاعة جاهزة». 89 are opening
 * balances from cutover. 0 recounts. So 93 of 110 rows on the production
 * screen describe something other than production, which is exactly what the
 * owner saw.
 *
 * The fix is not to hide them — a hidden row is stock nobody can find. It is
 * to say which door each row came in through, and to put the door's own link
 * beside it.
 */

export const BATCH_ORIGINS = ['PRODUCED', 'RECEIVED', 'OPENING', 'ADJUSTED'] as const;
export type BatchOrigin = (typeof BATCH_ORIGINS)[number];

export interface OriginFacts {
  /** What this row actually is. */
  ar: string;
  /** Why it is on a screen called «تشغيلات الإنتاج» — never left to be guessed. */
  why: string;
  /** The door that created it, so the reader can go where it belongs. */
  href: string | null;
}

export const ORIGIN: Record<BatchOrigin, OriginFacts> = {
  PRODUCED: {
    ar: 'تشغيلة إنتاج',
    why: 'صُنعت هنا، ببنود كلفتها.',
    href: '/manufacturing',
  },
  RECEIVED: {
    ar: 'استلام بضاعة جاهزة',
    why: 'بضاعة مشتراة جاهزة، دخلت من باب الاستلام. تظهر في هذه القائمة لأن الدفعة هي المكان الوحيد الذي تسكنه الوحدات، ولأن كلفة شرائها تُحفظ معها — لا لأنها صُنعت.',
    href: '/inventory/balances',
  },
  OPENING: {
    ar: 'رصيد افتتاحي',
    why: 'الكمية التي كانت على الرفّ يوم بدأ النظام. لا تشغيلة ولا استلام — جرد أوّل.',
    href: '/inventory/balances',
  },
  ADJUSTED: {
    ar: 'تعديل جرد',
    why: 'فرق ظهر بين المعدود والمسجَّل، فُتحت له دفعة ليسكن فيها.',
    href: '/inventory/movements',
  },
};

/**
 * WHICH DOOR THIS BATCH CAME IN THROUGH.
 *
 * There is no column that says it, so this reads the marks each door leaves.
 * The order below is the order of certainty, not convenience:
 *
 *   `openingCountId` is a real foreign key written by one function only, so
 *   when it is set the answer is not inferred at all.
 *
 *   The batch number prefix is next: `RCV-` is written by `nextBatchNumber`
 *   in `receiving.ts` and `ADJ-` by the recount branch of `/api/inventory`,
 *   and neither is offered to anybody to type. `INIT-` and `SEED-` are the
 *   cutover and seed batches that predate `StockOpeningCount` — 89 of the
 *   110 measured, all of them, so dropping them would mislabel four rows in
 *   five.
 *
 *   The product's own type is the last resort and it is a strong one: the
 *   server REFUSES to open a production run for a `PURCHASED` product
 *   (`/api/production` returns WRONG_DOOR), so a purchased product's batch
 *   cannot be a run whatever its number says.
 *
 * A prefix is a weak signal on its own — somebody could type `RCV-1` into
 * the run form — which is why the product type is checked as well and why
 * nothing here changes a number or a balance. It labels a row.
 */
export function batchOrigin(input: {
  batchNumber: string;
  openingCountId?: string | null;
  sourceType?: string | null;
}): BatchOrigin {
  if (input.openingCountId) return 'OPENING';

  const prefix = (input.batchNumber ?? '').trim().toUpperCase().match(/^[A-Z]+/)?.[0] ?? '';
  if (prefix === 'INIT' || prefix === 'SEED') return 'OPENING';
  if (prefix === 'ADJ') return 'ADJUSTED';
  if (prefix === 'RCV') return 'RECEIVED';
  if (input.sourceType === 'PURCHASED') return 'RECEIVED';

  return 'PRODUCED';
}

/**
 * THE SCORE — «تشغيلات الإنتاج: AI + Score», and it calls no model.
 *
 * There is no language model in this and there must not be: a batch's grade
 * is arithmetic over columns this row already carries, and a sentence
 * generated about money is a sentence nobody can check. Every band below
 * says what it measured and what that earned, the way `performance-score.ts`
 * already does for people:
 *
 *     الكلفة مُبنَّدة: 3 بنود ← 30 من 30
 *
 * THE WEIGHTS ARE FIXED, HERE, and are never a setting. A number whose
 * weights move cannot be compared with last month's, and comparing is the
 * first thing anybody does with a score.
 *
 * AND A BAND A BATCH CANNOT POSSIBLY EARN IS NOT SCORED AT ALL, rather than
 * scored as zero. A delivery of ready goods has one price on one supplier
 * invoice: that IS the whole truth of what it cost, and charging it 30 points
 * for the cost breakdown it was never supposed to have would be inventing a
 * failure. The chip therefore says «70 من 70» and means it.
 */

export type BandKey = 'priced' | 'itemised' | 'sellable';

export interface Band {
  key: BandKey;
  ar: string;
  /** Fixed. Not a setting, not a column, not a field on any screen. */
  weight: number;
}

export const BANDS: readonly Band[] = [
  { key: 'priced', ar: 'لها كلفة', weight: 40 },
  { key: 'itemised', ar: 'الكلفة مُبنَّدة', weight: 30 },
  { key: 'sellable', ar: 'تُباع بأكثر من كلفتها', weight: 30 },
];

export interface BandResult {
  key: BandKey;
  ar: string;
  weight: number;
  /** Points earned out of `weight`. */
  earned: number;
  /** What was measured and what it earned — the whole point of the band. */
  why: string;
}

/**
 * Fewer earnable bands than this and NO grade is given.
 *
 * Measured: 89 of 110 batches are opening balances whose product has no
 * selling price set, so the only thing that can be asked of them is whether
 * a cost exists at all. A batch that passes the one question it was asked is
 * not «جيّد» — it is unexamined, and a reader who cannot tell «good» from
 * «we only checked one thing» will trust the first. So those 89 say «لا
 * يكفي» out loud, which is the same rule `health.ts` applies to a delivery
 * rate over three parcels.
 */
export const MIN_BANDS = 2;

/** Money agreeing to four places, the precision `batchUnitCost` writes at. */
const EPSILON = 0.0001;

export interface GradeInput {
  batchNumber: string;
  openingCountId?: string | null;
  /** The product's type — `MANUFACTURED` or `PURCHASED`. */
  sourceType?: string | null;
  quantityProduced: number;
  costPerUnit: number;
  totalProductionCost: number;
  manufacturingCost?: number;
  packagingCost?: number;
  rawMaterialCost?: number;
  otherCosts?: number;
  costLines?: { amount: number }[];
  /**
   * What one unit is sold for. Null or zero means this product has no price
   * set, and then the margin band is not scored rather than assumed.
   */
  sellingPrice?: number | null;
}

export interface BatchGrade {
  origin: BatchOrigin;
  tone: HealthTone;
  /** The one word for the chip. */
  label: string;
  /** Why it says that, for the line under it. */
  why: string;
  earned: number;
  /** The most this particular batch could have earned. */
  earnable: number;
  bands: BandResult[];
  /** How many named parts the cost is broken into. */
  parts: number;
  /**
   * The stored figures contradict each other. Null when they agree, which
   * was true for 110 of 110 batches when this was written — so it is a
   * tripwire that stays silent, not a band that flatters every row with
   * points for arithmetic nobody got wrong.
   */
  mismatch: string | null;
}

/**
 * How many named parts this batch's cost is broken into.
 *
 * A bucket at zero explains no money and neither does a free-form line at
 * zero, so neither counts. «كل الكلفة في بند واحد» is a real and common
 * state — 89 of 110 — and it is graded as half marks rather than a pass,
 * because a single lump cannot answer where the money went.
 */
export function costParts(input: GradeInput): number {
  const buckets = [
    input.manufacturingCost ?? 0,
    input.packagingCost ?? 0,
    input.rawMaterialCost ?? 0,
    input.otherCosts ?? 0,
  ].filter((n) => n > 0).length;
  const lines = (input.costLines ?? []).filter((l) => (l?.amount ?? 0) > 0).length;
  return buckets + lines;
}

/**
 * THE STORED FIGURES CHECKED AGAINST EACH OTHER.
 *
 * Recomputed with the SAME two functions the server writes with —
 * `batchTotal` and `batchUnitCost` from `product-cost.ts`. A second
 * implementation here would drift from them and then this check would report
 * the drift as corruption in the data.
 */
export function batchMismatch(input: GradeInput): string | null {
  const qty = input.quantityProduced;
  if (!Number.isFinite(qty) || qty <= 0) return 'الكمية صفر أو غير رقم، فلا تكلفة وحدة يمكن حسابها.';

  const expectedUnit = batchUnitCost(input.totalProductionCost, qty);
  if (Math.abs(expectedUnit - input.costPerUnit) > EPSILON) {
    return `تكلفة الوحدة المحفوظة ${input.costPerUnit} والكلفة الكلية مقسومة على الكمية ${expectedUnit}.`;
  }

  // Only a batch that recorded parts has parts to be checked against. A
  // delivery of ready goods records a price, not a breakdown, and summing
  // its (absent) parts to zero would report every receipt as broken.
  if (costParts(input) > 0) {
    const { total } = batchTotal(input);
    if (Math.abs(total - input.totalProductionCost) > EPSILON) {
      return `مجموع بنود الكلفة ${total} والكلفة الكلية المحفوظة ${input.totalProductionCost}.`;
    }
  }

  return null;
}

/**
 * THE GRADE.
 *
 * Read the bands in the order they are decided, because the order carries a
 * judgement:
 *
 *   An unpriced batch is «ضعيف» IMMEDIATELY and is never «لا يكفي». Every
 *   unit sold out of a zero-cost batch reports as pure profit, for ever,
 *   with no later correction — and the one thing that must never happen is
 *   for that row to be quietly set aside as un-gradeable because nothing
 *   else about it could be measured either.
 *
 *   Selling at or below cost is «ضعيف» too, however tidy the rest is. A run
 *   with four named cost lines that loses money on every unit is not a
 *   well-documented run, it is a well-documented loss.
 */
export function gradeBatch(input: GradeInput): BatchGrade {
  const origin = batchOrigin(input);
  const parts = costParts(input);
  const mismatch = batchMismatch(input);
  const priced = input.costPerUnit > 0;
  const price = input.sellingPrice ?? 0;

  const bands: BandResult[] = [];
  const band = (key: BandKey, earned: number, why: string) => {
    const b = BANDS.find((x) => x.key === key)!;
    bands.push({ key, ar: b.ar, weight: b.weight, earned, why });
  };

  band(
    'priced',
    priced ? 40 : 0,
    priced
      ? `تكلفة الوحدة ${input.costPerUnit} ← 40 من 40.`
      : 'بلا كلفة ← 0 من 40. كل ما يُباع من هذه الدفعة يظهر ربحاً صافياً.'
  );

  // Only a run has a breakdown to be judged on. A receipt has a supplier's
  // price, an opening balance has a count, and a recount has a difference.
  if (origin === 'PRODUCED') {
    band(
      'itemised',
      parts >= 2 ? 30 : parts === 1 ? 15 : 0,
      parts >= 2
        ? `${parts} بنود كلفة ← 30 من 30.`
        : parts === 1
          ? 'كل الكلفة في بند واحد ← 15 من 30. لا يمكن معرفة أين ذهب المال.'
          : 'لا بنود كلفة ← 0 من 30. الكلفة رقم بلا تفصيل.'
    );
  }

  // Comparing a zero cost with a price says nothing, and comparing anything
  // with a product that has no price set says less. Either way the band is
  // not scored instead of being assumed.
  if (priced && price > 0) {
    band(
      'sellable',
      input.costPerUnit < price ? 30 : 0,
      input.costPerUnit < price
        ? `تكلفة الوحدة ${input.costPerUnit} وسعر البيع ${price} ← 30 من 30.`
        : `تكلفة الوحدة ${input.costPerUnit} وسعر البيع ${price} ← 0 من 30. كل وحدة تُباع بخسارة.`
    );
  }

  const earned = bands.reduce((sum, b) => sum + b.earned, 0);
  const earnable = bands.reduce((sum, b) => sum + b.weight, 0);

  if (!Number.isFinite(input.quantityProduced) || input.quantityProduced <= 0) {
    return {
      origin, parts, mismatch, bands, earned, earnable,
      tone: 'unknown',
      label: HEALTH_AR.unknown,
      why: 'الكمية صفر، فلا شيء في هذه الدفعة يمكن الحكم عليه.',
    };
  }

  if (!priced) {
    return {
      origin, parts, mismatch, bands, earned, earnable,
      tone: 'bad',
      label: 'بلا كلفة',
      why: `${earned} من ${earnable} — بلا تكلفة وحدة، فربح كل ما يُباع منها إجمالي لا صافٍ.`,
    };
  }

  const losing = bands.some((b) => b.key === 'sellable' && b.earned === 0);
  if (losing) {
    return {
      origin, parts, mismatch, bands, earned, earnable,
      tone: 'bad',
      label: 'تُباع بخسارة',
      why: `${earned} من ${earnable} — تكلفة الوحدة ${input.costPerUnit} لا تقل عن سعر البيع ${price}.`,
    };
  }

  if (bands.length < MIN_BANDS) {
    return {
      origin, parts, mismatch, bands, earned, earnable,
      tone: 'unknown',
      label: HEALTH_AR.unknown,
      why: `لم يُقَس منها إلا وجود الكلفة: هذا الصفّ ${ORIGIN[origin].ar}، فلا بنود كلفة تُقاس فيه، ولا سعر بيع للمنتج يُقارن به.`,
    };
  }

  if (earned < earnable) {
    return {
      origin, parts, mismatch, bands, earned, earnable,
      tone: 'ok',
      label: 'كلفتها ناقصة',
      why: `${earned} من ${earnable} — ${bands.filter((b) => b.earned < b.weight).map((b) => b.ar).join('، ')}.`,
    };
  }

  return {
    origin, parts, mismatch, bands, earned, earnable,
    tone: 'good',
    label: 'كلفتها واضحة',
    why: `${earned} من ${earnable} — كل ما يمكن قياسه في هذه الدفعة مسجَّل.`,
  };
}

/**
 * THE READ OVER THE WHOLE LIST — the other half of «AI + Score», and still
 * no model.
 *
 * One screen-wide count of the things a reader would otherwise have to work
 * out by scrolling 110 rows: how many of these are not production at all and
 * which door they came from, how many carry no cost, how many sell at a
 * loss, how many cannot be graded. Every figure is a count of the rows on
 * screen, so it can be checked by counting them.
 */
export interface BatchReading {
  total: number;
  /** Rows per door. The answer to «ليش المنتجات الجاهزة موجودة هنا». */
  byOrigin: { origin: BatchOrigin; count: number }[];
  /** Rows that are not production runs at all. */
  notProduction: number;
  unpriced: number;
  losing: number;
  ungraded: number;
  mismatched: number;
  /** The one line worth leading with, or null when there is nothing wrong. */
  headline: string | null;
}

export function readBatches(grades: readonly BatchGrade[]): BatchReading {
  const counts = new Map<BatchOrigin, number>();
  for (const g of grades) counts.set(g.origin, (counts.get(g.origin) ?? 0) + 1);

  const byOrigin = BATCH_ORIGINS.filter((o) => counts.has(o)).map((o) => ({
    origin: o,
    count: counts.get(o) ?? 0,
  }));

  const notProduction = grades.filter((g) => g.origin !== 'PRODUCED').length;
  const unpriced = grades.filter((g) => g.label === 'بلا كلفة').length;
  const losing = grades.filter((g) => g.label === 'تُباع بخسارة').length;
  const ungraded = grades.filter((g) => g.tone === 'unknown').length;
  const mismatched = grades.filter((g) => g.mismatch).length;

  // Worst first: money already mis-stated, then money about to be, then the
  // rows nobody can judge, then the labelling confusion that started all of
  // this. A screen that leads with the least of these buries the most.
  let headline: string | null = null;
  if (mismatched > 0) {
    headline = `${mismatched} من ${grades.length} دفعة أرقامها لا تتفق مع نفسها — الكلفة المحفوظة تخالف بنودها.`;
  } else if (unpriced > 0) {
    headline = `${unpriced} من ${grades.length} دفعة بلا كلفة — وكل ما يُباع منها يظهر ربحاً صافياً.`;
  } else if (losing > 0) {
    headline = `${losing} من ${grades.length} دفعة تكلفتها لا تقل عن سعر بيعها — كل وحدة تُباع بخسارة.`;
  } else if (notProduction > 0) {
    headline = `${notProduction} من ${grades.length} صفّ هنا ليست تشغيلات إنتاج — ${byOrigin
      .filter((b) => b.origin !== 'PRODUCED')
      .map((b) => `${b.count} ${ORIGIN[b.origin].ar}`)
      .join('، ')}. تظهر في هذه القائمة لأن الدفعة هي المكان الوحيد الذي تسكنه الوحدات.`;
  } else if (ungraded > 0) {
    headline = `${ungraded} من ${grades.length} دفعة لا تكفي بياناتها للحكم عليها.`;
  }

  return {
    total: grades.length,
    byOrigin,
    notProduction,
    unpriced,
    losing,
    ungraded,
    mismatched,
    headline,
  };
}

/**
 * A ROW SPLIT FROM A RUN IS NOT A RUN (the warehouse plan, W2c).
 *
 * When units of a batch change place, a twin row holds them (`batch-split.ts`): `quantityProduced` 0, the run's unit cost
 * and date, `splitFromBatchId` = the run. It is the same goods at another address — so every LIST of runs and every
 * COUNT of batches must see one run, not two: a twin listed as a run would grade as «الكمية صفر» (its `quantityProduced`
 * is 0 by design), and a count would rise each time goods moved. These two functions are pure and read only the rows they
 * are handed; a store that was never placed has no twin, and for it both return exactly what they were given.
 */
export interface SplitRow {
  id: string;
  splitFromBatchId?: string | null;
}

/** Each row's run: the top of its `splitFromBatchId` chain among the rows given (or the first id above them). */
export function runOfRows(rows: readonly SplitRow[]): (row: SplitRow) => string {
  const parent = new Map<string, string>();
  for (const r of rows) if (r.splitFromBatchId) parent.set(r.id, r.splitFromBatchId);
  if (parent.size === 0) return (row) => row.id;
  return (row) => {
    let id = row.id;
    if (row.splitFromBatchId && !parent.has(id)) id = row.splitFromBatchId;
    const seen = new Set<string>();
    while (parent.has(id) && !seen.has(id)) {
      seen.add(id);
      id = parent.get(id)!;
    }
    return id;
  };
}

/** How many runs these rows belong to — `which` (default: all of them), resolved against `all`. */
export function countRuns(all: readonly SplitRow[], which: readonly SplitRow[] = all): number {
  const runOf = runOfRows(all);
  return new Set(which.map(runOf)).size;
}

/**
 * The runs among these rows, each carrying the units its twins hold: `quantitySold` and `quantityRemaining` are the run's
 * own plus every row split from it (at any depth). «أُنتج» stays the run's own — a twin produced nothing. A twin whose run
 * is not among the rows (the run was deleted) stands as its own row. With no twin the rows come back untouched, the same
 * objects in the same order.
 */
export function foldSplitRows<R extends SplitRow & { quantitySold: number; quantityRemaining: number }>(
  rows: readonly R[],
  twins: readonly (SplitRow & { quantitySold: number; quantityRemaining: number })[] = []
): R[] {
  const all: (SplitRow & { quantitySold: number; quantityRemaining: number })[] = [...rows, ...twins];
  if (!all.some((r) => r.splitFromBatchId)) return [...rows];
  const runOf = runOfRows(all);
  const listed = new Set(rows.map((r) => r.id));
  const extra = new Map<string, { sold: number; remaining: number }>();
  const seenTwin = new Set<string>();
  for (const t of all) {
    if (!t.splitFromBatchId || seenTwin.has(t.id)) continue;
    seenTwin.add(t.id);
    const run = runOf(t);
    if (!listed.has(run)) continue;
    const e = extra.get(run) ?? { sold: 0, remaining: 0 };
    e.sold += t.quantitySold;
    e.remaining += t.quantityRemaining;
    extra.set(run, e);
  }
  return rows
    .filter((r) => !r.splitFromBatchId || !listed.has(runOf(r)))
    .map((r) => {
      const e = extra.get(r.id);
      return e ? { ...r, quantitySold: r.quantitySold + e.sold, quantityRemaining: r.quantityRemaining + e.remaining } : r;
    });
}
