import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { ShieldCheck, Truck, PhoneCall } from 'lucide-react';
import { db } from '@/lib/db';
import { activeOffersFor, offerEndings } from '@/lib/offers';
import { shownReviews } from '@/lib/product-reviews';
import { countdownEnd } from '@/lib/countdown';
import { ruleFor } from '@/lib/phone-rules';
import { verifyPreviewToken, clampStoredHtml } from '@/lib/landing-pages';
import { draftState } from '@/lib/landing-draft';
import { sellingCurrency } from '@/lib/selling-currency';
import OrderForm from '@/components/landing/OrderForm';
import { LandingFormBridge } from '@/components/landing/LandingFormBridge';
import { detectOrderIntent } from '@/lib/landing-dynamic';
import { BrowserVisit } from './BrowserVisit';
import { LandingTrackingPixels } from '@/components/tracking/LandingTrackingPixels';
import { getTrackingPixelsForPage } from '@/lib/tracking/tracking-config';
import { parseSections, ensureSellingCore } from '@/lib/landing-sections';
import { familyOf, trustRow } from '@/lib/selling-blocks';
import { whatsappHref } from '@/lib/store-contact';
import { sellingFacts } from '@/lib/selling-facts';
import { paletteFor, paletteVars, DEFAULT_THEME } from '@/lib/landing-theme';
import { checkoutForPage, parseStoreTheme, themeForPage, wearsShopChrome } from '@/lib/store-theme';
import { directionOf } from '@/lib/store-languages';
import { loadStoreFonts } from '@/lib/fonts/load-store-fonts';
import { PageBlocks } from '@/components/landing/blocks/PageBlocks';
import { StorefrontShell } from '@/components/storefront/StorefrontShell';
import { getStorefront } from '@/lib/storefront';
import { BLOCK_CSS_WITH_DEV_FONTS, fontHref } from '@/components/landing/blocks/styles';
import { availableStock } from '@/lib/reservation';
import { blurbOf, productPageLinks, type ShopForLinks } from '@/lib/recommendation-view';
import { deviceClassOf, recordLandingView } from '@/lib/landing-views';
import { resolveCampaign } from '@/lib/campaigns-server';
import { afterResponse } from '@/lib/notify';
import { publicizeMedia } from '@/lib/public-media';

/**
 * A LANDING PAGE, RENDERED — THE ONE RENDERER.
 *
 * Reached two ways: at /lp/<slug>, and as the front of a Single Product
 * store at /s/<store> (or the store's own domain). Both are this component,
 * so a store's front has every block, template, pixel, upsell and view
 * count a landing page has — there is no second page system to keep level.
 *
 * NO login, NO getCurrentUser(), no session cookies. Only PUBLISHED pages
 * are served; a preview token (the dashboard's, short-lived and signed) may
 * show an unpublished one to its author, and a preview is not a visit: it
 * loads no pixel and counts no view.
 *
 * Composition, for a page built from raw HTML:
 *   1. [Uploaded HTML]      → sandboxed iframe (opaque origin, untrusted)
 *   2. [Native Order Form]  → trusted React UI rendered by us, below it.
 * The iframe has sandbox="allow-scripts allow-forms allow-popups" WITHOUT
 * allow-same-origin: no session cookie, no storage, no credentialed calls.
 *
 * Analytics: one view = one successful public render. No cookies, no IPs,
 * no personal data.
 */

/**
 * The offers this page sells. They belong to the PRODUCT, so raising a
 * price in the catalogue reaches every page selling it.
 */
async function fetchOffers(companyId: string, productId: string | null, minorUnit: number) {
  if (!productId) return [];
  // The view itself: one mapping, and the struck-through price already
  // measured against real delivered orders — see price-honesty.ts.
  return activeOffersFor(db, companyId, productId, minorUnit);
}

/**
 * A page's OVERRIDE of its store's theme, or nothing.
 *
 * The store owns the look now. A page that saved no theme of its own wears
 * its store's template, which is why an absent value is `null` here rather
 * than DEFAULT_THEME — returning the house theme would have every page
 * silently overriding its store with the factory colours.
 */
