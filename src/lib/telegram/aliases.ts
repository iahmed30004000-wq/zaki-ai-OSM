import { z } from 'zod';
import { roundMinor } from '../money';
import { foldOfferText } from './offer-text';

/**
 * «أسماء المنتجات (الأب سيل والأسماء القديمة)» — THE NAMES A TELEGRAM MESSAGE MAY CARRY THAT ARE NOT THE CATALOGUE'S OWN.
 *
 * The owner, 10/11: the site's upsell step sends a SECOND message with the same «رقم الطلب» whose «إسم المنتج» is the upsell's
 * own name («كورس طنين: عبوتين إضافيات 🎁»), and the products were renamed on 2026-11-10, so the orders received before carry the
 * OLD names («✨ بديل الليزر... الآن بين يديك! ✨» is كريم حرير today). Neither is in the catalogue; both are one list
 * (`TelegramUpsellProduct`), per store, in two kinds:
 *
 *   UPSELL  — adds `extraUnits` units of a product for `linePrice` (both per one «الكمية») to the base order it is paired with;
 *   RENAMED — IS a catalogue product under its old name, and may carry the old offer texts (`offerAliases`), each one only
 *             NAMING which real active offer (same quantity AND same price) the old text meant. The money is the offer row's.
 *
 * Matching is folded equality (`foldOfferText`): the emoji, the dots, the exclamation mark and a double space all fold away, so
 * «قطرة  طنين الأذن» is «قطرة طنين الأذن». An alias is asked BEFORE the generic matcher and always wins; a name that matches no
 * ACTIVE alias goes on exactly as before.
 *
 * PURE: the door loads the rows (`loadAliases`, in `alias-store.ts`).
 */

export type AliasKind = 'UPSELL' | 'RENAMED';

export interface OfferAlias {
  /** The old offer text as the owner wrote it. */
  name: string;
  /** `foldOfferText(name)` — the match key. */
  foldedName: string;
  /** The offer's paid pieces. */
  quantity: number;
  /** What the offer charged, in the store's currency. */
  price: number;
}

export interface AliasRow {
  id: string;
  kind: AliasKind;
  incomingName: string;
  foldedName: string;
  productId: string;
  extraUnits: number | null;
  linePrice: number | null;
  offerAliases: OfferAlias[];
  isActive: boolean;
}

/** The longest a name may be, a list of old offers may run, and an upsell may add. */
export const ALIAS_NAME_MAX = 200;
export const OFFER_ALIASES_MAX = 30;
export const EXTRA_UNITS_MAX = 50;
export const LINE_PRICE_MAX = 100_000;

/** A stored `offerAliases` value read back defensively: anything that is not a well-formed entry is dropped, never guessed. */
export function readOfferAliases(value: unknown): OfferAlias[] {
  if (!Array.isArray(value)) return [];
  const out: OfferAlias[] = [];
  for (const raw of value.slice(0, OFFER_ALIASES_MAX)) {
    if (!raw || typeof raw !== 'object') continue;
    const { name, quantity, price } = raw as Record<string, unknown>;
    if (typeof name !== 'string' || !foldOfferText(name)) continue;
    // Written by this module's own form (numbers); anything else is not an entry — read as it is, never coerced.
    const q = typeof quantity === 'number' ? quantity : NaN;
    const p = typeof price === 'number' ? price : NaN;
    if (!Number.isInteger(q) || q < 1 || q > 1000 || !Number.isFinite(p) || p <= 0) continue;
    out.push({ name, foldedName: foldOfferText(name), quantity: q, price: p });
  }
  return out;
}

/** A database row (Decimal, Json) in the shape the door reads. */
export function toAliasRow(row: {
  id: string;
  kind: string;
  incomingName: string;
  foldedName: string;
  productId: string;
  extraUnits: number | null;
  linePrice: unknown;
  offerAliases: unknown;
  isActive: boolean;
}): AliasRow {
  return {
    id: row.id,
    kind: row.kind === 'RENAMED' ? 'RENAMED' : 'UPSELL',
    incomingName: row.incomingName,
    foldedName: row.foldedName,
    productId: row.productId,
    extraUnits: row.extraUnits ?? null,
    linePrice: row.linePrice === null || row.linePrice === undefined ? null : Number(row.linePrice),
    offerAliases: readOfferAliases(row.offerAliases),
    isActive: row.isActive,
  };
}

/**
 * The ACTIVE alias «إسم المنتج» names, by folded equality — or null. An UPSELL row without its units or its price is not a
 * usable upsell and is skipped (the form never saves one; this is the door not trusting the row).
 */
