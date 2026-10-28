import { describe, expect, it } from 'vitest';
import { contrastRatio, paletteFor } from './landing-theme';
import { landingSectionsSchema, newSection, COD_LINE } from './landing-sections';
import { LANDING_STRUCTURES } from './landing-structures';
import { structureToSections } from './landing-structure';
import { STORE_TEMPLATES } from './store-templates';
import { skinToLandingTheme } from './store-skin';
import { repoFile, stripComments } from './guard-source';

/**
 * المرحلة ٥ — كل بنية مع كل مظهر.
 *
 * «أي بنية بتشتغل مع أي مظهر من العشرة بلا خطأ · تبديل البنية أو المظهر ما
 * بيغيّر أي سعر ولا عرض ولا طلب مخزّن ولا حدث مرسل · النواة المقفولة ظاهرة
 * بلا تمرير على جوال 360 بكسل بكل تركيبة.»
 *
 * A hundred combinations is more than anybody looks at, which is why the
 * promise is worth making and why it has to be swept rather than sampled.
 *
 * WHAT THIS FILE CANNOT MEASURE, said rather than faked: pixels. Whether the
 * locked core clears 800px on a 360px phone, and what a browser downloads,
 * are facts about a rendered page. Those were measured against the real
 * thirty pages `scripts/structure-matrix.ts` publishes (30/30 clear, worst
 * COD line at 281px; 30.9 KB of JavaScript and 14.2 KB of CSS on the wire
 * from a production build). What is held HERE is everything that decides
 * those numbers and can be broken by an edit.
 */

/** «ثلاث مظاهر على الأقل» is the floor for screenshots; the sweep takes ten. */
const COMBINATIONS = LANDING_STRUCTURES.length * STORE_TEMPLATES.length;

describe('كل بنية مع كل مظهر', () => {
  it('builds a page the renderer accepts — all hundred of them', () => {
    let built = 0;
    const broken: string[] = [];
    for (const structure of LANDING_STRUCTURES) {
      for (const skin of STORE_TEMPLATES) {
        built++;
        const sections = structureToSections(structure, {}, 'msa', newSection);
        const parsed = landingSectionsSchema.safeParse(sections);
        if (!parsed.success) broken.push(`${structure.id} × ${skin.id}`);
        // The skin paints; it must never fail to produce a palette.
        const palette = paletteFor(skinToLandingTheme(skin));
        if (!palette.accent || !palette.text) broken.push(`${structure.id} × ${skin.id}: palette`);
      }
    }
    expect(broken).toEqual([]);
    // THE COUNTER, NOT THE LENGTHS. A loop over an empty list passes every
    // assertion inside it; what proves the sweep ran is the sweep's count.
    expect(built).toBe(COMBINATIONS);
    expect(built).toBeGreaterThanOrEqual(100);
  });

  /**
   * فحص التباين الآلي — ON THE LANDING PALETTE, WHICH IS A DIFFERENT PATH.
   *
   * `every-template.test.ts` sweeps the same ten skins through
   * `resolveSkinPalette`, which is what a SHOP paints from. A landing page
   * paints from `paletteFor(skinToLandingTheme(skin))` — a different
   * function, deriving different values, and a skin that reads well in the
   * shop can still fail here. Measured on its own side.
   */
  it('every skin is readable on a landing page, not only in the shop', () => {
    const PAIRS: { fg: 'text' | 'muted' | 'accentText'; bg: 'pageBg' | 'cardBg' | 'accent'; min: number; what: string }[] = [
      { fg: 'text', bg: 'pageBg', min: 4.5, what: 'النص على الصفحة' },
      { fg: 'text', bg: 'cardBg', min: 4.5, what: 'النص على البطاقة' },
      // The quiet line — the COD sentence under the button is drawn in it,
      // and a reassurance nobody can read reassures nobody. 4.5 is the body
      // threshold and this is body text, not a label.
      { fg: 'muted', bg: 'pageBg', min: 4.5, what: 'النص الهادئ على الصفحة' },
      { fg: 'muted', bg: 'cardBg', min: 4.5, what: 'النص الهادئ على البطاقة' },
      // The order button: the one control the whole page exists for.
      { fg: 'accentText', bg: 'accent', min: 4.5, what: 'نص الزرّ على لونه' },
    ];

    const failures: string[] = [];
    let compared = 0;
    for (const skin of STORE_TEMPLATES) {
      const palette = paletteFor(skinToLandingTheme(skin));
      for (const pair of PAIRS) {
        compared++;
        const ratio = contrastRatio(palette[pair.fg], palette[pair.bg]);
        if (ratio < pair.min) failures.push(`${skin.id}: ${pair.what} ${ratio.toFixed(2)}:1`);
      }
    }
    expect(failures).toEqual([]);
    expect(compared).toBe(STORE_TEMPLATES.length * PAIRS.length);
    expect(compared).toBeGreaterThanOrEqual(50);
  });
});

