import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from './guard-source';
import { UNCATEGORISED_LABEL } from '@/components/ui/ProductPicker';
import { ALL_ROUTES, NAV } from './route-registry';
import { OLD_STORE_ROUTES, STORE_TABS } from './store-admin';
import { PAGE_TEMPLATES, buildTemplate } from './page-templates';

/**
 * A TEMPLATE IS SHOWN, NOT DESCRIBED — AND BESIDE THE SHOP IT DRESSES.
 *
 * Both galleries offered a coloured square, a name and one sentence.
 * Fifteen sentences is not a choice anybody can make, so people took the
 * first one and fourteen shapes existed for nobody. And the two screens
 * that decide how a Single Product shop looks — its front page and its
 * landing pages — sat under «النمو» while its design, templates, logo and
 * icon sat under «واجهة المتجر».
 *
 * These guards hold what is easy to lose again:
 *
 *   • the preview is drawn by the renderer that draws the real page, so it
 *     cannot promise a shape the seller will not get;
 *   • one gallery, used by both screens, so a template cannot be missing
 *     from one of them;
 *   • the frames that stand in for photographs appear in a PREVIEW only —
 *     a grey box on a customer's screen is worse than nothing;
 *   • and the shop's screens are in the shop's tab.
 */

describe('the template gallery shows the template', () => {
  it('and draws it with the renderer the published page uses', () => {
    const preview = stripComments(repoFile('src/components/landing/TemplatePreview.tsx'));
    // The same component, not a picture and not a second renderer.
    expect(preview, 'المعاينة لا تستعمل مُصيّر الصفحة نفسه').toMatch(/<PageBlocks\b/);
    expect(preview).toMatch(/from '@\/components\/landing\/blocks\/PageBlocks'/);
    // And the same palette derivation, or its colours would be a guess.
    expect(preview).toMatch(/paletteVars\(palette\)/);
    // It must never take an order: the form is a stand-in.
    expect(preview, 'المعاينة تعرض نموذج طلب حقيقي').toMatch(/form: <FormPlaceholder/);
    expect(preview).not.toMatch(/OrderForm/);
  });

  it('and shows the seller’s own product in it', () => {
    const preview = stripComments(repoFile('src/components/landing/TemplatePreview.tsx'));
    expect(preview).toMatch(/productName: product\?\.name/);
    expect(preview).toMatch(/price: product\?\.price/);

    // The product is picked BEFORE the templates are shown — otherwise
    // every preview advertises «منتجك» and answers nothing. The create
    // dialog's code moved to the wizard on 3/11; the rule did not.
    const screen = stripComments(repoFile('src/components/landing-flow/CreateWizard.tsx'));
    const productAt = screen.indexOf('<ProductPicker');
    const galleryAt = screen.indexOf('<TemplateGallery');
    expect(productAt).toBeGreaterThan(-1);
    expect(galleryAt).toBeGreaterThan(-1);
    expect(productAt, 'القالب يُختار قبل المنتج').toBeLessThan(galleryAt);
    expect(screen).toMatch(/product=\{chosenProduct\}/);
  });

  it('and the products are offered under their categories', () => {
    /**
     * SAME RULE, DIFFERENT MARKUP.
     *
     * This asked for `<optgroup>`, which was how a native `<select>` drew
     * the headings. The field is now `ProductPicker` — searchable, because
     * 114 products in any kind of list is a scroll — and it draws the same
     * headings itself while nothing has been typed.
     *
     * The INTENT is unchanged and is what is asserted: the catalogue is
     * offered under its categories, and the products with no category are
     * a bucket that says so rather than a silent scattering. The headings
     * themselves are proved in ProductPicker.test.tsx, where they render;
     * `UNCATEGORISED_LABEL` is imported rather than retyped so the bucket
     * cannot be renamed out from under this test.
     */
    const screen = stripComments(repoFile('src/components/landing-flow/CreateWizard.tsx'));
    expect(screen, 'لا تجميع حسب التصنيف').toMatch(/groupByCategory/);
    expect(screen).toMatch(/<ProductPicker/);

    const picker = stripComments(repoFile('src/components/ui/ProductPicker.tsx'));
    expect(picker, 'المجمِّع اختفى من المنتقي').toMatch(/export function groupProducts/);
    expect(picker).toContain(UNCATEGORISED_LABEL);
  });

  /**
   * ONE GRID. Two galleries of the same fifteen templates is two places
   * for one of them to be missing, and the store's was a swatch list while
   * the page's had previews.
   */
  it('and both screens use the one gallery', () => {
    for (const file of [
      'src/components/landing-flow/CreateWizard.tsx',
      'src/components/screens/StoreThemeScreen.tsx',
    ]) {
      const src = stripComments(repoFile(file));
      expect(src, `${file} لا يستعمل المعرض المشترك`).toMatch(/<TemplateGallery/);
      // Neither may keep hand-rolling the fifteen cards beside it.
      expect(src, `${file} ما زال يرسم القوالب بنفسه`).not.toMatch(/PAGE_TEMPLATES\.map/);
    }
  });

  it('and every template it offers can actually be built', () => {
    expect(PAGE_TEMPLATES.length).toBeGreaterThan(1);
    for (const t of PAGE_TEMPLATES) {
      const built = buildTemplate(t.key);
      expect(built.sections.length, `${t.key} بلا أقسام`).toBeGreaterThan(0);
      expect(built.theme.accent, `${t.key} بلا لون`).toBeTruthy();
    }
  });

  /**
   * THE FRAMES ARE FOR THE PREVIEW ONLY.
   *
   * A template carries no photographs — it cannot, an uploaded image
   * belongs to the company that uploaded it — so the gallery draws where
   * they go. The published page must keep rendering nothing: an empty
   * block there is one the seller has not filled yet.
   */
  it('and the image frames never reach a customer', () => {
    const blocks = stripComments(repoFile('src/components/landing/blocks/PageBlocks.tsx'));
    // Every frame is behind the flag…
    const frames = blocks.match(/<ImageFrame/g) ?? [];
    expect(frames.length).toBeGreaterThan(0);
    expect(blocks).toMatch(/ctx\.placeholders && <ImageFrame/);
    expect(blocks).toMatch(/if \(!ctx\.placeholders\) return null;/);
    // …and only the gallery's preview sets it.
    expect(stripComments(repoFile('src/components/landing/TemplatePreview.tsx'))).toMatch(
      /placeholders: true/
    );
    for (const file of ['src/components/landing/LandingPageView.tsx', 'src/app/s/[store]/page.tsx']) {
      expect(stripComments(repoFile(file)), `${file} يرسم إطارات على صفحة الزبون`).not.toMatch(
        /placeholders/
      );
    }
  });
});

