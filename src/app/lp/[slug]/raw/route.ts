import { sellingCurrency, SELLING_STORE_SELECT } from '@/lib/selling-currency';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { activeOffersFor } from '@/lib/offers';
import { clampStoredHtml, RAW_HTML_CSP, verifyPreviewToken } from '@/lib/landing-pages';
import { draftState } from '@/lib/landing-draft';
import {
  sanitizeLandingCss,
  sanitizeLandingHtml,
  injectPageStyles,
  parseLandingSettings,
  applyLandingVariables,
} from '@/lib/landing-html-sanitize';
import { resolveDynamicPlaceholders } from '@/lib/landing-dynamic';
import { toPublicMedia } from '@/lib/public-media';

interface Ctx {
  params: Promise<{ slug: string }>;
}

const DEFAULT_HTML = (name: string, productName?: string | null) => `<!doctype html>
<html dir="rtl" lang="ar"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name.replace(/[<>&"]/g, '')}</title>
<style>*{margin:0;box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;background:linear-gradient(160deg,#121926 0%,#1a2232 60%,#b8256e22 100%);color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.hero{text-align:center;max-width:480px}
.tag{display:inline-block;background:#b8256e;color:#fff;font-size:12px;font-weight:700;letter-spacing:.1em;padding:6px 14px;border-radius:99px;text-transform:uppercase}
h1{font-size:32px;line-height:1.3;margin:18px 0 10px}
p.sub{color:#9aa4b2;font-size:15px;line-height:1.7}
.scroll{margin-top:28px;display:inline-flex;align-items:center;gap:8px;color:#fff;background:#ffffff14;border:1px solid #ffffff2e;padding:12px 22px;border-radius:99px;font-size:14px;font-weight:600;text-decoration:none}
</style></head><body>
<div class="hero">
<span class="tag">عرض خاص</span>
<h1>${name.replace(/[<>&"]/g, '')}</h1>
<p class="sub">اطلب الآن واستفد من العرض — الدفع عند الاستلام وتوصيل لجميع المناطق.</p>
<a class="scroll" href="#zaki-order-form">اطلب الآن ↓</a>
</div>
</body></html>`;

/**
 * Serves the uploaded landing page HTML.
 * This response is ONLY ever rendered inside a sandboxed iframe without
 * allow-same-origin (see /lp/[slug]/page.tsx) — an opaque origin that cannot
 * read the CRM session cookie, localStorage, JWT or CSRF tokens, and cannot
 * touch admin APIs with credentials. CSP is set as defense in depth.
 *
 * `?p=<signed token>` allows the dashboard preview of an UNPUBLISHED page
 * (token is LP-scoped, 10-minute TTL). Public visitors only ever get
 * published pages.
 */