export function aliasFor(productText: string, aliases: readonly AliasRow[]): AliasRow | null {
  const folded = foldOfferText(productText);
  if (!folded) return null;
  return (
    aliases.find(
      (a) =>
        a.isActive &&
        a.foldedName === folded &&
        (a.kind === 'RENAMED' || (Number.isInteger(a.extraUnits) && (a.extraUnits ?? 0) >= 1 && (a.linePrice ?? 0) > 0))
    ) ?? null
  );
}

/** The old offer text of a RENAMED alias «إسم العرض» names, by folded equality — or null. */
export function offerAliasFor(offerText: string, alias: AliasRow): OfferAlias | null {
  const folded = foldOfferText(offerText);
  if (!folded) return null;
  return alias.offerAliases.find((o) => o.foldedName === folded) ?? null;
}

export type AliasedOffer<T> = { kind: 'found'; offer: T } | { kind: 'ambiguous' } | { kind: 'none' };

/**
 * WHICH REAL OFFER AN OLD OFFER TEXT MEANT: the product's ACTIVE offers with the same paid pieces AND the same charged price
 * (the view's `price`, by the store currency's places). One is the answer; none is OFFER_NOT_FOUND; two is OFFER_AMBIGUOUS.
 * It names an offer and nothing else — the price the order is written with is still that offer row's, and the written
 * «السعر» is still checked against it.
 */
export function pickAliasedOffer<T extends { quantity: number; price: number }>(
  offers: readonly T[],
  wanted: { quantity: number; price: number },
  minorUnit: number
): AliasedOffer<T> {
  const price = roundMinor(wanted.price, minorUnit);
  const same = offers.filter((o) => o.quantity === wanted.quantity && roundMinor(o.price, minorUnit) === price);
  if (same.length === 1) return { kind: 'found', offer: same[0] };
  return same.length === 0 ? { kind: 'none' } : { kind: 'ambiguous' };
}

/* ─────────────────────────────── the form's rules (the API validates with these) ─────────────────────────────── */

/** A money figure with at most the currency's places, above 0 and at most the ceiling. */
function moneyOf(minorUnit: number, max: number) {
  return z
    .number('المبلغ لازم يكون رقم')
    .gt(0, 'المبلغ لازم يكون أكبر من صفر')
    .max(max, `المبلغ أكبر من ${max}`)
    .refine((n) => roundMinor(n, minorUnit) === n, `المبلغ بخانات عشرية أكتر من عملة المتجر (${minorUnit})`);
}

export function offerAliasSchema(minorUnit: number) {
  return z.object({
    name: z.string('اسم العرض القديم فاضي').trim().min(1, 'اسم العرض القديم فاضي').max(ALIAS_NAME_MAX, 'اسم العرض القديم طويل كتير'),
    quantity: z.number('الكمية لازم تكون رقم').int('الكمية لازم تكون رقم صحيح').min(1, 'الكمية من 1').max(1000, 'الكمية لـ1000'),
    price: moneyOf(minorUnit, LINE_PRICE_MAX),
  });
}

/** What the form sends to make or change one name. `kind` decides which of the other fields are required. */
export function aliasInputSchema(minorUnit: number) {
  return z
    .object({
      kind: z.enum(['UPSELL', 'RENAMED'], 'النوع لازم يكون أب سيل أو اسم قديم'),
      incomingName: z.string('الاسم الوارد فاضي').trim().min(1, 'الاسم الوارد فاضي').max(ALIAS_NAME_MAX, 'الاسم الوارد طويل كتير'),
      productId: z.string('اختار المنتج').trim().min(1, 'اختار المنتج'),
      extraUnits: z.number('عدد العبوات لازم يكون رقم').int('عدد العبوات لازم يكون رقم صحيح').min(1, 'عبوة وحدة عالأقل').max(EXTRA_UNITS_MAX, `لـ${EXTRA_UNITS_MAX} عبوة`).nullish(),
      linePrice: moneyOf(minorUnit, LINE_PRICE_MAX).nullish(),
      offerAliases: z.array(offerAliasSchema(minorUnit)).max(OFFER_ALIASES_MAX, `لـ${OFFER_ALIASES_MAX} عرض`).nullish(),
      isActive: z.boolean('التفعيل لازم يكون نعم أو لا').optional(),
    })
    .superRefine((v, ctx) => {
      if (!foldOfferText(v.incomingName)) ctx.addIssue({ code: 'custom', path: ['incomingName'], message: 'الاسم الوارد ما فيه حروف' });
      if (v.kind === 'UPSELL') {
        if (v.extraUnits == null) ctx.addIssue({ code: 'custom', path: ['extraUnits'], message: 'عدد العبوات الإضافية مطلوب' });
        if (v.linePrice == null) ctx.addIssue({ code: 'custom', path: ['linePrice'], message: 'سعر السطر مطلوب' });
      }
      const seen = new Set<string>();
      for (const [i, o] of (v.offerAliases ?? []).entries()) {
        const key = foldOfferText(o.name);
        if (!key) ctx.addIssue({ code: 'custom', path: ['offerAliases', i, 'name'], message: 'اسم العرض القديم ما فيه حروف' });
        if (seen.has(key)) ctx.addIssue({ code: 'custom', path: ['offerAliases', i, 'name'], message: 'نفس اسم العرض مرتين' });
        seen.add(key);
      }
    });
}