/**
 * NOTHING WE SHIP INVENTS A CUSTOMER.
 *
 * Five templates open a reviews block. The temptation, when the preview
 * looked thin, was to fill it with example testimonials — and a seller who
 * published without editing them would be showing a customer's words that
 * no customer said. The block is shown as an empty frame that says whose
 * job it is, and the template file carries no review text at all.
 */
describe('no template ships a testimonial', () => {
  it('the reviews blocks are empty in every template', () => {
    for (const t of PAGE_TEMPLATES) {
      for (const section of buildTemplate(t.key).sections) {
        if (section.type !== 'reviews') continue;
        for (const item of section.items) {
          expect(item.text.trim(), `${t.key} يحمل رأيَ عميلٍ مُختلَقاً`).toBe('');
          expect(item.name.trim(), `${t.key} يحمل اسمَ عميلٍ مُختلَقاً`).toBe('');
        }
      }
    }
  });

  it('and the empty frame is a preview-only thing', () => {
    const blocks = stripComments(repoFile('src/components/landing/blocks/PageBlocks.tsx'));
    // Both empty sections are behind the flag, like the image frames.
    const guarded = blocks.match(/if \(!ctx\.placeholders\) return null;/g) ?? [];
    expect(guarded.length, 'قسمٌ فارغ يُرسم على صفحة الزبون').toBeGreaterThanOrEqual(3);
    expect(blocks).toMatch(/<SlotFrame label="[^"]*آراء العملاء/);
    expect(blocks).toMatch(/<SlotFrame label="[^"]*الأسئلة الشائعة/);
  });
});

