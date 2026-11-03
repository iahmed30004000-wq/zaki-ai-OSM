import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from './guard-source';
import { ALL_ROUTES, NAV } from './route-registry';
import {
  OLD_STORE_ROUTES, STORE_TABS, canOpenSection, canOpenTab, findTab, openSections, readSection,
  storeTabHref,
} from './store-admin';
import type { SessionUser } from '@/types/auth';

/**
 * TEN MENU ENTRIES FOR ONE SHOP BECAME TWO, AND NOTHING WAS LOST.
 *
 * The owner's complaint, in his own words: «معجّق، كلام فوق بعضه، داتا
 * مكدّسة، بتضيع». `docs/storefront/AUDIT.md` §6 counted it — 89
 * paragraphs, 60 long sentences and 72 buttons across ten storefront
 * screens, and not one of them marking its primary action.
 *
 * What this file holds is the shape that replaced it, and every way the
 * shape could quietly come undone:
 *
 *   • the menu group is TWO entries — المتجر · صفحات الهبوط;
 *   • each of the eight old addresses redirects, permanently, to a panel
 *     that actually exists;
 *   • every panel has a title, ONE line and exactly ONE primary action,
 *     and its explanation is behind a ⓘ that starts closed;
 *   • no paragraph a seller meets on arrival runs past two lines;
 *   • and a tab is refused in the SERVICE layer, not hidden in the strip
 *     — with a negative test for every one of them.
 *
 * It also pins the four things the owner reported on 15/10 01:33, because
 * each of them is a one-line change away from coming back.
 */

/* ════════════════ 1 · THE MENU ════════════════ */

describe('the shop is two menu entries', () => {
  const group = () => NAV.find((g) => g.key === 'storefront')!;

  it('and they are المتجر and صفحات الهبوط, in that order', () => {
    /**
     * TWO AND NOT THREE.
     *
     * §7.1 of the audit proposed three entries and §10 corrected itself
     * in writing: «منصّة التجريب stays under النمو — the storefront group
     * is المتجر + صفحات الهبوط, two entries, not three.» The task's title
     * still says «3 مداخل», which is the older number; this follows the
     * correction, and the bench is asserted below to be where it was
     * left.
     */
    expect(group().routes.map((r) => r.path), 'مداخل القائمة مش اتنين').toEqual([
      '/store',
      '/store/landing-pages',
    ]);
  });

  it('and the nine that dressed the shop are no longer screens of their own', () => {
    const paths = ALL_ROUTES.map((r) => r.path);
    for (const moved of Object.keys(OLD_STORE_ROUTES)) {
      expect(paths, `${moved} ما زال مدخلاً في العقد`).not.toContain(moved);
    }
    /*
     * NINE, AND IT WAS EIGHT WHEN THIS WAS WRITTEN.
     *
     * «الآراء» (`/store/reviews`, owner decision D8) landed on main while
     * this task was being built, as a third entry in the group — and its
     * own comment in the registry gave the reason it belongs in «المحتوى»:
     * «this is about what the shop SAYS». So it moved with the other
     * eight, and this number is the count of what moved, not a constant.
     * A tenth appearing without a redirect beside it is a screen nobody
     * can reach, which is what the describe above this one holds.
     */
    expect(Object.keys(OLD_STORE_ROUTES)).toHaveLength(9);
  });

  it('and «منصّة التجريب» did not move into the shop', () => {
    const growth = NAV.find((g) => g.key === 'growth')!;
    expect(growth.routes.map((r) => r.path)).toContain('/growth/bench');
    expect(group().routes.map((r) => r.path)).not.toContain('/growth/bench');
  });

  it('and every section of every tab is a real panel', () => {
    const screens = stripComments(repoFile('src/components/store-admin/StoreAdminScreen.tsx'));
    for (const tab of STORE_TABS) {
      expect(tab.sections.length, `${tab.key} بلا أقسام`).toBeGreaterThan(0);
      for (const section of tab.sections) {
        expect(screens, `${tab.key}/${section.key} ما في لوح يرسمه`).toContain(
          `'${tab.key}/${section.key}': () =>`
        );
      }
    }
  });
});

/* ════════════════ 2 · THE EIGHT OLD ADDRESSES ════════════════ */

