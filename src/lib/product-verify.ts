import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { db } from '@/lib/db';
import { normalizeAuthenticityCode } from '@/lib/authenticity';
import {
  HEX_COLOR,
  VERIFY_DEFAULTS,
  VERIFY_LIMITS,
  normalizeSlug,
  normalizeWhatsapp,
  slugProblem,
  suggestSlug,
  contactWhatsappUrl,
  type VerifyDesign,
} from '@/lib/product-verify-design';

/**
 * «باركود المنتجات» — THE SERVER SIDE OF A PRODUCT'S OWN PAGE.
 *
 * A page is reached by its short slug (`/v/<slug>`), by an OLD slug (a permanent redirect to the current one — a
 * printed barcode never breaks), or by its stable `publicId` (`/verify/p/<publicId>`, which redirects to the slug).
 * Its check answers `{ genuine }` and nothing else (`isGenuineForProduct`).
 */

/** ~12 url-safe characters: the page's stable public key, never the product's id. */
export function newPublicId(): string {
  return randomBytes(9).toString('base64url');
}
export const PUBLIC_ID = /^[A-Za-z0-9_-]{12}$/;

// ───────────────────────── a save ─────────────────────────

const opt = (max: number, msg: string) =>
  z
    .string()
    .trim()
    .max(max, msg)
    .nullable()
    .optional()
    // Not sent → undefined (the column is left alone: a switch press must not wipe the design); sent empty → null.
    .transform((v) => (v === undefined ? undefined : v || null));

const httpsUrl = (label: string) =>
  opt(VERIFY_LIMITS.url, `${label}: الرابط طويل`).refine((v) => v == null || /^https:\/\/[^\s]+$/i.test(v), {
    message: `${label}: لازم يكون رابط يبلش بـ https://`,
  });

/** An image: an https link, or one uploaded here (a private `/api/media/...` link the server rewrites for the public). */
const imageRef = (label: string) =>
  opt(VERIFY_LIMITS.url, `${label}: الرابط طويل`).refine(
    (v) => v == null || /^https:\/\/[^\s]+$/i.test(v) || /^\/api\/(?:media|public\/store-logo)\/[A-Za-z0-9/._-]+$/.test(v),
    { message: `${label}: لازم تكون صورة مرفوعة أو رابط يبلش بـ https://` }
  );

const color = (label: string) =>
  opt(7, `${label}: لون غير صالح`).refine((v) => v == null || HEX_COLOR.test(v), {
    message: `${label}: اكتب اللون بالشكل ‎#1a2b3c`,
  });

export const designSchema = z
  .object({
    slug: z
      .string()
      .optional()
      .transform((v) => (v === undefined ? undefined : normalizeSlug(v)))
      .superRefine((v, ctx) => {
        if (v === undefined) return;
        const problem = slugProblem(v);
        if (problem) ctx.addIssue({ code: 'custom', message: problem });
      }),
    active: z.boolean().optional(),
    headline: opt(VERIFY_LIMITS.headline, `العنوان طويل — ${VERIFY_LIMITS.headline} حرفاً على الأكثر`),
    nameOverride: opt(VERIFY_LIMITS.name, `الاسم طويل — ${VERIFY_LIMITS.name} حرفاً على الأكثر`),
    imageUrl: imageRef('صورة المنتج'),
    logoUrl: imageRef('الشعار'),
    primaryColor: color('اللون الأساسي'),
    backgroundColor: color('لون الخلفية'),
    description: opt(VERIFY_LIMITS.description, `الوصف طويل — ${VERIFY_LIMITS.description} حرفاً على الأكثر`),
    features: z
      .array(z.string().trim().max(VERIFY_LIMITS.feature, `الميزة طويلة — ${VERIFY_LIMITS.feature} حرفاً على الأكثر`))
      .max(VERIFY_LIMITS.features, `${VERIFY_LIMITS.features} ميزات على الأكثر`)
      .optional()
      .transform((v) => (v ? v.filter(Boolean) : undefined)),
    genuineMessage: opt(VERIFY_LIMITS.message, `رسالة «منتج أصلي» طويلة — ${VERIFY_LIMITS.message} حرفاً على الأكثر`),
    notGenuineMessage: opt(VERIFY_LIMITS.message, `رسالة «غير أصلي» طويلة — ${VERIFY_LIMITS.message} حرفاً على الأكثر`),
    whatsappNumber: opt(20, 'رقم الواتساب طويل').refine((v) => v == null || normalizeWhatsapp(v) !== null, {
      message: 'رقم الواتساب لازم يكون أرقام مع رمز البلد (مثلاً 963912345678)',
    }),
    reorderMode: z.enum(['landing', 'custom', 'none'], { message: 'اختار وين بيروح زر «اطلب مرة تانية»' }).optional(),
    reorderUrl: httpsUrl('رابط «اطلب مرة تانية»'),
  })
  .superRefine((v, ctx) => {
    if (v.reorderMode === 'custom' && !v.reorderUrl) {
      ctx.addIssue({ code: 'custom', path: ['reorderUrl'], message: 'اكتب رابط «اطلب مرة تانية» أو اختار صفحة الهبوط' });
    }
  });