describe('the shop’s screens are in the shop’s tab', () => {
  it('the front page and the landing pages sit with the design', () => {
    const storefront = NAV.find((g) => g.key === 'storefront')!;
    const paths = storefront.routes.map((r) => r.path);
    expect(paths).toContain('/store');
    expect(paths).toContain('/store/landing-pages');
    // The shop comes before the things that dress it. The old
    // single-product address redirects to /store permanently instead of
    // living on as a second entry for the same thing.
    expect(paths).not.toContain('/store/single-product');
    expect(paths.indexOf('/store')).toBe(0);

    /*
     * AND THE THINGS THAT DRESS IT ARE NOT MENU ENTRIES ANY MORE.
     *
     * This line used to read «/store comes before /store/design», which
     * was the right rule for a group of ten. The eight are the three tabs
     * of `/store` now, so the rule is stronger: nothing in this group is
     * an eighth of a shop.
     */
    for (const moved of Object.keys(OLD_STORE_ROUTES)) {
      expect(paths, `${moved} ما زال مدخلاً في القائمة`).not.toContain(moved);
      expect(ALL_ROUTES.map((r) => r.path), `${moved} ما زال في العقد`).not.toContain(moved);
    }

    const growth = NAV.find((g) => g.key === 'growth')!;
    for (const gone of ['/growth/landing-pages', '/growth/single-product-stores']) {
      expect(growth.routes.map((r) => r.path), `${gone} ما زال في النمو`).not.toContain(gone);
    }
    // And nothing anywhere still answers on the old addresses.
    expect(ALL_ROUTES.map((r) => r.path)).not.toContain('/growth/landing-pages');
  });

  it('and two menu entries do not both read «الصفحات»', () => {
    const labels = NAV.flatMap((g) => g.routes.map((r) => r.label));
    expect(new Set(labels).size, 'مدخلان بالاسم نفسه').toBe(labels.length);
    /*
     * The policy pages are a SECTION now, not an entry, and the rule
     * applies to the sections too: «الصفحات» alone would be the same
     * word the landing pages wear, inside a shop that has both.
     */
    const pages = STORE_TABS.flatMap((t) => t.sections).find((x) => x.key === 'pages')!;
    expect(pages.label).not.toBe('الصفحات');
    const sectionLabels = STORE_TABS.flatMap((t) => t.sections).map((x) => x.label);
    expect(new Set(sectionLabels).size, 'قسمان بالاسم نفسه').toBe(sectionLabels.length);
  });

  it('and the store card reaches its design, templates and icon', () => {
    const src = stripComments(repoFile('src/components/screens/StoresScreen.tsx'));
    // The addresses are BUILT, not spelled: one map of tabs, so a card
    // cannot link to a panel that was renamed out from under it.
    for (const target of ["storeTabHref('front', 'home')", "storeTabHref('front', 'look')"]) {
      expect(src, `البطاقة لا تصل إلى ${target}`).toContain(target);
    }
    // The logo and the icon have one editor; this links to it rather than
    // growing a second copy of the fields.
    expect(src).toMatch(/الشعار والأيقونة/);
    expect(src, 'البطاقة تحرّر الشعار بنفسها').not.toMatch(/type="file"/);
  });

  /**
   * AND NONE OF THOSE IS A DEAD END.
   *
   * «صمّم الواجهة» used to be replaced, on every store that was not the
   * selected one, by a sentence telling the seller to go up to the header,
   * switch store, and come back — which was reported, correctly, as the
   * button not working. The card knows which store it is, so it switches
   * on the way instead of asking.
   */
  it('and every one of them opens, from whichever store you are standing in', () => {
    const src = stripComments(repoFile('src/components/screens/StoresScreen.tsx'));
    // …only when standing somewhere else, and it is the same call the
    // header's switcher makes, carrying THIS card's store…
    expect(src, 'لا شرط على المتجر الحالي').toMatch(/if \(!shop\.current\) \{/);
    expect(src, 'التبديل لا يحمل هذا المتجر').toMatch(
      /fetch\('\/api\/context'[\s\S]{0,240}storeId: shop\.id/
    );
    // …a full navigation, because the selection is read server-side…
    expect(src).toMatch(/window\.location\.href = href/);
    // …and the screens are opened through it, not with a bare link.
    expect(src, 'صفحات الهبوط تُفتح برابطٍ لا يبدّل المتجر').toContain(
      "onOpen('/store/landing-pages'"
    );
    for (const target of ["onOpen(storeTabHref('front'))", "onOpen(storeTabHref('front', 'home'))", "onOpen(storeTabHref('front', 'look'))"]) {
      expect(src, `${target} يُفتح برابطٍ لا يبدّل المتجر`).toContain(target);
    }
    // No screen sends somebody away to do something first.
    expect(src, 'ما زالت البطاقة تطلب التبديل يدوياً').not.toMatch(/بدّل إلى هذا المتجر من الأعلى/);
  });
});