export async function GET(req: Request, ctx: Ctx) {
  const { slug } = await ctx.params;
  if (!/^[a-z0-9-]{2,60}$/.test(slug)) return new NextResponse('Not found', { status: 404 });

  const { searchParams } = new URL(req.url);
  const previewToken = searchParams.get('p');

  let lp = null;
  let previewing = false;
  if (previewToken) {
    const tok = await verifyPreviewToken(previewToken);
    if (tok) {
      lp = await db.landingPage.findFirst({
        where: { id: tok.lpId, slug },
        select: {
          id: true, name: true, slug: true, htmlContent: true, cssContent: true, pageSettings: true,
          store: SELLING_STORE_SELECT,
          productId: true, companyId: true,
          product: { select: { name: true, nameEn: true, image: true, description: true, basePrice: true } },
          recommendations: { where: { isActive: true, product: { status: 'ACTIVE' } }, orderBy: { sortOrder: 'asc' }, select: { id: true, product: { select: { name: true, basePrice: true, image: true } } } },
        },
      });
      // Only a page the token actually opened is being previewed. A token
      // whose page is gone (or renamed out of this slug) falls through to the
      // published page below, and that page's images must be public links —
      // flagging it as a preview would hand a shopper private, no-store ones.
      previewing = !!lp;
    }
    // Invalid/expired token → fall through to the published-only path
  }
  if (!lp) {
    lp = await db.landingPage.findFirst({
      where: { slug, isPublished: true },
      orderBy: { createdAt: 'asc' }, // one resolution for a slug everywhere — the oldest page keeps it
      select: {
        id: true, name: true, slug: true, htmlContent: true, cssContent: true, pageSettings: true,
        store: SELLING_STORE_SELECT,
        productId: true, companyId: true,
        product: { select: { name: true, nameEn: true, image: true, description: true, basePrice: true } },
        recommendations: { where: { isActive: true, product: { status: 'ACTIVE' } }, orderBy: { sortOrder: 'asc' }, select: { id: true, product: { select: { name: true, basePrice: true, image: true } } } },
      },
    });
  }
  if (!lp) return new NextResponse('Not found', { status: 404 });

  // The uploaded HTML of a page being PREVIEWED is the draft's, for the same
  // reason the block page's is: a seller who saved and pressed «معاينة» was
  // shown the markup their visitors have, which is the markup they had just
  // replaced. Only behind a valid signed token — a visitor has none and gets
  // the published columns.
  if (previewing) {
    const { draft } = await draftState(lp.id);
    // The three this route serves, and only the ones the draft mentions: a
    // key it does not carry must leave the live value standing.
    if (draft) {
      const mine = Object.fromEntries(
        (['htmlContent', 'cssContent', 'pageSettings'] as const)
          .filter((f) => f in draft)
          .map((f) => [f, draft[f] ?? null])
      );
      lp = { ...lp, ...mine };
    }
  }

  // Serve the uploaded (untrusted) HTML — re-sanitized at serve time (defense
  // in depth; already sanitized at save). NO form injection: the Trusted
  // Native Order Form is rendered by /lp/[slug] OUTSIDE this iframe.
  const stored = clampStoredHtml(lp.htmlContent);
  const settings = parseLandingSettings(lp.pageSettings);

  // ── Page settings (base styles). They are injected at the START of the document
  //    (see injectPageStyles), so the uploaded file's own <style> elements come
  //    AFTER them. `html body` is one step more specific than the plain `body`
  //    such a file writes, so the seller's choice in the editor still wins. ──
  const baseStyles = settings
    ? `<style id="zaki-base-style">html body{${[
        settings.background ? `background:${settings.background}` : '',
        settings.direction ? `direction:${settings.direction}` : '',
        settings.fontFamily ? `font-family:${settings.fontFamily}` : '',
      ].filter(Boolean).join(';')}}
${settings.width === 'contained' && settings.maxWidth ? `html .zaki-page-wrap{max-width:${settings.maxWidth}px;margin:0 auto;padding:0 16px}` : ''}</style>`
    : '';

  // ── Custom CSS — sanitized, injected right after the settings ──
  const customCss = lp.cssContent?.trim() ? `<style id="zaki-custom-style">${sanitizeLandingCss(lp.cssContent)}</style>` : '';

  // ── Whitelisted dynamic variables — values from the DB only ──
  let html = stored || DEFAULT_HTML(lp.name, lp.product?.name);
  html = sanitizeLandingHtml(html);
  if (lp.product) {
    html = applyLandingVariables(html, {
      name: lp.product.name,
      nameEn: lp.product.nameEn,
      image: lp.product.image,
      description: lp.product.description,
      price: lp.product.basePrice,
    });
  }

  // ── Phase 2: data-zaki-* placeholders → server-rendered DB-backed blocks ──
  // Values (product/offers/recommendations) come exclusively from the DB —
  // the custom HTML can only place markers, never set prices/ids. The
  // interaction script is hard-coded server output (see landing-dynamic.ts).
  const currency = await sellingCurrency(lp.store, lp.companyId);

  // The offers come from the PRODUCT, like everywhere else. This page used to
  // read a per-page copy of the same tiers; there is only one copy now, so a
  // price raised in the catalogue reaches the uploaded HTML too.
  const productOffers = lp.productId
    ? await activeOffersFor(db, lp.companyId, lp.productId, lp.store?.country.minorUnit ?? 2)
    : [];

  html = resolveDynamicPlaceholders({
    html,
    slug: lp.slug,
    product: lp.product
      ? { name: lp.product.name, nameEn: lp.product.nameEn, image: lp.product.image, description: lp.product.description, price: lp.product.basePrice }
      : null,
    offers: productOffers.map((o) => ({
      id: o.id, name: o.name, quantity: o.quantity,
      freeQuantity: o.freeQuantity, price: o.price, isDefault: o.isDefault,
    })),
    recommendations: (lp.recommendations || []).map((r) => ({ id: r.id, name: r.product?.name || '', price: r.product?.basePrice ?? 0, image: r.product?.image || null })),
    currency,
  });

  // Base styles go right after the opening <head>, the seller's CSS right
  // before </head>. The seller's CSS is a seller's text, so it is spliced in
  // by a function: a replacement STRING would read `$'` in it as «the rest
  // of the document» (see injectPageStyles).
  html = injectPageStyles(html, baseStyles, customCss);

  // The frame has an opaque origin and sends no cookies, so a stored image
  // linked privately — in the seller's HTML, their CSS, or a product photo
  // placed by a marker — is public here or it is broken.
  html = toPublicMedia(html, { via: lp.id, previewToken: previewing ? previewToken ?? undefined : undefined });

  return new NextResponse(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': RAW_HTML_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    },
  });
}