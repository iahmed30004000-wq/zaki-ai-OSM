/**
 * WHAT YOUR SELLERS HAVE IN COMMON — COUNTED, NEVER PREDICTED.
 *
 * «إنشاءُ منتج من DNA منتجاتك الناجحة». The bench exists to try the next
 * product, and the owner's question before trying one is «what do the ones
 * that worked look like».
 *
 * ── MEASURED FIRST, AND IT DECIDED THE SHAPE OF THIS FILE ──
 *
 * On this database when it was written: TWELVE products, of which exactly
 * ONE has ever been ordered — 56 orders, 26 delivered — and the other
 * eleven have nothing at all.
 *
 * So there is no «successful products» plural to read a pattern out of. A
 * DNA computed from one product would answer «your winners are 50ml
 * dry-skin creams at 14 JOD» — which is not a finding, it is a description
 * of that single product wearing a finding's clothes. That is precisely how
 * this product's previous intelligence layer came to grade every customer
 * the same and had to be abandoned (see `expense-grade.ts`, which refuses a
 * «worth it» score for the same reason).
 *
 * THEREFORE: this engine is built with a floor and REFUSES below it, like
 * `delivery-time.ts` refuses a median of two deliveries and
 * `couriers/score.ts` refuses a score over four parcels. It says nothing
 * today and starts answering by itself the day ten products have sold.
 *
 * ── AND IT COUNTS. IT DOES NOT PREDICT ──
 *
 * Every number out of here is «N of your M sellers share this». Not a
 * probability, not a score, not «this will work». The difference is the
 * whole of why this is safe to show: a count is a fact about the past that
 * the owner can check against their own memory, and a prediction is a claim
 * about the future that nothing in this data can support.
 *
 * ── AND THE TRAITS ARE THE SHOP'S OWN FIELDS ──
 *
 * Category, price, and the keys the seller actually fills in `attributes` —
 * measured on this shop: `need`, `skin`, `ml`, `made`. Nothing is inferred
 * from a product's NAME: a word-frequency reading of twelve Arabic names
 * would find «كريم» and call it DNA.
 */

/** A product as this engine reads it. Delivered count decides «sold». */
export interface DnaProduct {
  id: string;
  name: string;
  /** The category's name, for a trait a person recognises. Null is a trait too. */
  category: string | null;
  price: number;
  /** Parcels of it that reached a customer. The only definition of «sold». */
  delivered: number;
  /** The seller's own structured answers. Values may be a string, number or list. */
  attributes?: Readonly<Record<string, unknown>> | null;
}

/**
 * A PRODUCT HAS SOLD WHEN A PARCEL OF IT REACHED SOMEBODY.
 *
 * Not «has an order»: an order that was refused on the phone tells you the
 * ad worked, not the product. Not «has revenue»: revenue is written at
 * confirmation on this system and a returned parcel keeps it. Delivered is
 * the only one of the three that means a person kept the thing.
 *
 * Three, and not one, because one delivery is a friend of the seller. It is
 * deliberately lower than `MIN_SELLERS` below: this decides whether a
 * product joins the population, and that decides whether the population is
 * big enough to read.
 */
export const MIN_DELIVERED = 3;

/**
 * HOW MANY SELLERS MAKE A POPULATION.
 *
 * Ten, the same floor `health.ts` puts under every rate, `channel-score`
 * under every channel and `couriers/score` under every courier —
 * deliberately identical, because a reader who has learned what «لا يكفي»
 * means on one screen should not have to learn a second meaning here.
 *
 * MEASURED: this shop has ONE product over `MIN_DELIVERED`. So this engine
 * refuses on today's data, and says so with the count.
 */
export const MIN_SELLERS = 10;

/** One thing the sellers share, and how many of them share it. */
export interface Trait {
  /** The field it came from: `category`, `price`, or an attribute key. */
  field: string;
  /** What a person calls that field. */
  label: string;
  /** The value, as text. A range for price. */
  value: string;
  /** How many of the sellers carry it. */
  shared: number;
  /** Out of how many sellers. Carried so a row can never be read bare. */
  outOf: number;
}

export interface DnaReading {
  /** The products that cleared `MIN_DELIVERED`. */
  sellers: number;
  minSellers: number;
  /** Null when the population is too small for any of this to mean anything. */
  traits: Trait[] | null;
  reason: 'BELOW_MINIMUM' | null;
}

/** Arabic names for the fields this shop actually fills. */
const FIELD_LABEL: Readonly<Record<string, string>> = Object.freeze({
  category: 'التصنيف',
  price: 'السعر',
  need: 'يُستعمل لـ',
  skin: 'نوع البشرة',
  ml: 'الحجم',
  made: 'المكوّنات',
});

/** A field's name in Arabic, or the key itself when the shop invented one. */
export function fieldLabel(field: string): string {
  return FIELD_LABEL[field] ?? field;
}

/**
 * EVERY VALUE A PRODUCT CARRIES FOR ONE ATTRIBUTE KEY.
 *
 * A list value («need: ['تجاعيد', 'جفاف']») is SEVERAL traits, not one
 * joined string: a product for wrinkles and a product for dryness share
 * «dryness», and a reading that compared the joined strings would find them
 * entirely different. Measured on this shop — `need` is a list on every
 * product that has it — so this is not a hypothetical.
 */
function valuesOf(raw: unknown): string[] {
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) return raw.flatMap((v) => valuesOf(v));
  if (typeof raw === 'number') return Number.isFinite(raw) ? [String(raw)] : [];
  if (typeof raw === 'string') {
    const t = raw.trim();
    return t === '' ? [] : [t];
  }
  return [];
}

