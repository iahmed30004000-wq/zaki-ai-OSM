import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { logAudit } from '@/lib/audit';
import { apiErrorResponse } from '@/lib/api-error';
import { PAGE_TEMPLATES, buildTemplate } from '@/lib/page-templates';
import { parseSections } from '@/lib/landing-sections';
import { cartBarApplies, parseStoreTheme } from '@/lib/store-theme';
import { exportTemplate, importTemplate, templateDisposition } from '@/lib/store-template-file';
import { STORE_TEMPLATES } from '@/lib/store-templates';
import { publicizeMedia } from '@/lib/public-media';
import { resolveSkinPalette, skinToSections, skinToStoreTheme } from '@/lib/store-skin';
import { applyLook, designSections, homeDesign, lookTokens } from '@/lib/store-looks';
import { DESIGN_NAMES } from '@/lib/store-looks/names.generated';
import { z } from 'zod';

/**
 * GET  /api/store/templates            — the gallery, and this shop's own look
 * GET  /api/store/templates?export=1   — that look as a file
 * POST /api/store/templates            — install one, from the gallery or a file
 *
 * INSTALLING WRITES THE DRAFT, NEVER WHAT IS LIVE. A template is a starting
 * point, and a seller must be able to try one, look at it, and walk away.
 * Publishing stays the one act a customer feels.
 */

const applySchema = z.union([
  z.object({ source: z.literal('builtin'), key: z.string().trim().min(1).max(40) }),
  /**
   * A WHOLE SHOP, NOT A HOME PAGE.
   *
   * `builtin` installs one of the fifteen PAGE shapes: an order of blocks
   * for the home page. `skin` installs one of the ten SHOP templates: the
   * palette, the typeface, which arrangement each part of the engine draws
   * (header, hero, nav, card, product page, cart) and the one feature it
   * puts forward. They are different units and both are templates, so they
   * are one gallery and two sources rather than two screens.
   */
  z.object({ source: z.literal('skin'), key: z.string().trim().min(1).max(40) }),
  // One of the eighteen home designs of the owner's other platform: its
  // page as OUR blocks into the home DRAFT, its look proposed unsaved — the
  // same two halves, and the same draft rule, as installing a skin.
  z.object({ source: z.literal('design'), key: z.string().trim().min(1).max(40) }),
  z.object({ source: z.literal('file'), file: z.unknown() }),
]);

const select = {
  id: true, name: true, type: true, theme: true, homeDraft: true, themeDraft: true,
} as const;

