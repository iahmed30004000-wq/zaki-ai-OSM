import type { db } from './db';
import type { SheetShow } from './label-sheet';
import { storeLogoForPrint } from './label-sheet';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «البوليصة المطبوعة» — WHAT EACH STORE'S WAYBILL SHOWS (25/11, F15).
 *
 * The owner: «بدي خاصية إني أضيف شعار للفاتورة لوجو وأقدر أتحكم بعناصر الفاتورة شو اللي رح ينعرض، تحكم شامل».
 * The document an order prints in this system is ONE: the waybill sheet of `label-sheet.ts` (the print page and its
 * «حفظ PDF» mode, `/api/ops/labels/print`). There is no second print system and this builds none: it only tells
 * that one renderer which parts to leave off, and which logo to draw.
 *
 * ── THE DOCUMENT ── `Company.settings.waybillPrint` (no migration; one key of the company's settings document):
 *   { v: 1, stores: { [storeId]: { hide: HideableKey[], logo: 'store' | 'own' | 'none', ownLogo?: string } } }
 * A store with no entry prints today's waybill, byte for byte: the renderer is not even handed a choice.
 *
 * ── WHAT CANNOT BE LEFT OFF ── the parts the courier works from: the customer's name, the phones, the address,
 * the amount to collect and the courier's barcode. They are LOCKED, not warned about: the screen draws them ticked
 * and disabled with the reason, and the door refuses a document that hides one (`COURIER_FIELD_LOCKED`).
 *
 * ── THE LOGO ── «شعار المتجر» (today: Store.logo, set in «هوية المتجر»), «شعار خاص بالبوليصة» (uploaded through the
 * same storage pipeline into the store's own folder, served by the signed-in `/api/media` door), or «بلا شعار».
 *
 * NOTHING HERE TOUCHES MONEY, ORDER CREATION, THE PRINT DATA OR A CONTRACT — only show / hide.
 * ═══════════════════════════════════════════════════════════════════════
 */

export const WAYBILL_PRINT_SETTINGS_KEY = 'waybillPrint';

export type HideableKey = keyof SheetShow;
export type LockedKey = 'name' | 'phones' | 'place' | 'cod' | 'barcode';
export type LogoChoice = 'store' | 'own' | 'none';

export interface WaybillElement {
  key: HideableKey | LockedKey;
  ar: string;
  /** A part the courier works from: always printed. */
  locked: boolean;
}

/** Every part of the waybill, in the order it prints (top to bottom). The screen's one list. */
export const WAYBILL_ELEMENTS: readonly WaybillElement[] = Object.freeze([
  { key: 'storeName', ar: 'اسم المتجر', locked: false },
  { key: 'courierName', ar: 'اسم شركة الشحن', locked: false },
  { key: 'ref', ar: 'رقم الطلب بالأعلى', locked: false },
  { key: 'name', ar: 'اسم الزبون', locked: true },
  { key: 'phones', ar: 'أرقام الهاتف', locked: true },
  { key: 'place', ar: 'العنوان', locked: true },
  { key: 'items', ar: 'المنتجات والكميات', locked: false },
  { key: 'note', ar: 'ملاحظة الزبون', locked: false },
  { key: 'cod', ar: 'المبلغ عند الاستلام', locked: true },
  { key: 'barcode', ar: 'باركود شركة الشحن', locked: true },
  { key: 'qr', ar: 'رمز QR لرقم الطلب', locked: false },
  { key: 'supportPhone', ar: 'رقم الاستفسار بالأسفل', locked: false },
] as WaybillElement[]);

export const HIDEABLE_KEYS: readonly HideableKey[] = WAYBILL_ELEMENTS.filter((e) => !e.locked).map((e) => e.key as HideableKey);
export const LOCKED_KEYS: readonly LockedKey[] = WAYBILL_ELEMENTS.filter((e) => e.locked).map((e) => e.key as LockedKey);

/** A waybill logo is drawn 7 mm tall: two megabytes is far more than it needs, and a phone photo is refused before it is read. */
export const WAYBILL_LOGO_MAX_BYTES = 2 * 1024 * 1024;

export const LOCKED_REASON ='ثابتة — شركة الشحن بتشتغل عليها، فما بتنشال عن البوليصة.';

export interface StoreWaybillPrint {
  hide: HideableKey[];
  logo: LogoChoice;
  /** The store's own waybill logo, once uploaded: `/api/media/companies/<company>/products/<store>/<uuid>.<ext>`. */
  ownLogo?: string;
}

export interface WaybillPrintDocument {
  v: 1;
  stores: Record<string, StoreWaybillPrint>;
}

export const WAYBILL_PRINT_DEFAULT: StoreWaybillPrint = Object.freeze({ hide: [], logo: 'store' }) as StoreWaybillPrint;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The exact shape of a waybill logo this store's own door wrote — nothing typed in, nothing of another store. */
export function isOwnWaybillLogo(url: unknown, companyId: string, storeId: string): url is string {
  if (typeof url !== 'string') return false;
  const prefix = `/api/media/companies/${companyId}/products/${storeId}/`;
  if (!url.startsWith(prefix)) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp)$/i.test(url.slice(prefix.length));
}

export type Validation =
  | { ok: true; value: Pick<StoreWaybillPrint, 'hide' | 'logo'> }
  | { ok: false; code: string; errorAr: string };

/**
 * What a person sent from the screen: `{ hide, logo }` and nothing else. The whole thing or nothing — one Arabic
 * sentence and a stable code for the first fault. The own logo is never sent: only its upload door writes it.
 */
export function validateWaybillPrint(input: unknown, has: { ownLogo: boolean }): Validation {
  const fail = (code: string, errorAr: string): Validation => ({ ok: false, code, errorAr });
  if (!isObject(input)) return fail('INVALID', 'الإعدادات لازم تنبعت كاملة: شو بينشال، وأي شعار.');
  if (Object.keys(input).some((k) => k !== 'hide' && k !== 'logo')) return fail('INVALID', 'في خانة مش من إعدادات البوليصة.');
  if (!Array.isArray(input.hide) || input.hide.some((k) => typeof k !== 'string')) return fail('INVALID', 'قائمة العناصر المخفية مش مفهومة.');
  const hide = [...new Set(input.hide as string[])];
  const locked = hide.find((k) => (LOCKED_KEYS as readonly string[]).includes(k));
  if (locked) {
    const ar = WAYBILL_ELEMENTS.find((e) => e.key === locked)!.ar;
    return fail('COURIER_FIELD_LOCKED', `«${ar}» ما بتنشال عن البوليصة: شركة الشحن بتشتغل عليها.`);
  }
  if (hide.some((k) => !(HIDEABLE_KEYS as readonly string[]).includes(k))) return fail('INVALID', 'في عنصر بالقائمة مش من عناصر البوليصة.');
  if (input.logo !== 'store' && input.logo !== 'own' && input.logo !== 'none') return fail('INVALID', 'اختار الشعار: شعار المتجر، أو شعار خاص، أو بلا شعار.');
  if (input.logo === 'own' && !has.ownLogo) return fail('NO_OWN_LOGO', 'ارفع شعار البوليصة أول، بعدين اختارو.');
  // In the order the waybill prints them, so two saves of the same choice store the same bytes.
  const ordered = HIDEABLE_KEYS.filter((k) => hide.includes(k));
  return { ok: true, value: { hide: ordered, logo: input.logo } };
}

/** The stored document, or null when it is not exactly one (a broken document prints today's waybill). */
export function readDocument(raw: unknown): WaybillPrintDocument | null {
  if (!isObject(raw) || raw.v !== 1 || !isObject(raw.stores)) return null;
  return raw as unknown as WaybillPrintDocument;
}

/** One store's choices, read defensively: anything not understood is today's. */
export function storeEntry(doc: WaybillPrintDocument | null, storeId: string): StoreWaybillPrint | null {
  const e = doc?.stores?.[storeId];
  if (!isObject(e)) return null;
  const hide = Array.isArray(e.hide) ? HIDEABLE_KEYS.filter((k) => (e.hide as unknown[]).includes(k)) : [];
  const logo: LogoChoice = e.logo === 'own' || e.logo === 'none' ? e.logo : 'store';
  return { hide, logo, ...(typeof e.ownLogo === 'string' ? { ownLogo: e.ownLogo } : {}) };
}

export interface ResolvedWaybillPrint {
  logoUrl: string | null;
  /** Omitted when nothing is hidden: the renderer then draws today's waybill, untouched. */
  show?: SheetShow;
}

/**
 * What the print page hands the renderer for this store. No entry, or an entry that hides nothing and keeps the
 * store's logo, is EXACTLY what the page handed it before this existed: `storeLogoForPrint(store.logo)` and no `show`.
 */
export function resolveWaybillPrint(
  doc: WaybillPrintDocument | null,
  ids: { companyId: string; storeId: string },
  storeLogo: string | null | undefined
): ResolvedWaybillPrint {
  const e = storeEntry(doc, ids.storeId);
  const logoUrl = !e || e.logo === 'store'
    ? storeLogoForPrint(storeLogo)
    : e.logo === 'own' && isOwnWaybillLogo(e.ownLogo, ids.companyId, ids.storeId)
      ? storeLogoForPrint(e.ownLogo)
      : null;
  if (!e || e.hide.length === 0) return { logoUrl };
  const show = Object.fromEntries(HIDEABLE_KEYS.map((k) => [k, !e.hide.includes(k)])) as unknown as SheetShow;
  return { logoUrl, show };
}

/** Reads the company's settings document once and answers this store's choices; a read that throws is today's. */
export async function readWaybillPrint(
  client: Pick<typeof db, 'company'>,
  companyId: string
): Promise<WaybillPrintDocument | null> {
  try {
    const row = await client.company.findUnique({ where: { id: companyId }, select: { settings: true } });
    if (!row?.settings) return null;
    return readDocument((JSON.parse(row.settings) as Record<string, unknown>)[WAYBILL_PRINT_SETTINGS_KEY]);
  } catch {
    return null;
  }
}
