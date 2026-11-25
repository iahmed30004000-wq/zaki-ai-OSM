/**
 * «باركود المنتجات» — WHAT BOTH SIDES OF A PRODUCT'S PAGE READ, AND NOTHING THAT RUNS ON THE SERVER.
 *
 * The public page (`/v/<slug>`) and the owner's editor draw the SAME view (`ProductVerifyView`), so the shape it is
 * drawn from, its defaults, the short-link rules and the link builders live here, importable from a client component.
 * The database, the zod schema of a save and the code check are in `product-verify.ts` (server only).
 *
 * What the world may learn from a page is the product the owner chose to show — and about a code, only genuine
 * true/false (`src/lib/authenticity.ts`). Nothing in `VerifyDesign` is about a code.
 */

/** The page as it is drawn: every field already resolved (override → product → default). */
export interface VerifyDesign {
  name: string;
  headline: string;
  description: string;
  features: string[];
  /** Absolute https, or a same-origin path the public can load. Null → no picture. */
  imageUrl: string | null;
  logoUrl: string | null;
  primaryColor: string;
  backgroundColor: string;
  genuineMessage: string;
  notGenuineMessage: string;
  /** A ready `https://wa.me/…` link, or null. */
  whatsappUrl: string | null;
  /** Where «اطلب مرة تانية» goes, or null (no button). */
  reorderUrl: string | null;
}

export const VERIFY_DEFAULTS = {
  primaryColor: '#0e9f6e',
  backgroundColor: '#f5f7fb',
  headline: 'تحقق إنو القطعة اللي بين إيديك أصلية',
  genuineMessage: 'هذه القطعة مسجّلة لدينا كمنتج أصلي. شكراً لثقتك.',
  notGenuineMessage:
    'هذا الرمز غير مسجّل لهذا المنتج. تأكد إنك كتبته متل ما هو، وإذا تكررت النتيجة تواصل معنا قبل الاستعمال.',
} as const;

/** Caps — the editor's inputs and the server's schema read the same numbers. */
export const VERIFY_LIMITS = {
  name: 120,
  headline: 160,
  description: 1200,
  feature: 100,
  features: 8,
  message: 400,
  url: 1000,
} as const;

export const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Relative luminance (sRGB) of a validated `#rrggbb`. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** True when light text reads better on this colour (relative luminance, sRGB). */
export function isDarkColor(hex: string): boolean {
  if (!HEX_COLOR.test(hex)) return false;
  return luminance(hex) < 0.4;
}

/** The night the page is drawn on when the owner's own background cannot be (the store-level checker's navy). */
export const VERIFY_NIGHT = '#060b16';

/**
 * THE PAGE'S BASE COLOUR. The page is a night page (grid, glow, particles — the look of `/verify/<id>`), so the
 * owner's `backgroundColor` can only TINT it, never turn it light:
 *   - already very dark (luminance < 0.05) → the owner's own colour, as it is;
 *   - a mid colour → the night, tinted 22% by it (a blue page stays bluish, a wine page wine-ish);
 *   - a light colour (the default `#f5f7fb` included) → the plain night: a light colour has no dark reading.
 * The result is always a `#rrggbb` — the public page also paints `html,body` with it (the overscroll).
 */
export function verifyPageBackground(bg: string): string {
  if (!HEX_COLOR.test(bg)) return VERIFY_NIGHT;
  const l = luminance(bg);
  if (l < 0.05) return bg.toLowerCase();
  if (l >= 0.4) return VERIFY_NIGHT;
  const mix = (i: number) => {
    const v = Math.round(parseInt(bg.slice(i, i + 2), 16) * 0.22 + parseInt(VERIFY_NIGHT.slice(i, i + 2), 16) * 0.78);
    return v.toString(16).padStart(2, '0');
  };
  return `#${mix(1)}${mix(3)}${mix(5)}`;
}

// ───────────────────────── the short link ─────────────────────────

/**
 * THE SHORT ADDRESS: `/v/<slug>` (25/11, owner: «الروابط بكون بقدر اعدل عليها واخليها اقصر»).
 *
 * Lowercase latin letters, digits and single dashes inside, 3–40 characters. Latin only on purpose: a QR of an Arabic
 * path is percent-encoded into three times the characters, which makes the printed square denser and harder to scan.
 */