export async function GET(req: Request) {
  try {
    const { storeId, companyId } = await requireContext();
    await requirePermission('storefront.view');

    const store = await db.store.findFirst({ where: { id: storeId!, companyId }, select });
    if (!store) return NextResponse.json({ error: 'المتجر غير موجود' }, { status: 404 });

    if (new URL(req.url).searchParams.get('export') === '1') {
      const file = exportTemplate({
        name: store.name,
        /**
         * THE CUSTOMISED ONE — «تصدير القالب المخصّص».
         *
         * The draft, because that is the template the seller is working
         * on: a seller who adjusted the colours and pressed «صدّر» before
         * publishing means the thing on their screen, not the one the shop
         * is still wearing. A shop with no draft has only the live one,
         * and then they are the same.
         *
         * The file carries the whole `storeThemeSchema`, so the
         * arrangement and which template it came from travel with the
         * colours — one schema, so a field added to the theme is a field
         * the file carries, without a line here.
         */
        theme: parseStoreTheme(store.themeDraft ?? store.theme),
        sections: parseSections(store.homeDraft),
      });
      return new NextResponse(JSON.stringify(file, null, 2), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': templateDisposition(store.name),
          'Cache-Control': 'no-store',
        },
      });
    }

    const theme = parseStoreTheme(store.theme);

    /**
     * FOUR OF THE SELLER'S OWN PRODUCTS, FOR THE PREVIEWS.
     *
     * «معاينة حاسوب وجوال مرسومة بمنتجات التاجر الحقيقية». A gallery drawn
     * with invented products shows a seller somebody else's shop: the names
     * are the wrong length, the photographs are the wrong shape, and the
     * one question they are there to answer — «does MY shop look right in
     * this?» — is the one it cannot answer.
     *
     * Four, because every card arrangement in the engine is two or four
     * across; and the cheapest columns, because a preview is a drawing and
     * not a page.
     */
    const productColumns = {
      id: true, name: true, image: true, basePrice: true,
      images: { select: { url: true }, take: 1, orderBy: { sortOrder: 'asc' } },
    } as const;

    /**
     * AND THE SHELF COMES FIRST, NOT THE CATALOGUE TABLE.
     *
     * Reported 15/10: «previews show ؟ and لا منتجات although the store
     * has published landing pages». Both were true at once, and this
     * query is why: `Product.storeId` is NULLABLE — «null only until a
     * product from before this is placed» (prisma/schema.prisma) — so a
     * shop whose goods predate per-store catalogues matched nothing here,
     * and the gallery told a shop with twelve live pages that it had no
     * products.
     *
     * What a shopper actually sees on the shelf is the product of a
     * published, shown landing page (owner's rule D2), and those pages
     * carry `storeId` themselves. So they are asked first; the store's own
     * ACTIVE products top the list up to four. Only a shop with neither
     * gets the empty state, and then it is the truth.
     */
    const shelf = await db.landingPage.findMany({
      where: {
        companyId, storeId: store.id, isPublished: true, showInStore: true,
        product: { is: { status: 'ACTIVE' } },
      },
      select: { product: { select: productColumns } },
      orderBy: { updatedAt: 'desc' },
      take: 4,
    });

    const placed = await db.product.findMany({
      where: { companyId, storeId: store.id, status: 'ACTIVE' },
      select: productColumns,
      orderBy: { createdAt: 'desc' },
      take: 4,
    });

    // One card per product: two shown pages for one product are one
    // product, exactly as the storefront's own shelf counts it.
    const seen = new Set<string>();
    const sample = [...shelf.map((p) => p.product), ...placed]
      .filter((p): p is NonNullable<typeof p> => !!p)
      .filter((p) => !seen.has(p.id) && (seen.add(p.id), true))
      .slice(0, 4);

    return NextResponse.json({
      // The gallery's cards: enough to choose by, and no page built until
      // one is asked for.
      templates: PAGE_TEMPLATES.map((t) => ({ key: t.key, label: t.label, hint: t.hint, swatch: t.swatch })),
      /**
       * The ten shop templates. They were written, validated at module
       * load and shipped, and no screen in this system could reach them —
       * a gallery of fifteen page shapes stood where a seller would look
       * for them.
       *
       * `suggestedFor` is the brief's «فلتر حسب الفئة المقترحة — للتصفح
       * فقط»: it narrows the list and nothing else. A template is not
       * refused to a shop because of what it sells.
       */
      skins: STORE_TEMPLATES.map((t) => ({
        key: t.id,
        label: t.name,
        suggestedFor: t.suggestedFor,
        feature: t.feature,
        mood: t.mood,
        // From the skin, not inferred from the mood: the corner radius is
        // `shape.corners` and nothing else decides it.
        corners: t.shape.corners,
        // The colours a card is drawn with, resolved the same way the shop
        // resolves them — so the swatch is the shop, not an approximation.
        palette: resolveSkinPalette(t),
        layout: t.layout,
        home: t.home,
      })),
      // Which one this shop is wearing, so the gallery can mark it. It is
      // matched on the arrangement and the accent rather than stored as a
      // name: a seller who customises a template is still wearing it, and
      // one who changed everything is not.
      installed: theme.template && STORE_TEMPLATES.some((t) => t.id === theme.template)
        ? theme.template
        : null,
      sample: publicizeMedia(sample).map((p) => ({
        name: p.name,
        image: p.images[0]?.url ?? p.image ?? null,
        price: p.basePrice,
      })),
      singleProduct: !cartBarApplies(store.type),
      storeName: store.name,
    });
  } catch (e) {
    return apiErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { user, storeId, companyId } = await requireContext();
    await requirePermission('storefront.manage');

    const store = await db.store.findFirst({ where: { id: storeId!, companyId }, select });
    if (!store) return NextResponse.json({ error: 'المتجر غير موجود' }, { status: 404 });
    if (!cartBarApplies(store.type)) {
      return NextResponse.json(
        { error: 'متجر Single Product واجهته صفحة الهبوط المرتبطة به — القوالب تُثبَّت من هناك', code: 'SINGLE_PRODUCT' },
        { status: 409 }
      );
    }

    const parsed = applySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'طلب غير مفهوم' }, { status: 400 });

    let theme;
    let sections;
    let label: string;

    const request = parsed.data;
    if (request.source === 'builtin') {
      const known = PAGE_TEMPLATES.find((t) => t.key === request.key);
      // buildTemplate falls back to the last template for an unknown key,
      // which would install something the seller did not pick.
      if (!known) return NextResponse.json({ error: 'قالب غير معروف' }, { status: 404 });
      const built = buildTemplate(known.key);
      // The store theme keeps everything the landing theme has no opinion
      // about — the header, the checkout, the footer's copyright — so a
      // template changes the look without emptying the shop's settings.
      theme = { ...parseStoreTheme(store.theme), ...built.theme };
      sections = built.sections;
      label = known.label;
    } else if (request.source === 'skin') {
      const skin = STORE_TEMPLATES.find((t) => t.id === request.key);
      if (!skin) return NextResponse.json({ error: 'قالب غير معروف' }, { status: 404 });
      /**
       * The same shape as a page template, for the same reason: the theme
       * is a PROPOSAL the screen holds as an unsaved change, and only the
       * draft home page is written. A seller must be able to try one of
       * the ten, look at it, and walk away.
       *
       * The shop's own settings survive. A skin says what it has an
       * opinion about — the palette, the type, the arrangement — and the
       * checkout fields, the cart bar and the footer's copyright are not
       * among them, so installing one changes the look and empties
       * nothing.
       */
      theme = { ...parseStoreTheme(store.theme), ...skinToStoreTheme(skin), template: skin.id };
      sections = skinToSections(skin);
      label = skin.name;
    } else if (request.source === 'design') {
      const plan = homeDesign(request.key);
      const look = plan ? lookTokens(plan.look) : null;
      if (!plan || !look) return NextResponse.json({ error: 'تصميم غير معروف' }, { status: 404 });
      theme = applyLook(parseStoreTheme(store.themeDraft ?? store.theme), look);
      sections = designSections(plan);
      label = DESIGN_NAMES[plan.id] ?? plan.id;
    } else {
      const imported = importTemplate(request.file);
      if (!imported.ok) return NextResponse.json({ error: imported.error, code: 'BAD_TEMPLATE' }, { status: 400 });
      theme = imported.theme;
      sections = imported.sections;
      label = imported.name || 'قالب مستورد';
    }

    await db.store.update({
      where: { id: store.id },
      // THE DRAFT, AND ONLY THE DRAFT.
      //
      // `stores.theme` is what every live storefront page and every
      // published landing page renders from, so writing it here would
      // repaint the whole shop the instant a seller pressed "try this one"
      // — while this route and the screen both told them it was a draft.
      // The template's palette is RETURNED instead, for the theme editor to
      // hold as an unsaved change the seller saves deliberately.
      data: { homeDraft: JSON.stringify(sections) },
    });

    await logAudit({
      companyId, userId: user.id, action: 'STORE_TEMPLATE_INSTALLED',
      entity: 'Store', entityId: store.id,
      newData: { source: request.source, template: label, sections: sections.length },
    });

    // `theme` is a proposal, not a saved value: the screen shows it as an
    // unsaved change. `themeApplied: false` says so out loud, so no caller
    // can read this response as "the shop is repainted".
    return NextResponse.json({ theme, sections, installed: label, themeApplied: false });
  } catch (e) {
    return apiErrorResponse(e);
  }
}