export type DesignInput = z.infer<typeof designSchema>;

/** The columns a parsed save writes (only what was sent). */
export function designData(d: DesignInput) {
  const out: Record<string, unknown> = {};
  for (const k of [
    'headline', 'nameOverride', 'imageUrl', 'logoUrl', 'primaryColor', 'backgroundColor', 'description',
    'genuineMessage', 'notGenuineMessage', 'reorderMode', 'reorderUrl', 'active',
  ] as const) {
    if (d[k] !== undefined) out[k] = d[k];
  }
  if (d.primaryColor) out.primaryColor = d.primaryColor.toLowerCase();
  if (d.backgroundColor) out.backgroundColor = d.backgroundColor.toLowerCase();
  if (d.whatsappNumber !== undefined) out.whatsappNumber = normalizeWhatsapp(d.whatsappNumber);
  if (d.features !== undefined) out.features = JSON.stringify(d.features);
  return out;
}

export function parseFeatures(json: string | null | undefined): string[] {
  try {
    const v = JSON.parse(json || '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, VERIFY_LIMITS.features) : [];
  } catch {
    return [];
  }
}

// ───────────────────────── the short link, server side ─────────────────────────

/** Whether a slug is held by ANY page — as its current slug or as one it used to have — other than `exceptPageId`. */
export async function slugTaken(slug: string, exceptPageId?: string | null): Promise<boolean> {
  const [current, old] = await Promise.all([
    db.productVerifyPage.findUnique({ where: { slug }, select: { id: true } }),
    db.productVerifyPageSlug.findUnique({ where: { slug }, select: { pageId: true } }),
  ]);
  if (current && current.id !== exceptPageId) return true;
  if (old && old.pageId !== exceptPageId) return true;
  return false;
}

export const SLUG_TAKEN = 'الرابط مستعمل لمنتج تاني — اختار غيره';

/** A free slug for a product: the suggestion, then the suggestion with a number, then a short random one. */
export async function freeSlugFor(product: { name?: string | null; nameEn?: string | null; sku?: string | null }): Promise<string> {
  const base = suggestSlug(product);
  if (base) {
    if (!(await slugTaken(base))) return base;
    for (let i = 2; i <= 9; i++) {
      const s = `${base.slice(0, 36)}-${i}`;
      if (!(await slugTaken(s))) return s;
    }
  }
  for (;;) {
    const s = `p-${randomBytes(4).toString('hex').slice(0, 6)}`;
    if (!(await slugTaken(s))) return s;
  }
}

// ───────────────────────── the public read ─────────────────────────

const PRIVATE_MEDIA = /^\/api\/media\/companies\/([0-9a-f-]{36})\/products\/([0-9a-f-]{36})\/([0-9a-f-]{36}\.(?:webp|jpe?g|png))$/i;

/**
 * An image the public may load. https → as is; the store's public logo → as is; a private upload in THIS product's
 * folder → this page's own media route (served only while the page is active, only files the page shows). Anything
 * else (another company's folder, another product's folder) → null: never a broken image, never a door into a folder.
 */
export function publicImage(url: string | null | undefined, page: { publicId: string; companyId: string; productId: string }): string | null {
  if (!url) return null;
  if (/^https:\/\//i.test(url)) return url;
  if (/^\/api\/public\/store-logo\/[A-Za-z0-9/._-]+$/.test(url)) return url;
  const m = PRIVATE_MEDIA.exec(url);
  if (m && m[1].toLowerCase() === page.companyId.toLowerCase() && m[2].toLowerCase() === page.productId.toLowerCase()) {
    return `/api/public/verify-product/${page.publicId}/media/${m[3].toLowerCase()}`;
  }
  return null;
}

const PAGE_SELECT = {
  id: true,
  companyId: true,
  productId: true,
  publicId: true,
  slug: true,
  active: true,
  headline: true,
  nameOverride: true,
  imageUrl: true,
  logoUrl: true,
  primaryColor: true,
  backgroundColor: true,
  description: true,
  features: true,
  genuineMessage: true,
  notGenuineMessage: true,
  whatsappNumber: true,
  reorderMode: true,
  reorderUrl: true,
} as const;

export type PageRow = {
  id: string;
  companyId: string;
  productId: string;
  publicId: string;
  slug: string;
  active: boolean;
  headline: string | null;
  nameOverride: string | null;
  imageUrl: string | null;
  logoUrl: string | null;
  primaryColor: string | null;
  backgroundColor: string | null;
  description: string | null;
  features: string;
  genuineMessage: string | null;
  notGenuineMessage: string | null;
  whatsappNumber: string | null;
  reorderMode: string;
  reorderUrl: string | null;
};

type ProductBits = {
  name: string;
  description: string | null;
  image: string | null;
  images: { url: string }[];
  store: { logo: string | null } | null;
};

/** The newest published landing page that sells this product — its own domain when proved, else `/lp/<slug>`. */
async function landingFor(companyId: string, productId: string): Promise<string | null> {
  const lp = await db.landingPage.findFirst({
    where: { companyId, productId, isPublished: true },
    orderBy: { updatedAt: 'desc' },
    select: { slug: true, domain: true, domainVerifiedAt: true },
  });
  if (!lp) return null;
  if (lp.domain && lp.domainVerifiedAt) return `https://${lp.domain}`;
  return `/lp/${encodeURIComponent(lp.slug)}`;
}

/** The page as the world sees it: overrides, then the product, then the defaults. */
export async function resolveDesign(page: PageRow, product: ProductBits): Promise<VerifyDesign> {
  const name = page.nameOverride || product.name;
  const productImage = product.images[0]?.url ?? product.image;
  const reorderUrl =
    page.reorderMode === 'custom' ? page.reorderUrl : page.reorderMode === 'landing' ? await landingFor(page.companyId, page.productId) : null;
  return {
    name,
    headline: page.headline || VERIFY_DEFAULTS.headline,
    description: page.description ?? '',
    features: parseFeatures(page.features),
    imageUrl: publicImage(page.imageUrl, page) ?? publicImage(productImage, page),
    logoUrl: publicImage(page.logoUrl, page) ?? publicImage(product.store?.logo, page),
    primaryColor: page.primaryColor && HEX_COLOR.test(page.primaryColor) ? page.primaryColor : VERIFY_DEFAULTS.primaryColor,
    backgroundColor: page.backgroundColor && HEX_COLOR.test(page.backgroundColor) ? page.backgroundColor : VERIFY_DEFAULTS.backgroundColor,
    genuineMessage: page.genuineMessage || VERIFY_DEFAULTS.genuineMessage,
    notGenuineMessage: page.notGenuineMessage || VERIFY_DEFAULTS.notGenuineMessage,
    whatsappUrl: contactWhatsappUrl(page.whatsappNumber, name),
    reorderUrl,
  };
}

const PRODUCT_SELECT = {
  name: true,
  description: true,
  image: true,
  images: { orderBy: [{ isPrimary: 'desc' as const }, { sortOrder: 'asc' as const }], take: 1, select: { url: true } },
  store: { select: { logo: true } },
};

export type SlugLookup =
  | { kind: 'page'; page: PageRow; design: VerifyDesign }
  | { kind: 'moved'; slug: string }
  | { kind: 'none' };

/**
 * What `/v/<slug>` answers. The current slug of an ACTIVE page → the page; a slug a page used to have → `moved` to its
 * current slug (the page is then judged again on arrival); anything else, an inactive page included → none (404).
 */
export async function lookupBySlug(rawSlug: string): Promise<SlugLookup> {
  const slug = normalizeSlug(rawSlug);
  // Every slug ever saved (current or old) passed `slugProblem`, so anything failing it is nobody's: no database read.
  if (slugProblem(slug)) return { kind: 'none' };
  const page = await db.productVerifyPage.findUnique({
    where: { slug },
    select: { ...PAGE_SELECT, product: { select: PRODUCT_SELECT } },
  });
  if (page) {
    if (!page.active) return { kind: 'none' };
    const { product, ...row } = page;
    return { kind: 'page', page: row, design: await resolveDesign(row, product) };
  }
  const old = await db.productVerifyPageSlug.findUnique({ where: { slug }, select: { page: { select: { slug: true, active: true } } } });
  if (old?.page?.active) return { kind: 'moved', slug: old.page.slug };
  return { kind: 'none' };
}

/** The current slug of an active page by its stable public id (for `/verify/p/<publicId>`), or null. */
export async function slugForPublicId(publicId: string): Promise<string | null> {
  if (!PUBLIC_ID.test(publicId)) return null;
  const page = await db.productVerifyPage.findUnique({ where: { publicId }, select: { slug: true, active: true } });
  return page?.active ? page.slug : null;
}

// ───────────────────────── the verdict ─────────────────────────

/**
 * GENUINE FOR THIS PRODUCT: the code (already normalized) exists in the page's company AND it is tagged to this
 * product, or to no product at all. A code tagged to ANOTHER product reads «غير أصلي» here — a label moved from one
 * product to another is exactly what this page exists to catch. Bumps the scan count best-effort, after the verdict.
 */
export async function isGenuineForProduct(companyId: string, productId: string, code: string | null): Promise<boolean> {
  if (!code) return false;
  const row = await db.authenticityCode.findUnique({
    where: { companyId_code: { companyId, code } },
    select: { id: true, productId: true },
  });
  if (!row) return false;
  if (row.productId && row.productId !== productId) return false;
  db.authenticityCode
    .update({ where: { id: row.id }, data: { scanCount: { increment: 1 }, lastScanAt: new Date() } })
    .catch(() => undefined);
  return true;
}

/**
 * A scanned/typed string for a product page: a link to THIS kind of page (`…/v/<slug>?code=X`) gives its code; the
 * store-level link and plain codes go through `normalizeAuthenticityCode` as everywhere else.
 */
export function normalizeProductCode(raw: string): string | null {
  const text = raw.trim();
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      if (/^\/v\/[a-z0-9-]+\/?$/i.test(url.pathname) || /^\/verify\/p\/[A-Za-z0-9_-]{12}\/?$/.test(url.pathname)) {
        const inner = url.searchParams.get('code');
        return inner ? normalizeAuthenticityCode(inner) : null;
      }
    } catch {
      /* not a link: judged as a code below */
    }
  }
  return normalizeAuthenticityCode(text);
}

/** The active page with this public id, for the public check and media routes. */
export async function activePageByPublicId(publicId: string) {
  if (!PUBLIC_ID.test(publicId)) return null;
  const page = await db.productVerifyPage.findUnique({
    where: { publicId },
    select: { companyId: true, productId: true, active: true, imageUrl: true, logoUrl: true },
  });
  return page?.active ? page : null;
}