/**
 * KEYS WHOSE VALUES ARE PROSE AND NOT A TRAIT.
 *
 * `made` on this shop is an ingredients sentence — «ماء، جلسرين، زبدة
 * الشيا، فيتامين هـ». No two products share it verbatim, so it would
 * contribute nothing but noise; and splitting it on the comma would invent
 * a taxonomy the seller never agreed to. Named rather than detected by
 * length, because «a detector I know to be wrong is worse than none».
 */
export const PROSE_KEYS: readonly string[] = ['made', 'description', 'notes', 'ingredients'];

/**
 * THE PRICE BAND, AS A TRAIT.
 *
 * A price is never shared verbatim, so it is read as a band. The band is
 * the sellers' own middle half — the 25th to the 75th percentile — and not
 * a round number somebody chose: «your winners are 9 to 22» is a fact
 * about the shop, where «under 20» is a fact about the number 20.
 *
 * Nearest-rank, not interpolated, for the reason `summariseDays` gives: a
 * price of «13.5» is a real price and «13.5 to 21.25» reads like a
 * calculation rather than a shelf.
 */
function priceBand(prices: number[]): { low: number; high: number } | null {
  const clean = prices.filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const at = (q: number) => clean[Math.min(clean.length - 1, Math.max(0, Math.ceil(q * clean.length) - 1))];
  return { low: at(0.25), high: at(0.75) };
}

/**
 * WHAT THE SELLERS SHARE, counted, most-shared first.
 *
 * `minShare` is the fraction of the sellers a value must appear on to be
 * worth saying. Half, by default: a trait on four of nine is not something
 * «your winners have», it is something four of them have — and a list that
 * includes it is a list the owner stops trusting.
 */
export function readDna(
  products: readonly DnaProduct[],
  opts: { minSellers?: number; minDelivered?: number; minShare?: number } = {}
): DnaReading {
  const minSellers = opts.minSellers ?? MIN_SELLERS;
  const minDelivered = opts.minDelivered ?? MIN_DELIVERED;
  const minShare = opts.minShare ?? 0.5;

  const sellers = products.filter((p) => (p.delivered ?? 0) >= minDelivered);

  if (sellers.length < minSellers) {
    return { sellers: sellers.length, minSellers, traits: null, reason: 'BELOW_MINIMUM' };
  }

  const outOf = sellers.length;
  const traits: Trait[] = [];

  /* ── the category ── */
  const byCategory = new Map<string, number>();
  for (const p of sellers) {
    const key = p.category?.trim() || 'بلا تصنيف';
    byCategory.set(key, (byCategory.get(key) ?? 0) + 1);
  }
  for (const [value, shared] of byCategory) {
    if (shared / outOf >= minShare) {
      traits.push({ field: 'category', label: fieldLabel('category'), value, shared, outOf });
    }
  }

  /* ── the price band, which every seller is inside by construction ── */
  const band = priceBand(sellers.map((p) => p.price));
  if (band) {
    const inside = sellers.filter((p) => p.price >= band.low && p.price <= band.high).length;
    traits.push({
      field: 'price',
      label: fieldLabel('price'),
      value: band.low === band.high ? `${band.low}` : `${band.low} — ${band.high}`,
      shared: inside,
      outOf,
    });
  }

  /* ── and the seller's own attribute keys ── */
  const byKeyValue = new Map<string, Map<string, number>>();
  for (const p of sellers) {
    const attrs = p.attributes;
    if (!attrs || typeof attrs !== 'object') continue;
    for (const [key, raw] of Object.entries(attrs)) {
      if (PROSE_KEYS.includes(key)) continue;
      const values = new Set(valuesOf(raw));
      if (values.size === 0) continue;
      const slot = byKeyValue.get(key) ?? new Map<string, number>();
      // ONE PRODUCT COUNTS ONCE PER VALUE, even if it lists it twice.
      for (const v of values) slot.set(v, (slot.get(v) ?? 0) + 1);
      byKeyValue.set(key, slot);
    }
  }
  for (const [field, values] of byKeyValue) {
    for (const [value, shared] of values) {
      if (shared / outOf >= minShare) {
        traits.push({ field, label: fieldLabel(field), value, shared, outOf });
      }
    }
  }

  traits.sort((a, b) => b.shared - a.shared || a.field.localeCompare(b.field));
  return { sellers: outOf, minSellers, traits, reason: null };
}

/**
 * WHY THERE IS NO READING, IN A SENTENCE THE OWNER CAN ACT ON.
 *
 * «لا يكفي» alone invites the reader to think the shop is doing badly. The
 * count and the floor together say the opposite: nothing is wrong, there
 * are simply not enough products with a history yet — which is the reason
 * the bench exists.
 */
export function whyNoDna(reading: DnaReading): string | null {
  if (reading.reason !== 'BELOW_MINIMUM') return null;
  if (reading.sellers === 0) {
    return `لا منتجَ وصلَ ${MIN_DELIVERED} تسليماتٍ بعد — لا شيءَ يُقرأُ منه نمط.`;
  }
  return `${reading.sellers} منتجاً فقط له تاريخٌ كافٍ — تحت ${reading.minSellers}، ونمطٌ من هذا العدد وصفٌ لتلك المنتجات لا قاعدةٌ لغيرها.`;
}

/**
 * THE READING, IN THE WORDS A PERSON SAYS.
 *
 * Each line is a count out of a count — «٧ من ٩» — and never a bare
 * percentage, because a percentage hides the denominator and the
 * denominator is the whole question.
 */
export function dnaLineAr(trait: Trait): string {
  return `${trait.label}: ${trait.value} — ${trait.shared} من ${trait.outOf}`;
}