export type AliasInput = z.infer<ReturnType<typeof aliasInputSchema>>;

/** The columns one valid input writes — the folded keys computed here, never taken from the client. */
export function aliasColumns(input: AliasInput) {
  const upsell = input.kind === 'UPSELL';
  return {
    kind: input.kind,
    incomingName: input.incomingName.trim(),
    foldedName: foldOfferText(input.incomingName),
    productId: input.productId,
    extraUnits: upsell ? input.extraUnits ?? null : null,
    linePrice: upsell ? input.linePrice ?? null : null,
    offerAliases: upsell
      ? null
      : (input.offerAliases ?? []).map((o) => ({ name: o.name.trim(), foldedName: foldOfferText(o.name), quantity: o.quantity, price: o.price })),
  };
}

/* ─────────────────────────────── «أضف الأسماء الجاهزة» — the owner's names, verbatim ─────────────────────────────── */

export interface SeedAlias {
  kind: AliasKind;
  incomingName: string;
  /** The catalogue product's NAME, matched by folded equality among the store's ACTIVE products. */
  productName: string;
  extraUnits?: number;
  linePrice?: number;
  offerAliases?: Array<{ name: string; quantity: number; price: number }>;
}

/**
 * The names of the owner's two briefs (10/11), copied as he wrote them — they fold anyway. Prices are dollars, so they are
 * seeded in USD stores only. The two OLDER upsell names («كورس … كامل: عبوتين + عبوة هدية 🎁», «كورس كمأة كامل: 3 عبوات زيادة
 * 🎁») are NOT here: their products are not known; the owner adds them from the same screen.
 */
/** The two symbols the site writes in these names, built from their code points (the source carries no pictograph). */
const GIFT = String.fromCodePoint(0x1f381);
const SPARKLES = String.fromCodePoint(0x2728);

export const SEED_ALIASES: readonly SeedAlias[] = [
  { kind: 'UPSELL', incomingName: `كورس حرير: عبوتين إضافيات ${GIFT}`, productName: 'كريم حرير', extraUnits: 2, linePrice: 20 },
  { kind: 'UPSELL', incomingName: `كورس طنين: عبوتين إضافيات ${GIFT}`, productName: 'قطرة طنين الأذن', extraUnits: 2, linePrice: 20 },
  { kind: 'UPSELL', incomingName: `كورس ندبات: عبوتين إضافيات ${GIFT}`, productName: 'كريم إزالة الندبات الألماني الأصلي', extraUnits: 2, linePrice: 20 },
  {
    kind: 'RENAMED',
    incomingName: `${SPARKLES} بديل الليزر... الآن بين يديك! ${SPARKLES}`,
    productName: 'كريم حرير',
    offerAliases: [
      { name: 'عبوة عدد 1 = 20 دولار + توصيل مجاني', quantity: 1, price: 20 },
      { name: 'عبوة عدد 2 = 35 دولار + توصيل مجاني', quantity: 2, price: 35 },
      { name: 'عبوة عدد 3= 45 دولار + توصيل مجاني', quantity: 3, price: 45 },
    ],
  },
  { kind: 'RENAMED', incomingName: 'ALBETCHU لإخفاء مظهر الندبات', productName: 'كريم إزالة الندبات الألماني الأصلي' },
  { kind: 'RENAMED', incomingName: 'ماء الكمأ الأصلي', productName: 'ماء الكمأ' },
  { kind: 'RENAMED', incomingName: 'قطرة  طنين الأذن', productName: 'قطرة طنين الأذن' },
];