/**
 * «تبديل البنية أو المظهر ما بيغيّر أي سعر ولا عرض ولا طلب مخزّن ولا حدث
 * مرسل.»
 *
 * Not tested by submitting a hundred orders — that would pass for a reason
 * that proves nothing, because all hundred would run the same code. It is
 * true BY CONSTRUCTION, and construction is what is asserted: the order path
 * cannot read a structure or a skin, because it never loads either.
 */
describe('الطلب لا يرى البنية ولا المظهر', () => {
  const orderRoute = stripComments(repoFile('src/app/api/public/landing-pages/[slug]/orders/route.ts'));

  it('the public order route loads no sections, no theme and no builder mode', () => {
    for (const field of ['sections', 'builderMode', 'contentDraft']) {
      expect(orderRoute, field).not.toContain(field);
    }
    /*
     * ONE EXCEPTION, NAMED AND NO WIDER: the STORE's «الدفع».
     *
     * The owner, asked 28/10 whether a field the shop made «إلزامي» and the visitor left blank refuses the order,
     * answered «انطيني الصلاحية شو الي يظهر بالشيك اوت الي بينطلب والترتيب دراخ اند دروب» — refuse it. Those settings
     * live in the store's theme column, so the door reads that column for them and for nothing else: through
     * `checkoutRules`, which answers only which fields are required. Never the PAGE's own theme, never a palette, a
     * structure or a skin — installing a template writes none of «الدفع» (every-template.test.ts), so switching a
     * look still cannot reach an order. Everything below is that one read, and then the old rule over the rest.
     */
    const ONE_READ = [
      "import { checkoutRules, parseStoreTheme } from '@/lib/store-theme';",
      'checkout: checkoutRules(parseStoreTheme(lp.store.theme)),',
    ];
    let rest = orderRoute;
    for (const line of ONE_READ) {
      expect(rest, line).toContain(line);
      rest = rest.split(line).join('');
    }
    // The column is selected on the STORE, never on the page.
    const storeAt = rest.indexOf('store: {');
    expect(storeAt, 'ما في قراءة للمتجر').toBeGreaterThan(-1);
    const storeSelect = rest.slice(storeAt, rest.indexOf('},\n      },', storeAt));
    expect(storeSelect).toMatch(/theme: true/);
    rest = rest.slice(0, storeAt) + storeSelect.replace(/theme: true,?/, '') + rest.slice(storeAt + storeSelect.length);
    expect(rest, 'الطلب صار يقرأ شي تاني من المظهر').not.toMatch(/theme/i);
  });

  it('and takes its price from the product, never from the page', () => {
    // The hero prints a price; the order computes one. If the second ever
    // read the first, a seller editing a headline would change what a
    // customer pays.
    expect(orderRoute).toContain('product: { select: { id: true, basePrice: true');
    expect(orderRoute).not.toMatch(/price\s*:\s*raw/);
  });

  it('the order form block carries no field configuration at all', () => {
    // If a structure could choose which fields its form asks for, two
    // structures would store two different orders. The block fixes WHERE the
    // form goes and nothing else; the fields live in one component and one
    // server schema.
    const sections = stripComments(repoFile('src/lib/landing-sections.ts'));
    const form = sections.slice(sections.indexOf("type: z.literal('form')"));
    const block = form.slice(0, form.indexOf('});'));
    expect(block).toContain('title');
    expect(block).toContain('subtitle');
    for (const forbidden of ['fields', 'required', 'askCity', 'askNotes', 'collect']) {
      expect(block, forbidden).not.toContain(forbidden);
    }
  });

  it('and every structure puts exactly one form on the page', () => {
    for (const s of LANDING_STRUCTURES) {
      const forms = s.sequence.filter((t) => t === 'form');
      expect(forms, s.id).toHaveLength(1);
    }
  });
});

/**
 * النواة المقفولة — AND THE PART OF IT THAT WAS DECLARED AND NOT DRAWN.
 *
 * All ten structures declare `firstScreen.codLine: true`, the schema makes
 * it `z.literal(true)` so none of them can say otherwise — and no renderer
 * drew a COD line. The promise lived entirely in a type. Found by looking at
 * the rendered page, which is the only place it could have been found.
 */