function pageThemeOverride(raw: string | null | undefined): Partial<typeof DEFAULT_THEME> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function loadLpData(
  landingPageId: string,
  companyId: string,
  productId: string | null,
  minorUnit: number,
  storeId: string | null,
  shop: ShopForLinks | null
) {
  const [offers, recs] = await Promise.all([
    fetchOffers(companyId, productId, minorUnit),
    db.landingPageRecommendation.findMany({
      where: { landingPageId, isActive: true, product: { status: 'ACTIVE' } },
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true,
        blurb: true,
        product: { select: { id: true, sku: true, slug: true, name: true, basePrice: true, image: true, description: true } },
      },
    }),
  ]);
  // «وصف بسيط… او رابط بيثير الفضول لصفحة المنتج» — recommendation-view.ts.
  const links = await productPageLinks({
    companyId,
    storeId,
    exceptPageId: landingPageId,
    products: recs.flatMap((r) => (r.product ? [r.product] : [])),
    shop,
  });
  // A recommendation needs a name and a price to be an offer at all: one
  // without them read "add it to my order — 0 USD" over a blank line, at the
  // moment the customer has just trusted us with their phone number.
  const recViews = recs
    .map((r) => ({
      id: r.id,
      name: (r.product?.name || '').trim(),
      price: r.product?.basePrice ?? 0,
      image: r.product?.image || null,
      blurb: blurbOf(r.blurb, r.product?.description),
      pageUrl: (r.product && links.get(r.product.id)) || null,
    }))
    .filter((r) => r.name && r.price > 0);
  return [offers, recViews] as const;
}

const PAGE_SELECT = {
  id: true,
  name: true,
  slug: true,
  isPublished: true,
  htmlContent: true,
  builderMode: true,
  theme: true,
  sections: true,
  // `reviewMode` decides whether the reviews block shows the seller's items,
  // the buyers' ratings, or both — owner decision D8. Read here so the
  // renderer never has to ask a second question about it.
  product: { select: { id: true, name: true, basePrice: true, reviewMode: true } },
  company: { select: { id: true } },
  storeId: true,
  store: {
    select: {
      countryId: true, name: true, slug: true, logo: true, favicon: true, supportPhone: true, theme: true, language: true,
      storefrontEnabled: true, status: true, type: true, landingPageId: true,
      country: { select: { code: true, currencyCode: true, minorUnit: true } },
    },
  },
} as const;

export type LandingPageTarget = (
  /** /lp/<slug>, optionally previewed with the dashboard's token. */
  | { slug: string; previewToken?: string }
  /**
   * /lp/<slug> FROM THE CACHE (`/lp-cached/<slug>`, `landing-cache-path.ts`). Built once for every visitor, so nothing
   * here may depend on one request: no preview, no campaign, no user agent — and no server count, because the page is
   * not built per visit. The browser's count (`BrowserVisit`) is the official one for it.
   */
  | { slug: string; cached: true }
  /** A Single Product store's front: its picked page, published only. */
  | { frontPageId: string; storeId: string }
) & {
  /** The ?c= campaign code the visit arrived with, if any. */
  campaign?: string;
  /**
   * RENDERED INSIDE A SHOP SCREEN THAT HAS ALREADY DRAWN THE SHELL.
   *
   * Set by `/s/<store>/p/<handle>`, which wraps this view in its own
   * `StorefrontShell` because only that route knows the «كل المنتجات»
   * back link belongs in it. The page then draws no chrome of its own —
   * see `wearsShopChrome`.
   */
  inStore?: boolean;
};