export const SLUG_MIN = 3;
export const SLUG_MAX = 40;
const SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Words that read as part of the app, not as a product — never a product's link. */
export const RESERVED_SLUGS: readonly string[] = [
  'admin', 'api', 'app', 'verify', 'v', 'p', 'lp', 's', 'login', 'logout', 'register', 'settings', 'dashboard',
  'static', 'public', 'new', 'edit', 'www', 'help', 'support', 'store', 'null', 'undefined',
];

/** The query parameter a piece's QR carries its code in — the same one the store-level page reads. */
export const PRODUCT_CODE_PARAM = 'code';

/** What an owner typed, as it would be stored: trimmed and lowercased. Nothing else is changed — a bad one is refused. */
export function normalizeSlug(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Null when the slug is acceptable in shape, else the Arabic sentence the owner reads. (Uniqueness is the server's.) */
export function slugProblem(slug: string): string | null {
  if (slug.length < SLUG_MIN) return `الرابط قصير — ${SLUG_MIN} أحرف على الأقل`;
  if (slug.length > SLUG_MAX) return `الرابط طويل — ${SLUG_MAX} حرفاً على الأكثر`;
  if (!SLUG_SHAPE.test(slug)) {
    return 'الرابط بيقبل أحرف إنكليزية صغيرة وأرقام وشرطة (-) بس، وما بيبلش ولا بيخلص بشرطة ولا فيه شرطتين ورا بعض';
  }
  if (RESERVED_SLUGS.includes(slug)) return 'هالكلمة محجوزة للنظام — اختار رابط تاني';
  return null;
}

const AR_LATIN: Record<string, string> = {
  ا: 'a', أ: 'a', إ: 'i', آ: 'a', ب: 'b', ت: 't', ث: 'th', ج: 'j', ح: 'h', خ: 'kh', د: 'd', ذ: 'th', ر: 'r', ز: 'z',
  س: 's', ش: 'sh', ص: 's', ض: 'd', ط: 't', ظ: 'z', ع: 'a', غ: 'gh', ف: 'f', ق: 'q', ك: 'k', ل: 'l', م: 'm', ن: 'n',
  ه: 'h', ة: 'a', و: 'w', ي: 'y', ى: 'a', ئ: 'y', ؤ: 'w', ء: '',
};

/** Arabic-Indic and Persian digits typed in a product name, as 0-9 (written as escapes: none is ever shown). */
const toWestern = (s: string) =>
  s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));

/** A latin rendering of any text, shaped like a slug (may come out empty or too short — the caller falls back). */
export function slugify(text: string, max = 32): string {
  // NFKD splits «أ» into «ا» and a hamza mark, and «é» into «e» and an accent: the marks are dropped, the letters kept.
  const latin = [...toWestern(text).normalize('NFKD').replace(/\p{M}/gu, '')]
    .map((ch) => AR_LATIN[ch] ?? ch)
    .join('')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (latin.length <= max) return latin;
  const cut = latin.slice(0, max);
  const at = cut.lastIndexOf('-');
  return (at >= SLUG_MIN ? cut.slice(0, at) : cut).replace(/-+$/g, '');
}

/**
 * The first suggestion for a product: its English name, else its Arabic name transliterated, else its SKU — whichever
 * makes a valid slug first. Null when none does (the server then uses a short random one).
 */
export function suggestSlug(product: { name?: string | null; nameEn?: string | null; sku?: string | null }): string | null {
  for (const source of [product.nameEn, product.name, product.sku]) {
    if (!source) continue;
    const s = slugify(source);
    if (!slugProblem(s)) return s;
  }
  return null;
}

/** `/v/<slug>` or `/v/<slug>?code=…`, on `origin` (no trailing slash). */
export function productVerifyLink(origin: string, slug: string, code?: string | null): string {
  const base = `${origin}/v/${slug}`;
  return code ? `${base}?${PRODUCT_CODE_PARAM}=${encodeURIComponent(code)}` : base;
}

/** The page's STABLE address, by its random public id: it never changes and redirects to the current short link. */
export function productVerifyStableLink(origin: string, publicId: string): string {
  return `${origin}/verify/p/${publicId}`;
}

/** Digits only, 6–15 of them (an international number without the plus), or null. */
export function normalizeWhatsapp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[\s()+-]/g, '').replace(/^00/, '');
  return /^\d{6,15}$/.test(digits) ? digits : null;
}

export function contactWhatsappUrl(number: string | null, productName: string): string | null {
  const n = normalizeWhatsapp(number);
  if (!n) return null;
  return `https://wa.me/${n}?text=${encodeURIComponent(`مرحبا، عندي سؤال عن ${productName}`)}`;
}