describe('no old storefront address answers 404', () => {
  const config = stripComments(repoFile('next.config.ts'));

  it('every one of the nine redirects permanently to its own panel', () => {
    for (const [old, target] of Object.entries(OLD_STORE_ROUTES)) {
      const want = storeTabHref(target.tab, target.section);
      /*
       * The destination is BUILT from the same map the shell reads, so a
       * tab renamed in `store-admin.ts` fails here rather than leaving a
       * redirect pointing at a panel that no longer exists. Next cannot
       * import that module — this file is read by the config loader at
       * build time — so the two lists are held in step by this guard
       * instead, which is what the comment beside the redirects says.
       */
      expect(
        config,
        `${old} ما بيحوّل على ${want}`
      ).toContain(`{ source: '${old}', destination: '${want}', permanent: true }`);
    }
  });

  it('and nothing is still mounted on them, so the redirect is the only answer', () => {
    // A page left behind would be dead code the redirect hides — and the
    // day somebody removes the redirect, a screen outside the registry
    // starts answering again.
    for (const old of Object.keys(OLD_STORE_ROUTES)) {
      const dir = `src/app/(system)/(shell)${old}/page.tsx`;
      expect(() => repoFile(dir), `${dir} ما زال موجوداً`).toThrow();
    }
  });

  it('and the single-product address still goes to the shop list', () => {
    expect(config).toContain(
      "{ source: '/store/single-product', destination: '/store', permanent: true }"
    );
  });

  it('and a stale section in an old bookmark opens the tab, never a blank panel', () => {
    const tab = findTab('content')!;
    // «/store?tab=content&sec=whatever-this-used-to-be»
    expect(readSection(tab, 'a-section-that-was-retired').key).toBe(tab.sections[0].key);
    expect(readSection(tab, undefined).key).toBe(tab.sections[0].key);
    // And a tab that does not exist is not a tab: the page shows the list.
    expect(findTab('nope')).toBeUndefined();
    expect(findTab(undefined)).toBeUndefined();
  });
});

/* ════════════════ 3 · ONE SCREEN, ONE PRIMARY ACTION ════════════════ */

/** The nine panels of `/store`, as the shell draws them. */
const PANELS = [
  'src/components/screens/StoresScreen.tsx',
  'src/components/screens/StoreDesignScreen.tsx',
  'src/components/screens/StoreThemeScreen.tsx',
  'src/components/screens/StorePagesScreen.tsx',
  'src/components/screens/StoreMenusScreen.tsx',
  'src/components/screens/StoreSearchScreen.tsx',
  'src/components/screens/StoreLanguagesScreen.tsx',
  'src/components/screens/StoreDomainScreen.tsx',
  'src/components/screens/StoreRoutesScreen.tsx',
];

/** Character ranges of every `help={ … }` value in a file. */
function helpSpans(src: string): [number, number][] {
  const spans: [number, number][] = [];
  const re = /\bhelp=\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 0;
    // The `{` that opens the value — `help={` ends on it.
    for (let i = m.index + m[0].length - 1; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) {
        spans.push([m.index, i]);
        break;
      }
    }
  }
  return spans;
}

