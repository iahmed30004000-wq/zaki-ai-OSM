import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LOCAL_STORAGE_DIR, STORAGE_PROVIDER, isSafeStorageKey } from '@/lib/storage';
import { readFontFacts, looksRestricted, type FontFacts } from './font-file';
import { cssString } from './css-string';

/**
 * A store's own typefaces: stored, named and served.
 *
 * Scoped to the store like everything else a store owns. A licence is
 * bought for a brand and usually for a domain, so a font uploaded for one
 * storefront is not a font the next storefront may set its headlines in —
 * the same rule as its stock, its couriers and its wallets.
 */

export const MAX_FONT_BYTES = 2 * 1024 * 1024;
export const ALLOWED_FONT_EXT = ['.woff2', '.woff', '.otf', '.ttf'] as const;

export interface UploadedFont {
  key: string;
  label: string;
  family: string;
  weight: number;
  italic: boolean;
  storageKey: string;
  sizeBytes: number;
  format: FontFacts['format'];
  notice: string;
  restricted: boolean;
}

/** What a seller is shown about a font they are about to publish with. */
export interface FontNotice {
  /** The designer's copyright and licence, as found in the file. */
  text: string;
  /** Where the designer says the full licence lives. */
  url: string;
  /** True when those words suggest serving the file is not permitted. */
  restricted: boolean;
}

/**
 * A CSS-safe, URL-safe slug for a family name.
 *
 * Arabic family names are common here and a family called "خمسة" cannot be
 * a filename or a CSS identifier, so a name that slugs to nothing falls back
 * to a short digest of itself. Two different Arabic names then still get two
 * different keys, which a constant like "font" would not.
 */
export function fontKey(family: string, fallback: string): string {
  const slug = family
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  if (slug) return slug;
  const seed = family.trim() || fallback;
  return 'f-' + crypto.createHash('sha256').update(seed).digest('hex').slice(0, 10);
}

/** The weight a filename implies, for a woff2 whose tables we cannot read. */
export function weightFromFileName(name: string): number | null {
  const n = name.toLowerCase();
  if (/extra\s*-?\s*light|ultra\s*-?\s*light|extralight/.test(n)) return 200;
  if (/\bthin\b|hairline/.test(n)) return 100;
  if (/\blight\b/.test(n)) return 300;
  if (/semi\s*-?\s*bold|demi\s*-?\s*bold|semibold/.test(n)) return 600;
  if (/extra\s*-?\s*bold|ultra\s*-?\s*bold|extrabold/.test(n)) return 800;
  if (/\bblack\b|\bheavy\b/.test(n)) return 900;
  if (/\bbold\b/.test(n)) return 700;
  if (/\bmedium\b/.test(n)) return 500;
  if (/\bregular\b|\bnormal\b|\bbook\b/.test(n)) return 400;
  const m = /\b([1-9]00)\b/.exec(n);
  return m ? Number(m[1]) : null;
}

/**
 * The family a filename implies, once the weight and style are taken off it.
 *
 * `thmanyah sans-Bold.woff2` is one face of `thmanyah sans`, not a family
 * called "thmanyah sans Bold". Leaving the weight in gave every file its
 * own family: a seller uploaded five weights and the picker offered five
 * fonts, each with one weight, none of which could go bold.
 *
 * Only matters for woff2 and woff, whose tables are compressed and whose
 * real family name we therefore cannot read.
 */