describe('النواة المقفولة مرسومة لا معلَنة فقط', () => {
  const hero = stripComments(repoFile('src/components/landing/blocks/PageBlocks.tsx'));
  const heroBlock = hero.slice(hero.indexOf('function Hero('), hero.indexOf('function Urgency('));

  it('the hero draws the COD line', () => {
    expect(heroBlock).toContain('COD_LINE');
    expect(heroBlock).toContain('lp-hero-cod');
  });

  it('and draws it unconditionally — «مقفولة» means there is no value that removes it', () => {
    // The price is behind `s.showPrice` and that is the seller's call; this
    // one is not theirs to make. A `&&` before it would be a switch.
    const line = heroBlock.split('\n').find((l) => l.includes('lp-hero-cod')) ?? '';
    expect(line).not.toContain('&&');
    expect(line).not.toContain('?');
  });

  it('the sentence is one sentence, in one place', () => {
    // It was written out in the form's default and on the shop's product
    // page; a shopper reading two versions wonders which is true.
    expect(COD_LINE).toContain('عند الاستلام');
    const sections = stripComments(repoFile('src/lib/landing-sections.ts'));
    expect(sections).toContain(`export const COD_LINE = '${COD_LINE}'`);
    // ONCE ON THE PAGE, NOT THREE TIMES. The form's subtitle used to default
    // to this same sentence, and the order form says it twice more beside the
    // amount and in the trust row. Four statements of one fact is not
    // reassurance, it is noise — so the locked line is the hero's alone.
    const formDefault = sections.slice(sections.indexOf("type: z.literal('form')"));
    expect(formDefault.slice(0, formDefault.indexOf('});'))).not.toContain('COD_LINE');
  });

  it('and no skin variable can hide it', () => {
    const css = repoFile('src/components/landing/blocks/styles.ts');
    const rule = css.slice(css.indexOf('.lp-hero-cod'), css.indexOf('.lp-hero-cod') + 220);
    expect(rule).not.toContain('display: none');
    expect(rule).not.toMatch(/var\(--store-(hide|show)/);
  });
});

/**
 * «ما في فيديو ولا 3D بالبطل · صور بأبعاد صريحة · ما في إزاحة تخطيط · ما في
 * قائمة تنقّل ولا روابط خروج.»
 */
describe('ما تحمله الصفحة وما لا تحمله', () => {
  const blocks = stripComments(repoFile('src/components/landing/blocks/PageBlocks.tsx'));
  // Newlines normalised: this repository is CRLF, and every offset below is
  // counted against a string the author wrote with \n.
  const flatCss = repoFile('src/components/landing/blocks/styles.ts').replace(/\r\n/g, '\n');

  it('no video, no 3D, no canvas, no embedded frame', () => {
    // Not «the hero has none» — NONE of the twenty blocks has one, so the
    // rule cannot be broken by moving a block.
    for (const tag of ['<video', '<model-viewer', '<canvas', '<iframe', '<object', '<embed']) {
      expect(blocks, tag).not.toContain(tag);
    }
  });

  it('and the library has no video section to put in a sequence', () => {
    const sections = stripComments(repoFile('src/lib/landing-sections.ts'));
    for (const t of ["'video'", "'embed'", "'model'"]) {
      expect(sections, t).not.toContain(t);
    }
  });

  it('every image a block draws has its space reserved before it arrives', () => {
    // An <img> with no intrinsic size occupies nothing until it loads and
    // then shoves everything below it down. Each of these classes is an
    // image the renderer emits; each needs a ratio in the sheet.
    // `.lp-hero-img` appears first in a hero-VARIANT rule that only sets
    // `order`; the sizing rule is the one that sets `display: block`.
    for (const cls of ['.lp-hero-img {\n  display: block;', '.lp-gallery img', '.lp-slider-slide img']) {
      const at = flatCss.indexOf(cls);
      expect(at, cls).toBeGreaterThan(-1);
      expect(flatCss.slice(at, at + 400), cls).toContain('aspect-ratio');
    }
  });

  it('and the hero’s ratio matches the frame drawn when there is no photograph', () => {
    // Otherwise a page lays out one way in the editor's placeholder state and
    // another once a real photograph is uploaded.
    expect(blocks).toContain('ratio={0.62}');
    const at = flatCss.indexOf('.lp-hero-img {\n  display: block;');
    expect(flatCss.slice(at, at + 400)).toContain('aspect-ratio: 1 / 0.62');
  });

  it('no structure puts a block on the page that leads away from it', () => {
    /*
     * MEASURED ON THE SEQUENCES, NOT ON THE WHOLE LIBRARY.
     *
     * The first version of this swept every `href` in the renderer file and
     * failed on the catalogue block, which links to categories and products —
     * and that block is right to: it draws a STORE's front page, where
     * leaving for a category is the point. It is simply not a block any of
     * the ten structures uses, and sweeping the file could not tell the
     * difference between «a link exists in this file» and «a link exists on
     * this page».
     */
    const LEAVES: string[] = ['catalog'];
    for (const s of LANDING_STRUCTURES) {
      for (const type of s.sequence) {
        expect(LEAVES, `${s.id}: ${type}`).not.toContain(type);
      }
    }
  });

  it('and the footer carries only the legal pages and the phone', () => {
    // The footer is a `case` in the one big block switch, not a function of
    // its own — so the slice runs from its case label to the next one. The
    // first version looked for `function Footer(`, found nothing, and swept
    // an EMPTY string: zero links, every assertion inside the loop skipped,
    // green. The length check below is what turns that into a failure.
    const at = blocks.indexOf("case 'footer': {");
    expect(at, 'لم يُعثر على كتلة التذييل').toBeGreaterThan(-1);
    const body = blocks.slice(at, blocks.indexOf('case ', at + 20));
    const hrefs = [...body.matchAll(/href=\{?["'`{]?([^"'`}\n]*)/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const h of hrefs) {
      // `link.url` is the legal-pages list the store configures; `tel:` is
      // the support number. Nothing else may be in here.
      const ok = h.startsWith('tel:') || h.includes('link.url') || h === '';
      expect(ok, `رابط في التذييل: ${h}`).toBe(true);
    }
  });
});