describe('every panel says what it is and offers one thing to do', () => {
  it('each of the nine renders PanelHeader with exactly one primary action', () => {
    for (const file of PANELS) {
      const src = stripComments(repoFile(file));
      expect(src, `${file} ما بيستعمل رأس اللوح`).toContain('<PanelHeader');
      /*
       * EXACTLY ONE. `PageHeader`'s `actions` is a ReactNode, so «one
       * primary» there is something a reviewer counts by eye — and the
       * audit found seventy-two buttons across these screens with not one
       * of them marked. `primary` is a single slot and `secondary` holds
       * the rest, so this is countable.
       */
      const primaries = src.match(/\bprimary=\{/g) ?? [];
      expect(primaries.length, `${file}: ${primaries.length} فعل أساسي بدل واحد`).toBe(1);
      // And the name and the line are not optional on any of them.
      expect(src, `${file} بلا عنوان`).toMatch(/\btitle=[{"]/);
      expect(src, `${file} بلا سطر واحد يشرحه`).toMatch(/\bline=[{"]/);
    }
  });

  it('and the header puts the title first, the line under it, and the help shut', () => {
    const header = stripComments(repoFile('src/components/store-admin/PanelHeader.tsx'));
    // The h1 the acceptance guard looks for.
    expect(header).toMatch(/<h1[^>]*>\{title\}<\/h1>/);
    // Closed by default: `useState(false)`, and the panel is rendered only
    // when it is open.
    expect(header, 'الشرح مفتوح افتراضياً').toMatch(/useState\(false\)/);
    expect(header).toMatch(/\{open && help && \(/);
    // A disclosure a screen reader can use, not a bare icon.
    expect(header).toMatch(/aria-expanded=\{open\}/);
    expect(header).toMatch(/aria-controls=\{helpId\}/);
    // 44px of target on a phone, as the task is held to.
    expect(header, 'زر الشرح أصغر من 44 بكسل').toMatch(/h-11 w-11/);
  });

  it('and no paragraph a seller meets on arrival runs past two lines', () => {
    /**
     * TWO LINES, MEASURED IN CHARACTERS.
     *
     * At 390px a card's text column is about 340px, and 12px Arabic runs
     * roughly 55 characters to the line — so two lines is about 110, and
     * 130 is that with room for a word. Help text is exempt because it is
     * BEHIND the ⓘ: it is read once, deliberately, and it is the place
     * every long paragraph on these screens was moved to.
     */
    const LIMIT = 130;
    const offenders: string[] = [];
    for (const file of PANELS) {
      const src = stripComments(repoFile(file));
      const spans = helpSpans(src);
      for (const m of src.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)) {
        const at = m.index ?? 0;
        if (spans.some(([a, b]) => at >= a && at <= b)) continue;
        const text = m[1]
          .replace(/\{[^{}]*\}/g, '')
          .replace(/<[^>]*>/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        if (text.length > LIMIT) offenders.push(`${file}: ${text.length} > ${LIMIT} — ${text.slice(0, 60)}`);
      }
    }
    expect(offenders, `فقرةٌ أطولُ من سطرين في بطاقة:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('and the «عم تعدّل» bar is on every tab, because it is on the layout', () => {
    // One bar for all three tabs: the layout mounts it, so no panel
    // carries a copy and no tab can be the one that forgets it.
    const layout = stripComments(repoFile('src/app/(system)/(shell)/store/layout.tsx'));
    expect(layout).toContain('<EditingStoreBar');
    for (const file of PANELS) {
      expect(stripComments(repoFile(file)), `${file} يحمل نسخة ثانية من الشريط`).not.toContain(
        '<EditingStoreBar'
      );
    }
  });
});

/* ════════════════ 4 · WHO MAY OPEN A TAB ════════════════ */

/**
 * The client's own check, which is also the shape the server's `can` has.
 * Written out rather than imported so this file needs no database double:
 * what is under test is `store-admin.ts`'s rule, not authorization.ts's.
 */
const can = (u: SessionUser, p: string) =>
  u.role === 'SUPER_ADMIN' || (u.permissions ?? []).includes(p);

const userWith = (permissions: string[], status = 'ACTIVE') =>
  ({ id: 'u1', role: 'MODERATOR', status, permissions } as unknown as SessionUser);

describe('a tab is refused in the service layer, not hidden in the strip', () => {
  it('the page asks before it renders, and 403s rather than drawing a dead panel', () => {
    const page = stripComments(repoFile('src/app/(system)/(shell)/store/page.tsx'));
    // The registry's guard for `/store` itself…
    expect(page).toContain("guardRoute('/store')");
    // …then the panel's own permission, on the SERVER, with the server's
    // own `can` — not the client's.
    expect(page).toContain("from '@/lib/authorization'");
    expect(page).toMatch(/if \(!canOpenTab\(user, tab, can\)\) forbidden\(\);/);
    expect(page).toMatch(/if \(!canOpenSection\(user, section, can\)\) forbidden\(\);/);
    // And the strip is drawn from the same answer, so nobody is offered a
    // door that would slam.
    expect(page).toMatch(/openSections\(user, t, can\)/);
  });

  /**
   * THE NEGATIVE THAT MADE THIS NECESSARY.
   *
   * `/store` opens for `geo.manage` as well — the person who decides
   * which shops EXIST. None of the eight panels is his, and every API
   * behind them asks for `storefront.*`. Without this rule he would have
   * been handed three tabs and eight panels of refused requests.
   */
  it('geo.manage opens the shop list and not one tab of it', () => {
    const geo = userWith(['geo.manage', 'geo.view']);
    for (const tab of STORE_TABS) {
      expect(canOpenTab(geo, tab, can), `${tab.key} مفتوح لـgeo.manage`).toBe(false);
      for (const section of tab.sections) {
        expect(canOpenSection(geo, section, can), `${tab.key}/${section.key} مفتوح له`).toBe(false);
      }
      expect(openSections(geo, tab, can)).toEqual([]);
    }
  });

  it('and landing_pages.view alone opens no tab either', () => {
    const pages = userWith(['landing_pages.view']);
    for (const tab of STORE_TABS) {
      expect(canOpenTab(pages, tab, can), `${tab.key} مفتوح بصلاحية صفحات الهبوط`).toBe(false);
    }
  });

  it('and storefront.view opens all three, because every panel reads with it', () => {
    const viewer = userWith(['storefront.view']);
    for (const tab of STORE_TABS) {
      expect(canOpenTab(viewer, tab, can), `${tab.key} مغلق على storefront.view`).toBe(true);
      expect(openSections(viewer, tab, can)).toHaveLength(tab.sections.length);
    }
  });

  /**
   * AND THE ADDRESS KEEPS ITS OWN KEY.
   *
   * `storefront.domain` is the one permission here that is not
   * `storefront.manage`: moving a shop's host is the single act on these
   * screens that can take the shop off the internet. The merge must not
   * have quietly handed it to everyone who can paint a header.
   */
  it('and the domain panel still asks for storefront.domain, not storefront.manage', () => {
    const domain = STORE_TABS.find((t) => t.key === 'address')!.sections.find((s) => s.key === 'domain')!;
    expect(domain.permissions).toContain('storefront.domain');
    expect(domain.permissions).not.toContain('storefront.manage');
    // The route behind it asks the same thing for every write.
    const route = stripComments(repoFile('src/app/api/store/domain/route.ts'));
    expect(route).toMatch(/requirePermission\('storefront\.domain'\)/);
  });

  it('and a suspended account opens nothing at all', () => {
    const suspended = userWith(['storefront.view', 'storefront.manage'], 'SUSPENDED');
    for (const tab of STORE_TABS) {
      expect(canOpenTab(suspended, tab, can), `${tab.key} مفتوح لحسابٍ موقوف`).toBe(false);
    }
  });
});

/* ════════════════ 5 · THE OWNER'S FOUR, 15/10 01:33 ════════════════ */

describe('the four things the owner found on the templates screen', () => {
  it('the yellow «اطلب الآن» bar cannot leave its preview any more', () => {
    /**
     * `.lp-sticky` is `position: fixed`, so it anchored to the browser
     * window and floated under the whole screen, below every card,
     * belonging to none of them. `overflow: hidden` could never catch it
     * — a fixed element is laid out against its nearest CONTAINING
     * BLOCK, and overflow does not make one. Paint containment does.
     */
    const preview = stripComments(repoFile('src/components/landing/TemplatePreview.tsx'));
    expect(preview, 'المعاينة ما بتحجز العناصر الثابتة جوّاها').toMatch(/contain: 'paint'/);
    // And the shop's own stylesheet was not touched for the dashboard's
    // sake: the published page is unchanged.
    const styles = repoFile('src/components/landing/blocks/styles.ts');
    expect(styles).toMatch(/\.lp-sticky \{/);
    expect(styles).not.toMatch(/contain: paint/);
  });

  it('the previews are drawn with the shop’s real products, not «منتجك» and «؟»', () => {
    const screen = stripComments(repoFile('src/components/screens/StoreThemeScreen.tsx'));
    // The gallery call used to pass no product at all.
    expect(screen, 'المعرض ما بياخد منتج').toMatch(/product=\{previewProduct\}/);
    expect(screen).toMatch(/shop\?\.sample\?\.\[0\]/);

    /*
     * AND THE SAMPLE COMES FROM THE SHELF.
     *
     * `Product.storeId` is nullable, so asking the catalogue table alone
     * returned nothing for a shop whose goods predate per-store
     * catalogues — which is how a shop with twelve published pages was
     * told it had no products. The published, shown landing pages carry
     * the store themselves.
     */
    const route = stripComments(repoFile('src/app/api/store/templates/route.ts'));
    expect(route).toMatch(/db\.landingPage\.findMany\(\{/);
    expect(route).toMatch(/isPublished: true, showInStore: true/);
  });

  it('«التصميم» and «القوالب» are one tab, and only one of them arranges the home page', () => {
    const tabs = STORE_TABS.find((t) => t.key === 'front')!;
    expect(tabs.sections.map((s) => s.key)).toEqual(['home', 'look']);

    // The look panel no longer carries a «الصفحة الرئيسية» tab of its own:
    // that tab was the overlap the owner reported.
    const look = stripComments(repoFile('src/components/screens/StoreThemeScreen.tsx'));
    expect(look, 'لوح الشكل ما زال فيه تبويب للصفحة الرئيسية').not.toMatch(
      /label: 'الصفحة الرئيسية'/
    );
    // One builder, in the home panel, and no second one beside it.
    const home = stripComments(repoFile('src/components/screens/StoreDesignScreen.tsx'));
    expect(home).toContain('<BlockBuilder');
    expect(look, 'لوح الشكل صار فيه بانية ثانية').not.toContain('<BlockBuilder');
  });

  it('and the cover image is picked, not typed into a text field', () => {
    const look = stripComments(repoFile('src/components/screens/StoreThemeScreen.tsx'));
    // It was `<Input … value={theme.home?.coverImage}>`: a 300-character
    // path a seller had to find somewhere else and paste.
    expect(look, 'صورة الغلاف ما زالت خانة نصّ').not.toMatch(
      /<Input[\s\S]{0,300}theme\.home\?\.coverImage/
    );
    expect(look).toMatch(/type="file"/);
    // READ RAW, FOR ONE ATTRIBUTE ONLY.
    //
    // The file-picker's accept attribute ends in a slash-star, and
    // `stripComments` is a regex stripper: it reads that as the start of a
    // block comment and blanks everything up to the next star-slash —
    // which, once a comment follows the picker in this file, swallows the
    // attribute and fails a guard about code that is right there. It
    // passed until the editors stage put a commented preview pane below
    // it, which is exactly how long such a guard stays honest by luck.
    //
    // (This very comment is line comments and not a block, for the same
    // reason: writing the two characters inside a block comment ends it.)
    //
    // So this one line is matched against the file as written. A comment
    // could in principle contain the string, but `type="file"` above is
    // checked on the stripped source — the picker is real either way.
    expect(repoFile('src/components/screens/StoreThemeScreen.tsx')).toMatch(/accept="image\/\*"/);
    // Through the one uploader both panels of «الواجهة» use — no second
    // door, no new permission.
    expect(look).toMatch(/uploadStoreImages\(\[file\]\)/);
    const uploader = stripComments(repoFile('src/lib/store-image-upload.ts'));
    expect(uploader).toContain("'/api/store/design/image'");
    // And it is a draft until it is saved, like every other value there.
    expect(look).toMatch(/setPart\('home', \{ coverImage: url \}\)/);
  });

  it('and «إنشاء صفحة هبوط» is steps, with the required fields on the last', () => {
    /*
     * THE STEPS WERE FOUR AND ARE NOW A PATH PER WAY — the owner's 3/11
     * order took his other platform's wizard (product → three ways →
     * design). The claims are the same three: the product first, the two
     * required fields on the LAST step of every path, and creating is
     * still not publishing. The behaviour is walked in
     * `landing-create-dialog.test.tsx`; this holds the shape in the source.
     */
    const wizard = stripComments(repoFile('src/components/landing-flow/CreateWizard.tsx'));
    for (const way of ['ai', 'design', 'blank']) {
      const path = new RegExp(`  ${way}: \\[([^\\]]+)\\]`).exec(wizard)?.[1] ?? '';
      const steps = path.split(',').map((x) => x.trim().replace(/'/g, ''));
      expect(steps[0], `طريق «${way}» ما بيبلّش بالمنتج`).toBe('product');
      expect(steps[steps.length - 1], `طريق «${way}» ما بيخلص بالاسم والرابط`).toBe('name');
    }
    const last = wizard.slice(wizard.indexOf("{step === 'name' && ("));
    expect(last).toContain('اسم الصفحة *');
    expect(last).toContain('الرابط *');
    expect(last).toMatch(/بتنعمل مسودة/);
  });
});