export function familyFromFileName(name: string): string {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(
      /[-_ ]*\b(thin|hairline|extra\s*-?\s*light|ultra\s*-?\s*light|extralight|light|regular|normal|book|medium|semi\s*-?\s*bold|demi\s*-?\s*bold|semibold|demibold|extra\s*-?\s*bold|ultra\s*-?\s*bold|extrabold|bold|black|heavy|italic|oblique|[1-9]00)\b/gi,
      ''
    )
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Read a font, and say what it is and what its designer wrote about it.
 *
 * Throws in Arabic on anything that is not a font — the message goes
 * straight to the seller, who uploaded a file and deserves to know why it
 * came back rather than to see "invalid input".
 */
export function describeFont(buffer: Buffer, originalName: string): Omit<UploadedFont, 'storageKey'> {
  if (buffer.length === 0) throw new Error('الملف فارغ');
  if (buffer.length > MAX_FONT_BYTES) {
    throw new Error(`حجم الخط يتجاوز الحد المسموح (${Math.round(MAX_FONT_BYTES / 1024 / 1024)} ميجابايت)`);
  }

  const facts = readFontFacts(buffer);
  // The magic bytes decide, not the extension: a .woff2 that is really a zip
  // would otherwise be stored and served as a font.
  if (!facts) throw new Error('هذا الملف ليس خطاً صالحاً');

  // A woff2 keeps its tables Brotli-compressed, so the family has to come
  // from the filename — with the weight taken off it, or every weight
  // becomes a family of its own.
  // Markup and control characters off the name before it is stored: it is
  // drawn into every page's stylesheet, and cssString at the drawing is the
  // guard — this is the second one, so a row written before the fix and a
  // future caller that forgets the first are both covered.
  const family =
    (facts.family || familyFromFileName(originalName) || '').replace(/[<>\u0000-\u001f\u007f]/g, '').trim() || 'خط مرفوع';
  const weight = facts.family ? facts.weight : (weightFromFileName(originalName) ?? 400);
  const italic = facts.italic || /italic|oblique/i.test(originalName);

  const noticeParts = [facts.copyright, facts.licence, facts.licenceUrl].filter(Boolean);

  return {
    key: fontKey(family, originalName),
    label: family,
    family,
    weight,
    italic,
    sizeBytes: buffer.length,
    format: facts.format,
    notice: noticeParts.join('\n\n').slice(0, 8000),
    restricted: looksRestricted(facts),
  };
}

/** Where a store's font files live. Tenant-namespaced like every upload. */
export function fontStorageKey(companyId: string, storeId: string, key: string, weight: number, italic: boolean, format: string) {
  const style = italic ? 'i' : 'n';
  return `companies/${companyId}/stores/${storeId}/fonts/${key}-${weight}${style}.${format}`;
}

export async function writeFontFile(storageKey: string, buffer: Buffer): Promise<void> {
  if (STORAGE_PROVIDER !== 'local') {
    throw new Error(`STORAGE_PROVIDER=${STORAGE_PROVIDER} غير مُهيأ لرفع الخطوط`);
  }
  // The same containment guard every other writer and reader of the uploads folder asks (SF-RV68).
  if (!isSafeStorageKey(storageKey)) throw new Error('مسار تخزين غير صالح');
  const abs = path.join(LOCAL_STORAGE_DIR, storageKey);
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  await fs.promises.writeFile(abs, buffer);
}

const MIME: Record<string, string> = {
  woff2: 'font/woff2',
  woff: 'font/woff',
  otf: 'font/otf',
  ttf: 'font/ttf',
};

export function fontMime(format: string): string {
  return MIME[format] || 'application/octet-stream';
}

// Pure, and in a file of its own so the editor (a client component) can use
// the same escape without importing this server-only module.
export { cssString };

/**
 * The @font-face rules for a store's uploaded faces.
 *
 * Built here rather than in a component so the editor and the published
 * page cannot drift: one function, one set of rules, both callers.
 *
 * Every value goes through cssString, because all of them arrived from a
 * file somebody uploaded: the family from its name table, the url from a
 * key we slugged, the weight from its metrics.
 */
export function fontFaceCss(
  fonts: { family: string; key: string; weight: number; italic: boolean; format: string }[],
  urlFor: (f: { key: string; weight: number; italic: boolean; format: string }) => string
): string {
  return fonts
    .map(
      (f) =>
        `@font-face{font-family:${cssString(f.family)};src:url(${cssString(urlFor(f))}) format(${cssString(f.format)});font-weight:${Number(f.weight) || 400};font-style:${f.italic ? 'italic' : 'normal'};font-display:swap;}`
    )
    .join('\n');
}