export async function LandingPageView({ target }: { target: LandingPageTarget }) {
  let previewing = false;
  let lp = null as Awaited<ReturnType<typeof findPage>>;

  async function findPage(where: Record<string, unknown>) {
    // Oldest first: a slug shared by two companies from before slugs were
    // made unique resolves the same way here as in the order route.
    return db.landingPage.findFirst({ where, select: PAGE_SELECT, orderBy: { createdAt: 'asc' } });
  }

  if ('slug' in target) {
    if ('previewToken' in target && target.previewToken) {
      const tok = await verifyPreviewToken(target.previewToken);
      if (tok) {
        lp = await findPage({ id: tok.lpId, slug: target.slug });
        if (lp) previewing = true;
      }
    }
    if (!lp) lp = await findPage({ slug: target.slug, isPublished: true });
  } else {
    // The page must still belong to the store that shows it: a page moved or
    // re-bound elsewhere must not keep answering at this store's address.
    lp = await findPage({ id: target.frontPageId, storeId: target.storeId, isPublished: true });
  }
  if (!lp || (!previewing && !lp.isPublished)) notFound();

  /**
   * A PREVIEW SHOWS THE DRAFT. A VISIT SHOWS WHAT IS PUBLISHED.
   *
   * Once a published page could hold unpublished edits, «معاينة» became the
   * one button that had to know: a seller who saved a draft and pressed it
   * was shown the page their visitors see — the version they had just
   * changed — and would reasonably conclude the save had failed.
   *
   * Only behind a valid signed token, which is the seller in the dashboard's
   * own frame. A visitor arriving at the public address has no token and
   * reads the live columns, so nothing unpublished can leak through this.
   */
  if (previewing) {
    const { draft } = await draftState(lp.id);
    if (draft) lp = { ...lp, ...draft };
  }
  const companyId = lp.company!.id;

  const page = lp;
  /*
   * FOUR READS THAT DO NOT WAIT FOR EACH OTHER, ASKED AT ONCE.
   *
   * The offers, the country's cities, the selling currency and the page's pixels each needed only the page — and they
   * ran one after another, every round trip to the database added to the time before a shopper on a Syrian phone saw
   * anything. Same answers, same order of use; only the waiting is shared.
   */
  const [[offers, recs], regions, currency, trackingPixels] = await Promise.all([
    loadLpData(page.id, companyId, page.product?.id ?? null, page.store?.country.minorUnit ?? 2, page.storeId ?? null, page.store ?? null),
    // The cities offered and the phone format come from the country this page sells into — never a hard-coded list.
    page.store
      ? db.region
          .findMany({
            where: { countryId: page.store.countryId, isActive: true },
            select: { name: true },
            orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          })
          .then((rows) => rows.map((r) => r.name))
      : Promise.resolve([] as string[]),
    // The currency of the COUNTRY this page sells into, not of the company.
    sellingCurrency(page.store, companyId),
    // Server-resolved pixels of the page's company, re-validated before any script may load. A preview loads none: the
    // seller checking their own page is not a PageView to report to their ad account. A campaign page may belong to no
    // shop (`LandingPage.storeId` is nullable); then only company-wide pixels reach it.
    previewing
      ? Promise.resolve([] as Awaited<ReturnType<typeof getTrackingPixelsForPage>>)
      : getTrackingPixelsForPage(companyId, 'LANDING_PAGES', {
          storeId: page.storeId ?? null,
          countryId: page.store?.countryId ?? null,
        }),
  ]);
  const previewToken = previewing && 'previewToken' in target ? target.previewToken : undefined;
  const cached = 'cached' in target && target.cached === true;
  // A visitor has no session: every stored image this page shows goes out
  // through the public media route, naming this page (public-media.ts). A
  // preview is the signed-in seller in the dashboard's frame — the private
  // links work for them, and do not expire under a lazy-loaded image the way
  // a ten-minute token would.
  const forVisitors = <T,>(value: T): T => (previewing ? value : publicizeMedia(value, { via: lp.id }));
  const recommendations = forVisitors(recs);

  if (!previewing && !cached) {
    // A visit: counted once in the page's lifetime total and once in its
    // day's row (device and campaign), both after the page has gone out. A
    // link-preview crawler is not a visitor and counts in neither.
    const device = deviceClassOf((await headers()).get('user-agent'));
    if (device) {
      const page = { id: lp.id, storeId: lp.storeId ?? null };
      const code = target.campaign;
      afterResponse(async () => {
        await db.landingPage.update({ where: { id: page.id }, data: { viewsCount: { increment: 1 } } });
        const campaignId = code && page.storeId ? await resolveCampaign(companyId, page.storeId, code) : null;
        await recordLandingView({ companyId, storeId: page.storeId, landingPageId: page.id, campaignId, device });
      });
    }
  }

  const countryCode = lp.store?.country.code ?? null;

  const rawSrc = `/lp/${encodeURIComponent(lp.slug)}/raw${previewToken ? `?p=${encodeURIComponent(previewToken)}` : ''}`;
  const productName = lp.product?.name || lp.name;
  const price = lp.product?.basePrice ?? 0;

  // ── Form visibility rule ──
  //  - Legacy pages (NO data-zaki-* markers at all): the trusted OrderForm
  //    renders below the content exactly as it always did.
  //  - Behaviour-layer pages (any data-zaki-* marker): the custom HTML owns
  //    the design; the trusted form exists ONLY when the page asks for
  //    ordering (data-zaki-action="order"/"scroll-order", legacy
  //    data-zaki-order, or the optional data-zaki-order-form anchor).
  const html = clampStoredHtml(lp.htmlContent) || '';
  const usesBehaviorLayer = /data-zaki-(?:action|offer|order|position|product)/.test(html);
  const showOrderForm = usesBehaviorLayer ? detectOrderIntent(html) : true;

  const viewContent = lp.product
    ? { contentIds: [lp.product.id], contentName: lp.product.name || null, value: lp.product.basePrice ?? null, currency }
    : null;

  // A block page may carry its own `offers` block. Then THAT is the picker
  // and the form must not draw a second one.
  /*
   * THE SELLING CORE, NOT JUST THE FORM.
   *
   * `ensureForm` guaranteed the page could take an order; it did not
   * guarantee the order was REACHABLE from two screens down. A page the
   * visitor has scrolled past the form on had nothing to carry them back,
   * and the floating button is the only thing that does — which is why
   * every one of the ten structures is refused by its own contract without
   * one. See `ensureSellingCore`.
   */
  const sections = lp.builderMode === 'BLOCKS' ? forVisitors(ensureSellingCore(parseSections(lp.sections))) : [];
  const pageHasOffersBlock = sections.some((s) => s.type === 'offers' && s.enabled);
  // What the customer reads after ordering — the seller's words when the page
  // has a thank-you block, ours when it does not.
  const thanks = sections.find((s) => s.type === 'thankyou' && s.enabled);
  const thankYou = thanks && thanks.type === 'thankyou' ? { title: thanks.title, message: thanks.message } : undefined;
  // The look of the order form is the form block's choice.
  const formBlock = sections.find((s) => s.type === 'form' && s.enabled);
  const formChoices = formBlock && formBlock.type === 'form' ? formBlock : undefined;
  /*
   * WHAT THE FORM ASKS FOR IS THE STORE'S «الدفع» — «مش مربوط بصفحة الهبوط».
   *
   * The fields and their order, the «*» marks, the confirm button's words and colour, the line after the order: set
   * once on the store, on every page it sells through. Read from the store's LIVE theme — the one a visitor's page
   * is painted from — never this page's own theme (a look, with no checkout in it) and never the store's draft. A
   * preview shows the page's draft beside the store's published checkout, which is what a visitor would get.
   */
  const checkout = checkoutForPage(parseStoreTheme(lp.store?.theme));

  const orderForm = (
    <LandingFormBridge
      offers={offers.map((o) => ({ ...o }))}
      currency={currency}
      product={lp.product ? { id: lp.product.id, name: lp.product.name } : null}
    >
      <OrderForm
        slug={lp.slug}
        productName={productName}
        basePrice={price}
        currency={currency}
        offers={offers.map((o) => ({ ...o }))}
        recommendations={recommendations}
        regions={regions}
        phonePlaceholder={ruleFor(countryCode)?.example}
        // The shop's own number, for the optional confirmation button
        // on the thank-you screen. A shop with none gets no button.
        whatsapp={formChoices?.whatsappNumber?.trim() || lp.store?.supportPhone || null}
        afterOrderWhatsapp={
          formChoices
            ? {
                enabled: formChoices.whatsappAfter,
                label: formChoices.whatsappLabel,
                message: formChoices.whatsappMessage,
                autoOpen: formChoices.whatsappAutoOpen,
                when: formChoices.whatsappWhen,
                delaySeconds: formChoices.whatsappDelay,
                look: formChoices.whatsappLook,
                shape: formChoices.whatsappShape,
                wide: formChoices.whatsappWide,
                color: formChoices.whatsappColor,
                icon: formChoices.whatsappIcon,
                pulse: formChoices.whatsappPulse,
              }
            : undefined
        }
        submitLabel={formChoices?.submitLabel}
        afterOrderLook={
          formChoices
            ? {
                flow: formChoices.afterOrderFlow,
                banner: formChoices.afterOrderBanner,
                bannerText: formChoices.afterOrderBannerText,
                upsellLook: formChoices.upsellLook,
                crossSellLook: formChoices.crossSellLook,
              }
            : undefined
        }
        showOfferPicker={!pageHasOffersBlock}
        formStyle={formChoices?.formStyle}
        offerStyle={formChoices?.offerStyle}
        thankYou={thankYou}
        checkout={checkout}
      />
    </LandingFormBridge>
  );

  // ── Mode A: the block builder ──
  // Nothing on it is untrusted, because nothing on it was written as
  // markup — the seller chose blocks and filled in text.
  if (sections.length > 0) {
    // The store is the template; the page may depart from it. One place
    // decides, so a shop cannot end up with two answers to what colour it is.
    const theme = forVisitors(themeForPage(parseStoreTheme(lp.store?.theme), pageThemeOverride(lp.theme)));
    const palette = paletteFor(theme);
    // The theme's font AND every font a block chose.
    const href = fontHref(theme.font ?? DEFAULT_THEME.font, ...sections.map((b) => b.look?.text?.font));
    // The store's own uploaded faces — filtered by the page's store, never
    // by the company: a font licensed to one brand is not the next brand's.
    const objections = sections.find((s) => s.type === 'objections' && s.enabled);
    const product = lp.product;
    /*
     * FIVE READS THAT DO NOT WAIT FOR EACH OTHER, ASKED AT ONCE — the same bargain as the four above.
     *
     * The store's fonts, the stock, the ratings, the offer's ending and the trust row each need only the page and its
     * blocks; they ran one after another, five round trips to the database before a shopper saw anything. Same
     * questions, same «asked only when the page has the block» rule, same fallbacks; only the waiting is shared.
     *
     *   · The store's own uploaded faces — filtered by the page's store, never by the company: a font licensed to one
     *     brand is not the next brand's.
     *   · Real stock of THIS store, for the one block allowed to mention it. Unknown stays unknown: the block renders
     *     nothing rather than inventing.
     *   · THE BUYERS' OWN RATINGS, AND THE OFFER'S OWN ENDING — owner decision D8, both READ FROM THE SERVER rather
     *     than stored in a block. A rating copied into a page would be wrong the moment a moderator hid it; an end
     *     date copied into a page would be a second source of truth for when the price stops. Asked only when the
     *     page actually has the block that uses it.
     *   · THE SELLING BLOCKS' FACTS — «صف ثقة (دفع عند الاستلام · مدّة التوصيل · إرجاع/ضمان فقط إذا البائع حدّده)».
     *     Resolved HERE, where the shop is known, and handed to the renderer as sentences — so the renderer has no way
     *     to invent one. The guarantee comes from the page's own objections block: the seller's words about their own
     *     guarantee beat a link to a policy page.
     */
    const [storeFonts, stock, reviews, offerEndsAt, facts] = await Promise.all([
      loadStoreFonts(lp.storeId),
      product
        ? availableStock(db, companyId, product.id, undefined, lp.storeId).catch(() => null)
        : Promise.resolve(null as number | null),
      product && sections.some((s) => s.type === 'reviews' && s.enabled)
        ? shownReviews({ companyId, productId: product.id, reviewMode: product.reviewMode }).catch(() => null)
        : Promise.resolve(null as Awaited<ReturnType<typeof shownReviews>> | null),
      product && sections.some((s) => s.type === 'urgency' && s.enabled && s.countdown === 'offer')
        ? offerEndings(db, companyId, { productId: product.id })
            .catch(() => [])
            .then((endsAt) => countdownEnd({ endsAt, now: new Date() })?.toISOString() ?? null)
        : Promise.resolve(null as string | null),
      sellingFacts({
        companyId,
        storeId: lp.storeId ?? null,
        storeSlug: lp.store?.slug ?? null,
        guarantee: objections && objections.type === 'objections' ? objections.guarantee : null,
      }),
    ]);
    // The look, derived from the template the seller chose — never stored
    // beside it. `familyOf` says why at length.
    const family = familyOf(parseStoreTheme(lp.store?.theme).template);

    const body = (
      <>
        {href && <link rel="stylesheet" href={href} />}
        <style dangerouslySetInnerHTML={{ __html: BLOCK_CSS_WITH_DEV_FONTS }} />
        {storeFonts.css && <style dangerouslySetInnerHTML={{ __html: storeFonts.css }} />}
        <LandingTrackingPixels pixels={trackingPixels} viewContent={viewContent} />
        {!previewing && <BrowserVisit pageId={lp.id} official={cached} />}
        {/*
          ONE ATTRIBUTE IS THE WHOLE FAMILY, AND IT IS WHY THIS IS A WRAPPER
          AND NOT A CLASS ON EACH BLOCK.

          A family is a LOOK: type rhythm, weight, colour emphasis, the
          ornament a section header may carry. Every rule that implements
          one is scoped to this attribute, so the blocks themselves carry no
          family-specific markup — which is the property that keeps the
          promise «المظهر لا يغيّر ترتيب شي رتّبه إنسان». A look that needed
          its own element order would be a look that moves the seller's
          blocks, and there is nowhere here for it to do that from.

          A wrapper rather than the root, because the root is the shop's
          shell when this page IS a shop's front, and the shell belongs to
          the storefront. One element, both paths, no second owner.
        */}
        <div className="lp-family" data-family={family}>
          <PageBlocks
            sections={sections}
            ctx={{
              palette, productName, price, currency, stock, offers, form: orderForm, family,
              // The country's own decimals. Absent read as two, so a currency
              // with three places was printed with none — on the first screen
              // of the page that sells it, and in the offer cards under it.
              minorUnit: lp.store?.country.minorUnit ?? 2,
              trust: trustRow(facts), reviews, offerEndsAt,
              whatsapp: whatsappHref(lp.store?.supportPhone),
              store: lp.store ? { name: lp.store.name, logo: lp.store.logo, phone: lp.store.supportPhone } : null,
            }}
          />
        </div>
      </>
    );

    /**
     * THE SHOP'S OWN HEADER, ON THE PAGE THAT IS THE SHOP.
     *
     * A Single Product store's address renders THIS page, and it rendered
     * bare: no logo, no shop name, no header, no footer, no menus. The
     * seller set all of it under «القوالب» and «البلدان والمتاجر» and none
     * of it ever appeared, which is why the store section read as dead.
     *
     * Only when this page is being served AS a store's front — a landing
     * page opened at /lp/… is an advert of its own and keeps its own
     * clothes. `getStorefront` is React-cached and the store route already
     * called it this request, so the wrap costs no query.
     *
     * The page's own footer block wins over the shop's: two footers is the
     * duplication this whole section exists to avoid.
     */
    // The switch belongs to the STORE's template, not to the page's own
    // palette: `theme` here has already been narrowed to what a landing
    // page may override, and the shop's chrome is never one of those.
    //
    // One function decides it, in `store-theme.ts`, because the question
    // «who draws the header» now has three answers and a condition spelled
    // out at the one call site cannot be tested without a database.
    const wearsChrome = wearsShopChrome({
      asFront: 'frontPageId' in target,
      inStore: target.inStore === true,
      hasSlug: !!lp.store?.slug,
      theme: parseStoreTheme(lp.store?.theme),
    });
    const shop = wearsChrome ? await getStorefront(lp.store!.slug) : null;
    if (shop) {
      return (
        <StorefrontShell store={shop} footer={!sections.some((s) => s.type === 'footer')}>
          {body}
        </StorefrontShell>
      );
    }

    return (
      // Its store's language and direction, not a hard-coded rtl: a page
      // selling in English was being mirrored.
      <div
        dir={directionOf(lp.store?.language)}
        lang={lp.store?.language ?? 'ar'}
        className="lp-root"
        style={paletteVars(palette) as React.CSSProperties}
      >
        {body}
      </div>
    );
  }

  // ── Mode B: raw HTML ──
  return (
    <div dir="rtl" className="flex min-h-screen flex-col bg-[#f7f7f8]">
      <LandingTrackingPixels pixels={trackingPixels} viewContent={viewContent} />
      {!previewing && <BrowserVisit pageId={lp.id} official={cached} />}
      <iframe
        src={rawSrc}
        title={lp.name}
        sandbox="allow-scripts allow-forms allow-popups"
        className="w-full border-none"
        style={{ height: '70vh', minHeight: 480, display: 'block' }}
      />
      {showOrderForm && orderForm}
      <footer className="border-t border-[#e3e8ef] bg-white px-4 py-8">
        <div className="mx-auto flex max-w-md flex-col items-center gap-4 text-center sm:flex-row sm:justify-center sm:gap-8">
          <span className="flex items-center gap-2 text-xs font-medium text-[#364152]">
            <ShieldCheck className="h-4 w-4 text-[#00c853]" /> طلب آمن
          </span>
          <span className="flex items-center gap-2 text-xs font-medium text-[#364152]">
            <Truck className="h-4 w-4 text-[#b8256e]" /> توصيل سريع
          </span>
          <span className="flex items-center gap-2 text-xs font-medium text-[#364152]">
            <PhoneCall className="h-4 w-4 text-[#3e97ff]" /> دعم متواصل
          </span>
        </div>
        <p className="mt-4 text-center text-[11px] text-[#9aa4b2]">جميع الحقوق محفوظة</p>
      </footer>
    </div>
  );
}
